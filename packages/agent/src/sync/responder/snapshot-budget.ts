import { getMetrics } from '@origintrail-official/dkg-core';
import type { SyncMemoryPhase } from '../memory-telemetry.js';

export interface SyncResponderSnapshotBudgetOptions {
  maxRows: number;
  maxBytesEstimate: number;
  maxSnapshotRows: number;
  maxSnapshotBytesEstimate: number;
}

export interface SyncResponderSnapshotBudgetStats {
  snapshots: number;
  rows: number;
  bytesEstimate: number;
}

interface SnapshotBudgetEntry {
  id: symbol;
  phase: SyncMemoryPhase;
  rows: number;
  bytesEstimate: number;
  onEvict: () => void;
}

export class SyncRowSnapshotBudgetError extends Error {
  readonly key: string;
  readonly reason: 'snapshot_rows' | 'snapshot_bytes' | 'global_rows' | 'global_bytes';
  readonly rows: number;
  readonly bytesEstimate: number;

  constructor(params: {
    key: string;
    reason: SyncRowSnapshotBudgetError['reason'];
    rows: number;
    bytesEstimate: number;
    limit: number;
  }) {
    const unit = params.reason.endsWith('rows') ? 'rows' : 'estimated bytes';
    const actual = params.reason.endsWith('rows') ? params.rows : params.bytesEstimate;
    super(
      `Sync responder snapshot exceeds ${params.reason.startsWith('snapshot') ? 'per-snapshot' : 'global'} ${unit} budget ` +
      `(key=${params.key}, actual=${actual}, limit=${params.limit})`,
    );
    this.name = 'SyncRowSnapshotBudgetError';
    this.key = params.key;
    this.reason = params.reason;
    this.rows = params.rows;
    this.bytesEstimate = params.bytesEstimate;
  }
}

export interface SyncResponderSnapshotBudget {
  admit(params: Omit<SnapshotBudgetEntry, 'id'> & { id: symbol; key: string }): void;
  touch(id: symbol): void;
  remove(id: symbol, reason?: 'expired' | 'released' | 'replaced'): void;
  stats(): SyncResponderSnapshotBudgetStats;
}

/**
 * A process-local LRU budget shared by every sync responder row-list memo.
 * Entries are admitted only after their complete size is known. This bounds
 * retained cache state; it intentionally does not claim to bound the temporary
 * store result used while one snapshot is being materialized.
 */
export function createSyncResponderSnapshotBudget(
  options: SyncResponderSnapshotBudgetOptions,
): SyncResponderSnapshotBudget {
  const limits = {
    maxRows: Math.max(0, Math.floor(options.maxRows)),
    maxBytesEstimate: Math.max(0, Math.floor(options.maxBytesEstimate)),
    maxSnapshotRows: Math.max(0, Math.floor(options.maxSnapshotRows)),
    maxSnapshotBytesEstimate: Math.max(0, Math.floor(options.maxSnapshotBytesEstimate)),
  };
  // Map insertion order is the LRU order. Hits move an entry to the tail.
  const entries = new Map<symbol, SnapshotBudgetEntry>();
  let rows = 0;
  let bytesEstimate = 0;

  const recordDelta = (entry: SnapshotBudgetEntry, direction: 1 | -1): void => {
    const attrs = { phase: entry.phase };
    const metrics = getMetrics();
    metrics.syncResponderSnapshots.add(direction, attrs);
    metrics.syncResponderSnapshotRows.add(direction * entry.rows, attrs);
    metrics.syncResponderSnapshotBytesEstimate.add(direction * entry.bytesEstimate, attrs);
  };

  const removeEntry = (
    id: symbol,
    reason: 'lru' | 'expired' | 'released' | 'replaced',
    notifyOwner: boolean,
  ): void => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    rows -= entry.rows;
    bytesEstimate -= entry.bytesEstimate;
    recordDelta(entry, -1);
    if (reason === 'lru' || reason === 'expired') {
      getMetrics().syncResponderSnapshotEvictionsTotal.add(1, {
        phase: entry.phase,
        reason,
      });
    }
    if (notifyOwner) entry.onEvict();
  };

  const reject = (
    params: Omit<SnapshotBudgetEntry, 'id'> & { id: symbol; key: string },
    reason: SyncRowSnapshotBudgetError['reason'],
    limit: number,
  ): never => {
    getMetrics().syncResponderSnapshotEvictionsTotal.add(1, {
      phase: params.phase,
      reason: 'limit_rejected',
    });
    throw new SyncRowSnapshotBudgetError({
      key: params.key,
      reason,
      rows: params.rows,
      bytesEstimate: params.bytesEstimate,
      limit,
    });
  };

  return {
    admit(params) {
      if (params.rows > limits.maxSnapshotRows) {
        reject(params, 'snapshot_rows', limits.maxSnapshotRows);
      }
      if (params.bytesEstimate > limits.maxSnapshotBytesEstimate) {
        reject(params, 'snapshot_bytes', limits.maxSnapshotBytesEstimate);
      }

      while (
        entries.size > 0 &&
        (rows + params.rows > limits.maxRows ||
          bytesEstimate + params.bytesEstimate > limits.maxBytesEstimate)
      ) {
        const oldestId = entries.keys().next().value as symbol | undefined;
        if (!oldestId) break;
        removeEntry(oldestId, 'lru', true);
      }

      if (rows + params.rows > limits.maxRows) {
        reject(params, 'global_rows', limits.maxRows);
      }
      if (bytesEstimate + params.bytesEstimate > limits.maxBytesEstimate) {
        reject(params, 'global_bytes', limits.maxBytesEstimate);
      }

      const entry: SnapshotBudgetEntry = {
        id: params.id,
        phase: params.phase,
        rows: params.rows,
        bytesEstimate: params.bytesEstimate,
        onEvict: params.onEvict,
      };
      entries.set(entry.id, entry);
      rows += entry.rows;
      bytesEstimate += entry.bytesEstimate;
      recordDelta(entry, 1);
    },
    touch(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entries.delete(id);
      entries.set(id, entry);
    },
    remove(id, reason = 'released') {
      removeEntry(id, reason, false);
    },
    stats() {
      return { snapshots: entries.size, rows, bytesEstimate };
    },
  };
}
