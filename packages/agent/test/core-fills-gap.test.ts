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
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ReplicationEvent, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';

interface AgentInternals {
  recordCoreHostedPublicCg(cgId: string, swmGraphId?: string): Promise<void>;
  reconcileChainOrdinal(localCgId: string, onChainCgId: bigint, ordinal: number, headBlock: number | undefined): Promise<{ status: string }>;
  syncContextGraphFromConnectedPeers(contextGraphId: string, options?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string }): Promise<unknown>;
  runVmReconcileForCg(localCgId: string): Promise<void>;
  runVmReconcileSweep(): Promise<void>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string; lastReconciledOrdinal?: number }>;
  reconcileCoalescer: { trigger: (cg: string) => void } | null;
  store: TripleStore;
  chain: MockChainAdapter & { getContextGraphAccessPolicy?: (id: bigint) => Promise<number> };
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

    // Same local id ("devnet-test"), but now hosting a DIFFERENT chain graph (9).
    await internals.recordCoreHostedPublicCg('9', 'devnet-test');

    const sub = internals.subscribedContextGraphs.get('devnet-test');
    expect(sub!.subscribed).toBe(true);            // membership preserved
    expect(sub!.coreHosted).toBe(true);
    expect(sub!.onChainId).toBe('9');              // rebound to the new graph
    expect(sub!.lastReconciledOrdinal).toBe(0);    // stale watermark dropped
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
    expect(cacheKeys).toHaveLength(1);
    expect(cacheKeys[0]).toContain('22'.repeat(32));
    expect(cacheKeys[0]).not.toContain('11'.repeat(32));
  });

  it('keeps an unreadable negative-cache generation damped until backoff expires', async () => {
    const internals = await boot();
    const onChainCgId = 45n;
    registerUnmatchedKC(internals.chain, 9005n, onChainCgId);

    const fetch = vi.spyOn(internals, 'syncContextGraphFromConnectedPeers').mockResolvedValue(emptyCatchupStats());
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    let generationReads = 0;
    vi.spyOn(internals.store, 'query').mockImplementation(async (sparql: string) => {
      if (sparql.includes('COUNT(?root) AS ?rootCount')) {
        generationReads++;
        if (generationReads <= 2) throw new Error('transient generation read failure');
      }
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expensiveScans).toBe(0);
    expect(generationReads).toBe(2);
  });

  it('invalidates the retry cache only for operation changes in the candidate SWM namespace', async () => {
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
    expect(expensiveScans).toBe(0);

    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('43'),
      'candidate-root-op-with-older-timestamp',
      'urn:fact:candidate',
      '2020-01-01T00:00:00.000Z',
    );

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
    internals.chain.getContextGraphAccessPolicy = async () => 0;

    const ON_CHAIN_CG = 42n;
    // The Core already has the SWM snapshot locally (simulating a pull from
    // another Core), but never member-subscribed — it only hosts the CG.
    const root = await seedSwmSnapshot(internals.store, '42', 'urn:fact:monday', 'Monday fun fact');
    const { ethers } = await import('ethers');
    chain.__registerKC({ kaId: 4242n, contextGraphId: ON_CHAIN_CG, merkleRootHex: ethers.hexlify(root), chunks: [] });

    await internals.recordCoreHostedPublicCg('42');
    await internals.runVmReconcileForCg('42');

    // Promoted into the per-CG VM graph.
    const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(chain.chainId, storageAddr, 4242n);
    expect(ual).toContain('4242');
    const vmGraph = `did:dkg:context-graph:42/context/${ON_CHAIN_CG}`;
    const res = await internals.store.query(
      `ASK { GRAPH <${vmGraph}> { <urn:fact:monday> <http://schema.org/name> "Monday fun fact" } }`,
    );
    expect(res.type === 'boolean' && res.value).toBe(true);

    // Watermark advanced + distinct core-fill telemetry emitted.
    expect(internals.subscribedContextGraphs.get('42')?.lastReconciledOrdinal).toBe(1);
    const coreFill = captured.find((e) => e.action === 'core-fill');
    expect(coreFill).toBeDefined();
    expect(coreFill?.reconciled).toBe(1);
    expect(coreFill?.contextGraphId).toBe('42');
  });
});
