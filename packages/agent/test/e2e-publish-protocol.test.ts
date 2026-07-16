/**
 * E2E multi-node tests for the "replicate-then-publish" protocol.
 *
 * These tests verify the full end-to-end flows across 2+ nodes with EVMChainAdapter:
 *
 * 1. ContextGraph publish: write → replicate → collect receiver sigs → on-chain → finalization
 * 2. Context graph publish: same + collect participant sigs → publishToContextGraph
 * 3. verify for already-published KCs
 * 4. Negative: insufficient receiver signatures → publish rejected
 * 5. Negative: insufficient participant signatures → context graph registration rejected
 * 6. Edge node as context graph participant
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens, setMinimumRequiredSignatures } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

const CONTEXT_GRAPH = 'publish-protocol-e2e';
const ENTITY_1 = 'urn:protocol:entity:1';
const ENTITY_2 = 'urn:protocol:entity:2';
const ENTITY_3 = 'urn:protocol:entity:3';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function stageRootlessAssertion(
  node: DKGAgent,
  contextGraphId: string,
  name: string,
  quads: Array<{ subject: string; predicate: string; object: string }>,
) {
  await node.assertion.create(contextGraphId, name);
  await node.assertion.write(contextGraphId, name, quads);
  return node.assertion.promote(contextGraphId, name);
}

async function bindAndSubscribePublicContextGraph(
  node: DKGAgent,
  contextGraphId: string,
  onChainId: string,
) {
  // Role-aware activation intentionally fails closed until the local label is
  // bound to a live public on-chain CG. These protocol tests isolate SWM and
  // finalization behavior, so bind the registration deterministically instead
  // of racing background ontology discovery before subscribing the replicas.
  await (node as any).store.insert([{
    subject: `did:dkg:context-graph:${contextGraphId}`,
    predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
    object: `"${onChainId}"`,
    graph: 'did:dkg:context-graph:ontology',
  }]);
  node.subscribeToContextGraph(contextGraphId);
}

async function pollUntil(
  queryFn: () => Promise<{ bindings: any[] }>,
  predicate: (bindings: any[]) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: any[] = [];
  while (Date.now() < deadline) {
    const result = await queryFn();
    lastResult = result.bindings;
    if (predicate(lastResult)) return lastResult;
    await sleep(intervalMs);
  }
  return lastResult;
}

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  // REC1..REC3 are staked by the shared Hardhat harness. Re-staking here
  // double-spends the setup path and reverts before the skipped shard tests run.
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// ========================================================================
// 1. ContextGraph Publish — Replicate-then-Publish with Receiver Signatures
// ========================================================================

describe('E2E: ContextGraph publish with receiver signature collection', () => {
  const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
    try { await nodeC?.stop(); } catch {}
  });

  it('bootstraps 3 agents with shared chain and connects them', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ProtoA',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ProtoB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
      // This suite owns GossipSub/finalization behavior. Receiver startup
      // catch-up can add the same logical rows from the per-KA VM graph; the
      // read-both bag-semantics issue is tracked separately in #1270.
      syncOnConnectEnabled: false,
    });
    nodeC = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ProtoC',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC2_OP),
      nodeRole: 'core',
      syncOnConnectEnabled: false,
    });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await nodeC.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(2);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Publish Protocol E2E', description: '' });
    const registration = await nodeA.registerContextGraph(CONTEXT_GRAPH);
    await bindAndSubscribePublicContextGraph(nodeA, CONTEXT_GRAPH, registration.onChainId);
    await bindAndSubscribePublicContextGraph(nodeB, CONTEXT_GRAPH, registration.onChainId);
    await bindAndSubscribePublicContextGraph(nodeC, CONTEXT_GRAPH, registration.onChainId);
    await sleep(1500);
  }, 20_000);

  it('A writes to workspace; B and C receive via GossipSub', async () => {
    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'protocol-entity', [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Protocol Entity"' },
      { subject: ENTITY_1, predicate: 'http://schema.org/version', object: '"1"' },
    ]);

    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bBindings.length).toBe(1);

    const cBindings = await pollUntil(
      () => nodeC.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(cBindings.length).toBe(1);
  }, 25_000);

  it('A enshrines with receiver signatures collected from B and C', async () => {
    /**
     * The new flow:
     * 1. A has data in workspace (already replicated to B and C)
     * 2. A calls publishFromSharedMemory
     * 3. Publisher internally: prepares merkle root → requests receiver sigs from B, C
     * 4. B and C verify they have the data and sign (merkleRoot, publicByteSize)
     * 5. Publisher submits on-chain tx with collected receiver signatures
     * 6. On-chain: verifies publisher sig + minimumRequiredSignatures receiver sigs
     * 7. Finalization broadcast → B, C promote workspace → data graph
     */
    const result = await nodeA.publishFromSharedMemory(
      CONTEXT_GRAPH,
      'all',
      { clearSharedMemoryAfter: true },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);

    // A has data in the data graph
    const aData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
      CONTEXT_GRAPH,
    );
    expect(aData.bindings.length).toBe(1);
  }, 30_000);

  it('B and C receive finalization and promote to data graph', async () => {
    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        CONTEXT_GRAPH,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bBindings.length).toBe(1);

    const cBindings = await pollUntil(
      () => nodeC.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        CONTEXT_GRAPH,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(cBindings.length).toBe(1);
  }, 30_000);

  it('on-chain V10 publish emits KCCreated event with publisher address', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of chainA.listenForEvents({
      eventTypes: ['KCCreated'],
    })) {
      events.push(event);
      break;
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const publishEvent = events[events.length - 1];
    expect(publishEvent.data.publisherAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 10_000);
});

// ========================================================================
// 1b. Design B canary (OT-RFC-44): a MULTI-ENTITY file publishes as ONE KA
//     and is ACKed cross-node. This is the §11.2 canary: pre-Design-B the
//     publisher's `kaCount !== 1` guard threw before the payload ever left
//     node A, AND the receiver's `storage-ack` check refused any payload
//     whose root-subject count != kaCount. So a multi-entity KA could never
//     be ACKed by a separate node — exactly the silent cross-node failure in
//     OT-RFC-43 §2.7. This test asserts it now succeeds end to end.
// ========================================================================

describe('E2E: Design B — multi-entity file publishes as one KA, ACKed cross-node (OT-RFC-44)', () => {
  const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;
  const MCG = 'design-b-multi-entity-e2e';

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
    try { await nodeC?.stop(); } catch {}
  });

  it('bootstraps 3 agents and a context graph', async () => {
    nodeA = await DKGAgent.create({ kaNumberAllocator: makeTestKaNumberAllocator(), name: 'DBMultiA', listenPort: 0, skills: [], chainAdapter: chainA, nodeRole: 'core' });
    // Keep receiver startup catch-up out of this GossipSub/finalization canary;
    // duplicate logical rows across VM layouts are tracked separately in #1270.
    nodeB = await DKGAgent.create({ kaNumberAllocator: makeTestKaNumberAllocator(), name: 'DBMultiB', listenPort: 0, skills: [], chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP), nodeRole: 'core', syncOnConnectEnabled: false });
    nodeC = await DKGAgent.create({ kaNumberAllocator: makeTestKaNumberAllocator(), name: 'DBMultiC', listenPort: 0, skills: [], chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC2_OP), nodeRole: 'core', syncOnConnectEnabled: false });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await nodeC.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(2);

    await nodeA.createContextGraph({ id: MCG, name: 'Design B Multi-Entity', description: '' });
    const registration = await nodeA.registerContextGraph(MCG);
    await bindAndSubscribePublicContextGraph(nodeA, MCG, registration.onChainId);
    await bindAndSubscribePublicContextGraph(nodeB, MCG, registration.onChainId);
    await bindAndSubscribePublicContextGraph(nodeC, MCG, registration.onChainId);
    await sleep(1500);
  }, 20_000);

  it('A shares a 3-entity file; B and C receive all three via GossipSub', async () => {
    await stageRootlessAssertion(nodeA, MCG, 'multi-entity-file', [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Alice"' },
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Bob"' },
      { subject: ENTITY_3, predicate: 'http://schema.org/name', object: '"Carol"' },
    ]);

    for (const node of [nodeB, nodeC]) {
      const bindings = await pollUntil(
        () => node.query(
          `SELECT ?e ?name WHERE { ?e <http://schema.org/name> ?name FILTER(?e IN (<${ENTITY_1}>,<${ENTITY_2}>,<${ENTITY_3}>)) }`,
          { contextGraphId: MCG, graphSuffix: '_shared_memory' },
        ),
        (b) => b.length >= 3,
        15_000,
      );
      expect(bindings.length).toBe(3);
    }
  }, 25_000);

  it('publishes all three entities as ONE KA with cross-node ACKs (THE CANARY)', async () => {
    const result = await nodeA.publishFromSharedMemory(
      MCG,
      'all',
      { clearSharedMemoryAfter: true },
    );

    // Reaching 'confirmed' means: the multi-entity payload left node A (no
    // kaCount!==1 guard), B and C verified + signed receiver ACKs over it (the
    // storage-ack receiver accepted N>1 root subjects with kaCount=1), and the
    // on-chain tx confirmed. All three were impossible pre-Design-B.
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);

    // One UAL + one batchId for the whole 3-entity file = ONE Knowledge Asset
    // (Design B: 1 KA, N entities — not 3 KAs). The compatibility label
    // metadata shape is asserted directly in the publisher unit test
    // (metadata.test.ts). Here we assert the end-to-end result is a single KA
    // carrying all three entities.
    expect(typeof result.ual).toBe('string');
    const aData = await nodeA.query(
      `SELECT ?e WHERE { ?e <http://schema.org/name> ?name FILTER(?e IN (<${ENTITY_1}>,<${ENTITY_2}>,<${ENTITY_3}>)) }`,
      MCG,
    );
    expect(aData.bindings.length).toBe(3);
  }, 30_000);

  it('B and C receive finalization for all three entities (one KA)', async () => {
    for (const node of [nodeB, nodeC]) {
      const bindings = await pollUntil(
        () => node.query(
          `SELECT ?e ?name WHERE { ?e <http://schema.org/name> ?name FILTER(?e IN (<${ENTITY_1}>,<${ENTITY_2}>,<${ENTITY_3}>)) }`,
          MCG,
        ),
        (b) => b.length >= 3,
        20_000,
      );
      expect(bindings.length).toBe(3);
    }
  }, 30_000);
});

// ========================================================================
// 2. Context Graph Publish — Two-Layer Signatures
// ========================================================================

describe('E2E: Context graph publish with receiver + participant signatures', () => {
  const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let contextGraphId: string;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
  });

  it('bootstraps 2 agents, connects, creates context graph', async () => {
    const ctx = getSharedContext();
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxProtoA',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxProtoB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Context Graph Protocol E2E', description: '' });
    await sleep(1500);

    // Both A and B are participants
    const result = await nodeA.registerContextGraph(CONTEXT_GRAPH, {
      accessPolicy: 0,
      publishPolicy: 1,
    });
    contextGraphId = result.onChainId;
    expect(Number(contextGraphId)).toBeGreaterThan(0);
    await bindAndSubscribePublicContextGraph(nodeA, CONTEXT_GRAPH, contextGraphId);
    await bindAndSubscribePublicContextGraph(nodeB, CONTEXT_GRAPH, contextGraphId);
    await sleep(1500);
  }, 20_000);

  it('A writes to workspace, enshrines to context graph with both sig layers', async () => {
    const ctx = getSharedContext();
    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'context-protocol-entity', [
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Context Protocol Entity"' },
    ]);
    await sleep(5000);

    /**
     * The context graph publish flow:
     * 1. Prepare data + compute merkle root
     * 2. Collect receiver signatures from core nodes (B) — they sign (merkleRoot, publicByteSize)
     * 3. Collect participant signatures — they sign (contextGraphId, merkleRoot)
     * 4. Submit atomic publishToContextGraph on-chain with both sets of signatures
     * 5. Broadcast finalization to peers
     */
    const result = await nodeA.publishFromSharedMemory(
      CONTEXT_GRAPH,
      'all',
      {
        clearSharedMemoryAfter: true,
        subContextGraphId: contextGraphId,
        contextGraphSignatures: [{
          identityId: BigInt(ctx.coreProfileId),
          r: new Uint8Array(32),
          vs: new Uint8Array(32),
        }],
      },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();

    // A has data in context graph data graph
    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;
    const aData = await nodeA.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_2}> <http://schema.org/name> ?name } }`,
    );
    expect(aData.bindings.length).toBe(1);
  }, 40_000);

  it('B receives finalization and promotes to context graph', async () => {
    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;

    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_2}> <http://schema.org/name> ?name } }`,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bBindings.length).toBe(1);
  }, 30_000);

  it('context graph data is NOT in contextGraph data graph', async () => {
    const aContextGraphData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_2}> <http://schema.org/name> ?name }`,
      CONTEXT_GRAPH,
    );
    expect(aContextGraphData.bindings.length).toBe(0);
  }, 5_000);
});

// ========================================================================
// 3. verify for Already-Published KCs
// ========================================================================

describe('E2E: Publish KC directly to context graph', () => {
  let nodeA: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
  });

  it('publishes KC via publishDirect from a lone core: no peer ACKs → tentative (RC11 / PR1)', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'DirectCGA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Direct CG E2E', description: '' });
    await nodeA.registerContextGraph(CONTEXT_GRAPH);
    nodeA.subscribeToContextGraph(CONTEXT_GRAPH);
    await sleep(500);

    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'direct-cg-publish', [
      { subject: ENTITY_3, predicate: 'http://schema.org/name', object: '"Direct CG Publish"' },
    ]);
    await sleep(2000);

    // RC11 / PR1 (review fix): the publisher's self-signed ACK fallback
    // is gone. `DKGAgent.publishFromSharedMemory()` unconditionally wires
    // `createV10ACKProvider()` on a V10-ready Hardhat chain, and that
    // provider routes through `ACKCollector.collect()` which throws
    // verbatim on "no connected core peers". The publisher's catch at
    // `dkg-publisher.ts:1989-1994` rethrows verbatim (RC11 / PR1+PR3),
    // so the publish REJECTS — it does not silently downgrade to
    // `tentative`. Pre-PR1 the publisher synthesised a `peerId: 'self'`
    // ACK that the contract would reject anyway on any network with
    // `minimumRequiredSignatures >= 2`; the new behaviour fails loudly
    // in the daemon log instead. The replicate-then-publish on-chain
    // path is covered by the multi-node §1 / §2 tests above.
    await expect(
      nodeA.publishFromSharedMemory(CONTEXT_GRAPH, 'all'),
    ).rejects.toThrow(/ACK collection failed: no connected core peers/);
  }, 20_000);
});

// ========================================================================
// 4. Negative: Insufficient Receiver Signatures
// ========================================================================

describe('E2E: Publish rejected with insufficient receiver signatures', () => {
  let nodeA: DKGAgent;
  let _describeSnapshot: string;

  beforeAll(async () => {
    _describeSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await setMinimumRequiredSignatures(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, 2);
  });

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    await revertSnapshot(_describeSnapshot);
  });

  it('publish fails gracefully when no peers provide receiver sigs', async () => {
    // Single node, no peers to collect receiver signatures from
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'LonelyA',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Lonely ContextGraph', description: '' });
    await nodeA.registerContextGraph(CONTEXT_GRAPH);
    nodeA.subscribeToContextGraph(CONTEXT_GRAPH);

    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'lonely-data', [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Lonely Data"' },
    ]);

    /**
     * RC11 / PR1 (review fix): with `minimumRequiredSignatures=2`
     * on-chain AND the lone publisher having no peer cores, the ACK
     * collector throws "no connected core peers" before the on-chain
     * submit branch is even reached. The publisher rethrows verbatim
     * (no self-signed-ACK fallback in PR1+PR3), so the call REJECTS.
     * Pre-PR1 the publisher synthesised a single self-signed ACK that
     * the chain rejected as 1<2; the new behaviour fails earlier and
     * the operator sees the real cause in the daemon log.
     */
    await expect(
      nodeA.publishFromSharedMemory(
        CONTEXT_GRAPH,
        'all',
      ),
    ).rejects.toThrow(/ACK collection failed: no connected core peers/);
  }, 20_000);
});

// ========================================================================
// 5. Negative: Insufficient Participant Signatures for Context Graph
// ========================================================================

describe('E2E: Context graph registration rejected with insufficient participant sigs', () => {
  let nodeA: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
  });

  it('context graph publish from a lone core: no peer ACKs → tentative (RC11 / PR1)', async () => {
    const ctx = getSharedContext();
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ParticipantA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Participant Test', description: '' });
    const cgResult = await nodeA.registerContextGraph(CONTEXT_GRAPH, {
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const contextGraphId = cgResult.onChainId;
    await bindAndSubscribePublicContextGraph(nodeA, CONTEXT_GRAPH, contextGraphId);

    await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'needs-sigs', [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Needs Sigs"' },
    ]);

    // RC11 / PR1 (review fix): V10 + LU-2 still enforces the *global*
    // `minimumRequiredSignatures`, but the publisher no longer
    // synthesises a self-signed ACK when peer collection yields
    // nothing. A lone core with no other peers in its mesh therefore
    // hits `ACKCollector.collect` with `corePeers.length === 0`, which
    // throws "no connected core peers". The publisher rethrows
    // verbatim and `publishFromSharedMemory` REJECTS — there is no
    // silent tentative-downgrade. Pre-PR1 this test asserted
    // `confirmed` because the (now-deleted) self-signed ACK satisfied
    // the 1-of-1 quorum on the harness; that path is gone. The
    // multi-peer happy path is covered by §1 / §2 above.
    await expect(
      nodeA.publishFromSharedMemory(
        CONTEXT_GRAPH,
        'all',
        { subContextGraphId: contextGraphId },
      ),
    ).rejects.toThrow(/ACK collection failed: no connected core peers/);
  }, 20_000);
});

// ========================================================================
// 6. Edge Node as Context Graph Participant
// ========================================================================

describe('E2E: Edge node participates in context graph governance', () => {
  const chainCore = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let coreNode: DKGAgent;
  let edgeNode: DKGAgent;
  let contextGraphId: string;

  afterAll(async () => {
    try { await coreNode?.stop(); } catch {}
    try { await edgeNode?.stop(); } catch {}
  });

  it('edge node (identity, no stake) can sign as context graph participant', async () => {
    const ctx = getSharedContext();
    coreNode = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CoreNode',
      listenPort: 0,
      skills: [],
      chainAdapter: chainCore,
      nodeRole: 'core',
    });

    /**
     * Edge node: same identity structure (has identityId via createProfile)
     * but not in the sharding table (no minimum stake).
     * Can participate in context graph governance.
     */
    edgeNode = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'EdgeNode',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'edge',
    });

    await coreNode.start();
    await edgeNode.start();
    await sleep(800);

    const addrCore = coreNode.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await edgeNode.connectTo(addrCore);
    await sleep(2000);

    await coreNode.createContextGraph({ id: CONTEXT_GRAPH, name: 'Edge Participant E2E', description: '' });
    await sleep(1500);

    // Both core and edge are participants
    const coreIdentity = await chainCore.getIdentityId();
    expect(coreIdentity).toBeGreaterThan(0n);

    const cgResult = await coreNode.registerContextGraphOnChain({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    contextGraphId = cgResult.contextGraphId;
    await bindAndSubscribePublicContextGraph(coreNode, CONTEXT_GRAPH, contextGraphId);
    await bindAndSubscribePublicContextGraph(edgeNode, CONTEXT_GRAPH, contextGraphId);
    await sleep(1500);

    // Core writes data
    await stageRootlessAssertion(coreNode, CONTEXT_GRAPH, 'edge-governed-data', [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Edge Governed Data"' },
    ]);
    await sleep(5000);

    /**
     * When enshrining to context graph:
     * - Receiver sigs come from core nodes (storage attestation)
     * - Participant sigs come from both core AND edge nodes (governance)
     *
     * Edge node should be able to sign (contextGraphId, merkleRoot)
     * even though it has no stake and isn't in the sharding table.
     *
     * RC11 / PR1+PR2 (review fix): the only peer in coreNode's mesh is
     * an EDGE node, which does not register the StorageACK handler.
     * `ACKCollector.collect` therefore either sees zero "known core
     * peers" and throws "no connected core peers", or falls through to
     * the edge peer and fails at protocol negotiation. The publisher
     * rethrows verbatim (PR1+PR3) and `publishFromSharedMemory`
     * REJECTS — no silent tentative-downgrade.
     *
     * PR2 also defers the data-graph insert until either on-chain
     * confirmation OR an intentional-local-skip branch fires. A reject
     * is neither, so the pre-PR2 "triples still land in the data graph
     * on tentative" invariant this test used to validate is GONE on
     * purpose (it was the LU-1 / PR2 verifiable-memory leak — see
     * `automated.test.ts §2`).
     *
     * What's still meaningful to check here is the inverse: the failed
     * publish does NOT leak its triples into the data graph on the
     * publishing core. The participant-sig governance layer this test
     * was named after is exercised by §1/§2/§5 above with a real
     * multi-core mesh; preserving this test as a regression for "edge
     * peer cannot stand in for a core ACK signer" + "failed publish
     * doesn't leak" keeps both PR1 and PR2 covered in this file.
     */
    await expect(
      coreNode.publishFromSharedMemory(
        CONTEXT_GRAPH,
        'all',
        {
          subContextGraphId: contextGraphId,
          contextGraphSignatures: [
            { identityId: BigInt(ctx.coreProfileId), r: new Uint8Array(32), vs: new Uint8Array(32) },
            { identityId: BigInt(ctx.receiverIds[0]), r: new Uint8Array(32), vs: new Uint8Array(32) },
          ],
        },
      ),
    ).rejects.toThrow();

    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;
    const data = await coreNode.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_1}> <http://schema.org/name> ?name } }`,
    );
    expect(data.bindings.length).toBe(0);
  }, 40_000);
});
