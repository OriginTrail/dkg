import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

describe('SwmHostModeStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dkg-host-mode-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seqnos per CG starting at 1', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
    });
    const cgId = 'curator/test-1';
    const s1 = await store.append(cgId, new Uint8Array([1, 2, 3]));
    const s2 = await store.append(cgId, new Uint8Array([4, 5, 6]));
    const s3 = await store.append(cgId, new Uint8Array([7, 8, 9]));
    expect(s1).toBe(1);
    expect(s2).toBe(2);
    expect(s3).toBe(3);
  });

  it('iterates entries strictly after sinceSeqno in seqno order', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
    });
    const cgId = 'curator/test-2';
    await store.append(cgId, new Uint8Array([0xa]));
    await store.append(cgId, new Uint8Array([0xb]));
    await store.append(cgId, new Uint8Array([0xc]));

    const all = await store.iterate(cgId, 0);
    expect(all.map((e) => e.seqno)).toEqual([1, 2, 3]);
    expect(Array.from(all[0].envelopeBytes)).toEqual([0xa]);

    const tail = await store.iterate(cgId, 1);
    expect(tail.map((e) => e.seqno)).toEqual([2, 3]);
  });

  it('persists seqno across new store instances', async () => {
    const cgId = 'curator/test-3';
    const limits = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };
    const first = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
    await first.append(cgId, new Uint8Array([1]));
    await first.append(cgId, new Uint8Array([2]));

    const second = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
    const s = await second.append(cgId, new Uint8Array([3]));
    expect(s).toBe(3);
    const all = await second.iterate(cgId, 0);
    expect(all.length).toBe(3);
  });

  it('prunes entries older than TTL', async () => {
    let nowMs = 1_000_000;
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
      now: () => nowMs,
    });
    const cgId = 'curator/test-4';
    await store.append(cgId, new Uint8Array([1]));
    nowMs += 50;
    await store.append(cgId, new Uint8Array([2]));
    nowMs += 200;
    const result = await store.prune();
    expect(result.bytesPruned).toBeGreaterThan(0);
    const entries = await store.iterate(cgId, 0);
    expect(entries.length).toBe(0);
  });

  it('enforces per-CG byte cap by evicting oldest entries FIFO', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 100, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 100, ttlMs: 60_000 },
    });
    const cgId = 'curator/test-5';
    for (let i = 0; i < 10; i += 1) {
      await store.append(cgId, new Uint8Array(20).fill(i));
    }
    const stats = await store.stats();
    expect(stats.totalBytes).toBeLessThanOrEqual(100);
    const entries = await store.iterate(cgId, 0);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(10);
    expect(entries[entries.length - 1].seqno).toBe(10);
  });

  it('uses larger limits after markRegistered', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 50, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 10_000, ttlMs: 60_000 },
    });
    const cgId = 'curator/test-6';
    await store.markRegistered(cgId);
    for (let i = 0; i < 10; i += 1) {
      await store.append(cgId, new Uint8Array(20).fill(i));
    }
    const entries = await store.iterate(cgId, 0);
    expect(entries.length).toBe(10);
    expect(await store.isRegistered(cgId)).toBe(true);
  });

  it('rejects zero-length envelopes', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024, ttlMs: 60_000 },
    });
    await expect(store.append('cg/empty', new Uint8Array(0))).rejects.toThrow(/zero-length/);
  });

  it('recovers seqno from log tail when meta cursor is stale (crash between appendFile and persistMeta)', async () => {
    const cgId = 'curator/test-7';
    const limits = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };
    const first = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
    await first.append(cgId, new Uint8Array([1]));
    await first.append(cgId, new Uint8Array([2]));
    await first.append(cgId, new Uint8Array([3]));

    // Simulate a crash where persistMeta lost a race and the meta
    // file reports a lower seqno than the log actually contains.
    // We do this by overwriting the meta file in place with the
    // stale cursor (seqno=1, but the log has 3 entries).
    const { promises: fs } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const cgKey = createHash('sha256').update(cgId).digest('base64url');
    const metaPath = path.join(dir, `${cgKey}.meta`);
    await fs.writeFile(metaPath, JSON.stringify({ seqno: 1, registered: false, contextGraphId: cgId }));

    // Fresh store instance reads the stale meta + scans the log tail
    // and reconciles to max(1, 3) = 3. The next append MUST assign
    // seqno 4, not 2 (which would otherwise collide with the
    // existing entry).
    const second = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
    const recovered = await second.getLastSeqno(cgId);
    expect(recovered).toBe(3);
    const next = await second.append(cgId, new Uint8Array([4]));
    expect(next).toBe(4);

    // All four entries are visible via iterate, with unique
    // strictly-increasing seqnos.
    const all = await second.iterate(cgId, 0);
    expect(all.map((e) => e.seqno)).toEqual([1, 2, 3, 4]);
  });

  it('isolates CGs by id', async () => {
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
    });
    await store.append('cg/A', new Uint8Array([1, 2]));
    await store.append('cg/B', new Uint8Array([3, 4]));
    const a = await store.iterate('cg/A', 0);
    const b = await store.iterate('cg/B', 0);
    expect(Array.from(a[0].envelopeBytes)).toEqual([1, 2]);
    expect(Array.from(b[0].envelopeBytes)).toEqual([3, 4]);
  });

  it('exposes a per-CG breakdown via stats() with entries, bytes, and registered flag', async () => {
    // Codex PR #610 R3: callers asserting "ciphertext was stored
    // for CG X" must be able to filter — relying on the global
    // totals lets unrelated CGs mask a missing entry for X.
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
    });
    await store.append('cg/per-cg-A', new Uint8Array([1, 2, 3, 4]));
    await store.append('cg/per-cg-A', new Uint8Array([5, 6, 7, 8]));
    await store.append('cg/per-cg-B', new Uint8Array([9, 10]));
    await store.markRegistered('cg/per-cg-A');

    const stats = await store.stats();
    expect(stats.cgCount).toBe(2);
    expect(stats.totalEntries).toBe(3);

    expect(stats.perCg['cg/per-cg-A']).toBeDefined();
    expect(stats.perCg['cg/per-cg-A'].entries).toBe(2);
    expect(stats.perCg['cg/per-cg-A'].registered).toBe(true);
    expect(stats.perCg['cg/per-cg-A'].bytes).toBeGreaterThan(0);

    expect(stats.perCg['cg/per-cg-B']).toBeDefined();
    expect(stats.perCg['cg/per-cg-B'].entries).toBe(1);
    expect(stats.perCg['cg/per-cg-B'].registered).toBe(false);

    expect(stats.perCg['cg/never-seen']).toBeUndefined();
  });

  it('cgCount only counts CGs that still have ciphertext entries (Codex PR #610 R4)', async () => {
    // markRegistered() creates a meta file even when the CG has
    // received zero envelopes. A prune-to-empty can also leave the
    // .meta behind. stats().cgCount must reflect "CGs with hosted
    // ciphertext", not "CGs the store has any record of", so
    // operators don't see inflated cg counts.
    const store = new SwmHostModeStore({
      dataDir: dir,
      unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
      registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 60_000 },
    });
    // Meta-only CG: registered up-front, never receives an envelope.
    await store.markRegistered('cg/meta-only');
    // Real CG: has hosted ciphertext.
    await store.append('cg/real-1', new Uint8Array([1, 2, 3]));
    await store.append('cg/real-2', new Uint8Array([4, 5, 6]));

    const stats = await store.stats();
    expect(stats.cgCount).toBe(2);
    expect(stats.totalEntries).toBe(2);
    expect(stats.perCg['cg/meta-only']).toBeUndefined();
    expect(stats.perCg['cg/real-1']).toBeDefined();
    expect(stats.perCg['cg/real-2']).toBeDefined();
  });
});
