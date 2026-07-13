// SPDX-License-Identifier: Apache-2.0

import { type JsonRpcProvider, type TransactionReceipt } from 'ethers';
import { ChainRpcTransportError, createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { errorCode, errorMessage } from './evm-adapter-errors.js';
import {
  isRetryableRpcError,
  sleep,
  withTimeout,
} from './evm-adapter-rpc.js';
import {
  RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  RPC_RECEIPT_POLL_INTERVAL_MS,
  resolveReceiptTimeoutMs,
} from './evm-adapter-constants.js';
import { noteRpcExhaustion, noteRpcFailover } from './rpc-failover-log.js';

/**
 * Optional absolute deadline for one complete receipt-lookup pass. Transport
 * implementations must cap every endpoint attempt to the remaining budget so
 * the pass itself cannot keep running after the operation-level deadline.
 */
export interface ReceiptLookupOptions {
  deadlineMs?: number;
}

export interface ReceiptWaitTimeoutContext {
  txHash: string;
  receiptTimeoutMs: number;
  lastError: unknown;
}

export interface WaitForReceiptWithDeadlineOptions<TReceipt> {
  txHash: string;
  receiptTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Fetch one receipt across the configured endpoint set. The absolute
   * deadline is required here: each implementation must apply it inside its
   * per-endpoint loop rather than leaving a detached lookup pass running behind
   * an outer Promise.race.
   */
  getReceipt: (
    txHash: string,
    options: Required<ReceiptLookupOptions>,
  ) => Promise<TReceipt | null>;
  assertSuccessfulReceipt: (receipt: TReceipt) => void;
  formatTimeoutMessage: (context: ReceiptWaitTimeoutContext) => string;
}

/**
 * Canonical operation-level receipt wait used by adapter-backed and direct CLI
 * writes. This one primitive owns the absolute deadline, polling cadence,
 * retryable-error handling, and final typed `RPC_TIMEOUT` creation. Endpoint
 * failover remains transport-specific, but every lookup receives the same
 * absolute deadline and therefore shares one finite operation budget.
 */
export async function waitForReceiptWithDeadline<TReceipt>(
  options: WaitForReceiptWithDeadlineOptions<TReceipt>,
): Promise<TReceipt> {
  const deadlineMs = Date.now() + options.receiptTimeoutMs;
  let lastError: unknown;

  while (Date.now() < deadlineMs) {
    let receipt: TReceipt | null = null;
    try {
      receipt = await options.getReceipt(options.txHash, { deadlineMs });
    } catch (err) {
      // A deadline-capped endpoint pass may wrap its final per-attempt timeout
      // as RPC_RECEIPT_LOOKUP_FAILED. Once that pass consumed the complete
      // operation budget, the operation-level RPC_TIMEOUT is authoritative.
      const deadlineLookupFailure = Date.now() >= deadlineMs
        && errorCode(err) === 'RPC_RECEIPT_LOOKUP_FAILED';
      if (!isRetryableRpcError(err) && !deadlineLookupFailure) throw err;
      if (Date.now() >= deadlineMs) {
        lastError = err;
        break;
      }
      lastError = err;
    }

    // Receipt validation is deliberately OUTSIDE the transport-retry catch.
    // A deterministic mined revert must remain CALL_EXCEPTION even when the
    // lookup completes at or just after the operation deadline.
    if (receipt) {
      options.assertSuccessfulReceipt(receipt);
      return receipt;
    }

    const sleepMs = Math.min(options.pollIntervalMs, deadlineMs - Date.now());
    if (sleepMs > 0) await sleep(sleepMs);
  }

  throw createRpcTimeoutError(
    options.formatTimeoutMessage({
      txHash: options.txHash,
      receiptTimeoutMs: options.receiptTimeoutMs,
      lastError,
    }),
    { cause: lastError, txHash: options.txHash },
  );
}

export interface TransactionReceiptWaitOptions {
  /** Provider URLs paired by index for failover telemetry and diagnostics. */
  rpcUrls?: readonly string[];
  /** Overall submitted-transaction receipt deadline (default 10 minutes). */
  receiptTimeoutMs?: number;
  /** Low-cardinality transport label. Defaults to `direct transaction`. */
  logLabel?: string;
}

/**
 * Stable direct-write boundary used by CLI commands after a raw transaction is
 * broadcast. Absolute-deadline and callback plumbing stay package-internal;
 * callers supply providers, a tx hash, and operator-facing timeout config.
 */
export async function waitForTransactionReceiptWithFailover(
  providers: readonly JsonRpcProvider[],
  txHash: string,
  options: TransactionReceiptWaitOptions = {},
): Promise<TransactionReceipt> {
  const receiptTimeoutMs = resolveReceiptTimeoutMs(options.receiptTimeoutMs);
  const logLabel = options.logLabel ?? 'direct transaction';

  return waitForReceiptWithDeadline({
    txHash,
    receiptTimeoutMs,
    pollIntervalMs: RPC_RECEIPT_POLL_INTERVAL_MS,
    getReceipt: async (hash, { deadlineMs }) => {
      let lastRetryable: unknown;
      let sawNonErrorResponse = false;

      for (let i = 0; i < providers.length; i += 1) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) break;
        try {
          const receipt = await withTimeout(
            providers[i].getTransactionReceipt(hash),
            Math.min(RPC_RECEIPT_ATTEMPT_TIMEOUT_MS, remainingMs),
            `receipt lookup via RPC #${i + 1}`,
          );
          sawNonErrorResponse = true;
          if (receipt) return receipt;
        } catch (err) {
          if (!isRetryableRpcError(err)) throw err;
          lastRetryable = err;
          const canTryNext = Date.now() < deadlineMs;
          if (options.rpcUrls && i < providers.length - 1 && canTryNext) {
            noteRpcFailover(
              `${logLabel} receipt lookup`,
              options.rpcUrls[i],
              err,
              options.rpcUrls[i + 1],
            );
          }
        }
      }

      if (lastRetryable && !sawNonErrorResponse) {
        if (options.rpcUrls) noteRpcExhaustion(`${logLabel} receipt lookup`, options.rpcUrls);
        throw new ChainRpcTransportError(
          'RPC_RECEIPT_LOOKUP_FAILED',
          `Receipt lookup for transaction ${hash} failed on all configured RPC endpoints: ${errorMessage(lastRetryable)}`,
          { cause: lastRetryable, txHash: hash },
        );
      }
      return null;
    },
    assertSuccessfulReceipt: (receipt) => {
      if (receipt.status !== 0) return;
      const err = new Error(`Transaction ${txHash} was mined but reverted (status=0)`);
      (err as any).code = 'CALL_EXCEPTION';
      (err as any).receipt = receipt;
      throw err;
    },
    formatTimeoutMessage: () =>
      `Transaction ${txHash} was broadcast but no receipt was found within ${receiptTimeoutMs}ms`,
  });
}
