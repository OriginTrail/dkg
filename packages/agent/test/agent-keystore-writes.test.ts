/**
 * Keystore writes take one lock per keystore file: writes to one file run one
 * at a time, so no entry is lost to an overlapping read-modify-write; writes
 * to another file do not wait for them; and a failed write does not hold up
 * the next one. The file system is replaced so that a read can be held open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeKeystoreEntry } from '../src/agent-keystore.js';

const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  heldReads: new Map<string, Promise<void>>(),
  failingWrites: new Set<string>(),
  reads: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (path: string) => {
      disk.reads.push(path);
      await disk.heldReads.get(path);
      const data = disk.files.get(path);
      if (data === undefined) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });
      return data;
    },
    writeFile: async (path: string, data: string) => {
      if (disk.failingWrites.delete(path)) throw new Error('write failed');
      disk.files.set(path, data);
    },
    mkdir: async () => undefined,
    chmod: async () => undefined,
  };
});

/** Hold every read of `path` until the returned function is called. */
function holdReads(path: string): () => void {
  let release!: () => void;
  disk.heldReads.set(path, new Promise<void>((resolve) => { release = resolve; }));
  return () => {
    disk.heldReads.delete(path);
    release();
  };
}

const entriesOf = (path: string) => JSON.parse(disk.files.get(path) ?? '{}') as Record<string, { authToken: string }>;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  disk.files.clear();
  disk.heldReads.clear();
  disk.failingWrites.clear();
  disk.reads.length = 0;
});

describe('keystore writes', () => {
  it('writes one file one entry at a time, without waiting on other files', async () => {
    const release = holdReads('/keystores/a.json');
    const first = writeKeystoreEntry('/keystores/a.json', '0xA1', { authToken: 'a1' });
    const second = writeKeystoreEntry('/keystores/a.json', '0xA2', { authToken: 'a2' });

    // Another file is written while the first one is held.
    await writeKeystoreEntry('/keystores/b.json', '0xB1', { authToken: 'b1' });
    expect(entriesOf('/keystores/b.json')).toEqual({ '0xb1': { authToken: 'b1' } });

    // The second write to the held file has not even read it yet.
    await settle();
    expect(disk.reads.filter((path) => path === '/keystores/a.json')).toHaveLength(1);

    release();
    await Promise.all([first, second]);
    expect(entriesOf('/keystores/a.json')).toEqual({
      '0xa1': { authToken: 'a1' },
      '0xa2': { authToken: 'a2' },
    });
  });

  it('lets the next write to a file run after one fails', async () => {
    disk.failingWrites.add('/keystores/a.json');
    const failed = writeKeystoreEntry('/keystores/a.json', '0xA1', { authToken: 'a1' });
    const next = writeKeystoreEntry('/keystores/a.json', '0xA2', { authToken: 'a2' });
    await expect(failed).rejects.toThrow('write failed');
    await next;
    expect(entriesOf('/keystores/a.json')).toEqual({ '0xa2': { authToken: 'a2' } });
  });
});
