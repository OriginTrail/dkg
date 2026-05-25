import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

function cgKey(contextGraphId: string): string {
  return createHash('sha256').update(contextGraphId).digest('base64url');
}

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

  describe('B2: orphan .log reconcile on startup', () => {
    const limits = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };

    it('removes a .log file with no matching .meta on init', async () => {
      // Simulate a crashed first-write: .log exists, .meta absent.
      const orphanKey = cgKey('curator/crashed-cg');
      const orphanLog = path.join(dir, `${orphanKey}.log`);
      await writeFile(orphanLog, Buffer.from('orphan-bytes-pretending-to-be-frames'));
      const before = await readdir(dir);
      expect(before).toContain(`${orphanKey}.log`);

      let reportSeen: { orphanLogsRemoved: number; orphanBytesRemoved: number } | null = null;
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
        onStartupReconcile: (r) => { reportSeen = r; },
      });
      await store.init();

      const after = await readdir(dir);
      expect(after).not.toContain(`${orphanKey}.log`);
      expect(reportSeen).toEqual({ orphanLogsRemoved: 1, orphanBytesRemoved: 36 });
    });

    it('preserves .meta without matching .log (markRegistered + never-written CG case)', async () => {
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
      });
      await store.init();
      await store.markRegistered('curator/registered-but-empty');

      const reincarnated = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
      });
      const report = await reincarnated.reconcileOrphanLogsNow();
      expect(report).toEqual({ orphanLogsRemoved: 0, orphanBytesRemoved: 0 });
      expect(await reincarnated.isRegistered('curator/registered-but-empty')).toBe(true);
    });

    it('preserves .log files that have a matching .meta (normal case)', async () => {
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
      });
      await store.append('curator/healthy', new Uint8Array([0xa, 0xb]));

      const reincarnated = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
      });
      const report = await reincarnated.reconcileOrphanLogsNow();
      expect(report.orphanLogsRemoved).toBe(0);
      const entries = await reincarnated.iterate('curator/healthy', 0);
      expect(entries).toHaveLength(1);
    });

    it('handles mixed dirs: removes orphan logs, leaves healthy pairs + lonely metas alone', async () => {
      // Seed a healthy pair via the store, then plant an orphan log manually,
      // then call init and verify only the orphan was removed.
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
      });
      await store.append('curator/healthy', new Uint8Array([0x42, 0x42]));
      await store.markRegistered('curator/lonely-meta');

      const orphanKey1 = cgKey('curator/orphan-1');
      const orphanKey2 = cgKey('curator/orphan-2');
      await writeFile(path.join(dir, `${orphanKey1}.log`), Buffer.from('garbage-1'));
      await writeFile(path.join(dir, `${orphanKey2}.log`), Buffer.from('garbage-22'));

      let reportSeen: { orphanLogsRemoved: number; orphanBytesRemoved: number } | null = null;
      const reincarnated = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
        onStartupReconcile: (r) => { reportSeen = r; },
      });
      await reincarnated.init();
      expect(reportSeen).toEqual({ orphanLogsRemoved: 2, orphanBytesRemoved: 9 + 10 });

      const after = await readdir(dir);
      expect(after).not.toContain(`${orphanKey1}.log`);
      expect(after).not.toContain(`${orphanKey2}.log`);
      // Healthy pair + lonely meta survive.
      expect(after).toContain(`${cgKey('curator/healthy')}.log`);
      expect(after).toContain(`${cgKey('curator/healthy')}.meta`);
      expect(after).toContain(`${cgKey('curator/lonely-meta')}.meta`);
    });

    it('does not fire the reconcile callback when there are no orphans', async () => {
      let callbackCount = 0;
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
        onStartupReconcile: () => { callbackCount += 1; },
      });
      await store.init();
      expect(callbackCount).toBe(0);
    });

    it('swallows callback errors so init never breaks on observability faults', async () => {
      const orphanKey = cgKey('curator/will-be-reaped');
      await writeFile(path.join(dir, `${orphanKey}.log`), Buffer.from('x'));
      const store = new SwmHostModeStore({
        dataDir: dir,
        unregisteredLimits: limits,
        registeredLimits: limits,
        onStartupReconcile: () => { throw new Error('observability is wedged'); },
      });
      await expect(store.init()).resolves.toBeUndefined();
    });

    describe('B2 round-2: Codex feedback', () => {
      it('reconcileOrphanLogsNow returns the init-time report on the first call (not {0,0} after init swept)', async () => {
        // Codex PR #619 R2: prior behavior always returned {0,0} on
        // the first invocation because init() had already run the
        // reconcile sweep before reconcileOrphanLogsNow() got a
        // chance, making the operator/helper API misleading.
        const orphanKey = cgKey('curator/init-reaped');
        await writeFile(path.join(dir, `${orphanKey}.log`), Buffer.from('garbage-bytes-12345'));
        const store = new SwmHostModeStore({
          dataDir: dir,
          unregisteredLimits: limits,
          registeredLimits: limits,
        });
        // No prior init() — the helper triggers it internally.
        const report = await store.reconcileOrphanLogsNow();
        expect(report.orphanLogsRemoved).toBe(1);
        expect(report.orphanBytesRemoved).toBe(19);
        // Second call goes through reconcileOrphanLogs again (no
        // orphans left now).
        const second = await store.reconcileOrphanLogsNow();
        expect(second.orphanLogsRemoved).toBe(0);
      });

      it('reaps .log paired with a .meta that fails to parse as JSON (crashed mid-persist)', async () => {
        // Codex PR #619 R2: a crash mid-`writeFile(metaPath, ...)`
        // can leave a truncated/invalid .meta. `loadMeta()` and
        // `listKnownCgs()` already treat that as unusable, so the
        // matching .log is still unservable + unprunable. The
        // reconcile pass must reap both.
        const corruptKey = cgKey('curator/half-persisted');
        await writeFile(path.join(dir, `${corruptKey}.meta`), Buffer.from('{"seqno":3,"reg'));
        await writeFile(path.join(dir, `${corruptKey}.log`), Buffer.from('xxxxxxxxxx'));

        let reportSeen: { orphanLogsRemoved: number; orphanBytesRemoved: number } | null = null;
        const store = new SwmHostModeStore({
          dataDir: dir,
          unregisteredLimits: limits,
          registeredLimits: limits,
          onStartupReconcile: (r) => { reportSeen = r; },
        });
        await store.init();
        expect(reportSeen).not.toBeNull();
        expect(reportSeen!.orphanLogsRemoved).toBe(2);

        const after = await readdir(dir);
        expect(after).not.toContain(`${corruptKey}.log`);
        expect(after).not.toContain(`${corruptKey}.meta`);
      });

      it('reaps .log paired with a .meta missing contextGraphId (parses as JSON but is unusable)', async () => {
        const corruptKey = cgKey('curator/meta-missing-cgid');
        await writeFile(
          path.join(dir, `${corruptKey}.meta`),
          Buffer.from('{"seqno":0,"registered":false}'),
        );
        await writeFile(path.join(dir, `${corruptKey}.log`), Buffer.from('zzzz'));
        const store = new SwmHostModeStore({
          dataDir: dir,
          unregisteredLimits: limits,
          registeredLimits: limits,
        });
        await store.init();
        const after = await readdir(dir);
        expect(after).not.toContain(`${corruptKey}.log`);
        expect(after).not.toContain(`${corruptKey}.meta`);
      });
    });
  });

  describe('B3: host-mode designation persistence', () => {
    const limits = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };

    it('persists hostModeSubscribed across new store instances', async () => {
      const first = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      await first.markHostModeSubscribed('curator/cg-host');

      const second = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      const restored = await second.listHostModeSubscribedCgs();
      expect(restored).toEqual(['curator/cg-host']);
    });

    it('listHostModeSubscribedCgs returns only flagged CGs', async () => {
      const store = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      await store.markHostModeSubscribed('curator/cg-a');
      await store.markRegistered('curator/cg-b'); // registered but never subscribed
      await store.append('curator/cg-c', new Uint8Array([1])); // ciphertext but no host-mode flag

      const restored = await store.listHostModeSubscribedCgs();
      expect(restored).toEqual(['curator/cg-a']);
    });

    it('markHostModeUnsubscribed clears the flag (unwire path)', async () => {
      const store = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      await store.markHostModeSubscribed('curator/cg-x');
      expect(await store.listHostModeSubscribedCgs()).toContain('curator/cg-x');
      await store.markHostModeUnsubscribed('curator/cg-x');
      expect(await store.listHostModeSubscribedCgs()).not.toContain('curator/cg-x');
    });

    it('preserves hostModeSubscribed alongside append-driven seqno updates', async () => {
      const first = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      await first.markHostModeSubscribed('curator/cg-active');
      await first.append('curator/cg-active', new Uint8Array([1, 2, 3]));
      await first.append('curator/cg-active', new Uint8Array([4, 5, 6]));

      const second = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      expect(await second.listHostModeSubscribedCgs()).toEqual(['curator/cg-active']);
      // Seqno bookkeeping also survives — append picks up at 3.
      const s3 = await second.append('curator/cg-active', new Uint8Array([7]));
      expect(s3).toBe(3);
    });

    it('mark + unmark are idempotent', async () => {
      const store = new SwmHostModeStore({ dataDir: dir, unregisteredLimits: limits, registeredLimits: limits });
      await store.markHostModeSubscribed('curator/cg-1');
      await store.markHostModeSubscribed('curator/cg-1');
      await store.markHostModeUnsubscribed('curator/cg-1');
      await store.markHostModeUnsubscribed('curator/cg-1');
      expect(await store.listHostModeSubscribedCgs()).toEqual([]);
    });
  });
});
