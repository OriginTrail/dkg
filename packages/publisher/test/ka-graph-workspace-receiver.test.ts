import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  DKGEvent,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  computeGossipSigningPayload,
  createGraphKnowledgeAssetScope,
  encodeGossipEnvelope,
  encodeWorkspacePublishRequest,
  knowledgeAssetLayerGraphUri,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
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

async function signV2Request(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  payload: Uint8Array,
  claimedAgentAddress = wallet.address,
): Promise<Uint8Array> {
  const timestamp = new Date().toISOString();
  const signingPayload = computeGossipSigningPayload(
    GOSSIP_TYPE_WORKSPACE_PUBLISH,
    CONTEXT_GRAPH,
    timestamp,
    payload,
  );
  const signature = await wallet.signMessage(signingPayload);
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: CONTEXT_GRAPH,
    agentAddress: claimedAgentAddress,
    timestamp,
    signature: ethers.getBytes(signature),
    payload,
  });
}

function swmGraphFor(version: number | string, subGraphName?: string): string {
  return knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(UAL, version),
    subGraphName,
  );
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

    const metaGraph = graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH);
    const meta = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    expect(meta.type).toBe('quads');
    if (meta.type !== 'quads') throw new Error('expected metadata quads');
    expect(meta.quads).toHaveLength(18);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('rootEntity'))).toBe(false);
    expect(meta.quads.some((quad) => quad.predicate.endsWith('workspaceOwner'))).toBe(false);
    // The current-head fence points at the immutable operation, so the digest
    // and private commitment are stored only once.
    expect(meta.quads.filter((quad) => quad.predicate.endsWith('publicQuadsDigest'))).toHaveLength(1);
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

  it('permanently rejects an empty graph-scoped write without touching prior state', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());

    // Fresh store: an empty first write must not create any durable state.
    const emptyFirst = await handler.handle(v2Request({
      nquads: new Uint8Array(),
      publicTripleCount: 0,
      privateTripleCount: 0,
      shareOperationId: 'rootless-op-empty-first',
    }), PEER_ID);
    expect(emptyFirst.applied).toBe(false);
    if (emptyFirst.applied) throw new Error('unreachable');
    expect(emptyFirst.retryable).toBe(false);
    expect(emptyFirst.reason).toContain('EMPTY_KA_CONTENT');
    const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH);
    expect(await graphCount(store, metaGraph)).toBe(0);

    // Established KA: an empty "update" must not clear the live graph or
    // corrupt the head (the destructive-clear-then-reject ordering bug).
    const original = v2Request();
    expect((await handler.handle(original, PEER_ID)).applied).toBe(true);
    const emptyUpdate = await handler.handle(v2Request({
      nquads: new Uint8Array(),
      publicTripleCount: 0,
      privateTripleCount: 0,
      shareOperationId: 'rootless-op-empty-update',
      assertionVersion: '2',
    }), PEER_ID);
    expect(emptyUpdate.applied).toBe(false);
    if (emptyUpdate.applied) throw new Error('unreachable');
    expect(emptyUpdate.retryable).toBe(false);
    expect(emptyUpdate.reason).toContain('EMPTY_KA_CONTENT');

    expect(await graphCount(store, swmGraphFor(1))).toBe(1);
    // The head is still resolvable and current: an exact replay of the
    // original write acknowledges instead of throwing on a corrupt head.
    const replay = await handler.handle(original, PEER_ID);
    expect(replay.applied).toBe(true);
  });

  it('rejects shareOperationId reuse across different KAs and keeps the first head healthy', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const first = v2Request();
    expect((await handler.handle(first, PEER_ID)).applied).toBe(true);

    const otherUal = `did:dkg:base:8453/${AGENT}/8`;
    const reuse = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:other', 'other')),
      kaUal: otherUal,
      kaNumber: '8',
      // Same shareOperationId as the first KA's operation.
    }), PEER_ID);
    expect(reuse.applied).toBe(false);
    if (reuse.applied) throw new Error('unreachable');
    expect(reuse.retryable).toBe(false);
    expect(reuse.reason).toContain('SHARE_OPERATION_ID_REUSE');

    // First KA's operation metadata and head survived: the exact replay is
    // acknowledged instead of failing on a corrupt or rebound head.
    const replay = await handler.handle(first, PEER_ID);
    expect(replay.applied).toBe(true);

    // The other KA applies cleanly under its own operation id.
    const fresh = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:other', 'other')),
      kaUal: otherUal,
      kaNumber: '8',
      shareOperationId: 'rootless-op-other',
    }), PEER_ID);
    expect(fresh.applied).toBe(true);
  });

  it('permanently rejects payloads carrying duplicate quads', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const line = nquad('urn:entity:dup', 'same');
    const outcome = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(`${line}\n${line}`),
      publicTripleCount: 2,
      shareOperationId: 'rootless-op-dup',
    }), PEER_ID);
    expect(outcome.applied).toBe(false);
    if (outcome.applied) throw new Error('unreachable');
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain('duplicates an earlier quad');
  });

  it('acknowledges an exact replay with zero inserted triples and no change events', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    let memoryGraphChanges = 0;
    bus.on(DKGEvent.MEMORY_GRAPH_CHANGED, () => {
      memoryGraphChanges += 1;
    });
    const handler = new SharedMemoryHandler(store, bus);
    const message = v2Request();

    const first = await handler.handle(message, PEER_ID);
    expect(first.applied).toBe(true);
    if (!first.applied) throw new Error('unreachable');
    expect(first.insertedTriples).toBe(1);
    expect(memoryGraphChanges).toBe(1);

    const replay = await handler.handle(message, PEER_ID);
    expect(replay.applied).toBe(true);
    if (!replay.applied) throw new Error('unreachable');
    // Nothing was written: replay reports zero inserts and emits no
    // MEMORY_GRAPH_CHANGED, so downstream aggregation and cache
    // invalidation see a mutation only when one happened.
    expect(replay.insertedTriples).toBe(0);
    expect(memoryGraphChanges).toBe(1);
  });

  it('isolates graph-scoped data and heads per sub-graph', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request(), PEER_ID)).applied).toBe(true);

    // Same KA and assertion version into a named sub-graph: the write and its
    // head fence live in the sub-graph's buckets, so it must apply instead of
    // colliding with the default bucket's version fence.
    const teamWrite = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:team', 'team')),
      subGraphName: 'team-a',
      shareOperationId: 'rootless-op-team',
    }), PEER_ID);
    expect(teamWrite.applied).toBe(true);

    const defaultGraph = swmGraphFor(1);
    const teamGraph = swmGraphFor(1, 'team-a');
    expect(teamGraph).not.toBe(defaultGraph);
    const teamRows = await store.query(
      `SELECT ?s WHERE { GRAPH <${teamGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(teamRows.type).toBe('bindings');
    if (teamRows.type !== 'bindings') throw new Error('expected bindings');
    expect(teamRows.bindings).toEqual([{ s: 'urn:entity:team' }]);
    const defaultRows = await store.query(
      `SELECT ?s WHERE { GRAPH <${defaultGraph}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(defaultRows.type).toBe('bindings');
    if (defaultRows.type !== 'bindings') throw new Error('expected bindings');
    expect(defaultRows.bindings).toEqual([{ s: 'urn:entity:1' }]);

    // Each bucket's head points at its own operation.
    const headSubject = `${UAL}#dkg-swm-head`;
    for (const [metaGraph, expectedOp] of [
      [graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH), 'rootless-op-1'],
      [graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH, 'team-a'), 'rootless-op-team'],
    ] as const) {
      const head = await store.query(
        `SELECT ?op WHERE { GRAPH <${metaGraph}> {
          <${headSubject}> <http://dkg.io/ontology/shareOperationId> ?op .
        } }`,
      );
      expect(head.type).toBe('bindings');
      if (head.type !== 'bindings') throw new Error('expected bindings');
      expect(head.bindings).toEqual([{ op: `"${expectedOp}"` }]);
    }
  });

  it('enforces CAS conditions against the per-KA graph for v2 writes', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:cas', 'recruiting')),
      shareOperationId: 'rootless-cas-1',
    }), PEER_ID)).applied).toBe(true);

    const matching = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:cas', 'traveling')),
      shareOperationId: 'rootless-cas-2',
      assertionVersion: '2',
      casConditions: [{
        subject: 'urn:entity:cas',
        predicate: 'urn:predicate:value',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    }), PEER_ID);
    expect(matching.applied).toBe(true);

    const mismatched = await handler.handle(v2Request({
      nquads: new TextEncoder().encode(nquad('urn:entity:cas', 'resting')),
      shareOperationId: 'rootless-cas-3',
      assertionVersion: '3',
      casConditions: [{
        subject: 'urn:entity:cas',
        predicate: 'urn:predicate:value',
        expectedValue: '"recruiting"',
        expectAbsent: false,
      }],
    }), PEER_ID);
    expect(mismatched.applied).toBe(false);
    if (mismatched.applied) throw new Error('unreachable');
    // CAS misses are transient (out-of-order gossip may still converge) and
    // must leave the prior graph-scoped state untouched.
    expect(mismatched.retryable).toBe(true);
    expect(mismatched.reason).toMatch(/CAS/);
    const rows = await store.query(
      `SELECT ?o WHERE { GRAPH <${swmGraphFor(2)}> { <urn:entity:cas> <urn:predicate:value> ?o } }`,
    );
    expect(rows.type).toBe('bindings');
    if (rows.type !== 'bindings') throw new Error('expected bindings');
    expect(rows.bindings).toEqual([{ o: '"traveling"' }]);
  });

  it('binds signed graph-scoped writes to the kaUal author', async () => {
    // Signed by a key that is NOT the UAL author: permanent rejection.
    const attacker = ethers.Wallet.createRandom();
    {
      const store = new OxigraphStore();
      const handler = new SharedMemoryHandler(store, new TypedEventBus());
      const outcome = await handler.handle(
        await signV2Request(attacker, v2Request({ shareOperationId: 'rootless-signed-1' })),
        PEER_ID,
      );
      expect(outcome.applied).toBe(false);
      if (outcome.applied) throw new Error('unreachable');
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain('KA_AUTHOR_SIGNER_MISMATCH');
    }

    // Claiming the author's address without the author's key: the envelope
    // fails self-consistent signature verification.
    const author = ethers.Wallet.createRandom();
    const authorUal = `did:dkg:base:8453/${author.address.toLowerCase()}/7`;
    const authorRequest = () => v2Request({
      kaUal: authorUal,
      agentAddress: author.address.toLowerCase(),
      shareOperationId: 'rootless-signed-2',
    });
    {
      const store = new OxigraphStore();
      const handler = new SharedMemoryHandler(store, new TypedEventBus());
      const outcome = await handler.handle(
        await signV2Request(attacker, authorRequest(), author.address),
        PEER_ID,
      );
      expect(outcome.applied).toBe(false);
      if (outcome.applied) throw new Error('unreachable');
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain('failed verification');
    }

    // Signed by the UAL author: accepted, and attribution records the
    // verified signer identity.
    {
      const store = new OxigraphStore();
      const handler = new SharedMemoryHandler(store, new TypedEventBus());
      const outcome = await handler.handle(
        await signV2Request(author, authorRequest()),
        PEER_ID,
      );
      expect(outcome.applied).toBe(true);
      const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH);
      const attribution = await store.query(
        `SELECT ?who WHERE { GRAPH <${metaGraph}> {
          ?op <http://www.w3.org/ns/prov#wasAttributedTo> ?who .
        } }`,
      );
      expect(attribution.type).toBe('bindings');
      if (attribution.type !== 'bindings') throw new Error('expected bindings');
      expect(attribution.bindings).toEqual([
        { who: `did:dkg:agent:${author.address.toLowerCase()}` },
      ]);
    }
  });

  it('attributes unsigned graph-scoped writes to the transport peer, not the claimed author', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect((await handler.handle(v2Request(), PEER_ID)).applied).toBe(true);
    const metaGraph = new GraphManager(store).sharedMemoryMetaUri(CONTEXT_GRAPH);
    const attribution = await store.query(
      `SELECT ?who WHERE { GRAPH <${metaGraph}> {
        ?op <http://www.w3.org/ns/prov#wasAttributedTo> ?who .
      } }`,
    );
    expect(attribution.type).toBe('bindings');
    if (attribution.type !== 'bindings') throw new Error('expected bindings');
    // The claimed-but-unverified UAL author must never be recorded as
    // provenance; the transport peer id is the only verified identity here.
    expect(attribution.bindings).toEqual([{ who: `"${PEER_ID}"` }]);
  });
});
