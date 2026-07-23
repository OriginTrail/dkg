// SPDX-License-Identifier: Apache-2.0

/**
 * Low-level RPC plumbing extracted from evm-adapter.ts: timing helpers
 * (`sleep` / `withTimeout`), RPC URL normalisation (`resolveRpcUrls`),
 * the bounded-retry `FetchRequest` factory, transient-error
 * classification (`isRetryableRpcError`), and receipt / known-tx
 * assertions. Bodies are a 1:1 move from the original module.
 */
import { ethers, FetchRequest } from 'ethers';
import {
  enrichEvmError,
  errorCode,
  errorMessage,
  errorName,
  errorStatus,
} from './evm-adapter-errors.js';
import { createRpcTimeoutError } from './chain-rpc-transport-error.js';
import { cancellableRpcGetUrl } from './rpc-request-transport.js';

/**
 * Per-request retry bound for ethers' built-in `FetchRequest`. ethers v6
 * retries HTTP 429 / 5xx responses with exponential backoff via
 * `FetchRequest.retryFunc`; the default keeps retrying for far longer than any
 * caller-side timeout, so a perpetually rate-limited (429) RPC makes a plain
 * read (e.g. `Hub.getContractAddress` inside `init()`, which sits on the
 * critical path of `createOnChainContextGraph` / context-graph register) hang
 * for minutes — register then never returns its `RPC_ENDPOINTS_EXHAUSTED`→503
 * in bounded time (#894 follow-up: surfaced once the boot timeout stopped the
 * daemon hanging at startup). Bounding the retry lets a sustained RPC error
 * surface as a normal (retryable) RPC error, so the adapter's own multi-RPC
 * failover + `RPC_ENDPOINTS_EXHAUSTED` wrapping kick in within seconds instead
 * of stalling. A transient single 429 is still retried (resilience preserved);
 * only a perpetually-failing endpoint gives up fast.
 *
 * The bound is the per-request RETRY COUNT (`attempt`), NOT a wall-clock
 * deadline. ethers resets `attempt` to 0 for every new top-level request and
 * increments it per retry, so an attempt-count cap is inherently per-request —
 * unlike a `Date.now()`-based deadline captured at provider construction, which
 * would (once the node had been up longer than the budget) instantly disable
 * retries for the rest of the process lifetime (Codex PR #901 round-3 :125).
 * With the capped backoff below, `RPC_REQUEST_MAX_RETRIES` retries span roughly
 * `RPC_REQUEST_MAX_RETRIES * backoffCap` ≈ 7.5s of wall time under a fast-
 * failing endpoint — bounded, and well under the daemon route / test ceilings.
 */
const RPC_REQUEST_MAX_RETRIES = 5;
const RPC_REQUEST_RETRY_BACKOFF_CAP_MS = 1_500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(createRpcTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export function resolveRpcUrls(rpcUrl: string, rpcUrls?: string[]): string[] {
  const out: string[] = [];
  for (const candidate of [rpcUrl, ...(rpcUrls ?? [])]) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  if (out.length === 0) {
    throw new Error('EVMChainAdapter requires at least one RPC URL');
  }
  return out;
}

/**
 * Build a `FetchRequest` whose retry loop gives up after `maxRetries` retries.
 * A bare string URL would use ethers' unbounded default; we install a bounded
 * `retryFunc` instead. The bound is evaluated from `attempt` (per-request), so
 * every request — no matter how long the node has been running — gets the same
 * fresh retry budget.
 *
 * `maxRetries` is chosen by the adapter from the configured endpoint count
 * (`evm-adapter-base.ts` constructor):
 *   - **Multi-RPC (≥2 endpoints): `0`** — the FIRST retryable failure (429/5xx/
 *     network) propagates immediately so the adapter's explicit per-provider
 *     read/write failover loops advance to the NEXT endpoint at once, instead of
 *     burning ~7.5s of same-endpoint backoff on an endpoint we already know is
 *     failing. With ≥2 endpoints the failover loop IS the resilience.
 *   - **Single-RPC: `RPC_REQUEST_MAX_RETRIES` (5)** — unchanged. There is
 *     nowhere to fail over to, so the bounded same-endpoint retry is the only
 *     resilience and rides out a transient blip while still surfacing a
 *     perpetual error as a bounded `RPC_ENDPOINTS_EXHAUSTED`→503 (#894).
 *
 * `maxRetries = 0` makes `retryFunc` return `false` on attempt 0 with NO sleep,
 * so the failure surfaces synchronously to the failover loop.
 */
export function boundedRetryFetchRequest(
  url: string,
  maxRetries: number = RPC_REQUEST_MAX_RETRIES,
): FetchRequest {
  const req = new FetchRequest(url);
  // ethers 6.16's Node getUrl cancellation rejects the FetchRequest but does
  // not close its underlying socket. Use the platform fetch transport so the
  // same FetchCancelSignal also aborts the active HTTP request.
  req.getUrlFunc = cancellableRpcGetUrl;
  req.retryFunc = async (_attemptReq, _response, attempt) => {
    if (attempt >= maxRetries) return false;
    await sleep(Math.min(500 * (attempt + 1), RPC_REQUEST_RETRY_BACKOFF_CAP_MS));
    return true;
  };
  return req;
}

/**
 * Is `err` a transient RPC failure worth retrying / failing over (vs a
 * deterministic chain revert / argument error)? Inspects ethers/fetch error
 * shapes thoroughly — top-level AND nested `error.code` / `statusCode` /
 * `response.status` / `error.status` (via `errorCode` / `errorStatus`), plus a
 * message probe — so a 429/5xx buried in a nested field is still recognised.
 * Exported so consumers (e.g. the agent's boot-recovery transient gate) reuse
 * the SAME extraction instead of duplicating a narrower top-level-only subset
 * (Codex PR #901 round-4 :459).
 */
export function isRetryableRpcError(err: unknown): boolean {
  if (err instanceof Error) enrichEvmError(err);
  const code = errorCode(err);
  const status = errorStatus(err);
  const msg = errorMessage(err).toLowerCase();
  const name = errorName(err);

  if (code === 'CALL_EXCEPTION' || code === 'INSUFFICIENT_FUNDS' || code === 'NONCE_EXPIRED'
    || code === 'RPC_RECEIPT_LOOKUP_FAILED'
    || code === 'REPLACEMENT_UNDERPRICED' || code === 'TRANSACTION_REPLACED'
    || code === 'ACTION_REJECTED' || code === 'INVALID_ARGUMENT' || code === 'UNPREDICTABLE_GAS_LIMIT') {
    return false;
  }
  if (msg.includes('execution reverted') || msg.includes('call exception')
    || msg.includes('insufficient funds') || msg.includes('invalid argument')
    || msg.includes('nonce too low') || msg.includes('replacement transaction underpriced')
    || msg.includes('intrinsic gas too low') || msg.includes('exceeds block gas limit')) {
    return false;
  }

  // Node/undici/ethers surface an aborted fetch as DOMException
  // `{ name: 'AbortError' }` (and some Node paths also stamp `ABORT_ERR`).
  // At the chain-RPC boundary this is a transport interruption, not a
  // deterministic EVM result. Treat it like the timeout/network cases below so
  // the SAME signed transaction or point read fails over to another endpoint.
  // This is especially important after `eth_sendRawTransaction`: an RPC can
  // accept the tx and then abort the client response, so fail-fast would report
  // publish failure even though the mint is already on chain.
  if (name === 'AbortError' || code === 'ABORT_ERR') return true;

  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  if (code === 'TIMEOUT' || code === 'RPC_TIMEOUT' || code === 'TIMEOUT_ERROR' || code === 'SERVER_ERROR'
    || code === 'NETWORK_ERROR' || code === 'ECONNRESET' || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || code === 'UNKNOWN_ERROR' || code === 'BAD_DATA'
    // Our own synthetic "all configured RPC endpoints exhausted" code — by
    // definition retryable, regardless of the aggregated message text.
    || code === 'RPC_ENDPOINTS_EXHAUSTED') {
    return true;
  }
  // `no runners?!` is ethers' FallbackProvider error (provider-fallback.js)
  // when EVERY configured sub-provider is unavailable — i.e. all RPC endpoints
  // are exhausted. On a multi-RPC node a perpetual 429 surfaces as this rather
  // than a raw `429`/`SERVER_ERROR` (which is what a single-provider config
  // throws), so classify it as retryable too — otherwise `init()`'s Hub reads
  // would propagate it un-coded and `/api/context-graph/register` would 500
  // instead of the bounded 503 (#894 follow-up).
  return /timeout|timed out|network|socket|reset|econnreset|econnrefused|etimedout|enotfound|eai_again|rate limit|too many requests|429|503|502|500|gateway|temporarily unavailable|fetch failed|connection|no runners/i
    .test(msg);
}

/** Canonical classifier for provider throttling, shared by failover policy. */
export function isThrottleRpcError(err: unknown): boolean {
  if (err instanceof Error) enrichEvmError(err);
  const status = errorStatus(err);
  const message = errorMessage(err).toLowerCase();
  return status === 429 || /\b429\b|too many requests|rate[ -]?limit|throttl/.test(message);
}

export function assertSuccessfulReceipt(receipt: ethers.TransactionReceipt, label: string): void {
  if (receipt.status !== 0) return;
  const err = Object.assign(
    new Error(`${label} tx ${receipt.hash} was mined but reverted (status=0)`),
    {
      code: 'CALL_EXCEPTION' as const,
      receipt,
    },
  );
  throw err;
}

export function isKnownTransactionError(err: unknown): boolean {
  const code = errorCode(err);
  const msg = errorMessage(err).toLowerCase();
  return code === 'NONCE_EXPIRED'
    || msg.includes('already known')
    || msg.includes('known transaction')
    || msg.includes('already imported')
    || msg.includes('transaction already in mempool')
    || msg.includes('already exists')
    || msg.includes('already have transaction')
    || msg.includes('nonce too low')
    || msg.includes('duplicate transaction');
}
