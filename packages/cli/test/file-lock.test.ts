import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/file-lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) };
});

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' });
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

  /** The pid of a process that has already exited. */
  function exitedPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    return child.pid!;
  }

  async function backdate(path: string, ms: number): Promise<void> {
    const then = new Date(Date.now() - ms);
    await utimes(path, then, then);
  }

  it('holds the lock, recording its pid, only while the callback runs', async () => {
    const result = await withFileLock(lockPath, async () => {
      expect(JSON.parse(await readFile(lockPath, 'utf-8')).pid).toBe(process.pid);
      return 'done';
    });

    expect(result).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(withFileLock(lockPath, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('makes an overlapping holder wait until the first one releases', async () => {
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
    await writeFile(lockPath, JSON.stringify({ pid: exitedPid(), createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('reaps a lock whose metadata names no pid', async () => {
    await writeFile(lockPath, JSON.stringify({ createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('waits for a live holder and names the lock file when it gives up', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

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

  // Under contention a holder can release its lock while a waiter inspects
  // it, and another waiter can take the path at once. Deleting the path then
  // would remove that new, live lock and let two writers in.
  it('retries at once, without deleting anything, when the lock vanishes before it is read', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
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

  it('gives up on an abandoned lock it cannot remove instead of spinning', async () => {
    await mkdir(lockPath);
    await backdate(lockPath, 10_000);

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
  });

  it('propagates failures other than an existing lock', async () => {
    await expect(withFileLock(join(dir, 'missing', 'resource.lock'), async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
