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
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import {
  VmReconcileDispatcher,
  type PendingOrdinalRecoveryResult,
} from '../src/chain-reconciler.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

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
      localCgId: string;
      onChainCgId: string;
      ordinal: number;
      ual: string;
      merkleRoot: string;
      kaId: string;
      reason: 'no-swm' | 'verified-vm-metadata-pending';
    }>,
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
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
  subscribedContextGraphs: Map<string, { subscribed: boolean; syncMode?: 'on-demand' | 'always-on'; coreHosted?: boolean; onChainId?: string; lastReconciledOrdinal?: number }>;
  gossipRegistered: Set<string>;
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

function vmRecoveryTarget(
  localCgId: string,
  ordinal: number,
  kaId = String(ordinal),
) {
  return {
    localCgId,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${kaId}`,
    merkleRoot: `root-${kaId}`,
    kaId,
    reason: 'no-swm' as const,
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
    vi.useFakeTimers();
    try {
      let settled = false;
      const recording = internals.recordCoreHostedPublicCg('44')
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(2_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await recording;

      expect(settled).toBe(true);
      expect(internals.subscribedContextGraphs.get('44')).toBeUndefined();
      expect(saved.find((r) => r.id === '44')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  it('reclaims binding generations when subscription records are deleted', async () => {
    const internals = await boot();
    const generations = (internals as any).contextGraphBindingGenerations as Map<string, number>;

    for (let index = 0; index < 32; index += 1) {
      const localCgId = `deleted-binding-${index}`;
      const subscription = { subscribed: true };
      internals.subscribedContextGraphs.set(localCgId, subscription);
      (internals as any).bindSubscriptionOnChainId(localCgId, subscription, String(index + 1));
      expect((internals as any).deleteContextGraphSubscription(localCgId)).toBe(true);
    }

    expect(generations.size).toBe(0);

    const reusedCgId = 'deleted-binding-reused';
    const oldSubscription = { subscribed: true };
    internals.subscribedContextGraphs.set(reusedCgId, oldSubscription);
    (internals as any).bindSubscriptionOnChainId(reusedCgId, oldSubscription, '100');
    const oldGeneration = (internals as any).captureContextGraphBindingGeneration(reusedCgId);
    (internals as any).deleteContextGraphSubscription(reusedCgId);
    const replacement = { subscribed: true };
    internals.subscribedContextGraphs.set(reusedCgId, replacement);
    (internals as any).bindSubscriptionOnChainId(reusedCgId, replacement, '101');

    expect(
      internals.subscribedContextGraphs.get(reusedCgId) === oldSubscription
      && (internals as any).isContextGraphBindingGenerationCurrent(
        reusedCgId,
        oldGeneration,
      ),
    ).toBe(false);
  });

  it('clears VM reconcile state and promotes durable mode when stale inactive on-chain ids are re-registered', async () => {
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
    // This low-level fixture intentionally has no gossip runtime. Model a
    // valid already-live on-demand member, including the handler-registration
    // invariant that makes subscribeToContextGraph's promotion path idempotent.
    internals.subscribedContextGraphs.set(localCgId, {
      syncMode: 'on-demand', subscribed: true, onChainId: '5', lastReconciledOrdinal: 4,
    });
    internals.gossipRegistered.add(localCgId);
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
    expect(sub?.syncMode).toBe('always-on');
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

  it('clears exact-recovery rotation state on the direct recent-cache terminal path', async () => {
    const internals = await boot();
    const localCgId = '68';
    const onChainCgId = 68n;
    const kaId = 9068n;
    registerUnmatchedKC(internals.chain, kaId, onChainCgId);
    const storageAddress = await internals.chain.getDKGKnowledgeAssetsAddress();
    const ual = buildKnowledgeAssetUal(internals.chain.chainId, storageAddress, kaId);
    const merkleRoot = await internals.chain.getLatestMerkleRoot(kaId);
    const target = {
      localCgId,
      onChainCgId: onChainCgId.toString(),
      ordinal: 0,
      ual,
      merkleRoot: bytesToHex(merkleRoot),
      kaId: kaId.toString(),
      reason: 'no-swm' as const,
    };
    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    (internals as any).prepareVmReconcileRotationTarget(
      target, ['12D3KooWDirectTerminalRecent'], 100,
    );
    ((internals as any).recentReconciledUals as { add(key: string): void }).add(
      (internals as any).vmReconcileCacheKey(localCgId, ual, merkleRoot),
    );
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(true);

    await expect(internals.reconcileChainOrdinal(localCgId, onChainCgId, 0, undefined))
      .resolves.toEqual({ status: 'already', blockNumber: 0 });

    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);
  });

  it.each([
    ['promoted', 'reconciled'],
    ['already-confirmed', 'already'],
    ['stale-target', 'already'],
  ] as const)(
    'clears exact-recovery rotation state on direct %s finalization',
    async (finalizationOutcome, expectedStatus) => {
      const internals = await boot();
      const ordinalByOutcome = {
        promoted: 69,
        'already-confirmed': 70,
        'stale-target': 71,
      } as const;
      const graphOrdinal = ordinalByOutcome[finalizationOutcome];
      const localCgId = String(graphOrdinal);
      const onChainCgId = BigInt(graphOrdinal);
      const kaId = BigInt(9_000 + graphOrdinal);
      registerUnmatchedKC(internals.chain, kaId, onChainCgId);
      const target = {
        ...vmRecoveryTarget(localCgId, 0, kaId.toString()),
        onChainCgId: onChainCgId.toString(),
      };
      const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
      (internals as any).prepareVmReconcileRotationTarget(
        target, [`12D3KooWDirectTerminal${graphOrdinal}`], 100,
      );
      (internals as any).getOrCreateFinalizationHandler = () => ({
        handleChainReconciledKC: async () => finalizationOutcome,
      });
      expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(true);

      await expect(internals.reconcileChainOrdinal(localCgId, onChainCgId, 0, undefined))
        .resolves.toMatchObject({ status: expectedStatus });

      expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);
    },
  );

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
    // W1 §5.5 — `sourceOverride` is attribution only: it changes no peer
    // selection, no rotation and no admission priority, which is why this
    // options object is otherwise unchanged. Pinned as an EXACT literal
    // because "not catchup-background" would also be satisfied by dropping
    // the override entirely and landing on some other excluded source.
    expect(fetch.calls[0]).toEqual(['47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
      sourceOverride: 'vm-recovery',
    }]);
    expect(fetch.calls[1]).toEqual(['47', {
      includeSharedMemory: true,
      maxPeers: 1,
      peerRotationKey: '47',
      sourceOverride: 'vm-recovery',
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

  it('bounds durable negative-cache hydration guards and safely reloads evicted keys', async () => {
    const loads: string[] = [];
    const internals = await boot({
      loadAll: async () => [],
      save: async () => undefined,
      delete: async () => undefined,
      loadVmReconcileNegative: async (cacheKey) => {
        loads.push(cacheKey);
        return undefined;
      },
    });
    const hydrated = (internals as any).vmReconcileNegativeCacheHydrated as Map<string, string>;
    const cap = DKGAgent.VM_RECONCILE_CACHE_MAX_ENTRIES;

    for (let index = 0; index < cap + 2; index += 1) {
      (internals as any).markVmReconcileNegativeCacheHydrated(
        `hydrated-cg\0ual-${index}#root`,
        'hydrated-cg',
      );
    }

    expect(hydrated.size).toBe(cap);
    expect(hydrated.has('hydrated-cg\0ual-0#root')).toBe(false);
    await expect((internals as any).shouldDeferVmReconcileByNegativeCache(
      'hydrated-cg\0ual-0#root',
      'hydrated-cg',
    )).resolves.toBe(false);
    expect(loads).toEqual(['hydrated-cg\0ual-0#root']);
    expect(hydrated.size).toBe(cap);
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
    const rotationState = (internals as any).vmReconcileRotationState as Map<string, unknown>;
    const hydrated = (internals as any).vmReconcileNegativeCacheHydrated as Map<string, string>;
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
    (internals as any).markVmReconcileNegativeCacheHydrated('cleanup-hydrated', 'cleanup-cg');
    fetchCooldown.set('cleanup-cg', now);
    peerCursor.set('cleanup-cg', 7);
    peerOrder.set('cleanup-cg', { orderedPeers: ['peer-a'], nextPeerId: 'peer-a' });
    const cleanupRotationKey = (internals as any).vmReconcileRotationSlotKey(
      vmRecoveryTarget('cleanup-cg', 0),
    );
    rotationState.set(cleanupRotationKey, {});
    recent.add('cleanup-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/1#01');
    (agent as any).unsubscribeFromContextGraph('cleanup-cg');
    expect(negativeCache.has('cleanup-cache')).toBe(false);
    expect(hydrated.has('cleanup-hydrated')).toBe(false);
    expect(fetchCooldown.has('cleanup-cg')).toBe(false);
    expect(peerCursor.has('cleanup-cg')).toBe(false);
    expect(peerOrder.has('cleanup-cg')).toBe(false);
    expect(rotationState.has(cleanupRotationKey)).toBe(false);
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
    (internals as any).markVmReconcileNegativeCacheHydrated('hosted-hydrated', 'hosted-cg');
    fetchCooldown.set('hosted-cg', now);
    peerCursor.set('hosted-cg', 3);
    peerOrder.set('hosted-cg', { orderedPeers: ['peer-b'], nextPeerId: 'peer-b' });
    const hostedRotationKey = (internals as any).vmReconcileRotationSlotKey(
      vmRecoveryTarget('hosted-cg', 0),
    );
    rotationState.set(hostedRotationKey, {});
    recent.add('hosted-cg\0did:dkg:mock:31337/0x000000000000000000000000000000000000c10a/2#02');
    (agent as any).unsubscribeFromContextGraph('hosted-cg');
    expect(negativeCache.has('hosted-cache')).toBe(true);
    expect(hydrated.has('hosted-hydrated')).toBe(true);
    expect(fetchCooldown.has('hosted-cg')).toBe(true);
    expect(peerCursor.has('hosted-cg')).toBe(true);
    expect(peerOrder.has('hosted-cg')).toBe(true);
    expect(rotationState.has(hostedRotationKey)).toBe(false);
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

  async function createExactVmRecoveryHarness(options: {
    name: string;
    localCgId: string;
    peers: string[];
    targetCount: number;
    found: (peerId: string, ordinal: number) => boolean;
  }) {
    const harness = await createVmRecoveryHostHarness({
      ...options,
      targetForOrdinal: (ordinal) => vmRecoveryTarget(
        options.localCgId,
        ordinal,
        String(ordinal),
      ),
      onFetch: (peerId, targets, recovered) => {
        let allFound = true;
        for (const target of targets) {
          if (options.found(peerId, target.ordinal)) recovered.add(target.ordinal);
          else allFound = false;
        }
        return allFound ? 'found' : 'clean-absent';
      },
    });
    return {
      ...harness,
      get fetches(): Array<{ peerId: string; ordinal: number }> {
        return harness.fetched.flatMap(({ peerId, uals }) => uals.map((ual) => ({
          peerId,
          ordinal: Number(ual.split('/').at(-1)),
        })));
      },
    };
  }

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
        attemptedOrdinals: targets.map((target) => target.ordinal),
        continuationOrdinal: undefined,
        hasImmediateRecoveryWork: false,
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
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      peerId: string,
      _cg: string,
      uals: string[],
    ) => {
      fetches.push({ peerId, uals });
      return {
        result: {
          fetchedDataTriples: 1,
          fetchedMetaTriples: 8,
          insertedTriples: 9,
          failedPeers: 0,
          failedPhases: 0,
          deferredBackpressure: 0,
        },
        disposition: 'found',
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
      [{ ...vmRecoveryTarget(localCgId, 0, '7'), ual }],
      100,
      () => true,
    );

    expect(connectionAttempts).toEqual([]);
    expect(protocolPeers[0]?.toString()).toBe(registryPeer);
    expect(fetches).toEqual([{ peerId: registryPeer, uals: [ual] }]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(result.attemptedOrdinals).toEqual([0]);
  });

  it('canonicalizes authoritative curators before the cap and ahead of a stale hint', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCanonicalCurators', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/canonical-curators';
    const staleHint = '12D3KooWCanonicalCuratorHint';
    const curators = [1, 2, 3, 4].map((n) => `12D3KooWCanonicalCurator${n}`);
    const connectedById = new Map(
      [staleHint, ...curators].map((peerId) => [peerId, { toString: () => peerId }]),
    );
    (internals as any).node = {
      peerId: '12D3KooWCanonicalCuratorLocal',
      libp2p: {
        getConnections: () => [...connectedById.values()].map((remotePeer) => ({ remotePeer })),
      },
    };
    (internals as any).preferredSyncPeers.set(localCgId, staleHint);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [curators[3], curators[1], curators[2], curators[0]],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    });
    const connectionAttempts: string[] = [];
    (internals as any).ensurePeerConnected = async (peerId: string) => {
      connectionAttempts.push(peerId);
    };
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const fetches: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetches.push(peerId);
      return {
        result: {
          fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'found',
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });

    await internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, '85')], 100, () => true,
    );

    expect(connectionAttempts).toEqual([]);
    expect(fetches).toEqual([curators[0]]);
    expect((internals as any).vmReconcileCuratorPeersByCg.get(localCgId))
      .toEqual([...curators, staleHint]);
  });

  it('retains four curators and eventually recovers an asset held only by curator four', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmFourthCurator', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/fourth-curator';
    const curators = [1, 2, 3, 4].map((n) => `12D3KooWFourthCurator${n}`);
    const connected = curators.map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWFourthCuratorLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [...curators].reverse(), curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const attempts: string[] = [];
    let lastPeerId: string | undefined;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      attempts.push(peerId);
      lastPeerId = peerId;
      const found = peerId === curators[3];
      return {
        result: {
          fetchedDataTriples: found ? 1 : 0,
          fetchedMetaTriples: found ? 8 : 0,
          insertedTriples: found ? 9 : 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: found ? 'found' : 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, 'fourth-holder');
    (internals as any).reconcileChainOrdinal = async () => (
      lastPeerId === curators[3]
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: target }
    );

    for (let pass = 0; pass < 3; pass += 1) {
      const result = await internals.recoverVmReconcileBatch(
        localCgId, 1n, [target], 100, () => true,
      );
      expect(result.outcomes.get(0)).toMatchObject({ status: 'pending' });
      expect((internals as any).vmReconcileRotationState.get(
        (internals as any).vmReconcileRotationSlotKey(target),
      )).toMatchObject({ phase: 'collecting' });
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    }
    const recovered = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(attempts).toEqual(curators);
    expect(recovered.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect((internals as any).vmReconcileCuratorPeersByCg.get(localCgId)).toEqual(curators);
  });

  it('rotates a bounded oversized-roster transport window without treating it as absence proof', async () => {
    const rosterDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_EXACT_ROSTER_MAX',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_EXACT_ROSTER_MAX', {
      ...rosterDescriptor,
      value: 4,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmRosterOverflow', chainAdapter: chain });
      const internals = agent as unknown as AgentInternals;
      const localCgId = '0x0000000000000000000000000000000000000001/roster-overflow';
      const overflowPeers = Array.from({ length: 5 }, (_, i) => `12D3KooWRosterOverflow${i}`);
      const connectedById = new Map<string, { toString(): string }>();
      (internals as any).node = {
        peerId: '12D3KooWRosterOverflowLocal',
        libp2p: {
          getConnections: () => [...connectedById.values()].map((remotePeer) => ({ remotePeer })),
        },
      };
      let resolutions = 0;
      (internals as any).resolveCuratorPeerIdsForCg = async (
        _cgId: string,
        options: { afterPeerId?: string },
      ) => {
        resolutions += 1;
        const previousIndex = options.afterPeerId
          ? overflowPeers.indexOf(options.afterPeerId)
          : -1;
        const peerId = overflowPeers[(previousIndex + 1) % overflowPeers.length]!;
        return {
          peerIds: [peerId],
          curatorIsLocal: false,
          legacyTripleResolved: false,
          overflowed: true,
          nextPageAfterPeerId: peerId,
        };
      };
      (internals as any).ensurePeerConnected = async (peerId: string) => {
        connectedById.set(peerId, { toString: () => peerId });
      };
      (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
      (internals as any).waitForSyncProtocol = async () => true;
      (internals as any).ensurePeerAdmittedForRecovery = async () => true;
      const fetches: string[] = [];
      const target = vmRecoveryTarget(localCgId, 0, 'roster-overflow');
      const holderPeerId = overflowPeers[4]!;
      let lastPeerId: string | undefined;
      (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
        fetches.push(peerId);
        lastPeerId = peerId;
        const found = peerId === holderPeerId;
        return {
          result: {
            fetchedDataTriples: found ? 1 : 0,
            fetchedMetaTriples: found ? 8 : 0,
            insertedTriples: found ? 9 : 0,
            failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
          },
          disposition: found ? 'found' as const : 'clean-absent' as const,
        };
      };
      (internals as any).reconcileChainOrdinal = async () => (
        lastPeerId === holderPeerId
          ? { status: 'reconciled', blockNumber: 100 }
          : { status: 'pending', recovery: target }
      );

      // Simulate a formerly authoritative prefix cached before the registry
      // grew beyond the proof cap. The current oversized result must replace it
      // with rotating transport windows instead of querying that prefix forever.
      (internals as any).vmReconcileCuratorPeersByCg.set(
        localCgId,
        overflowPeers.slice(0, 4),
      );

      let result;
      for (let pass = 0; pass < 5; pass += 1) {
        result = await internals.recoverVmReconcileBatch(
          localCgId, 1n, [target], 100, () => true,
        );
        if (pass < 4) {
          const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
          expect((internals as any).vmReconcileRotationState.get(slotKey)).toMatchObject({
            phase: 'collecting', curatorRosterConfirmed: false,
          });
          (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
        }
      }

      expect(resolutions).toBe(5);
      expect(fetches).toEqual(overflowPeers);
      expect(result?.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_EXACT_ROSTER_MAX',
        rosterDescriptor,
      );
    }
  });

  it('keeps a successful-empty metadata fallback ahead of the ordinary roster cap', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmFallbackCurator', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/fallback-curator';
    const fallbackPeer = '12D3KooWFallbackCuratorHolder';
    const ordinaryPeers = [1, 2, 3].map((n) => `12D3KooWFallbackOrdinary${n}`);
    const connectedById = new Map(
      ordinaryPeers.map((peerId) => [peerId, { toString: () => peerId }]),
    );
    (internals as any).node = {
      peerId: '12D3KooWFallbackCuratorLocal',
      libp2p: {
        getConnections: () => [...connectedById.values()].map((remotePeer) => ({ remotePeer })),
      },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [], curatorIsLocal: false, legacyTripleResolved: false, lookupFailed: false,
    });
    (internals as any).resolvePreferredSyncPeerId = async () => fallbackPeer;
    (internals as any).ensurePeerConnected = async (peerId: string) => {
      connectedById.set(peerId, { toString: () => peerId });
    };
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const fetches: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetches.push(peerId);
      return {
        result: {
          fetchedDataTriples: peerId === fallbackPeer ? 1 : 0,
          fetchedMetaTriples: peerId === fallbackPeer ? 8 : 0,
          insertedTriples: peerId === fallbackPeer ? 9 : 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: peerId === fallbackPeer ? 'found' : 'clean-absent',
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });

    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, 'fallback')], 100, () => true,
    );

    expect(fetches).toEqual([fallbackPeer]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect((internals as any).vmReconcileCuratorPeersByCg.get(localCgId))
      .toEqual([fallbackPeer]);
  });

  it('clears cached authoritative curators after a successful empty resolution', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmClearCuratorCache', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/clear-curators';
    const stalePeer = '12D3KooWClearCuratorStale';
    const connectedPeer = { toString: () => stalePeer };
    (internals as any).node = {
      peerId: '12D3KooWClearCuratorLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).vmReconcileCuratorPeersByCg.set(localCgId, [stalePeer]);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [], curatorIsLocal: false, legacyTripleResolved: false, lookupFailed: false,
    });
    (internals as any).resolvePreferredSyncPeerId = async () => undefined;
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = () => [connectedPeer];
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async () => ({
      result: {
        fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      },
      disposition: 'found',
    });
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });

    await internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, '86')], 100, () => true,
    );

    expect((internals as any).vmReconcileCuratorPeersByCg.has(localCgId)).toBe(false);
  });

  it('retains cached authoritative curators when curator discovery fails', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRetainCuratorCache', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/retain-curators';
    const cachedPeer = '12D3KooWRetainCuratorCached';
    const connectedPeer = { toString: () => cachedPeer };
    (internals as any).node = {
      peerId: '12D3KooWRetainCuratorLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).vmReconcileCuratorPeersByCg.set(localCgId, [cachedPeer]);
    (internals as any).discovery.findAgents = async () => {
      throw new Error('agent registry unavailable');
    };
    (internals as any).refreshMetaFromCurator = async () => false;
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = () => [connectedPeer];
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const fetches: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetches.push(peerId);
      return {
        result: {
          fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'found',
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });

    await internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, '87')], 100, () => true,
    );

    expect(fetches).toEqual([cachedPeer]);
    expect((internals as any).vmReconcileCuratorPeersByCg.get(localCgId))
      .toEqual([cachedPeer]);
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
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      peerId: string,
      _cg: string,
      uals: string[],
    ) => {
      fetches.push({ peerId, uals });
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
      };
    };
    const revalidated: number[] = [];
    (internals as any).reconcileChainOrdinal = async (
      _lcg: string, _ocg: bigint, ordinal: number,
    ) => {
      revalidated.push(ordinal);
      if (ordinal === 0) {
        return {
          status: 'pending',
          recovery: targets[0],
        };
      }
      return { status: 'reconciled', blockNumber: 100 };
    };
    const targets = Array.from({ length: 4 }, (_, ordinal) =>
      vmRecoveryTarget(localCgId, ordinal));

    const result = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);

    // Every peer attempt gives one potentially frame-sized KA the full
    // foreground budget. A pending target rotates behind untouched work, so
    // the second peer reaches ordinal 1 and the untouched tail leads the next
    // eligible sweep.
    expect(fetches).toHaveLength(2);
    expect(fetches[0]!.uals).toEqual([targets[0]!.ual]);
    expect(fetches[1]!.uals).toEqual([targets[1]!.ual]);
    // Revalidation runs only for requested targets, in request order.
    expect(revalidated).toEqual([targets[0]!.ordinal, targets[1]!.ordinal]);
    expect(result.outcomes.size).toBe(2);
    expect(result.attemptedOrdinals).toEqual([0, 1]);
    expect(result.continuationOrdinal).toBe(2);
  });

  it('rotates after spending one proven-holder reuse in the recovery slice', async () => {
    const holder = '12D3KooWExactProvenAHolder';
    const fallback = '12D3KooWExactProvenZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/proven-holder';
    const harness = await createExactVmRecoveryHarness({
      name: 'ExactVmProvenHolderBurst',
      localCgId,
      peers: [holder, fallback],
      targetCount: 4,
      found: () => true,
    });
    agent = harness.agent;
    const result = await harness.run();

    expect(harness.fetches).toEqual([
      { peerId: holder, ordinal: 0 },
      { peerId: holder, ordinal: 1 },
      { peerId: fallback, ordinal: 2 },
      { peerId: fallback, ordinal: 3 },
    ]);
    expect(harness.maxActiveFetches()).toBe(1);
    expect(result.attemptedOrdinals).toEqual(
      harness.targets.map((target) => target.ordinal),
    );
    expect([...result.outcomes.values()]).toEqual(
      harness.targets.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
    expect(result.continuationOrdinal).toBeUndefined();
  });

  it('stops reusing a proven holder after a clean absence', async () => {
    const holder = '12D3KooWExactRevocationAHolder';
    const fallback = '12D3KooWExactRevocationZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/revoke-holder';
    const harness = await createExactVmRecoveryHarness({
      name: 'ExactVmProvenHolderRevocation',
      localCgId,
      peers: [holder, fallback],
      targetCount: 3,
      found: (peerId, ordinal) => (peerId === holder && ordinal === 0)
        || (peerId === fallback && ordinal === 2),
    });
    agent = harness.agent;
    const result = await harness.run();

    expect(harness.fetches).toEqual([
      { peerId: holder, ordinal: 0 },
      { peerId: holder, ordinal: 1 },
      { peerId: fallback, ordinal: 2 },
    ]);
    expect(result.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(result.outcomes.get(1)?.status).toBe('pending');
    expect(result.outcomes.get(2)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(result.continuationOrdinal).toBeUndefined();
  });

  it('spreads unavailable-peer probes across targets within the global peer budget', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmUnavailableFairness', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peers = [1, 2, 3, 4].map((n) => `12D3KooWUnavailableFairness${n}`);
    const localCgId = '0x0000000000000000000000000000000000000001/unavailable-fairness';
    (internals as any).node = {
      peerId: '12D3KooWUnavailableFairnessLocal',
      libp2p: { getConnections: () => [] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: peers, curatorIsLocal: false, legacyTripleResolved: false,
    });
    const connectionAttempts: string[] = [];
    (internals as any).ensurePeerConnected = async (peerId: string) => {
      connectionAttempts.push(peerId);
    };
    (internals as any).selectCatchupPeers = (candidates: Array<{ toString(): string }>) => candidates;
    const protocolWaits: string[] = [];
    (internals as any).waitForSyncProtocol = async (peerId: string) => {
      protocolWaits.push(peerId);
      return false;
    };
    const fetch = vi.fn();
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    const targets = Array.from({ length: 4 }, (_, ordinal) =>
      vmRecoveryTarget(localCgId, ordinal, `unavailable-${ordinal}`));

    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, targets, 100, () => true,
    );

    expect(connectionAttempts).toEqual(peers.slice(0, 3));
    // The dial stub deliberately leaves each peer disconnected, so protocol
    // probing is skipped after each failed connection boundary.
    expect(protocolWaits).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(result.continuationOrdinal).toBe(3);
  });

  it('continues immediately while pending targets still have untried providers', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmBatchCooldown', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWExactCooldownPeerA';
    const peerB = '12D3KooWExactCooldownPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-cooldown';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWExactCooldownLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA, peerB], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    const fetchedUals: string[][] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      _peerId: string,
      _cgId: string,
      uals: string[],
    ) => {
      fetchedUals.push(uals);
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 1, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '7');
    const deferredTarget = vmRecoveryTarget(localCgId, 1, '8');
    (internals as any).reconcileChainOrdinal = async (
      _lcg: string,
      _ocg: bigint,
      ordinal: number,
    ) => ({
      status: 'pending',
      recovery: ordinal === target.ordinal ? target : deferredTarget,
    });

    const targets = [target, deferredTarget];
    const first = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);
    expect(fetchedUals).toEqual([[target.ual], [deferredTarget.ual]]);
    expect(first.outcomes.get(0)).toMatchObject({ status: 'pending' });
    expect(first.outcomes.get(1)).toMatchObject({ status: 'pending' });
    expect(first.attemptedOrdinals).toEqual([0, 1]);
    expect(first.continuationOrdinal).toBeUndefined();
    expect(first.hasImmediateRecoveryWork).toBe(true);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(false);

    // Both targets retain one untried provider. The next bounded pass rotates
    // to those providers immediately instead of sleeping for the 60s sweep.
    const second = await internals.recoverVmReconcileBatch(localCgId, 1n, targets, 100, () => true);
    expect(fetchedUals).toEqual([
      [target.ual],
      [deferredTarget.ual],
      [target.ual],
      [deferredTarget.ual],
    ]);
    expect(second.attemptedOrdinals).toEqual([0, 1]);
    expect(second.continuationOrdinal).toBeUndefined();
    expect(second.hasImmediateRecoveryWork).toBe(false);
    expect(second.cooldownOnly).toBe(false);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(true);
  });

  it('suppresses completed incomplete cycles after every pending target receives an attempt', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmBatchWrap', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;
    const peer = '12D3KooWExactWrapPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-wrap';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWExactWrapLocalPeer',
      libp2p: {
        getConnections: () => [{ remotePeer: connectedPeer }],
      },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = () => [connectedPeer];
    (internals as any).waitForSyncProtocol = async () => true;
    const networkAttempts: number[] = [];
    const targets = [0, 1].map((ordinal) => vmRecoveryTarget(localCgId, ordinal));
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      _peerId: string,
      _cgId: string,
      uals: string[],
    ) => {
      networkAttempts.push(Number(uals[0]!.split('/').at(-1)));
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 1, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
      };
    };
    (internals as any).reconcileChainOrdinal = async (
      _lcg: string,
      _ocg: bigint,
      ordinal: number,
    ) => ({
      status: 'pending',
      recovery: targets[ordinal],
    });

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, targets, 100, () => true,
    );
    expect(first.attemptedOrdinals).toEqual([0]);
    expect(first.continuationOrdinal).toBe(1);

    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const second = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [targets[1]!], 100, () => true,
    );
    expect(second.attemptedOrdinals).toEqual([1]);
    expect(second.continuationOrdinal).toBeUndefined();

    const rotationState = (internals as any).vmReconcileRotationState as Map<string, unknown>;
    expect(rotationState.size).toBe(2);
    for (const target of targets) {
      expect(rotationState.get(
        (internals as any).vmReconcileRotationSlotKey(target),
      )).toMatchObject({ phase: 'backoff', backoffKind: 'incomplete-cycle' });
    }
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const wrapped = await internals.recoverVmReconcileBatch(
      localCgId, 1n, targets, 100, () => true,
    );
    expect(wrapped.attemptedOrdinals).toEqual([]);
    expect(networkAttempts).toEqual([0, 1]);
  });

  it('rotates one pending recovery target across eligible peers between windows', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmPeerRotation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWExactRotationPeerA';
    const peerB = '12D3KooWExactRotationPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-peer-rotation';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWExactRotationLocalPeer',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (
      peers: Array<{ toString(): string }>,
    ) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const networkAttempts: string[] = [];
    let lastPeerId: string | undefined;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      networkAttempts.push(peerId);
      lastPeerId = peerId;
      return {
        result: {
          fetchedDataTriples: peerId === peerB ? 1 : 0,
          fetchedMetaTriples: peerId === peerB ? 8 : 0,
          insertedTriples: peerId === peerB ? 9 : 0,
          failedPeers: 0,
          failedPhases: 0,
          deferredBackpressure: 0,
        },
        disposition: peerId === peerB ? 'found' : 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '7');
    (internals as any).reconcileChainOrdinal = async () => (
      lastPeerId === peerB
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: target }
    );

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(first.outcomes.get(0)).toMatchObject({ status: 'pending' });
    expect(first.continuationOrdinal).toBeUndefined();
    expect(first.hasImmediateRecoveryWork).toBe(true);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(false);

    const second = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(networkAttempts).toEqual([peerA, peerB]);
    expect(second.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('keeps immediate recovery runnable after a provider fails before revalidation', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmProtocolRotation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWProtocolRotationPeerA';
    const peerB = '12D3KooWProtocolRotationPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/protocol-rotation';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWProtocolRotationLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA, peerB], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    const protocolAttempts: string[] = [];
    (internals as any).waitForSyncProtocol = async (peer: { toString(): string }) => {
      const peerId = peer.toString();
      protocolAttempts.push(peerId);
      return peerId === peerB;
    };
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const fetchAttempts: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetchAttempts.push(peerId);
      return {
        result: {
          fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'found',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '7');
    (internals as any).reconcileChainOrdinal = async () => (
      fetchAttempts.length > 0
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: target }
    );

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(first.outcomes.size).toBe(0);
    expect(first.hasImmediateRecoveryWork).toBe(true);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(false);

    const second = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(protocolAttempts).toEqual([peerA, peerB]);
    expect(fetchAttempts).toEqual([peerB]);
    expect(second.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('rotates incomplete, thrown, and still-pending found attempts without absence credit', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmIncompleteRotation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;
    const peerA = '12D3KooWIncompleteRotationPeerA';
    const peerB = '12D3KooWIncompleteRotationPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/incomplete-rotation';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWIncompleteRotationLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const attemptsByUal = new Map<string, string[]>();
    let lastDisposition: 'found' | 'incomplete' = 'incomplete';
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      peerId: string,
      _cgId: string,
      requestedUals: string[],
    ) => {
      const ual = requestedUals[0]!;
      const attempts = attemptsByUal.get(ual) ?? [];
      attempts.push(peerId);
      attemptsByUal.set(ual, attempts);
      if (ual.endsWith('/77') && peerId === peerB) {
        lastDisposition = 'incomplete';
        throw new Error('transport failed');
      }
      lastDisposition = (ual.endsWith('/76') && peerId === peerB)
        || (ual.endsWith('/77') && peerId === peerA)
        ? 'found'
        : 'incomplete';
      return {
        result: {
          fetchedDataTriples: lastDisposition === 'found' ? 1 : 0,
          fetchedMetaTriples: lastDisposition === 'found' ? 8 : 0,
          insertedTriples: lastDisposition === 'found' ? 9 : 0,
          failedPeers: 0, failedPhases: lastDisposition === 'incomplete' ? 1 : 0,
          deferredBackpressure: 0,
        },
        disposition: lastDisposition,
      };
    };
    let activeTarget = vmRecoveryTarget(localCgId, 0, '76');
    (internals as any).reconcileChainOrdinal = async () => (
      activeTarget.ual.endsWith('/76') && lastDisposition === 'found'
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: activeTarget }
    );

    await internals.recoverVmReconcileBatch(localCgId, 1n, [activeTarget], 100, () => true);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const recovered = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [activeTarget], 100, () => true,
    );
    expect(attemptsByUal.get(activeTarget.ual)).toEqual([peerA, peerB]);
    expect(recovered.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });

    activeTarget = vmRecoveryTarget(localCgId, 1, '77');
    lastDisposition = 'incomplete';
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [activeTarget], 100, () => true);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [activeTarget], 100, () => true);
    expect(attemptsByUal.get(activeTarget.ual)).toEqual([peerA, peerB]);
    const slotKey = (internals as any).vmReconcileRotationSlotKey(activeTarget);
    const incompleteBackoff = (internals as any).vmReconcileRotationState.get(slotKey);
    expect(incompleteBackoff).toMatchObject({
      phase: 'backoff', backoffKind: 'incomplete-cycle', failures: 1,
    });
    expect([...incompleteBackoff.cleanAbsentPeerIds]).toEqual([]);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(true);

    now = incompleteBackoff.nextRetryAt + 1;
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const retried = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [activeTarget], 100, () => true,
    );
    expect(attemptsByUal.get(activeTarget.ual)).toEqual([peerA, peerB, peerA]);
    expect(retried.outcomes.get(1)).toMatchObject({ status: 'pending' });
    expect((internals as any).vmReconcileRotationState.get(slotKey)).toMatchObject({
      phase: 'collecting', failures: 1,
    });

    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [activeTarget], 100, () => true);
    expect(attemptsByUal.get(activeTarget.ual)).toEqual([peerA, peerB, peerA, peerB]);
    expect((internals as any).vmReconcileRotationState.get(slotKey)).toMatchObject({
      phase: 'backoff', backoffKind: 'incomplete-cycle', failures: 2,
    });
  });

  it('backs off only after a complete clean-absence rotation and requires a fresh next cycle', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCleanAbsenceBackoff', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWCleanAbsentPeerA';
    const peerB = '12D3KooWCleanAbsentPeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/clean-absence';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWCleanAbsentLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    let curatorResolutions = 0;
    (internals as any).resolveCuratorPeerIdsForCg = async () => {
      curatorResolutions += 1;
      return { peerIds: [peerA], curatorIsLocal: false, legacyTripleResolved: false };
    };
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;
    const networkAttempts: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      networkAttempts.push(peerId);
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '71');
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending',
      recovery: target,
    });

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);

    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    const firstBackoff = (internals as any).vmReconcileRotationState.get(slotKey);
    expect(networkAttempts).toEqual([peerA, peerB]);
    expect(firstBackoff).toMatchObject({ phase: 'backoff', failures: 1 });

    const suppressed = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(suppressed.attemptedOrdinals).toEqual([]);
    expect(curatorResolutions).toBe(2);

    now = firstBackoff.nextRetryAt + 1;
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    const freshPartial = (internals as any).vmReconcileRotationState.get(slotKey);
    expect(networkAttempts).toEqual([peerA, peerB, peerA]);
    expect(freshPartial).toMatchObject({ phase: 'collecting', failures: 1 });
    expect([...freshPartial.cleanAbsentPeerIds]).toEqual([peerA]);

    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    expect(networkAttempts).toEqual([peerA, peerB, peerA, peerB]);
    expect((internals as any).vmReconcileRotationState.get(slotKey))
      .toMatchObject({ phase: 'backoff', failures: 2 });
  });

  it('backs off a scheduling-exhausted cycle when one peer is rejected and one is incomplete', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmSchedulingExhaustion', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const rejectedPeer = '12D3KooWSchedulingRejected';
    const incompletePeer = '12D3KooWSchedulingIncomplete';
    const localCgId = '0x0000000000000000000000000000000000000001/scheduling-exhaustion';
    const connected = [rejectedPeer, incompletePeer]
      .map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWSchedulingLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, rejectedPeer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [rejectedPeer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async (peerId: string) =>
      peerId !== rejectedPeer;
    const networkAttempts: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      networkAttempts.push(peerId);
      return {
        result: {
          fetchedDataTriples: 50_000, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, 'scheduling');
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending', recovery: target,
    });

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(first.attemptedOrdinals).toEqual([0]);
    expect(networkAttempts).toEqual([]);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    expect(networkAttempts).toEqual([incompletePeer]);
    expect(result.attemptedOrdinals).toEqual([0]);
    const incompleteBackoff = (internals as any).vmReconcileRotationState.get(slotKey);
    expect(incompleteBackoff).toMatchObject({
      phase: 'backoff', backoffKind: 'incomplete-cycle', failures: 1,
    });
    expect([...incompleteBackoff.attemptedPeerIds])
      .toEqual([rejectedPeer, incompletePeer]);
    expect([...incompleteBackoff.cleanAbsentPeerIds]).toEqual([]);
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(true);

    const damped = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(damped.cooldownOnly).toBe(false);
    expect(networkAttempts).toEqual([incompletePeer]);
  });

  it('retains max-batch proof progress while each slot continues making progress', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRollingCollectionDeadline', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const peers = ['12D3KooWRollingA', '12D3KooWRollingB', '12D3KooWRollingC'];
    const targets = Array.from({ length: DKGAgent.VM_RECONCILE_BATCH_SIZE }, (_, ordinal) =>
      vmRecoveryTarget('rolling-collection-deadline', ordinal, `rolling-${ordinal}`));
    let now = 0;
    (internals as any).vmReconcileRotationNow = () => now;

    for (const peerId of peers) {
      for (const target of targets) {
        now += 25_000;
        const prepared = (internals as any).prepareVmReconcileRotationTarget(
          target, peers, now,
        );
        expect(prepared.suppressed).toBe(false);
        expect(prepared.record).toBeDefined();
        (internals as any).settleVmReconcileRotationAttempt(
          target, peerId, 'clean-absent', peers, prepared.record,
        );
      }
    }

    expect(now).toBeGreaterThan(DKGAgent.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS);
    for (const target of targets) {
      expect((internals as any).vmReconcileRotationState.get(
        (internals as any).vmReconcileRotationSlotKey(target),
      )).toMatchObject({ phase: 'backoff', failures: 1 });
    }
  });

  it('keeps the pre-suppression roster stable across connection reorder and curator discovery', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCanonicalRoster', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWCanonicalRosterA';
    const peerB = '12D3KooWCanonicalRosterB';
    const peerC = '12D3KooWCanonicalRosterC';
    const peerD = '12D3KooWCanonicalRosterD';
    const localCgId = '0x0000000000000000000000000000000000000001/canonical-roster';
    const peerById = new Map(
      [peerA, peerB, peerC, peerD].map((peerId) => [peerId, { toString: () => peerId }]),
    );
    let connectionRead = 0;
    (internals as any).node = {
      peerId: '12D3KooWCanonicalRosterLocal',
      libp2p: {
        getConnections: () => {
          connectionRead += 1;
          const ids = connectionRead % 2 === 0
            ? [peerD, peerC, peerB, peerA]
            : [peerB, peerD, peerA, peerC];
          return ids.map((peerId) => ({ remotePeer: peerById.get(peerId)! }));
        },
      },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    let curatorResolutions = 0;
    (internals as any).resolveCuratorPeerIdsForCg = async () => {
      curatorResolutions += 1;
      return {
        // The secondary curator would displace C if this list were prepended to
        // the post-discovery roster instead of using the canonicalizer.
        peerIds: [peerA, peerD],
        curatorIsLocal: false,
        legacyTripleResolved: false,
      };
    };
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const networkAttempts: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      networkAttempts.push(peerId);
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '75');
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending', recovery: target,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    }
    expect(networkAttempts).toEqual([peerA, peerD, peerB]);
    expect(curatorResolutions).toBe(3);

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    expect(networkAttempts).toEqual([peerA, peerD, peerB, peerC]);
    expect(curatorResolutions).toBe(4);
    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    expect((internals as any).vmReconcileRotationState.get(slotKey)).toMatchObject({
      phase: 'backoff', backoffKind: 'clean-absence', failures: 1,
    });

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    expect(networkAttempts).toEqual([peerA, peerD, peerB, peerC]);
    expect(curatorResolutions).toBe(4);
  });

  it('ranks a resolved structural curator ahead of an ordinary capped roster', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmResolvedCuratorRoster', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peers = [
      '12D3KooWResolvedCuratorA',
      '12D3KooWResolvedCuratorB',
      '12D3KooWResolvedCuratorC',
      '12D3KooWResolvedCuratorD',
    ];
    const curatorPeerId = peers[3]!;
    const localCgId = '0x0000000000000000000000000000000000000001/resolved-curator';
    const connected = peers.map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWResolvedCuratorLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [curatorPeerId], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (ordered: Array<{ toString(): string }>) => ordered;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const attempts: string[] = [];
    let lastPeerId: string | undefined;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      attempts.push(peerId);
      lastPeerId = peerId;
      return {
        result: {
          fetchedDataTriples: peerId === curatorPeerId ? 1 : 0,
          fetchedMetaTriples: peerId === curatorPeerId ? 8 : 0,
          insertedTriples: peerId === curatorPeerId ? 9 : 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: peerId === curatorPeerId ? 'found' : 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '80');
    (internals as any).reconcileChainOrdinal = async () => (
      lastPeerId === curatorPeerId
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: target }
    );

    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(attempts).toEqual([curatorPeerId]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('completion-anchors the per-CG retry damper after a legacy incomplete rotation', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmPartialCycleExpiry', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWPartialCyclePeerA';
    const peerB = '12D3KooWPartialCyclePeerB';
    const localCgId = '0x0000000000000000000000000000000000000001/partial-cycle';
    const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
    (internals as any).node = {
      peerId: '12D3KooWPartialCycleLocal',
      libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peerA);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerA], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;
    const networkAttempts: string[] = [];
    let peerAFetches = 0;
    let lastDisposition: 'found' | 'clean-absent' | 'incomplete' = 'incomplete';
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      networkAttempts.push(peerId);
      if (peerId === peerA) peerAFetches += 1;
      lastDisposition = peerId === peerA && peerAFetches > 1
        ? 'found'
        : peerId === peerA
          ? 'clean-absent'
          : 'incomplete';
      return {
        result: {
          fetchedDataTriples: lastDisposition === 'found'
            ? 1
            : lastDisposition === 'incomplete'
              ? 50_000
              : 0,
          fetchedMetaTriples: lastDisposition === 'found' ? 8 : 0,
          insertedTriples: lastDisposition === 'found' ? 9 : 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: lastDisposition,
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '74');
    (internals as any).reconcileChainOrdinal = async () => (
      lastDisposition === 'found'
        ? { status: 'reconciled', blockNumber: 100 }
        : { status: 'pending', recovery: target }
    );

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);

    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    expect(networkAttempts).toEqual([peerA, peerB]);
    const incompleteBackoff = (internals as any).vmReconcileRotationState.get(slotKey);
    expect(incompleteBackoff).toMatchObject({
      phase: 'backoff', backoffKind: 'incomplete-cycle', failures: 1,
    });
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(true);

    const damped = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(networkAttempts).toEqual([peerA, peerB]);
    expect(damped.cooldownOnly).toBe(false);

    now = incompleteBackoff.nextRetryAt + 1;
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const recovered = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(networkAttempts).toEqual([peerA, peerB, peerA]);
    expect(recovered.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);
  });

  it('defers cap overflow until an expired slot can be replaced without retry churn', async () => {
    const capDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_CACHE_MAX_ENTRIES',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
      ...capDescriptor,
      value: 1,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmStableRotationCapacity', chainAdapter: chain });
      const internals = agent as unknown as AgentInternals;
      const peerA = '12D3KooWStableCapacityPeerA';
      const peerB = '12D3KooWStableCapacityPeerB';
      const localCgId = '0x0000000000000000000000000000000000000001/stable-capacity';
      const connected = [peerA, peerB].map((peerId) => ({ toString: () => peerId }));
      (internals as any).node = {
        peerId: '12D3KooWStableCapacityLocal',
        libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
      };
      (internals as any).preferredSyncPeers.set(localCgId, peerA);
      let curatorResolutions = 0;
      (internals as any).resolveCuratorPeerIdsForCg = async () => {
        curatorResolutions += 1;
        return { peerIds: [peerA], curatorIsLocal: false, legacyTripleResolved: false };
      };
      (internals as any).ensurePeerConnected = async () => undefined;
      (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
      (internals as any).waitForSyncProtocol = async () => true;
      (internals as any).ensurePeerAdmittedForRecovery = async () => true;
      const attemptsByUal = new Map<string, string[]>();
      (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
        peerId: string,
        _cgId: string,
        requestedUals: string[],
      ) => {
        const ual = requestedUals[0]!;
        const attempts = attemptsByUal.get(ual) ?? [];
        attempts.push(peerId);
        attemptsByUal.set(ual, attempts);
        return {
          result: {
            fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
            failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
          },
          disposition: 'clean-absent',
        };
      };
      const first = vmRecoveryTarget(localCgId, 0, '78');
      const overflow = vmRecoveryTarget(localCgId, 1, '79');
      const secondOverflow = vmRecoveryTarget(localCgId, 2, '80');
      const targets = [first, overflow, secondOverflow];
      const byOrdinal = new Map(targets.map((target) => [target.ordinal, target]));
      (internals as any).reconcileChainOrdinal = async (
        _lcg: string,
        _ocg: bigint,
        ordinal: number,
      ) => ({ status: 'pending', recovery: byOrdinal.get(ordinal)! });
      const rotationState = (internals as any).vmReconcileRotationState as Map<
        string,
        { phase: string; cleanAbsentPeerIds: Set<string> }
      >;
      const firstKey = (internals as any).vmReconcileRotationSlotKey(first);
      const overflowKey = (internals as any).vmReconcileRotationSlotKey(overflow);
      const secondOverflowKey = (internals as any).vmReconcileRotationSlotKey(secondOverflow);

      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      expect(rotationState.size).toBe(1);
      expect(rotationState.get(firstKey)).toMatchObject({ phase: 'collecting' });
      expect([...rotationState.get(firstKey)!.cleanAbsentPeerIds]).toEqual([peerA]);
      expect(attemptsByUal.get(first.ual)).toEqual([peerA]);
      expect(attemptsByUal.get(overflow.ual)).toBeUndefined();
      expect(attemptsByUal.get(secondOverflow.ual)).toBeUndefined();

      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      expect(rotationState.size).toBe(1);
      expect(rotationState.get(firstKey)).toMatchObject({ phase: 'backoff' });
      expect(attemptsByUal.get(first.ual)).toEqual([peerA, peerB]);
      expect(attemptsByUal.get(overflow.ual)).toBeUndefined();

      // A batch containing only an unowned target can be rejected from the
      // live capacity state without paying curator discovery or transport.
      const resolutionsBeforeCapacityDeferral = curatorResolutions;
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, [overflow], 100, () => true,
      );
      expect(curatorResolutions).toBe(resolutionsBeforeCapacityDeferral);
      expect(attemptsByUal.get(overflow.ual)).toBeUndefined();

      // An unexpired backoff remains installed and the overflow target performs
      // no evidence-free exact request.
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      expect(rotationState.size).toBe(1);
      expect(rotationState.get(firstKey)).toMatchObject({ phase: 'backoff' });
      expect(rotationState.has(overflowKey)).toBe(false);
      expect(attemptsByUal.get(first.ual)).toEqual([peerA, peerB]);
      expect(attemptsByUal.get(overflow.ual)).toBeUndefined();

      const firstBackoff = rotationState.get(firstKey) as any;
      (internals as any).vmReconcileRotationNow = () => firstBackoff.nextRetryAt + 1;
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      expect(rotationState.size).toBe(1);
      expect(rotationState.has(firstKey)).toBe(false);
      expect(rotationState.get(overflowKey)).toMatchObject({ phase: 'collecting' });
      expect(attemptsByUal.get(overflow.ual)).toEqual([peerA]);

      // Complete B's roster, expire it, and prove the third stable-order waiter
      // receives the next slot instead of A/B alternating forever.
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      const overflowBackoff = rotationState.get(overflowKey) as any;
      expect(overflowBackoff).toMatchObject({ phase: 'backoff' });
      expect(attemptsByUal.get(overflow.ual)).toEqual([peerA, peerB]);

      (internals as any).vmReconcileRotationNow = () => overflowBackoff.nextRetryAt + 1;
      (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
      await internals.recoverVmReconcileBatch(
        localCgId, 1n, targets, 100, () => true,
      );
      expect(rotationState.size).toBe(1);
      expect(rotationState.has(overflowKey)).toBe(false);
      expect(rotationState.get(secondOverflowKey)).toMatchObject({ phase: 'collecting' });
      expect(attemptsByUal.get(secondOverflow.ual)).toEqual([peerA]);
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_CACHE_MAX_ENTRIES',
        capDescriptor,
      );
    }
  });

  it('reserves a live rotation slot for an unrelated CG at the node-wide cache cap', async () => {
    const capDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_CACHE_MAX_ENTRIES',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
      ...capDescriptor,
      value: 3,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmCrossCgCapacity', chainAdapter: chain });
      stubNode(agent);
      const internals = agent as unknown as AgentInternals;
      const peer = '12D3KooWCrossCgCapacityPeer';
      const dominantCg = '0x0000000000000000000000000000000000000001/dominant-capacity';
      const waitingCg = '0x0000000000000000000000000000000000000002/waiting-capacity';
      const dominantTargets = [0, 1, 2]
        .map((ordinal) => vmRecoveryTarget(dominantCg, ordinal, `dominant-${ordinal}`));
      for (const target of dominantTargets) {
        expect((internals as any).prepareVmReconcileRotationTarget(
          target,
          [peer],
          100,
        ).suppressed).toBe(false);
      }
      const state = (internals as any).vmReconcileRotationState as Map<
        string,
        { localCgId: string }
      >;
      expect(state.size).toBe(3);
      expect([...state.values()].filter((record) => record.localCgId === dominantCg)).toHaveLength(3);

      const waiting = vmRecoveryTarget(waitingCg, 0, 'waiting');
      const admitted = (internals as any).prepareVmReconcileRotationTarget(
        waiting,
        [peer],
        100,
      );

      expect(admitted.suppressed).toBe(false);
      expect(admitted.record?.localCgId).toBe(waitingCg);
      expect(state.size).toBe(3);
      expect([...state.values()].filter((record) => record.localCgId === dominantCg)).toHaveLength(2);
      expect([...state.values()].filter((record) => record.localCgId === waitingCg)).toHaveLength(1);
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_CACHE_MAX_ENTRIES',
        capDescriptor,
      );
    }
  });

  it('does not evict a cross-CG donor when recovery exits before requester installation', async () => {
    const capDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_CACHE_MAX_ENTRIES',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
      ...capDescriptor,
      value: 3,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmDonationRollback', chainAdapter: chain });
      stubNode(agent);
      const internals = agent as unknown as AgentInternals;
      const peer = '12D3KooWDonationRollbackPeer';
      const dominantCg = '0x0000000000000000000000000000000000000001/donation-owner';
      const waitingCg = '0x0000000000000000000000000000000000000002/donation-waiter';
      (internals as any).vmReconcileRotationNow = () => 100;
      for (let ordinal = 0; ordinal < 3; ordinal += 1) {
        const target = vmRecoveryTarget(dominantCg, ordinal, `donor-${ordinal}`);
        expect((internals as any).prepareVmReconcileRotationTarget(
          target,
          [peer],
          100,
        ).record).toBeDefined();
      }
      const state = (internals as any).vmReconcileRotationState as Map<string, unknown>;
      const before = [...state.entries()];
      (internals as any).vmReconcileCuratorPeersByCg.set(waitingCg, [peer]);
      let current = true;
      (internals as any).resolveCuratorPeerIdsForCg = async () => {
        current = false;
        return {
          peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
        };
      };
      const waiting = vmRecoveryTarget(waitingCg, 0, 'waiting');

      await internals.recoverVmReconcileBatch(
        waitingCg,
        1n,
        [waiting],
        100,
        () => current,
      );

      expect([...state.entries()]).toEqual(before);
      expect(state.has((internals as any).vmReconcileRotationSlotKey(waiting))).toBe(false);
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_CACHE_MAX_ENTRIES',
        capDescriptor,
      );
    }
  });

  it('retains an incomplete-cycle backoff until expiry, then releases its state slot', async () => {
    const capDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_CACHE_MAX_ENTRIES',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
      ...capDescriptor,
      value: 1,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmNoProgressCapacity', chainAdapter: chain });
      stubNode(agent);
      const internals = agent as unknown as AgentInternals;
      const peer = '12D3KooWNoProgressCapacityPeer';
      const first = vmRecoveryTarget('no-progress-capacity', 0, 'first');
      const second = vmRecoveryTarget('no-progress-capacity', 1, 'second');
      const firstKey = (internals as any).vmReconcileRotationSlotKey(first);
      const secondKey = (internals as any).vmReconcileRotationSlotKey(second);
      let now = 100;
      (internals as any).vmReconcileRotationNow = () => now;
      const firstRecord = (internals as any).prepareVmReconcileRotationTarget(
        first, [peer], now,
      ).record;

      (internals as any).settleVmReconcileRotationAttempt(
        first, peer, 'incomplete', [peer], firstRecord,
      );
      expect((internals as any).vmReconcileRotationState.get(firstKey)).toMatchObject({
        phase: 'backoff', backoffKind: 'incomplete-cycle', failures: 1,
      });

      const secondRecord = (internals as any).prepareVmReconcileRotationTarget(
        second, [peer], now + 1,
      ).record;
      expect(secondRecord).toBeUndefined();
      expect((internals as any).vmReconcileRotationState.has(firstKey)).toBe(true);
      expect((internals as any).vmReconcileRotationState.has(secondKey)).toBe(false);

      now = (internals as any).vmReconcileRotationState.get(firstKey).nextRetryAt + 1;
      const admittedAfterExpiry = (internals as any).prepareVmReconcileRotationTarget(
        second, [peer], now,
      ).record;
      expect(admittedAfterExpiry).toBeDefined();
      expect((internals as any).vmReconcileRotationState.has(firstKey)).toBe(false);
      expect((internals as any).vmReconcileRotationState.get(secondKey))
        .toBe(admittedAfterExpiry);
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_CACHE_MAX_ENTRIES',
        capDescriptor,
      );
    }
  });

  it('evicts an expired collecting rotation when the next slot reaches the state cap', async () => {
    const capDescriptor = Object.getOwnPropertyDescriptor(
      DKGAgentBase,
      'VM_RECONCILE_CACHE_MAX_ENTRIES',
    )!;
    Object.defineProperty(DKGAgentBase, 'VM_RECONCILE_CACHE_MAX_ENTRIES', {
      ...capDescriptor,
      value: 1,
    });
    try {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmExpiredCapacity', chainAdapter: chain });
      stubNode(agent);
      const internals = agent as unknown as AgentInternals;
      const peer = '12D3KooWExpiredCapacityPeer';
      const first = vmRecoveryTarget('expired-capacity', 0, 'first');
      const second = vmRecoveryTarget('expired-capacity', 1, 'second');
      let now = 100;
      (internals as any).vmReconcileRotationNow = () => now;
      const firstKey = (internals as any).vmReconcileRotationSlotKey(first);
      const secondKey = (internals as any).vmReconcileRotationSlotKey(second);
      expect((internals as any).prepareVmReconcileRotationTarget(
        first, [peer], now,
      ).record).toBeDefined();

      now += DKGAgent.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS + 1;
      const secondRecord = (internals as any).prepareVmReconcileRotationTarget(
        second, [peer], now,
      ).record;
      expect(secondRecord).toBeDefined();
      expect((internals as any).vmReconcileRotationState.has(firstKey)).toBe(false);
      expect((internals as any).vmReconcileRotationState.get(secondKey)).toBe(secondRecord);
    } finally {
      Object.defineProperty(
        DKGAgentBase,
        'VM_RECONCILE_CACHE_MAX_ENTRIES',
        capDescriptor,
      );
    }
  });

  it('preserves retained proof across candidate growth and ignores evicted records', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRotationIdentity', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const target = vmRecoveryTarget('rotation-identity', 0, '72');
    const peerA = '12D3KooWRotationIdentityA';
    const peerB = '12D3KooWRotationIdentityB';
    const peerC = '12D3KooWRotationIdentityC';

    const initial = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA, peerB], 0,
    );
    (internals as any).creditVmReconcileCleanAbsence(
      target, peerA, [peerA, peerB], initial.record,
    );
    expect([...initial.record.cleanAbsentPeerIds]).toEqual([peerA]);

    const grown = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA, peerB, peerC], 1,
    );
    expect(grown.record).toBe(initial.record);
    expect(grown.record.phase).toBe('collecting');
    expect([...grown.record.cleanAbsentPeerIds]).toEqual([peerA]);
    expect([...grown.record.attemptedPeerIds]).toEqual([peerA]);

    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    (internals as any).vmReconcileRotationState.delete(slotKey);
    (internals as any).creditVmReconcileCleanAbsence(
      target, peerA, [peerA, peerB, peerC], grown.record,
    );
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);

    const rootB = { ...target, merkleRoot: 'root-b' };
    const replacement = (internals as any).prepareVmReconcileRotationTarget(
      rootB, [peerA], 2,
    ).record;
    expect(replacement).not.toBe(grown.record);
    const rootAAgain = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA], 2,
    ).record;
    expect(rootAAgain).not.toBe(initial.record);
    expect(rootAAgain).not.toBe(replacement);
    (internals as any).forceClearVmReconcileStateForContextGraph(target.localCgId);
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);
    (internals as any).creditVmReconcileCleanAbsence(
      target, peerA, [peerA], rootAAgain,
    );
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);

    const shutdownRecord = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA], 3,
    ).record;
    (internals as any).closeVmReconcileRotationState();
    (internals as any).creditVmReconcileCleanAbsence(
      target, peerA, [peerA], shutdownRecord,
    );
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it('closes exact-recovery rotation state through the public stop path', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRotationPublicStop', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const target = vmRecoveryTarget('rotation-public-stop', 0, 'stop');
    const peer = '12D3KooWRotationPublicStop';
    (internals as any).started = true;
    (internals as any).node = {
      peerId: '12D3KooWRotationPublicStopLocal',
      libp2p: { getPeers: () => [] },
      stop: vi.fn(async () => undefined),
    };
    (internals as any).messenger = { stopOutboxDrain: vi.fn(async () => undefined) };
    const record = (internals as any).prepareVmReconcileRotationTarget(
      target, [peer], 100,
    ).record;
    expect((internals as any).vmReconcileRotationState.size).toBe(1);

    await agent.stop();

    expect((internals as any).vmReconcileRotationClosed).toBe(true);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
    (internals as any).settleVmReconcileRotationAttempt(
      target, peer, 'clean-absent', [peer], record,
    );
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
    agent = null;
  });

  it('clears the complete proof cycle across capped-roster replacement and rejoin', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRotationReplacement', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const target = vmRecoveryTarget('rotation-replacement', 0, '81');
    const peerA = '12D3KooWRotationReplacementA';
    const peerB = '12D3KooWRotationReplacementB';
    const peerC = '12D3KooWRotationReplacementC';
    const peerD = '12D3KooWRotationReplacementD';
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;

    const initial = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA, peerB, peerC], now,
    ).record;
    for (const peerId of [peerA, peerB, peerC]) {
      (internals as any).settleVmReconcileRotationAttempt(
        target, peerId, 'clean-absent', [peerA, peerB, peerC], initial,
      );
    }
    expect(initial).toMatchObject({ phase: 'backoff', failures: 1 });

    now += 1;
    const replaced = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA, peerC, peerD], now,
    ).record;
    expect(replaced).toBe(initial);
    expect(replaced).toMatchObject({ phase: 'collecting', failures: 1, nextRetryAt: 0 });
    expect([...replaced.attemptedPeerIds]).toEqual([]);
    expect([...replaced.cleanAbsentPeerIds]).toEqual([]);
    expect((internals as any).vmReconcileUncreditedCandidateOrder(replaced))
      .toEqual([peerA, peerC, peerD]);
    (internals as any).settleVmReconcileRotationAttempt(
      target, peerA, 'clean-absent', [peerA, peerC, peerD], replaced,
    );
    expect([...replaced.cleanAbsentPeerIds]).toEqual([peerA]);

    now += 1;
    const rejoined = (internals as any).prepareVmReconcileRotationTarget(
      target, [peerA, peerB, peerC], now,
    ).record;
    expect(rejoined).toBe(initial);
    expect(rejoined).toMatchObject({ phase: 'collecting', failures: 1, nextRetryAt: 0 });
    expect([...rejoined.attemptedPeerIds]).toEqual([]);
    expect([...rejoined.cleanAbsentPeerIds]).toEqual([]);
    expect((internals as any).vmReconcileUncreditedCandidateOrder(rejoined))
      .toEqual([peerA, peerB, peerC]);
  });

  it('clears partial and active-backoff evidence on roster shrink', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRotationShrink', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const peerA = '12D3KooWRotationShrinkA';
    const peerB = '12D3KooWRotationShrinkB';

    const partialTarget = vmRecoveryTarget('rotation-shrink', 0, '87');
    const partial = (internals as any).prepareVmReconcileRotationTarget(
      partialTarget, [peerA, peerB], 100,
    ).record;
    (internals as any).settleVmReconcileRotationAttempt(
      partialTarget, peerA, 'incomplete', [peerA, peerB], partial,
    );
    expect([...partial.attemptedPeerIds]).toEqual([peerA]);

    const shrunkPartial = (internals as any).prepareVmReconcileRotationTarget(
      partialTarget, [peerA], 101,
    );
    expect(shrunkPartial.suppressed).toBe(false);
    expect(shrunkPartial.record).toMatchObject({ phase: 'collecting', failures: 0 });
    expect([...shrunkPartial.record.attemptedPeerIds]).toEqual([]);
    expect([...shrunkPartial.record.cleanAbsentPeerIds]).toEqual([]);
    // A response captured against the old roster is inert after shrink.
    (internals as any).settleVmReconcileRotationAttempt(
      partialTarget, peerB, 'clean-absent', [peerA, peerB], partial,
    );
    expect([...shrunkPartial.record.cleanAbsentPeerIds]).toEqual([]);

    const backoffTarget = vmRecoveryTarget('rotation-shrink', 1, '88');
    const backoff = (internals as any).prepareVmReconcileRotationTarget(
      backoffTarget, [peerA, peerB], 200,
    ).record;
    for (const peerId of [peerA, peerB]) {
      (internals as any).settleVmReconcileRotationAttempt(
        backoffTarget, peerId, 'clean-absent', [peerA, peerB], backoff,
      );
    }
    expect(backoff.phase).toBe('backoff');
    const shrunkBackoff = (internals as any).prepareVmReconcileRotationTarget(
      backoffTarget, [peerA], 201,
    );
    expect(shrunkBackoff.suppressed).toBe(false);
    expect(shrunkBackoff.record).toMatchObject({ phase: 'collecting', failures: 1 });
    expect([...shrunkBackoff.record.attemptedPeerIds]).toEqual([]);
    expect([...shrunkBackoff.record.cleanAbsentPeerIds]).toEqual([]);
  });

  it('preserves active backoff across an empty socket view but drops partial evidence', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmEmptyRoster', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peer = '12D3KooWEmptyRosterPeer';
    const otherPeer = '12D3KooWEmptyRosterOther';
    const localCgId = '0x0000000000000000000000000000000000000001/empty-roster';
    (internals as any).node = {
      peerId: '12D3KooWEmptyRosterLocal',
      libp2p: { getConnections: () => [] },
    };
    let now = 100;
    (internals as any).vmReconcileRotationNow = () => now;

    const partialTarget = vmRecoveryTarget(localCgId, 0, 'partial-empty');
    const partial = (internals as any).prepareVmReconcileRotationTarget(
      partialTarget, [peer, otherPeer], now,
    ).record;
    (internals as any).settleVmReconcileRotationAttempt(
      partialTarget, peer, 'incomplete', [peer, otherPeer], partial,
    );
    expect([...partial.attemptedPeerIds]).toEqual([peer]);
    const partialKey = (internals as any).vmReconcileRotationSlotKey(partialTarget);
    const emptyPartial = (internals as any).prepareVmReconcileRotationTarget(
      partialTarget, [], now + 1,
    );
    expect(emptyPartial.suppressed).toBe(false);
    expect((internals as any).vmReconcileRotationState.has(partialKey)).toBe(false);
    const rejoinedPartial = (internals as any).prepareVmReconcileRotationTarget(
      partialTarget, [peer], now + 2,
    ).record;
    expect([...rejoinedPartial.attemptedPeerIds]).toEqual([]);
    expect([...rejoinedPartial.cleanAbsentPeerIds]).toEqual([]);

    const backoffTarget = vmRecoveryTarget(localCgId, 1, 'backoff-empty');
    const backoff = (internals as any).prepareVmReconcileRotationTarget(
      backoffTarget, [peer], now,
    ).record;
    (internals as any).settleVmReconcileRotationAttempt(
      backoffTarget, peer, 'clean-absent', [peer], backoff,
    );
    expect(backoff.phase).toBe('backoff');
    now += 1;

    const resolveCurators = vi.fn();
    (internals as any).resolveCuratorPeerIdsForCg = resolveCurators;
    const fetch = vi.fn();
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [backoffTarget], 100, () => true,
    );
    expect(result.attemptedOrdinals).toEqual([]);
    expect(resolveCurators).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect((internals as any).vmReconcileRotationState.get(
      (internals as any).vmReconcileRotationSlotKey(backoffTarget),
    )).toBe(backoff);
  });

  it('does not let an unconfirmed curator roster suppress the next discovery attempt', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmUnconfirmedCuratorBackoff', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/unconfirmed-curator';
    const ordinaryPeer = '12D3KooWUnconfirmedOrdinary';
    const target = vmRecoveryTarget(localCgId, 0, 'unconfirmed');
    const first = (internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer], 100, false,
    );
    (internals as any).settleVmReconcileRotationAttempt(
      target, ordinaryPeer, 'clean-absent', [ordinaryPeer], first.record,
    );
    expect(first.record).toMatchObject({
      phase: 'collecting',
      curatorRosterConfirmed: false,
    });

    const retry = (internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer], 101, false,
    );
    expect(retry.suppressed).toBe(false);
    expect(retry.record).toBe(first.record);
    expect(retry.record).toMatchObject({
      phase: 'collecting',
      curatorRosterConfirmed: false,
    });

    (internals as any).settleVmReconcileRotationAttempt(
      target, ordinaryPeer, 'clean-absent', [ordinaryPeer], retry.record,
    );
    const confirmed = (internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer], 102, true,
    );
    expect(confirmed.suppressed).toBe(false);
    expect(confirmed.record).toBe(retry.record);
    expect(confirmed.record.curatorRosterConfirmed).toBe(true);
    expect([...confirmed.record.attemptedPeerIds]).toEqual([]);
    (internals as any).settleVmReconcileRotationAttempt(
      target, ordinaryPeer, 'clean-absent', [ordinaryPeer], confirmed.record,
    );
    expect((internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer], 103, true,
    ).suppressed).toBe(true);
  });

  it('reprobes retained peers when curator proof arrives with roster growth', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCuratorProofGrowth', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/proof-growth';
    const ordinaryPeer = '12D3KooWProofGrowthOrdinary';
    const curatorPeer = '12D3KooWProofGrowthCurator';
    const target = vmRecoveryTarget(localCgId, 0, 'proof-growth');
    const unconfirmed = (internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer], 100, false,
    );
    (internals as any).settleVmReconcileRotationAttempt(
      target, ordinaryPeer, 'clean-absent', [ordinaryPeer], unconfirmed.record,
    );
    expect([...unconfirmed.record.cleanAbsentPeerIds]).toEqual([ordinaryPeer]);

    const confirmed = (internals as any).prepareVmReconcileRotationTarget(
      target, [ordinaryPeer, curatorPeer], 101, true,
    );
    expect(confirmed.suppressed).toBe(false);
    expect(confirmed.record).toBe(unconfirmed.record);
    expect(confirmed.record.curatorRosterConfirmed).toBe(true);
    expect([...confirmed.record.candidatePeerIds]).toEqual([ordinaryPeer, curatorPeer]);
    expect([...confirmed.record.attemptedPeerIds]).toEqual([]);
    expect([...confirmed.record.cleanAbsentPeerIds]).toEqual([]);
  });

  it('does not persist incomplete-cycle suppression when curator discovery is unconfirmed', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmUnconfirmedIncompleteBackoff', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/unconfirmed-incomplete';
    const peer = '12D3KooWUnconfirmedIncomplete';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWUnconfirmedIncompleteLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peer);
    let curatorResolutions = 0;
    (internals as any).resolveCuratorPeerIdsForCg = async () => {
      curatorResolutions += 1;
      return {
        peerIds: [], curatorIsLocal: false, legacyTripleResolved: false, lookupFailed: true,
      };
    };
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = () => [connectedPeer];
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let fetches = 0;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      fetches += 1;
      return {
        result: {
          fetchedDataTriples: 50_000, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, 'unconfirmed-incomplete');
    (internals as any).reconcileChainOrdinal = async () => ({ status: 'pending', recovery: target });

    await internals.recoverVmReconcileBatch(localCgId, 1n, [target], 100, () => true);
    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    expect((internals as any).vmReconcileRotationState.get(slotKey)).toMatchObject({
      phase: 'collecting', curatorRosterConfirmed: false,
    });
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const suppressed = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(suppressed.attemptedOrdinals).toEqual([]);
    expect(curatorResolutions).toBe(2);
    expect(fetches).toBe(1);
  });

  it('retries curator discovery after an unconfirmed clean-absence cycle', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmCuratorDiscoveryRetry', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/curator-retry';
    const ordinaryPeer = '12D3KooWCuratorRetryOrdinary';
    const curatorPeer = '12D3KooWCuratorRetryAuthoritative';
    const connectedById = new Map([
      [ordinaryPeer, { toString: () => ordinaryPeer }],
    ]);
    (internals as any).node = {
      peerId: '12D3KooWCuratorRetryLocal',
      libp2p: {
        getConnections: () => [...connectedById.values()]
          .map((remotePeer) => ({ remotePeer })),
      },
    };
    const resolveCurators = vi.fn()
      .mockResolvedValueOnce({
        peerIds: [], curatorIsLocal: false, legacyTripleResolved: false, lookupFailed: true,
      })
      .mockResolvedValueOnce({
        peerIds: [curatorPeer], curatorIsLocal: false,
        legacyTripleResolved: false, lookupFailed: false,
      });
    (internals as any).resolveCuratorPeerIdsForCg = resolveCurators;
    (internals as any).ensurePeerConnected = async (peerId: string) => {
      connectedById.set(peerId, { toString: () => peerId });
    };
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    const fetches: string[] = [];
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetches.push(peerId);
      const found = peerId === curatorPeer;
      return {
        result: {
          fetchedDataTriples: found ? 1 : 0,
          fetchedMetaTriples: found ? 8 : 0,
          insertedTriples: found ? 9 : 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: found ? 'found' : 'clean-absent',
      };
    };
    (internals as any).reconcileChainOrdinal = vi.fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'reconciled', blockNumber: 100 });
    const target = vmRecoveryTarget(localCgId, 0, 'curator-retry');

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(first.outcomes.get(0)).toEqual({ status: 'pending' });
    expect(fetches).toEqual([ordinaryPeer]);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);

    const second = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(resolveCurators).toHaveBeenCalledTimes(2);
    expect(fetches).toEqual([ordinaryPeer, curatorPeer]);
    expect(second.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('ignores stale exact-recovery targets before creating state or fetching', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmStaleTarget', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const fetch = vi.fn();
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    const staleLocal = vmRecoveryTarget('other-context-graph', 0, '82');
    const staleOnChain = {
      ...vmRecoveryTarget('current-context-graph', 1, '83'),
      onChainCgId: '2',
    };

    const result = await internals.recoverVmReconcileBatch(
      'current-context-graph', 1n, [staleLocal, staleOnChain], 100, () => true,
    );

    expect(result.attemptedOrdinals).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it.each(['unsubscribe', 'rebind'])('does not recreate state after %s during curator resolution', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmResolutionInvalidation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/resolution-invalidation';
    const peer = '12D3KooWResolutionInvalidationPeer';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWResolutionInvalidationLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    let releaseResolution!: () => void;
    let markResolutionStarted!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => { markResolutionStarted = resolve; });
    const resolutionRelease = new Promise<void>((resolve) => { releaseResolution = resolve; });
    (internals as any).resolveCuratorPeerIdsForCg = async () => {
      markResolutionStarted();
      await resolutionRelease;
      return { peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false };
    };
    const connect = recorder(async () => undefined);
    const fetch = recorder(async () => undefined);
    (internals as any).ensurePeerConnected = connect;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    let current = true;
    const target = vmRecoveryTarget(localCgId, 0, 'resolution-invalidation');
    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => current,
    );
    await resolutionStarted;
    current = false;
    (internals as any).forceClearVmReconcileStateForContextGraph(localCgId);
    releaseResolution();

    await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
    expect(connect.calls).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect((internals as any).vmReconcileCuratorPeersByCg.has(localCgId)).toBe(false);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it('does not recreate state after shutdown during fallback resolution', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmFallbackShutdown', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/fallback-shutdown';
    const peer = '12D3KooWFallbackShutdownPeer';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWFallbackShutdownLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [], curatorIsLocal: false, legacyTripleResolved: false,
    });
    let releaseFallback!: () => void;
    let markFallbackStarted!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { markFallbackStarted = resolve; });
    const fallbackRelease = new Promise<void>((resolve) => { releaseFallback = resolve; });
    (internals as any).resolvePreferredSyncPeerId = async () => {
      markFallbackStarted();
      await fallbackRelease;
      return peer;
    };
    const connect = recorder(async () => undefined);
    (internals as any).ensurePeerConnected = connect;
    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, 'fallback-shutdown')], 100, () => true,
    );
    await fallbackStarted;
    (internals as any).closeVmReconcileRotationState();
    releaseFallback();

    await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
    expect(connect.calls).toEqual([]);
    expect((internals as any).vmReconcileCuratorPeersByCg.size).toBe(0);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it('keeps a pre-stop exact recovery stale after rotation state reopens', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmRestartGeneration', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/restart-generation';
    const peer = '12D3KooWRestartGenerationPeer';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWRestartGenerationLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [], curatorIsLocal: false, legacyTripleResolved: false,
    });
    let releaseFallback!: () => void;
    let markFallbackStarted!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { markFallbackStarted = resolve; });
    const fallbackRelease = new Promise<void>((resolve) => { releaseFallback = resolve; });
    (internals as any).resolvePreferredSyncPeerId = async () => {
      markFallbackStarted();
      await fallbackRelease;
      return peer;
    };
    const connect = recorder(async () => undefined);
    const fetch = recorder(async () => undefined);
    (internals as any).ensurePeerConnected = connect;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;

    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, 'restart-generation')], 100, () => true,
    );
    await fallbackStarted;
    const priorGeneration = (internals as any).vmReconcileLifecycleGeneration;
    (internals as any).closeVmReconcileRotationState();
    (internals as any).openVmReconcileRotationState();
    expect((internals as any).vmReconcileRotationClosed).toBe(false);
    expect((internals as any).vmReconcileLifecycleGeneration).toBe(priorGeneration + 1);
    releaseFallback();

    await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
    expect(connect.calls).toEqual([]);
    expect(fetch.calls).toEqual([]);
    expect((internals as any).vmReconcileCuratorPeersByCg.size).toBe(0);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it('does not recreate state after a rebind while dialing the curator', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmDialInvalidation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/dial-invalidation';
    const peer = '12D3KooWDialInvalidationPeer';
    (internals as any).node = {
      peerId: '12D3KooWDialInvalidationLocal',
      libp2p: { getConnections: () => [] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    let releaseDial!: () => void;
    let markDialStarted!: () => void;
    const dialStarted = new Promise<void>((resolve) => { markDialStarted = resolve; });
    const dialRelease = new Promise<void>((resolve) => { releaseDial = resolve; });
    (internals as any).ensurePeerConnected = async () => {
      markDialStarted();
      await dialRelease;
    };
    const fetch = recorder(async () => undefined);
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
    let current = true;
    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [vmRecoveryTarget(localCgId, 0, 'dial-invalidation')], 100, () => current,
    );
    await dialStarted;
    current = false;
    (internals as any).forceClearVmReconcileStateForContextGraph(localCgId);
    releaseDial();

    await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
    expect(fetch.calls).toEqual([]);
    expect((internals as any).vmReconcileCuratorPeersByCg.has(localCgId)).toBe(false);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it.each(['protocol', 'admission'] as const)(
    'does not start stale transport after invalidation during the %s wait',
    async (stage) => {
      const chain = new MockChainAdapter();
      agent = await DKGAgent.create({ name: 'ExactVmBoundaryInvalidation', chainAdapter: chain });
      const internals = agent as unknown as AgentInternals;
      const localCgId = `0x0000000000000000000000000000000000000001/${stage}-invalidation`;
      const peer = `12D3KooW${stage}InvalidationPeer`;
      const connectedPeer = { toString: () => peer };
      (internals as any).node = {
        peerId: '12D3KooWBoundaryInvalidationLocal',
        libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
      };
      (internals as any).resolveCuratorPeerIdsForCg = async () => ({
        peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
      });
      (internals as any).ensurePeerConnected = async () => undefined;
      (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
      let releaseBoundary!: () => void;
      let markBoundaryStarted!: () => void;
      const boundaryStarted = new Promise<void>((resolve) => { markBoundaryStarted = resolve; });
      const boundaryRelease = new Promise<void>((resolve) => { releaseBoundary = resolve; });
      (internals as any).waitForSyncProtocol = async () => {
        if (stage === 'protocol') {
          markBoundaryStarted();
          await boundaryRelease;
        }
        return true;
      };
      (internals as any).ensurePeerAdmittedForRecovery = async () => {
        if (stage === 'admission') {
          markBoundaryStarted();
          await boundaryRelease;
        }
        return true;
      };
      const fetch = vi.fn();
      (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = fetch;
      let current = true;
      const target = vmRecoveryTarget(localCgId, 0, `${stage}-invalidation`);
      const recovery = internals.recoverVmReconcileBatch(
        localCgId, 1n, [target], 100, () => current,
      );
      await boundaryStarted;
      current = false;
      (internals as any).forceClearVmReconcileStateForContextGraph(localCgId);
      releaseBoundary();

      await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
      expect(fetch).not.toHaveBeenCalled();
      expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(false);
      expect((internals as any).vmReconcileRotationState.size).toBe(0);
    },
  );

  it('does not restore cooldown after invalidation during exact transport', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmTransportInvalidation', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const localCgId = '0x0000000000000000000000000000000000000001/transport-invalidation';
    const peer = '12D3KooWTransportInvalidationPeer';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWTransportInvalidationLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchRelease = new Promise<void>((resolve) => { releaseFetch = resolve; });
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      markFetchStarted();
      await fetchRelease;
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'clean-absent',
      };
    };
    const reconcile = vi.fn();
    (internals as any).reconcileChainOrdinal = reconcile;
    let current = true;
    const target = vmRecoveryTarget(localCgId, 0, 'transport-invalidation');
    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => current,
    );
    await fetchStarted;
    current = false;
    (internals as any).forceClearVmReconcileStateForContextGraph(localCgId);
    releaseFetch();

    await expect(recovery).resolves.toMatchObject({ attemptedOrdinals: [] });
    expect(reconcile).not.toHaveBeenCalled();
    expect((internals as any).vmReconcileFetchCooldownAt.has(localCgId)).toBe(false);
    expect((internals as any).vmReconcileRotationState.size).toBe(0);
  });

  it('does not resurrect a rotation record evicted while the exact request is pending', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmLateEviction', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peer = '12D3KooWLateEvictionPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/late-eviction';
    const connectedPeer = { toString: () => peer };
    (internals as any).node = {
      peerId: '12D3KooWLateEvictionLocal',
      libp2p: { getConnections: () => [{ remotePeer: connectedPeer }] },
    };
    (internals as any).preferredSyncPeers.set(localCgId, peer);
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peer], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).ensurePeerConnected = async () => undefined;
    (internals as any).selectCatchupPeers = () => [connectedPeer];
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let releaseFetch!: () => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchRelease = new Promise<void>((resolve) => { releaseFetch = resolve; });
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      markFetchStarted();
      await fetchRelease;
      return {
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'clean-absent',
      };
    };
    const target = vmRecoveryTarget(localCgId, 0, '73');
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending', recovery: target,
    });

    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    await fetchStarted;
    const slotKey = (internals as any).vmReconcileRotationSlotKey(target);
    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(true);
    (internals as any).vmReconcileRotationState.delete(slotKey);
    releaseFetch();
    await recovery;

    expect((internals as any).vmReconcileRotationState.has(slotKey)).toBe(false);
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
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async () => {
      fetchCount += 1;
      return {
        result: {
          fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'found',
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 100,
    });
    const target = vmRecoveryTarget(localCgId, 0, '7');

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
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (peerId: string) => {
      fetches.push(peerId);
      return {
        result: {
          fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'found',
      };
    };
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 100,
    });
    const target = vmRecoveryTarget(localCgId, 0, '7');

    const first = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );
    expect(first.attemptedOrdinals).toEqual([0]);
    expect(fetches).toEqual([]);
    (internals as any).vmReconcileFetchCooldownAt.delete(localCgId);
    const result = await internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true,
    );

    expect(fetches).toEqual([admittedPeer]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(result.attemptedOrdinals).toEqual([0]);
  });

  it('propagates lifecycle cancellation into an in-flight exact recovery', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'ExactVmLifecycleAbort', chainAdapter: chain });
    const internals = agent as unknown as AgentInternals;
    const peerId = '12D3KooWExactLifecycleAbortPeer';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-abort';
    const remotePeer = { toString: () => peerId };
    (internals as any).node = {
      peerId: '12D3KooWExactLifecycleAbortLocal',
      libp2p: { getConnections: () => [{ remotePeer }] },
    };
    (internals as any).resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [peerId], curatorIsLocal: false, legacyTripleResolved: false,
    });
    (internals as any).selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
    (internals as any).waitForSyncProtocol = async () => true;
    (internals as any).ensurePeerAdmittedForRecovery = async () => true;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let receivedSignal: AbortSignal | undefined;
    (internals as any).syncExactKnowledgeAssetsFromPeerDetailed = async (
      _peerId: string,
      _cgId: string,
      _uals: string[],
      options: { signal?: AbortSignal },
    ) => {
      receivedSignal = options.signal;
      markEntered();
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener('abort', onAbort, { once: true });
      });
      throw new Error('unreachable');
    };
    const target = vmRecoveryTarget(localCgId, 0, 'exact-abort');
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'pending', recovery: target,
    });
    const controller = new AbortController();

    const recovery = internals.recoverVmReconcileBatch(
      localCgId, 1n, [target], 100, () => true, controller.signal,
    );
    await entered;
    controller.abort();

    await expect(recovery).resolves.toMatchObject({ outcomes: new Map() });
    expect(receivedSignal).toBe(controller.signal);
  });

  it('keeps the main VM slice ahead of repair and abandons a rebind during repair', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillHealBindingFence', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'heal-binding-fence';
    const sub = {
      subscribed: true,
      onChainId: '321',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, sub);
    let releaseHeal!: () => void;
    let markHealStarted!: () => void;
    const healStarted = new Promise<void>((resolve) => { markHealStarted = resolve; });
    const healRelease = new Promise<void>((resolve) => { releaseHeal = resolve; });
    (internals as any).healStrandedScopedKCs = async () => {
      markHealStarted();
      await healRelease;
    };
    const getCount = vi.fn(async () => 0n);
    chain.getContextGraphKCCount = getCount;

    const reconcile = (internals as any).executeVmReconcileForCg(localCgId, 'manual');
    await healStarted;
    sub.onChainId = '322';
    releaseHeal();

    await expect(reconcile).rejects.toMatchObject({ name: 'VmReconcileQueueClosedError' });
    // The primary reconcile must complete its useful bounded slice before the
    // best-effort repair begins; the post-repair binding fence still rejects a
    // stale continuation after the same subscription object is rebound.
    expect(getCount).toHaveBeenCalledOnce();
    expect(getCount).toHaveBeenCalledWith(321n);
    expect(sub.lastReconciledOrdinal).toBe(0);
  });

  it('retires an aborted reconcile even when stranded-KC repair ignores cancellation', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillHealAbortRace', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'heal-abort-race';
    internals.subscribedContextGraphs.set(localCgId, {
      subscribed: true,
      onChainId: '323',
      lastReconciledOrdinal: 0,
    });
    let markHealStarted!: () => void;
    const healStarted = new Promise<void>((resolve) => { markHealStarted = resolve; });
    let healCalls = 0;
    (internals as any).healStrandedScopedKCs = async () => {
      healCalls += 1;
      if (healCalls === 1) {
        markHealStarted();
        await new Promise<void>(() => undefined);
      }
    };
    chain.getContextGraphKCCount = async () => 0n;

    const abandoned = (internals as any).executeVmReconcileForCg(localCgId, 'manual');
    await healStarted;
    (internals as any).closeVmReconcileRotationState();
    await expect(abandoned).rejects.toMatchObject({ name: 'VmReconcileQueueClosedError' });

    (internals as any).openVmReconcileRotationState();
    await expect((internals as any).executeVmReconcileForCg(localCgId, 'manual'))
      .resolves.toMatchObject({ status: 'current' });
    expect(healCalls).toBe(2);
  });

  it('keeps watermark persistence inside the tracked physical reconcile', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkDrain', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'watermark-drain';
    internals.subscribedContextGraphs.set(localCgId, {
      subscribed: true,
      onChainId: '324',
      lastReconciledOrdinal: 0,
    });
    chain.getContextGraphKCCount = async () => 1n;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    (internals as any).persistVmReconcileWatermark = async () => {
      markPersistStarted();
      await persistGate;
    };

    const reconcile = (internals as any).executeVmReconcileForCg(localCgId, 'manual');
    await persistStarted;
    expect((internals as any).vmReconcilePhysicalRuns.size).toBe(1);
    let settled = false;
    void reconcile.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    releasePersist();
    await expect(reconcile).resolves.toMatchObject({ watermarkAfter: 1 });
    expect((internals as any).vmReconcilePhysicalRuns.size).toBe(0);
  });

  it('does not expose an advanced watermark when its durable save fails', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkSaveFailure', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'watermark-save-failure';
    const subscription = {
      subscribed: true,
      onChainId: '325',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    chain.getContextGraphKCCount = async () => 1n;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    (internals as any).persistVmReconcileWatermark = async () => {
      throw new Error('subscription store unavailable');
    };

    await expect((internals as any).executeVmReconcileForCg(localCgId, 'manual'))
      .rejects.toThrow('subscription store unavailable');
    expect(subscription.lastReconciledOrdinal).toBe(0);
    expect((internals as any).reconcileCursors.get(localCgId)?.watermark).toBe(0);
  });

  it('flushes reconcile materialization before strictly saving its watermark', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkFlushOrder', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'watermark-flush-order';
    const subscription = {
      subscribed: true,
      onChainId: '326',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    chain.getContextGraphKCCount = async () => 1n;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    const durabilityOrder: string[] = [];
    internals.store.flush = async () => { durabilityOrder.push('flush'); };
    (internals as any).persistContextGraphSubscriptionStrict = async () => {
      durabilityOrder.push('save');
    };

    await expect((internals as any).executeVmReconcileForCg(localCgId, 'manual'))
      .resolves.toMatchObject({ watermarkAfter: 1 });
    expect(durabilityOrder).toEqual(['flush', 'save']);
    expect(subscription.lastReconciledOrdinal).toBe(1);
  });

  it('flushes reconcile materialization while confirmation depth holds the watermark', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillHeldWatermarkFlush', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'held-watermark-flush';
    const subscription = {
      subscribed: true,
      onChainId: '330',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    chain.getContextGraphKCCount = async () => 1n;
    chain.getBlockNumber = async () => 100;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    const flush = vi.fn(async () => undefined);
    internals.store.flush = flush;
    const persistStrict = vi.fn(async () => undefined);
    (internals as any).persistContextGraphSubscriptionStrict = persistStrict;

    await expect((internals as any).executeVmReconcileForCg(localCgId, 'manual'))
      .resolves.toMatchObject({ watermarkAfter: 0, reconciledOrdinals: 1 });
    expect(flush).toHaveBeenCalledOnce();
    expect(persistStrict).not.toHaveBeenCalled();
    expect(subscription.lastReconciledOrdinal).toBe(0);
  });

  it('does not save or expose a watermark when reconcile materialization flush fails', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkFlushFailure', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'watermark-flush-failure';
    const subscription = {
      subscribed: true,
      onChainId: '327',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    chain.getContextGraphKCCount = async () => 1n;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    internals.store.flush = async () => { throw new Error('triple-store flush failed'); };
    const persistStrict = vi.fn(async () => undefined);
    (internals as any).persistContextGraphSubscriptionStrict = persistStrict;

    await expect((internals as any).executeVmReconcileForCg(localCgId, 'manual'))
      .rejects.toThrow('triple-store flush failed');
    expect(persistStrict).not.toHaveBeenCalled();
    expect(subscription.lastReconciledOrdinal).toBe(0);
    expect((internals as any).reconcileCursors.get(localCgId)?.watermark).toBe(0);
  });

  it('fences a watermark save continuation across a same-object binding ABA', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'CoreFillWatermarkBindingAba', chainAdapter: chain });
    stubNode(agent);
    const internals = agent as unknown as AgentInternals;
    const localCgId = 'watermark-binding-aba';
    const subscription = {
      subscribed: true,
      onChainId: '328',
      lastReconciledOrdinal: 0,
    };
    internals.subscribedContextGraphs.set(localCgId, subscription);
    chain.getContextGraphKCCount = async () => 1n;
    (internals as any).healStrandedScopedKCs = async () => undefined;
    (internals as any).reconcileChainOrdinal = async () => ({
      status: 'reconciled', blockNumber: 100,
    });
    internals.store.flush = async () => undefined;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    (internals as any).persistContextGraphSubscriptionStrict = async () => {
      markSaveStarted();
      await saveGate;
    };

    const reconcile = (internals as any).executeVmReconcileForCg(localCgId, 'manual');
    await saveStarted;
    const originalCursor = (internals as any).reconcileCursors.get(localCgId);
    (internals as any).bindSubscriptionOnChainId(localCgId, subscription, '329');
    (internals as any).bindSubscriptionOnChainId(localCgId, subscription, '328');
    (internals as any).reconcileCursors.set(localCgId, originalCursor);
    releaseSave();

    await expect(reconcile).rejects.toMatchObject({ name: 'VmReconcileQueueClosedError' });
    expect(subscription.onChainId).toBe('328');
    expect(subscription.lastReconciledOrdinal).toBe(0);
    expect(originalCursor.watermark).toBe(0);
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
