// SPDX-License-Identifier: Apache-2.0

import { createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { errorCode } from './evm-adapter-errors.js';
import { isRetryableRpcError, sleep } from './evm-adapter-rpc.js';

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
  formatTimeoutMessage: (context: ReceiptWaitTimeoutContext) => string;
}

/**
 * Canonical operation-level receipt wait used by adapter-backed and direct CLI
 * writes. This primitive owns only the absolute deadline, polling cadence,
 * retryable-error handling, and final typed `RPC_TIMEOUT` creation. Endpoint
 * ordering/failover belongs to `RpcFailoverClient`; every pass receives this
 * same operation deadline.
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
      let eligible = false;
      try {
        eligible = await options.isReceiptEligible?.(receipt, { deadlineMs }) ?? true;
      } catch (err) {
        if (!isRetryableRpcError(err)) throw err;
        lastError = err;
        if (Date.now() >= deadlineMs) break;
      }
      if (eligible) {
        options.assertSuccessfulReceipt(receipt);
        return receipt;
      }
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
