// SPDX-License-Identifier: Apache-2.0
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope, MemoryLayer, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import { materializeConfirmedGraphKnowledgeAsset, type GraphMaterializationRows } from '../src/confirmed-graph-publish-materialization.js';
import { computePrivateRootV10 } from '../src/merkle.js';
import { replaceCatalogQuads } from '../src/catalog-persistence.js';
import { generateGraphKnowledgeAssetMetadata, materializedVersionQuad, readMaterializedVersion, withMaterializationLock, writeMaterializedVersion } from '../src/metadata.js';

type FixtureRows = Omit<GraphMaterializationRows, 'metadataQuads'> & { confirmedQuads: readonly Quad[] };
function materialize(input: Omit<Parameters<typeof materializeConfirmedGraphKnowledgeAsset>[0], 'prepare'> & FixtureRows) {
  return materializeConfirmedGraphKnowledgeAsset({ ...input, prepare: async () => ({
    vmQuads: input.vmQuads, privateQuads: input.privateQuads, metadataQuads: input.confirmedQuads,
  }) });
}

function fixture() {
  const store = new OxigraphStore();
  const contextGraphId = 'mint-materialization';
  const scope = createGraphKnowledgeAssetScope('did:dkg:31337/0x00000000000000000000000000000000000000ab/7', 1);
  const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope);
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const vmQuads: Quad[] = [{ subject: 'urn:data', predicate: 'urn:value', object: '"old"', graph: vmGraph }];
  const confirmedQuads = generateGraphKnowledgeAssetMetadata({ ual: scope.ual, contextGraphId,
    assertionVersion: 1, assertionGraph: vmGraph, publisherPeerId: 'owner', accessPolicy: 'public',
    merkleRoot: new Uint8Array(32).fill(7), timestamp: new Date(0), publicTripleCount: 1,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: { batchId: 7n, txHash: `0x${'11'.repeat(32)}` } } });
  return { store, privateStore: new PrivateContentStore(store, new GraphManager(store)),
    scope, contextGraphId, metaGraph, vmGraph, vmQuads, privateQuads: [], confirmedQuads,
    version: { blockNumber: 10, txIndex: 2 }, persistCatalogEntry: vi.fn(async () => undefined) };
}

describe('confirmed graph publish materialization', () => {
  it('does not prepare or mutate while another KA writer owns the lock, and prepares once after release', async () => {
    const input = fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = withMaterializationLock(input.metaGraph, input.scope.ual, async () => { entered(); await gate; });
    await ready;
    const prepare = vi.fn(async () => ({ vmQuads: input.vmQuads,
      privateQuads: input.privateQuads, metadataQuads: input.confirmedQuads }));
    const query = vi.spyOn(input.store, 'query');
    const compound = vi.spyOn(input.store, 'replaceGraphAndSubject');
    const commit = materializeConfirmedGraphKnowledgeAsset({ ...input, prepare });
    try {
      await setImmediate();
      expect(prepare).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(compound).not.toHaveBeenCalled();
      release(); await holder;
      expect(await commit).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(compound).toHaveBeenCalledOnce();
    } finally { release(); await Promise.allSettled([holder, commit]); await input.store.close(); }
  });

  it('refuses stale confirmation before invoking preparation and propagates preparation failure before any slice write', async () => {
    const input = fixture();
    const prepare = vi.fn(async () => { throw new Error('identity preflight refused'); });
    const compound = vi.spyOn(input.store, 'replaceGraphAndSubject');
    try {
      await materialize(input);
      compound.mockClear();
      expect(await materializeConfirmedGraphKnowledgeAsset({ ...input,
        version: { blockNumber: 9, txIndex: 0 }, prepare })).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      await expect(materializeConfirmedGraphKnowledgeAsset({ ...input, prepare }))
        .rejects.toThrow('identity preflight refused');
      expect(prepare).toHaveBeenCalledOnce();
      expect(compound).not.toHaveBeenCalled();
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
    } finally { await input.store.close(); }
  });

  it('replaces the public graph and its metadata subject through one compound commit', async () => {
    const input = fixture();
    const compound = vi.spyOn(input.store, 'replaceGraphAndSubject');
    const graphOnly = vi.spyOn(input.store, 'replaceGraph');
    const other = { subject: 'urn:other-ka', predicate: 'urn:policy', object: '"keep"', graph: input.metaGraph };
    try {
      await input.store.insert([other, ...input.vmQuads.map(q => ({ ...q, object: '"superseded"' })),
        { subject: input.scope.ual, predicate: 'urn:obsolete', object: '"remove"', graph: input.metaGraph }]);
      expect(await materialize(input)).toBe(true);
      expect(compound).toHaveBeenCalledOnce();
      expect(compound.mock.calls[0]?.slice(0, 5)).toEqual([
        input.vmGraph, input.vmQuads, input.metaGraph, input.scope.ual, input.confirmedQuads,
      ]);
      expect(graphOnly.mock.calls.filter(([graph]) => graph === input.vmGraph)).toHaveLength(0);
      expect(await input.store.query(`ASK { GRAPH <${input.metaGraph}> { <urn:other-ka> <urn:policy> "keep" } }`))
        .toMatchObject({ value: true });
      expect(await input.store.query(`ASK { GRAPH <${input.metaGraph}> { <${input.scope.ual}> <urn:obsolete> ?v } }`))
        .toMatchObject({ value: false });
    } finally { await input.store.close(); }
  });

  it.each(['private', 'catalog'] as const)('retains the previous fence in the compound payload after a later %s failure', async failingSlice => {
    const input = fixture();
    try {
      await materialize(input);
      const compound = vi.spyOn(input.store, 'replaceGraphAndSubject');
      const nextVersion = { blockNumber: 11, txIndex: 1 };
      const next = { ...input, version: nextVersion,
        vmQuads: input.vmQuads.map(q => ({ ...q, object: '"replacement"' })),
        confirmedQuads: [...input.confirmedQuads, materializedVersionQuad(input.metaGraph, input.scope.ual, nextVersion)],
      };
      if (failingSlice === 'private') {
        vi.spyOn(input.privateStore, 'replaceKnowledgeAssetPrivateTriples').mockRejectedValueOnce(new Error('later slice failed'));
      } else {
        input.persistCatalogEntry.mockRejectedValueOnce(new Error('later slice failed'));
      }
      await expect(materialize(next)).rejects.toThrow('later slice failed');
      expect(compound).toHaveBeenCalledOnce();
      expect(compound.mock.calls[0]?.[4].filter(q => q.predicate.endsWith('materializedVersion')))
        .toEqual([materializedVersionQuad(input.metaGraph, input.scope.ual, input.version)]);
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
      expect(await input.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${input.vmGraph}> { ?s ?p ?o } }`))
        .toMatchObject({ quads: [expect.objectContaining({ object: '"replacement"' })] });
      expect(await materialize(next)).toBe(true);
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(nextVersion);
    } finally { await input.store.close(); }
  });

  it.each(['missing', 'refused'] as const)('retains the graph-only compatibility fallback when compound replacement is %s', async capability => {
    const input = fixture();
    try {
      const graphOnly = vi.spyOn(input.store, 'replaceGraph');
      if (capability === 'missing') Reflect.set(input.store, 'replaceGraphAndSubject', undefined);
      else vi.spyOn(input.store, 'replaceGraphAndSubject').mockRejectedValue(new UnsupportedTripleStoreCapabilityError('replaceGraphAndSubject', 'test compatibility store'));
      expect(await materialize(input)).toBe(true);
      expect(graphOnly.mock.calls.filter(([graph]) => graph === input.vmGraph)).toHaveLength(1);
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
      const nextVersion = { blockNumber: 11, txIndex: 0 };
      input.persistCatalogEntry.mockRejectedValueOnce(new Error('fallback catalog failed'));
      await expect(materialize({ ...input, version: nextVersion,
        confirmedQuads: [...input.confirmedQuads, materializedVersionQuad(input.metaGraph, input.scope.ual, nextVersion)],
      })).rejects.toThrow('fallback catalog failed');
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
    } finally { await input.store.close(); }
  });

  it('does not install an incoming ordering fence before the first catalog commit succeeds', async () => {
    const input = fixture();
    try {
      input.persistCatalogEntry.mockRejectedValueOnce(new Error('first catalog failed'));
      await expect(materialize({ ...input,
        confirmedQuads: [...input.confirmedQuads, materializedVersionQuad(input.metaGraph, input.scope.ual, input.version)],
      })).rejects.toThrow('first catalog failed');
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toBeNull();
      expect(await materialize(input)).toBe(true);
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
    } finally { await input.store.close(); }
  });

  it('propagates an indeterminate compound error without running the compatibility fallback', async () => {
    const input = fixture();
    try {
      const graphOnly = vi.spyOn(input.store, 'replaceGraph');
      vi.spyOn(input.store, 'replaceGraphAndSubject').mockRejectedValue(new Error('compound response lost'));
      await expect(materialize(input)).rejects.toThrow('compound response lost');
      expect(graphOnly).not.toHaveBeenCalled();
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toBeNull();
    } finally { await input.store.close(); }
  });

  it('persists every successful slice and ordering, then refuses older writes to the same assertion', async () => {
    const input = fixture();
    const privateQuads = [{ subject: 'urn:data', predicate: 'urn:secret', object: '"persisted private"', graph: '' }];
    const catalogGraph = 'urn:materialization-catalog';
    const catalogRows = [{ subject: input.scope.ual, predicate: 'urn:catalog-status', object: '"confirmed"', graph: catalogGraph }];
    const confirmedQuads = generateGraphKnowledgeAssetMetadata({ ual: input.scope.ual, contextGraphId: input.contextGraphId,
      assertionVersion: 1, assertionGraph: input.vmGraph, publisherPeerId: 'owner', accessPolicy: 'ownerOnly',
      merkleRoot: new Uint8Array(32).fill(7), timestamp: new Date(0), publicTripleCount: 1,
      privateTripleCount: 1, privateMerkleRoot: computePrivateRootV10(privateQuads)!,
    }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: { batchId: 7n, txHash: `0x${'11'.repeat(32)}` } } });
    const persistCatalogEntry = vi.fn(async () => replaceCatalogQuads(input.store, catalogGraph, catalogRows));
    const successful = { ...input, privateQuads, confirmedQuads, persistCatalogEntry };
    try {
      expect(await materialize(successful)).toBe(true);
      const data = () => input.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${input.vmGraph}> { ?s ?p ?o } }`);
      expect(await data()).toMatchObject({ quads: [expect.objectContaining({ object: '"old"' })] });
      const freshPrivateReader = new PrivateContentStore(input.store, new GraphManager(input.store));
      expect(await freshPrivateReader.getKnowledgeAssetPrivateTriples(input.contextGraphId, input.scope)).toEqual(privateQuads);
      expect(await input.store.query(`SELECT ?policy ?status WHERE { GRAPH <${input.metaGraph}> {
        <${input.scope.ual}> <http://dkg.io/ontology/accessPolicy> ?policy ; <http://dkg.io/ontology/status> ?status } }`))
        .toMatchObject({ bindings: [{ policy: '"ownerOnly"', status: '"confirmed"' }] });
      expect(await input.store.query(`ASK { GRAPH <${catalogGraph}> { <${input.scope.ual}> <urn:catalog-status> "confirmed" } }`))
        .toMatchObject({ value: true });
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
      for (const version of [{ blockNumber: 9, txIndex: 9 }, { blockNumber: 10, txIndex: 1 }]) {
        expect(await materialize({ ...successful, version,
          vmQuads: input.vmQuads.map(q => ({ ...q, object: '"stale public"' })),
          privateQuads: privateQuads.map(q => ({ ...q, object: '"stale private"' })),
          confirmedQuads: confirmedQuads.map(q => q.predicate.endsWith('accessPolicy') ? { ...q, object: '"public"' } : q),
        })).toBe(false);
      }
      expect(await data()).toMatchObject({ quads: [expect.objectContaining({ object: '"old"' })] });
      expect(await freshPrivateReader.getKnowledgeAssetPrivateTriples(input.contextGraphId, input.scope)).toEqual(privateQuads);
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
      expect(persistCatalogEntry).toHaveBeenCalledOnce();
    } finally { await input.store.close(); }
  });

  it('keeps the committed ordering fence after an interrupted equal-version metadata retry', async () => {
    const input = fixture();
    try {
      expect(await materialize(input)).toBe(true);
      vi.spyOn(input.privateStore, 'replaceKnowledgeAssetPrivateTriples').mockRejectedValueOnce(new Error('private retry failed'));
      await expect(materialize({ ...input,
        confirmedQuads: input.confirmedQuads.map(q => q.predicate.endsWith('accessPolicy')
          ? { ...q, object: '"ownerOnly"' } : q),
      })).rejects.toThrow('private retry failed');
      expect(await readMaterializedVersion(input.store, input.metaGraph, input.scope.ual)).toEqual(input.version);
      expect(await materialize({ ...input, version: { blockNumber: 9, txIndex: 9 },
        vmQuads: input.vmQuads.map(q => ({ ...q, object: '"stale after interrupted retry"' })),
      })).toBe(false);
      expect(await input.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${input.vmGraph}> { ?s ?p ?o } }`))
        .toMatchObject({ quads: [expect.objectContaining({ object: '"old"' })] });
      expect(input.persistCatalogEntry).toHaveBeenCalledOnce();
    } finally { await input.store.close(); }
  });

  it.each([{ blockNumber: 11, txIndex: 0 }, { blockNumber: 10, txIndex: 3 }])(
    'retains the newer chain ordering %j even at the same assertion version', async newer => {
      const input = fixture();
      try {
        const replacement = input.vmQuads.map(q => ({ ...q, object: '"new"' }));
        await input.store.insert(replacement);
        await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, newer);
        expect(await materialize(input)).toBe(false);
        expect(await input.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${input.vmGraph}> { ?s ?p ?o } }`))
          .toMatchObject({ type: 'quads', quads: [expect.objectContaining({ object: '"new"' })] });
        expect(input.persistCatalogEntry).not.toHaveBeenCalled();
      } finally { await input.store.close(); }
    },
  );

  it('waits for the existing per-KA lock before reading the version and writing any slice', async () => {
    const input = fixture();
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const precedingUpdate = withMaterializationLock(input.metaGraph, input.scope.ual, async () => {
      entered();
      await held;
      await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, { blockNumber: 11, txIndex: 0 });
    });
    await active;
    let settled = false;
    const publish = materialize(input).finally(() => { settled = true; });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(await input.store.countQuads(input.vmGraph)).toBe(0);
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
    } finally { release(); }
    try {
      await precedingUpdate;
      expect(await publish).toBe(false);
      expect(await input.store.countQuads(input.vmGraph)).toBe(0);
    } finally { await input.store.close(); }
  });

  it('refuses a store without atomic complete-graph replacement', async () => {
    const input = fixture();
    try {
      await input.store.insert(input.vmQuads);
      Reflect.set(input.store, 'replaceGraphAndSubject', undefined);
      Reflect.set(input.store, 'replaceGraph', undefined);
      await expect(materialize(input))
        .rejects.toMatchObject({ code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED', graphUri: input.vmGraph });
      expect(await input.store.countQuads(input.vmGraph)).toBe(1);
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
    } finally { await input.store.close(); }
  });

  it('does not stamp the materialized version or catalog after a failed public graph swap', async () => {
    const input = fixture();
    try {
      vi.spyOn(input.store, 'replaceGraphAndSubject').mockRejectedValue(new Error('swap failed'));
      await expect(materialize(input)).rejects.toThrow('swap failed');
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
      await expect(input.store.query(`ASK { GRAPH <${input.metaGraph}> {
        <${input.scope.ual}> <http://dkg.io/ontology/materializedVersion> ?v } }`))
        .resolves.toMatchObject({ type: 'boolean', value: false });
    } finally { await input.store.close(); }
  });
});
