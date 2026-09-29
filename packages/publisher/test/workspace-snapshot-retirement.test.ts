import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest } from '../src/workspace-snapshot-store.js';
import { snapshotReferenceCheck, withSnapshotScope } from '../src/workspace-snapshot-lifecycle.js';
import { makeQuads, snapshotPath } from './_helpers/workspace-snapshot-store.js';

const directories: string[] = [];
const stores: FileWorkspacePublicSnapshotStore[] = [];
const quads = makeQuads(3, 'retirement');
const digest = workspacePublicQuadsDigest(quads);
const GIB = 1024 ** 3;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(check?: (ref: string) => Promise<boolean>) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-retirement-'));
  directories.push(directory);
  let now = 100_000;
  let free = 100 * GIB;
  const open = () => {
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { finalizedCleanupEnabled: true, finalizedRetentionMs: 1_000, minAgeMs: 0 }, now: () => now,
      getAvailableBytes: async () => free, isSnapshotReferenced: check,
    });
    store.stopGarbageCollection();
    stores.push(store);
    return store;
  };
  const store = open();
  await store.putSnapshot({ digest, quads });
  // Make the payload genuinely eligible for the pressure collector in those tests.
  await utimes(snapshotPath(directory, digest), 0, 0);
  return {
    directory, store, open, path: snapshotPath(directory, digest),
    marker: snapshotPath(directory, digest).replace(/\.nq$/, '.retired'),
    advance: () => { now += 1_001; }, pressure: () => { free = 1 * GIB; },
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.stopGarbageCollection();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('confirmed snapshot retirement', () => {
  it('survives a store restart and reclaims unreferenced files after grace without pressure', async () => {
    const check = vi.fn(async () => false);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    expect((await f.store.collectGarbage()).deletedSnapshots).toBe(0);
    expect(check).not.toHaveBeenCalled();
    f.advance();
    const restarted = f.open();
    const result = await restarted.collectGarbage();
    expect(result).toMatchObject({ triggered: false, finalizedSnapshots: 1, deletedSnapshots: 1 });
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(check).toHaveBeenCalledWith(digest);
  });

  it('keeps bytes referenced by another graph or a legacy alias until the last reference is gone', async () => {
    const rdf = new OxigraphStore();
    const f = await fixture(snapshotReferenceCheck(rdf));
    await rdf.insert([{ graph: 'urn:other-context:metadata', subject: 'urn:pending-operation',
      predicate: 'http://dkg.io/ontology/publicSnapshotRef', object: JSON.stringify(digest.slice(7).toUpperCase()) }]);
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    expect((await f.store.collectGarbage()).referencedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
    await rdf.dropGraph('urn:other-context:metadata');
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('fails closed on a reference-check error, including under disk pressure', async () => {
    const f = await fixture(async () => { throw new Error('store unavailable'); });
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    f.pressure();
    expect(await f.store.collectGarbage()).toMatchObject({ triggered: true, failedDeletions: 1, deletedSnapshots: 0 });
    await expect(stat(f.path)).resolves.toBeDefined();
    await expect(stat(f.marker)).resolves.toBeDefined();
  });

  it('does not delete when no reference checker is installed', async () => {
    const f = await fixture();
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    f.pressure();
    expect((await f.store.collectGarbage()).deletedSnapshots).toBe(0);
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('times out a stuck checker, releases the file lease and ignores its late answer', async () => {
    const checked = deferred();
    const answer = deferred();
    const f = await fixture(async () => { checked.resolve(); await answer.promise; return false; });
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    const collecting = f.store.collectGarbage();
    await checked.promise;
    expect(await collecting).toMatchObject({ failedDeletions: 1, deletedSnapshots: 0 });
    await expect(stat(f.path)).resolves.toBeDefined();
    // A writer can proceed even though the old reference query is still pending.
    await f.open().putSnapshot({ digest, quads });
    answer.resolve();
    await Promise.resolve();
    expect(await f.store.getSnapshot(digest)).toEqual(quads);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('protects the metadata-commit gap across two store instances for the same directory', async () => {
    let referenced = false;
    const f = await fixture(async () => referenced);
    const second = f.open();
    const wrote = deferred();
    const commit = deferred();
    const writing = withSnapshotScope(second, async snapshots => {
      await snapshots!.putSnapshot({ digest, quads });
      wrote.resolve();
      await commit.promise;
      referenced = true;
    });
    await wrote.promise;
    // An older publication retires the same digest while the new metadata is pending.
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    expect((await f.store.collectGarbage()).deletedSnapshots).toBe(0);
    await expect(stat(f.path)).resolves.toBeDefined();
    commit.resolve();
    await writing;
    expect((await f.store.collectGarbage()).referencedSnapshots).toBe(1);
  });

  it('excludes a new writer between the final reference check and unlink, then recreates its bytes', async () => {
    const checking = deferred();
    const finishCheck = deferred();
    const f = await fixture(async () => { checking.resolve(); await finishCheck.promise; return false; });
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    const collecting = f.store.collectGarbage();
    await checking.promise;
    const other = f.open();
    const writing = other.putSnapshot({ digest, quads });
    finishCheck.resolve();
    expect((await collecting).finalizedSnapshots).toBe(1);
    await writing;
    expect(await other.getSnapshot(digest)).toEqual(quads);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('protects a leased read but can collect an unrelated file during that read', async () => {
    const f = await fixture(async () => false);
    const otherQuads = makeQuads(1, 'other');
    const otherDigest = workspacePublicQuadsDigest(otherQuads);
    await f.store.putSnapshot({ digest: otherDigest, quads: otherQuads });
    await f.store.lifecycle.markPublished([digest, otherDigest]);
    f.advance();
    const release = await f.open().lifecycle.acquire(digest);
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
    release();
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('also honors another store instance\'s lease during pressure collection', async () => {
    const f = await fixture(async () => false);
    f.pressure();
    const release = await f.open().lifecycle.acquire(digest);
    expect(await f.store.collectGarbage()).toMatchObject({ deletedSnapshots: 0, skippedActiveFiles: 1 });
    await expect(stat(f.path)).resolves.toBeDefined();
    release();
    expect((await f.store.collectGarbage()).deletedSnapshots).toBe(1);
  });

  it('protects stale temporary files through another directory alias and counts skips', async () => {
    const f = await fixture();
    const parent = await mkdtemp(join(tmpdir(), 'dkg-snapshot-temp-alias-'));
    directories.push(parent);
    const alias = join(parent, 'alias');
    await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const other = new FileWorkspacePublicSnapshotStore(alias, undefined, { gc: { enabled: false } });
    stores.push(other);
    const collector = new FileWorkspacePublicSnapshotStore(f.directory, undefined, {
      gc: { staleTempAgeMs: 0 }, getAvailableBytes: async () => 100 * GIB,
    });
    stores.push(collector); collector.stopGarbageCollection();
    const temp = `${f.path}.123.abc.tmp`;
    await writeFile(temp, 'pending write'); await utimes(temp, 0, 0);
    const release = await other.lifecycle.acquire(digest);
    try {
      expect(await collector.collectGarbage()).toMatchObject({ deletedTempFiles: 0, skippedActiveFiles: 1 });
      await expect(stat(temp)).resolves.toBeDefined();
    } finally { release(); }
    expect((await collector.collectGarbage()).deletedTempFiles).toBe(1);
  });

  it('does not bypass a retirement recorded after the pressure collector scanned files', async () => {
    const checking = deferred();
    const finishCheck = deferred();
    const f = await fixture(async () => { checking.resolve(); await finishCheck.promise; return true; });
    const otherQuads = makeQuads(1, 'pressure-marker');
    const otherDigest = workspacePublicQuadsDigest(otherQuads);
    await f.store.putSnapshot({ digest: otherDigest, quads: otherQuads });
    await f.store.lifecycle.markPublished([otherDigest]);
    f.advance();
    f.pressure();
    const collecting = f.store.collectGarbage();
    await checking.promise;
    // This digest was unmarked in the collector's initial inventory.
    await f.open().lifecycle.markPublished([digest]);
    finishCheck.resolve();
    expect((await collecting).deletedSnapshots).toBe(0);
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('cancels retirement when identical bytes are reused', async () => {
    const f = await fixture(async () => false);
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    await f.store.putSnapshot({ digest, quads });
    expect((await f.open().collectGarbage()).deletedSnapshots).toBe(0);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains malformed records and retries a failed check on the next pass', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValue(false);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.advance();
    const record = await readFile(f.marker, 'utf8');
    await writeFile(f.marker, '{broken');
    expect((await f.store.collectGarbage()).failedDeletions).toBe(1);
    expect(check).not.toHaveBeenCalled();
    await writeFile(f.marker, record);
    expect((await f.store.collectGarbage()).failedDeletions).toBe(1);
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('ignores protected lost+found and unrelated trees on a mounted snapshot volume', async () => {
    const f = await fixture(async () => false);
    const lost = join(f.directory, 'lost+found');
    await mkdir(lost);
    await writeFile(join(lost, 'must-stay'), 'filesystem-owned');
    await chmod(lost, 0);
    try {
      await f.store.lifecycle.markPublished([digest]);
      f.advance();
      expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
    } finally { await chmod(lost, 0o700); }
    expect(await readFile(join(lost, 'must-stay'), 'utf8')).toBe('filesystem-owned');
  });

  it('finishes derived-index cleanup on retry after the payload was already removed', async () => {
    const f = await fixture(async () => false);
    const deleteIndex = vi.fn().mockRejectedValueOnce(new Error('SQLite busy')).mockResolvedValue(undefined);
    const store = new FileWorkspacePublicSnapshotStore(f.directory, {
      get: async () => null, upsert: async () => undefined, delete: deleteIndex,
    }, { gc: { finalizedCleanupEnabled: true, finalizedRetentionMs: 0 }, isSnapshotReferenced: async () => false,
      getAvailableBytes: async () => 100 * GIB });
    stores.push(store);
    store.stopGarbageCollection();
    await store.lifecycle.markPublished([digest]);
    expect((await store.collectGarbage()).failedDeletions).toBe(1);
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.marker)).resolves.toBeDefined();
    expect((await store.collectGarbage()).failedDeletions).toBe(0);
    expect(deleteIndex).toHaveBeenLastCalledWith(digest);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors the master opt-out even when finalized cleanup is explicitly enabled', async () => {
    const f = await fixture();
    const check = vi.fn(async () => false);
    const space = vi.fn(async () => 0);
    const store = new FileWorkspacePublicSnapshotStore(f.directory, undefined, {
      gc: { enabled: false, finalizedCleanupEnabled: true, finalizedRetentionMs: 0 },
      isSnapshotReferenced: check, getAvailableBytes: space,
    });
    stores.push(store);
    expect(store.lifecycle.finalizedCleanupEnabled).toBe(false);
    await store.lifecycle.markPublished([digest]);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.collectGarbage()).deletedSnapshots).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(space).not.toHaveBeenCalled();
    await expect(stat(f.path)).resolves.toBeDefined();
  });

  it('shares the gate through symlink/junction and Windows case aliases', async () => {
    const f = await fixture(async () => false);
    const parent = await mkdtemp(join(tmpdir(), 'dkg-snapshot-alias-'));
    directories.push(parent);
    const alias = join(parent, 'alias');
    await symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const other = new FileWorkspacePublicSnapshotStore(
      process.platform === 'win32' ? alias.toUpperCase() : alias, undefined, { gc: { enabled: false } });
    stores.push(other);
    await f.store.lifecycle.markPublished([digest]); f.advance();
    const release = await other.lifecycle.acquire(digest);
    try { expect((await f.store.collectGarbage()).deletedSnapshots).toBe(0); }
    finally { release(); }
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('does not grant an existing-file lease when collection won first', async () => {
    const f = await fixture(async () => false);
    await f.store.lifecycle.markPublished([digest]); f.advance();
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
    await withSnapshotScope(f.store, async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(false);
    });
  });

  it('allows opting out of finalized cleanup without disabling pressure GC', async () => {
    const f = await fixture(async () => false);
    const store = new FileWorkspacePublicSnapshotStore(f.directory, undefined, {
      gc: { finalizedCleanupEnabled: false }, isSnapshotReferenced: async () => false,
    });
    stores.push(store);
    store.stopGarbageCollection();
    await store.lifecycle.markPublished([digest]);
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
