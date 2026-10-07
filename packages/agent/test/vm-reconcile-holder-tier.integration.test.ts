/**
 * The VM exact-recovery holder tier over real libp2p.
 *
 * A public Context Graph's finalized Verifiable-Memory data sits on a
 * sharding-table Core (the "holder"). The Edge that subscribed to the graph is
 * NOT connected to it and cannot reach it any other way than the holder's
 * unsigned phonebook profile: no curator, no connection, no gossip. Nothing but
 * the chain (ShardingTable membership and the wallet-to-identity binding) says
 * that profile is worth dialing.
 *
 * Real: three or four in-process agents over libp2p on 127.0.0.1, their
 * stores, the exact-asset sync transport, network admission, the on-chain
 * merkle-root check and the VM reconcile pass (`runVmReconcileForCg`). The
 * chains are the in-memory `MockChainAdapter`, each node reading its own copy
 * of the same facts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  MemoryLayer,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent, MockChainAdapter } from './agent.shared';
import { buildAgentProfile } from '../src/profile.js';

const CG_ID = 'holder-tier-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CG_ID)).toLowerCase();
const ON_CHAIN_ID = '41';
const PUBLISH_TX_HASH = `0x${'cd'.repeat(32)}`;
const PUBLISHER = '0x64529c023d853371228923B4FdA5FB22F929bf51';
const TRUE_VALUE = 'Octopuses have three hearts';
const FORGED_VALUE = 'Octopuses have nine hearts';
const ENTITY = 'urn:fact:octopus';

/** Operational wallets of two sharding-table Cores and the ShardingTable itself. */
const WALLET_HOLDER = '0x00000000000000000000000000000000000000a1';
const WALLET_FORGER = '0x00000000000000000000000000000000000000b2';
const IDENTITY_HOLDER = 7n;
const IDENTITY_FORGER = 8n;

const agents: DKGAgent[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
});

/**
 * One node's view of the chain: the public Context Graph 41, the two Cores'
 * operational wallets registered as identities, and a ShardingTable made of
 * them. `answers` lets a test take a fact away.
 */
async function chainFor(signer: string, options: {
  table?: bigint[] | 'unsupported';
} = {}): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter('mock:31337', signer, { initialContextGraphId: BigInt(ON_CHAIN_ID) });
  const created = await chain.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
    nameHash: NAME_HASH,
  } as never);
  expect(created.contextGraphId.toString()).toBe(ON_CHAIN_ID);
  chain.seedIdentity(WALLET_HOLDER, IDENTITY_HOLDER);
  chain.seedIdentity(WALLET_FORGER, IDENTITY_FORGER);
  const table = options.table ?? [IDENTITY_HOLDER, IDENTITY_FORGER];
  if (table === 'unsupported') {
    Object.defineProperty(chain, 'listDesignatableNodes', { value: undefined, configurable: true });
  } else {
    chain.listDesignatableNodes = async () => table.map((identityId) => ({
      nodeId: `0x${identityId.toString(16)}`,
      identityId,
      ask: 1n,
      stake: 1n,
    }));
  }
  return chain;
}

async function startAgent(name: string, chain: MockChainAdapter, nodeRole: 'core' | 'edge'): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    skills: [],
    nodeRole,
    chainAdapter: chain,
    // A real Edge signs sync requests with its default (owner) agent key.
    chainConfig: {
      rpcUrl: 'http://127.0.0.1:0',
      hubAddress: ethers.ZeroAddress,
      operationalKeys: [ethers.Wallet.createRandom().privateKey],
    },
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

const directAddress = (agent: DKGAgent): string =>
  agent.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!;

/**
 * A holder's side: the graph keyed by its cleartext id, bound to on-chain id
 * 41, holding one finalized KA (VM data + integrity metadata) whose data says
 * `value`. The metadata is self-consistent with that data; whether it matches
 * the CHAIN's root is what a forger gets wrong.
 */
async function seedHolder(
  holder: DKGAgent,
  chain: MockChainAdapter,
  value: string,
): Promise<{ ual: string; kaId: bigint; merkleRootHex: string }> {
  holder.subscribeToContextGraph(CG_ID, { onChainId: ON_CHAIN_ID });
  await holder.store.insert([{
    subject: contextGraphDataGraphUri(CG_ID),
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
    graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  }]);
  const storageAddress = await chain.getDKGKnowledgeAssetsAddress();
  const ual = `did:dkg:${chain.chainId}/${storageAddress}/1`;
  const assertionGraph = knowledgeAssetLayerGraphUri(
    CG_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, '1'),
  );
  const quad: Quad = {
    subject: ENTITY,
    predicate: 'http://schema.org/name',
    object: `"${value}"`,
    graph: assertionGraph,
  };
  const merkleRoot = computeFlatKCRootV10([quad], []);
  const metadata = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CG_ID,
    merkleRoot,
    publisherPeerId: holder.peerId,
    accessPolicy: 'public',
    timestamp: new Date(0),
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    assertionGraph,
  }, {
    status: 'confirmed',
    confirmation: {
      kind: 'transaction',
      provenance: {
        txHash: PUBLISH_TX_HASH,
        blockNumber: 1,
        blockTimestamp: 0,
        publisherAddress: PUBLISHER,
        batchId: 1n,
        chainId: chain.chainId,
      },
    },
  });
  await holder.store.insert([quad, ...metadata]);
  return { ual, kaId: (BigInt(storageAddress) << 96n) | 1n, merkleRootHex: ethers.hexlify(merkleRoot) };
}

/** The KA's on-chain registration in Context Graph 41 and its publish receipt. */
function registerKnowledgeAsset(chains: MockChainAdapter[], kaId: bigint, merkleRootHex: string): void {
  for (const chain of chains) {
    chain.__registerKC({
      kaId,
      contextGraphId: BigInt(ON_CHAIN_ID),
      merkleRootHex,
      chunks: [],
      publisherAddress: PUBLISHER,
    });
    chain.resolvePublishByTxHash = async (txHash: string) => (txHash === PUBLISH_TX_HASH
      ? {
        batchId: kaId,
        kaId,
        merkleRoot: ethers.getBytes(merkleRootHex),
        txHash,
        blockNumber: 1,
        txIndex: 0,
        blockTimestamp: 0,
        publisherAddress: PUBLISHER,
      }
      : null) as never;
  }
}

/** The Edge subscribed to the public graph by its cleartext id. */
function subscribeEdge(edge: DKGAgent): void {
  edge.onChainAccessPolicyCache.set(ON_CHAIN_ID, 0);
  edge.subscribeToContextGraph(CG_ID, { onChainId: ON_CHAIN_ID, syncMode: 'always-on' });
  expect(edge.getSubscribedContextGraphs().get(CG_ID)).toMatchObject({
    subscribed: true,
    onChainId: ON_CHAIN_ID,
  });
}

/**
 * A phonebook profile as a Core publishes it: its peer id next to its
 * operational wallet, with the addresses to dial. UNSIGNED: the Edge reads it
 * from its own store, exactly like a profile that arrived over `agents` sync.
 */
async function learnProfile(
  edge: DKGAgent,
  core: DKGAgent,
  options: { agentAddress?: string; nodeRole?: 'core' | 'edge'; lastSeen?: string } = {},
): Promise<void> {
  const { quads } = buildAgentProfile({
    peerId: core.peerId,
    name: `phonebook-${core.peerId.slice(-6)}`,
    skills: [],
    nodeRole: options.nodeRole ?? 'core',
    ...(options.agentAddress === undefined ? {} : { agentAddress: options.agentAddress }),
    multiaddrs: [directAddress(core)],
    lastSeen: options.lastSeen ?? new Date().toISOString(),
  });
  await edge.store.insert(quads);
}

async function vmValues(agent: DKGAgent): Promise<string[]> {
  const result = await agent.store.query(
    `SELECT ?o WHERE { GRAPH ?g { <${ENTITY}> <http://schema.org/name> ?o } `
    + `FILTER(STRSTARTS(STR(?g), ${JSON.stringify(`did:dkg:context-graph:${CG_ID}/`)})) }`,
    { source: 'test.holderTier.vm' } as never,
  );
  return result.type === 'bindings'
    ? result.bindings.map((row) => String(row['o']).replace(/^"|"$/g, '')).sort()
    : [];
}

const connectedTo = (edge: DKGAgent, peer: DKGAgent): boolean => edge.node.libp2p
  .getConnections()
  .some((connection) => connection.remotePeer.toString() === peer.peerId);

/**
 * Drive the Edge's VM reconcile pass until `done` holds or the deadline
 * passes. The per-graph fetch cooldown and rotation backoff are the product's
 * own dampers; the test only re-enters the pass, as the periodic sweep does.
 */
async function reconcileUntil(
  edge: DKGAgent,
  done: () => Promise<boolean>,
  timeoutMs = 45_000,
): Promise<boolean> {
  const internals = edge as unknown as {
    runVmReconcileForCg(cg: string, source: 'manual'): Promise<unknown>;
    vmReconcileFetchCooldowns: Map<string, unknown>;
    vmReconcileRotationState: Map<string, unknown>;
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await internals.runVmReconcileForCg(CG_ID, 'manual').catch(() => undefined);
    if (await done()) return true;
    internals.vmReconcileFetchCooldowns.delete(CG_ID);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return done();
}

/** Run a fixed number of reconcile rounds, for asserting that something did NOT happen. */
async function reconcileRounds(edge: DKGAgent, rounds: number): Promise<void> {
  const internals = edge as unknown as {
    runVmReconcileForCg(cg: string, source: 'manual'): Promise<unknown>;
    vmReconcileFetchCooldowns: Map<string, unknown>;
  };
  for (let round = 0; round < rounds; round += 1) {
    await internals.runVmReconcileForCg(CG_ID, 'manual').catch(() => undefined);
    internals.vmReconcileFetchCooldowns.delete(CG_ID);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('VM exact recovery reaches a ShardingTable holder the edge is not connected to', () => {
  it('fetches the finalized KA from a holder known only through its bound phonebook profile', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('TierHolder', holderChain, 'core');
    const edge = await startAgent('TierEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);
    await learnProfile(edge, holder, { agentAddress: WALLET_HOLDER });

    // Nothing connects them, and nothing but the profile mentions the holder.
    expect(connectedTo(edge, holder)).toBe(false);
    expect(await vmValues(edge)).toEqual([]);
    const exactFetch = vi.spyOn(edge, 'syncExactKnowledgeAssetsFromPeerDetailed');

    const reached = await reconcileUntil(edge, async () => (await vmValues(edge)).length === 1);

    expect(reached).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
    // It got there by dialing the holder, over the real sync protocol.
    expect(connectedTo(edge, holder)).toBe(true);
    expect(exactFetch.mock.calls.map(([peerId]) => peerId)).toContain(holder.peerId);
  }, 120_000);

  it('never dials a holder whose profile binds no operational wallet, and reaches it once one is bound', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('UnboundHolder', holderChain, 'core');
    const edge = await startAgent('UnboundEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);
    // A core-role profile that names the right peer and addresses, but no wallet.
    await learnProfile(edge, holder);
    const ensureConnected = vi.spyOn(edge, 'ensurePeerConnected');

    await reconcileRounds(edge, 4);

    expect(ensureConnected.mock.calls.map(([peerId]) => peerId)).not.toContain(holder.peerId);
    expect(connectedTo(edge, holder)).toBe(false);
    expect(await vmValues(edge)).toEqual([]);

    // The same peer with a wallet that is bound to a ShardingTable identity.
    await learnProfile(edge, holder, { agentAddress: WALLET_HOLDER });
    // A phonebook arrival: forget what the holder tier remembered, hints and graph sets together.
    (edge as unknown as { vmReconcileHolderTier?: { close(): void } }).vmReconcileHolderTier?.close();
    expect(await reconcileUntil(edge, async () => (await vmValues(edge)).length === 1)).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
  }, 120_000);

  it('reaches a holder whose profile sits behind more fresh junk profiles than one phonebook page holds', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('JunkAheadHolder', holderChain, 'core');
    const edge = await startAgent('JunkAheadEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);

    // 160 unregistered wallets that sort before the holder's, two fresh peers
    // each: 320 unsigned core-role rows, more than one page, all ahead of the
    // holder's own profile. Every wallet is real hex and every peer id unusable.
    const junkPeers: string[] = [];
    const quads: Quad[] = [];
    for (let wallet = 1; wallet <= 0xa0; wallet += 1) {
      for (const copy of ['A', 'B']) {
        const peerId = `12D3KooWJunk${wallet.toString(16).padStart(4, '0')}${copy}Unreachable`;
        junkPeers.push(peerId);
        quads.push(...buildAgentProfile({
          peerId,
          name: `junk-${wallet}-${copy}`,
          skills: [],
          nodeRole: 'core',
          agentAddress: `0x${'0'.repeat(36)}${wallet.toString(16).padStart(4, '0')}`,
          lastSeen: new Date().toISOString(),
        }).quads);
      }
    }
    await edge.store.insert(quads);
    expect(junkPeers.length).toBeGreaterThan(256);
    // The holder's own claim is the oldest in the phonebook (still recent enough
    // for its direct address to count), so a freshness-ordered read puts it last.
    await learnProfile(edge, holder, {
      agentAddress: WALLET_HOLDER,
      lastSeen: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const lookups = vi.spyOn(edgeChain, 'getIdentityIdForAddress');
    const ensureConnected = vi.spyOn(edge, 'ensurePeerConnected');

    const reached = await reconcileUntil(edge, async () => (await vmValues(edge)).length === 1);

    expect(reached).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
    expect(connectedTo(edge, holder)).toBe(true);
    // The junk cost one lookup per wallet at most, and none of its peers was ever dialed.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(0xa0 + 1);
    const dialed = new Set(ensureConnected.mock.calls.map(([peerId]) => peerId));
    expect(junkPeers.some((peerId) => dialed.has(peerId))).toBe(false);
  }, 120_000);

  it('walks on through a phonebook larger than one window until it reaches the holder behind it', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('WindowedHolder', holderChain, 'core');
    const edge = await startAgent('WindowedEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);

    // 160 unregistered wallets that sort before the holder's, seven fresh peers
    // each: 1,120 core-role rows, more than a resolution's four pages of 256.
    const junkPeers: string[] = [];
    const quads: Quad[] = [];
    for (let wallet = 1; wallet <= 0xa0; wallet += 1) {
      for (let copy = 0; copy < 7; copy += 1) {
        const peerId = `12D3KooWWide${wallet.toString(16).padStart(4, '0')}x${copy}Unreachable`;
        junkPeers.push(peerId);
        quads.push(...buildAgentProfile({
          peerId,
          name: `wide-${wallet}-${copy}`,
          skills: [],
          nodeRole: 'core',
          agentAddress: `0x${'0'.repeat(36)}${wallet.toString(16).padStart(4, '0')}`,
          lastSeen: new Date().toISOString(),
        }).quads);
      }
    }
    await edge.store.insert(quads);
    expect(junkPeers.length).toBeGreaterThan(4 * 256);
    await learnProfile(edge, holder, {
      agentAddress: WALLET_HOLDER,
      lastSeen: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    // The holder-tier cadence runs on the agent's rotation clock; let the test move it a minute per pass.
    let skew = 0;
    (edge as unknown as { vmReconcileRotationNow: () => number }).vmReconcileRotationNow = () => Date.now() + skew;
    const lookups = vi.spyOn(edgeChain, 'getIdentityIdForAddress');
    const ensureConnected = vi.spyOn(edge, 'ensurePeerConnected');

    const reached = await reconcileUntil(edge, async () => {
      skew += 61_000;
      return (await vmValues(edge)).length === 1;
    });

    expect(reached).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
    expect(connectedTo(edge, holder)).toBe(true);
    // Each wallet was resolved on chain at most once, and no junk peer was ever dialed.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(0xa0 + 1);
    const dialed = new Set(ensureConnected.mock.calls.map(([peerId]) => peerId));
    expect(junkPeers.some((peerId) => dialed.has(peerId))).toBe(false);
  }, 120_000);

  it('reaches a holder behind more distinct junk wallets than one resolution may ask the chain about, however far apart the sweeps run', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('DistinctJunkHolder', holderChain, 'core');
    const edge = await startAgent('DistinctJunkEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);

    // 1,100 unregistered wallets, one fresh peer each, all sorting before the holder's: more than four
    // resolutions' worth of lookups (256 each), so the first answers are older than a remembered
    // negative answer lives by the time the holder's row comes up.
    const JUNK = 1_100;
    const LATE_WALLET = '0xf0000000000000000000000000000000000000f1';
    edgeChain.seedIdentity(LATE_WALLET, IDENTITY_HOLDER);
    const junkPeers: string[] = [];
    const quads: Quad[] = [];
    // (Away from the two wallets this file registers on chain: a profile that claims one of those is
    // bound to a real identity, which is the accepted Phase 2 residual, not what this test is about.)
    for (let wallet = 0x1000; wallet < 0x1000 + JUNK; wallet += 1) {
      const peerId = `12D3KooWDistinct${wallet.toString(16).padStart(4, '0')}Unreachable`;
      junkPeers.push(peerId);
      quads.push(...buildAgentProfile({
        peerId,
        name: `distinct-${wallet}`,
        skills: [],
        nodeRole: 'core',
        agentAddress: `0x${'0'.repeat(36)}${wallet.toString(16).padStart(4, '0')}`,
        lastSeen: new Date().toISOString(),
      }).quads);
    }
    await edge.store.insert(quads);
    await learnProfile(edge, holder, {
      agentAddress: LATE_WALLET,
      lastSeen: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    // The holder tier's cadence runs on the agent's rotation clock. Two minutes per pass is what
    // the sweep really gives it (a resolution is due a minute after it ENDED, past the next tick),
    // and it is longer than a remembered negative answer lives (a minute per resolution in the
    // first design), so a walk that depends on those answers never gets past the junk.
    let skew = 0;
    (edge as unknown as { vmReconcileRotationNow: () => number }).vmReconcileRotationNow = () => Date.now() + skew;
    const lookups = vi.spyOn(edgeChain, 'getIdentityIdForAddress');
    const ensureConnected = vi.spyOn(edge, 'ensurePeerConnected');

    let passes = 0;
    const reached = await reconcileUntil(edge, async () => {
      passes += 1;
      skew += 121_000;
      return (await vmValues(edge)).length === 1;
    });

    expect(reached).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
    expect(connectedTo(edge, holder)).toBe(true);
    // 1,100 junk wallets at 256 lookups a resolution is five resolutions, the holder's the fifth or sixth.
    expect(passes).toBeLessThanOrEqual(Math.ceil(JUNK / 256) + 2);
    // Each wallet was resolved on chain once (junk and the holder's), and no junk peer was ever dialed.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(JUNK + 1);
    const dialed = new Set(ensureConnected.mock.calls.map(([peerId]) => peerId));
    expect(junkPeers.some((peerId) => dialed.has(peerId))).toBe(false);
  }, 120_000);

  it('rejects tampered content from a hinted holder and still recovers the true content from another', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const forgerChain = await chainFor('0x90F79bf6EB2c4f870365E785982E1f101E93b906');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('TrueHolder', holderChain, 'core');
    const forger = await startAgent('ForgingHolder', forgerChain, 'core');
    const edge = await startAgent('TamperEdge', edgeChain, 'edge');
    const trueKa = await seedHolder(holder, holderChain, TRUE_VALUE);
    // Same UAL, self-consistent metadata over DIFFERENT data: only the chain's
    // root tells the two apart.
    await seedHolder(forger, forgerChain, FORGED_VALUE);
    registerKnowledgeAsset([holderChain, forgerChain, edgeChain], trueKa.kaId, trueKa.merkleRootHex);
    subscribeEdge(edge);
    // The forger's profile is bound to a real ShardingTable identity; only the
    // holder's is left out until the forger has been tried.
    await learnProfile(edge, forger, { agentAddress: WALLET_FORGER });
    const exactFetch = vi.spyOn(edge, 'syncExactKnowledgeAssetsFromPeerDetailed');

    await reconcileUntil(
      edge,
      async () => exactFetch.mock.calls.some(([peerId]) => peerId === forger.peerId),
      30_000,
    );
    await reconcileRounds(edge, 3);
    // The forger was asked, and nothing it served became Verifiable Memory.
    expect(exactFetch.mock.calls.map(([peerId]) => peerId)).toContain(forger.peerId);
    expect(await vmValues(edge)).not.toContain(FORGED_VALUE);

    // The honest holder becomes known as well: the edge ends with the true content only.
    await learnProfile(edge, holder, { agentAddress: WALLET_HOLDER });
    // A phonebook arrival: forget what the holder tier remembered, hints and graph sets together.
    (edge as unknown as { vmReconcileHolderTier?: { close(): void } }).vmReconcileHolderTier?.close();
    expect(await reconcileUntil(edge, async () => (await vmValues(edge)).length > 0)).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
  }, 180_000);

  it('keeps syncing from a directly connected holder when the chain cannot answer the ShardingTable', async () => {
    const holderChain = await chainFor('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainFor('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', { table: 'unsupported' });
    const holder = await startAgent('FallbackHolder', holderChain, 'core');
    const unreachable = await startAgent('FallbackOther', holderChain, 'core');
    const edge = await startAgent('FallbackEdge', edgeChain, 'edge');
    const { kaId, merkleRootHex } = await seedHolder(holder, holderChain, TRUE_VALUE);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    subscribeEdge(edge);
    await learnProfile(edge, unreachable, { agentAddress: WALLET_FORGER });
    const ensureConnected = vi.spyOn(edge, 'ensurePeerConnected');
    await edge.connectTo(directAddress(holder));

    expect(await reconcileUntil(edge, async () => (await vmValues(edge)).length === 1)).toBe(true);
    expect(await vmValues(edge)).toEqual([TRUE_VALUE]);
    // The connected peer served it; the hinted-but-unverifiable one was never dialed.
    expect(ensureConnected.mock.calls.map(([peerId]) => peerId)).not.toContain(unreachable.peerId);
    expect(connectedTo(edge, unreachable)).toBe(false);
  }, 120_000);
});
