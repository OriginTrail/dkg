import { open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import { hasErrorCode } from '@origintrail-official/dkg-core';

const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;

export interface FileLockOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs?: number;
  /** Names the protected resource in the timeout error, e.g. `config`. */
  label?: string;
}

/**
 * Run `fn` while holding an exclusive lock file at `lockPath`. The lock is
 * shared across processes: the holder records its pid, and a waiter removes
 * the lock only when that process is gone (or when unreadable metadata has
 * aged out), so a crashed holder does not wedge later writers.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const handle = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireLock(lockPath: string, options: FileLockOptions): Promise<FileHandle> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return handle;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
    const retryNow = await reapStaleLock(lockPath);
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${options.label ?? 'file'} lock: ${lockPath} `
        + '(remove it if no DKG process is still running)',
      );
    }
    if (!retryNow) await sleep(LOCK_POLL_MS);
  }
}

/**
 * Decide whether to retry at once (the lock is gone or was stale) or wait. A
 * lock that disappears while it is being inspected was released: retry without
 * unlinking, because by then the path may hold a new waiter's live lock.
 */
async function reapStaleLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return true;
    raw = '';
  }
  let parsed: { pid?: number; createdAt?: number } | undefined;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    // Empty or partial metadata — the lock was just created and its holder is
    // still writing it. Check file age via mtime; treat as live if recent.
    const st = await stat(lockPath).catch(() => null);
    if (!st) return true;
    if (Date.now() - st.mtimeMs < 5000) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  }
  const createdAt = Number(parsed.createdAt);
  const pid = Number(parsed.pid);
  const pidDead = Number.isFinite(pid) ? !isProcessRunning(pid) : true;
  const aged = Number.isFinite(createdAt) ? Date.now() - createdAt > LOCK_STALE_MS : true;
  if (pidDead || (aged && !Number.isFinite(pid))) {
    await unlink(lockPath).catch(() => {});
    return true;
  }
  return false;
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
