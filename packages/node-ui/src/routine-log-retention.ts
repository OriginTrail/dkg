import type Database from 'better-sqlite3';

const PROTECTED_LOG_LEVELS = ['warn', 'error'] as const;
// Bump when the persisted index/trigger policy changes. Definition validation
// still repairs unexpected drift within a version (restores, dev databases).
export const ROUTINE_LOG_RETENTION_SCHEMA_VERSION = 1;
const protectedLogLevels = new Set<string>(PROTECTED_LOG_LEVELS);
const PROTECTED_LOG_LEVELS_SQL = PROTECTED_LOG_LEVELS
  .map((level) => `'${level.replaceAll("'", "''")}'`)
  .join(', ');
function routineLevelSql(column: string): string {
  return `${column} NOT IN (${PROTECTED_LOG_LEVELS_SQL})`;
}

function protectedLevelSql(column: string): string {
  return `${column} IN (${PROTECTED_LOG_LEVELS_SQL})`;
}

type RoutineLogRetentionSchemaDatabase = Pick<
  Database.Database,
  'exec' | 'prepare' | 'transaction'
>;

const ROUTINE_LOG_INDEX_NAME = 'idx_logs_routine_id';
const ROUTINE_LOG_INDEX_SQL = `
  CREATE INDEX ${ROUTINE_LOG_INDEX_NAME}
  ON logs(id) WHERE ${routineLevelSql('level')}
`;
const RETENTION_TRIGGER_DEFINITIONS = [
  {
    name: 'track_routine_log_insert',
    sql: `
      CREATE TRIGGER track_routine_log_insert
      AFTER INSERT ON logs
      WHEN ${routineLevelSql('NEW.level')}
      BEGIN
        UPDATE log_retention_state
        SET routine_count = routine_count + 1
        WHERE singleton_id = 1;
      END
    `,
  },
  {
    name: 'track_routine_log_delete',
    sql: `
      CREATE TRIGGER track_routine_log_delete
      AFTER DELETE ON logs
      WHEN ${routineLevelSql('OLD.level')}
      BEGIN
        UPDATE log_retention_state
        SET routine_count = routine_count - 1
        WHERE singleton_id = 1;
      END
    `,
  },
  {
    name: 'track_routine_log_level_to_protected',
    sql: `
      CREATE TRIGGER track_routine_log_level_to_protected
      AFTER UPDATE OF level ON logs
      WHEN ${routineLevelSql('OLD.level')}
        AND ${protectedLevelSql('NEW.level')}
      BEGIN
        UPDATE log_retention_state
        SET routine_count = routine_count - 1
        WHERE singleton_id = 1;
      END
    `,
  },
  {
    name: 'track_routine_log_level_to_routine',
    sql: `
      CREATE TRIGGER track_routine_log_level_to_routine
      AFTER UPDATE OF level ON logs
      WHEN ${protectedLevelSql('OLD.level')}
        AND ${routineLevelSql('NEW.level')}
      BEGIN
        UPDATE log_retention_state
        SET routine_count = routine_count + 1
        WHERE singleton_id = 1;
      END
    `,
  },
] as const;
const RETENTION_SCHEMA_DEFINITIONS = [
  { name: ROUTINE_LOG_INDEX_NAME, sql: ROUTINE_LOG_INDEX_SQL },
  ...RETENTION_TRIGGER_DEFINITIONS,
];

/** Exact production statement used for bounded oldest-row deletion. */
export const ROUTINE_LOG_PRUNE_SQL = `
  DELETE FROM logs
  WHERE id IN (
    SELECT id
    FROM logs
    WHERE ${routineLevelSql('level')}
    ORDER BY id ASC
    LIMIT @deleteRows
  )
`;

/**
 * Install or repair every SQLite adjunct owned by routine-log retention.
 * Missing state or triggers force a reseed from existing rows before triggers
 * are installed, so upgraded/restored databases regain an exact counter.
 */
export function installRoutineLogRetentionSchema(
  db: RoutineLogRetentionSchemaDatabase,
): void {
  const install = db.transaction(() => {
    const logsTable = db.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'logs'
    `).get() as { found: number } | undefined;
    if (!logsTable) return;

    const stateTable = db.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'table' AND name = 'log_retention_state'
    `).get() as { found: number } | undefined;
    const initialStateColumns = stateTable
      ? new Set(
        (db.prepare('PRAGMA table_info(log_retention_state)').all() as Array<{ name: string }>)
          .map(({ name }) => name),
      )
      : new Set<string>();
    const stateRow = initialStateColumns.has('schema_version')
      ? db.prepare(`
        SELECT schema_version FROM log_retention_state WHERE singleton_id = 1
      `).get() as { schema_version: number } | undefined
      : undefined;
    const canonicalSchema = hasCanonicalRetentionDefinitions(db);

    // Reopening a canonical database must not mutate the schema. In
    // particular, recreating the partial index scans every routine log row and
    // defeats the constant-time startup path this state table provides.
    if (
      stateRow?.schema_version === ROUTINE_LOG_RETENTION_SCHEMA_VERSION
      && canonicalSchema
    ) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS log_retention_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        routine_count INTEGER NOT NULL CHECK (routine_count >= 0)
      )
    `);
    if (!initialStateColumns.has('schema_version') && stateTable) {
      // Repairs databases created by an earlier development revision of V35.
      db.exec(`
        ALTER TABLE log_retention_state
        ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0
      `);
    }

    const repairedStateRow = db.prepare(`
      SELECT schema_version FROM log_retention_state WHERE singleton_id = 1
    `).get() as { schema_version: number } | undefined;
    const needsSchemaRepair = !canonicalSchema;
    const needsReseed = !repairedStateRow
      || repairedStateRow.schema_version !== ROUTINE_LOG_RETENTION_SCHEMA_VERSION
      || !canonicalSchema;

    if (needsSchemaRepair) {
      // Recreate every owned object from immutable versioned SQL only when
      // validation found drift. Rebuilding the partial index is intentionally
      // reserved for this repair path because it scans the logs table.
      db.exec([
        ...RETENTION_TRIGGER_DEFINITIONS.map(({ name }) => `DROP TRIGGER IF EXISTS ${name}`),
        `DROP INDEX IF EXISTS ${ROUTINE_LOG_INDEX_NAME}`,
        ROUTINE_LOG_INDEX_SQL,
        ...RETENTION_TRIGGER_DEFINITIONS.map(({ sql }) => sql),
      ].join(';\n'));
    }

    if (needsReseed) {
      db.prepare(`
        INSERT INTO log_retention_state(singleton_id, schema_version, routine_count)
        SELECT 1, @schemaVersion, COUNT(*) FROM logs
        WHERE ${routineLevelSql('level')}
        ON CONFLICT(singleton_id) DO UPDATE SET
          schema_version = excluded.schema_version,
          routine_count = excluded.routine_count
      `).run({ schemaVersion: ROUTINE_LOG_RETENTION_SCHEMA_VERSION });
    }
  });

  // IMMEDIATE acquires the write reservation before validation/counting.
  // Another connection can only commit after canonical triggers are active,
  // so no write can fall between the seed and its maintenance boundary.
  install.immediate();
}

function hasCanonicalRetentionDefinitions(db: RoutineLogRetentionSchemaDatabase): boolean {
  const names = RETENTION_SCHEMA_DEFINITIONS.map(({ name }) => name);
  const persisted = new Map(
    (db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE name IN (${names.map(() => '?').join(', ')})
    `).all(...names) as Array<{ name: string; sql: string | null }>)
      .map(({ name, sql }) => [name, normalizeSchemaSql(sql ?? '')]),
  );
  return RETENTION_SCHEMA_DEFINITIONS.every(({ name, sql }) => (
    persisted.get(name) === normalizeSchemaSql(sql)
  ));
}

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
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
  hasMore: boolean;
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
    private readonly db: Pick<Database.Database, 'prepare' | 'transaction'>,
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
    // Hold a write reservation from the counter read through deletion. Without
    // it, two connections can both observe the same overflow and the second
    // pruner can delete routine rows below the configured cap.
    return this.db.transaction(() => this.pruneOverflowBatchLocked()).immediate();
  }

  private pruneOverflowBatchLocked(): RoutineLogPruneBatch {
    const overflowRows = this.routineCount() - this.rowCap;
    if (overflowRows <= 0) {
      return { deleted: 0, hadOverflow: false, hasMore: false };
    }
    const deleteRows = Math.min(this.batchRows, overflowRows);
    const deleted = this.db.prepare(ROUTINE_LOG_PRUNE_SQL).run({ deleteRows }).changes;
    return {
      deleted,
      hadOverflow: true,
      hasMore: overflowRows > deleteRows,
    };
  }

  private routineCount(): number {
    const row = this.db.prepare(`
      SELECT routine_count AS count
      FROM log_retention_state
      WHERE singleton_id = 1 AND schema_version = ?
    `).get(ROUTINE_LOG_RETENTION_SCHEMA_VERSION) as { count: number } | undefined;
    if (!row) throw new RoutineLogRetentionInvariantError();
    return row.count;
  }

  private isRoutineLevel(level: string): boolean {
    return !protectedLogLevels.has(level);
  }
}
