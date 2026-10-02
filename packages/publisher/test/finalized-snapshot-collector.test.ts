import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinalizedSnapshotCollector } from '../src/finalized-snapshot-collector.js';
import { snapshotLifecycleGate } from '../src/workspace-snapshot-lifecycle.js';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';
import { makeQuads } from './_helpers/workspace-snapshot-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), realpath: vi.fn(actual.realpath) };
});
const directories: string[] = [];
const stores: FileWorkspacePublicSnapshotStore[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.stopGarbageCollection();
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-retirement-queue-'));
  directories.push(directory);
  return directory;
}

describe('retirement marker mutation ordering', () => {
  it.each(['retire', 'reuse'] as const)('a later %s through another directory alias wins over a paused older rename', async mode => {
    const directory = await fixture();
    const alias = join(await fixture(), 'alias');
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    let now = 10_000;
    const open = (path: string) => {
      const store = new FileWorkspacePublicSnapshotStore(path, undefined, {
        gc: { finalizedCleanupEnabled: true }, now: () => now,
        getAvailableBytes: async () => 100 * 1024 ** 3,
      });
      stores.push(store); store.stopGarbageCollection(); return store;
    };
    const first = open(directory); const second = open(alias);
    const quads = makeQuads(1, 'ordering'); const digest = workspacePublicQuadsDigest(quads);
    await first.putSnapshot({ digest, quads });
    // Resolve both physical identities before starting the ordering experiment.
    (await second.lifecycle.acquire(digest))();
    const entered = deferred(); const resume = deferred();
    const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      entered.resolve(); await resume.promise; return realRename(from, to);
    });
    const older = first.lifecycle.markPublished([digest]);
    await entered.promise;
    now = 20_000;
    let laterFinished = false;
    const later = (mode === 'retire'
      ? second.lifecycle.markPublished([digest])
      : second.putSnapshot({ digest, quads })).then(() => { laterFinished = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(laterFinished).toBe(false);
    } finally { resume.resolve(); }
    await Promise.all([older, later]);
    const hash = digest.slice(7); const marker = join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.retired`);
    if (mode === 'retire') expect(JSON.parse(await readFile(marker, 'utf8')).retiredAt).toBe(20_000);
    else await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enqueues all digests in one request before a later reuse can cancel one', async () => {
    const directory = await fixture(); const gate = snapshotLifecycleGate(directory);
    const collector = new FinalizedSnapshotCollector(directory, gate, () => 100, {
      enabled: true, retentionMs: 0, removePayloads: async () => {}, removeDerivedState: async () => {},
    });
    const firstHash = 'a'.repeat(64); const secondHash = 'b'.repeat(64);
    const entered = deferred(); const resume = deferred();
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${firstHash}.retired`)) { entered.resolve(); await resume.promise; }
      return real(from, to);
    });
    const marking = collector.markPublishedSnapshots([firstHash, secondHash]);
    await entered.promise;
    try {
      // An unrelated digest must still progress while the first rename is held.
      await collector.cancel(secondHash);
      expect(await gate.tryCollect(firstHash, async () => true)).toBeUndefined();
    } finally { resume.resolve(); }
    await marking;
    await expect(stat(collector.path(secondHash))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves request order while a new alias is still resolving its physical identity', async () => {
    const directory = await fixture(); const alias = join(await fixture(), 'alias');
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const gate = snapshotLifecycleGate(directory);
    const hash = 'a'.repeat(64);
    (await gate.acquire(hash))();
    const options = { enabled: true, retentionMs: 0, removePayloads: async () => {}, removeDerivedState: async () => {} };
    const warm = new FinalizedSnapshotCollector(directory, gate, () => 100, options);
    const cold = new FinalizedSnapshotCollector(alias, snapshotLifecycleGate(alias), () => 100, options);
    const entered = deferred(); const resume = deferred();
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath;
    vi.mocked(realpath).mockImplementationOnce(async path => {
      entered.resolve(); await resume.promise; return real(path);
    });
    const older = cold.markPublishedSnapshots([hash]);
    await entered.promise;
    let canceled = false;
    const later = warm.cancel(hash).then(() => { canceled = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(canceled).toBe(false);
    } finally { resume.resolve(); }
    await Promise.all([older, later]);
    await expect(stat(warm.path(hash))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not poison later mutations after a failed rename', async () => {
    const directory = await fixture(); const gate = snapshotLifecycleGate(directory);
    const collector = new FinalizedSnapshotCollector(directory, gate, () => 100, {
      enabled: true, retentionMs: 0, removePayloads: async () => {}, removeDerivedState: async () => {},
    });
    const hash = 'a'.repeat(64);
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    await expect(collector.markPublishedSnapshots([hash])).rejects.toThrow('disk temporarily unavailable');
    await collector.markPublishedSnapshots([hash]);
    await collector.cancel(hash);
    await expect(stat(collector.path(hash))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await gate.tryCollect(hash, async () => true)).toBe(true);
  });
});

describe('bounded retirement collection', () => {
  async function scheduled(check: (ref: string) => Promise<boolean>, count = 33) {
    const directory = await fixture(); const gate = snapshotLifecycleGate(directory);
    const removed = vi.fn(async (_hash: string, done: (bytes: number) => void) => { done(1); });
    const collector = new FinalizedSnapshotCollector(directory, gate, () => 10_000, {
      enabled: true, retentionMs: 0, isSnapshotReferenced: check,
      removePayloads: removed, removeDerivedState: async () => {},
    });
    const hashes = Array.from({ length: count }, (_, i) => i.toString(16).padStart(64, '0'));
    const files = await Promise.all(hashes.map(async hash => {
      const path = collector.path(hash);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ version: 1, retiredAt: 0 }));
      return { name: basename(path), path, hash };
    }));
    return { gate, collector, files, hashes, removed };
  }

  it.each(['referenced', 'failed', 'busy'] as const)('caps at 32 and rotates past %s candidates', async mode => {
    const check = vi.fn(async (ref: string) => {
      if (ref.endsWith('20')) return false; // 33rd candidate
      if (mode === 'failed') throw new Error('RPC/store failure');
      return true;
    });
    const f = await scheduled(check);
    const releases = mode === 'busy' ? await Promise.all(f.hashes.slice(0, 32).map(hash => f.gate.acquire(hash))) : [];
    const attempts = vi.spyOn(f.gate, 'tryCollect');
    try {
      expect((await f.collector.collect(f.files)).deleted).toBe(0);
      expect(attempts).toHaveBeenCalledTimes(32);
      expect(check.mock.calls.length).toBe(mode === 'busy' ? 0 : 32);
      attempts.mockClear(); check.mockClear();
      expect((await f.collector.collect(f.files)).deleted).toBe(1);
      expect(attempts).toHaveBeenCalledTimes(32);
      expect(attempts.mock.calls[0][0]).toBe(f.hashes[32]);
      expect(f.removed).toHaveBeenCalledExactlyOnceWith(f.hashes[32], expect.any(Function));
    } finally { releases.forEach(release => release()); }
  });

  it('stops at the time budget and resumes from the next candidate', async () => {
    let wall = 0;
    const check = vi.fn(async (_ref: string) => { wall += 3_000; return true; });
    const f = await scheduled(check, 5);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    await f.collector.collect(f.files);
    expect(check.mock.calls.map(([ref]) => ref)).toEqual(f.hashes.slice(0, 2).map(hash => `sha256:${hash}`));
    check.mockClear();
    await f.collector.collect(f.files);
    expect(check.mock.calls.map(([ref]) => ref)).toEqual(f.hashes.slice(2, 4).map(hash => `sha256:${hash}`));
  });
});
