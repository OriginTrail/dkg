import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DashboardDB } from '../src/db.js';

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
    expect(db.db.pragma('user_version', { simple: true })).toBe(11);

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
  it('inserts and searches logs by level', () => {
    db.insertLog({ ts: 1000, level: 'info', module: 'Agent', message: 'started' });
    db.insertLog({ ts: 2000, level: 'error', module: 'Agent', message: 'something broke' });
    db.insertLog({ ts: 3000, level: 'info', module: 'Publisher', message: 'published' });

    const errors = db.searchLogs({ level: 'error' });
    expect(errors.logs).toHaveLength(1);
    expect(errors.logs[0].message).toBe('something broke');

    const all = db.searchLogs({});
    expect(all.total).toBe(3);
  });

  it('searches logs by operationId', () => {
    db.insertLog({ ts: 1000, level: 'info', operation_id: 'op-1', module: 'A', message: 'hello' });
    db.insertLog({ ts: 2000, level: 'info', operation_id: 'op-2', module: 'A', message: 'world' });

    const result = db.searchLogs({ operationId: 'op-1' });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].message).toBe('hello');
  });

  it('supports full-text search', () => {
    db.insertLog({ ts: 1000, level: 'info', module: 'A', message: 'merkle root verified successfully' });
    db.insertLog({ ts: 2000, level: 'info', module: 'A', message: 'connection established' });
    db.insertLog({ ts: 3000, level: 'error', module: 'A', message: 'merkle root mismatch detected' });

    const result = db.searchLogs({ q: 'merkle' });
    expect(result.total).toBe(2);
    expect(result.logs.every((l: any) => l.message.includes('merkle'))).toBe(true);
  });

  it('filters by time range', () => {
    db.insertLog({ ts: 1000, level: 'info', module: 'A', message: 'early' });
    db.insertLog({ ts: 5000, level: 'info', module: 'A', message: 'middle' });
    db.insertLog({ ts: 9000, level: 'info', module: 'A', message: 'late' });

    const result = db.searchLogs({ from: 4000, to: 6000 });
    expect(result.total).toBe(1);
    expect(result.logs[0].message).toBe('middle');
  });

  it('paginates with limit and offset', () => {
    for (let i = 0; i < 20; i++) {
      db.insertLog({ ts: i * 1000, level: 'info', module: 'A', message: `log-${i}` });
    }

    const page1 = db.searchLogs({ limit: 5, offset: 0 });
    expect(page1.logs).toHaveLength(5);
    expect(page1.total).toBe(20);

    const page2 = db.searchLogs({ limit: 5, offset: 5 });
    expect(page2.logs).toHaveLength(5);
    expect(page2.logs[0].id).not.toBe(page1.logs[0].id);
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
  it('prunes data older than retention period', () => {
    const db2 = new DashboardDB({ dataDir: dir, retentionDays: 0 });

    db2.insertSnapshot({ ts: Date.now() - 100_000, cpu_percent: 10, mem_used_bytes: null, mem_total_bytes: null, disk_used_bytes: null, disk_total_bytes: null, heap_used_bytes: null, uptime_seconds: null, peer_count: null, direct_peers: null, relayed_peers: null, mesh_peers: null, contextGraph_count: null, total_triples: null, total_kcs: null, total_kas: null, store_bytes: null, confirmed_kcs: null, tentative_kcs: null, rpc_latency_ms: null, rpc_healthy: null, relay_capacity: null, relay_reservation_count: null, relay_active_circuits: null, relay_bytes_in: null, relay_bytes_out: null });
    db2.insertLog({ ts: Date.now() - 100_000, level: 'info', module: 'A', message: 'old' });
    db2.insertOperation({ operation_id: 'old-op', operation_name: 'query', started_at: Date.now() - 100_000 });

    db2.prune();

    expect(db2.getLatestSnapshot()).toBeUndefined();
    expect(db2.searchLogs({}).total).toBe(0);
    expect(db2.getOperations().total).toBe(0);

    db2.close();
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
    expect(db2.searchLogs({}).total).toBe(1);
    db2.close();
    db = new DashboardDB({ dataDir: dir });
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

// Receiver-side dedup by `message_id` — addresses the seq=13 duplicate
// class from the May 2026 Miles↔Lex 6h soak postmortem (same encrypted
// payload arrived on Miles's side twice ~1s apart and both rows were
// stored because there was no idempotency key). V11 adds the partial
// unique index `idx_chat_msgid ON (peer, direction, message_id)
// WHERE message_id IS NOT NULL`, and `insertChatMessage` switches to
// `INSERT OR IGNORE`. `direction` is in the key per Codex review of
// PR #534 so inbound + outbound rows from the same peer that happen
// to reuse a `messageId` (e.g. caller-supplied via MCP) don't collide.
describe('DashboardDB.insertChatMessage — V11 receiver-side dedup', () => {
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

  it('returns false and drops the row on duplicate (peer, messageId)', () => {
    db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'first', messageId: 'msg-1' });
    // Same peer + same messageId — receiver-side dedup must drop this.
    // The dropped insert may carry different `ts` / `text` (e.g. an
    // application-level retry that mutated the timestamp): the index
    // still recognises it as the same logical message because dedup
    // keys off `(peer, message_id)` only.
    const inserted = db.insertChatMessage({
      ts: 1500,
      direction: 'in',
      peer: 'alice',
      text: 'first-but-different-text',
      messageId: 'msg-1',
    });
    expect(inserted).toBe(false);
    const rows = db.getChatMessages({ peer: 'alice' });
    expect(rows).toHaveLength(1);
    // Original row is the survivor — partial-unique-index INSERT OR
    // IGNORE drops the second insert before any column is overwritten.
    expect(rows[0].text).toBe('first');
    expect(rows[0].ts).toBe(1000);
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

  // The dedup index includes `direction` (Codex review of PR #534
  // flagged the original `(peer, message_id)` shape as letting a
  // legitimate inbound message collide with an outbound row from
  // the same peer that reused the same id). Within ONE direction
  // the index still drops re-INSERTs of the same `(peer, dir, id)`:
  // current code paths only INSERT outbound rows once (via
  // `/api/chat`; retries reuse the row by design — they don't
  // re-INSERT), but this pin protects any future code path that
  // re-INSERTs from accidentally duplicating.
  it('dedup applies WITHIN one direction (outbound retry replays drop on the existing row)', () => {
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
    expect(replay).toBe(false);
    const rows = db.getChatMessages({ peer: 'alice', direction: 'out' });
    expect(rows).toHaveLength(1);
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
});

// Regression coverage for the V11 schema migration itself — analogous to
// the V10 metric_snapshots upgrade test above. Strategy: take the freshly
// created V11 db (full schema), simulate a pre-V11 baseline by dropping
// the `message_id` column AND the `idx_chat_msgid` index AND resetting
// `user_version` to 10, then reopen via DashboardDB and verify the
// upgrade restores both schema artefacts and that the dedup semantic
// kicks in on subsequent inserts.
describe('DashboardDB — V11 schema migration', () => {
  it('upgrades a pre-V11 chat_messages table by adding `message_id` + the partial unique index', () => {
    const dbPath = join(dir, 'node-ui.db');
    db.close();

    // Simulate pre-V11 state on disk.
    const raw = new Database(dbPath);
    raw.exec('DROP INDEX IF EXISTS idx_chat_msgid;');
    raw.exec('ALTER TABLE chat_messages DROP COLUMN message_id;');
    // Seed a pre-V11 row that has no message_id by definition. After
    // the upgrade this row must still be addressable AND must not
    // block future inserts (the partial index excludes NULL rows).
    // `ts` must be within the DashboardDB retention window (default
    // 14d) or the constructor's prune-on-open will sweep it before
    // the test can read it back.
    const preV11Ts = Date.now() - 60_000;
    raw.prepare(
      `INSERT INTO chat_messages (ts, direction, peer, text) VALUES (?, ?, ?, ?)`,
    ).run(preV11Ts, 'in', 'alice', 'pre-v11-row');
    raw.pragma('user_version = 10');
    raw.close();

    db = new DashboardDB({ dataDir: dir });
    expect(db.db.pragma('user_version', { simple: true })).toBe(11);

    const cols = (db.db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('message_id');

    const indexes = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_messages'").all() as Array<{ name: string }>)
      .map((i) => i.name);
    expect(indexes).toContain('idx_chat_msgid');

    const idxSql = (db.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_chat_msgid'")
      .get() as { sql: string }).sql;
    expect(idxSql).toMatch(/\bdirection\b/);
    expect(idxSql).toMatch(/WHERE\s+message_id\s+IS\s+NOT\s+NULL/i);

    // Pre-V11 row survives the migration with a NULL message_id.
    const pre = db.getChatMessages({ peer: 'alice' });
    expect(pre).toHaveLength(1);
    expect(pre[0].text).toBe('pre-v11-row');
    expect(pre[0].message_id).toBeNull();

    // V11 semantics kick in for new inserts.
    expect(
      db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'v11-a', messageId: 'm1' }),
    ).toBe(true);
    expect(
      db.insertChatMessage({ ts: 1000, direction: 'in', peer: 'alice', text: 'v11-a-dup', messageId: 'm1' }),
    ).toBe(false);
    expect(db.getChatMessages({ peer: 'alice' })).toHaveLength(2);
  });
});
