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
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

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
      name: 'SubGossipA',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    nodeB = await DKGAgent.create({
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

  it('SWM write to sub-graph replicates via gossip', async () => {
    await nodeA.share(CG_ID, [
      { subject: 'urn:sg:paper:1', predicate: 'http://schema.org/name', object: '"DKG V10 Paper"', graph: '' },
      { subject: 'urn:sg:paper:1', predicate: 'http://schema.org/author', object: '"Research Team"', graph: '' },
    ], { subGraphName: SG_RESEARCH });

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
    await nodes[1].connectTo(addrA);
    await nodes[2].connectTo(addrA);
    await sleep(2000);

    const CG = 'concurrent-sg-e2e';
    await nodes[0].createContextGraph({ id: CG, name: 'Concurrent Sub-graph E2E' });
    for (const n of nodes) n.subscribeToContextGraph(CG);
    await sleep(1500);

    await nodes[0].createSubGraph(CG, 'alpha');
    await nodes[0].createSubGraph(CG, 'beta');
    await nodes[1].createSubGraph(CG, 'beta');

    // Node A writes to alpha, Node B writes to beta
    await Promise.all([
      nodes[0].share(CG, [
        { subject: 'urn:conc:alpha:1', predicate: 'http://schema.org/name', object: '"Alpha Data"', graph: '' },
      ], { subGraphName: 'alpha' }),
      nodes[1].share(CG, [
        { subject: 'urn:conc:beta:1', predicate: 'http://schema.org/name', object: '"Beta Data"', graph: '' },
      ], { subGraphName: 'beta' }),
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
