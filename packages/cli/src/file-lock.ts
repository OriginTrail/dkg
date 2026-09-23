import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { threadId } from 'node:worker_threads';
import { hasErrorCode } from '@origintrail-official/dkg-core';

/**
 * No holder keeps a lock this long, so an older one is abandoned even when its
 * pid is alive (the pid was reused) or cannot be checked from here.
 */
const LOCK_STALE_MS = 60 * 1000;
/** Until a lock file is this old, missing metadata means its holder is still writing it. */
const LOCK_WRITE_GRACE_MS = 5000;
const LOCK_POLL_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;

/**
 * Tokens of the locks this thread holds. A lock naming this thread's pid with
 * any other token was left by an earlier process that had the same pid, as a
 * restarted container's pid 1 does.
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
 * belongs to and a token. A waiter takes the lock over only when its holder
 * is gone (the pid is dead, or is this thread's own pid without a lock this
 * thread holds) or the lock is older than any holder keeps it, so a crashed
 * holder does not wedge later writers. A lock from another pid namespace is
 * judged by its age alone.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const { handle, token } = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await releaseLock(lockPath, token);
  }
}

async function acquireLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<{ handle: FileHandle; token: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
      const retryNow = await reapStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for ${options.label ?? 'file'} lock: ${lockPath} `
          + '(remove it if no DKG process is still running)',
        );
      }
      if (!retryNow) await sleep(LOCK_POLL_MS);
      continue;
    }
    const token = randomUUID();
    heldTokens.add(token);
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        pidNamespace: pidNamespace(),
        threadId,
        token,
        createdAt: Date.now(),
      }));
      return { handle, token };
    } catch (error) {
      // Without its holder record the lock would stand until it aged out.
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      heldTokens.delete(token);
      throw error;
    }
  }
}

/**
 * Remove the lock only while it still carries this holder's token: a waiter
 * may have taken over a lock held past LOCK_STALE_MS. A lock left behind
 * because the removal failed is abandoned: this thread recognises it at once
 * and other processes once it is LOCK_STALE_MS old.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (parseHolder(await readFile(lockPath, 'utf-8'))?.token === token) await unlink(lockPath);
  } catch {
    // Recovered as abandoned, as described above.
  } finally {
    heldTokens.delete(token);
  }
}

/**
 * Decide whether to retry at once (the lock is gone, or was stale and has been
 * removed) or to wait. Several waiters can find the same stale lock: only the
 * one holding the reaper lock removes it, and only after finding it still
 * stale, so no waiter can delete a lock that another has just taken. A lock
 * that disappears while it is being inspected was released, and is retried
 * without deleting anything.
 */
async function reapStaleLock(lockPath: string): Promise<boolean> {
  const state = await inspectLock(lockPath);
  if (state !== 'stale') return state === 'gone';
  const reaperPath = `${lockPath}.reap`;
  let reaper: FileHandle;
  try {
    reaper = await open(reaperPath, 'wx', 0o600);
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    await clearAbandonedReaper(reaperPath);
    return false;
  }
  try {
    const current = await inspectLock(lockPath);
    if (current !== 'stale') return current === 'gone';
    await unlink(lockPath);
    return true;
  } catch (error) {
    // Wait rather than spin on a stale lock that cannot be removed.
    return hasErrorCode(error, 'ENOENT');
  } finally {
    await reaper.close().catch(() => {});
    await unlink(reaperPath).catch(() => {});
  }
}

/**
 * A reaper holds its lock only to re-check and remove one file. One left by a
 * waiter that crashed doing so is removed once it is LOCK_WRITE_GRACE_MS old.
 */
async function clearAbandonedReaper(reaperPath: string): Promise<void> {
  const st = await stat(reaperPath).catch(() => null);
  if (st && Date.now() - st.mtimeMs >= LOCK_WRITE_GRACE_MS) await unlink(reaperPath).catch(() => {});
}

async function inspectLock(lockPath: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return 'gone';
    raw = '';
  }
  const holder = parseHolder(raw);
  if (!holder) {
    // Empty or partial metadata — the lock was just created and its holder is
    // still writing it. Check file age via mtime; treat as live if recent.
    const st = await stat(lockPath).catch(() => null);
    if (!st) return 'gone';
    return Date.now() - st.mtimeMs < LOCK_WRITE_GRACE_MS ? 'live' : 'stale';
  }
  const pid = Number(holder.pid);
  if (!Number.isFinite(pid)) return 'stale';
  // A lock written before the namespace was recorded counts as this one's.
  if ((holder.pidNamespace ?? pidNamespace()) !== pidNamespace()) {
    return isAged(holder) ? 'stale' : 'live';
  }
  if (pid === process.pid && (holder.threadId ?? 0) === threadId) {
    return heldTokens.has(String(holder.token)) ? 'live' : 'stale';
  }
  if (!isProcessRunning(pid)) return 'stale';
  return isAged(holder) ? 'stale' : 'live';
}

function isAged(holder: LockHolder): boolean {
  const createdAt = Number(holder.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt > LOCK_STALE_MS;
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
