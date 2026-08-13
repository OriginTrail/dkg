import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createOperationContext,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computePrivateRootV10,
  generatedPrivateCatalogTripleKeys,
  skolemizeKnowledgeAsset,
} from '../src/index.js';

const CONTEXT_GRAPH = 'rootless-publish';
const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const UAL = `did:dkg:base:8453/${AUTHOR}/41`;

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

describe('graph-scoped KA publish storage', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
  });

  it('stores one exact VM graph with constant-size metadata and one private commitment', async () => {
    const publicQuads = [
      quad('urn:subject:one', 'urn:predicate:child', '_:child'),
      quad('_:child', 'urn:predicate:value', '"private-independent"'),
      quad('urn:subject:two', 'urn:predicate:value', '"ordinary RDF subject"'),
    ];
    const privateQuads = [
      quad('urn:private:one', 'urn:predicate:secret', '"alpha"'),
      quad('urn:private:two', 'urn:predicate:secret', '"beta"'),
    ];
    const canonicalPublic = await skolemizeKnowledgeAsset(publicQuads);
    const canonicalPrivate = await skolemizeKnowledgeAsset(privateQuads);
    const privateMerkleRoot = computePrivateRootV10(canonicalPrivate)!;

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: publicQuads,
      privateQuads,
      publisherPeerId: 'rootless-publisher',
      accessPolicy: 'ownerOnly',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: canonicalPublic.length,
      privateTripleCount: canonicalPrivate.length,
      privateMerkleRoot,
    });

    expect(result.status).toBe('tentative');
    expect(result.ual).toBe(UAL);
    expect(result.kaManifest).toEqual([]);
    expect(result.publicQuads).toEqual(canonicalPublic);

    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    expect(await store.countQuads(vmGraph)).toBe(canonicalPublic.length);

    const privateStore = (publisher as unknown as {
      privateStore: {
        knowledgeAssetPrivateGraphUri: (
          contextGraphId: string,
          scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
        ) => string;
        getKnowledgeAssetPrivateTriples: (
          contextGraphId: string,
          scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
        ) => Promise<Quad[]>;
      };
    }).privateStore;
    const privateGraph = privateStore.knowledgeAssetPrivateGraphUri(CONTEXT_GRAPH, scope);
    expect(await store.countQuads(privateGraph)).toBe(canonicalPrivate.length);
    expect(await privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope)).toEqual(
      canonicalPrivate,
    );

    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const metadata = await store.query(
      `CONSTRUCT { <${UAL}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${UAL}> ?p ?o } }`,
    );
    expect(metadata.type).toBe('quads');
    if (metadata.type !== 'quads') throw new Error('expected metadata quads');
    expect(metadata.quads.some((q) => q.predicate.endsWith('rootEntity'))).toBe(false);
    expect(metadata.quads.some((q) => q.predicate.endsWith('entity'))).toBe(false);
    expect(metadata.quads.some((q) => q.predicate.endsWith('tokenId'))).toBe(false);
    expect(metadata.quads.some((q) => q.predicate.endsWith('trustLevel'))).toBe(false);
    expect(metadata.quads.filter((q) => q.predicate.endsWith('privateMerkleRoot'))).toHaveLength(1);
    expect(metadata.quads.filter((q) => q.predicate.endsWith('assertionGraph'))).toEqual([
      expect.objectContaining({ object: vmGraph }),
    ]);
  });

  it('clears the exact SWM graph and its active recovery metadata after VM finalization', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const swmMetaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
    const head = `${UAL}#dkg-swm-head`;
    const operationId = 'rootless-finalized-cleanup';
    const operation = `urn:dkg:share:${CONTEXT_GRAPH}:${operationId}`;
    const unrelatedOperation = `urn:dkg:share:${CONTEXT_GRAPH}:unrelated`;
    await store.insert([
      { ...quad('urn:swm:data', 'urn:predicate:value', '"active"'), graph: swmGraph },
      { graph: swmMetaGraph, subject: head, predicate: 'http://dkg.io/ontology/kaUal', object: UAL },
      { graph: swmMetaGraph, subject: head, predicate: 'http://dkg.io/ontology/shareOperationId', object: `"${operationId}"` },
      { graph: swmMetaGraph, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: swmMetaGraph, subject: operation, predicate: 'http://dkg.io/ontology/kaUal', object: UAL },
      { graph: swmMetaGraph, subject: operation, predicate: 'http://dkg.io/ontology/shareOperationId', object: `"${operationId}"` },
      { graph: swmMetaGraph, subject: unrelatedOperation, predicate: 'http://dkg.io/ontology/shareOperationId', object: '"unrelated"' },
    ]);

    await publisher.clearPublishedKnowledgeAssetSwm(
      CONTEXT_GRAPH,
      {
        kind: 'named-lifecycle',
        identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
      },
      undefined,
      createOperationContext('test'),
      UAL,
    );

    expect(await store.countQuads(swmGraph)).toBe(0);
    await expect(store.query(`ASK { GRAPH <${swmMetaGraph}> { <${head}> ?p ?o } }`))
      .resolves.toMatchObject({ type: 'boolean', value: false });
    await expect(store.query(`ASK { GRAPH <${swmMetaGraph}> { <${operation}> ?p ?o } }`))
      .resolves.toMatchObject({ type: 'boolean', value: false });
    await expect(store.query(`ASK { GRAPH <${swmMetaGraph}> { <${unrelatedOperation}> ?p ?o } }`))
      .resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('removes dangling operation metadata when a prior cleanup already deleted the head', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const swmMetaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
    const operations = Array.from(
      { length: 18 },
      (_, index) => `urn:dkg:share:${CONTEXT_GRAPH}:partial-cleanup-${index}`,
    );
    const unrelatedOperation = `urn:dkg:share:${CONTEXT_GRAPH}:unrelated-partial-cleanup`;
    await store.insert([
      ...operations.flatMap((operation) => [
        { graph: swmMetaGraph, subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
        { graph: swmMetaGraph, subject: operation, predicate: 'http://dkg.io/ontology/kaUal', object: UAL },
      ]),
      { graph: swmMetaGraph, subject: unrelatedOperation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
      { graph: swmMetaGraph, subject: unrelatedOperation, predicate: 'http://dkg.io/ontology/kaUal', object: `did:dkg:base:8453/${AUTHOR}/42` },
    ]);

    await publisher.clearPublishedKnowledgeAssetSwm(
      CONTEXT_GRAPH,
      {
        kind: 'named-lifecycle',
        identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
      },
      undefined,
      createOperationContext('test'),
      UAL,
    );

    await expect(store.query(`ASK { GRAPH <${swmMetaGraph}> { ?operation <http://dkg.io/ontology/kaUal> <${UAL}> } }`))
      .resolves.toMatchObject({ type: 'boolean', value: false });
    await expect(store.query(`ASK { GRAPH <${swmMetaGraph}> { <${unrelatedOperation}> ?p ?o } }`))
      .resolves.toMatchObject({ type: 'boolean', value: true });
  });

  it('replaces the complete VM graph and preserves the prior version on failed swap', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const initial = [quad('urn:version:one', 'urn:predicate:value', '"one"')];
    const initialResult = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: initial,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });

    const realReplace = store.replaceGraph?.bind(store);
    store.replaceGraph = async (graphUri, quads, options) => {
      if (graphUri === vmGraph) throw new Error('injected VM replacement failure');
      if (!realReplace) throw new Error('replaceGraph unavailable');
      return realReplace(graphUri, quads, options);
    };
    await expect(
      publisher.update(initialResult.kaId, {
        contextGraphId: CONTEXT_GRAPH,
        quads: [quad('urn:version:two', 'urn:predicate:value', '"two"')],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 2,
        publicTripleCount: 1,
      }),
    ).rejects.toThrow('injected VM replacement failure');
    const preserved = await store.query(
      `SELECT ?s WHERE { GRAPH <${vmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(preserved.type).toBe('bindings');
    if (preserved.type !== 'bindings') throw new Error('expected bindings');
    expect(preserved.bindings).toEqual([{ s: 'urn:version:one' }]);

    store.replaceGraph = realReplace;
    const updateResult = await publisher.update(initialResult.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:version:two', 'urn:predicate:value', '"two"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 1,
    });
    expect(updateResult.ual).toBe(UAL);
    expect(updateResult.kaManifest).toEqual([]);
    const replaced = await store.query(
      `SELECT ?s WHERE { GRAPH <${vmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(replaced.type).toBe('bindings');
    if (replaced.type !== 'bindings') throw new Error('expected bindings');
    expect(replaced.bindings).toEqual([{ s: 'urn:version:two' }]);
  });

  it.each([
    ['ownerOnly' as const, undefined],
    ['allowList' as const, ['peer-a', 'peer-b']],
  ])('inherits %s access metadata on originator updates', async (accessPolicy, allowedPeers) => {
    const initial = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:access:data', 'urn:predicate:value', '"old"')],
      publisherPeerId: 'original-peer',
      accessPolicy,
      ...(allowedPeers ? { allowedPeers } : {}),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });

    await publisher.update(initial.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:access:data', 'urn:predicate:value', '"new"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 1,
    });

    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    const rows = await store.query(
      `SELECT ?policy ?peer ?publisher WHERE { GRAPH <${metaGraph}> {
         <${UAL}> <http://dkg.io/ontology/accessPolicy> ?policy ;
           <http://dkg.io/ontology/publisherPeerId> ?publisher .
         OPTIONAL { <${UAL}> <http://dkg.io/ontology/allowedPeer> ?peer }
       } }`,
    );
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('expected access metadata bindings');
    expect(new Set(rows.bindings.map((row) => row.policy))).toEqual(new Set([`"${accessPolicy}"`]));
    expect(new Set(rows.bindings.map((row) => row.publisher))).toEqual(new Set(['"original-peer"']));
    expect(new Set(rows.bindings.map((row) => row.peer).filter(Boolean))).toEqual(
      new Set(allowedPeers?.map((peer) => `"${peer}"`) ?? []),
    );
  });

  it('updates a fully private KA from SWM without requiring a public placeholder', async () => {
    const initialPrivate = [
      quad('urn:private:only', 'urn:predicate:secret', '"one"'),
    ];
    const canonicalInitial = await skolemizeKnowledgeAsset(initialPrivate);
    const initial = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [],
      privateQuads: initialPrivate,
      publisherPeerId: 'rootless-private-publisher',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 0,
      privateTripleCount: canonicalInitial.length,
      privateMerkleRoot: computePrivateRootV10(canonicalInitial),
    });
    const replacementPrivate = [
      quad('urn:private:only', 'urn:predicate:secret', '"two"'),
      quad('urn:private:second', 'urn:predicate:secret', '"three"'),
    ];
    const canonicalReplacement = await skolemizeKnowledgeAsset(replacementPrivate);

    const updated = await publisher.updateKnowledgeAssetFromSharedMemory(initial.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      privateQuads: replacementPrivate,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 0,
      privateTripleCount: canonicalReplacement.length,
      privateMerkleRoot: computePrivateRootV10(canonicalReplacement),
    });

    expect(updated.status).toBe('tentative');
    expect(updated.publicQuads).toEqual([]);
    const privateStore = (publisher as unknown as {
      privateStore: {
        getKnowledgeAssetPrivateTriples: (
          contextGraphId: string,
          scope: ReturnType<typeof createGraphKnowledgeAssetScope>,
        ) => Promise<Quad[]>;
      };
    }).privateStore;
    expect(await privateStore.getKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      createGraphKnowledgeAssetScope(UAL, 2),
    )).toEqual(canonicalReplacement);
  });

  it('keeps the deterministic curated catalog floor out of a trusted SWM update graph', async () => {
    const initial = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:curated:data', 'urn:predicate:value', '"old"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });
    const scope = createGraphKnowledgeAssetScope(UAL, 2);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    await store.insert([{
      ...quad('urn:curated:data', 'urn:predicate:value', '"new"'),
      graph: swmGraph,
    }]);

    const updated = await publisher.updateKnowledgeAssetFromSharedMemory(initial.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 1,
      privateTripleCount: 0,
      trustedNonManifestCatalogTriples:
        generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
    });

    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    expect(updated.publicQuads).toEqual([
      expect.objectContaining({
        subject: 'urn:curated:data',
        predicate: 'urn:predicate:value',
        object: '"new"',
      }),
    ]);
    expect(await store.countQuads(vmGraph)).toBe(1);
    const catalogRows = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${vmGraph}> {
         <did:dkg:context-graph:${CONTEXT_GRAPH}> ?p ?o
       } }`,
    );
    expect(catalogRows.type).toBe('bindings');
    if (catalogRows.type !== 'bindings') throw new Error('expected catalog bindings');
    expect(catalogRows.bindings).toHaveLength(0);
  });

  it('rejects graph-scoped identity conflicts before planner or storage work', async () => {
    const expectedPackedKaId = (BigInt(AUTHOR) << 96n) | 41n;
    const payload = [quad('urn:conflict', 'urn:predicate:value', '"conflict"')];
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const plannerPrepare = vi.spyOn(
      (publisher as unknown as {
        publisherPlanner: { prepare: (...args: unknown[]) => Promise<unknown> };
      }).publisherPlanner,
      'prepare',
    );
    const ensureContextGraph = vi.spyOn(
      (publisher as unknown as {
        graphManager: { ensureContextGraph: (...args: unknown[]) => Promise<unknown> };
      }).graphManager,
      'ensureContextGraph',
    );

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: payload,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: 1,
        reservedKaId: expectedPackedKaId + 1n,
      }),
    ).rejects.toThrow(/derives packed kaId/);
    expect(plannerPrepare).not.toHaveBeenCalled();
    expect(ensureContextGraph).not.toHaveBeenCalled();
    expect(await store.hasGraph(vmGraph)).toBe(false);

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: payload,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: 1,
        precomputedAttestation: {
          expectedMerkleRoot: new Uint8Array(32),
          authorAddress: '0x000000000000000000000000000000000000dEaD',
          signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
          schemeVersion: 1,
          reservedKaId: expectedPackedKaId,
        },
      }),
    ).rejects.toThrow(/does not match/);
    expect(plannerPrepare).not.toHaveBeenCalled();
    expect(ensureContextGraph).not.toHaveBeenCalled();
    expect(await store.hasGraph(vmGraph)).toBe(false);

    const accepted = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: payload,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
      reservedKaId: expectedPackedKaId,
    });
    expect(accepted.ual).toBe(UAL);
    expect(plannerPrepare).toHaveBeenCalledTimes(1);
    expect(ensureContextGraph).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy and incomplete mutation envelopes before writing', async () => {
    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [{
          ...quad('urn:named', 'urn:predicate:value', '"named"'),
          graph: 'urn:user:named-graph',
        }],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: 1,
      }),
    ).rejects.toMatchObject({ code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED' });

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [quad('urn:legacy', 'urn:predicate:value', '"legacy"')],
        contentScopeVersion: 1,
        publicTripleCount: 1,
      }),
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });

    await expect(
      publisher.publish({
        contextGraphId: CONTEXT_GRAPH,
        quads: [quad('urn:partial', 'urn:predicate:value', '"partial"')],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        publicTripleCount: 1,
      }),
    ).rejects.toThrow(/requires kaUal and assertionVersion/);
  });
});
