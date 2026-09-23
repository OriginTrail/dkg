/**
 * Reproduces Base-mainnet Context Graph #33 (2026-09-23) with two in-process
 * agents over real libp2p on 127.0.0.1.
 *
 * The edge learned the public graph only from `ContextGraphCreated`, which
 * carries `nameHash = keccak256(utf8(id))`, and subscribed by that hash. The
 * holder keys the graph (and its finalized VM data) by the cleartext id. Every
 * request the edge makes under the hash is answered `clean-absent`; after the
 * edge learns and verifies the cleartext id it adopts it and the same exact VM
 * fetch returns the data.
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
  tripleContentV10,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent, MockChainAdapter } from './agent.shared';
import { PROTOCOL_CONTEXT_GRAPH_NAME } from '../src/context-graph-name-protocol.js';

const CLEARTEXT_ID = 'acme-fun-facts';
const NAME_HASH = ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT_ID)).toLowerCase();
const ON_CHAIN_ID = '33';
const PUBLISH_TX_HASH = `0x${'ab'.repeat(32)}`;
const PUBLISHER = '0x64529c023d853371228923B4FdA5FB22F929bf51';

const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents) {
    try { await agent.stop(); } catch { /* best effort */ }
  }
  agents.length = 0;
});

/**
 * Each node reads its own view of the same chain: Context Graph 33 committed
 * to the cleartext id's name hash, with the given access policy.
 */
async function chainWithContextGraph33(signer: string, accessPolicy: 0 | 1 = 0): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter('mock:31337', signer, { initialContextGraphId: BigInt(ON_CHAIN_ID) });
  const created = await chain.createOnChainContextGraph({
    accessPolicy,
    publishPolicy: 1,
    nameHash: NAME_HASH,
  } as never);
  expect(created.contextGraphId.toString()).toBe(ON_CHAIN_ID);
  return chain;
}

async function startAgent(name: string, chain: MockChainAdapter): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    listenHost: '127.0.0.1',
    listenPort: 0,
    skills: [],
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

/**
 * The holder's side of #33: it keys the public graph by its cleartext id,
 * bound to on-chain id 33, and holds one finalized KA (VM data + integrity
 * metadata), exactly as a holder that ACK-signed and promoted it would.
 */
async function seedHolder(
  holder: DKGAgent,
  chain: MockChainAdapter,
): Promise<{ ual: string; quad: Quad; kaId: bigint; merkleRootHex: string }> {
  holder.subscribeToContextGraph(CLEARTEXT_ID, { onChainId: ON_CHAIN_ID });
  // The creator's public definition, as `createContextGraph` writes it and
  // cores re-sync it from each other on connect.
  await holder.store.insert([{
    subject: contextGraphDataGraphUri(CLEARTEXT_ID),
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
    graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  }]);
  const storageAddress = await chain.getDKGKnowledgeAssetsAddress();
  const ual = `did:dkg:${chain.chainId}/${storageAddress}/1`;
  const assertionGraph = knowledgeAssetLayerGraphUri(
    CLEARTEXT_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ual, '1'),
  );
  const quad: Quad = {
    subject: 'urn:fact:octopus',
    predicate: 'http://schema.org/name',
    object: '"Octopuses have three hearts"',
    graph: assertionGraph,
  };
  const merkleRoot = computeFlatKCRootV10([quad], []);
  const metadata = generateGraphKnowledgeAssetMetadata({
    ual,
    contextGraphId: CLEARTEXT_ID,
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
  return { ual, quad, kaId: (BigInt(storageAddress) << 96n) | 1n, merkleRootHex: ethers.hexlify(merkleRoot) };
}

/**
 * The KA's on-chain registration in Context Graph 33 and its publish receipt,
 * as each node's chain reports them.
 */
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

/**
 * The edge's side of #33: the finalized `ContextGraphCreated` event staged a
 * hash-keyed placeholder bound to on-chain 33 (policy public), and the
 * operator ran `dkg subscribe <nameHash>`.
 */
function seedEdge(edge: DKGAgent): void {
  expect(edge.stageOnChainContextGraphBindingFromNameHash(NAME_HASH, ON_CHAIN_ID)).toBe(NAME_HASH);
  edge.onChainAccessPolicyCache.set(ON_CHAIN_ID, 0);
  edge.subscribeToContextGraph(NAME_HASH, { syncMode: 'always-on' });
  const row = edge.getSubscribedContextGraphs().get(NAME_HASH);
  expect(row).toMatchObject({ subscribed: true, onChainHash: NAME_HASH, onChainId: ON_CHAIN_ID });
}

async function connect(edge: DKGAgent, holder: DKGAgent): Promise<void> {
  const address = holder.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
  await edge.connectTo(address);
  // Identify must finish before the edge can see which protocols the holder speaks.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const protocols = await edge.node.libp2p.peerStore.get(holder.node.libp2p.peerId)
      .then((peer) => peer.protocols)
      .catch(() => [] as string[]);
    if (protocols.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('identify did not complete');
}

async function vmQuadCount(agent: DKGAgent, contextGraphId: string): Promise<number> {
  const result = await agent.store.query(
    `SELECT ?o WHERE { GRAPH ?g { <urn:fact:octopus> <http://schema.org/name> ?o } `
    + `FILTER(STRSTARTS(STR(?g), ${JSON.stringify(`did:dkg:context-graph:${contextGraphId}/`)})) }`,
    { source: 'test.nameHashSubscription.vm' } as never,
  );
  return result.type === 'bindings' ? result.bindings.length : 0;
}

describe('Context Graph known only by its on-chain name hash (#33)', () => {
  it('repairs challenge-pinned historical material over the real sync transport after name adoption', async () => {
    const holderChain = await chainWithContextGraph33('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainWithContextGraph33('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('RepairHolder33', holderChain);
    const edge = await startAgent('RepairEdge33', edgeChain);
    const { ual, quad, kaId, merkleRootHex } = await seedHolder(holder, holderChain);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    seedEdge(edge);
    await connect(edge, holder);
    expect(await edge.resolveContextGraphNameHashNow(NAME_HASH)).toBe(CLEARTEXT_ID);
    const exactFetch = vi.spyOn(edge, 'syncExactKnowledgeAssetsFromPeerDetailed');

    // This goes through peer admission, the real libp2p sync protocol and
    // challenge-pinned authentication; no proof material is mocked here.
    const repaired = await edge.repairRandomSamplingKnowledgeAsset({
      kaId,
      cgId: BigInt(ON_CHAIN_ID),
      expectedRoot: ethers.getBytes(merkleRootHex),
      expectedLeafCount: 1n,
    }).result;
    expect(repaired).toEqual({
      contents: [tripleContentV10(quad.subject, quad.predicate, quad.object)],
      privateRoots: [],
    });
    expect(exactFetch).toHaveBeenCalledWith(
      holder.peerId,
      CLEARTEXT_ID,
      expect.objectContaining({
        kind: 'challenge-pinned',
        commitments: [{ assetUal: ual, merkleRootHex: merkleRootHex.slice(2), merkleLeafCount: 1n }],
      }),
      expect.anything(),
    );
  }, 120_000);

  it('syncs nothing under the hash, then adopts the verified cleartext id and syncs the VM data', async () => {
    const holderChain = await chainWithContextGraph33('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainWithContextGraph33('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('Holder33', holderChain);
    const edge = await startAgent('Edge33', edgeChain);
    const { ual, kaId, merkleRootHex } = await seedHolder(holder, holderChain);
    registerKnowledgeAsset([holderChain, edgeChain], kaId, merkleRootHex);
    seedEdge(edge);
    await connect(edge, holder);

    // Before: every exact VM fetch under the hash is clean-absent (live: 101
    // requests, 0 of 25 KAs).
    const before = await edge.syncExactKnowledgeAssetsFromPeerDetailed(holder.peerId, NAME_HASH, [ual]);
    expect(before.disposition).toBe('clean-absent');
    expect(await vmQuadCount(edge, NAME_HASH)).toBe(0);

    // The holder advertises the name protocol; the edge asks it, verifies the
    // answer against the on-chain hash, and promotes the row.
    const resolved = await edge.resolveContextGraphNameHashNow(NAME_HASH);
    expect(resolved).toBe(CLEARTEXT_ID);
    const subscriptions = edge.getSubscribedContextGraphs();
    expect(subscriptions.has(NAME_HASH)).toBe(false);
    expect(subscriptions.get(CLEARTEXT_ID)).toMatchObject({
      subscribed: true,
      syncMode: 'always-on',
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    expect(edge.resolveContextGraphIdAlias(NAME_HASH)).toBe(CLEARTEXT_ID);
    expect(edge.getContextGraphNameResolutionStatus()).toContainEqual(expect.objectContaining({
      state: 'resolved',
      nameHash: NAME_HASH,
      contextGraphId: CLEARTEXT_ID,
      source: 'peer-protocol',
    }));

    // After: the edge's own post-adoption sync, now under the cleartext id,
    // delivers the finalized VM data the hash could never reach.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && await vmQuadCount(edge, CLEARTEXT_ID) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await vmQuadCount(edge, CLEARTEXT_ID)).toBe(1);
  }, 120_000);

  it('resolves through the ontology graph of a peer that predates the name protocol', async () => {
    const holderChain = await chainWithContextGraph33('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const edgeChain = await chainWithContextGraph33('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const holder = await startAgent('OldHolder33', holderChain);
    // A 10.0.17/10.0.18 peer: no name protocol, ordinary sync only.
    holder.router.unregister(PROTOCOL_CONTEXT_GRAPH_NAME);
    const edge = await startAgent('Edge33Ontology', edgeChain);
    await seedHolder(holder, holderChain);
    seedEdge(edge);
    await connect(edge, holder);

    const protocols = (await edge.node.libp2p.peerStore.get(holder.node.libp2p.peerId)).protocols;
    expect(protocols).not.toContain(PROTOCOL_CONTEXT_GRAPH_NAME);

    // Even asked directly (past the identify pre-check), an old peer is a
    // quiet miss: no answer, no warning or error output, no penalty.
    const warnings: string[] = [];
    const edgeLog = (edge as unknown as { log: { warn: (...args: unknown[]) => void } }).log;
    const originalWarn = edgeLog.warn;
    edgeLog.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const answer = await edge.askPeerForContextGraphName(
        holder.peerId,
        { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
        new AbortController().signal,
      );
      expect(answer).toBeNull();
    } finally {
      edgeLog.warn = originalWarn;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }
    expect(warnings.filter((line) => /context-graph-name|name request|protocol/i.test(line))).toEqual([]);
    expect(edge.networkAdmissionCoordinator.isRejectedPeer(holder.peerId)).toBe(false);

    const resolved = await edge.resolveContextGraphNameHashNow(NAME_HASH);
    expect(resolved).toBe(CLEARTEXT_ID);
    expect(edge.getContextGraphNameResolutionStatus()).toContainEqual(expect.objectContaining({
      state: 'resolved',
      source: 'peer-ontology',
    }));
    // The pull is scanned in memory: nothing from the peer's ontology graph
    // lands in the edge's store.
    const ontologyRows = await edge.store.query(
      `SELECT ?s WHERE { GRAPH <${contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)}> `
      + `{ <${contextGraphDataGraphUri(CLEARTEXT_ID)}> ?p ?o } }`,
      { source: 'test.nameHashSubscription.ontology' } as never,
    );
    expect(ontologyRows.type === 'bindings' ? ontologyRows.bindings.length : -1).toBe(0);
  }, 120_000);

  it('never reveals the cleartext id of a private graph', async () => {
    const holderChain = await chainWithContextGraph33('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1);
    const edgeChain = await chainWithContextGraph33('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 1);
    const holder = await startAgent('PrivateHolder33', holderChain);
    const edge = await startAgent('PrivateEdge33', edgeChain);
    await seedHolder(holder, holderChain);
    await connect(edge, holder);
    // A null answer alone would also pass if the request never reached the
    // holder; watch the holder's reveal gate refuse this very graph.
    const revealGate = vi.spyOn(holder, 'isContextGraphPublicForNameReveal');

    const answer = await edge.askPeerForContextGraphName(
      holder.peerId,
      { nameHash: NAME_HASH, onChainId: ON_CHAIN_ID },
      new AbortController().signal,
    );
    expect(answer).toBeNull();
    expect(revealGate).toHaveBeenCalledTimes(1);
    expect(revealGate.mock.calls[0]?.[0]).toBe(CLEARTEXT_ID);
    await expect(revealGate.mock.results[0]?.value).resolves.toBe(false);
  }, 120_000);

  it('resolves from its own store first, reading the access policy from the chain', async () => {
    const edgeChain = await chainWithContextGraph33('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    const edge = await startAgent('Edge33LocalStore', edgeChain);
    seedEdge(edge);
    // Nothing cached: the resolver must prove the policy public itself.
    edge.onChainAccessPolicyCache.delete(ON_CHAIN_ID);
    // The creator's public definition, already in this node's own ontology
    // graph (cores re-sync it to each other), next to another graph's.
    await edge.store.insert([
      {
        subject: contextGraphDataGraphUri('acme-other'),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      },
      {
        subject: contextGraphDataGraphUri(CLEARTEXT_ID),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
      },
    ]);
    const asked = vi.spyOn(edge, 'askPeerForContextGraphName');
    const pulled = vi.spyOn(edge, 'pullPeerOntologyForContextGraphNames');

    expect(await edge.resolveContextGraphNameHashNow(NAME_HASH)).toBe(CLEARTEXT_ID);
    expect(edge.getContextGraphNameResolutionStatus()).toContainEqual(expect.objectContaining({
      state: 'resolved',
      nameHash: NAME_HASH,
      contextGraphId: CLEARTEXT_ID,
      source: 'local-store',
    }));
    expect(edge.onChainAccessPolicyCache.get(ON_CHAIN_ID)).toBe(0);
    expect(edge.getSubscribedContextGraphs().get(CLEARTEXT_ID)).toMatchObject({
      subscribed: true,
      onChainId: ON_CHAIN_ID,
      onChainHash: NAME_HASH,
    });
    expect(asked).not.toHaveBeenCalled();
    expect(pulled).not.toHaveBeenCalled();
  }, 120_000);
});
