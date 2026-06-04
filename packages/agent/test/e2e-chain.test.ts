import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  buildUpdateAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
  type PrecomputedUpdateAttestation,
} from '@origintrail-official/dkg-core';
import {
  autoPartition,
  computeFlatKCRootV10,
  computePrivateRootV10,
} from '../../publisher/src/index.js';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  spawnHardhatEnv,
  killHardhat,
  mintTokens,
  createNodeProfile,
  stakeAndSetAsk,
  makeAdapterConfig,
  HARDHAT_KEYS,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

/**
 * V10 greenfield updates require a `precomputedUpdateAttestation` signed by
 * the KA author (the wallet whose ACK quorum produced the original publish).
 * The agent's `update()` does not auto-mint one — the publisher's
 * `publish()` does have an inline mint helper, but the update path was
 * deliberately left as caller-supplied (RFC 38 / LU-9). This local helper
 * mirrors `buildUpdateSeal` from `packages/publisher/test/_helpers/seal.ts`,
 * inlined here to avoid leaking publisher test helpers into agent tests.
 */
async function buildUpdateSeal(opts: {
  kaId: bigint;
  quads: Quad[];
  privateQuads?: Quad[];
  author: Wallet;
  provider: ethers.JsonRpcProvider;
  kav10Address: string;
}): Promise<PrecomputedUpdateAttestation> {
  const kaMap = autoPartition(opts.quads);
  const allPublic = [...kaMap.values()].flat();
  const privateRoots: Uint8Array[] = [];
  for (const rootEntity of kaMap.keys()) {
    const entityPrivateQuads = (opts.privateQuads ?? []).filter(
      (q) =>
        q.subject === rootEntity ||
        q.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    if (entityPrivateQuads.length === 0) continue;
    const root = computePrivateRootV10(entityPrivateQuads);
    if (root) privateRoots.push(root);
  }
  const newMerkleRoot = computeFlatKCRootV10(allPublic, privateRoots);
  const chainId = await opts.provider.getNetwork().then((n) => n.chainId);
  const td = buildUpdateAuthorAttestationTypedData({
    chainId: BigInt(chainId),
    kav10Address: opts.kav10Address,
    kaId: opts.kaId,
    newMerkleRoot,
    authorAddress: opts.author.address,
  });
  const sigHex = await opts.author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedNewMerkleRoot: newMerkleRoot,
    authorAddress: opts.author.address,
    signature: {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

let ctx: HardhatContext;
const agents: DKGAgent[] = [];

function makeChainConfig(operationalKey: string, adminPrivateKey: string) {
  return {
    rpcUrl: ctx!.rpcUrl,
    adminPrivateKey,
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

  it('creates agents with real EVMChainAdapter (no mocks)', async () => {
    const agentA = await DKGAgent.create({
      name: 'ChainNodeA',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3),
    });
    agents.push(agentA);

    const agentB = await DKGAgent.create({
      name: 'ChainNodeB',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA2, HARDHAT_KEYS.PUBLISHER2),
    });
    agents.push(agentB);

    expect(agentA.wallet).toBeDefined();
    expect(agentB.wallet).toBeDefined();
  }, 60_000);

  it('starts agents and connects them', async () => {
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

  let CONTEXT_GRAPH_ID: string;
  let firstPublishBatchId: bigint;

  it('publishes knowledge through agent with on-chain finality', async () => {

    // Create an on-chain V10 context graph with the agent's identity as a hosting node
    const chainAdapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.EXTRA1),
    );
    const cgResult = await chainAdapter.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    CONTEXT_GRAPH_ID = String(cgResult.contextGraphId);

    await agents[0].createContextGraph({
      id: CONTEXT_GRAPH_ID,
      name: 'Chain Test ContextGraph',
      description: 'E2E test with real blockchain',
    });

    // Store the numeric on-chain ID so the V10 publish path can find it
    const sub = (agents[0] as any).subscribedContextGraphs.get(CONTEXT_GRAPH_ID);
    if (sub) sub.onChainId = CONTEXT_GRAPH_ID;

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

  it('queries published knowledge', async () => {
    const result = await agents[0].query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10',
    );

    expect(result).toBeDefined();
    expect(result.bindings).toBeDefined();
    expect(result.bindings.length).toBeGreaterThan(0);
  }, 30_000);

  it('second agent receives published knowledge via gossipsub', async () => {
    await new Promise((r) => setTimeout(r, 3000));

    const result = await agents[1].query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH_ID },
    );

    expect(result).toBeDefined();
    expect(result.bindings).toBeDefined();
    expect(result.bindings.length).toBeGreaterThan(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Update published KC
  // -------------------------------------------------------------------------

  it('updates published knowledge on-chain and verifies new data', async () => {

    const kaId = firstPublishBatchId;
    const updateQuads = [
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/name',
        object: '"Alice Updated"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      },
    ];

    // V10 greenfield: caller must supply the signed author attestation.
    // The original publish was authored by EXTRA1 (agentA's operational
    // key), so the update seal has to be produced by that same wallet.
    const chainAdapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.EXTRA1),
    );
    const author = new Wallet(HARDHAT_KEYS.EXTRA1, ctx.provider);
    const precomputedUpdateAttestation = await buildUpdateSeal({
      kaId,
      quads: updateQuads,
      author,
      provider: ctx.provider,
      kav10Address: await chainAdapter.getKnowledgeAssetsLifecycleAddress(),
    });

    const updateResult = await agents[0].update(
      kaId,
      CONTEXT_GRAPH_ID,
      updateQuads,
      undefined,
      { precomputedUpdateAttestation },
    );
    expect(updateResult).toBeDefined();
    expect(updateResult.merkleRoot).toHaveLength(32);
    expect(updateResult.status).toBe('confirmed');
    expect(updateResult.onChainResult).toBeDefined();
    expect(updateResult.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const queryResult = await agents[0].query(
      `SELECT ?name WHERE { <did:dkg:test:Alice> <http://schema.org/name> ?name }`,
      { contextGraphId: CONTEXT_GRAPH_ID },
    );
    expect(queryResult).toBeDefined();
    expect(queryResult.bindings).toBeDefined();
    expect(queryResult.bindings.length).toBeGreaterThan(0);
    const names = queryResult.bindings.map((b: any) => b.name?.value ?? b.name);
    expect(names.some((n: string) => n.includes('Alice Updated'))).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Second context graph + publish
  // -------------------------------------------------------------------------

  it('creates a second context graph and publishes on-chain', async () => {

    const chainAdapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.EXTRA1),
    );
    const cgResult = await chainAdapter.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const secondCG = String(cgResult.contextGraphId);

    await agents[0].createContextGraph({
      id: secondCG,
      name: 'Second Chain ContextGraph',
      description: 'Second E2E context graph',
    });
    const sub2 = (agents[0] as any).subscribedContextGraphs.get(secondCG);
    if (sub2) sub2.onChainId = secondCG;

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
    expect(queryResult.bindings).toBeDefined();
    expect(queryResult.bindings.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Multi-entity publish — OT-RFC-44 / Design B.
  // Direct agent.publish now routes multi-root payloads as one KA with multiple
  // member entities. The on-chain publish still uses knowledgeAssetsAmount=1;
  // the manifest keeps per-root compatibility token IDs for UAL suffix callers.
  // -------------------------------------------------------------------------

  it('publishes multi-root payloads through agent.publish as one Knowledge Asset', async () => {
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

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(new Set(result.kaManifest.map((m) => m.rootEntity))).toEqual(new Set(entities));
    expect(new Set(result.kaManifest.map((m) => String(m.tokenId)))).toEqual(new Set(['1', '2', '3']));
    expect(new Set(result.kaManifest.map((m: any) => String(m.metadataTokenId)))).toEqual(new Set(['1', '2', '3']));
  }, 30_000);

  // -------------------------------------------------------------------------
  // Multi-node gossip verification
  // -------------------------------------------------------------------------

  it('second agent sees new publish via gossipsub without manual sync', async () => {

    const chainAdapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.EXTRA1),
    );
    const cgResult = await chainAdapter.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const gossipCG = String(cgResult.contextGraphId);

    await agents[0].createContextGraph({
      id: gossipCG,
      name: 'Gossip Verification',
    });
    const sub3 = (agents[0] as any).subscribedContextGraphs.get(gossipCG);
    if (sub3) sub3.onChainId = gossipCG;

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
      { contextGraphId: gossipCG },
    );

    expect(result).toBeDefined();
    expect(result.bindings).toBeDefined();
    expect(result.bindings.length).toBeGreaterThanOrEqual(1);
    const names = result.bindings.map((b: any) => b.name?.value ?? b.name);
    expect(names.some((n: string) => n.includes('GossipTest'))).toBe(true);
  }, 60_000);
});
