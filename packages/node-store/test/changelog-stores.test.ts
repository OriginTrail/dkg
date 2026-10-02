import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteChangelogCursorStore, SqliteChangelogEraGuard } from '../src/index.js';
import { DashboardDB } from './helpers/dashboard-db.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-node-store-changelog-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
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
});
