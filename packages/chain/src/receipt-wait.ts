// SPDX-License-Identifier: Apache-2.0

import { createRpcTimeoutError, isChainRpcTransportError } from './chain-rpc-transport-error.js';
import { isRetryableRpcError, sleep } from './evm-adapter-rpc.js';

export interface ReceiptWaitTimeoutContext {
  txHash: string;
  receiptTimeoutMs: number;
  lastError: unknown;
}

export interface WaitForReceiptWithDeadlineOptions<TReceipt> {
  txHash: string;
  /**
   * Every hash that may carry this operation's receipt, looked up together on
   * each tick, so a slow lookup for one cannot starve the others; read again on
   * every tick, so it may grow while the wait runs (a stuck transaction's
   * same-nonce replacements join the original). The first eligible receipt to
   * come back decides the outcome: an ineligible one (not yet final, or no
   * longer canonical) does not hide the others. Defaults to `[txHash]`.
   */
  txHashes?: () => readonly string[];
  /** The hash the timeout names; defaults to the last of `txHashes`. */
  timeoutTxHash?: () => string;
  receiptTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Fetch one receipt across the configured endpoint set. The absolute
   * deadline is required here so the endpoint pass cannot outlive this wait.
   */
  getReceipt: (
    txHash: string,
    options: { deadlineMs: number },
  ) => Promise<TReceipt | null>;
  /**
   * Optional policy gate for a mined receipt. A false result keeps polling.
   * EVM writes use this to wait for the operator-selected canonical depth.
   */
  isReceiptEligible?: (
    receipt: TReceipt,
    options: { deadlineMs: number },
  ) => Promise<boolean>;
  assertSuccessfulReceipt: (receipt: TReceipt) => void;
  /**
   * Called after each tick that found no eligible receipt, and once more when
   * the deadline is reached (`deadlineReached: true`) before the wait gives up.
   * It may act on a stuck transaction, and may return a later absolute
   * deadline to keep waiting; returning nothing keeps the current one.
   */
  onPending?: (context: { deadlineMs: number; deadlineReached: boolean }) => Promise<number | void>;
  formatTimeoutMessage: (context: ReceiptWaitTimeoutContext) => string;
}

/**
 * Canonical operation-level receipt wait used by adapter-backed and direct CLI
 * writes. This primitive owns only the absolute deadline, polling cadence,
 * retryable-error handling, and final typed `RPC_TIMEOUT` creation. Endpoint
 * ordering/failover belongs to `RpcFailoverClient`; every pass receives this
 * same operation deadline. What happens to a transaction that stays unmined
 * (speed-up, deadline renewal) belongs to the caller's `onPending`.
 */
export async function waitForReceiptWithDeadline<TReceipt>(
  options: WaitForReceiptWithDeadlineOptions<TReceipt>,
): Promise<TReceipt> {
  const txHashes = options.txHashes ?? (() => [options.txHash]);
  let deadlineMs = Date.now() + options.receiptTimeoutMs;
  let lastError: unknown;

  for (;;) {
    while (Date.now() < deadlineMs) {
      // Each hash is looked up and, once its receipt returns, checked for
      // eligibility on its own, so a slow lookup for one hash delays neither
      // the lookup nor the (deadline-bound) finality check of another.
      const receipt = await firstEligibleReceipt(txHashes().map(async (txHash) => {
        let found: TReceipt | null;
        try {
          found = await options.getReceipt(txHash, { deadlineMs });
        } catch (err) {
          // A transport-class failure inside this budgeted wait consumes budget, never the
          // operation: an exhausted endpoint pass (RPC_RECEIPT_LOOKUP_FAILED — classified
          // non-retryable so ONE-SHOT lookups fail fast) or any other chain-namespaced
          // transport code keeps polling until the deadline, exactly like a retryable blip.
          // The tx may already be on the wire, so dying here with budget left would demote a
          // healthy publish into the recovery lane over a single flaky poll tick. Once the
          // deadline is consumed, the operation-level RPC_TIMEOUT below is authoritative,
          // carrying the last transport error as cause. Everything outside the retryable and
          // transport sets (deterministic classifications) still aborts immediately.
          if (!isRetryableRpcError(err) && !isChainRpcTransportError(err)) throw err;
          lastError = err;
          return null;
        }
        if (!found) return null;
        try {
          return (await options.isReceiptEligible?.(found, { deadlineMs }) ?? true) ? found : null;
        } catch (err) {
          if (!isRetryableRpcError(err)) throw err;
          lastError = err;
          return null;
        }
      }));
      // Receipt validation is deliberately OUTSIDE the transport-retry handling.
      // A deterministic mined revert must remain CALL_EXCEPTION even when the
      // lookup completes at or just after the operation deadline.
      if (receipt) {
        options.assertSuccessfulReceipt(receipt);
        return receipt;
      }
      if (Date.now() >= deadlineMs) break;

      const extendedMs = await options.onPending?.({ deadlineMs, deadlineReached: false });
      if (typeof extendedMs === 'number' && extendedMs > deadlineMs) deadlineMs = extendedMs;

      const sleepMs = Math.min(options.pollIntervalMs, deadlineMs - Date.now());
      if (sleepMs > 0) await sleep(sleepMs);
    }

    const renewedMs = await options.onPending?.({ deadlineMs, deadlineReached: true });
    if (typeof renewedMs !== 'number' || renewedMs <= Date.now()) break;
    deadlineMs = renewedMs;
  }

  const waitedHashes = txHashes();
  const txHash = options.timeoutTxHash?.() ?? waitedHashes[waitedHashes.length - 1] ?? options.txHash;
  throw createRpcTimeoutError(
    options.formatTimeoutMessage({
      txHash,
      receiptTimeoutMs: options.receiptTimeoutMs,
      lastError,
    }),
    { cause: lastError, txHash },
  );
}

/**
 * The first receipt any of `checks` settles with, without waiting for the
 * others; null once all of them settled with none. A check that throws ends
 * the wait at once, as a deterministic lookup failure always has.
 */
function firstEligibleReceipt<TReceipt>(checks: Array<Promise<TReceipt | null>>): Promise<TReceipt | null> {
  return new Promise((resolve, reject) => {
    let pending = checks.length;
    if (pending === 0) resolve(null);
    for (const check of checks) {
      check.then((receipt) => {
        if (receipt) resolve(receipt);
        else if (--pending === 0) resolve(null);
      }, reject);
    }
  });
}
