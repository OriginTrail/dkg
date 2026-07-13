import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  stat: vi.fn(),
  open: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  stat: fsMocks.stat,
  open: fsMocks.open,
  writeFile: fsMocks.writeFile,
  // Deliberately supplied so a regression to whole-file readFile() is visible.
  readFile: fsMocks.readFile,
}));

const { rotateDaemonLogIfNeeded } = await import('../src/daemon/log-rotation.js');

describe('daemon log rotation I/O bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.stat.mockResolvedValue({ size: 2_000_000_000 });
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

  it('reads only keepBytes from a multi-gigabyte log and never uses readFile', async () => {
    const result = await rotateDaemonLogIfNeeded('/var/lib/dkg/daemon.log', {
      maxBytes: 100,
      keepBytes: 60,
    });

    expect(result).toEqual({
      rotated: true,
      previousBytes: 2_000_000_000,
      keptBytes: 60,
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
