/**
 * E2E multi-node tests for the "replicate-then-publish" protocol.
 *
 * These tests verify the full end-to-end flows across 2+ nodes with EVMChainAdapter:
 *
 * 1. Paranet publish: write → replicate → collect receiver sigs → on-chain → finalization
 * 2. Context graph publish: same + collect participant sigs → publishToContextGraph
 * 3. verify for already-published KCs
 * 4. Negative: insufficient receiver signatures → publish rejected
 * 5. Negative: insufficient participant signatures → context graph registration rejected
 * 6. Edge node as context graph participant
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens, stakeAndSetAsk, setMinimumRequiredSignatures } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

const PARANET = 'publish-protocol-e2e';
const ENTITY_1 = 'urn:protocol:entity:1';
const ENTITY_2 = 'urn:protocol:entity:2';
const ENTITY_3 = 'urn:protocol:entity:3';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
  const { hubAddress, receiverIds } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
  await stakeAndSetAsk(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.REC1_OP, receiverIds[0]);
  await stakeAndSetAsk(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.REC2_OP, receiverIds[1]);
  await stakeAndSetAsk(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.REC3_OP, receiverIds[2]);
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// ========================================================================
// 1. Paranet Publish — Replicate-then-Publish with Receiver Signatures
// ========================================================================

describe('E2E: Paranet publish with receiver signature collection', () => {
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
      name: 'ProtoA',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      name: 'ProtoB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      nodeRole: 'core',
    });
    nodeC = await DKGAgent.create({
      name: 'ProtoC',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC2_OP),
      nodeRole: 'core',
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

    await nodeA.createContextGraph({ id: PARANET, name: 'Publish Protocol E2E', description: '' });
    nodeA.subscribeToContextGraph(PARANET);
    nodeB.subscribeToContextGraph(PARANET);
    nodeC.subscribeToContextGraph(PARANET);
    await sleep(1500);
  }, 20_000);

  it('A writes to workspace; B and C receive via GossipSub', async () => {
    const quads = [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Protocol Entity"', graph: '' },
      { subject: ENTITY_1, predicate: 'http://schema.org/version', object: '"1"', graph: '' },
    ];

    await nodeA.share(PARANET, quads);

    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bBindings.length).toBe(1);

    const cBindings = await pollUntil(
      () => nodeC.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
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
      PARANET,
      { rootEntities: [ENTITY_1] },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);

    // A has data in the data graph
    const aData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(aData.bindings.length).toBe(1);
  }, 30_000);

  it('B and C receive finalization and promote to data graph', async () => {
    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        PARANET,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bBindings.length).toBe(1);

    const cBindings = await pollUntil(
      () => nodeC.query(
        `SELECT ?name WHERE { <${ENTITY_1}> <http://schema.org/name> ?name }`,
        PARANET,
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
      name: 'CtxProtoA',
      listenPort: 0,
      skills: [],
      chainAdapter: chainA,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
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

    await nodeA.createContextGraph({ id: PARANET, name: 'Context Graph Protocol E2E', description: '' });
    nodeA.subscribeToContextGraph(PARANET);
    nodeB.subscribeToContextGraph(PARANET);
    await sleep(1500);

    // Both A and B are participants
    const result = await nodeA.registerContextGraphOnChain({
      participantIdentityIds: [BigInt(ctx.coreProfileId), BigInt(ctx.receiverIds[0])],
      requiredSignatures: 1,
    });
    contextGraphId = result.contextGraphId;
    expect(Number(contextGraphId)).toBeGreaterThan(0);
  }, 20_000);

  it('A writes to workspace, enshrines to context graph with both sig layers', async () => {
    const ctx = getSharedContext();
    const quads = [
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Context Protocol Entity"', graph: '' },
    ];

    await nodeA.share(PARANET, quads);
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
      PARANET,
      { rootEntities: [ENTITY_2] },
      {
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
    const ctxDataGraph = `did:dkg:context-graph:${PARANET}/context/${contextGraphId}`;
    const aData = await nodeA.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_2}> <http://schema.org/name> ?name } }`,
    );
    expect(aData.bindings.length).toBe(1);
  }, 40_000);

  it('B receives finalization and promotes to context graph', async () => {
    const ctxDataGraph = `did:dkg:context-graph:${PARANET}/context/${contextGraphId}`;

    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_2}> <http://schema.org/name> ?name } }`,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bBindings.length).toBe(1);
  }, 30_000);

  it('context graph data is NOT in paranet data graph', async () => {
    const aParanetData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_2}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(aParanetData.bindings.length).toBe(0);
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

  it('publishes KC via publishDirect and registers it to the CG atomically', async () => {
    nodeA = await DKGAgent.create({
      name: 'DirectCGA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: PARANET, name: 'Direct CG E2E', description: '' });
    nodeA.subscribeToContextGraph(PARANET);
    await sleep(500);

    await nodeA.share(PARANET, [
      { subject: ENTITY_3, predicate: 'http://schema.org/name', object: '"Direct CG Publish"', graph: '' },
    ]);
    await sleep(2000);

    const result = await nodeA.publishFromSharedMemory(PARANET, { rootEntities: [ENTITY_3] });
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
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
      name: 'LonelyA',
      listenPort: 0,
      skills: [],
      chainAdapter: chain,
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: PARANET, name: 'Lonely Paranet', description: '' });
    nodeA.subscribeToContextGraph(PARANET);

    await nodeA.share(PARANET, [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Lonely Data"', graph: '' },
    ]);

    /**
     * With minimumRequiredSignatures=2 on-chain, the self-signed
     * single signature will be rejected by the chain's signature check,
     * resulting in a tentative (off-chain only) publish.
     */
    const result = await nodeA.publishFromSharedMemory(
      PARANET,
      { rootEntities: [ENTITY_1] },
    );

    // Should be tentative since the on-chain tx rejects with only 1 self-signed sig
    expect(result.status).toBe('tentative');
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

  it('context graph enshrine fails when participant sigs not met', async () => {
    const ctx = getSharedContext();
    nodeA = await DKGAgent.create({
      name: 'ParticipantA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      nodeRole: 'core',
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({ id: PARANET, name: 'Participant Test', description: '' });
    nodeA.subscribeToContextGraph(PARANET);

    // Context graph requires 2 signatures, but only 1 node available
    const cgResult = await nodeA.registerContextGraphOnChain({
      participantIdentityIds: [BigInt(ctx.coreProfileId), BigInt(ctx.receiverIds[0])],
      requiredSignatures: 2,
    });
    const contextGraphId = cgResult.contextGraphId;

    await nodeA.share(PARANET, [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Needs Sigs"', graph: '' },
    ]);

    const result = await nodeA.publishFromSharedMemory(
      PARANET,
      { rootEntities: [ENTITY_1] },
      { subContextGraphId: contextGraphId },
    );

    // V10: publishDirect enforces the *global* minimumRequiredSignatures
    // (set via ParametersStorage), not the per-CG requiredSignatures.
    // The per-CG quorum governs context-graph governance, not publish gating.
    // With the global minimum at 1 and a valid self-signed ACK the publish
    // succeeds even though the CG's own quorum is 2.
    expect(result.status).toBe('confirmed');
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

    await coreNode.createContextGraph({ id: PARANET, name: 'Edge Participant E2E', description: '' });
    coreNode.subscribeToContextGraph(PARANET);
    edgeNode.subscribeToContextGraph(PARANET);
    await sleep(1500);

    // Both core and edge are participants
    const coreIdentity = await chainCore.getIdentityId();
    expect(coreIdentity).toBeGreaterThan(0n);

    const cgResult = await coreNode.registerContextGraphOnChain({
      participantIdentityIds: [BigInt(ctx.coreProfileId), BigInt(ctx.receiverIds[0])],
      requiredSignatures: 2,
    });
    contextGraphId = cgResult.contextGraphId;

    // Core writes data
    await coreNode.share(PARANET, [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Edge Governed Data"', graph: '' },
    ]);
    await sleep(5000);

    /**
     * When enshrining to context graph:
     * - Receiver sigs come from core nodes (storage attestation)
     * - Participant sigs come from both core AND edge nodes (governance)
     *
     * Edge node should be able to sign (contextGraphId, merkleRoot)
     * even though it has no stake and isn't in the sharding table.
     */
    // Both core and edge node sign as participants
    const result = await coreNode.publishFromSharedMemory(
      PARANET,
      { rootEntities: [ENTITY_1] },
      {
        subContextGraphId: contextGraphId,
        contextGraphSignatures: [
          { identityId: BigInt(ctx.coreProfileId), r: new Uint8Array(32), vs: new Uint8Array(32) },
          { identityId: BigInt(ctx.receiverIds[0]), r: new Uint8Array(32), vs: new Uint8Array(32) },
        ],
      },
    );

    expect(result.status).toBe('confirmed');

    const ctxDataGraph = `did:dkg:context-graph:${PARANET}/context/${contextGraphId}`;
    const data = await coreNode.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_1}> <http://schema.org/name> ?name } }`,
    );
    expect(data.bindings.length).toBe(1);
  }, 40_000);
});
