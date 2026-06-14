/**
 * Phase D — Cores fill their own gaps.
 *
 * When a Core signs a StorageACK for a PUBLIC CG it becomes a storage node for
 * it. The chain-driven VM reconciler (Phase B) must then run for that CG even
 * without a member subscription, so a Core that was offline during the next
 * publish learns the missed KA from chain on restart and pulls it core-first.
 *
 * This file pins the Phase-D-specific agent seams that the pure
 * reconcile-cursor / chain-reconciler unit tests can't reach:
 *
 *   1. `recordCoreHostedPublicCg` — the StorageACK pre-sign chokepoint. Marks
 *      PUBLIC CGs `coreHosted` (persisted), skips curated/unknown/non-numeric.
 *   2. The lifted reconcile gate — sweep + per-CG reconcile run for a
 *      `coreHosted` CG that has NO member subscription.
 *   3. The `core-fill` telemetry — a host-only reconcile that promotes KAs to
 *      VM emits the distinct `core-fill` replication event.
 *
 * The reconcile→VM engine itself is covered by `chain-reconcile-e2e.test.ts`;
 * here we only prove the host-only path lights it up end-to-end.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import type { ReplicationEvent, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';

interface AgentInternals {
  createContextGraph(opts: { id: string; name: string; description?: string; private?: boolean; callerAgentAddress?: string }): Promise<void>;
  registerContextGraph(id: string, opts?: { callerAgentAddress?: string }): Promise<{ onChainId: string; txHash?: string }>;
  recordCoreHostedPublicCg(cgId: string, swmGraphId?: string): Promise<void>;
  reconcileChainOrdinal(localCgId: string, onChainCgId: bigint, ordinal: number, headBlock: number | undefined): Promise<{ status: string }>;
  syncContextGraphFromConnectedPeers(contextGraphId: string, options?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string }): Promise<unknown>;
  runVmReconcileForCg(localCgId: string): Promise<void>;
  runVmReconcileSweep(): Promise<void>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string; lastReconciledOrdinal?: number }>;
  reconcileCoalescer: { trigger: (cg: string) => void } | null;
  store: TripleStore;
  chain: MockChainAdapter & {
    getContextGraphAccessPolicy?: (id: bigint) => Promise<number>;
    isContextGraphActiveOnChain?: (id: bigint) => Promise<boolean>;
  };
}

/**
 * Without a real `start()` the `DKGNode` getter throws on `peerId` access,
 * which `setContextGraphSubscription`'s membership bookkeeping hits. Stub a
 * structurally-typed node so the subscription map mutation path runs. Mirrors
 * `v10-ack-provider-wiring.test.ts`.
 */
function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWCoreFillTestPeer',
    libp2p: { getPeers: () => [] },
  };
}

function emptyCatchupStats() {
  return {
    connectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersSucceeded: 1,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 1,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 1,
        droppedDataTriples: 0,
        failedPeers: 0,
      },
    },
  };
}

function noProtocolCatchupStats() {
  return {
    ...emptyCatchupStats(),
    syncCapablePeers: 0,
    peersTried: 0,
    peersSucceeded: 0,
  };
}

async function insertWorkspaceOperationMeta(
  store: TripleStore,
  metaGraph: string,
  opId: string,
  rootEntity: string,
  publishedAt: string,
): Promise<void> {
  const subject = `urn:dkg:share:${opId}`;
  await store.insert([
    { graph: metaGraph, subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation' },
    { graph: metaGraph, subject, predicate: 'http://dkg.io/ontology/rootEntity', object: rootEntity },
    { graph: metaGraph, subject, predicate: 'http://dkg.io/ontology/publishedAt', object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
  ]);
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function insertWorkspaceDataTriple(
  store: TripleStore,
  localCgId: string,
  entity: string,
  value: string,
): Promise<void> {
  await store.insert([{
    subject: entity,
    predicate: 'http://schema.org/name',
    object: `"${value}"`,
    graph: contextGraphWorkspaceGraphUri(localCgId),
  }]);
}

async function replaceWorkspaceDataTriple(
  store: TripleStore,
  localCgId: string,
  entity: string,
  value: string,
): Promise<void> {
  await store.deleteByPattern({
    subject: entity,
    predicate: 'http://schema.org/name',
    graph: contextGraphWorkspaceGraphUri(localCgId),
  });
  await insertWorkspaceDataTriple(store, localCgId, entity, value);
}

async function insertPrivateMerkleRoot(
  store: TripleStore,
  localCgId: string,
  entity: string,
  privateRoot: Uint8Array,
): Promise<void> {
  await store.insert([{
    subject: entity,
    predicate: 'http://dkg.io/ontology/privateMerkleRoot',
    object: `"${bytesToHex(privateRoot)}"`,
    graph: contextGraphWorkspaceMetaGraphUri(localCgId),
  }]);
}

/** Seed a local SWM snapshot for one KA under a CG and return its flat-KC root. */
async function seedSwmSnapshot(store: TripleStore, localCgId: string, entity: string, value: string): Promise<Uint8Array> {
  const wsGraph = contextGraphWorkspaceGraphUri(localCgId);
  const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(localCgId);
  await store.insert([
    { subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: wsGraph },
    { subject: `urn:dkg:share:${entity}`, predicate: 'http://dkg.io/ontology/rootEntity', object: entity, graph: wsMetaGraph },
  ]);
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
    [],
  );
}

async function seedSwmSnapshotInSubGraph(
  store: TripleStore,
  localCgId: string,
  subGraphName: string,
  entity: string,
  value: string,
): Promise<Uint8Array> {
  const graphManager = new GraphManager(store);
  await store.insert([
    { subject: `urn:test:subgraph-marker:${subGraphName}`, predicate: 'http://schema.org/name', object: '"marker"', graph: graphManager.subGraphUri(localCgId, subGraphName) },
    { subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: graphManager.sharedMemoryUri(localCgId, subGraphName) },
    { subject: `urn:dkg:share:${subGraphName}`, predicate: 'http://dkg.io/ontology/rootEntity', object: entity, graph: graphManager.sharedMemoryMetaUri(localCgId, subGraphName) },
  ]);
  return computeFlatKCRootV10(
    [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
    [],
  );
}

describe('Phase D — recordCoreHostedPublicCg', () => {
  let agent: DKGAgent | null = null;
  const saved: ContextGraphSubscriptionRecord[] = [];

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    saved.length = 0;
    vi.restoreAllMocks();
  });

  async function boot(): Promise<AgentInternals> {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'CoreFillTest',
      chainAdapter: chain,
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async (record) => { saved.push(record); },
        delete: async () => undefined,
      },
    });
    stubNode(agent);
    chain.isContextGraphActiveOnChain = async () => true;
    return agent as unknown as AgentInternals;
  }

  it('marks a PUBLIC CG core-hosted (subscribed=false) and persists it', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0; // public

    await internals.recordCoreHostedPublicCg('42');

    const sub = internals.subscribedContextGraphs.get('42');
    expect(sub).toBeDefined();
    expect(sub!.coreHosted).toBe(true);
    expect(sub!.subscribed).toBe(false);
    expect(sub!.onChainId).toBe('42');

    // Persisted across restart — the whole point of Phase D.
    const persisted = saved.find((r) => r.id === '42');
    expect(persisted?.coreHosted).toBe(true);
    expect(persisted?.subscribed).toBe(false);
  });

  it('records a public hosted CG for ACK-backed adapters without a liveness probe', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0; // public
    (internals.chain as { isContextGraphActiveOnChain?: unknown }).isContextGraphActiveOnChain = undefined;

    await internals.recordCoreHostedPublicCg('43');

    const sub = internals.subscribedContextGraphs.get('43');
    expect(sub?.coreHosted).toBe(true);
    expect(sub?.onChainId).toBe('43');
    expect(saved.find((r) => r.id === '43')?.coreHosted).toBe(true);
  });

  it('bounds ACK-backed access-policy reads when the adapter has no liveness probe', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => new Promise<number>(() => undefined);
    (internals.chain as { isContextGraphActiveOnChain?: unknown }).isContextGraphActiveOnChain = undefined;

    const startedAt = Date.now();
    await internals.recordCoreHostedPublicCg('44');

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(internals.subscribedContextGraphs.get('44')).toBeUndefined();
    expect(saved.find((r) => r.id === '44')).toBeUndefined();
  });

  it('stops accepting and drains core-host recordings deterministically', async () => {
    const internals = await boot();
    let startedAfterClose = false;
    (internals as any).coreHostRecordingsClosed = true;
    (internals as any).trackCoreHostRecording(async () => { startedAfterClose = true; });
    expect(startedAfterClose).toBe(false);

    (internals as any).coreHostRecordingsClosed = false;
    const recordings = (internals as any).coreHostRecordings as Set<Promise<void>>;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstBase = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstTracked!: Promise<void>;
    firstTracked = firstBase.finally(() => {
      recordings.delete(firstTracked);
      let secondTracked!: Promise<void>;
      secondTracked = new Promise<void>((resolve) => { releaseSecond = resolve; })
        .finally(() => { recordings.delete(secondTracked); });
      recordings.add(secondTracked);
    });
    recordings.add(firstTracked);

    const drained = (internals as any).drainCoreHostRecordings();
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(recordings.size).toBe(1);
    releaseSecond();
    await drained;

    expect(recordings.size).toBe(0);
  });

  it('keys the host row under the cleartext swmGraphId (not the numeric id) on first ACK', async () => {
    // Regression: on the first ACK for a CG we only host, there is no local
    // mapping yet, so without the cleartext hint the row would land under the
    // numeric id ("1") instead of the local CG name ("devnet-test"), and the
    // reconciler would sync against the wrong namespace.
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0; // public

    await internals.recordCoreHostedPublicCg('1', 'devnet-test');

    // Recorded under the cleartext local id, with the numeric on-chain id bound.
    const sub = internals.subscribedContextGraphs.get('devnet-test');
    expect(sub).toBeDefined();
    expect(sub!.coreHosted).toBe(true);
    expect(sub!.onChainId).toBe('1');
    // NOT under the numeric id.
    expect(internals.subscribedContextGraphs.get('1')).toBeUndefined();
    const persisted = saved.find((r) => r.id === 'devnet-test');
    expect(persisted?.coreHosted).toBe(true);
  });

  it('ignores a numeric swmGraphId hint and falls back to the numeric id', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0;

    // A numeric (or equal-to-cgId) hint carries no cleartext info → numericStr.
    await internals.recordCoreHostedPublicCg('8', '8');

    expect(internals.subscribedContextGraphs.get('8')?.coreHosted).toBe(true);
  });

  it('does NOT mark a CURATED CG (Cores host curated as opaque ciphertext, not VM)', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 1; // curated

    await internals.recordCoreHostedPublicCg('99');

    expect(internals.subscribedContextGraphs.get('99')?.coreHosted).toBeUndefined();
    expect(saved.find((r) => r.id === '99')).toBeUndefined();
  });

  it('does NOT mark an UNKNOWN CG even when the policy getter defaults to public', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0;
    internals.chain.isContextGraphActiveOnChain = async () => false;

    await internals.recordCoreHostedPublicCg('123456');

    expect(internals.subscribedContextGraphs.get('123456')).toBeUndefined();
    expect(saved.find((r) => r.id === '123456')).toBeUndefined();
  });

  it('ignores a non-numeric id (cannot index the on-chain ordinal list)', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0;

    await internals.recordCoreHostedPublicCg('not-a-number');

    expect(internals.subscribedContextGraphs.size).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('is idempotent — a second ACK for the same hosted CG does not churn state', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0;

    await internals.recordCoreHostedPublicCg('7');
    const savesAfterFirst = saved.length;
    await internals.recordCoreHostedPublicCg('7');

    expect(internals.subscribedContextGraphs.get('7')?.coreHosted).toBe(true);
    expect(saved.length).toBe(savesAfterFirst); // no second persist
  });

  it('preserves a pre-existing member subscription while adding coreHosted', async () => {
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0;
    internals.subscribedContextGraphs.set('5', { subscribed: true, onChainId: '5', lastReconciledOrdinal: 3 });

    await internals.recordCoreHostedPublicCg('5');

    const sub = internals.subscribedContextGraphs.get('5');
    expect(sub!.subscribed).toBe(true);          // not clobbered
    expect(sub!.coreHosted).toBe(true);
    expect(sub!.lastReconciledOrdinal).toBe(3);  // watermark preserved
  });

  it('resets the reconcile watermark when an existing local id rebinds to a NEW on-chain id', async () => {
    // Regression: a hosted public CG re-created/rebound under the same local id
    // must drop its stale `lastReconciledOrdinal`. The watermark counts
    // contiguous KAs promoted for the OLD chain graph; reusing it would make
    // the sweep resume at the wrong ordinal and permanently skip the new
    // graph's early KAs. The row must route through bindSubscriptionOnChainId
    // (which zeroes the watermark on an id change) rather than a bare overwrite.
    const internals = await boot();
    internals.chain.getContextGraphAccessPolicy = async () => 0; // public
    // Existing local row bound to on-chain id 5 with reconcile progress.
    internals.subscribedContextGraphs.set('devnet-test', {
      subscribed: true, onChainId: '5', lastReconciledOrdinal: 3,
    });
    const storageAddr = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddr, 777n);
    const root = new Uint8Array(32);
    root[31] = 3;
    const recentKey = (internals as any).vmReconcileCacheKey('devnet-test', ual, root);
    ((internals as any).recentReconciledUals as { add(key: string): void }).add(recentKey);

    // Same local id ("devnet-test"), but now hosting a DIFFERENT chain graph (9).
    await internals.recordCoreHostedPublicCg('9', 'devnet-test');

    const sub = internals.subscribedContextGraphs.get('devnet-test');
    expect(sub!.subscribed).toBe(true);            // membership preserved
    expect(sub!.coreHosted).toBe(true);
    expect(sub!.onChainId).toBe('9');              // rebound to the new graph
    expect(sub!.lastReconciledOrdinal).toBe(0);    // stale watermark dropped
    expect(((internals as any).recentReconciledUals as { has(key: string): boolean }).has(recentKey)).toBe(false);
  });

  it('clears VM reconcile state when stale inactive on-chain ids are re-registered', async () => {
    const internals = await boot();
    const localCgId = 'stale-register';
    const ownerAddr = (internals.chain as unknown as { signerAddress: string }).signerAddress;

    await internals.createContextGraph({
      id: localCgId,
      name: 'Stale Register',
      private: true,
      callerAgentAddress: ownerAddr,
    });
    await internals.store.insert([{
      subject: `did:dkg:context-graph:${localCgId}`,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      object: '"5"',
      graph: contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
    }]);
    internals.subscribedContextGraphs.set(localCgId, {
      subscribed: true, onChainId: '5', lastReconciledOrdinal: 4,
    });
    internals.chain.isContextGraphActiveOnChain = async (id) => id !== 5n;

    const storageAddr = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddr, 778n);
    const root = new Uint8Array(32);
    root[31] = 4;
    const recentKey = (internals as any).vmReconcileCacheKey(localCgId, ual, root);
    const recent = (internals as any).recentReconciledUals as { add(key: string): void; has(key: string): boolean };
    const negativeCache = (internals as any).vmReconcileNegativeCache as Map<string, unknown>;
    const negativeKeysByCg = (internals as any).vmReconcileNegativeCacheKeysByCg as Map<string, Set<string>>;
    const fetchCooldown = (internals as any).vmReconcileFetchCooldownAt as Map<string, number>;
    const peerCursor = (internals as any).vmReconcileCatchupPeerCursor as Map<string, number>;
    const peerOrder = (internals as any).vmReconcileCatchupPeerOrder as Map<string, unknown>;
    const reconcileCursors = (internals as any).reconcileCursors as Map<string, unknown>;
    recent.add(recentKey);
    negativeCache.set(recentKey, {
      localCgId,
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });
    negativeKeysByCg.set(localCgId, new Set([recentKey]));
    fetchCooldown.set(localCgId, Date.now());
    peerCursor.set(localCgId, 2);
    peerOrder.set(localCgId, { orderedPeers: ['peer-a'], nextPeerId: 'peer-a' });
    reconcileCursors.set(localCgId, { pending: new Set([0]) });

    await expect(internals.registerContextGraph(localCgId, { callerAgentAddress: ownerAddr }))
      .resolves.toMatchObject({ onChainId: expect.any(String) });

    const sub = internals.subscribedContextGraphs.get(localCgId);
    expect(sub?.onChainId).not.toBe('5');
    expect(sub?.lastReconciledOrdinal).toBe(0);
    expect(recent.has(recentKey)).toBe(false);
    expect(negativeCache.has(recentKey)).toBe(false);
    expect(negativeKeysByCg.has(localCgId)).toBe(false);
    expect(fetchCooldown.has(localCgId)).toBe(false);
    expect(peerCursor.has(localCgId)).toBe(false);
    expect(peerOrder.has(localCgId)).toBe(false);
    expect(reconcileCursors.has(localCgId)).toBe(false);
  });
});

describe('Phase D - VM reconcile damping', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    vi.restoreAllMocks();
  });

  async function boot(): Promise<AgentInternals> {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'VmReconcileDamping', chainAdapter: chain });
    stubNode(agent);
    return agent as unknown as AgentInternals;
  }

  function registerUnmatchedKC(
    chain: MockChainAdapter,
    kaId: bigint,
    onChainCgId: bigint,
    merkleRootHex = '0x' + kaId.toString(16).padStart(64, '0'),
  ): void {
    chain.__registerKC({
      kaId,
      contextGraphId: onChainCgId,
      merkleRootHex,
      chunks: [],
    });
  }

  it('negative-caches a missing SWM snapshot and skips the expensive scan plus active fetch during backoff', async () => {
    const internals = await boot();
    const onChainCgId = 42n;
    registerUnmatchedKC(internals.chain, 9001n, onChainCgId);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('42', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('42', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBe(0);
  });

  it('does not reuse a negative cache entry after catchup peer topology changes', async () => {
    const internals = await boot();
    const onChainCgId = 54n;
    registerUnmatchedKC(internals.chain, 9014n, onChainCgId);

    let connectedPeers = ['peer-empty'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('54', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;
    connectedPeers = ['peer-empty', 'peer-newly-reachable'];

    await expect(internals.reconcileChainOrdinal('54', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(expensiveScans).toBeGreaterThan(0);
  });

  it('reuses a negative cache entry when connected peers only reorder', async () => {
    const internals = await boot();
    const onChainCgId = 55n;
    registerUnmatchedKC(internals.chain, 9015n, onChainCgId);

    let connectedPeers = ['peer-a', 'peer-b'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('55', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    const fetchesAfterFirstMiss = fetch.mock.calls.length;
    expect(fetchesAfterFirstMiss).toBeGreaterThan(0);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;
    connectedPeers = ['peer-b', 'peer-a'];

    await expect(internals.reconcileChainOrdinal('55', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(fetchesAfterFirstMiss);
    expect(expensiveScans).toBe(0);
  });

  it('primes catchup connections before reusing a negative cache entry', async () => {
    const internals = await boot();
    const onChainCgId = 57n;
    registerUnmatchedKC(internals.chain, 9017n, onChainCgId);

    let connectedPeers = ['peer-empty'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    let primeCalls = 0;
    vi.spyOn(internals as any, 'primeCatchupConnections').mockImplementation(async () => {
      primeCalls += 1;
      if (primeCalls >= 1) {
        connectedPeers = ['peer-empty', 'peer-discovered'];
      }
    });

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('57', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;

    await expect(internals.reconcileChainOrdinal('57', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(primeCalls).toBeGreaterThanOrEqual(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(expensiveScans).toBeGreaterThan(0);
  });

  it('does not reuse a negative cache entry when catchup ranking changes for the same peer set', async () => {
    const internals = await boot();
    const onChainCgId = 56n;
    registerUnmatchedKC(internals.chain, 9016n, onChainCgId);

    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-reclassified' } },
    ];

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('56', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    (internals as any).knownCorePeerIds.add('peer-reclassified');

    await expect(internals.reconcileChainOrdinal('56', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(expensiveScans).toBeGreaterThan(0);
  });

  it('does not reuse a negative cache entry when the same KA has a newer merkle root', async () => {
    const internals = await boot();
    const onChainCgId = 46n;
    registerUnmatchedKC(internals.chain, 9006n, onChainCgId, '0x' + '11'.repeat(32));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBe(0);

    registerUnmatchedKC(internals.chain, 9006n, onChainCgId, '0x' + '22'.repeat(32));
    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    // New root bypasses the negative-cache deferral and re-runs the SWM scan;
    // the independent per-CG active-fetch cooldown may still suppress another
    // network fetch in the same sweep interval.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
    const cacheKeys = Array.from(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).keys());
    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys.some((key) => key.includes('11'.repeat(32)))).toBe(true);
    expect(cacheKeys.some((key) => key.includes('22'.repeat(32)))).toBe(true);
  });

  it('retries an incomplete SWM operation when data arrives without operation-meta changes', async () => {
    const internals = await boot();
    const onChainCgId = 48n;
    const entity = 'urn:fact:data-arrival';
    const value = 'Data arrived after cache';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9008n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('48'),
      'data-arrival-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );

    await expect(internals.reconcileChainOrdinal('48', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await insertWorkspaceDataTriple(internals.store, '48', entity, value);

    await expect(internals.reconcileChainOrdinal('48', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('retries finalization after shared-memory fetch progress even when peer success is zero', async () => {
    const internals = await boot();
    const onChainCgId = 61n;
    const entity = 'urn:fact:shared-progress';
    const value = 'Shared memory fetched despite durable failure';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9022n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockImplementation(async () => {
      await seedSwmSnapshot(internals.store, '61', entity, value);
      return {
        ...emptyCatchupStats(),
        peersSucceeded: 0,
        sharedMemorySynced: 2,
        diagnostics: {
          ...emptyCatchupStats().diagnostics,
          sharedMemory: {
            ...emptyCatchupStats().diagnostics.sharedMemory,
            insertedDataTriples: 1,
            insertedMetaTriples: 1,
          },
        },
      };
    });

    await expect(internals.reconcileChainOrdinal('61', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('retries an incomplete SWM operation when data changes without triple-count changes', async () => {
    const internals = await boot();
    const onChainCgId = 52n;
    const entity = 'urn:fact:data-replacement';
    const staleValue = 'Stale value';
    const freshValue = 'Fresh value';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${freshValue}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9012n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('52'),
      'data-replacement-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );
    await insertWorkspaceDataTriple(internals.store, '52', entity, staleValue);

    await expect(internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await replaceWorkspaceDataTriple(internals.store, '52', entity, freshValue);

    await expect(internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('retries an incomplete SWM operation when private-root metadata arrives without operation-meta changes', async () => {
    const internals = await boot();
    const onChainCgId = 49n;
    const entity = 'urn:fact:private-arrival';
    const value = 'Private root arrived after cache';
    const privateRoot = new Uint8Array(32);
    privateRoot[31] = 7;
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [privateRoot],
    );
    registerUnmatchedKC(internals.chain, 9009n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('49'),
      'private-arrival-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );
    await insertWorkspaceDataTriple(internals.store, '49', entity, value);

    await expect(internals.reconcileChainOrdinal('49', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await insertPrivateMerkleRoot(internals.store, '49', entity, privateRoot);

    await expect(internals.reconcileChainOrdinal('49', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('invalidates a negative cache entry when matching SWM arrives in a new subgraph namespace', async () => {
    const internals = await boot();
    const onChainCgId = 53n;
    const entity = 'urn:fact:new-subgraph-arrival';
    const value = 'Subgraph SWM arrived after cache';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9013n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());

    await expect(internals.reconcileChainOrdinal('53', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await seedSwmSnapshotInSubGraph(internals.store, '53', 'code', entity, value);

    await expect(internals.reconcileChainOrdinal('53', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('rechecks the root SWM generation when subgraph enumeration fails during negative-cache validation', async () => {
    const internals = await boot();
    const onChainCgId = 58n;
    const entity = 'urn:fact:root-fallback-arrival';
    const value = 'Root fallback arrived after cache';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9018n, onChainCgId, bytesToHex(root));

    vi.spyOn(GraphManager.prototype, 'listSubGraphs').mockRejectedValue(new Error('subgraph listing failed'));
    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());

    await expect(internals.reconcileChainOrdinal('58', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    const seededRoot = await seedSwmSnapshot(internals.store, '58', entity, value);
    expect(bytesToHex(seededRoot)).toBe(bytesToHex(root));

    await expect(internals.reconcileChainOrdinal('58', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('keeps a negative cache entry when subgraph enumeration fails during namespace validation', async () => {
    const internals = await boot();
    const onChainCgId = 60n;
    registerUnmatchedKC(internals.chain, 9020n, onChainCgId);

    const graphManager = new GraphManager(internals.store);
    await internals.store.insert([{
      subject: 'urn:test:subgraph-marker:code',
      predicate: 'http://schema.org/name',
      object: '"marker"',
      graph: graphManager.subGraphUri('60', 'code'),
    }]);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('60', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    const fetchesAfterFirstMiss = fetch.mock.calls.length;
    expect(fetchesAfterFirstMiss).toBeGreaterThan(0);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    vi.spyOn(GraphManager.prototype, 'listSubGraphs').mockRejectedValue(new Error('transient subgraph listing failure'));
    expensiveScans = 0;

    await expect(internals.reconcileChainOrdinal('60', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(fetchesAfterFirstMiss);
    expect(expensiveScans).toBe(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);
  });

  it('does not reuse a negative cache entry across local CGs for the same KA root', async () => {
    const internals = await boot();
    const storageAddr = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddr, 9021n);
    const root = new Uint8Array(32);
    root[31] = 21;
    const keyA = (internals as any).vmReconcileCacheKey('61', ual, root);
    const keyB = (internals as any).vmReconcileCacheKey('62', ual, root);
    expect(keyA).not.toBe(keyB);

    (internals as any).recordVmReconcileNegativeCache(keyA, '61', {
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: 'unreadable',
    });

    await expect((internals as any).shouldDeferVmReconcileByNegativeCache(keyB, '62')).resolves.toBe(false);

    (internals as any).recordVmReconcileNegativeCache(keyB, '62', {
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: 'unreadable',
    });

    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(2);
  });

  it('does not negative-cache an unreadable SWM generation and retries before backoff', async () => {
    const internals = await boot();
    const onChainCgId = 45n;
    const entity = 'urn:fact:after-unreadable';
    const value = 'Visible right after a probe failure';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9005n, onChainCgId, bytesToHex(root));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    let generationReads = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root ?ts WHERE')) {
        generationReads++;
        if (generationReads <= 2) throw new Error('transient generation read failure');
      }
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(generationReads).toBe(2);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await seedSwmSnapshot(internals.store, '45', entity, value);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('invalidates a negative cache entry when same-count SWM data changes', async () => {
    const internals = await boot();
    const storageAddr = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddr, 9023n);
    const root = new Uint8Array(32);
    root[31] = 23;
    const cacheKey = (internals as any).vmReconcileCacheKey('63', ual, root);

    await insertWorkspaceDataTriple(internals.store, '63', 'urn:fact:same-count', 'old');
    const stateBefore = await (internals as any).collectVmReconcileSwmCandidateState('63');
    expect(stateBefore.swmGen).toContain('dataTriples:1');

    (internals as any).recordVmReconcileNegativeCache(cacheKey, '63', stateBefore);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await replaceWorkspaceDataTriple(internals.store, '63', 'urn:fact:same-count', 'new');

    await expect((internals as any).shouldDeferVmReconcileByNegativeCache(cacheKey, '63')).resolves.toBe(false);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('does not negative-cache misses once candidate SWM operation metadata exists', async () => {
    const internals = await boot();
    const onChainCgId = 43n;
    registerUnmatchedKC(internals.chain, 9002n, onChainCgId);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('43'),
      'existing-root-op',
      'urn:fact:existing',
      '2030-01-01T00:00:00.000Z',
    );

    await internals.reconcileChainOrdinal('43', onChainCgId, 0, undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await insertWorkspaceOperationMeta(
      internals.store,
      'did:dkg:context-graph:43/code/_shared_memory_meta',
      'unrelated-subgraph-op',
      'urn:fact:unrelated',
      '2040-01-01T00:00:00.000Z',
    );

    expensiveScans = 0;
    await internals.reconcileChainOrdinal('43', onChainCgId, 0, undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);

    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('43'),
      'candidate-root-op-with-older-timestamp',
      'urn:fact:candidate',
      '2020-01-01T00:00:00.000Z',
    );

    expensiveScans = 0;
    await internals.reconcileChainOrdinal('43', onChainCgId, 0, undefined);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);
  });

  it('runs at most one active fetch per CG sweep interval across different pending ordinals', async () => {
    const internals = await boot();
    const onChainCgId = 44n;
    registerUnmatchedKC(internals.chain, 9003n, onChainCgId);
    registerUnmatchedKC(internals.chain, 9004n, onChainCgId);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());

    await internals.reconcileChainOrdinal('44', onChainCgId, 0, undefined);
    await internals.reconcileChainOrdinal('44', onChainCgId, 1, undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls through a no-protocol active-fetch peer before caching a miss', async () => {
    const internals = await boot();
    const onChainCgId = 47n;
    registerUnmatchedKC(internals.chain, 9007n, onChainCgId);
    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-no-protocol' } },
      { remotePeer: { toString: () => 'peer-empty' } },
    ];

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers')
      .mockResolvedValueOnce(noProtocolCatchupStats())
      .mockResolvedValueOnce(emptyCatchupStats());

    await expect(internals.reconcileChainOrdinal('47', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, '47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
    });
  });

  it('extends active-fetch attempts after the first fetch round dials another peer', async () => {
    const internals = await boot();
    const onChainCgId = 59n;
    registerUnmatchedKC(internals.chain, 9019n, onChainCgId);

    let connectedPeers = ['peer-initial'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockImplementation(async () => {
      if (connectedPeers.length === 1) {
        connectedPeers = ['peer-initial', 'peer-dialed'];
      }
      return {
        ...emptyCatchupStats(),
        connectedPeers: connectedPeers.length,
        selectedPeers: 1,
      };
    });

    await expect(internals.reconcileChainOrdinal('59', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('attempts every connected peer before recording a miss', async () => {
    const internals = await boot();
    const onChainCgId = 64n;
    registerUnmatchedKC(internals.chain, 9024n, onChainCgId);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue({
      ...emptyCatchupStats(),
      connectedPeers: 33,
      selectedPeers: 1,
    });

    await expect(internals.reconcileChainOrdinal('64', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch).toHaveBeenCalledTimes(33);
  });

  it('does not negative-cache no-swm when active fetch reaches no sync-capable peer', async () => {
    const internals = await boot();
    const onChainCgId = 50n;
    registerUnmatchedKC(internals.chain, 9010n, onChainCgId);
    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-no-protocol-a' } },
      { remotePeer: { toString: () => 'peer-no-protocol-b' } },
    ];

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(noProtocolCatchupStats());

    await expect(internals.reconcileChainOrdinal('50', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
    expect(((internals as any).vmReconcileFetchCooldownAt as Map<string, unknown>).has('50')).toBe(false);
  });

  it('does not negative-cache no-swm when every active fetch attempt fails', async () => {
    const internals = await boot();
    const onChainCgId = 51n;
    registerUnmatchedKC(internals.chain, 9011n, onChainCgId);
    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-fails-a' } },
      { remotePeer: { toString: () => 'peer-fails-b' } },
    ];

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockRejectedValue(new Error('fetch failed'));

    await expect(internals.reconcileChainOrdinal('51', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
    expect(((internals as any).vmReconcileFetchCooldownAt as Map<string, unknown>).has('51')).toBe(false);
  });

  it('does not prune newer root cache state when a stale root is replayed', async () => {
    const internals = await boot();
    const onChainCgId = 55n;
    const kaId = 9015n;
    const staleRoot = new Uint8Array(32);
    const freshRoot = new Uint8Array(32);
    staleRoot[31] = 1;
    freshRoot[31] = 2;
    registerUnmatchedKC(internals.chain, kaId, onChainCgId, bytesToHex(staleRoot));

    const storageAddr = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddr, kaId);
    const staleKey = (internals as any).vmReconcileCacheKey('55', ual, staleRoot);
    const freshKey = (internals as any).vmReconcileCacheKey('55', ual, freshRoot);
    ((internals as any).recentReconciledUals as { add(key: string): void }).add(freshKey);
    ((internals as any).vmReconcileNegativeCache as Map<string, unknown>).set(freshKey, {
      localCgId: '55',
      failures: 1,
      nextRetryAt: Date.now() + 60_000,
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });
    vi.spyOn(internals as any, 'getOrCreateFinalizationHandler').mockReturnValue({
      handleChainReconciledKC: vi.fn().mockResolvedValue('stale-target'),
    });

    await expect(internals.reconcileChainOrdinal('55', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'already', blockNumber: 0 });

    expect(((internals as any).recentReconciledUals as { has(key: string): boolean }).has(freshKey)).toBe(true);
    expect(((internals as any).recentReconciledUals as { has(key: string): boolean }).has(staleKey)).toBe(true);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).has(freshKey)).toBe(true);
  });

  it('keeps expired negative-cache entries as bounded retry history', async () => {
    const internals = await boot();
    const negativeCache = (internals as any).vmReconcileNegativeCache as Map<string, {
      failures: number;
      nextRetryAt: number;
      swmGen: string;
      candidateNamespaces: unknown[];
      peerTopologyKey: string;
    }>;
    const now = Date.now();
    const cacheKey = 'retry-history-key';

    negativeCache.set(cacheKey, {
      localCgId: 'retry-cg',
      failures: 1,
      nextRetryAt: now - 1,
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    } as any);

    (internals as any).pruneVmReconcileState(now);
    expect(negativeCache.has(cacheKey)).toBe(true);
    await expect((internals as any).shouldDeferVmReconcileByNegativeCache(cacheKey, 'retry-cg')).resolves.toBe(false);

    (internals as any).recordVmReconcileNegativeCache(cacheKey, 'retry-cg', {
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });

    expect(negativeCache.get(cacheKey)?.failures).toBe(2);
    expect(negativeCache.get(cacheKey)?.nextRetryAt).toBeGreaterThan(now);
  });

  it('prunes oversized VM reconcile state and clears non-hosted CG state on unsubscribe', async () => {
    const internals = await boot();
    const negativeCache = (internals as any).vmReconcileNegativeCache as Map<string, {
      failures: number;
      nextRetryAt: number;
      swmGen: string;
      candidateNamespaces: unknown[];
      peerTopologyKey: string;
    }>;
    const fetchCooldown = (internals as any).vmReconcileFetchCooldownAt as Map<string, number>;
    const peerCursor = (internals as any).vmReconcileCatchupPeerCursor as Map<string, number>;
    const peerOrder = (internals as any).vmReconcileCatchupPeerOrder as Map<string, { orderedPeers: string[]; nextPeerId?: string }>;
    const recent = (internals as any).recentReconciledUals as { add(key: string): void; has(key: string): boolean };
    const now = Date.now();

    for (let i = 0; i < DKGAgent.VM_RECONCILE_CACHE_MAX_ENTRIES + 2; i += 1) {
      negativeCache.set(`future-${i}`, {
        localCgId: `future-cg-${i}`,
        failures: 1,
        nextRetryAt: now + 60_000,
        swmGen: 'empty:0',
        candidateNamespaces: [],
        peerTopologyKey: '',
      });
    }
    fetchCooldown.set('expired-cg', now - DKGAgent.VM_RECONCILE_SWEEP_INTERVAL_MS - 1);
    for (let i = 0; i < DKGAgent.VM_RECONCILE_CG_STATE_MAX_ENTRIES + 2; i += 1) {
      fetchCooldown.set(`fetch-${i}`, now);
      peerCursor.set(`cursor-${i}`, i);
      peerOrder.set(`cursor-${i}`, { orderedPeers: [`peer-${i}`], nextPeerId: `peer-${i}` });
    }

    (internals as any).pruneVmReconcileState(now);

    expect(negativeCache.size).toBeLessThanOrEqual(DKGAgent.VM_RECONCILE_CACHE_MAX_ENTRIES);
    expect(fetchCooldown.has('expired-cg')).toBe(false);
    expect(fetchCooldown.size).toBeLessThanOrEqual(DKGAgent.VM_RECONCILE_CG_STATE_MAX_ENTRIES);
    expect(peerCursor.size).toBeLessThanOrEqual(DKGAgent.VM_RECONCILE_CG_STATE_MAX_ENTRIES);
    expect(peerOrder.size).toBeLessThanOrEqual(DKGAgent.VM_RECONCILE_CG_STATE_MAX_ENTRIES);

    internals.subscribedContextGraphs.set('cleanup-cg', { subscribed: true });
    negativeCache.set('cleanup-cache', {
      localCgId: 'cleanup-cg',
      failures: 1,
      nextRetryAt: now + 60_000,
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });
    (internals as any).indexVmReconcileNegativeCacheEntry('cleanup-cg', 'cleanup-cache');
    fetchCooldown.set('cleanup-cg', now);
    peerCursor.set('cleanup-cg', 7);
    peerOrder.set('cleanup-cg', { orderedPeers: ['peer-a'], nextPeerId: 'peer-a' });
    recent.add('cleanup-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/1#01');
    (agent as any).unsubscribeFromContextGraph('cleanup-cg');
    expect(negativeCache.has('cleanup-cache')).toBe(false);
    expect(fetchCooldown.has('cleanup-cg')).toBe(false);
    expect(peerCursor.has('cleanup-cg')).toBe(false);
    expect(peerOrder.has('cleanup-cg')).toBe(false);
    expect(recent.has('cleanup-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/1#01')).toBe(false);

    internals.subscribedContextGraphs.set('hosted-cg', { subscribed: true, coreHosted: true });
    negativeCache.set('hosted-cache', {
      localCgId: 'hosted-cg',
      failures: 1,
      nextRetryAt: now + 60_000,
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });
    (internals as any).indexVmReconcileNegativeCacheEntry('hosted-cg', 'hosted-cache');
    fetchCooldown.set('hosted-cg', now);
    peerCursor.set('hosted-cg', 3);
    peerOrder.set('hosted-cg', { orderedPeers: ['peer-b'], nextPeerId: 'peer-b' });
    recent.add('hosted-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/2#02');
    (agent as any).unsubscribeFromContextGraph('hosted-cg');
    expect(negativeCache.has('hosted-cache')).toBe(true);
    expect(fetchCooldown.has('hosted-cg')).toBe(true);
    expect(peerCursor.has('hosted-cg')).toBe(true);
    expect(peerOrder.has('hosted-cg')).toBe(true);
    expect(recent.has('hosted-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/2#02')).toBe(true);
  });
});

describe('Phase D — reconcile gate + core-fill telemetry', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    vi.restoreAllMocks();
  });

  it('sweep triggers a reconcile for a core-hosted CG with NO member subscription', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    // Host-only CG (subscribed:false, coreHosted:true) + a never-hosted member CG.
    internals.subscribedContextGraphs.set('100', { subscribed: false, coreHosted: true, onChainId: '100' });
    internals.subscribedContextGraphs.set('200', { subscribed: false, onChainId: '200' }); // neither subscribed nor hosted

    const triggered: string[] = [];
    internals.reconcileCoalescer = { trigger: (cg: string) => { triggered.push(cg); } };

    await internals.runVmReconcileSweep();

    expect(triggered).toContain('100');     // hosted → swept
    expect(triggered).not.toContain('200'); // neither → skipped
  });

  it('a host-only reconcile promotes the missed KA to VM and emits core-fill', async () => {
    const captured: ReplicationEvent[] = [];
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'CoreFillE2E',
      chainAdapter: chain,
      onReplicationEvent: (ev) => { captured.push(ev); },
    });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    const { contextGraphId: ON_CHAIN_CG } = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    const localCgId = ON_CHAIN_CG.toString();
    // The Core already has the SWM snapshot locally (simulating a pull from
    // another Core), but never member-subscribed — it only hosts the CG.
    const root = await seedSwmSnapshot(internals.store, localCgId, 'urn:fact:monday', 'Monday fun fact');
    const { ethers } = await import('ethers');
    chain.__registerKC({ kaId: 4242n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    await internals.recordCoreHostedPublicCg(localCgId);
    await internals.runVmReconcileForCg(localCgId);

    // Promoted into the per-CG VM graph.
    const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(chain.chainId, storageAddr, 4242n);
    expect(ual).toContain('4242');
    const vmGraph = `did:dkg:context-graph:${localCgId}/context/${ON_CHAIN_CG}`;
    const res = await internals.store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:fact:monday> <http://schema.org/name> "Monday fun fact" } }`,
    );
    expect(res.type === 'boolean' && res.value).toBe(true);

    // Watermark advanced + distinct core-fill telemetry emitted.
    expect(internals.subscribedContextGraphs.get(localCgId)?.lastReconciledOrdinal).toBe(1);
    const coreFill = captured.find((e) => e.action === 'core-fill');
    expect(coreFill).toBeDefined();
    expect(coreFill?.reconciled).toBe(1);
    expect(coreFill?.contextGraphId).toBe(localCgId);
  });
});
