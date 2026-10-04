import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistContentAddressedFile } from '../src/durable-content-addressed-file.js';
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
    const directory = join(dir, 'new', 'nested'), firstCreated = await mkdir(directory, { recursive: true });
    const file = join(directory, 'bytes'); await writeFile(file, 'verified bytes');
    await persistContentAddressedFile(file, firstCreated, 'linux');
    expect(observed.paths).toEqual([file, directory, join(dir, 'new'), dir]);
    observed.paths = []; await persistContentAddressedFile(file, undefined, 'linux');
    expect(observed.paths).toEqual([file, directory, join(dir, 'new')]);
  });
  it('uses file FlushFileBuffers while omitting unsupported Windows directory handles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-content-file-windows-')); dirs.push(dir);
    const file = join(dir, 'bytes'); await writeFile(file, 'verified bytes');
    await persistContentAddressedFile(file, undefined, 'win32');
    expect(observed.paths).toEqual([file]);
  });
});
