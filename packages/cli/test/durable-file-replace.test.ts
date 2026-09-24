import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access, chmod, chown, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink,
  writeFile, type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceFileDurably } from '../src/durable-file-replace.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readlink: vi.fn(actual.readlink),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** Have every file handle the code opens go through `wrap` first. */
function wrapOpenedHandles(wrap: (handle: FileHandle, path: string) => void): void {
  vi.mocked(open).mockImplementation(async (path, ...rest) => {
    const handle = await actualFs.open(path, ...rest);
    wrap(handle, String(path));
    return handle;
  });
}

/** Record, in order, each fsync of an opened file or directory and each rename. */
function recordSyncsAndRenames(): string[] {
  const events: string[] = [];
  wrapOpenedHandles((handle, path) => {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push(`sync ${basename(path)}`);
      await sync();
    };
  });
  vi.mocked(rename).mockImplementation(async (from, to) => {
    events.push(`rename ${basename(String(from))} -> ${basename(String(to))}`);
    await actualFs.rename(from, to);
  });
  return events;
}

/** The mode writeFile gives a new file in `dir`, which the umask decides. */
async function newFileMode(dir: string): Promise<number> {
  const reference = join(dir, '.reference');
  await writeFile(reference, 'x');
  const { mode } = await stat(reference);
  await rm(reference);
  return mode & 0o777;
}

const TEMP_FILE = /^\.config\.json\.\d+\.[0-9a-f-]+\.tmp$/;

describe('replaceFileDurably', () => {
  let dir = '';
  let target = '';

  beforeEach(async () => {
    // Resolve the temp root: on macOS it is reached through the /var symlink.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'dkg-durable-replace-')));
    target = join(dir, 'config.json');
  });

  afterEach(async () => {
    for (const mocked of [open, readlink, realpath, rename, stat]) vi.mocked(mocked).mockReset();
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temp file behind', async () => {
    await writeFile(target, 'old');

    await replaceFileDurably(target, 'new');

    expect(await readFile(target, 'utf-8')).toBe('new');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('keeps the permission bits of the file it replaces', async () => {
    for (const mode of [0o600, 0o640]) {
      await writeFile(target, 'old');
      await chmod(target, mode);

      await replaceFileDurably(target, 'new');

      expect(await readFile(target, 'utf-8')).toBe('new');
      // Windows keeps only a read-only flag, not POSIX permission bits.
      if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(mode);
    }
  });

  it('keeps the group of the file it replaces', async () => {
    // A new file gets the writer's group or the directory's, as this one did;
    // move it to another group the writer is in, as an operator sharing it would.
    await writeFile(target, 'old');
    const { uid, gid: createdGid } = await stat(target);
    const otherGid = process.getgroups?.().find((gid) => gid !== createdGid);
    // Windows has no POSIX groups, and a writer in a single group has nowhere to move it.
    if (otherGid === undefined) return;
    await chown(target, uid, otherGid);

    await replaceFileDurably(target, 'new');

    expect(await readFile(target, 'utf-8')).toBe('new');
    expect(await stat(target)).toMatchObject({ uid, gid: otherGid });
  });

  it("gives the replacement the owner and group of another user's file before its mode", async () => {
    await writeFile(target, 'old');
    await chmod(target, 0o640);
    const actual = await stat(target);
    // The file belongs to another user, as when a root daemon writes an operator's config.
    const owner = { uid: actual.uid + 1, gid: actual.gid + 1 };
    vi.mocked(stat).mockImplementationOnce(async (path) => Object.assign(await actualFs.stat(path), owner));
    const events: string[] = [];
    wrapOpenedHandles((handle) => {
      handle.chown = async (uid, gid) => { events.push(`chown ${uid}:${gid}`); };
      const chmodHandle = handle.chmod.bind(handle);
      handle.chmod = async (mode) => {
        events.push(`chmod ${(Number(mode) & 0o777).toString(8)}`);
        await chmodHandle(mode);
      };
    });

    await replaceFileDurably(target, 'new');

    // The mode stat reports: Windows keeps only a read-only flag.
    expect(events).toEqual([`chown ${owner.uid}:${owner.gid}`, `chmod ${(actual.mode & 0o777).toString(8)}`]);
    expect(await readFile(target, 'utf-8')).toBe('new');
    expect((await stat(target)).ino).not.toBe(actual.ino);
  });

  it('rewrites the file in place when it may not give the replacement the original owner', async () => {
    await writeFile(target, 'old');
    await chmod(target, 0o640);
    const actual = await stat(target);
    const anotherUser = async (path: Parameters<typeof stat>[0]) =>
      Object.assign(await actualFs.stat(path), { uid: actual.uid + 1 });
    wrapOpenedHandles((handle) => {
      handle.chown = async () => { throw fsError('EPERM'); };
    });

    // A commit step that refuses to publish leaves even the in-place path untouched.
    vi.mocked(stat).mockImplementationOnce(anotherUser);
    await expect(replaceFileDurably(target, 'new', {
      commit: async () => { throw new Error('lock lost'); },
    })).rejects.toThrow('lock lost');
    expect(await readFile(target, 'utf-8')).toBe('old');

    vi.mocked(stat).mockImplementationOnce(anotherUser);
    const syncs = vi.fn();
    wrapOpenedHandles((handle, path) => {
      handle.chown = async () => { throw fsError('EPERM'); };
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncs(basename(path));
        await sync();
      };
    });
    await replaceFileDurably(target, 'new content');

    // The same inode, so its owner, group, mode and any ACL stay as they were.
    const after = await stat(target);
    expect(after.ino).toBe(actual.ino);
    expect(after.mode & 0o777).toBe(actual.mode & 0o777);
    expect(await readFile(target, 'utf-8')).toBe('new content');
    expect(syncs.mock.calls).toEqual([['config.json']]);
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('propagates a chown failure other than a refusal', async () => {
    await writeFile(target, 'old');
    const actual = await stat(target);
    vi.mocked(stat).mockImplementationOnce(async (path) => Object.assign(await actualFs.stat(path), { uid: actual.uid + 1 }));
    wrapOpenedHandles((handle) => {
      handle.chown = async () => { throw fsError('EIO'); };
    });

    await expect(replaceFileDurably(target, 'new')).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('gives a new file the same default mode writeFile would', async () => {
    const reference = join(dir, 'reference');
    await writeFile(reference, 'x');

    await replaceFileDurably(target, 'new');

    expect((await stat(target)).mode & 0o777).toBe((await stat(reference)).mode & 0o777);
  });

  it('refuses a read-only file whenever writeFile would', async () => {
    await writeFile(target, 'old');
    await chmod(target, 0o444);
    // Unprivileged users are refused (EACCES, or EPERM on Windows); root may write anyway.
    const expected = await access(target, constants.W_OK)
      .then(() => 'replaced', (error: NodeJS.ErrnoException) => error.code);

    const outcome = await replaceFileDurably(target, 'new')
      .then(() => 'replaced', (error: NodeJS.ErrnoException) => error.code);

    expect(outcome).toBe(expected);
    expect(await readFile(target, 'utf-8')).toBe(outcome === 'replaced' ? 'new' : 'old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('replaces a symlinked file behind its link', async () => {
    // Creating a file symlink needs a privilege Windows users usually lack.
    if (process.platform === 'win32') return;
    const realDir = join(dir, 'managed');
    await mkdir(realDir);
    await writeFile(join(realDir, 'config.json'), 'old');
    const link = join(dir, 'link.json');
    await symlink(join(realDir, 'config.json'), link);

    await replaceFileDurably(link, 'new');

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(realDir, 'config.json'), 'utf-8')).toBe('new');
    expect(await readdir(realDir)).toEqual(['config.json']);
  });

  // A config managed elsewhere is linked in before the managed copy exists.
  it.each([
    ['an absolute', (managed: string) => managed],
    ['a relative', () => join('managed', 'config.json')],
  ])('creates the missing file behind %s symlink and keeps the link', async (_kind, linkTo) => {
    // Creating a file symlink needs a privilege Windows users usually lack.
    if (process.platform === 'win32') return;
    const managed = join(dir, 'managed', 'config.json');
    await mkdir(join(dir, 'managed'));
    await symlink(linkTo(managed), target);

    await replaceFileDurably(target, 'new');

    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readFile(managed, 'utf-8')).toBe('new');
    expect((await stat(managed)).mode & 0o777).toBe(await newFileMode(dir));
    expect(await readdir(join(dir, 'managed'))).toEqual(['config.json']);
    expect((await readdir(dir)).sort()).toEqual(['config.json', 'managed']);
  });

  it('resolves a relative symlink from the directory it really sits in', async () => {
    if (process.platform === 'win32') return;
    // The home is itself a link, so `..` from the link must mean `data/..`.
    await mkdir(join(dir, 'data', 'home'), { recursive: true });
    await mkdir(join(dir, 'data', 'managed'));
    await symlink(join(dir, 'data', 'home'), join(dir, 'home'));
    await symlink(join('..', 'managed', 'config.json'), join(dir, 'data', 'home', 'config.json'));

    await replaceFileDurably(join(dir, 'home', 'config.json'), 'new');

    expect(await readFile(join(dir, 'data', 'managed', 'config.json'), 'utf-8')).toBe('new');
    expect((await lstat(join(dir, 'data', 'home', 'config.json'))).isSymbolicLink()).toBe(true);
  });

  it('gives up on a cycle of links instead of following it forever', async () => {
    if (process.platform === 'win32') return;
    await symlink(join(dir, 'b.json'), join(dir, 'a.json'));
    await symlink(join(dir, 'a.json'), join(dir, 'b.json'));
    // realpath reports the cycle itself; make it look like a missing target to reach the walk.
    vi.mocked(realpath).mockImplementation(async (path) => {
      if (String(path).endsWith('.json')) throw fsError('ENOENT');
      return actualFs.realpath(path);
    });

    await expect(replaceFileDurably(join(dir, 'a.json'), 'new')).rejects.toMatchObject({ code: 'ELOOP' });
    expect((await readdir(dir)).sort()).toEqual(['a.json', 'b.json']);
  });

  it('propagates a failure to resolve the target other than a missing file', async () => {
    vi.mocked(realpath).mockRejectedValueOnce(fsError('ELOOP'));

    await expect(replaceFileDurably(target, 'new')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails as writeFile would when the directory does not exist', async () => {
    await expect(replaceFileDurably(join(dir, 'missing', 'config.json'), 'new')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('propagates a failure to resolve a missing file other than a missing directory or link', async () => {
    const missing = join(dir, 'missing.json');
    // The directory cannot be resolved.
    vi.mocked(realpath)
      .mockRejectedValueOnce(fsError('ENOENT'))
      .mockRejectedValueOnce(fsError('EACCES'));
    await expect(replaceFileDurably(missing, 'new')).rejects.toMatchObject({ code: 'EACCES' });

    // The entry cannot be read as a link.
    vi.mocked(readlink).mockRejectedValueOnce(fsError('EIO'));
    await expect(replaceFileDurably(missing, 'new')).rejects.toMatchObject({ code: 'EIO' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('propagates a failure to inspect the target other than a missing file', async () => {
    await writeFile(target, 'old');
    vi.mocked(stat).mockRejectedValueOnce(fsError('EACCES'));

    await expect(replaceFileDurably(target, 'new')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('keeps the previous file and removes the temp file when the rename fails', async () => {
    await writeFile(target, 'old');
    vi.mocked(rename).mockRejectedValueOnce(fsError('EIO'));

    await expect(replaceFileDurably(target, 'new')).rejects.toMatchObject({ code: 'EIO' });

    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('retries a rename that Windows refused while another handle was open', async () => {
    await writeFile(target, 'old');
    vi.mocked(rename)
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockRejectedValueOnce(fsError('EBUSY'));

    await replaceFileDurably(target, 'new', { platform: 'win32' });

    expect(await readFile(target, 'utf-8')).toBe('new');
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('gives up once the Windows retry budget is spent', async () => {
    await writeFile(target, 'old');
    vi.mocked(rename).mockRejectedValue(fsError('EACCES'));

    await expect(replaceFileDurably(target, 'new', { platform: 'win32' })).rejects.toMatchObject({ code: 'EACCES' });

    expect(rename).toHaveBeenCalledTimes(6);
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('does not retry a rename failure Windows does not report for a busy file', async () => {
    await writeFile(target, 'old');
    vi.mocked(rename).mockRejectedValueOnce(fsError('EXDEV'));

    await expect(replaceFileDurably(target, 'new', { platform: 'win32' })).rejects.toMatchObject({ code: 'EXDEV' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('does not retry the same failure on other platforms', async () => {
    await writeFile(target, 'old');
    vi.mocked(rename).mockRejectedValueOnce(fsError('EPERM'));

    await expect(replaceFileDurably(target, 'new', { platform: 'linux' })).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('syncs the new content before the rename and the directory after it, except on Windows', async () => {
    await writeFile(target, 'old');
    const events = recordSyncsAndRenames();

    await replaceFileDurably(target, 'posix', { platform: 'linux' });
    const temp = events[0]?.slice('sync '.length) ?? '';
    expect(temp).toMatch(TEMP_FILE);
    // A Windows host cannot open the directory to flush it; the linux path still tries.
    const directorySync = process.platform === 'win32' ? [] : [`sync ${basename(dir)}`];
    expect(events).toEqual([`sync ${temp}`, `rename ${temp} -> config.json`, ...directorySync]);
    expect(await readFile(target, 'utf-8')).toBe('posix');

    events.length = 0;
    await replaceFileDurably(target, 'windows', { platform: 'win32' });
    expect(events).toEqual([expect.stringMatching(/^sync /), expect.stringMatching(/ -> config\.json$/)]);
    expect(await readFile(target, 'utf-8')).toBe('windows');
  });

  it('publishes through the commit step, once the content is synced', async () => {
    await writeFile(target, 'old');
    const events = recordSyncsAndRenames();

    await replaceFileDurably(target, 'new', {
      platform: 'win32',
      commit: async (publish) => {
        events.push('commit:start');
        await publish();
        events.push('commit:end');
      },
    });

    expect(events).toEqual([
      expect.stringMatching(/^sync \.config\.json\./), 'commit:start', expect.stringMatching(/ -> config\.json$/), 'commit:end',
    ]);
    expect(await readFile(target, 'utf-8')).toBe('new');
  });

  it('leaves the file alone when the commit step refuses to publish', async () => {
    await writeFile(target, 'old');
    const events = recordSyncsAndRenames();

    await expect(replaceFileDurably(target, 'new', {
      commit: async () => {
        events.push('check');
        throw new Error('lock lost');
      },
    })).rejects.toThrow('lock lost');

    // The step runs on content already synced, and nothing is renamed when it refuses.
    expect(events).toEqual([expect.stringMatching(/^sync \.config\.json\./), 'check']);
    expect(await readFile(target, 'utf-8')).toBe('old');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('gives the file the requested mode, over a looser original and without a looser moment when new', async () => {
    await writeFile(target, 'old');
    await chmod(target, 0o644);
    const fresh = join(dir, 'fresh.json');

    await replaceFileDurably(target, 'new', { mode: 0o600 });
    await replaceFileDurably(fresh, 'new', { mode: 0o600 });

    expect(await readFile(target, 'utf-8')).toBe('new');
    // The new file's temp file is created owner-only, never with the umask default.
    const freshTemps = vi.mocked(open).mock.calls.filter(([path]) => /\.fresh\.json\..+\.tmp$/.test(String(path)));
    expect(freshTemps.map(([, flags, mode]) => [flags, mode])).toEqual([['wx', 0o600]]);
    // Windows keeps only a read-only flag, not POSIX permission bits.
    if (process.platform !== 'win32') {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect((await stat(fresh)).mode & 0o777).toBe(0o600);
    }
  });

  // Antivirus or an editor can hold a file open without FILE_SHARE_DELETE,
  // which makes Windows refuse a rename over it until the handle closes.
  it('replaces a file Windows holds open without delete sharing once the handle closes', async () => {
    if (process.platform !== 'win32') return;
    await writeFile(target, 'old');
    const holder = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `$f = [System.IO.File]::Open('${target}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); `
      + '[Console]::In.ReadLine() | Out-Null; $f.Close()',
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => { holder.on('exit', resolve); });
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) resolve(); });
    });
    let refused = 0;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      try {
        await actualFs.rename(from, to);
      } catch (error) {
        // Release the handle once Windows has refused the rename.
        if (refused++ === 0) holder.stdin.end('\n');
        throw error;
      }
    });

    await replaceFileDurably(target, 'new');
    await exited;

    expect(refused).toBeGreaterThan(0);
    expect(await readFile(target, 'utf-8')).toBe('new');
    expect(await readdir(dir)).toEqual(['config.json']);
  });

  it('still succeeds when the directory cannot be flushed', async () => {
    vi.mocked(open).mockImplementation(async (path, ...rest) => {
      if (path === dir) throw fsError('EINVAL');
      return actualFs.open(path, ...rest);
    });

    await replaceFileDurably(target, 'new', { platform: 'linux' });

    expect(await readFile(target, 'utf-8')).toBe('new');
  });
});
