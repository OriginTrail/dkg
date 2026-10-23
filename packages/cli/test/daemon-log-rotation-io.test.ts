import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn(),
  open: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
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
  rename: fsMocks.rename,
  unlink: fsMocks.unlink,
}));

const { rotateDaemonLogIfNeeded } = await import('../src/daemon/log-rotation.js');

const DIR = '/var/lib/dkg';
const LOG = `${DIR}/daemon.log`;

/**
 * The log directory as rotation sees it: sizes and times, no content. Renames,
 * removals and writes change it, so retention after a rename finds the renamed
 * file as it would on disk.
 */
const files = new Map<string, { size: number; mtimeMs: number }>();

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' });
}

describe('daemon log rotation I/O bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    files.clear();
    fsMocks.stat.mockImplementation(async (path: string) => {
      const file = files.get(path);
      if (!file) throw missing(path);
      return { size: file.size, mtimeMs: file.mtimeMs, isFile: () => true };
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
      files.set(path, { size: data.length, mtimeMs: Date.now() });
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
    expect(fsMocks.rename).toHaveBeenCalledWith(LOG, `${LOG}.1`);
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

  it('falls back to reading only keepBytes of the live log, never the whole file, when the rename fails', async () => {
    files.set(LOG, { size: 2_000_000_000, mtimeMs: Date.now() });
    fsMocks.rename.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));

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
});
