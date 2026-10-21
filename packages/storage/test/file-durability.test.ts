import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableDirectory } from '../src/file-durability.js';
import { DurableDirectoryPreparation } from '../src/durable-content-addressed-file.js';

const io = vi.hoisted(() => ({ synced: [] as string[], fail: '', code: 'EIO', partialCreate: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === io.partialCreate) {
      io.partialCreate = '';
      await fs.mkdir(dirname(String(args[0])), { recursive: true });
      throw Object.assign(new Error('injected partial mkdir ENOSPC'), { code: 'ENOSPC' });
    }
    return fs.mkdir(...args);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), path = String(args[0]), sync = handle.sync.bind(handle);
    if (args[1] === 'r') handle.sync = async () => {
      if (path === io.fail) throw Object.assign(new Error(`injected directory ${io.code}`), { code: io.code });
      await sync(); io.synced.push(path);
    };
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { io.synced = []; io.fail = ''; io.code = 'EIO'; io.partialCreate = ''; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function absentNested() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-durable-directory-'))); roots.push(root);
  const created = join(root, 'new');
  return { root, created, path: join(created, 'nested') };
}

function ancestry(path: string): string[] {
  const paths = [path];
  while (dirname(path) !== path) { path = dirname(path); paths.push(path); }
  return paths;
}

it('creates with the requested mode and certifies its adopted ancestry once', async () => {
  const { created, path } = await absentNested(), directory = new DurableDirectory(path, { mode: 0o700, platform: 'linux' });
  await directory.create(); await directory.persist();
  // A fresh owner must also certify existing parents that another owner may have left unsynced.
  expect(io.synced).toEqual(ancestry(path));
  io.synced = []; await directory.create(); await directory.persist();
  expect(io.synced).toEqual([path]);
  for (const entry of [created, path]) expect((await stat(entry)).mode & 0o777).toBe(0o700 & ~process.umask());
});

it('keeps a failed range pending, although mkdir reports nothing on retry', async () => {
  const { created, path } = await absentNested(), directory = new DurableDirectory(path, { platform: 'linux' });
  await directory.create(); io.fail = created;
  await expect(directory.persist()).rejects.toMatchObject({ code: 'EIO' });
  io.fail = ''; io.synced = [];
  await directory.create(); await directory.persist();
  expect(io.synced).toEqual(ancestry(path));
});

it.each(['EIO', 'EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'])('propagates POSIX %s at every directory and retains the failed range', async code => {
  const { created, path } = await absentNested();
  const directory = new DurableDirectory(path, { platform: 'linux' });
  await directory.create(); io.fail = created; io.code = code;
  await expect(directory.persist()).rejects.toMatchObject({ code });
  io.fail = ''; io.synced = []; await directory.persist();
  expect(io.synced).toEqual(ancestry(path));
});


it('retains ancestry when recursive creation makes a parent before failing, and certifies only after every parent sync', async () => {
  const { root, created, path } = await absentNested();
  const preparation = new DurableDirectoryPreparation(path, 'linux');
  io.partialCreate = path;
  await expect(preparation.prepare()).rejects.toMatchObject({ code: 'ENOSPC' });
  expect((await stat(created)).isDirectory()).toBe(true);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(io.synced).toEqual([]);
  // Retry creates only nested/, but new/'s entry in root still needs certification.
  io.fail = root;
  await expect(preparation.prepare()).rejects.toMatchObject({ code: 'EIO' });
  expect(io.synced).toEqual([path, created]);
  io.fail = ''; io.synced = [];
  await preparation.prepare();
  expect(io.synced).toEqual(ancestry(path));
  io.synced = []; await preparation.prepare();
  expect(io.synced).toEqual([]);
});

it('reconstructs failed ancestor obligations when a new owner adopts the existing directory', async () => {
  const { root, path } = await absentNested();
  const original = new DurableDirectory(path, { platform: 'linux' });
  await original.create(); io.fail = root;
  await expect(original.persist()).rejects.toMatchObject({ code: 'EIO' });
  const replacement = new DurableDirectory(path, { platform: 'linux' });
  await replacement.create();
  await expect(replacement.persist()).rejects.toMatchObject({ code: 'EIO' });
  io.fail = ''; io.synced = [];
  await replacement.persist();
  expect(io.synced).toContain(root);
  io.synced = []; await replacement.persist();
  expect(io.synced).toEqual([path]);
});
