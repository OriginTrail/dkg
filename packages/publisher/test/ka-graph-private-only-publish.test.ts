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
import { OxigraphStore, PrivateContentStore, GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computePrivateRootV10,
  skolemizeKnowledgeAsset,
} from '../src/index.js';

const CONTEXT_GRAPH = 'rootless-private-only';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const AUTHOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const UAL = `did:dkg:base:8453/${AUTHOR}/55`;

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

/**
 * Fully private (zero-public) graph-scoped KAs through the REAL publisher
 * paths — no stubbing of publishFromSharedMemory/update. Guards against a
 * regression that reinstates an unconditional empty-public rejection, which
 * would make private-only KAs unpublishable and un-updatable locally.
 * (The V10 on-chain ACK path for zero public leaves remains a separate open
 * protocol question — see PR #1713 review.)
 */
describe('fully private graph-scoped KA publish/update (real paths)', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;
  let privateStore: PrivateContentStore;

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    privateStore = new PrivateContentStore(store, new GraphManager(store));
  });

  it('publishes a private-only KA from shared memory through the real path', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const canonicalPrivate = await skolemizeKnowledgeAsset([
      quad('urn:private:only', 'urn:predicate:secret', '"nothing public here"'),
    ]);
    const privateMerkleRoot = computePrivateRootV10(canonicalPrivate)!;
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      canonicalPrivate,
    );

    const result = await publisher.publishFromSharedMemory(CONTEXT_GRAPH, 'all', {
      sharedMemoryScope: {
        kind: 'named-lifecycle',
        identity: { agentAddress: scope.agentAddress, kaNumber: BigInt(scope.kaNumber) },
      },
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 0,
      privateTripleCount: 1,
      privateMerkleRoot,
      publisherPeerId: 'rootless-publisher', // private content defaults to ownerOnly
    });

    expect(result.ual).toBe(UAL);
    expect(result.status).toBe('tentative');
    expect(result.publicQuads).toEqual([]);
    expect(result.kaManifest).toEqual([]);

    const meta = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${META_GRAPH}> { <${UAL}> ?p ?o } }`,
    );
    expect(meta.type).toBe('bindings');
    if (meta.type !== 'bindings') throw new Error('expected bindings');
    const rows = new Map(meta.bindings.map((b) => [b['p'], b['o']]));
    expect(rows.get('http://dkg.io/ontology/publicTripleCount')).toContain('"0"');
    expect(rows.get('http://dkg.io/ontology/privateTripleCount')).toContain('"1"');
    expect(rows.get('http://dkg.io/ontology/privateMerkleRoot'))
      .toContain(Buffer.from(privateMerkleRoot).toString('hex'));
    expect(
      await privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope),
    ).toEqual(canonicalPrivate);
  });

  it('updates a KA to fully private content through the real update path', async () => {
    const v1Public = [quad('urn:public:v1', 'urn:predicate:value', '"public v1"')];
    const first = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: v1Public,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });

    const canonicalPrivate = await skolemizeKnowledgeAsset([
      quad('urn:private:v2', 'urn:predicate:secret', '"went dark"'),
    ]);
    const privateMerkleRoot = computePrivateRootV10(canonicalPrivate)!;
    const updated = await publisher.update(first.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      quads: [],
      privateQuads: canonicalPrivate,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 0,
      privateTripleCount: 1,
      privateMerkleRoot,
    });
    expect(updated.ual).toBe(UAL);

    // The public-to-private-only transition must remove the public VM graph
    // content while the v2 private commitment becomes readable.
    const scope2 = createGraphKnowledgeAssetScope(UAL, 2);
    const vmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope2,
    );
    expect(await store.countQuads(vmGraph)).toBe(0);
    expect(
      await privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope2),
    ).toEqual(canonicalPrivate);

    const meta = await store.query(
      `SELECT ?o WHERE { GRAPH <${META_GRAPH}> { <${UAL}> <http://dkg.io/ontology/assertionVersion> ?o } }`,
    );
    expect(meta.type).toBe('bindings');
    if (meta.type !== 'bindings') throw new Error('expected bindings');
    // NB: exact one-row convergence is pinned by #1712's regression test (the
    // stale-row fix lands there and reaches this branch on restack); here we
    // only require the new head version to be recorded.
    expect(meta.bindings.map((b) => b['o'])).toContainEqual(
      expect.stringContaining('"2"'),
    );
  });

  it('updateKnowledgeAssetFromSharedMemory accepts a private-only envelope with empty SWM', async () => {
    const first = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [quad('urn:public:v1', 'urn:predicate:value', '"public v1"')],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 1,
    });

    const canonicalPrivate = await skolemizeKnowledgeAsset([
      quad('urn:private:v2', 'urn:predicate:secret', '"swm has no public rows"'),
    ]);
    const privateMerkleRoot = computePrivateRootV10(canonicalPrivate)!;

    // Regression: this used to throw "No quads in shared memory" for every
    // fully private KA, because zero public SWM rows were treated as an error
    // regardless of the private partition.
    const updated = await publisher.updateKnowledgeAssetFromSharedMemory(first.kaId, {
      contextGraphId: CONTEXT_GRAPH,
      privateQuads: canonicalPrivate,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 2,
      publicTripleCount: 0,
      privateTripleCount: 1,
      privateMerkleRoot,
    });
    expect(updated.ual).toBe(UAL);
    expect(
      await privateStore.getKnowledgeAssetPrivateTriples(
        CONTEXT_GRAPH,
        createGraphKnowledgeAssetScope(UAL, 2),
      ),
    ).toEqual(canonicalPrivate);

    // Fail-closed stays: an envelope PROMISING public content that shared
    // memory does not hold is still rejected.
    await expect(
      publisher.updateKnowledgeAssetFromSharedMemory(first.kaId, {
        contextGraphId: CONTEXT_GRAPH,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 3,
        publicTripleCount: 2,
        privateTripleCount: 1,
        privateMerkleRoot,
      }),
    ).rejects.toThrow(/No quads in shared memory/);
  });
});
