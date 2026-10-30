import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SyncResponderSnapshotBudget } from './snapshot-budget.js';
import { raceAgainstAbort, throwIfAborted } from './responder-row-page.js';
import {
  exactGraphPlanScalarBytes,
  snapshotBudgetError,
  EXACT_GRAPH_CURSOR_CACHE_MAX_BYTES_ESTIMATE,
  EXACT_GRAPH_PLAN_MAX_BYTES_ESTIMATE,
  type ExactGraphPagePlan,
} from './exact-graph-reader.js';

export interface SessionPlanMemo<T> {
  get(
    key: string,
    load: () => Promise<T>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<T | null>;
}

interface SessionPlanBudgetAccounting<T> {
  budget: SyncResponderSnapshotBudget;
  phase: 'shared_memory' | 'durable_meta' | 'durable_data';
  bytesEstimate: (value: T) => number;
  /** Keep responder admission until an aborted store load physically settles. */
  drainOnAbort?: boolean;
}

export function createSessionPlanMemo<T>(
  ttlMs: number,
  maxEntries: number,
  accounting?: SessionPlanBudgetAccounting<T>,
): SessionPlanMemo<T> {
  const cached = new Map<string, { value: T; cachedAt: number; budgetEntryId?: symbol }>();
  const inflight = new Map<string, Promise<T>>();
  const deleteEntry = (key: string, reason: 'expired' | 'released' | 'replaced') => {
    const entry = cached.get(key);
    if (!entry) return;
    cached.delete(key);
    if (entry.budgetEntryId) accounting?.budget.remove(entry.budgetEntryId, reason);
  };
  const prune = (now = Date.now()) => {
    for (const [key, entry] of cached) {
      if (now - entry.cachedAt >= ttlMs) deleteEntry(key, 'expired');
    }
  };
  return {
    async get(key, load, options) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      prune(now);
      const pending = inflight.get(key);
      if (pending) {
        if (!accounting?.drainOnAbort) return raceAgainstAbort(pending, options?.signal);
        if (!options?.refresh) {
          const value = await pending;
          throwIfAborted(options?.signal);
          return value;
        }
        // An explicit replacement waits for the prior physical load, then
        // builds its own plan rather than inheriting the older generation.
        try { await pending; } catch { throwIfAborted(options?.signal); }
        throwIfAborted(options?.signal);
      }
      const existing = cached.get(key);
      if (!options?.refresh && existing) {
        cached.delete(key);
        cached.set(key, { ...existing, cachedAt: now });
        if (existing.budgetEntryId) {
          // Refresh the global-budget LRU position, then stay evictable: an
          // entry pinned forever would let idle plans exempt themselves from
          // memory-pressure eviction.
          accounting?.budget.touch(existing.budgetEntryId);
          accounting?.budget.release(existing.budgetEntryId);
        }
        return existing.value;
      }
      if (options?.requireExisting) return null;
      if (!existing && cached.size >= maxEntries) {
        deleteEntry(cached.keys().next().value!, 'released');
      }
      const pendingLoad = load()
        .then((value) => {
          if (accounting?.drainOnAbort) throwIfAborted(options?.signal);
          const replaced = cached.get(key);
          let budgetEntryId: symbol | undefined;
          if (accounting) {
            budgetEntryId = Symbol(key);
            // Throws the typed global budget error when the process-wide
            // responder budget cannot admit the plan; the failed refresh leaves
            // any previously-admitted plan in place (memo entry untouched).
            accounting.budget.admit({
              id: budgetEntryId,
              key,
              phase: accounting.phase,
              rows: 0,
              bytesEstimate: accounting.bytesEstimate(value),
              controlPlane: true,
              replaceId: replaced?.budgetEntryId,
              onEvict: () => {
                if (cached.get(key)?.budgetEntryId === budgetEntryId) cached.delete(key);
              },
            });
            accounting.budget.release(budgetEntryId);
          }
          // Concurrent loads for different keys can pass the entry check
          // before either settles. Keep the cap true at settlement as well.
          if (!cached.has(key)) {
            while (cached.size >= maxEntries) deleteEntry(cached.keys().next().value!, 'released');
          }
          cached.set(key, { value, cachedAt: Date.now(), budgetEntryId });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pendingLoad);
      if (!accounting?.drainOnAbort) return raceAgainstAbort(pendingLoad, options?.signal);
      const value = await pendingLoad;
      throwIfAborted(options?.signal);
      return value;
    },
  };
}

export function createPageOnlySessionPlanMemo<T>(
  ttlMs: number,
  maxEntries: number,
  budget: SyncResponderSnapshotBudget,
  graphPlan: (value: T) => ExactGraphPagePlan,
): SessionPlanMemo<T> {
  const memo = createSessionPlanMemo<T>(ttlMs, maxEntries, {
    budget,
    phase: 'durable_data',
    drainOnAbort: true,
    bytesEstimate: (value) => {
      const plan = graphPlan(value);
      const bytes = exactGraphPlanScalarBytes(plan);
      if (bytes > EXACT_GRAPH_PLAN_MAX_BYTES_ESTIMATE) {
        throw snapshotBudgetError({
          key: 'exact-data-plan', reason: 'snapshot_bytes', rows: plan.entries.length,
          bytesEstimate: bytes, limit: EXACT_GRAPH_PLAN_MAX_BYTES_ESTIMATE,
        });
      }
      return bytes + EXACT_GRAPH_CURSOR_CACHE_MAX_BYTES_ESTIMATE;
    },
  });
  return {
    get(key, load, options) {
      // Opaque request tokens need not have a small wire spelling. Retain a
      // fixed-size digest of the complete server-derived scope/generation.
      const boundedKey = bytesToHex(sha256(new TextEncoder().encode(key)));
      return memo.get(boundedKey, load, options);
    },
  };
}
