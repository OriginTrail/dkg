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

export type SyncRow = { s: string; p: string; o: string; g: string };

export interface SyncRowListMemo {
  get(
    key: string,
    loadRows: () => Promise<readonly SyncRow[]>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
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
}

interface RejectedSnapshot {
  error: SyncRowSnapshotBudgetError;
  cleanupTimer: ReturnType<typeof setTimeout>;
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
  const cached = new Map<string, CachedSnapshot>();
  const expired = new Map<string, ReturnType<typeof setTimeout>>();
  const rejected = new Map<string, RejectedSnapshot>();
  const inflight = new Map<string, Promise<readonly SyncRow[]>>();

  const deleteCached = (key: string, reason: 'expired' | 'released' | 'replaced' = 'released') => {
    const existing = cached.get(key);
    if (existing) clearTimeout(existing.cleanupTimer);
    cached.delete(key);
    if (existing?.budgetEntryId) memoOptions.budget?.remove(existing.budgetEntryId, reason);
  };

  const deleteExpired = (key: string) => {
    const timer = expired.get(key);
    if (timer) clearTimeout(timer);
    expired.delete(key);
  };

  const deleteRejected = (key: string) => {
    const entry = rejected.get(key);
    if (entry) clearTimeout(entry.cleanupTimer);
    rejected.delete(key);
  };

  const rememberExpired = (key: string) => {
    deleteExpired(key);
    const timer = setTimeout(() => expired.delete(key), ttlMs);
    (timer as { unref?: () => void }).unref?.();
    expired.set(key, timer);
  };

  const rememberRejected = (key: string, error: SyncRowSnapshotBudgetError) => {
    deleteRejected(key);
    const cleanupTimer = setTimeout(() => rejected.delete(key), ttlMs);
    (cleanupTimer as { unref?: () => void }).unref?.();
    rejected.set(key, { error, cleanupTimer });
  };

  const markExpired = (key: string) => {
    deleteCached(key, 'expired');
    rememberExpired(key);
  };

  const pruneExpired = (now = Date.now()) => {
    for (const [key, entry] of cached) {
      if (now - entry.cachedAt >= ttlMs) markExpired(key);
    }
  };

  const scheduleCleanup = (key: string, cachedAt: number) => {
    const timer = setTimeout(() => {
      const existing = cached.get(key);
      if (existing?.cachedAt === cachedAt) markExpired(key);
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

  const storeCached = (key: string, value: readonly SyncRow[]) => {
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
        if (
          !existing &&
          error instanceof SyncRowSnapshotBudgetError &&
          (error.reason === 'snapshot_rows' || error.reason === 'snapshot_bytes')
        ) {
          // Remember an intrinsically-oversized snapshot for this session so
          // later pages can take the store-paged fallback without repeating the
          // full materialization. A refresh/new session clears this marker.
          rememberRejected(key, error);
        }
        throw error;
      }
    }

    if (existing) clearTimeout(existing.cleanupTimer);
    cached.set(key, {
      value,
      cachedAt: now,
      cleanupTimer: scheduleCleanup(key, now),
      budgetEntryId,
      released: false,
    });
  };

  return {
    async get(key, loadRows, options) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      pruneExpired(now);
      const pending = inflight.get(key);
      if (pending) return raceAgainstAbort(pending, options?.signal);
      if (expired.has(key)) {
        if (options?.refresh) deleteExpired(key);
        else throw new Error('Durable data sync session snapshot expired before page completion');
      }
      const priorRejection = rejected.get(key);
      if (priorRejection) {
        if (options?.refresh) deleteRejected(key);
        else throw priorRejection.error;
      }

      const existing = cached.get(key);
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) {
        const refreshed: CachedSnapshot = {
          value: existing.value,
          cachedAt: now,
          cleanupTimer: scheduleCleanup(key, now),
          budgetEntryId: existing.budgetEntryId,
          released: false,
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
          storeCached(key, rows);
          return rows;
        })
        .catch((error) => {
          loadOutcome = 'error';
          throw error;
        })
        .finally(() => {
          getMetrics().syncResponderSnapshotLoadDurationMs.record(
            Date.now() - loadStartedAt,
            { phase: memoOptions.phase, outcome: loadOutcome },
          );
          recordSyncMemoryCheckpoint(memoOptions.phase, 'responder_snapshot_after_load');
          if (inflight.get(key) === load) inflight.delete(key);
      });
      inflight.set(key, load);
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
        cleanupTimer: scheduleCleanup(key, cachedAt),
        released: true,
      });
      if (existing.budgetEntryId) memoOptions.budget?.release(existing.budgetEntryId);
    },
  };
}
