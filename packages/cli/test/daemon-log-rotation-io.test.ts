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

describe('daemon log rotation I/O bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.stat.mockResolvedValue({ size: 2_000_000_000, mtimeMs: Date.now(), isFile: () => true });
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.rename.mockResolvedValue(undefined);
    fsMocks.read.mockImplementation(async (
      buffer: Buffer,
      offset: number,
      length: number,
    ) => {
      buffer.fill(0x78, offset, offset + length);
      return { bytesRead: length, buffer };
    });
    fsMocks.close.mockResolvedValue(undefined);
    fsMocks.open.mockResolvedValue({ read: fsMocks.read, close: fsMocks.close });
    fsMocks.writeFile.mockResolvedValue(undefined);
  });

  it('rotates a multi-gigabyte log by renaming it, without reading it', async () => {
    const result = await rotateDaemonLogIfNeeded('/var/lib/dkg/daemon.log', {
      maxBytes: 100,
      keepBytes: 60,
    });

    expect(result).toMatchObject({ rotated: true, trimmed: false, previousBytes: 2_000_000_000 });
    expect(fsMocks.rename).toHaveBeenCalledWith('/var/lib/dkg/daemon.log', '/var/lib/dkg/daemon.log.1');
    expect(fsMocks.open).not.toHaveBeenCalled();
    expect(fsMocks.readFile).not.toHaveBeenCalled();
  });

  it('falls back to reading only keepBytes, never the whole file, when the rename fails', async () => {
    fsMocks.rename.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    const result = await rotateDaemonLogIfNeeded('/var/lib/dkg/daemon.log', {
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
    expect(fsMocks.read).toHaveBeenCalledTimes(1);
    expect(fsMocks.read).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      60,
      1_999_999_940,
    );
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      '/var/lib/dkg/daemon.log',
      expect.objectContaining({ length: 60 }),
    );
  });
});
