/**
 * GH #1369 devnet regression: folded public+private V10 publishes must collect
 * live core StorageACKs and confirm on-chain.
 *
 * Preconditions:
 *   ./scripts/devnet.sh start 6
 *
 * This suite uses a transient edge agent instead of a running daemon route so it
 * can call DKGAgent.publish() with explicit privateQuads. The agent publishes
 * into the already-registered devnet-test CG, connects to the live core nodes,
 * and requires the result to be confirmed. A regression that drops
 * privateMerkleRoots from the ACK request should fail here with missing/rejected
 * ACKs instead of returning confirmed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, type KaNumberStore } from '@origintrail-official/dkg-core';
import { DKGAgent, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  CONTEXT_GRAPH,
  DEVNET_DIR,
  RPC,
  detectDevnet,
  ensureAllIdentities,
  getJson,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const CORE_COUNT = 4;

class InMemoryKaNumberStore implements KaNumberStore {
  private readonly next = new Map<string, bigint>();

  allocate(authorAddress: string): bigint {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0n;
    this.next.set(key, current + 1n);
    return current;
  }

  reconcileFloor(authorAddress: string, nextNumberFloor: bigint): void {
    const key = authorAddress.toLowerCase();
    const current = this.next.get(key) ?? 0n;
    this.next.set(key, current > nextNumberFloor ? current : nextNumberFloor);
  }

  peekNext(authorAddress: string): bigint {
    return this.next.get(authorAddress.toLowerCase()) ?? 0n;
  }
}

function makeKaNumberAllocator(): KaNumberAllocator {
  return new KaNumberAllocator(new InMemoryKaNumberStore());
}

function readCoreMultiaddrs(): string[] {
  const addrs: string[] = [];
  for (let i = 1; i <= CORE_COUNT; i++) {
    const path = `${DEVNET_DIR}/node${i}/multiaddr`;
    if (!existsSync(path)) {
      throw new Error(`Missing core node${i} multiaddr at ${path}; restart devnet with ./scripts/devnet.sh start 6`);
    }
    const addr = readFileSync(path, 'utf8').trim();
    if (!addr) throw new Error(`Empty core node${i} multiaddr at ${path}`);
    addrs.push(addr);
  }
  return addrs;
}

async function devnetTestCgOnChainId(node: DevnetNode): Promise<string> {
  const { status, json } = await getJson(node, '/api/context-graph/list');
  expect(status, JSON.stringify(json)).toBe(200);
  const row = (json.contextGraphs as Array<{ id?: string; onChainId?: string }> | undefined)
    ?.find((cg) => cg.id === CONTEXT_GRAPH);
  expect(row?.onChainId, `${CONTEXT_GRAPH} must be registered on-chain by devnet bootstrap`).toMatch(/^[1-9]\d*$/);
  return row!.onChainId!;
}

async function seedLocalContextGraph(store: OxigraphStore, onChainId: string): Promise<void> {
  const gm = new GraphManager(store);
  await gm.ensureContextGraph(CONTEXT_GRAPH);

  const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const contextGraphUri = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  await store.insert([
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph: ontologyGraph,
    },
    {
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.SCHEMA_NAME,
      object: '"Devnet Test"',
      graph: ontologyGraph,
    },
    {
      subject: contextGraphUri,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: `"${onChainId}"`,
      graph: ontologyGraph,
    },
  ]);
}

async function waitForDevnetPeers(agent: DKGAgent): Promise<void> {
  for (const addr of readCoreMultiaddrs()) {
    await agent.connectTo(addr).catch(() => undefined);
  }

  await waitFor(
    'transient publisher to connect to at least 3 devnet core peers',
    90_000,
    2_000,
    async () => {
      const peers = ((agent as unknown as { node?: { libp2p?: { getPeers?: () => unknown[] } } })
        .node?.libp2p?.getPeers?.() ?? []);
      return peers.length >= 3 ? true : null;
    },
  );
}

let state: DevnetState;
let node1: DevnetNode;
let store: OxigraphStore;
let agent: DKGAgent | undefined;
let onChainContextGraphId = '';

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error('No devnet detected - run ./scripts/devnet.sh start 6 before this suite');
  }
  state = detected;
  await ensureAllIdentities(state, CORE_COUNT);
  node1 = state.nodes[1]!;
  onChainContextGraphId = await devnetTestCgOnChainId(node1);

  store = new OxigraphStore();
  await seedLocalContextGraph(store, onChainContextGraphId);

  agent = await DKGAgent.create({
    name: 'PR1369FoldedPrivateAckDevnet',
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: readCoreMultiaddrs(),
    nodeRole: 'edge',
    store,
    syncSharedMemoryOnConnect: false,
    kaNumberAllocator: makeKaNumberAllocator(),
    chainConfig: {
      rpcUrl: RPC,
      hubAddress: state.addrs.Hub,
      chainId: 'evm:31337',
      operationalKeys: [node1.opWallets[0]!.privateKey],
      adminPrivateKey: node1.admin.privateKey,
    },
  });
  await agent.start();

  const sub = agent.getSubscribedContextGraphs().get(CONTEXT_GRAPH);
  (agent as unknown as {
    setContextGraphSubscription: (id: string, next: unknown, opts?: { persist?: boolean }) => void;
  }).setContextGraphSubscription(
    CONTEXT_GRAPH,
    { ...sub, subscribed: true, synced: true, onChainId: onChainContextGraphId },
    { persist: false },
  );

  await waitForDevnetPeers(agent);
}, 240_000);

afterAll(async () => {
  await agent?.stop().catch(() => undefined);
  await store?.close?.().catch(() => undefined);
});

describe('GH #1369 folded private ACK devnet coverage', () => {
  it('confirms a direct public+private publish with live core ACKs', async () => {
    expect(agent).toBeDefined();
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const subject = `urn:devnet:pr1369:${nonce}`;
    const graph = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

    const publicQuads: Quad[] = [
      {
        subject,
        predicate: 'https://schema.org/name',
        object: `"PR1369 folded private ${nonce}"`,
        graph,
      },
    ];
    const privateQuads: Quad[] = [
      {
        subject,
        predicate: 'https://example.org/private/apiKey',
        object: `"secret-${nonce}"`,
        graph,
      },
      {
        subject,
        predicate: 'https://example.org/private/modelPath',
        object: `"s3://private/pr1369/${nonce}"`,
        graph,
      },
    ];

    const result = await agent!.publish(CONTEXT_GRAPH, publicQuads, privateQuads, {
      onChainContextGraphId,
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.kaId).toBeGreaterThan(0n);
    expect(result.kaManifest[0]?.privateTripleCount).toBe(privateQuads.length);
  }, 180_000);
});
