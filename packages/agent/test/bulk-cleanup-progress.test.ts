import { expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { BulkGraphPartialError } from '../src/sync/requester/bulk-graph-stream.js';
import { fixture } from './helpers/bulk-graph-fixture.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rm: vi.fn(fs.rm) };
});
it('retains every confirmed identity and metric when completed-directory cleanup fails', async () => {
  const f = await fixture(2);
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const failure = Object.assign(new Error('staging directory cleanup failed'), { code: 'EIO' });
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (options?.recursive && !options.force) throw failure;
    return fs.rm(path, options);
  });
  try {
    const error = await f.run().then(() => { throw new Error('cleanup unexpectedly succeeded'); }, error => error);
    expect(error).toBeInstanceOf(BulkGraphPartialError);
    expect(error.cause).toBe(failure);
    expect(error.committedAssetUals).toEqual(f.uals);
    expect(error.metrics).toMatchObject({ committedAssets: 2, receivedAssets: 2, verifiedAssets: 2 });
    expect(error.metrics.commitGroups).toBeGreaterThan(0);
    expect(await f.target.countQuads()).toBeGreaterThan(0);
  } finally { vi.mocked(rm).mockImplementation(fs.rm); }
});
