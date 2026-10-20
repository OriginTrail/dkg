// SPDX-License-Identifier: Apache-2.0

/**
 * Speed-up of a broadcast transaction that stays unmined while it holds its
 * account's next nonce.
 *
 * Such a transaction blocks every later transaction of the same wallet, so
 * abandoning it at the receipt deadline leaves the wallet stuck for as long as
 * the fee market stays above it: on 2026-10-20 six Gnosis publishes signed at
 * 614-736 wei sat behind a base fee of 4.9M-36M wei and kept three wallets'
 * later transactions queued for hours. Instead, while the receipt wait runs,
 * the transaction is re-signed at its own nonce with higher fees and
 * broadcast again, and the wait then accepts the receipt of whichever of the
 * hashes is mined; same calldata, so either one is the same operation.
 *
 * Each check reads the account's mined nonce count ("latest") and the latest
 * base fee from one endpoint:
 *
 * | account nonce vs ours | before the deadline           | at the deadline                     |
 * |-----------------------|-------------------------------|-------------------------------------|
 * | equal: next to mine   | replace if priced below base  | replace and renew the deadline      |
 * | lower: queued behind  | wait                          | renew the deadline (still ours)     |
 * | higher: slot consumed | wait (our receipt may follow) | give up: the timeout surfaces       |
 *
 * Replacing does not change the nonce, so it never races the wallet's nonce
 * lane: every later transaction already holds a higher one. A replacement that
 * cannot be made or sent is logged and never becomes the operation's error;
 * the original may still be mined, so the outcome stays the receipt wait's.
 * Once its broadcast starts, a replacement counts as possibly sent, whatever
 * the broadcast reports: an endpoint that took it can lose its answer and a
 * later one then reject it, so its hash is polled and waited for.
 */

import type { JsonRpcProvider } from 'ethers';
import type { ReplacementBroadcastSignal } from './chain-adapter.js';
import { errorMessage } from './evm-adapter-errors.js';
import { applyTransactionFeeCap } from './evm-fee-cap.js';
import {
  type ChainFeeFloor,
  type Eip1559Fees,
  isAcceptedReplacement,
  priceEip1559Fees,
  readSuggestedPriorityFee,
  replacementFees,
  replacementTransactionRequest,
  signedEip1559Fees,
} from './evm-fee-policy.js';
import { signTransactionOnce, type EvmSigner } from './evm-signer.js';
import { hostOnlyRpcText } from './rpc-failover-log.js';

/** How often a pending transaction is checked against the account nonce and base fee. */
export const STUCK_TRANSACTION_CHECK_INTERVAL_MS = 30_000;

/** Most same-nonce replacements one transaction gets. */
export const MAX_STUCK_TRANSACTION_REPLACEMENTS = 5;

/**
 * Most times the receipt deadline is renewed for a transaction that still
 * holds its nonce, so a wait lasts at most three receipt timeouts.
 */
export const MAX_STUCK_TRANSACTION_DEADLINE_RENEWALS = 2;

/**
 * The check interval for a receipt timeout: the default for real timeouts,
 * and a quarter of the timeout for one shorter than four intervals.
 */
export function stuckTransactionCheckIntervalMs(receiptTimeoutMs: number): number {
  return Math.min(STUCK_TRANSACTION_CHECK_INTERVAL_MS, Math.max(1, Math.floor(receiptTimeoutMs / 4)));
}

export type StuckTransactionDecision =
  | { readonly action: 'wait' }
  | { readonly action: 'give-up' }
  | { readonly action: 'renew-deadline' }
  | { readonly action: 'replace'; readonly reason: 'underpriced' | 'unmined'; readonly renewDeadline: boolean };

/** What one check does; see the table in the module comment. */
export function decideStuckTransaction(input: {
  /** The nonce the transaction and its replacements carry. */
  readonly nonce: number;
  /** The account's mined nonce count at the chain head. */
  readonly latestNonce: number;
  /** The latest block's base fee, or null when the chain reports none. */
  readonly baseFeePerGas: bigint | null;
  /** `maxFeePerGas` of the most recently signed of the transaction's hashes. */
  readonly maxFeePerGas: bigint;
  readonly deadlineReached: boolean;
  readonly replacementsLeft: number;
  readonly renewalsLeft: number;
}): StuckTransactionDecision {
  if (input.latestNonce > input.nonce) {
    return { action: input.deadlineReached ? 'give-up' : 'wait' };
  }
  if (input.latestNonce < input.nonce) {
    if (!input.deadlineReached) return { action: 'wait' };
    return { action: input.renewalsLeft > 0 ? 'renew-deadline' : 'give-up' };
  }
  if (input.deadlineReached) {
    return input.replacementsLeft > 0 && input.renewalsLeft > 0
      ? { action: 'replace', reason: 'unmined', renewDeadline: true }
      : { action: 'give-up' };
  }
  const underpriced = input.baseFeePerGas !== null && input.maxFeePerGas < input.baseFeePerGas;
  return underpriced && input.replacementsLeft > 0
    ? { action: 'replace', reason: 'underpriced', renewDeadline: false }
    : { action: 'wait' };
}

/** One signed version of the transaction. */
export interface TrackedTransaction {
  readonly txHash: string;
  readonly signedTx: string;
  readonly fees: Eip1559Fees;
}

/** What a recovery needs from the chain; every method may throw. */
export interface StuckTransactionPort {
  /** One endpoint's account nonce count at `latest` and that block's base fee. */
  readChainHead(): Promise<{ latestNonce: number; baseFeePerGas: bigint | null }>;
  /** Fees a transaction signed now would carry, given the latest base fee. */
  priceFees(baseFeePerGas: bigint): Promise<Eip1559Fees>;
  sign(request: ReturnType<typeof replacementTransactionRequest>): Promise<{ signedTx: string; txHash: string }>;
  /**
   * Durable checkpoint awaited before a replacement is broadcast; a throw
   * means the replacement is not sent. Absent when nothing needs recording.
   */
  beforeBroadcast?: (signal: ReplacementBroadcastSignal) => Promise<void> | void;
  broadcast(signedTx: string, txHash: string): Promise<void>;
  /** Called after a replacement was accepted by an endpoint. */
  onReplaced?: () => void;
}

export interface StuckTransactionRecoveryOptions {
  readonly original: TrackedTransaction;
  readonly nonce: number;
  /** Names the operation in log lines, e.g. `V10 publish`. */
  readonly label: string;
  readonly receiptTimeoutMs: number;
  readonly checkIntervalMs: number;
  /** The operator's `chain.maxFeePerGasWei`, which a replacement never exceeds. */
  readonly maxFeePerGasCap?: bigint;
  readonly maxReplacements?: number;
  readonly maxDeadlineRenewals?: number;
  readonly port: StuckTransactionPort;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/**
 * The speed-up state of one receipt wait: the hashes it polls and its
 * `onPending` step (see `waitForReceiptWithDeadline`).
 */
export class StuckTransactionRecovery {
  private readonly tracked: TrackedTransaction[];
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly maxReplacements: number;
  private readonly maxDeadlineRenewals: number;
  private replacements = 0;
  private renewals = 0;
  /** The latest hash an endpoint accepted; the original until a replacement is. */
  private acceptedTxHash: string;
  private nextCheckAtMs: number;

  constructor(private readonly options: StuckTransactionRecoveryOptions) {
    this.tracked = [options.original];
    this.acceptedTxHash = options.original.txHash;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
    this.maxReplacements = options.maxReplacements ?? MAX_STUCK_TRANSACTION_REPLACEMENTS;
    this.maxDeadlineRenewals = options.maxDeadlineRenewals ?? MAX_STUCK_TRANSACTION_DEADLINE_RENEWALS;
    this.nextCheckAtMs = this.now() + options.checkIntervalMs;
  }

  /** Every hash that may carry the receipt, oldest first. */
  txHashes(): readonly string[] {
    return this.tracked.map((tx) => tx.txHash);
  }

  /** The latest hash an endpoint accepted: the one most likely to be mined. */
  latestTxHash(): string {
    return this.acceptedTxHash;
  }

  /**
   * A suffix for the timeout message: the other hashes it was sent as, and how
   * many times the deadline was renewed. Empty when neither happened.
   */
  describeTimeout(): string {
    const parts: string[] = [];
    const others = this.txHashes().filter((txHash) => txHash !== this.acceptedTxHash);
    if (others.length > 0) parts.push(`also sent as ${others.join(', ')}`);
    if (this.renewals > 0) parts.push(`deadline renewed ${this.renewals}x`);
    return parts.length === 0 ? '' : ` (nonce ${this.options.nonce}; ${parts.join('; ')})`;
  }

  /**
   * One step of the receipt wait that found no receipt. Returns a new
   * absolute deadline to keep waiting past the current one, or nothing.
   */
  async onPending(context: { deadlineMs: number; deadlineReached: boolean }): Promise<number | void> {
    const now = this.now();
    if (!context.deadlineReached && now < this.nextCheckAtMs) return;
    this.nextCheckAtMs = now + this.options.checkIntervalMs;

    let head: { latestNonce: number; baseFeePerGas: bigint | null };
    try {
      head = await this.options.port.readChainHead();
    } catch (err) {
      this.log(`[chain] ${this.options.label} tx ${this.latestTxHash()}: stuck-transaction check failed: ${describeError(err)}`);
      return;
    }
    const newest = this.tracked[this.tracked.length - 1];
    const decision = decideStuckTransaction({
      nonce: this.options.nonce,
      latestNonce: head.latestNonce,
      baseFeePerGas: head.baseFeePerGas,
      maxFeePerGas: newest.fees.maxFeePerGas,
      deadlineReached: context.deadlineReached,
      replacementsLeft: this.maxReplacements - this.replacements,
      renewalsLeft: this.maxDeadlineRenewals - this.renewals,
    });
    switch (decision.action) {
      case 'wait':
      case 'give-up':
        return;
      case 'renew-deadline':
        this.renewals += 1;
        this.log(
          `[chain] ${this.options.label} tx ${newest.txHash} is unmined at the receipt deadline behind an ` +
          `earlier nonce (account nonce ${head.latestNonce}, ours ${this.options.nonce}); waiting again`,
        );
        return this.now() + this.options.receiptTimeoutMs;
      case 'replace': {
        const sent = await this.replace(newest, head.baseFeePerGas, decision.reason);
        if (!sent) return;
        if (decision.renewDeadline) {
          this.renewals += 1;
          return this.now() + this.options.receiptTimeoutMs;
        }
        // Signing and broadcasting can run past the deadline; the new hash still
        // gets a check interval of polling before the wait may give up.
        const pollUntilMs = this.now() + this.options.checkIntervalMs;
        return pollUntilMs > context.deadlineMs ? pollUntilMs : undefined;
      }
    }
  }

  /** Sign, checkpoint and broadcast one replacement; true once its broadcast started. */
  private async replace(
    previous: TrackedTransaction,
    baseFeePerGas: bigint | null,
    reason: 'underpriced' | 'unmined',
  ): Promise<boolean> {
    const { label, nonce, port } = this.options;
    const why = reason === 'underpriced'
      ? `its maxFeePerGas ${previous.fees.maxFeePerGas} is below the base fee ${baseFeePerGas}`
      : `it is unmined after the receipt timeout`;
    let fees: Eip1559Fees;
    let signed: { signedTx: string; txHash: string };
    try {
      const market = baseFeePerGas === null ? previous.fees : await port.priceFees(baseFeePerGas);
      const cap = this.options.maxFeePerGasCap;
      fees = cap === undefined
        ? replacementFees(previous.fees, market)
        : applyTransactionFeeCap(replacementFees(previous.fees, market), cap);
      if (!isAcceptedReplacement(previous.fees, fees)) {
        this.log(
          `[chain] ${label} tx ${previous.txHash} at nonce ${nonce} is stuck (${why}) but cannot be ` +
          `replaced: chain.maxFeePerGasWei ${this.options.maxFeePerGasCap} leaves no room for a fee bump`,
        );
        return false;
      }
      signed = await port.sign(replacementTransactionRequest(previous.signedTx, fees));
      await port.beforeBroadcast?.({
        txHash: signed.txHash,
        nonce,
        replacesTxHashes: this.txHashes(),
      });
    } catch (err) {
      this.log(`[chain] ${label} tx ${previous.txHash} at nonce ${nonce} is stuck (${why}); replacement failed: ${describeError(err)}`);
      return false;
    }
    this.tracked.push({ txHash: signed.txHash, signedTx: signed.signedTx, fees });
    this.replacements += 1;
    try {
      await port.broadcast(signed.signedTx, signed.txHash);
    } catch (err) {
      this.log(
        `[chain] ${label} tx ${previous.txHash} at nonce ${nonce} is stuck (${why}); replacement ` +
        `${signed.txHash} may not have been accepted, still polling it: ${describeError(err)}`,
      );
      return true;
    }
    this.acceptedTxHash = signed.txHash;
    port.onReplaced?.();
    this.log(
      `[chain] ${label} tx ${previous.txHash} at nonce ${nonce} is stuck (${why}); replaced it with ` +
      `${signed.txHash} (maxFeePerGas ${fees.maxFeePerGas}, maxPriorityFeePerGas ${fees.maxPriorityFeePerGas})`,
    );
    return true;
  }
}

/** A broadcast transaction a recovery may speed up, and the hooks around its replacements. */
export interface StuckTransactionTarget {
  /** The wallet that signed it; it signs every replacement too. */
  readonly signer: EvmSigner;
  readonly signedTx: string;
  readonly txHash: string;
  /** The nonce read at signing. Without it nothing can be proven about the slot. */
  readonly nonce: number | undefined;
  readonly label: string;
  readonly beforeBroadcast?: (signal: ReplacementBroadcastSignal) => Promise<void> | void;
  readonly onReplaced?: () => void;
}

/** The adapter plumbing a recovery runs on. */
export interface StuckTransactionChain {
  readonly receiptTimeoutMs: number;
  readonly maxFeePerGasCap?: bigint;
  readonly feeFloor?: ChainFeeFloor;
  /** A tip-fresh read served by one endpoint. */
  readonly readHead: <T>(label: string, read: (provider: JsonRpcProvider) => Promise<T>) => Promise<T>;
  readonly read: <T>(label: string, read: (provider: JsonRpcProvider) => Promise<T>) => Promise<T>;
  readonly broadcast: (signedTx: string, txHash: string, label: string) => Promise<void>;
}

/**
 * The recovery for one broadcast transaction, or undefined when it cannot be
 * re-priced: its nonce was not read at signing, or it is not EIP-1559.
 */
export function stuckTransactionRecoveryFor(
  target: StuckTransactionTarget,
  chain: StuckTransactionChain,
): StuckTransactionRecovery | undefined {
  if (target.nonce === undefined) return undefined;
  const fees = signedEip1559Fees(target.signedTx);
  if (!fees) return undefined;
  const { signer, label } = target;
  return new StuckTransactionRecovery({
    original: { txHash: target.txHash, signedTx: target.signedTx, fees },
    nonce: target.nonce,
    label,
    receiptTimeoutMs: chain.receiptTimeoutMs,
    checkIntervalMs: stuckTransactionCheckIntervalMs(chain.receiptTimeoutMs),
    maxFeePerGasCap: chain.maxFeePerGasCap,
    port: {
      // One endpoint answers both, so the nonce and base fee describe one head.
      readChainHead: () => chain.readHead('stuck transaction check', async (provider) => {
        const [latestNonce, block] = await Promise.all([
          provider.getTransactionCount(signer.address, 'latest'),
          provider.getBlock('latest'),
        ]);
        return { latestNonce, baseFeePerGas: block?.baseFeePerGas ?? null };
      }),
      priceFees: (baseFeePerGas) => chain.read('replacement fee pricing', async (provider) =>
        priceEip1559Fees({
          baseFeePerGas,
          suggestedPriorityFeePerGas: await readSuggestedPriorityFee(provider),
          floor: chain.feeFloor,
        })),
      sign: async (request) => {
        const { signedTx, parsed } = await signTransactionOnce(signer, request);
        return { signedTx, txHash: parsed.hash ?? '0x' };
      },
      ...(target.beforeBroadcast ? { beforeBroadcast: target.beforeBroadcast } : {}),
      broadcast: (signedTx, txHash) => chain.broadcast(signedTx, txHash, label),
      ...(target.onReplaced ? { onReplaced: target.onReplaced } : {}),
    },
  });
}

/** An error's text for a log line, without the request URL (it may carry an API key). */
function describeError(err: unknown): string {
  return hostOnlyRpcText(errorMessage(err));
}
