import { describe, expect, it, vi } from 'vitest';
import {
  contextGraphWorkspaceMetaGraphUri,
  PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../src/dkg-agent-types.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  runSelectedSwmContinuations,
} from '../src/sync/selected-swm-continuation.js';

const PEER = '12D3KooWSelectedCompleteSwmProvider';

const DKG = 'http://dkg.io/ontology/';

function snapshotManifest(contextGraphId: string, count: number): {
  meta: Quad[];
  payloadByRef: Map<string, Quad[]>;
} {
  const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  const meta: Quad[] = [];
  const payloadByRef = new Map<string, Quad[]>();
  for (let index = 0; index < count; index += 1) {
    const payload: Quad[] = [{
      subject: `urn:selected-swm:${index}`,
      predicate: 'http://schema.org/value',
      object: `"${index}"`,
      graph: '',
    }];
    const digest = workspacePublicQuadsDigest(payload);
    const subject = `urn:selected-swm-manifest:${index}`;
    meta.push(
      {
        subject,
        predicate: `${DKG}publicQuadsDigest`,
        object: `"${digest}"`,
        graph: metaGraph,
      },
      {
        subject,
        predicate: `${DKG}publicQuadsCount`,
        object: '"1"',
        graph: metaGraph,
      },
    );
    payloadByRef.set(digest, payload);
  }
  return { meta, payloadByRef };
}

function cleanDurableResult(): SharedMemorySyncResult {
  return {
    insertedTriples: 0,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: 0,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: 0,
    completedPhases: 0,
    checkpointAdvances: 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
    deferredBackpressure: 0,
    snapshotPlaneIncomplete: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
  };
}

function result(
  contextGraphId: string,
  snapshotsResolved: number,
  snapshotsTotal: number,
  options: {
    completed?: boolean;
    deferredBackpressure?: number;
    insertedDataTriples?: number;
  } = {},
): SharedMemorySyncResult {
  const completed = options.completed ?? snapshotsResolved === snapshotsTotal;
  const swmCoverage: SwmSnapshotCoverage = {
    contextGraphId,
    peerIdSuffix: PEER.slice(-8),
    snapshotsResolved,
    snapshotsTotal,
    manifestComplete: true,
    missingCount: snapshotsTotal - snapshotsResolved,
    missingSample: [],
    materializationFailures: 0,
  };
  return {
    insertedTriples: options.insertedDataTriples ?? snapshotsResolved,
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    insertedMetaTriples: 0,
    insertedDataTriples: options.insertedDataTriples ?? snapshotsResolved,
    bytesReceived: 0,
    resumedPhases: 0,
    timedOutPhases: completed ? 0 : 1,
    completedPhases: completed ? 1 : 0,
    checkpointAdvances: snapshotsResolved > 0 ? 1 : 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: 0,
    deniedPhases: 0,
    backoffWorthyFailures: completed ? 0 : 1,
    deferredBackpressure: options.deferredBackpressure ?? 0,
    snapshotPlaneIncomplete: completed ? 0 : 1,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
    swmCoverage,
  };
}

function merge(
  summary: SharedMemorySyncResult,
  part: SharedMemorySyncResult,
): SharedMemorySyncResult {
  return {
    ...part,
    insertedTriples: summary.insertedTriples + part.insertedTriples,
    insertedDataTriples: summary.insertedDataTriples + part.insertedDataTriples,
    deferredBackpressure:
      (summary.deferredBackpressure ?? 0) + (part.deferredBackpressure ?? 0),
  };
}

interface SelectedProviderSelectionAgent {
  started: boolean;
  config: {
    syncOnConnect: boolean;
    syncSharedMemoryOnConnect: boolean;
    syncContextGraphs: string[];
    rfc64PublicCatalogBootstrap: {
      acceptedPublicPolicies: Array<{ completeSwmProviders: string[] }>;
    };
  };
  networkAdmissionCoordinator: { isAcceptedPeer: (peerId: string) => boolean };
  syncingPeers: Set<string>;
  knownCorePeerIds: Set<string>;
  knownCorePeerIdsV2: Set<string>;
  skippedNoSyncPeers: Set<string>;
  lastSuccessfulSyncAt: Map<string, number>;
  lastSyncProgressAt: Map<string, number>;
  syncReconcilerBackoff: Map<string, unknown>;
  getPeerProtocols: () => Promise<string[]>;
  planSharedMemorySyncContextGraphs: () => Promise<{
    publicContextGraphIds: string[];
    privateRecoverFromCurator: string[];
    eligibleContextGraphIds: string[];
  }>;
  resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => string[];
  syncFromPeerDetailed: () => Promise<number>;
  refreshMetaSyncedFlags: () => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeerDetailed: (
    peerId: string,
    contextGraphIds: readonly string[],
    options?: { selectedSwmPriority?: boolean },
  ) => Promise<SharedMemorySyncResult>;
  log: { info: () => void; warn: () => void; debug: () => void };
}

const callTrySyncFromPeer = LifecycleSyncMethods.prototype.trySyncFromPeer as unknown as (
  this: SelectedProviderSelectionAgent,
  remotePeer: string,
) => Promise<unknown>;

interface AdmissionProbe {
  readonly contextGraphId: string;
  readonly selected: boolean;
  readonly priority: number | undefined;
  readonly event: 'start' | 'end';
}

interface SelectedSwmLifecycleHarnessOptions {
  readonly contextGraphs: {
    readonly public: string;
    readonly private?: string;
  };
  readonly manifest: ReturnType<typeof snapshotManifest>;
  readonly clock: {
    readonly now: () => number;
    readonly deadline: () => number;
  };
  readonly priorities?: Readonly<Record<string, number>>;
  readonly onSnapshotRead?: (probe: {
    readonly ref: string;
    readonly publicAdmission: number;
    readonly snapshotRead: number;
  }) => void;
  readonly beforeAdmissionRun?: (probe: {
    readonly contextGraphId: string;
    readonly publicAdmission: number;
  }) => Promise<void> | void;
}

interface SelectedSwmLifecycleAgentFixture {
  config: { syncContextGraphPriorities: Readonly<Record<string, number>> };
  store: OxigraphStore;
  writeLocks: Map<string, Promise<void>>;
  publicSnapshotStore: {
    getSnapshot: (ref: string) => Promise<Quad[] | null>;
    putSnapshot: (input: { digest: string }) => Promise<{ ref: string; byteLength: number }>;
  };
  listSubGraphs: () => Promise<string[]>;
  createContextGraphSyncDeadline: () => number;
  fetchSyncPages: (
    ctx: unknown,
    peerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: string,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
  ) => Promise<{
    quads: Quad[];
    bytesReceived: number;
    resumedFromOffset: number;
    nextOffset: number;
    checkpointKey: string;
    completed: boolean;
    timedOut: boolean;
  }>;
  getOrCreateSyncVerifyWorker: () => {
    processSharedMemoryBatch: (dataQuads: Quad[], metaQuads: Quad[]) => Promise<{
      verifiedData: Quad[];
      verifiedMeta: Quad[];
      totalFetchedDataQuads: number;
      totalFetchedMetaQuads: number;
      droppedDataTriples: number;
      emptyResponses: number;
      entityCreators: string[];
    }>;
  };
  runContextGraphSyncWithBackpressure: (
    ctx: unknown,
    contextGraphId: string,
    lane: string,
    operationId: string,
    work: () => Promise<SharedMemorySyncResult>,
    admission: { priorityOverride?: number; selectedSwmPriority?: boolean },
  ) => Promise<SharedMemorySyncResult>;
  syncCheckpoints: Map<string, number>;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
  invalidateListContextGraphsCache: () => void;
  contextGraphMetaProjection: { markDirtyFromQuads: () => void };
  oversizeTombstoneLog: { record: () => void };
  log: { info: () => void; warn: () => void; debug: () => void };
}

interface SelectedSwmLifecycleHarness {
  readonly agent: SelectedSwmLifecycleAgentFixture;
  readonly probes: {
    readonly admissions: AdmissionProbe[];
    readonly snapshotFetches: string[];
    readonly publicAdmissions: () => number;
    readonly snapshotReads: () => number;
    readonly metaFetches: () => number;
    readonly maxActiveAdmissions: () => number;
  };
  readonly close: () => Promise<void>;
}

type SyncSharedMemoryOptions = Parameters<
  typeof LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed
>[2];

const callSyncSharedMemoryFromPeerDetailed = (
  agent: SelectedSwmLifecycleAgentFixture,
  contextGraphIds: string[],
  options: SyncSharedMemoryOptions,
): Promise<SharedMemorySyncResult> => {
  const method = LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as unknown as (
    this: SelectedSwmLifecycleAgentFixture,
    remotePeerId: string,
    ids: string[],
    syncOptions: SyncSharedMemoryOptions,
  ) => Promise<SharedMemorySyncResult>;
  return method.call(agent, PEER, contextGraphIds, options);
};

function createSelectedSwmLifecycleHarness(
  options: SelectedSwmLifecycleHarnessOptions,
): SelectedSwmLifecycleHarness {
  const store = new OxigraphStore();
  const admissions: AdmissionProbe[] = [];
  const snapshotFetches: string[] = [];
  let activeAdmissions = 0;
  let maxActiveAdmissions = 0;
  let publicAdmissions = 0;
  let snapshotReads = 0;
  let metaFetches = 0;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(options.clock.now);

  const agent: SelectedSwmLifecycleAgentFixture = {
    config: { syncContextGraphPriorities: options.priorities ?? {} },
    store,
    writeLocks: new Map(),
    publicSnapshotStore: {
      getSnapshot: async (ref) => {
        snapshotReads += 1;
        options.onSnapshotRead?.({ ref, publicAdmission: publicAdmissions, snapshotRead: snapshotReads });
        return options.manifest.payloadByRef.get(ref) ?? null;
      },
      putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 0 }),
    },
    listSubGraphs: async () => [],
    createContextGraphSyncDeadline: options.clock.deadline,
    fetchSyncPages: async (
      _ctx,
      _peerId,
      contextGraphId,
      _includeSharedMemory,
      phase,
      _graphUri,
      _deadline,
      snapshotRef,
    ) => {
      if (phase === 'snapshot') {
        snapshotFetches.push(snapshotRef ?? 'missing-ref');
        throw new Error('all snapshot fixtures should be cache hits');
      }
      if (phase === 'meta') metaFetches += 1;
      const quads = phase === 'meta' && contextGraphId === options.contextGraphs.public
        ? options.manifest.meta
        : [];
      return {
        quads,
        bytesReceived: quads.length,
        resumedFromOffset: 0,
        nextOffset: quads.length,
        checkpointKey: `${contextGraphId}:${phase}`,
        completed: true,
        timedOut: false,
      };
    },
    getOrCreateSyncVerifyWorker: () => ({
      processSharedMemoryBatch: async (dataQuads, metaQuads) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        totalFetchedDataQuads: dataQuads.length,
        totalFetchedMetaQuads: metaQuads.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
    }),
    runContextGraphSyncWithBackpressure: async (
      _ctx,
      contextGraphId,
      _lane,
      _operationId,
      work,
      admission,
    ) => {
      activeAdmissions += 1;
      maxActiveAdmissions = Math.max(maxActiveAdmissions, activeAdmissions);
      if (contextGraphId === options.contextGraphs.public) publicAdmissions += 1;
      const row = {
        contextGraphId,
        selected: admission.selectedSwmPriority === true,
        priority: admission.priorityOverride,
      };
      admissions.push({ ...row, event: 'start' });
      try {
        await options.beforeAdmissionRun?.({ contextGraphId, publicAdmission: publicAdmissions });
        return await work();
      } finally {
        admissions.push({ ...row, event: 'end' });
        activeAdmissions -= 1;
      }
    },
    syncCheckpoints: new Map(),
    workspaceOwnedEntities: new Map(),
    invalidateListContextGraphsCache: () => {},
    contextGraphMetaProjection: { markDirtyFromQuads: () => {} },
    oversizeTombstoneLog: { record: () => {} },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  };

  return {
    agent,
    probes: {
      admissions,
      snapshotFetches,
      publicAdmissions: () => publicAdmissions,
      snapshotReads: () => snapshotReads,
      metaFetches: () => metaFetches,
      maxActiveAdmissions: () => maxActiveAdmissions,
    },
    close: async () => {
      dateNow.mockRestore();
      await store.close();
    },
  };
}

describe('selected RFC-64 SWM continuation', () => {
  it('re-enters admission promptly until incomplete coverage becomes complete', async () => {
    const contextGraphId = 'selected-public';
    const admissions: string[] = [];
    const summary = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{
        contextGraphId,
        lane: 'shared_memory',
        operationId: 'selected-public',
        run: async () => result(contextGraphId, 3, 3, { insertedDataTriples: 2 }),
      }],
      initialRounds: [{ contextGraphId, result: result(contextGraphId, 1, 3) }],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (item, run) => {
        admissions.push(item.contextGraphId);
        return run();
      },
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
    });

    expect(admissions).toEqual([contextGraphId]);
    expect(summary.continuationPasses).toBe(1);
    expect(summary.swmCoverage).toMatchObject({ snapshotsResolved: 3, snapshotsTotal: 3 });
  });

  it('allows one capable zero-progress retry, then stops when coverage stalls', async () => {
    const contextGraphId = 'selected-stalled';
    const stalled = result(contextGraphId, 0, 3);
    const stop = vi.fn();
    let admissions = 0;

    const summary = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{
        contextGraphId,
        lane: 'shared_memory',
        operationId: 'selected-stalled',
        run: async () => stalled,
      }],
      initialRounds: [{ contextGraphId, result: stalled }],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => {
        admissions += 1;
        return run();
      },
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
      onStop: stop,
    });

    expect(admissions).toBe(1);
    expect(summary.continuationPasses).toBe(1);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'coverage-stalled',
    }));
  });

  it('keeps independent per-CG coverage and continues only the incomplete graph', async () => {
    const runs: string[] = [];
    const stop = vi.fn();
    const work = ['complete-cg', 'incomplete-cg'].map((contextGraphId) => ({
      contextGraphId,
      lane: 'shared_memory' as const,
      operationId: contextGraphId,
      run: async () => {
        runs.push(contextGraphId);
        return result(contextGraphId, 5, 5);
      },
    }));

    await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work,
      initialRounds: [
        { contextGraphId: 'complete-cg', result: result('complete-cg', 2, 2) },
        { contextGraphId: 'incomplete-cg', result: result('incomplete-cg', 1, 5) },
      ],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(runs).toEqual(['incomplete-cg']);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId: 'complete-cg',
      reason: 'plane-proven',
    }));
  });

  it('stops at four total passes even while coverage keeps advancing', async () => {
    const contextGraphId = 'selected-bounded';
    const rounds = [2, 3, 4];
    const stop = vi.fn();
    const summary = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{
        contextGraphId,
        lane: 'shared_memory',
        operationId: contextGraphId,
        run: async () => result(contextGraphId, rounds.shift()!, 5),
      }],
      initialRounds: [{ contextGraphId, result: result(contextGraphId, 1, 5) }],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(summary.continuationPasses).toBe(3);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      continuationPasses: 3,
      reason: 'max-passes-reached',
    }));
  });

  it('does not start a continuation after the absolute budget expires', async () => {
    const contextGraphId = 'selected-expired';
    const run = vi.fn(async () => result(contextGraphId, 2, 2));
    const stop = vi.fn();
    const summary = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{ contextGraphId, lane: 'shared_memory', operationId: contextGraphId, run }],
      initialRounds: [{ contextGraphId, result: result(contextGraphId, 1, 2) }],
      passConfig: { maxPasses: 4, budgetMs: 0 },
      nowMs: () => 100,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, work) => work(),
      merge,
      markDeferred: (current) => current,
      onStop: stop,
    });

    expect(run).not.toHaveBeenCalled();
    expect(summary.continuationPasses).toBe(0);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      reason: 'budget-exhausted',
    }));
  });

  it('stops immediately on continuation backpressure', async () => {
    const contextGraphId = 'selected-pressure';
    const incomplete = result(contextGraphId, 1, 3);
    const continuationStop = vi.fn();
    const continuationRun = vi.fn(async () => (
      result(contextGraphId, 1, 3, { deferredBackpressure: 1 })
    ));

    await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{
        contextGraphId,
        lane: 'shared_memory',
        operationId: 'continuation-pressure',
        run: continuationRun,
      }],
      initialRounds: [{ contextGraphId, result: incomplete }],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (summary) => ({
        ...summary,
        deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
      }),
      onBackpressure: continuationStop,
    });
    expect(continuationRun).toHaveBeenCalledOnce();
    expect(continuationStop).toHaveBeenCalledOnce();
  });

  it('owns continuationPasses even when a part result carries a nonzero counter', async () => {
    const contextGraphId = 'selected-counter-owner';
    const continuation = {
      ...result(contextGraphId, 2, 2, { insertedDataTriples: 1 }),
      continuationPasses: 23,
    };

    const summary = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      work: [{
        contextGraphId,
        lane: 'shared_memory',
        operationId: 'counter-owner',
        run: async () => continuation,
      }],
      initialRounds: [{ contextGraphId, result: result(contextGraphId, 1, 2) }],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge: (left, right) => ({
        ...merge(left, right),
        continuationPasses:
          (left.continuationPasses ?? 0) + (right.continuationPasses ?? 0),
      }),
      markDeferred: (current) => current,
    });

    expect(summary.continuationPasses).toBe(1);
  });
});

describe('selected RFC-64 SWM lifecycle wiring', () => {
  it('keeps the reserved selected-provider lane public-only and leaves private recovery ordinary', async () => {
    const publicCg = 'selected-public-cg';
    const privateCg = 'did:dkg:agent:0x1111111111111111111111111111111111111111/private-cg';
    const syncCalls: Array<{
      contextGraphIds: readonly string[];
      selected: boolean;
    }> = [];
    const mixedPlan = {
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [privateCg],
      eligibleContextGraphIds: [publicCg, privateCg],
    };
    const agent: SelectedProviderSelectionAgent = {
      started: true,
      config: {
        syncOnConnect: true,
        syncSharedMemoryOnConnect: true,
        syncContextGraphs: [publicCg, privateCg],
        rfc64PublicCatalogBootstrap: {
          acceptedPublicPolicies: [{ completeSwmProviders: [PEER] }],
        },
      },
      networkAdmissionCoordinator: { isAcceptedPeer: () => true },
      syncingPeers: new Set<string>(),
      knownCorePeerIds: new Set<string>(),
      knownCorePeerIdsV2: new Set<string>(),
      skippedNoSyncPeers: new Set<string>(),
      lastSuccessfulSyncAt: new Map<string, number>(),
      lastSyncProgressAt: new Map<string, number>(),
      syncReconcilerBackoff: new Map<string, unknown>(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      planSharedMemorySyncContextGraphs: async () => mixedPlan,
      resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => (
        contextGraphId === publicCg ? [PEER] : []
      ),
      syncFromPeerDetailed: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeerDetailed: async (
        _peerId: string,
        contextGraphIds: readonly string[],
        options: { selectedSwmPriority?: boolean } = {},
      ) => {
        syncCalls.push({
          contextGraphIds: [...contextGraphIds],
          selected: options.selectedSwmPriority === true,
        });
        return cleanDurableResult();
      },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await callTrySyncFromPeer.call(agent, PEER);

    expect(syncCalls).toEqual([
      { contextGraphIds: [publicCg], selected: true },
      { contextGraphIds: [privateCg], selected: false },
    ]);
  });

  it('continues a voluntary 672/905 public snapshot yield to 905/905 with fresh admission', async () => {
    const publicCg = 'selected-production-shape';
    const privateCg = 'selected-private-unaffected';
    let initialSnapshotReads = 0;
    let wallNow = 1_000;
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg, private: privateCg },
      manifest: snapshotManifest(publicCg, 905),
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      priorities: { [publicCg]: 100, [privateCg]: 0 },
      onSnapshotRead: ({ publicAdmission }) => {
        if (publicAdmission === 1) {
          initialSnapshotReads += 1;
          if (initialSnapshotReads === 672) wallNow += 120_000;
        }
      },
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg, privateCg],
        {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [publicCg],
          privateRecoverFromCurator: [privateCg],
          eligibleContextGraphIds: [publicCg, privateCg],
        },
        },
      );

      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 905,
        snapshotsTotal: 905,
        missingCount: 0,
      });
      expect(summary.continuationPasses).toBe(1);
      expect(summary.snapshotPlaneIncomplete).toBe(1);
      expect(summary.failedPhases).toBe(1);
      expect(summary.timedOutPhases).toBe(0);
      expect(summary.backoffWorthyFailures).toBe(0);
      expect(initialSnapshotReads).toBe(672);
      expect(harness.probes.snapshotFetches).toEqual([]);
      expect(harness.probes.maxActiveAdmissions()).toBe(1);
      expect(harness.probes.admissions).toEqual([
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'start' },
        { contextGraphId: privateCg, selected: false, priority: undefined, event: 'end' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'start' },
        { contextGraphId: publicCg, selected: true, priority: 2_000, event: 'end' },
      ]);
    } finally {
      await harness.close();
    }
  });

  it('rechecks the continuation budget after queued scheduler admission', async () => {
    const contextGraphId = 'selected-expired-in-queue';
    const priorBudget = process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
    process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = '50';
    let wallNow = 2_000;
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: contextGraphId },
      manifest: snapshotManifest(contextGraphId, 2),
      clock: { now: () => wallNow, deadline: () => wallNow + 1 },
      onSnapshotRead: ({ publicAdmission, snapshotRead }) => {
        if (publicAdmission === 1 && snapshotRead === 1) wallNow += 120_000;
      },
      beforeAdmissionRun: async ({ publicAdmission }) => {
        if (publicAdmission === 2) {
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
      },
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [contextGraphId],
        {
        selectedSwmPriority: true,
        priority: 2_000,
        sharedMemorySyncPlan: {
          publicContextGraphIds: [contextGraphId],
          privateRecoverFromCurator: [],
          eligibleContextGraphIds: [contextGraphId],
        },
        },
      );

      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.snapshotReads()).toBe(1);
      expect(summary.continuationPasses).toBe(0);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 1,
        snapshotsTotal: 2,
      });
    } finally {
      if (priorBudget === undefined) delete process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS;
      else process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS = priorBudget;
      await harness.close();
    }
  });
});
