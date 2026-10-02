import type Database from 'better-sqlite3';
import {
  RESPONSE_CACHE_BYTES,
  type IdempotencyCheckResult,
  type MessageDirection,
  type MessageIdempotencyStore,
} from '@origintrail-official/dkg-core';
import type { NodeStoreDatabaseHandle } from './database-handle.js';

/**
 * SQLite-backed `MessageIdempotencyStore` against the V12
 * `message_idempotency` table in `DashboardDB`. Receiver-side dedup
 * cache + sender-side "did we deliver this" cache, keyed by
 * `(peer, protocol, message_id, direction)`.
 *
 * Constructed against an already-opened `DashboardDB` so all DKG
 * persistence shares a single SQLite file (one WAL, one fsync, one
 * pragma surface). Doesn't open the DB itself — the daemon's
 * `lifecycle.ts` owns DB lifecycle and hands one in here in PR-2.
 *
 * Response caching policy lives in `RESPONSE_CACHE_BYTES` (256 KiB
 * fixed limit, exported from `@origintrail-official/dkg-core`).
 * Responses up to the limit are stored inline in `response_blob`;
 * larger responses store `response_blob = NULL` with the actual
 * size in `response_size` (mark-only). Duplicate receives whose
 * original was mark-only surface as `RESPONSE_GONE` to the sender
 * — see `RESPONSE_GONE_MARKER` for the canonical signal string.
 */
export class SqliteMessageIdempotencyStore implements MessageIdempotencyStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  /** @param clock injectable for deterministic tests. Defaults to `Date.now`. */
  constructor(database: NodeStoreDatabaseHandle, options: { clock?: () => number } = {}) {
    this.db = database.db;
    this.clock = options.clock ?? (() => Date.now());
  }

  check(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
  ): IdempotencyCheckResult {
    const row = this.db
      .prepare(
        `SELECT response_blob FROM message_idempotency
         WHERE peer_id = ? AND protocol = ? AND message_id = ? AND direction = ?`,
      )
      .get(peer, protocol, messageId, direction) as
      | { response_blob: Buffer | null }
      | undefined;
    if (!row) return { seen: false };
    // better-sqlite3 returns Node Buffer for BLOB columns; copy into a
    // Uint8Array so callers cannot mutate the cached DB snapshot.
    if (row.response_blob === null) return { seen: true };
    return {
      seen: true,
      cachedResponse: new Uint8Array(row.response_blob),
    };
  }

  record(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
    response?: Uint8Array,
  ): void {
    const responseSize = response?.length ?? 0;
    // Mark-only when over the cache limit. Stores NULL blob + the
    // actual size, so a future duplicate receive can surface
    // `RESPONSE_GONE`. The 256 KiB cutoff is the rc.9 plan's locked
    // design decision — no per-protocol/per-call knob.
    const blob =
      response !== undefined && response.length <= RESPONSE_CACHE_BYTES
        ? Buffer.from(response)
        : null;
    // Targeted ON CONFLICT — never the broader INSERT OR IGNORE which
    // would silently swallow unrelated constraint violations (the
    // Codex #534 lesson). Idempotent re-record on the same key is a
    // no-op; any other constraint violation surfaces as a thrown
    // SqliteError so the substrate's bug doesn't disguise itself as
    // a normal duplicate.
    this.db
      .prepare(
        `INSERT INTO message_idempotency
           (peer_id, protocol, message_id, direction, response_blob, response_size, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (peer_id, protocol, message_id, direction) DO NOTHING`,
      )
      .run(peer, protocol, messageId, direction, blob, responseSize, this.clock());
  }

  pruneOlderThan(tsMs: number): number {
    const result = this.db
      .prepare(`DELETE FROM message_idempotency WHERE ts < ?`)
      .run(tsMs);
    return result.changes;
  }
}
