import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableDirectory } from '../src/file-durability.js';

const fault = vi.hoisted(() => ({ parent: '', calls: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), sync = file.sync.bind(file);
    if (args[1] === 'r') file.sync = async () => {
      const path = await fs.realpath(String(args[0])); fault.calls.push(path);
      if (path === fault.parent) throw Object.assign(new Error('alias parent fsync failed'), { code: 'EIO' });
      await sync();
    };
    return file;
  } };
});
const roots: string[] = [];
afterEach(async () => { fault.parent = ''; fault.calls = []; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// test-disable-allow: D1 #2962 -- owner=Jurij89 lane=storage-unit-linux expires=2026-11-14 POSIX directory barriers run in required Linux storage tests; Node has no Windows directory-fsync contract.
it.skipIf(process.platform === 'win32').each([[false, false], [true, false], [false, true], [true, true]])('certifies visible and link-target alias parents, relative=%s, dotdot=%s', async (relativePath, dotdot) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-directory-alias-'))); roots.push(root);
  const client = join(root, 'client'), bridge = join(root, 'bridge'), target = join(root, 'volume', 'data');
  await Promise.all([mkdir(client), mkdir(bridge), mkdir(target, { recursive: true })]);
  await symlink(target, join(bridge, 'hop'), 'dir');
  await symlink('../bridge/hop', join(client, 'alias'), 'dir');
  const configured = dotdot ? `${client}/alias/../data/nested` : join(client, 'alias', 'nested');
  const path = relativePath ? `${relative(process.cwd(), client)}/${dotdot ? 'alias/../data/nested' : 'alias/nested'}` : configured;
  const directory = new DurableDirectory(path);
  await directory.create(); fault.parent = bridge;
  await expect(directory.persist()).rejects.toMatchObject({ code: 'EIO' });
  expect(fault.calls).toContain(bridge);
  fault.parent = ''; fault.calls = []; await directory.persist();
  for (const parent of [client, bridge, target, dirname(target)]) expect(fault.calls).toContain(parent);
  // The successful owner cannot stand in for a fresh owner adopting unsynced aliases.
  const fresh = new DurableDirectory(path); await fresh.create(); fault.parent = client;
  await expect(fresh.persist()).rejects.toMatchObject({ code: 'EIO' });
  fault.parent = ''; fault.calls = []; await fresh.persist();
  expect(fault.calls).toContain(client); expect(fault.calls).toContain(bridge);
});
