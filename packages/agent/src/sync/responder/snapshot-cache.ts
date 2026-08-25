import { getMetrics } from '@origintrail-official/dkg-core';
import {
  estimateStringRowHeapBytes,
  recordSyncMemoryCheckpoint,
  type SyncMemoryPhase,
} from '../memory-telemetry.js';
import {
  SyncRowSnapshotBudgetError,
  type SyncResponderSnapshotBudget,
} from './snapshot-budget.js';

// Readonly at the object level, not just the array: the memo hands out its
// retained snapshot array by reference, so a mutation to any row would corrupt
// later pages served from the same snapshot. The type makes that invariant a
// compile-time boundary rather than a comment.
export type SyncRow = Readonly<{ s: string; p: string; o: string; g: string }>;

/**
 * Hard build caps are intentionally lower than the retained-cache defaults.
 * They bound temporary materialization even when an operator configures a very
 * large cache. Larger phases use direct store paging instead of being cached.
 */
// Sized against measured mainnet `_meta` density (fifa-world-cup-2026,
// 2026-08-05: 76,265 rows / 34.5 MiB => 474.5 B/row via
// estimateStringRowHeapBytes). The two caps are CO-TUNED: 200,000 x 474.5 B
// ~= 90.5 MiB, just under the 96 MiB ceiling, so neither cap is dead code —
// ordinary rows bind on ROWS and large-literal rows bind on BYTES.
//
// Both stay strictly below the retained per-snapshot caps
// (SYNC_RESPONDER_PER_SNAPSHOT_ROW_LIMIT = 250_000,
// SYNC_RESPONDER_PER_SNAPSHOT_BYTES_ESTIMATE_LIMIT = 128 MiB), preserving the
// "hard build caps < retained-cache defaults" ordering documented above: a
// snapshot that passes the build check is always admissible, never built and
// then rejected.
//
// Why raised from 64,000 / 32 MiB: a CG whose `_meta` crossed the old ceiling
// fell off the in-memory predicate (filterDurableMetaSnapshotRows) onto the
// SPARQL fallback (buildDurableMetaRowsQuery), whose assertion-name branch is
// O(candidates x assertionName-lifecycles) and is re-paid per page. Measured on
// mainnet that fallback exceeded a 120s server-side query deadline; fifa was
// only 1.19x over the row cap and 1.08x over the byte cap when it fell off.
export const SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS = 200_000;
export const SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE = 96 * 1024 * 1024;
export const SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS = 500;

export interface SyncRowSnapshotLoadLimits {
  maxRows: number;
  maxBytesEstimate: number;
  pageRows: number;
}

export interface SyncRowListMemo {
  /** Store-paged loader limits; present on production memos. */
  readonly snapshotLoadLimits?: Readonly<SyncRowSnapshotLoadLimits>;
  get(
    key: string,
    loadRows: () => Promise<readonly SyncRow[]>,
    options?: {
      refresh?: boolean;
      /**
       * Server-validated responder-session generation. A new generation must
       * wait for, then reload after, an older in-flight snapshot. The cache key
       * itself stays server-derived so attacker-controlled tokens cannot grow
       * the retained-entry set.
       */
      refreshGeneration?: string;
      /** Offset-zero retry may rebuild an evicted/expired snapshot safely. */
      refreshExpired?: boolean;
      requireExisting?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<readonly SyncRow[] | null>;
  release(key: string, options?: { graceMs?: number }): void;
}

interface SyncRowListMemoOptions {
  phase: SyncMemoryPhase;
  budget?: SyncResponderSnapshotBudget;
}

interface CachedSnapshot {
  value: readonly SyncRow[];
  cachedAt: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  budgetEntryId?: symbol;
  released: boolean;
  refreshGeneration?: string;
}

interface RejectedSnapshot {
  error: SyncRowSnapshotBudgetError;
  cleanupTimer: ReturnType<typeof setTimeout>;
  refreshGeneration?: string;
}

interface ExpiredSnapshot {
  cleanupTimer: ReturnType<typeof setTimeout>;
  refreshGeneration?: string;
}

export class SyncRowSnapshotLimitError extends Error {
  readonly key: string;
  readonly maxEntries: number;
  readonly cachedEntries: number;
  readonly inflightEntries: number;
  readonly activeEntries: number;

  constructor(params: {
    key: string;
    maxEntries: number;
    cachedEntries: number;
    inflightEntries: number;
  }) {
    const activeEntries = params.cachedEntries + params.inflightEntries;
    super(
      `Too many active sync responder session snapshots (key=${params.key}, active=${activeEntries}, max=${params.maxEntries})`,
    );
    this.name = 'SyncRowSnapshotLimitError';
    this.key = params.key;
    this.maxEntries = params.maxEntries;
    this.cachedEntries = params.cachedEntries;
    this.inflightEntries = params.inflightEntries;
    this.activeEntries = activeEntries;
  }
}

function asAbortError(reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(asAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Session snapshot cache with coalesced loads, TTL expiry, immutable row-array
 * sharing, and optional process-wide retention budgeting. Returned arrays are
 * shared between waiters and MUST NOT be mutated; page consumers must slice.
 */
export function createResponderSyncRowListMemo(
  ttlMs = 120_000,
  maxEntries = 32,
  memoOptions: SyncRowListMemoOptions = { phase: 'durable_data' },
): SyncRowListMemo {
  const configuredLimits = memoOptions.budget?.limits();
  const snapshotLoadLimits: SyncRowSnapshotLoadLimits = {
    maxRows: Math.min(
      SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
      configuredLimits?.maxSnapshotRows ?? SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    ),
    maxBytesEstimate: Math.min(
      SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      configuredLimits?.maxSnapshotBytesEstimate ?? SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    ),
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const cached = new Map<string, CachedSnapshot>();
  const expired = new Map<string, ExpiredSnapshot>();
  const rejected = new Map<string, RejectedSnapshot>();
  const inflight = new Map<string, {
    promise: Promise<readonly SyncRow[]>;
    refreshGeneration?: string;
  }>();

  const deleteCached = (key: string, reason: 'expired' | 'released' | 'replaced' = 'released') => {
    const existing = cached.get(key);
    if (existing) clearTimeout(existing.cleanupTimer);
    cached.delete(key);
    if (existing?.budgetEntryId) memoOptions.budget?.remove(existing.budgetEntryId, reason);
  };

  const deleteExpired = (key: string) => {
    const entry = expired.get(key);
    if (entry) clearTimeout(entry.cleanupTimer);
    expired.delete(key);
  };

  const deleteRejected = (key: string) => {
    const entry = rejected.get(key);
    if (entry) clearTimeout(entry.cleanupTimer);
    rejected.delete(key);
  };

  const rememberExpired = (key: string, refreshGeneration?: string) => {
    deleteExpired(key);
    const timer = setTimeout(() => expired.delete(key), ttlMs);
    (timer as { unref?: () => void }).unref?.();
    expired.set(key, { cleanupTimer: timer, refreshGeneration });
  };

  const rememberRejected = (
    key: string,
    error: SyncRowSnapshotBudgetError,
    refreshGeneration?: string,
  ) => {
    deleteRejected(key);
    const cleanupTimer = setTimeout(() => rejected.delete(key), ttlMs);
    (cleanupTimer as { unref?: () => void }).unref?.();
    rejected.set(key, { error, cleanupTimer, refreshGeneration });
  };

  const markExpired = (key: string) => {
    const refreshGeneration = cached.get(key)?.refreshGeneration;
    deleteCached(key, 'expired');
    rememberExpired(key, refreshGeneration);
  };

  const pruneExpired = (now = Date.now()) => {
    for (const [key, entry] of cached) {
      if (now - entry.cachedAt >= ttlMs) markExpired(key);
    }
  };

  const scheduleCleanup = (key: string, cachedAt: number, refreshGeneration?: string) => {
    const timer = setTimeout(() => {
      const existing = cached.get(key);
      if (
        existing?.cachedAt === cachedAt &&
        existing.refreshGeneration === refreshGeneration
      ) markExpired(key);
    }, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  const evictOneReleased = (): boolean => {
    const released = [...cached.entries()].find(([, entry]) => entry.released);
    if (!released) return false;
    deleteCached(released[0], 'released');
    return true;
  };

  const storeCached = (
    key: string,
    value: readonly SyncRow[],
    refreshGeneration?: string,
  ) => {
    const now = Date.now();
    pruneExpired(now);
    deleteExpired(key);
    deleteRejected(key);
    const existing = cached.get(key);
    if (value.length === 0) {
      if (existing) deleteCached(key, 'replaced');
      return;
    }
    if (!existing && cached.size >= maxEntries && !evictOneReleased()) {
      throw new SyncRowSnapshotLimitError({
        key,
        maxEntries,
        cachedEntries: cached.size,
        inflightEntries: inflight.size,
      });
    }

    let bytesEstimate = 0;
    for (const row of value) {
      bytesEstimate += estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
    }
    const budgetEntryId = memoOptions.budget ? Symbol(key) : undefined;
    if (budgetEntryId) {
      try {
        memoOptions.budget!.admit({
          id: budgetEntryId,
          replaceId: existing?.budgetEntryId,
          key,
          phase: memoOptions.phase,
          rows: value.length,
          bytesEstimate,
          onEvict: () => {
            const current = cached.get(key);
            if (current?.budgetEntryId !== budgetEntryId) return;
            clearTimeout(current.cleanupTimer);
            cached.delete(key);
            // Memory pressure is not TTL expiry. Active entries are pinned and
            // cannot reach this callback; completed sessions may reload cleanly.
          },
        });
      } catch (error) {
        if (error instanceof SyncRowSnapshotBudgetError) {
          // A refresh whose new snapshot fails admission must not leave the
          // superseded prior snapshot serveable. admit()'s atomic replace keeps
          // the old entry on any failure, but the new token is already active,
          // so a same-token retry (refresh=false) would resume the STALE rows.
          // Drop it for BOTH the per-snapshot and the global rejection paths.
          if (existing) deleteCached(key, 'replaced');
          // Intrinsically-oversized (per-snapshot) snapshots additionally remember
          // the rejection so later pages of THIS session take the store-bounded
          // fallback without re-materializing. Global (process-wide) pressure is
          // transient and is NOT remembered — a retry re-attempts admission and
          // succeeds once other sessions drain (and the drop above eases pressure).
          if (error.reason === 'snapshot_rows' || error.reason === 'snapshot_bytes') {
            rememberRejected(key, error, refreshGeneration);
          }
        }
        throw error;
      }
    }

    if (existing) clearTimeout(existing.cleanupTimer);
    cached.set(key, {
      value,
      cachedAt: now,
      cleanupTimer: scheduleCleanup(key, now, refreshGeneration),
      budgetEntryId,
      released: false,
      refreshGeneration,
    });
  };

  return {
    snapshotLoadLimits,
    async get(key, loadRows, options) {
      throwIfAborted(options?.signal);
      // A page-zero request carrying a new responder-session token is an
      // explicit snapshot refresh. If the prior session is still loading,
      // coalescing onto that in-flight promise would return the OLD row set to
      // the new session (the private-CG approval race can then omit the freshly
      // written delegation). Wait for older loads to settle, then issue a new
      // store read. Re-check in a loop so concurrent refreshes serialize rather
      // than racing two writers against the same cache key.
      while (true) {
        const pending = inflight.get(key);
        if (!pending) break;
        const supersedesPending = options?.refreshGeneration !== undefined &&
          options.refreshGeneration !== pending.refreshGeneration;
        if (!supersedesPending) {
          return raceAgainstAbort(pending.promise, options?.signal);
        }
        try {
          await raceAgainstAbort(pending.promise, options?.signal);
        } catch {
          // A new session owns an independent attempt. An older session's
          // query/budget failure must not be inherited, but caller abort still
          // takes precedence.
          throwIfAborted(options?.signal);
        }
      }

      const now = Date.now();
      pruneExpired(now);
      const requestedGeneration = options?.refreshGeneration;
      const priorExpiry = expired.get(key);
      if (priorExpiry) {
        if (
          options?.refresh ||
          options?.refreshExpired ||
          (requestedGeneration !== undefined &&
            priorExpiry.refreshGeneration !== requestedGeneration)
        ) deleteExpired(key);
        else throw new Error('Durable data sync session snapshot expired before page completion');
      }
      const priorRejection = rejected.get(key);
      if (priorRejection) {
        if (
          options?.refresh ||
          (requestedGeneration !== undefined &&
            priorRejection.refreshGeneration !== requestedGeneration)
        ) deleteRejected(key);
        else {
          // An intrinsically oversized snapshot deliberately uses the
          // store-bounded exact-graph path for every later page.  The typed
          // rejection is therefore active session state, not a one-shot
          // negative cache entry.  Slide its lifetime whenever the same
          // session requests another page, just like retained row snapshots
          // and exact-graph plans.  Without this touch, a healthy long-running
          // stream loses the fallback marker at the original TTL boundary and
          // is misreported as an expired immutable snapshot.
          rememberRejected(
            key,
            priorRejection.error,
            priorRejection.refreshGeneration,
          );
          throw priorRejection.error;
        }
      }

      let existing = cached.get(key);
      if (
        existing &&
        requestedGeneration !== undefined &&
        existing.refreshGeneration !== requestedGeneration
      ) {
        // prepareResponderSession installs a new token before its page-zero
        // snapshot finishes. If that request aborts while waiting for an older
        // generation, or its own refresh load fails, the older snapshot can
        // remain retained. A same-token retry has refresh=false, so generation
        // validation must also happen on cache hits rather than only while an
        // in-flight load exists.
        deleteCached(key, 'replaced');
        existing = undefined;
      }
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) {
        const refreshed: CachedSnapshot = {
          value: existing.value,
          cachedAt: now,
          cleanupTimer: scheduleCleanup(key, now, existing.refreshGeneration),
          budgetEntryId: existing.budgetEntryId,
          released: false,
          refreshGeneration: existing.refreshGeneration,
        };
        clearTimeout(existing.cleanupTimer);
        cached.delete(key);
        cached.set(key, refreshed);
        if (existing.budgetEntryId) memoOptions.budget?.touch(existing.budgetEntryId);
        return existing.value;
      }
      if (options?.requireExisting) return null;
      if (!cached.has(key) && cached.size + inflight.size >= maxEntries && !evictOneReleased()) {
        throw new SyncRowSnapshotLimitError({
          key,
          maxEntries,
          cachedEntries: cached.size,
          inflightEntries: inflight.size,
        });
      }

      const loadStartedAt = Date.now();
      let loadOutcome: 'completed' | 'error' = 'completed';
      recordSyncMemoryCheckpoint(memoOptions.phase, 'responder_snapshot_before_load');
      const load = loadRows()
        .then((rows) => {
          // Loads are owner-independent and may finish after the first waiter
          // aborts. Cache the complete result for surviving/coalesced waiters.
          storeCached(key, rows, options?.refreshGeneration);
          return rows;
        })
        .catch((error) => {
          loadOutcome = 'error';
          // A loader may reject before returning its array when a cheap store
          // preflight or store-paged builder proves the full query would cross
          // a response/heap safety bound. Remember intrinsic rejections exactly
          // like storeCached() does, so later pages in this responder session go
          // straight to bounded store paging instead of repeating the full load.
          if (
            error instanceof SyncRowSnapshotBudgetError &&
            (error.reason === 'snapshot_rows' || error.reason === 'snapshot_bytes')
          ) {
            const stale = cached.get(key);
            if (stale) deleteCached(key, 'replaced');
            rememberRejected(key, error, options?.refreshGeneration);
          }
          throw error;
        })
        .finally(() => {
          getMetrics().syncResponderSnapshotLoadDurationMs.record(
            Date.now() - loadStartedAt,
            { phase: memoOptions.phase, outcome: loadOutcome },
          );
          recordSyncMemoryCheckpoint(memoOptions.phase, 'responder_snapshot_after_load');
          if (inflight.get(key)?.promise === load) inflight.delete(key);
        });
      inflight.set(key, {
        promise: load,
        refreshGeneration: options?.refreshGeneration,
      });
      const rows = await load;
      if (options?.signal?.aborted) {
        const completed = cached.get(key);
        if (completed) {
          cached.set(key, { ...completed, released: true });
          if (completed.budgetEntryId) memoOptions.budget?.release(completed.budgetEntryId);
        }
        throwIfAborted(options.signal);
      }
      return rows;
    },
    release(key, options) {
      const existing = cached.get(key);
      if (!existing) return;
      const graceMs = Math.max(0, Math.min(options?.graceMs ?? 0, ttlMs));
      if (graceMs === 0) {
        markExpired(key);
        return;
      }
      const cachedAt = Date.now() - (ttlMs - graceMs);
      clearTimeout(existing.cleanupTimer);
      cached.set(key, {
        ...existing,
        cachedAt,
        cleanupTimer: scheduleCleanup(key, cachedAt, existing.refreshGeneration),
        released: true,
      });
      if (existing.budgetEntryId) memoOptions.budget?.release(existing.budgetEntryId);
    },
  };
}
