import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableDirectoryPreparation, persistContentAddressedFile } from '../src/durable-content-addressed-file.js';
const observed = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    observed.paths.push(String(args[0])); return actual.open(...args);
  } };
});
const dirs: string[] = [];
afterEach(async () => { observed.paths = []; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('content addressed file persistence', () => {
  it('syncs a newly-created recursive directory chain through its first existing parent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-content-file-')); dirs.push(dir);
    const directory = join(dir, 'new', 'nested');
    const preparation = new DurableDirectoryPreparation(directory, 'linux');
    await Promise.all([preparation.prepare(), preparation.prepare()]);
    expect(observed.paths).toEqual([directory, join(dir, 'new'), dir]);
    const file = join(directory, 'bytes'); await writeFile(file, 'verified bytes');
    observed.paths = []; await persistContentAddressedFile(file, 'linux');
    expect(observed.paths).toEqual([file, directory]);
    observed.paths = []; await preparation.prepare();
    expect(observed.paths).toEqual([]);
    await new DurableDirectoryPreparation(directory, 'linux').prepare();
    expect(observed.paths).toEqual([directory]);
  });
  it('uses file FlushFileBuffers while omitting unsupported Windows directory handles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-content-file-windows-')); dirs.push(dir);
    const directory = join(dir, 'new');
    await new DurableDirectoryPreparation(directory, 'win32').prepare();
    expect(observed.paths).toEqual([]);
    const file = join(directory, 'bytes'); await writeFile(file, 'verified bytes');
    await persistContentAddressedFile(file, 'win32');
    expect(observed.paths).toEqual([file]);
  });
});
