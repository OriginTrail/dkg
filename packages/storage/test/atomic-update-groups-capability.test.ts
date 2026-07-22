import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  createTripleStore,
  type TripleStore,
} from '../src/index.js';

// #1863 — the async-lift publisher only takes the single-subject atomic replace
// path when its store declares `atomicUpdateGroups === true`. This capability
// MUST survive the full production decorator stack, or the atomic path is
// silently never taken and the fix is a no-op in prod.
describe('#1863 atomicUpdateGroups capability', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('the embedded oxigraph adapter declares group-atomicity', () => {
    expect(new OxigraphStore().atomicUpdateGroups).toBe(true);
  });

  it('decorators forward the wrapped store capability in both directions', () => {
    // Forwards `true` from an atomic inner.
    expect(new GraphSetIndexStore(new OxigraphStore()).atomicUpdateGroups).toBe(true);
    expect(new ChangelogStore(new OxigraphStore()).atomicUpdateGroups).toBe(true);

    // Forwards a non-atomic inner unchanged (never fabricates atomicity).
    const nonAtomic = { atomicUpdateGroups: false } as unknown as TripleStore;
    expect(new GraphSetIndexStore(nonAtomic).atomicUpdateGroups).toBe(false);
    expect(new ChangelogStore(nonAtomic).atomicUpdateGroups).toBe(false);

    // An inner that omits the capability stays falsy (conservative fallback).
    const absent = {} as unknown as TripleStore;
    expect(new GraphSetIndexStore(absent).atomicUpdateGroups).toBeUndefined();
  });

  it('the composed production local store reports group-atomicity through the full decorator stack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-update-groups-'));
    tempDirs.push(dir);
    // Prod stack: ChangelogStore -> GraphSetIndexStore -> SharedMemoryLiteralBlobStore
    // -> OxigraphWorkerStore. graphSetIndex is auto-enabled for the local oxigraph
    // backends; changelog + largeLiteralStorage opt the other two decorators in.
    const store = await createTripleStore({
      backend: 'oxigraph-worker',
      changelog: true,
      largeLiteralStorage: { enabled: true, directory: dir },
    });
    try {
      // The outermost decorator is the changelog store — proves the full stack was built.
      expect(store.constructor.name).toBe('ChangelogStore');
      // The make-or-break: the atomic capability survives every decorator to the top.
      expect(store.atomicUpdateGroups).toBe(true);
    } finally {
      await store.close();
    }
  });
});
