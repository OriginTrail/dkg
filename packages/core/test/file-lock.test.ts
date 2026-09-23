import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/file-lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' });
}

/** The pid of a process that has already exited. */
const EXITED_PID = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;

/** A running process other than this one, standing in for another DKG process. */
function liveHolder(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ pid: process.ppid, token: 'other-process', createdAt: Date.now(), ...fields });
}

describe('withFileLock', () => {
  let dir = '';
  let lockPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dkg-file-lock-'));
    lockPath = join(dir, 'resource.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(readFile).mockReset();
    vi.mocked(stat).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  async function backdate(path: string, ms: number): Promise<void> {
    const then = new Date(Date.now() - ms);
    await utimes(path, then, then);
  }

  it('holds the lock, recording its holder, only while the callback runs', async () => {
    const result = await withFileLock(lockPath, async () => {
      const holder = JSON.parse(await readFile(lockPath, 'utf-8'));
      expect(holder).toMatchObject({ pid: process.pid, threadId, token: expect.any(String) });
      return 'done';
    });

    expect(result).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(withFileLock(lockPath, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('makes an overlapping holder in the same process wait until the first one releases', async () => {
    const events: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = withFileLock(lockPath, async () => {
      events.push('first:start');
      await released;
      events.push('first:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const second = withFileLock(lockPath, async () => { events.push('second'); }, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['first:start']);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('reaps a lock left by a process that has exited', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('reaps a lock whose metadata names no pid', async () => {
    await writeFile(lockPath, JSON.stringify({ createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('takes over a lock that an earlier process with this pid left behind', async () => {
    // A restarted container runs the daemon as the same pid (often 1) again.
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, threadId, token: 'earlier-process', createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('takes over a lock older than any holder keeps it, even when its pid is alive', async () => {
    await writeFile(lockPath, liveHolder({ createdAt: Date.now() - 6 * 60_000 }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('waits for a live holder and names the lock file when it gives up', async () => {
    await writeFile(lockPath, liveHolder());

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100, label: 'config' }))
      .rejects.toThrow(`Timed out waiting for config lock: ${lockPath}`);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('treats a holder it may not signal as alive', async () => {
    // Signalling another user's process fails with EPERM; that process is
    // still running and its lock must stand.
    const holderPid = 424_242;
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== holderPid) return kill(pid, signal);
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    await writeFile(lockPath, JSON.stringify({ pid: holderPid, createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('treats a fresh empty lock as still being written, and an old one as abandoned', async () => {
    await writeFile(lockPath, '');
    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

    await backdate(lockPath, 10_000);
    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 100 })).resolves.toBe('ran');
  });

  it('treats a fresh unreadable lock as still being written, and an old one as abandoned', async () => {
    await writeFile(lockPath, '{"pid":');
    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

    await backdate(lockPath, 10_000);
    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 100 })).resolves.toBe('ran');
  });

  // Two waiters find the same stale lock. The first to remove it takes the
  // lock; the other, still acting on what it read before, must not then
  // remove the lock that was just taken, or both callbacks run at once.
  it('never lets a waiter remove a lock another waiter took after it judged the old one stale', async () => {
    const stale = JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() });
    await writeFile(lockPath, stale);
    let finishStaleRead!: () => void;
    const staleReadFinished = new Promise<void>((resolve) => { finishStaleRead = resolve; });
    // The slow waiter's read of the stale lock completes only once the fast waiter holds the lock.
    vi.mocked(readFile).mockImplementationOnce(async () => {
      await staleReadFinished;
      return stale;
    });
    let active = 0;
    let maxActive = 0;
    const waiter = (onEnter: () => Promise<void>) => withFileLock(lockPath, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await onEnter();
      active -= 1;
    }, { timeoutMs: 5_000 });

    const slow = waiter(async () => {});
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    const fast = waiter(async () => {
      finishStaleRead();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await Promise.all([slow, fast]);

    expect(maxActive).toBe(1);
  });

  it('waits while another waiter is reaping, and clears a reaper lock a crash left behind', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));
    await writeFile(`${lockPath}.reap`, '');

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);

    await backdate(`${lockPath}.reap`, 10_000);
    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    expect(existsSync(`${lockPath}.reap`)).toBe(false);
  });

  it('releases only a lock that still carries its token', async () => {
    const successor = liveHolder({ token: 'successor' });

    await withFileLock(lockPath, async () => {
      // A waiter took the lock over while this holder was still working.
      await writeFile(lockPath, successor);
    });

    expect(await readFile(lockPath, 'utf-8')).toBe(successor);
  });

  // Under contention a holder can release its lock while a waiter inspects
  // it, and another waiter can take the path at once. Deleting the path then
  // would remove that new, live lock and let two writers in.
  it('retries at once, without deleting anything, when the lock vanishes before it is read', async () => {
    await writeFile(lockPath, liveHolder());
    vi.mocked(readFile).mockRejectedValueOnce(enoent());

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('never deletes a lock that vanishes while its age is checked', async () => {
    await writeFile(lockPath, '');
    vi.mocked(stat).mockRejectedValueOnce(enoent());

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('polls, instead of spinning on, an abandoned lock it cannot remove', async () => {
    await mkdir(lockPath);
    await backdate(lockPath, 10_000);
    vi.mocked(readFile).mockClear();

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    // Two inspections per 25 ms poll; a retry loop without the wait would make hundreds.
    expect(vi.mocked(readFile).mock.calls.length).toBeLessThan(40);
  });

  it('propagates failures other than an existing lock', async () => {
    await expect(withFileLock(join(dir, 'missing', 'resource.lock'), async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
