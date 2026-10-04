// SPDX-License-Identifier: Apache-2.0

import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { storeKnowledgeAssetOperationPublicQuads, storeWorkspaceOperationPublicQuads } from '../src/workspace-resolution.js';
import { workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';
import { withWorkspaceOperationWriteLock } from '../src/workspace-operation-write-lock.js';

const DKG = 'http://dkg.io/ontology/';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const ROOT = 'urn:test:legacy-root';
const quads = [{ subject: ROOT, predicate: 'urn:test:p', object: '"value"', graph: '' }];
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(store => store.close())); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const store = new OxigraphStore(); stores.push(store);
  return { store, graphManager: new GraphManager(store), contextGraphId: 'operation-fence',
    subGraphName: 'detail' as string | undefined, shareOperationId: 'same-operation', quads };
}
const legacy = (params: ReturnType<typeof fixture>) => storeWorkspaceOperationPublicQuads({ ...params, rootEntities: [ROOT] });
const v2 = (params: ReturnType<typeof fixture>) => storeKnowledgeAssetOperationPublicQuads({ ...params, kaUal: UAL, assertionVersion: 1 });
async function owner(params: ReturnType<typeof fixture>) {
  const result = await params.store.query(`SELECT ?ka ?root WHERE { GRAPH <${params.graphManager.sharedMemoryMetaUri(params.contextGraphId, params.subGraphName)}> {
    <${workspaceOperationSubject(params.contextGraphId, params.shareOperationId)}> <${DKG}shareOperationId> ?id .
    OPTIONAL { <${workspaceOperationSubject(params.contextGraphId, params.shareOperationId)}> <${DKG}kaUal> ?ka }
    OPTIONAL { <${workspaceOperationSubject(params.contextGraphId, params.shareOperationId)}> <${DKG}rootEntity> ?root }
  } }`);
  if (result.type !== 'bindings') throw new Error('Operation owner query did not return bindings');
  return result.bindings;
}

describe('canonical operation metadata write fence', () => {
  it('holds a legacy factory through all mutations before a same-ID V2 factory changes ownership', async () => {
    const f = fixture(); await legacy(f);
    const entered = deferred(), release = deferred(), remove = f.store.deleteByPatternWithoutCount.bind(f.store);
    vi.spyOn(f.store, 'deleteByPatternWithoutCount').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return remove(...args);
    });
    const drop = vi.spyOn(f.store, 'dropGraph');
    const first = legacy({ ...f, subGraphName: ' detail ' }); await entered.promise;
    const second = v2(f);
    try {
      await setImmediate();
      expect(drop).not.toHaveBeenCalled();
      expect(await owner(f)).toEqual([{ root: ROOT }]);
    } finally { release.resolve(); await Promise.all([first, second]); }
    expect(await owner(f)).toEqual([{ ka: UAL }]);
  });

  it('holds the V2 factory through its final authenticated evidence write before a legacy same-ID writer enters', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const replace = f.store.replaceSubject.bind(f.store);
    vi.spyOn(f.store, 'replaceSubject').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return replace(...args);
    });
    const first = v2(f); await entered.promise;
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount');
    const second = legacy(f);
    try {
      await setImmediate();
      expect(remove).not.toHaveBeenCalled();
      expect(await owner(f)).toEqual([{ ka: UAL }]);
    } finally { release.resolve(); await Promise.all([first, second]); }
    expect(await owner(f)).toEqual([{ root: ROOT }]);
  });

  it('defers the final retirement ownership reader until the real V2 mutation has changed the route', async () => {
    const f = fixture(); await legacy(f);
    const entered = deferred(), release = deferred(), drop = f.store.dropGraph.bind(f.store);
    vi.spyOn(f.store, 'dropGraph').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return drop(...args);
    });
    const write = v2(f); await entered.promise;
    const inspect = vi.fn(async () => {
      const rows = await owner(f);
      if (rows.some(row => row.root === ROOT)) {
        await f.store.deleteByPatternWithoutCount({ graph: f.graphManager.sharedMemoryMetaUri(f.contextGraphId, f.subGraphName),
          subject: workspaceOperationSubject(f.contextGraphId, f.shareOperationId) });
      }
      return rows;
    });
    const retirement = withWorkspaceOperationWriteLock(f, inspect);
    try {
      await setImmediate();
      expect(inspect).not.toHaveBeenCalled();
    } finally { release.resolve(); await write; }
    expect(await retirement).toEqual([{ ka: UAL }]);
    expect(await owner(f)).toEqual([{ ka: UAL }]);
  });

  it.each(['operation', 'namespace', 'subgraph', 'store'] as const)('allows an independent %s to progress while the same operation is held', async domain => {
    const f = fixture(), entered = deferred(), release = deferred(), drop = f.store.dropGraph.bind(f.store);
    vi.spyOn(f.store, 'dropGraph').mockImplementationOnce(async (...args) => {
      entered.resolve(); await release.promise; return drop(...args);
    });
    const held = v2(f); await entered.promise;
    const other = domain === 'operation' ? { ...f, shareOperationId: 'independent-operation' }
      : domain === 'namespace' ? { ...f, contextGraphId: 'other-namespace' }
      : domain === 'subgraph' ? { ...f, subGraphName: 'other' }
      : { ...fixture(), shareOperationId: f.shareOperationId };
    let completed = false;
    const independent = v2(other).then(() => { completed = true; });
    try {
      await setImmediate();
      expect(completed).toBe(true);
      expect(await owner(other)).toEqual([{ ka: UAL }]);
    } finally { release.resolve(); await Promise.all([held, independent]); }
  });

  it('releases the real writer fence after failure so the queued repair completes', async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    vi.spyOn(f.store, 'dropGraph').mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; throw new Error('Snapshot mutation failed');
    });
    const failed = v2(f), result = expect(failed).rejects.toThrow('Snapshot mutation failed');
    await entered.promise;
    let completed = false;
    const repair = legacy(f).then(() => { completed = true; });
    try { await setImmediate(); expect(completed).toBe(false); }
    finally { release.resolve(); await Promise.all([result, repair]); }
    expect(await owner(f)).toEqual([{ root: ROOT }]);
  });

  it('uses one root-graph fence for an omitted or empty normalized subgraph', async () => {
    const f = { ...fixture(), subGraphName: undefined }, entered = deferred(), release = deferred();
    const held = withWorkspaceOperationWriteLock({ ...f, subGraphName: ' ' }, async () => {
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount'), write = legacy(f);
    try { await setImmediate(); expect(remove).not.toHaveBeenCalled(); }
    finally { release.resolve(); await Promise.all([held, write]); }
    expect(await owner(f)).toEqual([{ root: ROOT }]);
  });

  it.each([
    { shareOperationId: 'bad operation' }, { contextGraphId: '' }, { subGraphName: 'bad/name' },
  ])('rejects malformed identity before either factory mutates native storage: %j', async invalid => {
    const f = { ...fixture(), ...invalid };
    const remove = vi.spyOn(f.store, 'deleteByPatternWithoutCount'), drop = vi.spyOn(f.store, 'dropGraph');
    await expect(legacy(f)).rejects.toThrow(); await expect(v2(f)).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled(); expect(drop).not.toHaveBeenCalled();
  });
});
