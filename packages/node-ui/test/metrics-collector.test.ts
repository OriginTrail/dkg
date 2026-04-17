import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import { MetricsCollector, type MetricsSource } from '../src/metrics-collector.js';

let db: DashboardDB;
let dir: string;

function mockSource(overrides: Partial<MetricsSource> = {}): MetricsSource {
  return {
    getPeerCount: () => 5,
    getDirectPeerCount: () => 3,
    getRelayedPeerCount: () => 2,
    getMeshPeerCount: () => 4,
    getContextGraphCount: async () => 2,
    getTotalTriples: async () => 1000,
    getTotalKCs: async () => 15,
    getTotalKAs: async () => 30,
    getConfirmedKCs: async () => 12,
    getTentativeKCs: async () => 3,
    getStoreBytes: async () => 65536,
    getRpcLatencyMs: async () => 25,
    isRpcHealthy: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-metrics-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MetricsCollector', () => {
  it('collects a snapshot with all metrics', async () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    const snap = await collector.collect();

    expect(snap.ts).toBeGreaterThan(0);
    expect(snap.cpu_percent).toBeTypeOf('number');
    expect(snap.mem_used_bytes).toBeGreaterThan(0);
    expect(snap.mem_total_bytes).toBeGreaterThan(0);
    expect(snap.heap_used_bytes).toBeGreaterThan(0);
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(snap.peer_count).toBe(5);
    expect(snap.direct_peers).toBe(3);
    expect(snap.relayed_peers).toBe(2);
    expect(snap.mesh_peers).toBe(4);
    expect(snap.paranet_count).toBe(2);
    expect(snap.total_triples).toBe(1000);
    expect(snap.total_kcs).toBe(15);
    expect(snap.total_kas).toBe(30);
    expect(snap.confirmed_kcs).toBe(12);
    expect(snap.tentative_kcs).toBe(3);
    expect(snap.store_bytes).toBe(65536);
    expect(snap.rpc_latency_ms).toBe(25);
    expect(snap.rpc_healthy).toBe(1);
  });

  it('stores collected snapshot in the database', async () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    await collector.collectAndStore();

    const stored = db.getLatestSnapshot();
    expect(stored).toBeDefined();
    expect(stored!.peer_count).toBe(5);
    expect(stored!.total_triples).toBe(1000);
  });

  it('gracefully handles source errors', async () => {
    const broken: MetricsSource = {
      getPeerCount: () => 1,
      getDirectPeerCount: () => 1,
      getRelayedPeerCount: () => 0,
      getMeshPeerCount: () => 0,
      getContextGraphCount: async () => { throw new Error('db locked'); },
      getTotalTriples: async () => { throw new Error('store error'); },
      getTotalKCs: async () => { throw new Error('fail'); },
      getTotalKAs: async () => { throw new Error('fail'); },
      getConfirmedKCs: async () => { throw new Error('fail'); },
      getTentativeKCs: async () => { throw new Error('fail'); },
      getStoreBytes: async () => { throw new Error('fail'); },
      getRpcLatencyMs: async () => { throw new Error('fail'); },
      isRpcHealthy: async () => { throw new Error('fail'); },
    };

    const collector = new MetricsCollector(db, broken, dir);
    const snap = await collector.collect();

    expect(snap.peer_count).toBe(1);
    expect(snap.total_triples).toBeNull();
    expect(snap.total_kcs).toBeNull();
    expect(snap.rpc_latency_ms).toBeNull();
    expect(snap.rpc_healthy).toBeNull();
    expect(snap.mem_used_bytes).toBeGreaterThan(0);
  });

  it('start and stop control the timer', async () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    collector.start();

    // Wait a beat for the initial collect
    await new Promise(r => setTimeout(r, 100));

    const snap = db.getLatestSnapshot();
    expect(snap).toBeDefined();

    collector.stop();
  });

  it('start is idempotent — a second start() does not allocate a second interval', () => {
    const collector = new MetricsCollector(db, mockSource(), dir);

    // Peek at the private timer handle through a narrow cast. Re-entrant
    // start() calls previously had no observable check; a regression that
    // fires `setInterval` twice would leak the first handle and silently
    // double the DB write rate. Comparing the timer reference before and
    // after the second start() locks in the "no second interval" contract.
    const internal = collector as unknown as { timer: ReturnType<typeof setInterval> | null };

    collector.start();
    const firstTimer = internal.timer;
    expect(firstTimer).not.toBeNull();

    collector.start();
    expect(internal.timer).toBe(firstTimer);

    collector.stop();
    expect(internal.timer).toBeNull();
  });

  it('cpu measurement returns 0 on first call (no baseline)', async () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    const snap = await collector.collect();
    expect(snap.cpu_percent).toBe(0);
  });

  it('cpu measurement returns a value on second call', async () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    await collector.collect();
    const snap2 = await collector.collect();
    expect(snap2.cpu_percent).toBeTypeOf('number');
    expect(snap2.cpu_percent).toBeGreaterThanOrEqual(0);
  });
});
