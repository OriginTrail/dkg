import { vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type {
  SharedMemorySyncResult,
  SwmSnapshotCoverage,
} from '../src/dkg-agent-types.js';
import type {
  SelectedSharedMemoryRequestedScope,
  SelectedSharedMemorySyncResult,
} from '../src/sync/shared-memory-freshness.js';
import type { Rfc64SwmRecoveryTargetV1 } from '../src/rfc64/swm-recovery-plan-v1.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  type SelectedSwmMetaContinuation,
} from '../src/sync/selected-swm-meta-fetcher.js';
import { SelectedSwmMetaTransferCoordinator } from '../src/sync/selected-swm-meta-transfer-coordinator.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';
import {
  SyncPageAccumulationLimitError,
  type SyncPageFetchOptions,
} from '../src/sync/requester/page-fetch.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';

export const PEER = '12D3KooWSelectedCompleteSwmProvider';

export const DKG = 'http://dkg.io/ontology/';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export function snapshotManifest(contextGraphId: string, count: number): {
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

export function graphBackedManifest(contextGraphId: string): ReturnType<typeof snapshotManifest> {
  const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  const kaUal = 'did:dkg:testnet:20430/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1';
  const assertionVersion = 1;
  const shareOperationId = 'graph-backed-selected-op';
  const operationSubject = `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
  const headSubject = `${kaUal}#dkg-swm-head`;
  const assertionGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(kaUal, assertionVersion),
  );
  const snapshotGraph = `did:dkg:context-graph:${encodeURIComponent(contextGraphId)}`
    + `/_shared_memory_snapshots/_/${encodeURIComponent(shareOperationId)}/ka`;
  const payload: Quad[] = [{
    subject: 'urn:selected-graph-backed',
    predicate: 'http://schema.org/value',
    object: '"missing-from-response"',
    graph: '',
  }];
  const digest = workspacePublicQuadsDigest(payload);
  const meta: Quad[] = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId,
      contextGraphId,
      kaUal,
      assertionVersion,
      publicTripleCount: payload.length,
      privateTripleCount: 0,
      publisherPeerId: PEER,
      timestamp: new Date(0),
    }, metaGraph),
    {
      subject: operationSubject,
      predicate: `${DKG}publicQuadsDigest`,
      object: `"${digest}"`,
      graph: metaGraph,
    },
    {
      subject: operationSubject,
      predicate: `${DKG}publicSnapshotGraph`,
      object: snapshotGraph,
      graph: metaGraph,
    },
    {
      subject: headSubject,
      predicate: `${DKG}contentScopeVersion`,
      object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    },
    { subject: headSubject, predicate: `${DKG}kaUal`, object: kaUal, graph: metaGraph },
    {
      subject: headSubject,
      predicate: `${DKG}assertionVersion`,
      object: `"${assertionVersion}"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    },
    { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
    {
      subject: headSubject,
      predicate: `${DKG}shareOperationId`,
      object: `"${shareOperationId}"`,
      graph: metaGraph,
    },
  ];
  return { meta, payloadByRef: new Map() };
}

export function cleanDurableResult(): SharedMemorySyncResult {
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

export function result(
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

export function merge(
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

export function selectedUnit(
  contextGraphId: string,
  initialResult: SharedMemorySyncResult,
  run: () => Promise<SharedMemorySyncResult>,
  metadata: {
    readonly initial?: SelectedSwmMetaContinuation;
    readonly afterRun?: () => SelectedSwmMetaContinuation;
  } = {},
) {
  const completeMetadata: SelectedSwmMetaContinuation = {
    progress: undefined,
    generation: 0,
    completed: true,
  };
  return {
    work: {
      contextGraphId,
      lane: 'shared_memory' as const,
      operationId: contextGraphId,
      run: async () => ({
        result: await run(),
        metadataContinuation: metadata.afterRun?.() ?? completeMetadata,
      }),
    },
    initialRound: {
      result: initialResult,
      metadataContinuation: metadata.initial ?? completeMetadata,
    },
  };
}

export interface SelectedProviderSelectionAgent {
  started: boolean;
  config: {
    syncOnConnect: boolean;
    syncSharedMemoryOnConnect: boolean;
    syncContextGraphs: string[];
    rfc64PublicCatalogBootstrap?: {
      acceptedPublicPolicies: Array<{
        policyEnvelope: { payload: { contextGraphId: string; accessPolicy?: 0 | 1 } };
        completeSwmProviders: string[];
      }>;
    };
    rfc64CatalogBootstrap?: {
      acceptedPolicies: Array<{
        policyEnvelope: { payload: { contextGraphId: string; accessPolicy?: 0 | 1 } };
        completeSwmProviders: string[];
      }>;
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
  selectedSwmBootstrapAdmission: SelectedSwmBootstrapAdmission;
  rfc64SwmRecoveryCoordinatorV1: {
    admitSelectedPublic: (peerId: string, contextGraphIds: readonly string[]) => boolean;
  };
  selectedSwmBootstrapContextGraphIdsForPeer: (peerId: string) => readonly string[];
  getPeerProtocols: () => Promise<string[]>;
  planSharedMemorySyncContextGraphs: (
    peerId?: string,
    contextGraphIds?: readonly string[],
  ) => Promise<{
    targets: readonly Rfc64SwmRecoveryTargetV1[];
  }>;
  resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => string[];
  syncFromPeerDetailed: () => Promise<number>;
  refreshMetaSyncedFlags: () => Promise<void>;
  discoverContextGraphsFromStore: () => Promise<number>;
  syncSharedMemoryFromPeerDetailed: (
    peerId: string,
    contextGraphIds: readonly string[],
  ) => Promise<SharedMemorySyncResult>;
  syncSelectedSharedMemoryFromPeerDetailed: (
    peerId: string,
    contextGraphIds: readonly string[],
    options: {
      selectedSwmPriority: true;
      requestedScope: SelectedSharedMemoryRequestedScope;
    },
  ) => Promise<SelectedSharedMemorySyncResult>;
  log: { info: () => void; warn: () => void; debug: () => void };
  getSelectedSwmMetaTransfers: () => SelectedSwmMetaTransferCoordinator;
  closeSelectedSwmMetaTransfers: () => Promise<void>;
}

export async function callTrySyncFromPeer(
  this: SelectedProviderSelectionAgent,
  remotePeer: string,
  onSyncAccounting?: (outcome: {
    reconcilerDisposition: 'clear' | 'retry' | 'defer';
    fresh: boolean;
    progress: boolean;
  }) => void,
): Promise<unknown> {
  const agent = this as SelectedProviderSelectionAgent & {
    trySelectedSwmRetryFromPeer:
      typeof LifecycleSyncMethods.prototype.trySelectedSwmRetryFromPeer;
    trySyncFromPeer: typeof LifecycleSyncMethods.prototype.trySyncFromPeer;
    subscribedContextGraphs: Map<string, unknown>;
    getSyncReconcilerProbe: () => Promise<{
      protocolsKey: string | null;
      connectionKey: string | null;
    }>;
    resolveRfc64CatalogReceiverAuthorityV1: () => { legacySyncAllowed: boolean };
    recordSyncReconcilerFailure: (peerId: string) => void;
  };
  agent.trySelectedSwmRetryFromPeer = LifecycleSyncMethods.prototype.trySelectedSwmRetryFromPeer;
  agent.trySyncFromPeer = LifecycleSyncMethods.prototype.trySyncFromPeer;
  agent.subscribedContextGraphs ??= new Map();
  agent.getSyncReconcilerProbe = async () => ({
    protocolsKey: null,
    connectionKey: null,
  });
  agent.resolveRfc64CatalogReceiverAuthorityV1 = () => ({ legacySyncAllowed: true });
  agent.recordSyncReconcilerFailure ??= () => {};
  const applyAccounting = agent.applySyncOnConnectAccounting;
  if (onSyncAccounting) {
    agent.applySyncOnConnectAccounting = (
      _peerId: string,
      outcome: Parameters<typeof onSyncAccounting>[0],
    ) => { onSyncAccounting(outcome); };
  }
  const runner = (
    LifecycleSyncMethods.prototype as unknown as {
      createSyncOnConnectPeerJobRunner: (
        this: SelectedProviderSelectionAgent,
        peerId: string,
        options: {
          initialProbe: { protocolsKey: string | null; connectionKey: string | null };
        },
      ) => {
        runAutomaticSelectedThenOrdinary: () => Promise<unknown>;
        finish: () => void;
      };
    }
  ).createSyncOnConnectPeerJobRunner.call(agent, remotePeer, {
    initialProbe: { protocolsKey: null, connectionKey: null },
  });
  try {
    return await runner.runAutomaticSelectedThenOrdinary();
  } finally {
    runner.finish();
    agent.applySyncOnConnectAccounting = applyAccounting;
  }
}

export interface AdmissionProbe {
  readonly contextGraphId: string;
  readonly selected: boolean;
  readonly priority: number | undefined;
  readonly event: 'start' | 'end';
}

export interface SelectedSwmLifecycleHarnessOptions {
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
  /**
   * RFC-64 complete providers accepted for the selected public scope.
   * Defaults to [PEER] because this harness models the selected RFC-64 lane;
   * pass [] explicitly when testing ordinary public SWM behavior.
   */
  readonly completeSwmProviders?: readonly string[];
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
    readonly globalRows?: number;
    readonly globalBytesEstimate?: number;
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
  /** Mirror the production verifier's empty-batch classification. */
  readonly reportEmptyResponse?: boolean;
  /** Override the aggregate data phase to exercise incomplete empty rounds. */
  readonly dataPage?: {
    readonly quads?: readonly Quad[];
    readonly completed: boolean;
    readonly timedOut: boolean;
  };
}

export interface SelectedSwmLifecycleAgentFixture {
  config: {
    syncContextGraphPriorities: Readonly<Record<string, number>>;
    syncResponderSnapshotLimits?: {
      global?: { rows?: number; bytesEstimate?: number };
      local?: { rows?: number; bytesEstimate?: number };
    };
  };
  selectedSwmBootstrapAdmission: SelectedSwmBootstrapAdmission;
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
    options?: SyncPageFetchOptions,
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
  resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId: string) => string[];
  resolveRfc64CatalogReceiverAuthorityV1: (
    contextGraphId: string,
  ) => { legacySyncAllowed: boolean };
  syncSharedMemoryFromPeerDetailedExecution:
    typeof LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution;
}

export interface SelectedSwmLifecycleHarness {
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
    readonly metaReturnAcceptedPrefixOnRetryableTransportFailure: readonly boolean[];
    readonly maxActiveAdmissions: () => number;
  };
  readonly close: () => Promise<void>;
}

type ProductionSelectedSyncSharedMemoryOptions = Parameters<
  typeof LifecycleSyncMethods.prototype.syncSelectedSharedMemoryFromPeerDetailed
>[2];

type TestSelectedSharedMemoryRequestedScope = Pick<
  SelectedSharedMemoryRequestedScope,
  'kind'
>;

export type SelectedSyncSharedMemoryOptions = Omit<
ProductionSelectedSyncSharedMemoryOptions,
'requestedScope'
> & {
  requestedScope?: TestSelectedSharedMemoryRequestedScope;
  recoveryTargets?: readonly Rfc64SwmRecoveryTargetV1[];
};

type ProductionSyncSharedMemoryOptions = Parameters<
  typeof LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed
>[2];

export type SyncSharedMemoryOptions = NonNullable<ProductionSyncSharedMemoryOptions>;

function testRecoveryTargets(
  contextGraphIds: readonly string[],
  targets: readonly Rfc64SwmRecoveryTargetV1[] | undefined,
): readonly Rfc64SwmRecoveryTargetV1[] {
  if (targets === undefined) {
    return contextGraphIds.map((contextGraphId) => ({
      contextGraphId,
      lane: 'selected-public',
    }));
  }
  return targets;
}

export const callSelectedSharedMemoryFromPeerDetailed = (
  agent: SelectedSwmLifecycleAgentFixture,
  contextGraphIds: string[],
  options: SelectedSyncSharedMemoryOptions,
): Promise<SelectedSharedMemorySyncResult> => {
  const method = LifecycleSyncMethods.prototype.syncSelectedSharedMemoryFromPeerDetailed as unknown as (
    this: SelectedSwmLifecycleAgentFixture,
    remotePeerId: string,
    ids: string[],
    syncOptions: ProductionSelectedSyncSharedMemoryOptions,
  ) => Promise<SelectedSharedMemorySyncResult>;
  const { requestedScope, recoveryTargets, ...productionOptions } = options;
  const targets = testRecoveryTargets(contextGraphIds, recoveryTargets);
  const exactRequestedScope: SelectedSharedMemoryRequestedScope = requestedScope?.kind
    === 'rfc64-recovery-plan'
    ? {
      kind: 'rfc64-recovery-plan',
      plan: {
        kind: 'rfc64-authorized-swm-recovery-v1',
        providerPeerId: PEER,
        targets,
      },
    }
    : {
      kind: 'selected-public',
      targets: targets.filter(
        (target): target is Rfc64SwmRecoveryTargetV1 & { lane: 'selected-public' } => (
          target.lane === 'selected-public'
        ),
      ),
    };
  return method.call(agent, PEER, contextGraphIds, {
    ...productionOptions,
    requestedScope: exactRequestedScope,
  });
};

export const callSelectedSharedMemorySummary = async (
  agent: SelectedSwmLifecycleAgentFixture,
  contextGraphIds: string[],
  options: SelectedSyncSharedMemoryOptions,
): Promise<SharedMemorySyncResult> => (
  (await callSelectedSharedMemoryFromPeerDetailed(agent, contextGraphIds, options)).shared
);

export const callSyncSharedMemoryFromPeerDetailed = async (
  agent: SelectedSwmLifecycleAgentFixture,
  contextGraphIds: string[],
  options: SyncSharedMemoryOptions,
): Promise<SharedMemorySyncResult> => {
  const method = LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed as unknown as (
    this: SelectedSwmLifecycleAgentFixture,
    remotePeerId: string,
    ids: string[],
    syncOptions: NonNullable<ProductionSyncSharedMemoryOptions>,
  ) => Promise<SharedMemorySyncResult>;
  return method.call(agent, PEER, contextGraphIds, options);
};

export function createSelectedSwmLifecycleHarness(
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
  const metaReturnAcceptedPrefixOnRetryableTransportFailure: boolean[] = [];
  const processedMetaBatches: Quad[][] = [];
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(options.clock.now);
  let selectedSwmMetaTransfers: SelectedSwmMetaTransferCoordinator | undefined;

  const agent: SelectedSwmLifecycleAgentFixture = {
    config: {
      syncContextGraphPriorities: options.priorities ?? {},
      ...(options.metaContinuationLimits
        ? {
          syncResponderSnapshotLimits: {
            local: {
              rows: options.metaContinuationLimits.rows,
              bytesEstimate: options.metaContinuationLimits.bytesEstimate,
            },
            ...(options.metaContinuationLimits.globalRows !== undefined
              || options.metaContinuationLimits.globalBytesEstimate !== undefined
              ? {
                global: {
                  rows: options.metaContinuationLimits.globalRows,
                  bytesEstimate: options.metaContinuationLimits.globalBytesEstimate,
                },
              }
              : {}),
          },
        }
        : {}),
    },
    selectedSwmBootstrapAdmission: new SelectedSwmBootstrapAdmission(),
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
      fetchOptions = {},
    ) => {
      const {
        snapshotRef,
        sinceBatchId,
        requesterScope,
        maxAcceptedQuads,
        maxAcceptedHeapBytesEstimate,
        returnAcceptedPrefixOnRetryableTransportFailure,
      } = fetchOptions;
      if (phase === 'snapshot') {
        snapshotFetches.push(snapshotRef ?? 'missing-ref');
        throw new Error('all snapshot fixtures should be cache hits');
      }
      if (phase === 'meta') {
        metaFetches += 1;
        metaRequesterScopes.push(requesterScope);
        metaSinceBatchIds.push(sinceBatchId);
        metaReturnAcceptedPrefixOnRetryableTransportFailure.push(
          returnAcceptedPrefixOnRetryableTransportFailure === true,
        );
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
        if (options.dataPage) {
          return {
            quads: [...(options.dataPage.quads ?? [])],
            bytesReceived: options.dataPage.quads?.length ?? 0,
            resumedFromOffset: 0,
            nextOffset: options.dataPage.quads?.length ?? 0,
            checkpointKey: `${contextGraphId}:${phase}`,
            completed: options.dataPage.completed,
            timedOut: options.dataPage.timedOut,
          };
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
          emptyResponses: options.reportEmptyResponse
            && dataQuads.length === 0
            && metaQuads.length === 0
              ? 1
              : 0,
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
    resolveRfc64CompleteSwmProviderPeerIdsV1: (contextGraphId) => (
      contextGraphId === options.contextGraphs.public
        ? [...(options.completeSwmProviders ?? [PEER])]
        : []
    ),
    resolveRfc64CatalogReceiverAuthorityV1: () => ({ legacySyncAllowed: true }),
    syncSharedMemoryFromPeerDetailedExecution:
      LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution,
    getSelectedSwmMetaTransfers: () => {
      selectedSwmMetaTransfers ??= new SelectedSwmMetaTransferCoordinator();
      return selectedSwmMetaTransfers;
    },
    closeSelectedSwmMetaTransfers: async () => {
      const transfers = selectedSwmMetaTransfers;
      if (!transfers) return;
      await transfers.close();
      if (selectedSwmMetaTransfers === transfers) selectedSwmMetaTransfers = undefined;
    },
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
      metaReturnAcceptedPrefixOnRetryableTransportFailure,
      maxActiveAdmissions: () => maxActiveAdmissions,
    },
    close: async () => {
      dateNow.mockRestore();
      await agent.closeSelectedSwmMetaTransfers();
      await store.close();
    },
  };
}
