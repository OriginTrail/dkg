import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  appendFile, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateFileUnderLease, withFileLease } from '../src/file-lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rmdir: vi.fn(actual.rmdir),
    stat: vi.fn(actual.stat),
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

describe('withFileLease', () => {
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
    for (const mocked of [link, open, readFile, rename, rmdir, stat]) vi.mocked(mocked).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  async function backdate(path: string, ms: number): Promise<void> {
    const then = new Date(Date.now() - ms);
    await utimes(path, then, then);
  }

  /** The holder record this process writes, read from a real lock. */
  async function ownHolderRecord(): Promise<Record<string, unknown>> {
    let record: Record<string, unknown> = {};
    await withFileLease(lockPath, async () => { record = JSON.parse(await readFile(lockPath, 'utf-8')); });
    return record;
  }

  it('holds the lock, recording its holder, only while the callback runs', async () => {
    const result = await withFileLease(lockPath, async () => {
      const holder = JSON.parse(await readFile(lockPath, 'utf-8'));
      expect(holder).toMatchObject({ pid: process.pid, pidNamespace: expect.any(String), threadId, token: expect.any(String) });
      return 'done';
    });

    expect(result).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(withFileLease(lockPath, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('makes an overlapping holder in the same process wait until the first one releases', async () => {
    const events: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = withFileLease(lockPath, async () => {
      events.push('first:start');
      await released;
      events.push('first:end');
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const second = withFileLease(lockPath, async () => { events.push('second'); }, { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(['first:start']);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('reaps a lock left by a process that has exited', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));

    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('reaps a lock whose metadata names no pid', async () => {
    await writeFile(lockPath, JSON.stringify({ createdAt: Date.now() }));

    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('takes over a lock that an earlier process with this pid left behind', async () => {
    // A process restarted in the same pid namespace can get the same pid again.
    const own = await ownHolderRecord();
    await writeFile(lockPath, JSON.stringify({ ...own, token: 'earlier-process', createdAt: Date.now() }));

    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  // A holder renews its lease while it works, so a live pid whose lease has
  // lapsed is a reused pid, or a holder stalled for a whole lease.
  it('takes over a lock whose lease lapsed, even when its pid is alive', async () => {
    await writeFile(lockPath, liveHolder());
    await backdate(lockPath, 2 * 60_000);

    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('keeps waiting on a live holder that took its lock long ago but renewed its lease', async () => {
    await writeFile(lockPath, liveHolder({ createdAt: Date.now() - 10 * 60_000 }));

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('renews its lease while the callback runs', async () => {
    await withFileLease(lockPath, async () => {
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

    const waiter = withFileLease(lockPath, async () => { entered = true; }, { timeoutMs: 5_000 });
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

    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('leaves nothing behind when it cannot write its holder record', async () => {
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
      const handle = await actualFs.open(...args);
      handle.writeFile = async () => { throw fsError('ENOSPC'); };
      return handle;
    });

    await expect(withFileLease(lockPath, async () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    // The record is staged before the lock appears, so no lock ever lacked one.
    expect(await readdir(dir)).toEqual([]);
    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
  });

  it('creates the lock directly where the filesystem has no hard links', async () => {
    vi.mocked(link).mockRejectedValue(fsError('EPERM'));

    await withFileLease(lockPath, async (lock) => {
      expect(JSON.parse(await readFile(lockPath, 'utf-8'))).toMatchObject({ pid: process.pid });
      // The guard needs no hard links: it is a directory renamed into place.
      await lock.commit(async () => { expect(await readdir(guardPath)).toHaveLength(1); });
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

    await expect(withFileLease(lockPath, async () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('waits for an existing lock where the filesystem has no hard links', async () => {
    vi.mocked(link).mockRejectedValue(fsError('EPERM'));
    const holder = liveHolder();
    await writeFile(lockPath, holder);

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(await readFile(lockPath, 'utf-8')).toBe(holder);
  });

  it('propagates a failure to create the lock directly other than an existing one', async () => {
    vi.mocked(link).mockRejectedValue(fsError('ENOTSUP'));
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      if (args[0] === lockPath) throw fsError('EACCES');
      return actualFs.open(...args);
    });

    await expect(withFileLease(lockPath, async () => {})).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('propagates a failure to place the lock other than an existing one or missing hard links', async () => {
    vi.mocked(link).mockRejectedValueOnce(fsError('EIO'));

    await expect(withFileLease(lockPath, async () => {})).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(dir)).toEqual([]);
  });

  describe('holder records', () => {
    // The publisher wallet lock recorded only its pid (and when it was taken).
    it('reads a record without a namespace, thread or token as this namespace\'s main thread', async () => {
      await writeFile(lockPath, JSON.stringify({ pid: process.ppid, createdAt: Date.now() }));
      await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

      await writeFile(lockPath, JSON.stringify({ pid: EXITED_PID, createdAt: Date.now() }));
      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    it('takes over a record whose fields have the wrong types, instead of coercing them', async () => {
      for (const record of [
        '{"pid":"123","token":{}}',
        '{"pid":1.5}',
        '{"pid":-1}',
        '[1, 2]',
        'null',
        // A live pid, but a thread or token no version wrote.
        JSON.stringify({ pid: process.ppid, threadId: '0' }),
        JSON.stringify({ pid: process.ppid, token: '' }),
      ]) {
        await writeFile(lockPath, record);
        await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
      }
    });

    it('writes the fields a waiter checks, and no others', async () => {
      await withFileLease(lockPath, async () => {
        const record = JSON.parse(await readFile(lockPath, 'utf-8'));
        expect(Object.keys(record).sort()).toEqual(['pid', 'pidNamespace', 'threadId', 'token']);
      });
    });
  });

  it('waits for a live holder and names the lock file when it gives up', async () => {
    await writeFile(lockPath, liveHolder());

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100, label: 'config' }))
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

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('treats a fresh empty lock as still being written, and an old one as abandoned', async () => {
    await writeFile(lockPath, '');
    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

    await backdate(lockPath, 10_000);
    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 100 })).resolves.toBe('ran');
  });

  it('treats a fresh unreadable lock as still being written, and an old one as abandoned', async () => {
    await writeFile(lockPath, '{"pid":');
    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

    await backdate(lockPath, 10_000);
    await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 100 })).resolves.toBe('ran');
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
    const waiter = (onEnter: () => Promise<void>) => withFileLease(lockPath, async () => {
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
    const staleLock = () => JSON.stringify({ pid: EXITED_PID });

    /** A guard as a holder leaves it: a directory holding its record, named by its token. */
    async function writeGuard(record: string, name: string): Promise<string> {
      await mkdir(guardPath);
      const recordPath = join(guardPath, name);
      await writeFile(recordPath, record);
      return recordPath;
    }

    // A live process holds the guard only while it commits, releases or
    // removes a lock; taking it over could let that step interleave with this one.
    it('never takes the guard from a live holder, however long it has held it', async () => {
      await writeFile(lockPath, staleLock());
      const record = await writeGuard(liveHolder({ token: 'committing' }), 'committing');
      await backdate(record, 10 * 60_000);

      await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
      expect(existsSync(lockPath)).toBe(true);
      expect(await readdir(guardPath)).toEqual(['committing']);
    });

    it('clears a guard whose holder died, then takes the stale lock over', async () => {
      await writeFile(lockPath, staleLock());
      await writeGuard(JSON.stringify({ pid: EXITED_PID, token: 'crashed' }), 'crashed');

      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
      expect(await readdir(dir)).toEqual([]);
    });

    it('clears a guard an earlier process with this pid left behind', async () => {
      const own = await ownHolderRecord();
      await writeFile(lockPath, staleLock());
      await writeGuard(JSON.stringify({ ...own, token: 'earlier-process' }), 'earlier-process');

      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    it('clears a guard from another pid namespace only once its record is as old as a lapsed lease', async () => {
      await writeFile(lockPath, staleLock());
      const record = await writeGuard(JSON.stringify({
        pid: process.pid, pidNamespace: 'other-container pid:[4026532001]', threadId: 0, token: 'other',
      }), 'other');
      await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);

      await backdate(record, 2 * 60_000);
      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });

    // A holder's release, or a clearer, stopped between removing the record
    // and the directory. Only an empty directory is ever removed, so there is
    // nothing to wait for.
    it('removes an empty guard at once', async () => {
      await writeFile(lockPath, staleLock());
      await mkdir(guardPath);

      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
      expect(await readdir(dir)).toEqual([]);
    });

    it('waits, instead of spinning, on a stale guard record it cannot remove', async () => {
      await writeFile(lockPath, staleLock());
      // A directory where the record should be: not a record, and not removable as one.
      const stuck = join(guardPath, 'stuck');
      await mkdir(stuck, { recursive: true });
      await backdate(stuck, 10_000);

      await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 150 })).rejects.toThrow(/Timed out/);
      expect(existsSync(lockPath)).toBe(true);
    });

    // The race a clearer must not lose: it judges a dead holder's guard gone,
    // and before it acts, another contender clears that guard and takes it
    // again. What the first clearer then removes must leave the new guard.
    it('never removes a guard taken since a clearer judged the old one gone', async () => {
      await writeFile(lockPath, staleLock());
      const deadRecord = await writeGuard(JSON.stringify({ pid: EXITED_PID, token: 'crashed' }), 'crashed');
      let resumeSlow!: () => void;
      const slowResumed = new Promise<void>((resolve) => { resumeSlow = resolve; });
      let slowPaused = false;
      // The slow clearer's read of the dead record returns only once the guard has been taken again.
      vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
        const content = await actualFs.readFile(...args);
        if (args[0] === deadRecord && !slowPaused) {
          slowPaused = true;
          await slowResumed;
        }
        return content;
      });
      const guardRemovals: string[] = [];
      vi.mocked(rmdir).mockImplementation(async (...args: Parameters<typeof rmdir>) => {
        guardRemovals.push(String(args[0]));
        return actualFs.rmdir(...args);
      });
      let guardBefore: string[] = [];
      let guardAfter: string[] = [];

      const slow = withFileLease(lockPath, async () => 'slow', { timeoutMs: 10_000 });
      await vi.waitFor(() => expect(slowPaused).toBe(true));
      const fast = withFileLease(lockPath, async (lock) => lock.commit(async () => {
        guardBefore = await readdir(guardPath);
        const removalsBefore = guardRemovals.length;
        resumeSlow();
        // The slow clearer now acts on what it read about the dead guard.
        await vi.waitFor(() => expect(guardRemovals.length).toBeGreaterThan(removalsBefore));
        guardAfter = await readdir(guardPath);
        return 'fast';
      }), { timeoutMs: 10_000 });

      expect(await Promise.all([slow, fast])).toEqual(['slow', 'fast']);
      expect(guardBefore).toHaveLength(1);
      expect(guardBefore).not.toEqual(['crashed']);
      expect(guardAfter).toEqual(guardBefore);
    });

    it('commits only while it holds the lock, holding the guard meanwhile', async () => {
      await withFileLease(lockPath, async (lock) => {
        await expect(lock.commit(async () => {
          const records = await readdir(guardPath);
          expect(records).toHaveLength(1);
          expect(JSON.parse(await readFile(join(guardPath, records[0]!), 'utf-8')))
            .toMatchObject({ pid: process.pid, threadId, token: records[0] });
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

      await withFileLease(lockPath, async (lock) => {
        await lock.replaceFile(target, 'new');
        await writeFile(lockPath, liveHolder({ token: 'successor' }));
        await expect(lock.replaceFile(target, 'stale')).rejects.toThrow('Lost the file lock');
      });

      expect(await readFile(target, 'utf-8')).toBe('new');
      expect((await readdir(dir)).sort()).toEqual(['data.json', 'resource.lock']);
    });

    it('refuses to commit when it cannot read the lock to check it still holds it', async () => {
      await withFileLease(lockPath, async (lock) => {
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

    // Windows refuses a rename onto any existing directory with EPERM or EACCES,
    // which elsewhere can mean a permission problem instead.
    it('counts a guard refused with EPERM or EACCES as taken only while one exists', async () => {
      await withFileLease(lockPath, async (lock) => {
        await writeGuard(liveHolder({ token: 'committing' }), 'committing');
        vi.mocked(rename).mockImplementation(async (from, to) => {
          if (to === guardPath) throw fsError(existsSync(guardPath) ? 'EPERM' : 'EACCES');
          return actualFs.rename(from, to);
        });
        await expect(lock.commit(async () => {})).rejects.toThrow('Timed out waiting to commit');

        await rm(guardPath, { recursive: true });
        await expect(lock.commit(async () => {})).rejects.toMatchObject({ code: 'EACCES' });
        vi.mocked(rename).mockReset();
      }, { label: 'config', staleMs: 150 });

      expect(await readdir(dir)).toEqual([]);
    });

    it('gives up committing while the guard stays taken', async () => {
      await withFileLease(lockPath, async (lock) => {
        await writeGuard(liveHolder({ token: 'committing' }), 'committing');
        const publish = vi.fn(async () => {});
        await expect(lock.commit(publish)).rejects.toThrow(
          `Timed out waiting to commit under the config lock: ${guardPath} is held`,
        );
        expect(publish).not.toHaveBeenCalled();
        await rm(guardPath, { recursive: true });
      }, { label: 'config', staleMs: 150 });
    });

    it('leaves its lock to lapse when the guard stays taken as it releases', async () => {
      await withFileLease(lockPath, async () => {
        await writeGuard(liveHolder({ token: 'committing' }), 'committing');
      }, { staleMs: 150 });
      expect(existsSync(lockPath)).toBe(true);

      await rm(guardPath, { recursive: true });
      // No longer held by this thread, so it is taken over at once.
      await expect(withFileLease(lockPath, async () => 'ran', { timeoutMs: 200 })).resolves.toBe('ran');
    });
  });

  it('releases only a lock that still carries its token', async () => {
    const successor = liveHolder({ token: 'successor' });

    await withFileLease(lockPath, async () => {
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

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('never deletes a lock that vanishes while its age is checked', async () => {
    await writeFile(lockPath, '');
    vi.mocked(stat).mockRejectedValueOnce(enoent());

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 100 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('polls, instead of spinning on, an abandoned lock it cannot remove', async () => {
    await mkdir(lockPath);
    await backdate(lockPath, 10_000);
    vi.mocked(readFile).mockClear();

    await expect(withFileLease(lockPath, async () => {}, { timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    // A few reads per 25 ms poll; a retry loop without the wait would make hundreds.
    expect(vi.mocked(readFile).mock.calls.length).toBeLessThan(40);
  });

  // What writers use: prepare reads and returns the new content, and only
  // the lease publishes it, through the guarded commit.
  describe('updateFileUnderLease', () => {
    it('replaces the file prepare returns, and reports how', async () => {
      const target = join(dir, 'data.json');
      await writeFile(target, 'old');

      await expect(updateFileUnderLease(lockPath, async () => ({ result: 'done', path: target, content: 'new' })))
        .resolves.toEqual({ result: 'done', replaced: true, strategy: 'rename' });

      expect(await readFile(target, 'utf-8')).toBe('new');
      expect(await readdir(dir)).toEqual(['data.json']);
    });

    it('writes nothing when prepare returns no file', async () => {
      await expect(updateFileUnderLease(lockPath, async () => ({ result: 42 })))
        .resolves.toEqual({ result: 42, replaced: false });

      expect(await readdir(dir)).toEqual([]);
    });

    it('publishes nothing when its lease was taken over while prepare ran', async () => {
      const target = join(dir, 'data.json');
      await writeFile(target, 'old');

      await expect(updateFileUnderLease(lockPath, async () => {
        // This holder stalled past its lease; a successor took the lock over and wrote.
        await writeFile(lockPath, liveHolder({ token: 'successor' }));
        await writeFile(target, 'successor');
        return { result: 'stale', path: target, content: 'stale' };
      }, { label: 'config' })).rejects.toThrow(`Lost the config lock: ${lockPath} was taken over`);

      expect(await readFile(target, 'utf-8')).toBe('successor');
      expect((await readdir(dir)).sort()).toEqual(['data.json', 'resource.lock']);
    });

    it('gives the file the mode prepare asks for', async () => {
      const target = join(dir, 'secret.json');

      await updateFileUnderLease(lockPath, async () => ({ result: undefined, path: target, content: '{}', mode: 0o600 }));

      expect(await readFile(target, 'utf-8')).toBe('{}');
      // Windows keeps only a read-only flag, not POSIX permission bits.
      if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600);
    });
  });

  it('propagates failures other than an existing lock', async () => {
    await expect(withFileLease(join(dir, 'missing', 'resource.lock'), async () => {}))
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
      await withFileLease(lockPath, async () => {
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
