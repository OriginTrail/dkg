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

  const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

  /** Log holds frames 1..3; the meta on disk lags at seqno 1 (the crash-recovery shape). */
  async function seedLaggingMeta(
    cg: string,
    flags: { registered?: boolean; hostModeSubscribed?: boolean } = {},
  ): Promise<string> {
    const first = newStore(dir);
    for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
    const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
    await writeFile(
      metaPath,
      JSON.stringify({ seqno: 1, registered: flags.registered ?? false, contextGraphId: cg, ...(flags.hostModeSubscribed ? { hostModeSubscribed: true } : {}) }),
    );
    return metaPath;
  }

  /** Pause the FIRST rename after this call (the first cold load's reconcile write) until released. */
  function gateFirstRename() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let atRename: () => void = () => {};
    const reached = new Promise<void>((resolve) => { atRename = resolve; });
    const realRename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
      atRename();
      await gate;
      return realRename(from, to);
    });
    return { reached, release, spy };
  }

  function readCalls(suffix: string): number {
    return vi.mocked(fsp.readFile).mock.calls.filter(([p]) => String(p).endsWith(suffix)).length;
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

    it('prune that drops every entry removes the log (no temp file, no rename) and then syncs the directory entry', async () => {
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

      // The unlink is a directory-entry change like a rename: the directory fsync is the only durability step.
      expect(events).toEqual(['dirsync:dataDir']);
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

  describe('cold metadata initialization has a single owner per CG', () => {
    it('a delayed cold-load reconcile cannot restore a flag a later mutation cleared: a fresh store reads the mutation', async () => {
      const cg = 'cg/init-stale-rename';
      const metaPath = await seedLaggingMeta(cg, { hostModeSubscribed: true });
      const store = newStore(dir);
      await store.init();
      const gate = gateFirstRename();

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
      const fresh = newStore(dir);
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
      const store = newStore(dir);
      await store.init();
      const gate = gateFirstRename();

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
      const fresh = newStore(dir);
      expect(await fresh.getLastSeqno(cg)).toBe(expectMeta.seqno);
      expect(await fresh.isRegistered(cg)).toBe('registered' in expectMeta ? expectMeta.registered : false);
    });

    it('a mutation that starts the initialization is joined by later readers: one reconcile, both orders consistent', async () => {
      const cg = 'cg/init-mutator-first';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(dir);
      await store.init();
      const readFileSpy = vi.spyOn(fsp, 'readFile');
      const gate = gateFirstRename();

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
      const store = newStore(dir);
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
      const store = newStore(dir);
      await store.init();
      // I/O errors are swallowed by the cold load by design (unchanged). Only an unexpected fault
      // rejects it, so inject one: the log read yields a non-buffer, which the tail scan cannot parse.
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
      const store = newStore(dir);
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
      expect(await newStore(dir).isRegistered(cg)).toBe(true);
    });

    it('best-effort reconcile persistence never fails or poisons the shared initialization', async () => {
      const cg = 'cg/init-best-effort';
      const metaPath = await seedLaggingMeta(cg);
      const store = newStore(dir);
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
      const store = newStore(dir);
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
      const store = newStore(dir);
      await store.init();
      // The same answers the store gave before the initialization had an owner (loadMeta was async).
      await expect(store.getLastSeqno(undefined as never)).resolves.toBe(0);
      await expect(store.isRegistered(undefined as never)).resolves.toBe(false);
      await expect(store.getLastSeqno(42 as never)).resolves.toBe(0);

      // A meta whose contextGraphId is not a string (init() reaps those, so it has to appear afterwards)
      // is skipped by the listing instead of failing it.
      await store.markHostModeSubscribed('cg/listed');
      await writeFile(
        path.join(dir, `${cgKey('cg/not-a-string')}.meta`),
        JSON.stringify({ seqno: 1, registered: false, contextGraphId: 123, hostModeSubscribed: true }),
      );
      await expect(store.listHostModeSubscribedCgs()).resolves.toEqual(['cg/listed']);
    });

    it('a failed cursor write drops the cache; the next cold load (a reader) and a queued append share one recovery and stay monotonic', async () => {
      const cg = 'cg/init-evict';
      const store = newStore(dir);
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
      expect(await newStore(dir).getLastSeqno(cg)).toBe(3);
    });
  });

  describe('a retry after a failed directory fsync completes durability before it acknowledges', () => {
    const dirSyncCount = () => vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.length;
    const failNextDirSync = (message = 'injected dir fsync failure') =>
      vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockRejectedValueOnce(new Error(message));
    /**
     * Hold the NEXT directory fsync open: `reached` resolves once it has started (it has
     * then taken its snapshot of the pending targets), `release(outcome)` lets it finish,
     * either for real or by failing.
     */
    function holdNextDirSync() {
      let settle: (outcome: 'ok' | Error) => void = () => {};
      const gate = new Promise<'ok' | Error>((resolve) => { settle = resolve; });
      let started: () => void = () => {};
      const reached = new Promise<void>((resolve) => { started = resolve; });
      vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockImplementationOnce(async (p) => {
        started();
        const outcome = await gate;
        if (outcome !== 'ok') throw outcome;
        return actualDirFsync(p);
      });
      return { reached, release: (outcome: 'ok' | Error = 'ok') => settle(outcome) };
    }

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
      const store = newStore(dir);
      const cg = `cg/dirsync-${name}`;
      await prepare(store, cg);
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);

      failNextDirSync();
      await expect(run(store, cg)).rejects.toThrow('injected dir fsync failure');
      // The gap: the rename went through, the file already shows the requested state.
      expect(JSON.parse(await readFile(metaPath, 'utf8'))).toMatchObject(visible);

      const renames = vi.spyOn(fsp, 'rename');
      const before = dirSyncCount();
      await run(store, cg); // the retry
      expect(dirSyncCount() - before, 'the retry must complete the failed directory fsync').toBe(1);
      expect(path.resolve(String(vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mock.calls.at(-1)?.[0]))).toBe(path.resolve(dir));
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
      const store = newStore(dir);
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
      const store = newStore(dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
      const cg = 'cg/dirsync-prune';
      await store.append(cg, new Uint8Array([1]));
      nowMs += 1_000;
      await store.append(cg, new Uint8Array([2]));
      await store.append(cg, new Uint8Array([3]));
      const logPath = path.join(dir, `${cgKey(cg)}.log`);

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
      const store = newStore(dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
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
      const store = newStore(dir);
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
      const store = newStore(dir);
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
      const store = newStore(dir);
      await store.init();
      const x = 'cg/dirsync-inflight-x';
      const y = 'cg/dirsync-inflight-y';
      const dirSync = vi.mocked(fsPolicy.fsyncRfc64DirectoryV1);

      failNextDirSync();
      await expect(store.markRegistered(x)).rejects.toThrow('injected dir fsync failure');

      // X's retry completes its fsync; hold that fsync open.
      let releaseX: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseX = resolve; });
      let reachedX: () => void = () => {};
      const xInFlight = new Promise<void>((resolve) => { reachedX = resolve; });
      dirSync.mockImplementationOnce(async (p) => {
        reachedX();
        await gate;
        return actualDirFsync(p);
      });
      const retryX = store.markRegistered(x);
      // (Race against the retry itself so a build whose retry never syncs fails here instead of hanging.)
      expect(await Promise.race([xInFlight.then(() => true), retryX.then(() => false)]), 'the retry must start a directory fsync').toBe(true);

      // Meanwhile Y renames its meta into place and ITS directory fsync fails.
      failNextDirSync('y failure');
      await expect(store.markRegistered(y)).rejects.toThrow('y failure');
      releaseX();
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
      const store = newStore(dir);
      await store.init();
      const x = 'cg/dirsync-rerename-x';
      const y = 'cg/dirsync-rerename-y';

      failNextDirSync('x first failure');
      await expect(store.markRegistered(x)).rejects.toThrow('x first failure'); // X: rename 1, not durable
      const held = holdNextDirSync();
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
      const store = newStore(dir);
      await store.init();
      const [x, y, z] = ['cg/dirsync-three-x', 'cg/dirsync-three-y', 'cg/dirsync-three-z'];

      failNextDirSync('x failure');
      await expect(store.markRegistered(x)).rejects.toThrow('x failure');
      failNextDirSync('y failure');
      await expect(store.markRegistered(y)).rejects.toThrow('y failure');
      const held = holdNextDirSync();
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
        const store = newStore(dir); // a fresh instance per round: the previous one is idle
        const x = `cg/dirsync-overlap-x-${order.first}`;
        const a = `cg/dirsync-overlap-a-${order.first}`;
        const b = `cg/dirsync-overlap-b-${order.first}`;
        await store.init();
        failNextDirSync('x failure');
        await expect(store.markRegistered(x)).rejects.toThrow('x failure');

        const heldA = holdNextDirSync();
        const writeA = store.markRegistered(a); // both fsyncs below have X in their snapshot
        await heldA.reached;
        const heldB = holdNextDirSync();
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
      const store = newStore(dir);
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
        const store = newStore(dir, { unregisteredLimits: EXPIRED_LIMITS, registeredLimits: EXPIRED_LIMITS, now: () => nowMs });
        await store.append(cg, new Uint8Array([1]));
        await store.append(cg, new Uint8Array([2]));
        nowMs += 10_000;
        return { store, logPath: path.join(dir, `${cgKey(cg)}.log`) };
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
        const store = newStore(dir, { unregisteredLimits: tiny, registeredLimits: tiny });
        const cg = 'cg/dirsync-unlink-cap';
        const logPath = path.join(dir, `${cgKey(cg)}.log`);
        const dirSync = vi.mocked(fsPolicy.fsyncRfc64DirectoryV1);

        // The append's own cursor write syncs the directory first (passes), the eviction's unlink second (fails).
        dirSync.mockImplementationOnce(async (p) => actualDirFsync(p));
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
      const store = newStore(dir, { unregisteredLimits: limits, registeredLimits: limits, now: () => nowMs });
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

  describe('seqno monotonicity across crash windows', () => {
    it('a slow unlocked cold load cannot roll the cursor back: a concurrent append waits for that one initialization and stays monotonic', async () => {
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
      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
        atRename();
        await gate;
        return realRename(from, to);
      });
      const slowReader = store.getLastSeqno(cg);
      await reachedRename;

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
      release();
      expect(await appended).toBe(4);
      // The reader linearises with the initialization it shared: it reports the reconciled cursor
      // (3), or the appended one (4) if the append's continuation ran first. Never the stale 1.
      expect([3, 4]).toContain(await slowReader);
      expect(await store.append(cg, new Uint8Array([5]))).toBe(5);
      expect((await store.iterate(cg, 0)).map((e) => e.seqno)).toEqual([1, 2, 3, 4, 5]);
      // One reconcile write for the shared initialization, then one cursor write per append.
      expect(renameSpy).toHaveBeenCalledTimes(3);
      expect(JSON.parse(await readFile(path.join(dir, `${cgKey(cg)}.meta`), 'utf8')).seqno).toBe(5);
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
