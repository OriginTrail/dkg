import type Database from 'better-sqlite3';
import {
  DEFAULT_SYNC_CHECKPOINT_TTL_MS,
  isValidSyncCheckpointEntry,
  transitionSyncCheckpointManifestOffset,
  transitionSyncCheckpointOffset,
  transitionSyncCheckpointResponderSession,
  withoutSyncCheckpointResponderSession,
  type DurableManifestDigest,
  type DurableManifestPrefixDigest,
  type SyncCheckpointEntry,
} from '@origintrail-official/dkg-core';
import type { NodeStoreDatabaseHandle } from './database-handle.js';

// --- Sync requester checkpoints (issue #1138 A3) ---

export class SqliteSyncCheckpointStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private readonly ttlMs: number;

  constructor(
    database: NodeStoreDatabaseHandle,
    options: { clock?: () => number; ttlMs?: number } = {},
  ) {
    this.db = database.db;
    this.clock = options.clock ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_SYNC_CHECKPOINT_TTL_MS;
  }

  private readRow(key: string): SyncCheckpointEntry | undefined {
    const row = this.db.prepare(
      `SELECT offset, updated_at, expires_at,
              responder_session_id, responder_session_expires_at, responder_session_offset,
              manifest_digest, manifest_prefix_digest, terminal
         FROM sync_checkpoints WHERE key = ?`,
    ).get(key) as {
      offset: number;
      updated_at: number;
      expires_at: number;
      responder_session_id: string | null;
      responder_session_expires_at: number | null;
      responder_session_offset: number | null;
      manifest_digest: DurableManifestDigest | null;
      manifest_prefix_digest: DurableManifestPrefixDigest | null;
      terminal: number;
    } | undefined;
    if (!row) return undefined;
    return {
      offset: row.offset,
      updatedAtMs: row.updated_at,
      expiresAtMs: row.expires_at,
      ...(row.terminal === 1 ? { terminal: true } : {}),
      ...(row.manifest_digest ? { manifestDigest: row.manifest_digest } : {}),
      ...(row.manifest_prefix_digest
        ? { manifestPrefixDigest: row.manifest_prefix_digest }
        : {}),
      // Preserve each nullable session column independently so the shared
      // validator can distinguish an absent session from a torn/malformed
      // persisted session. Collapsing a partial row to no session fields would
      // turn corrupt durable state into an apparently valid ordinary offset.
      ...(row.responder_session_id !== null
        ? { responderSessionId: row.responder_session_id }
        : {}),
      ...(row.responder_session_expires_at !== null
        ? { responderSessionExpiresAtMs: row.responder_session_expires_at }
        : {}),
      ...(row.responder_session_offset !== null
        ? { responderSessionOffset: row.responder_session_offset }
        : {}),
    };
  }

  get(key: string, now = this.clock()): SyncCheckpointEntry | undefined {
    const entry = this.readRow(key);
    if (!entry) return undefined;
    if (!isValidSyncCheckpointEntry(entry) || entry.expiresAtMs < now) {
      this.delete(key);
      return undefined;
    }
    if (
      entry.responderSessionId
      && (entry.responderSessionExpiresAtMs ?? 0) <= now
    ) {
      const withoutExpiredSession = withoutSyncCheckpointResponderSession(entry);
      this.writeEntry(key, withoutExpiredSession);
      return withoutExpiredSession;
    }
    return entry;
  }

  private writeEntry(key: string, entry: SyncCheckpointEntry): void {
    this.db.prepare(`
      INSERT INTO sync_checkpoints (
        key, offset, updated_at, expires_at,
        responder_session_id, responder_session_expires_at, responder_session_offset,
        manifest_digest, manifest_prefix_digest, terminal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        offset = excluded.offset,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at,
        responder_session_id = excluded.responder_session_id,
        responder_session_expires_at = excluded.responder_session_expires_at,
        responder_session_offset = excluded.responder_session_offset,
        manifest_digest = excluded.manifest_digest,
        manifest_prefix_digest = excluded.manifest_prefix_digest,
        terminal = excluded.terminal
    `).run(
      key,
      entry.offset,
      entry.updatedAtMs,
      entry.expiresAtMs,
      entry.responderSessionId ?? null,
      entry.responderSessionExpiresAtMs ?? null,
      entry.responderSessionOffset ?? null,
      entry.manifestDigest ?? null,
      entry.manifestPrefixDigest ?? null,
      entry.terminal ? 1 : 0,
    );
  }

  set(
    key: string,
    value: number,
    nowMs = this.clock(),
    responderSessionOffset?: number,
  ): void {
    const transition = this.db.transaction(() => {
      this.writeEntry(key, transitionSyncCheckpointOffset({
        key,
        existing: this.get(key, nowMs),
        value,
        nowMs,
        ttlMs: this.ttlMs,
        responderSessionOffset,
      }));
    });
    transition();
  }

  setManifestBoundOffset(
    key: string,
    value: number,
    manifestDigest: DurableManifestDigest,
    nowMs = this.clock(),
    manifestPrefixDigest?: DurableManifestPrefixDigest,
    terminal = false,
    responderSessionOffset?: number,
  ): void {
    const transition = this.db.transaction(() => {
      this.writeEntry(key, transitionSyncCheckpointManifestOffset({
        key,
        existing: this.get(key, nowMs),
        value,
        manifestDigest,
        nowMs,
        ttlMs: this.ttlMs,
        manifestPrefixDigest,
        terminal,
        responderSessionOffset,
      }));
    });
    transition();
  }

  setResponderSession(
    key: string,
    sessionId: string,
    expiresAtMs: number,
    nowMs = this.clock(),
    manifestDigest?: DurableManifestDigest,
    manifestPrefixDigest?: DurableManifestPrefixDigest,
    responderSessionOffset?: number,
  ): void {
    if (expiresAtMs <= nowMs) {
      this.clearResponderSession(key);
      return;
    }
    const transition = this.db.transaction(() => {
      this.writeEntry(key, transitionSyncCheckpointResponderSession({
        key,
        existing: this.get(key, nowMs),
        sessionId,
        expiresAtMs,
        nowMs,
        ttlMs: this.ttlMs,
        manifestDigest,
        manifestPrefixDigest,
        responderSessionOffset,
      }));
    });
    transition();
  }

  clearResponderSession(key: string): void {
    const transition = this.db.transaction(() => {
      const existing = this.readRow(key);
      if (existing) this.writeEntry(key, withoutSyncCheckpointResponderSession(existing));
    });
    transition();
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM sync_checkpoints WHERE key = ?`).run(key);
  }

  pruneExpired(nowMs = this.clock()): number {
    return this.db.prepare(`DELETE FROM sync_checkpoints WHERE expires_at < ?`).run(nowMs).changes;
  }
}
