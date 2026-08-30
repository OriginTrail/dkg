import type Database from 'better-sqlite3';

const PROTECTED_LOG_LEVELS = ['warn', 'error'] as const;
const protectedLogLevels = new Set<string>(PROTECTED_LOG_LEVELS);
const PROTECTED_LOG_LEVELS_SQL = PROTECTED_LOG_LEVELS
  .map((level) => `'${level.replaceAll("'", "''")}'`)
  .join(', ');
const RETENTION_TRIGGER_NAMES = [
  'track_routine_log_insert',
  'track_routine_log_delete',
  'track_routine_log_level_to_protected',
  'track_routine_log_level_to_routine',
] as const;

function routineLevelSql(column: string): string {
  return `${column} NOT IN (${PROTECTED_LOG_LEVELS_SQL})`;
}

function protectedLevelSql(column: string): string {
  return `${column} IN (${PROTECTED_LOG_LEVELS_SQL})`;
}

type RoutineLogRetentionSchemaDatabase = Pick<Database.Database, 'exec' | 'prepare'>;

/**
 * Install or repair every SQLite adjunct owned by routine-log retention.
 * Missing state or triggers force a reseed from existing rows before triggers
 * are installed, so upgraded/restored databases regain an exact counter.
 */
export function installRoutineLogRetentionSchema(
  db: RoutineLogRetentionSchemaDatabase,
): void {
  const logsTable = db.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'logs'
  `).get() as { found: number } | undefined;
  if (!logsTable) return;

  const existingTriggers = new Set(
    (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (${RETENTION_TRIGGER_NAMES.map(() => '?').join(', ')})
    `).all(...RETENTION_TRIGGER_NAMES) as Array<{ name: string }>).map(({ name }) => name),
  );
  const stateTable = db.prepare(`
    SELECT 1 AS found FROM sqlite_master
    WHERE type = 'table' AND name = 'log_retention_state'
  `).get() as { found: number } | undefined;
  const stateRow = stateTable
    ? db.prepare(`
      SELECT 1 AS found FROM log_retention_state WHERE singleton_id = 1
    `).get() as { found: number } | undefined
    : undefined;
  const needsReseed = !stateTable
    || !stateRow
    || RETENTION_TRIGGER_NAMES.some((name) => !existingTriggers.has(name));

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_routine_id
      ON logs(id) WHERE ${routineLevelSql('level')};
    CREATE TABLE IF NOT EXISTS log_retention_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      routine_count INTEGER NOT NULL CHECK (routine_count >= 0)
    );
  `);
  if (needsReseed) {
    db.prepare(`
      INSERT INTO log_retention_state(singleton_id, routine_count)
      SELECT 1, COUNT(*) FROM logs
      WHERE ${routineLevelSql('level')}
      ON CONFLICT(singleton_id) DO UPDATE
        SET routine_count = excluded.routine_count
    `).run();
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS track_routine_log_insert
    AFTER INSERT ON logs
    WHEN ${routineLevelSql('NEW.level')}
    BEGIN
      UPDATE log_retention_state
      SET routine_count = routine_count + 1
      WHERE singleton_id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS track_routine_log_delete
    AFTER DELETE ON logs
    WHEN ${routineLevelSql('OLD.level')}
    BEGIN
      UPDATE log_retention_state
      SET routine_count = routine_count - 1
      WHERE singleton_id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS track_routine_log_level_to_protected
    AFTER UPDATE OF level ON logs
    WHEN ${routineLevelSql('OLD.level')}
      AND ${protectedLevelSql('NEW.level')}
    BEGIN
      UPDATE log_retention_state
      SET routine_count = routine_count - 1
      WHERE singleton_id = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS track_routine_log_level_to_routine
    AFTER UPDATE OF level ON logs
    WHEN ${protectedLevelSql('OLD.level')}
      AND ${routineLevelSql('NEW.level')}
    BEGIN
      UPDATE log_retention_state
      SET routine_count = routine_count + 1
      WHERE singleton_id = 1;
    END;
  `);
}

export class RoutineLogRetentionInvariantError extends Error {
  constructor() {
    super(
      'Routine log retention state is missing its singleton row; reopen the database to repair it',
    );
    this.name = 'RoutineLogRetentionInvariantError';
  }
}

export interface RoutineLogPruneBatch {
  deleted: number;
  hadOverflow: boolean;
  filledBatch: boolean;
}

/**
 * Owns the complete count-based retention policy for routine log rows.
 * Warning/error classification, guard cadence, overflow selection, and the
 * bounded deletion statement live together so compatibility writes and the
 * background pruner cannot drift onto different retention rules.
 */
export class RoutineLogRetention {
  private writesSinceGuard = 0;

  constructor(
    private readonly db: Pick<Database.Database, 'prepare'>,
    private readonly rowCap: number,
    private readonly batchRows: number,
  ) {}

  noteCommittedInsert(level: string): void {
    if (!this.isRoutineLevel(level)) return;
    this.writesSinceGuard += 1;
    // Each guard removes at most one configured batch, so its cadence must
    // never admit more routine rows than that batch can remove.
    const guardInterval = Math.min(
      1_000,
      Math.max(1, this.rowCap),
      this.batchRows,
    );
    if (this.writesSinceGuard < guardInterval) return;
    this.writesSinceGuard = 0;
    try {
      this.pruneOverflowBatch();
    } catch {
      // The INSERT has already committed. Inline retention is therefore
      // best-effort: surfacing this maintenance failure would falsely report
      // the durable write as failed and invite duplicate retries. The
      // independent volume pruner will retry the same bounded cleanup later.
    }
  }

  hasOverflow(): boolean {
    return this.routineCount() > this.rowCap;
  }

  pruneOverflowBatch(): RoutineLogPruneBatch {
    const overflowRows = this.routineCount() - this.rowCap;
    if (overflowRows <= 0) {
      return { deleted: 0, hadOverflow: false, filledBatch: false };
    }
    const deleteRows = Math.min(this.batchRows, overflowRows);
    const deleted = this.db.prepare(`
      DELETE FROM logs
      WHERE id IN (
        SELECT id
        FROM logs
        WHERE ${routineLevelSql('level')}
        ORDER BY id ASC
        LIMIT @deleteRows
      )
    `).run({ deleteRows }).changes;
    return {
      deleted,
      hadOverflow: true,
      filledBatch: deleted === this.batchRows,
    };
  }

  private routineCount(): number {
    const row = this.db.prepare(`
      SELECT routine_count AS count
      FROM log_retention_state
      WHERE singleton_id = 1
    `).get() as { count: number } | undefined;
    if (!row) throw new RoutineLogRetentionInvariantError();
    return row.count;
  }

  private isRoutineLevel(level: string): boolean {
    return !protectedLogLevels.has(level);
  }
}
