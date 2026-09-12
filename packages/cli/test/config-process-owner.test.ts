import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownProcess, type OwnedProcess } from '../../../scripts/testing/owned-process.mjs';
import { writeConfigFile } from '../src/config-file.js';
import { DkgHomeFiles } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';

const fileModule = new URL('../src/config-file.ts', import.meta.url).href;
let directory: string;
let files: DkgHomeFiles;
const children: OwnedProcess[] = [];
const stores: DkgConfigStore[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dkg-config-process-'));
  files = new DkgHomeFiles(directory);
  await writeFile(files.configPath, JSON.stringify({ name: 'before', apiPort: 0, listenPort: 0, nodeRole: 'edge' }));
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => child.stop()));
  await Promise.all(stores.splice(0).map(store => store.close()));
  await rm(directory, { recursive: true, force: true });
});

function startWriter(body: string) {
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', '--input-type=module', '-e', `
    const { configFileStore, writeConfigSettingsTransaction } = await import(process.argv[1]);
    const path = process.argv[2];
    const released = new Promise(resolve => process.stdin.once('data', resolve));
    ${body}
  `, fileModule, files.configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const owner = ownProcess(child, { label: 'Configuration process fixture' });
  children.push(owner);
  return owner;
}

it.each([
  ['same path', false], ['file symlink', false], ['directory symlink', false],
  ['same path', true], ['file symlink', true], ['directory symlink', true],
] as const)('fences %s writers and releases ownership after abrupt exit=%s', async (alias, abrupt) => {
  let destination = files.configPath;
  if (alias === 'file symlink') {
    destination = join(directory, 'alias.json');
    await symlink('config.json', destination);
  } else if (alias === 'directory symlink') {
    await mkdir(join(directory, 'alias-parent'));
    await symlink(directory, join(directory, 'alias-parent', 'home'), 'dir');
    destination = join(directory, 'alias-parent', 'home', 'config.json');
  }
  const owner = startWriter(`
    const writer = configFileStore(path).claim();
    await writer.ready;
    console.log('OWNED');
    await released;
    await writer.close();
  `);
  await owner.ready(({ stdout }) => stdout().includes('OWNED') ? true : undefined);
  const before = await readFile(files.configPath, 'utf8');
  await expect(writeConfigFile(destination, 'must not publish')).rejects.toThrow('owned by another process');
  expect(await readFile(files.configPath, 'utf8')).toBe(before);
  if (abrupt) {
    owner.child.kill('SIGKILL');
    await owner.stop();
  } else {
    owner.child.stdin!.end('release');
    await owner.waitForExit(10_000);
  }
  await writeConfigFile(destination, 'after release');
  expect(await readFile(files.configPath, 'utf8')).toBe('after release');
});

it('loads startup configuration only after an external publication retires', async () => {
  const owner = startWriter(`
    await writeConfigSettingsTransaction(path, JSON.stringify({ name: 'external commit', apiPort: 0, listenPort: 0, nodeRole: 'edge' }), {
      async apply() { console.log('PUBLISHED'); await released; }, rollback() {},
    });
  `);
  await owner.ready(({ stdout }) => stdout().includes('PUBLISHED') ? true : undefined);
  const load = vi.fn(() => files.loadConfig());
  await expect(DkgConfigStore.open(files, load)).rejects.toThrow('owned by another process');
  expect(load).not.toHaveBeenCalled();
  owner.child.stdin!.end('release');
  await owner.waitForExit(10_000);
  const store = await DkgConfigStore.open(files, load);
  stores.push(store);
  expect(load).toHaveBeenCalledOnce();
  expect(store.current.name).toBe('external commit');
  await store.update(current => ({ ...current, sharedMemoryTtlMs: 1234 }), 'configuration-only');
  expect(JSON.parse(await readFile(files.configPath, 'utf8'))).toMatchObject({ name: 'external commit', sharedMemoryTtlMs: 1234 });
});

it('releases a failed startup claim and makes stale handle closure idempotent', async () => {
  const invalid = { name: 'invalid', apiPort: 0, listenPort: 0, nodeRole: 'edge' as const };
  Object.defineProperty(invalid, 'name', { get() { throw new Error('invalid initial snapshot'); } });
  expect(() => DkgConfigStore.open(files, invalid)).toThrow('invalid initial snapshot');
  await expect(DkgConfigStore.open(files, async () => { throw new Error('invalid boot config'); })).rejects.toThrow('invalid boot config');
  const first = await DkgConfigStore.open(files, () => files.loadConfig());
  await first.close();
  const second = await DkgConfigStore.open(files, () => files.loadConfig());
  stores.push(second);
  await first.close();
  expect(await DkgConfigStore.open(files, () => files.loadConfig())).toBe(second);
  await expect(first.update(current => current, 'configuration-only')).rejects.toThrow('owner is closed');
  await expect(files.saveConfig(await files.loadConfig())).rejects.toThrow('explicit activation');
  await second.close();
  await files.saveConfig({ ...await files.loadConfig(), name: 'standalone again' });
});
