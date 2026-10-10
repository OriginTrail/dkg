// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replaceDurableFile } from '../src/durable-file-replace.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { saveSourceWorkerState } from '../src/source-worker.js';

const failure = vi.hoisted(() => ({ directory: '', phase: '' as 'sync' | 'close' | 'file' | '', code: 'EPERM' }));
const synced = vi.hoisted(() => [] as string[]); // Directories whose sync succeeded, in order.
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), path = String(args[0]);
    const error = () => Object.assign(new Error(`injected ${failure.phase} ${failure.code}`), { code: failure.code });
    if (args[1] === 'r') { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); synced.push(path); }; }
    if (path === failure.directory && args[1] === 'r') {
      if (failure.phase === 'sync') handle.sync = async () => { throw error(); };
      if (failure.phase === 'close') { const close = handle.close.bind(handle); handle.close = async () => { await close(); throw error(); }; }
    }
    if (failure.phase === 'file' && path.endsWith('.tmp')) handle.sync = async () => { throw error(); };
    return handle;
  } };
});
const directories: string[] = [];
afterEach(async () => { failure.directory = ''; failure.phase = ''; failure.code = 'EPERM'; synced.splice(0); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dkg-durable-replace-')); directories.push(path); return path; }

describe('shared durable file replacement', () => {
  it('replaces complete private bytes with explicit file/directory modes and no temporary residue', async () => {
    const parent = join(await directory(), 'private'), path = join(parent, 'journal.json');
    await replaceDurableFile(path, '{"old":true}', { fileMode: 0o600, directoryMode: 0o700 });
    await replaceDurableFile(path, '{"new":true}', { fileMode: 0o600, directoryMode: 0o700 });
    expect(await readFile(path, 'utf8')).toBe('{"new":true}');
    expect(await readdir(parent)).toEqual(['journal.json']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
      expect((await stat(parent)).mode & 0o777).toBe(0o700 & ~process.umask());
    }
  });

  it('preserves source-worker serialization and default creation permissions', async () => {
    const parent = join(await directory(), 'source'), path = join(parent, 'state.json'), state = { sources: {} };
    await saveSourceWorkerState(path, state);
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(state, null, 2) + '\n');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o666 & ~process.umask());
      expect((await stat(parent)).mode & 0o777).toBe(0o777 & ~process.umask());
    }
  });

  it('removes its temporary file and preserves the target after a failed rename', async () => {
    const parent = await directory(), target = join(parent, 'state.json');
    await mkdir(target);
    await expect(replaceDurableFile(target, 'cannot replace a directory', { fileMode: 0o600, directoryMode: 0o700 })).rejects.toThrow();
    expect(await readdir(parent)).toEqual(['state.json']);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});

it.each(['sync', 'close'] as const)('strict replacement propagates directory %s EPERM and can be retried', async phase => {
  const parent = await directory(), path = join(parent, 'strict.json');
  failure.directory = parent; failure.phase = phase;
  await expect(replaceDurableFile(path, '{"confirmed":true}', { fileMode: 0o600, directoryMode: 0o700 })).rejects.toMatchObject({ code: 'EPERM' });
  expect(await readdir(parent)).toEqual(['strict.json']); // Rename visibility does not certify durability.
  failure.phase = '';
  await replaceDurableFile(path, '{"confirmed":true}', { fileMode: 0o600, directoryMode: 0o700 });
  expect(await readFile(path, 'utf8')).toBe('{"confirmed":true}');
});
it.each(['sync', 'close'] as const)('source-worker explicitly preserves directory %s compatibility but refuses other I/O errors', async phase => {
  const parent = await directory(), path = join(parent, 'source.json'), state = { sources: {} };
  failure.directory = parent; failure.phase = phase;
  await saveSourceWorkerState(path, state); // Established EPERM tolerance is scoped to this consumer.
  failure.code = 'EIO';
  await expect(saveSourceWorkerState(path, state)).rejects.toMatchObject({ code: 'EIO' });
  failure.phase = '';
  await saveSourceWorkerState(path, state);
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(state, null, 2) + '\n');
});
it('directory compatibility never tolerates a failed file sync or damages the prior target', async () => {
  const parent = await directory(), path = join(parent, 'source.json');
  await saveSourceWorkerState(path, { sources: {} });
  const before = await readFile(path, 'utf8'); failure.phase = 'file';
  await expect(saveSourceWorkerState(path, { sources: { next: { fingerprint: 'different pending bytes', lastStatus: 'queued' } } })).rejects.toMatchObject({ code: 'EPERM' });
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readdir(parent)).toEqual(['source.json']);
});
const input = { contextGraphId: 'durable-journal', name: 'exact-name', agentAddress: '0x' + '12'.repeat(20),
  publishedUal: 'did:dkg:31337/0x' + '34'.repeat(20) + '/1', merkleRoot: 'ab'.repeat(32), assertionVersion: '1' };
it('journal admission propagates directory EPERM before applying confirmed state, then retries exact evidence', async () => {
  const parent = await directory(), apply = vi.fn(async () => {});
  const owner = new NamedKaVmLifecycleRepair({ dataDir: parent, writeLocks: new Map(), isCurrent: async () => true, apply, warn: () => {} });
  try {
    failure.directory = parent; failure.phase = 'sync';
    await expect(owner.submit(input)).rejects.toMatchObject({ code: 'EPERM' });
    expect(apply).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(parent, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries[0][1].input).toEqual(input);
    failure.phase = '';
    expect(await owner.submit(input)).toBe('repaired');
    expect(apply).toHaveBeenCalledExactlyOnceWith(input);
    expect(JSON.parse(await readFile(join(parent, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries).toEqual([]);
  } finally { failure.phase = ''; await owner.stop(); }
});
describe.skipIf(process.platform === 'win32')('newly created directory ancestry', () => {
  async function nested() {
    const root = await directory(), created = join(root, 'new'), dataDir = join(created, 'nested');
    const syncedAtApply: string[][] = [], apply = vi.fn(async () => { syncedAtApply.push([...synced]); });
    const owner = new NamedKaVmLifecycleRepair({ dataDir, writeLocks: new Map(), isCurrent: async () => true, apply, warn: () => {} });
    return { root, created, dataDir, syncedAtApply, apply, owner };
  }
  it('journal admission into an absent nested dataDir syncs every created directory before apply runs', async () => {
    const { root, created, dataDir, syncedAtApply, owner } = await nested();
    try {
      expect(await owner.submit(input)).toBe('repaired');
      // mkdir created new/ and new/nested/: their entries live in new/ and in the existing root.
      expect(syncedAtApply).toEqual([[dataDir, created, root]]);
      expect(synced).toEqual([dataDir, created, root, dataDir]); // Retirement needs only the journal directory.
    } finally { await owner.stop(); }
  });
  it('keeps the created journal ancestry pending after a failed admission barrier, although mkdir reports nothing on retry', async () => {
    const { root, created, dataDir, syncedAtApply, apply, owner } = await nested();
    try {
      failure.directory = created; failure.phase = 'sync'; failure.code = 'EIO';
      await expect(owner.submit(input)).rejects.toMatchObject({ code: 'EIO' });
      expect(apply).not.toHaveBeenCalled();
      failure.phase = ''; synced.splice(0);
      expect(await owner.submit(input)).toBe('repaired');
      expect(syncedAtApply).toEqual([[dataDir, created, root]]);
    } finally { failure.phase = ''; await owner.stop(); }
  });
  it('source-worker state syncs its created ancestry and keeps its directory compatibility across it', async () => {
    const root = await directory(), created = join(root, 'new'), parent = join(created, 'source');
    failure.directory = created; failure.phase = 'sync'; // EPERM: tolerated only for source-worker state.
    await saveSourceWorkerState(join(parent, 'state.json'), { sources: {} });
    expect(synced).toEqual([parent, root]);
  });
});
it('concurrent replacements retain complete contents, independent temporary names and permissions', async () => {
  const parent = await directory(), path = join(parent, 'concurrent.json');
  const contents = Array.from({ length: 16 }, (_, i) => JSON.stringify({ i, value: String(i).repeat(8192) }));
  await Promise.all(contents.map(value => replaceDurableFile(path, value, { fileMode: 0o600, directoryMode: 0o700 })));
  expect(contents).toContain(await readFile(path, 'utf8'));
  expect(await readdir(parent)).toEqual(['concurrent.json']);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
});
