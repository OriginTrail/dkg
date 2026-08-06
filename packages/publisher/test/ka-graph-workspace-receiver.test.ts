import { describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  encodeWorkspacePublishRequest,
  knowledgeAssetLayerGraphUri,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';
import { SharedMemoryHandler } from '../src/workspace-handler.js';

const CONTEXT_GRAPH = 'rootless-receiver';
const PEER_ID = '12D3KooWGraphScopedPeer';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
const AGENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const DATA_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

function nquad(subject: string, value: string): string {
  return `<${subject}> <urn:predicate:value> "${value}" <${DATA_GRAPH}> .`;
}

function v2Request(
  overrides: Partial<WorkspacePublishRequestMsg> = {},
): Uint8Array {
  const nquads = overrides.nquads ?? new TextEncoder().encode(nquad('urn:entity:1', 'one'));
  return encodeWorkspacePublishRequest({
    contextGraphId: CONTEXT_GRAPH,
    nquads,
    manifest: [],
    publisherPeerId: PEER_ID,
    shareOperationId: 'rootless-op-1',
    timestampMs: Date.now(),
    agentAddress: AGENT,
    kaNumber: '7',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    ...overrides,
  });
}

async function graphCount(store: OxigraphStore, graph: string): Promise<number> {
  return store.countQuads(graph);
}

describe('SharedMemoryHandler graph-scoped KA receiver', () => {
  it('stores 1,000 subjects as one exact KA graph with constant-size metadata', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const lines = Array.from({ length: 1_000 }, (_, index) =>
      nquad(`urn:entity:${index}`, String(index))
    ).join('\n');

    const outcome = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(lines),
      publicTripleCount: 1_000,
    }), PEER_ID);

    expect(outcome.applied).toBe(true);
    if (!outcome.applied) throw new Error(outcome.reason);
    expect(outcome.assetUal).toBe(UAL);
    expect(outcome.insertedTriples).toBe(1_000);

    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    expect(await graphCount(store, swmGraph)).toBe(1_000);
    expect(await graphCount(store, graphManager.sharedMemoryUri(CONTEXT_GRAPH))).toBe(0);

    // #2079: a gossip apply REPLACES this graph, under the same
    // `swmKaWriteLockKey` the catch-up materializer uses. The catch-up count
    // gate cannot see a replace, so this path must drop the memo itself —
    // otherwise a TORN apply (graph replaced, head write throws) leaves
    // catch-up certifying the OLD digest against NEW content.
    //
    // Seeded after the apply and re-applied, rather than building a torn-apply
    // rig: the property under test is simply "the apply path invalidates", and
    // deleting that call must fail this.

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const meta = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(meta.type).toBe('quads');
    if (meta.type !== 'quads') throw new Error('expected metadata quads');
    expect(meta.quads).toHaveLength(19);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('rootEntity'))).toBe(false);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('workspaceOwner'))).toBe(false);
    expect(meta.quads.some(
      (quad) => quad.predicate.endsWith('accessPolicy') && quad.object === '"public"',
    )).toBe(true);
    // The current-head fence points at the immutable operation, so the digest
    // and private commitment are stored only once.
    expect(meta.quads.filter((quad) => quad.predicate.endsWith('publicQuadsDigest'))).toHaveLength(1);
  });

  it('drops the catch-up materialization witness when it replaces the graph (#2079)', async () => {
    // A gossip apply REPLACES this graph under the same `swmKaWriteLockKey` the
    // catch-up materializer uses. Catch-up's count gate cannot see a replace
    // (the count can be unchanged), so this path must drop the memo itself —
    // otherwise a TORN apply (graph replaced, head write throws) leaves
    // catch-up certifying the OLD digest against NEW content.
    //
    // Its own test rather than an assertion bolted onto another: the second
    // apply below adds metadata, which would break sibling assertions about
    // final meta state.
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request(), PEER_ID)).applied).toBe(true);

    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    await writeSwmMaterializationWitness(store, swmGraph, 'sha256:stale-witness');
    expect(await readSwmMaterializationWitness(store, swmGraph, 'sha256:stale-witness')).toBe(true);

    // A genuinely NEW version, not a replay: an identical request is fenced by
    // durable metadata and never reaches the replace, so it would prove nothing.
    // All versions of a graph-scoped KA share one assertion graph, so this
    // replaces exactly the graph the witness was seeded against.
    const replacement = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:2', 'two')),
      shareOperationId: 'rootless-op-witness',
      assertionVersion: '2',
    }), PEER_ID);
    expect(replacement.applied).toBe(true);

    expect(await readSwmMaterializationWitness(store, swmGraph, 'sha256:stale-witness')).toBe(false);
  });

  it('stores canonical Markdown section entities received over SWM', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const document = 'urn:document:construction-notes';
    const section = 'urn:dkg:ka-skolem:c14n0';
    const lines = [
      `<${document}> <http://dkg.io/ontology/hasSection> <${section}> <${DATA_GRAPH}> .`,
      `<${section}> <http://schema.org/name> "Safety" <${DATA_GRAPH}> .`,
    ].join('\n');

    const outcome = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(lines),
      publicTripleCount: 2,
      shareOperationId: 'rootless-markdown-op',
    }), PEER_ID);

    expect(outcome.applied).toBe(true);
    if (!outcome.applied) throw new Error(outcome.reason);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    const rows = await store.query(
      `SELECT ?section ?name WHERE { GRAPH <${swmGraph}> {
        <${document}> <http://dkg.io/ontology/hasSection> ?section .
        ?section <http://schema.org/name> ?name .
      } }`,
    );
    expect(rows).toMatchObject({
      type: 'bindings',
      bindings: [{ section, name: '"Safety"' }],
    });
  });

  it('replaces the whole KA graph without leaving prior subjects behind', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request(), PEER_ID)).applied).toBe(true);

    const replacement = v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:2', 'two')),
      shareOperationId: 'rootless-op-2',
      assertionVersion: '2',
    });
    expect((await handler.handle(replacement, PEER_ID)).applied).toBe(true);

    const scope = createGraphKnowledgeAssetScope(UAL, 2);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const rows = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${swmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('expected bindings');
    expect(rows.bindings).toEqual([{ s: 'urn:entity:2', o: '"two"' }]);

    // A new handler instance proves that replay/version fencing comes from
    // durable metadata rather than the prior process's in-memory state.
    const restartedHandler = new SharedMemoryHandler(store, new TypedEventBus());
    const replay = await restartedHandler.handle(replacement, PEER_ID);
    expect(replay.applied).toBe(true);

    const stale = await restartedHandler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:stale', 'stale')),
      shareOperationId: 'rootless-op-stale',
      assertionVersion: '1',
    }), PEER_ID);
    expect(stale.applied).toBe(false);
    if (stale.applied) throw new Error('unreachable');
    expect(stale.retryable).toBe(false);
    expect(stale.reason).toContain('STALE_KA_ASSERTION_VERSION');

    const conflict = await restartedHandler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:conflict', 'conflict')),
      shareOperationId: 'rootless-op-conflict',
      assertionVersion: '2',
    }), PEER_ID);
    expect(conflict.applied).toBe(false);
    if (conflict.applied) throw new Error('unreachable');
    expect(conflict.retryable).toBe(false);
    expect(conflict.reason).toContain('CONFLICTING_KA_ASSERTION_VERSION');

    const stillCurrent = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${swmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(stillCurrent.type).toBe('bindings');
    if (stillCurrent.type !== 'bindings') throw new Error('expected bindings');
    expect(stillCurrent.bindings).toEqual([{ s: 'urn:entity:2', o: '"two"' }]);
  });

  it('persists the access envelope and rejects same-version policy drift after restart', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const request = v2Request({
      accessPolicy: 'allowList',
      allowedPeers: [' peer-b ', 'peer-a', 'peer-b'],
    });
    expect((await handler.handle(request, PEER_ID)).applied).toBe(true);

    const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH);
    const envelope = await store.query(
      `SELECT ?policy ?peer WHERE { GRAPH <${metaGraph}> {
        ?operation <http://dkg.io/ontology/shareOperationId> "rootless-op-1" ;
          <http://dkg.io/ontology/accessPolicy> ?policy .
        OPTIONAL { ?operation <http://dkg.io/ontology/allowedPeer> ?peer }
      } } ORDER BY ?peer`,
    );
    expect(envelope.type).toBe('bindings');
    if (envelope.type !== 'bindings') throw new Error('expected access-envelope bindings');
    expect(envelope.bindings).toEqual([
      { policy: '"allowList"', peer: '"peer-a"' },
      { policy: '"allowList"', peer: '"peer-b"' },
    ]);

    const restarted = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await restarted.handle(v2Request({
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a', 'peer-b'],
    }), PEER_ID)).applied).toBe(true);

    const drift = await restarted.handle(v2Request({
      accessPolicy: 'ownerOnly',
      allowedPeers: [],
    }), PEER_ID);
    expect(drift).toMatchObject({ applied: false, retryable: false });
    if (drift.applied) throw new Error('expected policy-drift rejection');
    expect(drift.reason).toContain('CONFLICTING_KA_ASSERTION_VERSION');
  });

  it('keeps one KA-level transport owner across assertion versions', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request(), PEER_ID)).applied).toBe(true);

    const attackerPeer = '12D3KooWGraphScopedAttacker';
    const rejected = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:attacker:replacement', 'bad')),
      publisherPeerId: attackerPeer,
      shareOperationId: 'rootless-attacker-op',
      assertionVersion: '2',
    }), attackerPeer);
    expect(rejected).toMatchObject({ applied: false, retryable: false });
    if (rejected.applied) throw new Error('expected ownership rejection');
    expect(rejected.reason).toContain('KA_PUBLISHER_MISMATCH');

    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const rows = await store.query(
      `SELECT ?s WHERE { GRAPH <${swmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('expected bindings');
    expect(rows.bindings).toEqual([{ s: 'urn:entity:1' }]);
  });

  it('keeps the prior complete graph when the atomic swap fails, then recovers on retry', async () => {
    const store = new OxigraphStore();
    const initialHandler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await initialHandler.handle(v2Request(), PEER_ID)).applied).toBe(true);

    const replacement = v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:2', 'two')),
      shareOperationId: 'rootless-op-atomic-retry',
      assertionVersion: '2',
    });
    const originalReplaceGraph = store.replaceGraph.bind(store);
    store.replaceGraph = async (): Promise<void> => {
      throw new Error('simulated atomic swap failure');
    };
    const failingHandler = new SharedMemoryHandler(store, new TypedEventBus());
    const failed = await failingHandler.handle(replacement, PEER_ID);
    expect(failed.applied).toBe(false);
    if (failed.applied) throw new Error('unreachable');
    expect(failed.retryable).toBe(true);
    expect(failed.reason).toContain('simulated atomic swap failure');

    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const swmGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const beforeRetry = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${swmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(beforeRetry.type).toBe('bindings');
    if (beforeRetry.type !== 'bindings') throw new Error('expected bindings');
    expect(beforeRetry.bindings).toEqual([{ s: 'urn:entity:1', o: '"one"' }]);

    store.replaceGraph = originalReplaceGraph;
    const recovered = await new SharedMemoryHandler(
      store,
      new TypedEventBus(),
    ).handle(replacement, PEER_ID);
    expect(recovered.applied).toBe(true);
    const afterRetry = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${swmGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(afterRetry.type).toBe('bindings');
    if (afterRetry.type !== 'bindings') throw new Error('expected bindings');
    expect(afterRetry.bindings).toEqual([{ s: 'urn:entity:2', o: '"two"' }]);
  });

  it('accepts a fully private KA with an empty public graph', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const privateRoot = Uint8Array.from({ length: 32 }, (_, index) => index);
    const outcome = await handler.handle(v2Request({
      nquads: new Uint8Array(),
      publicTripleCount: 0,
      privateMerkleRoot: privateRoot,
      privateTripleCount: 12,
      shareOperationId: 'rootless-private-only',
    }), PEER_ID);

    expect(outcome.applied).toBe(true);
    const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH);
    const privateRows = await store.query(
      `SELECT ?root ?count WHERE { GRAPH <${metaGraph}> {
        ?op <http://dkg.io/ontology/privateMerkleRoot> ?root ;
          <http://dkg.io/ontology/privateTripleCount> ?count .
      } }`,
    );
    expect(privateRows.type).toBe('bindings');
    if (privateRows.type !== 'bindings') throw new Error('expected bindings');
    expect(privateRows.bindings).toEqual([{
      root: `"0x${Buffer.from(privateRoot).toString('hex')}"`,
      count: '"12"^^<http://www.w3.org/2001/XMLSchema#integer>',
    }]);
  });

  it('permanently rejects legacy and mixed root-manifest writes', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const legacy = encodeWorkspacePublishRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(nquad('urn:legacy:1', 'legacy')),
      manifest: [{ rootEntity: 'urn:legacy:1', privateTripleCount: 0 }],
      publisherPeerId: PEER_ID,
      shareOperationId: 'legacy-op',
      timestampMs: Date.now(),
    });
    const legacyOutcome = await handler.handle(legacy, PEER_ID);
    expect(legacyOutcome.applied).toBe(false);
    if (legacyOutcome.applied) throw new Error('unreachable');
    expect(legacyOutcome.retryable).toBe(false);
    expect(legacyOutcome.reason).toContain('LEGACY_KA_READ_ONLY');

    const mixedOutcome = await handler.handle(v2Request({
      manifest: [{ rootEntity: 'urn:legacy:1', privateTripleCount: 0 }],
      shareOperationId: 'mixed-op',
    }), PEER_ID);
    expect(mixedOutcome.applied).toBe(false);
    if (mixedOutcome.applied) throw new Error('unreachable');
    expect(mixedOutcome.retryable).toBe(false);
    expect(mixedOutcome.reason).toContain('MIXED_KA_CONTENT_SCOPE');
  });

  it('permanently rejects identity, count, blank-node, and private-commitment mismatches', async () => {
    const cases: Array<[string, Partial<WorkspacePublishRequestMsg>, string]> = [
      ['identity', { kaNumber: '8' }, 'conflicts with kaUal'],
      ['count', { publicTripleCount: 2 }, 'public triple count mismatch'],
      [
        'blank',
        {
          nquads: new TextEncoder().encode(
            `_:b0 <urn:predicate:value> "blank" <${DATA_GRAPH}> .`,
          ),
        },
        'blank-node subject',
      ],
      [
        'forged-skolem',
        {
          nquads: new TextEncoder().encode(
            `<urn:dkg:ka-skolem:attacker> <urn:predicate:value> "forged" <${DATA_GRAPH}> .`,
          ),
        },
        'reserved KA skolem namespace',
      ],
      [
        'private',
        { privateTripleCount: 1, privateMerkleRoot: new Uint8Array([1, 2, 3]) },
        '32-byte privateMerkleRoot',
      ],
    ];

    for (const [name, override, expectedReason] of cases) {
      const store = new OxigraphStore();
      const handler = new SharedMemoryHandler(store, new TypedEventBus());
      const outcome = await handler.handle(v2Request({
        ...override,
        shareOperationId: `invalid-${name}`,
      }), PEER_ID);
      expect(outcome.applied, name).toBe(false);
      if (outcome.applied) throw new Error('unreachable');
      expect(outcome.retryable, name).toBe(false);
      expect(outcome.reason, name).toContain(expectedReason);
    }
  });
});
