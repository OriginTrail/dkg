import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

/**
 * Real-node INTEGRATION test for the dashboard replication rollups
 * (`/api/replication/summary | per-cg | timeline`), served by the live daemon
 * via handleNodeUIRequest + a real DashboardDB.
 *
 * The memo's OBSERVABLE caching behaviour (hit, TTL expiry, per-window keying,
 * bypass, disable, defensive-copy) is proven deterministically in the unit suite
 * `packages/node-ui/test/replication-cache.test.ts`. This test proves the live
 * HTTP WIRING: with real seeded telemetry it returns NON-EMPTY, internally
 * consistent payloads, and stays correct under rapid concurrent polling.
 *
 * The daemon is started with the memo DISABLED (`DKG_DASHBOARD_CACHE_TTL_MS=0`)
 * so rows seeded directly into its `node-ui.db` are immediately visible over
 * HTTP — i.e. we assert non-zero counts, not just empty-payload shape. Runs in
 * the Bura: cli lane.
 */
describe('daemon /api/replication/* (real node, seeded telemetry)', () => {
  let daemon: LiveDaemon | undefined;
  let prevTtlEnv: string | undefined;

  beforeAll(async () => {
    // Disable the rollup memo in the spawned daemon (inherits process.env via the
    // helper) so freshly-seeded rows are visible on the very next read.
    prevTtlEnv = process.env.DKG_DASHBOARD_CACHE_TTL_MS;
    process.env.DKG_DASHBOARD_CACHE_TTL_MS = '0';
    daemon = await startLiveDaemon({ authEnabled: true });

    // Seed replication telemetry straight into the daemon's node-ui.db (same
    // file the daemon serves from; dkgDir() === DKG_HOME === daemon.home here).
    // There is no HTTP route to insert replication_events, so we write directly.
    const seed = new DashboardDB({ dataDir: daemon.home });
    try {
      const now = Date.now();
      seed.insertReplicationEvent({ ts: now - 10_000, context_graph_id: 'seedcg', action: 'fetch', ual: 'urn:ka:seed', ordinal: 1 });
      seed.insertReplicationEvent({ ts: now - 5_000, context_graph_id: 'seedcg', action: 'promote', ual: 'urn:ka:seed', ordinal: 1 });
      seed.insertReplicationEvent({ ts: now - 4_000, context_graph_id: 'seedcg', action: 'promote', ual: 'urn:ka:seed2', ordinal: 2 });
    } finally {
      seed.close();
    }
  }, 90_000);

  afterAll(async () => {
    // Restore the env var even if daemon shutdown throws/times out, so a leaked
    // TTL=0 can't change caching behaviour for later tests in this worker.
    try {
      await stopLiveDaemon(daemon);
    } finally {
      if (prevTtlEnv === undefined) delete process.env.DKG_DASHBOARD_CACHE_TTL_MS;
      else process.env.DKG_DASHBOARD_CACHE_TTL_MS = prevTtlEnv;
    }
  }, 30_000);

  async function getJson(d: LiveDaemon, path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${d.base}${path}`, { headers: authHeaders(d) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  it('exposes the seeded telemetry (non-empty, internally consistent) over HTTP', async () => {
    const d = daemon!;

    const summary = await getJson(d, '/api/replication/summary?periodMs=86400000');
    expect(summary.status).toBe(200);
    // Non-zero: would still pass with empty payload before seeding, so this is
    // the assertion that proves the daemon wiring actually surfaces telemetry.
    expect(summary.body.totalEvents).toBeGreaterThanOrEqual(3);
    expect(summary.body.counts.promote).toBeGreaterThanOrEqual(2);
    expect(summary.body.counts.fetch).toBeGreaterThanOrEqual(1);
    // Internal consistency: totalEvents == sum of action counts.
    const countSum = Object.values(summary.body.counts as Record<string, number>).reduce((s, n) => s + n, 0);
    expect(summary.body.totalEvents).toBe(countSum);

    const perCg = await getJson(d, '/api/replication/per-cg?periodMs=86400000');
    expect(perCg.status).toBe(200);
    expect(Array.isArray(perCg.body.rows)).toBe(true);
    expect(perCg.body.rows.some((r: any) => r.context_graph_id === 'seedcg')).toBe(true);

    const timeline = await getJson(d, '/api/replication/timeline?periodMs=86400000&bucketMs=3600000');
    expect(timeline.status).toBe(200);
    expect(Array.isArray(timeline.body.buckets)).toBe(true);
    const timelineTotal = timeline.body.buckets.reduce((s: number, b: any) => s + (b.total ?? 0), 0);
    expect(timelineTotal).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('stays correct and consistent under rapid concurrent polling', async () => {
    const d = daemon!;
    const calls = await Promise.all(
      Array.from({ length: 10 }, () => getJson(d, '/api/replication/summary?periodMs=86400000')),
    );
    expect(calls.every((c) => c.status === 200)).toBe(true);
    expect(calls.every((c) => c.body?.totalEvents >= 3)).toBe(true);
    const serialized = new Set(calls.map((c) => JSON.stringify(c.body)));
    expect(serialized.size).toBe(1); // identical payload across all concurrent polls
  }, 30_000);
});
