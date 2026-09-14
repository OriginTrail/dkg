import { describe, expect, it, vi } from 'vitest';
import {
  resolveAtomicWriteDestination,
  resolveAtomicWriteDestinationSync,
  writeFileAtomic,
  type AtomicWriteIo,
  type SyncAtomicWriteResolutionIo,
} from '../src/fs-utils.js';

const file = { isSymbolicLink: () => false };
const link = { isSymbolicLink: () => true };
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

function virtualResolutionIo(): {
  async: Pick<AtomicWriteIo, 'lstat' | 'readlink'>;
  sync: SyncAtomicWriteResolutionIo;
} {
  const inspect = (path: string) => {
    if (path === '/virtual/alias') return link;
    if (path === '/virtual/final.json') return link;
    if (path === '/' || path === '/virtual' || path === '/physical') return file;
    throw missing();
  };
  const target = (path: string) => {
    if (path === '/virtual/alias') return '/physical';
    if (path === '/virtual/final.json') return '../physical/final-target.json';
    throw missing();
  };
  return {
    async: {
      lstat: async path => inspect(path),
      readlink: async path => target(path),
    },
    sync: { lstat: inspect, readlink: target },
  };
}

describe('atomic write destination resolution', () => {
  it.each([
    ['/virtual/alias/new.json', '/physical/new.json'],
    ['/virtual/final.json', '/physical/final-target.json'],
  ])('uses the same canonical identity for %s', async (input, expected) => {
    const io = virtualResolutionIo();
    expect(resolveAtomicWriteDestinationSync(input, io.sync)).toBe(expected);
    await expect(resolveAtomicWriteDestination(input, io.async)).resolves.toBe(expected);
  });

  it('drives custom atomic-write I/O with the canonical parent destination', async () => {
    const resolution = virtualResolutionIo();
    const write = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const io: AtomicWriteIo = {
      ...resolution.async,
      writeFile: write,
      rename,
      unlink: vi.fn(async () => undefined),
    };

    await writeFileAtomic('/virtual/alias/new.json', 'contents', { io });

    expect(write).toHaveBeenCalledWith(
      expect.stringMatching(/^\/physical\/new\.json\.tmp\./),
      'contents',
      undefined,
    );
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/^\/physical\/new\.json\.tmp\./),
      '/physical/new.json',
    );
  });

  it.each(['sync', 'async'] as const)('enforces the symlink limit in the %s adapter', async mode => {
    const sync: SyncAtomicWriteResolutionIo = {
      lstat: () => link,
      readlink: path => path,
    };
    const asyncIo: Pick<AtomicWriteIo, 'lstat' | 'readlink'> = {
      lstat: async () => link,
      readlink: async path => path,
    };

    const operation = mode === 'sync'
      ? Promise.resolve().then(() => resolveAtomicWriteDestinationSync('/cycle', sync))
      : resolveAtomicWriteDestination('/cycle', asyncIo);
    await expect(operation).rejects.toMatchObject({ code: 'ELOOP' });
  });
});
