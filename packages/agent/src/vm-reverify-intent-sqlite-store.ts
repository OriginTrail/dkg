// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite implementation of the re-verification intent store (#2435).
 *
 * Concurrency model, copied from the finalization inbox because it is the one
 * this codebase already trusts: every mutation is serialized behind a promise
 * tail, every read awaits that tail, and every multi-statement mutation runs
 * inside `BEGIN IMMEDIATE`. Cross-actor safety is a compare-and-set on
 * `generation` — the drain plans against generation N and every write it then
 * issues is refused if a newer event has redefined the row in the meantime.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  fsyncVmReverifyIntentDatabase,
  openVmReverifyIntentDatabase,
} from './vm-reverify-intent-sqlite-schema.js';
import {
  eventRedefinesIntent,
  type VmReverifyAbandonReason,
  VmReverifyIntentHealth,
  VmReverifyIntentPosition,
  VmReverifyIntentRecord,
  VmReverifyIntentStore,
  VmReverifyIntentUpsertInput,
  VmReverifyIntentUpsertResult,
} from './vm-reverify-intent-store.js';

export interface SqliteVmReverifyIntentStoreOptions {
  /** Injectable clock. Production passes nothing and gets `Date.now`. */
  now?: () => number;
}

interface VmReverifyIntentRow {
  ual: string;
  local_cg_id: string;
  ka_id: string;
  kind: string;
  observed_block: number;
  observed_block_hash: string;
  observed_tx_hash: string;
  observed_tx_index: number;
  observed_log_index: number;
  state: string;
  abandon_reason: string | null;
  generation: number;
  attempt_count: number;
  first_attempt_at: number | null;
  next_attempt_at: number | null;
  last_outcome: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRecord(raw: unknown): VmReverifyIntentRecord {
  const row = raw as VmReverifyIntentRow;
  return {
    ual: String(row.ual),
    localCgId: String(row.local_cg_id),
    kaId: String(row.ka_id),
    kind: row.kind as VmReverifyIntentRecord['kind'],
    observed: {
      blockNumber: Number(row.observed_block),
      blockHash: String(row.observed_block_hash),
      transactionHash: String(row.observed_tx_hash),
      transactionIndex: Number(row.observed_tx_index),
      logIndex: Number(row.observed_log_index),
    },
    state: row.state as VmReverifyIntentRecord['state'],
    ...(row.abandon_reason === null
      ? {}
      : { abandonReason: row.abandon_reason as VmReverifyAbandonReason }),
    generation: Number(row.generation),
    attemptCount: Number(row.attempt_count),
    ...(row.first_attempt_at === null ? {} : { firstAttemptAt: Number(row.first_attempt_at) }),
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: Number(row.next_attempt_at) }),
    ...(row.last_outcome === null ? {} : { lastOutcome: row.last_outcome }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class SqliteVmReverifyIntentStore implements VmReverifyIntentStore {
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #now: () => number;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    options: SqliteVmReverifyIntentStoreOptions,
  ) {
    this.#now = options.now ?? (() => Date.now());
  }

  static async open(
    dataDir: string,
    options: SqliteVmReverifyIntentStoreOptions = {},
  ): Promise<SqliteVmReverifyIntentStore> {
    const opened = await openVmReverifyIntentDatabase(dataDir);
    return new SqliteVmReverifyIntentStore(opened.databasePath, opened.database, options);
  }

  get closed(): boolean {
    return this.#closed;
  }

  upsert(input: VmReverifyIntentUpsertInput): Promise<VmReverifyIntentUpsertResult> {
    if (this.#closed || this.#closing) {
      return Promise.reject(new Error('VM re-verify intent store is closed'));
    }
    return this.mutate(() => {
      if (this.#closed) throw new Error('VM re-verify intent store is closed');
      let outcome: VmReverifyIntentUpsertResult = 'unchanged';
      this.transaction(() => {
        const now = this.#now();
        const existing = this.database
          .prepare('SELECT * FROM vm_reverify_intents_v1 WHERE ual = ?')
          .get(input.ual);
        if (!existing) {
          this.database.prepare(`
            INSERT INTO vm_reverify_intents_v1 (
              ual, local_cg_id, ka_id, kind,
              observed_block, observed_block_hash, observed_tx_hash,
              observed_tx_index, observed_log_index,
              state, generation, attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, ?, ?)
          `).run(
            input.ual,
            input.localCgId,
            input.kaId,
            input.kind,
            input.position.blockNumber,
            input.position.blockHash,
            input.position.transactionHash,
            input.position.transactionIndex,
            input.position.logIndex,
            now,
            now,
          );
          outcome = 'inserted';
          return;
        }
        const record = rowToRecord(existing);
        if (!eventRedefinesIntent(input.position, record.observed, record.state)) return;
        // A strictly-newer event redefines the work, so the ENTIRE retry budget
        // resets — including `first_attempt_at`. Carrying the old timestamp
        // forward would re-park a revived row against a 24 h window that
        // started before this event existed, silently turning "any newer event
        // revives ABANDONED rows" (ADR-W2R-4) into a no-op.
        this.database.prepare(`
          UPDATE vm_reverify_intents_v1
          SET local_cg_id = ?,
              ka_id = ?,
              kind = ?,
              observed_block = ?,
              observed_block_hash = ?,
              observed_tx_hash = ?,
              observed_tx_index = ?,
              observed_log_index = ?,
              state = 'PENDING',
              abandon_reason = NULL,
              generation = generation + 1,
              attempt_count = 0,
              first_attempt_at = NULL,
              next_attempt_at = NULL,
              last_outcome = NULL,
              updated_at = ?
          WHERE ual = ?
        `).run(
          input.localCgId,
          input.kaId,
          input.kind,
          input.position.blockNumber,
          input.position.blockHash,
          input.position.transactionHash,
          input.position.transactionIndex,
          input.position.logIndex,
          now,
          input.ual,
        );
        outcome = 'advanced';
      });
      return outcome;
    });
  }

  async listDue(now: number, limit: number): Promise<VmReverifyIntentRecord[]> {
    if (this.#closed || this.#closing) return [];
    if (!Number.isFinite(limit)) return [];
    const boundedLimit = Math.max(0, Math.trunc(limit));
    if (boundedLimit === 0) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    return this.database.prepare(`
      SELECT * FROM vm_reverify_intents_v1
      WHERE state = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY observed_block, updated_at, ual
      LIMIT ?
    `).all(now, boundedLimit).map(rowToRecord);
  }

  resolve(ual: string, generation: number): Promise<boolean> {
    return this.casMutation(() => this.database.prepare(
      'DELETE FROM vm_reverify_intents_v1 WHERE ual = ? AND generation = ?',
    ).run(ual, generation).changes > 0);
  }

  recordAttempt(
    ual: string,
    generation: number,
    lastOutcome: string,
    retryDelayMs: number,
    now: number,
    startsParkBudget: boolean,
  ): Promise<boolean> {
    return this.casMutation(() => this.database.prepare(`
      UPDATE vm_reverify_intents_v1
      SET attempt_count = attempt_count + 1,
          first_attempt_at = CASE WHEN ? THEN COALESCE(first_attempt_at, ?) ELSE first_attempt_at END,
          next_attempt_at = ?,
          last_outcome = ?,
          updated_at = ?
      WHERE ual = ? AND generation = ? AND state = 'PENDING'
    `).run(
      startsParkBudget ? 1 : 0,
      now,
      now + Math.max(0, Math.trunc(retryDelayMs)),
      lastOutcome,
      now,
      ual,
      generation,
    ).changes > 0);
  }

  abandon(ual: string, generation: number, reason: VmReverifyAbandonReason): Promise<boolean> {
    return this.casMutation(() => this.database.prepare(`
      UPDATE vm_reverify_intents_v1
      SET state = 'ABANDONED',
          abandon_reason = ?,
          next_attempt_at = NULL,
          updated_at = ?
      WHERE ual = ? AND generation = ? AND state = 'PENDING'
    `).run(reason, this.#now(), ual, generation).changes > 0);
  }

  reviveForContextGraph(localCgId: string): Promise<number> {
    if (this.#closed || this.#closing) return Promise.resolve(0);
    return this.mutate(() => {
      if (this.#closed) return 0;
      let revived = 0;
      this.transaction(() => {
        // Same total budget reset as `upsert`'s advance, for the same reason:
        // re-hosting a CG is new evidence about reachability, so a row parked
        // under the old evidence must start its 24 h window over.
        revived = Number(this.database.prepare(`
          UPDATE vm_reverify_intents_v1
          SET state = 'PENDING',
              abandon_reason = NULL,
              generation = generation + 1,
              attempt_count = 0,
              first_attempt_at = NULL,
              next_attempt_at = NULL,
              last_outcome = NULL,
              updated_at = ?
          WHERE local_cg_id = ? AND state = 'ABANDONED'
        `).run(this.#now(), localCgId).changes);
      });
      return revived;
    });
  }

  async countPending(localCgId?: string): Promise<number> {
    if (this.#closed || this.#closing) return 0;
    await this.#mutationTail;
    if (this.#closed) return 0;
    const row = localCgId === undefined
      ? this.database.prepare(
        "SELECT COUNT(*) AS count FROM vm_reverify_intents_v1 WHERE state = 'PENDING'",
      ).get()
      : this.database.prepare(
        "SELECT COUNT(*) AS count FROM vm_reverify_intents_v1 WHERE state = 'PENDING' AND local_cg_id = ?",
      ).get(localCgId);
    return Number((row as { count: number | bigint }).count);
  }

  async health(): Promise<VmReverifyIntentHealth> {
    if (this.#closed || this.#closing) return { pending: 0, abandoned: 0 };
    await this.#mutationTail;
    if (this.#closed) return { pending: 0, abandoned: 0 };
    const counts = this.database.prepare(
      'SELECT state, COUNT(*) AS count FROM vm_reverify_intents_v1 GROUP BY state',
    ).all() as Array<{ state: string; count: number | bigint }>;
    const oldest = this.database.prepare(
      "SELECT MIN(first_attempt_at) AS oldest FROM vm_reverify_intents_v1 WHERE state = 'PENDING'",
    ).get() as { oldest: number | bigint | null };
    const byState = new Map(counts.map((row) => [row.state, Number(row.count)]));
    return {
      pending: byState.get('PENDING') ?? 0,
      abandoned: byState.get('ABANDONED') ?? 0,
      ...(oldest.oldest === null
        ? {}
        : { oldestPendingFirstAttemptAt: Number(oldest.oldest) }),
    };
  }

  gcAbandoned(olderThanMs: number): Promise<number> {
    if (this.#closed || this.#closing) return Promise.resolve(0);
    return this.mutate(() => {
      if (this.#closed) return 0;
      let removed = 0;
      this.transaction(() => {
        removed = Number(this.database.prepare(
          "DELETE FROM vm_reverify_intents_v1 WHERE state = 'ABANDONED' AND updated_at <= ?",
        ).run(this.#now() - Math.max(0, Math.trunc(olderThanMs))).changes);
      });
      return removed;
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#mutationTail;
      try {
        this.database.exec('PRAGMA busy_timeout = 0');
        try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retain WAL */ }
        this.database.close();
        this.#closed = true;
        fsyncVmReverifyIntentDatabase(this.databasePath);
      } finally {
        this.#closing = false;
      }
    })();
    return this.#closePromise;
  }

  private casMutation(operation: () => boolean): Promise<boolean> {
    if (this.#closed || this.#closing) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => { changed = operation(); });
      return changed;
    });
  }

  private mutate<T>(operation: () => T): Promise<T> {
    const run = this.#mutationTail.catch(() => undefined).then(operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private transaction(operation: () => void): void {
    let open = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      open = true;
      operation();
      this.database.exec('COMMIT');
      open = false;
    } catch (error) {
      if (open) {
        try { this.database.exec('ROLLBACK'); } catch { /* retain transaction failure */ }
      }
      throw error;
    }
  }
}

export async function openSqliteVmReverifyIntentStore(
  dataDir: string,
  options: SqliteVmReverifyIntentStoreOptions = {},
): Promise<SqliteVmReverifyIntentStore> {
  return SqliteVmReverifyIntentStore.open(dataDir, options);
}
