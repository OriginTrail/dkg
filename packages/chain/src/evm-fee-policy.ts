// SPDX-License-Identifier: Apache-2.0

/**
 * EIP-1559 fee pricing for every transaction this node signs, and for the
 * same-nonce replacement of one that is stuck.
 *
 * ethers' default (`2 x latest base fee + eth_maxPriorityFeePerGas`) leaves a
 * transaction un-includable as soon as the base fee more than doubles before it
 * is mined. On a chain whose base fee idles at a few wei that is no headroom at
 * all: on Gnosis the base fee rose from 72 wei to 2.7M wei in 16 minutes on
 * 2026-10-15 (#3260), and from 23 wei to 36M wei within minutes on 2026-10-20,
 * stranding publishes signed with `maxFeePerGas` of 216-2,946 wei and 614-736
 * wei. Each stranded transaction held its wallet's nonce, so every later
 * transaction of that wallet queued behind it.
 *
 * The protocol charges the base fee of the block a transaction lands in plus
 * at most its tip, never `maxFeePerGas` itself, so a generous cap costs nothing
 * beyond the balance it must cover. The tip is what a producer is paid.
 */

import { Transaction, type ethers } from 'ethers';
import { applyTransactionFeeCap } from './evm-fee-cap.js';
import type { EvmSigner } from './evm-signer.js';

const GWEI = 1_000_000_000n;

/** Lowest fees this node signs with on one chain, whatever its RPC suggests. */
export interface ChainFeeFloor {
  /** Lowest `maxFeePerGas`: the base fee a transaction stays includable up to. */
  readonly maxFeePerGasWei: bigint;
  /** Lowest `maxPriorityFeePerGas`: the tip offered to the block producer. */
  readonly maxPriorityFeePerGasWei: bigint;
}

/**
 * Gnosis RPCs suggest tips of 1 to 100 wei, and blocks routinely include them.
 * Yet in the fee history of 2026-10-20 some blocks included nothing below
 * 0.01, 0.22 or 0.35 gwei, so not every producer takes a 100-wei tip; 1 gwei is
 * above every such minimum sampled, and is also ethers' own fallback tip. A
 * `maxFeePerGas` of at least 2 gwei leaves the base fee 1 gwei of room above
 * that tip: more than 25 times both spikes above. At a publish's ~1M gas this
 * costs about 0.001 xDAI.
 */
const GNOSIS_FEE_FLOOR: ChainFeeFloor = {
  maxFeePerGasWei: 2n * GWEI,
  maxPriorityFeePerGasWei: GWEI,
};

/**
 * Per-chain floors, keyed by numeric chain id. A chain without an entry is
 * priced from its base fee and suggested tip alone.
 */
export const CHAIN_FEE_FLOORS: ReadonlyMap<bigint, ChainFeeFloor> = new Map([
  [100n, GNOSIS_FEE_FLOOR], // Gnosis
  [10200n, GNOSIS_FEE_FLOOR], // Chiado, Gnosis' testnet: same fee market
]);

export function chainFeeFloor(chainId: bigint | undefined): ChainFeeFloor | undefined {
  return chainId === undefined ? undefined : CHAIN_FEE_FLOORS.get(chainId);
}

/**
 * `maxFeePerGas` covers this many times the latest base fee, on top of the
 * tip. A full block raises the base fee by 12.5%, so 3x stays includable
 * through nine consecutive full blocks (45 s on Gnosis); ethers' 2x through six.
 */
export const BASE_FEE_HEADROOM_MULTIPLIER = 3n;

/** The tip when the RPC suggests none: ethers v6's own fallback. */
export const DEFAULT_PRIORITY_FEE_PER_GAS_WEI = GWEI;

export interface Eip1559Fees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

function maxOf(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((highest, value) => (value > highest ? value : highest), first);
}

/**
 * The endpoint's suggested tip (`eth_maxPriorityFeePerGas`), or null when it
 * gives none. Like ethers' `getFeeData`, a failed read is no suggestion
 * rather than an error: the tip then falls back to the floor or the default.
 */
export async function readSuggestedPriorityFee(provider: ethers.Provider): Promise<bigint | null> {
  const { send } = provider as { send?: (method: string, params: unknown[]) => Promise<unknown> };
  try {
    if (typeof send === 'function') {
      return BigInt(String(await send.call(provider, 'eth_maxPriorityFeePerGas', [])));
    }
    return (await provider.getFeeData()).maxPriorityFeePerGas;
  } catch {
    return null;
  }
}

/** Fees for a transaction signed now, from the latest base fee and the RPC's suggested tip. */
export function priceEip1559Fees(params: {
  baseFeePerGas: bigint;
  /** `eth_maxPriorityFeePerGas`, or null when the RPC gave none. */
  suggestedPriorityFeePerGas: bigint | null;
  floor?: ChainFeeFloor;
}): Eip1559Fees {
  const maxPriorityFeePerGas = maxOf(
    params.suggestedPriorityFeePerGas ?? DEFAULT_PRIORITY_FEE_PER_GAS_WEI,
    params.floor?.maxPriorityFeePerGasWei ?? 0n,
  );
  const maxFeePerGas = maxOf(
    params.baseFeePerGas * BASE_FEE_HEADROOM_MULTIPLIER + maxPriorityFeePerGas,
    params.floor?.maxFeePerGasWei ?? 0n,
  );
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Set a request's EIP-1559 fee fields before ethers populates the rest, from
 * the latest base fee and suggested tip `provider` reports. Fees the caller
 * already chose, an explicitly legacy request, a chain without a base fee
 * (ethers' own rule: none, or zero) and a provider that cannot report a block
 * are left to ethers. Also returns the base fee read, if one was.
 */
export async function priceTransactionRequest(
  provider: ethers.Provider | null,
  request: ethers.TransactionRequest,
  floor: ChainFeeFloor | undefined,
): Promise<{ transaction: ethers.TransactionRequest; baseFeePerGas?: bigint | null }> {
  const feesChosen = request.gasPrice != null
    || request.maxFeePerGas != null
    || request.maxPriorityFeePerGas != null;
  if (feesChosen || (request.type != null && request.type !== 2)
    || !provider || typeof provider.getBlock !== 'function') {
    return { transaction: request };
  }
  const baseFeePerGas = (await provider.getBlock('latest'))?.baseFeePerGas ?? null;
  if (!baseFeePerGas) return { transaction: request, baseFeePerGas };
  const fees = priceEip1559Fees({
    baseFeePerGas,
    suggestedPriorityFeePerGas: await readSuggestedPriorityFee(provider),
    floor,
  });
  return { transaction: { ...request, type: 2, ...fees }, baseFeePerGas };
}

/**
 * Mempools take a same-nonce replacement only when it raises BOTH fee fields
 * by at least 10% (the geth, Erigon, Nethermind, Besu and Reth default), and
 * strictly. 12.5%, rounded up, clears that with room for integer rounding.
 */
export const REPLACEMENT_FEE_BUMP_BPS = 1_250n;

/** The lowest value a replacement may carry for a fee field that was `previous`. */
export function bumpedFee(previous: bigint): bigint {
  const bump = (previous * REPLACEMENT_FEE_BUMP_BPS + 9_999n) / 10_000n;
  return previous + (bump > 0n ? bump : 1n);
}

/**
 * Fees for re-signing a stuck transaction at its own nonce: at least the bump
 * a mempool needs to accept the replacement, and at least what a transaction
 * priced now would carry, so a base fee that has run away is caught up with in
 * one step.
 */
export function replacementFees(previous: Eip1559Fees, market: Eip1559Fees): Eip1559Fees {
  const maxPriorityFeePerGas = maxOf(bumpedFee(previous.maxPriorityFeePerGas), market.maxPriorityFeePerGas);
  const maxFeePerGas = maxOf(bumpedFee(previous.maxFeePerGas), market.maxFeePerGas, maxPriorityFeePerGas);
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** True when `candidate` raises both fields of `previous` enough to replace it. */
export function isAcceptedReplacement(previous: Eip1559Fees, candidate: Eip1559Fees): boolean {
  return candidate.maxFeePerGas >= bumpedFee(previous.maxFeePerGas)
    && candidate.maxPriorityFeePerGas >= bumpedFee(previous.maxPriorityFeePerGas);
}

/**
 * The fee fields of a signed EIP-1559 transaction, or undefined for any other
 * type, or for bytes that do not decode: only EIP-1559 transactions are re-priced.
 */
export function signedEip1559Fees(signedTx: string): Eip1559Fees | undefined {
  let tx: Transaction;
  try {
    tx = Transaction.from(signedTx);
  } catch {
    return undefined;
  }
  if (tx.type !== 2 || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null) return undefined;
  return { maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
}

/**
 * The request that re-signs `signedTx` with new fees and nothing else changed:
 * the same chain, nonce, gas limit, recipient, value, calldata and access
 * list. It is never re-populated, which would read the `pending` nonce and so
 * sign a different slot.
 */
export function replacementTransactionRequest(
  signedTx: string,
  fees: Eip1559Fees,
): ethers.TransactionRequest {
  const tx = Transaction.from(signedTx);
  return {
    type: 2,
    chainId: tx.chainId,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    accessList: tx.accessList ?? [],
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}

/** Price before estimation under the operator cap, then validate the populated transaction. */
export async function prepareTransactionWithFees(
  signer: EvmSigner,
  populated: ethers.TransactionRequest,
  floor?: ChainFeeFloor,
  maxFeePerGasWei?: bigint,
): Promise<ethers.TransactionRequest> {
  // Headroom over the latest base fee and the chain's floor (evm-fee-policy.ts), under the
  // operator cap already (validated against the base fee read): ethers estimates gas with
  // these fees, and the RPC checks them against the balance and the base fee.
  const priced = await priceTransactionRequest(signer.provider, populated, floor);
  const filled = await signer.populateTransaction(maxFeePerGasWei === undefined
    ? priced.transaction
    : applyTransactionFeeCap(priced.transaction, maxFeePerGasWei, priced.baseFeePerGas));
  if (maxFeePerGasWei === undefined) return filled;
  let baseFeePerGas = priced.baseFeePerGas;
  if (baseFeePerGas === undefined && filled.maxFeePerGas !== null && filled.maxFeePerGas !== undefined) {
    baseFeePerGas = (await signer.provider?.getBlock('latest'))?.baseFeePerGas;
  }
  return applyTransactionFeeCap(filled, maxFeePerGasWei, baseFeePerGas);
}
