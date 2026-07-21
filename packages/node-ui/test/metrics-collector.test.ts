import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  it('uses the supported 30-second system and 12-hour store defaults', () => {
    const collector = new MetricsCollector(db, mockSource(), dir);
    expect(collector.collectionIntervalMs).toBe(30_000);
    expect(collector.storeCollectionIntervalMs).toBe(43_200_000);
  });

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
    expect(snap.contextGraph_count).toBe(2);
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

  it('start is idempotent — a second start() does not launch another initial collection', async () => {
    let calls = 0;
    const collector = new MetricsCollector(db, mockSource({
      getStoreBytes: async () => { calls++; return 65_536; },
    }), dir);
    collector.start();
    collector.start();
    await new Promise(r => setTimeout(r, 100));
    expect(calls).toBe(1);

    collector.stop();
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

  // ─── PR2: Relay observability ────────────────────────────────────
  //
  // The relay-server columns (relay_capacity, relay_reservation_count,
  // relay_active_circuits, relay_bytes_in, relay_bytes_out) are NULL
  // on edge nodes (sources without `getRelayStats`) and populated
  // from the source on Core Nodes. These tests pin the contract.

  describe('relay-stats integration', () => {
    it('omits getRelayStats on edge sources → all relay_* columns null', async () => {
      const collector = new MetricsCollector(db, mockSource(), dir);
      const snap = await collector.collect();
      expect(snap.relay_capacity).toBeNull();
      expect(snap.relay_reservation_count).toBeNull();
      expect(snap.relay_active_circuits).toBeNull();
      expect(snap.relay_bytes_in).toBeNull();
      expect(snap.relay_bytes_out).toBeNull();
    });

    it('passes through relay snapshot when source provides it (Core Node path)', async () => {
      const collector = new MetricsCollector(
        db,
        mockSource({
          getRelayStats: () => ({
            capacity: 1024,
            reservationCount: 42,
            activeCircuits: 17,
            bytesIn: 123_456_789n,
            bytesOut: 987_654_321n,
          }),
        }),
        dir,
      );
      const snap = await collector.collect();
      expect(snap.relay_capacity).toBe(1024);
      expect(snap.relay_reservation_count).toBe(42);
      expect(snap.relay_active_circuits).toBe(17);
      expect(snap.relay_bytes_in).toBe(123_456_789);
      expect(snap.relay_bytes_out).toBe(987_654_321);
    });

    it('returns null relay columns when source.getRelayStats() returns null (edge tier)', async () => {
      const collector = new MetricsCollector(
        db,
        mockSource({ getRelayStats: () => null }),
        dir,
      );
      const snap = await collector.collect();
      expect(snap.relay_capacity).toBeNull();
      expect(snap.relay_reservation_count).toBeNull();
      expect(snap.relay_active_circuits).toBeNull();
    });

    it('clamps oversized bigint byte totals to MAX_SAFE_INTEGER (defence in depth)', async () => {
      // 9 PB ≈ 9.0e15 fits MAX_SAFE_INTEGER (9.007e15) but 10 PB doesn't.
      // The clamp guarantees SQLite gets a finite Number even in the
      // pathological "relay forwarded EB-scale traffic in one
      // retention window" case. If you ever see this value in
      // production, the snapshot column representation should
      // switch to deltas — see the helper docstring.
      const collector = new MetricsCollector(
        db,
        mockSource({
          getRelayStats: () => ({
            capacity: 1024,
            reservationCount: 1,
            activeCircuits: 1,
            bytesIn: BigInt(Number.MAX_SAFE_INTEGER) + 1_000_000n,
            bytesOut: 0n,
          }),
        }),
        dir,
      );
      const snap = await collector.collect();
      expect(snap.relay_bytes_in).toBe(Number.MAX_SAFE_INTEGER);
      expect(snap.relay_bytes_out).toBe(0);
    });

    it('persists relay columns through insertSnapshot → getLatestSnapshot round-trip (schema v10)', async () => {
      const collector = new MetricsCollector(
        db,
        mockSource({
          getRelayStats: () => ({
            capacity: 512,
            reservationCount: 7,
            activeCircuits: 3,
            bytesIn: 2_048n,
            bytesOut: 4_096n,
          }),
        }),
        dir,
      );
      await collector.collectAndStore();

      const stored = db.getLatestSnapshot();
      expect(stored).toBeDefined();
      expect(stored!.relay_capacity).toBe(512);
      expect(stored!.relay_reservation_count).toBe(7);
      expect(stored!.relay_active_circuits).toBe(3);
      expect(stored!.relay_bytes_in).toBe(2_048);
      expect(stored!.relay_bytes_out).toBe(4_096);
    });

    it('isolates relay-source errors — non-relay metrics still ship', async () => {
      const collector = new MetricsCollector(
        db,
        mockSource({
          getRelayStats: () => {
            throw new Error('relay service exploded');
          },
        }),
        dir,
      );
      const snap = await collector.collect();
      // Non-relay metrics survive the error path.
      expect(snap.peer_count).toBe(5);
      expect(snap.total_triples).toBe(1000);
      // Relay columns end up NULL because the source threw.
      expect(snap.relay_capacity).toBeNull();
      expect(snap.relay_bytes_in).toBeNull();
    });
  });
});

describe('MetricsCollector scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the initial collection immediately, before an interval elapses', async () => {
    let calls = 0;
    const collector = new MetricsCollector(
      db,
      mockSource({ getStoreBytes: async () => { calls++; return 65_536; } }),
      undefined,
      () => true,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 5_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toBe(1);
    expect(db.getLatestSnapshot()).toBeDefined();
    collector.stop();
  });

  it('keeps cheap snapshots frequent while store scans use their slower cadence', async () => {
    let cheapCalls = 0;
    let storeCalls = 0;
    const collector = new MetricsCollector(
      db,
      mockSource({
        getPeerCount: () => { cheapCalls++; return 5; },
        getTotalTriples: async () => { storeCalls++; return 1_000; },
      }),
      undefined,
      () => true,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 5_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(storeCalls).toBe(1); // documented immediate startup attempt

    await vi.advanceTimersByTimeAsync(4_000);
    expect(cheapCalls).toBe(5);
    expect(storeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cheapCalls).toBe(6);
    expect(storeCalls).toBe(2);
    collector.stop();
  });

  it('honors a 12-hour store interval after the documented initial scan', async () => {
    let storeCalls = 0;
    const twelveHours = 43_200_000;
    const collector = new MetricsCollector(
      db,
      mockSource({
        getTotalTriples: async () => { storeCalls++; return 1_000; },
      }),
      undefined,
      () => true,
      { collectionIntervalMs: twelveHours, storeCollectionIntervalMs: twelveHours },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(storeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(twelveHours - 1);
    expect(storeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(storeCalls).toBe(2);
    collector.stop();
  });

  it('never overlaps collection when a tick takes longer than its interval', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const collector = new MetricsCollector(
      db,
      mockSource({
        getStoreBytes: async () => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>(resolve => releases.push(resolve));
          active--;
          return 65_536;
        },
      }),
      undefined,
      () => true,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 1_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);

    collector.stop();
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('continues cheap snapshots while a slow store scan remains serialized', async () => {
    let cheapCalls = 0;
    let storeCalls = 0;
    let activeStoreCalls = 0;
    let maxActiveStoreCalls = 0;
    const releases: Array<() => void> = [];
    const collector = new MetricsCollector(
      db,
      mockSource({
        getPeerCount: () => { cheapCalls++; return 5; },
        getTotalTriples: async () => {
          storeCalls++;
          activeStoreCalls++;
          maxActiveStoreCalls = Math.max(maxActiveStoreCalls, activeStoreCalls);
          await new Promise<void>(resolve => releases.push(resolve));
          activeStoreCalls--;
          return 1_000;
        },
      }),
      undefined,
      () => true,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 1_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(storeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cheapCalls).toBe(6); // immediate + five one-second system ticks
    expect(storeCalls).toBe(1);
    expect(maxActiveStoreCalls).toBe(1);

    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storeCalls).toBe(2);
    expect(maxActiveStoreCalls).toBe(1);

    collector.stop();
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stop during an active collection prevents every future tick', async () => {
    let calls = 0;
    let release!: () => void;
    const collector = new MetricsCollector(
      db,
      mockSource({
        getStoreBytes: async () => {
          calls++;
          await new Promise<void>(resolve => { release = resolve; });
          return 65_536;
        },
      }),
      undefined,
      () => true,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 1_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    collector.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBe(1);
    const internal = collector as unknown as {
      systemTimer: ReturnType<typeof setTimeout> | null;
      storeTimer: ReturnType<typeof setTimeout> | null;
    };
    expect(internal.systemTimer).toBeNull();
    expect(internal.storeTimer).toBeNull();
  });

  it('keeps probing the presence gate cheaply and scans when a consumer appears', async () => {
    let watching = false;
    let storeCalls = 0;
    const collector = new MetricsCollector(
      db,
      mockSource({
        getTotalTriples: async () => { storeCalls++; return 1_000; },
      }),
      undefined,
      () => watching,
      { collectionIntervalMs: 1_000, storeCollectionIntervalMs: 5_000 },
    );

    collector.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storeCalls).toBe(0);

    watching = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storeCalls).toBe(1);
    collector.stop();
  });
});

// ─── #1066 Item 1: store-metrics presence gate ──────────────────────
//
// The six store getters (total triples + KC/KA/confirmed/tentative +
// context-graph count) are full-store SPARQL scans. When nothing is
// consuming metrics the collector skips them, leaving those columns null,
// while the cheap system/network metrics keep flowing.
describe('MetricsCollector store-metrics presence gate', () => {
  function countingSource() {
    const calls = {
      getContextGraphCount: 0, getTotalTriples: 0, getTotalKCs: 0,
      getTotalKAs: 0, getConfirmedKCs: 0, getTentativeKCs: 0,
      getStoreBytes: 0, getPeerCount: 0,
    };
    const source: MetricsSource = {
      getPeerCount: () => { calls.getPeerCount++; return 5; },
      getDirectPeerCount: () => 3,
      getRelayedPeerCount: () => 2,
      getMeshPeerCount: () => 4,
      getContextGraphCount: async () => { calls.getContextGraphCount++; return 2; },
      getTotalTriples: async () => { calls.getTotalTriples++; return 1000; },
      getTotalKCs: async () => { calls.getTotalKCs++; return 15; },
      getTotalKAs: async () => { calls.getTotalKAs++; return 30; },
      getConfirmedKCs: async () => { calls.getConfirmedKCs++; return 12; },
      getTentativeKCs: async () => { calls.getTentativeKCs++; return 3; },
      getStoreBytes: async () => { calls.getStoreBytes++; return 65536; },
      getRpcLatencyMs: async () => 25,
      isRpcHealthy: async () => true,
    };
    return { source, calls };
  }

  it('closed gate: skips the six store scans and nulls their columns; cheap metrics still collect', async () => {
    const { source, calls } = countingSource();
    const collector = new MetricsCollector(db, source, dir, () => false);
    const snap = await collector.collect();

    // None of the full-store scans ran.
    expect(calls.getTotalTriples).toBe(0);
    expect(calls.getTotalKCs).toBe(0);
    expect(calls.getTotalKAs).toBe(0);
    expect(calls.getConfirmedKCs).toBe(0);
    expect(calls.getTentativeKCs).toBe(0);
    expect(calls.getContextGraphCount).toBe(0);

    // Their columns are null.
    expect(snap.total_triples).toBeNull();
    expect(snap.total_kcs).toBeNull();
    expect(snap.total_kas).toBeNull();
    expect(snap.confirmed_kcs).toBeNull();
    expect(snap.tentative_kcs).toBeNull();
    expect(snap.contextGraph_count).toBeNull();

    // Cheap system/network metrics still collected (a CPU peg is still
    // recorded even with no dashboard open). getStoreBytes is a cheap stat,
    // not a SPARQL scan, so it is NOT gated.
    expect(calls.getPeerCount).toBeGreaterThan(0);
    expect(snap.peer_count).toBe(5);
    expect(snap.mem_used_bytes).toBeGreaterThan(0);
    expect(calls.getStoreBytes).toBe(1);
    expect(snap.store_bytes).toBe(65536);
  });

  it('open gate: runs the store getters', async () => {
    const { source, calls } = countingSource();
    const collector = new MetricsCollector(db, source, dir, () => true);
    const snap = await collector.collect();

    expect(calls.getTotalTriples).toBe(1);
    expect(calls.getContextGraphCount).toBe(1);
    expect(snap.total_triples).toBe(1000);
    expect(snap.contextGraph_count).toBe(2);
  });

  it('no gate supplied: collects store metrics by default (back-compat)', async () => {
    const { source, calls } = countingSource();
    const collector = new MetricsCollector(db, source, dir);
    const snap = await collector.collect();

    expect(calls.getTotalTriples).toBe(1);
    expect(snap.total_triples).toBe(1000);
  });

  it('re-evaluates the gate every tick (idle → active resumes store metrics)', async () => {
    const { source, calls } = countingSource();
    let watching = false;
    const collector = new MetricsCollector(db, source, dir, () => watching);

    const idle = await collector.collect();
    expect(idle.total_triples).toBeNull();
    expect(calls.getTotalTriples).toBe(0);

    watching = true;
    const active = await collector.collect();
    expect(active.total_triples).toBe(1000);
    expect(calls.getTotalTriples).toBe(1);
  });
});
