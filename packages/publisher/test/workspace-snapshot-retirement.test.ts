import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  FileWorkspacePublicSnapshotStore, workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore,
} from '../src/workspace-snapshot-store.js';
import {
  snapshotHash, snapshotLifecycleGate, snapshotReferenceCheck, withSnapshotScope, type WorkspaceSnapshotLifecycle,
} from '../src/workspace-snapshot-lifecycle.js';
import { PublishedSnapshotRetirement } from '../src/published-snapshot-retirement.js';
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

async function fixture(check?: (ref: string) => Promise<boolean>, gc: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-retirement-'));
  directories.push(directory);
  let now = 100_000;
  let free = 100 * GIB;
  const open = () => {
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { finalizedCleanupEnabled: true, finalizedRetentionMs: 1_000, minAgeMs: 0, ...gc }, now: () => now,
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
    setFree: (bytes: number) => { free = bytes; },
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
    const release = await f.open().lifecycle.operationLease!(digest);
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
    await expect(stat(f.path)).resolves.toBeDefined();
    release();
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('also honors another store instance\'s lease during pressure collection', async () => {
    const f = await fixture(async () => false);
    f.pressure();
    const release = await f.open().lifecycle.operationLease!(digest);
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
    const collector = new FileWorkspacePublicSnapshotStore(f.directory, undefined, {
      gc: { staleTempAgeMs: 0 }, getAvailableBytes: async () => 100 * GIB,
    });
    stores.push(collector); collector.stopGarbageCollection();
    const temp = `${f.path}.123.abc.tmp`;
    await writeFile(temp, 'pending write'); await utimes(temp, 0, 0);
    const release = await snapshotLifecycleGate(alias).acquire(snapshotHash(digest));
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
    await f.store.lifecycle.markPublished([digest]); f.advance();
    // A lease taken through the alias path is the one the collector must honor.
    const release = await snapshotLifecycleGate(process.platform === 'win32' ? alias.toUpperCase() : alias)
      .acquire(snapshotHash(digest));
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

describe('capacity pressure and retirement candidates', () => {
  const SOFT = 10 * GIB; // below the 15 GiB trigger, above the 5 GiB hard reserve

  it('reclaims an unreferenced candidate under hard pressure without waiting for its grace period', async () => {
    const check = vi.fn(async () => false);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.pressure();
    expect(await f.store.collectGarbage()).toMatchObject({ triggered: true, finalizedSnapshots: 1, deletedSnapshots: 1 });
    expect(check).toHaveBeenCalledWith(digest);
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a write that would breach the hard reserve as hard pressure', async () => {
    const check = vi.fn(async () => false);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.setFree(6 * GIB);
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(0);
    await expect(stat(f.path)).resolves.toBeDefined();
    expect(await f.store.collectGarbage({ requiredWriteBytes: 2 * GIB })).toMatchObject({ finalizedSnapshots: 1 });
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a referenced candidate and its record under hard pressure', async () => {
    const check = vi.fn(async () => true);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.pressure();
    expect(await f.store.collectGarbage()).toMatchObject({ referencedSnapshots: 1, deletedSnapshots: 0 });
    await expect(stat(f.path)).resolves.toBeDefined();
    await expect(stat(f.marker)).resolves.toBeDefined();
  });

  it.each([
    ['a failing checker', async () => { throw new Error('store unavailable'); }],
    ['no checker', undefined],
  ] as const)('fails closed with %s even under hard pressure and inside the grace period', async (_label, check) => {
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.pressure();
    expect((await f.store.collectGarbage()).deletedSnapshots).toBe(0);
    await expect(stat(f.path)).resolves.toBeDefined();
    await expect(stat(f.marker)).resolves.toBeDefined();
  });

  it('keeps the grace period under soft pressure and does not age-evict a marked file', async () => {
    const check = vi.fn(async () => false);
    const f = await fixture(check);
    await f.store.lifecycle.markPublished([digest]);
    f.setFree(SOFT);
    expect(await f.store.collectGarbage()).toMatchObject({ triggered: true, deletedSnapshots: 0 });
    expect(check).not.toHaveBeenCalled();
    await expect(stat(f.path)).resolves.toBeDefined();
    f.advance();
    expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
  });

  it('stops retiring candidates once the reclaim target is met', async () => {
    const check = vi.fn(async () => false);
    const f = await fixture(check, { hardReserveBytes: 10, triggerFreeBytes: 20, targetFreeBytes: 20 });
    const otherQuads = makeQuads(3, 'second-candidate');
    const otherDigest = workspacePublicQuadsDigest(otherQuads);
    await f.store.putSnapshot({ digest: otherDigest, quads: otherQuads });
    await f.store.lifecycle.markPublished([digest, otherDigest]);
    // Need is 15 bytes (target 20 vs 5 available): one candidate covers it.
    f.setFree(5);
    expect(await f.store.collectGarbage()).toMatchObject({ finalizedSnapshots: 1, deletedSnapshots: 1 });
    const markers = await Promise.all([digest, otherDigest].map(ref =>
      stat(snapshotPath(f.directory, ref).replace(/\.nq$/, '.retired')).then(() => true, () => false)));
    expect(markers.filter(Boolean)).toHaveLength(1);
  });
});

describe('operation leases follow the finalized cleanup opt-in', () => {
  it.each([
    ['is off, so pressure GC may reclaim a file an ordinary operation touched', false, { deletedSnapshots: 1, skippedActiveFiles: 0 }],
    ['is on, so an operation keeps the files it touched until it finishes', true, { deletedSnapshots: 0, skippedActiveFiles: 1 }],
  ] as const)('cleanup %s', async (_label, cleanup, expected) => {
    const f = await fixture(undefined, { finalizedCleanupEnabled: cleanup });
    const store = f.open();
    f.pressure();
    await withSnapshotScope(store, async snapshots => {
      expect(await snapshots!.getSnapshot(digest)).toEqual(quads);
      expect(await store.collectGarbage()).toMatchObject(expected);
    });
    // Once the operation ends, an enabled store's file is evictable again.
    if (cleanup) expect((await store.collectGarbage()).deletedSnapshots).toBe(1);
  });

  it.each([false, true])('holds no lease beyond an existence probe unless the store offers one (cleanup: %s)', async cleanup => {
    const f = await fixture(undefined, { finalizedCleanupEnabled: cleanup });
    const store = f.open();
    const hash = digest.slice('sha256:'.length);
    expect('operationLease' in store.lifecycle).toBe(cleanup);
    await withSnapshotScope(store, async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(true);
      // A probe alone is short-lived: only an operation-long lease leaves the digest busy afterwards.
      expect(await snapshotLifecycleGate(f.directory).tryCollect(hash, async () => 'idle')).toBe(cleanup ? undefined : 'idle');
    });
    expect(await snapshotLifecycleGate(f.directory).tryCollect(hash, async () => 'idle')).toBe('idle');
  });

  it('reports a file that pressure GC removed as missing while cleanup is off, so reuse fetches it again', async () => {
    const f = await fixture(undefined, { finalizedCleanupEnabled: false });
    const store = f.open();
    const probe = vi.spyOn(store.lifecycle, 'snapshotExists');
    await withSnapshotScope(store, async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(true);
    });
    f.pressure();
    expect(await store.collectGarbage()).toMatchObject({ deletedSnapshots: 1 });
    await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await withSnapshotScope(store, async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(false);
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('the file store\'s existence probe', () => {
  it.each([
    ['a file without read permission', false],
    ['a file without read permission', true],
    ['a directory in the payload\'s place', false],
    ['a directory in the payload\'s place', true],
  ] as const)('rejects for %s (cleanup: %s), so a fetch is never mistaken for a repair', async (kind, cleanup) => {
    const noPermission = kind.startsWith('a file');
    // root and Windows do not enforce the mode bit: only the directory variant can run there.
    if (noPermission && (process.platform === 'win32' || process.getuid?.() === 0)) return;
    const f = await fixture(undefined, { finalizedCleanupEnabled: cleanup });
    const store = f.open();
    if (noPermission) await chmod(f.path, 0o000);
    else { await rm(f.path); await mkdir(f.path); }
    try {
      await withSnapshotScope(store, async snapshots => {
        // The payload is present, so it is not "absent": the probe fails visibly.
        await expect(snapshots!.retainExisting(digest)).rejects.toThrow(noPermission ? /EACCES/ : undefined);
        // Fetching would not help: writing skips an existing path, and reads keep failing.
        await expect(snapshots!.putSnapshot({ digest, quads })).resolves.toMatchObject({ ref: digest });
        await expect(snapshots!.getSnapshot(digest)).rejects.toThrow();
      });
    } finally {
      if (noPermission) await chmod(f.path, 0o644);
    }
  });

  it.each([false, true])('reports a snapshot that does not exist as absent, not as a failure (cleanup: %s)', async cleanup => {
    const f = await fixture(undefined, { finalizedCleanupEnabled: cleanup });
    const store = f.open();
    await rm(f.path);
    await withSnapshotScope(store, async snapshots => {
      await expect(snapshots!.retainExisting(digest)).resolves.toBe(false);
    });
  });
});

describe('operation leases are an optional capability of the store', () => {
  /** A custom I/O store; `lifecycle` is whatever the test wants the scope to see. */
  function customStore(lifecycle: WorkspaceSnapshotLifecycle | undefined): WorkspacePublicSnapshotStore {
    return {
      putSnapshot: async input => ({ ref: input.digest, byteLength: 1 }),
      getSnapshot: async () => [],
      validateSnapshot: async () => true,
      getSnapshotPage: async () => [],
      ...(lifecycle ? { lifecycle } : {}),
    };
  }
  const lifecycleOf = (over: Partial<WorkspaceSnapshotLifecycle>) => ({
    finalizedCleanupEnabled: false, snapshotExists: async () => true,
    markPublished: async () => {}, ...over,
  }) as WorkspaceSnapshotLifecycle;

  it('honors a custom capability even though finalized cleanup is reported off, and closes it with the operation', async () => {
    let active = 0;
    const leased: string[] = [];
    const operationLease = vi.fn(async (ref: string) => { leased.push(ref); active += 1; return () => { active -= 1; }; });
    const store = customStore(lifecycleOf({ finalizedCleanupEnabled: false, operationLease }));
    await withSnapshotScope(store, async snapshots => {
      await snapshots!.putSnapshot({ digest, quads });
      await snapshots!.getSnapshot(digest);
      await snapshots!.validateSnapshot!(digest, digest, 1);
      await snapshots!.getSnapshotPage!(digest, 0, 1);
      // One lease per digest for the whole operation, however many times it is touched.
      expect(leased).toEqual([digest]);
      expect(active).toBe(1);
    });
    expect(active).toBe(0);
  });

  it('takes no operation-long lease from a cleanup-disabled lifecycle that offers none, and raises no error', async () => {
    const snapshotExists = vi.fn(async () => true);
    const markPublished = vi.fn(async () => {});
    const store = customStore(lifecycleOf({ finalizedCleanupEnabled: false, snapshotExists, markPublished }));
    await withSnapshotScope(store, async snapshots => {
      await snapshots!.putSnapshot({ digest, quads });
      await snapshots!.getSnapshot(digest);
      await snapshots!.validateSnapshot!(digest, digest, 1);
      await snapshots!.getSnapshotPage!(digest, 0, 1);
      // Reuse still asks the probe: the lease policy and the existence question are separate.
      expect(await snapshots!.retainExisting(digest)).toBe(true);
    });
    // Nothing but the existence probe (through retainExisting) and retirement scheduling touch a lifecycle.
    expect(snapshotExists).toHaveBeenCalledExactlyOnceWith(digest);
    expect(markPublished).not.toHaveBeenCalled();
  });

  describe('a lifecycle that breaks the contract is refused where it is first used', () => {
    const CONTRACT_NOTE = ' The lifecycle contract changed: operationLease(ref) replaces acquire(ref) for operation-long leases, '
      + 'and the existence probe is now snapshotExists(ref): Promise<boolean>, which replaces acquireExisting(ref). '
      + 'See docs/use-dkg/swm-public-snapshot-gc.md.';
    const NO_LEASE = 'Invalid snapshot lifecycle. It reports finalizedCleanupEnabled but offers no operationLease(ref), so operations '
      + 'would run without operation-long leases and the collector could remove a snapshot between its write and the metadata '
      + 'commit that references it.';
    const LEGACY_ACQUIRE = ' It still has the earlier acquire(ref) method, which is no longer read: offer the same lease as operationLease(ref).';
    const NO_PROBE = ' It offers no snapshotExists(ref).';

    it('rejects a cleanup-enabled lifecycle without operationLease before any operation work', async () => {
      const snapshotExists = vi.fn(async () => true);
      const markPublished = vi.fn(async () => {});
      const store = customStore({ finalizedCleanupEnabled: true, snapshotExists, markPublished } as unknown as WorkspaceSnapshotLifecycle);
      const put = vi.spyOn(store, 'putSnapshot');
      const operation = vi.fn(async () => 'ran');
      // The type refuses this shape (the compiler-checked fixture pins that); a cast or plain JavaScript gets it here.
      await expect(withSnapshotScope(store, operation)).rejects.toHaveProperty('message', `${NO_LEASE}${CONTRACT_NOTE}`);
      expect(operation).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(snapshotExists).not.toHaveBeenCalled();
      expect(markPublished).not.toHaveBeenCalled();
    });

    it.each([
      ['an explicit undefined operationLease', { operationLease: undefined }],
      ['an operationLease that is a string', { operationLease: 'lease' }],
    ])('rejects a cleanup-enabled lifecycle with %s', async (_label, extra) => {
      const store = customStore({ finalizedCleanupEnabled: true, snapshotExists: async () => true, markPublished: async () => {}, ...extra } as unknown as WorkspaceSnapshotLifecycle);
      await expect(withSnapshotScope(store, async () => 'ran')).rejects.toHaveProperty('message', `${NO_LEASE}${CONTRACT_NOTE}`);
    });

    it('says so when the lifecycle still has the earlier acquire/acquireExisting shape, and never calls it', async () => {
      const acquire = vi.fn(async () => () => {});
      const acquireExisting = vi.fn(async () => () => {});
      const markPublished = vi.fn(async () => {});
      const store = customStore({ finalizedCleanupEnabled: true, acquire, acquireExisting, markPublished } as unknown as WorkspaceSnapshotLifecycle);
      const operation = vi.fn(async () => 'ran');
      await expect(withSnapshotScope(store, operation)).rejects
        .toHaveProperty('message', `${NO_LEASE}${LEGACY_ACQUIRE}${NO_PROBE}${CONTRACT_NOTE}`);
      expect(operation).not.toHaveBeenCalled();
      expect([acquire, acquireExisting, markPublished].map(fn => fn.mock.calls.length)).toEqual([0, 0, 0]);
    });

    it('refuses a lifecycle without the boolean existence probe, cleanup enabled or not', async () => {
      for (const finalizedCleanupEnabled of [false, true]) {
        const store = customStore({
          finalizedCleanupEnabled, markPublished: async () => {}, acquireExisting: async () => () => {},
          ...(finalizedCleanupEnabled ? { operationLease: async () => () => {} } : {}),
        } as unknown as WorkspaceSnapshotLifecycle);
        await expect(withSnapshotScope(store, async () => 'ran')).rejects
          .toHaveProperty('message', `Invalid snapshot lifecycle.${NO_PROBE}${CONTRACT_NOTE}`);
      }
    });

    it('does not refuse a cleanup-enabled lifecycle that offers operationLease, and leaves a custom store without a lifecycle alone', async () => {
      const operationLease = vi.fn(async () => () => {});
      await expect(withSnapshotScope(customStore(lifecycleOf({ finalizedCleanupEnabled: true, operationLease })),
        async snapshots => { await snapshots!.getSnapshot(digest); return 'ran'; })).resolves.toBe('ran');
      expect(operationLease).toHaveBeenCalledOnce();
      await expect(withSnapshotScope(customStore(undefined), async () => 'ran')).resolves.toBe('ran');
    });

    it('fails a publisher\'s retirement at construction too, and accepts the file store\'s own lifecycle', async () => {
      const f = await fixture();
      const bad = { finalizedCleanupEnabled: true, snapshotExists: async () => true, markPublished: async () => {} } as unknown as WorkspaceSnapshotLifecycle;
      expect(() => new PublishedSnapshotRetirement({} as OxigraphStore, bad)).toThrow(`${NO_LEASE}${CONTRACT_NOTE}`);
      expect(() => new PublishedSnapshotRetirement({} as OxigraphStore, f.store.lifecycle)).not.toThrow();
      expect(() => new PublishedSnapshotRetirement({} as OxigraphStore, undefined)).not.toThrow();
    });
  });

  it.each([true, false])('answers reuse from the existence probe of a custom lifecycle (present: %s)', async present => {
    const snapshotExists = vi.fn(async () => present);
    const operationLease = vi.fn(async () => () => {});
    const store = customStore(lifecycleOf({ snapshotExists, operationLease }));
    await withSnapshotScope(store, async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(present);
    });
    expect(snapshotExists).toHaveBeenCalledExactlyOnceWith(digest);
    expect(operationLease).toHaveBeenCalledOnce();
  });

  it.each([
    ['a filesystem error', Object.assign(new Error('too many open files'), { code: 'EMFILE' })],
    ['a lifecycle gate failure', new Error('Snapshot directory needs a stable physical identity')],
    ['an implementation defect', new TypeError('probe is broken')],
  ])('lets an existence probe that throws (%s) fail the operation instead of reading as absent', async (_label, failure) => {
    const snapshotExists = vi.fn(async (): Promise<boolean> => { throw failure; });
    const release = vi.fn();
    const operationLease = vi.fn(async () => release);
    const store = customStore(lifecycleOf({ snapshotExists, operationLease }));
    await withSnapshotScope(store, async snapshots => {
      await expect(snapshots!.retainExisting(digest)).rejects.toBe(failure);
    });
    expect(snapshotExists).toHaveBeenCalledExactlyOnceWith(digest);
    // The failed probe still closes with the operation: its lease is released.
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ['a lease function, as the earlier acquireExisting resolved', () => {}],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'true'],
  ])('refuses a probe that resolves %s, which is neither present nor absent', async (_label, answer) => {
    const snapshotExists = vi.fn(async () => answer as unknown as boolean);
    const store = customStore(lifecycleOf({ snapshotExists, operationLease: vi.fn(async () => () => {}) }));
    await withSnapshotScope(store, async snapshots => {
      await expect(snapshots!.retainExisting(digest)).rejects.toThrow(/snapshotExists\(ref\) must resolve a boolean .* replaces acquireExisting\(ref\)/);
    });
  });

  it('keeps the store\'s explicit false as the one answer for absent, without any error', async () => {
    const snapshotExists = vi.fn(async () => false);
    const store = customStore(lifecycleOf({ snapshotExists, operationLease: vi.fn(async () => () => {}) }));
    await withSnapshotScope(store, async snapshots => {
      await expect(snapshots!.retainExisting(digest)).resolves.toBe(false);
    });
    expect(snapshotExists).toHaveBeenCalledExactlyOnceWith(digest);
  });

  it('lets a store without a lifecycle own reuse', async () => {
    await withSnapshotScope(customStore(undefined), async snapshots => {
      expect(await snapshots!.retainExisting(digest)).toBe(true);
    });
  });
});

describe('reference check store queries', () => {
  it('issues no abort signal into the store', async () => {
    const rdf = new OxigraphStore();
    const query = vi.spyOn(rdf, 'query');
    try {
      expect(await snapshotReferenceCheck(rdf)(digest)).toBe(false);
      expect(query).toHaveBeenCalledOnce();
      // A short caller signal on a managed store can restart it; only the client-side deadline may apply.
      expect(query.mock.calls[0]?.[1]).toBeUndefined();
    } finally { await rdf.close(); }
  });

  it('gives the collector no signal path either, while still bounding its own wait', async () => {
    const rdf = new OxigraphStore();
    const query = vi.spyOn(rdf, 'query');
    const f = await fixture(snapshotReferenceCheck(rdf));
    try {
      await f.store.lifecycle.markPublished([digest]);
      f.advance();
      expect((await f.store.collectGarbage()).finalizedSnapshots).toBe(1);
      expect(query.mock.calls.length).toBeGreaterThan(0);
      expect(query.mock.calls.every(call => call[1] === undefined)).toBe(true);
    } finally { await rdf.close(); }
  });
});
