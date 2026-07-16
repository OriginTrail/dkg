/**
 * Silence the `eth_getFilterChanges` "filter not found" spam from
 * long-lived ethers JsonRpcProvider polling against RPC nodes that
 * garbage-collect filters on a shorter TTL than the contract listener
 * expects.
 *
 * # The incident
 *
 * Beacon-01 (Base Sepolia) accumulated **134 MB of `daemon.log` in 24
 * hours** during the rc.10 deadlock investigation, dominated by:
 *
 *   `@TODO Error: could not coalesce error
 *      eth_getFilterChanges("0x4e58f53e...")
 *      JSON-RPC response: -32602 filter not found`
 *
 * The polling itself happens inside ethers' Contract.on(...) machinery
 * (registered in `evm-adapter.ts:startHubRotationListener` for the
 * Hub's `ContractChanged` + `NewContract` events). When the RPC node
 * GC's the filter, ethers' next `eth_getFilterChanges` call gets
 * `-32602 "filter not found"`, which becomes a `provider.on('error',
 * ...)` event that, with no handler installed, falls through to the
 * default `console.error` path → log spam.
 *
 * # Scope of this PR (deliberate)
 *
 * **Log-spam classification + dedup ONLY.** A full filter-recreation
 * fix would require reproducing the GC behaviour against a real RPC
 * node (the local Hardhat test setup doesn't GC filters on the same
 * TTL), which the planning spike concluded is out of scope. The
 * pragmatic delta:
 *
 *   1. Install a `provider.on('error', ...)` handler that classifies
 *      every error.
 *   2. If it's a filter-not-found error, dedupe-log it (one line per
 *      DEDUP_WINDOW_MS, with a count of suppressed repeats).
 *   3. Any other provider error still flows through to the default
 *      logger (we don't want to mask non-filter errors).
 *
 * The TTL-refresh fallback currently covers the highest-value
 * RandomSampling / RandomSamplingStorage pair, which is the pair that
 * already has self-healing cache logic. Other one-shot Hub-resolved
 * contract handles still depend on Hub event delivery (or process
 * restart) to observe rotations. So the warning emitted by this module
 * must keep that degradation visible while deduping the repeated provider
 * errors.
 *
 * Future PR can wrap a true `RecoverableEventProvider` once we have a
 * live repro to verify against; tracked in the planning doc as the
 * follow-up to PR-8.
 */

/**
 * Heuristic classifier for the "filter not found" error class.
 * Returns true if `err` looks like an ethers-surfaced
 * `eth_getFilterChanges` failure from a GC'd filter.
 *
 * Defensive: matches on the canonical expiry strings ("filter not found" /
 * "filter expired") with the RPC error code (-32602 / -32000) when the
 * provider exposes structured payloads; if the payload names an RPC method, it
 * must be `eth_getFilterChanges`. Plain outer messages only match when they
 * also identify the failing RPC method as `eth_getFilterChanges`. We
 * intentionally do NOT swallow unrelated filter-shaped errors like "invalid
 * filter object".
 */
export function isFilterNotFoundError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  // ethers wraps the JSON-RPC error and exposes the code on err.info / err.code.
  const candidate = err as {
    code?: unknown;
    info?: { error?: { code?: unknown; message?: unknown }; payload?: { method?: unknown } };
    payload?: { method?: unknown };
  };
  const method = candidate.info?.payload?.method ?? candidate.payload?.method;
  const isGetFilterChanges = method === undefined || method === 'eth_getFilterChanges';
  const rpcCode = typeof candidate.code === 'number' ? candidate.code : candidate.info?.error?.code;
  const rpcMessage = candidate.info?.error?.message;
  if ((rpcCode === -32602 || rpcCode === -32000) && typeof rpcMessage === 'string') {
    if (isExpiredFilterMessage(rpcMessage.toLowerCase()) && isGetFilterChanges) return true;
  }
  if (
    isExpiredFilterMessage(lower) &&
    (lower.includes('eth_getfilterchanges') || method === 'eth_getFilterChanges')
  ) {
    return true;
  }
  return false;
}

function isExpiredFilterMessage(message: string): boolean {
  return message.includes('filter not found')
    || message.includes('filter expired')
    || message.includes('filter has expired');
}

/**
 * Format non-filter provider errors without dropping the nested JSON-RPC
 * payload ethers often stores on `err.info.error`.
 */
export function formatProviderError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.stack || err.message];
    const record = err as Error & {
      code?: unknown;
      info?: unknown;
      error?: unknown;
      data?: unknown;
    };
    for (const [label, value] of [
      ['code', record.code],
      ['info', record.info],
      ['error', record.error],
      ['data', record.data],
    ] as const) {
      if (value !== undefined) {
        parts.push(`${label}=${safeJson(value)}`);
      }
    }
    return parts.join(' ');
  }
  return typeof err === 'string' ? err : safeJson(err);
}

function safeJson(value: unknown): string {
  // Codex (#670#discussion_r3301775310): ethers error payloads commonly
  // contain `bigint` fields (e.g. transaction values, chain ids), which
  // `JSON.stringify` rejects with a TypeError. The previous fallback
  // returned `"[object Object]"`, discarding the structured diagnostics
  // this path is trying to preserve. Stringify bigints in a replacer so
  // the serialized form survives the round-trip.
  try {
    return JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  } catch {
    return String(value);
  }
}

/** Default dedup window — 5 min. Operators see ~12 lines/hour during a sustained outage instead of ~thousands. */
export const DEFAULT_DEDUP_WINDOW_MS = 5 * 60_000;

export interface FilterErrorSilencerOpts {
  /** Operator log target. Default: `console.warn`. */
  log?: (msg: string) => void;
  /** Override the dedup window (e.g. tests use a small window). */
  dedupWindowMs?: number;
  /**
   * Test-time clock injection. Default `Date.now`. Replaces global
   * `Date.now()` reads so fake-timer tests can advance time
   * deterministically.
   */
  now?: () => number;
}

export interface FilterErrorSilencerStats {
  /** Total error events seen since install (counted, NOT all logged). */
  filterErrorsTotal: number;
  /** Errors suppressed within the current dedup window (resets every emit). */
  filterErrorsSuppressedInWindow: number;
  /** Timestamp (ms-since-epoch) of the last log emit; null until first emit. */
  lastEmitAt: number | null;
}

export interface FilterErrorSilencer {
  /** Call from `provider.on('error', handler)`. Returns true if the error was handled (filter-not-found); false if it should propagate. */
  handle(err: unknown): boolean;
  /** Read counters (for `/api/status` exposure or operator debug). */
  stats(): FilterErrorSilencerStats;
  /** Reset counters — used by tests; not called from production. */
  resetForTest(): void;
}

/**
 * Build a stateful silencer. Each silencer maintains its own dedup
 * window — typically you'd install one per `JsonRpcProvider` instance.
 *
 * Not bound to ethers directly; the consumer (evm-adapter.ts) does the
 * `provider.on('error', (err) => { if (!silencer.handle(err)) defaultLog(err); })`
 * wiring. Keeps this module pure-logic + test-friendly.
 */
export function createFilterErrorSilencer(opts: FilterErrorSilencerOpts = {}): FilterErrorSilencer {
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const now = opts.now ?? Date.now;

  let filterErrorsTotal = 0;
  let filterErrorsSuppressedInWindow = 0;
  let lastEmitAt: number | null = null;

  return {
    handle(err) {
      if (!isFilterNotFoundError(err)) return false;
      filterErrorsTotal += 1;
      const currentTime = now();
      const shouldEmit =
        lastEmitAt === null || currentTime - lastEmitAt >= dedupWindowMs;
      if (shouldEmit) {
        const suppressedSuffix =
          filterErrorsSuppressedInWindow > 0
            ? ` (${filterErrorsSuppressedInWindow} similar errors suppressed in the previous window)`
            : '';
        log(
          `[chain] RPC filter expired (eth_getFilterChanges returned "filter not found"). ` +
            `Hub event polling is degraded; RandomSampling/RandomSamplingStorage have a TTL fallback, ` +
            `but other Hub-resolved contract handles may stay stale until filters recover or the adapter restarts.${suppressedSuffix}`,
        );
        lastEmitAt = currentTime;
        filterErrorsSuppressedInWindow = 0;
      } else {
        filterErrorsSuppressedInWindow += 1;
      }
      return true;
    },
    stats() {
      return {
        filterErrorsTotal,
        filterErrorsSuppressedInWindow,
        lastEmitAt,
      };
    },
    resetForTest() {
      filterErrorsTotal = 0;
      filterErrorsSuppressedInWindow = 0;
      lastEmitAt = null;
    },
  };
}

/**
 * BUG-022 — ethers v6 swallows the `eth_getFilterChanges` "filter not
 * found" error inside `subscriber-filterid.js#poll()` with a literal
 * `console.log("@TODO", error)` (see ethers v6.16.0). That code path
 * NEVER fires the `provider.on('error', ...)` event we hook in
 * `evm-adapter.ts`, so the per-provider `FilterErrorSilencer` only
 * catches the (rare) errors that surface through real `_perform`
 * exceptions. Operators kept seeing a hot stream of `@TODO Error:
 * could not coalesce error … filter not found` entries in
 * `daemon.log` even after the rc.11 silencer landed.
 *
 * Fix: wrap `console.log` once per process. When a `@TODO`-prefixed
 * call carries a filter-not-found error, route it through a dedicated
 * dedup'd silencer instead of writing it to the log. Every other
 * `console.log` call is forwarded untouched. Idempotent — subsequent
 * adapter constructions skip the wrap.
 *
 * Returns the silencer so callers can read its stats (`/api/status`
 * surfaces filter-error counts).
 */
let consoleSuppressorInstalled = false;
let consoleSuppressorSilencer: FilterErrorSilencer | null = null;
let consoleSuppressorOriginalLog: typeof console.log | null = null;

export function installFilterNotFoundConsoleSuppressor(opts: FilterErrorSilencerOpts = {}): FilterErrorSilencer {
  if (consoleSuppressorInstalled && consoleSuppressorSilencer) return consoleSuppressorSilencer;
  // Capture `console.warn` BEFORE wrapping `console.log`. The
  // dedup-emit path uses `console.warn` so operators still see one
  // line per dedup window (with a count of suppressed repeats),
  // matching the per-provider silencer's UX.
  const originalConsoleWarn = console.warn.bind(console);
  const silencer = createFilterErrorSilencer({
    ...opts,
    log: opts.log ?? ((msg: string) => originalConsoleWarn(msg)),
  });
  const originalConsoleLog = console.log;
  consoleSuppressorOriginalLog = originalConsoleLog;
  console.log = (...args: unknown[]) => {
    // ethers v6 emits `console.log("@TODO", error)` from
    // subscriber-filterid.js. Intercept exactly that two-arg shape so
    // we don't accidentally swallow legitimate "@TODO" log lines that
    // happen to start with the same string.
    if (args.length === 2 && args[0] === '@TODO' && silencer.handle(args[1])) return;
    originalConsoleLog.apply(console, args);
  };
  consoleSuppressorInstalled = true;
  consoleSuppressorSilencer = silencer;
  return silencer;
}

/** Test-only — restore the original `console.log` so subsequent tests
 *  see real output. Not exported as part of the public surface in
 *  production, but vitest specs need a way to undo the wrap between
 *  cases. */
export function _uninstallFilterNotFoundConsoleSuppressorForTest(): void {
  if (consoleSuppressorOriginalLog) {
    console.log = consoleSuppressorOriginalLog;
  }
  consoleSuppressorInstalled = false;
  consoleSuppressorSilencer = null;
  consoleSuppressorOriginalLog = null;
}
