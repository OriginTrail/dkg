// SPDX-License-Identifier: Apache-2.0

/**
 * Observability for multi-RPC failover. Records + logs the per-provider
 * failovers in BOTH the EVM adapter's write loops AND its read-failover loop
 * (the `RpcFailoverClient` read core + the V10 populate loop), plus the CLI
 * stack in `cli-rpc.ts`, under three invariants the callers depend on:
 *
 *  1. Dedup-gated logging — at most one line per `host|errorClass` per
 *     `DEFAULT_DEDUP_WINDOW_MS` (5 min) with a suppressed-count rollup, so a
 *     stuck write (the receipt poll retries every backend repeatedly over its
 *     180s budget) cannot flood the logs.
 *  2. Synchronous and never-throwing — the call sits inside the failover loops
 *     between the `lastRetryable` assignment and `continue`, so it must never
 *     abort failover (the whole body is wrapped and is never `await`ed).
 *  3. Host-only — full RPC URLs (which may carry API keys) never leave this
 *     module; counters and logs use the URL host only.
 *
 * Counters are a PROCESS-WIDE singleton: the daemon builds one adapter per
 * agent + per publisher wallet, and `/api/status` reads the aggregate via a
 * direct getter import. Scope covers BOTH read and write failover — reads route
 * through the `RpcFailoverClient` read core (the ethers `FallbackProvider` was
 * removed; see `evm-adapter-base.ts`), so both halves funnel their per-hop
 * failovers and exhaustions through this module.
 */

import { errorCode, errorMessage, errorStatus } from './evm-adapter-errors.js';
import { DEFAULT_DEDUP_WINDOW_MS } from './filter-error-silencer.js';

/** Bounded classification of a transient failover cause. Never the raw
 *  message (which has unbounded cardinality and would defeat the dedup). */
export type RpcFailoverErrorClass =
  | 'THROTTLE_429'
  | 'SERVER_5XX'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'EXHAUSTED'
  | 'OTHER';

/** Reduce an arbitrary RPC error to a small, bounded class. */
export function classifyRpcFailoverError(err: unknown): RpcFailoverErrorClass {
  const code = errorCode(err);
  const status = errorStatus(err);
  // `errorMessage` returns `JSON.stringify(err)` for non-Error inputs, and
  // `JSON.stringify(undefined) === undefined` (the JS value), so coerce
  // defensively — an `undefined` error must classify as OTHER, never throw.
  const msg = String(errorMessage(err) ?? '').toLowerCase();

  if (code === 'RPC_ENDPOINTS_EXHAUSTED' || msg.includes('no runners')) return 'EXHAUSTED';
  if (status === 429 || /rate limit|too many requests|\b429\b/.test(msg)) return 'THROTTLE_429';
  if ((typeof status === 'number' && status >= 500) || /\b(500|502|503|gateway|temporarily unavailable)\b/.test(msg)) {
    return 'SERVER_5XX';
  }
  if (code === 'TIMEOUT' || code === 'TIMEOUT_ERROR' || /timeout|timed out/.test(msg)) return 'TIMEOUT';
  if (
    code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' || code === 'ECONNRESET' || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || /network|socket|reset|econnreset|econnrefused|etimedout|enotfound|fetch failed|connection/.test(msg)
  ) {
    return 'NETWORK';
  }
  return 'OTHER';
}

/** Host-only reduction of an RPC URL (never expose full URLs / keys). */
export function rpcHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host || parsed.protocol || 'unknown-rpc';
  } catch {
    return 'unparseable-rpc';
  }
}

// --- Process-wide counters (host-only) --------------------------------------

interface MutableStats {
  failovers: number;
  exhaustions: number;
  // CUMULATIVE, monotonically-increasing count of establishment edges — each
  // time endpoint-stickiness newly ESTABLISHED a preferred (last-good) backend
  // after a failover (the primary was degraded). It is NOT decremented when the
  // primary recovers and the preference is cleared; only the process-wide test
  // reset (`_resetRpcFailoverStatsForTest`) zeroes it. A rising rate is the
  // operator's signal that a configured primary is flapping. It is NOT a gauge of
  // the current active preference (that state lives on the client instance) — for
  // "is a preference active right now" a separate gauge would be needed.
  preferredEstablishments: number;
  byErrorClass: Map<RpcFailoverErrorClass, number>;
  byEndpointHost: Map<string, number>;
  // Per-host count of successful calls each endpoint SERVED — symmetric with
  // `byEndpointHost` (which counts failures). This is the operator's "which
  // provider is actually carrying the traffic" distribution, the success-side
  // complement to the failover log.
  servedByEndpointHost: Map<string, number>;
}

/** Cap the per-host map so a pathological churn of hosts can't grow it
 *  without bound (real configs have <=~4 endpoints per chain). */
const MAX_TRACKED_HOSTS = 64;
const MAX_DEDUP_KEYS = 256;

function freshStats(): MutableStats {
  return {
    failovers: 0,
    exhaustions: 0,
    preferredEstablishments: 0,
    byErrorClass: new Map(),
    byEndpointHost: new Map(),
    servedByEndpointHost: new Map(),
  };
}

let stats: MutableStats = freshStats();

// Last host that successfully served each stable operation key — drives the
// log-on-change gate for high-volume reads (so we log a provider shift, not
// every call). This deliberately does NOT key by the human log label: call-site
// wording is presentation, not process-wide state. Bounded with LRU eviction so
// overflow labels can still suppress repeated same-host read logs.
const lastServedByKey = new Map<string, string>();

function bump(map: Map<string, number>, key: string, cap: number): void {
  if (!map.has(key) && map.size >= cap) return; // bounded; drop new keys past the cap
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Snapshot for `/api/status` — host-only, plain JSON. */
export interface RpcFailoverStatsSnapshot {
  failovers: number;
  exhaustions: number;
  preferredEstablishments: number;
  byErrorClass: Record<string, number>;
  byEndpointHost: Record<string, number>;
  servedByEndpointHost: Record<string, number>;
}

export function getRpcFailoverStats(): RpcFailoverStatsSnapshot {
  return {
    failovers: stats.failovers,
    exhaustions: stats.exhaustions,
    preferredEstablishments: stats.preferredEstablishments,
    byErrorClass: Object.fromEntries(stats.byErrorClass),
    byEndpointHost: Object.fromEntries(stats.byEndpointHost),
    servedByEndpointHost: Object.fromEntries(stats.servedByEndpointHost),
  };
}

/** Test-only reset of the process-wide counters + dedup window. */
export function _resetRpcFailoverStatsForTest(): void {
  stats = freshStats();
  dedup.clear();
  lastServedByKey.clear();
  clockOverride = undefined;
}

// --- Dedup'd, never-throwing logger -----------------------------------------

const dedup = new Map<string, { lastEmitAt: number; suppressed: number }>();
let clockOverride: (() => number) | undefined;

/** Test-only clock injection (so fake-timer tests can drive the window). */
export function _setRpcFailoverClockForTest(now: (() => number) | undefined): void {
  clockOverride = now;
}

function nowMs(): number {
  return (clockOverride ?? Date.now)();
}

/**
 * Emit-path write to the shared dedup map, bounded to MAX_DEDUP_KEYS. Used by
 * BOTH writers so the map can never grow without bound regardless of which one
 * overflows it. Map preserves insertion order, so the first key is the
 * oldest-inserted — O(1) eviction, no sort.
 */
function setDedup(key: string, now: number): void {
  dedup.set(key, { lastEmitAt: now, suppressed: 0 });
  while (dedup.size > MAX_DEDUP_KEYS) {
    const oldest = dedup.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    dedup.delete(oldest);
  }
}

/**
 * Record + log a single per-provider write failover. Synchronous and
 * guaranteed never to throw (any internal failure — including a throwing
 * `console.warn` — is swallowed) so it is safe to call inside a failover
 * loop without altering control flow. Emits at most one line per
 * `host|errorClass` per dedup window, with a suppressed-count rollup.
 *
 * @param label     operation label, e.g. `V10 publish broadcast`
 * @param failedUrl the RPC URL that just failed (reduced to host before logging)
 * @param err       the (retryable) error that triggered failover
 * @param nextUrl   the endpoint failover will try next, if any (host-only)
 */
export function noteRpcFailover(
  label: string,
  failedUrl: string,
  err: unknown,
  nextUrl?: string,
): void {
  try {
    const host = rpcHost(failedUrl);
    const errClass = classifyRpcFailoverError(err);

    stats.failovers += 1;
    stats.byErrorClass.set(errClass, (stats.byErrorClass.get(errClass) ?? 0) + 1);
    bump(stats.byEndpointHost, host, MAX_TRACKED_HOSTS);

    const key = `${host}|${errClass}`;
    const now = nowMs();
    const entry = dedup.get(key);
    const shouldEmit = !entry || now - entry.lastEmitAt >= DEFAULT_DEDUP_WINDOW_MS;
    if (shouldEmit) {
      const suppressed = entry?.suppressed ?? 0;
      const suffix = suppressed > 0 ? ` (${suppressed} similar failovers suppressed in the previous window)` : '';
      const next = nextUrl ? `, trying ${rpcHost(nextUrl)}` : ', no further endpoints';
      // eslint-disable-next-line no-console
      console.warn(`[chain] RPC failover: ${label} via ${host} failed (${errClass})${next}${suffix}`);
      setDedup(key, now);
    } else {
      entry.suppressed += 1;
    }
  } catch {
    // Observability must never break the failover path.
  }
}

/**
 * Record + log the terminal "all configured RPC endpoints exhausted"
 * condition. Host-only — does NOT print the full `rpcUrls.join()` aggregate
 * the thrown error carries. Synchronous and never-throwing.
 */
export function noteRpcExhaustion(label: string, urls: readonly string[]): void {
  try {
    stats.exhaustions += 1;
    const hosts = urls.map(rpcHost);
    const key = `EXHAUSTED|${label}|${hosts.join(',')}`;
    const now = nowMs();
    const entry = dedup.get(key);
    const shouldEmit = !entry || now - entry.lastEmitAt >= DEFAULT_DEDUP_WINDOW_MS;
    if (shouldEmit) {
      const suppressed = entry?.suppressed ?? 0;
      const suffix = suppressed > 0 ? ` (${suppressed} similar exhaustions suppressed in the previous window)` : '';
      // eslint-disable-next-line no-console
      console.warn(`[chain] RPC endpoints exhausted: ${label} failed on all ${hosts.length} endpoint(s) [${hosts.join(', ')}]${suffix}`);
      setDedup(key, now);
    } else {
      entry.suppressed += 1;
    }
  } catch {
    // Observability must never break the failover path.
  }
}

/**
 * Record + log that endpoint-stickiness ESTABLISHED a preferred (last-good)
 * backend after a failover — the `RpcFailoverClient` will now try `preferredUrl`
 * first (until a TTL'd primary re-probe succeeds). Host-only, dedup-gated, and
 * never-throwing, symmetric with {@link noteRpcFailover}: it sits on the success
 * path inside the failover loops and must never alter control flow. Gives
 * operators a visible "we're leaning on a backup because the primary is
 * degraded" signal (also counted in {@link getRpcFailoverStats}).
 */
export function notePreferredEndpoint(label: string, preferredUrl: string): void {
  try {
    stats.preferredEstablishments += 1;
    const host = rpcHost(preferredUrl);
    const key = `PREFERRED|${host}`;
    const now = nowMs();
    const entry = dedup.get(key);
    const shouldEmit = !entry || now - entry.lastEmitAt >= DEFAULT_DEDUP_WINDOW_MS;
    if (shouldEmit) {
      const suppressed = entry?.suppressed ?? 0;
      const suffix = suppressed > 0 ? ` (${suppressed} similar re-establishments suppressed in the previous window)` : '';
      // eslint-disable-next-line no-console
      console.warn(`[chain] RPC stickiness: ${label} now prefers ${host} (primary degraded)${suffix}`);
      setDedup(key, now);
    } else {
      entry.suppressed += 1;
    }
  } catch {
    // Observability must never break the failover path.
  }
}

/**
 * Record + log which endpoint SERVED a successful call/tx — the success-side
 * complement to {@link noteRpcFailover}. Host-only, never-throwing, safe on the
 * hot success path. Answers "which provider is actually carrying the traffic",
 * which the failure-only failover log cannot.
 *
 *  - `alwaysLog` (tx / write broadcasts): logs EVERY success. Broadcasts are
 *    low-volume and operators want per-tx attribution — "which provider
 *    broadcast this tx".
 *  - default (reads): high-volume, so it logs ONLY when the serving host CHANGES
 *    for this label (a provider shift), never once per call. The full per-host
 *    distribution is always available via {@link getRpcFailoverStats}
 *    (`servedByEndpointHost`) and `/api/status`.
 *
 * @param label   human operation label, e.g. `V10 publish broadcast`
 * @param servedUrl the RPC URL that served the call (reduced to host before logging)
 * @param options `alwaysLog` logs every success (writes); `key` is the stable
 *                low-cardinality operation identity used for read shift gating
 */
export function noteRpcServed(
  label: string,
  servedUrl: string,
  options: boolean | { alwaysLog?: boolean; key?: string } = false,
): void {
  try {
    const alwaysLog = typeof options === 'boolean' ? options : options.alwaysLog === true;
    const key = typeof options === 'boolean' ? label : (options.key ?? label);
    const host = rpcHost(servedUrl);
    bump(stats.servedByEndpointHost, host, MAX_TRACKED_HOSTS);
    const prior = lastServedByKey.get(key);
    const changed = prior !== host;
    if (!alwaysLog && !changed) return; // same provider on a read — count only, don't log
    if (!alwaysLog) {
      if (lastServedByKey.has(key)) lastServedByKey.delete(key);
      lastServedByKey.set(key, host);
      while (lastServedByKey.size > MAX_TRACKED_HOSTS) {
        const oldest = lastServedByKey.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        lastServedByKey.delete(oldest);
      }
    }
    // Mark a genuine provider SHIFT (had a prior, different host) — not the first
    // sighting, and not the always-log tx path.
    const shift = changed && prior !== undefined && !alwaysLog;
    // eslint-disable-next-line no-console
    console.log(`[chain] RPC served: ${label} via ${host}${shift ? ' (provider shift)' : ''}`);
  } catch {
    // Observability must never break the call path.
  }
}
