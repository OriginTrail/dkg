import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/file-lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function enoent(): NodeJS.ErrnoException {
  return fsError('ENOENT');
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
  let guardPath = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dkg-file-lock-'));
    lockPath = join(dir, 'resource.lock');
    guardPath = `${lockPath}.guard`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const mocked of [link, open, readFile, stat]) vi.mocked(mocked).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  async function backdate(path: string, ms: number): Promise<void> {
    const then = new Date(Date.now() - ms);
    await utimes(path, then, then);
  }

  /** The holder record this process writes, read from a real lock. */
  async function ownHolderRecord(): Promise<Record<string, unknown>> {
    let record: Record<string, unknown> = {};
    await withFileLock(lockPath, async () => { record = JSON.parse(await readFile(lockPath, 'utf-8')); });
    return record;
  }

  it('holds the lock, recording its holder, only while the callback runs', async () => {
    const result = await withFileLock(lockPath, async () => {
      const holder = JSON.parse(await readFile(lockPath, 'utf-8'));
      expect(holder).toMatchObject({ pid: process.pid, pidNamespace: expect.any(String), threadId, token: expect.any(String) });
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
    // A process restarted in the same pid namespace can get the same pid again.
    const own = await ownHolderRecord();
    await writeFile(lockPath, JSON.stringify({ ...own, token: 'earlier-process', createdAt: Date.now() }));

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  // A holder renews its lease while it works, so a live pid whose lease has
  // lapsed is a reused pid, or a holder stalled for a whole lease.
  it('takes over a lock whose lease lapsed, even when its pid is alive', async () => {
    await writeFile(lockPath, liveHolder());
    await backdate(lockPath, 2 * 60_000);

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('keeps waiting on a live holder that took its lock long ago but renewed its lease', async () => {
    await writeFile(lockPath, liveHolder({ createdAt: Date.now() - 10 * 60_000 }));

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('renews its lease while the callback runs', async () => {
    await withFileLock(lockPath, async () => {
      await backdate(lockPath, 10_000);
      await vi.waitFor(async () => expect(Date.now() - (await stat(lockPath)).mtimeMs).toBeLessThan(5_000));
    }, { staleMs: 120 });
  });

  // Two containers sharing one home can both run their DKG process as pid 1.
  // A pid recorded in the other container's namespace says nothing here.
  it('leaves alone a lock that a process with this pid holds in another pid namespace', async () => {
    const own = await ownHolderRecord();
    await writeFile(lockPath, JSON.stringify({
      ...own, pidNamespace: 'other-container pid:[4026532001]', token: 'other-container', createdAt: Date.now(),
    }));
    let entered = false;

    const waiter = withFileLock(lockPath, async () => { entered = true; }, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(entered).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    await rm(lockPath);
    await waiter;
    expect(entered).toBe(true);
  });

  it('takes over a lock from another pid namespace once its lease lapses', async () => {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid, pidNamespace: 'other-container pid:[4026532001]', token: 'crashed', createdAt: Date.now(),
    }));
    await backdate(lockPath, 2 * 60_000);

    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('leaves nothing behind when it cannot write its holder record', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const handle = await actualFs.open(...args);
      handle.writeFile = async () => { throw fsError('ENOSPC'); };
      return handle;
    });

    await expect(withFileLock(lockPath, async () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    // The record is staged before the lock appears, so no lock ever lacked one.
    expect(await readdir(dir)).toEqual([]);
    await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('creates the lock and the guard directly where the filesystem has no hard links', async () => {
    vi.mocked(link).mockRejectedValue(fsError('EPERM'));

    await withFileLock(lockPath, async (lock) => {
      expect(JSON.parse(await readFile(lockPath, 'utf-8'))).toMatchObject({ pid: process.pid });
      await lock.commit(async () => {
        expect(JSON.parse(await readFile(guardPath, 'utf-8'))).toMatchObject({ pid: process.pid });
      });
    });

    expect(await readdir(dir)).toEqual([]);
  });

  it('removes a lock it created directly when it cannot write its record there', async () => {
    vi.mocked(link).mockRejectedValue(fsError('ENOTSUP'));
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) handle.writeFile = async () => { throw fsError('ENOSPC'); };
      return handle;
    });

    await expect(withFileLock(lockPath, async () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('waits for an existing lock where the filesystem has no hard links', async () => {
    vi.mocked(link).mockRejectedValue(fsError('EPERM'));
    const holder = liveHolder();
    await writeFile(lockPath, holder);

    await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(await readFile(lockPath, 'utf-8')).toBe(holder);
  });

  it('propagates a failure to create the lock directly other than an existing one', async () => {
    vi.mocked(link).mockRejectedValue(fsError('ENOTSUP'));
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      if (args[0] === lockPath) throw fsError('EACCES');
      return actualFs.open(...args);
    });

    await expect(withFileLock(lockPath, async () => {})).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('propagates a failure to place the lock other than an existing one or missing hard links', async () => {
    vi.mocked(link).mockRejectedValueOnce(fsError('EIO'));

    await expect(withFileLock(lockPath, async () => {})).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(dir)).toEqual([]);
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

  describe('the guard', () => {
    const staleLock = () => JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() });

    // A live process holds the guard only while it commits, releases or
    // removes a lock; taking it over could let that step interleave with this one.
    it('never takes the guard from a live holder, however long it has held it', async () => {
      await writeFile(lockPath, staleLock());
      await writeFile(guardPath, liveHolder({ token: 'committing' }));
      await backdate(guardPath, 10 * 60_000);

      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(guardPath)).toBe(true);
    });

    it('clears a guard whose holder died, then takes the stale lock over', async () => {
      await writeFile(lockPath, staleLock());
      await writeFile(guardPath, JSON.stringify({ pid: EXITED_PID, token: 'crashed', createdAt: Date.now() }));

      await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
      expect(await readdir(dir)).toEqual([]);
    });

    it('clears a guard an earlier process with this pid left behind', async () => {
      const own = await ownHolderRecord();
      await writeFile(lockPath, staleLock());
      await writeFile(guardPath, JSON.stringify({ ...own, token: 'earlier-process' }));

      await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    it('clears a guard from another pid namespace only once it is as old as a lapsed lease', async () => {
      await writeFile(lockPath, staleLock());
      await writeFile(guardPath, JSON.stringify({
        pid: process.pid, pidNamespace: 'other-container pid:[4026532001]', token: 'other', createdAt: Date.now(),
      }));
      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

      await backdate(guardPath, 2 * 60_000);
      await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    // Only a guard created without hard links can briefly lack its record.
    it('treats a guard without its record as being written until it is old', async () => {
      await writeFile(lockPath, staleLock());
      await writeFile(guardPath, '');
      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

      await backdate(guardPath, 10_000);
      await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    it('commits only while it holds the lock, holding the guard meanwhile', async () => {
      await withFileLock(lockPath, async (lock) => {
        await expect(lock.commit(async () => {
          expect(JSON.parse(await readFile(guardPath, 'utf-8'))).toMatchObject({ pid: process.pid, threadId });
          return 'published';
        })).resolves.toBe('published');
        expect(existsSync(guardPath)).toBe(false);

        // A waiter took the lock over after this holder's lease lapsed.
        await writeFile(lockPath, liveHolder({ token: 'successor' }));
        const publish = vi.fn(async () => {});
        await expect(lock.commit(publish)).rejects.toThrow(`Lost the config lock: ${lockPath} was taken over`);
        await rm(lockPath);
        await expect(lock.commit(publish)).rejects.toThrow('Lost the config lock');
        expect(publish).not.toHaveBeenCalled();
      }, { label: 'config' });
    });

    it('replaces a file through the commit', async () => {
      const target = join(dir, 'data.json');
      await writeFile(target, 'old');

      await withFileLock(lockPath, async (lock) => {
        await lock.replaceFile(target, 'new');
        await writeFile(lockPath, liveHolder({ token: 'successor' }));
        await expect(lock.replaceFile(target, 'stale')).rejects.toThrow('Lost the file lock');
      });

      expect(await readFile(target, 'utf-8')).toBe('new');
      expect((await readdir(dir)).sort()).toEqual(['data.json', 'resource.lock']);
    });

    it('refuses to commit when it cannot read the lock to check it still holds it', async () => {
      await withFileLock(lockPath, async (lock) => {
        vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
          if (args[0] === lockPath) throw fsError('EIO');
          return actualFs.readFile(...args);
        });
        const publish = vi.fn(async () => {});
        await expect(lock.commit(publish)).rejects.toMatchObject({ code: 'EIO' });
        expect(publish).not.toHaveBeenCalled();
        vi.mocked(readFile).mockReset();
      });

      expect(await readdir(dir)).toEqual([]);
    });

    it('waits, instead of spinning, on a stale guard it cannot remove', async () => {
      await writeFile(lockPath, staleLock());
      await mkdir(guardPath);
      await backdate(guardPath, 10_000);

      await expect(withFileLock(lockPath, async () => {}, { timeoutMs: 150 })).rejects.toThrow(/Timed out/);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('gives up committing while the guard stays taken', async () => {
      await withFileLock(lockPath, async (lock) => {
        await writeFile(guardPath, liveHolder({ token: 'committing' }));
        const publish = vi.fn(async () => {});
        await expect(lock.commit(publish)).rejects.toThrow(
          `Timed out waiting to commit under the config lock: ${guardPath} is held`,
        );
        expect(publish).not.toHaveBeenCalled();
        await rm(guardPath);
      }, { label: 'config', staleMs: 150 });
    });

    it('leaves its lock to lapse when the guard stays taken as it releases', async () => {
      await withFileLock(lockPath, async () => {
        await writeFile(guardPath, liveHolder({ token: 'committing' }));
      }, { staleMs: 150 });
      expect(existsSync(lockPath)).toBe(true);

      await rm(guardPath);
      // No longer held by this thread, so it is taken over at once.
      await expect(withFileLock(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });
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
    // A few reads per 25 ms poll; a retry loop without the wait would make hundreds.
    expect(vi.mocked(readFile).mock.calls.length).toBeLessThan(40);
  });

  it('propagates failures other than an existing lock', async () => {
    await expect(withFileLock(join(dir, 'missing', 'resource.lock'), async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  // A holder in another process, reading a counter when it takes the lock and
  // writing it back when it is done, as a config writer reads and commits.
  describe('a holder in another process', () => {
    // Long enough that a loaded CI runner does not starve the holder's renewals.
    const STALE_MS = 1_000;
    const HOLD_MS = 3 * STALE_MS;
    let counterPath = '';
    let logPath = '';

    beforeEach(async () => {
      counterPath = join(dir, 'counter');
      logPath = join(dir, 'events.log');
      await writeFile(counterPath, '0');
      await writeFile(logPath, '');
    });

    /** Start the holder, and resolve once it has logged `ready`, with its exit code. */
    async function startHolder(
      mode: 'await' | 'block' | 'block-in-commit',
      ready = 'holder:enter',
    ): Promise<{ exited: Promise<number | null> }> {
      const fixture = fileURLToPath(new URL('./fixtures/file-lock-holder.fixture.ts', import.meta.url));
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx/esm'), fixture, lockPath, counterPath, logPath, mode, String(HOLD_MS), String(STALE_MS)],
        { stdio: 'ignore' },
      );
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      });
      await vi.waitFor(async () => expect(await events()).toContain(ready), { timeout: 30_000, interval: 20 });
      return { exited };
    }

    async function events(): Promise<string[]> {
      return (await readFile(logPath, 'utf-8')).split('\n').filter(Boolean);
    }

    async function incrementAsWaiter(): Promise<void> {
      await withFileLock(lockPath, async () => {
        await appendFile(logPath, 'waiter:enter\n');
        await writeFile(counterPath, String(Number(await readFile(counterPath, 'utf-8')) + 1));
        await appendFile(logPath, 'waiter:leave\n');
      }, { staleMs: STALE_MS, timeoutMs: 20_000 });
    }

    it('keeps its lock while it works past the lease, so neither update is lost', async () => {
      const holder = await startHolder('await');

      await incrementAsWaiter();

      expect(await holder.exited).toBe(0);
      expect(await events()).toEqual(['holder:enter', 'holder:leave', 'waiter:enter', 'waiter:leave']);
      expect(await readFile(counterPath, 'utf-8')).toBe('2');
    }, 60_000);

    // The window the guard closes: a takeover between the holder's check that
    // it still holds the lock and its commit would let the holder's stale
    // write land after the waiter's.
    it('holds off a takeover while its holder commits, so neither update is lost', async () => {
      const holder = await startHolder('block-in-commit', 'holder:committing');

      await incrementAsWaiter();

      expect(await holder.exited).toBe(0);
      expect(await events()).toEqual([
        'holder:enter', 'holder:committing', 'holder:leave', 'waiter:enter', 'waiter:leave',
      ]);
      expect(await readFile(counterPath, 'utf-8')).toBe('2');
    }, 60_000);

    it('loses its lock when it stalls past the lease, and then does not commit', async () => {
      const holder = await startHolder('block');

      await incrementAsWaiter();

      expect(await holder.exited).toBe(3);
      expect(await events()).toEqual([
        'holder:enter', 'waiter:enter', 'waiter:leave',
        expect.stringMatching(/^holder:error: Lost the file lock: .* was taken over/),
      ]);
      expect(await readFile(counterPath, 'utf-8')).toBe('1');
    }, 60_000);
  });
});
