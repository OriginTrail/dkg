import type Database from 'better-sqlite3';
import type { NodeStoreDatabaseHandle } from './database-handle.js';

/**
 * OT-RFC-59 SC5 durable changelog cursor store (duck-compatible with the agent's
 * ChangelogCursorStore). Keyed by (peer_id, context_graph_id); stores the last
 * APPLIED (era, seq) from that responder. Like `ka_numbers` / `protocol_outbox`
 * this state is durable: it is NEVER added to `prune()` — a TTL would defeat the
 * O(delta) cross-restart catch-up the changelog lane exists for.
 */
export class SqliteChangelogCursorStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(database: NodeStoreDatabaseHandle, options: { clock?: () => number } = {}) {
    this.db = database.db;
    this.clock = options.clock ?? (() => Date.now());
  }

  get(peerId: string, contextGraphId: string): { era: string; seq: number; updatedAtMs: number } | undefined {
    const row = this.db.prepare(
      `SELECT era, seq, updated_at FROM changelog_cursors WHERE peer_id = ? AND context_graph_id = ?`,
    ).get(peerId, contextGraphId) as { era: string; seq: number; updated_at: number } | undefined;
    if (!row) return undefined;
    return { era: row.era, seq: row.seq, updatedAtMs: row.updated_at };
  }

  set(peerId: string, contextGraphId: string, era: string, seq: number, nowMs = this.clock()): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`Invalid changelog cursor seq for ${peerId}/${contextGraphId}: ${seq}`);
    }
    this.db.prepare(`
      INSERT INTO changelog_cursors (peer_id, context_graph_id, era, seq, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, context_graph_id) DO UPDATE SET
        era = excluded.era,
        seq = excluded.seq,
        updated_at = excluded.updated_at
    `).run(peerId, contextGraphId, era, seq, nowMs);
  }
}

/**
 * OT-RFC-59 §6 P0 durable era guard (duck-compatible with storage's
 * ChangelogEraGuard). Persists the single (era, high_seq) high-water in
 * node-ui.db — which a `store.nq` RDF-store restore does NOT roll back — so the
 * write-side ChangelogStore can detect a restore/rollback (seq regressed under
 * the same era) and rotate the era, forcing peers to full-resync instead of
 * silently skipping. `save` is called after every committed seq, so it must be a
 * single fast upsert.
 */
export class SqliteChangelogEraGuard {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  constructor(database: NodeStoreDatabaseHandle, options: { clock?: () => number } = {}) {
    this.db = database.db;
    this.clock = options.clock ?? (() => Date.now());
  }

  async load(): Promise<{ era: string; highSeq: number } | null> {
    const row = this.db.prepare(
      `SELECT era, high_seq FROM changelog_era WHERE id = 1`,
    ).get() as { era: string; high_seq: number } | undefined;
    return row ? { era: row.era, highSeq: row.high_seq } : null;
  }

  async save(era: string, highSeq: number): Promise<void> {
    if (!Number.isSafeInteger(highSeq) || highSeq < 0) {
      throw new Error(`Invalid changelog era high_seq: ${highSeq}`);
    }
    this.db.prepare(`
      INSERT INTO changelog_era (id, era, high_seq, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        era = excluded.era,
        high_seq = excluded.high_seq,
        updated_at = excluded.updated_at
    `).run(era, highSeq, this.clock());
  }
}
