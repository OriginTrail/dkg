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
