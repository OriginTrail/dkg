import type { ServerResponse } from 'node:http';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import { classifyQueryWorkTermination, QueryWorkTerminationUnconfirmedError } from '@origintrail-official/dkg-storage';
import { jsonResponse } from './http-utils.js';

/**
 * The node's own time limit for a SPARQL query on `/api/query`.
 *
 * When it passes, the query is stopped where the store can stop it: the
 * embedded worker store replaces its worker, Blazegraph and a DKG-managed
 * Oxigraph server get the limit as their own deadline. The caller then gets a
 * 504 that says so. `DKG_API_QUERY_TIME_LIMIT_MS` sets the limit once, at
 * startup; a request's `timeoutMs` may only lower it. `0` turns the node's
 * limit off, and then only a request's own `timeoutMs` sets one.
 *
 * A stop can cost a reload of the worker store or a restart of a managed
 * store, so no limit is shorter than MIN_API_QUERY_TIME_LIMIT_MS: a caller
 * cannot have the node stop, and reload, many times a second.
 */
export const DEFAULT_API_QUERY_TIME_LIMIT_MS = 30_000;
export const MIN_API_QUERY_TIME_LIMIT_MS = 1_000;
export const MAX_API_QUERY_TIME_LIMIT_MS = 600_000;
export const QUERY_TIME_LIMIT_EXCEEDED_CODE = 'QUERY_TIME_LIMIT_EXCEEDED';

export interface ApiQueryTimeLimitLogger {
  info(message: string): void;
  warn(message: string): void;
}

let nodeTimeLimitMs: number | null = DEFAULT_API_QUERY_TIME_LIMIT_MS;

/** `null` is no node limit. An unset, empty or invalid value keeps the default. */
export function resolveApiQueryTimeLimitMs(raw: string | undefined): { limitMs: number | null; valid: boolean } {
  const text = raw?.trim();
  if (!text) return { limitMs: DEFAULT_API_QUERY_TIME_LIMIT_MS, valid: true };
  if (!/^\d+$/.test(text)) return { limitMs: DEFAULT_API_QUERY_TIME_LIMIT_MS, valid: false };
  const value = Number(text);
  if (value === 0) return { limitMs: null, valid: true };
  if (value < MIN_API_QUERY_TIME_LIMIT_MS || value > MAX_API_QUERY_TIME_LIMIT_MS) {
    return { limitMs: DEFAULT_API_QUERY_TIME_LIMIT_MS, valid: false };
  }
  return { limitMs: value, valid: true };
}

/** Resolve and log the node's limit once during daemon startup. */
export function configureApiQueryTimeLimit(raw: string | undefined, logger: ApiQueryTimeLimitLogger): number | null {
  const { limitMs, valid } = resolveApiQueryTimeLimitMs(raw);
  if (!valid) {
    logger.warn(
      `Invalid DKG_API_QUERY_TIME_LIMIT_MS=${JSON.stringify(raw?.trim().slice(0, 32))}; expected 0 or an integer `
      + `from ${MIN_API_QUERY_TIME_LIMIT_MS} to ${MAX_API_QUERY_TIME_LIMIT_MS}. Falling back to ${DEFAULT_API_QUERY_TIME_LIMIT_MS} ms.`,
    );
  }
  nodeTimeLimitMs = limitMs;
  logger.info(limitMs === null
    ? 'API query time limit: off (DKG_API_QUERY_TIME_LIMIT_MS=0); a request may still set timeoutMs'
    : `API query time limit: ${limitMs} ms (DKG_API_QUERY_TIME_LIMIT_MS; a request may set a lower timeoutMs)`);
  return limitMs;
}

export function getApiQueryTimeLimitMs(): number | null {
  return nodeTimeLimitMs;
}

/** A request's limit: its own `timeoutMs` when given, never above the node's. */
export function requestQueryTimeLimitMs(
  timeoutMs: unknown,
  nodeLimitMs: number | null = nodeTimeLimitMs,
): { ok: true; limitMs: number | null } | { ok: false; error: string } {
  if (timeoutMs === undefined || timeoutMs === null) return { ok: true, limitMs: nodeLimitMs };
  const ceiling = nodeLimitMs ?? MAX_API_QUERY_TIME_LIMIT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)
      || timeoutMs < MIN_API_QUERY_TIME_LIMIT_MS || timeoutMs > ceiling) {
    return { ok: false, error: `timeoutMs must be an integer from ${MIN_API_QUERY_TIME_LIMIT_MS} to ${ceiling}` };
  }
  return { ok: true, limitMs: timeoutMs };
}

export interface ApiQueryTimeLimit {
  readonly limitMs: number;
  /** The `performance.now()` deadline handed to the store as `workDeadline`. */
  readonly deadlineAt: number;
  /** Aborts at the limit, or with the caller's reason when the caller leaves. */
  readonly signal: AbortSignal;
  /** The limit has passed. */
  expired(): boolean;
  release(): void;
}

export function startApiQueryTimeLimit(limitMs: number, caller: AbortSignal): ApiQueryTimeLimit {
  const deadlineAt = performance.now() + limitMs;
  const lifecycle = startRequestAbortLifecycle(limitMs, [caller]);
  return {
    limitMs,
    deadlineAt,
    signal: lifecycle.signal,
    expired: () => lifecycle.deadline.aborted || performance.now() >= deadlineAt,
    release: () => lifecycle.release(),
  };
}

/** Give cooperative stores at most five additional seconds to confirm physical termination. */
const API_QUERY_TERMINATION_GRACE_MS = 5_000;

/** Bound the HTTP wait even when a custom backend ignores cancellation. */
export function awaitApiQueryResult<T>(work: Promise<T>, limit: ApiQueryTimeLimit | undefined, caller: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      caller.removeEventListener('abort', disconnected);
      limit?.signal.removeEventListener('abort', expired);
      if (outcome.ok) resolve(outcome.value); else reject(outcome.error);
    };
    const disconnected = (): void => finish({ ok: false, error: caller.reason });
    const expired = (): void => {
      if (settled || grace !== undefined || !limit?.expired()) return;
      grace = setTimeout(() => finish({ ok: false,
        error: new QueryWorkTerminationUnconfirmedError(limit.signal.reason),
      }), Math.max(0, limit.deadlineAt + API_QUERY_TERMINATION_GRACE_MS - performance.now()));
      grace.unref?.();
    };
    // Both handlers remain attached after a fallback response: late settlement
    // cannot write another response or become an unhandled rejection.
    void work.then(value => finish({ ok: true, value }), error => finish({ ok: false, error }));
    caller.addEventListener('abort', disconnected, { once: true });
    limit?.signal.addEventListener('abort', expired, { once: true });
    if (caller.aborted) disconnected(); else if (limit?.expired()) expired();
  });
}

/**
 * 504: the time limit ended the query. `stopped` is true when the store
 * reported that it stopped the query's work, or never started it.
 */
export function respondQueryTimeLimitExceeded(res: ServerResponse, limitMs: number, error: unknown): void {
  const stopped = classifyQueryWorkTermination(error) === 'confirmed';
  jsonResponse(res, 504, {
    code: QUERY_TIME_LIMIT_EXCEEDED_CODE,
    error: stopped
      ? `The query ran past its time limit of ${limitMs} ms, and the node stopped it.`
      : `The query ran past its time limit of ${limitMs} ms. The node could not confirm that the store stopped this query, so it may still be running.`,
    timeLimitMs: limitMs,
    stopped,
    retryable: false,
  });
}
