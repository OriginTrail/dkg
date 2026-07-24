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

// Hand-rolled call recorder (replaces vitest spy factories): wraps an
// implementation, records every argument tuple on `.calls`, and returns the
// implementation's result. `vi` is retained ONLY for deterministic fake-timer
// clock control (legitimate time, not a behavior mock).
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import type {
  ReplicationEvent,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  VmReconcileNegativeRecord,
} from '../src/dkg-agent-types.js';
import { DKGAgent } from '../src/index.js';
import {
  VmReconcileDispatcher,
  type PendingOrdinalRecoveryResult,
} from '../src/chain-reconciler.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';

interface AgentInternals {
  createContextGraph(opts: { id: string; name: string; description?: string; private?: boolean; callerAgentAddress?: string }): Promise<void>;
  registerContextGraph(id: string, opts?: { callerAgentAddress?: string }): Promise<{ onChainId: string; txHash?: string }>;
  recordCoreHostedPublicCg(cgId: string, swmGraphId?: string): Promise<void>;
  reconcileChainOrdinal(
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options?: {
      acquireActiveFetchPermit?: () => boolean;
      maxPeerAttempts?: number;
      isTargetCurrent?: () => boolean;
      deferActiveFetch?: boolean;
    },
  ): Promise<{ status: string }>;
  recoverVmReconcileBatch(
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly Array<{
      ordinal: number;
      ual: string;
      kaId: string;
      reason: 'no-swm' | 'verified-vm-metadata-pending';
    }>,
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
  ): Promise<PendingOrdinalRecoveryResult>;
  syncContextGraphFromConnectedPeers(contextGraphId: string, options?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string }): Promise<unknown>;
  runVmReconcileForCg(localCgId: string, source?: 'live' | 'periodic' | 'manual'): Promise<{
    status: string;
    attempted: boolean;
    headOrdinal: number;
    watermarkBefore: number;
    watermarkAfter: number;
  }>;
  runVmReconcileSweep(): Promise<void>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; coreHosted?: boolean; onChainId?: string; lastReconciledOrdinal?: number }>;
  vmReconcileDispatcher: {
    triggerLive: (cg: string) => void;
    triggerPeriodic: (cg: string) => void;
    tryTriggerPeriodic: (cg: string) => boolean;
    dispatch?: (cg: string, source: 'live' | 'periodic' | 'manual') => Promise<unknown>;
  } | null;
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
    totalPeers: 1,
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
    vi.useRealTimers();
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    saved.length = 0;
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

  it('memoizes ACK-backed access-policy reads when the adapter has no liveness probe', async () => {
    const internals = await boot();
    const getContextGraphAccessPolicy = recorder(async () => 0);
    internals.chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;
    (internals.chain as { isContextGraphActiveOnChain?: unknown }).isContextGraphActiveOnChain = undefined;

    await internals.recordCoreHostedPublicCg('43');
    await internals.recordCoreHostedPublicCg('43');

    expect(getContextGraphAccessPolicy.calls).toHaveLength(1);
    expect((internals as any).onChainAccessPolicyCache.get('43')).toBe(0);
  });

  it('falls back to ACK-backed policy read when the liveness probe times out', async () => {
    const internals = await boot();
    const getContextGraphAccessPolicy = recorder(async () => 0);
    internals.chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;
    internals.chain.isContextGraphActiveOnChain = recorder(() => new Promise<boolean>(() => undefined));

    vi.useFakeTimers();
    try {
      const recorded = internals.recordCoreHostedPublicCg('45');
      await vi.advanceTimersByTimeAsync(2_500);
      await recorded;
    } finally {
      vi.useRealTimers();
    }

    expect(getContextGraphAccessPolicy.calls.at(-1)).toEqual([45n]);
    expect(internals.subscribedContextGraphs.get('45')?.coreHosted).toBe(true);
  });

  it('lets in-flight core-host recordings finish while shutdown is draining', async () => {
    const internals = await boot();
    let resolvePolicy!: (value: number) => void;
    internals.chain.getContextGraphAccessPolicy = recorder(() => new Promise<number>((resolve) => {
      resolvePolicy = resolve;
    }));
    (internals.chain as { isContextGraphActiveOnChain?: unknown }).isContextGraphActiveOnChain = undefined;

    const recording = internals.recordCoreHostedPublicCg('48', 'late-hosted');
    (internals as any).coreHostRecordingsClosed = true;
    resolvePolicy(0);
    await recording;

    expect(internals.subscribedContextGraphs.get('late-hosted')?.coreHosted).toBe(true);
    expect(saved.find((r) => r.id === 'late-hosted')?.coreHosted).toBe(true);
  });

  it('ignores late core-host recording completions from abandoned drain generations after restart', async () => {
    const internals = await boot();
    let resolvePolicy!: (value: number) => void;
    internals.chain.getContextGraphAccessPolicy = recorder(() => new Promise<number>((resolve) => {
      resolvePolicy = resolve;
    }));
    (internals.chain as { isContextGraphActiveOnChain?: unknown }).isContextGraphActiveOnChain = undefined;

    const recording = internals.recordCoreHostedPublicCg('49', 'late-after-timeout');
    (internals as any).coreHostRecordingGeneration += 1;
    // Simulate a later restart opening new recordings; the abandoned
    // continuation captured the previous generation and must still be ignored.
    (internals as any).coreHostRecordingsClosed = false;
    resolvePolicy(0);
    await recording;

    expect(internals.subscribedContextGraphs.get('late-after-timeout')).toBeUndefined();
    expect(saved.find((r) => r.id === 'late-after-timeout')).toBeUndefined();
  });

  it('uses cached public access policy when liveness fails and the fallback policy read flakes', async () => {
    const internals = await boot();
    ((internals as any).onChainAccessPolicyCache as Map<string, 0 | 1>).set('50', 0);
    internals.chain.isContextGraphActiveOnChain = recorder(async () => {
      throw new Error('liveness rpc unavailable');
    });
    const getContextGraphAccessPolicy = recorder(async (): Promise<number> => {
      throw new Error('rpc unavailable');
    });
    internals.chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;

    await internals.recordCoreHostedPublicCg('50', 'cached-public');

    expect(getContextGraphAccessPolicy.calls).toEqual([]);
    expect(internals.subscribedContextGraphs.get('cached-public')?.coreHosted).toBe(true);
    expect(saved.find((r) => r.id === 'cached-public')?.coreHosted).toBe(true);
  });

  it('forces a fresh policy read after liveness proves the slot is live', async () => {
    const internals = await boot();
    ((internals as any).onChainAccessPolicyCache as Map<string, 0 | 1>).set('51', 0);
    internals.chain.isContextGraphActiveOnChain = recorder(async () => true);
    const getContextGraphAccessPolicy = recorder(async () => 1);
    internals.chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;

    await internals.recordCoreHostedPublicCg('51', 'stale-cache-curated');

    expect(getContextGraphAccessPolicy.calls.at(-1)).toEqual([51n]);
    expect(internals.subscribedContextGraphs.get('stale-cache-curated')).toBeUndefined();
    expect(saved.find((r) => r.id === 'stale-cache-curated')).toBeUndefined();
  });

  it('falls back to ACK-backed policy read when the liveness probe rejects', async () => {
    const internals = await boot();
    const getContextGraphAccessPolicy = recorder(async () => 0);
    internals.chain.getContextGraphAccessPolicy = getContextGraphAccessPolicy;
    internals.chain.isContextGraphActiveOnChain = recorder(async () => {
      throw new Error('rpc unavailable');
    });

    await internals.recordCoreHostedPublicCg('46');

    expect(getContextGraphAccessPolicy.calls.at(-1)).toEqual([46n]);
    expect(internals.subscribedContextGraphs.get('46')?.coreHosted).toBe(true);
    expect(saved.find((r) => r.id === '46')?.coreHosted).toBe(true);
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

  it('bounds core-host recording drain during shutdown', async () => {
    const internals = await boot();
    const recordings = (internals as any).coreHostRecordings as Set<Promise<void>>;
    recordings.add(new Promise<void>(() => undefined));
    const log = (internals as any).log;
    const origWarn = log.warn.bind(log);
    const warn = recorder((...a: unknown[]) => origWarn(...a));
    log.warn = warn;
    const generationBeforeDrain = (internals as any).coreHostRecordingGeneration;

    vi.useFakeTimers();
    try {
      const drained = (internals as any).drainCoreHostRecordings();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(drained).resolves.toBeUndefined();

      expect(recordings.size).toBe(0);
      expect((internals as any).coreHostRecordingGeneration).toBe(generationBeforeDrain + 1);
      expect(warn.calls).toContainEqual([
        expect.anything(),
        expect.stringContaining('timed out draining 1 core-host recording'),
      ]);
    } finally {
      recordings.clear();
      vi.useRealTimers();
    }
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

  it('does not re-register an existing on-chain id when liveness is unknown', async () => {
    const internals = await boot();
    const localCgId = 'unknown-live-register';
    const ownerAddr = (internals.chain as unknown as { signerAddress: string }).signerAddress;

    await internals.createContextGraph({
      id: localCgId,
      name: 'Unknown Live Register',
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
    internals.chain.isContextGraphActiveOnChain = recorder(async () => {
      throw new Error('rpc unavailable');
    });
    const origRegisterOnChain = (internals as any).registerContextGraphOnChain.bind(internals);
    const registerOnChain = recorder((...a: unknown[]) => origRegisterOnChain(...a));
    (internals as any).registerContextGraphOnChain = registerOnChain;

    await expect(internals.registerContextGraph(localCgId, { callerAgentAddress: ownerAddr }))
      .rejects.toThrow(/liveness could not be verified/);

    expect(registerOnChain.calls).toEqual([]);
    expect(internals.subscribedContextGraphs.get(localCgId)).toMatchObject({
      subscribed: true,
      onChainId: '5',
      lastReconciledOrdinal: 4,
    });
  });
});

describe('Phase D - VM reconcile damping', () => {
  let agent: DKGAgent | null = null;

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  async function boot(contextGraphSubscriptionStore?: ContextGraphSubscriptionStore): Promise<AgentInternals> {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({
      name: 'VmReconcileDamping',
      chainAdapter: chain,
      contextGraphSubscriptionStore,
    });
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

  it('reconciles packed rootless ids through their canonical author/number UAL', async () => {
    const internals = await boot();
    const onChainCgId = 66n;
    const authorAddress = '0x9277a1a194fcadbb60d8df0c472e7909ead50e33';
    const kaNumber = 408n;
    const kaId = packKnowledgeAssetIdFromIdentity({ agentAddress: authorAddress, kaNumber });
    registerUnmatchedKC(internals.chain, kaId, onChainCgId);

    const reconcile = recorder(async () => 'already-confirmed' as const);
    (internals as any).getOrCreateFinalizationHandler = recorder(() => ({
      handleChainReconciledKC: reconcile,
    }));

    await expect(internals.reconcileChainOrdinal('66', onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'already', blockNumber: 0 });

    expect(reconcile.calls).toHaveLength(1);
    expect(reconcile.calls[0]?.[0]).toMatchObject({
      kaId,
      ual: buildKnowledgeAssetUal(internals.chain.chainId, authorAddress, kaNumber),
    });
  });

  it('keeps legacy sequential ids on the read-only contract/id UAL', async () => {
    const internals = await boot();
    const onChainCgId = 67n;
    const kaId = 9067n;
    registerUnmatchedKC(internals.chain, kaId, onChainCgId);

    const reconcile = recorder(async () => 'already-confirmed' as const);
    (internals as any).getOrCreateFinalizationHandler = recorder(() => ({
      handleChainReconciledKC: reconcile,
    }));

    await expect(internals.reconcileChainOrdinal('67', onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'already', blockNumber: 0 });

    const storageAddress = await internals.chain.getDKGKnowledgeAssetsAddress();
    expect(reconcile.calls).toHaveLength(1);
    expect(reconcile.calls[0]?.[0]).toMatchObject({
      kaId,
      ual: buildKnowledgeAssetUal(internals.chain.chainId, storageAddress, kaId),
    });
  });

  it('negative-caches a missing SWM snapshot and skips the expensive scan plus active fetch during backoff', async () => {
    const internals = await boot();
    const onChainCgId = 42n;
    registerUnmatchedKC(internals.chain, 9001n, onChainCgId);

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('42', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('42', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBe(0);
  });

  it('rehydrates a generation-gated miss after restart without repeating the scan', async () => {
    const durable = new Map<string, VmReconcileNegativeRecord>();
    const subscriptionStore: ContextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => undefined,
      delete: async () => undefined,
      loadVmReconcileNegative: async (key) => durable.get(key) ?? null,
      saveVmReconcileNegative: async (record) => { durable.set(record.cacheKey, record); },
      deleteVmReconcileNegative: async (key) => { durable.delete(key); },
      deleteVmReconcileNegativesForContextGraph: async (cg) => {
        for (const [key, record] of durable) if (record.localCgId === cg) durable.delete(key);
      },
    };
    const onChainCgId = 52n;
    let internals = await boot(subscriptionStore);
    registerUnmatchedKC(internals.chain, 9052n, onChainCgId);
    (internals as any).syncContextGraphFromConnectedPeers = recorder(async () => emptyCatchupStats());
    await internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined);
    expect(durable.size).toBe(1);

    await agent!.stop();
    agent = null;
    internals = await boot(subscriptionStore);
    registerUnmatchedKC(internals.chain, 9052n, onChainCgId);
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });
    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined);
    expect(expensiveScans).toBe(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it('rescans after restart when an incomplete operation payload appears only in a per-KA child graph', async () => {
    const durable = new Map<string, VmReconcileNegativeRecord>();
    const subscriptionStore: ContextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => undefined,
      delete: async () => undefined,
      loadVmReconcileNegative: async (key) => durable.get(key) ?? null,
      saveVmReconcileNegative: async (record) => { durable.set(record.cacheKey, record); },
      deleteVmReconcileNegative: async (key) => { durable.delete(key); },
      deleteVmReconcileNegativesForContextGraph: async (cg) => {
        for (const [key, record] of durable) if (record.localCgId === cg) durable.delete(key);
      },
    };
    const localCgId = '65';
    const onChainCgId = 65n;
    const kaId = 9065n;
    const entity = 'urn:fact:child-after-restart';
    const value = 'Payload persisted in a per-KA SWM graph';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    const publishedAt = '2035-01-01T00:00:00.000Z';

    let internals = await boot(subscriptionStore);
    registerUnmatchedKC(internals.chain, kaId, onChainCgId, bytesToHex(root));
    (internals.store as TripleStore & { getWriteGen?: (prefix: string) => number }).getWriteGen = () => 0;
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri(localCgId),
      'child-after-restart',
      entity,
      publishedAt,
    );
    (internals as any).syncContextGraphFromConnectedPeers = recorder(async () => emptyCatchupStats());

    await expect(internals.reconcileChainOrdinal(localCgId, onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'pending' });
    expect(durable.size).toBe(0);

    await agent!.stop();
    agent = null;
    internals = await boot(subscriptionStore);
    registerUnmatchedKC(internals.chain, kaId, onChainCgId, bytesToHex(root));
    (internals.store as TripleStore & { getWriteGen?: (prefix: string) => number }).getWriteGen = () => 0;
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri(localCgId),
      'child-after-restart',
      entity,
      publishedAt,
    );
    await internals.store.insert([{
      subject: entity,
      predicate: 'http://schema.org/name',
      object: `"${value}"`,
      graph: `${contextGraphWorkspaceGraphUri(localCgId)}/0x0000000000000000000000000000000000000000/${kaId}`,
    }]);

    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });
    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal(localCgId, onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(expensiveScans).toBeGreaterThan(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it('does not reuse a negative cache entry after catchup peer topology changes', async () => {
    const internals = await boot();
    const onChainCgId = 54n;
    registerUnmatchedKC(internals.chain, 9014n, onChainCgId);

    let connectedPeers = ['peer-empty'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('54', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;
    connectedPeers = ['peer-empty', 'peer-newly-reachable'];

    await expect(internals.reconcileChainOrdinal('54', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    // The sweep-level cache entry is NOT reused — the fetch re-ran for the new
    // topology (1 → 3 calls). The scan itself is served by the handler-level
    // write-generation negative memo (#1609): no local write touched the CG
    // between passes, so rescanning the unchanged store cannot change the
    // verdict. Peer topology gates the FETCH, not the scan.
    expect(fetch.calls).toHaveLength(3);
    expect(expensiveScans).toBe(0);
  });

  it('reuses a negative cache entry when connected peers only reorder', async () => {
    const internals = await boot();
    const onChainCgId = 55n;
    registerUnmatchedKC(internals.chain, 9015n, onChainCgId);

    let connectedPeers = ['peer-a', 'peer-b'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('55', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    const fetchesAfterFirstMiss = fetch.calls.length;
    expect(fetchesAfterFirstMiss).toBeGreaterThan(0);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;
    connectedPeers = ['peer-b', 'peer-a'];

    await expect(internals.reconcileChainOrdinal('55', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(fetchesAfterFirstMiss);
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
    (internals as any).primeCatchupConnections = recorder(async () => {
      primeCalls += 1;
      if (primeCalls >= 1) {
        connectedPeers = ['peer-empty', 'peer-discovered'];
      }
    });

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('57', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    expensiveScans = 0;

    await expect(internals.reconcileChainOrdinal('57', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(primeCalls).toBeGreaterThanOrEqual(1);
    // Fetch re-ran against the primed topology (sweep entry not reused); the
    // scan is served by the #1609 write-gen negative memo — see the topology
    // test above.
    expect(fetch.calls).toHaveLength(3);
    expect(expensiveScans).toBe(0);
  });

  it('does not reuse a negative cache entry when catchup ranking changes for the same peer set', async () => {
    const internals = await boot();
    const onChainCgId = 56n;
    registerUnmatchedKC(internals.chain, 9016n, onChainCgId);

    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-reclassified' } },
    ];

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('56', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    (internals as any).knownCorePeerIds.add('peer-reclassified');

    await expect(internals.reconcileChainOrdinal('56', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    // Fetch re-ran for the reclassified peer (sweep entry not reused); the
    // scan is served by the #1609 write-gen negative memo — see the topology
    // test above.
    expect(fetch.calls).toHaveLength(2);
    expect(expensiveScans).toBe(0);
  });

  it('does not reuse a negative cache entry when the same KA has a newer merkle root', async () => {
    const internals = await boot();
    const onChainCgId = 46n;
    registerUnmatchedKC(internals.chain, 9006n, onChainCgId, '0x' + '11'.repeat(32));

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBe(0);

    registerUnmatchedKC(internals.chain, 9006n, onChainCgId, '0x' + '22'.repeat(32));
    await expect(internals.reconcileChainOrdinal('46', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    // New root bypasses the negative-cache deferral and re-runs the SWM scan;
    // the independent per-CG active-fetch cooldown may still suppress another
    // network fetch in the same sweep interval.
    expect(fetch.calls).toHaveLength(1);
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('48'),
      'data-arrival-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );

    await expect(internals.reconcileChainOrdinal('48', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await insertWorkspaceDataTriple(internals.store, '48', entity, value);

    await expect(internals.reconcileChainOrdinal('48', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
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

    const fetch = recorder(async () => {
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
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('61', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
  });

  it('actively fetches provenance metadata when exact VM content is metadata-pending', async () => {
    const internals = await boot();
    const onChainCgId = 62n;
    const root = new Uint8Array(32);
    root[31] = 62;
    registerUnmatchedKC(internals.chain, 9062n, onChainCgId, bytesToHex(root));

    let finalizationAttempt = 0;
    const handleChainReconciledKC = recorder(async () => {
      finalizationAttempt += 1;
      return finalizationAttempt === 1
        ? 'verified-vm-metadata-pending'
        : 'already-confirmed';
    });
    (internals as any).getOrCreateFinalizationHandler = recorder(() => ({
      handleChainReconciledKC,
    }));
    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('62', onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'already', blockNumber: 0 });

    expect(fetch.calls).toHaveLength(1);
    expect(handleChainReconciledKC.calls).toHaveLength(2);
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('52'),
      'data-replacement-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );
    await insertWorkspaceDataTriple(internals.store, '52', entity, staleValue);

    await expect(internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await replaceWorkspaceDataTriple(internals.store, '52', entity, freshValue);

    await expect(internals.reconcileChainOrdinal('52', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    await insertWorkspaceOperationMeta(
      internals.store,
      contextGraphWorkspaceMetaGraphUri('49'),
      'private-arrival-op',
      entity,
      '2030-01-01T00:00:00.000Z',
    );
    await insertWorkspaceDataTriple(internals.store, '49', entity, value);

    await expect(internals.reconcileChainOrdinal('49', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await insertPrivateMerkleRoot(internals.store, '49', entity, privateRoot);

    await expect(internals.reconcileChainOrdinal('49', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('53', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await seedSwmSnapshotInSubGraph(internals.store, '53', 'code', entity, value);

    await expect(internals.reconcileChainOrdinal('53', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
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

    const originalListSubGraphs = GraphManager.prototype.listSubGraphs;
    GraphManager.prototype.listSubGraphs = recorder(async () => { throw new Error('subgraph listing failed'); }) as typeof originalListSubGraphs;
    try {
      const fetch = recorder(async () => emptyCatchupStats());
      (internals as any).syncContextGraphFromConnectedPeers = fetch;

      await expect(internals.reconcileChainOrdinal('58', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
      expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

      const seededRoot = await seedSwmSnapshot(internals.store, '58', entity, value);
      expect(bytesToHex(seededRoot)).toBe(bytesToHex(root));

      await expect(internals.reconcileChainOrdinal('58', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
      expect(fetch.calls).toHaveLength(1);
      expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
    } finally {
      GraphManager.prototype.listSubGraphs = originalListSubGraphs;
    }
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('60', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    const fetchesAfterFirstMiss = fetch.calls.length;
    expect(fetchesAfterFirstMiss).toBeGreaterThan(0);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    const originalListSubGraphs = GraphManager.prototype.listSubGraphs;
    GraphManager.prototype.listSubGraphs = recorder(async () => { throw new Error('transient subgraph listing failure'); }) as typeof originalListSubGraphs;
    try {
      expensiveScans = 0;

      await expect(internals.reconcileChainOrdinal('60', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
      expect(fetch.calls).toHaveLength(fetchesAfterFirstMiss);
      expect(expensiveScans).toBe(0);
      expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);
    } finally {
      GraphManager.prototype.listSubGraphs = originalListSubGraphs;
    }
  });

  it('invalidates a negative cache entry when root SWM changes while subgraph enumeration fails', async () => {
    const internals = await boot();
    const onChainCgId = 65n;
    const entity = 'urn:fact:root-arrival-after-subgraph-cache';
    const value = 'Root SWM arrived after subgraph cache';
    const root = computeFlatKCRootV10(
      [{ subject: entity, predicate: 'http://schema.org/name', object: `"${value}"`, graph: '' }],
      [],
    );
    registerUnmatchedKC(internals.chain, 9025n, onChainCgId, bytesToHex(root));

    const graphManager = new GraphManager(internals.store);
    await internals.store.insert([{
      subject: 'urn:test:subgraph-marker:code',
      predicate: 'http://schema.org/name',
      object: '"marker"',
      graph: graphManager.subGraphUri('65', 'code'),
    }]);

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('65', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    const fetchesAfterFirstMiss = fetch.calls.length;
    expect(fetchesAfterFirstMiss).toBeGreaterThan(0);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    const originalListSubGraphs = GraphManager.prototype.listSubGraphs;
    GraphManager.prototype.listSubGraphs = recorder(async () => { throw new Error('transient subgraph listing failure'); }) as typeof originalListSubGraphs;
    try {
      const seededRoot = await seedSwmSnapshot(internals.store, '65', entity, value);
      expect(bytesToHex(seededRoot)).toBe(bytesToHex(root));

      await expect(internals.reconcileChainOrdinal('65', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
      expect(fetch.calls).toHaveLength(fetchesAfterFirstMiss);
      expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);
    } finally {
      GraphManager.prototype.listSubGraphs = originalListSubGraphs;
    }
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

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    let generationReads = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
      if (sparql.includes('SELECT ?op ?root ?ts WHERE')) {
        generationReads++;
        if (generationReads <= 2) throw new Error('transient generation read failure');
      }
      if (sparql.includes('SELECT ?op ?root WHERE')) expensiveScans++;
      return originalQuery(sparql);
    });

    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);
    expect(generationReads).toBe(2);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(0);

    await seedSwmSnapshot(internals.store, '45', entity, value);

    expensiveScans = 0;
    await expect(internals.reconcileChainOrdinal('45', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'reconciled', blockNumber: 0 });
    expect(fetch.calls).toHaveLength(1);
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

  it('negative-caches unchanged incomplete SWM operations and invalidates on namespace/content changes', async () => {
    const internals = await boot();
    const onChainCgId = 43n;
    registerUnmatchedKC(internals.chain, 9002n, onChainCgId);

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;
    const originalQuery = internals.store.query.bind(internals.store);
    let expensiveScans = 0;
    (internals.store as any).query = recorder(async (sparql: string) => {
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
    expect(fetch.calls).toHaveLength(1);
    expect(((internals as any).vmReconcileNegativeCache as Map<string, unknown>).size).toBe(1);

    await insertWorkspaceOperationMeta(
      internals.store,
      'did:dkg:context-graph:43/code/_shared_memory_meta',
      'unrelated-subgraph-op',
      'urn:fact:unrelated',
      '2040-01-01T00:00:00.000Z',
    );

    expensiveScans = 0;
    await internals.reconcileChainOrdinal('43', onChainCgId, 0, undefined);
    expect(fetch.calls).toHaveLength(1);
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
    expect(fetch.calls).toHaveLength(1);
    expect(expensiveScans).toBeGreaterThan(0);
  });

  it('runs at most one active fetch per CG sweep interval across different pending ordinals', async () => {
    const internals = await boot();
    const onChainCgId = 44n;
    registerUnmatchedKC(internals.chain, 9003n, onChainCgId);
    registerUnmatchedKC(internals.chain, 9004n, onChainCgId);

    const fetch = recorder(async () => emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await internals.reconcileChainOrdinal('44', onChainCgId, 0, undefined);
    await internals.reconcileChainOrdinal('44', onChainCgId, 1, undefined);

    expect(fetch.calls).toHaveLength(1);
  });

  it('falls through a no-protocol active-fetch peer before caching a miss', async () => {
    const internals = await boot();
    const onChainCgId = 47n;
    registerUnmatchedKC(internals.chain, 9007n, onChainCgId);
    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-no-protocol' } },
      { remotePeer: { toString: () => 'peer-empty' } },
    ];

    const fetchResults = [noProtocolCatchupStats(), emptyCatchupStats()];
    const fetch = recorder(async () => fetchResults.shift() ?? emptyCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('47', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]).toEqual(['47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
    }]);
    expect(fetch.calls[1]).toEqual(['47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
    }]);
  });

  it('extends active-fetch attempts after the first fetch round dials another peer', async () => {
    const internals = await boot();
    const onChainCgId = 59n;
    registerUnmatchedKC(internals.chain, 9019n, onChainCgId);

    let connectedPeers = ['peer-initial'];
    (agent as any).node.libp2p.getConnections = () =>
      connectedPeers.map((peerId) => ({ remotePeer: { toString: () => peerId } }));

    const fetch = recorder(async () => {
      if (connectedPeers.length === 1) {
        connectedPeers = ['peer-initial', 'peer-dialed'];
      }
      return {
        ...emptyCatchupStats(),
        connectedPeers: connectedPeers.length,
        totalPeers: connectedPeers.length,
        selectedPeers: 1,
      };
    });
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('59', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch.calls).toHaveLength(2);
  });

  it('attempts every connected peer before recording a miss', async () => {
    const internals = await boot();
    const onChainCgId = 64n;
    registerUnmatchedKC(internals.chain, 9024n, onChainCgId);

    const fetch = recorder(async () => ({
      ...emptyCatchupStats(),
      connectedPeers: 33,
      totalPeers: 33,
      selectedPeers: 1,
    }));
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('64', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch.calls).toHaveLength(33);
  });

  it('does not negative-cache no-swm when active fetch reaches no sync-capable peer', async () => {
    const internals = await boot();
    const onChainCgId = 50n;
    registerUnmatchedKC(internals.chain, 9010n, onChainCgId);
    (agent as any).node.libp2p.getConnections = () => [
      { remotePeer: { toString: () => 'peer-no-protocol-a' } },
      { remotePeer: { toString: () => 'peer-no-protocol-b' } },
    ];

    const fetch = recorder(async () => noProtocolCatchupStats());
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('50', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch.calls).toHaveLength(2);
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

    const fetch = recorder(async () => { throw new Error('fetch failed'); });
    (internals as any).syncContextGraphFromConnectedPeers = fetch;

    await expect(internals.reconcileChainOrdinal('51', onChainCgId, 0, undefined)).resolves.toEqual({ status: 'pending' });

    expect(fetch.calls).toHaveLength(2);
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
    (internals as any).getOrCreateFinalizationHandler = recorder(() => ({
      handleChainReconciledKC: recorder(async () => 'stale-target'),
    }));

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
  });

  it('sweep triggers a reconcile for a core-hosted CG with NO member subscription', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillSweep', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;

    // Host-only CG (subscribed:false, coreHosted:true) + a never-hosted member CG.
    internals.subscribedContextGraphs.set('100', { subscribed: false, coreHosted: true, onChainId: '100' });
    internals.subscribedContextGraphs.set('200', { subscribed: false, onChainId: '200' }); // neither subscribed nor hosted

    const liveTriggered: string[] = [];
    const periodicTriggered: string[] = [];
    internals.vmReconcileDispatcher = {
      triggerLive: (cg: string) => { liveTriggered.push(cg); },
      triggerPeriodic: (cg: string) => { periodicTriggered.push(cg); },
      tryTriggerPeriodic: (cg: string) => {
        periodicTriggered.push(cg);
        return true;
      },
      dispatch: async (cg: string, source: 'live' | 'periodic' | 'manual') => {
        if (source === 'periodic') periodicTriggered.push(cg);
        else if (source === 'live') liveTriggered.push(cg);
        return {};
      },
    };

    await internals.runVmReconcileSweep();

    expect(periodicTriggered).toContain('100');     // hosted → swept
    expect(periodicTriggered).not.toContain('200'); // neither → skipped
    expect(liveTriggered).toEqual([]);
  });

  it('carries bounded periodic admission forward so every CG is eventually swept', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillSweepFairness', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.clear();

    const contextGraphIds = Array.from({ length: 7 }, (_, index) => `fair-${index}`);
    for (const [index, contextGraphId] of contextGraphIds.entries()) {
      internals.subscribedContextGraphs.set(contextGraphId, {
        subscribed: false,
        coreHosted: true,
        onChainId: String(index + 1),
      });
    }

    const swept: string[] = [];
    const dispatcher = new VmReconcileDispatcher(
      async (contextGraphId) => { swept.push(contextGraphId); },
      () => undefined,
      { concurrency: 1, maxPending: 1 },
    );
    internals.vmReconcileDispatcher = dispatcher;

    for (let sweep = 0; sweep < 4; sweep += 1) {
      await internals.runVmReconcileSweep();
      await dispatcher.waitForIdle();
    }

    expect(new Set(swept)).toEqual(new Set(contextGraphIds));
  });

  it('skips ordinal reconciliation when the durable watermark equals chain head', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillEvidenceGate', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const onChainCgId = 321n;
    internals.subscribedContextGraphs.set('evidence-current', {
      subscribed: false,
      coreHosted: true,
      onChainId: onChainCgId.toString(),
      lastReconciledOrdinal: 2,
    });
    chain.getContextGraphKCCount = async () => 2n;
    const reconcileOrdinal = recorder(async () => {
      throw new Error('must not reconcile an ordinal when evidence is current');
    });
    (internals as any).reconcileChainOrdinal = reconcileOrdinal;

    const result = await internals.runVmReconcileForCg('evidence-current', 'manual');

    expect(result).toMatchObject({
      status: 'current',
      attempted: false,
      headOrdinal: 2,
      watermarkBefore: 2,
      watermarkAfter: 2,
    });
    expect(reconcileOrdinal.calls).toEqual([]);
  });

  it('defers payload fetch during the parallel scan and recovers only missing ordinals as one batch', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillBatchFetchBudget', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'batch-fetch-budget';
    internals.subscribedContextGraphs.set(localCgId, {
      subscribed: false,
      coreHosted: true,
      onChainId: '324',
      lastReconciledOrdinal: 0,
    });
    chain.getContextGraphKCCount = async () => 3n;

    const scannedOrdinals: number[] = [];
    const deferredFetches: boolean[] = [];
    (internals as any).reconcileChainOrdinal = async (
      _lcg: string,
      _ocg: bigint,
      ordinal: number,
      _headBlock: number | undefined,
      options: {
        isTargetCurrent?: () => boolean;
        deferActiveFetch?: boolean;
      },
    ) => {
      scannedOrdinals.push(ordinal);
      deferredFetches.push(options.deferActiveFetch ?? false);
      expect(options.isTargetCurrent?.()).toBe(true);
      if (ordinal === 0) return { status: 'already', blockNumber: 0 };
      return {
        status: 'pending',
        recovery: {
          ordinal,
          ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
          kaId: String(ordinal),
          reason: 'no-swm',
        },
      };
    };
    const recoveryBatches: number[][] = [];
    (internals as any).recoverVmReconcileBatch = async (
      _lcg: string,
      _ocg: bigint,
      targets: readonly Array<{ ordinal: number }>,
    ) => {
      recoveryBatches.push(targets.map((target) => target.ordinal));
      return {
        outcomes: new Map(targets.map((target) => [
          target.ordinal,
          { status: 'reconciled', blockNumber: 0 } as const,
        ])),
      };
    };

    const result = await internals.runVmReconcileForCg(localCgId, 'manual');

    expect(result.watermarkAfter).toBe(3);
    expect(scannedOrdinals).toEqual([0, 1, 2]);
    expect(deferredFetches).toEqual([true, true, true]);
    expect(recoveryBatches).toEqual([[1, 2]]);
  });

  it('targets the authenticated curator without running the global connection-prime walk', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCuratorTarget', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const approvedPeer = '12D3KooWApprovedCuratorPeer';
    const registryPeer = '12D3KooWRegistryCuratorPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-target';
    const connected = [approvedPeer, registryPeer].map((peerId) => ({
      toString: () => peerId,
    }));
    (internals as any).node = {
      peerId: '12D3KooWExactVmLocalPeer',
      libp2p: {
        getConnections: () => connected.map((remotePeer) => ({ remotePeer })),
      },
    };
    (internals as any).preferredSyncPeers.set(localCgId, approvedPeer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [registryPeer],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    });
    (internals as any).primeCatchupConnections = async () => {
      throw new Error('exact recovery must not walk every discovered agent');
    };
    const connectionAttempts: string[] = [];
    (internals as any).ensurePeerConnected = async (peerId: string) => {
      connectionAttempts.push(peerId);
    };
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    const protocolPeers: Array<{ toString(): string }> = [];
    (internals as any).waitForSyncProtocol = async (peer: { toString(): string }) => {
      protocolPeers.push(peer);
      return true;
    };
    const fetches: Array<{ peerId: string; uals: string[] }> = [];
    (internals as any).syncExactKnowledgeAssetsFromPeer = async (
      peerId: string,
      _cg: string,
      uals: string[],
    ) => {
      fetches.push({ peerId, uals });
      return {
        fetchedDataTriples: 1,
        fetchedMetaTriples: 8,
        insertedTriples: 9,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 100,
    });
    const ual = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';

    const result = await internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      [{ ordinal: 0, ual, kaId: '7', reason: 'no-swm' }],
      100,
      () => true,
    );

    expect(connectionAttempts).toEqual([approvedPeer, registryPeer]);
    expect(protocolPeers[0]).toBe(connected[0]);
    expect(fetches).toEqual([{ peerId: approvedPeer, uals: [ual] }]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('fetches one large recovery KA per peer attempt and defers the rest', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmBatchCap', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWExactCapPeerA';
    const peerB = '12D3KooWExactCapPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-cap';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWExactCapLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA, peerB],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    const fetches: Array<{ peerId: string; uals: string[] }> = [];
    (internals as any).syncExactKnowledgeAssetsFromPeer = async (
      peerId: string,
      _cg: string,
      uals: string[],
    ) => {
      fetches.push({ peerId, uals });
      return {
        fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      };
    };
    const revalidated: number[] = [];
    (internals as any).reconcileChainOrdinal = async (
      _lcg: string, _ocg: bigint, ordinal: number,
    ) => {
      revalidated.push(ordinal);
      return { status: 'reconciled', blockNumber: 100 };
    };
    const targets = Array.from({ length: 4 }, (_, ordinal) => ({
      ordinal,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
      kaId: String(ordinal),
      reason: 'no-swm' as const,
    }));

    const result = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);

    // Every peer attempt gives one potentially frame-sized KA the full
    // foreground budget. The untouched tail remains for the next sweep.
    expect(fetches).toHaveLength(2);
    expect(fetches[0]!.uals).toEqual([targets[0]!.ual]);
    expect(fetches[1]!.uals).toEqual([targets[1]!.ual]);
    // Revalidation runs only for requested targets, in request order.
    expect(revalidated).toEqual([targets[0]!.ordinal, targets[1]!.ordinal]);
    expect(result.outcomes.size).toBe(2);
    expect(result.nextRecoveryOrdinal).toBe(2);
  });

  it('keeps an attempted pending target ahead of deferred targets and damps retries', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmBatchCooldown', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peer = '12D3KooWExactCooldownPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-cooldown';
    const connected = [{ toString: () => peer }];
    (internals as any).node = {
      peerId: '12D3KooWExactCooldownLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    let fetchCount = 0;
    (internals as any).syncExactKnowledgeAssetsFromPeer = async () => {
      fetchCount += 1;
      return {
        fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
        failedPeers: 1, failedPhases: 0, deferredBackpressure: 0,
      };
    };
    const target = {
      ordinal: 0,
      ual: 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7',
      kaId: '7',
      reason: 'no-swm' as const,
    };
    const deferredTarget = {
      ordinal: 1,
      ual: 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8',
      kaId: '8',
      reason: 'no-swm' as const,
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending',
      recovery: target,
    });

    const targets = [target, deferredTarget];
    const first = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);
    expect(fetchCount).toBe(1);
    expect(first.outcomes.get(0)).toMatchObject({ status: 'pending' });
    expect(first.nextRecoveryOrdinal).toBeUndefined();

    // Nothing recovered: the cooldown stamped on entry stands, so an immediate
    // next pass performs no network fetch for this CG.
    const second = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);
    expect(fetchCount).toBe(1);
    expect(second.outcomes.size).toBe(0);
    expect(second.nextRecoveryOrdinal).toBeUndefined();
  });

  it('clears the fetch cooldown after a productive exact batch so the next slice proceeds', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmBatchProductive', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peer = '12D3KooWExactProductivePeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-productive';
    const connected = [{ toString: () => peer }];
    (internals as any).node = {
      peerId: '12D3KooWExactProductiveLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    let fetchCount = 0;
    (internals as any).syncExactKnowledgeAssetsFromPeer = async () => {
      fetchCount += 1;
      return {
        fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 100,
    });
    const target = {
      ordinal: 0,
      ual: 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7',
      kaId: '7',
      reason: 'no-swm' as const,
    };

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    expect(fetchCount).toBe(1);

    // Progress cleared the cooldown: the trailing hasMore slice fetches now.
    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    expect(fetchCount).toBe(2);
  });

  it('never sends an exact request to a peer the network-admission boundary rejects', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmAdmissionGate', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const rejectedPeer = '12D3KooWExactRejectedPeer';
    const admittedPeer = '12D3KooWExactAdmittedPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-admission';
    const connected = [rejectedPeer, admittedPeer].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWExactAdmissionLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    // The curator hint points at the peer the admission boundary rejects — a
    // hint must never bypass the identity gate.
    (internals as any).preferredSyncPeers.set(localCgId, rejectedPeer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [rejectedPeer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).networkAdmissionCoordinator = {
      isAcceptedPeer: (peerId: string) => peerId === admittedPeer,
      isRejectedPeer: (peerId: string) => peerId === rejectedPeer,
      ensureAdmitted: async () => false,
    };
    const fetches: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeer = async (peerId: string) => {
      fetches.push(peerId);
      return {
        fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 100,
    });
    const target = {
      ordinal: 0,
      ual: 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7',
      kaId: '7',
      reason: 'no-swm' as const,
    };

    const result = await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);

    expect(fetches).toEqual([admittedPeer]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('reports a durable watermark ahead of the chain head without ordinal work', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkAhead', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set('evidence-ahead', {
      subscribed: false,
      coreHosted: true,
      onChainId: '323',
      lastReconciledOrdinal: 5,
    });
    chain.getContextGraphKCCount = async () => 3n;
    const reconcileOrdinal = recorder(async () => {
      throw new Error('watermark-ahead evidence must not enter ordinal reconciliation');
    });
    (internals as any).reconcileChainOrdinal = reconcileOrdinal;

    const result = await internals.runVmReconcileForCg('evidence-ahead', 'manual');

    expect(result).toMatchObject({
      status: 'watermark-ahead',
      attempted: false,
      headOrdinal: 3,
      watermarkBefore: 5,
      watermarkAfter: 5,
    });
    expect(reconcileOrdinal.calls).toEqual([]);
  });

  it('routes periodic, live, and manual work through the unified dispatcher', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillAdmissionPriority', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    internals.subscribedContextGraphs.set('priority-current', {
      subscribed: false,
      coreHosted: true,
      onChainId: '322',
      lastReconciledOrdinal: 0,
    });
    chain.getContextGraphKCCount = async () => 0n;

    const sources: string[] = [];
    (internals as any).vmReconcileDispatcher = {
      dispatch: async (_key: string, source: string) => {
        sources.push(source);
        return {};
      },
    };

    await internals.runVmReconcileForCg('priority-current', 'periodic');
    await internals.runVmReconcileForCg('priority-current', 'live');
    await internals.runVmReconcileForCg('priority-current', 'manual');

    expect(sources).toEqual(['periodic', 'live', 'manual']);
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

  it('surfaces a production chain failure from runVmReconcileForCg to its scheduler', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillFailure', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const failure = new Error('store deadline exceeded');

    internals.subscribedContextGraphs.set('500', {
      subscribed: true,
      onChainId: '500',
    });
    chain.getContextGraphKCCount = async () => {
      throw failure;
    };

    await expect(internals.runVmReconcileForCg('500')).rejects.toBe(failure);
  });
});
