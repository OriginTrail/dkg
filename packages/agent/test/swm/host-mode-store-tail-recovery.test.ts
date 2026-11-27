/**
 * Crash-safety of the SWM host-mode store's disk writes, part 2: what a crash leaves behind and how
 * startup and the next append deal with it. Leftover `<file>.tmp-*` siblings (swept by `init()`, never
 * counted as orphan logs, never reaped while this instance still has the write in flight) and a torn
 * log tail (a partial frame repaired before the next append instead of burying later frames behind it).
 *
 * Shared fixture and pause controls: `test/_helpers/host-mode-store-durability-support.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FileHandle } from 'node:fs/promises';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import type { SwmHostModeStartupReconcileReport } from '../../src/swm/host-mode-store.js';
import {
  HEADER_BYTES,
  cgKey,
  errnoError,
  frame,
  gateRenames,
  newStore,
  parseFrames,
  useDurabilityFixture,
} from '../_helpers/host-mode-store-durability-support.js';

describe('SwmHostModeStore durable writes', () => {
  const fx = useDurabilityFixture();
  const { tempFiles } = fx;

  describe('leftover temp files', () => {
    it('sweeps temp files left by a crash before the rename, without touching the intact targets', async () => {
      const cg = 'cg/leftover-1';
      const first = newStore(fx.dir);
      await first.append(cg, new Uint8Array([1, 1]));
      await first.append(cg, new Uint8Array([2, 2]));
      const key = cgKey(cg);
      const logBefore = await readFile(path.join(fx.dir, `${key}.log`));
      const metaBefore = await readFile(path.join(fx.dir, `${key}.meta`), 'utf8');

      // A prune that died mid-write, and a meta write that died before the rename.
      await writeFile(path.join(fx.dir, `${key}.log.tmp-4242-0f0f0f0f-0000-4000-8000-000000000001`), logBefore.subarray(0, 7));
      await writeFile(
        path.join(fx.dir, `${key}.meta.tmp-4242-0f0f0f0f-0000-4000-8000-000000000002`),
        '{"seqno":99,"registered":tr',
      );
      // Decoys that must NOT be swept: not this store's temp naming.
      await writeFile(path.join(fx.dir, 'notes.txt'), 'operator notes');
      await writeFile(path.join(fx.dir, 'unrelated.tmp-1'), 'x');
      await mkdir(path.join(fx.dir, `${key}.log.tmp-not-a-file`));

      const reports: SwmHostModeStartupReconcileReport[] = [];
      const second = newStore(fx.dir, { onStartupReconcile: (r) => reports.push(r) });
      const report = await second.reconcileOrphanLogsNow();

      expect(report).toEqual({ orphanLogsRemoved: 0, orphanBytesRemoved: 0, staleTempFilesRemoved: 2 });
      // Temps alone are not an "orphan log" event: no operator warning.
      expect(reports).toEqual([]);
      expect((await readdir(fx.dir)).sort()).toEqual(
        [`${key}.log`, `${key}.log.tmp-not-a-file`, `${key}.meta`, 'notes.txt', 'unrelated.tmp-1'].sort(),
      );
      expect(await readFile(path.join(fx.dir, `${key}.log`))).toEqual(logBefore);
      expect(await readFile(path.join(fx.dir, `${key}.meta`), 'utf8')).toBe(metaBefore);
      // The seqno cursor never goes backwards and a fresh append lands after the survivors.
      expect(await second.getLastSeqno(cg)).toBe(2);
      expect(await second.append(cg, new Uint8Array([3, 3]))).toBe(3);
      expect((await second.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3]);
    });

    it('a stale temp for a CG that never got its target does not resurrect that CG', async () => {
      const cg = 'cg/leftover-2';
      const key = cgKey(cg);
      await mkdir(fx.dir, { recursive: true });
      await writeFile(
        path.join(fx.dir, `${key}.meta.tmp-1-0f0f0f0f-0000-4000-8000-000000000003`),
        JSON.stringify({ seqno: 7, registered: true, contextGraphId: cg }),
      );

      const store = newStore(fx.dir);
      await store.init();

      expect(await store.listHostModeSubscribedCgs()).toEqual([]);
      expect((await store.stats()).cgCount).toBe(0);
      expect(await store.getLastSeqno(cg)).toBe(0);
      expect(await tempFiles()).toEqual([]);
    });

    it('directory scans ignore a temp that appears after init (crash mid-rename in a live process)', async () => {
      const cg = 'cg/leftover-3';
      const other = 'cg/leftover-3-other';
      const store = newStore(fx.dir);
      await store.markHostModeSubscribed(cg);
      // A temp holding a perfectly valid meta for a different CG.
      await writeFile(
        path.join(fx.dir, `${cgKey(other)}.meta.tmp-1-0f0f0f0f-0000-4000-8000-000000000004`),
        JSON.stringify({ seqno: 1, registered: true, contextGraphId: other, hostModeSubscribed: true }),
      );

      expect(await store.listHostModeSubscribedCgs()).toEqual([cg]);
      expect((await store.stats()).perCg).toEqual({});
      const report = await store.reconcileOrphanLogsNow();
      expect(report.orphanLogsRemoved).toBe(0);
      expect(report.staleTempFilesRemoved).toBe(1);
    });

    it('never reaps the temp file of a write this instance still has in flight', async () => {
      const cg = 'cg/leftover-4';
      const store = newStore(fx.dir);
      await store.init();
      const gate = gateRenames({ every: true });

      const write = store.markRegistered(cg);
      await gate.reached;
      expect(await tempFiles()).toHaveLength(1);

      const report = await store.reconcileOrphanLogsNow();
      expect(report.staleTempFilesRemoved).toBeUndefined();
      expect(await tempFiles()).toHaveLength(1);

      gate.release();
      await write;
      expect(await tempFiles()).toEqual([]);
      expect(await store.isRegistered(cg)).toBe(true);
      expect(JSON.parse(await readFile(path.join(fx.dir, `${cgKey(cg)}.meta`), 'utf8')).registered).toBe(true);
    });
  });

  describe('torn log tail', () => {
    it('repairs a partial frame left by a crashed append instead of burying later frames behind it', async () => {
      const cg = 'cg/torn-1';
      const key = cgKey(cg);
      const first = newStore(fx.dir);
      await first.append(cg, new Uint8Array([1, 1, 1]));
      await first.append(cg, new Uint8Array([2, 2, 2]));
      const logPath = path.join(fx.dir, `${key}.log`);
      const goodLength = (await readFile(logPath)).length;
      // A frame that claims 100 payload bytes but only 10 reached the disk.
      await appendFile(logPath, Buffer.concat([frame(3, new Uint8Array(100)).subarray(0, HEADER_BYTES + 10)]));

      const second = newStore(fx.dir);
      expect((await second.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2]);
      expect(await second.append(cg, new Uint8Array([4, 4, 4]))).toBe(3);
      expect(await second.append(cg, new Uint8Array([5, 5, 5]))).toBe(4);

      const entries = await second.iterate(cg, 0);
      expect(entries.map((e) => e.seqno)).toEqual([1, 2, 3, 4]);
      expect(Array.from(entries[2].envelopeBytes)).toEqual([4, 4, 4]);
      const log = await readFile(logPath);
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2, 3, 4], validLength: log.length });
      expect(log.length).toBe(goodLength + 2 * (HEADER_BYTES + 3));
    });

    it('repairs a tail shorter than one header', async () => {
      const cg = 'cg/torn-2';
      const key = cgKey(cg);
      const first = newStore(fx.dir);
      await first.append(cg, new Uint8Array([1]));
      await appendFile(path.join(fx.dir, `${key}.log`), Buffer.from([0, 0, 0, 0, 0, 1, 2]));

      const second = newStore(fx.dir);
      expect(await second.append(cg, new Uint8Array([2]))).toBe(2);
      const log = await readFile(path.join(fx.dir, `${key}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2], validLength: log.length });
    });

    it('checks the tail once per process, not on every append', async () => {
      const cg = 'cg/torn-3';
      const key = cgKey(cg);
      const first = newStore(fx.dir);
      await first.append(cg, new Uint8Array([1]));
      await appendFile(path.join(fx.dir, `${key}.log`), Buffer.from([9, 9, 9]));
      const truncate = vi.spyOn(fx.fileHandleProto, 'truncate');

      const second = newStore(fx.dir);
      for (let i = 0; i < 4; i += 1) await second.append(cg, new Uint8Array([i + 2]));

      expect(truncate).toHaveBeenCalledTimes(1);
      const log = await readFile(path.join(fx.dir, `${key}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2, 3, 4, 5], validLength: log.length });
    });

    it('leaves a clean log untouched', async () => {
      const cg = 'cg/torn-4';
      const first = newStore(fx.dir);
      await first.append(cg, new Uint8Array([1]));
      const truncate = vi.spyOn(fx.fileHandleProto, 'truncate');

      const second = newStore(fx.dir);
      await second.append(cg, new Uint8Array([2]));

      expect(truncate).not.toHaveBeenCalled();
    });

    it('re-checks the tail after an append that failed part-way (ENOSPC leaves a partial frame)', async () => {
      const cg = 'cg/torn-5';
      const key = cgKey(cg);
      const store = newStore(fx.dir);
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      const realAppendFile = fx.fileHandleProto.appendFile;
      vi.spyOn(fx.fileHandleProto, 'appendFile').mockImplementationOnce(async function (this: FileHandle, data) {
        const bytes = data as Buffer;
        await realAppendFile.call(this, bytes.subarray(0, HEADER_BYTES + 1));
        throw errnoError('ENOSPC', 'injected partial append');
      });

      await expect(store.append(cg, new Uint8Array([2, 2, 2, 2]))).rejects.toThrow('injected partial append');
      const retry = await store.append(cg, new Uint8Array([3, 3, 3, 3]));

      // The failed append burned its seqno; nothing was buried behind the partial frame.
      expect(retry).toBe(3);
      const entries = await store.iterate(cg, 0);
      expect(entries.map((e) => e.seqno)).toEqual([1, 3]);
      expect(Array.from(entries[1].envelopeBytes)).toEqual([3, 3, 3, 3]);
      const log = await readFile(path.join(fx.dir, `${key}.log`));
      expect(parseFrames(log).validLength).toBe(log.length);
    });

    it('refuses to append after a tail it cannot inspect instead of writing behind unknown bytes', async () => {
      const cg = 'cg/torn-6';
      await mkdir(fx.dir, { recursive: true });
      // A directory where the log should be: reading it fails with EISDIR, not ENOENT.
      await mkdir(path.join(fx.dir, `${cgKey(cg)}.log`));
      const store = newStore(fx.dir);

      await expect(store.append(cg, new Uint8Array([1]))).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EPERM)$/),
      });
    });
  });
});
