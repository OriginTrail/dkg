/**
 * E2E tests for sub-graph replication and gossip:
 *
 * 1. Sub-graph SWM write replicates via gossip to peer
 * 2. Sub-graph publish from SWM → finalization → peer promotes
 * 3. Assertion promote to sub-graph SWM → gossips to peer
 * 4. Sub-graph isolation in gossip: data in one sub-graph doesn't appear in another
 * 5. Sub-graph data doesn't leak to root CG queries
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent as RealDKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
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

const CG_ID = 'sg-gossip-e2e';
const SG_RESEARCH = 'research';
const SG_CODE = 'code';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pollUntil(
  queryFn: () => Promise<{ bindings: any[] }>,
  predicate: (bindings: any[]) => boolean,
  timeoutMs: number,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: any[] = [];
  while (Date.now() < deadline) {
    const result = await queryFn();
    lastResult = result.bindings;
    if (predicate(lastResult)) return lastResult;
    await sleep(500);
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
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('Sub-graph gossip replication (2 nodes)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  beforeAll(async () => {
    nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubGossipA',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'SubGossipB',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    await nodeA.createContextGraph({ id: CG_ID, name: 'Sub-graph Gossip E2E' });
    await nodeA.registerContextGraph(CG_ID);
    nodeA.subscribeToContextGraph(CG_ID);
    nodeB.subscribeToContextGraph(CG_ID);
    await sleep(1500);

    await nodeA.createSubGraph(CG_ID, SG_RESEARCH, { description: 'Papers' });
    await nodeA.createSubGraph(CG_ID, SG_CODE, { description: 'Source code' });
  }, 20_000);

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
  });

  it('rootless SWM assertion in a sub-graph replicates via gossip', async () => {
    await nodeA.assertion.create(CG_ID, 'research-draft', { subGraphName: SG_RESEARCH });
    await nodeA.assertion.write(CG_ID, 'research-draft', [
      { subject: 'urn:sg:paper:1', predicate: 'http://schema.org/name', object: '"DKG V10 Paper"' },
      { subject: 'urn:sg:paper:1', predicate: 'http://schema.org/author', object: '"Research Team"' },
    ], { subGraphName: SG_RESEARCH });
    await nodeA.assertion.promote(CG_ID, 'research-draft', { subGraphName: SG_RESEARCH });

    const bBindings = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
        { contextGraphId: CG_ID, subGraphName: SG_RESEARCH, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bBindings.length).toBe(1);
    expect(bBindings[0]?.['name']).toBe('"DKG V10 Paper"');
  }, 25_000);

  it('sub-graph data doesn\'t leak to a different sub-graph SWM', async () => {
    const codeSwm = await nodeB.query(
      `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, subGraphName: SG_CODE, graphSuffix: '_shared_memory' },
    );
    expect(codeSwm.bindings.length).toBe(0);
  }, 10_000);

  it('sub-graph data doesn\'t appear in root CG SWM query', async () => {
    const rootSwm = await nodeA.query(
      `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(rootSwm.bindings.length).toBe(0);
  }, 10_000);

  it('assertion promote to sub-graph SWM gossips to peer', async () => {
    await nodeA.assertion.create(CG_ID, 'code-draft', { subGraphName: SG_CODE });
    await nodeA.assertion.write(CG_ID, 'code-draft', [
      { subject: 'urn:sg:module:parser', predicate: 'http://schema.org/name', object: '"Parser Module"' },
    ], { subGraphName: SG_CODE });

    await nodeA.assertion.promote(CG_ID, 'code-draft', { subGraphName: SG_CODE });

    const bCode = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <urn:sg:module:parser> <http://schema.org/name> ?name }`,
        { contextGraphId: CG_ID, subGraphName: SG_CODE, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bCode.length).toBe(1);
    expect(bCode[0]?.['name']).toBe('"Parser Module"');
  }, 25_000);

  it('publish sub-graph SWM → finalization → B promotes to data graph', async () => {
    const result = await nodeA.publishFromSharedMemory(CG_ID, 'all', {
      subGraphName: SG_RESEARCH,
    });

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();

    // A's data graph should have the research paper
    const aData = await nodeA.query(
      `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, subGraphName: SG_RESEARCH },
    );
    expect(aData.bindings.length).toBe(1);

    // B should receive finalization and promote
    const bData = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
        { contextGraphId: CG_ID, subGraphName: SG_RESEARCH },
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bData.length).toBe(1);
    expect(bData[0]?.['name']).toBe('"DKG V10 Paper"');
  }, 30_000);

  it('published sub-graph data still not in root CG data graph', async () => {
    const rootData = await nodeA.query(
      `SELECT ?name WHERE { <urn:sg:paper:1> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(rootData.bindings.length).toBe(0);
  }, 10_000);
});

describe('Multiple sub-graphs with concurrent writes (3 nodes)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const localAgents: DKGAgent[] = [];

  afterAll(async () => {
    for (const a of localAgents) {
      try { await a.stop(); } catch {}
    }
  });

  it('concurrent SWM writes to different sub-graphs replicate correctly', async () => {
    const nodes = await Promise.all(
      ['ConcA', 'ConcB', 'ConcC'].map(async (name) => {
        const agent = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
          name,
          listenPort: 0,
          chainAdapter: sharedChain,
        });
        localAgents.push(agent);
        await agent.start();
        return agent;
      }),
    );
    await sleep(500);

    const addrA = nodes[0].multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    const addrB = nodes[1].multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodes[1].connectTo(addrA);
    await nodes[2].connectTo(addrA);
    // A star only guarantees that A sees both publishers/subscribers. The
    // active SWM fan-out deliberately targets the publisher's own live
    // subscriber set, so B cannot be expected to deliver its concurrent beta
    // write to C until B and C have exchanged subscriptions. Fully mesh this
    // three-node test and prove the transport precondition before asserting
    // all-recipient replication.
    await nodes[2].connectTo(addrB);
    const peersDeadline = Date.now() + 5_000;
    while (
      Date.now() < peersDeadline
      && nodes.some((node) => node.node.libp2p.getPeers().length < 2)
    ) {
      await sleep(100);
    }
    for (const node of nodes) {
      expect(node.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(2);
    }
    await sleep(2000);

    const CG = 'concurrent-sg-e2e';
    await nodes[0].createContextGraph({ id: CG, name: 'Concurrent Sub-graph E2E' });

    // Discovery gossip is asynchronous. Subscribing B/C before they have the
    // CG metadata is an authorization-denied no-op and made this test depend
    // on timing/state left by earlier cases in the file.
    const discoveryDeadline = Date.now() + 10_000;
    let cgKnown = [true, false, false];
    while (Date.now() < discoveryDeadline) {
      cgKnown = await Promise.all(nodes.map((node) => node.contextGraphExists(CG)));
      if (cgKnown.every(Boolean)) break;
      await sleep(250);
    }
    expect(cgKnown).toEqual([true, true, true]);

    for (const n of nodes) n.subscribeToContextGraph(CG);
    const subscriberDeadline = Date.now() + 10_000;
    let subscriberCounts = [0, 0, 0];
    const swmWireId = ethers.keccak256(ethers.toUtf8Bytes(CG)).toLowerCase();
    const swmTopic = `dkg/context-graph/${swmWireId}/shared-memory`;
    while (Date.now() < subscriberDeadline) {
      subscriberCounts = nodes.map((node) => node.gossip.getSubscribers(swmTopic).length);
      if (subscriberCounts.every((count) => count >= 2)) break;
      await sleep(250);
    }
    expect(subscriberCounts).toEqual([2, 2, 2]);

    await nodes[0].createSubGraph(CG, 'alpha');
    await nodes[0].createSubGraph(CG, 'beta');
    await nodes[1].createSubGraph(CG, 'beta');

    // Node A writes a rootless assertion to alpha, Node B writes one to beta.
    // Direct `share()` is the read-only legacy/root-scoped API and must not be
    // used for new V10 KAs.
    await Promise.all([
      (async () => {
        await nodes[0].assertion.create(CG, 'alpha-draft', { subGraphName: 'alpha' });
        await nodes[0].assertion.write(CG, 'alpha-draft', [
          { subject: 'urn:conc:alpha:1', predicate: 'http://schema.org/name', object: '"Alpha Data"' },
        ], { subGraphName: 'alpha' });
        await nodes[0].assertion.promote(CG, 'alpha-draft', { subGraphName: 'alpha' });
      })(),
      (async () => {
        await nodes[1].assertion.create(CG, 'beta-draft', { subGraphName: 'beta' });
        await nodes[1].assertion.write(CG, 'beta-draft', [
          { subject: 'urn:conc:beta:1', predicate: 'http://schema.org/name', object: '"Beta Data"' },
        ], { subGraphName: 'beta' });
        await nodes[1].assertion.promote(CG, 'beta-draft', { subGraphName: 'beta' });
      })(),
    ]);

    // Node C should eventually see both
    const cAlpha = await pollUntil(
      () => nodes[2].query(
        `SELECT ?name WHERE { <urn:conc:alpha:1> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: 'alpha', graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(cAlpha.length).toBe(1);

    const cBeta = await pollUntil(
      () => nodes[2].query(
        `SELECT ?name WHERE { <urn:conc:beta:1> <http://schema.org/name> ?name }`,
        { contextGraphId: CG, subGraphName: 'beta', graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(cBeta.length).toBe(1);

    // Cross-isolation: alpha data not in beta
    const betaCheck = await nodes[2].query(
      `SELECT ?name WHERE { <urn:conc:alpha:1> <http://schema.org/name> ?name }`,
      { contextGraphId: CG, subGraphName: 'beta', graphSuffix: '_shared_memory' },
    );
    expect(betaCheck.bindings.length).toBe(0);
  }, 45_000);
});
