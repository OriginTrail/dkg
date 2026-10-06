/**
 * Shared support for the SWM host-mode store's durability suites
 * (`test/swm/host-mode-store-{durable-writes,tail-recovery,cold-init,dirsync-retries}.test.ts`):
 * one fixture (a fresh data dir per test, the `FileHandle` prototype to spy on, the real directory
 * fsync), the spies that record the durability sequence, and the pause controls (gates) the
 * concurrency tests use.
 *
 * `vi.mock('../../src/rfc64/secure-filesystem-policy-v1.js', ...)` is NOT here: a test file must
 * declare it itself so that it is hoisted above that file's imports. Every suite that uses this
 * module declares the same factory (wrapping `fsyncRfc64DirectoryV1` in `vi.fn`), which
 * `useDurabilityFixture` and the gates rely on.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as fsPolicy from '../../src/rfc64/secure-filesystem-policy-v1.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

export const HEADER_BYTES = 20;
export const LIMITS = { perCgByteCap: 1024 * 1024, ttlMs: 60_000 };

export function cgKey(contextGraphId: string): string {
  return createHash('sha256').update(contextGraphId).digest('base64url');
}

export function newStore(
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
export function parseFrames(buf: Buffer): { seqnos: number[]; timestamps: number[]; validLength: number } {
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

export function frame(seqno: number, payload: Uint8Array, timestampMs = Date.now()): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeBigUInt64BE(BigInt(timestampMs), 0);
  header.writeBigUInt64BE(BigInt(seqno), 8);
  header.writeUInt32BE(payload.length, 16);
  return Buffer.concat([header, Buffer.from(payload)]);
}

export function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

export const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** How many times the (spied) `fs.readFile` was called on a path ending in `suffix`. */
export function readCalls(suffix: string): number {
  return vi.mocked(fsp.readFile).mock.calls.filter(([p]) => String(p).endsWith(suffix)).length;
}

// ───────────────────────────────── gates ──────────────────────────────────

/** A promise the test resolves by hand. */
export function createGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * Pause `fs.rename`. `reached` resolves once a paused rename has started, and `release()` lets the
 * paused rename(s) go on (for real). By default only the FIRST rename after this call is paused
 * (for example the first cold load's reconcile write); `{ every: true }` pauses every rename until
 * released. `spy` is the `rename` spy, for call counts.
 */
export function gateRenames(options: { every?: boolean } = {}) {
  const hold = createGate();
  const started = createGate();
  const realRename = fsp.rename.bind(fsp);
  const pausedRename = async (from: Parameters<typeof realRename>[0], to: Parameters<typeof realRename>[1]) => {
    started.open();
    await hold.promise;
    return realRename(from, to);
  };
  const spy = options.every
    ? vi.spyOn(fsp, 'rename').mockImplementation(pausedRename)
    : vi.spyOn(fsp, 'rename').mockImplementationOnce(pausedRename);
  return { reached: started.promise, release: hold.open, spy };
}

/**
 * Hold the NEXT directory fsync open: `reached` resolves once it has started (it has then taken its
 * snapshot of the pending targets), `release(outcome)` lets it finish, either for real or by
 * failing with the given error.
 */
export function holdNextDirSync(actualDirFsync: typeof fsPolicy.fsyncRfc64DirectoryV1) {
  let settle: (outcome: 'ok' | Error) => void = () => {};
  const outcome = new Promise<'ok' | Error>((resolve) => { settle = resolve; });
  const started = createGate();
  vi.mocked(fsPolicy.fsyncRfc64DirectoryV1).mockImplementationOnce(async (p) => {
    started.open();
    const result = await outcome;
    if (result !== 'ok') throw result;
    return actualDirFsync(p);
  });
  return { reached: started.promise, release: (result: 'ok' | Error = 'ok') => settle(result) };
}

// ──────────────────────────────── fixture ─────────────────────────────────

export interface DurabilityFixture {
  /** The data dir of the current test (a fresh temp dir per test). */
  readonly dir: string;
  /** The prototype of `fs.promises` file handles: `sync`, `writeFile`, `appendFile`, `truncate` live here. */
  readonly fileHandleProto: FileHandle;
  /** The real directory fsync, behind the `vi.fn` wrapper that the test file's `vi.mock` installs. */
  readonly actualDirFsync: typeof fsPolicy.fsyncRfc64DirectoryV1;
  /**
   * Record open/sync/rename/directory-fsync calls the store makes, with the per-CG key and the
   * unique temp suffix normalised so a single-CG test can assert the exact durability sequence.
   */
  traceDurability(): string[];
  /** Names of the temp files currently in the data dir. */
  tempFiles(): Promise<string[]>;
  /** Log holds frames 1..3; the meta on disk lags at seqno 1 (the crash-recovery shape). */
  seedLaggingMeta(cg: string, flags?: { registered?: boolean; hostModeSubscribed?: boolean }): Promise<string>;
}

/**
 * Call inside the suite's `describe`: registers the `beforeEach` / `afterEach` that create and remove
 * the data dir and restore the mocks, and returns the fixture the tests read `dir` and the spies from.
 */
export function useDurabilityFixture(): DurabilityFixture {
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

  return {
    get dir() { return dir; },
    get fileHandleProto() { return fileHandleProto; },
    get actualDirFsync() { return actualDirFsync; },

    traceDurability(): string[] {
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
    },

    async tempFiles(): Promise<string[]> {
      return (await readdir(dir)).filter((n) => n.includes('.tmp-')).sort();
    },

    async seedLaggingMeta(cg, flags = {}): Promise<string> {
      const first = newStore(dir);
      for (let i = 1; i <= 3; i += 1) await first.append(cg, new Uint8Array([i]));
      const metaPath = path.join(dir, `${cgKey(cg)}.meta`);
      await writeFile(
        metaPath,
        JSON.stringify({ seqno: 1, registered: flags.registered ?? false, contextGraphId: cg, ...(flags.hostModeSubscribed ? { hostModeSubscribed: true } : {}) }),
      );
      return metaPath;
    },
  };
}
