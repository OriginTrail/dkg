import type Database from 'better-sqlite3';

export interface RoutineLogPruneBatch {
  deleted: number;
  hadOverflow: boolean;
  filledBatch: boolean;
}

interface RoutineLogCountRow {
  routine_rows: number;
}

/**
 * Owns count-based retention for routine log rows.
 *
 * Schema triggers maintain an exact, crash-safe row count for every writer,
 * including compatibility callers that write through `DashboardDB.db`. The
 * hot path performs only O(1) counter accounting and schedules maintenance;
 * bounded deletion runs after the insert returns and the independent daemon
 * pruner remains its retry/backlog owner.
 */
export class RoutineLogRetention {
  private writesSinceGuard = 0;
  private scheduledMaintenance: ReturnType<typeof setImmediate> | null = null;
  private readonly readRoutineCount: Database.Statement;
  private readonly deleteOldestRoutineRows: Database.Statement;
  private readonly runPruneTransaction: () => RoutineLogPruneBatch;

  constructor(
    db: Pick<Database.Database, 'prepare' | 'transaction'>,
    private readonly rowCap: number,
    private readonly batchRows: number,
  ) {
    this.readRoutineCount = db.prepare(`
      SELECT routine_rows
      FROM routine_log_retention_state
      WHERE singleton = 1
    `);
    this.deleteOldestRoutineRows = db.prepare(`
      DELETE FROM logs
      WHERE id IN (
        SELECT id
        FROM logs
        WHERE level NOT IN ('warn', 'error')
        ORDER BY id ASC
        LIMIT @deleteRows
      )
    `);
    const pruneTransaction = db.transaction(() => this.pruneWithinTransaction());
    this.runPruneTransaction = () => pruneTransaction.immediate();
  }

  noteCommittedInsert(level: string): void {
    if (!this.isRoutineLevel(level)) return;
    this.writesSinceGuard += 1;
    // Each scheduled run removes at most one configured batch, so its cadence
    // must never admit more routine rows than that batch can remove.
    const guardInterval = Math.min(
      1_000,
      Math.max(1, this.rowCap),
      this.batchRows,
    );
    if (this.writesSinceGuard < guardInterval) return;
    this.writesSinceGuard = 0;
    this.scheduleMaintenance();
  }

  hasOverflow(): boolean {
    return this.routineRowCount() > this.rowCap;
  }

  pruneOverflowBatch(): RoutineLogPruneBatch {
    return this.runPruneTransaction();
  }

  close(): void {
    if (this.scheduledMaintenance) clearImmediate(this.scheduledMaintenance);
    this.scheduledMaintenance = null;
  }

  private scheduleMaintenance(): void {
    if (this.scheduledMaintenance) return;
    this.scheduledMaintenance = setImmediate(() => {
      this.scheduledMaintenance = null;
      try {
        const result = this.pruneOverflowBatch();
        if (result.filledBatch) this.scheduleMaintenance();
      } catch {
        // The INSERT committed before maintenance was scheduled. A retention
        // failure must not falsely report that durable write as failed; the
        // independent daemon pruner or a later guard will retry the backlog.
      }
    });
    this.scheduledMaintenance.unref?.();
  }

  private routineRowCount(): number {
    const row = this.readRoutineCount.get() as RoutineLogCountRow | undefined;
    if (!row) {
      throw new Error('Routine-log retention state is missing');
    }
    return row.routine_rows;
  }

  private pruneWithinTransaction(): RoutineLogPruneBatch {
    const overflow = Math.max(0, this.routineRowCount() - this.rowCap);
    if (overflow === 0) {
      return { deleted: 0, hadOverflow: false, filledBatch: false };
    }
    const deleteRows = Math.min(overflow, this.batchRows);
    const deleted = this.deleteOldestRoutineRows.run({ deleteRows }).changes;
    return {
      deleted,
      hadOverflow: true,
      filledBatch: deleted === this.batchRows,
    };
  }

  private isRoutineLevel(level: string): boolean {
    return level !== 'warn' && level !== 'error';
  }
}
