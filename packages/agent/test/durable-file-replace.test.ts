// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { type ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-evidence.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

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

const input: ConfirmedNamedKaVmLifecycleInput = { contextGraphId: 'durable-journal', name: 'exact-name', agentAddress: '0x' + '12'.repeat(20),
  packedKaId: (BigInt('0x' + '12'.repeat(20)) << 96n) | 1n,
  publishedUal: 'did:dkg:31337/0x' + '12'.repeat(20) + '/1', merkleRoot: 'ab'.repeat(32), assertionVersion: '1',
  publicationDeployment: { chainId: '31337', lifecycleAddress: '0x' + '56'.repeat(20) } };
it('journal admission propagates directory EPERM before applying confirmed state, then retries exact evidence', async () => {
  const parent = await directory(), apply = vi.fn(async () => {});
  const owner = new NamedKaVmLifecycleRepair({ dataDir: parent, writeLocks: new Map(), isCurrent: async () => true, apply, warn: () => {} });
  try {
    failure.directory = parent; failure.phase = 'sync';
    await expect(owner.submit(input)).rejects.toMatchObject({ code: 'EPERM' });
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(join(parent, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    failure.phase = '';
    expect(await owner.submit(input)).toBe('repaired');
    expect(apply).toHaveBeenCalledExactlyOnceWith(input, false);
    expect(JSON.parse(await readFile(join(parent, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries).toEqual([]);
  } finally { failure.phase = ''; await owner.stop(); }
});
function ancestry(path: string): string[] { return dirname(path) === path ? [path] : [path, ...ancestry(dirname(path))]; }
describe('newly created directory ancestry', () => {
  async function nested() {
    const root = await directory(), created = join(root, 'new'), dataDir = join(created, 'nested');
    const syncedAtApply: string[][] = [], apply = vi.fn(async () => { syncedAtApply.push([...synced]); });
    const owner = new NamedKaVmLifecycleRepair({ dataDir, writeLocks: new Map(), isCurrent: async () => true, apply, warn: () => {} });
    return { root, created, dataDir, syncedAtApply, apply, owner };
  }
  it('journal admission into an absent nested dataDir syncs every created directory before apply runs', async () => {
    const { dataDir, syncedAtApply, owner } = await nested();
    try {
      expect(await owner.submit(input)).toBe('repaired');
      // mkdir created new/ and new/nested/: their entries live in new/ and in the existing root.
      expect(syncedAtApply).toEqual([[...ancestry(join(dataDir, 'named-ka-vm-lifecycle-snapshots')), ...ancestry(dataDir)]]);
      expect(synced).toEqual([...ancestry(join(dataDir, 'named-ka-vm-lifecycle-snapshots')), ...ancestry(dataDir), dataDir]); // Retirement needs only the journal directory.
    } finally { await owner.stop(); }
  });
  it('keeps the created journal ancestry pending after a failed admission barrier, although mkdir reports nothing on retry', async () => {
    const { created, dataDir, syncedAtApply, apply, owner } = await nested();
    try {
      failure.directory = created; failure.phase = 'sync'; failure.code = 'EIO';
      await expect(owner.submit(input)).rejects.toMatchObject({ code: 'EIO' });
      expect(apply).not.toHaveBeenCalled();
      failure.phase = ''; synced.splice(0);
      expect(await owner.submit(input)).toBe('repaired');
      expect(syncedAtApply).toEqual([[...ancestry(join(dataDir, 'named-ka-vm-lifecycle-snapshots')), ...ancestry(dataDir)]]);
    } finally { failure.phase = ''; await owner.stop(); }
  });
});

it.each([false, true])('snapshot admission retries pending ancestors for a different snapshot=%s', async different => {
  const root = await directory(), created = join(root, 'new'), dataDir = join(created, 'data');
  const snapshots = join(dataDir, 'named-ka-vm-lifecycle-snapshots');
  const apply = vi.fn(async () => { expect(synced).toEqual(expect.arrayContaining([snapshots, dataDir, created, root])); });
  const owner = new NamedKaVmLifecycleRepair({ dataDir, writeLocks: new Map(), isCurrent: async () => true, apply, warn: () => {} });
  try {
    failure.directory = created; failure.phase = 'sync';
    await expect(owner.submit(confirmedMaterializationFixture().input)).rejects.toMatchObject({ code: 'EPERM' });
    expect(apply).not.toHaveBeenCalled();
    synced.splice(0); failure.phase = '';
    expect(await owner.submit(confirmedMaterializationFixture(different).input)).toBe('repaired');
    expect(apply).toHaveBeenCalledOnce();
  } finally { failure.phase = ''; await owner.stop(); }
});

it('snapshot-less admission completes retained snapshot ancestry before apply and persists its pending obligation', async () => {
  const root = await directory(), created = join(root, 'new'), dataDir = join(created, 'data');
  const snapshots = join(dataDir, 'named-ka-vm-lifecycle-snapshots');
  const path = join(dataDir, 'named-ka-vm-lifecycle-repairs.json');
  const apply = vi.fn(async () => {
    expect(synced).toEqual(expect.arrayContaining([snapshots, dataDir, created, root]));
    throw new Error('store still unavailable');
  });
  const options = { dataDir, writeLocks: new Map<string, Promise<void>>(), isCurrent: async () => true, warn: () => {} };
  const owner = new NamedKaVmLifecycleRepair({ ...options, now: () => 0, apply });
  try {
    failure.directory = created; failure.phase = 'sync'; failure.code = 'EIO';
    await expect(owner.submit(confirmedMaterializationFixture().input)).rejects.toMatchObject({ code: 'EIO' });
    expect(apply).not.toHaveBeenCalled();
    // A different repair has no snapshot, but shares the still-uncertified ancestry.
    await expect(owner.submit(input)).rejects.toMatchObject({ code: 'EIO' });
    expect(apply).not.toHaveBeenCalled();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    failure.phase = ''; synced.splice(0);
    expect(await owner.submit(input)).toBe('pending');
    expect(apply).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path, 'utf8')).entries).toHaveLength(1);
    await owner.stop();
    const recovered = vi.fn(async () => {});
    const reopened = new NamedKaVmLifecycleRepair({ ...options, now: () => 10_000, apply: recovered });
    try {
      await reopened.runDue();
      expect(recovered).toHaveBeenCalledExactlyOnceWith(input, false);
      expect(JSON.parse(await readFile(path, 'utf8')).entries).toEqual([]);
    } finally { await reopened.stop(); }
  } finally { failure.phase = ''; await owner.stop(); }
});
