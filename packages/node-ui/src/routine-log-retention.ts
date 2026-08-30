import type Database from 'better-sqlite3';

export interface RoutineLogPruneBatch {
  deleted: number;
  hadOverflow: boolean;
  filledBatch: boolean;
}

interface RoutineLogCountRow {
  routine_rows: number;
}

type RoutineLogSchemaDatabase = Pick<
  Database.Database,
  'exec' | 'prepare' | 'transaction'
>;

const ROUTINE_LOG_TRIGGER_NAMES = [
  'track_routine_log_insert',
  'track_routine_log_delete',
  'track_routine_log_level_update',
] as const;

/**
 * Install or repair the durable schema owned by routine-log retention.
 *
 * DashboardDB keeps migration ordering, while this module keeps the counter,
 * index, trigger predicates, and recount transaction together with the code
 * that consumes them.
 */
export function ensureRoutineLogRetentionSchema(db: RoutineLogSchemaDatabase): void {
  const logsTable = db.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'logs'
  `).get() as { found: number } | undefined;
  if (!logsTable) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS routine_log_retention_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      routine_rows INTEGER NOT NULL CHECK (routine_rows >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_logs_routine_id
      ON logs(id)
      WHERE level NOT IN ('warn', 'error');
  `);

  const triggerRows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
      AND name IN (
        'track_routine_log_insert',
        'track_routine_log_delete',
        'track_routine_log_level_update'
      )
  `).all() as Array<{ name: string }>;
  const state = db.prepare(`
    SELECT routine_rows
    FROM routine_log_retention_state
    WHERE singleton = 1
  `).get() as RoutineLogCountRow | undefined;
  if (
    state
    && ROUTINE_LOG_TRIGGER_NAMES.every(
      (name) => triggerRows.some((row) => row.name === name),
    )
  ) {
    return;
  }

  // This one-time/recovery scan is protected by an IMMEDIATE transaction.
  // The partial index makes it covering, and every later overflow check is
  // an O(1) singleton lookup rather than OFFSET-walking one million rows.
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS track_routine_log_insert;
      DROP TRIGGER IF EXISTS track_routine_log_delete;
      DROP TRIGGER IF EXISTS track_routine_log_level_update;
    `);
    const count = db.prepare(`
      SELECT COUNT(*) AS routine_rows
      FROM logs
      WHERE level NOT IN ('warn', 'error')
    `).get() as RoutineLogCountRow;
    db.prepare(`
      INSERT INTO routine_log_retention_state (singleton, routine_rows)
      VALUES (1, @routineRows)
      ON CONFLICT(singleton) DO UPDATE SET routine_rows = excluded.routine_rows
    `).run({ routineRows: count.routine_rows });
    db.exec(`
      CREATE TRIGGER track_routine_log_insert
      AFTER INSERT ON logs
      WHEN NEW.level NOT IN ('warn', 'error')
      BEGIN
        UPDATE routine_log_retention_state
        SET routine_rows = routine_rows + 1
        WHERE singleton = 1;
      END;

      CREATE TRIGGER track_routine_log_delete
      AFTER DELETE ON logs
      WHEN OLD.level NOT IN ('warn', 'error')
      BEGIN
        UPDATE routine_log_retention_state
        SET routine_rows = MAX(0, routine_rows - 1)
        WHERE singleton = 1;
      END;

      CREATE TRIGGER track_routine_log_level_update
      AFTER UPDATE OF level ON logs
      WHEN (OLD.level IN ('warn', 'error')) <> (NEW.level IN ('warn', 'error'))
      BEGIN
        UPDATE routine_log_retention_state
        SET routine_rows = routine_rows + CASE
          WHEN NEW.level NOT IN ('warn', 'error') THEN 1
          ELSE -1
        END
        WHERE singleton = 1;
      END;
    `);
  }).immediate();
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
