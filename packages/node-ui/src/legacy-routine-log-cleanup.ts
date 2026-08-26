import type Database from 'better-sqlite3';

const STATE_KEY = 'legacyRoutineLogCleanup.v2';
const COMPLETE = 'complete';

export type LegacyRoutineLogCleanupState =
  | { kind: 'pending'; highWaterId: number }
  | { kind: 'complete' };

export interface LegacyRoutineLogDeleteBatchResult {
  deleted: number;
  hasMore: boolean;
}

/**
 * Finite upgrade migration for the routine rows written by the former daemon
 * SQLite sink. One setting owns the complete durable state: `pending:<id>` is
 * the immutable first-upgrade high-water mark and `complete` is terminal.
 *
 * Warning/error rows are always diagnostics. For a retained operation, the
 * newest pre-cutover routine row is also kept as a bounded summary so the
 * operation detail API remains useful; older routine traffic and orphaned
 * operation IDs are drained.
 */
export class LegacyRoutineLogCleanup {
  constructor(
    private readonly db: Database.Database,
    private readonly batchRows: number,
  ) {
    this.initialize();
  }

  state(): LegacyRoutineLogCleanupState {
    const row = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(STATE_KEY) as { value: string } | undefined;
    if (!row) throw new Error('Legacy routine-log cleanup state was not initialized');
    if (row.value === COMPLETE) return { kind: 'complete' };
    const match = /^pending:(\d+)$/.exec(row.value);
    const highWaterId = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(highWaterId) || highWaterId < 0) {
      throw new Error(`Invalid legacy routine-log cleanup state: ${row.value}`);
    }
    return { kind: 'pending', highWaterId };
  }

  hasPendingRows(): boolean {
    const state = this.state();
    if (state.kind === 'complete') return false;
    return this.db.prepare(`
      SELECT 1
      FROM logs AS candidate
      WHERE ${this.candidatePredicate()}
      LIMIT 1
    `).get({ highWaterId: state.highWaterId }) !== undefined;
  }

  deleteBatch(): LegacyRoutineLogDeleteBatchResult {
    const state = this.state();
    if (state.kind === 'complete') return { deleted: 0, hasMore: false };
    const deleted = this.db.prepare(`
      DELETE FROM logs
      WHERE id IN (
        SELECT candidate.id
        FROM logs AS candidate
        WHERE ${this.candidatePredicate()}
        ORDER BY candidate.id ASC
        LIMIT @batchRows
      )
    `).run({
      highWaterId: state.highWaterId,
      batchRows: this.batchRows,
    }).changes;
    return { deleted, hasMore: deleted === this.batchRows };
  }

  markComplete(): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(STATE_KEY, COMPLETE);
  }

  private initialize(): void {
    const current = this.db.prepare(
      `SELECT 1 FROM settings WHERE key = ?`,
    ).get(STATE_KEY);
    if (current !== undefined) return;

    const maxRow = this.db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS id FROM logs`,
    ).get() as { id: number };
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)`,
    ).run(STATE_KEY, `pending:${maxRow.id}`);
  }

  private candidatePredicate(): string {
    return `
      candidate.id <= @highWaterId
      AND candidate.level IN ('debug', 'info')
      AND (
        candidate.operation_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM operations AS operation
          WHERE operation.operation_id = candidate.operation_id
        )
        OR EXISTS (
          SELECT 1
          FROM logs AS newer
          WHERE newer.operation_id = candidate.operation_id
            AND newer.id > candidate.id
            AND newer.id <= @highWaterId
            AND newer.level IN ('debug', 'info')
        )
      )
    `;
  }

}
