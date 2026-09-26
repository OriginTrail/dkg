import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileUpdateHoldoffStore, UPDATE_HOLDOFF_FILE } from '../src/daemon/auto-update-holdoff-store.js';
import { memoryFs } from './_helpers/holdoff-memory-fs.js';

const RECORD_PATH = `/dkg-home/${UPDATE_HOLDOFF_FILE}`;

describe('createFileUpdateHoldoffStore', () => {
  it('round-trips a record through the real filesystem and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-update-holdoff-'));
    try {
      const store = createFileUpdateHoldoffStore(join(dir, UPDATE_HOLDOFF_FILE));
      expect(await store.read()).toBeNull();
      await store.write({ target: 'abc123', deadlineEpochMs: 1_000 });
      await store.write({ target: 'def456', deadlineEpochMs: 2_000 });
      expect(await store.read()).toEqual({ target: 'def456', deadlineEpochMs: 2_000 });
      expect(await readdir(dir)).toEqual([UPDATE_HOLDOFF_FILE]);
      await store.clear();
      await store.clear();
      expect(await store.read()).toBeNull();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on a malformed record so the gate can log it, and returns null only when absent', async () => {
    const mem = memoryFs();
    const store = createFileUpdateHoldoffStore(RECORD_PATH, mem.fs);
    expect(await store.read()).toBeNull();
    mem.files.set(RECORD_PATH, '{"target":');
    await expect(store.read()).rejects.toThrow();
  });

  it('removes the temp file and surfaces the error when the rename fails', async () => {
    const mem = memoryFs();
    const store = createFileUpdateHoldoffStore(RECORD_PATH, {
      ...mem.fs,
      rename: async () => { throw new Error('EXDEV: cross-device link not permitted'); },
    });
    await expect(store.write({ target: 'c1', deadlineEpochMs: 1 })).rejects.toThrow('EXDEV');
    expect([...mem.files.keys()]).toEqual([]);
  });
});
