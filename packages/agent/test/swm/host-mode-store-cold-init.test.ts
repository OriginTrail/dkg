/**
 * Crash-safety of the SWM host-mode store's disk writes, part 3: the cold metadata load has a single
 * owner per CG (no mutation interleaves with its reconcile write, a rejected initialization is not
 * cached, concurrent callers share one), the seqno cursor stays monotonic across the crash
 * windows (a slow cold load, a durable cursor ahead of a lost frame, a cursor behind the log), and a
 * file the store could not read (as opposed to one that is missing) rejects the load instead of
 * restarting the cursor.
 *
 * Shared fixture and pause controls: `test/_helpers/host-mode-store-durability-support.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import {
  HEADER_BYTES,
  cgKey,
  errnoError,
  gateRenames,
  newStore,
  parseFrames,
  readCalls,
  wait,
  useDurabilityFixture,
} from '../_helpers/host-mode-store-durability-support.js';

describe('SwmHostModeStore durable writes', () => {
  const fx = useDurabilityFixture();
  const { tempFiles, seedLaggingMeta } = fx;

  describe('cold metadata initialization has a single owner per CG', () => {
    it('a delayed cold-load reconcile cannot restore a flag a later mutation cleared: a fresh store reads the mutation', async () => {
      const cg = 'cg/init-stale-rename';
      const metaPath = await seedLaggingMeta(cg, { hostModeSubscribed: true });
      const store = newStore(fx.dir);
      await store.init();
      const gate = gateRenames();

      const reader = store.isRegistered(cg); // unlocked cold load, paused right before its reconcile rename
      await gate.reached;
      let unsubscribed = false;
      const unsubscribe = store.markHostModeUnsubscribed(cg).then(() => { unsubscribed = true; });
      // Give the mutation every chance to finish while the reader is paused. Before the fix it did
      // (it cold-loaded on its own); now it must wait for the reader's initialization.
      await Promise.race([unsubscribe, wait(600)]);
      const finishedWhilePaused = unsubscribed;
      gate.release();
      await Promise.all([reader, unsubscribe]);

      // Outcome first: the acknowledged unsubscribe is what disk and a restarted store see.
      const onDisk = JSON.parse(await readFile(metaPath, 'utf8'));
      expect(onDisk.hostModeSubscribed, 'a stale reconcile rename restored the cleared flag').not.toBe(true);
      expect(onDisk.seqno).toBe(3);
      // A restart must not re-engage the subscription the unsubscribe acknowledged.
      const fresh = newStore(fx.dir);
      expect(await fresh.listHostModeSubscribedCgs()).toEqual([]);
      expect(await fresh.getLastSeqno(cg)).toBe(3);
      // Mechanism: the mutation waited for the in-flight initialization instead of racing it.
      expect(finishedWhilePaused, 'the mutation must wait for the in-flight initialization').toBe(false);
    });

    it.each([
      { name: 'markRegistered', pre: {}, run: (s: SwmHostModeStore, cg: string) => s.markRegistered(cg), expectMeta: { registered: true, seqno: 3 } },
      { name: 'markUnregistered', pre: { registered: true }, run: (s: SwmHostModeStore, cg: string) => s.markUnregistered(cg), expectMeta: { registered: false, seqno: 3 } },
      { name: 'markHostModeSubscribed', pre: {}, run: (s: SwmHostModeStore, cg: string) => s.markHostModeSubscribed(cg), expectMeta: { hostModeSubscribed: true, seqno: 3 } },
      { name: 'markHostModeUnsubscribed', pre: { hostModeSubscribed: true }, run: (s: SwmHostModeStore, cg: string) => s.markHostModeUnsubscribed(cg), expectMeta: { hostModeSubscribed: false, seqno: 3 } },
      { name: 'append', pre: {}, run: (s: SwmHostModeStore, cg: string) => s.append(cg, new Uint8Array([4])), expectMeta: { seqno: 4 } },
    ])('$name arriving during a paused unlocked cold load waits for it and lands on top of the reconciled cursor', async ({ name, pre, run, expectMeta }) => {
      const cg = `cg/init-wait-${name}`;
      const metaPath = await seedLaggingMeta(cg, pre);
      const store = newStore(fx.dir);
      await store.init();
      const gate = gateRenames();

      const reader = store.getLastSeqno(cg);
      await gate.reached;
      let done = false;
      const mutation = run(store, cg).then(() => { done = true; });
      await Promise.race([mutation, wait(400)]);
      expect(done, `${name} must not complete while the initialization is paused`).toBe(false);
      gate.release();
      await Promise.all([reader, mutation]);

      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject(expectMeta);
      // What a restarted store sees is what the mutation acknowledged.
      const fresh = newStore(fx.dir);
      expect(await fresh.getLastSeqno(cg)).toBe(expectMeta.seqno);
      expect(await fresh.isRegistered(cg)).toBe('registered' in expectMeta ? expectMeta.registered : false);
    });

    it('a mutation that starts the initialization is joined by later readers: one reconcile, both orders consistent', async () => {
      const cg = 'cg/init-mutator-first';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      const readFileSpy = vi.spyOn(fsp, 'readFile');
      const gate = gateRenames();

      const mutation = store.markRegistered(cg); // owns the cold load (inside its lock)
      await gate.reached;
      const readers = Promise.all([store.getLastSeqno(cg), store.getLastSeqno(cg), store.isRegistered(cg)]);
      gate.release();
      const [seqnoA, seqnoB] = await readers;
      await mutation;

      expect([seqnoA, seqnoB]).toEqual([3, 3]);
      expect(await store.isRegistered(cg)).toBe(true);
      // Exactly one initialization: one meta read, one log scan, and only two renames
      // (its reconcile write and the mutation's own write).
      expect(readFileSpy.mock.calls.filter(([p]) => String(p).endsWith('.meta'))).toHaveLength(1);
      expect(readFileSpy.mock.calls.filter(([p]) => String(p).endsWith('.log'))).toHaveLength(1);
      expect(gate.spy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: true });
    });

    it('concurrent cold loads (readers and a mutator) share exactly one initialization', async () => {
      const cg = 'cg/init-shared';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      vi.spyOn(fsp, 'readFile');
      const renameSpy = vi.spyOn(fsp, 'rename');
      const dirSyncBefore = vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.length;

      const results = await Promise.all([
        store.getLastSeqno(cg),
        store.getLastSeqno(cg),
        store.isRegistered(cg),
        store.markRegistered(cg),
        store.getLastSeqno(cg),
        store.isRegistered(cg),
      ]);

      expect(results[0]).toBe(3);
      expect(results[1]).toBe(3);
      expect(results[4]).toBe(3);
      expect(await store.isRegistered(cg)).toBe(true);
      expect(readCalls('.meta')).toBe(1);
      expect(readCalls('.log')).toBe(1);
      // One reconcile write for the initialization plus the mutator's own write; each with one directory fsync.
      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.length - dirSyncBefore).toBe(2);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: true });

      // Warm now: further callers touch the disk zero times.
      await store.getLastSeqno(cg);
      await store.isRegistered(cg);
      expect(readCalls('.meta')).toBe(1);
      expect(readCalls('.log')).toBe(1);
    });

    it('a rejected initialization is not cached: every waiter sees it and the next caller retries', async () => {
      const cg = 'cg/init-retry';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      // Any fault that rejects the cold load will do here (read errors have their own tests further
      // down): the log read yields a non-buffer, which the tail scan cannot parse.
      const realReadFile = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
      let failLogRead = true;
      vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (failLogRead && String(p).endsWith('.log')) {
          failLogRead = false;
          return null;
        }
        return realReadFile(p, ...rest);
      }) as never);

      // Two unlocked readers share the failing initialization (their `catch` turns it into 0)...
      expect(await Promise.all([store.getLastSeqno(cg), store.getLastSeqno(cg)])).toEqual([0, 0]);
      expect(readCalls('.log')).toBe(1);
      // ...nothing was cached, so the next caller runs a fresh initialization and recovers the cursor.
      expect(await store.getLastSeqno(cg)).toBe(3);
      expect(readCalls('.log')).toBe(2);
      expect(JSON.parse(await readFile(metaPath, 'utf8')).seqno).toBe(3);
    });

    it('a mutator whose initialization rejects does not poison the caller queued behind it', async () => {
      const cg = 'cg/init-retry-queued';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      const realReadFile = fsp.readFile.bind(fsp) as (...args: unknown[]) => Promise<unknown>;
      let failLogRead = true;
      vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (failLogRead && String(p).endsWith('.log')) {
          failLogRead = false;
          return null;
        }
        return realReadFile(p, ...rest);
      }) as never);

      const failing = store.markRegistered(cg);
      const queued = store.markHostModeSubscribed(cg);
      await expect(failing).rejects.toBeInstanceOf(TypeError);
      await queued;

      // The failed mutation left no trace; the queued one ran its own (successful) initialization.
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: false, hostModeSubscribed: true });
      expect(await store.isRegistered(cg)).toBe(false);
      await store.markRegistered(cg);
      expect(await newStore(fx.dir).isRegistered(cg)).toBe(true);
    });

    it('best-effort reconcile persistence never fails or poisons the shared initialization', async () => {
      const cg = 'cg/init-best-effort';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EACCES', 'injected reconcile rename failure'));

      // Both callers share the initialization whose persistence step fails; neither sees an error.
      const [seqno] = await Promise.all([store.getLastSeqno(cg), store.markRegistered(cg)]);
      expect(seqno).toBe(3);
      // The cache holds the reconciled cursor, so the mutation's own write publishes it durably.
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: true });
      expect(await tempFiles()).toEqual([]);
    });

    it('the cache check and the registration of an initialization are one synchronous step: two loads in the same tick share one initialization', async () => {
      const cg = 'cg/init-sync-step';
      await seedLaggingMeta(cg);
      const store = newStore(fx.dir);
      await store.init();
      vi.spyOn(fsp, 'readFile');
      const loadMeta = (store as unknown as { loadMeta(contextGraphId: string): Promise<unknown> }).loadMeta.bind(store);

      const first = loadMeta(cg);
      const second = loadMeta(cg); // no yield between the two calls
      expect(await second).toBe(await first);
      expect(readCalls('.meta')).toBe(1);
      expect(readCalls('.log')).toBe(1);
    });

    it('a context graph id that is not a string is a rejected lookup the readers swallow, not a synchronous throw', async () => {
      const store = newStore(fx.dir);
      await store.init();
      // The same answers the store gave before the initialization had an owner (loadMeta was async).
      await expect(store.getLastSeqno(undefined as never)).resolves.toBe(0);
      await expect(store.isRegistered(undefined as never)).resolves.toBe(false);
      await expect(store.getLastSeqno(42 as never)).resolves.toBe(0);

      // A meta whose contextGraphId is not a string (init() reaps those, so it has to appear afterwards)
      // is skipped by the listing instead of failing it.
      await store.markHostModeSubscribed('cg/listed');
      await writeFile(
        path.join(fx.dir, `${cgKey('cg/not-a-string')}.meta`),
        JSON.stringify({ seqno: 1, registered: false, contextGraphId: 123, hostModeSubscribed: true }),
      );
      await expect(store.listHostModeSubscribedCgs()).resolves.toEqual(['cg/listed']);
    });

    it('a failed cursor write drops the cache; the next cold load (a reader) and a queued append share one recovery and stay monotonic', async () => {
      const cg = 'cg/init-evict';
      const store = newStore(fx.dir);
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected cursor rename failure'));
      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected cursor rename failure');
      vi.spyOn(fsp, 'readFile');

      // The cache was dropped, so the reader starts a new initialization (frame 2 is in the log,
      // the meta still says 1) and the append queued behind it joins it instead of scanning again.
      const reader = store.getLastSeqno(cg);
      const appended = store.append(cg, new Uint8Array([3]));

      expect(await reader).toBeGreaterThanOrEqual(2);
      expect(await appended).toBe(3);
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3]);
      expect(readCalls('.meta')).toBe(1);
      expect(await newStore(fx.dir).getLastSeqno(cg)).toBe(3);
    });
  });

  describe('seqno monotonicity across crash windows', () => {
    it('a slow unlocked cold load cannot roll the cursor back: a concurrent append waits for that one initialization and stays monotonic', async () => {
      const cg = 'cg/mono-race';
      const first = newStore(fx.dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Crash-recovery shape: the meta lags the log, so the cold load must rewrite it durably.
      await writeFile(
        path.join(fx.dir, `${cgKey(cg)}.meta`),
        JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg }),
      );
      const store = newStore(fx.dir);
      await store.init();

      // Hold the FIRST reconcile write (the unlocked reader's) at its rename.
      const gate = gateRenames();
      const renameSpy = gate.spy;
      const slowReader = store.getLastSeqno(cg);
      await gate.reached;

      // A locked append arrives meanwhile. It does NOT start a second cold load: it joins the
      // reader's initialization and cannot get past it while that (including its reconcile write)
      // is still in flight. Before the single-owner initialization it cold-loaded on its own here,
      // wrote its own reconcile and finished while the reader was still paused.
      let appendDone = false;
      const appended = store.append(cg, new Uint8Array([4])).then((seqno) => {
        appendDone = true;
        return seqno;
      });
      await Promise.race([appended, wait(400)]);
      expect(appendDone, 'the append must wait for the reader\'s initialization').toBe(false);
      expect(renameSpy, 'no second cold load, so no second reconcile write yet').toHaveBeenCalledTimes(1);
      gate.release();
      expect(await appended).toBe(4);
      // The reader linearises with the initialization it shared: it reports the reconciled cursor
      // (3), or the appended one (4) if the append's continuation ran first. Never the stale 1.
      expect([3, 4]).toContain(await slowReader);
      expect(await store.append(cg, new Uint8Array([5]))).toBe(5);
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3, 4, 5]);
      // One reconcile write for the shared initialization, then one cursor write per append.
      expect(renameSpy).toHaveBeenCalledTimes(3);
      expect(JSON.parse(await readFile(path.join(fx.dir, `${cgKey(cg)}.meta`), 'utf8')).seqno).toBe(5);
    });

    it('a durable cursor ahead of a lost frame leaves a gap instead of recycling the seqno', async () => {
      const cg = 'cg/mono-1';
      const key = cgKey(cg);
      const first = newStore(fx.dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Power loss: the meta rename was durable for seqno 3, the frame for seqno 3 was not.
      const logPath = path.join(fx.dir, `${key}.log`);
      const log = await readFile(logPath);
      await writeFile(logPath, log.subarray(0, log.length - (HEADER_BYTES + 1)));

      const second = newStore(fx.dir);
      expect(await second.getLastSeqno(cg)).toBe(3);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
      expect((await second.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 4]);
      // A catch-up client paging strictly-greater-than sees every surviving frame.
      expect((await second.iterate(cg, 2)).map((e) => e.seqno)).toEqual([4]);
    });

    it('a cursor that lags the log is reconciled from the log tail and republished by the next append', async () => {
      const cg = 'cg/mono-2';
      const key = cgKey(cg);
      const first = newStore(fx.dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Cursor lags the log by two (each append's meta rename raced the crash).
      await writeFile(path.join(fx.dir, `${key}.meta`), JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg }));

      const second = newStore(fx.dir);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
      expect(JSON.parse(await readFile(path.join(fx.dir, `${key}.meta`), 'utf8')).seqno).toBe(4);
    });
  });

  describe('a file the store could not read is not an absent file', () => {
    /**
     * Fail the next read of a `.meta` / `.log` file with an errno error, once; every other read is
     * real. (The real function is the module-level import: `fsp.readFile` may already be a spy.)
     */
    function failNextRead(suffix: '.meta' | '.log', code: string): void {
      const realReadFile = readFile as (...args: unknown[]) => Promise<unknown>;
      let armed = true;
      vi.spyOn(fsp, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (armed && String(p).endsWith(suffix)) {
          armed = false;
          throw errnoError(code, `injected ${code} on the ${suffix} read`);
        }
        return realReadFile(p, ...rest);
      }) as never);
    }

    /**
     * Frame 2 is in the log, the meta still says 1, and the failed cursor write dropped the cache:
     * only the log tail knows about seqno 2.
     */
    async function cursorBehindLog(cg: string) {
      const store = newStore(fx.dir);
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected cursor rename failure'));
      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected cursor rename failure');
      const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);
      expect(parseFrames(await readFile(logPath)).seqnos).toEqual([1, 2]);
      expect(JSON.parse(await readFile(path.join(fx.dir, `${cgKey(cg)}.meta`), 'utf8')).seqno).toBe(1);
      return { store, logPath };
    }

    it.each(['EIO', 'EACCES', 'EMFILE'])('after a prune-to-empty and a failed meta write, %s on the re-read rejects the append instead of restarting the cursor', async (code) => {
      let nowMs = 1_000_000;
      const expiring = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      const store = newStore(fx.dir, { unregisteredLimits: expiring, registeredLimits: expiring, now: () => nowMs });
      const cg = `cg/unreadable-meta-${code}`;
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);
      await store.markHostModeSubscribed(cg);
      for (let i = 1; i <= 5; i += 1) expect(await store.append(cg, new Uint8Array([i]))).toBe(i);
      nowMs += 10_000;
      await store.prune(); // every frame expired: the log is unlinked, the meta (cursor 5 and the flag) stays
      await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const metaBefore = await readFile(metaPath, 'utf8');
      expect(JSON.parse(metaBefore)).toEqual({ seqno: 5, registered: false, contextGraphId: cg, hostModeSubscribed: true });

      // A failed meta write drops the warm cache (the failed-mutation rollback)...
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));
      await expect(store.markRegistered(cg)).rejects.toThrow('injected rename failure');
      // ...so the next access has to read the meta again, and that read fails. With no log left to
      // recover from, taking the failure for "no meta" would hand out seqno 1 a second time.
      failNextRead('.meta', code);
      await expect(store.append(cg, new Uint8Array([6]))).rejects.toMatchObject({ code });
      // Nothing was persisted from the failed load: no frame, and the meta is byte-identical.
      await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(metaPath, 'utf8')).toBe(metaBefore);

      // Reads work again: the same store continues after the acknowledged seqnos and keeps the flag.
      expect(await store.append(cg, new Uint8Array([6]))).toBe(6);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toEqual({ seqno: 6, registered: false, contextGraphId: cg, hostModeSubscribed: true });
      // A requester that had caught up to 5 is served the new frame.
      expect((await store.iterate(cg, 5)).map((e) => e.seqno)).toEqual([6]);
      const restarted = newStore(fx.dir);
      expect(await restarted.listHostModeSubscribedCgs()).toEqual([cg]);
      expect(await restarted.getLastSeqno(cg)).toBe(6);
    });

    it('control: a meta that is really missing (ENOENT) on the same route is still "no metadata yet": defaults, and the first append is seqno 1', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/missing-meta';
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      // The very first meta write fails: nothing reaches the disk and the cache is dropped, as above.
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));
      await expect(store.markHostModeSubscribed(cg)).rejects.toThrow('injected rename failure');
      await expect(stat(metaPath)).rejects.toMatchObject({ code: 'ENOENT' });
      vi.spyOn(fsp, 'readFile');

      // The re-read finds no file, the one failure that does mean "absent".
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      expect(readCalls('.meta')).toBe(1);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toEqual({ seqno: 1, registered: false, contextGraphId: cg });
      expect(await newStore(fx.dir).listHostModeSubscribedCgs()).toEqual([]);
    });

    it('a transient read error is not cached: the next call on the same store reads again and sees the real state', async () => {
      const cg = 'cg/unreadable-meta-once';
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      const first = newStore(fx.dir);
      await first.markHostModeSubscribed(cg);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaBefore = await readFile(metaPath, 'utf8');
      const store = newStore(fx.dir); // cold: its first access has to read the meta
      await store.init();
      failNextRead('.meta', 'EMFILE');

      // The mutation rejects and leaves the file alone, rather than writing its flag over defaults.
      await expect(store.markRegistered(cg)).rejects.toMatchObject({ code: 'EMFILE' });
      expect(await readFile(metaPath, 'utf8')).toBe(metaBefore);
      expect(readCalls('.meta')).toBe(1);

      // No restart and no new store: the very next call starts a fresh load, which succeeds.
      await store.markRegistered(cg);
      expect(readCalls('.meta')).toBe(2);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toEqual({ seqno: 3, registered: true, contextGraphId: cg, hostModeSubscribed: true });
      expect(await store.append(cg, new Uint8Array([4]))).toBe(4);
      // Warm from here on: the load that succeeded is the one that was cached.
      expect(readCalls('.meta')).toBe(2);
    });

    it('a reader that hits the error answers "unknown" for that call only: a registered CG is not pruned under the unregistered limits afterwards', async () => {
      let nowMs = 1_000_000;
      const options = {
        unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
        registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 1_000_000 },
        now: () => nowMs,
      };
      const cg = 'cg/unreadable-meta-limits';
      const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);
      const first = newStore(fx.dir, options);
      await first.markRegistered(cg);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      nowMs += 10_000; // past the unregistered TTL, far inside the registered one
      const store = newStore(fx.dir, options);
      await store.init();
      failNextRead('.meta', 'EACCES');

      expect(await store.isRegistered(cg)).toBe(false);
      // The defaults behind that answer were not cached, so the sweep loads the real flag and keeps every frame.
      expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 });
      expect(parseFrames(await readFile(logPath)).seqnos).toEqual([1, 2, 3]);
      expect(await store.isRegistered(cg)).toBe(true);
    });

    it('the log tail follows the same rule: a failed log read rejects the load instead of letting a lagging cursor stand', async () => {
      const cg = 'cg/unreadable-log';
      const { store, logPath } = await cursorBehindLog(cg);
      const logBefore = await readFile(logPath);
      failNextRead('.log', 'EIO');

      // Taking the failure for "no log" would keep the cursor at 1 and write seqno 2 a second time.
      await expect(store.append(cg, new Uint8Array([3]))).rejects.toMatchObject({ code: 'EIO' });
      expect((await readFile(logPath)).equals(logBefore)).toBe(true);

      expect(await store.append(cg, new Uint8Array([3]))).toBe(3);
      const log = await readFile(logPath);
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2, 3], validLength: log.length });
      expect(await newStore(fx.dir).getLastSeqno(cg)).toBe(3);
    });

    it('the log tail is recovered by the read alone: an existence probe that fails cannot hide the log', async () => {
      const cg = 'cg/unreadable-log-probe';
      const { store, logPath } = await cursorBehindLog(cg);
      const realAccess = fsp.access.bind(fsp) as (...args: unknown[]) => Promise<void>;
      vi.spyOn(fsp, 'access').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
        if (String(p).endsWith('.log')) throw errnoError('EIO', 'injected EIO on the .log probe');
        return realAccess(p, ...rest);
      }) as never);

      expect(await store.append(cg, new Uint8Array([3]))).toBe(3);
      const log = await readFile(logPath);
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2, 3], validLength: log.length });
    });

    it('a CG whose files cannot be read does not stop the prune sweep: the others are pruned and the failure is still reported', async () => {
      let nowMs = 1_000_000;
      const expiring = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      const options = { unregisteredLimits: expiring, registeredLimits: expiring, now: () => nowMs };
      const cgs = ['cg/sweep-one', 'cg/sweep-two'];
      const first = newStore(fx.dir, options);
      for (const cg of cgs) {
        for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      }
      nowMs += 10_000; // every frame of both CGs has expired
      const logState = () => Promise.all(cgs.map((cg) =>
        stat(path.join(fx.dir, `${cgKey(cg)}.log`)).then(() => 'kept', () => 'pruned')));
      const store = newStore(fx.dir, options); // cold: the sweep has to load each CG
      await store.init();
      // Whichever CG the sweep reaches first cannot read its log.
      failNextRead('.log', 'EIO');

      await expect(store.prune()).rejects.toMatchObject({ code: 'EIO' });
      // That CG was left alone, and the sweep went on to the other one.
      expect((await logState()).sort()).toEqual(['kept', 'pruned']);

      // The next sweep reaches the one that was skipped.
      expect(await store.prune()).toMatchObject({ cgsPruned: 1 });
      expect(await logState()).toEqual(['pruned', 'pruned']);
    });
  });
});
