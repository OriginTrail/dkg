import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableDirectory } from '@origintrail-official/dkg-storage';
import { createManagedOxigraphPersistenceBarrierV1 } from '../src/daemon/oxigraph-persistence.js';

const synced = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle);
    if (args[1] === 'r+') handle.sync = async () => {
      await sync(); synced.push(await fs.realpath(String(args[0])));
    };
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { synced.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it.each([false, true].flatMap(decoy => [false, true].map(relativePath => [decoy, relativePath] as const)))(
  'syncs the enumerated database through symlink/.. with decoy=%s, relative=%s', async (decoy, relativePath) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-wal-traversal-'))); roots.push(root);
    await mkdir(join(root, 'physical', 'deep'), { recursive: true });
    await mkdir(join(root, 'physical', 'db'));
    await symlink(join(root, 'physical', 'deep'), join(root, 'link'), 'junction');
    const directory = `${relativePath ? relative(process.cwd(), root) : root}/link/../db`;
    const actual = join(await realpath(directory), '000007.log'), unrelated = join(root, 'db', '000007.log');
    await writeFile(actual, 'acknowledged WAL');
    if (decoy) { await mkdir(join(root, 'db')); await writeFile(unrelated, 'unrelated WAL'); }
    await createManagedOxigraphPersistenceBarrierV1(new DurableDirectory(directory), '0.5.8')!();
    expect(synced).toEqual([actual]);
    if (actual !== unrelated) {
      expect(synced).not.toContain(unrelated);
      if (decoy) expect(await readFile(unrelated, 'utf8')).toBe('unrelated WAL');
      else await expect(readFile(unrelated)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
);
