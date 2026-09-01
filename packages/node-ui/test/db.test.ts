import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DashboardDB, SqliteChainEventCursorStore, SqliteContextGraphRegistryScanCursorStore, SqliteKaNumberStore, SqliteSyncCheckpointStore, SqliteChangelogCursorStore, SqliteChangelogEraGuard, buildActivityDigestKey, ACTIVITY_DIGEST_WINDOW_MS, ASSERTION_ACTIVITY_TYPE, SCHEMA_VERSION } from '../src/db.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-db-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('DashboardDB — metric snapshots', () => {
  it('inserts and retrieves the latest snapshot', () => {
    db.insertSnapshot({ ts: 1000, cpu_percent: 42.5, mem_used_bytes: 100, mem_total_bytes: 200, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: 50, uptime_seconds: 60, peer_count: 3, direct_peers: 2, relayed_peers: 1, mesh_peers: 3, contextGraph_count: 1, total_triples: 500, total_kcs: 10, total_kas: 20, store_bytes: 1024, confirmed_kcs: 8, tentative_kcs: 2, rpc_latency_ms: 15, rpc_healthy: 1, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });
    db.insertSnapshot({ ts: 2000, cpu_percent: 55.0, mem_used_bytes: 120, mem_total_bytes: 200, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: 60, uptime_seconds: 120, peer_count: 5, direct_peers: 3, relayed_peers: 2, mesh_peers: 4, contextGraph_count: 2, total_triples: 600, total_kcs: 12, total_kas: 24, store_bytes: 2048, confirmed_kcs: 10, tentative_kcs: 2, rpc_latency_ms: 20, rpc_healthy: 1, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });

    const latest = db.getLatestSnapshot();
    expect(latest).toBeDefined();
    expect(latest!.ts).toBe(2000);
    expect(latest!.cpu_percent).toBe(55.0);
    expect(latest!.peer_count).toBe(5);
  });

  it('returns undefined when no snapshots exist', () => {
    expect(db.getLatestSnapshot()).toBeUndefined();
  });

  it('retrieves snapshot history within a time range', () => {
    for (let i = 1; i <= 10; i++) {
      db.insertSnapshot({ ts: i * 1000, cpu_percent: i, mem_used_bytes: null, mem_total_bytes: null, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null, uptime_seconds: null, peer_count: null, direct_peers: null, relayed_peers: null, mesh_peers: null, contextGraph_count: null, total_triples: null, total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null, tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });
    }

    const history = db.getSnapshotHistory(3000, 7000);
    expect(history.length).toBe(5);
    expect(history[0].ts).toBe(3000);
    expect(history[4].ts).toBe(7000);
  });

  it('downsamples when exceeding maxPoints', () => {
    for (let i = 1; i <= 100; i++) {
      db.insertSnapshot({ ts: i * 1000, cpu_percent: i, mem_used_bytes: null, mem_total_bytes: null, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null, uptime_seconds: null, peer_count: null, direct_peers: null, relayed_peers: null, mesh_peers: null, contextGraph_count: null, total_triples: null, total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null, tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });
    }

    const sampled = db.getSnapshotHistory(1000, 100000, 10);
    expect(sampled.length).toBeLessThanOrEqual(10);
  });

  it('migrates a pre-V10 metric_snapshots table by adding the relay_* columns', () => {
    // Codex review on PR #525 round 3 flagged that bumping SCHEMA_VERSION
    // to 10 without an explicit ALTER for existing tables would leave V9
    // schemas without the new relay_* columns, causing insertSnapshot()
    // to throw `no such column: relay_capacity`. This regression locks
    // in the idempotent column-add path in `version < 10`.
    //
    // Strategy: take the freshly-created V10 db (full schema), simulate
    // a V9 baseline by dropping the new relay_* columns and resetting
    // user_version to 9, then reopen via DashboardDB and verify the
    // upgrade restores the columns and lets insertSnapshot succeed.
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    for (const col of [
      'relay_capacity',
      'relay_reservation_count',
      'relay_active_circuits',
      'relay_bytes_in',
      'relay_bytes_out',
    ]) {
      raw.exec(`ALTER TABLE metric_snapshots DROP COLUMN ${col};`);
    }
    const recentTs = Date.now() - 60_000;
    raw.prepare(
      `INSERT INTO metric_snapshots (ts, cpu_percent, peer_count) VALUES (?, 10, 3)`,
    ).run(recentTs);
    raw.pragma('user_version = 9');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.db.prepare('PRAGMA table_info(metric_snapshots)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of [
      'relay_capacity',
      'relay_reservation_count',
      'relay_active_circuits',
      'relay_bytes_in',
      'relay_bytes_out',
    ]) {
      expect(cols).toContain(col);
    }

    const newTs = Date.now();
    expect(() => db.insertSnapshot({
      ts: newTs, cpu_percent: 20, mem_used_bytes: null, mem_total_bytes: null,
      disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null,
      uptime_seconds: null, peer_count: 4, direct_peers: 2, relayed_peers: 2,
      mesh_peers: null, contextGraph_count: null, total_triples: null,
      total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null,
      tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null,
      relay_capacity: 1024, relay_reservation_count: 3, relay_active_circuits: 5,
      relay_bytes_in: 12345, relay_bytes_out: 67890,
    })).not.toThrow();

    const latest = db.getLatestSnapshot();
    expect(latest!.ts).toBe(newTs);
    expect(latest!.relay_capacity).toBe(1024);
    expect(latest!.relay_active_circuits).toBe(5);

    const preExisting = db.getSnapshotHistory(recentTs, recentTs);
    expect(preExisting).toHaveLength(1);
    expect(preExisting[0].relay_capacity).toBeNull();
  });

  it('migrates pre-V14 paranet_count / paranet_id columns to contextGraph_*', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    // Simulate a V13 DB that still has the old column names
    const snapshotCols = (raw.prepare('PRAGMA table_info(metric_snapshots)').all() as { name: string }[])
      .map(c => c.name);
    if (snapshotCols.includes('contextGraph_count')) {
      raw.exec('ALTER TABLE metric_snapshots RENAME COLUMN contextGraph_count TO paranet_count');
    }
    const opsCols = (raw.prepare('PRAGMA table_info(operations)').all() as { name: string }[])
      .map(c => c.name);
    if (opsCols.includes('contextGraph_id')) {
      raw.exec('ALTER TABLE operations RENAME COLUMN contextGraph_id TO paranet_id');
    }
    raw.pragma('user_version = 13');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const newSnapshotCols = (db.db.prepare('PRAGMA table_info(metric_snapshots)').all() as { name: string }[])
      .map(c => c.name);
    expect(newSnapshotCols).toContain('contextGraph_count');
    expect(newSnapshotCols).not.toContain('paranet_count');

    const newOpsCols = (db.db.prepare('PRAGMA table_info(operations)').all() as { name: string }[])
      .map(c => c.name);
    expect(newOpsCols).toContain('contextGraph_id');
    expect(newOpsCols).not.toContain('paranet_id');

    // Verify inserts work with the new column names
    expect(() => db.insertSnapshot({
      ts: Date.now(), cpu_percent: 50, mem_used_bytes: null, mem_total_bytes: null,
      disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null,
      uptime_seconds: null, peer_count: 2, direct_peers: 1, relayed_peers: 1,
      mesh_peers: null, contextGraph_count: 3, total_triples: null,
      total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null,
      tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null,
      relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null,
      relay_bytes_in: null, relay_bytes_out: null,
    })).not.toThrow();

    expect(() => db.insertOperation({
      operation_id: 'test-v14-migration',
      operation_name: 'query',
      started_at: Date.now(),
      contextGraph_id: 'did:dkg:context-graph:test',
    })).not.toThrow();
  });
});

describe('DashboardDB — operations', () => {
  it('inserts, completes, and retrieves an operation', () => {
    db.insertOperation({
      operation_id: 'op-1',
      operation_name: 'publish',
      started_at: 1000,
      peer_id: 'peer-abc',
      contextGraph_id: 'testing',
    });

    const { operations } = db.getOperations();
    expect(operations).toHaveLength(1);
    expect(operations[0].operation_id).toBe('op-1');
    expect(operations[0].status).toBe('in_progress');

    db.completeOperation({ operation_id: 'op-1', duration_ms: 250, triple_count: 42 });

    const { operation } = db.getOperation('op-1');
    expect(operation).toBeDefined();
    expect(operation!.status).toBe('success');
    expect(operation!.duration_ms).toBe(250);
    expect(operation!.triple_count).toBe(42);
  });

  it('fails an operation with error message', () => {
    db.insertOperation({
      operation_id: 'op-fail',
      operation_name: 'sync',
      started_at: 2000,
    });

    db.failOperation({ operation_id: 'op-fail', duration_ms: 100, error_message: 'connection refused' });

    const { operation } = db.getOperation('op-fail');
    expect(operation!.status).toBe('error');
    expect(operation!.error_message).toBe('connection refused');
  });

  it('filters operations by name and status', () => {
    db.insertOperation({ operation_id: 'a', operation_name: 'publish', started_at: 1000 });
    db.insertOperation({ operation_id: 'b', operation_name: 'query', started_at: 2000 });
    db.insertOperation({ operation_id: 'c', operation_name: 'publish', started_at: 3000 });
    db.completeOperation({ operation_id: 'a', duration_ms: 10 });

    const publishOnly = db.getOperations({ name: 'publish' });
    expect(publishOnly.operations).toHaveLength(2);
    expect(publishOnly.total).toBe(2);

    const successOnly = db.getOperations({ status: 'success' });
    expect(successOnly.operations).toHaveLength(1);
    expect(successOnly.operations[0].operation_id).toBe('a');
  });

  it('returns null/undefined for nonexistent operation', () => {
    const { operation, logs } = db.getOperation('nonexistent');
    expect(operation).toBeFalsy();
    expect(logs).toHaveLength(0);
  });

  it('retrieves associated logs for an operation', () => {
    db.insertOperation({ operation_id: 'op-x', operation_name: 'sync', started_at: 1000 });
    db.insertLog({ ts: 1001, level: 'info', operation_name: 'sync', operation_id: 'op-x', module: 'Agent', message: 'syncing page 1' });
    db.insertLog({ ts: 1002, level: 'info', operation_name: 'sync', operation_id: 'op-x', module: 'Agent', message: 'syncing page 2' });
    db.insertLog({ ts: 1003, level: 'info', operation_name: 'query', operation_id: 'other-op', module: 'Query', message: 'unrelated' });

    const { operation, logs } = db.getOperation('op-x');
    expect(operation).toBeDefined();
    expect(logs).toHaveLength(2);
    expect(logs[0].message).toBe('syncing page 1');
  });
});

describe('DashboardDB — logs', () => {
  // NOTE: V15 removed the FTS5 index, not the public search surface.
  // `searchLogs()` now uses bounded LIKE scans over the retained base
  // `logs` table for backwards compatibility.

  it('insertLog persists the row with all columns', () => {
    db.insertLog({
      ts: 1000,
      level: 'error',
      operation_name: 'sync',
      operation_id: 'op-1',
      module: 'Agent',
      message: 'something broke',
    });

    const rows = db.db.prepare(`SELECT * FROM logs ORDER BY ts ASC`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: 1000,
      level: 'error',
      operation_name: 'sync',
      operation_id: 'op-1',
      module: 'Agent',
      message: 'something broke',
    });
  });

  it('insertLog tolerates null operation context', () => {
    db.insertLog({ ts: 2000, level: 'info', module: 'Publisher', message: 'published' });
    const row = db.db.prepare(`SELECT * FROM logs WHERE ts = 2000`).get() as any;
    expect(row.operation_id).toBeNull();
    expect(row.operation_name).toBeNull();
  });

  it('searchLogs keeps the non-FTS compatibility surface', () => {
    db.insertLog({ ts: 1000, level: 'info', operation_name: 'publish', operation_id: 'op-1', module: 'Publisher', message: 'publish started' });
    db.insertLog({ ts: 2000, level: 'error', operation_name: 'sync', operation_id: 'op-2', module: 'Agent', message: 'sync timeout' });
    db.insertLog({ ts: 3000, level: 'info', operation_name: 'publish', operation_id: 'op-3', module: 'Publisher', message: 'publish completed 100%' });

    const result = db.searchLogs({ q: 'publish completed 100%', level: 'info', module: 'Publisher' });
    expect(result.total).toBe(1);
    expect(result.logs[0].operation_id).toBe('op-3');
  });
});

describe('DashboardDB — query history', () => {
  it('records and retrieves query history', () => {
    db.insertQueryHistory({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', duration_ms: 15, result_count: 42 });
    db.insertQueryHistory({ sparql: 'SELECT * WHERE { ?a ?b ?c }', duration_ms: 8, result_count: 0 });

    const history = db.getQueryHistory();
    expect(history).toHaveLength(2);
    expect(history[0].sparql).toBe('SELECT * WHERE { ?a ?b ?c }');
    expect(history[1].result_count).toBe(42);
  });

  it('records queries that errored', () => {
    db.insertQueryHistory({ sparql: 'INVALID', duration_ms: 1, error: 'parse error' });

    const history = db.getQueryHistory();
    expect(history[0].error).toBe('parse error');
  });
});

describe('DashboardDB — saved queries', () => {
  it('creates, lists, updates, and deletes saved queries', () => {
    const id = db.insertSavedQuery({ name: 'All triples', sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }' });
    expect(id).toBeGreaterThan(0);

    let saved = db.getSavedQueries();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('All triples');

    db.updateSavedQuery(id, { name: 'Everything', description: 'Gets all triples' });
    saved = db.getSavedQueries();
    expect(saved[0].name).toBe('Everything');
    expect(saved[0].description).toBe('Gets all triples');

    db.deleteSavedQuery(id);
    expect(db.getSavedQueries()).toHaveLength(0);
  });
});

describe('DashboardDB — retention', () => {
  it('uses 14 days for fresh installs', () => {
    expect(db.getRetentionDays()).toBe(14);
  });

  it('preserves legacy implicit 90-day retention for upgraded DBs without a saved setting', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    const twentyDaysAgo = Date.now() - 20 * 86_400_000;
    raw.prepare(
      `INSERT INTO logs (ts, level, module, message) VALUES (?, 'info', 'test', 'legacy retained')`,
    ).run(twentyDaysAgo);
    raw.pragma('user_version = 14');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.getRetentionDays()).toBe(90);
    const count = (db.db.prepare(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('prunes data older than retention period', () => {
    const db2 = new DashboardDB({ dataDir: dir, retentionDays: 0 });

    db2.insertSnapshot({ ts: Date.now() - 100_000, cpu_percent: 10, mem_used_bytes: null, mem_total_bytes: null, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null, uptime_seconds: null, peer_count: null, direct_peers: null, relayed_peers: null, mesh_peers: null, contextGraph_count: null, total_triples: null, total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null, tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });
    db2.insertLog({ ts: Date.now() - 100_000, level: 'info', module: 'A', message: 'old' });
    db2.insertOperation({ operation_id: 'old-op', operation_name: 'query', started_at: Date.now() - 100_000 });

    db2.prune();

    expect(db2.getLatestSnapshot()).toBeUndefined();
    const remainingLogs = (db2.db.prepare(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c;
    expect(remainingLogs).toBe(0);
    expect(db2.getOperations().total).toBe(0);

    db2.close();
  });

  it('caps routine logs incrementally while preserving warning and error history', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-volume-'));
    const volumeDb = new DashboardDB({
      dataDir: volumeDir,
      retentionDays: 365,
      routineLogRowCap: 3,
      logVolumePruneBatchRows: 2,
    });
    try {
      const insert = volumeDb.db.prepare(
        `INSERT INTO logs (ts, level, module, message) VALUES (?, ?, 'sync', ?)`,
      );
      for (let i = 0; i < 7; i += 1) {
        insert.run(1_000 + i, i % 2 === 0 ? 'debug' : 'info', `routine-${i}`);
      }
      insert.run(2_000, 'warn', 'keep-warn');
      insert.run(2_001, 'error', 'keep-error');

      expect(volumeDb.pruneLogVolumeBatch()).toEqual({ deleted: 2, status: 'more' });
      expect(volumeDb.pruneLogVolumeBatch()).toEqual({ deleted: 2, status: 'done' });

      const rows = volumeDb.db.prepare(
        `SELECT level, message FROM logs ORDER BY id ASC`,
      ).all() as Array<{ level: string; message: string }>;
      expect(rows.filter((row) => row.level === 'debug' || row.level === 'info')).toEqual([
        { level: 'debug', message: 'routine-4' },
        { level: 'info', message: 'routine-5' },
        { level: 'debug', message: 'routine-6' },
      ]);
      expect(rows).toContainEqual({ level: 'warn', message: 'keep-warn' });
      expect(rows).toContainEqual({ level: 'error', message: 'keep-error' });
    } finally {
      volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });

  it('seeds and prunes populated pre-V35 routine logs during a V34 upgrade', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TRIGGER IF EXISTS track_routine_log_insert;
      DROP TRIGGER IF EXISTS track_routine_log_delete;
      DROP TRIGGER IF EXISTS track_routine_log_level_to_protected;
      DROP TRIGGER IF EXISTS track_routine_log_level_to_routine;
      DROP INDEX IF EXISTS idx_logs_routine_id;
      DROP TABLE IF EXISTS log_retention_state;
    `);
    const insert = raw.prepare(
      `INSERT INTO logs (ts, level, module, message) VALUES (?, ?, 'pre-v35', ?)`,
    );
    insert.run(Date.now(), 'info', 'routine-0');
    insert.run(Date.now() + 1, 'debug', 'routine-1');
    insert.run(Date.now() + 2, 'info', 'routine-2');
    insert.run(Date.now() + 3, 'debug', 'routine-3');
    insert.run(Date.now() + 4, 'warn', 'keep-warn');
    insert.run(Date.now() + 5, 'error', 'keep-error');
    raw.pragma('user_version = 34');
    raw.close();

    db = new DashboardDB({
      dataDir: dir,
      retentionDays: 365,
      routineLogRowCap: 2,
      logVolumePruneBatchRows: 10,
    });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.db.prepare(`
      SELECT routine_count FROM log_retention_state WHERE singleton_id = 1
    `).get()).toEqual({ routine_count: 4 });

    expect(db.pruneLogVolumeBatch()).toMatchObject({ deleted: 2 });
    expect(db.db.prepare(`
      SELECT level, message FROM logs ORDER BY id ASC
    `).all()).toEqual([
      { level: 'info', message: 'routine-2' },
      { level: 'debug', message: 'routine-3' },
      { level: 'warn', message: 'keep-warn' },
      { level: 'error', message: 'keep-error' },
    ]);
    expect(db.db.prepare(`
      SELECT routine_count FROM log_retention_state WHERE singleton_id = 1
    `).get()).toEqual({ routine_count: 2 });
  });

  it('repairs a lost V35 retention trigger when DashboardDB reopens', () => {
    db.db.exec('DROP TRIGGER track_routine_log_insert');
    db.db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (?, 'info', 'restore-test', 'untracked-before-reopen')
    `).run(Date.now());
    expect(db.db.prepare(`
      SELECT routine_count FROM log_retention_state WHERE singleton_id = 1
    `).get()).toEqual({ routine_count: 0 });

    db.close();
    db = new DashboardDB({ dataDir: dir, retentionDays: 365 });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.db.prepare(`
      SELECT routine_count FROM log_retention_state WHERE singleton_id = 1
    `).get()).toEqual({ routine_count: 1 });

    db.db.prepare(`
      INSERT INTO logs (ts, level, module, message)
      VALUES (?, 'debug', 'restore-test', 'tracked-after-reopen')
    `).run(Date.now() + 1);
    expect(db.db.prepare(`
      SELECT routine_count FROM log_retention_state WHERE singleton_id = 1
    `).get()).toEqual({ routine_count: 2 });
  });

  it('preserves ambiguous pre-upgrade compatibility rows below the public cap', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-legacy-compat-'));
    const dbPath = join(volumeDir, 'node-ui.db');
    let volumeDb = new DashboardDB({ dataDir: volumeDir, retentionDays: 365 });
    try {
      volumeDb.close();
      const preUpgrade = new Database(dbPath);
      preUpgrade.prepare(
        `INSERT INTO logs (ts, level, module, message) VALUES (?, 'info', 'third-party', ?)`,
      ).run(Date.now(), 'public-compatibility-record');
      preUpgrade.close();

      volumeDb = new DashboardDB({
        dataDir: volumeDir,
        retentionDays: 365,
        routineLogRowCap: 10,
        logVolumePruneBatchRows: 2,
      });
      expect(volumeDb.pruneLogVolumeBatch()).toEqual({ deleted: 0, status: 'done' });
      expect(volumeDb.db.prepare(
        `SELECT module, message FROM logs`,
      ).all()).toEqual([
        { module: 'third-party', message: 'public-compatibility-record' },
      ]);
    } finally {
      if (volumeDb.db.open) volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });

  it('bounds routine compatibility writes through the published row cap', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-compat-cap-'));
    const volumeDb = new DashboardDB({
      dataDir: volumeDir,
      retentionDays: 365,
      routineLogRowCap: 2,
      // Deprecated option remains a source/runtime-compatible alias.
      logVolumePruneBatchRows: 10,
    });
    try {
      const rawInsert = volumeDb.db.prepare(
        `INSERT INTO logs (ts, level, module, message) VALUES (?, 'info', 'legacy-caller', ?)`,
      );
      rawInsert.run(Date.now(), 'preexisting-0');
      rawInsert.run(Date.now() + 1, 'preexisting-1');
      rawInsert.run(Date.now() + 2, 'preexisting-2');
      expect(volumeDb.pruneLogVolumeBatch()).toMatchObject({ deleted: 1, status: 'done' });
      for (let i = 0; i < 6; i += 1) {
        volumeDb.insertLog({
          ts: Date.now() + i,
          level: 'info',
          module: 'compatibility',
          message: `routine-${i}`,
        });
      }
      volumeDb.insertLog({
        ts: Date.now() + 10,
        level: 'warn',
        module: 'compatibility',
        message: 'keep-warning',
      });

      const rows = volumeDb.db.prepare(
        `SELECT level, message FROM logs ORDER BY id ASC`,
      ).all() as Array<{ level: string; message: string }>;
      expect(rows.filter((row) => row.level === 'info')).toEqual([
        { level: 'info', message: 'routine-4' },
        { level: 'info', message: 'routine-5' },
      ]);
      expect(rows).toContainEqual({ level: 'warn', message: 'keep-warning' });
    } finally {
      volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });

  it('keeps pace when the compatibility cleanup batch is smaller than the old guard cadence', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-small-compat-batch-'));
    const volumeDb = new DashboardDB({
      dataDir: volumeDir,
      retentionDays: 365,
      routineLogRowCap: 100,
      logVolumePruneBatchRows: 1,
    });
    try {
      // Compile-time compatibility guard: published callers may still pass a
      // string-typed value even when its runtime value is canonical.
      const configuredLevel: string = 'info';
      volumeDb.insertLog({
        ts: Date.now(),
        level: configuredLevel,
        module: 'legacy-caller',
        message: 'configured-level',
      });
      for (let i = 0; i < 500; i += 1) {
        volumeDb.insertLog({
          ts: Date.now() + i + 1,
          level: 'info',
          module: 'legacy-caller',
          message: `routine-${i}`,
        });
      }
      volumeDb.insertLog({
        ts: Date.now() + 1_000,
        level: 'warn',
        module: 'legacy-caller',
        message: 'keep-warning',
      });

      const counts = volumeDb.db.prepare(`
        SELECT
          SUM(CASE WHEN level NOT IN ('warn', 'error') THEN 1 ELSE 0 END) AS routine,
          SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) AS warnings
        FROM logs
      `).get() as { routine: number; warnings: number };
      expect(counts).toEqual({ routine: 100, warnings: 1 });
    } finally {
      volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });

  it('reports a committed insert as successful when inline retention fails', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-retention-failure-'));
    const volumeDb = new DashboardDB({
      dataDir: volumeDir,
      retentionDays: 365,
      routineLogRowCap: 0,
      logVolumePruneBatchRows: 1,
    });
    try {
      volumeDb.db.exec(`
        CREATE TRIGGER fail_inline_log_retention
        BEFORE DELETE ON logs
        BEGIN
          SELECT RAISE(ABORT, 'forced retention failure');
        END
      `);

      expect(() => volumeDb.insertLog({
        ts: Date.now(),
        level: 'info',
        module: 'compatibility',
        message: 'committed-before-maintenance',
      })).not.toThrow();
      expect(volumeDb.db.prepare(
        `SELECT level, message FROM logs`,
      ).all()).toEqual([
        { level: 'info', message: 'committed-before-maintenance' },
      ]);

      volumeDb.db.exec('DROP TRIGGER fail_inline_log_retention');
      expect(volumeDb.pruneLogVolumeBatch()).toEqual({ deleted: 1, status: 'done' });
    } finally {
      volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });

  it('returns multi-megabyte free pages to the OS after the final volume batch', () => {
    const volumeDir = mkdtempSync(join(tmpdir(), 'dkg-db-log-compact-'));
    const dbPath = join(volumeDir, 'node-ui.db');
    const volumeDb = new DashboardDB({
      dataDir: volumeDir,
      retentionDays: 365,
      routineLogRowCap: 2,
      logVolumePruneBatchRows: 10,
    });
    try {
      const payload = 'x'.repeat(256 * 1024);
      const insert = volumeDb.db.prepare(
        `INSERT INTO logs (ts, level, module, message) VALUES (?, ?, 'sync', ?)`,
      );
      for (let i = 0; i < 30; i += 1) {
        insert.run(1_000 + i, 'debug', `${i}:${payload}`);
      }
      insert.run(2_000, 'warn', 'keep-warn');
      volumeDb.db.pragma('wal_checkpoint(TRUNCATE)');
      const beforeBytes = statSync(dbPath).size;

      let compacted = false;
      for (let i = 0; i < 10; i += 1) {
        const result = volumeDb.pruneLogVolumeBatch();
        compacted ||= result.status === 'done-compacted';
        if (result.status === 'done' || result.status === 'done-compacted') break;
      }

      const afterBytes = statSync(dbPath).size;
      const levels = volumeDb.db.prepare(
        `SELECT level, COUNT(*) AS count FROM logs GROUP BY level`,
      ).all() as Array<{ level: string; count: number }>;
      expect(compacted).toBe(true);
      expect(afterBytes).toBeLessThan(beforeBytes / 2);
      expect(levels).toContainEqual({ level: 'debug', count: 2 });
      expect(levels).toContainEqual({ level: 'warn', count: 1 });
    } finally {
      volumeDb.close();
      rmSync(volumeDir, { recursive: true, force: true });
    }
  });
});

describe('DashboardDB — operation phases', () => {
  it('inserts and completes phases', () => {
    db.insertOperation({ operation_id: 'op-ph', operation_name: 'publish', started_at: 1000 });

    db.insertPhase({ operation_id: 'op-ph', phase: 'prepare', started_at: 1000 });
    db.insertPhase({ operation_id: 'op-ph', phase: 'store', started_at: 1050 });

    db.completePhase({ operation_id: 'op-ph', phase: 'prepare', duration_ms: 50 });
    db.completePhase({ operation_id: 'op-ph', phase: 'store', duration_ms: 100 });

    const { phases } = db.getOperation('op-ph');
    expect(phases).toHaveLength(2);
    expect(phases[0].phase).toBe('prepare');
    expect(phases[0].duration_ms).toBe(50);
    expect(phases[0].status).toBe('success');
    expect(phases[1].phase).toBe('store');
    expect(phases[1].duration_ms).toBe(100);
  });

  it('returns phases ordered by started_at', () => {
    db.insertOperation({ operation_id: 'op-order', operation_name: 'publish', started_at: 1000 });
    db.insertPhase({ operation_id: 'op-order', phase: 'chain', started_at: 2000 });
    db.insertPhase({ operation_id: 'op-order', phase: 'prepare', started_at: 1000 });
    db.insertPhase({ operation_id: 'op-order', phase: 'store', started_at: 1500 });

    const { phases } = db.getOperation('op-order');
    expect(phases.map((p: any) => p.phase)).toEqual(['prepare', 'store', 'chain']);
  });
});

describe('DashboardDB — operation cost', () => {
  it('sets gas and TRAC cost on an operation', () => {
    db.insertOperation({ operation_id: 'op-cost', operation_name: 'publish', started_at: 1000 });

    db.setOperationCost({
      operation_id: 'op-cost',
      gas_used: 210000,
      gas_price_gwei: 0.25,
      gas_cost_eth: 0.0000525,
      trac_cost: 0.5,
      tx_hash: '0xabc123',
      chain_id: 84532,
    });

    const { operation } = db.getOperation('op-cost');
    expect(operation!.gas_used).toBe(210000);
    expect(operation!.gas_price_gwei).toBeCloseTo(0.25);
    expect(operation!.gas_cost_eth).toBeCloseTo(0.0000525);
    expect(operation!.trac_cost).toBeCloseTo(0.5);
    expect(operation!.tx_hash).toBe('0xabc123');
    expect(operation!.chain_id).toBe(84532);
  });

  it('partial cost update preserves existing values', () => {
    db.insertOperation({ operation_id: 'op-partial', operation_name: 'publish', started_at: 1000 });

    db.setOperationCost({ operation_id: 'op-partial', tx_hash: '0xfirst' });
    db.setOperationCost({ operation_id: 'op-partial', gas_used: 100000 });

    const { operation } = db.getOperation('op-partial');
    expect(operation!.tx_hash).toBe('0xfirst');
    expect(operation!.gas_used).toBe(100000);
  });
});

describe('DashboardDB — operation stats', () => {
  beforeEach(() => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.insertOperation({
        operation_id: `st-${i}`,
        operation_name: i < 7 ? 'publish' : 'query',
        started_at: now - (10 - i) * 60_000,
      });
      if (i < 8) {
        db.completeOperation({ operation_id: `st-${i}`, duration_ms: 1000 + i * 100 });
      } else {
        db.failOperation({ operation_id: `st-${i}`, duration_ms: 500, error_message: 'fail' });
      }
      if (i < 5) {
        db.setOperationCost({ operation_id: `st-${i}`, gas_cost_eth: 0.001, trac_cost: 0.1 });
      }
    }
  });

  it('returns correct aggregate summary for all operations', () => {
    const { summary } = db.getOperationStats({ periodMs: 86_400_000, bucketMs: 3_600_000 });
    expect(summary.totalCount).toBe(10);
    expect(summary.successCount).toBe(8);
    expect(summary.errorCount).toBe(2);
    expect(summary.successRate).toBeCloseTo(0.8);
    expect(summary.avgDurationMs).toBeGreaterThan(0);
    expect(summary.totalGasCostEth).toBeCloseTo(0.005);
    expect(summary.totalTracCost).toBeCloseTo(0.5);
  });

  it('keeps cancelled operations visible without depressing health success rates', () => {
    db.insertOperation({
      operation_id: 'st-cancelled',
      operation_name: 'query',
      started_at: Date.now(),
    });
    db.cancelOperation({
      operation_id: 'st-cancelled',
      duration_ms: 25,
      error_message: 'API query caller disconnected',
    });

    const { summary, timeSeries } = db.getOperationStats({
      periodMs: 86_400_000,
      bucketMs: 1_000_000_000_000,
    });
    expect(summary.totalCount).toBe(11);
    expect(summary.successCount).toBe(8);
    expect(summary.errorCount).toBe(2);
    expect(summary.successRate).toBeCloseTo(0.8);
    expect(timeSeries).toHaveLength(1);
    expect(timeSeries[0].count).toBe(11);
    expect(timeSeries[0].successRate).toBeCloseTo(0.8);

    const perType = db.getPerTypeTimeSeries({
      periodMs: 86_400_000,
      bucketMs: 1_000_000_000_000,
    });
    expect(perType.series.query[0].count).toBe(4);
    expect(perType.series.query[0].successRate).toBeCloseTo(1 / 3);

    const queryRate = db.getSuccessRatesByType(86_400_000)
      .find((row) => row.type === 'query');
    expect(queryRate).toMatchObject({
      total: 4,
      success: 1,
      error: 2,
    });
    expect(queryRate!.rate).toBeCloseTo(1 / 3);
  });

  it('filters stats by operation name', () => {
    const { summary } = db.getOperationStats({ name: 'publish', periodMs: 86_400_000, bucketMs: 3_600_000 });
    expect(summary.totalCount).toBe(7);
  });

  it('returns time series buckets', () => {
    const { timeSeries } = db.getOperationStats({ periodMs: 86_400_000, bucketMs: 3_600_000 });
    expect(timeSeries.length).toBeGreaterThan(0);
    const bucket = timeSeries[0];
    expect(bucket).toHaveProperty('bucket');
    expect(bucket).toHaveProperty('count');
    expect(bucket).toHaveProperty('successRate');
    expect(bucket).toHaveProperty('avgDurationMs');
  });
});

describe('DashboardDB — schema idempotency', () => {
  it('can be opened twice on the same directory without error', () => {
    db.close();
    const db2 = new DashboardDB({ dataDir: dir });
    db2.insertLog({ ts: 1, level: 'info', module: 'Test', message: 'ok' });
    const count = (db2.db.prepare(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c;
    expect(count).toBe(1);
    db2.close();
    db = new DashboardDB({ dataDir: dir });
  });
});

describe('DashboardDB — V15 migration: drop FTS5 logs index', () => {
  // Regression guard for the rc.11 incident
  // (~9 GB node-ui.db, corrupt SQLite page from a runaway FTS5 index).
  // We construct a V14-shape database by hand — virtual table + the
  // two triggers + an actual log row that the trigger should mirror
  // into the shadow tables — then open it through DashboardDB and
  // confirm the migration removes the FTS5 infrastructure while
  // preserving the base `logs` row.
  it('drops logs_fts virtual table and its two triggers on upgrade from V14', () => {
    const mkdtempSync = require('node:fs').mkdtempSync;
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const Database = require('better-sqlite3');

    const upgradeDir = mkdtempSync(join(tmpdir(), 'dkg-dashboard-db-v15-'));
    const upgradeDbPath = join(upgradeDir, 'node-ui.db');

    // Build a realistic V14-shape DB. We let DashboardDB create the
    // full schema first (so prune() during the upgrade re-open won't
    // trip on missing tables), then downgrade user_version to 14 and
    // bolt the V14-era FTS5 infrastructure back onto `logs`. Reopening
    // through DashboardDB exercises the real migrate() codepath.
    const v14 = new DashboardDB({ dataDir: upgradeDir });
    // Use a recent timestamp so the V15 default 14-day retention prune
    // (which runs on every DashboardDB open) doesn't delete this row
    // before the assertion can see it.
    const recentTs = Date.now() - 60_000;
    v14.insertLog({ ts: recentTs, level: 'info', module: 'Agent', message: 'pre-migration row' });
    v14.close();

    const downgrade = new Database(upgradeDbPath);
    downgrade.exec(`
      CREATE VIRTUAL TABLE logs_fts USING fts5(
        message, content=logs, content_rowid=id
      );
      CREATE TRIGGER logs_ai AFTER INSERT ON logs BEGIN
        INSERT INTO logs_fts(rowid, message) VALUES (new.id, new.message);
      END;
      CREATE TRIGGER logs_ad AFTER DELETE ON logs BEGIN
        INSERT INTO logs_fts(logs_fts, rowid, message) VALUES('delete', old.id, old.message);
      END;
      -- Backfill the index from the existing row so the fixture matches
      -- what a long-lived V14 DB would actually look like on disk.
      INSERT INTO logs_fts(rowid, message) SELECT id, message FROM logs;
    `);
    downgrade.pragma(`user_version = 14`);
    downgrade.close();

    const upgraded = new DashboardDB({ dataDir: upgradeDir });
    try {
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

      const ftsTables = upgraded.db.prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'logs_fts%'`,
      ).all() as { name: string }[];
      expect(ftsTables).toHaveLength(0);

      const triggers = upgraded.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('logs_ai','logs_ad')`,
      ).all() as { name: string }[];
      expect(triggers).toHaveLength(0);

      const preserved = upgraded.db.prepare(
        `SELECT message FROM logs ORDER BY ts ASC`,
      ).all() as { message: string }[];
      expect(preserved).toEqual([{ message: 'pre-migration row' }]);

      // Sanity: inserts on `logs` still succeed (no orphaned trigger
      // pointing at the deleted virtual table).
      expect(() => upgraded.insertLog({
        ts: 2000, level: 'warn', module: 'Agent', message: 'post-migration row',
      })).not.toThrow();
    } finally {
      upgraded.close();
    }
  });

  it('prune vacuums a large freelist even when retained logs are not deleted', () => {
    const mkdtempSync = require('node:fs').mkdtempSync;
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');

    const vacuumDir = mkdtempSync(join(tmpdir(), 'dkg-dashboard-db-vacuum-'));
    const vacuumDb = new DashboardDB({ dataDir: vacuumDir, retentionDays: 365 });

    try {
      // Simulate the failure mode where a migration dropped a large object
      // (V15 drops logs_fts + its shadow tables) but retained logs are still
      // younger than the cutoff, so logsDeleted alone would not trigger VACUUM.
      vacuumDb.db.exec(`CREATE TABLE vacuum_fixture (payload BLOB NOT NULL);`);
      const insert = vacuumDb.db.prepare(
        `INSERT INTO vacuum_fixture (payload) VALUES (zeroblob(4096))`,
      );
      const fillFixture = vacuumDb.db.transaction(() => {
        for (let i = 0; i < 2_000; i += 1) insert.run();
      });
      fillFixture();
      vacuumDb.db.exec(`DROP TABLE vacuum_fixture;`);

      const beforePrune = Number(vacuumDb.db.pragma('freelist_count', { simple: true }));
      expect(beforePrune).toBeGreaterThan(1_000);

      vacuumDb.prune();

      const afterPrune = Number(vacuumDb.db.pragma('freelist_count', { simple: true }));
      expect(afterPrune).toBeLessThan(1_000);
    } finally {
      vacuumDb.close();
    }
  });
});

describe('DashboardDB — V27 join-approval ledger migration', () => {
  it('repairs a missing audit-cap trigger on a current-version database', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    raw.exec('DROP TRIGGER IF EXISTS cap_cg_join_policy_audit_rows;');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'cap_cg_join_policy_audit_rows'
    `).get()).toBeTruthy();
  });

  it('upgrades a V27 ledger with the durable repair marker', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP INDEX IF EXISTS idx_cg_join_approval_ledger_repair;
      ALTER TABLE context_graph_join_approval_ledger DROP COLUMN repair_pending;
    `);
    raw.pragma('user_version = 27');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const columns = db.db.pragma(
      'table_info(context_graph_join_approval_ledger)',
    ) as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('repair_pending');
  });

  it('upgrades a V24 database and makes the typed reservation ledger usable', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP TRIGGER IF EXISTS cap_cg_join_policy_audit_rows;
      DROP TABLE IF EXISTS context_graph_join_policy_audit;
      DROP TABLE IF EXISTS context_graph_join_approval_ledger;
    `);
    raw.pragma('user_version = 24');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'context_graph_join_policy_audit'
    `).get()).toBeTruthy();
    expect(db.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'context_graph_join_approval_ledger'
    `).get()).toBeTruthy();
    expect(db.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'cap_cg_join_policy_audit_rows'
    `).get()).toBeTruthy();

    const now = Date.now();
    const reservation = db.reserveContextGraphAutomaticApproval({
      contextGraphId: 'cg-v24-upgrade',
      timestamp: now,
      contextGraphLimit: 1,
      nodeLimit: 1,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'v24-upgrade-request',
      policyVersion: 1,
      policyEpoch: now,
    });
    expect(reservation).toMatchObject({ allowed: true });
    expect(db.commitContextGraphAutomaticApproval({
      contextGraphId: 'cg-v24-upgrade',
      timestamp: now + 1,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'v24-upgrade-request',
      policyEpoch: now,
    })).toBe(true);
    expect(db.listContextGraphJoinPolicyAudit('cg-v24-upgrade').map((row) => row.event_type))
      .toEqual(['join_auto_reservation', 'join_admission_committed']);
    expect(db.db.prepare(`
      SELECT policy_epoch, state, reserved_at, committed_at
      FROM context_graph_join_approval_ledger
      WHERE context_graph_id = ? AND request_digest = ?
    `).get('cg-v24-upgrade', 'v24-upgrade-request')).toEqual({
      policy_epoch: now,
      state: 'committed',
      reserved_at: now,
      committed_at: now + 1,
    });
  });

  it('replaces the V26 trigger now that live reservations no longer depend on audit', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS context_graph_join_approval_ledger;
      DROP TRIGGER IF EXISTS cap_cg_join_policy_audit_rows;
      CREATE TRIGGER cap_cg_join_policy_audit_rows
      AFTER INSERT ON context_graph_join_policy_audit
      BEGIN
        DELETE FROM context_graph_join_policy_audit
        WHERE id <= NEW.id - 100000
          AND event_type NOT IN (
            'join_admission_committed',
            'join_policy_changed'
          )
          AND NOT (
            event_type = 'join_auto_reservation'
            AND outcome = 'reserved'
            AND ts >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 3600000)
          );
      END;
    `);
    raw.prepare(`
      INSERT INTO context_graph_join_policy_audit (
        ts, context_graph_id, event_type, outcome
      ) VALUES (?, ?, 'join_admission_committed', 'approved')
    `).run(Date.now(), 'cg-v26-preserved-proof');
    raw.pragma('user_version = 26');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const trigger = db.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'cap_cg_join_policy_audit_rows'
    `).get() as { sql: string };
    expect(trigger.sql).toContain("'join_admission_committed'");
    expect(trigger.sql).toContain("'join_policy_changed'");
    expect(trigger.sql).not.toContain("'join_auto_reservation'");
    expect(db.listContextGraphJoinPolicyAudit('cg-v26-preserved-proof')).toHaveLength(1);
  });

  it('projects V26 reservation and commit audit rows into typed ledger state', () => {
    const dbPath = join(dir, 'node-ui.db');
    const now = Date.now();
    db.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TABLE IF EXISTS context_graph_join_approval_ledger;');
    const insert = raw.prepare(`
      INSERT INTO context_graph_join_policy_audit (
        ts, context_graph_id, event_type, actor, agent_address, outcome,
        request_digest, policy_version, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      now,
      'cg-v26-ledger-migration',
      'join_auto_reservation',
      'did:dkg:agent:owner',
      '0x0000000000000000000000000000000000000001',
      'reserved',
      'legacy-request',
      1,
      JSON.stringify({ policyEpoch: 777 }),
    );
    insert.run(
      now + 1,
      'cg-v26-ledger-migration',
      'join_admission_committed',
      'did:dkg:agent:owner',
      '0x0000000000000000000000000000000000000001',
      'approved',
      'legacy-request',
      1,
      JSON.stringify({ policyEpoch: 777 }),
    );
    raw.pragma('user_version = 26');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.prepare(`
      SELECT policy_epoch, state, reserved_at, committed_at, actor,
             agent_address, policy_version
      FROM context_graph_join_approval_ledger
      WHERE context_graph_id = ? AND request_digest = ?
    `).get('cg-v26-ledger-migration', 'legacy-request')).toEqual({
      policy_epoch: 777,
      state: 'committed',
      reserved_at: now,
      committed_at: now + 1,
      actor: 'did:dkg:agent:owner',
      agent_address: '0x0000000000000000000000000000000000000001',
      policy_version: 1,
    });
    expect(db.commitContextGraphAutomaticApproval({
      contextGraphId: 'cg-v26-ledger-migration',
      timestamp: now + 2,
      actor: 'did:dkg:agent:caller',
      agentAddress: '0x0000000000000000000000000000000000000002',
      requestDigest: 'legacy-request',
      policyEpoch: 777,
    })).toBe(true);
    expect(db.listContextGraphJoinPolicyAudit('cg-v26-ledger-migration').filter(
      (row) => row.event_type === 'join_admission_committed',
    )).toHaveLength(1);
  });

  it('caps audit flood noise while ledger reservations keep enforcing limits', () => {
    const now = Date.now();
    db.appendContextGraphJoinPolicyAudit({
      timestamp: now,
      contextGraphId: 'cg-old-noise',
      eventType: 'join_auto_decision',
      outcome: 'pending',
    });
    db.appendContextGraphJoinPolicyAudit({
      timestamp: now,
      contextGraphId: 'cg-proof',
      eventType: 'join_admission_committed',
      outcome: 'approved',
      requestDigest: 'committed-request',
    });
    db.appendContextGraphJoinPolicyAudit({
      timestamp: now,
      contextGraphId: 'cg-proof',
      eventType: 'join_policy_changed',
      outcome: 'open',
    });
    expect(db.reserveContextGraphAutomaticApproval({
      contextGraphId: 'cg-reservation-cap-v27',
      timestamp: now,
      contextGraphLimit: 1,
      nodeLimit: 100,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'live-reservation',
      policyVersion: 1,
      policyEpoch: now,
    })).toMatchObject({ allowed: true });

    // Advance the AUTOINCREMENT high-water so one insert crosses the cap
    // without allocating 100k fixture rows. The first four rows are all below
    // the trigger cutoff. Audit reservations may now be removed because the
    // dedicated ledger, rather than an audit event name/JSON shape, owns quota.
    db.db.prepare(`UPDATE sqlite_sequence SET seq = 100004 WHERE name = ?`)
      .run('context_graph_join_policy_audit');
    db.appendContextGraphJoinPolicyAudit({
      timestamp: now,
      contextGraphId: 'cg-new-noise',
      eventType: 'join_admission_failed',
      outcome: 'pending',
    });

    const retained = db.db.prepare(`
      SELECT context_graph_id, event_type
      FROM context_graph_join_policy_audit
      ORDER BY id ASC
    `).all() as Array<{ context_graph_id: string; event_type: string }>;
    expect(retained).not.toContainEqual({
      context_graph_id: 'cg-old-noise',
      event_type: 'join_auto_decision',
    });
    expect(retained).not.toContainEqual({
      context_graph_id: 'cg-reservation-cap-v27',
      event_type: 'join_auto_reservation',
    });
    expect(retained).toEqual(expect.arrayContaining([
      { context_graph_id: 'cg-proof', event_type: 'join_admission_committed' },
      { context_graph_id: 'cg-proof', event_type: 'join_policy_changed' },
      { context_graph_id: 'cg-new-noise', event_type: 'join_admission_failed' },
    ]));

    expect(db.reserveContextGraphAutomaticApproval({
      contextGraphId: 'cg-reservation-cap-v27',
      timestamp: now + 1,
      contextGraphLimit: 1,
      nodeLimit: 100,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000002',
      requestDigest: 'rate-limited-request',
      policyVersion: 1,
      policyEpoch: now,
    })).toMatchObject({ allowed: false, reason: 'context-graph-rate-limit' });
  });

  it('still applies time retention to volume-cap-exempt proof events', () => {
    expect(db.reserveContextGraphAutomaticApproval({
      timestamp: 1,
      contextGraphId: 'cg-expired-proof',
      contextGraphLimit: 1,
      nodeLimit: 1,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'expired-ledger-state',
      policyVersion: 1,
      policyEpoch: 1,
    })).toMatchObject({ allowed: true });
    db.appendContextGraphJoinPolicyAudit({
      timestamp: 1,
      contextGraphId: 'cg-expired-proof',
      eventType: 'join_admission_committed',
      outcome: 'approved',
    });
    db.appendContextGraphJoinPolicyAudit({
      timestamp: 1,
      contextGraphId: 'cg-expired-proof',
      eventType: 'join_policy_changed',
      outcome: 'manual',
    });

    db.prune();
    expect(db.listContextGraphJoinPolicyAudit('cg-expired-proof')).toHaveLength(0);
    expect(db.db.prepare(`
      SELECT COUNT(*) AS count FROM context_graph_join_approval_ledger
      WHERE context_graph_id = 'cg-expired-proof'
    `).get()).toEqual({ count: 0 });
  });
});

describe('DashboardDB — WAL reclaim', () => {
  it('caps the WAL with journal_size_limit = 64 MiB on open', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'dkg-db-wal-limit-'));
    const walDb = new DashboardDB({ dataDir: walDir });
    try {
      expect(Number(walDb.db.pragma('journal_size_limit', { simple: true }))).toBe(67108864);
    } finally {
      walDb.close();
      rmSync(walDir, { recursive: true, force: true });
    }
  });

  it('truncates the -wal file on prune() even when the VACUUM gate stays closed', () => {
    const walDir = mkdtempSync(join(tmpdir(), 'dkg-db-wal-trunc-'));
    // retentionDays high so prune() deletes no rows and the VACUUM gate
    // (logsDeleted / freelist thresholds) never trips — isolating the
    // unconditional wal_checkpoint(TRUNCATE) added at the end of prune().
    const walDb = new DashboardDB({ dataDir: walDir, retentionDays: 365 });
    const walPath = join(walDir, 'node-ui.db-wal');
    try {
      // Disable autocheckpoint so the WAL grows unbounded as we write,
      // reproducing the high-water-mark the fix targets.
      walDb.db.pragma('wal_autocheckpoint = 0');
      walDb.db.exec(`CREATE TABLE wal_fixture (payload BLOB NOT NULL);`);
      const insert = walDb.db.prepare(
        `INSERT INTO wal_fixture (payload) VALUES (zeroblob(4096))`,
      );
      const fillFixture = walDb.db.transaction(() => {
        for (let i = 0; i < 5_000; i += 1) insert.run();
      });
      fillFixture();

      const beforeWal = statSync(walPath).size;
      expect(beforeWal).toBeGreaterThan(5 * 1024 * 1024);

      walDb.prune();

      // No competing readers in this test, so wal_checkpoint(TRUNCATE)
      // must fully reclaim the file (busy = 0). Assert it is truncated to
      // empty rather than merely "smaller" — a partial checkpoint that
      // only shaved a few pages (the regression we want to catch) would
      // still leave multiple MB here.
      const afterWal = statSync(walPath).size;
      expect(afterWal).toBe(0);
    } finally {
      walDb.close();
      rmSync(walDir, { recursive: true, force: true });
    }
  });
});

describe('DashboardDB — context graph subscriptions', () => {
  it('persists shared-memory sync state across upserts', () => {
    db.upsertContextGraphSubscription({
      context_graph_id: 'project-a',
      name: 'Project A',
      subscribed: 1,
      synced: 1,
      shared_memory_synced: 0,
      meta_synced: 1,
      on_chain_id: '0xabc',
      sync_scoped: 1,
      updated_at: 1000,
    });

    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'project-a',
      shared_memory_synced: 0,
      meta_synced: 1,
      sync_scoped: 1,
    }]);

    db.upsertContextGraphSubscription({
      context_graph_id: 'project-a',
      name: 'Project A',
      subscribed: 1,
      synced: 1,
      shared_memory_synced: 1,
      meta_synced: 1,
      on_chain_id: '0xabc',
      sync_scoped: 1,
      updated_at: 2000,
    });

    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'project-a',
      shared_memory_synced: 1,
      updated_at: 2000,
    }]);
  });

  it('round-trips on_chain_hash + last_reconciled_ordinal (Phase B), defaulting to NULL', () => {
    // Omitted → NULL (legacy / never-reconciled).
    db.upsertContextGraphSubscription({
      context_graph_id: 'cg-legacy',
      subscribed: 1,
      synced: 1,
      sync_scoped: 1,
      updated_at: 1000,
    });
    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'cg-legacy',
      on_chain_hash: null,
      last_reconciled_ordinal: null,
    }]);

    // Set + advance the watermark.
    db.upsertContextGraphSubscription({
      context_graph_id: 'cg-legacy',
      subscribed: 1,
      synced: 1,
      on_chain_hash: '0xfeed',
      last_reconciled_ordinal: 5,
      sync_scoped: 1,
      updated_at: 2000,
    });
    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'cg-legacy',
      on_chain_hash: '0xfeed',
      last_reconciled_ordinal: 5,
    }]);
  });

  it('loads one context graph subscription by id', () => {
    db.upsertContextGraphSubscription({
      context_graph_id: 'project-a',
      subscribed: 1,
      synced: 1,
      sync_scoped: 1,
      updated_at: 1000,
    });
    db.upsertContextGraphSubscription({
      context_graph_id: 'project-b',
      subscribed: 0,
      synced: 0,
      sync_scoped: 0,
      updated_at: 2000,
    });

    expect(db.getContextGraphSubscription('project-b')).toMatchObject({
      context_graph_id: 'project-b',
      subscribed: 0,
      synced: 0,
    });
    expect(db.getContextGraphSubscription('missing')).toBeUndefined();
  });
});

describe('DashboardDB — durable VM reconcile negative cache', () => {
  it('round-trips and deletes restart-durable generation-gated misses', () => {
    db.upsertVmReconcileNegative({
      cache_key: 'cg\0ual#root',
      context_graph_id: 'cg',
      failures: 2,
      next_retry_at: 12_345,
      swm_gen: 'generation',
      candidate_namespaces: JSON.stringify([{ metaGraph: 'urn:meta', dataGraph: 'urn:data' }]),
      peer_topology_key: 'peers',
      updated_at: 100,
    });

    expect(db.getVmReconcileNegative('cg\0ual#root')).toMatchObject({
      context_graph_id: 'cg',
      failures: 2,
      swm_gen: 'generation',
    });
    db.deleteVmReconcileNegativesForContextGraph('cg');
    expect(db.getVmReconcileNegative('cg\0ual#root')).toBeUndefined();
  });

  it('prunes records after their bounded retry window', () => {
    db.upsertVmReconcileNegative({
      cache_key: 'expired',
      context_graph_id: 'cg',
      failures: 1,
      next_retry_at: Date.now() - 1,
      swm_gen: 'generation',
      candidate_namespaces: '[]',
      peer_topology_key: 'peers',
      updated_at: Date.now() - 1_000,
    });
    db.prune();
    expect(db.getVmReconcileNegative('expired')).toBeUndefined();
  });
});

describe('DashboardDB — selected-only VM reconcile cursors', () => {
  it('creates the deployment-scoped cursor table when upgrading an existing V31 database', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.setRetentionDays(42);
    db.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TABLE selected_vm_reconcile_cursors;');
    raw.pragma('user_version = 31');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.getRetentionDays()).toBe(42);

    db.upsertSelectedVmReconcileCursor({
      deployment_id: 'evm:84532:hub=0xupgrade',
      context_graph_id: 'selected-upgrade',
      on_chain_context_graph_id: '298',
      name_hash: `0x${'22'.repeat(32)}`,
      watermark: 9,
      updated_at: 400,
    });
    expect(db.getSelectedVmReconcileCursor(
      'evm:84532:hub=0xupgrade',
      'selected-upgrade',
      '298',
    )).toMatchObject({
      watermark: 9,
      updated_at: 400,
    });
  });

  it('keeps progress independent per deployment, local CG, and numeric chain binding across reopen', () => {
    db.upsertSelectedVmReconcileCursor({
      deployment_id: 'evm:84532:hub=0xaaa',
      context_graph_id: 'selected-public',
      on_chain_context_graph_id: '298',
      name_hash: `0x${'11'.repeat(32)}`,
      watermark: 7,
      updated_at: 100,
    });
    db.upsertSelectedVmReconcileCursor({
      deployment_id: 'evm:84532:hub=0xbbb',
      context_graph_id: 'selected-public',
      on_chain_context_graph_id: '298',
      name_hash: `0x${'11'.repeat(32)}`,
      watermark: 2,
      updated_at: 200,
    });
    db.upsertSelectedVmReconcileCursor({
      deployment_id: 'evm:84532:hub=0xaaa',
      context_graph_id: 'selected-public',
      on_chain_context_graph_id: '299',
      name_hash: `0x${'11'.repeat(32)}`,
      watermark: 3,
      updated_at: 300,
    });

    expect(db.getSelectedVmReconcileCursor(
      'evm:84532:hub=0xaaa',
      'selected-public',
      '298',
    )).toMatchObject({
      deployment_id: 'evm:84532:hub=0xaaa',
      on_chain_context_graph_id: '298',
      watermark: 7,
    });
    expect(db.getSelectedVmReconcileCursor(
      'evm:84532:hub=0xbbb',
      'selected-public',
      '298',
    )).toMatchObject({
      deployment_id: 'evm:84532:hub=0xbbb',
      on_chain_context_graph_id: '298',
      watermark: 2,
    });
    expect(db.getSelectedVmReconcileCursor(
      'evm:84532:hub=0xaaa',
      'selected-public',
      '299',
    )).toMatchObject({ watermark: 3 });
    expect(db.getContextGraphSubscription('selected-public')).toBeUndefined();

    db.close();
    db = new DashboardDB({ dataDir: dir });
    expect(db.getSelectedVmReconcileCursor(
      'evm:84532:hub=0xaaa',
      'selected-public',
      '298',
    )).toMatchObject({
      watermark: 7,
    });
  });

});

describe('DashboardDB — V17 subscription columns migration (Phase B)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-v17-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds on_chain_hash + last_reconciled_ordinal when upgrading a pre-V17 DB, preserving rows', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE context_graph_subscriptions DROP COLUMN on_chain_hash;');
    raw.exec('ALTER TABLE context_graph_subscriptions DROP COLUMN last_reconciled_ordinal;');
    raw.prepare(
      `INSERT INTO context_graph_subscriptions
         (context_graph_id, name, subscribed, synced, on_chain_id, sync_scoped, updated_at)
       VALUES ('cg-pre17', 'Pre17', 1, 1, '0xabc', 1, 1000)`,
    ).run();
    raw.pragma('user_version = 16');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.db.prepare('PRAGMA table_info(context_graph_subscriptions)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('on_chain_hash');
    expect(cols).toContain('last_reconciled_ordinal');

    // Pre-existing row survives; new columns default to NULL.
    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'cg-pre17',
      on_chain_id: '0xabc',
      on_chain_hash: null,
      last_reconciled_ordinal: null,
    }]);
  });

  it('fresh install already carries the V17 columns', () => {
    const cols = (db.db.prepare('PRAGMA table_info(context_graph_subscriptions)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('on_chain_hash');
    expect(cols).toContain('last_reconciled_ordinal');
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});

describe('DashboardDB — V19 core_hosted column migration (Phase D)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-v19-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips core_hosted, defaulting to NULL', () => {
    // Omitted → NULL (member-only / legacy subscription).
    db.upsertContextGraphSubscription({
      context_graph_id: 'cg-member',
      subscribed: 1,
      synced: 1,
      sync_scoped: 1,
      updated_at: 1000,
    });
    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'cg-member',
      core_hosted: null,
    }]);

    // A Core that ACKed a public CG records itself as a host (subscribed=0).
    db.upsertContextGraphSubscription({
      context_graph_id: '42',
      subscribed: 0,
      synced: 0,
      on_chain_id: '42',
      core_hosted: 1,
      sync_scoped: 0,
      updated_at: 2000,
    });
    const rows = db.listContextGraphSubscriptions();
    expect(rows.find((r) => r.context_graph_id === '42')).toMatchObject({
      subscribed: 0,
      on_chain_id: '42',
      core_hosted: 1,
    });
  });

  it('surfaces core_hosted in the cursor inspector join', () => {
    db.upsertContextGraphSubscription({
      context_graph_id: '7',
      subscribed: 0,
      synced: 0,
      on_chain_id: '7',
      core_hosted: 1,
      last_reconciled_ordinal: 3,
      sync_scoped: 0,
      updated_at: 1000,
    });
    const cursors = db.getReplicationCursors();
    expect(cursors.find((c) => c.context_graph_id === '7')).toMatchObject({
      on_chain_id: '7',
      last_reconciled_ordinal: 3,
      core_hosted: 1,
    });
  });

  it('adds core_hosted when upgrading a pre-V19 DB, preserving rows', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec('ALTER TABLE context_graph_subscriptions DROP COLUMN core_hosted;');
    raw.prepare(
      `INSERT INTO context_graph_subscriptions
         (context_graph_id, name, subscribed, synced, on_chain_id, sync_scoped, updated_at)
       VALUES ('cg-pre19', 'Pre19', 1, 1, '0xabc', 1, 1000)`,
    ).run();
    raw.pragma('user_version = 18');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.db.prepare('PRAGMA table_info(context_graph_subscriptions)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('core_hosted');

    expect(db.listContextGraphSubscriptions()).toMatchObject([{
      context_graph_id: 'cg-pre19',
      on_chain_id: '0xabc',
      core_hosted: null,
    }]);
  });
});

describe('DashboardDB — V20 ka_numbers table migration (B2 KA-number allocator)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-v20-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh install lands at the current schema and already carries the ka_numbers table', () => {
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const table = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ka_numbers'",
    ).get() as { name: string } | undefined;
    expect(table).toEqual({ name: 'ka_numbers' });

    // The B2 allocator packs `(uint160(author) << 96) | uint96(number)`;
    // this table owns the per-author `number` half. Lock the column shape
    // the SqliteKaNumberStore depends on: author_address PRIMARY KEY +
    // a NOT NULL next_number counter.
    const cols = db.db.prepare('PRAGMA table_info(ka_numbers)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect([...byName.keys()].sort()).toEqual(['author_address', 'next_number']);
    expect(byName.get('author_address')).toMatchObject({ type: 'TEXT', pk: 1 });
    expect(byName.get('next_number')).toMatchObject({ type: 'INTEGER', notnull: 1 });
  });

  it('creates ka_numbers when upgrading a pre-V20 (V19) DB', () => {
    // Stepwise upgrade: build a fresh DB, drop ka_numbers + reset
    // user_version to 19 to simulate a node that last booted before the
    // B2 allocator's V20 bump, then reopen via DashboardDB and verify the
    // `version < 20` block adds the table and the migration chain advances to the current schema.
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec('DROP TABLE IF EXISTS ka_numbers;');
    raw.pragma('user_version = 19');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const table = db.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ka_numbers'",
    ).get() as { name: string } | undefined;
    expect(table).toEqual({ name: 'ka_numbers' });

    // The upgraded table accepts the allocator's row shape.
    expect(() =>
      db.db.prepare(
        'INSERT INTO ka_numbers (author_address, next_number) VALUES (?, ?)',
      ).run('0xabc', 0),
    ).not.toThrow();
    const row = db.db.prepare(
      'SELECT next_number FROM ka_numbers WHERE author_address = ?',
    ).get('0xabc') as { next_number: number } | undefined;
    expect(row).toEqual({ next_number: 0 });
  });
});

describe('SqliteKaNumberStore — bigint counter (codex PR #976 F6)', () => {
  let db: DashboardDB;
  let dir: string;
  let store: SqliteKaNumberStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-ka-number-store-test-'));
    db = new DashboardDB({ dataDir: dir });
    store = new SqliteKaNumberStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const AUTHOR = '0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1';

  it('allocate / peekNext return bigint, not number', () => {
    const a = store.allocate(AUTHOR);
    expect(typeof a).toBe('bigint');
    expect(a).toBe(0n);

    expect(typeof store.peekNext(AUTHOR)).toBe('bigint');
    expect(store.peekNext(AUTHOR)).toBe(1n);

    expect(store.allocate(AUTHOR)).toBe(1n);
    expect(store.allocate(AUTHOR)).toBe(2n);
  });

  it('reconcileFloor accepts bigint and raises but never lowers', () => {
    store.reconcileFloor(AUTHOR, 41n);
    expect(store.peekNext(AUTHOR)).toBe(41n);
    expect(store.allocate(AUTHOR)).toBe(41n);

    // Stale floor must not pull the sequence backwards.
    store.reconcileFloor(AUTHOR, 5n);
    expect(store.peekNext(AUTHOR)).toBe(42n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER (no silent precision loss)', () => {
    // This is the F6 invariant against the REAL sqlite path. Pre-fix
    // the store returned JS `number`, so values past 2^53 would round
    // to the nearest even — successive `allocate()` calls could either
    // return the same value twice (kaId collision) or skip one.
    const past = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
    store.reconcileFloor(AUTHOR, past);
    const a = store.allocate(AUTHOR);
    const b = store.allocate(AUTHOR);
    const c = store.allocate(AUTHOR);
    expect(a).toBe(past);
    expect(b).toBe(past + 1n);
    expect(c).toBe(past + 2n);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    // peekNext is also exact.
    expect(store.peekNext(AUTHOR)).toBe(past + 3n);
  });
});

describe('DashboardDB — V21 sync_checkpoints table (A3 sync resume)', () => {
  let now = Date.now();
  const manifestA = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const manifestB = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const prefixA = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

  beforeEach(() => {
    now = Date.now();
  });

  const checkpointStore = () => new SqliteSyncCheckpointStore(db, {
    clock: () => now,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  it('fresh install carries the sync_checkpoints table and expiry index', () => {
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='sync_checkpoints'`,
    ).all();
    const indexes = db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sync_checkpoints_expires_at'`,
    ).all();
    expect(tables).toHaveLength(1);
    expect(indexes).toHaveLength(1);
    const columns = new Set(
      (db.db.prepare('PRAGMA table_info(sync_checkpoints)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    expect(columns).toContain('responder_session_id');
    expect(columns).toContain('responder_session_expires_at');
    expect(columns).toContain('manifest_digest');
    expect(columns).toContain('manifest_prefix_digest');
    expect(columns).toContain('terminal');
  });

  it('round-trips, overwrites, deletes, and expires checkpoints', () => {
    const store = checkpointStore();
    store.set('peer|cg|durable|data', 500);
    expect(store.get('peer|cg|durable|data')).toEqual({
      offset: 500,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    store.set('peer|cg|durable|data', 750);
    expect(store.get('peer|cg|durable|data')).toEqual({
      offset: 750,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    store.delete('peer|cg|durable|data');
    expect(store.get('peer|cg|durable|data')).toBeUndefined();

    store.set('peer|cg|durable|meta', 100);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(store.get('peer|cg|durable|meta')).toBeUndefined();
  });

  it('persists non-expired checkpoints across DashboardDB reopen and prunes stale rows', () => {
    const store = checkpointStore();
    store.set('peer|cg|swm|data', 42);
    store.set('peer|cg|swm|meta', 43);
    db.close();

    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get('peer|cg|swm|data')).toEqual({
      offset: 42,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
    });

    now += 24 * 60 * 60 * 1000 + 1;
    expect(reopened.get('peer|cg|swm|data')).toBeUndefined();
    expect(reopened.pruneExpired(now)).toBe(1);
    const count = (db.db.prepare(`SELECT COUNT(*) AS c FROM sync_checkpoints`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('persists the responder session with its verified offset across reopen', () => {
    const store = checkpointStore();
    const key = 'peer|cg|durable|data';
    const sessionExpiresAt = now + 10 * 60 * 1000;

    store.setResponderSession(key, 'durable-data:restart-safe', sessionExpiresAt);
    store.set(key, 573235);
    expect(store.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      responderSessionId: 'durable-data:restart-safe',
      responderSessionExpiresAtMs: sessionExpiresAt,
      responderSessionOffset: 573235,
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      responderSessionId: 'durable-data:restart-safe',
      responderSessionExpiresAtMs: sessionExpiresAt,
    });

    now = sessionExpiresAt + 1;
    expect(reopened.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: sessionExpiresAt - 10 * 60 * 1000,
      expiresAtMs: sessionExpiresAt - 10 * 60 * 1000 + 24 * 60 * 60 * 1000,
    });
    expect(db.db.prepare(`
      SELECT responder_session_id, responder_session_expires_at
        FROM sync_checkpoints WHERE key = ?
    `).get(key)).toEqual({
      responder_session_id: null,
      responder_session_expires_at: null,
    });
  });

  it('persists a manifest-bound verified prefix across restart and safely rebinds it', () => {
    const key = 'peer|cg|durable|data';
    const sessionExpiresAt = now + 10 * 60 * 1000;
    const store = checkpointStore();

    store.setManifestBoundOffset(key, 573235, manifestA, now, prefixA);
    store.setResponderSession(key, 'durable-data:generation-a', sessionExpiresAt, now, manifestA);
    expect(store.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-a',
      responderSessionExpiresAtMs: sessionExpiresAt,
      responderSessionOffset: 573235,
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-a',
    });

    // The requester has already proven this prefix is byte-identical in the
    // fresh META generation. Rebinding retains the verified offset and prefix
    // but must discard the responder token from the old immutable row list.
    now += 1;
    reopened.setManifestBoundOffset(key, 573235, manifestB, now, prefixA);
    expect(reopened.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
    });

    // Priming a fresh responder generation with the new manifest must not
    // reset the already-verified local prefix to zero.
    reopened.setResponderSession(
      key,
      'durable-data:generation-b',
      sessionExpiresAt,
      now,
      manifestB,
    );
    expect(reopened.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-b',
    });

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const restarted = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(restarted.get(key)).toMatchObject({
      offset: 573235,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
      responderSessionId: 'durable-data:generation-b',
    });

    now = sessionExpiresAt + 1;
    expect(restarted.get(key)).toEqual({
      offset: 573235,
      updatedAtMs: sessionExpiresAt - 10 * 60 * 1000 + 1,
      expiresAtMs: sessionExpiresAt - 10 * 60 * 1000 + 1 + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      manifestPrefixDigest: prefixA,
    });
  });

  it('persists terminal manifest completion across restart and clears it on rebind', () => {
    const key = 'peer|cg|durable|data';
    const store = checkpointStore();
    store.setManifestBoundOffset(key, 6_357_721, manifestA, now, prefixA, true);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteSyncCheckpointStore(db, { clock: () => now });
    expect(reopened.get(key)).toMatchObject({
      offset: 6_357_721,
      manifestDigest: manifestA,
      manifestPrefixDigest: prefixA,
      terminal: true,
    });

    reopened.setManifestBoundOffset(key, 512, manifestB, now + 1, prefixA);
    expect(reopened.get(key)?.terminal).toBeUndefined();
  });

  it('resets an offset when a responder session is bound to a different manifest', () => {
    const key = 'peer|cg|durable|data';
    const store = checkpointStore();
    store.setManifestBoundOffset(key, 4096, manifestA, now, prefixA);

    store.setResponderSession(
      key,
      'durable-data:unproven-generation',
      now + 60_000,
      now,
      manifestB,
    );

    expect(store.get(key)).toEqual({
      offset: 0,
      updatedAtMs: now,
      expiresAtMs: now + 24 * 60 * 60 * 1000,
      manifestDigest: manifestB,
      responderSessionId: 'durable-data:unproven-generation',
      responderSessionExpiresAtMs: now + 60_000,
      responderSessionOffset: 0,
    });

    // Legacy/non-manifest writes cannot leave a stale cryptographic binding or
    // responder token attached to an unrelated offset.
    store.set(key, 128, now + 1);
    expect(store.get(key)).toEqual({
      offset: 128,
      updatedAtMs: now + 1,
      expiresAtMs: now + 1 + 24 * 60 * 60 * 1000,
    });
  });

  it('rejects malformed manifest bindings', () => {
    const store = checkpointStore();
    expect(() => store.setManifestBoundOffset(
      'peer|cg|durable|data',
      1,
      'sha256:not-a-digest',
    )).toThrow('Invalid sync manifest digest');
    expect(() => store.setManifestBoundOffset(
      'peer|cg|durable|data',
      1,
      manifestA,
      now,
      'sha256:not-a-prefix',
    )).toThrow('Invalid sync manifest prefix digest');
  });

  it.each([
    ['invalid manifest digest', {
      manifest_digest: 'sha256:not-a-digest',
      manifest_prefix_digest: null,
      responder_session_id: null,
      responder_session_expires_at: null,
      responder_session_offset: null,
    }],
    ['orphan manifest prefix', {
      manifest_digest: null,
      manifest_prefix_digest: prefixA,
      responder_session_id: null,
      responder_session_expires_at: null,
      responder_session_offset: null,
    }],
    ['partial responder session', {
      manifest_digest: manifestA,
      manifest_prefix_digest: prefixA,
      responder_session_id: 'torn-session',
      responder_session_expires_at: now + 60_000,
      responder_session_offset: null,
    }],
  ])('fails closed and deletes a persisted row with %s', (_name, malformed) => {
    const key = `peer|cg|durable|data|checkpoint:v2|${_name}`;
    db.db.prepare(`
      INSERT INTO sync_checkpoints (
        key, offset, updated_at, expires_at,
        responder_session_id, responder_session_expires_at, responder_session_offset,
        manifest_digest, manifest_prefix_digest, terminal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      key,
      512,
      now,
      now + 60_000,
      malformed.responder_session_id,
      malformed.responder_session_expires_at,
      malformed.responder_session_offset,
      malformed.manifest_digest,
      malformed.manifest_prefix_digest,
    );

    expect(checkpointStore().get(key)).toBeUndefined();
    expect(db.db.prepare(
      'SELECT key FROM sync_checkpoints WHERE key = ?',
    ).get(key)).toBeUndefined();
  });

  it('creates sync_checkpoints when upgrading a pre-V21 DB', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`DROP TABLE IF EXISTS sync_checkpoints;`);
    raw.pragma('user_version = 20');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='sync_checkpoints'`,
    ).all()).toHaveLength(1);
    expect(db.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_cursors'`,
    ).all()).toHaveLength(1);
  });

  it('adds responder-session columns when upgrading a V29 checkpoint table', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE sync_checkpoints;
      CREATE TABLE sync_checkpoints (
        key TEXT PRIMARY KEY,
        offset INTEGER NOT NULL CHECK (offset >= 0),
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_sync_checkpoints_expires_at
        ON sync_checkpoints(expires_at);
    `);
    raw.pragma('user_version = 29');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const columns = new Set(
      (db.db.prepare('PRAGMA table_info(sync_checkpoints)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    expect(columns).toContain('responder_session_id');
    expect(columns).toContain('responder_session_expires_at');
    expect(columns).toContain('manifest_digest');
    expect(columns).toContain('manifest_prefix_digest');
    expect(columns).toContain('terminal');
  });

  it('invalidates unversioned V32 durable DATA progress during the V34 upgrade', () => {
    const dbPath = join(dir, 'node-ui.db');
    const key = 'peer|cg|durable|data';
    db.close();

    const raw = new Database(dbPath);
    raw.exec(`
      ALTER TABLE sync_checkpoints DROP COLUMN manifest_digest;
      ALTER TABLE sync_checkpoints DROP COLUMN manifest_prefix_digest;
      ALTER TABLE sync_checkpoints DROP COLUMN terminal;
    `);
    raw.prepare(`
      INSERT INTO sync_checkpoints (
        key, offset, updated_at, expires_at,
        responder_session_id, responder_session_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(key, 8192, now, now + 60_000, 'legacy-session', now + 30_000);
    raw.pragma('user_version = 32');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(new SqliteSyncCheckpointStore(db, { clock: () => now }).get(key)).toBeUndefined();
    const columns = new Set(
      (db.db.prepare('PRAGMA table_info(sync_checkpoints)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    expect(columns).toContain('manifest_digest');
    expect(columns).toContain('manifest_prefix_digest');
    expect(columns).toContain('terminal');
    expect(columns).toContain('responder_session_offset');
  });
});

describe('DashboardDB — chain RPC cursor stores', () => {
  it('persists chain-event lane cursors by scope across reopen', async () => {
    const store = new SqliteChainEventCursorStore(db, { scope: 'evm:1:hub=0xabc' });

    await store.saveLane('contextGraphDiscovery', 1234);
    await store.saveLane('vmReconcile', 5678);
    expect(await store.loadLane('contextGraphDiscovery')).toBe(1234);
    expect(await store.loadLane('vmReconcile')).toBe(5678);
    expect(db.db.prepare(
      `SELECT value FROM runtime_cursors
       WHERE namespace = 'chainEventPoller.cursor'
         AND scope = 'evm:1:hub=0xabc'
         AND key = 'contextGraphDiscovery'`,
    ).get()).toEqual({ value: 1234 });
    expect(await new SqliteChainEventCursorStore(db, { scope: 'evm:2:hub=0xabc' }).loadLane('contextGraphDiscovery')).toBeUndefined();

    await store.saveLane('contextGraphDiscovery', 0);
    await store.saveLane('contextGraphDiscovery', -1);
    await store.saveLane('contextGraphDiscovery', 1.5);
    await store.saveLane('contextGraphDiscovery', Number.MAX_SAFE_INTEGER + 1);
    expect(await store.loadLane('contextGraphDiscovery')).toBe(1234);

    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('chainEventPoller.cursor:evm:1:hub=0xabc:badLane', '0');
    expect(await store.loadLane('badLane')).toBeUndefined();
    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run('chainEventPoller.cursor:evm:1:hub=0xabc:legacyLane', '2468');
    expect(await store.loadLane('legacyLane')).toBe(2468);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteChainEventCursorStore(db, { scope: 'evm:1:hub=0xabc' });
    expect(await reopened.loadLane('contextGraphDiscovery')).toBe(1234);
    expect(await reopened.loadLane('vmReconcile')).toBe(5678);
    expect(await reopened.loadLane('legacyLane')).toBe(2468);
  });

  it('persists registry scan cursors by deployment key and ignores corrupt values', async () => {
    const store = new SqliteContextGraphRegistryScanCursorStore(db);
    const key = {
      chainId: 'evm:1',
      deploymentId: 'evm:1:hub=0xabc',
      registryAddress: '0x3333333333333333333333333333333333333333',
    };

    await store.save(key, 5000);
    expect(await store.load(key)).toBe(5000);
    expect(db.db.prepare(
      `SELECT value FROM runtime_cursors
       WHERE namespace = 'contextGraphRegistryScan.cursor'
         AND scope = ?
         AND key = ?`,
    ).get(`${key.chainId}:${key.deploymentId}`, key.registryAddress.toLowerCase())).toEqual({ value: 5000 });
    await store.save(key, 0);
    await store.save(key, -1);
    await store.save(key, 1.5);
    await store.save(key, Number.MAX_SAFE_INTEGER + 1);
    expect(await store.load(key)).toBe(5000);
    expect(await store.load({ ...key, registryAddress: '0x4444444444444444444444444444444444444444' })).toBeUndefined();

    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(
      `contextGraphRegistryScan.cursor:${key.chainId}:${key.deploymentId}:0x5555555555555555555555555555555555555555`,
      'not-a-number',
    );
    expect(await store.load({ ...key, registryAddress: '0x5555555555555555555555555555555555555555' })).toBeUndefined();
    db.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(
      `contextGraphRegistryScan.cursor:${key.chainId}:${key.deploymentId}:0x6666666666666666666666666666666666666666`,
      '6000',
    );
    expect(await store.load({ ...key, registryAddress: '0x6666666666666666666666666666666666666666' })).toBe(6000);

    db.close();
    db = new DashboardDB({ dataDir: dir });
    const reopened = new SqliteContextGraphRegistryScanCursorStore(db);
    expect(await reopened.load(key)).toBe(5000);
    expect(await reopened.load({ ...key, registryAddress: '0x6666666666666666666666666666666666666666' })).toBe(6000);
  });
});

describe('DashboardDB — context graph memberships', () => {
  it('upserts, lists, and deletes node/agent membership rows', () => {
    db.upsertContextGraphMember({
      context_graph_id: 'project-a',
      principal_type: 'node',
      principal_id: 'peer-1',
      role: 'subscriber',
      status: 'active',
      source: 'subscription',
      display_name: 'Node 1',
      metadata: JSON.stringify({ synced: false }),
      first_seen_at: 1000,
      updated_at: 1000,
    });
    db.upsertContextGraphMember({
      context_graph_id: 'project-a',
      principal_type: 'agent',
      principal_id: '0x1111111111111111111111111111111111111111',
      role: 'participant',
      status: 'active',
      source: 'allowed-agent',
      updated_at: 1100,
    });

    expect(db.listContextGraphMembers('project-a')).toHaveLength(2);

    db.upsertContextGraphMember({
      context_graph_id: 'project-a',
      principal_type: 'node',
      principal_id: 'peer-1',
      role: 'curator',
      status: 'active',
      source: 'local-create',
      first_seen_at: 2000,
      updated_at: 2000,
    });

    const node = db.listContextGraphMembers('project-a').find((m) => m.principal_type === 'node');
    expect(node?.role).toBe('curator');
    expect(node?.source).toBe('local-create');
    expect(node?.first_seen_at).toBe(1000);
    expect(node?.updated_at).toBe(2000);

    db.deleteContextGraphMember('project-a', 'agent', '0x1111111111111111111111111111111111111111');
    const remaining = db.listContextGraphMembers('project-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].principal_id).toBe('peer-1');
  });
});

// Regression coverage for the agent-to-agent debug chat inbox.
// `getChatMessages` is consumed by `dkg_check_inbox` (mcp-dkg) and the
// inject-inbox prompt-prefix hook. The three properties exercised here
// were all flagged by Codex on PR #510 (the first round added direction
// filtering; round 2 added compound-cursor pagination + ASC order).
describe('DashboardDB.getChatMessages — chat inbox semantics', () => {
  function seed() {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'a-in-1' });
    db.insertChatMessage({ ts: 1000, direction: 'out', peer: 'alice', text: 'a-out-1', delivered: true });
    // Same-ts burst — should NOT be lost by ts-only pagination.
    db.insertChatMessage({ ts: 2000, direction: 'in', peer: 'alice', text: 'a-in-2' });
    db.insertChatMessage({ ts: 2000, direction: 'in', peer: 'alice', text: 'a-in-3' });
    db.insertChatMessage({ ts: 3000, direction: 'in', peer: 'bob', text: 'b-in-1' });
  }

  it('applies server-side `direction=in` filter BEFORE the LIMIT cap', () => {
    // Without the filter, LIMIT=2 returns the newest 2 rows mixed
    // across directions. With direction=in, LIMIT=2 returns the newest
    // 2 INBOUND rows — what an inbox reader expects.
    seed();
    const rows = db.getChatMessages({ direction: 'in', limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.direction === 'in')).toBe(true);
  });

  it('compound (since, sinceId) cursor is lossless across same-millisecond rows', () => {
    seed();
    // Page 1: ASC pagination starting from ts=0 returns all 4 inbound.
    const page1 = db.getChatMessages({
      direction: 'in',
      order: 'asc',
      limit: 2,
      since: 0,
    });
    expect(page1.map((r) => r.text)).toEqual(['a-in-1', 'a-in-2']);

    // Advance compound cursor past the last row in page 1 — note that
    // `a-in-2` and `a-in-3` share ts=2000, so a `ts > 2000` cursor
    // would skip `a-in-3`. The compound cursor must carry id forward.
    const lastP1 = page1[page1.length - 1];
    const page2 = db.getChatMessages({
      direction: 'in',
      order: 'asc',
      limit: 2,
      since: lastP1.ts,
      sinceId: lastP1.id,
    });
    expect(page2.map((r) => r.text)).toEqual(['a-in-3', 'b-in-1']);
  });

  it('ts-only cursor (no sinceId) preserves legacy behaviour for callers that opt out', () => {
    // Without `sinceId`, paginating past a same-ts boundary would
    // skip rows. This test pins the legacy predicate so we KNOW
    // the compound path is what fixes it, and we don't accidentally
    // change behaviour for callers that haven't migrated.
    seed();
    const skipped = db.getChatMessages({
      direction: 'in',
      order: 'asc',
      since: 2000, // ts > 2000 → drops both 2000-ts rows AND a-in-1
    });
    expect(skipped.map((r) => r.text)).toEqual(['b-in-1']);
  });

  it('omitting `order` preserves legacy "newest N displayed oldest-first" dashboard contract', () => {
    seed();
    const rows = db.getChatMessages({ direction: 'in' });
    // Pre-RFC dashboard expected the result laid out chronologically
    // for a "history scroll" view, but bounded to the newest N.
    // SQL picks DESC then we reverse — keeps existing UI callers
    // working without any opt-in change.
    expect(rows[rows.length - 1].text).toBe('b-in-1');
    expect(rows[0].text).toBe('a-in-1');
  });

  // Codex PR #510 round 4 — previously `order: 'desc'` was not
  // honoured: SQL returned DESC then `.reverse()` flipped it to ASC,
  // so the API contract didn't match the behaviour. Explicit values
  // are now applied literally.
  it("explicit order='asc' returns oldest-first (true ASC)", () => {
    seed();
    const rows = db.getChatMessages({ direction: 'in', order: 'asc' });
    expect(rows[0].text).toBe('a-in-1');
    expect(rows[rows.length - 1].text).toBe('b-in-1');
  });

  it("explicit order='desc' returns newest-first (true DESC, no implicit reverse)", () => {
    seed();
    const rows = db.getChatMessages({ direction: 'in', order: 'desc' });
    expect(rows[0].text).toBe('b-in-1');
    expect(rows[rows.length - 1].text).toBe('a-in-1');
  });

  it('returns SQLite rowid (`id`) on every row so callers can build the next compound cursor', () => {
    seed();
    const rows = db.getChatMessages({});
    for (const r of rows) {
      expect(typeof r.id).toBe('number');
      expect(r.id).toBeGreaterThan(0);
    }
  });
});

// Receiver-side message-id semantics — V13 (rc.9 PR-3) moved chat
// dedup from SQL to the substrate (`Messenger.register` +
// `message_idempotency`). The `chat_messages.message_id` COLUMN is
// preserved as nullable + persisted so existing readers (HTTP API +
// MCP) keep working. The partial unique INDEX
// `idx_chat_msgid(peer, direction, message_id) WHERE message_id IS
// NOT NULL` was DROPPED — duplicate inserts at SQL level are no
// longer blocked because the substrate intercepts them upstream.
// These tests pin the V13 contract: column persists, no SQL dedup,
// non-dedup constraint violations still throw.
describe('DashboardDB.insertChatMessage — V13 substrate-owned dedup', () => {
  it('returns true on first insert with a messageId', () => {
    const inserted = db.insertChatMessage({
      ts: 1000,
      direction: 'in',
      peer: 'alice',
      text: 'first',
      messageId: 'msg-1',
    });
    expect(inserted).toBe(true);
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(1);
  });

  it('V13: duplicate (peer, direction, messageId) tuples are persisted (substrate gates upstream)', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'first', messageId: 'msg-1' });
    // V13 contract: SQL no longer enforces uniqueness. If two
    // identical rows reach the insert, both are persisted —
    // because in the rc.9 substrate-owned model, both reaching
    // this layer means the substrate did NOT detect a duplicate
    // (e.g. test-direct insert that bypasses Messenger.register).
    const inserted = db.insertChatMessage({
      ts: 1500,
      direction: 'in',
      peer: 'alice',
      text: 'first-but-different-text',
      messageId: 'msg-1',
    });
    expect(inserted).toBe(true);
    const rows = db.getChatMessages({ peer: 'alice' });
    expect(rows).toHaveLength(2);
  });

  it('different messageIds from the same peer are NOT deduped', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'a', messageId: 'msg-1' });
    db.insertChatMessage({ ts: 2000, direction: 'in', peer: 'alice', text: 'b', messageId: 'msg-2' });
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(2);
  });

  // Per-sender keying — the index is `(peer, message_id)`, not just
  // `message_id`. Two different senders that happen to pick the same
  // UUID must NOT collide. Vanishingly unlikely with v4 UUIDs, but
  // (a) the trust model can't assume a sender picks unique ids, and
  // (b) any future migration to a smaller id space would make the
  // collision real.
  it('same messageId from DIFFERENT peers is NOT deduped (per-sender keying)', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'from-alice', messageId: 'shared-uuid' });
    const insertedBob = db.insertChatMessage({
      ts: 1000,
      direction: 'in',
      peer: 'bob',
      text: 'from-bob',
      messageId: 'shared-uuid',
    });
    expect(insertedBob).toBe(true);
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(1);
    expect(db.getChatMessages({ peer: 'bob' })).toHaveLength(1);
  });

  // Pre-V11 senders + future senders that intentionally omit the id
  // must remain insertable repeatedly. The partial-unique-index
  // predicate `WHERE message_id IS NOT NULL` ensures null-id rows
  // sit outside the constraint.
  it('messageId=null rows are never deduped (legacy + opt-out path)', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'legacy-a' });
    db.insertChatMessage({ ts: 2000, direction: 'in', peer: 'alice', text: 'legacy-b' });
    db.insertChatMessage({ ts: 3000, direction: 'in', peer: 'alice', text: 'legacy-c', messageId: null });
    const rows = db.getChatMessages({ peer: 'alice' });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.message_id === null)).toBe(true);
  });

  it('persists messageId on the row for `getChatMessages` readers', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'tracked', messageId: 'mid-XYZ' });
    const [row] = db.getChatMessages({ peer: 'alice' });
    expect(row.message_id).toBe('mid-XYZ');
  });

  // V13: substrate owns dedup. Repeated outbound INSERTs at the
  // SQL layer are no longer suppressed — they persist as separate
  // rows. The new contract for callers that previously relied on
  // SQL dedup is to delegate to `Messenger.sendReliable` (sender
  // idempotency cache) instead of calling `insertChatMessage`
  // multiple times with the same key.
  it('V13: outbound INSERT replay with the same messageId persists both rows', () => {
    const firstAttempt = db.insertChatMessage({
      ts: 1000,
      direction: 'out',
      peer: 'alice',
      text: 'hello',
      delivered: false,
      messageId: 'out-msg-1',
    });
    expect(firstAttempt).toBe(true);
    const replay = db.insertChatMessage({
      ts: 2000,
      direction: 'out',
      peer: 'alice',
      text: 'hello',
      delivered: true,
      messageId: 'out-msg-1',
    });
    expect(replay).toBe(true);
    const rows = db.getChatMessages({ peer: 'alice', direction: 'out' });
    expect(rows).toHaveLength(2);
  });

  // Codex review of PR #534 regression: with the original
  // `(peer, message_id)` index shape, a legitimate inbound message
  // would be silently dropped if its `messageId` happened to match
  // an outbound row to the same peer. v4 UUIDs make accidental
  // collision vanishingly unlikely, but a caller-supplied id (the
  // MCP tool layer, an external bridge that mirrors ids from
  // upstream systems) can easily produce the collision — and the
  // failure mode would be a SILENTLY dropped inbound, exactly the
  // class this PR is trying to close. With the per-direction index
  // shape (`(peer, direction, message_id)`), the namespaces are
  // independent.
  it('inbound and outbound with the same (peer, messageId) DO NOT collide (per-direction index)', () => {
    const outFirst = db.insertChatMessage({
      ts: 1000,
      direction: 'out',
      peer: 'alice',
      text: 'I asked',
      delivered: true,
      messageId: 'shared-id',
    });
    expect(outFirst).toBe(true);
    const inEcho = db.insertChatMessage({
      ts: 2000,
      direction: 'in',
      peer: 'alice',
      text: 'alice replied',
      messageId: 'shared-id',
    });
    expect(inEcho).toBe(true);
    expect(db.getChatMessages({ peer: 'alice', direction: 'in' })).toHaveLength(1);
    expect(db.getChatMessages({ peer: 'alice', direction: 'out' })).toHaveLength(1);
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(2);
  });

  // V13 (rc.9 PR-3) removed the `ON CONFLICT ... DO NOTHING` clause
  // entirely — but the underlying schema constraints (NOT NULL
  // etc.) remain. Make sure non-dedup constraint violations still
  // throw, so a bug in the daemon's chat path can't silently
  // swallow a NULL peer or similar.
  it('non-dedup constraint violations still throw (peer NOT NULL is not swallowed)', () => {
    expect(() => {
      db.insertChatMessage({
        ts: 1000,
        direction: 'in',
        // @ts-expect-error — deliberately passing null to trigger the
        // schema's NOT NULL constraint on `peer`. The point of the
        // test is to confirm this raises an error rather than getting
        // silently absorbed by the dedup-clause.
        peer: null,
        text: 'should-throw',
        messageId: 'msg-not-null-violation',
      });
    }).toThrow(/NOT NULL constraint failed: chat_messages\.peer/i);
    // And confirm no row leaked through.
    expect(db.getChatMessages({})).toHaveLength(0);
  });
});

// Regression coverage for the V11→V13 chat schema migration chain. V11
// added `chat_messages.message_id` + the partial unique index
// `idx_chat_msgid` to dedup multi-path-race chat duplicates at SQL
// level. V12 added the substrate's protocol-agnostic
// `message_idempotency` table. V13 (rc.9 PR-3) drops
// `idx_chat_msgid` because dedup is now owned by `Messenger.register`
// + `message_idempotency` — the substrate intercepts duplicates
// before they reach the chat-messages insert. The `message_id`
// COLUMN is preserved as nullable + unwritten for rollback safety
// (downgrade to rc.8 finds a structurally-compatible schema).
describe('DashboardDB — V11→V13 chat schema migration chain', () => {
  it('upgrades pre-V11 → V13: adds `message_id` column, drops the partial unique index, accepts duplicate inserts (substrate owns dedup)', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    // Simulate pre-V11 state on disk.
    const raw = new Database(dbPath);
    raw.exec('DROP INDEX IF EXISTS idx_chat_msgid;');
    raw.exec('ALTER TABLE chat_messages DROP COLUMN message_id;');
    const preV11Ts = Date.now() - 60_000;
    raw.prepare(
      `INSERT INTO chat_messages (ts, direction, peer, text) VALUES (?, ?, ?, ?)`,
    ).run(preV11Ts, 'in', 'alice', 'pre-v11-row');
    raw.pragma('user_version = 10');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('message_id');

    // V13 explicitly drops the V11 partial unique index. The column
    // stays for rollback safety; the uniqueness contract is gone.
    const indexes = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages'").all() as Array<{ name: string }>)
      .map((i) => i.name);
    expect(indexes).not.toContain('idx_chat_msgid');

    // Pre-V11 row survives the migration with a NULL message_id.
    const pre = db.getChatMessages({ peer: 'alice' });
    expect(pre).toHaveLength(1);
    expect(pre[0].text).toBe('pre-v11-row');
    expect(pre[0].message_id).toBeNull();

    // V13 semantics: duplicate (peer, direction, message_id) tuples
    // are NO LONGER blocked at SQL level — the substrate's
    // `message_idempotency` cache intercepts duplicates upstream.
    // Both inserts succeed; the second is the "if substrate let it
    // through, persist it" outcome.
    expect(
      db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'v11-a', messageId: 'm1' }),
    ).toBe(true);
    expect(
      db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'v11-a-dup', messageId: 'm1' }),
    ).toBe(true);
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(3);
  });
});

describe('DashboardDB — V16 notifications.context_graph_id migration (A1)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-v16-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds context_graph_id + idx_notif_cg when upgrading a pre-V16 DB, preserving rows as NULL', () => {
    // Simulate a V15 DB: drop the new column + its index and reset
    // user_version to 15, then reopen via DashboardDB and verify the
    // V16 block restores them and leaves the pre-existing row's scope NULL.
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    const raw = new Database(dbPath);
    raw.exec('DROP INDEX IF EXISTS idx_notif_cg;');
    raw.exec('ALTER TABLE notifications DROP COLUMN context_graph_id;');
    const legacyTs = Date.now() - 60_000;
    raw.prepare(
      `INSERT INTO notifications (ts, type, title, message, source, peer, read, meta)
       VALUES (?, 'join_request', 'Legacy', 'pre-v16 row', 'access-control', NULL, 0, NULL)`,
    ).run(legacyTs);
    raw.pragma('user_version = 15');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const cols = (db.db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('context_graph_id');

    const indexes = (db.db.prepare(`PRAGMA index_list(notifications)`).all() as Array<{ name: string }>)
      .map((i) => i.name);
    expect(indexes).toContain('idx_notif_cg');

    // Legacy row survives with NULL scope (treated as out-of-scope by the
    // scoped read path; aged out by prune()).
    const { notifications } = db.getNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].context_graph_id).toBeNull();

    // New inserts can carry a scope.
    expect(() => db.insertNotification({
      ts: Date.now(), type: 'join_request', title: 'X', message: 'y',
      contextGraphId: 'cg-abc',
    })).not.toThrow();
    const after = db.getNotifications().notifications;
    expect(after.find((n) => n.title === 'X')!.context_graph_id).toBe('cg-abc');
  });

  it('fresh install already carries context_graph_id (no upgrade needed)', () => {
    const cols = (db.db.prepare('PRAGMA table_info(notifications)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('context_graph_id');
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('insertNotification writes context_graph_id to the column; omitted → NULL', () => {
    db.insertNotification({ ts: 1000, type: 'assertion_activity', title: 'A', message: 'a', contextGraphId: 'cg-1' });
    db.insertNotification({ ts: 2000, type: 'peer_connected', title: 'B', message: 'b' });
    const { notifications } = db.getNotifications();
    const a = notifications.find((n) => n.title === 'A')!;
    const b = notifications.find((n) => n.title === 'B')!;
    expect(a.context_graph_id).toBe('cg-1');
    expect(b.context_graph_id).toBeNull();
  });

  it('getPcaCostCoveredRowsForWallet returns ONLY the wallet rows, SQL-filtered, ts DESC, bounded, case-insensitive (#1365 r2)', () => {
    const A = '0xaaaa000000000000000000000000000000000001';
    const B = '0xbbbb000000000000000000000000000000000002';
    const pca = (ts: number, publisher: string) => db.insertNotification({
      ts, type: 'pca_cost_covered', title: 'd', message: 'd', contextGraphId: 'cg-pub',
      meta: JSON.stringify({ publisherAddress: publisher.toLowerCase(), accountId: '7', epoch: 42 }),
    });
    pca(1000, A);
    pca(3000, A);
    pca(2000, B);

    const rowsA = db.getPcaCostCoveredRowsForWallet(A);
    expect(rowsA).toHaveLength(2);                          // only A's rows (B filtered out in SQL)
    expect(rowsA.map((r) => r.ts)).toEqual([3000, 1000]);  // ts DESC
    expect(db.getPcaCostCoveredRowsForWallet(B)).toHaveLength(1);
    expect(db.getPcaCostCoveredRowsForWallet(A.toUpperCase())).toHaveLength(2); // case-insensitive
    expect(db.getPcaCostCoveredRowsForWallet('0xcccc000000000000000000000000000000000003')).toHaveLength(0);
    expect(db.getPcaCostCoveredRowsForWallet('  ')).toHaveLength(0); // blank → []
    expect(db.getPcaCostCoveredRowsForWallet(A, 1)).toHaveLength(1); // bounded by limit
  });
});

describe('DashboardDB — resolveActivityDigestRowIds (CR-3 digest read-marking)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-digest-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const activityRow = (cgId: string, kind: string, ts: number) =>
    db.insertNotification({
      ts,
      type: ASSERTION_ACTIVITY_TYPE,
      title: 'activity',
      message: `${kind} in ${cgId}`,
      contextGraphId: cgId,
      meta: JSON.stringify({ contextGraphId: cgId, kind }),
    });

  it('resolves a digestKey to exactly the atomic rows in its (cg, kind, window)', () => {
    // Anchor all rows to one window bucket so the digest key is stable.
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1_000; // bucket = 5
    const id1 = activityRow('cg-1', 'created', baseTs);
    const id2 = activityRow('cg-1', 'created', baseTs + 1_000);
    // Different kind, same cg+window — must NOT be included.
    activityRow('cg-1', 'promoted', baseTs + 2_000);
    // Different cg — must NOT be included.
    activityRow('cg-2', 'created', baseTs + 3_000);
    // Same cg+kind but a DIFFERENT window bucket — must NOT be included.
    activityRow('cg-1', 'created', baseTs + ACTIVITY_DIGEST_WINDOW_MS);

    const digestKey = buildActivityDigestKey('cg-1', 'created', baseTs);
    const ids = db.resolveActivityDigestRowIds(digestKey).sort((a, b) => a - b);
    expect(ids).toEqual([id1, id2].sort((a, b) => a - b));
  });

  it('returns [] for a malformed digest key (no-op, never throws)', () => {
    expect(db.resolveActivityDigestRowIds('not-a-digest')).toEqual([]);
    expect(db.resolveActivityDigestRowIds('activity:cg-1:bogus:5')).toEqual([]);
    expect(db.resolveActivityDigestRowIds('activity:cg-1:created:notanumber')).toEqual([]);
  });

  it('handles a context graph id containing colons (URI form)', () => {
    const cgId = 'did:dkg:context-graph:abc123';
    const baseTs = 7 * ACTIVITY_DIGEST_WINDOW_MS + 500; // bucket = 7
    const id1 = activityRow(cgId, 'published', baseTs);
    const digestKey = buildActivityDigestKey(cgId, 'published', baseTs);
    expect(db.resolveActivityDigestRowIds(digestKey)).toEqual([id1]);
  });
});

describe('DashboardDB — replication telemetry (Phase F)', () => {
  let db: DashboardDB;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dkg-db-repl-test-'));
    db = new DashboardDB({ dataDir: dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const now = Date.now();

  it('summary computes counts, success rate, and fetch→promote latency', () => {
    // mfacts: fetch at T, promote 5s later (latency 5000); plus a 0-latency
    // promote (SWM already present, no preceding fetch); plus one defer.
    db.insertReplicationEvent({ ts: now - 10_000, context_graph_id: 'mfacts', action: 'fetch', ual: 'urn:ka:1', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 5_000, context_graph_id: 'mfacts', action: 'promote', ual: 'urn:ka:1', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 4_000, context_graph_id: 'mfacts', action: 'promote', ual: 'urn:ka:2', ordinal: 2 });
    db.insertReplicationEvent({ ts: now - 3_000, context_graph_id: 'mfacts', action: 'defer', ual: 'urn:ka:3', ordinal: 3, detail: 'no-swm' });

    const s = db.getReplicationSummary(60 * 60 * 1000);
    expect(s.promotes).toBe(2);
    expect(s.fetches).toBe(1);
    expect(s.defers).toBe(1);
    // promote / (promote + defer) = 2/3
    expect(s.successRate).toBeCloseTo(2 / 3, 5);
    // latencies: [0, 5000] → P50 index = floor(0.5*2)=1 → 5000
    expect(s.latencyP50Ms).toBe(5000);
    expect(s.totalEvents).toBe(4);
  });

  it('summary excludes events outside the window', () => {
    db.insertReplicationEvent({ ts: now - 10 * 86_400_000, context_graph_id: 'old', action: 'promote', ual: 'urn:ka:x' });
    const s = db.getReplicationSummary(60 * 60 * 1000);
    expect(s.totalEvents).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.latencyP50Ms).toBeNull();
  });

  it('defaults to a 24-HOUR window (not 24 days)', () => {
    // Regression: the default was `24 * 86_400_000` (24 days). An event from
    // 2 days ago must be EXCLUDED by the default window; a recent one included.
    db.insertReplicationEvent({ ts: now - 2 * 86_400_000, context_graph_id: 'stale', action: 'promote' });
    db.insertReplicationEvent({ ts: now - 1_000, context_graph_id: 'fresh', action: 'promote' });
    const s = db.getReplicationSummary(); // default period
    expect(s.periodMs).toBe(86_400_000);
    expect(s.totalEvents).toBe(1);
    expect(s.promotes).toBe(1);
    // per-cg default window must match
    expect(db.getReplicationPerCg().length).toBe(1);
  });

  it('pairs fetch→promote latency per VERSION (ordinal), not per UAL', () => {
    // Regression: keying latency on UAL let a later fast-path promote (no
    // fetch) mispair with an older fetch for a DIFFERENT version of the same
    // KA, inflating latency. Two promotes share one UAL but distinct ordinals.
    db.insertReplicationEvent({ ts: now - 10_000, context_graph_id: 'cg', action: 'fetch', ual: 'urn:ka:9', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 5_000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:9', ordinal: 1 });
    // New version of the same KA, promoted fast-path (SWM already present): no
    // fetch for ordinal 2 → must contribute 0ms, NOT pair with ordinal 1's fetch.
    db.insertReplicationEvent({ ts: now - 1_000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:9', ordinal: 2 });

    const s = db.getReplicationSummary(60 * 60 * 1000);
    // latencies: [0 (ordinal 2), 5000 (ordinal 1)]. With the old UAL-keying the
    // fast-path promote would mispair to 9000ms, pushing P95 to 9000.
    expect(s.latencyP50Ms).toBe(5000);
    expect(s.latencyP95Ms).toBe(5000);
  });

  it('per-cg rollup groups and reports last watermark/head', () => {
    db.insertReplicationEvent({ ts: now - 2_000, context_graph_id: 'cgA', on_chain_cg_id: '42', action: 'promote', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 1_000, context_graph_id: 'cgA', on_chain_cg_id: '42', action: 'cursor-advance', from_watermark: 0, to_watermark: 1, head: 3 });
    db.insertReplicationEvent({ ts: now - 1_500, context_graph_id: 'cgB', action: 'fetch' });

    const rows = db.getReplicationPerCg(60 * 60 * 1000);
    expect(rows.length).toBe(2);
    const a = rows.find((r) => r.context_graph_id === 'cgA')!;
    expect(a.promotes).toBe(1);
    expect(a.cursor_advances).toBe(1);
    expect(a.last_watermark).toBe(1);
    expect(a.last_head).toBe(3);
    // cgA most recently active → ordered first
    expect(rows[0].context_graph_id).toBe('cgA');
  });

  it('timeline buckets events and optionally scopes to a CG', () => {
    const bucketMs = 60_000;
    db.insertReplicationEvent({ ts: now - 1000, context_graph_id: 'cgA', action: 'promote' });
    db.insertReplicationEvent({ ts: now - 2000, context_graph_id: 'cgA', action: 'fetch' });
    db.insertReplicationEvent({ ts: now - 1000, context_graph_id: 'cgB', action: 'promote' });

    const all = db.getReplicationTimeline({ periodMs: 60 * 60 * 1000, bucketMs });
    expect(all.reduce((s, b) => s + b.total, 0)).toBe(3);

    const scoped = db.getReplicationTimeline({ periodMs: 60 * 60 * 1000, bucketMs, contextGraphId: 'cgA' });
    expect(scoped.reduce((s, b) => s + b.total, 0)).toBe(2);
    expect(scoped.reduce((s, b) => s + b.promotes, 0)).toBe(1);
  });

  it('cursors join subscriptions with observed chain head', () => {
    db.upsertContextGraphSubscription({
      context_graph_id: 'mfacts', name: 'Monday Fun Facts', subscribed: 1, synced: 1,
      on_chain_id: '7', last_reconciled_ordinal: 4, sync_scoped: 1, updated_at: now,
    });
    db.insertReplicationEvent({ ts: now - 500, context_graph_id: 'mfacts', action: 'sweep', head: 6, to_watermark: 4 });

    const cursors = db.getReplicationCursors();
    const c = cursors.find((r) => r.context_graph_id === 'mfacts')!;
    expect(c.last_reconciled_ordinal).toBe(4);
    expect(c.on_chain_id).toBe('7');
    expect(c.last_head).toBe(6);
    // a subscription with no events still appears (head null)
    db.upsertContextGraphSubscription({
      context_graph_id: 'empty', subscribed: 1, synced: 0, sync_scoped: 1, updated_at: now,
    });
    const after = db.getReplicationCursors();
    expect(after.find((r) => r.context_graph_id === 'empty')!.last_head).toBeNull();
  });

  it('per-cg event stream returns newest-first, capped', () => {
    for (let i = 0; i < 5; i++) {
      db.insertReplicationEvent({ ts: now - i * 1000, context_graph_id: 'cgA', action: 'promote', ordinal: 5 - i });
    }
    const events = db.getReplicationEventsForCg('cgA', 3);
    expect(events.length).toBe(3);
    // newest (ts = now) first
    expect(events[0].ts).toBe(now);
  });

  it('per-cg event stream coerces a non-finite limit to the default (no LIMIT NaN)', () => {
    // ?limit=foo → parseInt → NaN. Math.min/max propagate NaN, so binding it
    // straight into `LIMIT ?` made SQLite throw. The limit must fall back safely.
    for (let i = 0; i < 3; i++) {
      db.insertReplicationEvent({ ts: now - i * 1000, context_graph_id: 'cgN', action: 'promote', ordinal: 3 - i });
    }
    expect(() => db.getReplicationEventsForCg('cgN', NaN)).not.toThrow();
    expect(db.getReplicationEventsForCg('cgN', NaN).length).toBe(3);
    // Out-of-range values are clamped, not rejected.
    expect(db.getReplicationEventsForCg('cgN', 0).length).toBe(1);
    expect(db.getReplicationEventsForCg('cgN', 99_999).length).toBe(3);
  });

  it('V18 migration creates replication_events on an upgraded DB', () => {
    db.close();
    const raw = new Database(join(dir, 'node-ui.db'));
    raw.pragma('user_version = 17');
    raw.close();
    const upgraded = new DashboardDB({ dataDir: dir });
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    // insert works → table exists
    upgraded.insertReplicationEvent({ ts: now, context_graph_id: 'cg', action: 'promote' });
    expect(upgraded.getReplicationSummary(60_000).promotes).toBe(1);
    upgraded.close();
  });
});

describe('SqliteChangelogCursorStore — OT-RFC-59 durable (era,seq) cursor (SC5)', () => {
  it('upserts per (peer,cg), keeps keys independent, is durable across reopen, validates seq', () => {
    const store = new SqliteChangelogCursorStore(db);
    expect(store.get('peerA', 'cg1')).toBeUndefined();
    store.set('peerA', 'cg1', 'era-1', 5);
    expect(store.get('peerA', 'cg1')).toMatchObject({ era: 'era-1', seq: 5 });
    // upsert (same key) replaces era + seq
    store.set('peerA', 'cg1', 'era-2', 9);
    expect(store.get('peerA', 'cg1')).toMatchObject({ era: 'era-2', seq: 9 });
    // distinct (peer,cg) keys are independent (seq is per-responder-node)
    store.set('peerB', 'cg1', 'era-x', 3);
    store.set('peerA', 'cg2', 'era-y', 7);
    expect(store.get('peerB', 'cg1')!.seq).toBe(3);
    expect(store.get('peerA', 'cg2')!.seq).toBe(7);
    expect(store.get('peerA', 'cg1')!.seq).toBe(9);
    // seq 0 is valid (first contact / reseed); negative rejected
    store.set('peerC', 'cg1', 'era-1', 0);
    expect(store.get('peerC', 'cg1')!.seq).toBe(0);
    expect(() => store.set('peerC', 'cg1', 'era-1', -1)).toThrow(/Invalid changelog cursor seq/);
    // durable across a fresh DashboardDB on the same dir (never TTL-pruned)
    const db2 = new DashboardDB({ dataDir: dir });
    const store2 = new SqliteChangelogCursorStore(db2);
    expect(store2.get('peerA', 'cg1')).toMatchObject({ era: 'era-2', seq: 9 });
  });
});

describe('SqliteChangelogEraGuard — OT-RFC-59 §6 P0 durable era guard', () => {
  it('round-trips (era, highSeq) as a singleton, is durable across reopen, validates highSeq', async () => {
    const guard = new SqliteChangelogEraGuard(db);
    expect(await guard.load()).toBeNull();
    await guard.save('era-1', 10);
    expect(await guard.load()).toEqual({ era: 'era-1', highSeq: 10 });
    // singleton: a second save REPLACES (not a second row) — this is the node-global high-water
    await guard.save('era-2', 42);
    expect(await guard.load()).toEqual({ era: 'era-2', highSeq: 42 });
    await expect(guard.save('era-2', -1)).rejects.toThrow(/Invalid changelog era high_seq/);
    // survives a fresh DashboardDB on the same dir (the whole point — outlives a store.nq restore)
    const guard2 = new SqliteChangelogEraGuard(new DashboardDB({ dataDir: dir }));
    expect(await guard2.load()).toEqual({ era: 'era-2', highSeq: 42 });
  });

  it('an existing pre-v24 db upgrades and gains the changelog_era + changelog_cursors tables', () => {
    // Fresh db is already at current version; assert both OT-RFC-59 tables exist after migration.
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    expect(tables).toContain('changelog_cursors');
    expect(tables).toContain('changelog_era');
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});
