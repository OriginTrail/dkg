/**
 * Crash-safety of the SWM host-mode store's disk writes, part 1: the atomic write sequence (an
 * fsynced frame before the cursor on append, temp + fsync + rename + directory fsync for `.meta`
 * and prune rewrites, the unlink of a fully expired log) and how each step's failure is handled
 * (what rejects, what is left on disk, temp cleanup, cache drop, the best-effort reconcile write).
 *
 * The other durability suites: `host-mode-store-tail-recovery.test.ts` (leftover temps, torn tail),
 * `host-mode-store-cold-init.test.ts` (the single-owner cold load, seqno monotonicity),
 * `host-mode-store-dirsync-retries.test.ts` (a retry after a failed directory fsync), the seeded
 * `host-mode-store-dirsync-model.test.ts`, and the end-to-end kill -9 counterpart
 * `host-mode-store-crash.e2e.test.ts`. Their shared fixture and pause controls live in
 * `test/_helpers/host-mode-store-durability-support.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import {
  cgKey,
  errnoError,
  newStore,
  parseFrames,
  useDurabilityFixture,
} from '../_helpers/host-mode-store-durability-support.js';

describe('SwmHostModeStore durable writes', () => {
  const fx = useDurabilityFixture();
  const { traceDurability, tempFiles } = fx;

  describe('atomic write sequence', () => {
    it('append fsyncs the frame, then writes the cursor via temp + fsync + rename + directory fsync', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const events = traceDurability();

      await store.append('cg/seq-1', new Uint8Array([1, 2, 3]));

      expect(events).toEqual([
        'open:K.log',
        'sync:K.log',
        'open:K.meta.tmp',
        'sync:K.meta.tmp',
        'rename:K.meta.tmp->K.meta',
        'dirsync:dataDir',
      ]);
      expect(await tempFiles()).toEqual([]);
    });

    it('markRegistered / markHostModeSubscribed write metadata atomically and durably', async () => {
      const store = newStore(fx.dir);
      await store.init();
      const events = traceDurability();

      await store.markRegistered('cg/seq-2');
      await store.markHostModeSubscribed('cg/seq-2');

      const oneWrite = [
        'open:K.meta.tmp',
        'sync:K.meta.tmp',
        'rename:K.meta.tmp->K.meta',
        'dirsync:dataDir',
      ];
      expect(events).toEqual([...oneWrite, ...oneWrite]);
      const meta = JSON.parse(await readFile(path.join(fx.dir, `${cgKey('cg/seq-2')}.meta`), 'utf8'));
      expect(meta).toMatchObject({ registered: true, hostModeSubscribed: true, contextGraphId: 'cg/seq-2' });
      expect(await tempFiles()).toEqual([]);
    });

    it('prune rewrites the log via temp + fsync + rename + directory fsync', async () => {
      let nowMs = 1_000_000;
      const store = newStore(fx.dir, {
        unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
        registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
        now: () => nowMs,
      });
      const cg = 'cg/seq-3';
      await store.append(cg, new Uint8Array([1]));
      nowMs += 1_000;
      await store.append(cg, new Uint8Array([2]));
      await store.append(cg, new Uint8Array([3]));
      const events = traceDurability();

      const result = await store.prune();

      expect(result.cgsPruned).toBe(1);
      expect(events).toEqual([
        'open:K.log.tmp',
        'sync:K.log.tmp',
        'rename:K.log.tmp->K.log',
        'dirsync:dataDir',
      ]);
      const log = await readFile(path.join(fx.dir, `${cgKey(cg)}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [2, 3], validLength: log.length });
      expect(await tempFiles()).toEqual([]);
    });

    it('prune that drops every entry removes the log (no temp file, no rename) and then syncs the directory entry', async () => {
      let nowMs = 1_000_000;
      const store = newStore(fx.dir, {
        unregisteredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
        registeredLimits: { perCgByteCap: 1024 * 1024, ttlMs: 100 },
        now: () => nowMs,
      });
      const cg = 'cg/seq-4';
      await store.append(cg, new Uint8Array([1]));
      await store.append(cg, new Uint8Array([2]));
      nowMs += 10_000;
      const events = traceDurability();

      await store.prune();

      // The unlink is a directory-entry change like a rename: the directory fsync is the only durability step.
      expect(events).toEqual(['dirsync:dataDir']);
      await expect(stat(path.join(fx.dir, `${cgKey(cg)}.log`))).rejects.toMatchObject({ code: 'ENOENT' });
      // The cursor survives the log, so a later append cannot recycle a seqno.
      expect(await newStore(fx.dir).append(cg, new Uint8Array([3]))).toBe(3);
    });

    it('byte-cap eviction during append rewrites the log atomically after the cursor is durable', async () => {
      const capped = { perCgByteCap: 200, ttlMs: 60_000 };
      const store = newStore(fx.dir, { unregisteredLimits: capped, registeredLimits: capped });
      const cg = 'cg/seq-5';
      for (let i = 0; i < 4; i += 1) await store.append(cg, new Uint8Array(40).fill(i + 1));
      const events = traceDurability();

      await store.append(cg, new Uint8Array(40).fill(9));

      expect(events).toEqual([
        'open:K.log', 'sync:K.log',
        'open:K.meta.tmp', 'sync:K.meta.tmp', 'rename:K.meta.tmp->K.meta', 'dirsync:dataDir',
        'open:K.log.tmp', 'sync:K.log.tmp', 'rename:K.log.tmp->K.log', 'dirsync:dataDir',
      ]);
      const log = await readFile(path.join(fx.dir, `${cgKey(cg)}.log`));
      const parsed = parseFrames(log);
      expect(parsed.validLength).toBe(log.length);
      expect(parsed.seqnos.at(-1)).toBe(5);
      expect(log.length).toBeLessThanOrEqual(200);
    });

    it('readers racing a prune only ever observe the whole old log or the whole pruned log', async () => {
      let nowMs = 1_000_000;
      const big = { perCgByteCap: 64 * 1024 * 1024, ttlMs: 500 };
      const store = newStore(fx.dir, { unregisteredLimits: big, registeredLimits: big, now: () => nowMs });
      const cg = 'cg/seq-6';
      const payload = new Uint8Array(64 * 1024).fill(7);
      for (let i = 0; i < 40; i += 1) await store.append(cg, payload);
      nowMs += 1_000;
      for (let i = 0; i < 40; i += 1) await store.append(cg, payload);
      const logPath = path.join(fx.dir, `${cgKey(cg)}.log`);
      const oldLength = (await readFile(logPath)).length;

      let stop = false;
      const lengths = new Set<number>();
      const reader = (async () => {
        while (!stop) {
          try {
            lengths.add((await readFile(logPath)).length);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            lengths.add(-1);
          }
        }
      })();
      await store.prune();
      stop = true;
      await reader;

      const prunedLength = (await readFile(logPath)).length;
      expect(prunedLength).toBeLessThan(oldLength);
      // Never a truncated or missing file in between.
      for (const length of lengths) expect([oldLength, prunedLength]).toContain(length);
    });
  });

  describe('failure handling', () => {
    it('persistMeta rejects when the rename fails, leaves the previous meta intact and removes the temp file', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-1';
      await store.markHostModeSubscribed(cg);
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      const before = await readFile(metaPath, 'utf8');
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected rename failure');

      expect(await readFile(metaPath, 'utf8')).toBe(before);
      expect(await tempFiles()).toEqual([]);
    });

    it('a failed metadata write does not leave the cache ahead of the disk: the retry really writes', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-1b';
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected rename failure');
      // Neither the cache nor the disk claims registration.
      expect(await store.isRegistered(cg)).toBe(false);

      await store.markRegistered(cg);
      expect(await newStore(fx.dir).isRegistered(cg)).toBe(true);
    });

    it('an append whose cursor write fails rejects, keeps its frame servable, and the retry takes the next seqno', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-1c';
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected cursor rename failure'));

      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected cursor rename failure');
      // The frame was fsynced before the cursor write, so it is on disk and servable...
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2]);
      // ...and the cursor is re-derived from the log, so the retry cannot recycle seqno 2.
      expect(await store.append(cg, new Uint8Array([3]))).toBe(3);
      expect((await newStore(fx.dir).iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3]);
      expect(await newStore(fx.dir).getLastSeqno(cg)).toBe(3);
    });

    it('persistMeta rejects when the directory fsync fails', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-2';
      vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockRejectedValueOnce(new Error('injected dir fsync failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected dir fsync failure');
      expect(await tempFiles()).toEqual([]);
    });

    it('closes the temp handle and removes the temp file when the write or the file fsync fails', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-3';
      let opened = 0;
      let closed = 0;
      const realOpen = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<FileHandle>;
      vi.spyOn(fsp, 'open').mockImplementation((async (...args: unknown[]) => {
        const handle = await realOpen(...args);
        opened += 1;
        // `close` is an own (arrow-function) property of a FileHandle, not on its prototype.
        const realClose = handle.close;
        handle.close = () => {
          closed += 1;
          return realClose();
        };
        return handle;
      }) as never);

      vi.spyOn(fx.fileHandleProto, 'writeFile').mockRejectedValueOnce(errnoError('ENOSPC', 'injected write failure'));
      await expect(store.markRegistered(cg)).rejects.toThrow('injected write failure');
      expect(await tempFiles()).toEqual([]);
      expect(closed).toBe(opened);

      vi.spyOn(fx.fileHandleProto, 'sync').mockRejectedValueOnce(errnoError('EIO', 'injected fsync failure'));
      await expect(store.markRegistered(cg)).rejects.toThrow('injected fsync failure');
      expect(await tempFiles()).toEqual([]);
      expect(closed).toBe(opened);
      // Neither failed attempt produced a meta file; a clean retry still works.
      await expect(stat(path.join(fx.dir, `${cgKey(cg)}.meta`))).rejects.toMatchObject({ code: 'ENOENT' });
      await store.markRegistered(cg);
      expect(await newStore(fx.dir).isRegistered(cg)).toBe(true);
    });

    it('keeps the loadMeta reconcile write best-effort: a failing write neither breaks the cold load nor leaves a temp', async () => {
      const cg = 'cg/fail-4';
      const first = newStore(fx.dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      const stale = JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg });
      await writeFile(metaPath, stale);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EACCES', 'injected reconcile rename failure'));

      const second = newStore(fx.dir);
      expect(await second.getLastSeqno(cg)).toBe(3);
      expect(await readFile(metaPath, 'utf8')).toBe(stale);
      expect(await tempFiles()).toEqual([]);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
    });

    it('persists the reconciled cursor durably when the log is ahead of the meta', async () => {
      const cg = 'cg/reconcile-1';
      const first = newStore(fx.dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      await writeFile(metaPath, JSON.stringify({ seqno: 1, registered: true, contextGraphId: cg }));
      const second = newStore(fx.dir);
      await second.init();
      const events = traceDurability();

      expect(await second.getLastSeqno(cg)).toBe(3);

      expect(events).toEqual([
        'open:K.meta.tmp', 'sync:K.meta.tmp', 'rename:K.meta.tmp->K.meta', 'dirsync:dataDir',
      ]);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: true });
    });

    it('a failed frame fsync rejects the append, burns its seqno, and never duplicates it on retry', async () => {
      const store = newStore(fx.dir);
      const cg = 'cg/fail-5';
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      const metaPath = path.join(fx.dir, `${cgKey(cg)}.meta`);
      const metaBefore = await readFile(metaPath, 'utf8');
      vi.spyOn(fx.fileHandleProto, 'sync').mockRejectedValueOnce(errnoError('EIO', 'injected frame fsync failure'));

      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected frame fsync failure');
      // The cursor was not published for the failed append.
      expect(await readFile(metaPath, 'utf8')).toBe(metaBefore);

      const retry = await store.append(cg, new Uint8Array([3]));
      expect(retry).toBe(3);
      const log = await readFile(path.join(fx.dir, `${cgKey(cg)}.log`));
      const { seqnos, validLength } = parseFrames(log);
      expect(validLength).toBe(log.length);
      expect(new Set(seqnos).size).toBe(seqnos.length);
      expect(seqnos).toEqual([...seqnos].sort((a, b) => a - b));
      expect(seqnos.at(-1)).toBe(3);
    });
  });
});
