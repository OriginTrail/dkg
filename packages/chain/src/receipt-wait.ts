// SPDX-License-Identifier: Apache-2.0

import { createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { isRetryableRpcError, sleep } from './evm-adapter-rpc.js';

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
    try {
      const receipt = await options.getReceipt(options.txHash, { deadlineMs });
      if (receipt) {
        options.assertSuccessfulReceipt(receipt);
        return receipt;
      }
    } catch (err) {
      // A deadline-capped endpoint pass may wrap its final per-attempt timeout
      // as RPC_RECEIPT_LOOKUP_FAILED. Once that pass consumed the complete
      // operation budget, the operation-level RPC_TIMEOUT is authoritative.
      if (Date.now() >= deadlineMs) {
        lastError = err;
        break;
      }
      if (!isRetryableRpcError(err)) throw err;
      lastError = err;
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
