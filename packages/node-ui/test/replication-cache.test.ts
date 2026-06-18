import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB, type ReplicationTimelineBucket } from '../src/db.js';

const ENV_KEY = 'DKG_DASHBOARD_CACHE_TTL_MS';

let dir: string;
let db: DashboardDB | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-repl-cache-'));
  prevEnv = process.env[ENV_KEY];
});

afterEach(() => {
  vi.useRealTimers();
  db?.close();
  db = undefined;
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

// TTL is injected via the constructor option (no global env mutation needed).
function open(ttlMs: number): DashboardDB {
  return new DashboardDB({ dataDir: dir, cacheTtlMs: ttlMs });
}

function promote(d: DashboardDB, ts: number, cg: string, ord: number): void {
  d.insertReplicationEvent({ ts, context_graph_id: cg, action: 'promote', ual: `urn:ka:${ord}`, ordinal: ord });
}

const timelineTotal = (buckets: ReplicationTimelineBucket[]): number =>
  buckets.reduce((s, b) => s + (b.total ?? 0), 0);

describe('DashboardDB — replication rollup memo', () => {
  it('serves a cached summary within the TTL (does not re-scan on every poll)', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);

    promote(db, now - 500, 'cg', 2); // new event, but within TTL the poll stays cached
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
  });

  it('expires the cache after the TTL — a permanent cache would FAIL this', () => {
    // Deterministic via faked Date only (leaves real timers/native sqlite alone).
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    db = open(1000); // 1s TTL, 1h window (> TTL) so caching is active
    promote(db, t0 - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // computed + cached at t0

    promote(db, t0 - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // still within TTL → cached

    vi.setSystemTime(t0 + 1500); // advance past the 1s TTL
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // expired → recomputed
  });

  it('reflects fresh data immediately when caching is disabled (TTL <= 0)', () => {
    db = open(0);
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // no cache
  });

  it('keys the cache by window (a different periodMs is not served a stale value)', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 30 * 60_000, 'cg', 1); // inside 1h
    promote(db, now - 90 * 60_000, 'cg', 2); // only inside 2h
    expect(db.getReplicationSummary(60 * 60_000).totalEvents).toBe(1);
    expect(db.getReplicationSummary(2 * 60 * 60_000).totalEvents).toBe(2); // distinct key
  });

  it('only caches when the window is comfortably (>=10x) larger than the TTL', () => {
    db = open(60_000); // TTL 60s → caches only when window > 600s (10x)
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);

    // window 500s (< 10x TTL) → bypass → always fresh
    expect(db.getReplicationSummary(500_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(500_000).totalEvents).toBe(2);

    // window 700s (> 10x TTL) → cache
    expect(db.getReplicationSummary(700_000).totalEvents).toBe(2);
    promote(db, now - 250, 'cg', 3);
    expect(db.getReplicationSummary(700_000).totalEvents).toBe(2); // cached → 3rd not yet visible
  });

  it('memoizes getReplicationPerCg independently and keys it by window', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 1000, 'cgA', 1);
    expect(db.getReplicationPerCg(3_600_000).length).toBe(1);

    promote(db, now - 500, 'cgB', 2); // a second CG appears
    expect(db.getReplicationPerCg(3_600_000).length).toBe(1); // cached within TTL — cgB not yet visible
    expect(db.getReplicationPerCg(2 * 3_600_000).length).toBe(2); // different window key → recomputed
  });

  it('timeline caching also requires a comfortably-large bucketMs (conservative guard)', () => {
    db = open(60_000); // 60s TTL → 10x = 600s
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);

    // periodMs 24h (>> 10x TTL) but bucketMs 10s (< 10x TTL) → bypass → fresh
    const fineBuckets = { periodMs: 86_400_000, bucketMs: 10_000 };
    expect(timelineTotal(db.getReplicationTimeline(fineBuckets))).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(timelineTotal(db.getReplicationTimeline(fineBuckets))).toBe(2); // small bucket → not cached

    // periodMs 24h AND bucketMs 1h (both >> 10x TTL) → cache
    const coarseBuckets = { periodMs: 86_400_000, bucketMs: 3_600_000 };
    expect(timelineTotal(db.getReplicationTimeline(coarseBuckets))).toBe(2);
    promote(db, now - 250, 'cg', 3);
    expect(timelineTotal(db.getReplicationTimeline(coarseBuckets))).toBe(2); // cached
  });

  it('returns a defensive copy — mutating the result does not poison the cache', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 1000, 'cgA', 1);
    promote(db, now - 900, 'cgB', 2);

    const rows = db.getReplicationPerCg(3_600_000);
    expect(rows.length).toBe(2);
    rows.pop(); // mutate the returned array...
    (rows as unknown[]).push({ tampered: true });
    const rows2 = db.getReplicationPerCg(3_600_000); // cache hit within TTL
    expect(rows2.length).toBe(2); // cached instance untouched
    expect(rows2.some((r) => (r as { tampered?: boolean }).tampered === true)).toBe(false);

    const summary = db.getReplicationSummary(3_600_000);
    summary.totalEvents = 999; // mutate the returned object...
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // cached instance untouched
  });

  it('caches at exactly MEMO_WINDOW_SAFETY_FACTOR x TTL (boundary is inclusive)', () => {
    db = open(1000); // TTL 1s → 10x boundary = 10_000ms
    const now = Date.now();
    promote(db, now - 500, 'cg', 1);
    // window EXACTLY 10x TTL → cached (matches the ">= 10x cacheable" contract)
    expect(db.getReplicationSummary(10_000).totalEvents).toBe(1);
    promote(db, now - 250, 'cg', 2);
    expect(db.getReplicationSummary(10_000).totalEvents).toBe(1); // cached, still 1
    // window just under the boundary → bypass → fresh
    expect(db.getReplicationSummary(9_999).totalEvents).toBe(2);
  });
});

describe('DashboardDB — cache TTL resolution', () => {
  it('empty DKG_DASHBOARD_CACHE_TTL_MS falls back to the default (does NOT disable) — the reported bug', () => {
    process.env[ENV_KEY] = '';
    db = new DashboardDB({ dataDir: dir }); // no option → resolves via env
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // still cached → default TTL active, not disabled
  });

  it('malformed DKG_DASHBOARD_CACHE_TTL_MS falls back to the 2000ms default (not a lax parseInt)', () => {
    // A lax resolver like `parseInt('64x')` would yield a 64ms TTL, and two
    // immediate reads can't tell that from 2000ms. Use fake time: advance past a
    // hypothetical 64ms TTL but well before 2000ms and assert the value is STILL
    // cached → the TTL really is the default, not a leniently-parsed 64.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    process.env[ENV_KEY] = '64x';
    db = new DashboardDB({ dataDir: dir });
    promote(db, t0 - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // computed + cached at t0

    promote(db, t0 - 500, 'cg', 2);
    vi.setSystemTime(t0 + 100); // past a hypothetical 64ms TTL, far below 2000ms
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // still cached → TTL is 2000, not 64
  });

  it('the cacheTtlMs option overrides the env var', () => {
    process.env[ENV_KEY] = '60000';
    db = new DashboardDB({ dataDir: dir, cacheTtlMs: 0 }); // option disables, beating env
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // option won → no cache
  });

  it('honors a VALID env value — DKG_DASHBOARD_CACHE_TTL_MS=0 disables (proves env is read, not ignored)', () => {
    // A resolver that ignored the env and always returned 2000 would pass the
    // empty/malformed cases above; this proves a real env value takes effect.
    process.env[ENV_KEY] = '0';
    db = new DashboardDB({ dataDir: dir });
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // env '0' disabled the cache → fresh
  });
});
