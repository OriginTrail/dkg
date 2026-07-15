import { beforeEach, describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
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
  return { subject, predicate, object, graph: 'urn:input:placement-is-flattened' };
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

  it('refreshes only the deterministic curated catalog floor on a trusted SWM update', async () => {
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

    await publisher.updateKnowledgeAssetFromSharedMemory(initial.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 5,
      privateTripleCount: 0,
      trustedNonManifestCatalogTriples:
        generatedPrivateCatalogTripleKeys(CONTEXT_GRAPH),
    });

    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    expect(await store.countQuads(vmGraph)).toBe(5);
    const catalogRows = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${vmGraph}> {
         <did:dkg:context-graph:${CONTEXT_GRAPH}> ?p ?o
       } }`,
    );
    expect(catalogRows.type).toBe('bindings');
    if (catalogRows.type !== 'bindings') throw new Error('expected catalog bindings');
    expect(catalogRows.bindings).toHaveLength(4);
  });

  it('rejects legacy and incomplete mutation envelopes before writing', async () => {
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
