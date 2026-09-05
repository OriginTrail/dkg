import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { ethers, Wallet, Contract } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  buildUpdateAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  contextGraphFinalizationTopic,
  type PrecomputedUpdateAttestation,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  computePrivateRootV10,
  skolemizeKnowledgeAssetParts,
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
  const canonical = await skolemizeKnowledgeAssetParts(
    opts.quads,
    opts.privateQuads ?? [],
  );
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  const newMerkleRoot = computeFlatKCRootV10(
    canonical.publicQuads,
    privateRoot ? [privateRoot] : [],
  );
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
    ctx = await spawnHardhatEnv();
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
    await killHardhat(ctx);
  });

  it('creates agents with real EVMChainAdapter (no mocks)', async () => {
    const agentA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ChainNodeA',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      // This suite exercises the one-release legacy GossipSub rollback. In
      // 10.0.16 omission selects catalog authority and suppresses that topic.
      rfc64CatalogActivation: { enabled: false },
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3),
    });
    agents.push(agentA);

    const agentB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'ChainNodeB',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      rfc64CatalogActivation: { enabled: false },
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
        graph: '',
      },
      {
        subject: 'did:dkg:test:Alice',
        predicate: 'http://schema.org/knows',
        object: 'did:dkg:test:Bob',
        graph: '',
      },
    ];

    const result = await agents[0].publish(CONTEXT_GRAPH_ID, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest).toEqual([]);
    expect(result.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    expect(result.assertionVersion).toBe('1');
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.onChainResult!.batchId).toBeGreaterThan(0n);
    const scope = createGraphKnowledgeAssetScope(result.ual, result.assertionVersion!);
    expect(scope.ual).toBe(result.ual);
    expect((BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber))
      .toBe(result.onChainResult!.batchId);
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
        // V2 KAs commit one exact RDF triple set. The DKG-owned VM graph is
        // derived from the UAL; it is storage placement, not a caller-authored
        // RDF named graph.
        graph: '',
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
        graph: '',
      },
      {
        subject: 'did:dkg:test:Dave',
        predicate: 'http://schema.org/jobTitle',
        object: '"Researcher"',
        graph: '',
      },
    ];

    const result = await agents[0].publish(secondCG, quads);
    expect(result).toBeDefined();
    expect(result.kaManifest).toEqual([]);
    expect(result.publicTripleCount).toBe(quads.length);
    expect(result.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    const scope = createGraphKnowledgeAssetScope(result.ual, result.assertionVersion!);
    expect((BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber))
      .toBe(result.onChainResult!.batchId);
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
  // Multi-entity publish — rootless V2.
  // Subjects are data, not KA partitions: direct agent.publish commits the
  // complete six-triple set as one KA and emits no legacy root manifest.
  // -------------------------------------------------------------------------

  it('publishes multi-root payloads through agent.publish as one Knowledge Asset', async () => {
    const entities = ['urn:agent-e2e:entity-A', 'urn:agent-e2e:entity-B', 'urn:agent-e2e:entity-C'];
    const quads = entities.flatMap((e) => [
      {
        subject: e,
        predicate: 'http://schema.org/name',
        object: `"${e.split(':').pop()}"`,
        graph: '',
      },
      {
        subject: e,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://schema.org/Thing',
        graph: '',
      },
    ]);

    const result = await agents[0].publish(CONTEXT_GRAPH_ID, quads);

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.kaManifest).toEqual([]);
    expect(result.publicTripleCount).toBe(quads.length);
    expect(result.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
    const scope = createGraphKnowledgeAssetScope(result.ual, result.assertionVersion!);
    const exactGraph = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH_ID,
      MemoryLayer.VerifiableMemory,
      scope,
    );
    const exact = await (agents[0] as unknown as { store: {
      query: (sparql: string) => Promise<{ type: string; bindings?: Record<string, string>[] }>;
    } }).store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${exactGraph}> { ?s ?p ?o } }`,
    );
    expect(exact.type).toBe('bindings');
    expect(exact.bindings).toHaveLength(6);
    expect(new Set(exact.bindings!.map((binding) => binding.s))).toEqual(new Set(entities));
  }, 30_000);

  // -------------------------------------------------------------------------
  // Multi-node gossip verification
  // -------------------------------------------------------------------------

  it('second agent sees new publish via gossipsub without manual sync', async () => {

    const gossipCG = 'gossip-verification-e2e';
    await agents[0].createContextGraph({ id: gossipCG, name: 'Gossip Verification' });
    await agents[0].registerContextGraph(gossipCG);
    // Subscription is authorization gated on discovered CG metadata. A fixed
    // sleep could publish before the receiver knew the graph or its topic.
    await expect.poll(() => agents[1].contextGraphExists(gossipCG), { timeout: 10_000 }).toBe(true);
    agents[0].subscribeToContextGraph(gossipCG);
    agents[1].subscribeToContextGraph(gossipCG);
    await expect.poll(
      () => agents[0].gossip.getSubscribers(contextGraphFinalizationTopic(gossipCG)),
      { timeout: 10_000 },
    ).toContain(agents[1].peerId);

    const quads = [
      {
        subject: 'did:dkg:test:GossipEntity',
        predicate: 'http://schema.org/name',
        object: '"GossipTest"',
        graph: '',
      },
    ];

    const receiver = agents[1];
    const delivered = vi.spyOn(receiver.getOrCreateFinalizationHandler(), 'handleFinalizationMessage');
    try {
      await agents[0].publish(gossipCG, quads);
      await expect.poll(() => delivered.mock.calls.some(
        ([, cg, from]) => cg === gossipCG && from === agents[0].peerId,
      ), { timeout: 10_000 }).toBe(true);
      const deliveryIndex = delivered.mock.calls.findIndex(([, cg]) => cg === gossipCG);
      await delivered.mock.results[deliveryIndex].value;
      await expect.poll(async () => {
        const result = await receiver.query(
          `SELECT ?name WHERE { <did:dkg:test:GossipEntity> <http://schema.org/name> ?name }`,
          { contextGraphId: gossipCG },
        );
        return result.bindings.map((binding: any) => binding.name?.value ?? binding.name);
      }, { timeout: 10_000 }).toContain('"GossipTest"');
    } finally {
      delivered.mockRestore();
    }
  }, 60_000);
});
