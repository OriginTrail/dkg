import type Database from 'better-sqlite3';
import {
  type BoundedProtocolOutboxStore,
  type ProtocolOutboxStore,
  type ProtocolOutboxEntry,
  type ProtocolOutboxMetadata,
  type ProtocolOutboxPage,
  type ProtocolOutboxPageBudget,
  type ProtocolOutboxQueueStats,
  validateProtocolOutboxPageBudget,
} from '@origintrail-official/dkg-core';

interface SqliteOutboxRow {
  peer_id: string;
  protocol: string;
  message_id: string;
  payload: Buffer;
  attempts: number;
  first_failure_at: number;
  last_attempt_at: number;
  next_attempt_at: number;
  last_error: string | null;
}

/**
 * SQLite-backed `ProtocolOutboxStore` against the V12
 * `protocol_outbox` table. Sender-side durable retry queue, keyed
 * by `(peer, protocol, message_id)`. The substrate's reliability
 * floor: a daemon crash mid-retry doesn't lose the message — the
 * next startup's `Messenger.processOutboxTick` picks up exactly
 * where the crash left off (modulo the in-flight bytes that died
 * with the process, which is documented as the "in-flight queue
 * caveat" in CHANGELOG for rc.9).
 *
 * The backoff ladder + max-age are NOT stored in SQL — they live
 * on the wrapping `ProtocolOutbox` in `packages/core`, and only
 * the resulting `next_attempt_at` and `first_failure_at` timestamps
 * land in the table. This keeps the schema independent of policy
 * changes: bumping the ladder doesn't require a migration.
 *
 * Constructor takes a `maxAgeMs` so `dropExpired` can apply it
 * directly in SQL (avoiding a full table read).
 */
export interface SqliteProtocolOutboxStoreOptions {
  /**
   * Max age (ms) from `firstFailureAt` before `dropExpired(now)`
   * evicts an entry. Defaults to 24h. Mirrors the wrapping
   * `ProtocolOutbox`'s `maxAgeMs` so both layers agree.
   */
  maxAgeMs?: number;
  /**
   * Function that returns the backoff (ms) to apply for an entry
   * about to bump to `attempts`. The schema does NOT store the
   * ladder; PR-2's `lifecycle.ts` wiring passes the wrapping
   * `ProtocolOutbox`'s `backoffFor` method here so policy lives in
   * one place. Defaults to a flat 5s backoff so the store works
   * standalone in tests + before the wrapping outbox is wired.
   */
  backoffFor?: (attempts: number) => number;
}

const OUTBOX_METADATA_COLUMNS = `peer_id AS peer, protocol, message_id AS messageId,
  length(payload) AS payloadBytes, attempts, first_failure_at AS firstFailureAt,
  last_attempt_at AS lastAttemptAt, next_attempt_at AS nextAttemptAt,
  coalesce(last_error, '') AS lastError`;

export class SqliteProtocolOutboxStore implements BoundedProtocolOutboxStore, ProtocolOutboxStore {
  private readonly db: Database.Database;
  private maxAgeMs = 24 * 60 * 60 * 1000;
  private backoffFor: (attempts: number) => number = (_attempts) => 5_000;

  constructor(dashboard: { readonly db: Database.Database }, options: SqliteProtocolOutboxStoreOptions = {}) {
    this.db = dashboard.db;
    this.configurePolicy(options);
  }

  configurePolicy(options: SqliteProtocolOutboxStoreOptions = {}): void {
    this.maxAgeMs = options.maxAgeMs ?? this.maxAgeMs;
    this.backoffFor = options.backoffFor ?? this.backoffFor;
  }

  enqueue(
    peer: string,
    protocol: string,
    messageId: string,
    payload: Uint8Array,
    error: string,
    now: number,
  ): ProtocolOutboxEntry {
    const existing = this.db.prepare(
      'SELECT attempts FROM protocol_outbox WHERE peer_id = ? AND protocol = ? AND message_id = ?',
    ).get(peer, protocol, messageId) as { attempts: number } | undefined;
    if (existing) {
      return SqliteProtocolOutboxStore.rowToEntry(this.advanceRetryEntry(
        peer, protocol, messageId, existing.attempts + 1, error, now,
      )!);
    }

    const attempts = 1;
    const nextAttemptAt = now + this.backoffFor(attempts);
    const blob = Buffer.from(payload);
    this.db
      .prepare(
        `INSERT INTO protocol_outbox
           (peer_id, protocol, message_id, payload, attempts,
            first_failure_at, last_attempt_at, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(peer, protocol, messageId, blob, attempts, now, now, nextAttemptAt, error);
    return {
      peer,
      protocol,
      messageId,
      payload: new Uint8Array(blob),
      attempts,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt,
      lastError: error,
    };
  }

  markDelivered(peer: string, protocol: string, messageId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM protocol_outbox
         WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
      )
      .run(peer, protocol, messageId);
    return result.changes > 0;
  }

  hasEntry(peer: string, protocol: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM protocol_outbox
         WHERE peer_id = ? AND protocol = ? AND message_id = ? LIMIT 1`,
      )
      .get(peer, protocol, messageId) as { 1: number } | undefined;
    return row !== undefined;
  }

  hasPendingFor(peer: string): boolean {
    return this.db.prepare('SELECT 1 FROM protocol_outbox WHERE peer_id = ? LIMIT 1').get(peer) !== undefined;
  }

  pendingFor(peer: string): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_outbox
         WHERE peer_id = ?
         ORDER BY first_failure_at ASC, protocol ASC, message_id ASC`,
      )
      .all(peer) as Array<SqliteOutboxRow>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  due(now: number): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_outbox
         WHERE next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, first_failure_at ASC,
                  peer_id ASC, protocol ASC, message_id ASC`,
      )
      .all(now) as Array<SqliteOutboxRow>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  duePage(now: number, limit: number): ProtocolOutboxEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Outbox duePage limit must be a non-negative safe integer');
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_outbox
         WHERE next_attempt_at <= ?
         ORDER BY next_attempt_at ASC, first_failure_at ASC,
                  peer_id ASC, protocol ASC, message_id ASC
         LIMIT ?`,
      )
      .all(now, limit) as Array<SqliteOutboxRow>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  readDuePage(now: number, budget: ProtocolOutboxPageBudget): ProtocolOutboxPage {
    validateProtocolOutboxPageBudget(budget);
    // SQLite length(BLOB) reads its size without returning the BLOB to JS.
    // Select metadata first, then load only the admitted prefix. The read
    // transaction keeps both queries on one snapshot without a durable lease:
    // the daemon has one Messenger owner and never deletes rows on selection.
    return this.db.transaction(() => {
      const candidates = this.db.prepare(
        `SELECT ${OUTBOX_METADATA_COLUMNS} FROM protocol_outbox
         WHERE next_attempt_at <= ? AND length(payload) <= ?
         ORDER BY next_attempt_at, first_failure_at, peer_id, protocol, message_id
         LIMIT ?`,
      ).all(now, budget.maxPayloadBytes, budget.maxEntries) as ProtocolOutboxMetadata[];
      let selectedCount = 0;
      let payloadBytes = 0;
      let byteBudgetExhausted = false;
      for (const candidate of candidates) {
        if (payloadBytes + candidate.payloadBytes > budget.maxPayloadBytes) {
          byteBudgetExhausted = true;
          break;
        }
        selectedCount++;
        payloadBytes += candidate.payloadBytes;
      }
      // Carry exact admitted identities and order into one payload query.
      // JSON binds the bounded key list with one parameter regardless of size;
      // eligibility and ordering policy belong only to the metadata pass.
      const admittedKeys = candidates.slice(0, selectedCount)
        .map(entry => [entry.peer, entry.protocol, entry.messageId]);
      const rows = this.db.prepare(
        `SELECT CAST(admitted.key AS INTEGER) AS admitted_order, queued.* FROM json_each(?) AS admitted
         JOIN protocol_outbox AS queued
           ON queued.peer_id = json_extract(admitted.value, '$[0]')
          AND queued.protocol = json_extract(admitted.value, '$[1]')
          AND queued.message_id = json_extract(admitted.value, '$[2]')`,
      ).all(JSON.stringify(admittedKeys)) as Array<SqliteOutboxRow & { admitted_order: number }>;
      // Sort bounded row references here. A SQL ORDER BY on queued.* would
      // copy the admitted BLOBs into SQLite's temporary sorter as well.
      rows.sort((a, b) => a.admitted_order - b.admitted_order);
      const entries = rows.map(SqliteProtocolOutboxStore.rowToEntry);
      const { skippedOversizedEntries } = this.db.prepare(
        'SELECT count(*) AS skippedOversizedEntries FROM protocol_outbox WHERE next_attempt_at <= ? AND length(payload) > ?',
      ).get(now, budget.maxPayloadBytes) as { skippedOversizedEntries: number };
      return { entries, skippedOversizedEntries, byteBudgetExhausted };
    })();
  }

  listMetadata(peer?: string): ProtocolOutboxMetadata[] {
    const statement = this.db.prepare(
      `SELECT ${OUTBOX_METADATA_COLUMNS} FROM protocol_outbox
       ${peer === undefined ? '' : 'WHERE peer_id = ?'}
       ORDER BY first_failure_at, peer_id, protocol, message_id`,
    );
    return (peer === undefined ? statement.all() : statement.all(peer)) as ProtocolOutboxMetadata[];
  }

  dropExpiredMetadata(now: number): ProtocolOutboxMetadata[] {
    return this.db.prepare(
      `DELETE FROM protocol_outbox WHERE first_failure_at < ? RETURNING ${OUTBOX_METADATA_COLUMNS}`,
    ).all(now - this.maxAgeMs) as ProtocolOutboxMetadata[];
  }

  recordRetryFailure(peer: string, protocol: string, messageId: string, error: string, now: number): ProtocolOutboxMetadata | undefined {
    return this.db.transaction(() => {
      const current = this.db.prepare(
        'SELECT attempts FROM protocol_outbox WHERE peer_id = ? AND protocol = ? AND message_id = ?',
      ).get(peer, protocol, messageId) as { attempts: number } | undefined;
      if (!current) return undefined;
      return this.advanceRetryMetadata(
        peer, protocol, messageId, current.attempts + 1, error, now,
      );
    }).immediate();
  }

  private advanceRetryMetadata(
    peer: string, protocol: string, messageId: string, attempts: number,
    error: string, now: number,
  ): ProtocolOutboxMetadata | undefined {
    return this.db.prepare(
      `UPDATE protocol_outbox SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?
       WHERE peer_id = ? AND protocol = ? AND message_id = ? RETURNING ${OUTBOX_METADATA_COLUMNS}`,
    ).get(attempts, now, now + this.backoffFor(attempts), error, peer, protocol, messageId) as ProtocolOutboxMetadata | undefined;
  }

  private advanceRetryEntry(
    peer: string, protocol: string, messageId: string, attempts: number,
    error: string, now: number,
  ): SqliteOutboxRow | undefined {
    return this.db.prepare(
      `UPDATE protocol_outbox SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?
       WHERE peer_id = ? AND protocol = ? AND message_id = ? RETURNING *`,
    ).get(attempts, now, now + this.backoffFor(attempts), error, peer, protocol, messageId) as SqliteOutboxRow | undefined;
  }

  queueStats(now: number, maxPayloadBytes: number): ProtocolOutboxQueueStats {
    return this.db.prepare(
      `SELECT count(*) AS queuedEntries, coalesce(sum(length(payload)), 0) AS queuedBytes,
       coalesce(max(CASE WHEN next_attempt_at <= ? THEN ? - next_attempt_at END), 0) AS oldestDueAgeMs,
       count(CASE WHEN next_attempt_at <= ? AND length(payload) > ? THEN 1 END) AS oversizedDueEntries
       FROM protocol_outbox`,
    ).get(now, now, now, maxPayloadBytes) as ProtocolOutboxQueueStats;
  }

  dropExpired(now: number): ProtocolOutboxEntry[] {
    return (this.db.prepare(
      'DELETE FROM protocol_outbox WHERE first_failure_at < ? RETURNING *',
    ).all(now - this.maxAgeMs) as SqliteOutboxRow[])
      .map(SqliteProtocolOutboxStore.rowToEntry);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM protocol_outbox`).get() as {
      c: number;
    };
    return row.c;
  }

  list(): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM protocol_outbox ORDER BY first_failure_at ASC`)
      .all() as Array<SqliteOutboxRow>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM protocol_outbox WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
      )
      .get(peer, protocol, messageId) as
      | SqliteOutboxRow
      | undefined;
    if (!row) return undefined;
    return SqliteProtocolOutboxStore.rowToEntry(row);
  }

  private static rowToEntry(row: SqliteOutboxRow): ProtocolOutboxEntry {
    return {
      peer: row.peer_id,
      protocol: row.protocol,
      messageId: row.message_id,
      // better-sqlite3 already owns a fresh Buffer. A view retains that backing
      // allocation without a second full-payload copy; writes cannot affect SQL.
      payload: new Uint8Array(row.payload.buffer, row.payload.byteOffset, row.payload.byteLength),
      attempts: row.attempts,
      firstFailureAt: row.first_failure_at,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error ?? '',
    };
  }
}
