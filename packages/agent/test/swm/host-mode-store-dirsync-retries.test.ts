/**
 * Crash-safety of the SWM host-mode store's disk writes, part 4: a rename or unlink whose directory
 * fsync failed is remembered per change, and an idempotent retry completes that fsync before it
 * acknowledges (the four `mark*` mutators, prune's rewrite and unlink, the cold-load reconcile
 * write, a cap eviction), including the overlapping and out-of-order fsync cases that the
 * per-change generation exists for. The seeded `host-mode-store-dirsync-model.test.ts` is the
 * randomised counterpart.
 *
 * Shared fixture and pause controls: `test/_helpers/host-mode-store-durability-support.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import {
  cgKey,
  holdNextDirSync,
  newStore,
  parseFrames,
  useDurabilityFixture,
} from '../_helpers/host-mode-store-durability-support.js';

describe('SwmHostModeStore durable writes', () => {
  const fx = useDurabilityFixture();
  const { tempFiles, seedLaggingMeta } = fx;

  describe('a retry after a failed directory fsync completes durability before it acknowledges', () => {
    const dirSyncCount = () => vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.length;
    const failNextDirSync = (message = 'injected dir fsync failure') =>
      vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockRejectedValueOnce(new Error(message));
    type Mutator = {
      name: string;
      /** Puts the CG in the state the mutator will flip, durably. */
      prepare: (s: SwmHostModeStore, cg: string) => Promise<void>;
      run: (s: SwmHostModeStore, cg: string) => Promise<void>;
      /** What the meta file shows once `run` has renamed its new file into place. */
      visible: Record<string, unknown>;
    };
    const noop = async () => {};
    // Every mutator of the store that has an idempotency early return.
    const MUTATORS: Mutator[] = [
      { name: 'markRegistered', prepare: noop, run: (s, cg) => s.markRegistered(cg), visible: { registered: true } },
      { name: 'markUnregistered', prepare: (s, cg) => s.markRegistered(cg), run: (s, cg) => s.markUnregistered(cg), visible: { registered: false } },
      { name: 'markHostModeSubscribed', prepare: noop, run: (s, cg) => s.markHostModeSubscribed(cg), visible: { hostModeSubscribed: true } },
      { name: 'markHostModeUnsubscribed', prepare: (s, cg) => s.markHostModeSubscribed(cg), run: (s, cg) => s.markHostModeUnsubscribed(cg), visible: { hostModeSubscribed: false } },
    ];

    it.each(MUTATORS)('$name: the retry finds the renamed file, completes the failed directory fsync, and only then is idempotent', async ({ name, prepare, run, visible }) => {
      const store = newStore(fx.dir);
      const cg = `cg/dirsync-${name}`;
      await prepare(store, cg);
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);

      failNextDirSync();
      await expect(run(store, cg)).rejects.toThrow('injected dir fsync failure');
      // The gap: the rename went through, the file already shows the requested state.
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject(visible);

      const renames = vi.spyOn(fsp, 'rename');
      const before = dirSyncCount();
      await run(store, cg); // the retry
      expect(dirSyncCount() - before, 'the retry must complete the failed directory fsync').toBe(1);
      expect(path.resolve(String(vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.at(-1)?.[0]))).toBe(path.resolve(fx.dir));
      expect(renames, 'the retry must not rewrite an already-correct file').not.toHaveBeenCalled();

      // Durable now: further identical calls stay free (idempotency preserved).
      const settled = dirSyncCount();
      await run(store, cg);
      await run(store, cg);
      expect(dirSyncCount()).toBe(settled);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject(visible);
      expect(await tempFiles()).toEqual([]);
    });

    it.each(MUTATORS)('$name: a second failure keeps the pending mark, the next retry syncs again, then it is free', async ({ name, prepare, run }) => {
      const store = newStore(fx.dir);
      const cg = `cg/dirsync-twice-${name}`;
      await prepare(store, cg);

      failNextDirSync('first failure');
      await expect(run(store, cg)).rejects.toThrow('first failure');
      failNextDirSync('second failure');
      // The retry's own fsync fails: it must not acknowledge.
      await expect(run(store, cg)).rejects.toThrow('second failure');

      const before = dirSyncCount();
      await run(store, cg);
      expect(dirSyncCount() - before, 'the mark survived the failed retry').toBe(1);
      const settled = dirSyncCount();
      await run(store, cg);
      expect(dirSyncCount()).toBe(settled);
    });

    it('prune: a retry that finds the log already pruned completes the failed directory fsync', async () => {
      let nowMs = 1_000_000;
      const limits = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      const store = newStore(fx.dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
      const cg = 'cg/dirsync-prune';
      await store.append(cg, new Uint8Array([1]));
      nowMs += 1_000;
      await store.append(cg, new Uint8Array([2]));
      await store.append(cg, new Uint8Array([3]));
      const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);

      failNextDirSync();
      await expect(store.prune()).rejects.toThrow('injected dir fsync failure');
      // The gap: the pruned log is already in place, so a retry sees nothing left to drop.
      expect(parseFrames(await readFile(logPath)).seqnos).toEqual([2, 3]);

      const renames = vi.spyOn(fsp, 'rename');
      const before = dirSyncCount();
      expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 });
      expect(dirSyncCount() - before, 'the retry must complete the failed directory fsync').toBe(1);
      expect(renames).not.toHaveBeenCalled();
      const settled = dirSyncCount();
      await store.prune();
      expect(dirSyncCount()).toBe(settled);
    });

    it('prune: a second failure keeps the pending mark too', async () => {
      let nowMs = 1_000_000;
      const limits = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      const store = newStore(fx.dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
      const cg = 'cg/dirsync-prune-twice';
      await store.append(cg, new Uint8Array([1]));
      nowMs += 1_000;
      await store.append(cg, new Uint8Array([2]));

      failNextDirSync('first failure');
      await expect(store.prune()).rejects.toThrow('first failure');
      failNextDirSync('second failure');
      await expect(store.prune()).rejects.toThrow('second failure');

      const before = dirSyncCount();
      await store.prune();
      expect(dirSyncCount() - before).toBe(1);
      const settled = dirSyncCount();
      await store.prune();
      expect(dirSyncCount()).toBe(settled);
    });

    it('a cold-load reconcile write whose directory fsync fails leaves the mark for the next idempotent mutation', async () => {
      const cg = 'cg/dirsync-reconcile';
      await seedLaggingMeta(cg, { registered: true });
      const store = newStore(fx.dir);
      await store.init();

      failNextDirSync(); // the reconcile write renames, then its fsync fails: swallowed (best-effort)
      expect(await store.getLastSeqno(cg)).toBe(3);

      const before = dirSyncCount();
      await store.markRegistered(cg); // already registered: nothing to write, but the rename is not durable yet
      expect(dirSyncCount() - before).toBe(1);
      const settled = dirSyncCount();
      await store.markRegistered(cg);
      expect(dirSyncCount()).toBe(settled);
    });

    it('a later successful directory fsync of the same directory covers the pending rename (append, or another CG)', async () => {
      const store = newStore(fx.dir);
      const x = 'cg/dirsync-cover-x';
      const y = 'cg/dirsync-cover-y';

      failNextDirSync();
      await expect(store.markRegistered(x)).rejects.toThrow('injected dir fsync failure');
      // The append's own cursor write ends with a directory fsync that succeeds.
      await store.append(x, new Uint8Array([1]));
      let before = dirSyncCount();
      await store.markRegistered(x);
      expect(dirSyncCount() - before, 'covered by the append\'s directory fsync').toBe(0);

      failNextDirSync();
      await expect(store.markHostModeSubscribed(x)).rejects.toThrow('injected dir fsync failure');
      // A different CG's successful write in the same directory covers it too.
      await store.markRegistered(y);
      before = dirSyncCount();
      await store.markHostModeSubscribed(x);
      expect(dirSyncCount() - before, 'covered by the other CG\'s directory fsync').toBe(0);
    });

    it('a rename that fails its own fsync while another fsync is in flight is not cleared by the other one', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const x = 'cg/dirsync-inflight-x';
      const y = 'cg/dirsync-inflight-y';

      failNextDirSync();
      await expect(store.markRegistered(x)).rejects.toThrow('injected dir fsync failure');

      // X's retry completes its fsync; hold that fsync open.
      const heldX = holdNextDirSync(fx.actualDirFsync);
      const retryX = store.markRegistered(x);
      // (Race against the retry itself so a build whose retry never syncs fails here instead of hanging.)
      expect(await Promise.race([heldX.reached.then(() => true), retryX.then(() => false)]), 'the retry must start a directory fsync').toBe(true);

      // Meanwhile Y renames its meta into place and ITS directory fsync fails.
      failNextDirSync('y failure');
      await expect(store.markRegistered(y)).rejects.toThrow('y failure');
      heldX.release();
      await retryX;

      // X's fsync started before Y's rename returned, so it cannot vouch for Y.
      const before = dirSyncCount();
      await store.markRegistered(y);
      expect(dirSyncCount() - before, 'Y stayed pending').toBe(1);
      const settled = dirSyncCount();
      await store.markRegistered(y);
      await store.markRegistered(x);
      expect(dirSyncCount()).toBe(settled);
    });

    // A pending mark is about ONE rename of its target. A directory fsync covers the renames
    // that had returned before it started and nothing later, so a target renamed AGAIN while
    // such an fsync is in flight must stay pending even though the path was already in the set.
    it('a target that is already pending and is renamed again while a covering fsync is in flight stays pending', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const x = 'cg/dirsync-rerename-x';
      const y = 'cg/dirsync-rerename-y';

      failNextDirSync('x first failure');
      await expect(store.markRegistered(x)).rejects.toThrow('x first failure'); // X: rename 1, not durable
      const held = holdNextDirSync(fx.actualDirFsync);
      const writeY = store.markRegistered(y); // Y's fsync snapshots X as covered and stays in flight
      await held.reached;
      failNextDirSync('x second failure');
      // X flips again: rename 2 happens AFTER the in-flight fsync started, and its own fsync fails.
      await expect(store.markUnregistered(x)).rejects.toThrow('x second failure');
      held.release();
      await writeY;

      // The retry finds the file already saying registered=false (rename 2). The fsync that just
      // finished started before that rename, so it cannot vouch for it: the retry must sync.
      const before = dirSyncCount();
      await store.markUnregistered(x);
      expect(dirSyncCount() - before, 'rename 2 of X was acknowledged without a directory fsync that started after it').toBe(1);
      const settled = dirSyncCount();
      await store.markUnregistered(x);
      await store.markRegistered(y);
      expect(dirSyncCount()).toBe(settled);
    });

    it('with three targets, a covering fsync clears exactly the ones whose rename it had seen', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const [x, y, z] = ['cg/dirsync-three-x', 'cg/dirsync-three-y', 'cg/dirsync-three-z'];

      failNextDirSync('x failure');
      await expect(store.markRegistered(x)).rejects.toThrow('x failure');
      failNextDirSync('y failure');
      await expect(store.markRegistered(y)).rejects.toThrow('y failure');
      const held = holdNextDirSync(fx.actualDirFsync);
      const writeZ = store.markRegistered(z); // snapshots X and Y
      await held.reached;
      failNextDirSync('x again');
      await expect(store.markUnregistered(x)).rejects.toThrow('x again'); // X: a newer rename the snapshot never saw
      held.release();
      await writeZ;

      const settled = dirSyncCount();
      await store.markRegistered(y);
      await store.markRegistered(z);
      expect(dirSyncCount() - settled, 'Y (seen by the fsync) and Z (its own fsync) are durable').toBe(0);
      await store.markUnregistered(x);
      expect(dirSyncCount() - settled, 'X\'s second rename is not').toBe(1);
      await store.markUnregistered(x);
      expect(dirSyncCount() - settled).toBe(1);
    });

    it('overlapping directory fsyncs: whichever one covers a pending rename clears it, and the other finishing either way changes nothing', async () => {
      for (const order of [
        { first: 'ok', second: 'fail' },
        { first: 'fail', second: 'ok' },
      ] as const) {
        const store = newStore(fx.dir); // a fresh instance per round: the previous one is idle
        const x = `cg/dirsync-overlap-x-${order.first}`;
        const a = `cg/dirsync-overlap-a-${order.first}`;
        const b = `cg/dirsync-overlap-b-${order.first}`;
        await store.init();
        failNextDirSync('x failure');
        await expect(store.markRegistered(x)).rejects.toThrow('x failure');

        const heldA = holdNextDirSync(fx.actualDirFsync);
        const writeA = store.markRegistered(a); // both fsyncs below have X in their snapshot
        await heldA.reached;
        const heldB = holdNextDirSync(fx.actualDirFsync);
        const writeB = store.markRegistered(b);
        await heldB.reached;
        const settle = (held: ReturnType<typeof holdNextDirSync>, outcome: 'ok' | 'fail') =>
          held.release(outcome === 'ok' ? 'ok' : new Error('overlap failure'));
        settle(heldA, order.first);
        await (order.first === 'ok' ? writeA : expect(writeA).rejects.toThrow('overlap failure'));
        settle(heldB, order.second);
        await (order.second === 'ok' ? writeB : expect(writeB).rejects.toThrow('overlap failure'));

        // One of the two succeeded after X's rename returned, so X is durable either way.
        const before = dirSyncCount();
        await store.markRegistered(x);
        expect(dirSyncCount() - before, `first ${order.first}, second ${order.second}`).toBe(0);
        // The one that failed stays pending itself.
        const failed = order.first === 'fail' ? a : b;
        await store.markRegistered(failed);
        expect(dirSyncCount() - before, `the failed write (${failed}) must complete its own fsync`).toBe(1);
      }
    });

    it('one directory fsync completes every pending target in the directory, and a failing one keeps all of them', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const cgs = ['cg/dirsync-all-x', 'cg/dirsync-all-y', 'cg/dirsync-all-z'];
      for (const cg of cgs) {
        failNextDirSync(`${cg} failure`);
        await expect(store.markRegistered(cg)).rejects.toThrow(`${cg} failure`);
      }

      failNextDirSync('retry failure');
      await expect(store.markRegistered(cgs[0])).rejects.toThrow('retry failure');
      let before = dirSyncCount();
      await store.markRegistered(cgs[0]); // succeeds: covers all three
      expect(dirSyncCount() - before).toBe(1);
      before = dirSyncCount();
      await store.markRegistered(cgs[1]);
      await store.markRegistered(cgs[2]);
      expect(dirSyncCount() - before, 'the one successful fsync covered the other two').toBe(0);
    });

    describe('prune that drops every entry (the log is unlinked)', () => {
      const EXPIRED_LIMITS = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      let nowMs = 1_000_000;

      /** A store holding two frames that have both expired by the time `prune()` runs. */
      async function expiredLog(cg: string) {
        nowMs = 1_000_000;
        const store = newStore(fx.dir, { unregisteredLimits: EXPIRED_LIMITS, registeredLimits: EXPIRED_LIMITS, now: () => nowMs });
        await store.append(cg, new Uint8Array([1]));
        await store.append(cg, new Uint8Array([2]));
        nowMs += 10_000;
        return { store, logPath: path.join(fx.dir, `${cgKey(cg)}.log`) };
      }

      it('a failed directory fsync rejects; the retry finds the log already gone, completes the fsync, and only then reports done', async () => {
        const { store, logPath } = await expiredLog('cg/dirsync-unlink');

        failNextDirSync();
        await expect(store.prune()).rejects.toThrow('injected dir fsync failure');
        // The gap: the unlink went through, so a retry finds no log and nothing to drop.
        await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });

        const rm = vi.spyOn(fsp, 'rm');
        const before = dirSyncCount();
        expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 });
        expect(dirSyncCount() - before, 'the retry must complete the failed directory fsync').toBe(1);
        expect(rm, 'the retry must not unlink again').not.toHaveBeenCalled();
        const settled = dirSyncCount();
        await store.prune();
        expect(dirSyncCount()).toBe(settled);
      });

      it('a second failure keeps the pending mark, the next retry syncs again, then it is free', async () => {
        const { store } = await expiredLog('cg/dirsync-unlink-twice');

        failNextDirSync('first failure');
        await expect(store.prune()).rejects.toThrow('first failure');
        failNextDirSync('second failure');
        await expect(store.prune()).rejects.toThrow('second failure');

        const before = dirSyncCount();
        await store.prune();
        expect(dirSyncCount() - before, 'the mark survived the failed retry').toBe(1);
        const settled = dirSyncCount();
        await store.prune();
        expect(dirSyncCount()).toBe(settled);
      });

      it('a later successful directory fsync covers the unlink: a meta write of another CG', async () => {
        const { store } = await expiredLog('cg/dirsync-unlink-cover');

        failNextDirSync();
        await expect(store.prune()).rejects.toThrow('injected dir fsync failure');
        await store.markRegistered('cg/dirsync-unlink-cover-other'); // meta rename + a successful directory fsync, after the unlink
        const before = dirSyncCount();
        expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 });
        expect(dirSyncCount() - before, 'covered by the other CG\'s directory fsync').toBe(0);
      });

      it('a later successful directory fsync covers the unlink: an append that recreates the log', async () => {
        const cg = 'cg/dirsync-unlink-recreate';
        const { store, logPath } = await expiredLog(cg);

        failNextDirSync();
        await expect(store.prune()).rejects.toThrow('injected dir fsync failure');
        await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await store.append(cg, new Uint8Array([3]))).toBe(3); // the log is back; its cursor write syncs the directory
        const before = dirSyncCount();
        expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 }); // the fresh frame stays, nothing pending
        expect(dirSyncCount() - before).toBe(0);
        expect(parseFrames(await readFile(logPath)).seqnos).toEqual([3]);
      });

      it('a cap eviction that removes the log is covered too: the failing fsync rejects the append, and the retry completes it', async () => {
        const tiny = { perCgByteCap: 10, ttlMs: 60_000 }; // a 20-byte frame alone exceeds the cap
        const store = newStore(fx.dir, { unregisteredLimits: tiny, registeredLimits: tiny });
        const cg = 'cg/dirsync-unlink-cap';
        const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);
        const dirSync = vi.mocked(fsPolicy.fsyncRfc64DirectoryV1);

        // The append's own cursor write syncs the directory first (passes), the eviction's unlink second (fails).
        dirSync.mockImplementationOnce(async (p) => fx.actualDirFsync(p));
        failNextDirSync('eviction failure');
        await expect(store.append(cg, new Uint8Array(20).fill(7))).rejects.toThrow('eviction failure');
        await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' }); // evicted (the cursor did advance: seqno 1 is burnt)
        expect(await store.getLastSeqno(cg)).toBe(1);

        // The retry takes the next seqno; its cursor write's directory fsync also covers the pending unlink.
        expect(await store.append(cg, new Uint8Array(20).fill(8))).toBe(2);
        await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const settled = dirSyncCount();
        await store.prune(); // nothing to do, nothing pending
        expect(dirSyncCount()).toBe(settled);
      });
    });

    it('prune and meta writes share the directory: a successful meta write covers a prune rename whose fsync failed', async () => {
      let nowMs = 1_000_000;
      const limits = { perCgByteCap: 1024 * 1024, ttlMs: 100 };
      const store = newStore(fx.dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
      const cg = 'cg/dirsync-prune-meta';
      await store.append(cg, new Uint8Array([1]));
      nowMs += 1_000;
      await store.append(cg, new Uint8Array([2]));

      failNextDirSync();
      await expect(store.prune()).rejects.toThrow('injected dir fsync failure'); // the log rename is pending
      await store.markRegistered(cg); // meta rename + a successful directory fsync, after the log rename
      const before = dirSyncCount();
      expect(await store.prune()).toEqual({ bytesPruned: 0, cgsPruned: 0 });
      expect(dirSyncCount() - before, 'covered by the meta write\'s directory fsync').toBe(0);
    });
  });
});
