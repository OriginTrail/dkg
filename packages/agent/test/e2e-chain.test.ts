import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract } from 'ethers';
import { DKGAgent } from '../src/index.js';
import {
  spawnHardhatEnv,
  killHardhat,
  mintTokens,
  createNodeProfile,
  stakeAndSetAsk,
  HARDHAT_KEYS,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let ctx: HardhatContext | null = null;
const agents: DKGAgent[] = [];

function makeChainConfig(operationalKey: string) {
  return {
    rpcUrl: ctx!.rpcUrl,
    operationalKeys: [operationalKey],
    hubAddress: ctx!.hubAddress,
    chainId: `evm:31337`,
  };
}

let agentAIdentityId: number;
let agentBIdentityId: number;

describe('E2E: DKGAgent with real blockchain', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8547);
    if (!ctx) return;

    // Create on-chain profiles for agent keys so ensureProfile finds them
    agentAIdentityId = await createNodeProfile(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3,
      'AgentNodeA',
    );
    agentBIdentityId = await createNodeProfile(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.EXTRA2, HARDHAT_KEYS.PUBLISHER2,
      'AgentNodeB',
    );

    // Stake both agents so they can publish
    await stakeAndSetAsk(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.EXTRA1, agentAIdentityId);
    await stakeAndSetAsk(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.EXTRA2, agentBIdentityId);

    // Fund agents with additional tokens for publishing fees
    const nodeA = new Wallet(HARDHAT_KEYS.EXTRA1, ctx.provider);
    const nodeB = new Wallet(HARDHAT_KEYS.EXTRA2, ctx.provider);
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, nodeA.address, ethers.parseEther('500000'));
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, nodeB.address, ethers.parseEther('500000'));
  }, 120_000);

  afterAll(async () => {
    for (const agent of agents) {
      try { await agent.stop(); } catch { /* teardown best-effort */ }
    }
    killHardhat(ctx);
  });

  it('creates agents with real EVMChainAdapter (no mocks)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const agentA = await DKGAgent.create({
      name: 'ChainNodeA',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA1),
    });
    agents.push(agentA);

    const agentB = await DKGAgent.create({
      name: 'ChainNodeB',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA2),
    });
    agents.push(agentB);

    expect(agentA.wallet).toBeDefined();
    expect(agentB.wallet).toBeDefined();
  }, 60_000);

  it('starts agents and connects them', async (test) => {
    if (!ctx) { test.skip(); return; }
    await agents[0].start();
    await agents[1].start();

    const addrA = agents[0].multiaddrs[0];
    await agents[1].connectTo(addrA);

    await new Promise((r) => setTimeout(r, 2000));

    const peersA = agents[0].node.libp2p.getPeers();
    const peersB = agents[1].node.libp2p.getPeers();

    expect(peersA.length).toBeGreaterThanOrEqual(1);
    expect(peersB.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Publish + query
  // -------------------------------------------------------------------------

  const CONTEXT_GRAPH_ID = 'test-chain-paranet';
  let firstPublishBatchId: bigint;

  it('publishes knowledge through agent with on-chain finality', async (test) => {
    if (!ctx) { test.skip(); return; }

    await agents[0].createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Chain Test Paranet',
      description: 'E2E test with real blockchain',
    });

    agents[0].subscribeToContextGraph(CONTEXT_GRAPH_ID);
    agents[1].subscribeToContextGraph(CONTEXT_GRAPH_ID);
    await new Promise((r) => setTimeout(r, 1000));

    const quads = [
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/knows',
        object: 'did:dkg:test:Bob',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
    ];

    const result = await agents[0].publish(CONTEXT_GRAPH_ID, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest).toBeDefined();
    expect(result.kaManifest.length).toBeGreaterThan(0);
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
    expect(result.ual).toContain('did:dkg:evm:31337/');
    firstPublishBatchId = result.onChainResult!.batchId;
  }, 60_000);

  it('queries published knowledge', async (test) => {
    if (!ctx) { test.skip(); return; }
    const result = await agents[0].query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
    );

    expect(result).toBeDefined();
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('second agent receives published knowledge via gossipsub', async (test) => {
    if (!ctx) { test.skip(); return; }
    await new Promise((r) => setTimeout(r, 3000));

    const result = await agents[1].query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );

    expect(result).toBeDefined();
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBeGreaterThan(0);
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Update published KC
  // -------------------------------------------------------------------------

  it('updates published knowledge on-chain and verifies new data', async (test) => {
    if (!ctx) { test.skip(); return; }

    const kcId = firstPublishBatchId;
    const updateQuads = [
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/name',
        object: '"Alice Updated"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
    ];

    const updateResult = await agents[0].update(kcId, CONTEXT_GRAPH_ID, updateQuads);
    expect(updateResult).toBeDefined();
    expect(updateResult.merkleRoot).toHaveLength(32);
    expect(updateResult.status).toBe('confirmed');
    expect(updateResult.onChainResult).toBeDefined();
    expect(updateResult.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const queryResult = await agents[0].query(
      `SELECT ?name WHERE { <did:dkg:test:Alice> <http://schema.org/name> ?name }`,
    );
    expect(queryResult).toBeDefined();
    if (queryResult.type === 'bindings' && queryResult.bindings.length > 0) {
      const names = queryResult.bindings.map((b: any) => b.name?.value ?? b.name);
      expect(names.some((n: string) => n.includes('Alice Updated'))).toBe(true);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Second context graph + publish
  // -------------------------------------------------------------------------

  it('creates a second context graph and publishes on-chain', async (test) => {
    if (!ctx) { test.skip(); return; }

    const secondCG = 'test-chain-paranet-2';
    await agents[0].createContextGraph({
      id: secondCG,
      name: 'Second Chain Paranet',
      description: 'Second E2E context graph',
    });

    agents[0].subscribeToContextGraph(secondCG);
    await new Promise((r) => setTimeout(r, 500));

    const quads = [
      {
        subject: 'did:dkg:test:Dave',
        predicate: 'http://schema.org/name',
        object: '"Dave"',
        graph: `did:dkg:context-graph:${secondCG}`,
      },
      {
        subject: 'did:dkg:test:Dave',
        predicate: 'http://schema.org/jobTitle',
        object: '"Researcher"',
        graph: `did:dkg:context-graph:${secondCG}`,
      },
    ];

    const result = await agents[0].publish(secondCG, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest.length).toBeGreaterThan(0);
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();

    const queryResult = await agents[0].query(
      `SELECT ?title WHERE { <did:dkg:test:Dave> <http://schema.org/jobTitle> ?title }`,
      { contextGraphId: secondCG },
    );

    expect(queryResult).toBeDefined();
    if (queryResult.type === 'bindings') {
      expect(queryResult.bindings.length).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Multi-entity publish
  // -------------------------------------------------------------------------

  it('publishes multiple entities and queries them individually', async (test) => {
    if (!ctx) { test.skip(); return; }

    const entities = ['urn:agent-e2e:entity-A', 'urn:agent-e2e:entity-B', 'urn:agent-e2e:entity-C'];
    const quads = entities.flatMap((e) => [
      {
        subject: e,
        predicate: 'http://schema.org/name',
        object: `"${e.split(':').pop()}"`,
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
      {
        subject: e,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://schema.org/Thing',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
    ]);

    const result = await agents[0].publish(CONTEXT_GRAPH_ID, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest.length).toBe(3);
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();

    for (const entity of entities) {
      const queryResult = await agents[0].query(
        `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`,
      );
      expect(queryResult).toBeDefined();
      if (queryResult.type === 'bindings') {
        expect(queryResult.bindings.length).toBeGreaterThanOrEqual(1);
      }
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Multi-node gossip verification
  // -------------------------------------------------------------------------

  it('second agent sees new publish via gossipsub without manual sync', async (test) => {
    if (!ctx) { test.skip(); return; }

    const gossipCG = 'gossip-verification-cg';
    await agents[0].createContextGraph({
      id: gossipCG,
      name: 'Gossip Verification',
    });

    agents[0].subscribeToContextGraph(gossipCG);
    agents[1].subscribeToContextGraph(gossipCG);
    await new Promise((r) => setTimeout(r, 1000));

    const quads = [
      {
        subject: 'did:dkg:test:GossipEntity',
        predicate: 'http://schema.org/name',
        object: '"GossipTest"',
        graph: `did:dkg:context-graph:${gossipCG}`,
      },
    ];

    await agents[0].publish(gossipCG, quads);

    // Wait for gossip propagation
    await new Promise((r) => setTimeout(r, 3000));

    const result = await agents[1].query(
      `SELECT ?name WHERE { <did:dkg:test:GossipEntity> <http://schema.org/name> ?name }`,
    );

    expect(result).toBeDefined();
    if (result.type === 'bindings') {
      expect(result.bindings.length).toBeGreaterThanOrEqual(1);
      const names = result.bindings.map((b: any) => b.name?.value ?? b.name);
      expect(names.some((n: string) => n.includes('GossipTest'))).toBe(true);
    }
  }, 60_000);
});
