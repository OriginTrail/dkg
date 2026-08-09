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
import {
  applySelectedSwmFreshnessResolution,
  classifySelectedSwmRoundFreshness,
  classifySharedMemoryFreshness,
} from '../src/sync/shared-memory-freshness.js';
import { runSyncOnConnect } from '../src/sync/on-connect/sync-on-connect.js';
import { SyncPageAccumulationLimitError } from '../src/sync/requester/page-fetch.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';

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
    descriptorsAuthoritative: true,
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
    // Production voluntary snapshot yield: the responder is healthy, our
    // local round budget ended with refs outstanding.
    timedOutPhases: 0,
    completedPhases: completed ? 1 : 0,
    checkpointAdvances: snapshotsResolved > 0 ? 1 : 0,
    emptyResponses: 0,
    droppedDataTriples: 0,
    failedPeers: 0,
    failedPhases: completed ? 0 : 1,
    deniedPhases: 0,
    backoffWorthyFailures: 0,
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

function selectedUnit(
  contextGraphId: string,
  initialResult: SharedMemorySyncResult,
  run: () => Promise<SharedMemorySyncResult>,
) {
  return {
    work: {
      contextGraphId,
      lane: 'shared_memory' as const,
      operationId: contextGraphId,
      run,
    },
    initialResult,
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
  readonly onMetaFetch?: (probe: {
    readonly fetch: number;
    readonly requesterScope: string | undefined;
    readonly maxAcceptedQuads: number | undefined;
    readonly maxAcceptedHeapBytesEstimate: number | undefined;
  }) => Promise<void> | void;
  readonly metaContinuationLimits?: {
    readonly rows: number;
    readonly bytesEstimate: number;
  };
  /** Deterministic metadata slices returned by consecutive selected passes. */
  readonly metaPages?: readonly {
    readonly quads: Quad[];
    readonly resumedFromOffset: number;
    readonly nextOffset: number;
    readonly completed: boolean;
    readonly timedOut: boolean;
    readonly responderSessionStartedFresh?: boolean;
  }[];
  /** Number of aggregate-data calls that fail after metadata completed. */
  readonly dataFailuresBeforeSuccess?: number;
}

interface SelectedSwmLifecycleAgentFixture {
  config: {
    syncContextGraphPriorities: Readonly<Record<string, number>>;
    syncResponderSnapshotLimits?: {
      local?: { rows?: number; bytesEstimate?: number };
    };
  };
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
    sinceBatchId?: string,
    signal?: AbortSignal,
    recovery?: boolean,
    forceFreshSession?: boolean,
    assetUals?: string[],
    requesterScope?: `selected-swm-meta:${string}`,
    maxAcceptedQuads?: number,
    maxAcceptedHeapBytesEstimate?: number,
  ) => Promise<{
    quads: Quad[];
    bytesReceived: number;
    resumedFromOffset: number;
    nextOffset: number;
    checkpointKey: string;
    completed: boolean;
    timedOut: boolean;
    responderSessionStartedFresh?: boolean;
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
    readonly processedMetaBatches: readonly Quad[][];
    readonly dataFetches: () => number;
    readonly metaRequesterScopes: readonly (string | undefined)[];
    readonly metaSinceBatchIds: readonly (string | undefined)[];
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
  let dataFetches = 0;
  const metaRequesterScopes: Array<string | undefined> = [];
  const metaSinceBatchIds: Array<string | undefined> = [];
  const processedMetaBatches: Quad[][] = [];
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(options.clock.now);

  const agent: SelectedSwmLifecycleAgentFixture = {
    config: {
      syncContextGraphPriorities: options.priorities ?? {},
      ...(options.metaContinuationLimits
        ? {
          syncResponderSnapshotLimits: {
            local: options.metaContinuationLimits,
          },
        }
        : {}),
    },
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
      sinceBatchId,
      _signal,
      _recovery,
      _forceFreshSession,
      _assetUals,
      requesterScope,
      maxAcceptedQuads,
      maxAcceptedHeapBytesEstimate,
    ) => {
      if (phase === 'snapshot') {
        snapshotFetches.push(snapshotRef ?? 'missing-ref');
        throw new Error('all snapshot fixtures should be cache hits');
      }
      if (phase === 'meta') {
        metaFetches += 1;
        metaRequesterScopes.push(requesterScope);
        metaSinceBatchIds.push(sinceBatchId);
        await options.onMetaFetch?.({
          fetch: metaFetches,
          requesterScope,
          maxAcceptedQuads,
          maxAcceptedHeapBytesEstimate,
        });
        const planned = options.metaPages?.[metaFetches - 1];
        if (planned) {
          if (
            maxAcceptedQuads !== undefined
            && planned.quads.length > maxAcceptedQuads
          ) {
            const error = new SyncPageAccumulationLimitError(
              'quads',
              planned.quads.length,
              maxAcceptedQuads,
            );
            error.responderSessionStartedFresh =
              planned.responderSessionStartedFresh;
            throw error;
          }
          const heapBytesEstimate = planned.quads.reduce(
            (total, quad) => total + estimateQuadHeapBytes(quad),
            0,
          );
          if (
            maxAcceptedHeapBytesEstimate !== undefined
            && heapBytesEstimate > maxAcceptedHeapBytesEstimate
          ) {
            const error = new SyncPageAccumulationLimitError(
              'heap-bytes',
              heapBytesEstimate,
              maxAcceptedHeapBytesEstimate,
            );
            error.responderSessionStartedFresh =
              planned.responderSessionStartedFresh;
            throw error;
          }
          return {
            ...planned,
            bytesReceived: planned.quads.length,
            checkpointKey: `${contextGraphId}:${phase}`,
          };
        }
      }
      if (phase === 'data') {
        dataFetches += 1;
        if (dataFetches <= (options.dataFailuresBeforeSuccess ?? 0)) {
          throw new Error('simulated aggregate-data transport failure');
        }
      }
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
      processSharedMemoryBatch: async (dataQuads, metaQuads) => {
        processedMetaBatches.push([...metaQuads]);
        return {
          verifiedData: dataQuads,
          verifiedMeta: metaQuads,
          totalFetchedDataQuads: dataQuads.length,
          totalFetchedMetaQuads: metaQuads.length,
          droppedDataTriples: 0,
          emptyResponses: 0,
          entityCreators: [],
        };
      },
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
      processedMetaBatches,
      dataFetches: () => dataFetches,
      metaRequesterScopes,
      metaSinceBatchIds,
      maxActiveAdmissions: () => maxActiveAdmissions,
    },
    close: async () => {
      dateNow.mockRestore();
      await store.close();
    },
  };
}

describe('shared-memory freshness classification', () => {
  it('owns producer recovery, bounding, and final classification as one invariant', () => {
    const contextGraphId = 'selected-freshness-boundary';
    const incomplete = result(contextGraphId, 1, 2);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, incomplete)).toEqual({
      recoverableSnapshotYieldFailures: 1,
      recoverableMetadataContinuationYields: 0,
      snapshotPlaneComplete: false,
    });
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        contextGraphId: 'another-context-graph',
      },
    }).recoverableSnapshotYieldFailures).toBe(0);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        descriptorsAuthoritative: false,
      },
    }).recoverableSnapshotYieldFailures).toBe(0);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...incomplete,
      swmCoverage: {
        ...incomplete.swmCoverage!,
        materializationFailures: 1,
      },
    }).recoverableSnapshotYieldFailures).toBe(0);

    const complete = result(contextGraphId, 2, 2);
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...complete,
      swmCoverage: {
        ...complete.swmCoverage!,
        descriptorsAuthoritative: false,
      },
    }).snapshotPlaneComplete).toBe(false);
    const { descriptorsAuthoritative: _unknown, ...legacyCoverage } = complete.swmCoverage!;
    expect(classifySelectedSwmRoundFreshness(contextGraphId, {
      ...complete,
      swmCoverage: legacyCoverage,
    }).snapshotPlaneComplete).toBe(false);

    const finalRaw = {
      ...complete,
      failedPhases: 1,
      snapshotPlaneIncomplete: 1,
    };
    const resolved = applySelectedSwmFreshnessResolution(finalRaw, {
      recoverableSnapshotYieldFailures: 1,
    });
    expect(classifySharedMemoryFreshness(resolved).phaseFailed).toBe(false);

    expect(classifySharedMemoryFreshness({
      ...finalRaw,
      resolvedSnapshotPlaneIncomplete: 2,
    }).phaseFailed).toBe(true);
    expect(classifySharedMemoryFreshness({
      ...finalRaw,
      failedPhases: 2,
      resolvedSnapshotPlaneIncomplete: 1,
    }).phaseFailed).toBe(true);
    expect(applySelectedSwmFreshnessResolution({
      ...finalRaw,
      failedPhases: Number.NaN,
    }, {
      recoverableSnapshotYieldFailures: 1,
    }).resolvedSnapshotPlaneIncomplete).toBe(0);
    expect(applySelectedSwmFreshnessResolution({
      ...finalRaw,
      snapshotPlaneIncomplete: -1,
    }, {
      recoverableSnapshotYieldFailures: 1,
    }).resolvedSnapshotPlaneIncomplete).toBe(0);

    const retainedMetadataYield = {
      ...cleanDurableResult(),
      timedOutPhases: 1,
      metadataContinuationYields: 1,
    };
    expect(classifySelectedSwmRoundFreshness(
      contextGraphId,
      retainedMetadataYield,
    ).recoverableMetadataContinuationYields).toBe(1);
    const metadataResolved = applySelectedSwmFreshnessResolution(
      {
        ...retainedMetadataYield,
        completedPhases: 2,
      },
      {
        recoverableSnapshotYieldFailures: 0,
        recoverableMetadataContinuationYields: 1,
      },
    );
    expect(classifySharedMemoryFreshness(metadataResolved).timedOut).toBe(false);
    expect(classifySharedMemoryFreshness({
      ...retainedMetadataYield,
      completedPhases: 2,
      resolvedMetadataContinuationYields: 2,
    }).timedOut).toBe(true);
  });
});

describe('selected RFC-64 SWM continuation', () => {
  it('re-enters admission promptly until incomplete coverage becomes complete', async () => {
    const contextGraphId = 'selected-public';
    const admissions: string[] = [];
    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 3),
        async () => result(contextGraphId, 3, 3, { insertedDataTriples: 2 }),
      )],
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

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, stalled, async () => stalled)],
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

  it('does not treat an allocated zero-offset metadata accumulator as retry capability', async () => {
    const contextGraphId = 'selected-zero-meta-progress';
    const run = vi.fn(async () => cleanDurableResult());
    const stop = vi.fn();
    const unit = {
      ...selectedUnit(contextGraphId, cleanDurableResult(), run),
      metadataContinuationProgress: () => 0,
    };

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [unit],
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
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
      reason: 'coverage-stalled',
    }));
  });

  it('keeps independent per-CG coverage and continues only the incomplete graph', async () => {
    const runs: string[] = [];
    const stop = vi.fn();
    const units = ['complete-cg', 'incomplete-cg'].map((contextGraphId) => selectedUnit(
      contextGraphId,
      result(contextGraphId, contextGraphId === 'complete-cg' ? 2 : 1, contextGraphId === 'complete-cg' ? 2 : 5),
      async () => {
        runs.push(contextGraphId);
        return result(contextGraphId, 5, 5);
      },
    ));

    await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units,
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

  it('continues two selected public CGs independently in priority order', async () => {
    const publicA = 'selected-public-a';
    const publicB = 'selected-public-b';
    const runs: string[] = [];
    const admissions: string[] = [];
    const progress: Array<{
      contextGraphId: string;
      progressBefore: number;
      progressAfter: number;
    }> = [];

    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [publicA, publicB].map((contextGraphId) => selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 3),
        async () => {
          runs.push(contextGraphId);
          return result(contextGraphId, 3, 3, { insertedDataTriples: 2 });
        },
      )),
      priorities: { [publicA]: 100, [publicB]: 200 },
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (item, run) => {
        admissions.push(item.contextGraphId);
        return run();
      },
      merge,
      markDeferred: (current) => current,
      onContinuation: (event) => progress.push(event),
    });

    expect(admissions).toEqual([publicB, publicA]);
    expect(runs).toEqual([publicB, publicA]);
    expect(progress).toEqual([
      { contextGraphId: publicB, progressBefore: 1, progressAfter: 3 },
      { contextGraphId: publicA, progressBefore: 1, progressAfter: 3 },
    ]);
    expect(execution.summary.continuationPasses).toBe(2);
    expect(execution.freshnessResolution).toEqual({
      recoverableSnapshotYieldFailures: 2,
      recoverableMetadataContinuationYields: 0,
    });
  });

  it('stops at four total passes even while coverage keeps advancing', async () => {
    const contextGraphId = 'selected-bounded';
    const rounds = [2, 3, 4];
    const stop = vi.fn();
    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 5),
        async () => result(contextGraphId, rounds.shift()!, 5),
      )],
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
    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(contextGraphId, result(contextGraphId, 1, 2), run)],
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
      units: [selectedUnit(contextGraphId, incomplete, continuationRun)],
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

  it('preserves the three-failure peer-dead cutoff across outer continuation batches', async () => {
    const calls: string[] = [];
    const onBackpressure = vi.fn();
    const contextGraphIds = Array.from({ length: 8 }, (_, index) => `selected-dead-${index}`);
    const failed = {
      ...cleanDurableResult(),
      failedPeers: 1,
      backoffWorthyFailures: 1,
    };

    const execution = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: contextGraphIds.map((contextGraphId) => selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 2),
        async () => {
          calls.push(contextGraphId);
          return failed;
        },
      )),
      passConfig: { maxPasses: 4, budgetMs: 600_000 },
      nowMs: () => 1,
      emptyResult: cleanDurableResult,
      runWithAdmission: async (_item, run) => run(),
      merge,
      markDeferred: (current) => current,
      isPeerTransportFailure: (part) => part.failedPeers > 0,
      onBackpressure,
    });

    expect(calls).toEqual(contextGraphIds.slice(0, 3));
    expect(execution.summary.continuationPasses).toBe(3);
    expect(onBackpressure).not.toHaveBeenCalled();
  });

  it('owns continuationPasses even when a part result carries a nonzero counter', async () => {
    const contextGraphId = 'selected-counter-owner';
    const continuation = {
      ...result(contextGraphId, 2, 2, { insertedDataTriples: 1 }),
      continuationPasses: 23,
    };

    const { summary } = await runSelectedSwmContinuations({
      providerPeerId: PEER,
      units: [selectedUnit(
        contextGraphId,
        result(contextGraphId, 1, 2),
        async () => continuation,
      )],
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
      expect(summary.resolvedSnapshotPlaneIncomplete).toBe(1);
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

      const onPeerSynced = vi.fn();
      const outcome = await runSyncOnConnect({
        remotePeer: PEER,
        syncingPeers: new Set(),
        getPeerProtocols: async () => [PROTOCOL_SYNC],
        knownCorePeerIds: new Set(),
        knownCorePeerIdsV2: new Set(),
        getSyncContextGraphs: () => [],
        getDurableSyncContextGraphs: () => [],
        getSharedMemorySyncContextGraphs: () => [publicCg],
        getPrioritySharedMemorySyncContextGraphs: () => [publicCg],
        syncFromPeer: async () => 0,
        refreshMetaSyncedFlags: async () => undefined,
        discoverContextGraphsFromStore: async () => 0,
        syncSharedMemoryFromPeer: async () => summary,
        onPeerSynced,
        logInfo: () => {},
      });
      expect(outcome).toBe('synced');
      expect(onPeerSynced).toHaveBeenCalledWith(PEER, {
        fresh: true,
        progress: false,
      });
    } finally {
      await harness.close();
    }
  });

  it('retains an exact metadata prefix across bounded passes and verifies the combined manifest once', async () => {
    const publicCg = 'selected-multi-pass-metadata';
    const manifest = snapshotManifest(publicCg, 3);
    const firstPrefix = manifest.meta.slice(0, 4);
    const finalSuffix = manifest.meta.slice(4);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: finalSuffix,
          resumedFromOffset: firstPrefix.length,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          stopOnBackoffWorthyFailure: true,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(2);
      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(harness.probes.metaRequesterScopes[0]).toMatch(/^selected-swm-meta:\d+$/);
      expect(harness.probes.metaRequesterScopes[1]).toBe(
        harness.probes.metaRequesterScopes[0],
      );
      expect(harness.probes.metaSinceBatchIds).toEqual([undefined, undefined]);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.timedOutPhases).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(classifySharedMemoryFreshness(summary).timedOut).toBe(false);
      expect(summary.swmCoverage).toMatchObject({
        contextGraphId: publicCg,
        snapshotsResolved: 3,
        snapshotsTotal: 3,
        missingCount: 0,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('treats a responder restart as a new progress generation and completes its replacement prefix', async () => {
    const publicCg = 'selected-restarted-metadata-generation';
    const manifest = snapshotManifest(publicCg, 3);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: manifest.meta.slice(0, 2),
          resumedFromOffset: 0,
          nextOffset: 14_000,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(0, 2),
          resumedFromOffset: 0,
          nextOffset: 5_000,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(2),
          resumedFromOffset: 5_000,
          nextOffset: 19_000,
          completed: true,
          timedOut: false,
        },
      ],
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.publicAdmissions()).toBe(3);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(2);
      expect(summary.metadataContinuationYields).toBe(2);
      expect(summary.resolvedMetadataContinuationYields).toBe(2);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 3,
        snapshotsTotal: 3,
        missingCount: 0,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('drops a full old prefix and retries once when a fresh responder generation replaces it', async () => {
    const publicCg = 'selected-full-prefix-fresh-generation';
    const manifest = snapshotManifest(publicCg, 1);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaContinuationLimits: { rows: manifest.meta.length, bytesEstimate: 1024 * 1024 },
      metaPages: [
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 14_000,
          completed: false,
          timedOut: true,
        },
        {
          // The old prefix owns the entire row allowance, so this first fresh
          // replacement attempt proves the restart by hitting the zero append
          // cap. The requester must discard the old generation and retry.
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 2,
          completed: true,
          timedOut: false,
          responderSessionStartedFresh: true,
        },
        {
          quads: manifest.meta,
          resumedFromOffset: 0,
          nextOffset: 2,
          completed: true,
          timedOut: false,
          responderSessionStartedFresh: true,
        },
      ],
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(3);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.metadataContinuationYields).toBe(1);
      expect(summary.resolvedMetadataContinuationYields).toBe(1);
      expect(summary.failedPhases).toBe(0);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('isolates overlapping selected invocations with unique requester scopes', async () => {
    const publicCg = 'selected-overlap-isolation';
    const manifest = snapshotManifest(publicCg, 0);
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      onMetaFetch: ({ fetch }) => {
        if (fetch === 2) releaseBoth();
        return bothStarted;
      },
    });
    const plan = {
      publicContextGraphIds: [publicCg],
      privateRecoverFromCurator: [],
      eligibleContextGraphIds: [publicCg],
    };

    try {
      await Promise.all([
        callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: plan,
        }),
        callSyncSharedMemoryFromPeerDetailed(harness.agent, [publicCg], {
          selectedSwmPriority: true,
          priority: 2_001,
          sharedMemorySyncPlan: plan,
        }),
      ]);

      expect(harness.probes.metaRequesterScopes).toHaveLength(2);
      expect(new Set(harness.probes.metaRequesterScopes).size).toBe(2);
      expect(harness.probes.metaSinceBatchIds).toEqual([undefined, undefined]);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('fails closed when a retained metadata prefix exceeds the local resource budget', async () => {
    const publicCg = 'selected-metadata-resource-cap';
    const manifest = snapshotManifest(publicCg, 2);
    const onMetaFetch = vi.fn();
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaContinuationLimits: { rows: 1, bytesEstimate: 1024 * 1024 },
      onMetaFetch,
      metaPages: [{
        quads: manifest.meta.slice(0, 2),
        resumedFromOffset: 0,
        nextOffset: 2,
        completed: false,
        timedOut: true,
      }],
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(1);
      expect(onMetaFetch).toHaveBeenCalledWith(expect.objectContaining({
        maxAcceptedQuads: 1,
        maxAcceptedHeapBytesEstimate: 1024 * 1024,
      }));
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(summary.failedPhases).toBe(1);
      expect(summary.continuationPasses).toBe(0);
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('reuses a complete retained manifest when a later aggregate-data phase fails', async () => {
    const publicCg = 'selected-complete-metadata-reuse';
    const manifest = snapshotManifest(publicCg, 3);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 61_000 },
      dataFailuresBeforeSuccess: 1,
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.publicAdmissions()).toBe(2);
      expect(harness.probes.metaFetches()).toBe(1);
      expect(harness.probes.dataFetches()).toBe(2);
      expect(harness.probes.processedMetaBatches).toEqual([manifest.meta]);
      expect(summary.continuationPasses).toBe(1);
      expect(summary.swmCoverage).toMatchObject({
        snapshotsResolved: 3,
        snapshotsTotal: 3,
      });
      expect(harness.agent.syncCheckpoints.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('fails closed instead of splicing a tail from an incompatible metadata offset', async () => {
    const publicCg = 'selected-metadata-offset-mismatch';
    const manifest = snapshotManifest(publicCg, 3);
    const firstPrefix = manifest.meta.slice(0, 4);
    const harness = createSelectedSwmLifecycleHarness({
      contextGraphs: { public: publicCg },
      manifest,
      clock: { now: () => 1_000, deadline: () => 1_001 },
      metaPages: [
        {
          quads: firstPrefix,
          resumedFromOffset: 0,
          nextOffset: firstPrefix.length,
          completed: false,
          timedOut: true,
        },
        {
          quads: manifest.meta.slice(1),
          resumedFromOffset: 1,
          nextOffset: manifest.meta.length,
          completed: true,
          timedOut: false,
        },
      ],
    });

    try {
      const summary = await callSyncSharedMemoryFromPeerDetailed(
        harness.agent,
        [publicCg],
        {
          selectedSwmPriority: true,
          priority: 2_000,
          stopOnBackoffWorthyFailure: true,
          sharedMemorySyncPlan: {
            publicContextGraphIds: [publicCg],
            privateRecoverFromCurator: [],
            eligibleContextGraphIds: [publicCg],
          },
        },
      );

      expect(harness.probes.metaFetches()).toBe(2);
      expect(harness.probes.processedMetaBatches).toEqual([]);
      expect(summary.failedPhases).toBe(1);
      expect(summary.swmCoverage).toBeUndefined();
      expect(harness.agent.syncCheckpoints.size).toBe(0);
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

  it('does not hide an unrelated shared-memory phase failure', async () => {
    const contextGraphId = 'selected-with-unrelated-failure';
    const onPeerSynced = vi.fn();
    const shared = {
      ...result(contextGraphId, 3, 3),
      failedPhases: 2,
      snapshotPlaneIncomplete: 1,
      resolvedSnapshotPlaneIncomplete: 1,
    };

    await runSyncOnConnect({
      remotePeer: PEER,
      syncingPeers: new Set(),
      getPeerProtocols: async () => [PROTOCOL_SYNC],
      knownCorePeerIds: new Set(),
      knownCorePeerIdsV2: new Set(),
      getSyncContextGraphs: () => [],
      getDurableSyncContextGraphs: () => [],
      getSharedMemorySyncContextGraphs: () => [contextGraphId],
      getPrioritySharedMemorySyncContextGraphs: () => [contextGraphId],
      syncFromPeer: async () => 0,
      refreshMetaSyncedFlags: async () => undefined,
      discoverContextGraphsFromStore: async () => 0,
      syncSharedMemoryFromPeer: async () => shared,
      onPeerSynced,
      logInfo: () => {},
    });

    expect(onPeerSynced).toHaveBeenCalledWith(PEER, {
      fresh: false,
      progress: true,
    });
  });
});
