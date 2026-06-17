import type { SyncPhase } from '../auth/request-build.js';

export const DEFAULT_SYNC_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SyncCheckpointEntry {
  offset: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

export interface SyncCheckpointStore {
  /**
   * Return a checkpoint only while it is still fresh enough to resume the
   * responder's OFFSET-based page order safely. Implementations must reject
   * stale entries from this read path; pruneExpired() is maintenance only.
   */
  get(key: string, nowMs?: number): SyncCheckpointEntry | undefined;
  set(key: string, value: number, nowMs?: number): void;
  delete(key: string): void;
  pruneExpired?(nowMs?: number): number;
}

export class MemorySyncCheckpointStore implements SyncCheckpointStore {
  private readonly entries = new Map<string, SyncCheckpointEntry>();
  private readonly clock: () => number;
  private readonly ttlMs: number;

  constructor(options: { clock?: () => number; ttlMs?: number } = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_SYNC_CHECKPOINT_TTL_MS;
  }

  get(key: string, nowMs = this.clock()): SyncCheckpointEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs < nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: number, nowMs = this.clock()): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid sync checkpoint offset for ${key}: ${value}`);
    }
    this.entries.set(key, {
      offset: value,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  pruneExpired(nowMs = this.clock()): number {
    let pruned = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs < nowMs) {
        this.entries.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }
}

export function getSyncCheckpointKey(
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: SyncPhase,
  snapshotRef?: string,
  sinceBatchId?: string,
  recovery?: boolean,
): string {
  const refSuffix = phase === 'snapshot' && snapshotRef ? `|${snapshotRef}` : '';
  // Phase C: `sinceBatchId` changes the responder's result set, so a delta
  // fetch MUST NOT resume at an offset recorded against a full scan (or a
  // delta with a different high-water mark) — that would skip newly eligible
  // triples. Scoping the key by `sinceBatchId` keeps each filtered dataset on
  // its own resume cursor; a full sync (no hint) keeps the unscoped key.
  const sinceSuffix = sinceBatchId ? `|since:${sinceBatchId}` : '';
  // R10: member SWM recovery reuses the same `(peer|cg|swm|phase)` namespace as
  // background incremental SWM catch-up. A running recovery's mid-stream cursor
  // (set/dropped per page) would otherwise overwrite or delete the normal
  // incremental cursor and force background sync to restart from offset 0. Give
  // recovery its OWN cursor + responder-session scope so it never mutates the
  // shared incremental-sync cursor. The flag is additive (only set on the
  // recovery path), so normal sync keeps its unscoped key.
  const recoverySuffix = recovery ? '|recovery' : '';
  return `${remotePeerId}|${contextGraphId}|${includeSharedMemory ? 'swm' : 'durable'}|${phase}${refSuffix}${sinceSuffix}${recoverySuffix}`;
}
