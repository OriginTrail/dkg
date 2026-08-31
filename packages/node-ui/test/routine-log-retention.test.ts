import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  ROUTINE_LOG_PRUNE_SQL,
  ROUTINE_LOG_RETENTION_SCHEMA_VERSION,
  RoutineLogRetention,
  installRoutineLogRetentionSchema,
} from '../src/routine-log-retention.js';

function createLogsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      module TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);
}

function retentionState(db: Database.Database): {
  schema_version: number;
  routine_count: number;
} {
  return db.prepare(`
    SELECT schema_version, routine_count
    FROM log_retention_state
    WHERE singleton_id = 1
  `).get() as { schema_version: number; routine_count: number };
}

describe('RoutineLogRetention', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createLogsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('tracks every level transition and the production prune uses the partial index', () => {
    installRoutineLogRetentionSchema(db);
    const insert = db.prepare(
      `INSERT INTO logs (ts, level, module, message) VALUES (?, ?, 'test', ?)`,
    );
    insert.run(1, 'info', 'routine-a');
    insert.run(2, 'debug', 'routine-b');
    insert.run(3, 'warn', 'protected');
    expect(retentionState(db)).toEqual({
      schema_version: ROUTINE_LOG_RETENTION_SCHEMA_VERSION,
      routine_count: 2,
    });

    db.prepare(`UPDATE logs SET level = 'error' WHERE message = 'routine-a'`).run();
    db.prepare(`UPDATE logs SET level = 'info' WHERE message = 'protected'`).run();
    db.prepare(`DELETE FROM logs WHERE message = 'routine-b'`).run();
    expect(retentionState(db).routine_count).toBe(1);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${ROUTINE_LOG_PRUNE_SQL}`)
      .all({ deleteRows: 2 }) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('idx_logs_routine_id'))).toBe(true);

    const retention = new RoutineLogRetention(db, 0, 1);
    expect(retention.pruneOverflowBatch()).toEqual({
      deleted: 1,
      hadOverflow: true,
      filledBatch: true,
    });
    expect(db.prepare(`SELECT level, message FROM logs ORDER BY id`).all()).toEqual([
      { level: 'error', message: 'routine-a' },
    ]);
  });

  it('fails loudly on a missing singleton and repairs its count on reinstall', () => {
    installRoutineLogRetentionSchema(db);
    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (1, 'info', 'test', 'routine-row')
    `).run();
    db.exec('DELETE FROM log_retention_state WHERE singleton_id = 1');

    const retention = new RoutineLogRetention(db, 10, 2);
    expect(() => retention.hasOverflow()).toThrow(
      /retention state is missing its singleton row/,
    );

    installRoutineLogRetentionSchema(db);
    expect(retentionState(db).routine_count).toBe(1);
  });

  it('repairs stale same-name schema objects and reseeds possible counter drift', () => {
    installRoutineLogRetentionSchema(db);
    db.exec(`
      DROP TRIGGER track_routine_log_insert;
      CREATE TRIGGER track_routine_log_insert
      AFTER INSERT ON logs
      BEGIN
        UPDATE log_retention_state SET routine_count = routine_count;
      END;
      DROP INDEX idx_logs_routine_id;
      CREATE INDEX idx_logs_routine_id ON logs(level, id);
    `);
    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (1, 'info', 'test', 'untracked')
    `).run();
    expect(retentionState(db).routine_count).toBe(0);

    installRoutineLogRetentionSchema(db);
    expect(retentionState(db).routine_count).toBe(1);
    const definitions = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE name IN ('track_routine_log_insert', 'idx_logs_routine_id')
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    expect(definitions.find(({ name }) => name === 'track_routine_log_insert')?.sql)
      .toContain('routine_count = routine_count + 1');
    expect(definitions.find(({ name }) => name === 'idx_logs_routine_id')?.sql)
      .toContain("WHERE level NOT IN ('warn', 'error')");

    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (2, 'debug', 'test', 'tracked')
    `).run();
    expect(retentionState(db).routine_count).toBe(2);
  });

  it('repairs a missing current-version trigger and tracks subsequent writes', () => {
    installRoutineLogRetentionSchema(db);
    db.exec('DROP TRIGGER track_routine_log_insert');
    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (1, 'info', 'test', 'drifted')
    `).run();
    expect(retentionState(db).routine_count).toBe(0);

    installRoutineLogRetentionSchema(db);
    expect(retentionState(db).routine_count).toBe(1);
    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (2, 'debug', 'test', 'tracked')
    `).run();
    expect(retentionState(db).routine_count).toBe(2);
  });

  it('does not rescan logs when the installed versioned definitions are canonical', () => {
    installRoutineLogRetentionSchema(db);
    db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (1, 'info', 'test', 'already-tracked')
    `).run();
    let reseedStatements = 0;
    const observedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('SELECT 1, @schemaVersion, COUNT(*) FROM logs')) {
              reseedStatements += 1;
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    installRoutineLogRetentionSchema(observedDb);
    expect(reseedStatements).toBe(0);
    expect(retentionState(db).routine_count).toBe(1);
  });
});

describe('installRoutineLogRetentionSchema locking', () => {
  it('holds a write lock from before seeding until canonical triggers are active', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dkg-routine-retention-lock-'));
    const path = join(dir, 'retention.db');
    const installerConnection = new Database(path);
    const racingConnection = new Database(path);
    try {
      createLogsTable(installerConnection);
      racingConnection.pragma('busy_timeout = 0');
      let racingWriteBlocked = false;
      const installingDb = new Proxy(installerConnection, {
        get(target, property) {
          if (property === 'exec') {
            return (sql: string) => {
              const result = target.exec(sql);
              if (sql === 'BEGIN IMMEDIATE') {
                expect(() => racingConnection.prepare(`
                  INSERT INTO logs (ts, level, module, message)
                  VALUES (1, 'info', 'racer', 'blocked')
                `).run()).toThrow(/locked/);
                racingWriteBlocked = true;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      installRoutineLogRetentionSchema(installingDb);
      expect(racingWriteBlocked).toBe(true);

      racingConnection.prepare(`
        INSERT INTO logs (ts, level, module, message)
        VALUES (2, 'info', 'racer', 'tracked-after-commit')
      `).run();
      expect(retentionState(installerConnection).routine_count).toBe(1);
    } finally {
      racingConnection.close();
      installerConnection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
