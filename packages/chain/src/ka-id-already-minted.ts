// SPDX-License-Identifier: Apache-2.0

import { ErrorFragment, Interface, ethers } from 'ethers';
import { forEachEvmErrorEnvelope, structuredRevertData } from './evm-error-envelopes.js';

/**
 * `DKGKnowledgeAssets` reverts `KaIdAlreadyMinted(kaId)` when a publish reuses
 * a packed KA id that is already minted. A named-asset publish whose earlier
 * transaction mined after the node stopped waiting hits it on every retry,
 * at gas estimation and before anything is broadcast.
 */
const KA_ID_ALREADY_MINTED = ErrorFragment.from('error KaIdAlreadyMinted(uint256 kaId)');
const KA_ID_ALREADY_MINTED_INTERFACE = new Interface([KA_ID_ALREADY_MINTED]);

/** Selector plus one ABI word: exactly what the contract emits for this error. */
const KA_ID_ALREADY_MINTED_DATA_BYTES = 4 + 32;

export const KA_ID_ALREADY_MINTED_SELECTOR = KA_ID_ALREADY_MINTED.selector;

/**
 * The KA id named by a `KaIdAlreadyMinted` revert, decoded from the structured
 * revert data of the error and the errors it wraps: never message text, and
 * never `transaction.data`, which is the publish calldata. Returns `null` when
 * no structured revert data carries this error, or when two pieces of revert
 * data name different ids.
 */
export function kaIdAlreadyMintedFromError(error: unknown): bigint | null {
  const ids = new Set<bigint>();
  forEachEvmErrorEnvelope(error, (envelope) => {
    for (const raw of structuredRevertData(envelope)) {
      const kaId = decodeKaIdAlreadyMintedData(raw);
      if (kaId !== null) ids.add(kaId);
    }
  });
  return ids.size === 1 ? [...ids][0]! : null;
}

function decodeKaIdAlreadyMintedData(raw: string | Uint8Array): bigint | null {
  const hex = raw instanceof Uint8Array ? ethers.hexlify(raw) : raw;
  if (!ethers.isHexString(hex, KA_ID_ALREADY_MINTED_DATA_BYTES)) return null;
  if (hex.slice(0, 10).toLowerCase() !== KA_ID_ALREADY_MINTED_SELECTOR) return null;
  const [kaId] = KA_ID_ALREADY_MINTED_INTERFACE.decodeErrorResult(KA_ID_ALREADY_MINTED, hex);
  return BigInt(kaId);
}

/**
 * The gas-estimation failure the real adapter surfaces for this revert, for
 * offline adapters that model the contract's re-mint guard.
 */
export function kaIdAlreadyMintedRevert(kaId: bigint): Error {
  const data = KA_ID_ALREADY_MINTED_INTERFACE.encodeErrorResult(KA_ID_ALREADY_MINTED, [kaId]);
  return Object.assign(new Error(`execution reverted: KaIdAlreadyMinted(${kaId})`), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
    reason: null,
    data,
    revert: { name: KA_ID_ALREADY_MINTED.name, signature: KA_ID_ALREADY_MINTED.format(), args: [kaId] },
  });
}
