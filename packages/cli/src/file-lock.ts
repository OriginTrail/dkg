import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import {
  link, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile, type FileHandle,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { hasErrorCode } from '@origintrail-official/dkg-core';
import { replaceFileDurably, type DurableReplaceOptions, type ReplaceStrategy } from './durable-file-replace.js';

/**
 * How long a holder's lease lasts without renewal. A holder renews it several
 * times over while its callback runs, so a lock not renewed for this long was
 * abandoned (its pid was reused, or cannot be checked from here) or belongs to
 * a holder stalled for as long, which can then no longer commit.
 */
const LOCK_STALE_MS = 60 * 1000;
const LEASE_RENEWALS_PER_STALE_PERIOD = 6;
/** Until a lock file is this old, missing metadata means its holder is still writing it. */
const LOCK_WRITE_GRACE_MS = 5000;
const LOCK_POLL_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
/** The longest a holder waits for the guard to commit or release; it is held only across a check and one step. */
const GUARD_TIMEOUT_MS = 10_000;
/** What link() fails with on a filesystem without hard links. */
const NO_HARD_LINK_CODES = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];

/**
 * Tokens of the locks and guards this thread holds. One naming this thread's
 * pid with any other token was left by an earlier process that had the same
 * pid, as a restarted container's pid 1 does.
 */
const heldTokens = new Set<string>();

let cachedPidNamespace: string | undefined;

/**
 * Where this process's pid means something: the host and, on Linux, its pid
 * namespace. Two containers sharing one home can both run as pid 1, and a pid
 * recorded in another namespace cannot be checked from this one.
 */
function pidNamespace(): string {
  if (cachedPidNamespace === undefined) {
    let namespace = '';
    try {
      namespace = readlinkSync('/proc/self/ns/pid');
    } catch {
      // No /proc (not Linux): the host name alone identifies the namespace.
    }
    cachedPidNamespace = `${hostname()} ${namespace}`;
  }
  return cachedPidNamespace;
}

export interface FileLeaseOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs?: number;
  /** Names the protected resource in the timeout error, e.g. `config`. */
  label?: string;
  /** How long a lease lasts without renewal; tests shorten it. */
  staleMs?: number;
}

/** The lease a `withFileLease` callback holds; what it writes is published only while it still holds it. */
export interface HeldFileLease {
  /**
   * Run `publish`, the step that makes the callback's work visible (such as a
   * rename), only if this holder still holds the lock, and with takeover held
   * off until it returns. When a waiter took the lock over after this holder
   * stalled past its lease, throws without running it.
   */
  commit<T>(publish: () => Promise<T>): Promise<T>;
  /** Durably replace the file at `path` with `content`, publishing it through `commit`. */
  replaceFile(path: string, content: string, options?: Omit<DurableReplaceOptions, 'commit'>): Promise<ReplaceStrategy>;
}

/** Who holds a lock or a guard, as its record says, with an older record's missing fields filled in. */
interface Holder {
  pid: number;
  pidNamespace: string;
  threadId: number;
  token: string | undefined;
}

/** A lock or guard record as read from its file. */
type ParsedHolder =
  /** Empty or cut short: its holder is still writing it. */
  | { kind: 'writing' }
  /** Complete JSON, but not a record any version wrote. */
  | { kind: 'malformed' }
  /** Written by this version, with every field. */
  | ({ kind: 'current' } & Holder)
  /**
   * Written before the pid namespace, thread or token was recorded, such as
   * the publisher wallet lock's `{ pid, createdAt }`. Those fields take the
   * values such a writer had: this namespace, the main thread and no token.
   */
  | ({ kind: 'legacy' } & Holder);

type LockState = 'gone' | 'live' | 'stale';

/** A change that `prepare` asks updateFileUnderLease to publish: its result, and the file to replace, if any. */
export type LeasedFileChange<T> =
  | { result: T }
  | { result: T; path: string; content: string; mode?: number };

/** What updateFileUnderLease did: the result `prepare` gave, and how the file was replaced if it was. */
export type LeasedFileUpdate<T> =
  | { result: T; replaced: false }
  | { result: T; replaced: true; strategy: ReplaceStrategy };

/**
 * Prepare a change to one file under the lease at `lockPath` (see
 * withFileLease), and publish it. `prepare` runs while the lease is held,
 * reads what it needs and returns the file's new content, if any; the file
 * is then replaced only while the lease is still held, through the guarded
 * commit. `prepare` is given no way to write, so a holder that stalled past
 * its lease and was taken over publishes nothing.
 */
export async function updateFileUnderLease<T>(
  lockPath: string,
  prepare: () => Promise<LeasedFileChange<T>>,
  options: FileLeaseOptions = {},
): Promise<LeasedFileUpdate<T>> {
  return withFileLease(lockPath, async (lease) => {
    const change = await prepare();
    if (!('path' in change)) return { result: change.result, replaced: false };
    const replaceOptions = change.mode === undefined ? {} : { mode: change.mode };
    const strategy = await lease.replaceFile(change.path, change.content, replaceOptions);
    return { result: change.result, replaced: true, strategy };
  }, options);
}

/**
 * Run `fn` while holding a lease on the lock file at `lockPath`. This is the
 * machinery beneath updateFileUnderLease, which writers use: `fn` is not
 * mutually exclusive once its lease lapses, so anything it does outside
 * `commit` or `replaceFile` can overlap a successor's work.
 *
 * The lock is shared across processes: the holder records its pid, the pid
 * namespace it belongs to and a token, and renews its lease (the lock file's
 * mtime) while `fn` runs. A waiter takes the lock over only when its holder
 * is gone (the pid is dead, or is this thread's own pid without a lock this
 * thread holds) or its lease has lapsed, so a crashed holder does not wedge
 * later writers while a live one keeps its lock however long it works. A
 * lock from another pid namespace is judged by its lease alone.
 *
 * A holder that stalls for a whole lease can be taken over, so its work is
 * published through the lease (`replaceFile`, or `commit` for any other
 * step). Every step that removes the lock or publishes under it holds the
 * guard, a directory at `<lockPath>.guard`: a waiter's takeover, a holder's
 * release and a holder's commit. A takeover therefore cannot come between a
 * holder's check that it still holds the lock and its commit, and a holder
 * that was taken over throws instead of committing.
 */
export async function withFileLease<T>(
  lockPath: string,
  fn: (lease: HeldFileLease) => Promise<T>,
  options: FileLeaseOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const label = options.label ?? 'file';
  const { handle, token } = await acquireLock(lockPath, label, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, staleMs);
  const lease = renewLease(handle, staleMs / LEASE_RENEWALS_PER_STALE_PERIOD);
  const commit = <R>(publish: () => Promise<R>): Promise<R> => commitUnderGuard(lockPath, token, label, staleMs, publish);
  try {
    return await fn({
      commit,
      replaceFile: (path, content, replaceOptions) => replaceFileDurably(path, content, { ...replaceOptions, commit }),
    });
  } finally {
    await lease.stop();
    await handle.close().catch(() => {});
    await releaseLock(lockPath, token, staleMs);
  }
}

/** Refresh the lock file's mtime every `intervalMs` until stopped. */
function renewLease(handle: FileHandle, intervalMs: number): { stop(): Promise<void> } {
  let renewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    // A renewal still waiting on the filesystem is not doubled up.
    if (renewal) return;
    const now = new Date();
    renewal = handle.utimes(now, now).catch(() => {}).finally(() => { renewal = undefined; });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await renewal;
    },
  };
}

async function commitUnderGuard<T>(
  lockPath: string,
  token: string,
  label: string,
  staleMs: number,
  publish: () => Promise<T>,
): Promise<T> {
  const guard = await acquireGuard(lockPath, staleMs, Date.now() + guardTimeoutMs(staleMs));
  if (guard === undefined) {
    throw new Error(`Timed out waiting to commit under the ${label} lock: ${guardPath(lockPath)} is held`);
  }
  try {
    if (!await holdsLock(lockPath, token)) {
      throw new Error(
        `Lost the ${label} lock: ${lockPath} was taken over after this process stalled for longer than its lease`,
      );
    }
    return await publish();
  } finally {
    await releaseGuard(lockPath, guard);
  }
}

async function acquireLock(
  lockPath: string,
  label: string,
  timeoutMs: number,
  staleMs: number,
): Promise<{ handle: FileHandle; token: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomUUID();
    // Registered before the file exists, so this thread never mistakes it for a leftover.
    heldTokens.add(token);
    let handle: FileHandle | undefined;
    try {
      handle = await createLockFile(lockPath, token);
    } finally {
      if (!handle) heldTokens.delete(token);
    }
    if (handle) return { handle, token };
    const retryNow = await reapStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${label} lock: ${lockPath} `
        + `(remove it, and ${guardPath(lockPath)} if present, if no DKG process is still running)`,
      );
    }
    if (!retryNow) await sleep(LOCK_POLL_MS);
  }
}

/**
 * Create the lock file holding this thread's record for `token`, returning a
 * handle to it, or undefined if the lock exists. The record is written to a
 * staging file that is then hard-linked into place, so the lock never
 * appears without it. Where the filesystem has no hard links, the lock is
 * created exclusively and then written, and can briefly appear empty; a
 * holder stalled that long can then be taken over, but not commit.
 */
async function createLockFile(path: string, token: string): Promise<FileHandle | undefined> {
  const record = holderRecord(token);
  const stagingPath = `${path}.${token}.tmp`;
  const staging = await open(stagingPath, 'wx', 0o600);
  let placed = false;
  try {
    await staging.writeFile(record);
    await link(stagingPath, path);
    placed = true;
    return staging;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return undefined;
    if (!NO_HARD_LINK_CODES.some((code) => hasErrorCode(error, code))) throw error;
  } finally {
    if (!placed) await staging.close().catch(() => {});
    await unlink(stagingPath).catch(() => {});
  }
  const handle = await open(path, 'wx', 0o600).catch((error: unknown) => {
    if (hasErrorCode(error, 'EEXIST')) return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    await handle.writeFile(record);
    return handle;
  } catch (error) {
    // Without its record the lock would stand until it looked abandoned.
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

function holderRecord(token: string): string {
  return JSON.stringify({ pid: process.pid, pidNamespace: pidNamespace(), threadId, token });
}

/**
 * Remove the lock, under the guard, only while it still carries this holder's
 * token: a waiter may have taken over a lock whose lease lapsed. A lock left
 * behind because the guard stayed taken or the removal failed is abandoned:
 * this thread recognises it at once and other processes once its lease lapses.
 */
async function releaseLock(lockPath: string, token: string, staleMs: number): Promise<void> {
  try {
    const guard = await acquireGuard(lockPath, staleMs, Date.now() + guardTimeoutMs(staleMs));
    if (guard === undefined) return;
    try {
      if (await holdsLock(lockPath, token)) await unlink(lockPath);
    } finally {
      await releaseGuard(lockPath, guard);
    }
  } catch {
    // Recovered as abandoned, as described above.
  } finally {
    heldTokens.delete(token);
  }
}

async function holdsLock(lockPath: string, token: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
  const holder = parseHolder(raw);
  return holder.kind === 'current' && holder.token === token;
}

/**
 * Decide whether to retry at once (the lock is gone, or was stale and has been
 * removed) or to wait. The lock is removed only under the guard, after finding
 * it still stale, so a takeover can neither remove a lock another waiter has
 * just taken nor come between a holder's final check and its commit. A lock
 * that disappears while it is being inspected was released, and is retried
 * without deleting anything.
 */
async function reapStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const state = await inspectHolder(lockPath, staleMs, 'lock');
  if (state !== 'stale') return state === 'gone';
  const guard = await acquireGuard(lockPath, staleMs, Date.now() + LOCK_POLL_MS);
  if (guard === undefined) return false;
  try {
    const current = await inspectHolder(lockPath, staleMs, 'lock');
    if (current !== 'stale') return current === 'gone';
    await unlink(lockPath);
    return true;
  } catch (error) {
    // Wait rather than spin on a stale lock that cannot be removed.
    return hasErrorCode(error, 'ENOENT');
  } finally {
    await releaseGuard(lockPath, guard);
  }
}

/*
 * The guard is a directory, `<lock>.guard`, holding one file: its holder's
 * record, named by the holder's token. It is taken by renaming a prepared
 * directory into place, so it never appears without its record, and only
 * while it is absent or empty. It is cleared by removing the record of each
 * holder that is gone, by that record's name, and then the directory only if
 * that left it empty. A clearer acting on what it read about a guard that
 * has since been cleared and taken again therefore removes nothing of the
 * new holder's.
 */

function guardPath(lockPath: string): string {
  return `${lockPath}.guard`;
}

/** A guard is only ever held across a check and one step, so waiting longer than a lease for one is pointless. */
function guardTimeoutMs(staleMs: number): number {
  return Math.min(GUARD_TIMEOUT_MS, staleMs);
}

/**
 * Take the guard, returning its token, or undefined once `deadline` passes.
 * A guard is never taken from a live holder in this pid namespace: it is
 * cleared when its holder has died, or, recorded in another pid namespace
 * where that cannot be checked, once its record is as old as a lapsed lease.
 */
async function acquireGuard(lockPath: string, staleMs: number, deadline: number): Promise<string | undefined> {
  const path = guardPath(lockPath);
  for (;;) {
    const token = randomUUID();
    // Registered before the guard exists, so this thread never mistakes it for a leftover.
    heldTokens.add(token);
    let taken = false;
    try {
      taken = await createGuard(path, token);
    } finally {
      if (!taken) heldTokens.delete(token);
    }
    if (taken) return token;
    const cleared = await clearStaleGuard(path, staleMs);
    if (Date.now() >= deadline) return undefined;
    if (!cleared) await sleep(LOCK_POLL_MS);
  }
}

/** Take the guard by renaming a directory that holds this holder's record into place; false if it is taken. */
async function createGuard(path: string, token: string): Promise<boolean> {
  const staging = `${path}.${token}.tmp`;
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(join(staging, token), holderRecord(token), { mode: 0o600 });
    await rename(staging, path);
    return true;
  } catch (error) {
    if (await isTakenGuardError(error, path)) return false;
    throw error;
  } finally {
    // Gone once renamed into place.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Whether a rename onto the guard failed because a guard is there. POSIX
 * refuses a directory that is not empty (ENOTEMPTY or EEXIST) or a file
 * (ENOTDIR). Windows refuses any existing directory with EPERM or EACCES,
 * which can also be a permission problem, so those count only while the
 * guard path exists.
 */
async function isTakenGuardError(error: unknown, path: string): Promise<boolean> {
  if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].some((code) => hasErrorCode(error, code))) return true;
  if (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EACCES')) return false;
  return stat(path).then(() => true, () => false);
}

async function releaseGuard(lockPath: string, token: string): Promise<void> {
  const path = guardPath(lockPath);
  try {
    await unlink(join(path, token));
    // Only while empty: a guard taken again in the meantime keeps its record.
    await rmdir(path);
  } catch {
    // An emptied guard left behind is removed by the next one to find it.
  } finally {
    heldTokens.delete(token);
  }
}

/**
 * Clear the guard if its holder is gone, returning whether it is now free:
 * remove the record of each holder that is gone, by its name, then the
 * directory if that left it empty. A path that is not a guard directory is
 * left in place, for the lock's timeout error to name.
 */
async function clearStaleGuard(path: string, staleMs: number): Promise<boolean> {
  let records: string[];
  try {
    records = await readdir(path);
  } catch (error) {
    return hasErrorCode(error, 'ENOENT');
  }
  for (const record of records) {
    const recordPath = join(path, record);
    if (await inspectHolder(recordPath, staleMs, 'guard') === 'live') return false;
    await unlink(recordPath).catch(() => {});
  }
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    // Not empty: the guard was taken again in the meantime.
    return hasErrorCode(error, 'ENOENT');
  }
}

/**
 * Whether the holder recorded in a lock file, or in a guard's record, still
 * holds it. Both are given up when their holder is gone, or when their
 * record is still being written after LOCK_WRITE_GRACE_MS. A lock is also
 * given up once its lease lapses; a guard, never taken from a live holder in
 * this pid namespace, only when it was recorded in another one (whose pids
 * cannot be checked) and is that old.
 */
async function inspectHolder(path: string, staleMs: number, kind: 'lock' | 'guard'): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'gone';
    raw = '';
  }
  // The age is read after the record: a file replaced in between then looks
  // freshly renewed, never lapsed.
  const st = await stat(path).catch(() => null);
  if (!st) return 'gone';
  const idleMs = Date.now() - st.mtimeMs;
  const holder = parseHolder(raw);
  if (holder.kind === 'writing') return idleMs < LOCK_WRITE_GRACE_MS ? 'live' : 'stale';
  if (holder.kind === 'malformed') return 'stale';
  const lapsed = idleMs > staleMs;
  if (holder.pidNamespace !== pidNamespace()) return lapsed ? 'stale' : 'live';
  if (holder.pid === process.pid && holder.threadId === threadId) {
    return holder.token !== undefined && heldTokens.has(holder.token) ? 'live' : 'stale';
  }
  if (!isProcessRunning(holder.pid)) return 'stale';
  return kind === 'lock' && lapsed ? 'stale' : 'live';
}

/**
 * Read a lock or guard record. A field present with the wrong type makes the
 * record malformed; a missing namespace, thread or token makes it legacy.
 */
function parseHolder(raw: string): ParsedHolder {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { kind: 'writing' };
  }
  if (!isPlainRecord(record)) return { kind: 'malformed' };
  const { pid, pidNamespace: namespace, threadId: thread, token } = record;
  if (!isPositiveInteger(pid)
    || !(namespace === undefined || typeof namespace === 'string')
    || !(thread === undefined || isThreadId(thread))
    || !(token === undefined || (typeof token === 'string' && token !== ''))) {
    return { kind: 'malformed' };
  }
  const holder: Holder = { pid, pidNamespace: namespace ?? pidNamespace(), threadId: thread ?? 0, token };
  return namespace !== undefined && thread !== undefined && token !== undefined
    ? { kind: 'current', ...holder }
    : { kind: 'legacy', ...holder };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isThreadId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A process we may not signal (EPERM) still holds its lock. */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
