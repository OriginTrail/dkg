import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { link, open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hasErrorCode } from '@origintrail-official/dkg-core';
import { replaceFileDurably, type DurableReplaceOptions } from './durable-file-replace.js';

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

export interface FileLockOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs?: number;
  /** Names the protected resource in the timeout error, e.g. `config`. */
  label?: string;
  /** How long a lease lasts without renewal; tests shorten it. */
  staleMs?: number;
}

/** The lock a `withFileLock` callback holds; what it writes is published only while it still holds it. */
export interface HeldFileLock {
  /**
   * Run `publish`, the step that makes the callback's work visible (such as a
   * rename), only if this holder still holds the lock, and with takeover held
   * off until it returns. When a waiter took the lock over after this holder
   * stalled past its lease, throws without running it.
   */
  commit<T>(publish: () => Promise<T>): Promise<T>;
  /** Durably replace the file at `path` with `content`, publishing it through `commit`. */
  replaceFile(path: string, content: string, options?: Omit<DurableReplaceOptions, 'commit'>): Promise<void>;
}

interface LockHolder {
  pid?: unknown;
  pidNamespace?: unknown;
  threadId?: unknown;
  token?: unknown;
  createdAt?: unknown;
}

type LockState = 'gone' | 'live' | 'stale';

/**
 * Run `fn` while holding an exclusive lock file at `lockPath`. The lock is
 * shared across processes: the holder records its pid, the pid namespace it
 * belongs to and a token, and renews its lease (the lock file's mtime) while
 * `fn` runs. A waiter takes the lock over only when its holder is gone (the
 * pid is dead, or is this thread's own pid without a lock this thread holds)
 * or its lease has lapsed, so a crashed holder does not wedge later writers
 * while a live one keeps its lock however long it works. A lock from another
 * pid namespace is judged by its lease alone.
 *
 * A holder that stalls for a whole lease can be taken over, so `fn` publishes
 * its work through the lock (`replaceFile`, or `commit` for any other step).
 * Every step that removes the lock or publishes under it holds the guard, a
 * second file at `<lockPath>.guard`: a waiter's takeover, a holder's release
 * and a holder's commit. A takeover therefore cannot come between a holder's
 * check that it still holds the lock and its commit, and a holder that was
 * taken over throws instead of committing.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: (lock: HeldFileLock) => Promise<T>,
  options: FileLockOptions = {},
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
      handle = await createHeldFile(lockPath, token);
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
 * Create `path` holding this thread's holder record for `token`, returning a
 * handle to it, or undefined if the path is taken. The record is written to a
 * staging file that is then hard-linked into place, so the file never appears
 * without it. Where the filesystem has no hard links, the file is created
 * exclusively and then written, and can briefly appear empty.
 */
async function createHeldFile(path: string, token: string): Promise<FileHandle | undefined> {
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
    // Without its record the file would stand until it looked abandoned.
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

function holderRecord(token: string): string {
  return JSON.stringify({ pid: process.pid, pidNamespace: pidNamespace(), threadId, token, createdAt: Date.now() });
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
  try {
    return parseHolder(await readFile(lockPath, 'utf-8'))?.token === token;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
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
  const guard = await acquireGuard(lockPath, staleMs, Date.now());
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

function guardPath(lockPath: string): string {
  return `${lockPath}.guard`;
}

/** A guard is only ever held across a check and one step, so waiting longer than a lease for one is pointless. */
function guardTimeoutMs(staleMs: number): number {
  return Math.min(GUARD_TIMEOUT_MS, staleMs);
}

/**
 * Take the guard, returning its token, or undefined once `deadline` passes.
 * A guard is taken over only when its holder has died, or, recorded in
 * another pid namespace where that cannot be checked, once it is as old as a
 * lapsed lease. Where the filesystem has no hard links, a guard is created
 * before its record is written, and one still without it after
 * LOCK_WRITE_GRACE_MS counts as abandoned even if its holder is only stalled.
 * Clearing a guard whose holder died is not itself serialized, but it needs a
 * holder to die inside a step that takes microseconds.
 */
async function acquireGuard(lockPath: string, staleMs: number, deadline: number): Promise<string | undefined> {
  const path = guardPath(lockPath);
  for (;;) {
    const token = randomUUID();
    heldTokens.add(token);
    let handle: FileHandle | undefined;
    try {
      handle = await createHeldFile(path, token);
    } finally {
      if (!handle) heldTokens.delete(token);
    }
    if (handle) {
      await handle.close().catch(() => {});
      return token;
    }
    if (await clearStaleGuard(path, staleMs)) continue;
    if (Date.now() >= deadline) return undefined;
    await sleep(LOCK_POLL_MS);
  }
}

async function releaseGuard(lockPath: string, token: string): Promise<void> {
  const path = guardPath(lockPath);
  try {
    if (parseHolder(await readFile(path, 'utf-8'))?.token === token) await unlink(path);
  } catch {
    // A guard left behind is cleared once it is found stale.
  } finally {
    heldTokens.delete(token);
  }
}

async function clearStaleGuard(path: string, staleMs: number): Promise<boolean> {
  const state = await inspectHolder(path, staleMs, 'guard');
  if (state !== 'stale') return state === 'gone';
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return hasErrorCode(error, 'ENOENT');
  }
}

/**
 * Whether the holder recorded in a lock or guard file still holds it. Both are
 * given up when their holder is gone, or when they still lack a record after
 * LOCK_WRITE_GRACE_MS. A lock is also given up once its lease lapses; a guard
 * with a record, never taken from a live holder in this pid namespace, only
 * when it was recorded in another one (whose pids cannot be checked) and is
 * that old.
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
  if (!holder) {
    // Empty or partial metadata: the file was just created and its holder is
    // still writing it, unless that was a while ago.
    return idleMs < LOCK_WRITE_GRACE_MS ? 'live' : 'stale';
  }
  const pid = Number(holder.pid);
  if (!Number.isFinite(pid)) return 'stale';
  const lapsed = idleMs > staleMs;
  // A lock written before the namespace was recorded counts as this one's.
  if ((holder.pidNamespace ?? pidNamespace()) !== pidNamespace()) {
    return lapsed ? 'stale' : 'live';
  }
  if (pid === process.pid && (holder.threadId ?? 0) === threadId) {
    return heldTokens.has(String(holder.token)) ? 'live' : 'stale';
  }
  if (!isProcessRunning(pid)) return 'stale';
  return kind === 'lock' && lapsed ? 'stale' : 'live';
}

function parseHolder(raw: string): LockHolder | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed as LockHolder : undefined;
  } catch {
    return undefined;
  }
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
