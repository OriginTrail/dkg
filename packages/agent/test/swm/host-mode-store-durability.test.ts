/**
 * Crash-safety of the SWM host-mode store's disk writes: atomic temp + fsync +
 * rename + directory fsync for `.meta` and prune rewrites, an fsynced frame
 * before the cursor on append, leftover-temp handling, and torn-tail repair.
 *
 * The end-to-end kill -9 counterpart lives in
 * `host-mode-store-crash.e2e.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rfc64/secure-filesystem-policy-v1.js')>();
  return { ...actual, fsyncRfc64DirectoryV1: vi.fn(actual.fsyncRfc64DirectoryV1) };
});

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import {
  SwmHostModeStore,
  type SwmHostModeStartupReconcileReport,
} from '../../src/swm/host-mode-store.js';

const HEADER_BYTES = 20;
const LIMITS = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };

function cgKey(contextGraphId: string): string {
  return createHash('sha256').update(contextGraphId).digest('base64url');
}

function newStore(
  dataDir: string,
  extra: Partial<ConstructorParameters<typeof SwmHostModeStore>[0]> = {},
): SwmHostModeStore {
  return new SwmHostModeStore({
    dataDir,
    unregisteredLimits: LIMITS,
    registeredLimits: LIMITS,
    ...extra,
  });
}

/** Independent re-implementation of the frame walk, so the store cannot vouch for itself. */
function parseFrames(buf: Buffer): { seqnos: number[]; timestamps: number[]; validLength: number } {
  const seqnos: number[] = [];
  const timestamps: number[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + HEADER_BYTES + len;
    if (end > buf.length) break;
    timestamps.push(Number(buf.readBigUInt64BE(offset)));
    seqnos.push(Number(buf.readBigUInt64BE(offset + 8)));
    offset = end;
  }
  return { seqnos, timestamps, validLength: offset };
}

function frame(seqno: number, payload: Uint8Array, timestampMs = Date.now()): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeBigUInt64BE(BigInt(timestampMs), 0);
  header.writeBigUInt64BE(BigInt(seqno), 8);
  header.writeUInt32BE(payload.length, 16);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('SwmHostModeStore durable writes', () => {
  let dir: string;
  let fileHandleProto: FileHandle;
  let actualDirFsync: typeof fsPolicy.fsyncRfc64DirectoryV1;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dkg-host-store-durable-'));
    // FileHandle is not exported; its prototype is reachable through any open handle.
    const probePath = path.join(dir, '.probe');
    await writeFile(probePath, 'x');
    const probe = await fsp.open(probePath, 'r');
    fileHandleProto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    await rm(probePath, { force: true });
    actualDirFsync = (await vi.importActual<typeof fsPolicy>(
      '../../src/rfc64/secure-filesystem-policy-v1.js',
    )).fsyncRfc64DirectoryV1;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Record open/sync/rename/directory-fsync calls the store makes, with the
   * per-CG key and the unique temp suffix normalised so a single-CG test can
   * assert the exact durability sequence.
   */
  function traceDurability(): string[] {
    const events: string[] = [];
    // Keyed by handle object, not fd: fd numbers are reused (the directory
    // handle opened by the directory fsync often gets a just-closed temp's fd).
    const names = new WeakMap<object, string>();
    const label = (p: unknown): string =>
      path.basename(String(p))
        .replace(/\.tmp-\d+-[0-9a-f-]{36}$/, '.tmp')
        .replace(/^[A-Za-z0-9_-]{43}/, 'K');
    const realOpen = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<FileHandle>;
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: unknown[]) => {
      const handle = await realOpen(...args);
      names.set(handle, label(args[0]));
      events.push(`open:${label(args[0])}`);
      return handle;
    }) as never);
    const realSync = fileHandleProto.sync;
    vi.spyOn(fileHandleProto, 'sync').mockImplementation(async function (this: FileHandle) {
      // Handles the store did not open through fs.promises.open (the
      // directory fsync opens its own) are not part of the sequence.
      const name = names.get(this);
      if (name !== undefined) events.push(`sync:${name}`);
      return realSync.call(this);
    });
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      events.push(`rename:${label(from)}->${label(to)}`);
      return realRename(from, to);
    });
    vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockImplementation(async (p) => {
      events.push(`dirsync:${path.resolve(p) === path.resolve(dir) ? 'dataDir' : p}`);
      return actualDirFsync(p);
    });
    return events;
  }

  async function tempFiles(): Promise<string[]> {
    return (await readdir(dir)).filter((n) => n.includes('.tmp-')).sort();
  }

  describe('atomic write sequence', () => {
    it('append fsyncs the frame, then writes the cursor via temp + fsync + rename + directory fsync', async () => {
      const store = newStore(dir);
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
      const store = newStore(dir);
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
      const meta = JSON.parse(await readFile(path.join(dir, `${cgKey('cg/seq-2')}.meta`), 'utf8'));
      expect(meta).toMatchObject({ registered: true, hostModeSubscribed: true, contextGraphId: 'cg/seq-2' });
      expect(await tempFiles()).toEqual([]);
    });

    it('prune rewrites the log via temp + fsync + rename + directory fsync', async () => {
      let nowMs = 1_000_000;
      const store = newStore(dir, {
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
      const log = await readFile(path.join(dir, `${cgKey(cg)}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [2, 3], validLength: log.length });
      expect(await tempFiles()).toEqual([]);
    });

    it('prune that drops every entry still just removes the log (no temp file involved)', async () => {
      let nowMs = 1_000_000;
      const store = newStore(dir, {
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

      expect(events).toEqual([]);
      await expect(stat(path.join(dir, `${cgKey(cg)}.log`))).rejects.toMatchObject({ code: 'ENOENT' });
      // The cursor survives the log, so a later append cannot recycle a seqno.
      expect(await newStore(dir).append(cg, new Uint8Array([3]))).toBe(3);
    });

    it('byte-cap eviction during append rewrites the log atomically after the cursor is durable', async () => {
      const capped = { perCgByteCap: 200, ttlMs: 60_000 };
      const store = newStore(dir, { unregisteredLimits: capped, registeredLimits: capped });
      const cg = 'cg/seq-5';
      for (let i = 0; i < 4; i += 1) await store.append(cg, new Uint8Array(40).fill(i + 1));
      const events = traceDurability();

      await store.append(cg, new Uint8Array(40).fill(9));

      expect(events).toEqual([
        'open:K.log', 'sync:K.log',
        'open:K.meta.tmp', 'sync:K.meta.tmp', 'rename:K.meta.tmp->K.meta', 'dirsync:dataDir',
        'open:K.log.tmp', 'sync:K.log.tmp', 'rename:K.log.tmp->K.log', 'dirsync:dataDir',
      ]);
      const log = await readFile(path.join(dir, `${cgKey(cg)}.log`));
      const parsed = parseFrames(log);
      expect(parsed.validLength).toBe(log.length);
      expect(parsed.seqnos.at(-1)).toBe(5);
      expect(log.length).toBeLessThanOrEqual(200);
    });

    it('readers racing a prune only ever observe the whole old log or the whole pruned log', async () => {
      let nowMs = 1_000_000;
      const big = { perCgByteCap: 64 * 1024 * 1024, ttlMs: 500 };
      const store = newStore(dir, { unregisteredLimits: big, registeredLimits: big, now: () => nowMs });
      const cg = 'cg/seq-6';
      const payload = new Uint8Array(64 * 1024).fill(7);
      for (let i = 0; i < 40; i += 1) await store.append(cg, payload);
      nowMs += 1_000;
      for (let i = 0; i < 40; i += 1) await store.append(cg, payload);
      const logPath = path.join(dir, `${cgKey(cg)}.log`);
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
      const store = newStore(dir);
      const cg = 'cg/fail-1';
      await store.markHostModeSubscribed(cg);
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
      const before = await readFile(metaPath, 'utf8');
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected rename failure');

      expect(await readFile(metaPath, 'utf8')).toBe(before);
      expect(await tempFiles()).toEqual([]);
    });

    it('a failed metadata write does not leave the cache ahead of the disk: the retry really writes', async () => {
      const store = newStore(dir);
      const cg = 'cg/fail-1b';
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected rename failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected rename failure');
      // Neither the cache nor the disk claims registration.
      expect(await store.isRegistered(cg)).toBe(false);

      await store.markRegistered(cg);
      expect(await newStore(dir).isRegistered(cg)).toBe(true);
    });

    it('an append whose cursor write fails rejects, keeps its frame servable, and the retry takes the next seqno', async () => {
      const store = newStore(dir);
      const cg = 'cg/fail-1c';
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EIO', 'injected cursor rename failure'));

      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected cursor rename failure');
      // The frame was fsynced before the cursor write, so it is on disk and servable...
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2]);
      // ...and the cursor is re-derived from the log, so the retry cannot recycle seqno 2.
      expect(await store.append(cg, new Uint8Array([3]))).toBe(3);
      expect((await newStore(dir).iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3]);
      expect(await newStore(dir).getLastSeqno(cg)).toBe(3);
    });

    it('persistMeta rejects when the directory fsync fails', async () => {
      const store = newStore(dir);
      const cg = 'cg/fail-2';
      vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockRejectedValueOnce(new Error('injected dir fsync failure'));

      await expect(store.markRegistered(cg)).rejects.toThrow('injected dir fsync failure');
      expect(await tempFiles()).toEqual([]);
    });

    it('closes the temp handle and removes the temp file when the write or the file fsync fails', async () => {
      const store = newStore(dir);
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

      vi.spyOn(fileHandleProto, 'writeFile').mockRejectedValueOnce(errnoError('ENOSPC', 'injected write failure'));
      await expect(store.markRegistered(cg)).rejects.toThrow('injected write failure');
      expect(await tempFiles()).toEqual([]);
      expect(closed).toBe(opened);

      vi.spyOn(fileHandleProto, 'sync').mockRejectedValueOnce(errnoError('EIO', 'injected fsync failure'));
      await expect(store.markRegistered(cg)).rejects.toThrow('injected fsync failure');
      expect(await tempFiles()).toEqual([]);
      expect(closed).toBe(opened);
      // Neither failed attempt produced a meta file; a clean retry still works.
      await expect(stat(path.join(dir, `${cgKey(cg)}.meta`))).rejects.toMatchObject({ code: 'ENOENT' });
      await store.markRegistered(cg);
      expect(await newStore(dir).isRegistered(cg)).toBe(true);
    });

    it('keeps the loadMeta reconcile write best-effort: a failing write neither breaks the cold load nor leaves a temp', async () => {
      const cg = 'cg/fail-4';
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
      const stale = JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg });
      await writeFile(metaPath, stale);
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(errnoError('EACCES', 'injected reconcile rename failure'));

      const second = newStore(dir);
      expect(await second.getLastSeqno(cg)).toBe(3);
      expect(await readFile(metaPath, 'utf8')).toBe(stale);
      expect(await tempFiles()).toEqual([]);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
    });

    it('persists the reconciled cursor durably when the log is ahead of the meta', async () => {
      const cg = 'cg/reconcile-1';
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
      await writeFile(metaPath, JSON.stringify({ seqno: 1, registered: true, contextGraphId: cg }));
      const second = newStore(dir);
      await second.init();
      const events = traceDurability();

      expect(await second.getLastSeqno(cg)).toBe(3);

      expect(events).toEqual([
        'open:K.meta.tmp', 'sync:K.meta.tmp', 'rename:K.meta.tmp->K.meta', 'dirsync:dataDir',
      ]);
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject({ seqno: 3, registered: true });
    });

    it('a failed frame fsync rejects the append, burns its seqno, and never duplicates it on retry', async () => {
      const store = newStore(dir);
      const cg = 'cg/fail-5';
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
      const metaBefore = await readFile(metaPath, 'utf8');
      vi.spyOn(fileHandleProto, 'sync').mockRejectedValueOnce(errnoError('EIO', 'injected frame fsync failure'));

      await expect(store.append(cg, new Uint8Array([2]))).rejects.toThrow('injected frame fsync failure');
      // The cursor was not published for the failed append.
      expect(await readFile(metaPath, 'utf8')).toBe(metaBefore);

      const retry = await store.append(cg, new Uint8Array([3]));
      expect(retry).toBe(3);
      const log = await readFile(path.join(dir, `${cgKey(cg)}.log`));
      const { seqnos, validLength } = parseFrames(log);
      expect(validLength).toBe(log.length);
      expect(new Set(seqnos).size).toBe(seqnos.length);
      expect(seqnos).toEqual([...seqnos].sort((a, b) => a - b));
      expect(seqnos.at(-1)).toBe(3);
    });
  });

  describe('leftover temp files', () => {
    it('sweeps temp files left by a crash before the rename, without touching the intact targets', async () => {
      const cg = 'cg/leftover-1';
      const first = newStore(dir);
      await first.append(cg, new Uint8Array([1, 1]));
      await first.append(cg, new Uint8Array([2, 2]));
      const key = cgKey(cg);
      const logBefore = await readFile(path.join(dir, `${key}.log`));
      const metaBefore = await readFile(path.join(dir, `${key}.meta`), 'utf8');

      // A prune that died mid-write, and a meta write that died before the rename.
      await writeFile(path.join(dir, `${key}.log.tmp-4242-0f0f0f0f-0000-4000-8000-000000000001`), logBefore.subarray(0, 7));
      await writeFile(
        path.join(dir, `${key}.meta.tmp-4242-0f0f0f0f-0000-4000-8000-000000000002`),
        '{"seqno":99,"registered":tr',
      );
      // Decoys that must NOT be swept: not this store's temp naming.
      await writeFile(path.join(dir, 'notes.txt'), 'operator notes');
      await writeFile(path.join(dir, 'unrelated.tmp-1'), 'x');
      await mkdir(path.join(dir, `${key}.log.tmp-not-a-file`));

      const reports: SwmHostModeStartupReconcileReport[] = [];
      const second = newStore(dir, { onStartupReconcile: (r) => reports.push(r) });
      const report = await second.reconcileOrphanLogsNow();

      expect(report).toEqual({ orphanLogsRemoved: 0, orphanBytesRemoved: 0, staleTempFilesRemoved: 2 });
      // Temps alone are not an "orphan log" event: no operator warning.
      expect(reports).toEqual([]);
      expect((await readdir(dir)).sort()).toEqual(
        [`${key}.log`, `${key}.log.tmp-not-a-file`, `${key}.meta`, 'notes.txt', 'unrelated.tmp-1'].sort(),
      );
      expect(await readFile(path.join(dir, `${key}.log`))).toEqual(logBefore);
      expect(await readFile(path.join(dir, `${key}.meta`), 'utf8')).toBe(metaBefore);
      // The seqno cursor never goes backwards and a fresh append lands after the survivors.
      expect(await second.getLastSeqno(cg)).toBe(2);
      expect(await second.append(cg, new Uint8Array([3, 3]))).toBe(3);
      expect((await second.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3]);
    });

    it('a stale temp for a CG that never got its target does not resurrect that CG', async () => {
      const cg = 'cg/leftover-2';
      const key = cgKey(cg);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `${key}.meta.tmp-1-0f0f0f0f-0000-4000-8000-000000000003`),
        JSON.stringify({ seqno: 7, registered: true, contextGraphId: cg }),
      );

      const store = newStore(dir);
      await store.init();

      expect(await store.listHostModeSubscribedCgs()).toEqual([]);
      expect((await store.stats()).cgCount).toBe(0);
      expect(await store.getLastSeqno(cg)).toBe(0);
      expect(await tempFiles()).toEqual([]);
    });

    it('directory scans ignore a temp that appears after init (crash mid-rename in a live process)', async () => {
      const cg = 'cg/leftover-3';
      const other = 'cg/leftover-3-other';
      const store = newStore(dir);
      await store.markHostModeSubscribed(cg);
      // A temp holding a perfectly valid meta for a different CG.
      await writeFile(
        path.join(dir, `${cgKey(other)}.meta.tmp-1-0f0f0f0f-0000-4000-8000-000000000004`),
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
      const store = newStore(dir);
      await store.init();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let atRename: () => void = () => {};
      const reachedRename = new Promise<void>((resolve) => { atRename = resolve; });
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        atRename();
        await gate;
        return realRename(from, to);
      });

      const write = store.markRegistered(cg);
      await reachedRename;
      expect(await tempFiles()).toHaveLength(1);

      const report = await store.reconcileOrphanLogsNow();
      expect(report.staleTempFilesRemoved).toBeUndefined();
      expect(await tempFiles()).toHaveLength(1);

      release();
      await write;
      expect(await tempFiles()).toEqual([]);
      expect(await store.isRegistered(cg)).toBe(true);
      expect(JSON.parse(await readFile(path.join(dir, `${cgKey(cg)}.meta`), 'utf8')).registered).toBe(true);
    });
  });

  describe('torn log tail', () => {
    it('repairs a partial frame left by a crashed append instead of burying later frames behind it', async () => {
      const cg = 'cg/torn-1';
      const key = cgKey(cg);
      const first = newStore(dir);
      await first.append(cg, new Uint8Array([1, 1, 1]));
      await first.append(cg, new Uint8Array([2, 2, 2]));
      const logPath = path.join(dir, `${key}.log`);
      const goodLength = (await readFile(logPath)).length;
      // A frame that claims 100 payload bytes but only 10 reached the disk.
      await appendFile(logPath, Buffer.concat([frame(3, new Uint8Array(100)).subarray(0, HEADER_BYTES + 10)]));

      const second = newStore(dir);
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
      const first = newStore(dir);
      await first.append(cg, new Uint8Array([1]));
      await appendFile(path.join(dir, `${key}.log`), Buffer.from([0, 0, 0, 0, 0, 1, 2]));

      const second = newStore(dir);
      expect(await second.append(cg, new Uint8Array([2]))).toBe(2);
      const log = await readFile(path.join(dir, `${key}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2], validLength: log.length });
    });

    it('checks the tail once per process, not on every append', async () => {
      const cg = 'cg/torn-3';
      const key = cgKey(cg);
      const first = newStore(dir);
      await first.append(cg, new Uint8Array([1]));
      await appendFile(path.join(dir, `${key}.log`), Buffer.from([9, 9, 9]));
      const truncate = vi.spyOn(fileHandleProto, 'truncate');

      const second = newStore(dir);
      for (let i = 0; i < 4; i += 1) await second.append(cg, new Uint8Array([i + 2]));

      expect(truncate).toHaveBeenCalledTimes(1);
      const log = await readFile(path.join(dir, `${key}.log`));
      expect(parseFrames(log)).toMatchObject({ seqnos: [1, 2, 3, 4, 5], validLength: log.length });
    });

    it('leaves a clean log untouched', async () => {
      const cg = 'cg/torn-4';
      const first = newStore(dir);
      await first.append(cg, new Uint8Array([1]));
      const truncate = vi.spyOn(fileHandleProto, 'truncate');

      const second = newStore(dir);
      await second.append(cg, new Uint8Array([2]));

      expect(truncate).not.toHaveBeenCalled();
    });

    it('re-checks the tail after an append that failed part-way (ENOSPC leaves a partial frame)', async () => {
      const cg = 'cg/torn-5';
      const key = cgKey(cg);
      const store = newStore(dir);
      expect(await store.append(cg, new Uint8Array([1]))).toBe(1);
      const realAppendFile = fileHandleProto.appendFile;
      vi.spyOn(fileHandleProto, 'appendFile').mockImplementationOnce(async function (this: FileHandle, data) {
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
      const log = await readFile(path.join(dir, `${key}.log`));
      expect(parseFrames(log).validLength).toBe(log.length);
    });

    it('refuses to append after a tail it cannot inspect instead of writing behind unknown bytes', async () => {
      const cg = 'cg/torn-6';
      await mkdir(dir, { recursive: true });
      // A directory where the log should be: reading it fails with EISDIR, not ENOENT.
      await mkdir(path.join(dir, `${cgKey(cg)}.log`));
      const store = newStore(dir);

      await expect(store.append(cg, new Uint8Array([1]))).rejects.toMatchObject({
        code: expect.stringMatching(/^(EISDIR|EPERM)$/),
      });
    });
  });

  describe('seqno monotonicity across crash windows', () => {
    it('a slow unlocked cold load cannot roll the in-memory cursor back under a concurrent append', async () => {
      const cg = 'cg/mono-race';
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Crash-recovery shape: the meta lags the log, so the cold load must rewrite it durably.
      await writeFile(
        path.join(dir, `${cgKey(cg)}.meta`),
        JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg }),
      );
      const store = newStore(dir);
      await store.init();

      // Hold the FIRST reconcile write (the unlocked reader's) at its rename.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let atRename: () => void = () => {};
      const reachedRename = new Promise<void>((resolve) => { atRename = resolve; });
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
        atRename();
        await gate;
        return realRename(from, to);
      });
      const slowReader = store.getLastSeqno(cg);
      await reachedRename;

      // A locked append cold-loads, appends seqno 4 and publishes the cursor meanwhile.
      expect(await store.append(cg, new Uint8Array([4]))).toBe(4);
      release();
      // The stale reader must observe the installed cursor, not overwrite it with its older snapshot.
      expect(await slowReader).toBe(4);
      expect(await store.append(cg, new Uint8Array([5]))).toBe(5);
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3, 4, 5]);
    });

    it('a durable cursor ahead of a lost frame leaves a gap instead of recycling the seqno', async () => {
      const cg = 'cg/mono-1';
      const key = cgKey(cg);
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Power loss: the meta rename was durable for seqno 3, the frame for seqno 3 was not.
      const logPath = path.join(dir, `${key}.log`);
      const log = await readFile(logPath);
      await writeFile(logPath, log.subarray(0, log.length - (HEADER_BYTES + 1)));

      const second = newStore(dir);
      expect(await second.getLastSeqno(cg)).toBe(3);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
      expect((await second.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 4]);
      // A catch-up client paging strictly-greater-than sees every surviving frame.
      expect((await second.iterate(cg, 2)).map((e) => e.seqno)).toEqual([4]);
    });

    it('a cursor that lags the log is reconciled from the log tail and republished by the next append', async () => {
      const cg = 'cg/mono-2';
      const key = cgKey(cg);
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      // Cursor lags the log by two (each append's meta rename raced the crash).
      await writeFile(path.join(dir, `${key}.meta`), JSON.stringify({ seqno: 1, registered: false, contextGraphId: cg }));

      const second = newStore(dir);
      expect(await second.append(cg, new Uint8Array([4]))).toBe(4);
      expect(JSON.parse(await readFile(path.join(dir, `${key}.meta`), 'utf8')).seqno).toBe(4);
    });
  });
});
