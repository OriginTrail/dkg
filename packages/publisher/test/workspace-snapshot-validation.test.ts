import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileWorkspacePublicSnapshotStore,
  workspacePublicQuadsDigest,
} from '../src/workspace-snapshot-store.js';

import { readSnapshotSource } from '../src/workspace-snapshot-source.js';

vi.mock('../src/workspace-snapshot-source.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/workspace-snapshot-source.js')>();
  return { ...actual, readSnapshotSource: vi.fn(actual.readSnapshotSource) };
});

const quads = [{ subject: 'urn:validation:subject', predicate: 'urn:predicate', object: '"value"', graph: '' }];
const digest = workspacePublicQuadsDigest(quads);
const tempDirs: string[] = [];
const options = { gc: { enabled: false } };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-validation-'));
  tempDirs.push(directory);
  const store = new FileWorkspacePublicSnapshotStore(directory, undefined, options);
  const hash = digest.slice(7);
  const path = join(directory, hash.slice(0, 2), hash.slice(2, 4), `${hash}.nq`);
  await store.putSnapshot({ digest, quads });
  const load = vi.mocked(readSnapshotSource);
  load.mockClear();
  return { directory, store, path, load, validate: () => store.validateSnapshot(digest, digest, quads.length) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(readSnapshotSource).mockReset();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('immutable snapshot validation cache', () => {
  it('fully validates after put, then reuses evidence without materializing quads', async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(1);
    // A new instance has no previous validation evidence, even in this process.
    const restarted = new FileWorkspacePublicSnapshotStore(f.directory, undefined, options);
    const load = vi.mocked(readSnapshotSource);
    load.mockClear();
    await expect(restarted.validateSnapshot(digest, digest, 1)).resolves.toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });

  it('retains warm evidence throughout concurrent fingerprint reads', async () => {
    const f = await fixture();
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledOnce();
    await expect(Promise.all([f.validate(), f.validate()])).resolves.toEqual([true, true]);
    expect(f.load).toHaveBeenCalledOnce();
  });

  it.each(['delete', 'truncate', 'corrupt', 'replace', 'same-size-restored-mtime'] as const)(
    'rejects %s after a successful validation and does not retain failed evidence', async (change) => {
      const f = await fixture();
      expect(await f.validate()).toBe(true);
      const original = await readFile(f.path, 'utf8');
      const before = await stat(f.path);
      if (change === 'delete') await rm(f.path);
      if (change === 'truncate') await truncate(f.path, 0);
      if (change === 'corrupt') await writeFile(f.path, 'invalid N-Quads');
      if (change === 'replace') {
        await writeFile(`${f.path}.replacement`, original.replace('value', 'other'));
        await rename(`${f.path}.replacement`, f.path);
      }
      if (change === 'same-size-restored-mtime') {
        await writeFile(f.path, original.replace('value', 'other'));
        await utimes(f.path, before.atime, before.mtime);
      }
      await expect(f.validate()).resolves.toBe(false);
      const reads = f.load.mock.calls.length;
      await expect(f.validate()).resolves.toBe(false);
      expect(f.load).toHaveBeenCalledTimes(change === 'delete' ? reads : reads + 1);
      await writeFile(f.path, original);
      await expect(f.validate()).resolves.toBe(true);
      const recoveredReads = f.load.mock.calls.length;
      await expect(f.validate()).resolves.toBe(true);
      expect(f.load).toHaveBeenCalledTimes(recoveredReads);
    },
  );

  it('revalidates an identical replacement instead of reusing the old inode evidence', async () => {
    const f = await fixture();
    expect(await f.validate()).toBe(true);
    const original = await readFile(f.path);
    const before = await stat(f.path);
    await writeFile(`${f.path}.replacement`, original);
    await utimes(`${f.path}.replacement`, before.atime, before.mtime);
    await rename(`${f.path}.replacement`, f.path);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('answers mismatched expectations from unchanged cached evidence without rereading', async () => {
    const f = await fixture();
    expect(await f.validate()).toBe(true);
    await expect(f.store.validateSnapshot(digest, `sha256:${'0'.repeat(64)}`, 1)).resolves.toBe(false);
    await expect(f.store.validateSnapshot(digest, digest, 2)).resolves.toBe(false);
    expect(f.load).toHaveBeenCalledTimes(1);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid count %s', async (count) => {
    const f = await fixture();
    await expect(f.store.validateSnapshot(digest, digest, count)).resolves.toBe(false);
    expect(f.load).not.toHaveBeenCalled();
  });

  it('returns false for an invalid ref and a directory where a snapshot should be', async () => {
    const f = await fixture();
    await expect(f.store.validateSnapshot('../escape', digest, 1)).resolves.toBe(false);
    await rm(f.path);
    await mkdir(f.path);
    await expect(f.validate()).resolves.toBe(false);
    expect(f.load).not.toHaveBeenCalled();
  });

  it('validates legacy JSON and rechecks when N-Quads takes precedence', async () => {
    const f = await fixture();
    const raw = await readFile(f.path);
    await rm(f.path);
    await writeFile(f.path.replace(/\.nq$/, '.json'), JSON.stringify(quads.map(q => [q.subject, q.predicate, q.object])));
    await expect(f.validate()).resolves.toBe(true);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledOnce();
    await writeFile(f.path, raw);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2);
    await writeFile(f.path, 'invalid');
    await expect(f.validate()).resolves.toBe(false); // Do not fall back past corrupt N-Quads.
    await rm(f.path);
    await expect(f.validate()).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(4);
  });

  it('uses the same non-regular N-Quads precedence for reading and validation', async () => {
    const f = await fixture();
    await rm(f.path);
    await writeFile(f.path.replace(/\.nq$/, '.json'), JSON.stringify(quads.map(q => [q.subject, q.predicate, q.object])));
    await mkdir(f.path);
    await expect(f.store.getSnapshot(digest)).rejects.toThrow('not a regular file');
    await expect(f.validate()).resolves.toBe(false);
    await rm(f.path, { recursive: true });
    await expect(f.store.getSnapshot(digest)).resolves.toEqual(quads);
    await expect(f.validate()).resolves.toBe(true);
  });

  it.each(['modify', 'delete', 'replace-identical'] as const)('rejects %s during a full validation', async (change) => {
    const f = await fixture();
    f.load.mockReset();
    const originalLoad = f.load.getMockImplementation()!;
    const load = f.load.mockImplementationOnce(async (source) => {
      const result = await originalLoad(source);
      if (change === 'modify') await writeFile(f.path, (await readFile(f.path, 'utf8')).replace('value', 'other'));
      if (change === 'delete') await rm(f.path);
      if (change === 'replace-identical') {
        await writeFile(`${f.path}.replacement`, await readFile(f.path));
        await rename(`${f.path}.replacement`, f.path);
      }
      return result;
    });
    await expect(f.validate()).resolves.toBe(false);
    await expect(f.validate()).resolves.toBe(change === 'replace-identical');
    expect(load).toHaveBeenCalledTimes(change === 'delete' ? 1 : 2);
  });

  it('rejects stat errors and validates an empty snapshot', async () => {
    const f = await fixture();
    expect(await f.validate()).toBe(true);
    await rm(f.path);
    await symlink(f.path, f.path);
    await expect(f.validate()).resolves.toBe(false);
    const emptyDigest = workspacePublicQuadsDigest([]);
    await f.store.putSnapshot({ digest: emptyDigest, quads: [] });
    await expect(f.store.validateSnapshot(emptyDigest, emptyDigest, 0)).resolves.toBe(true);
    await expect(f.store.validateSnapshot(emptyDigest, emptyDigest, 0)).resolves.toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('protects the whole validation interval from garbage collection', async () => {
    const f = await fixture();
    await utimes(f.path, new Date(0), new Date(0));
    const gcStore = new FileWorkspacePublicSnapshotStore(f.directory, undefined, {
      gc: { enabled: true, minAgeMs: 0, triggerFreeBytes: 100, targetFreeBytes: 200, hardReserveBytes: 0 },
      getAvailableBytes: async () => 0,
    });
    let duringValidation: Awaited<ReturnType<typeof gcStore.collectGarbage>> | undefined;
    const originalLoad = f.load.getMockImplementation()!;
    f.load.mockImplementationOnce(async (source) => {
      const quads = await originalLoad(source);
      // The lease-free read has finished; the validation operation still owns its lease.
      duringValidation = await gcStore.collectGarbage();
      return quads;
    });
    try {
      await expect(gcStore.validateSnapshot(digest, digest, 1)).resolves.toBe(true);
      expect(duringValidation).toMatchObject({ deletedSnapshots: 0, skippedActiveFiles: 1 });
      expect((await gcStore.collectGarbage()).deletedSnapshots).toBe(1);
      await expect(gcStore.validateSnapshot(digest, digest, 1)).resolves.toBe(false);
    } finally { gcStore.stopGarbageCollection(); }
  });

  it('keeps at most 2048 successful entries and refreshes LRU order on a hit', async () => {
    const f = await fixture();
    const refs: string[] = [];
    for (let i = 0; i < 2048; i++) {
      const ref = `sha256:${i.toString(16).padStart(64, '0')}`;
      await f.store.putSnapshot({ digest: ref, quads });
      expect(await f.store.validateSnapshot(ref, digest, 1)).toBe(true);
      refs.push(ref);
    }
    expect(f.load).toHaveBeenCalledTimes(2048);
    expect(await f.store.validateSnapshot(refs[0]!, digest, 1)).toBe(true);
    expect(await f.validate()).toBe(true); // Entry 2049 evicts refs[1], not refreshed refs[0].
    expect(f.load).toHaveBeenCalledTimes(2049);
    expect(await f.store.validateSnapshot(refs[0]!, digest, 1)).toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2049);
    expect(await f.store.validateSnapshot(refs[1]!, digest, 1)).toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2050);
  });
});

it.each(['nq', 'json'] as const)('keeps %s validation and page fallback inside their owning store operation', async format => {
  const f = await fixture();
  if (format === 'json') {
    await rm(f.path);
    await writeFile(f.path.replace(/\.nq$/, '.json'), JSON.stringify(quads.map(q => [q.subject, q.predicate, q.object])));
  }
  f.load.mockReset();
  const publicRead = vi.spyOn(f.store, 'getSnapshot').mockRejectedValue(new Error('public re-entry'));
  await expect(f.validate()).resolves.toBe(true);
  await expect(f.store.getSnapshotPage(digest, 0, 1)).resolves.toEqual(quads);
  expect(publicRead).not.toHaveBeenCalled();
});

it('preserves the legacy non-array JSON null result across validation and paging', async () => {
  const f = await fixture();
  await rm(f.path);
  await writeFile(f.path.replace(/\.nq$/, '.json'), '{}');
  await expect(f.store.getSnapshot(digest)).resolves.toBeNull();
  await expect(f.validate()).resolves.toBe(false);
  await expect(f.store.getSnapshotPage(digest, 0, 1)).resolves.toBeNull();
});

it('does not certify an invalid inode temporarily replaced by valid bytes during its read', async () => {
  const f = await fixture();
  const valid = await readFile(f.path);
  await writeFile(f.path, 'invalid snapshot');
  const replacement = `${f.path}.valid`;
  const original = `${f.path}.invalid`;
  await writeFile(replacement, valid);
  const source = await import('../src/workspace-snapshot-source.js');
  const actual = await vi.importActual<typeof source>('../src/workspace-snapshot-source.js');
  f.load.mockImplementationOnce(async selected => {
    await rename(f.path, original);
    await rename(replacement, f.path);
    try { return await actual.readSnapshotSource(selected); }
    finally { await rename(f.path, replacement); await rename(original, f.path); }
  });
  await expect(f.validate()).resolves.toBe(false);
  await expect(f.validate()).resolves.toBe(false);
  expect(await readFile(f.path, 'utf8')).toBe('invalid snapshot');
});
