import { constants } from 'node:fs';
import {
  access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceFileDurably } from '../src/durable-file-replace.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    stat: vi.fn(actual.stat),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('replaceFileDurably', () => {
  let dir = '';
  let target = '';

  beforeEach(async () => {
    // Resolve the temp root: on macOS it is reached through the /var symlink.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'dkg-durable-replace-')));
    target = join(dir, 'config.json');
  });

  afterEach(async () => {
    for (const mocked of [open, realpath, rename, stat]) vi.mocked(mocked).mockReset();
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

  it('propagates a failure to resolve the target other than a missing file', async () => {
    vi.mocked(realpath).mockRejectedValueOnce(fsError('ELOOP'));

    await expect(replaceFileDurably(target, 'new')).rejects.toMatchObject({ code: 'ELOOP' });
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

  it('flushes the directory after the rename, except on Windows', async () => {
    const directoryOpens = () => vi.mocked(open).mock.calls.filter(([path]) => path === dir);

    await replaceFileDurably(target, 'posix', { platform: 'linux' });
    expect(directoryOpens()).toEqual([[dir, constants.O_RDONLY]]);

    vi.mocked(open).mockClear();
    await replaceFileDurably(target, 'windows', { platform: 'win32' });
    expect(directoryOpens()).toEqual([]);
    expect(await readFile(target, 'utf-8')).toBe('windows');
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
