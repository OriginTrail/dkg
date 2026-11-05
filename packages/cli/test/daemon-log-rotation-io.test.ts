import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn(),
  open: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  link: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  stat: fsMocks.stat,
  open: fsMocks.open,
  writeFile: fsMocks.writeFile,
  // Deliberately supplied so a regression to whole-file readFile() is visible.
  readFile: fsMocks.readFile,
  readdir: fsMocks.readdir,
  link: fsMocks.link,
  // Preserve POSIX overwrite semantics so a rename regression fails on lost history.
  rename: fsMocks.rename,
  unlink: fsMocks.unlink,
}));

const { rotateDaemonLogIfNeeded } = await import('../src/daemon/log-rotation.js');

const DIR = '/var/lib/dkg';
const LOG = `${DIR}/daemon.log`;

/**
 * The log directory as rotation sees it: sizes and times, no content. Renames,
 * removals and writes change it, so retention after a link finds the moved
 * file as it would on disk.
 */
const files = new Map<string, { size: number; mtimeMs: number }>();
let inodeIds = new WeakMap<object, bigint>();
let nextInode = 1n;

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

describe('daemon log rotation I/O bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    inodeIds = new WeakMap();
    nextInode = 1n;
    fsMocks.stat.mockImplementation(async (path: string) => {
      const file = files.get(path);
      if (!file) throw missing(path);
      if (!inodeIds.has(file)) inodeIds.set(file, nextInode++);
      return { size: file.size, mtimeMs: file.mtimeMs, dev: 1n, ino: inodeIds.get(file), isFile: () => true };
    });
    fsMocks.readdir.mockImplementation(async (dir: string) => [...files.keys()]
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1)));
    fsMocks.rename.mockImplementation(async (from: string, to: string) => {
      const file = files.get(from);
      if (!file) throw missing(from);
      files.delete(from);
      files.set(to, file);
    });
    fsMocks.link.mockImplementation(async (from: string, to: string) => {
      const file = files.get(from);
      if (!file) throw missing(from);
      if (files.has(to)) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
      files.set(to, file);
    });
    fsMocks.unlink.mockImplementation(async (path: string) => {
      if (!files.delete(path)) throw missing(path);
    });
    fsMocks.open.mockImplementation(async (path: string) => {
      if (!files.has(path)) throw missing(path);
      return { read: fsMocks.read, close: fsMocks.close };
    });
    fsMocks.read.mockImplementation(async (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(0x78, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    fsMocks.close.mockResolvedValue(undefined);
    fsMocks.writeFile.mockImplementation(async (path: string, data: Buffer) => {
      const existing = files.get(path);
      if (existing) { existing.size = data.length; existing.mtimeMs = Date.now(); }
      else files.set(path, { size: data.length, mtimeMs: Date.now() });
    });
  });

  it('rotates a large log that fits the size limit by renaming it, without opening it', async () => {
    files.set(LOG, { size: 400_000_000, mtimeMs: Date.now() });

    const result = await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60 });

    expect(result).toEqual({
      rotated: true,
      trimmed: false,
      previousBytes: 400_000_000,
      removedFiles: 0,
      newestCutTo: null,
    });
    expect(fsMocks.link).toHaveBeenCalledWith(LOG, `${LOG}.1`);
    expect(files.get(`${LOG}.1`)?.size).toBe(400_000_000);
    expect(fsMocks.open).not.toHaveBeenCalled();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('cuts a rotated multi-gigabyte log past the size limit from a bounded tail read, never the whole file', async () => {
    files.set(LOG, { size: 2_000_000_000, mtimeMs: Date.now() });

    const result = await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60 });

    expect(result).toEqual({
      rotated: true,
      trimmed: false,
      previousBytes: 2_000_000_000,
      removedFiles: 0,
      newestCutTo: 60,
    });
    expect(fsMocks.open).toHaveBeenCalledTimes(1);
    expect(fsMocks.open).toHaveBeenCalledWith(`${LOG}.1`, 'r');
    expect(fsMocks.read).toHaveBeenCalledTimes(1);
    expect(fsMocks.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 60, 1_999_999_940);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(`${LOG}.1`, expect.objectContaining({ length: 60 }));
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(files.get(`${LOG}.1`)?.size).toBe(60);
  });

  it('falls back to reading only keepBytes of the live log, never the whole file, when the link fails', async () => {
    files.set(LOG, { size: 2_000_000_000, mtimeMs: Date.now() });
    fsMocks.link.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    const result = await rotateDaemonLogIfNeeded(LOG, {
      maxBytes: 100,
      keepBytes: 60,
    });

    expect(result).toEqual({
      rotated: false,
      trimmed: true,
      previousBytes: 2_000_000_000,
      removedFiles: 0,
      newestCutTo: null,
    });
    expect(fsMocks.readFile).not.toHaveBeenCalled();
    expect(fsMocks.open).toHaveBeenCalledWith(LOG, 'r');
    expect(fsMocks.read).toHaveBeenCalledTimes(1);
    expect(fsMocks.read).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      60,
      1_999_999_940,
    );
    expect(fsMocks.writeFile).toHaveBeenCalledWith(LOG, expect.objectContaining({ length: 60 }));
    expect(files.get(LOG)?.size).toBe(60);
  });
  it.each(['readdir', 'stat'] as const)('keeps every rotated file after an incomplete %s scan', async (failure) => {
    const now = Date.now();
    files.set(LOG, { size: 200, mtimeMs: now });
    const newest = { size: 40, mtimeMs: now - 1 };
    const expectedNewest = { ...newest };
    const older = { size: 30, mtimeMs: now - 2 };
    const expectedOlder = { ...older };
    files.set(`${LOG}.1`, newest);
    files.set(`${LOG}.2`, older);
    const error = Object.assign(new Error('temporary scan failure'), { code: 'EIO' });
    if (failure === 'readdir') fsMocks.readdir.mockRejectedValue(error);
    else {
      const stat = fsMocks.stat.getMockImplementation()!;
      fsMocks.stat.mockImplementation(async (path: string) => {
        if (path === `${LOG}.1`) throw error;
        return stat(path);
      });
    }
    const result = await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 });
    expect(result.rotated).toBe(false);
    expect(result.trimmed).toBe(false);
    expect(files.get(`${LOG}.1`)).toEqual(expectedNewest);
    expect(files.get(`${LOG}.2`)).toEqual(expectedOlder);
    expect(files.get(LOG)?.size).toBe(200);
    expect(fsMocks.link).not.toHaveBeenCalled();
    expect(fsMocks.unlink).not.toHaveBeenCalled();
  });

  it('keeps the moved history after a partial rotation and recovers on the next check', async () => {
    const now = Date.now();
    files.set(LOG, { size: 200, mtimeMs: now });
    const newest = { size: 40, mtimeMs: now - 1 };
    const expectedNewest = { ...newest };
    const older = { size: 30, mtimeMs: now - 2 };
    const expectedOlder = { ...older };
    files.set(`${LOG}.1`, newest);
    files.set(`${LOG}.2`, older);
    const link = fsMocks.link.getMockImplementation()!;
    fsMocks.rename.mockImplementation(async (from: string, to: string) => {
      const file = files.get(from);
      if (!file) throw missing(from);
      files.delete(from);
      files.set(to, file);
    });
    fsMocks.link.mockImplementation(async (from: string, to: string) => {
      if (from === `${LOG}.1`) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return link(from, to);
    });
    const options = { maxBytes: 100, keepBytes: 60, totalBytes: 500 };
    expect(await rotateDaemonLogIfNeeded(LOG, options)).toMatchObject({ rotated: false, trimmed: true });
    expect(files.get(`${LOG}.1`)).toEqual(expectedNewest);
    expect(files.has(`${LOG}.2`)).toBe(false);
    expect(files.get(`${LOG}.3`)).toEqual(expectedOlder);
    expect(files.get(LOG)?.size).toBe(60);
    fsMocks.link.mockImplementation(link);
    // Normal logging crosses the rotation threshold again.
    files.set(LOG, { size: 150, mtimeMs: now + 1 });
    expect(await rotateDaemonLogIfNeeded(LOG, options)).toMatchObject({ rotated: true, trimmed: false });
    expect(files.get(`${LOG}.1`)?.size).toBe(150);
    expect(files.get(`${LOG}.2`)).toEqual(expectedNewest);
    expect(files.get(`${LOG}.4`)).toEqual(expectedOlder);
  });

  it('never replaces a destination absent from an otherwise successful directory scan', async () => {
    const now = Date.now();
    files.set(LOG, { size: 200, mtimeMs: now });
    const existing = { size: 40, mtimeMs: now - 1 };
    const expectedExisting = { ...existing };
    files.set(`${LOG}.1`, existing);
    fsMocks.readdir.mockResolvedValueOnce(['daemon.log']);
    const result = await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 });
    expect(result).toMatchObject({ rotated: false, trimmed: false });
    expect(files.get(`${LOG}.1`)).toEqual(expectedExisting);
    expect(files.get(LOG)?.size).toBe(200);
  });

  it('bounds the live file when hard links are unsupported, without changing history', async () => {
    const now = Date.now();
    files.set(LOG, { size: 200, mtimeMs: now });
    const previous = { size: 40, mtimeMs: now - 1 };
    const expectedPrevious = { ...previous };
    files.set(`${LOG}.1`, previous);
    fsMocks.link.mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
    expect(await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 }))
      .toMatchObject({ rotated: false, trimmed: true });
    expect(files.get(LOG)?.size).toBe(60);
    expect(files.get(`${LOG}.1`)).toEqual(expectedPrevious);
  });

  it('rolls back a claimed name when removing the source fails, then safely trims', async () => {
    files.set(LOG, { size: 200, mtimeMs: Date.now() });
    const unlink = fsMocks.unlink.getMockImplementation()!;
    fsMocks.unlink.mockImplementation(async (path: string) => {
      if (path === LOG) throw Object.assign(new Error('source busy'), { code: 'EBUSY' });
      return unlink(path);
    });
    expect(await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 }))
      .toMatchObject({ rotated: false, trimmed: true });
    expect([...files.keys()]).toEqual([LOG]);
    expect(files.get(LOG)?.size).toBe(60);
  });

  it('does not trim or grow aliases while unlink and rollback fail, then recovers once', async () => {
    files.set(LOG, { size: 200, mtimeMs: Date.now() });
    const unlink = fsMocks.unlink.getMockImplementation()!;
    fsMocks.unlink.mockRejectedValue(Object.assign(new Error('directory temporarily read-only'), { code: 'EACCES' }));
    const options = { maxBytes: 100, keepBytes: 60, totalBytes: 500 };
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await rotateDaemonLogIfNeeded(LOG, options)).toMatchObject({ rotated: false, trimmed: false });
      expect([...files.keys()].sort()).toEqual([LOG, `${LOG}.1`]);
      expect(files.get(LOG)?.size).toBe(200);
      expect(files.get(`${LOG}.1`)).toBe(files.get(LOG));
    }
    expect(fsMocks.link).toHaveBeenCalledTimes(1);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
    fsMocks.unlink.mockImplementation(unlink);
    expect(await rotateDaemonLogIfNeeded(LOG, options)).toMatchObject({ rotated: true, trimmed: false });
    expect([...files.keys()]).toEqual([`${LOG}.1`]);
    expect(files.get(`${LOG}.1`)?.size).toBe(200);
  });

  it.each([undefined, 0n])('does not treat unavailable inode %s as shared identity', async (ino) => {
    files.set(LOG, { size: 200, mtimeMs: Date.now() });
    files.set(`${LOG}.1`, { size: 40, mtimeMs: Date.now() });
    const stat = fsMocks.stat.getMockImplementation()!;
    fsMocks.stat.mockImplementation(async (path: string) => ({ ...await stat(path), ino }));
    expect(await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 }))
      .toMatchObject({ rotated: false, trimmed: false });
    expect([...files.keys()].sort()).toEqual([LOG, `${LOG}.1`]);
    expect(fsMocks.link).not.toHaveBeenCalled();
    expect(fsMocks.unlink).not.toHaveBeenCalled();
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('keeps distinct inode identities beyond Number precision distinct', async () => {
    const live = { size: 200, mtimeMs: Date.now() };
    const expectedLive = { ...live };
    const previous = { size: 40, mtimeMs: Date.now() - 1 };
    const expectedPrevious = { ...previous };
    files.set(LOG, live);
    files.set(`${LOG}.1`, previous);
    inodeIds.set(live, 9_007_199_254_740_992n);
    inodeIds.set(previous, 9_007_199_254_740_993n);
    expect(await rotateDaemonLogIfNeeded(LOG, { maxBytes: 100, keepBytes: 60, totalBytes: 500 }))
      .toMatchObject({ rotated: true, trimmed: false });
    expect(files.get(`${LOG}.1`)).toEqual(expectedLive);
    expect(files.get(`${LOG}.2`)).toEqual(expectedPrevious);
  });

});
