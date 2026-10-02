/**
 * E2E tests for the context graph publishing flow (2 nodes, shared chain):
 *
 * 1. Create a context graph on-chain
 * 2. Write data to workspace → replicate via GossipSub
 * 3. The legacy (not graph-scoped) publish into the `<cg>/context/<id>`
 *    partition, with or without the same-graph root dual-write, is refused by
 *    a 10.0.19 Core: it cannot keep a copy of such a publish that it could
 *    promote to VM, so it declines the StorageACK (CORE_VM_PROMOTION_DISABLED)
 * 4. The same assertion publishes graph-scoped: B ACKs it and promotes it
 *
 * Uses a shared EVMChainAdapter so both nodes see the same on-chain events,
 * allowing B to verify A's publish transaction during finalization.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent as RealDKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import type { SelectResult } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

type DKGAgent = RealDKGAgent;
const DKGAgent = {
  create(config: Parameters<typeof RealDKGAgent.create>[0]) {
    return RealDKGAgent.create({
      rfc64CatalogActivation: { enabled: false },
      ...config,
    });
  },
};

const CONTEXT_GRAPH = 'context-graph-e2e';
const ENTITY_CTX_1 = 'urn:ctxgraph:entity:1';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Inspect exact persisted partitions while gossip finalization is writing. */
async function readPhysicalPlacement(node: DKGAgent, sparql: string): Promise<SelectResult> {
  const result = await node.store.query(sparql, {
    source: 'test.e2eContextGraph.physicalPlacement',
  });
  if (result.type !== 'bindings') {
    throw new Error(`Physical placement SELECT returned ${result.type} instead of bindings`);
  }
  return result;
}

/** Run a legacy publish and report how it ended, without throwing. */
async function legacyPublishOutcome(
  publish: Promise<{ status: string }>,
): Promise<{ status: string; error: string }> {
  return publish.then(
    (result) => ({ status: result.status, error: '' }),
    (err: unknown) => ({ status: 'rejected', error: err instanceof Error ? err.message : String(err) }),
  );
}

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
  // The public subscription gate intentionally requires a live on-chain
  // binding. Pin it in this publish/finalization test instead of racing the
  // background ontology-discovery loop.
  await (node as any).store.insert([{
    subject: `did:dkg:context-graph:${contextGraphId}`,
    predicate: 'https://dkg.network/ontology#ContextGraphOnChainId',
    object: `"${onChainId}"`,
    graph: 'did:dkg:context-graph:ontology',
  }]);
  node.subscribeToContextGraph(contextGraphId);
}

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('E2E: context graph publish + finalization (shared chain)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let contextGraphId: string;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
  });

  it('bootstraps two agents with shared chain, connects, subscribes', async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxA',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'CtxB',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);

    await nodeA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Context Graph E2E', description: '' });
    await sleep(1500);
  }, 15_000);

  it('creates a context graph on the shared chain', async () => {
    const result = await nodeA.registerContextGraph(CONTEXT_GRAPH, {
      accessPolicy: 0,
      publishPolicy: 1,
    });

    contextGraphId = result.onChainId;
    expect(contextGraphId).toBeDefined();
    expect(Number(contextGraphId)).toBeGreaterThan(0);
    await bindAndSubscribePublicContextGraph(nodeA, CONTEXT_GRAPH, contextGraphId);
    await bindAndSubscribePublicContextGraph(nodeB, CONTEXT_GRAPH, contextGraphId);
    await sleep(1500);
  }, 10_000);

  it('A writes to workspace; B receives via GossipSub', async () => {
    const wsResult = await stageRootlessAssertion(nodeA, CONTEXT_GRAPH, 'context-entity-1', [
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/name', object: '"Context Graph Entity"' },
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/version', object: '"1"' },
    ]);
    expect(wsResult.promotedCount).toBeGreaterThan(0);

    const deadline = Date.now() + 15_000;
    let bWorkspace: any;
    while (Date.now() < deadline) {
      bWorkspace = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      );
      if (bWorkspace.bindings.length > 0) break;
      await sleep(500);
    }
    expect(bWorkspace.bindings.length).toBe(1);
    expect(bWorkspace.bindings[0]['name']).toBe('"Context Graph Entity"');
  }, 25_000);

  it('a gated receiver refuses the legacy publish into the context graph partition', async () => {
    const outcome = await legacyPublishOutcome(nodeA.publishFromSharedMemory(
      CONTEXT_GRAPH,
      'all',
      { subContextGraphId: contextGraphId, clearSharedMemoryAfter: true },
    ));

    expect(outcome.status).not.toBe('confirmed');
    expect(outcome.error).toContain('CORE_VM_PROMOTION_DISABLED');
    const ctxDataGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/context/${contextGraphId}`;
    for (const node of [nodeA, nodeB]) {
      const data = await readPhysicalPlacement(node,
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_CTX_1}> <http://schema.org/name> ?name } }`,
      );
      expect(data.bindings.length).toBe(0);
    }
  }, 30_000);

  it('the same assertion publishes graph-scoped; B ACKs it and promotes it to VM', async () => {
    const result = await nodeA.publishFromFinalizedAssertion(
      CONTEXT_GRAPH,
      'context-entity-1',
      { clearSharedMemoryAfter: true },
    );
    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();

    const deadline = Date.now() + 20_000;
    let bData: SelectResult = { type: 'bindings', bindings: [] };
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
        CONTEXT_GRAPH,
      );
      if (bData.bindings.length > 0) break;
      await sleep(500);
    }
    expect(bData.bindings.length).toBe(1);
    expect(bData.bindings[0]['name']).toBe('"Context Graph Entity"');
  }, 40_000);

  describe('same-graph publish (keepRootCopyOnLabel=true)', () => {
    const SAMEG_LABEL = 'context-graph-e2e-sameg';
    const ENTITY_SAMEG = 'urn:ctxgraph:entity:sameg';
    let samegOnChainId: string;

    it('registers a fresh same-graph-friendly CG and primes both nodes', async () => {
      await nodeA.createContextGraph({ id: SAMEG_LABEL, name: 'Same-Graph E2E', description: '' });
      await nodeB.createContextGraph({ id: SAMEG_LABEL, name: 'Same-Graph E2E', description: '' });
      const reg = await nodeA.registerContextGraph(SAMEG_LABEL, {
        accessPolicy: 0,
        publishPolicy: 1,
      });
      samegOnChainId = String(reg.onChainId);
      expect(Number(samegOnChainId)).toBeGreaterThan(0);
      await bindAndSubscribePublicContextGraph(nodeA, SAMEG_LABEL, samegOnChainId);
      await bindAndSubscribePublicContextGraph(nodeB, SAMEG_LABEL, samegOnChainId);
      await sleep(1500);
    }, 30_000);

    it('a gated receiver refuses the legacy same-graph dual-write publish', async () => {
      await stageRootlessAssertion(nodeA, SAMEG_LABEL, 'same-graph-entity', [
        { subject: ENTITY_SAMEG, predicate: 'http://schema.org/name', object: '"Same-Graph Entity"' },
      ]);
      const wsDeadline = Date.now() + 10_000;
      while (Date.now() < wsDeadline) {
        const ws = await nodeB.query(
          `SELECT ?name WHERE { <${ENTITY_SAMEG}> <http://schema.org/name> ?name }`,
          { contextGraphId: SAMEG_LABEL, graphSuffix: '_shared_memory' },
        );
        if (ws.bindings.length > 0) break;
        await sleep(500);
      }

      const outcome = await legacyPublishOutcome(nodeA.publishFromSharedMemory(
        SAMEG_LABEL,
        'all',
        { clearSharedMemoryAfter: true },
      ));

      expect(outcome.status).not.toBe('confirmed');
      expect(outcome.error).toContain('CORE_VM_PROMOTION_DISABLED');
      const ctxDataGraph = `did:dkg:context-graph:${SAMEG_LABEL}/context/${samegOnChainId}`;
      const bPerCgIdData = await readPhysicalPlacement(nodeB,
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_SAMEG}> <http://schema.org/name> ?name } }`,
      );
      expect(bPerCgIdData.bindings.length).toBe(0);
    }, 60_000);
  });
});
