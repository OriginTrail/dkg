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

/** @internal Shared only between chain-package receipt transports. */
export interface ReceiptEndpointLookupContext {
  /** One-based endpoint number, used only for bounded diagnostic labels. */
  attempt: number;
  /** Per-attempt cap, already clipped to the remaining operation budget. */
  attemptTimeoutMs: number;
  /** Optional absolute operation deadline for transports with preflight work. */
  deadlineMs?: number;
}

/** @internal Shared only between chain-package receipt transports. */
export type ReceiptEndpointLookupResult<TReceipt> =
  | { kind: 'response'; receipt: TReceipt | null }
  | { kind: 'deadline' };

/** @internal Shared only between chain-package receipt transports. */
export interface ReceiptPassEndpoint<TReceipt> {
  /** Telemetry metadata only; absence must never remove an endpoint from flow. */
  rpcUrl?: string;
  lookup: (
    txHash: string,
    context: ReceiptEndpointLookupContext,
  ) => Promise<ReceiptEndpointLookupResult<TReceipt>>;
  recordSuccess?: () => void;
  recordFailure?: () => void;
}

/** @internal Shared only between chain-package receipt transports. */
export interface ReceiptPassOptions<TReceipt> {
  endpoints: readonly ReceiptPassEndpoint<TReceipt>[];
  txHash: string;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  logLabel: string;
  /** Canonical URL order for exhaustion telemetry when attempts are sticky. */
  exhaustionRpcUrls?: readonly string[];
  formatExhaustionMessage: (lastError: unknown) => string;
  onReceipt?: (
    endpoint: ReceiptPassEndpoint<TReceipt>,
    receipt: TReceipt,
  ) => void;
  onNonRetryableError?: (err: unknown) => void;
  onExhausted?: (lastError: unknown) => void;
}

/**
 * One canonical receipt endpoint-pass state machine. Both the adapter transport
 * and direct CLI writes use this loop for retry classification, null-response
 * semantics, failover/exhaustion telemetry, and deadline-aware endpoint order.
 * Endpoint-specific work (chain-id validation, stickiness, tracing) stays in
 * callbacks and therefore does not fork the failover control flow.
 * @internal Shared only between chain-package receipt transports.
 */
export async function getReceiptAcrossEndpoints<TReceipt>(
  options: ReceiptPassOptions<TReceipt>,
): Promise<TReceipt | null> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? RPC_RECEIPT_ATTEMPT_TIMEOUT_MS;
  let lastRetryable: unknown;
  let sawNonErrorResponse = false;

  for (let i = 0; i < options.endpoints.length; i += 1) {
    const endpoint = options.endpoints[i];
    const remainingMs = options.deadlineMs === undefined
      ? attemptTimeoutMs
      : options.deadlineMs - Date.now();
    if (remainingMs <= 0) break;

    try {
      const result = await endpoint.lookup(options.txHash, {
        attempt: i + 1,
        attemptTimeoutMs: Math.min(attemptTimeoutMs, remainingMs),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      });
      if (result.kind === 'deadline') break;

      sawNonErrorResponse = true;
      if (result.receipt) {
        endpoint.recordSuccess?.();
        options.onReceipt?.(endpoint, result.receipt);
        return result.receipt;
      }
    } catch (err) {
      if (!isRetryableRpcError(err)) {
        options.onNonRetryableError?.(err);
        throw err;
      }
      lastRetryable = err;
      endpoint.recordFailure?.();

      const nextEndpoint = options.endpoints[i + 1];
      const canTryNext = options.deadlineMs === undefined || Date.now() < options.deadlineMs;
      if (endpoint.rpcUrl && nextEndpoint?.rpcUrl && canTryNext) {
        noteRpcFailover(options.logLabel, endpoint.rpcUrl, err, nextEndpoint.rpcUrl);
      }
    }
  }

  if (lastRetryable && !sawNonErrorResponse) {
    options.onExhausted?.(lastRetryable);
    const rpcUrls = options.exhaustionRpcUrls
      ?? options.endpoints.map(endpoint => endpoint.rpcUrl);
    if (rpcUrls.every((url): url is string => typeof url === 'string')) {
      noteRpcExhaustion(options.logLabel, rpcUrls);
    }
    throw new ChainRpcTransportError(
      'RPC_RECEIPT_LOOKUP_FAILED',
      options.formatExhaustionMessage(lastRetryable),
      { cause: lastRetryable, txHash: options.txHash },
    );
  }

  return null;
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
 * retryable-error handling, and final typed `RPC_TIMEOUT` creation. The endpoint
 * pass is shared too; transports contribute only lookup hooks such as chain-id
 * validation, stickiness, and tracing. Every pass receives the same deadline.
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
  /** Overall submitted-transaction receipt deadline (default 10 minutes). */
  receiptTimeoutMs?: number;
  /** Low-cardinality transport label. Defaults to `direct transaction`. */
  logLabel?: string;
}

/** One direct receipt endpoint with optional telemetry metadata kept in-band. */
export interface TransactionReceiptEndpoint {
  provider: JsonRpcProvider;
  rpcUrl?: string;
}

/**
 * Stable direct-write boundary used by CLI commands after a raw transaction is
 * broadcast. Absolute-deadline and callback plumbing stay package-internal;
 * callers supply providers, a tx hash, and operator-facing timeout config.
 */
export async function waitForTransactionReceiptWithFailover(
  endpoints: readonly TransactionReceiptEndpoint[],
  txHash: string,
  options: TransactionReceiptWaitOptions = {},
): Promise<TransactionReceipt> {
  const receiptTimeoutMs = resolveReceiptTimeoutMs(options.receiptTimeoutMs);
  const logLabel = options.logLabel ?? 'direct transaction';
  const receiptPassEndpoints: ReceiptPassEndpoint<TransactionReceipt>[] = endpoints.map(endpoint => ({
    ...(endpoint.rpcUrl ? { rpcUrl: endpoint.rpcUrl } : {}),
    lookup: async (hash, context) => ({
      kind: 'response',
      receipt: await withTimeout(
        endpoint.provider.getTransactionReceipt(hash),
        context.attemptTimeoutMs,
        `receipt lookup via RPC #${context.attempt}`,
      ),
    }),
  }));

  return waitForReceiptWithDeadline({
    txHash,
    receiptTimeoutMs,
    pollIntervalMs: RPC_RECEIPT_POLL_INTERVAL_MS,
    getReceipt: (hash, { deadlineMs }) => getReceiptAcrossEndpoints({
      endpoints: receiptPassEndpoints,
      txHash: hash,
      deadlineMs,
      logLabel: `${logLabel} receipt lookup`,
      formatExhaustionMessage: lastError =>
        `Receipt lookup for transaction ${hash} failed on all configured RPC endpoints: ${errorMessage(lastError)}`,
    }),
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
