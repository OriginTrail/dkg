import type { SyncPhase } from '../auth/request-build.js';

export const DEFAULT_SYNC_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export interface SyncCheckpointEntry {
  offset: number;
  updatedAtMs: number;
  expiresAtMs: number;
  /**
   * Opaque responder snapshot token paired with this offset. OFFSET is only
   * meaningful while the responder still owns the same immutable row list;
   * persisting the token lets a requester resume safely across its own restart.
   */
  responderSessionId?: string;
  responderSessionExpiresAtMs?: number;
}

export interface SyncCheckpointStore {
  /**
   * Return a checkpoint only while it is still fresh enough to resume the
   * responder's OFFSET-based page order safely. Implementations must reject
   * stale entries from this read path; pruneExpired() is maintenance only.
   */
  get(key: string, nowMs?: number): SyncCheckpointEntry | undefined;
  set(key: string, value: number, nowMs?: number): void;
  /** Persist the responder snapshot token without advancing the verified offset. */
  setResponderSession?(key: string, sessionId: string, expiresAtMs: number, nowMs?: number): void;
  /** Forget only the snapshot token while retaining the verified offset. */
  clearResponderSession?(key: string): void;
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
    if (
      entry.responderSessionId
      && (entry.responderSessionExpiresAtMs ?? 0) <= nowMs
    ) {
      const withoutExpiredSession: SyncCheckpointEntry = {
        offset: entry.offset,
        updatedAtMs: entry.updatedAtMs,
        expiresAtMs: entry.expiresAtMs,
      };
      this.entries.set(key, withoutExpiredSession);
      return withoutExpiredSession;
    }
    return entry;
  }

  set(key: string, value: number, nowMs = this.clock()): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid sync checkpoint offset for ${key}: ${value}`);
    }
    const existing = this.entries.get(key);
    this.entries.set(key, {
      offset: value,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      ...(existing?.responderSessionId
        && (existing.responderSessionExpiresAtMs ?? 0) > nowMs
        ? {
            responderSessionId: existing.responderSessionId,
            responderSessionExpiresAtMs: existing.responderSessionExpiresAtMs,
          }
        : {}),
    });
  }

  setResponderSession(
    key: string,
    sessionId: string,
    expiresAtMs: number,
    nowMs = this.clock(),
  ): void {
    if (!sessionId || !Number.isSafeInteger(expiresAtMs)) {
      throw new Error(`Invalid sync responder session for ${key}`);
    }
    if (expiresAtMs <= nowMs) {
      this.clearResponderSession(key);
      return;
    }
    const existing = this.entries.get(key);
    this.entries.set(key, {
      offset: existing?.offset ?? 0,
      updatedAtMs: existing?.updatedAtMs ?? nowMs,
      expiresAtMs: existing?.expiresAtMs ?? nowMs + this.ttlMs,
      responderSessionId: sessionId,
      responderSessionExpiresAtMs: expiresAtMs,
    });
  }

  clearResponderSession(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.set(key, {
      offset: existing.offset,
      updatedAtMs: existing.updatedAtMs,
      expiresAtMs: existing.expiresAtMs,
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

// ── OT-RFC-59 changelog cursor (SC5) ─────────────────────────────────────────

export interface ChangelogCursorEntry {
  /** Log generation id of the responder this cursor tracks (era mismatch ⇒ resync). */
  era: string;
  /** Last seq successfully APPLIED from that responder for this CG. */
  seq: number;
  updatedAtMs: number;
}

/**
 * Durable per-(peer, contextGraph) OT-RFC-59 changelog cursor. Unlike
 * {@link SyncCheckpointStore} this is **NEVER TTL-pruned** — the whole point is
 * O(delta) catch-up across restarts, which a TTL would defeat by forcing a full
 * rescan. Keyed by (peerId, contextGraphId): `seq` is the responder node's
 * per-node counter, so a cursor is never shared across peers.
 */
export interface ChangelogCursorStore {
  get(peerId: string, contextGraphId: string): ChangelogCursorEntry | undefined;
  set(peerId: string, contextGraphId: string, era: string, seq: number, nowMs?: number): void;
}

export class MemoryChangelogCursorStore implements ChangelogCursorStore {
  private readonly entries = new Map<string, ChangelogCursorEntry>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  private static key(peerId: string, contextGraphId: string): string {
    return `${peerId}\n${contextGraphId}`;
  }

  get(peerId: string, contextGraphId: string): ChangelogCursorEntry | undefined {
    return this.entries.get(MemoryChangelogCursorStore.key(peerId, contextGraphId));
  }

  set(peerId: string, contextGraphId: string, era: string, seq: number, nowMs = this.clock()): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`Invalid changelog cursor seq for ${peerId}/${contextGraphId}: ${seq}`);
    }
    this.entries.set(MemoryChangelogCursorStore.key(peerId, contextGraphId), { era, seq, updatedAtMs: nowMs });
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
  assetFilterKey?: string,
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
  const assetsSuffix = assetFilterKey ? `|assets:${encodeURIComponent(assetFilterKey)}` : '';
  return `${remotePeerId}|${contextGraphId}|${includeSharedMemory ? 'swm' : 'durable'}|${phase}${refSuffix}${sinceSuffix}${recoverySuffix}${assetsSuffix}`;
}
