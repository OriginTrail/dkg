// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle + sync subsystem extracted from dkg-agent.ts as a mixin holder:
 * start() boot orchestration, random-sampling prover wiring, peer/CG sync
 * (warm-core, catchup, paged fetch, sync-verify worker), subscription-state
 * bookkeeping, and shared-memory TTL cleanup. 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { isLegacySyncGraphCandidateV1 } from './sync/legacy-sync-graph-candidate.js';
import {
  ProtocolRouter,
  GossipSubManager,
  DKGEvent,
  LibP2PNetwork,
  PeerResolver,
  StubNetworkStateRegistry,
  PROTOCOL_ACCESS,
  PROTOCOL_PUBLISH,
  PROTOCOL_SYNC,
  PROTOCOL_SYNC_POOLED,
  PROTOCOL_SYNC_CHANGELOG,
  PROTOCOL_QUERY_REMOTE,
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  PROTOCOL_GET_CIPHERTEXT_CHUNK,
  PROTOCOL_VERIFY_PROPOSAL,
  PROTOCOL_JOIN_REQUEST,
  PROTOCOL_NETWORK_IDENTITY,
  PROTOCOL_SWM_SENDER_KEY,
  PROTOCOL_SWM_UPDATE,
  PROTOCOL_SWM_SHARE_ACK,
  PROTOCOL_SWM_HOST_CATCHUP,
  PROTOCOL_MESSAGE,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  ENTITY_PRED_ALT,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  contextGraphSharedMemoryUri,
  deriveCuratorDidFromCgId,
  SYSTEM_CONTEXT_GRAPHS,
  DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  validateSubGraphName,
  createOperationContext,
  isKaPublishLifecycleDebugLoggingEnabled,
  isStorageACKDecline,
  isSafeIri,
  assertSafeIri,
  type OperationContext,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  SUBSCRIPTION_SOURCES,
  tripleContentV10,
  withRetry,
} from '@origintrail-official/dkg-core';
import type { RandomSamplingRepairOperation } from '@origintrail-official/dkg-random-sampling';
import {
  GraphManager,
  asChangelogReader,
  deleteByPatternWithoutCount,
  tryReplaceGraphAtomically,
  type ChangelogReader,
  type TripleStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { readChangelogDeltaPage } from './sync/responder/graph-plan.js';
import { decodeChangelogRequest, encodeChangelogResponse } from './sync/changelog/wire.js';
import { runChangelogSync, planPageApply } from './sync/requester/changelog-sync.js';
import {
  authenticateChallengePinnedGraphScopedAsset,
  authenticateVerifiedGraphScopedAsset,
  materializeVerifiedGraphScopedAsset,
  type ChallengePinnedGraphScopedAsset,
  type GraphScopedMaterializationOutcome,
  type VerifiedGraphScopedAsset,
  type VerifyContextGraphBinding,
} from './sync/requester/graph-scoped-materialization.js';
import {
  reconcileFinalizedSwmTwin,
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinRetirement,
} from './sync/requester/finalized-swm-twin-reconciliation.js';
import { createRpcTimeoutError, isChainRpcTransportError, type ChainAdapter } from '@origintrail-official/dkg-chain';
import {
  PublishHandler,
  ChainEventPoller,
  AccessHandler,
  PublishJournal,
  StorageACKHandler,
  createStorageAckLifecycleObserver,
  withSignerRegistrationCache,
  VerifyProposalHandler,
  parseWorkspacePublicSnapshotNQuads,
  type PhaseCallback,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import { QueryHandler, type QueryAccessConfig } from '@origintrail-official/dkg-query';

import { repairCreatorPublicMetaProjections } from './context-graph-public-meta-repair.js';
import {
  startRandomSamplingExactRepair,
  type RandomSamplingExactRepairDependencies,
  type RandomSamplingExactRepairInput,
} from './sync/recovery/random-sampling-exact-repair.js';
import {
  reconcileConfiguredContextGraphMetadataV1,
  type ConfiguredContextGraphMetadataReconciliationResult,
} from './configured-context-graph-metadata-reconciliation.js';
import { confirmContextGraphMetadataV1 } from './context-graph-meta-confirmation.js';

import { MessageHandler } from './messaging.js';
import { ed25519ToX25519Private } from './encryption.js';

import { type SignedAgentDelegation } from './auth/agent-delegation.js';
import {
  SyncVerifyWorker,
  type DurableBatchProcessResult,
  type DurableBatchVerificationMode,
} from './sync-verify-worker.js';
import { classifyDurableMetaGraph } from './sync/durable-integrity.js';
import {
  bindRandomSampling,
  RandomSamplingShutdownTimeoutError,
  stopRandomSamplingHandleWithin,
} from './random-sampling-bind.js';
import {
  ensurePeerConnected as ensurePeerConnectedAtom,
  primeCatchupConnections as primeCatchupConnectionsAtom,
} from './p2p/peer-connect.js';
import { Messenger } from './p2p/messenger.js';
import { createSingleUseSyncSender } from './p2p/sync-transport.js';
import { NetworkAdmissionService } from './p2p/network-admission.js';
import {
  NetworkAdmissionCoordinator,
  NetworkAdmissionRejectedError,
} from './p2p/network-admission-coordinator.js';
import { createNetworkAdmissionRouterPolicy } from './p2p/network-admission-protocol-adapter.js';

import { BEACON_REANNOUNCE_INTERVAL_MS, DKG_CG_DISCOVERY_TOPIC } from './swm/cg-discovery-beacon.js';

import { waitForPeerProtocol } from './p2p/protocol-readiness.js';
import { orderCatchupPeers } from './p2p/peer-selection.js';
import { reconcileWarmCoreConnections, type WarmCoreAgent } from './p2p/warm-core-connections.js';
import {
  deleteSyncPageCheckpoint,
  fetchSyncPages,
  SyncPageSizeProfileCache,
  type SyncPageFetchOptions,
  type SyncPageResult,
} from './sync/requester/page-fetch.js';
import {
  createChallengePinnedExactAssetSelection,
  createUalOnlyExactAssetSelection,
  exactAssetUalsForSelection,
  exactAssetFilterKey,
  exactSyncPhaseAccumulationLimits,
  requireExactAssetSelection,
  type ExactAssetCommitment,
  type ExactAssetSelection,
} from './sync/exact-assets.js';
import { insertWithOversizeGuard, type OversizeGuardHooks } from './sync/oversize-filter.js';
import { runOversizeSweep } from './sync/oversize-sweep.js';
import {
  MemorySyncCheckpointStore,
  type SelectedSwmMetaRetentionScope,
  type SyncCheckpointScope,
} from './sync/checkpoint/state.js';
import {
  DurableRecoveryRunner,
  type DurableRecoveryExecution,
} from './sync/durable-recovery-runner.js';
export type {
  DurableRecoveryExecution,
  DurableRecoveryPeerExecution,
} from './sync/durable-recovery-runner.js';
import {
  createContextGraphSyncDeadline,
  createDurableSyncBudget,
  createDurableSyncFetchTimeoutMs,
  DURABLE_SYNC_SETTLEMENT_HEADROOM_MS,
  EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS,
  normalizeDurableSyncTimeoutMs,
} from './sync/requester/durable-sync-budget.js';
import {
  runChallengeExactAssetFetch,
  runDurableSync,
  runDurableSyncDetailed,
  type ChallengeExactAssetFetchContext,
  type DurableMetaContinuation,
  type DurableSyncContext,
  type VerifiedFullSnapshot,
} from './sync/requester/durable-sync.js';
import { createGraphScopedPhysicalOperationFence } from './sync/requester/graph-scoped-operation-fence.js';
import {
  mergeExactDurableFetchDisposition,
  type ExactDurableFetchDisposition,
} from './sync/requester/exact-durable-fetch.js';
import { resolveSyncAgentsMeta, shouldWithholdAgentsDurableMeta } from './sync/agents-meta-policy.js';
import {
  createSelectedSwmMetaRetentionBudget,
  type SelectedSwmMetaRetentionLimits,
} from './sync/selected-swm-meta-budget.js';
import {
  runSharedMemorySync,
  selectSwmSnapshotCoverage,
  sharedMemoryOwnershipKeyFromGraph,
} from './sync/requester/shared-memory-sync.js';
import {
  createSelectedSwmMetaFetcher,
  type SelectedSwmMetaFetcher,
} from './sync/selected-swm-meta-fetcher.js';
import { createSharedMemorySnapshotMaterializer } from './sync/requester/swm-snapshot-materializer.js';
import {
  runOrderedContextGraphSyncs,
  type ContextGraphSyncWork,
} from './sync/requester/ordered-sync.js';
import {
  recoverContextGraphSwm,
  recoverContextGraphSwmWithProgressRetries,
  type RecoverContextGraphSwmResult,
} from './sync/requester/swm-recovery.js';
import { type SyncPhase } from './sync/auth/request-build.js';

import {
  registerSyncHandler,
  resolveSyncResponderSnapshotPolicy,
} from './sync/responder/sync-handler.js';
import {
  runSelectedSharedMemoryRetry,
  runSyncOnConnect,
  SyncOnConnectPostSyncError,
  type SyncOnConnectOutcome,
  type SyncOnConnectPeerOutcome,
} from './sync/on-connect/sync-on-connect.js';
import {
  SyncOnConnectPeerScheduler,
} from './sync/on-connect/peer-scheduler.js';
import {
  captureSyncOnConnectAttempt,
  type SyncReconcilerAttemptOutcome,
} from './sync/on-connect/attempt-accounting.js';
import { ReconciledSyncOnConnectPeerJobRunner } from
  './sync/on-connect/peer-job-runner.js';
import type {
  SelectedSharedMemoryRequestedScope,
  SelectedSharedMemorySyncResult,
} from './sync/shared-memory-freshness.js';
import {
  formatPrivateRecoverySkip,
  planPrivateRecoverySource,
} from './sync/private-recovery-source-planner.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from './sync/catchup-concurrency.js';
import {
  FOREGROUND_CATCHUP_SYNC_PRIORITY,
  catchupAdmissionSource,
  runCatchupPlaneWithPolicy,
  runCatchupPlanesWithPolicy,
  type CatchupMode,
} from './sync/catchup-policy.js';
import {
  SwmCatchupPassTracker,
  catchupPassNowMs,
  resolveSwmCatchupPassConfig,
  runSwmCatchupContinuations,
  type CatchupPassConfig,
} from './sync/catchup-pass-policy.js';
import {
  runSelectedSwmContinuations,
  type SelectedSwmContinuationUnit,
} from './sync/selected-swm-continuation.js';
import {
  projectRfc64SelectedSwmGraphSyncStatus,
  type Rfc64SelectedSwmGraphSyncStatus,
} from './sync/selected-swm-graph-sync-status.js';
import {
  applySelectedSwmFreshnessResolution,
  mergeSharedMemoryFreshnessDiagnostics,
} from './sync/shared-memory-freshness.js';
import {
  classifyDurableProgress,
  createDurableSyncAccumulator,
  createFailedPeerDurableSyncResult,
  createIncompleteDurableSyncResult,
  durableSyncAccumulatorHasPeerTransportFailure,
  durableSyncAccumulatorHasTerminalBoundary,
  durableSyncAccumulatorFromResult,
  finalizeDurableSyncCompletion,
  markDurableTerminalBoundary,
  mergeDurableSyncAccumulatorInto,
  mergeDurableSyncResultIntoAccumulator,
  recordDurableSyncDiagnostics,
  type DurableSyncAccumulator,
} from './sync/durable-progress.js';
import {
  getSyncBackpressureSnapshot,
  getSyncBackpressureBusyError,
  resolveBooleanSwitch,
  resolveSyncReconcilerEnabled,
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from './sync/backpressure.js';
import {
  contextGraphPriority,
  countSyncPriorityClasses,
  normalizeSyncAdmissionSource,
  orderContextGraphIdsByPriority,
  syncPriorityClass,
  type SyncAdmissionSource,
} from './sync/policy.js';
import { automaticDurableSyncContextGraphs } from './sync/system-context-graph-policy.js';
import {
  activeSyncAdmissionSource,
  monotonicNowMs,
  recordSyncAttempt,
  recordSyncAttemptRequestBytes,
  recordSyncAttemptResponseBytes,
  recordSyncOperationDuration,
  recordSyncOperationRejected,
  recordSyncSingleFlightJoin,
  syncAttemptAttributes,
  syncOperationRejectionReason,
  withSyncAdmissionSource,
  type SyncAttemptOutcome,
  type SyncOperationLane,
  type SyncOperationOutcome,
  type SyncSingleFlightScope,
} from './sync/attempt-telemetry.js';

import { resolveStorageAckLifecycleAssetUalFromLocalSwm } from './storage-ack-lifecycle-identity.js';
// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
/**
 * Default cap on how many persisted context-graph subscriptions are activated
 * (gossip-subscribed + sync-tracked) on startup. A large backlog of stale
 * subscriptions otherwise fans out store-touching gossip/sync work that
 * starves authenticated store-backed routes (issue #997). Rows beyond the cap
 * remain persisted/dormant and are exposed through subscription diagnostics.
 * Override via `DKGAgentConfig.maxRehydratedContextGraphSubscriptions` (0 disables).
 */
const DEFAULT_MAX_REHYDRATED_SUBSCRIPTIONS = 64;
/** Yield to the event loop every N activations so concurrent store work can interleave. */
const REHYDRATE_THROTTLE_BATCH = 8;
// A large rootless VM snapshot may need more than one graph-aligned fetch
// window. Keep the post-approval bootstrap on the authenticated curator while
// every round makes verified progress, instead of falling into a broad peer
// scan and then waiting for an unrelated periodic reconciler. The cap is a
// hard safety bound; the no-progress guard below is the normal termination.
const MAX_POST_APPROVAL_CURATOR_SYNC_ROUNDS = 64;
/** A recovery owner stops starting new assets after this scheduling quantum. */
const DURABLE_RECOVERY_SETTLEMENT_SLICE_TIMEOUT_MS = 120_000;
/** Hard fault ceiling: maximum-size transfer plus local settlement headroom. */
const DURABLE_RECOVERY_HARD_TIMEOUT_MS =
  EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS + DURABLE_SYNC_SETTLEMENT_HEADROOM_MS;

// type alias so listPendingJoinApprovalRetries() retains its old
// public shape while it stubs out to []. PR-12 rebuilds the operator
// diagnostic surface on top of the substrate outbox and will return
// real entries with substrate-shaped metadata.
type JoinApprovalRetryEntry = {
  contextGraphId: string;
  agentAddress: string;
  attempts: number;
  firstFailureAt: number;
  nextAttemptAt: number;
  lastError: string;
};
import { multiaddr } from '@multiformats/multiaddr';

import { stripLiteral } from './dkg-agent-utils.js';
import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_PAGE_RETRY_ATTEMPTS,
  SYNC_TOTAL_TIMEOUT_MS,
  SYNC_MIN_GRAPH_BUDGET_MS,
  SYNC_PAGE_TIMEOUT_MS,
  SYNC_ROUTER_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_DELAY_MS,
  SYNC_ACCESS_DENIED_MARKER,
  DEBUG_SYNC_PROGRESS,
  DEFAULT_SWM_TTL_MS,
  SWM_CLEANUP_INTERVAL_MS,
  SYNC_DENIED_RESPONSE,
  GOSSIP_DIAL_COOLDOWN_MS,
  GOSSIP_DIAL_TIMEOUT_MS,
  CATCHUP_ON_CONNECT_COOLDOWN_MS,
  SYNC_RECONNECT_FLAP_GRACE_MS,
  RANDOM_SAMPLING_BIND_RETRY_MS,
  STORAGE_ACK_REGISTRATION_RETRY_MS,
  MESSAGE_OUTBOX_TICK_MS,
  AGENT_PROFILE_HEARTBEAT_MS,
  AGENT_PROFILE_STALE_THRESHOLD_MS,
  WARM_CORE_CONNECTIONS_ENABLED,
  WARM_CORE_RECONCILE_INTERVAL_MS,
  WARM_CORE_MAX,
  WARM_CORE_KEEPALIVE_TAG,
  WARM_CORE_DIAL_TIMEOUT_MS,
  BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
  MIN_STORAGE_ACK_REGISTRATION_RETRY_MS,
} from './dkg-agent-constants.js';
import { raceWithBootTimeout, isTransientBootChainError } from './dkg-agent-boot.js';

import {
  type RandomSamplingStartResult,
  type SyncRequestEnvelope,
  type ContextGraphSub,
  type ContextGraphSubInput,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionRehydrationStatus,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMembershipRecord,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type SwmSnapshotCoverage,
  type DKGAgentConfig,
  type ResolvedDKGAgentConfig,
  type SyncReconcilerProbe,
  type SyncReconcilerBackoff,
} from './dkg-agent-types.js';
import {
  normalizeContextGraphSubscriptionTransition,
  projectContextGraphSubscriptionPersistence,
} from './context-graph-subscription-policy.js';
import {
  authoritativeSyncPeerId,
  resolveCuratorSyncPeer,
  type SyncPeerResolution,
} from './dkg-agent-cg-resolve.js';
import { normalizeAgentDid, inferAdapterPublisherAddress } from './dkg-agent-helpers.js';

import { DKGAgentBase } from './dkg-agent-base.js';
import { VmReconcileShutdownTimeoutError } from './vm-reconcile-service.js';
import { ContextGraphMembershipPersistShutdownTimeoutError } from './context-graph-membership-persist-scheduler.js';
import type { DKGAgent } from './dkg-agent.js';

import { deterministicStartupJitterMs, scheduleAfterStartupJitter } from './startup-jitter.js';
import {
  projectContextGraphDormancy,
} from './context-graph-subscription-dormancy.js';
import {
  isRfc64PrivateRecoveryOwnerV1,
  resolveRfc64PrivateRecoveryContextGraphIdsV1,
  resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1,
  resolveRfc64SelectedRecoveryContextGraphIdsV1,
  resolveRfc64SwmRecoveryLaneV1,
  type Rfc64AuthorizedSwmRecoveryPlanV1,
  type Rfc64PeerSwmRecoveryPlanV1,
  type Rfc64SwmRecoveryTargetV1,
} from './rfc64/swm-recovery-plan-v1.js';
import {
  rfc64ExecutionPlanAllowsLegacySyncV1,
} from
  './rfc64/public-catalog-activation-config-v1.js';
import { reconcileRfc64CatalogAuthorityPlanV1 } from
  './rfc64/catalog-rollout-authority-reconciliation-v1.js';
import { initializeRfc64LegacySwmBoundaryV1 } from
  './rfc64/legacy-swm-boundary-v1.js';

const DEFAULT_HOST_MODE_RECONCILE_JITTER_RATIO = 0.15;
const RFC64_SELECTED_SWM_ADMISSION_PRIORITY = 2_000;

function resolveAgentSyncGlobalBackpressure(config: ResolvedDKGAgentConfig) {
  // `trackSyncContextGraph()` mutates this list when an Edge explicitly
  // subscribes or starts a foreground catch-up. Those operator-selected graphs
  // need the same admission guarantee as an RFC-64 pinned scope: otherwise a
  // mature Edge can fill every global slot with unrelated background VM
  // recovery and repeatedly reject the graph the user just selected.
  //
  // Keep this Edge-only. Core nodes intentionally host the public corpus and
  // grow `syncContextGraphs` through discovery; treating that all-CG inventory
  // as one selected scope would permanently reduce Core background throughput.
  const edgeSelectedContextGraphIds = (config.nodeRole ?? 'edge') === 'edge'
    ? config.syncContextGraphs ?? []
    : [];
  return resolveSyncGlobalBackpressure({
    ...config,
    selectedRecoveryContextGraphIds: [...new Set([
      ...resolveRfc64SelectedRecoveryContextGraphIdsV1(
        config.rfc64CatalogBootstrap ?? config.rfc64PublicCatalogBootstrap,
      ).filter((contextGraphId) => rfc64ExecutionPlanAllowsLegacySyncV1(
        config.rfc64CatalogExecutionPlan,
        contextGraphId,
      )),
      ...edgeSelectedContextGraphIds,
    ])],
  });
}

interface SharedMemorySyncFromPeerOptions {
  stopOnBackoffWorthyFailure?: boolean;
  sharedMemorySyncPlan?: SharedMemorySyncContextGraphPlan;
  /** Admission override for foreground catch-up. */
  priority?: number;
  /** Bounded admission origin for node-wide scheduler diagnostics. */
  source?: SyncAdmissionSource;
}

interface OrdinarySharedMemorySyncFromPeerOptions extends SharedMemorySyncFromPeerOptions {
  /** Keeps the execution boundary discriminated from the selected lane. */
  selectedSwmPriority?: false;
}

interface SelectedSharedMemorySyncFromPeerOptions extends Omit<
SharedMemorySyncFromPeerOptions,
'sharedMemorySyncPlan'
> {
  /** Selects the graph-complete RFC-64 SWM lane and its terminal verdict. */
  selectedSwmPriority: true;
  /** Exact scope whose terminal verdict generic retry accounting consumes. */
  requestedScope: SelectedSharedMemoryRequestedScope;
}

interface OrdinarySharedMemorySyncExecution {
  readonly kind: 'ordinary-shared-memory';
  readonly shared: SharedMemorySyncResult;
}

type SharedMemorySyncExecution =
  | OrdinarySharedMemorySyncExecution
  | SelectedSharedMemorySyncResult;

function sharedMemoryRecoveryTargetKey(
  target: Readonly<Rfc64SwmRecoveryTargetV1>,
): string {
  return `${target.lane}\n${target.contextGraphId}`;
}

function selectedSharedMemoryExecutionResult(
  requestedScope: SelectedSharedMemoryRequestedScope,
  shared: SharedMemorySyncResult,
  completedTargetKeys: ReadonlySet<string>,
): SelectedSharedMemorySyncResult {
  const targets = requestedScope.kind === 'rfc64-recovery-plan'
    ? requestedScope.plan.targets
    : requestedScope.targets;
  let selectedPublicCompleted = 0;
  let selectedPublicTotal = 0;
  let ordinaryPrivateCompleted = 0;
  let ordinaryPrivateTotal = 0;
  for (const target of targets) {
    const completed = completedTargetKeys.has(sharedMemoryRecoveryTargetKey(target));
    if (target.lane === 'selected-public') {
      selectedPublicTotal += 1;
      if (completed) selectedPublicCompleted += 1;
    } else {
      ordinaryPrivateTotal += 1;
      if (completed) ordinaryPrivateCompleted += 1;
    }
  }
  const scopeComplete = selectedPublicCompleted === selectedPublicTotal
    && ordinaryPrivateCompleted === ordinaryPrivateTotal;
  const base = {
    kind: 'selected-shared-memory' as const,
    shared,
    scopeComplete,
    selectedScopeComplete: scopeComplete,
    targetDiagnostics: Object.freeze({
      selectedPublic: Object.freeze({
        completed: selectedPublicCompleted,
        total: selectedPublicTotal,
      }),
      ordinaryPrivate: Object.freeze({
        completed: ordinaryPrivateCompleted,
        total: ordinaryPrivateTotal,
      }),
    }),
  };
  if (requestedScope.kind === 'rfc64-recovery-plan') {
    return { ...base, requestedScope };
  }
  return { ...base, requestedScope };
}

type InFlightSyncPageFetch = {
  promise: Promise<SyncPageResult>;
  controller: AbortController;
  waiters: number;
  /**
   * Admission source of the fetch's OWNER — metadata stored BESIDE the shared
   * promise, never part of the coalescing key. Putting it in the key would fork
   * one physical page fetch into one per trigger, which is the opposite of what
   * coalescing is for. I6 records the resulting attribution ambiguity instead.
   */
  ownerSource: SyncAdmissionSource;
};
type InFlightSyncSingleFlight = {
  promise: Promise<unknown>;
  /** Same contract as {@link InFlightSyncPageFetch.ownerSource}. */
  ownerSource: SyncAdmissionSource;
};
type ContextGraphCatchupResult = Awaited<ReturnType<DKGAgent['runCatchupOverPeers']>>;

const inFlightSyncPageFetchesByAgent = new WeakMap<DKGAgent, Map<string, InFlightSyncPageFetch>>();
const inFlightSyncSingleFlightsByAgent = new WeakMap<DKGAgent, Map<string, InFlightSyncSingleFlight>>();
const syncPageSizeProfilesByAgent = new WeakMap<DKGAgent, SyncPageSizeProfileCache>();
const alreadyMemberDelegationRefreshChains = new WeakMap<DKGAgent, Map<string, Promise<void>>>();
const durableContextGraphSyncChains = new WeakMap<DKGAgent, Map<string, Promise<void>>>();
const durableRecoveryRunnersByAgent = new WeakMap<DKGAgent, DurableRecoveryRunner>();

function durableRecoveryRunnerFor(agent: DKGAgent): DurableRecoveryRunner {
  let runner = durableRecoveryRunnersByAgent.get(agent);
  if (!runner) {
    runner = new DurableRecoveryRunner();
    durableRecoveryRunnersByAgent.set(agent, runner);
  }
  return runner;
}

async function runAlreadyMemberDelegationRefresh<T>(
  agent: DKGAgent,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let chains = alreadyMemberDelegationRefreshChains.get(agent);
  if (!chains) {
    chains = new Map<string, Promise<void>>();
    alreadyMemberDelegationRefreshChains.set(agent, chains);
  }
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  try {
    return await run;
  } finally {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  }
}

/**
 * Serialize physical durable streams for one peer + Context Graph while still
 * allowing callers with different budgets/callback semantics to run as
 * distinct operations. Responder sessions are keyed by this same identity;
 * overlapping a 120s automatic pass with a 300s recovery pass can otherwise
 * supersede the immutable snapshot, duplicate transport work, and race the
 * safe checkpoint. The wait happens outside global admission so queued work
 * does not consume one of the scarce active sync slots.
 */
async function runSerializedDurableContextGraphSync<T>(
  agent: DKGAgent,
  remotePeerId: string,
  contextGraphId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let chains = durableContextGraphSyncChains.get(agent);
  if (!chains) {
    chains = new Map<string, Promise<void>>();
    durableContextGraphSyncChains.set(agent, chains);
  }
  const key = JSON.stringify([remotePeerId, contextGraphId]);
  const previous = chains.get(key) ?? Promise.resolve();
  let started = false;
  const run = previous.catch(() => undefined).then(() => {
    if (signal?.aborted) throw asSyncFetchAbortError(signal.reason);
    started = true;
    return operation();
  });
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });
  if (!signal) return run;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // Once the operation owns the serialization turn, its admission and
      // durable phase boundaries own cancellation and atomic settlement.
      if (!started) reject(asSyncFetchAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
    void run.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function combineSyncAdmissionSignals(
  nodeStopSignal: AbortSignal | undefined,
  operationSignal: AbortSignal | undefined,
): { signal?: AbortSignal; dispose: () => void } {
  const signals = [...new Set([nodeStopSignal, operationSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  ))];
  if (signals.length <= 1) {
    return { signal: signals[0], dispose: () => {} };
  }

  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const onAbort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return { signal, onAbort };
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, onAbort } of listeners) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * Durable DATA may be intentionally tuned down for large assertion payloads,
 * but durable META is a compact proof manifest that must complete before any
 * DATA prefix can be mapped to verified graph boundaries. Keep META on the
 * negotiated byte-budget row hint while preserving the caller's DATA size.
 */
export function durableSyncRequestPageSize(
  phase: SyncPhase,
  dataPageSize: number = SYNC_REQUEST_PAGE_SIZE,
): number {
  return phase === 'meta' ? SYNC_BYTE_BUDGET_MAX_ROWS : dataPageSize;
}

function syncPageFetchCoalescingKey(params: {
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  graphUri: string;
  snapshotRef?: string;
  sinceBatchId?: string;
  recovery?: boolean;
  forceFreshSession?: boolean;
  manifestDigest?: SyncPageFetchOptions['manifestDigest'];
  assetUals?: readonly string[];
  returnAcceptedPrefixOnRetryableTransportFailure?: boolean;
  requesterScope?: SyncCheckpointScope;
  maxAcceptedQuads?: number;
  maxAcceptedHeapBytesEstimate?: number;
}): string {
  return JSON.stringify([
    params.remotePeerId,
    params.contextGraphId,
    params.includeSharedMemory,
    params.phase,
    params.graphUri,
    params.snapshotRef ?? null,
    params.sinceBatchId ?? null,
    params.recovery === true,
    params.forceFreshSession === true,
    params.manifestDigest ?? null,
    params.assetUals === undefined ? null : exactAssetFilterKey(params.assetUals),
    params.returnAcceptedPrefixOnRetryableTransportFailure === true,
    params.requesterScope ?? null,
    params.maxAcceptedQuads ?? null,
    params.maxAcceptedHeapBytesEstimate ?? null,
  ]);
}

function inFlightSyncPageFetchesFor(agent: DKGAgent): Map<string, InFlightSyncPageFetch> {
  let inFlight = inFlightSyncPageFetchesByAgent.get(agent);
  if (!inFlight) {
    inFlight = new Map();
    inFlightSyncPageFetchesByAgent.set(agent, inFlight);
  }
  return inFlight;
}

function syncPageSizeProfileCacheFor(agent: DKGAgent): SyncPageSizeProfileCache {
  let cache = syncPageSizeProfilesByAgent.get(agent);
  if (!cache) {
    cache = new SyncPageSizeProfileCache();
    syncPageSizeProfilesByAgent.set(agent, cache);
  }
  return cache;
}

/**
 * @param meta.scope Which coalescing family this key belongs to — passed
 *   explicitly rather than parsed back out of the key, so the I6 label cannot
 *   drift when a key builder is renamed. The source is NOT derived from `key`
 *   either: it is never in one.
 * @param meta.source The trigger this caller would admit under. Supplied
 *   explicitly at every generic scope because all three of them coalesce
 *   ABOVE the admission boundary — admission happens per Context Graph inside
 *   the factory — so there is no ambient source to read yet. Reading the
 *   ambient one here instead would label every join `unspecified` and quietly
 *   make I6's cross-family check unable to fire.
 */
function runSyncSingleFlight<T>(
  agent: DKGAgent,
  key: string,
  factory: () => Promise<T>,
  meta: { scope: SyncSingleFlightScope; source?: SyncAdmissionSource },
): Promise<T> {
  let inFlight = inFlightSyncSingleFlightsByAgent.get(agent);
  if (!inFlight) {
    inFlight = new Map();
    inFlightSyncSingleFlightsByAgent.set(agent, inFlight);
  }
  const { scope } = meta;
  const joinerSource = normalizeSyncAdmissionSource(meta.source ?? activeSyncAdmissionSource());
  const existing = inFlight.get(key);
  if (existing) {
    // Recorded at MAP-HIT time, before any bytes move: a join is a decision to
    // share work, and by the time the shared promise settles there is nothing
    // left to attribute.
    recordSyncSingleFlightJoin({
      scope,
      ownerSource: existing.ownerSource,
      joinerSource,
    });
    return existing.promise as Promise<T>;
  }

  // Mirrors the page-fetch map's `let entry!` idiom below: the cleanup closure
  // must compare the ENTRY it created, not the promise, so a later generation
  // for the same key cannot be evicted by an earlier one's `finally`.
  let entry!: InFlightSyncSingleFlight;
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlight.get(key) === entry) {
        inFlight.delete(key);
      }
    });
  entry = { promise, ownerSource: joinerSource };
  inFlight.set(key, entry);
  return promise;
}

function syncSingleFlightKey(scope: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ scope, ...fields });
}

function normalizedCatchupMaxPeers(maxPeers: number | undefined): number | null {
  if (maxPeers === undefined || !Number.isInteger(maxPeers) || maxPeers <= 0) return null;
  return maxPeers;
}

function contextGraphCatchupSingleFlightKey(params: {
  contextGraphId: string;
  includeSharedMemory: boolean;
  maxPeers?: number;
  peerRotationKey?: string;
  mode: CatchupMode;
}): string {
  return syncSingleFlightKey('context-graph-catchup', {
    contextGraphId: params.contextGraphId,
    includeSharedMemory: params.includeSharedMemory,
    maxPeers: normalizedCatchupMaxPeers(params.maxPeers),
    peerRotationKey: params.peerRotationKey ?? null,
    mode: params.mode,
  });
}

function durableSyncSingleFlightKey(params: {
  remotePeerId: string;
  contextGraphIds: readonly string[];
  stopOnBackoffWorthyFailure?: boolean;
  fetchTimeoutMs: number;
  authenticationTimeoutMs: number;
  syncAgentsMeta: boolean;
  hasPhaseCallback: boolean;
  hasAtomicCommitCallback: boolean;
  hasAccessDeniedCallback: boolean;
  hasSinceBatchIdResolver: boolean;
  hasSignal: boolean;
  hasCurrentFence: boolean;
  hasChallengePinnedSelection: boolean;
  exactAssetUals?: readonly string[];
  settlementSliceTimeoutMs?: number;
  priority?: number;
}): string | null {
  if (
    params.hasPhaseCallback
    || params.hasAtomicCommitCallback
    || params.hasAccessDeniedCallback
    || params.hasSinceBatchIdResolver
    || params.hasSignal
    || params.hasCurrentFence
    || params.hasChallengePinnedSelection
  ) {
    return null;
  }
  return syncSingleFlightKey('durable-sync', {
    remotePeerId: params.remotePeerId,
    contextGraphIds: params.contextGraphIds,
    stopOnBackoffWorthyFailure: params.stopOnBackoffWorthyFailure === true,
    fetchTimeoutMs: params.fetchTimeoutMs,
    authenticationTimeoutMs: params.authenticationTimeoutMs,
    syncAgentsMeta: params.syncAgentsMeta,
    exactAssetUals: params.exactAssetUals ?? null,
    settlementSliceTimeoutMs: params.settlementSliceTimeoutMs ?? null,
    priority: params.priority ?? null,
  });
}

function sharedMemorySyncSingleFlightKey(params: {
  remotePeerId: string;
  contextGraphIds: readonly string[];
  stopOnBackoffWorthyFailure?: boolean;
  targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[];
  priority?: number;
  selectedSwm: boolean;
  requestedScope: SelectedSharedMemoryRequestedScope | null;
}): string {
  return syncSingleFlightKey('shared-memory-sync', {
    remotePeerId: params.remotePeerId,
    contextGraphIds: params.contextGraphIds,
    stopOnBackoffWorthyFailure: params.stopOnBackoffWorthyFailure === true,
    targets: params.targets,
    priority: params.priority ?? null,
    selectedSwm: params.selectedSwm,
    requestedScope: params.requestedScope?.kind ?? null,
  });
}

function normalizeSyncPageFetchOptions(
  optionsOrSnapshotRef: SyncPageFetchOptions | string | undefined,
  legacySinceBatchId: string | undefined,
  legacySignal: AbortSignal | undefined,
  legacyRecovery: boolean | undefined,
  legacyForceFreshSession: boolean | undefined,
  legacyAssetUals: string[] | undefined,
): SyncPageFetchOptions {
  if (
    typeof optionsOrSnapshotRef === 'object'
    && optionsOrSnapshotRef !== null
    && !Array.isArray(optionsOrSnapshotRef)
  ) {
    if (
      legacySinceBatchId !== undefined
      || legacySignal !== undefined
      || legacyRecovery !== undefined
      || legacyForceFreshSession !== undefined
      || legacyAssetUals !== undefined
    ) {
      throw new TypeError(
        'fetchSyncPages cannot mix an options object with legacy positional modifiers',
      );
    }
    return optionsOrSnapshotRef;
  }
  if (optionsOrSnapshotRef !== undefined && typeof optionsOrSnapshotRef !== 'string') {
    throw new TypeError(
      'fetchSyncPages options must be an object or a legacy snapshotRef string',
    );
  }
  return {
    snapshotRef: optionsOrSnapshotRef,
    sinceBatchId: legacySinceBatchId,
    signal: legacySignal,
    recovery: legacyRecovery,
    forceFreshSession: legacyForceFreshSession,
    assetUals: legacyAssetUals,
  };
}

let selectedSwmMetaInvocationSequence = 0;

type SelectedSwmMetaRetentionBudget = ReturnType<
  typeof createSelectedSwmMetaRetentionBudget
>;

const selectedSwmMetaRetentionBudgets = new WeakMap<
  object,
  { signature: string; budget: SelectedSwmMetaRetentionBudget }
>();

function selectedSwmMetaRetentionBudgetFor(
  owner: object,
  limits: SelectedSwmMetaRetentionLimits,
): SelectedSwmMetaRetentionBudget {
  const signature = JSON.stringify(limits);
  const existing = selectedSwmMetaRetentionBudgets.get(owner);
  if (existing?.signature === signature) return existing.budget;
  const budget = createSelectedSwmMetaRetentionBudget(limits);
  selectedSwmMetaRetentionBudgets.set(owner, { signature, budget });
  return budget;
}

function nextSelectedSwmMetaRequesterScope(): SelectedSwmMetaRetentionScope {
  selectedSwmMetaInvocationSequence += 1;
  return `selected-swm-meta:retained:${selectedSwmMetaInvocationSequence}`;
}

function asSyncFetchAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

const DURABLE_SYNC_SETTLEMENT_HEADROOM_FRACTION = 0.2;
const DURABLE_SYNC_SETTLEMENT_HEADROOM_MAX_MS = 60_000;

function durableSyncFetchDeadline(startedAt: number, timeoutMs: number): number {
  const settlementHeadroomMs = Math.min(
    DURABLE_SYNC_SETTLEMENT_HEADROOM_MAX_MS,
    Math.floor(timeoutMs * DURABLE_SYNC_SETTLEMENT_HEADROOM_FRACTION),
    Math.max(0, timeoutMs - SYNC_MIN_GRAPH_BUDGET_MS),
  );
  return startedAt + timeoutMs - settlementHeadroomMs;
}

function createDurableSyncOperationBoundary(options: {
  totalTimeoutMs?: number;
  maximumTimeoutMs?: number;
  signal?: AbortSignal;
}): {
  deadline?: number;
  fetchDeadline?: number;
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (options.totalTimeoutMs === undefined) {
    return {
      signal: options.signal,
      dispose: () => {},
    };
  }

  const timeoutMs = normalizeDurableSyncTimeoutMs(
    options.totalTimeoutMs,
    options.maximumTimeoutMs,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const fetchDeadline = durableSyncFetchDeadline(startedAt, timeoutMs);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    asSyncFetchAbortError(options.signal?.reason),
  );
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(
      asSyncFetchAbortError(new Error(
        `Durable sync exceeded totalTimeoutMs=${timeoutMs}`,
      )),
    ),
    timeoutMs,
  );
  timeout.unref?.();

  return {
    deadline,
    fetchDeadline,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function isMissingShardingTableContractError(error: unknown): boolean {
  // The EVM adapter normalizes a missing Hub binding onto these markers.
  // Keep every other membership failure retryable because it may be a
  // transient RPC outage.
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ShardingTableStorage') && (
    message.includes('not found in Hub') || message.includes('not resolvable')
  );
}

function waitForSyncPageFetch(
  entry: InFlightSyncPageFetch,
  signal: AbortSignal | undefined,
): Promise<SyncPageResult> {
  if (signal?.aborted) return Promise.reject(asSyncFetchAbortError(signal.reason));
  entry.waiters += 1;

  return new Promise<SyncPageResult>((resolve, reject) => {
    let settled = false;
    const release = (options?: { abortSharedIfLast?: boolean; reason?: unknown }) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      entry.waiters -= 1;
      if (entry.waiters === 0 && options?.abortSharedIfLast === true && !entry.controller.signal.aborted) {
        entry.controller.abort(options.reason);
      }
    };
    const onAbort = () => {
      release({ abortSharedIfLast: true, reason: signal?.reason });
      reject(asSyncFetchAbortError(signal?.reason));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (value) => {
        release();
        resolve(value);
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}

function jitteredIntervalMs(intervalMs: number, ratio: number | undefined): number {
  const normalizedRatio =
    typeof ratio === 'number' && Number.isFinite(ratio)
      ? Math.min(1, Math.max(0, ratio))
      : DEFAULT_HOST_MODE_RECONCILE_JITTER_RATIO;
  if (normalizedRatio === 0) return intervalMs;
  const delta = intervalMs * normalizedRatio;
  return Math.max(1, Math.round(intervalMs - delta + Math.random() * delta * 2));
}

type SharedMemorySyncContextGraphPlan = {
  readonly targets: readonly Readonly<Rfc64SwmRecoveryTargetV1>[];
};

function sharedMemoryPlanContextGraphIds(
  plan: SharedMemorySyncContextGraphPlan,
): string[] {
  return plan.targets.map(({ contextGraphId }) => contextGraphId);
}

function sharedMemoryPlanTargets<Lane extends Rfc64SwmRecoveryTargetV1['lane']>(
  plan: SharedMemorySyncContextGraphPlan,
  lane: Lane,
): readonly Readonly<Rfc64SwmRecoveryTargetV1 & { readonly lane: Lane }>[] {
  return plan.targets.filter(
    (target): target is Rfc64SwmRecoveryTargetV1 & { readonly lane: Lane } => (
      target.lane === lane
    ),
  );
}

function ordinarySharedMemorySyncContextGraphPlan(
  plan: SharedMemorySyncContextGraphPlan,
  selectedPublicContextGraphIds: ReadonlySet<string>,
): SharedMemorySyncContextGraphPlan {
  const ordinaryTargets = plan.targets.filter((target) => !(
    target.lane === 'selected-public'
    && selectedPublicContextGraphIds.has(target.contextGraphId)
  ));
  return Object.freeze({
    targets: Object.freeze([...ordinaryTargets]),
  });
}

function enforceRfc64CompleteProviderAuthority(
  plan: SharedMemorySyncContextGraphPlan,
  remotePeerId: string | undefined,
  resolveCompleteProviders: (contextGraphId: string) => readonly string[],
  onRejected: (contextGraphId: string, remotePeerId: string) => void,
): SharedMemorySyncContextGraphPlan {
  if (remotePeerId === undefined) return plan;
  const rejectedContextGraphIds = new Set(
    plan.targets.filter(({ contextGraphId, lane }) => {
      const completeSwmProviders = resolveCompleteProviders(contextGraphId);
      if (completeSwmProviders.length === 0) return false;
      return lane === 'ordinary-private'
        ? !isRfc64PrivateRecoveryOwnerV1(completeSwmProviders, remotePeerId)
        : !completeSwmProviders.includes(remotePeerId);
    }).map(({ contextGraphId }) => contextGraphId),
  );
  if (rejectedContextGraphIds.size === 0) return plan;
  for (const contextGraphId of rejectedContextGraphIds) {
    onRejected(contextGraphId, remotePeerId);
  }
  return {
    targets: plan.targets.filter(
      ({ contextGraphId }) => !rejectedContextGraphIds.has(contextGraphId),
    ),
  };
}

type RecoverContextGraphSwmOptions = Parameters<typeof recoverContextGraphSwm>[0];

interface RecoverContextGraphSwmFromPeerDependencies {
  store: TripleStore;
  writeLocks: Map<string, Promise<void>>;
  listSubGraphs: (contextGraphId: string) => ReturnType<DKGAgent['listSubGraphs']>;
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: RecoverContextGraphSwmOptions['fetchSyncPages'];
  processSharedMemoryBatch: RecoverContextGraphSwmOptions['processSharedMemoryBatch'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * GH#2273 — the materializer owns BOTH the skip predicate and the
   * preserve-identity decision (one capability over one store and lock
   * map). REQUIRED at this production boundary: removing a
   * construction-site wiring is a COMPILE error.
   */
  snapshotMaterializer: NonNullable<RecoverContextGraphSwmOptions['snapshotMaterializer']>;
  recordDrops: OversizeGuardHooks['recordDrops'];
  invalidateListContextGraphsCache: () => void;
  markMetaProjectionDirty: (quads: Quad[]) => void;
  setCheckpoint: RecoverContextGraphSwmOptions['setCheckpoint'];
  deleteCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  ensureOwnedMap: RecoverContextGraphSwmOptions['ensureOwnedMap'];
  logInfo: NonNullable<RecoverContextGraphSwmOptions['logInfo']>;
  logWarn: NonNullable<RecoverContextGraphSwmOptions['logWarn']>;
  includeRootScope?: boolean;
}

export interface ContextGraphCatchupOptions {
  includeSharedMemory?: boolean;
  maxPeers?: number;
  peerRotationKey?: string;
  /**
   * Foreground mode receives scheduler priority and bounded local-deferral
   * retries. Background mode remains best-effort and never waits for capacity.
   */
  mode?: CatchupMode;
  /**
   * Bounded, METADATA-ONLY admission source, replacing the one `mode` would
   * imply. It exists because `source` is trigger attribution on some routes and
   * execution MODE on others: `catchupSourceForMode('background')` always emits
   * `catchup-background`, so VM-recovery traffic — which enters through the same
   * default-background path — was reported as ordinary background catch-up and
   * silently undercounted against the already-defined `vm-recovery` label.
   *
   * It changes NO scheduling decision (priority still follows `mode`) and it
   * MUST NOT enter any coalescing or single-flight key: two catch-ups that
   * differ only by this value are the same physical work, and forking the key
   * on it would turn a label into duplicated network traffic. Clamped to the
   * closed source set wherever it is applied.
   *
   * Post-approval curator/broadcast catch-up deliberately does NOT set it: it
   * keeps `catchup-background`, now defined as "post-approval and background
   * catch-up, after VM recovery receives its override".
   */
  sourceOverride?: SyncAdmissionSource;
}

export type DurableSyncOptions = {
  stopOnBackoffWorthyFailure?: boolean;
  /**
   * Outer wall-clock budget for the complete legacy durable operation.
   * Network transfer and post-fetch chain authentication retain separate
   * phase deadlines, but neither may extend work beyond this caller boundary.
   */
  totalTimeoutMs?: number;
  /**
   * Soft graph-settlement scheduling quantum. Once it expires, a recovery
   * finishes and checkpoints the asset already in flight, then returns before
   * starting another asset. Unlike `totalTimeoutMs`, this never aborts an
   * authentication or atomic materialization that has already started.
   */
  settlementSliceTimeoutMs?: number;
  /**
   * Cancels the whole durable operation. Paging and graph-scoped chain
   * authentication observe the signal directly; verification and atomic
   * materialization check it before any subsequent commit boundary.
   */
  signal?: AbortSignal;
  /** Internal lifecycle fence for exact VM recovery. */
  isCurrent?: () => boolean;
  /**
   * Called synchronously after graph-scoped authentication succeeds and
   * immediately before atomic materialization is dispatched. This is a
   * settlement boundary, not a generic progress callback.
   */
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  /** Atomic VM-recovery selection; challenge-pinned assets cannot omit their pins. */
  exactAssetSelection?: ExactAssetSelection;
  /** Owner-private retained META prefix for bounded durable recovery. */
  durableMetaContinuation?: DurableMetaContinuation;
  /** Admission override for foreground VM recovery. */
  priority?: number;
  /**
   * Which trigger asked for this sync. Recorded as a bounded dimension on
   * node-wide scheduler diagnostics so queue pressure can be attributed to an
   * origin.
   *
   * The closed union, so an ordinary in-process caller cannot introduce an
   * unbounded or identifier-bearing label. The catch-up Worker RPC is the one
   * path where the compile-time union guarantees nothing — a `postMessage`
   * payload is whatever crossed the wire — and that edge clamps with
   * `normalizeSyncAdmissionSource` in the CLI bridge before calling in.
   * The scheduler re-clamps anyway, as defence in depth.
   */
  source?: SyncAdmissionSource;
};

export interface ExactKnowledgeAssetSyncResult {
  readonly result: DurableSyncResult;
  readonly disposition: ExactDurableFetchDisposition;
  readonly authenticatedAssets?: readonly ChallengePinnedGraphScopedAsset[];
}

type PhysicalDurableSyncResult = {
  readonly result: DurableSyncResult;
  readonly exactFetchDisposition?: ExactDurableFetchDisposition;
  readonly authenticatedExactAssets?: readonly ChallengePinnedGraphScopedAsset[];
};

type LegacyDurableContextGraphOptions = {
  onPhase?: PhaseCallback;
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  onAccessDenied?: (contextGraphId: string) => void;
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  stopOnBackoffWorthyFailure?: boolean;
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
  fetchTimeoutMs?: number;
  exactAssetSelection?: ExactAssetSelection;
  authenticationTimeoutMs?: number;
  operationFetchDeadline?: number;
  operationDeadline?: number;
  settlementSliceTimeoutMs?: number;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  durableMetaContinuation?: DurableMetaContinuation;
};

const DURABLE_AUTHENTICATION_MAX_ATTEMPTS = 5;
const DURABLE_AUTHENTICATION_RETRY_BASE_MS = 1_000;
const DURABLE_AUTHENTICATION_RETRY_MAX_MS = 8_000;
const DURABLE_AUTHENTICATION_ATTEMPT_TIMEOUT_MS = 15_000;

function raceAuthenticationWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function runAuthenticationWithinDeadline<T>(params: {
  deadline: number;
  deadlineError: Error;
  signal?: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const { deadline, deadlineError, signal, operation } = params;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError;

  const controller = new AbortController();
  const abortFromOperation = () => controller.abort(asSyncFetchAbortError(signal?.reason));
  if (signal?.aborted) abortFromOperation();
  else signal?.addEventListener('abort', abortFromOperation, { once: true });
  const timer = setTimeout(() => controller.abort(deadlineError), remaining);
  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? deadlineError;
    }
    return await raceAuthenticationWithSignal(
      operation(controller.signal),
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromOperation);
  }
}

export async function authenticateChallengePinnedGraphScopedAssetWithinDeadline(params: {
  chain: ChainAdapter;
  asset: VerifiedGraphScopedAsset;
  commitment: ExactAssetCommitment;
  verifyContextGraphBinding: VerifyContextGraphBinding;
  authenticationDeadline: number;
  signal?: AbortSignal;
}): Promise<ChallengePinnedGraphScopedAsset> {
  const {
    chain,
    asset,
    commitment,
    verifyContextGraphBinding,
    authenticationDeadline,
    signal,
  } = params;
  const deadlineError = createRpcTimeoutError(
    `Challenge-pinned authentication for ${asset.ual} exceeded its deadline`,
  );
  const authenticated = await runAuthenticationWithinDeadline({
    deadline: authenticationDeadline,
    deadlineError,
    signal,
    operation: (authenticationSignal) => authenticateChallengePinnedGraphScopedAsset(
      chain,
      asset,
      commitment,
      verifyContextGraphBinding,
      { signal: authenticationSignal },
    ),
  });
  if (Date.now() >= authenticationDeadline) throw deadlineError;
  return authenticated;
}

async function authenticateDurableGraphScopedAsset(params: {
  chain: ChainAdapter;
  asset: VerifiedGraphScopedAsset;
  verifyContextGraphBinding: VerifyContextGraphBinding;
  deadline: number;
  signal?: AbortSignal;
  onRetry: (error: unknown, attempt: number, maxAttempts: number) => void;
}) {
  const { chain, asset, verifyContextGraphBinding, deadline, signal, onRetry } = params;
  const receivedAt = new Date();
  const deadlineError = createRpcTimeoutError(
    `Graph-scoped durable authentication for ${asset.ual} exceeded its context-graph deadline`,
  );
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError;

  const deadlineController = new AbortController();
  const abortFromOperation = () => deadlineController.abort(
    asSyncFetchAbortError(signal?.reason),
  );
  if (signal?.aborted) abortFromOperation();
  else signal?.addEventListener('abort', abortFromOperation, { once: true });
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(deadlineError),
    remaining,
  );
  try {
    return await withRetry(
      async () => {
        const attemptRemaining = deadline - Date.now();
        if (attemptRemaining <= 0) throw deadlineError;
        const attemptError = createRpcTimeoutError(
          `Graph-scoped durable authentication attempt for ${asset.ual} timed out`,
        );
        const attemptController = new AbortController();
        const abortFromDeadline = () => attemptController.abort(deadlineController.signal.reason);
        deadlineController.signal.addEventListener('abort', abortFromDeadline, { once: true });
        const attemptTimer = setTimeout(
          () => attemptController.abort(attemptError),
          Math.min(DURABLE_AUTHENTICATION_ATTEMPT_TIMEOUT_MS, attemptRemaining),
        );
        if (deadlineController.signal.aborted) abortFromDeadline();
        try {
          return await raceAuthenticationWithSignal(
            authenticateVerifiedGraphScopedAsset(
              chain,
              asset,
              verifyContextGraphBinding,
              receivedAt,
              { signal: attemptController.signal },
            ),
            attemptController.signal,
          );
        } finally {
          if (!attemptController.signal.aborted) attemptController.abort();
          clearTimeout(attemptTimer);
          deadlineController.signal.removeEventListener('abort', abortFromDeadline);
        }
      },
      {
        maxAttempts: DURABLE_AUTHENTICATION_MAX_ATTEMPTS,
        baseDelayMs: DURABLE_AUTHENTICATION_RETRY_BASE_MS,
        maxDelayMs: DURABLE_AUTHENTICATION_RETRY_MAX_MS,
        isRetryable: isChainRpcTransportError,
        signal: deadlineController.signal,
        onRetry: (attempt, _delayMs, error) => {
          onRetry(error, attempt, DURABLE_AUTHENTICATION_MAX_ATTEMPTS);
        },
      },
    );
  } catch (error) {
    if (deadlineController.signal.aborted) {
      throw deadlineController.signal.reason ?? deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abortFromOperation);
  }
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function syncReconcilerEnabled(config: DKGAgentConfig): boolean {
  return resolveSyncReconcilerEnabled(config.syncReconcilerEnabled);
}

function syncOnConnectEnabled(config: DKGAgentConfig): boolean {
  return resolveBooleanSwitch(config.syncOnConnectEnabled, 'DKG_SYNC_ON_CONNECT_ENABLED', true);
}

function durableSyncEnabled(config: DKGAgentConfig): boolean {
  return resolveBooleanSwitch(config.durableSyncEnabled, 'DKG_DURABLE_SYNC_ENABLED', true);
}

/** OT-RFC-59 responder cap on the peer-controlled raw-scan limit (DoS bound). Honest
 *  requesters send SYNC_PAGE_SIZE (500); the headroom tolerates larger legitimate pages. */
const CHANGELOG_MAX_SCAN_LIMIT = 2000;

function emptySharedMemorySyncResult(): SharedMemorySyncResult {
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
    metadataContinuationYields: 0,
    replayPhaseBytesReceived: 0,
    snapshotPhaseBytesReceived: 0,
  };
}

function mergeSharedMemorySyncResults(
  a: SharedMemorySyncResult,
  b: SharedMemorySyncResult,
): SharedMemorySyncResult {
  const swmCoverage = selectSwmSnapshotCoverage(a.swmCoverage, b.swmCoverage);
  return {
    insertedTriples: a.insertedTriples + b.insertedTriples,
    fetchedMetaTriples: a.fetchedMetaTriples + b.fetchedMetaTriples,
    fetchedDataTriples: a.fetchedDataTriples + b.fetchedDataTriples,
    insertedMetaTriples: a.insertedMetaTriples + b.insertedMetaTriples,
    insertedDataTriples: a.insertedDataTriples + b.insertedDataTriples,
    bytesReceived: a.bytesReceived + b.bytesReceived,
    resumedPhases: a.resumedPhases + b.resumedPhases,
    timedOutPhases: a.timedOutPhases + b.timedOutPhases,
    completedPhases: a.completedPhases + b.completedPhases,
    checkpointAdvances: a.checkpointAdvances + b.checkpointAdvances,
    emptyResponses: a.emptyResponses + b.emptyResponses,
    droppedDataTriples: a.droppedDataTriples + b.droppedDataTriples,
    // This accumulator is also scoped to one remote peer across several CGs.
    failedPeers: Math.max(a.failedPeers, b.failedPeers),
    failedPhases: a.failedPhases + b.failedPhases,
    deniedPhases: a.deniedPhases + b.deniedPhases,
    backoffWorthyFailures: (a.backoffWorthyFailures ?? 0) + (b.backoffWorthyFailures ?? 0),
    deferredBackpressure: (a.deferredBackpressure ?? 0) + (b.deferredBackpressure ?? 0),
    snapshotPlaneIncomplete: (a.snapshotPlaneIncomplete ?? 0) + (b.snapshotPlaneIncomplete ?? 0),
    metadataContinuationYields:
      (a.metadataContinuationYields ?? 0) + (b.metadataContinuationYields ?? 0),
    continuationPasses: (a.continuationPasses ?? 0) + (b.continuationPasses ?? 0),
    ...mergeSharedMemoryFreshnessDiagnostics(a, b),
    // The two halves of `bytesReceived`, kept apart so replay cost stays
    // measurable once passes repeat.
    replayPhaseBytesReceived: (a.replayPhaseBytesReceived ?? 0) + (b.replayPhaseBytesReceived ?? 0),
    snapshotPhaseBytesReceived:
      (a.snapshotPhaseBytesReceived ?? 0) + (b.snapshotPhaseBytesReceived ?? 0),
    // Scalars above sum; coverage does NOT. It is selected whole from one round
    // so the counts, their peer and the sample can never be spliced together
    // from different manifests — see `selectSwmSnapshotCoverage`.
    ...(swmCoverage ? { swmCoverage } : {}),
  };
}

function emptySwmRecoveryResult(): RecoverContextGraphSwmResult {
  return {
    replacedRoots: 0,
    replacedGraphs: 0,
    insertedDataQuads: 0,
    insertedMetaQuads: 0,
    droppedDataTriples: 0,
    readySnapshots: 0,
    totalSnapshots: 0,
    completed: true,
  };
}

export class LifecycleSyncMethods extends DKGAgentBase {
  async retireFinalizedSwmTwinCandidate(
    candidate: FinalizedSwmTwinRetirement,
    ctx: OperationContext,
  ): Promise<void> {
    await this.publisher.clearPublishedKnowledgeAssetSwm(
      candidate.contextGraphId,
      {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: candidate.agentAddress,
          kaNumber: candidate.kaNumber,
        },
      },
      candidate.subGraphName,
      ctx,
      candidate.kaUal,
    );
  }
  async runContextGraphSyncWithBackpressure<T>(this: DKGAgent,
    ctx: OperationContext,
    contextGraphId: string,
    /**
     * `SyncOperationLane`, NOT the wider `SyncSchedulerLane`. This is the
     * requester-side admission path, and its I4/I5 points carry `lane`
     * directly — so the two scheduler lanes it can never receive
     * (`pre_authorization`, `responder`, both owned by the responder limiter in
     * `sync/responder/sync-handler.ts`) must not be expressible here. They are
     * absent from `OPERATION_LANES`, so passing one would clamp silently to
     * `unspecified` and quietly drop that operation out of every per-lane
     * denominator. Typing it narrowly makes the compiler prove what was
     * previously only an unstated assumption.
     */
    lane: SyncOperationLane,
    label: string,
    work: () => Promise<T>,
    admission: {
      /** Admission override for foreground catch-up / VM recovery. */
      priorityOverride?: number;
      operationSignal?: AbortSignal;
      /**
       * Which trigger enqueued this admission. Typed as the closed union for
       * ordinary callers; still normalized HERE, because this is the single
       * choke point every admission passes through and a clamp that cannot be
       * bypassed is worth more than one that merely type-checks.
       */
      source?: SyncAdmissionSource;
      /** Admit the selected graph-complete RFC-64 SWM transfer into its reserved slot. */
      selectedSwmPriority?: boolean;
    } = {},
    /**
     * Nothing may follow `admission`. Typed `never[]` so a TypeScript caller passing
     * the old 7th positional `operationSignal` fails to compile, and captured at
     * runtime so a JS one fails too — see the guard below.
     */
    ...legacyPositionalArgs: never[]
  ): Promise<T> {
    // Before #2006 this took `(…, priorityOverride?: number, operationSignal?: AbortSignal)`
    // positionally. Those collapsed into one `admission` object so the new `source`
    // dimension did not become a fourth positional argument.
    //
    // TypeScript rejects the old shape, but a JS caller compiled against it would
    // pass a number here, destructure to `undefined`, and silently lose BOTH its
    // priority override AND its cancellation — an operation that ignores its abort
    // signal keeps running after the caller gave up. Losing cancellation quietly is
    // strictly worse than failing, so the old shape fails loudly.
    //
    // Deliberately NOT a compatibility shim translating the old arguments: this is an
    // internal admission helper with no caller outside `packages/agent`, and a
    // translated second shape would have to be carried and tested forever.
    // `legacyPositionalArgs` catches the shape the 6th-argument test below cannot:
    // `(…, work, undefined, signal)`. There the 6th is absent-looking and defaults to
    // `{}`, so only the presence of a 7th argument reveals that a caller still thinks
    // it is passing a cancellation signal.
    if (legacyPositionalArgs.length > 0
      || typeof admission !== 'object' || admission === null
      || typeof (admission as { aborted?: unknown }).aborted === 'boolean') {
      throw new TypeError(
        'runContextGraphSyncWithBackpressure takes a single `admission` object '
        + '({ priorityOverride, operationSignal, source, selectedSwmPriority }). The positional '
        + 'priority/signal arguments used before issue #2006 are no longer accepted, '
        + 'because ignoring them would silently drop the caller\'s cancellation.',
      );
    }
    const { priorityOverride, operationSignal, selectedSwmPriority } = admission;
    const source = normalizeSyncAdmissionSource(admission.source);
    const priority = priorityOverride
      ?? contextGraphPriority(this.config.syncContextGraphPriorities, contextGraphId);
    const admissionBoundary = combineSyncAdmissionSignals(
      this.node.stopSignal ?? undefined,
      operationSignal,
    );
    // W1 §6.4 — time the INNER closure, not the outer call. `withGlobalSyncBackpressure`
    // invokes `work()` only after `await admission.release`, so this boundary
    // excludes admission queue wait while still covering the disabled-policy
    // fast path (which emits nothing today). It encloses peer auth/fetch,
    // decode, verification and the atomic store commit, and includes nested
    // store-scheduler queueing; it excludes the per-(peer, CG) serialization
    // wait, which happens outside admission.
    //
    // `started` discriminates work that ran from work that never began: an
    // abort while queued and an abort during work both surface as AbortError,
    // and a never-started call must go to I5 rather than enter the duration
    // histogram as a 0 ms sample.
    let started = false;
    const timedWork = async (): Promise<T> => {
      started = true;
      const startedAt = monotonicNowMs();
      let outcome: SyncOperationOutcome = 'resolved';
      try {
        // The admission source becomes ambient for the whole operation here —
        // this is the single choke point every admission passes through, and it
        // has already normalized the value. Everything below (both request
        // lanes, and the changelog lane's legacy `runResync` fallback) reports
        // its attempts and bytes under this label without carrying it as a
        // parameter, so it can never reach a coalescing key.
        return await withSyncAdmissionSource(source, work);
      } catch (error) {
        // Causal, exactly like the attempt-level classifier: an operation is
        // `cancelled` only when something actually cancelled it.
        //
        // `admissionBoundary.signal` combines the node stop signal and the
        // caller's `operationSignal`, which is the whole of the cancellation
        // evidence that exists at this level, and it is read before `dispose()`
        // runs in the outer `finally`. Being the CAPTURED signal it stays
        // aborted for its lifetime, so a shutdown completing between the
        // rejection and this line cannot downgrade a real cancellation.
        //
        // An error-class predicate cannot work here for the same reason it
        // could not at I1: `ProtocolRouter` coerces a deadline `TimeoutError`
        // into an `AbortError`, and this boundary has a production path that
        // reaches it — `recoverContextGraphSwmFromPeer` runs its recovery fetch
        // inside this admission and does NOT fold a router rejection into a
        // diagnostic result, so a `swm_recovery` deadline escapes with nothing
        // aborted. Classifying that as `cancelled` exports network strain as
        // shutdown activity.
        //
        // `signal` is optional: with neither a node stop signal nor a caller
        // signal, no cancellation evidence can exist, so every failure is an
        // `error`. That is the correct reading rather than a fallback.
        outcome = Boolean(admissionBoundary.signal?.aborted) ? 'cancelled' : 'error';
        throw error;
      } finally {
        recordSyncOperationDuration({
          lane,
          source,
          outcome,
          durationMs: monotonicNowMs() - startedAt,
        });
      }
    };
    try {
      return await withGlobalSyncBackpressure(
        {
          policy: resolveAgentSyncGlobalBackpressure(this.config),
          ctx,
          label,
          contextGraphId,
          lane,
          priority,
          priorityClass: syncPriorityClass(priority),
          source,
          selectedSwmPriority,
          signal: admissionBoundary.signal,
          logInfo: (opCtx, message) => this.log.info(opCtx, message),
        },
        timedWork,
      );
    } catch (error) {
      // Rejected BEFORE the work closure ever ran: queue overflow, priority
      // displacement, or cancellation while queued. Never a 0 ms I4 sample.
      if (!started) {
        recordSyncOperationRejected({
          lane,
          source,
          reason: syncOperationRejectionReason(error),
        });
      }
      throw error;
    } finally {
      admissionBoundary.dispose();
    }
  }

  async start(this: DKGAgent): Promise<void> {
    if (this.vmReconcileShutdownBlocked) {
      throw new VmReconcileShutdownTimeoutError(DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS);
    }
    if (this.contextGraphMembershipPersistenceShutdownBlocked) {
      throw new ContextGraphMembershipPersistShutdownTimeoutError(
        DKGAgentBase.CONTEXT_GRAPH_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT_MS,
      );
    }
    if (this.started) return;
    this.contextGraphMembershipPersistence.reopen();
    this.vmReconcileRuntimeReady = false;
    this.graphScopedStoreClosed = false;
    this.coreHostRecordingGeneration += 1;
    this.coreHostRecordingsClosed = false;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    // OT-RFC-64: persistent inventory ownership and the complete bounded
    // startup purge precede node.start(), protocol registration, and every
    // network consumer. No dataDir intentionally leaves the feature dormant.
    await this.prepareRfc64PersistenceV1();
    try {
      if (
        this.config.dataDir !== undefined
        && this.rfc64PersistenceV1 !== undefined
      ) {
        await initializeRfc64LegacySwmBoundaryV1(
          this,
          this.rfc64PersistenceV1.rootPath,
          this.store,
        );
        await reconcileRfc64CatalogAuthorityPlanV1(
          this.rfc64PersistenceV1,
          this.store,
          this.config.rfc64CatalogExecutionPlan,
        );
      }
      await this.prepareFinalizationRecoveryStore();
      // One-shot resident-poison sweep (OT-RFC-56 §4.4) — BEFORE networking,
      // so the local store is clean before this node serves or syncs anything.
      // Marker-gated (runs once per data dir), never throws, no-op on stores
      // that never accepted oversized literals (Blazegraph).
      await runOversizeSweep({
        store: this.store,
        dataDir: this.config.dataDir,
        recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
        logInfo: (message) => this.log.info(ctx, message),
        logWarn: (message) => this.log.warn(ctx, message),
      });

      await this.node.start();
    } catch (cause) {
      const failures: unknown[] = [cause];
      try {
        await this.closeFinalizationRecoveryStore();
      } catch (closeCause) {
        failures.push(closeCause);
      }
      try {
        await this.closeRfc64PersistenceV1();
      } catch (closeCause) {
        failures.push(closeCause);
      }
      if (failures.length === 1) throw cause;
      throw new AggregateError(
        failures,
        'DKG node startup and persistence cleanup failed',
      );
    }
    this.started = true;
    this.openVmReconcileRotationState();
    this.finalizationRuntime.markStarted({
      localPeerId: this.peerId,
      localNodeIdentityId: this.identityId.toString(),
    });
    this.log.info(ctx, `Node started, peer ID: ${this.node.peerId.toString()}`);

    // Public definitions were historically written only to ONTOLOGY while
    // late-subscriber admission requires the canonical proof in root `_meta`.
    // Repair only graphs whose ontology creator is this exact peer. This runs
    // after libp2p has exposed the stable peer ID but before protocol handlers
    // and sync serving are registered. Foreign/discovered graphs remain
    // ineligible; conflicting local policy remains fail-closed.
    try {
      const repaired = await repairCreatorPublicMetaProjections(
        this.store,
        this.node.peerId.toString(),
      );
      if (repaired.repairedGraphs > 0) {
        this.log.info(
          ctx,
          `Repaired authoritative public metadata for ${repaired.repairedGraphs} creator-owned context graph(s) (${repaired.insertedTriples} triples)`,
        );
      }
      if (repaired.conflictingGraphs.length > 0) {
        this.log.warn(
          ctx,
          `Skipped authoritative public metadata repair for ${repaired.conflictingGraphs.length} context graph(s) with conflicting root policy: ${repaired.conflictingGraphs.join(', ')}`,
        );
      }
    } catch (err) {
      this.log.warn(
        ctx,
        `Failed to repair creator-owned public metadata projections; continuing fail-closed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Load registered agents from triple store; auto-register default if none exist.
    // loadAgentsFromStore restores defaultAgentAddress from the persisted
    // isDefaultAgent marker, avoiding reliance on SPARQL result ordering.
    await this.loadAgentsFromStore();
    if (this.localAgents.size === 0) {
      await this.autoRegisterDefaultAgent();
    }
    if (!this.defaultAgentAddress && this.localAgents.size > 0) {
      // Fallback: no persisted marker — pick first and persist for next boot
      const first = this.localAgents.values().next().value!;
      this.defaultAgentAddress = first.agentAddress;
      await this.markDefaultAgent(first.agentAddress).catch(() => {});
    }

    const network = new LibP2PNetwork(this.node);
    // Local helper: race a lookup against an optional AbortSignal so
    // an in-flight SPARQL query honours the resolver's outer deadline.
    // Codex PR #499 round 5 race: re-check signal.aborted INSIDE the
    // listener-attach Promise so we don't lose the one-shot 'abort'
    // event between the early gate and addEventListener.
    const raceAgainstAbort = <T>(lookup: Promise<T | null>, signal: AbortSignal | undefined): Promise<T | null> => {
      if (!signal) return lookup;
      return Promise.race<T | null>([
        lookup,
        new Promise<null>((resolve) => {
          if (signal.aborted) {
            resolve(null);
            return;
          }
          signal.addEventListener('abort', () => resolve(null), { once: true });
        }),
      ]);
    };

    const peerResolver = new PeerResolver({
      network,
      registry: new StubNetworkStateRegistry(),
      agentDirectory: {
        // Wraps DiscoveryClient.findAgentByPeerId in the resolver's
        // minimal AgentDirectoryLookup shape so packages/core doesn't
        // need to know about the agents-CG SPARQL surface. Replaced
        // when RFC 04 Phase 2 lands — at that point, the registry
        // step takes precedence and this fallback is rarely hit.
        //
        // Codex review feedback on PR #496 round 5: the previous
        // revision dropped `opts.signal` entirely, leaving the
        // resolver's documented cancellation guarantee unhonored at
        // the only production AgentDirectoryLookup. DiscoveryClient
        // itself doesn't (yet) accept an AbortSignal, so we honor
        // the contract at the adapter boundary instead: if the
        // signal aborts the adapter resolves to `null` immediately,
        // unblocking the resolver and the outer caller. The
        // underlying SPARQL fetch then completes in the background
        // and its result is discarded — a small leak in the abort
        // path, acceptable given:
        //   (a) it's bounded by the discovery client's own internal
        //       timeout
        //   (b) RFC 04 Phase 2 replaces this fallback path entirely
        //   (c) the alternative (refactoring DiscoveryClient end-to-
        //       end signal threading) is out of scope for this PR
        // The follow-up to plumb signals into DiscoveryClient is
        // tracked separately.
        findRelayForPeer: async (peerId, opts) => {
          if (opts?.signal?.aborted) return null;
          const lookup = this.discovery.findAgentByPeerId(peerId)
            .then((agent) => agent?.relayAddress ?? null);
          return raceAgainstAbort(lookup, opts?.signal);
        },
        // PR feat/chain-agents-cg-phonebook: richer lookup that
        // returns direct multiaddrs + relayAddress + lastSeen so the
        // resolver can prime the peerStore with current dialable
        // addrs and filter by freshness. The resolver falls through
        // to `findRelayForPeer` if this returns null.
        findAgentDialAddresses: async (peerId, opts) => {
          if (opts?.signal?.aborted) return null;
          const lookup = this.discovery.findAgentByPeerId(peerId)
            .then((agent) => {
              if (!agent) return null;
              const lastSeenMs = agent.lastSeen ? Date.parse(agent.lastSeen) : undefined;
              return {
                multiaddrs: agent.multiaddrs ?? [],
                relayAddress: agent.relayAddress,
                lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : undefined,
              };
            });
          return raceAgainstAbort(lookup, opts?.signal);
        },
      },
      agentDirectoryStaleThresholdMs: AGENT_PROFILE_STALE_THRESHOLD_MS,
      // Bootstrap is a libp2p-startup concern (`bootstrap({ list })` in
      // peerDiscovery, see node.ts) — not a per-peer resolution concern.
      // Removed here per Codex review feedback on PR #496.
      //
      // Note: `defaultPerStepTimeoutMs` is intentionally NOT wired from
      // operator config. Production callers (`connectToPeerId`, chat /
      // routed sends) always pass an explicit `perStepTimeoutMs`
      // derived from their own deadline budget, so any constructor
      // default would be a silent no-op for those paths. The
      // constructor option survives as a test-fixture surface.
      // Codex review of PR #698 round 2 caught this.
    });
    this.peerResolver = peerResolver;
    this.networkAdmission = new NetworkAdmissionService({
      networkId: this.config.networkIdentity?.networkId,
      selfPeerId: this.node.peerId.toString(),
    });
    this.networkAdmissionCoordinator = new NetworkAdmissionCoordinator({
      admission: this.networkAdmission,
      identity: this.config.networkIdentity,
      selfPeerId: this.node.peerId.toString(),
      sign: (payload) => this.wallet.sign(payload),
      sendIdentityProbe: (peerId, data, options) =>
        this.router.send(peerId, PROTOCOL_NETWORK_IDENTITY, data, options),
      getConnections: () => this.node.libp2p.getConnections() as any,
      deletePeerFromPeerStore: async (peerId) => {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        await this.node.libp2p.peerStore.delete(peerIdFromString(peerId));
      },
      cleanupRejectedPeerState: (peerId) => this.clearNetworkRejectedPeerState(peerId),
      log: this.log,
    });
    this.router = new ProtocolRouter(this.node, {
      peerResolver,
      // Both admission phases — the probing full check and the cached-verdict
      // pre-read gate — installed as one policy from one coordinator; see
      // createNetworkAdmissionRouterPolicy for why they must not be wired
      // separately.
      ...createNetworkAdmissionRouterPolicy(this.networkAdmissionCoordinator),
      admissionExemptProtocols: [PROTOCOL_NETWORK_IDENTITY],
    });
    // Default to in-memory substrate stores when no durable stores
    // are supplied. The production daemon (`cli/src/daemon/
    // lifecycle.ts`) always wires SQLite-backed stores against the
    // shared DashboardDB; the in-memory fallback exists so that
    // test fixtures and ad-hoc DKGAgent embedders get working
    // reliability semantics without having to plumb a database.
    // In-memory means: substrate works correctly within one daemon
    // lifetime, but outbox entries don't survive restart.
    // Production picks up the SQLite path via `messengerStores`.
    const idempotencyStore =
      this.config.messengerStores?.idempotencyStore ??
      new InMemoryMessageIdempotencyStore();
    const outboxStore =
      this.config.messengerStores?.outboxStore ??
      new InMemoryProtocolOutboxStore();
    this.messenger = new Messenger({
      router: this.router,
      idempotencyStore,
      outboxStore,
      // PR feat/chain-agents-cg-phonebook: stall-recovery now routes
      // through the full PeerResolver instead of raw DHT findPeer.
      // The dial fast-path (ProtocolRouter) already uses the canonical
      // PeerResolver.connect() boundary on every attempt, but the outbox
      // stall-walk (the Messenger peer-recovery scheduler) was hardcoded
      // to a DHT-only path — so an entry that timed out 5x because
      // its addresses were stale couldn't recover by consulting
      // agents-CG. Routing through PeerResolver picks up the
      // phonebook fallback automatically; the raw findPeer call
      // remains the step-2 DHT lookup inside resolve(), so we don't
      // lose any pre-existing recovery path.
      resolvePeer: async (peerId, { signal }) => {
        await peerResolver.connect(peerId, { signal }).catch(() => undefined);
      },
    });
    // A remote join handler that aborts before persisting its decision can be
    // observed by libp2p as either a stream reset or clean EOF. Treat only a
    // parseable join ACK/NACK as delivery so clean EOF/garbage retains the
    // exact envelope in the durable outbox for retry.
    this.messenger.setResponseAcceptanceValidator(PROTOCOL_JOIN_REQUEST, (response) => {
      if (response.byteLength === 0) return false;
      try {
        const body = JSON.parse(new TextDecoder().decode(response));
        return body !== null && typeof body === 'object' && typeof body.ok === 'boolean';
      } catch {
        return false;
      }
    });
    this.messenger.setOutboxResponseHandler(PROTOCOL_JOIN_REQUEST, async (result) => {
      await this.handleJoinRequestOutboxResponse(result);
    });
    this.gossip = new GossipSubManager(this.node, this.eventBus, {
      networkId: this.config.networkIdentity?.networkId,
      chainId: this.config.networkIdentity?.chainId,
      isPeerAccepted: (peerId) => this.networkAdmissionCoordinator.isAcceptedPeer(peerId),
    });
    await this.loadSwmSenderKeyState();
    await this.initializeSwmHostModeStore();
    await this.rehydrateContextGraphSubscriptions();

    this.networkAdmissionCoordinator.registerIdentityProtocol(this.router);

    // Register protocol handlers. PROTOCOL_ACCESS migrated onto the
    // Universal Messenger substrate in rc.9 PR-8 — handler is
    // registered via messenger.register so receiver-side dedup +
    // envelope unwrap happen transparently. AccessHandler's contract
    // is unchanged (it still receives the application bytes and
    // returns the application response bytes); the substrate sits
    // between it and the wire.
    const accessHandler = new AccessHandler(this.store, this.eventBus);
    this.messenger.register(PROTOCOL_ACCESS, async (data, peerId) => {
      const peerIdObj = {
        toString: () => peerId,
        toBytes: () => new Uint8Array(),
      };
      return accessHandler.handler(data, peerIdObj);
    });

    const journal = this.config.dataDir ? new PublishJournal(this.config.dataDir) : undefined;
    const publishHandler = new PublishHandler(this.store, this.eventBus, { journal });
    this.router.register(PROTOCOL_PUBLISH, publishHandler.handler);
    if (journal) {
      try {
        await publishHandler.restorePendingPublishes();
      } catch (err) {
        this.log.warn(ctx, `Journal restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cross-agent query handler (deny-by-default for security)
    const queryAccessConfig: QueryAccessConfig = this.config.queryAccess ?? {
      defaultPolicy: 'deny',
    };
    if (this.config.queryAccess?.defaultPolicy === 'public') {
      this.log.warn(ctx, 'Query access policy is "public" — all remote queries will be accepted. Set queryAccess.defaultPolicy to "deny" for stricter security.');
    }
    // #1105: even under deny-by-default, a CG whose live on-chain
    // accessPolicy is public (0) is remotely queryable — otherwise
    // `accessPolicy: "public"` at CG creation has no remote-query effect
    // and every devnet/fresh install (which ships no queryAccess config)
    // denies everything. Explicit queryAccess.contextGraphs entries still
    // override; isContextGraphPublicOnChain fails closed on any lookup
    // error, so private/curated/unregistered CGs remain denied.
    const queryRemoteHandler = new QueryHandler(this.queryEngine, queryAccessConfig, {
      isContextGraphPublic: (contextGraphId: string) =>
        this.isContextGraphPublicOnChain(contextGraphId, createOperationContext('query')),
    });
    // rc.9 PR-9: PROTOCOL_QUERY_REMOTE migrated onto the Universal
    // Messenger substrate. Wire prefix bumped to /dkg/10.0.1/* (hard
    // cutover; rc.8 ↔ rc.9 cross-version query stops working) so
    // receiver-side dedup + envelope unwrap happen transparently.
    // QueryHandler's contract is unchanged.
    this.messenger.register(PROTOCOL_QUERY_REMOTE, async (data, peerId) => {
      const peerIdObj = {
        toString: () => peerId,
        toBytes: () => new Uint8Array(),
      };
      return queryRemoteHandler.handler(data, peerIdObj);
    });
    // PROTOCOL_SWM_SENDER_KEY migrated onto the substrate in rc.9 PR-8.
    // messenger.register handles envelope unwrap + receiver dedup
    // before the in-process handleSwmSenderKeyPackage call.
    this.messenger.register(PROTOCOL_SWM_SENDER_KEY, async (data, peerId) => {
      return this.handleSwmSenderKeyPackage(data, peerId);
    });

    // rc.9 PR-C (SWM reliable fan-out plan, Step 3): NEW protocol
    // for point-to-point SWM share delivery as an alternative to
    // GossipSub's best-effort mesh. The wire bytes are the same
    // encoded workspace gossip message the gossip subscription
    // delivers (see `encodeWorkspaceGossipMessage` in publisher),
    // so we route them through the exact same in-process apply
    // path — `SharedMemoryHandler.handle()`. That means PR-A's
    // `seenShareOps` / `redundantApplies` accounting transparently
    // covers double-delivery (gossip + substrate to the same
    // peer): the second arrival just bumps `swm.redundantApplies`
    // for that cgId. No separate dedup machinery needed here.
    //
    // PR-C codex R3 (receiver ACK semantics): the substrate
    // response distinguishes three outcomes returned by
    // `handle()`:
    //   - `applied: true`         → empty Uint8Array ACK (success).
    //   - `applied: false, retryable: false` → empty Uint8Array
    //       (permanent rejection; nothing more for the sender to
    //       do — bad signature, peer not in allowlist, CAS
    //       conditions don't hold, etc. The sender drops the
    //       share, matching pre-PR-C gossip semantics where the
    //       same rejection would silently fall on the floor).
    //   - `applied: false, retryable: true`  → THROW from the
    //       handler so `messenger.sendReliable` reports the send
    //       as failed and the substrate outbox keeps the share
    //       queued for retry. Dominant production case: sender
    //       key package for the current epoch hasn't arrived
    //       yet; once it does, the same wire bytes apply on the
    //       next retry.
    // PR-D will replace the empty response with a structured ACK
    // message (SwmShareAck) carrying the outcome explicitly, so
    // the sender's quorum tracker can upgrade queued → delivered
    // after receiver-side application succeeds (rather than the
    // current proxy through substrate-level wire delivery).
    this.messenger.register(PROTOCOL_SWM_UPDATE, async (data, peerId) => this.handleSwmUpdate(data, peerId));
    // PR-C codex R7: tell Messenger that the 1-byte rejection
    // sentinel is an APP-LEVEL rejection — Messenger's
    // protocol-level `delivered` counter + latency histogram
    // (`/api/slo`'s `protocols['/dkg/10.0.1/swm-update']`) should
    // NOT bump for these responses. The application-level
    // truth (delivered vs rejected) lives in
    // `swm.substrateFanout.{delivered,rejected}`.
    // rc.9 PR-D (codex follow-up from PR-G #G1): exclude BOTH
    // the 0x01 (permanent) AND 0x02 (transient) sentinels from
    // the protocol-level `delivered` count — neither maps to an
    // application-level successful apply. The application-side
    // truth (delivered / rejected / retryable) lives in
    // `swm.substrateFanout.*`.
    this.messenger.setResponseDeliveredClassifier(
      PROTOCOL_SWM_UPDATE,
      (response) => !(response.byteLength === 1 && (response[0] === 0x01 || response[0] === 0x02)),
    );

    // rc.9 PR-D: gossip-applied share acks. Receiver-only —
    // senders don't read the response (returns empty Uint8Array
    // as a no-op ACK at the wire level). The handler simply
    // funnels arrivals into SwmAckQuorum.onAck which is the
    // source of truth for delivery quorum tracking. Decoupled
    // from the substrate path entirely: PROTOCOL_SWM_UPDATE's
    // own response is the substrate-side ack and is consumed by
    // PR-C's classifySendResult — it does NOT route through
    // SwmAckQuorum.onAck (the substrate-delivered peers are
    // pre-populated into the `acked` set at track time instead,
    // which is structurally identical and avoids a second
    // round-trip per peer).
    this.messenger.register(PROTOCOL_SWM_SHARE_ACK, (data, fromPeerId) => this.handleSwmShareAck(data, fromPeerId));

    // OT-RFC-38 LU-6: cores expose stored ciphertext envelopes to
    // members via /dkg/10.0.1/swm-host-catchup. Registered
    // unconditionally — the handler itself checks node role + host-
    // mode store presence and serves a `denied` response on edges.
    // Going through messenger.register opts into the substrate's
    // envelope versioning, idempotency cache, and `/api/slo` stats.
    this.messenger.register(PROTOCOL_SWM_HOST_CATCHUP, (data, fromPeerId) => this.handleSwmHostCatchup(data, fromPeerId));

    // OT-RFC-38 LU-11 / OT-RFC-39: per-chunk ciphertext sync verb.
    // Symmetric to PROTOCOL_SWM_HOST_CATCHUP but pulls one
    // (cgId, batchId, chunkIndex) ciphertext at a time from the
    // triple-store-backed chunk store the V2 ACK verifier reads
    // against. Registered unconditionally — the handler itself
    // gates by node role + per-CG authorization.
    this.messenger.register(PROTOCOL_GET_CIPHERTEXT_CHUNK, (data, fromPeerId) => this.handleGetCiphertextChunk(data, fromPeerId));

    // OT-RFC-64 Gate 1: wire the public author-catalog transport onto the
    // production router. Announce/fetch protocols are admission-gated like
    // every other node protocol. Dormant when no dataDir opened persistence.
    this.startRfc64CatalogRuntimeV1(ctx);

    const effectiveRole = this.config.nodeRole ?? 'edge';
    const ackSignerCandidates = this.getACKSignerCandidateWallets(ctx);
    let onChainIdentityId = 0n;
    // #894 / Codex PR #901: distinguishes a 0n identity caused by a transient
    // boot-time chain failure (RPC timeout/unreachable — recoverable, so the
    // StorageACK path must keep retrying + re-resolve once RPC returns) from
    // an intentional 0n (e.g. an edge node that never provisions on-chain — it
    // never reaches the core-only ACK block anyway). Set when the boot
    // identity block times out or errors below.
    let bootChainIdentityUnresolvedTransient = false;
    const ensureACKCandidateWalletsRegistered = async (
      attemptCtx: OperationContext,
    ): Promise<boolean> => {
      if (onChainIdentityId <= 0n || typeof this.chain.ensureOperationalWalletsRegistered !== 'function') {
        return true;
      }
      try {
        const registration = await this.chain.ensureOperationalWalletsRegistered({
          identityId: onChainIdentityId,
          additionalAddresses: ackSignerCandidates.map((wallet) => wallet.address),
        });
        if (registration.registered.length > 0) {
          this.log.info(
            attemptCtx,
            `Registered ${registration.registered.length} operational wallet(s) on-chain for ` +
            `identityId=${onChainIdentityId}`,
          );
        }
        if (registration.taken.length > 0) {
          this.log.warn(
            attemptCtx,
            `Operational wallet(s) already registered to another identity: ` +
            registration.taken.map((w) => `${w.address}->${w.identityId}`).join(', '),
          );
        }
        return true;
      } catch (err) {
        this.log.warn(
          attemptCtx,
          `Operational wallet auto-registration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    };

    // Auto-detect or register on-chain identity.
    // Edge nodes skip profile creation — they operate with agent identity only.
    if (this.chain.chainId !== 'none') {
      // #894: bound boot-time chain identity resolution so an unreachable /
      // rate-limited RPC (which the multi-RPC failover loop retries across
      // endpoints) cannot block daemon HTTP readiness past the CLI's 45s
      // ceiling. On timeout the existing catch leaves identity unresolved and
      // boot proceeds; the node serves HTTP and on-chain writes 503 at call
      // time. The 20s bound is well below 45s yet generous for a healthy chain.
      try {
        onChainIdentityId = await raceWithBootTimeout(
          this.chain.getIdentityId(),
          BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
          'boot getIdentityId',
        );
        if (onChainIdentityId === 0n && effectiveRole === 'core') {
          this.log.info(ctx, `No on-chain identity found, creating profile and staking...`);
          // Codex PR #901 round-3 :1685: do NOT race `ensureProfile()` with the
          // boot timeout — it is a mutating createProfile+stake flow that can
          // legitimately exceed 20s while the tx settles, and abandoning a live
          // staking tx (then re-calling it on retry) risks a duplicate profile /
          // double-stake. The read-side `getIdentityId()` above keeps its
          // timeout (safe to abandon); provisioning runs to completion, guarded
          // so neither boot nor the retry re-submits while one is in flight.
          onChainIdentityId = await this.provisionProfileGuarded(ctx);
          this.log.info(ctx, `On-chain profile created, identityId=${onChainIdentityId}`);
        } else if (onChainIdentityId === 0n) {
          this.log.info(ctx, `Edge node — skipping on-chain profile creation (agent identity only)`);
        } else {
          this.log.info(ctx, `On-chain identity found: identityId=${onChainIdentityId}`);
        }
      } catch (err) {
        this.log.warn(ctx, `ensureProfile error: ${err instanceof Error ? err.message : String(err)}`);
        // The recovery `getIdentityId` is only useful when the original
        // `getIdentityId` succeeded but `ensureProfile` later failed (e.g.
        // gas exhaustion / chain revert) — in that case the chain is
        // reachable and a fresh read may pick up a partially-created
        // identity. When the original itself timed out (BOOT_CHAIN_TIMEOUT,
        // see #894), the RPC is unreachable / rate-limited and a recovery
        // attempt just doubles the boot delay (40s → past the 45s harness
        // ceiling), surfacing as `Daemon did not become ready within 45s`
        // in `daemon-http-behavior-extra.test.ts`. Skip the redundant retry
        // on that path; on every other path keep the recovery behaviour.
        const bootChainTimeout =
          err instanceof Error &&
          (err as Error & { code?: string }).code === 'BOOT_CHAIN_TIMEOUT';
        if (!bootChainTimeout) {
          try {
            onChainIdentityId = await raceWithBootTimeout(
              this.chain.getIdentityId(),
              BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
              'boot getIdentityId (recovery)',
            );
            if (onChainIdentityId > 0n) {
              this.log.info(ctx, `Recovered identityId=${onChainIdentityId} after partial failure`);
            }
          } catch { /* ignore — boot proceeds with identity unresolved */ }
        }
        // The boot identity block threw. If it left identity at 0n AND the
        // failure is TRANSIENT (RPC unreachable/slow/rate-limited), flag it so
        // the StorageACK path re-resolves and recovers once the chain is back
        // (#894 / Codex PR #901). A node that genuinely has no identity resolves
        // 0n on the happy path WITHOUT throwing, leaving this false. And a
        // PERMANENT/deterministic failure (missing admin key, insufficient
        // funds, contract revert) must NOT arm the retry — otherwise the
        // StorageACK loop would re-call `ensureProfile()` every 30s forever
        // (Codex PR #901 round-3 :1714). It stays disabled and surfaces once.
        if (onChainIdentityId === 0n && isTransientBootChainError(err)) {
          bootChainIdentityUnresolvedTransient = true;
        }
      }
      if (onChainIdentityId > 0n) {
        if (effectiveRole === 'core') {
          await ensureACKCandidateWalletsRegistered(ctx);
        }

        this.publisher.setIdentityId(onChainIdentityId);
        this.log.info(ctx, `Publisher using identityId=${onChainIdentityId}`);
      } else if (effectiveRole === 'core') {
        this.log.warn(ctx, `No valid on-chain identity — on-chain publishes will be skipped`);
      }
    }

    // Register V10 StorageACK handler AFTER ensureProfile so identity is resolved.
    // Only core nodes register the StorageACK handler — edge nodes cannot
    // sign ACKs (the handler would reject immediately) and advertising the
    // protocol confuses peer-role detection based on protocol support.
    if (effectiveRole === 'core') {
      if (ackSignerCandidates.length > 0) {
        let storageACKProtocolRegistered = false;
        let storageACKFailoverInFlight = false;
        const attemptStorageACKRegistration = async (
          attemptCtx: OperationContext,
          options: { repairWallets?: boolean; allowChainReresolution?: boolean } = {},
        ): Promise<'registered' | 'retryable' | 'disabled'> => {
          if (storageACKProtocolRegistered) return 'registered';
          // #894 / Codex PR #901 (round 2): background identity re-resolution.
          // If boot left the identity unresolved because of a transient chain
          // failure (RPC timeout/unreachable), re-probe the chain — but ONLY on
          // the scheduled retry path (`allowChainReresolution`), never on the
          // first attempt awaited by `start()`. The boot path already spent its
          // chain-timeout budget resolving identity; doing another bounded
          // chain probe here would stack a third ~20s wait onto `start()` and
          // blow the 45s readiness ceiling this fix exists to protect (Codex
          // :1752). On the first attempt we return 'retryable' immediately and
          // let the unref'd retry timer do the (background) re-resolution.
          //
          // We do NOT re-probe on a settled 0n (the flag stays false), so an
          // intentional no-identity node doesn't spin the chain pointlessly.
          if (
            onChainIdentityId === 0n
            && bootChainIdentityUnresolvedTransient
            && options.allowChainReresolution === true
          ) {
            try {
              let reresolved = await raceWithBootTimeout(
                this.chain.getIdentityId(),
                BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
                'StorageACK identity re-resolution',
              );
              // Codex :1757: a brand-new core node may have hit the transient
              // failure BEFORE `ensureProfile()` ever ran, so it has no profile
              // to find. Re-probing `getIdentityId()` alone would return 0n
              // forever and the node would never provision. Once the chain is
              // reachable again, create the profile (core only) — mirroring the
              // boot-time provisioning path. Codex round-3 :1685: provision via
              // the guarded, un-raced helper so the mutating createProfile+stake
              // tx runs to completion and is never double-submitted alongside a
              // boot-path (or concurrent-retry) provisioning still in flight.
              if (reresolved === 0n && effectiveRole === 'core') {
                this.log.info(attemptCtx, `No on-chain identity after transient boot outage — creating profile and staking...`);
                reresolved = await this.provisionProfileGuarded(attemptCtx);
              }
              if (reresolved > 0n) {
                onChainIdentityId = reresolved;
                bootChainIdentityUnresolvedTransient = false;
                this.publisher.setIdentityId(onChainIdentityId);
                this.log.info(
                  attemptCtx,
                  `Recovered on-chain identity=${onChainIdentityId} for StorageACK after a transient boot-time chain failure`,
                );
              }
            } catch (err) {
              // Codex PR #901 round-4 :1838: mirror the boot-path :1714 gate on
              // the retry path. If the chain came back but provisioning then
              // failed DETERMINISTICALLY (insufficient funds / revert / admin),
              // keeping the transient flag set would re-run `ensureProfile()`
              // every interval forever. Reclassify: permanent → clear the flag
              // so the terminal branch below returns 'disabled' (surface once,
              // stop scheduling); transient → keep retrying.
              if (!isTransientBootChainError(err)) {
                bootChainIdentityUnresolvedTransient = false;
                this.log.warn(
                  attemptCtx,
                  `V10 StorageACK identity provisioning failed permanently — disabling (no further retries): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                );
              } else {
                this.log.warn(
                  attemptCtx,
                  `StorageACK identity re-resolution failed (chain still unreachable?), will retry: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          if (onChainIdentityId > 0n) {
            const registrationSucceeded = options.repairWallets === false
              ? true
              : await ensureACKCandidateWalletsRegistered(attemptCtx);
            const signerResolution = await this.resolveConfirmedACKSigner(
              onChainIdentityId,
              ackSignerCandidates,
              attemptCtx,
            );
            const ackSignerWallet = signerResolution.wallet;
            if (!ackSignerWallet) {
              return (registrationSucceeded && !signerResolution.retryable) ? 'disabled' : 'retryable';
            }

            // The V10 ACK digest includes a (chainid, kav10Address) H5 prefix
            // per KnowledgeAssetsV10.sol:362-373. Resolve both from the chain
            // adapter BEFORE constructing the handler so the handler can sign
            // digests that actually verify on-chain. The handler itself has
            // no provider-backed dependency, so both values are passed in at
            // construction.
            const chainIdForHandler = typeof this.chain.getEvmChainId === 'function'
              ? await this.chain.getEvmChainId()
              : undefined;
            const kav10AddressForHandler = typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
              ? await this.chain.getKnowledgeAssetsLifecycleAddress()
              : undefined;
            if (chainIdForHandler === undefined || kav10AddressForHandler === undefined) {
              this.log.warn(
                attemptCtx,
                `Skipping V10 StorageACK handler: chain adapter does not expose ` +
                `getEvmChainId() + getKnowledgeAssetsLifecycleAddress(); handler cannot build the ` +
                `H5-prefixed ACK digest that KnowledgeAssetsV10 verifies on-chain`,
              );
              return 'disabled';
            }

            const ackHandler = new StorageACKHandler(this.store, {
              nodeRole: effectiveRole,
              nodeIdentityId: onChainIdentityId,
              signerWallet: ackSignerWallet,
              contextGraphSharedMemoryUri,
              chainId: chainIdForHandler,
              kav10Address: kav10AddressForHandler,
              ackHandlerDeadlineMs: this.config.storageAckTiming.handlerDeadlineMs,
              // Codex review (round 2) on PR #727: must NOT collapse to a
              // plain `gossipWireIdFor` because `PublishIntent.swmGraphId`
              // may be absent on a chunked V2 intent (the handler then
              // falls back to the numeric `cgId`). Pass through
              // `canonicalChunkStoreCgIdOrNull` so numeric ids resolve via
              // the local on-chain map, and unknown shapes return null →
              // handler widens to wildcard `GRAPH ?g` instead of pinning
              // to a fabricated keccak-of-decimal-string.
              normalizeContextGraphIdForChunkStore: (rawCgId: string) =>
                this.canonicalChunkStoreCgIdOrNull(rawCgId),
              isCgCurated: (cgId: string) => this.resolveCgCurationForAck(cgId, ctx),
              // Testnet dead-air fix: `isOperationalWalletRegistered` is a
              // LIVE chain read the handler runs on EVERY inbound StorageACK.
              // With the raw wiring, one degraded shared RPC made the lookup
              // throw on every ACK on every core simultaneously — the whole
              // network stopped ACKing at once (the 21-attempts-all-
              // no_response incident). The cache wrapper serves the last
              // good verdict for 30s (no RPC per ACK in steady state) and
              // keeps serving it up to 5 min through an RPC outage;
              // registration changes are operator-driven and rare, so that
              // staleness window is safe. Both verdicts are cached — a
              // known-unregistered signer shouldn't hammer the RPC either.
              // The closure state lives (and dies) with this handler
              // registration attempt, so a signer failover / re-register
              // always starts from a fresh cache.
              isSignerRegistered: withSignerRegistrationCache(
                async () => {
                  const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
                  if (typeof isOperationalWalletRegistered !== 'function') return false;
                  return isOperationalWalletRegistered.call(
                    this.chain,
                    onChainIdentityId,
                    ackSignerWallet.address,
                  );
                },
                {
                  onServedStale: (err, staleValue) => {
                    this.log.debug?.(
                      attemptCtx,
                      `V10 StorageACK signer registration lookup failed; serving cached ` +
                      `verdict=${staleValue} for ${ackSignerWallet.address}: ` +
                      `${err instanceof Error ? err.message : String(err)}`,
                    );
                  },
                },
              ),
              onSignerUnregistered: () => {
                if (storageACKFailoverInFlight) return;
                storageACKFailoverInFlight = true;
                storageACKProtocolRegistered = false;
                // rc.9 PR-11: messenger.register stored the handler
                // in the substrate's wrapper which delegates to
                // router.register under the hood (see Messenger.register
                // implementation), so router.unregister still removes it.
                this.router.unregister(PROTOCOL_STORAGE_ACK);
                this.router.unregister(PROTOCOL_STORAGE_ACK_V2);
                this.router.unregister(PROTOCOL_STORAGE_UPDATE_ACK);
                this.router.unregister(PROTOCOL_STORAGE_UPDATE_ACK_V2);
                this.log.warn(
                  attemptCtx,
                  `Unregistered V10 StorageACK handler: signer ${ackSignerWallet.address} ` +
                  `is no longer confirmed on-chain for identity=${onChainIdentityId}`,
                );
                attemptStorageACKRegistration(
                  createOperationContext('connect'),
                  { repairWallets: false },
                )
                  .then((result) => {
                    if (result === 'retryable') {
                      scheduleStorageACKRegistrationRetry({ repairWallets: false });
                    }
                  })
                  .catch((err: unknown) => {
                    this.log.warn(
                      attemptCtx,
                      `V10 StorageACK signer failover failed: ` +
                      `${err instanceof Error ? err.message : String(err)}`,
                    );
                    scheduleStorageACKRegistrationRetry({ repairWallets: false });
                  })
                  .finally(() => {
                    storageACKFailoverInFlight = false;
                  });
              },
              onSignerRegistrationLookupFailed: (err) => {
                this.log.warn(
                  attemptCtx,
                  `V10 StorageACK signer registration lookup failed for ${ackSignerWallet.address}; ` +
                  `keeping handler active: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
              onDecline: (details) => {
                const syncPressure = getSyncBackpressureSnapshot(resolveAgentSyncGlobalBackpressure(this.config));
                const syncPressureLabel =
                  `syncGlobalInflight=${syncPressure.inflight} ` +
                  `syncGlobalQueued=${syncPressure.queued} ` +
                  `syncGlobalLimit=${syncPressure.limit ?? 'unbounded'} ` +
                  `syncGlobalQueueLimit=${syncPressure.queueLimit ?? 'unbounded'} ` +
                  `syncQueuedElevated=${syncPressure.queuedByPriorityClass.elevated} ` +
                  `syncQueuedDefault=${syncPressure.queuedByPriorityClass.default} ` +
                  `syncQueuedDeprioritized=${syncPressure.queuedByPriorityClass.deprioritized} ` +
                  `syncOldestQueuedAgeMs=${syncPressure.oldestQueuedAgeMs}`;
                this.log.warn(
                  attemptCtx,
                  `V10 StorageACK declined: code=${details.code} ` +
                  `cg=${details.contextGraphId} reason=${details.message} ${syncPressureLabel}`,
                );
              },
              onStorageAckDecision: createStorageAckLifecycleObserver({
                logger: this.log,
                localPeerId: () => this.peerId,
                localNodeIdentityId: () => onChainIdentityId,
                shouldObserve: (decision) =>
                  isKaPublishLifecycleDebugLoggingEnabled() || isStorageACKDecline(decision.ack),
                detailForDecision: (decision) =>
                  isStorageACKDecline(decision.ack) ? 'summary' : 'debug',
                resolveAssetUalForPublishIntent: ({ intent }) =>
                  resolveStorageAckLifecycleAssetUalFromLocalSwm({
                    store: this.store,
                    chain: this.chain,
                    intent,
                  }),
              }),
              // PR5 ACK-provenance — bind to the agent's host-mode
              // bookkeeping so every signed ACK carries which of the
              // four LU-6 Phase B discovery paths brought this CG's
              // hosting state up. Resolver tries each candidate id
              // because the two consulted maps are keyed differently:
              // `sharedMemoryGossipRegistered` (member-mode) uses the
              // CALLER-supplied cleartext id verbatim, while
              // `swmHostModeSubscribed` (host-mode) is canonical-keyed
              // by the wire-form hash (see `getSwmSubscriptionSource`
              // and `canonicalSwmHostModeKey`).
              //
              // PR5 (review fix #1) + PR-B Codex #672 review
              // `id=3302086589`: `getSwmSubscriptionSource` now
              // canonicalises each candidate internally before the
              // host-mode lookup, so on the host-only paths a single
              // pass through any of the four shapes (numeric / cleartext
              // / pre-canonical / hash) lands. We still hand it both
              // the cleartext and the pre-computed wire forms so the
              // MEMBER-mode `has(id)` check (which keys by cleartext)
              // gets the cleartext candidate without the canonicaliser
              // having to round-trip it. Variadic + internal `seen` Set
              // dedups, so over-passing is cheap and order-independent.
              getSubscriptionSourceForCg: (cgId, swmGraphId) => {
                // Phase D — this hook fires immediately before EVERY StorageACK
                // sign (the universal pre-sign chokepoint across the plaintext /
                // encrypted / chunked paths). Use it to record that this Core
                // hosts the CG so the chain-driven VM reconciler fills its gaps
                // across restarts. Best-effort + public-CG-gated inside the
                // helper; never blocks or affects the (sync) provenance return.
                this.trackCoreHostRecording(() => this.recordCoreHostedPublicCg(cgId, swmGraphId));
                const wireFromCgId = cgId ? this.gossipWireIdFor(cgId) : undefined;
                const wireFromSwmGraphId = swmGraphId && swmGraphId !== cgId
                  ? this.gossipWireIdFor(swmGraphId)
                  : undefined;
                return this.getSwmSubscriptionSource(
                  cgId,
                  swmGraphId,
                  wireFromCgId,
                  wireFromSwmGraphId,
                );
              },
            }, this.eventBus);
            // rc.9 PR-11: migrated onto the Universal Messenger
            // substrate (wire prefix /dkg/10.0.1/storage-ack).
            // messenger.register handles envelope decode + receiver
            // dedup; ackHandler's signature stays the same.
            this.messenger.register(PROTOCOL_STORAGE_ACK, async (data, peerIdStr) => {
              const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
              return ackHandler.handler(data, peerId);
            });
            // OT-RFC-38 LU-11 / OT-RFC-39 — V2 protocol id. Same handler
            // instance, distinct libp2p protocol. Publishers negotiate V2 for
            // chunked ciphertext commitments and folded-private field-20
            // commitments, so V1-only cores never receive intents whose new
            // fields they would silently ignore. The handler dispatches on the
            // decoded intent shape internally.
            this.messenger.register(PROTOCOL_STORAGE_ACK_V2, async (data, peerIdStr) => {
              const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
              return ackHandler.handler(data, peerId);
            });
            // V10 UPDATE StorageACK — same handler instance + config
            // (signer, chainId, kav10Address, SWM resolver, curation
            // oracle, signer-registration gate, provenance hook), distinct
            // libp2p protocol. Carries an `UpdateIntent` and binds the
            // 13-field UPDATE ACK digest. Pre-update cores never register
            // this, so an UPDATE-aware publisher gracefully falls back
            // (the dial fails as peer-unreachable against the quorum).
            this.messenger.register(PROTOCOL_STORAGE_UPDATE_ACK, async (data, peerIdStr) => {
              const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
              return ackHandler.updateHandler(data, peerId);
            });
            this.messenger.register(PROTOCOL_STORAGE_UPDATE_ACK_V2, async (data, peerIdStr) => {
              const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
              return ackHandler.updateHandler(data, peerId);
            });
            storageACKProtocolRegistered = true;
            this.clearStorageACKRegistrationRetry();
            this.log.info(
              attemptCtx,
              `Registered V10 StorageACK handler (identity=${onChainIdentityId}, signer=${ackSignerWallet.address})`,
            );
            return 'registered';
          } else if (bootChainIdentityUnresolvedTransient) {
            // #894 / Codex PR #901: identity is still 0n only because the
            // chain was unreachable at boot and the re-resolution above hasn't
            // recovered it yet. This is recoverable, so report 'retryable' —
            // the scheduled retry keeps re-probing and registers ACK once the
            // RPC returns, instead of leaving a core node permanently
            // un-advertised until restart.
            this.log.warn(attemptCtx, `Deferring V10 StorageACK handler registration — on-chain identity not yet resolved (transient chain outage at boot); will retry`);
            return 'retryable';
          } else {
            this.log.warn(attemptCtx, `Skipping V10 StorageACK handler registration — identity not yet provisioned`);
            return 'disabled';
          }
          return 'disabled';
        };

        // Codex PR #901 round-4 :2106: `storageAckRegistrationRetryMs` is a
        // public config field fed straight into `setTimeout`. Clamp it to a
        // sane floor so a 0 / negative / NaN value can't collapse the retry into
        // a tight loop that hammers the RPC and floods the log while the node is
        // unhealthy. A non-finite or too-small value falls back to the floor.
        const requestedRetryMs = this.config.storageAckRegistrationRetryMs;
        const storageACKRegistrationRetryMs =
          typeof requestedRetryMs === 'number' && Number.isFinite(requestedRetryMs)
            ? Math.max(requestedRetryMs, MIN_STORAGE_ACK_REGISTRATION_RETRY_MS)
            : STORAGE_ACK_REGISTRATION_RETRY_MS;
        const scheduleStorageACKRegistrationRetry = (options: { repairWallets?: boolean; allowChainReresolution?: boolean } = {}) => {
          if (this.storageACKRegistrationRetryTimer || storageACKProtocolRegistered) return;
          this.log.warn(ctx, `V10 StorageACK handler registration will retry every ${storageACKRegistrationRetryMs}ms`);
          this.storageACKRegistrationRetryTimer = setTimeout(() => {
            this.storageACKRegistrationRetryTimer = null;
            if (!this.started || storageACKProtocolRegistered || this.storageACKRegistrationRetryInFlight) return;
            this.storageACKRegistrationRetryInFlight = true;
            attemptStorageACKRegistration(createOperationContext('connect'), options)
              .then((result) => {
                if (result === 'retryable') scheduleStorageACKRegistrationRetry(options);
              })
              .catch((err: unknown) => {
                this.log.warn(
                  ctx,
                  `V10 StorageACK handler registration retry failed: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
                );
                scheduleStorageACKRegistrationRetry(options);
              })
              .finally(() => {
                this.storageACKRegistrationRetryInFlight = false;
              });
          }, storageACKRegistrationRetryMs);
          if (this.storageACKRegistrationRetryTimer.unref) this.storageACKRegistrationRetryTimer.unref();
        };

        try {
          // The first attempt is awaited by `start()`, so it must NOT do a
          // blocking chain re-probe (Codex :1752). It returns 'retryable'
          // immediately for a transient-0n identity; the scheduled retry then
          // runs the background re-resolution (+ ensureProfile for a brand-new
          // core node) with `allowChainReresolution: true`.
          const result = await attemptStorageACKRegistration(ctx);
          if (result === 'retryable') scheduleStorageACKRegistrationRetry({ allowChainReresolution: true });
        } catch (err) {
          this.log.warn(ctx, `Skipping V10 StorageACK handler: ${err instanceof Error ? err.message : String(err)}`);
          scheduleStorageACKRegistrationRetry({ allowChainReresolution: true });
        }
      } else if (typeof this.chain.signACKDigest === 'function') {
        this.log.info(ctx, `V10 StorageACK: adapter has signACKDigest but no extractable key — handler registration deferred until callback signing is supported`);
      }
    } else {
      this.log.info(ctx, `Node role is '${effectiveRole}' — skipping StorageACK handler registration (core-only)`);
    }

    // Register VERIFY proposal handler — responds to incoming M-of-N proposals.
    // Agents on the allowList sign the verify digest when they agree with the data.
    // Uses the ACK signer key (core nodes) or first operational key (edge nodes).
    const verifySignerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (verifySignerKey) {
      const verifyWallet = new ethers.Wallet(verifySignerKey);
      const verifyHandler = new VerifyProposalHandler({
        store: this.store,
        agentPrivateKey: verifySignerKey,
        agentAddress: verifyWallet.address,
        getBatchMerkleRoot: async (cgId: string, batchId: bigint) => {
          const metaGraph = contextGraphMetaGraphUri(cgId);
          const namespaces = ['http://dkg.io/ontology/', 'https://dkg.network/ontology#'];
          // Try typed literal first, fallback to untyped for backward compat.
          for (const ns of namespaces) {
            for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
              const result = await this.store.query(
                `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <${ns}merkleRoot> ?root . ?kc <${ns}batchId> ${literal} } } LIMIT 1`,
                { source: 'agent.verifyProposal.batchMerkleRoot' },
              );
              if (result.type === 'bindings' && result.bindings.length > 0) {
                const hex = (result.bindings[0] as Record<string, string>)['root'];
                if (!hex) return null;
                const merkleRootValue = /^"([^"]+)"/.exec(hex)?.[1] ?? hex;
                return ethers.getBytes(
                  merkleRootValue.startsWith('0x') ? merkleRootValue : `0x${merkleRootValue}`,
                );
              }
            }
          }
          return null;
        },
        getContextGraphIdOnChain: async (cgId: string) => {
          const onChainId = await this.getContextGraphOnChainId(cgId);
          return onChainId ? BigInt(onChainId) : null;
        },
      });
      // rc.9 PR-11: migrated onto the Universal Messenger substrate
      // (wire prefix /dkg/10.0.1/verify-proposal). messenger.register
      // wraps the handler with envelope decode + receiver dedup.
      this.messenger.register(PROTOCOL_VERIFY_PROPOSAL, async (data, peerIdStr) => {
        const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
        return verifyHandler.handler(data, peerId);
      });
      this.log.info(ctx, 'Registered VERIFY proposal handler');
    }

    // Start chain event poller for trustless confirmation of tentative publishes
    // and discovery of on-chain context graphs. Only with a real chain adapter.
    if (this.chain.chainId !== 'none') {
      this.chainPoller = new ChainEventPoller({
        chain: this.chain,
        publishHandler,
        cursorPersistence: this.config.chainEventCursorStore,
        onContextGraphCreated: async ({ contextGraphId, creator, accessPolicy, publishPolicy, nameHash, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain context graph ${contextGraphId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy}, publishPolicy ${publishPolicy ?? '?'}, nameHash ${nameHash ? nameHash.slice(0, 10) + '…' : '(opt-out)'})`);

          // The finalized event can arrive before or after the explicit local
          // subscription. Bind an already-indexed cleartext row immediately;
          // otherwise retain a process-local wire-only placeholder that the
          // canonical setter will promote when create/join/subscribe supplies
          // the matching cleartext id. This applies to public graphs too: they
          // do not enter the curated host-mode block below, and a cold Edge
          // must not lose its only authoritative chain-id/policy binding while
          // waiting for an ontology announcement it may have missed.
          const eventLocalId = nameHash
            ? this.stageOnChainContextGraphBindingFromNameHash(
                nameHash,
                contextGraphId,
              )
            : null;
          if (nameHash && eventLocalId === null) {
            this.log.warn(
              ctx,
              `Skipped ambiguous Context Graph name-hash binding ${nameHash.slice(0, 18)}…`,
            );
          }

          // Track the numeric on-chain id for dedup.
          const alreadyKnown = this.seenOnChainIds.has(contextGraphId)
            || [...this.subscribedContextGraphs.values()].some(s => s.onChainId === contextGraphId);
          if (!alreadyKnown) {
            this.seenOnChainIds.add(contextGraphId);
            this.log.info(ctx, `Noted on-chain context graph ${contextGraphId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
          }

          // OT-RFC-38 / LU-5: eagerly populate the on-chain access-policy
          // cache so the StorageACK encrypted-payload guard can answer
          // `isCgCurated` from local state without an extra RPC. The
          // event itself carries the policy enum — no need to re-read.
          // `contextGraphId` here is the on-chain numeric id (stringified
          // bigint) for V10 `ContextGraphCreated` events, which is also
          // what the publish-intent ships in `PublishIntent.contextGraphId`,
          // so the keying matches the lazy-fallback lookup below.
          if (accessPolicy === 0 || accessPolicy === 1) {
            this.onChainAccessPolicyCache.set(contextGraphId, accessPolicy);
          }
          // Issue #872 — same eager-cache pattern for the `publishPolicy`
          // enum so daemon routes can recognise a public + open CG from
          // local state and relax owner-scoped artifact-read guards.
          if (publishPolicy === 0 || publishPolicy === 1) {
            this.onChainPublishPolicyCache.set(contextGraphId, publishPolicy);
            this.onChainPublishPolicyCacheUpdatedAt.set(contextGraphId, Date.now());
          }

          // OT-RFC-38 / LU-6 Phase B — host-mode auto-subscribe path for
          // sharding-table cores. The event carries the curator-committed
          // wire id (`nameHash`); cores derive the SWM gossip topic from
          // it directly and start hosting ciphertext for the CG without
          // needing the cleartext name, without an operator-driven
          // `/api/shared-memory/host-mode/subscribe`, and without an off-
          // chain discovery channel for *registered* CGs (pre-reg CGs
          // go through the discovery-beacon path instead).
          //
          // Gate conditions (all must hold):
          //   1. Curator opted into the hash commitment (nameHash != null
          //      — opt-out CGs run through the beacon path only).
          //   2. CG is curated (accessPolicy == 1). Public CGs don't have
          //      curated SWM substrate to host; LU-6 only applies to
          //      curated.
          //   3. Local node has `nodeRole === 'core'` AND swmHostMode is
          //      enabled. The reconciler below applies the same checks
          //      so this branch is purely an optimisation (eliminates
          //      the discovery-beacon round-trip + the host-mode
          //      reconciler poll latency).
          //   4. Local node is in the sharding table. Probed by the
          //      reconciler; we pass through to it rather than
          //      duplicating the check here.
          //
          // The reconciler is robust to being called for a CG it can't
          // act on (returns early on `nodeRole !== 'core'`, swmHostMode
          // disabled, off-sharding-table, etc.), so the call below
          // doesn't need any of those gates beyond the event-side hash
          // presence and the curated flag.
          if (nameHash && accessPolicy === 1 && eventLocalId !== null) {
            // Register the wire id → numeric id mapping so the receive
            // path's chain fallback resolver (Scope A) can take a hash
            // input and find the on-chain participant agents without an
            // RPC round-trip per envelope.
            const hashLower = this.contextGraphWireId(nameHash);

            // Delegate to the host-mode reconciler — it owns the
            // sharding-table check, swmHostMode flag, and the wire-up
            // of the host-mode gossip handler. Async + best-effort:
            // the periodic reconciler covers the timer-driven fallback
            // path, so a missed event here heals on the next sweep.
            void this.reconcileSwmHostModeSubscription(
              eventLocalId,
              SUBSCRIPTION_SOURCES.CHAIN_EVENT,
            ).catch((err) => {
              this.log.warn(
                ctx,
                `Phase B chain-event auto-subscribe for ${hashLower.slice(0, 18)}… failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        },
        // Phase B — live VM-reconcile nudge. A `KnowledgeAssetRegisteredToContextGraph`
        // event doesn't carry the registration ordinal (only kaId + cgId), so it is
        // NOT a cursor position — it just triggers an immediate coalesced sweep for
        // that CG so newly-registered KCs land in VM with low latency. The periodic
        // sweep is the safety net if this is missed. Only wired when reconciliation
        // is actually possible (chain + ordinal reads present).
        onKARegisteredToContextGraph: this.vmReconcileEnabled()
          ? async ({ contextGraphId: onChainId, kaId }) => {
              // GH #1098 — body extracted to `handleKARegisteredNudge` so the
              // bind-only-the-matching-CG branch is directly testable.
              await this.handleKARegisteredNudge(onChainId, kaId, ctx);
            }
          : undefined,
      });
      await this.chainPoller.start();
      this.log.info(ctx, `Chain event poller started`);
    }

    // OT-RFC-38 / LU-6 Phase B — discovery beacon wiring.
    //
    // CURATOR side (any node with the chain signer + a curated CG
    // it created): the periodic re-announce timer is wired
    // unconditionally — entries are added/removed by
    // `registerCgForBeaconAnnouncement` /
    // `unregisterCgFromBeaconAnnouncement`. An empty `beaconRegistry`
    // makes each tick a no-op, so leaving the timer running on
    // edge nodes with no CGs is harmless.
    //
    // CORE side: subscribe to the global discovery topic only when
    // host-mode is enabled (otherwise we'd accept beacons but have
    // nowhere to host the resulting ciphertext, leaking beacon
    // bookkeeping memory on every signal).
    if (this.swmHostModeStore) {
      this.subscribeCgDiscoveryTopic();
      this.log.info(ctx, `Subscribed to ${DKG_CG_DISCOVERY_TOPIC} for pre-registration auto-host`);
    }
    this.beaconReannounceTimer = setInterval(() => {
      this.reannounceAllBeacons().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Beacon re-announce sweep failed: ${msg}`);
      });
    }, BEACON_REANNOUNCE_INTERVAL_MS);
    // Prevent the re-announce timer from holding the event loop
    // open during test teardown.
    if (typeof this.beaconReannounceTimer.unref === 'function') {
      this.beaconReannounceTimer.unref();
    }

    // PR feat/chain-agents-cg-phonebook: schedule the periodic
    // profile heartbeat alongside the beacon timer. The one-shot
    // startup publish happens in `lifecycle.ts` (setTimeout 0); this
    // timer is the steady-state refresh that keeps `dkg:multiaddr` +
    // `dkg:lastSeen` fresh for peers' dial fallback. Default 5 min;
    // operator-tunable; `0` disables.
    const heartbeatMs = this.config.agentProfileHeartbeatMs ?? AGENT_PROFILE_HEARTBEAT_MS;
    if (Number.isFinite(heartbeatMs) && Number.isInteger(heartbeatMs) && heartbeatMs > 0) {
      this.agentProfileHeartbeatTimer = setInterval(() => {
        if (this.agentProfileHeartbeatInFlight) {
          this.log.debug?.(ctx, 'Agent profile heartbeat skipped: previous publish still in flight');
          return;
        }
        this.agentProfileHeartbeatInFlight = true;
        this.publishProfile()
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(ctx, `Agent profile heartbeat publish failed: ${msg}`);
          })
          .finally(() => {
            this.agentProfileHeartbeatInFlight = false;
          });
      }, heartbeatMs);
      if (typeof this.agentProfileHeartbeatTimer.unref === 'function') {
        this.agentProfileHeartbeatTimer.unref();
      }
    }

    // Set up messaging
    const x25519Priv = ed25519ToX25519Private(this.wallet.keypair.secretKey);
    this.messageHandler = new MessageHandler(
      this.messenger,
      this.wallet.keypair,
      x25519Priv,
      this.node.peerId,
      this.eventBus,
    );

    // Long-lived stream pooling for the chat protocol — opt-in via
    // env. When `DKG_POOLED_MESSAGES=1`, ProtocolRouter wraps the
    // chat protocol (`/dkg/10.0.1/message`) with a per-peer pooled
    // wire variant (`/dkg/10.0.2/message`) that re-uses a single
    // bidirectional yamux substream + framed multiplexing across
    // every send to the same peer. Backward-compatible: peers that
    // don't advertise the pooled wire variant fall back to one-shot
    // automatically via multistream-select.
    //
    // Designed for the May 2026 multi-node soak finding: circuit-
    // relay-v2 connections were being torn down between every send
    // (200–365 ms per re-dial), dominating the latency tail (p95
    // ~8.5s, p99 ~9.6s). Long-lived streams keep both the substream
    // and the underlying relay connection warm via periodic PING
    // frames. See packages/core/src/message-stream-pool.ts.
    if (process.env.DKG_POOLED_MESSAGES === '1') {
      this.router.enablePooling(PROTOCOL_MESSAGE, {
        // Conservative keepalive: 10s is fast enough to keep
        // relay-v2 reservations alive (default reservation TTL is
        // far longer) and slow enough to add <0.1Hz of background
        // traffic per peer.
        keepaliveIntervalMs: 10_000,
        // 5 min idle close: a peer the local node hasn't messaged in
        // 5 min probably isn't going to message again soon; closing
        // the stream releases the relay reservation slot, and the
        // next send re-opens cheaply.
        idleTimeoutMs: 5 * 60_000,
      });
      this.log.info(
        ctx,
        '[messenger] pooled wire variant /dkg/10.0.2/message enabled for ' +
          'chat protocol (long-lived per-peer streams).',
      );
    }

    // Wire up pending chat handler
    if (this._pendingChatHandler) {
      this.messageHandler.onChat(this._pendingChatHandler);
      this._pendingChatHandler = null;
    }

    // Wire up pending chat ACL (set via `agent.setChatAcl(...)` before start)
    if (this._pendingChatAcl) {
      this.messageHandler.setChatAcl(this._pendingChatAcl);
      this._pendingChatAcl = null;
    }

    // GH #462 — wire up pending skill ACL (set via `agent.setSkillAcl(...)`).
    if (this._pendingSkillAcl) {
      this.messageHandler.setSkillAcl(this._pendingSkillAcl);
      this._pendingSkillAcl = null;
    }

    // Register skill handlers
    if (this.config.skills) {
      for (const skill of this.config.skills) {
        const uri = `https://dkg.origintrail.io/skill#${skill.skillType}`;
        this.messageHandler.registerSkill(uri, skill.handler);
      }
    }

    // Sync registers on the RAW ProtocolRouter (not messenger.register):
    // /dkg/10.0.2/sync is deliberately off the Universal Messenger
    // substrate so its large, never-reused page responses are not cached
    // in message_idempotency (the ~2.9 GB node-ui.db bloat). The raw
    // router passes the bare payload — exactly the auth envelope
    // parseSyncRequest expects — and the adapter re-exposes the string
    // peerId contract registerSyncHandler relies on. (Reverts rc.9 PR-E
    // for sync only; other substrate protocols keep their dedup.)
    const snapshotPolicy = resolveSyncResponderSnapshotPolicy(
      this.config.syncResponderSnapshotLimits,
      process.env,
      (message) => this.log.warn(ctx, message),
    );
    const syncGlobalPolicy = resolveAgentSyncGlobalBackpressure(this.config);
    const syncPartitions = syncGlobalPolicy.mode === 'partitioned'
      && syncGlobalPolicy.limit !== undefined
      ? syncGlobalPolicy.partitions
      : undefined;
    const configuredPriorityCounts = countSyncPriorityClasses(this.config.syncContextGraphPriorities);
    this.log.info(ctx, `Resolved sync policy ${JSON.stringify({
      syncAdmissionMode: syncGlobalPolicy.mode,
      snapshotGlobalRows: snapshotPolicy.budget.maxRows,
      snapshotGlobalBytesEstimate: snapshotPolicy.budget.maxBytesEstimate,
      snapshotLocalRows: snapshotPolicy.budget.maxSnapshotRows,
      snapshotLocalBytesEstimate: snapshotPolicy.budget.maxSnapshotBytesEstimate,
      syncGlobalInflightLimit: syncGlobalPolicy.limit ?? 0,
      syncGlobalQueueLimit: syncGlobalPolicy.queueLimit ?? 0,
      syncFastInflightLimit: syncPartitions?.fast.maxInflight,
      syncFastQueueLimit: syncPartitions?.fast.queueLimit,
      syncSlowInflightLimit: syncPartitions?.slow.maxInflight,
      syncSlowForegroundReserved: syncPartitions?.slow.foregroundReserved,
      syncSlowForegroundQueueLimit: syncPartitions?.slow.foregroundQueueLimit,
      syncSlowBackgroundInflightLimit: syncPartitions?.slow.backgroundMaxInflight,
      syncSlowBackgroundQueueLimit: syncPartitions?.slow.backgroundQueueLimit,
      configuredPriorities: configuredPriorityCounts,
      snapshotLocalClamped: snapshotPolicy.localRowsClamped || snapshotPolicy.localBytesEstimateClamped,
    })}`);
    // Keep one framed sync stream (and therefore its circuit-relay connection)
    // alive across page requests. Old peers do not advertise this wire id and
    // transparently fall back to PROTOCOL_SYNC. Set DKG_POOLED_SYNC=0 only as
    // an emergency rollback; the hot path is enabled by default.
    if (process.env.DKG_POOLED_SYNC !== '0') {
      this.router.enablePooling(PROTOCOL_SYNC, {
        protocolId: PROTOCOL_SYNC_POOLED,
        keepaliveIntervalMs: 10_000,
        idleTimeoutMs: 5 * 60_000,
      });
      this.log.info(ctx, `[sync] pooled wire variant ${PROTOCOL_SYNC_POOLED} enabled`);
    }
    registerSyncHandler({
      register: (protocol, handler) =>
        this.router.register(protocol, (data, peerIdObj, options) => handler(data, peerIdObj.toString(), options)),
      protocolSync: PROTOCOL_SYNC,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      syncPageSize: SYNC_PAGE_SIZE,
      sharedMemoryTtlMs: this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS,
      store: this.store,
      publicSnapshotStore: this.publicSnapshotStore,
      peerId: this.peerId,
      parseSyncRequest: this.parseSyncRequest.bind(this),
      authorizeSyncRequest: this.authorizeSyncRequest.bind(this),
      // Serve-skip policy (#1233): withhold the no-consumer agents/_meta snapshot
      // unless the operator opts in. This is the env boundary — the pure
      // `shouldWithholdAgentsDurableMeta` resolver is called directly with a FRESH
      // `process.env.DKG_SERVE_AGENTS_META` read per request, so the kill-switch is
      // reversible at runtime (no restart).
      shouldWithholdDurableMeta: (contextGraphId) =>
        shouldWithholdAgentsDurableMeta(contextGraphId, process.env.DKG_SERVE_AGENTS_META),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logDebug: (ctx, message) => this.log.debug(ctx, message),
      snapshotBudget: snapshotPolicy.budget,
      contextGraphPriorities: this.config.syncContextGraphPriorities,
    });

    // OT-RFC-59 changelog delta lane. Registered ONLY when the changelog is
    // enabled — asChangelogReader resolves the ChangelogStore behind the daemon's
    // store wrapper, which is non-null only if config.store.changelog is on and
    // wrapped the store. Default-off: with the flag off the store is not wrapped,
    // this is null, PROTOCOL_SYNC_CHANGELOG is never advertised (identify omits
    // it), and every requester cleanly falls back to PROTOCOL_SYNC. Separate raw-
    // router registration (off-substrate, like PROTOCOL_SYNC) reusing the SAME
    // per-CG RFC-49 authorization as the legacy lane.
    const changelogReader = asChangelogReader(this.store);
    if (changelogReader) {
      this.router.register(PROTOCOL_SYNC_CHANGELOG, (data, peerIdObj, options) =>
        this.handleChangelogSync(data, peerIdObj.toString(), options, changelogReader));
    }

    // Join-request protocol: receives signed join requests forwarded by peers.
    // Stores them locally if this node is the curator; ACKs with "ok" or "error".
    // rc.9 PR-10: migrated onto the Universal Messenger substrate
    // (generation-bound wire prefix /dkg/10.0.2/join-request). messenger.register
    // wraps the handler with envelope-decode + receiver-side dedup;
    // the application logic below is unchanged.
    this.messenger.register(PROTOCOL_JOIN_REQUEST, async (data, peerIdStr) => {
      const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
      let trustedDecisionInProgress = false;
      try {
        if (data.byteLength > 64 * 1024) {
          return new TextEncoder().encode(JSON.stringify({
            ok: false,
            error: 'join-request payload exceeds 64 KiB',
          }));
        }
        const payload = JSON.parse(new TextDecoder().decode(data));

        // Handle "join-approved" notifications from curator → requester.
        // Only process if this node owns the target agentAddress AND the
        // sender is a peer we previously trusted as a curator candidate
        // for THIS specific (cgId, agentAddress) pair (or, as a fallback,
        // matches the curator triple in our local _meta graph — which
        // works for already-approved members getting re-approved).
        if (payload.type === 'join-approved') {
          const {
            contextGraphId,
            agentAddress: approvedAddr,
            requestGeneration,
            curatorAgentAddress,
            curatorAuthorityEra,
          } = payload;
          // Require BOTH fields. Earlier the address was treated as
          // optional, so a forged payload carrying only `contextGraphId`
          // would skip the trusted-sender check, subscribe this node,
          // and emit JOIN_APPROVED unconditionally. Mirror the
          // rejection handler: if either field is missing, drop.
          if (!contextGraphId || !approvedAddr || typeof requestGeneration !== 'string') {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          if (contextGraphId && approvedAddr && typeof requestGeneration === 'string') {
            const isLocalAgent = [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === approvedAddr.toLowerCase(),
            );
            if (!isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            const senderTrusted = await this.isTrustedJoinDecisionSender(
              contextGraphId,
              approvedAddr,
              requestGeneration,
              peerId.toString(),
            );
            if (!senderTrusted) {
              this.log.warn(
                createOperationContext('system'),
                `Dropping join-approved for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
              );
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            trustedDecisionInProgress = true;
            const decisionApplied = await this.applyRequesterJoinDecision(
              contextGraphId,
              approvedAddr,
              requestGeneration,
              'approved',
              peerId.toString(),
              typeof curatorAgentAddress === 'string'
                && typeof curatorAuthorityEra === 'string'
                ? {
                  agentAddress: curatorAgentAddress,
                  authorityEra: curatorAuthorityEra,
                }
                : undefined,
            );
            if (!decisionApplied) {
              this.log.warn(
                createOperationContext('system'),
                `Dropping join-approved for "${contextGraphId}" from ${peerId.toString()} — request generation is stale, unknown, or already terminal`,
              );
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            const existingApprovedSubscription =
              this.subscribedContextGraphs.get(contextGraphId);
            const wireOnlySubscription =
              this.resolveWireOnlyContextGraphSubscription(contextGraphId);
            const adoptsWireOnlySubscription = wireOnlySubscription !== null
              && (
                existingApprovedSubscription?.onChainId === undefined
                || wireOnlySubscription.subscription.onChainId === undefined
                || existingApprovedSubscription.onChainId
                  === wireOnlySubscription.subscription.onChainId
              )
              && (
                existingApprovedSubscription?.onChainHash === undefined
                || this.contextGraphWireId(existingApprovedSubscription.onChainHash)
                  === wireOnlySubscription.wireId
              );
            const approvedSubscription: ContextGraphSub = {
              ...(adoptsWireOnlySubscription ? {
                onChainId: wireOnlySubscription.subscription.onChainId,
                onChainHash: wireOnlySubscription.wireId,
              } : {}),
              ...existingApprovedSubscription,
              syncMode: 'always-on',
              subscribed: true,
              pendingMeta: true,
              metaSynced: false,
              // Approval begins a new authoritative bootstrap attempt. Any
              // completion flags recorded before `_meta` was available are
              // untrusted (an unrelated peer may have returned clean-empty),
              // so they cannot survive into the approved state.
              synced: false,
              sharedMemorySynced: false,
            };
            const approvedMembership: ContextGraphMembershipRecord = {
              contextGraphId,
              principalType: 'agent',
              principalId: approvedAddr,
              role: 'participant',
              status: 'active',
              source: 'join-approved',
              metadata: { curatorPeerId: peerId.toString() },
            };
            // Commit the restart contract before changing live subscription
            // state. The two stores do not expose a shared transaction, so the
            // helper snapshots both rows and compensates the first write if the
            // second fails. This also keeps a failed Messenger delivery fully
            // retryable: no gossip wiring, readiness flags, event, or sync kick
            // escapes before both configured stores accept the approval.
            try {
              await this.persistJoinApprovalStateStrict(
                contextGraphId,
                approvedMembership,
                approvedSubscription,
              );
            } catch (error) {
              try {
                await this.restoreRequesterJoinDecisionAfterFailedApply(
                  contextGraphId,
                  approvedAddr,
                  requestGeneration,
                  'approved',
                );
              } catch (rollbackError) {
                const originalMessage = error instanceof Error ? error.message : String(error);
                const rollbackMessage = rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
                throw new AggregateError(
                  [error, rollbackError],
                  `${originalMessage}; requester decision rollback failed: ${rollbackMessage}`,
                );
              }
              throw error;
            }
            this.preferredSyncPeers.set(contextGraphId, peerId.toString());
            // Curator just confirmed `approvedAddr` is the principal — record
            // it before the sync kick so the first post-approval request claims
            // the right agent on multi-agent nodes.
            this.localApprovedAgentByCG.set(contextGraphId, approvedAddr.toLowerCase());
            this.log.info(createOperationContext('system'), `Join request approved for "${contextGraphId}" — auto-subscribing`);
            // Defer the SWM gossip subscribe specifically: the curator's
            // allowlist hasn't synced into our local `_meta` yet, so a
            // pre-meta `canReadContextGraph` check would deny and emit a
            // misleading WARN. `runImmediatePostApprovalSync` below pulls
            // `_meta`, then `refreshMetaSyncedFlags` (called from
            // `runCatchupOverPeers`) re-queues the SWM gossip subscribe
            // once the allowlist is locally visible — clean self-heal,
            // no spurious denial. Other gossip topics (publish/app/
            // update/finalization) wire up immediately as before.
            this.subscribeToContextGraph(contextGraphId, {
              deferSharedMemoryGossipSubscribe: true,
              syncMode: 'always-on',
              // The exact approval snapshot was committed above. Scheduling
              // the ordinary background persistence here would reintroduce
              // untracked writes around the compensating transaction.
              persist: false,
            });
            // Mark the subscription as "expecting meta" so listContextGraphs
            // surfaces it in the UI immediately (with synced=false) instead
            // of filtering it out as a phantom subscription until meta-sync
            // completes. Cleared in `refreshMetaSyncedFlags` once meta lands.
            //
            // `metaSynced: false` is set together with `pendingMeta: true`
            // because the two are complementary, not redundant: `metaSynced`
            // is the FACTUAL state that downstream safety guards check
            // (`shouldCreateImplicitSharedMemoryContextGraph` and the curated
            // gossip pre-meta gate in gossip-publish-handler.ts both use
            // strict `metaSynced === false` equality), and `pendingMeta` is
            // the UI affordance layered on top. Without `metaSynced: false`,
            // a freshly-approved private CG slips past both guards in the
            // window between approval and the first `_meta` arrival — any
            // SWM write or inbound gossip in that window then gets inferred
            // as a public CG locally, which is the exact corruption these
            // guards exist to prevent. Lex review on PR #517 round 2 + Codex.
            this.setContextGraphSubscription(
              contextGraphId,
              approvedSubscription,
              { persist: false },
            );
            this.joinRequestAcceptedBy.delete(this.joinRequestTrackingKey(
              contextGraphId,
              approvedAddr,
              requestGeneration,
            ));
            // Sync immediately by targeting the curator peer we just received
            // this notification from, instead of relying on the periodic
            // catchup reconciler to pick it up minutes later. The previous
            // `.catch(() => {})` swallowed every failure mode silently and
            // also went through the regular peer-ranking path that produced
            // zero sync attempts in the just-approved-but-no-meta-yet window.
            void this.runImmediatePostApprovalSync(contextGraphId, peerId.toString());
            this.eventBus.emit(DKGEvent.JOIN_APPROVED, {
              contextGraphId,
              agentAddress: approvedAddr,
            });
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        // Handle "join-rejected" notifications from curator → requester.
        // Symmetric to join-approved: filter by localAgents and emit an
        // event so the UI can surface a notification instead of leaving
        // the invitee's Join modal stuck on "Join request sent…" forever.
        //
        // We deliberately do NOT mutate local subscription/ACL state —
        // cleanup of phantom auto-discovery is left to the daemon's
        // catch-up denial path, which is gated on the curator's actual
        // ACL response.
        if (payload.type === 'join-rejected') {
          const {
            contextGraphId,
            agentAddress: rejectedAddr,
            requestGeneration,
          } = payload;
          if (!contextGraphId || !rejectedAddr || typeof requestGeneration !== 'string') {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          // The rejection target must be one of our local agents (Codex
          // tier-4h N14). This alone isn't enough though: a malicious
          // peer that knows a target's agent address can still forge a
          // rejection for any CG, driving our UI into a false "denied"
          // state. So also require the SENDER to be the CG's curator
          // — Codex tier-4k N27. The sender's peer ID is passed in by
          // the router; we match it against the CG's recorded curator
          // DID (direct peer-ID DID for legacy CGs) or, for
          // wallet-scoped curators, the current peer ID published by
          // the curator agent in the registry. Anything else is
          // dropped with a short `skipped` ACK.
          const isLocalAgent = [...this.localAgents.keys()].some(
            (addr) => addr.toLowerCase() === rejectedAddr.toLowerCase(),
          );
          if (!isLocalAgent) {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          const senderTrusted = await this.isTrustedJoinDecisionSender(
            contextGraphId,
            rejectedAddr,
            requestGeneration,
            peerId.toString(),
          );
          if (!senderTrusted) {
            this.log.warn(
              createOperationContext('system'),
              `Dropping join-rejected for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          trustedDecisionInProgress = true;
          const decisionApplied = await this.finalizeRequesterJoinRejection({
            contextGraphId,
            agentAddress: rejectedAddr,
            requestGeneration,
            expectedCuratorPeerId: peerId.toString(),
            source: 'join-rejected',
          });
          if (!decisionApplied) {
            this.log.warn(
              createOperationContext('system'),
              `Dropping join-rejected for "${contextGraphId}" from ${peerId.toString()} — request generation is stale, unknown, or already terminal`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        const { contextGraphId, delegation, agentName, requestGeneration } = payload as {
          contextGraphId?: string;
          delegation?: SignedAgentDelegation;
          agentName?: string;
          requestGeneration?: string;
        };
        // Diagnostic surface for the rejection paths below. Without this
        // every silent-reject path (`missing fields`, `unknown CG`, `not
        // curator`, `verifyJoinRequest` throws) is invisible at runtime
        // — the failing joiner just sees "no reachable curator" and the
        // curator's log shows nothing. PR #448 round-6 testing burned a
        // lot of time on that gap; surface it.
        const remotePeer = peerId.toString();
        const peerTag = remotePeer.slice(-8);
        const requestCtx = createOperationContext('system');
        if (
          !contextGraphId ||
          !delegation?.agentAddress ||
          !delegation?.signature
        ) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag}: rejected — missing fields ` +
              `(contextGraphId=${!!contextGraphId} agentAddress=${!!delegation?.agentAddress} signature=${!!delegation?.signature})`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
        // Reserve the transport-authenticated peer and queue slot before any
        // attacker-controlled CG lookup or signature work. Payload-derived CG
        // and agent buckets are charged only after verification in the shared
        // processing lane.
        const releaseIngress = this.hasRetryableContextGraphJoinAdmission(contextGraphId, delegation)
          ? () => {}
          : this.reserveContextGraphJoinIngress(
              contextGraphId,
              peerId.toString(),
            );
        try {
          // Only store if this node is the curator (creator) of the CG
          const owner = await this.getContextGraphOwner(contextGraphId);
          if (!owner) {
            this.log.warn(
              requestCtx,
              `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": rejected — unknown CG`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'unknown CG' }));
          }
          // Compare on normalised DIDs (see `normalizeAgentDid`): EVM
          // address suffixes are lowered (case-insensitive on-wire), peer-ID
          // suffixes pass through (case-sensitive base58).
          const ownerNorm = normalizeAgentDid(owner);
          const selfDid = `did:dkg:agent:${this.peerId}`;
          const selfAgentDid = this.defaultAgentAddress
            ? normalizeAgentDid(`did:dkg:agent:${this.defaultAgentAddress}`)
            : null;
          const ownerLocalAgentAddress = [...this.localAgents.keys()].find(
            (addr) => ownerNorm === normalizeAgentDid(`did:dkg:agent:${addr}`),
          );
          const isCurator = ownerNorm === selfDid ||
            (selfAgentDid !== null && ownerNorm === selfAgentDid) ||
            ownerLocalAgentAddress !== undefined;
          if (!isCurator) {
            this.log.warn(
              requestCtx,
              `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": rejected — not curator (owner=${owner})`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'not curator' }));
          }
          this.log.info(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": accepted for admission processing for ${delegation.agentAddress}`,
          );
          const derivedRequestGeneration = this.getJoinRequestGeneration(delegation);
          if (
            requestGeneration !== undefined
            && (
              typeof requestGeneration !== 'string'
              || requestGeneration.toLowerCase() !== derivedRequestGeneration
            )
          ) {
            return new TextEncoder().encode(JSON.stringify({
              ok: false,
              error: 'request generation does not match signed delegation',
            }));
          }
          if (
            delegation.delegateePeerId
            && delegation.delegateePeerId !== peerId.toString()
          ) {
            return new TextEncoder().encode(JSON.stringify({
              ok: false,
              error: `join request carrier mismatch: signed delegatee peer ${delegation.delegateePeerId} `
                + `does not match transport peer ${peerId.toString()}`,
            }));
          }

          const addrLower = delegation.agentAddress.toLowerCase();
          // Install the return-path before processing because automatic
          // approval may notify immediately. Restore the previous path when
          // processing rejects so invalid/over-cap unique addresses cannot
          // grow this map without bound.
          const originKey = this.joinRequestTrackingKey(
            contextGraphId,
            addrLower,
            derivedRequestGeneration,
          );
          const previousOriginPeer = this.joinRequestOriginPeers.get(originKey);
          this.joinRequestOriginPeers.set(originKey, peerId.toString());
          let decision: Awaited<ReturnType<DKGAgent['processIncomingJoinRequest']>>;
          try {
            decision = await this.processIncomingJoinRequest(
              contextGraphId,
              delegation,
              agentName,
              peerId.toString(),
              { ingressReserved: true },
            );
          } catch (error) {
            if (this.joinRequestOriginPeers.get(originKey) === peerId.toString()) {
              if (previousOriginPeer === undefined) this.joinRequestOriginPeers.delete(originKey);
              else this.joinRequestOriginPeers.set(originKey, previousOriginPeer);
            }
            throw error;
          }
          return new TextEncoder().encode(JSON.stringify({
            ok: true,
            status: decision.status,
            // Origin/main requesters only understand `alreadyMember` and may
            // drop the immediate approval notification before the response
            // establishes curator trust. Alias every completed approval so a
            // rolling-upgrade requester still transitions synchronously.
            ...(decision.alreadyMember || decision.status === 'approved'
              ? { alreadyMember: true }
              : {}),
            ...(decision.autoApproved ? { autoApproved: true } : {}),
          }));
        } finally {
          releaseIngress();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'RetryableJoinAdmissionError') {
          // Do not turn a post-membership partial failure into an application
          // ACK. Let the reliable messenger observe a transport failure so it
          // keeps the envelope in its durable outbox; the idempotent member
          // branch repairs status/audit on the retry.
          this.log.warn(
            createOperationContext('system'),
            `PROTOCOL_JOIN_REQUEST admission incomplete; retrying via messenger outbox: ${msg}`,
          );
          throw err;
        }
        // Mirror the per-rejection-path warns above. The most common
        // throw-site is `verifyJoinRequest` (signature/scope/expiry
        // failure); without this log the curator silently NACKs and the
        // joiner sees only "no reachable curator".
        this.log.warn(
          createOperationContext('system'),
          `PROTOCOL_JOIN_REQUEST handler error: ${msg}`,
        );
        // Once a decision sender has passed authentication, persistence and
        // bootstrap failures must escape the application handler. Messenger
        // then leaves the message unhandled so the sender's durable outbox can
        // retry it; returning `{ok:false}` bytes would be cached as a terminal
        // handled response and silently lose the decision.
        if (trustedDecisionInProgress) throw err;
        return new TextEncoder().encode(JSON.stringify({ ok: false, error: msg }));
      }
    }, {
      // ReliableEnvelope overhead sits outside the 64 KiB application body.
      // Reject oversized frames in ProtocolRouter before buffering/decoding.
      maxWireBytes: 80 * 1024,
    });

    // Subscribe to both system context graph GossipSub topics
    for (const systemContextGraph of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
      this.subscribeToContextGraph(systemContextGraph, { syncMode: 'always-on' });
    }

    // Connect to bootstrap peers
    if (this.config.bootstrapPeers) {
      for (const addr of this.config.bootstrapPeers) {
        try {
          await this.node.libp2p.dial(multiaddr(addr));
        } catch {
          // Bootstrap peer may be unreachable
        }
      }
    }

    // On new peer connection, request automatic durable catch-up. Core nodes
    // include the system Context Graphs; Edge nodes default to the graphs their
    // operator selected and can fetch system graphs explicitly when needed.
    // Wait for protocol identification to complete, then only sync with
    // peers that actually support the sync protocol (skips raw relay nodes).
    const handleSyncError = (remotePeer: string, err: unknown): void => {
      const shortPeer = remotePeer.slice(-8);
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Sync-on-connect failed for ${shortPeer}: ${message}`);
    };

    // Single source of truth for "new or reconnecting peer → trigger
    // catch-up sync": the `connection:open` listener below. It fires
    // both on the first connection to a new peer AND on every
    // subsequent reconnect for that same peer, so it fully subsumes
    // `peer:connect`. Registering both produced a double-queued
    // `trySyncFromPeer` for every new peer (one from each handler),
    // doubling initial catch-up traffic and racing the sync/store
    // path on first-contact peers. Codex tier-4g finding on this line.
    this.node.libp2p.addEventListener('connection:open', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const replayContextGraphIds = [...new Set([
        ...this.readRfc64CatalogResponsibilitiesV1()
          .filter((responsibility) => responsibility.active && responsibility.mode !== 'legacy')
          .map((responsibility) => responsibility.contextGraphId),
        ...Object.keys(this.config.rfc64CatalogExecutionPlan.selectedAuthority)
          .filter((contextGraphId) => {
            const authority = this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId);
            return authority.active && authority.mode !== 'legacy';
          }),
      ])].sort();
      for (const contextGraphId of replayContextGraphIds) {
        this.markRfc64CatalogReplayPeerPendingV1(contextGraphId, remotePeer);
      }
      // Reverse-path peerStore enrichment for inbound circuit-relay
      // connections.
      //
      // Closes the "Window D" class from the May 2026 Miles↔Lex 6h
      // soak postmortem: an inbound circuit connection from peer P
      // via relay R was open and live, but every
      // `dialProtocol(P, ...)` retry on our side failed with "no
      // valid addresses for peer" because P's identify-push didn't
      // replicate the reservation address into our peerStore.
      // Echoing the inbound circuit's relay back as an outbound
      // multiaddr for P (`<R>/p2p-circuit/p2p/<P>`) lets the next
      // dialProtocol find an address and try it.
      //
      // User review on PR #536 caught the original ordering bug:
      // The whole chain runs as a fire-and-forget IIFE so the
      // listener itself doesn't await — libp2p's
      // `connection:open` emitter is synchronous and we don't
      // want to slow down other listeners.
      void (async () => {
        let admitted = false;
        try {
          admitted = await this.networkAdmissionCoordinator.ensureAdmitted(remotePeer, ctx);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Network admission probe failed for ${remotePeer.slice(-8)} on connect: ${message}`);
          for (const contextGraphId of replayContextGraphIds) {
            this.clearRfc64CatalogReplayPeerPendingV1(contextGraphId, remotePeer);
          }
          return;
        }
        if (!admitted) {
          for (const contextGraphId of replayContextGraphIds) {
            this.clearRfc64CatalogReplayPeerPendingV1(contextGraphId, remotePeer);
          }
          return;
        }
        try {
          await this.enrichPeerStoreFromInboundCircuit(evt.detail);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Reverse-path peerStore enrichment failed for ${remotePeer}: ${message}`);
        }
        // PR-2 (SWM-fanout plan): drain pending sender-key packages
        // that were queued because the recipient had no advertised
        // peerId at publish time. Tolerant of profile-lookup failure
        // (the next connection:open will retry).
        try {
          const drained = await this.drainPendingSenderKeyForPeer(remotePeer, ctx);
          if (drained > 0) {
            this.log.info(ctx, `Drained ${drained} pending SWM sender-key package(s) for ${remotePeer}`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Pending SWM sender-key drain on connect failed for ${remotePeer}: ${message}`);
        }
        // The receiver owns replay completeness. Provider-initiated pushes do
        // not carry a promised-head manifest and can otherwise leave a brief
        // A-applied/B-undiscovered window reporting complete. Request every
        // active CG through the completion-capable scoped protocol instead.
        // Keep the 10.0.15 rolling-upgrade direction alive: legacy receivers
        // cannot request V2 completion, but they can still consume ordinary
        // head announcements. Upgraded receivers remain fenced by the scoped
        // pull below and never interpret this compatibility push as complete.
        void this.reannounceRfc64CatalogHeadsToPeerV1(remotePeer).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(
            ctx,
            `RFC-64 compatibility re-announcement failed for ${remotePeer.slice(-8)}: ${message}`,
          );
        });
        for (const contextGraphId of replayContextGraphIds) {
          void this.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(
            contextGraphId,
          ).then((result) => {
            if (result.failed > 0) {
              this.log.warn(
                ctx,
                `RFC-64 catalog replay incomplete for "${contextGraphId}" after ${remotePeer.slice(-8)} connected`,
              );
            }
          }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(
              ctx,
              `RFC-64 catalog replay failed after ${remotePeer.slice(-8)} connected: ${message}`,
            );
          });
        }
        this.queueSyncFromPeerOnConnect(remotePeer, handleSyncError);
      })();
    });

    // Remember when the last live connection to a peer is gone. A3 keeps
    // `lastSuccessfulSyncAt` and reconciler backoff across relay flaps, but
    // the next `connection:open` must not suppress catch-up using a sync
    // timestamp from before an offline gap. `lastSyncDisconnectedAt` is the
    // boundary that distinguishes stale pre-disconnect success from a fresh
    // sync in the current live session.
    this.node.libp2p.addEventListener('connection:close', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const stillConnected = this.node.libp2p
        .getPeers()
        .some((p) => p.toString() === remotePeer);
      if (stillConnected) return;
      this.skippedNoSyncPeers.delete(remotePeer);
      this.lastSyncDisconnectedAt.set(remotePeer, Date.now());
    });

    // Event-driven sync-retry: libp2p emits `peer:update` whenever a
    // peer record changes — including (and most importantly) when
    // identify completes and populates the protocol list for the first
    // time. The inbound side of `connection:open` reliably loses this
    // race in practice (the event fires on TCP accept, before identify
    // has been processed), so without this listener a node that mostly
    // accepts inbound dials — typically the relay node 1 in our devnet
    // topology — would never sync from any peer beyond the bootstrap
    // window. See `handlePeerUpdateForSyncRetry` for the dedup logic.
    this.node.libp2p.addEventListener('peer:update', (evt) => {
      const detail = evt.detail as { peer?: { id?: { toString(): string }; protocols?: readonly string[] } };
      const peerIdObj = detail?.peer?.id;
      if (!peerIdObj) return;
      const protocols = detail.peer?.protocols ?? [];
      this.handlePeerUpdateForSyncRetry(peerIdObj.toString(), protocols);
    });

    // Reconnect-on-gossip: when a gossip message arrives from a peer we're
    // not currently connected to, best-effort dial them. This catches the
    // case where two NAT'd edge nodes briefly lose their direct path but
    // gossipsub still routes their messages to each other via the mesh —
    // the arriving message is both proof-of-life *and* a cheap trigger to
    // rebuild the direct link so subsequent sync requests have a path.
    this.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (data) => {
      const from = (data as { from?: string })?.from;
      if (!from || from === 'unknown') return;
      this.maybeDialGossipSender(from).catch(() => {
        // Swallow: reconnect-on-gossip is best-effort; failures are already
        // logged inside the method and we don't want to disrupt gossip
        // delivery if a single peer happens to be unreachable.
      });
    });

    // Sync from peers already connected (e.g. relay dialed during node.start())
    const alreadyConnected = this.node.libp2p.getPeers();
    for (const pid of alreadyConnected) {
      const remotePeer = pid.toString();
      void this.networkAdmissionCoordinator.ensureAdmitted(remotePeer, ctx)
        .then((admitted) => {
          if (admitted) this.queueSyncFromPeerOnConnect(remotePeer, handleSyncError);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Startup network admission check failed for ${remotePeer.slice(-8)}: ${message}`);
        });
    }

    // Start periodic shared memory cleanup
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl > 0) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    }

    // OT-RFC-38 LU-6: periodic reconciler that ensures the local
    // node is subscribed in host-mode to every locally-known
    // curated CG (cores only). Without this tick, a CG learned of
    // after `subscribeToContextGraph` already ran (e.g. via on-
    // connect sync from a peer) would miss host-mode coverage
    // until the next explicit subscribe call. Also runs the
    // store's TTL/cap prune.
    if (this.swmHostModeStore) {
      const reconcileEveryMs = this.config.swmHostMode?.reconcileIntervalMs ?? 30_000;
      const reconcileTimerMs = jitteredIntervalMs(
        reconcileEveryMs,
        this.config.swmHostMode?.reconcileJitterRatio,
      );
      const pruneEveryMs = this.config.swmHostMode?.pruneIntervalMs ?? 5 * 60_000;
      this.reconcileHostModeSubscriptions().catch(() => {});
      this.hostModeReconcilerTimer = setInterval(() => {
        this.reconcileHostModeSubscriptions().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(createOperationContext('system'), `Host-mode reconciler tick failed: ${msg}`);
        });
      }, reconcileTimerMs);
      if (this.hostModeReconcilerTimer.unref) this.hostModeReconcilerTimer.unref();
      this.hostModePruneTimer = setInterval(() => {
        this.swmHostModeStore?.prune().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(createOperationContext('system'), `Host-mode prune tick failed: ${msg}`);
        });
      }, pruneEveryMs);
      if (this.hostModePruneTimer.unref) this.hostModePruneTimer.unref();
    }

    // Start the periodic sync reconciler — the safety net for the
    // event-driven `peer:update` retry path. See the constants block at
    // the top of this file (`SYNC_RECONCILER_INTERVAL_MS`,
    // `SYNC_STALENESS_THRESHOLD_MS`) and `reconcileSyncFromConnectedPeers`
    // for the full design rationale.
    if (syncReconcilerEnabled(this.config)) {
      const syncTiming = this.config.syncReconcilerTiming;
      this.syncReconcilerTimer = setInterval(() => {
        this.reconcileSyncFromConnectedPeers().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Sync reconciler tick failed: ${message}`);
        });
      }, syncTiming.intervalMs);
      if (this.syncReconcilerTimer.unref) this.syncReconcilerTimer.unref();
    } else {
      this.log.warn(ctx, `Skipping periodic sync reconciler startup (DKG_SYNC_RECONCILER_ENABLED=0)`);
    }

    // A.4-lite+: keep a small set of Core nodes warm (connection pinned +
    // auto-redialed by libp2p) so catch-up / chain reconciliation never pays
    // a cold circuit-relay dial to reach a Core. Opt-in via
    // DKG_WARM_CORE_CONNECTIONS=1. See `p2p/warm-core-connections.ts`.
    if (WARM_CORE_CONNECTIONS_ENABLED) {
      // Serialize passes: one reconcile can run longer than the interval
      // (discovery + chain gate + up to WARM_CORE_MAX sequential dials, each
      // with a 20s timeout). Without this guard, overlapping passes race on
      // `this.warmedCores` and can unpin a Core a newer pass just selected.
      let warmCoreInFlight = false;
      const runWarmCore = (): void => {
        if (warmCoreInFlight) return;
        warmCoreInFlight = true;
        this.reconcileWarmCoreConnections()
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(ctx, `Warm-core reconcile tick failed: ${message}`);
          })
          .finally(() => {
            warmCoreInFlight = false;
          });
      };
      // Prime once now (after startup), then on a steady cadence.
      runWarmCore();
      this.warmCoreTimer = setInterval(runWarmCore, WARM_CORE_RECONCILE_INTERVAL_MS);
      if (this.warmCoreTimer.unref) this.warmCoreTimer.unref();
    }

    // rc.9 PR-10: dedicated join-approval retry tick removed. The
    // substrate's Messenger.processOutboxTick (set up immediately
    // below) now drives retries for /dkg/10.0.2/join-request the
    // same way it does for chat — same cadence, same backoff ladder,
    // persisted across daemon restart.

    // Periodic tick for the chat outbox retry queue. See
    // MESSAGE_OUTBOX_TICK_MS for the rationale (silent-drop on
    // transport failure used to lose operator-typed messages from
    // `dkg_send_message`; this is the safety-net retry loop that turns
    // them into eventual successes on their persisted retry schedule.
    // Universal Messenger substrate retry tick (rc.9 PR-2 +
    // PR-3). The rc.8 chat-specific tick was deleted in PR-3;
    // this is now the only outbox tick — chat (PR-3) and every
    // future migrated protocol drain on the same cadence so
    // operators see a single "outbox tick" beat.
    this.messengerOutboxTimer = setInterval(() => {
      const now = Date.now();
      this.messenger.processOutboxTick(now)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Messenger-outbox retry tick failed: ${message}`);
        })
        .finally(() => {
          const dropped = this.messenger.dropExpiredOutbox(now);
          for (const entry of dropped) {
            this.log.warn(
              ctx,
              `Messenger-outbox dropped after ${entry.attempts} attempts: ` +
                `peer=${entry.peer.slice(-8)} protocol=${entry.protocol} ` +
                `msgId=${entry.messageId.slice(0, 8)} lastError="${entry.lastError}"`,
            );
          }
        });
    }, MESSAGE_OUTBOX_TICK_MS);
    if (this.messengerOutboxTimer.unref) this.messengerOutboxTimer.unref();

    // The durable finalization inbox is an executable retry queue, not only a
    // write-ahead journal. Its lifecycle is independent of chain-cursor
    // progress so entries received after a watermark advance are still
    // reconsidered. The worker batches SQLite reads but serializes graph work.
    if (this.finalizationRuntime.getRecoveryStore()) {
      this.getOrCreateFinalizationHandler().startRecoveryWorker();
    }

    // Wire V10 Random Sampling prover. Edge nodes no-op. Core nodes with
    // transient identity/RPC startup failures retry in the background so
    // one flaky `getIdentityId()` call does not disable proving until the
    // next process restart.
    const rsStart = await this.tryStartRandomSamplingProver(ctx, true);
    if (rsStart === 'retryable') {
      this.scheduleRandomSamplingBindRetry(ctx);
    }

    // Arm VM work only at the final successful-start boundary. Every network,
    // subscription, protocol, and persistence dependency is now initialized,
    // and both initial start and same-object restart retain the cold-start
    // jitter instead of launching an eager sweep against the old runtime.
    this.vmReconcileRuntimeReady = true;
    if (this.vmReconcileEnabled()) {
      this.ensureVmReconcileDispatcher();
      const runSweep = (): void => {
        this.runVmReconcileSweep().catch((err: unknown) => {
          this.log.warn(ctx, `VM reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      const startupDelayMs = deterministicStartupJitterMs(
        `${this.node.peerId.toString()}\0${this.chain.chainId}`,
        DKGAgentBase.VM_RECONCILE_STARTUP_MAX_DELAY_MS,
      );
      this.vmReconcileStartupTimer = scheduleAfterStartupJitter(
        () => {
          this.vmReconcileStartupTimer = null;
          runSweep();
        },
        startupDelayMs,
        DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS,
        (timer) => {
          this.vmReconcileTimer = timer;
          if (timer.unref) timer.unref();
        },
      );
      if (this.vmReconcileStartupTimer.unref) this.vmReconcileStartupTimer.unref();
      this.log.info(ctx, `Chain-driven VM reconciliation armed (startupDelay ${startupDelayMs}ms, sweep ${DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS}ms, depth ${DKGAgentBase.VM_RECONCILE_CONFIRMATION_DEPTH})`);
    }
  }

  /**
   * OT-RFC-59 changelog delta lane handler (PROTOCOL_SYNC_CHANGELOG). Reuses the
   * SAME per-CG RFC-49 authorization as the legacy sync lane, then serves a
   * bounded O(delta) page from the change log via {@link readChangelogDeltaPage}
   * instead of the O(store) scan. Registered only when the changelog is enabled
   * (see start()).
   */
  private async handleChangelogSync(
    this: DKGAgent,
    data: Uint8Array,
    peerId: string,
    options: { signal?: AbortSignal } | undefined,
    reader: ChangelogReader,
  ): Promise<Uint8Array> {
    let request;
    try {
      request = decodeChangelogRequest(data);
    } catch {
      // Malformed peer bytes → deny (mirrors the legacy lane's parse-fail path).
      return encodeChangelogResponse({ kind: 'denied' });
    }
    // Same per-CG gate as PROTOCOL_SYNC: public CGs are open (returns true),
    // private CGs verify the signed digest — a bare (unsigned) changelog request
    // carries no digest, so `authorizePrivateSyncRequest` denies it. Any throw on a
    // malformed envelope must fail CLOSED (deny), never escape as a handler error.
    let authorized = false;
    try {
      authorized = await this.authorizeSyncRequest(
        request as unknown as SyncRequestEnvelope,
        peerId,
        { signal: options?.signal },
      );
    } catch {
      return encodeChangelogResponse({ kind: 'denied' });
    }
    if (!authorized) return encodeChangelogResponse({ kind: 'denied' });
    const resp = await readChangelogDeltaPage({
      reader,
      store: this.store,
      contextGraphId: request.contextGraphId,
      sinceSeq: request.sinceSeq,
      requesterEra: request.era,
      // Clamp the peer-controlled scan limit: an unbounded value would let a peer
      // force an O(limit) log scan (DoS). Honest requesters send SYNC_PAGE_SIZE.
      limit: Math.min(Math.max(1, request.limit), CHANGELOG_MAX_SCAN_LIMIT),
      signal: options?.signal,
    });
    return encodeChangelogResponse(resp);
  }

  randomSamplingLogger(this: DKGAgent, ctx: OperationContext) {
    return {
      info: (event: string, fields: Record<string, unknown>) =>
        this.log.info(ctx, `[${event}] ${JSON.stringify(fields)}`),
      warn: (event: string, fields: Record<string, unknown>) =>
        this.log.warn(ctx, `[${event}] ${JSON.stringify(fields)}`),
      error: (event: string, fields: Record<string, unknown>) =>
        this.log.error(ctx, `[${event}] ${JSON.stringify(fields)}`),
    };
  }

  /** Bind fresh resources before the lifecycle takes replacement ownership. */
  createRandomSamplingHandle(
    this: DKGAgent,
    options: Parameters<typeof bindRandomSampling>[0],
  ): ReturnType<typeof bindRandomSampling> {
    return bindRandomSampling(options);
  }

  /** Thin lifecycle adapter for the bounded proof-time exact-repair runner. */
  repairRandomSamplingKnowledgeAsset(
    this: DKGAgent,
    input: RandomSamplingExactRepairInput,
  ): RandomSamplingRepairOperation {
    const ctx = createOperationContext('sync');
    const dependencies = {
      chainId: this.chain.chainId,
      maxPeers: DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
      stopSignal: this.node.stopSignal,
      resolveStorageAddress: (_signal) => this.chain.getDKGKnowledgeAssetsAddress
        ? this.chain.getDKGKnowledgeAssetsAddress()
        : this.chain.getKnowledgeAssetsLifecycleAddress(),
      resolveLocalContextGraphId: (cgId, signal) =>
        this.resolveRandomSamplingLocalContextGraphId(cgId, signal),
      resolveCandidatePeerIds: async (localContextGraphId, signal) => {
        const isCurrent = () => this.started && !signal.aborted;
        const curatorResolution = await this.resolveCuratorPeerIdsForCg(
          localContextGraphId,
          {
            maxPeerIds: DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
            signal,
            isCurrent,
          },
        ).catch((error) => {
          if (signal.aborted) throw signal.reason ?? error;
          return { peerIds: [] as string[] };
        });
        if (!isCurrent()) {
          throw signal.reason ?? asSyncFetchAbortError(new Error(
            `Random Sampling provider discovery for ${localContextGraphId} is no longer current`,
          ));
        }
        const observedPeerIds = this.vmReconcileObservedCandidatePeerIds(
          localContextGraphId,
        );
        const connectedPeerIds = this.node.libp2p.getConnections()
          .map((connection) => connection.remotePeer.toString());
        return [...new Set([
          ...curatorResolution.peerIds,
          ...observedPeerIds,
          this.preferredSyncPeers.get(localContextGraphId),
          ...connectedPeerIds,
        ].filter((peerId): peerId is string => Boolean(
          peerId && peerId !== this.peerId,
        )))];
      },
      selectPeerWindow: (peerIds, options) => this.selectCatchupPeerWindow(
        peerIds.map((peerId) => ({ toString: () => peerId })),
        options,
      ).map((peer) => peer.toString()),
      preparePeer: async (peerId, signal) => {
        if (!(await this.ensurePeerAdmittedForRecovery(
          peerId,
          ctx,
          'Random Sampling exact repair peer',
          signal,
        ))) return false;
        await this.ensurePeerConnected(peerId, { signal });
        return this.waitForSyncProtocol({ toString: () => peerId }, signal);
      },
      fetchExactKnowledgeAsset: async (
        peerId,
        localContextGraphId,
        expectedCommitment,
        signal,
      ) => {
        const result = await this.syncExactKnowledgeAssetsFromPeerDetailed(
          peerId,
          localContextGraphId,
          createChallengePinnedExactAssetSelection([expectedCommitment]),
          {
            signal,
            isCurrent: () => this.started && !signal.aborted,
          },
        );
        const authenticated = result.authenticatedAssets?.find(
          ({ asset }) => asset.ual === expectedCommitment.assetUal,
        );
        if (authenticated !== undefined) {
          return {
            kind: 'found' as const,
            material: Object.freeze({
              contents: Object.freeze(authenticated.asset.dataQuads.map((quad) => (
                tripleContentV10(quad.subject, quad.predicate, quad.object)
              ))),
              privateRoots: Object.freeze([...authenticated.privateRoots]),
            }),
          };
        }
        return {
          kind: 'miss' as const,
          // A durable fetch can report `found` based on storage progress even
          // when it produced no challenge-authenticated material. At this
          // proof boundary that is necessarily an incomplete miss.
          disposition: result.disposition === 'clean-absent'
            ? 'clean-absent' as const
            : 'incomplete' as const,
        };
      },
      logInfo: (message) => this.log.info(ctx, message),
    } satisfies RandomSamplingExactRepairDependencies;
    return startRandomSamplingExactRepair(dependencies, input);
  }

  async tryStartRandomSamplingProver(this: DKGAgent,
    ctx: OperationContext,
    logDisabled: boolean,
  ): Promise<RandomSamplingStartResult> {
    if (!this.started) return 'disabled';
    const rsRole: 'core' | 'edge' = (this.config.nodeRole ?? 'edge') === 'core' ? 'core' : 'edge';
    if (rsRole !== 'core') {
      this.randomSamplingIdentityId = 0n;
      this.randomSamplingDisabledReason = 'edge_node';
      return 'disabled';
    }
    if (this.chain.chainId === 'none') {
      this.randomSamplingDisabledReason = 'unsupported_chain';
      return 'disabled';
    }

    let rsIdentityId = 0n;
    try {
      rsIdentityId = await this.chain.getIdentityId();
    } catch (err) {
      this.randomSamplingDisabledReason = 'identity_lookup_failed';
      this.log.warn(
        ctx,
        `V10 Random Sampling identity lookup failed; prover bind will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'retryable';
    }
    this.randomSamplingIdentityId = rsIdentityId;

    if (rsIdentityId === 0n) {
      this.randomSamplingDisabledReason = 'no_identity';
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=0, chain=${this.chain.chainId}); will retry`);
      }
      return 'retryable';
    }

    const readiness = this.chain.isRandomSamplingReady;
    if (typeof readiness === 'function') {
      try {
        if (!readiness.call(this.chain)) {
          this.randomSamplingDisabledReason = 'contracts_not_deployed';
          this.log.warn(
            ctx,
            'V10 Random Sampling contracts are unavailable on this chain; disabling prover',
          );
          return 'disabled';
        }
      } catch (err) {
        this.randomSamplingDisabledReason = 'bind_failed';
        this.log.warn(
          ctx,
          `V10 Random Sampling readiness probe failed; prover bind will retry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'retryable';
      }
    }

    const membershipProbe = this.chain.isShardingTableMember?.bind(this.chain);
    if (!membershipProbe) {
      this.randomSamplingDisabledReason = 'unsupported_chain';
      this.log.warn(
        ctx,
        'V10 Random Sampling requires isShardingTableMember(); disabling for this adapter',
      );
      return 'disabled';
    }

    try {
      if (!(await membershipProbe(rsIdentityId))) {
        this.randomSamplingDisabledReason = 'awaiting_sharding_table';
        if (logDisabled) {
          this.log.info(
            ctx,
            `V10 Random Sampling prover waiting: identityId=${rsIdentityId} ` +
              'is not in the active sharding table; will retry after staking/admission',
          );
        }
        return 'retryable';
      }
    } catch (err) {
      if (isMissingShardingTableContractError(err)) {
        this.randomSamplingDisabledReason = 'contracts_not_deployed';
        this.log.warn(
          ctx,
          `V10 Random Sampling sharding-table contract is unavailable; disabling prover: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'disabled';
      }
      this.randomSamplingDisabledReason = 'eligibility_lookup_failed';
      this.log.warn(
        ctx,
        `V10 Random Sampling eligibility lookup failed; prover bind will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'retryable';
    }
    if (!this.started) return 'disabled';

    try {
      const handle = await this.createRandomSamplingHandle({
        role: rsRole,
        chain: this.chain,
        store: this.store,
        identityId: rsIdentityId,
        walPath: this.config.randomSamplingWalPath,
        useWorkerThread: this.config.randomSamplingUseWorkerThread ?? true,
        tickIntervalMs: this.config.randomSamplingTickIntervalMs,
        log: this.randomSamplingLogger(ctx),
        repairMissingKnowledgeAsset: (input) =>
          this.repairRandomSamplingKnowledgeAsset(input),
      });
      if (this.randomSamplingHandle && this.randomSamplingHandle !== handle) {
        try {
          await stopRandomSamplingHandleWithin(
            this.randomSamplingHandle,
            DKGAgentBase.RANDOM_SAMPLING_SHUTDOWN_TIMEOUT_MS,
          );
        } catch (error) {
          if (error instanceof RandomSamplingShutdownTimeoutError) {
            // The replacement has not started, so retire its fresh resources
            // and keep the old handle quarantined until its physical close can
            // be observed by a later lifecycle retry.
            try { await handle.stop(); } catch { /* best-effort unused-handle cleanup */ }
            throw error;
          }
          this.log.warn(
            ctx,
            `Previous V10 Random Sampling prover close failed during replacement: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      this.randomSamplingHandle = handle;
      if (handle.enabled) {
        if (!this.started) {
          try { await handle.stop(); } catch { /* swallow shutdown race cleanup */ }
          return 'disabled';
        }
        this.randomSamplingDisabledReason = 'not_started';
        handle.start();
        this.clearRandomSamplingBindRetry();
        this.log.info(ctx, `V10 Random Sampling prover started (identityId=${rsIdentityId})`);
        return 'started';
      }
      this.randomSamplingDisabledReason = handle.getStatus().disabledReason ?? 'bind_failed';
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=${rsIdentityId}, chain=${this.chain.chainId})`);
      }
      return 'disabled';
    } catch (err) {
      this.randomSamplingDisabledReason = 'bind_failed';
      this.log.warn(ctx, `Failed to bind V10 Random Sampling prover: ${err instanceof Error ? err.message : String(err)}`);
      return 'retryable';
    }
  }

  scheduleRandomSamplingBindRetry(this: DKGAgent, ctx: OperationContext): void {
    if (this.randomSamplingBindRetryTimer) return;
    this.log.warn(ctx, `V10 Random Sampling prover bind will retry every ${RANDOM_SAMPLING_BIND_RETRY_MS}ms`);
    this.randomSamplingBindRetryTimer = setInterval(() => {
      if (!this.started || this.randomSamplingBindRetryInFlight || this.randomSamplingHandle?.enabled) return;
      this.randomSamplingBindRetryInFlight = true;
      this.tryStartRandomSamplingProver(ctx, false)
        .then((result) => {
          if (result === 'started' || result === 'disabled') {
            this.clearRandomSamplingBindRetry();
          }
        })
        .catch((err: unknown) => {
          this.log.warn(ctx, `V10 Random Sampling prover retry failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.randomSamplingBindRetryInFlight = false;
        });
    }, RANDOM_SAMPLING_BIND_RETRY_MS);
    if (this.randomSamplingBindRetryTimer.unref) this.randomSamplingBindRetryTimer.unref();
  }

  clearRandomSamplingBindRetry(this: DKGAgent): void {
    if (!this.randomSamplingBindRetryTimer) return;
    clearInterval(this.randomSamplingBindRetryTimer);
    this.randomSamplingBindRetryTimer = null;
  }

  clearStorageACKRegistrationRetry(this: DKGAgent): void {
    if (!this.storageACKRegistrationRetryTimer) return;
    clearTimeout(this.storageACKRegistrationRetryTimer);
    this.storageACKRegistrationRetryTimer = null;
  }

  syncOnConnectDisconnectBoundary(this: DKGAgent, remotePeer: string, now = Date.now()): number {
    const lastDisconnected = this.lastSyncDisconnectedAt.get(remotePeer) ?? 0;
    if (lastDisconnected === 0) return 0;
    return now - lastDisconnected >= SYNC_RECONNECT_FLAP_GRACE_MS ? lastDisconnected : 0;
  }

  clearNetworkRejectedPeerState(this: DKGAgent, remotePeer: string): void {
    this.knownCorePeerIds.delete(remotePeer);
    this.knownCorePeerIdsV2.delete(remotePeer);
    this.skippedNoSyncPeers.delete(remotePeer);
    this.catchupOnConnectAt.delete(remotePeer);
    this.rfc64ExactCatchupOnConnectAt.delete(remotePeer);
    this.lastSyncDisconnectedAt.delete(remotePeer);
    this.lastSuccessfulSyncAt.delete(remotePeer);
    this.lastSyncProgressAt.delete(remotePeer);
    this.selectedSwmBootstrapAdmission.clear(remotePeer);
    this.syncOnConnectPeerScheduler?.clear(remotePeer);
    this.syncReconcilerBackoff.delete(remotePeer);
    this.warmedCores.delete(remotePeer);
    this.warmCoreFailedUnpins.delete(remotePeer);
  }

  queueSelectedSwmFromPeerOnConnect(
    this: DKGAgent,
    remotePeer: string,
    handleSyncError: (remotePeer: string, err: unknown) => void,
    delayMs = 3000,
  ): boolean {
    const selectedContextGraphIds = this.selectedSwmBootstrapContextGraphIdsForPeer(remotePeer);
    // One graph-scoped owner decides whether this exact peer/scope pair is a
    // first seed, an incomplete retry, or already terminal. A changed runtime
    // subscription scope is a new bounded admission.
    if (!this.rfc64SwmRecoveryCoordinatorV1.admitSelectedPublic(
      remotePeer,
      selectedContextGraphIds,
    )) {
      return false;
    }
    return this.queueSyncFromPeerOnConnect(
      remotePeer,
      handleSyncError,
      delayMs,
      { selectedSwmRetry: true },
    );
  }

  /** Compatibility boundary for callers that still hold an untrusted raw plan. */
  queueRfc64SwmRecoveryPlanFromPeerOnConnect(
    this: DKGAgent,
    recoveryPlan: Readonly<Rfc64PeerSwmRecoveryPlanV1>,
    handleSyncError: (remotePeer: string, err: unknown) => void,
    delayMs = 3000,
  ): boolean {
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(recoveryPlan.providerPeerId)) {
      return false;
    }
    const authorized = this.rfc64SwmRecoveryCoordinatorV1.authorize(recoveryPlan);
    if (authorized === null) return false;
    return this.queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
      authorized,
      handleSyncError,
      delayMs,
    );
  }

  /** Canonical execution boundary for a coordinator-authorized immutable plan. */
  queueAuthorizedRfc64SwmRecoveryPlanFromPeerOnConnect(
    this: DKGAgent,
    recoveryPlan: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
    handleSyncError: (remotePeer: string, err: unknown) => void,
    delayMs = 3000,
  ): boolean {
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(recoveryPlan.providerPeerId)) {
      return false;
    }
    return this.queueSyncFromPeerOnConnect(
      recoveryPlan.providerPeerId,
      handleSyncError,
      delayMs,
      { selectedSwmRetry: true, rfc64RecoveryPlan: recoveryPlan },
    );
  }

  selectedSwmBootstrapContextGraphIdsForPeer(
    this: DKGAgent,
    remotePeer: string,
  ): readonly string[] {
    const selected = new Set(this.config.syncContextGraphs ?? []);
    return resolveRfc64SelectedRecoveryContextGraphIdsForProviderV1(
      this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
      remotePeer,
    ).filter((contextGraphId) => selected.has(contextGraphId));
  }

  /**
   * Project the selected RFC-64 retry owner into a graph-scoped, identity-safe
   * operator status. `continuing` means automatic continuation is still
   * required; it deliberately does not claim a transfer is in flight at this
   * exact instant.
   */
  getRfc64SelectedSwmGraphSyncStatus(
    this: DKGAgent,
    contextGraphId: string,
  ): Rfc64SelectedSwmGraphSyncStatus {
    const selected = (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    const providerPeerIds = [
      ...new Set(this.resolveRfc64CompleteSwmProviderPeerIdsV1(contextGraphId)),
    ];
    const summary = this.selectedSwmBootstrapAdmission.summarizeContextGraph(
      contextGraphId,
      providerPeerIds,
    );
    const sharedMemorySynced =
      this.subscribedContextGraphs.get(contextGraphId)?.sharedMemorySynced === true;
    return projectRfc64SelectedSwmGraphSyncStatus({
      selected,
      configuredProviderCount: providerPeerIds.length,
      retryRequiredProviderCount: summary.retryRequiredProviders,
      terminalProviderCount: summary.terminalProviders,
      sharedMemorySynced,
    });
  }

  getSyncOnConnectPeerScheduler(
    this: DKGAgent,
  ): SyncOnConnectPeerScheduler<Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>> {
    this.syncOnConnectPeerScheduler ??= new SyncOnConnectPeerScheduler({
      createJob: (remotePeer) => this.createSyncOnConnectPeerJobRunner(remotePeer),
      onInternalError: (remotePeer, error, stage) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.log.error(
          createOperationContext('sync'),
          `Sync-on-connect scheduler ${stage} failure for ${remotePeer.slice(-8)}: ${detail}`,
        );
      },
    });
    return this.syncOnConnectPeerScheduler;
  }

  protected createSyncOnConnectPeerJobRunner(
    this: DKGAgent,
    remotePeer: string,
    options: Readonly<{
      initialProbe?: SyncReconcilerProbe;
      source?: SyncAdmissionSource;
    }> = {},
  ): ReconciledSyncOnConnectPeerJobRunner<
    Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
    SyncReconcilerProbe
  > {
    const source = options.source ?? 'on-connect';
    const jobAdmittedByInitialProbe = options.initialProbe !== undefined;
    const automaticSelectedContextGraphIds = syncOnConnectEnabled(this.config)
      && (this.config.syncSharedMemoryOnConnect ?? true)
      ? this.selectedSwmBootstrapContextGraphIdsForPeer(remotePeer)
      : [];
    return new ReconciledSyncOnConnectPeerJobRunner({
      acquireProbe: async () => {
        // A supplied probe means the reconciler already admitted this whole
        // peer-job transaction. Refresh later phase probes, but do not let the
        // backoff that was explicitly bypassed suppress its invariant ordinary
        // phase after optional selected work consumes the initial probe.
        if (!jobAdmittedByInitialProbe) {
          const backoff = this.syncReconcilerBackoff.get(remotePeer);
          if (backoff && Date.now() < backoff.nextRetryAt) return null;
        }
        return this.getSyncReconcilerProbe(remotePeer);
      },
      runSelected: (recoveryPlan) => captureSyncOnConnectAttempt(
        (onSyncAccounting) => this.trySelectedSwmRetryFromPeer(
          remotePeer,
          onSyncAccounting,
          source,
          recoveryPlan,
        ),
      ),
      ...(automaticSelectedContextGraphIds.length === 0
        ? {}
        : {
          runAutomaticSelected: () => captureSyncOnConnectAttempt(
            (onSyncAccounting) => this.trySelectedSwmRetryFromPeer(
              remotePeer,
              onSyncAccounting,
              source,
            ),
          ),
        }),
      runOrdinary: () => captureSyncOnConnectAttempt(
        (onSyncAccounting) => this.trySyncFromPeer(
          remotePeer,
          onSyncAccounting,
          source,
        ),
      ),
      selectedRetryStillRequired: () => (
        this.selectedSwmBootstrapAdmission.isRetryRequired(remotePeer)
      ),
      resetBackoffBeforeRetry: () => {
        this.syncReconcilerBackoff.delete(remotePeer);
      },
      commitAccounting: (outcome, probe) => {
        this.applySyncOnConnectAccounting(remotePeer, outcome, probe);
      },
      logBackpressure: (backpressureDetail) => {
        const detail = backpressureDetail === undefined ? '' : `: ${backpressureDetail}`;
        this.log.info(
          createOperationContext('sync'),
          `Deferring sync from peer ${remotePeer.slice(-8)} due to local backpressure${detail}`,
        );
      },
    }, options);
  }

  queueSyncFromPeerOnConnect(
    this: DKGAgent,
    remotePeer: string,
    handleSyncError: (remotePeer: string, err: unknown) => void,
    delayMs = 3000,
    options: {
      selectedSwmRetry?: boolean;
      rfc64RecoveryPlan?: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>;
    } = {},
  ): boolean {
    const syncTiming = this.config.syncReconcilerTiming;
    const selectedSwmRetryRequired = options.rfc64RecoveryPlan !== undefined
      || (
        options.selectedSwmRetry === true
        && this.selectedSwmBootstrapAdmission.isRetryRequired(remotePeer)
      );
    if (!syncOnConnectEnabled(this.config) && !selectedSwmRetryRequired) return false;
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(remotePeer)) {
      return false;
    }
    const now = Date.now();
    const disconnectBoundary = this.syncOnConnectDisconnectBoundary(remotePeer, now);
    const exactRecoveryPlan = options.rfc64RecoveryPlan;
    const lastExactQueued = this.rfc64ExactCatchupOnConnectAt.get(remotePeer) ?? 0;
    if (
      exactRecoveryPlan !== undefined
      && lastExactQueued > disconnectBoundary
      && now - lastExactQueued < CATCHUP_ON_CONNECT_COOLDOWN_MS
    ) {
      return false;
    }
    const lastSuccessfulSync = this.lastSuccessfulSyncAt.get(remotePeer);
    if (
      !selectedSwmRetryRequired &&
      lastSuccessfulSync != null &&
      lastSuccessfulSync > disconnectBoundary &&
      now - lastSuccessfulSync < syncTiming.stalenessThresholdMs
    ) {
      return false;
    }

    const scheduler = this.getSyncOnConnectPeerScheduler();
    if (scheduler.has(remotePeer)) {
      if (exactRecoveryPlan !== undefined) {
        const enqueued = scheduler.enqueueSelected(
          remotePeer,
          handleSyncError,
          delayMs,
          exactRecoveryPlan,
        );
        if (enqueued) this.rfc64ExactCatchupOnConnectAt.set(remotePeer, now);
        return enqueued;
      }
      return selectedSwmRetryRequired
        ? false
        : scheduler.enqueueOrdinary(remotePeer, handleSyncError, delayMs);
    }

    const lastQueued = this.catchupOnConnectAt.get(remotePeer) ?? 0;
    if (lastQueued > disconnectBoundary && now - lastQueued < CATCHUP_ON_CONNECT_COOLDOWN_MS) {
      // One exact post-catalog recovery may arrive just after an ordinary
      // timer completed. Its dedicated timestamp above permits that upgrade
      // once while keeping subsequent periodic exact plans bounded.
      if (exactRecoveryPlan === undefined) return false;
    }

    const backoff = this.syncReconcilerBackoff.get(remotePeer);
    if (backoff && now < backoff.nextRetryAt) {
      return false;
    }

    this.catchupOnConnectAt.set(remotePeer, now);
    if (exactRecoveryPlan !== undefined) {
      this.rfc64ExactCatchupOnConnectAt.set(remotePeer, now);
    }
    return selectedSwmRetryRequired
      ? scheduler.enqueueSelected(
        remotePeer,
        handleSyncError,
        delayMs,
        exactRecoveryPlan,
      )
      : scheduler.enqueueOrdinary(remotePeer, handleSyncError, delayMs);
  }

  async attemptSyncFromPeerWithReconcilerAccounting(
    this: DKGAgent,
    remotePeer: string,
    probe: SyncReconcilerProbe,
    source: SyncAdmissionSource = 'on-connect',
  ): Promise<SyncReconcilerAttemptOutcome> {
    if (!syncOnConnectEnabled(this.config)) return 'not-started';
    const runner = this.createSyncOnConnectPeerJobRunner(remotePeer, {
      initialProbe: probe,
      source,
    });
    try {
      return await runner.runAutomaticSelectedThenOrdinary();
    } finally {
      runner.finish();
    }
  }

  async attemptSelectedSwmRetryWithReconcilerAccounting(
    this: DKGAgent,
    remotePeer: string,
    probe: SyncReconcilerProbe,
    source: SyncAdmissionSource = 'on-connect',
    recoveryPlan?: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
  ): Promise<SyncReconcilerAttemptOutcome> {
    if (
      recoveryPlan === undefined
      && !this.selectedSwmBootstrapAdmission.isRetryRequired(remotePeer)
    ) return 'not-started';
    const runner = this.createSyncOnConnectPeerJobRunner(remotePeer, {
      initialProbe: probe,
      source,
    });
    try {
      return await runner.runSelected(recoveryPlan);
    } finally {
      runner.finish();
    }
  }

  /**
   * Pull all triples for the given context graphs from a remote peer and merge
   * them into our local store. Used on peer:connect for initial catch-up,
   * with a per-peer guard to avoid overlapping sync storms.
   */
  async trySyncFromPeer(
    this: DKGAgent,
    remotePeer: string,
    onSyncAccounting?: (outcome: SyncOnConnectPeerOutcome) => void,
    source: SyncAdmissionSource = 'on-connect',
  ): Promise<SyncOnConnectOutcome | 'not-started'> {
    if (!this.started || !syncOnConnectEnabled(this.config)) return 'not-started';
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(remotePeer)) {
      return 'not-started';
    }
    const automaticPeerSweep = source === 'on-connect' || source === 'reconcile';
    const acceptedPolicies = (this.config.rfc64CatalogBootstrap?.acceptedPolicies
      ?? this.config.rfc64PublicCatalogBootstrap?.acceptedPublicPolicies
      ?? []).filter(({ policyEnvelope }) => this.resolveRfc64CatalogReceiverAuthorityV1(
        policyEnvelope.payload.contextGraphId,
      ).legacySyncAllowed);
    // Private RFC-64 selections stay out of `syncContextGraphs`: that list is
    // also the automatic durable/VM scope, and private VM recovery belongs to
    // catalog activation. They still need an explicit SWM-only planning scope
    // so the ordinary private curator-replacement lane can run.
    const namedSubgraphCompatibilityContextGraphIds = [
      ...this.subscribedContextGraphs.entries(),
    ].filter(([contextGraphId, subscription]) => (
      subscription.subscribed === true
      && !this.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)
    )).map(([contextGraphId]) => contextGraphId);
    const sharedMemoryRecoveryContextGraphIds = [...new Set([
      ...(this.config.syncContextGraphs ?? []),
      ...namedSubgraphCompatibilityContextGraphIds,
      ...resolveRfc64PrivateRecoveryContextGraphIdsV1(
        this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
      ).filter((contextGraphId) => this.resolveRfc64CatalogReceiverAuthorityV1(
        contextGraphId,
      ).legacySyncAllowed),
    ])];
    const remotePeerIsCompleteSwmProvider = acceptedPolicies.some(
        ({ completeSwmProviders = [] }) => completeSwmProviders.includes(remotePeer),
      );
    const selectedPublicContextGraphIds = new Set(
      this.selectedSwmBootstrapContextGraphIdsForPeer(remotePeer),
    );
    const selectedLaneOwnsPinnedPublicGraphs = automaticPeerSweep
      && (
        remotePeerIsCompleteSwmProvider
        || selectedPublicContextGraphIds.size > 0
      );
    const getPostDurableOrdinarySharedMemoryPlan = async (
      peerId: string,
    ): Promise<SharedMemorySyncContextGraphPlan> => (
      ordinarySharedMemorySyncContextGraphPlan(
        await this.planSharedMemorySyncContextGraphs(
          peerId,
          sharedMemoryRecoveryContextGraphIds,
          createOperationContext('sync'),
        ),
        selectedLaneOwnsPinnedPublicGraphs
          ? selectedPublicContextGraphIds
          : new Set<string>(),
      )
    );
    return runSyncOnConnect({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      knownCorePeerIds: this.knownCorePeerIds,
      knownCorePeerIdsV2: this.knownCorePeerIdsV2,
      getSyncContextGraphs: () => this.config.syncContextGraphs ?? [],
      getDurableSyncContextGraphs: () => automaticDurableSyncContextGraphs(
        this.config.syncContextGraphs ?? [],
        {
          nodeRole: this.config.nodeRole,
          configValue: this.config.syncSystemContextGraphsOnConnect,
          envValue: process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT,
        },
      ).filter((contextGraphId) => {
        const completeSwmProviders = this.resolveRfc64CompleteSwmProviderPeerIdsV1(
          contextGraphId,
        );
        // For an RFC-64 selected public CG, VM/durable inventory is chain/core
        // territory. An Edge that was pinned as the complete SWM source must
        // not start a duplicate durable pull before its useful SWM transfer;
        // unrelated Edge peers should do neither plane in the automatic sweep.
        return completeSwmProviders.length === 0 || this.knownCorePeerIds.has(remotePeer);
      }),
      syncFromPeer: async (peerId, contextGraphIds) => {
        const requestedContextGraphIds = contextGraphIds
          ?? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])];
        const selectedRecoveryGraphs = new Set(this.config.syncContextGraphs ?? []);
        const coordinated = requestedContextGraphIds.filter(
          (contextGraphId) => selectedRecoveryGraphs.has(contextGraphId),
        );
        const ordinary = requestedContextGraphIds.filter(
          (contextGraphId) => !selectedRecoveryGraphs.has(contextGraphId),
        );
        const accumulator = createDurableSyncAccumulator();
        for (const contextGraphId of coordinated) {
          if (typeof this.syncDurableRecoveryContextGraph === 'function') {
            const recovery = await this.syncDurableRecoveryContextGraph(contextGraphId, {
              candidatePeerIds: [peerId],
              candidatesAreSyncCapable: true,
            });
            mergeDurableSyncResultIntoAccumulator(accumulator, recovery.result);
          } else {
            // Structural embedders and focused lifecycle test doubles may expose
            // only the legacy detailed seam. Keep that typed compatibility path
            // without changing the full production agent's graph-owned runner.
            mergeDurableSyncResultIntoAccumulator(
              accumulator,
              await this.syncFromPeerDetailed(
                peerId,
                [contextGraphId],
                undefined,
                undefined,
                undefined,
                { stopOnBackoffWorthyFailure: true, source },
              ),
            );
          }
        }
        if (ordinary.length > 0) {
          mergeDurableSyncResultIntoAccumulator(
            accumulator,
            await this.syncFromPeerDetailed(
              peerId,
              ordinary,
              undefined,
              undefined,
              undefined,
              { stopOnBackoffWorthyFailure: true, source },
            ),
          );
        }
        return finalizeDurableSyncCompletion(accumulator);
      },
      refreshMetaSyncedFlags: (contextGraphIds) => this.refreshMetaSyncedFlags(contextGraphIds),
      discoverContextGraphsFromStore: () => this.discoverContextGraphsFromStore(),
      ordinarySharedMemoryLane: {
        resolveWork: async (peerId) => {
          // runSyncOnConnect resolves this work only after durable metadata and
          // discovery, so newly authorized/visible ordinary CGs join this run.
          const ordinaryPlan = await getPostDurableOrdinarySharedMemoryPlan(peerId);
          const contextGraphIds = sharedMemoryPlanContextGraphIds(
            ordinaryPlan,
          );
          return Object.freeze({
            contextGraphIds: Object.freeze([...contextGraphIds]),
            syncFromPeer: () => this.syncSharedMemoryFromPeerDetailed(
              peerId,
              [...contextGraphIds],
              {
                stopOnBackoffWorthyFailure: true,
                source,
                sharedMemorySyncPlan: ordinaryPlan,
              },
            ),
          });
        },
      },
      syncSharedMemoryOnConnect: syncOnConnectEnabled(this.config)
        && (this.config.syncSharedMemoryOnConnect ?? true),
      logInfo: (ctx, message) => this.log.info(ctx, message),
      onPeerSkippedNoSync: (peerId) => {
        this.skippedNoSyncPeers.add(peerId);
      },
      onSyncAccounting: (peerId, outcome) => {
        if (onSyncAccounting) {
          onSyncAccounting(outcome);
        } else {
          this.applySyncOnConnectAccounting(peerId, outcome);
        }
      },
    });
  }

  async trySelectedSwmRetryFromPeer(
    this: DKGAgent,
    remotePeer: string,
    onSyncAccounting?: (outcome: SyncOnConnectPeerOutcome) => void,
    source: SyncAdmissionSource = 'on-connect',
    recoveryPlan?: Readonly<Rfc64AuthorizedSwmRecoveryPlanV1>,
  ): Promise<SyncOnConnectOutcome | 'not-started'> {
    if (!this.started) return 'not-started';
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(remotePeer)) {
      return 'not-started';
    }
    const validatedRecoveryPlan = recoveryPlan === undefined
      ? null
      : this.rfc64SwmRecoveryCoordinatorV1.revalidate(recoveryPlan);
    const requestedScope: SelectedSharedMemoryRequestedScope = validatedRecoveryPlan === null
      ? {
        kind: 'selected-public',
        targets: sharedMemoryPlanTargets(
          await this.planSharedMemorySyncContextGraphs(
            remotePeer,
            this.config.syncContextGraphs ?? [],
            createOperationContext('sync'),
            { requireCompleteProviderMatch: true },
          ),
          'selected-public',
        ),
      }
      : {
        kind: 'rfc64-recovery-plan',
        plan: validatedRecoveryPlan,
      };
    const requestedTargets = requestedScope.kind === 'rfc64-recovery-plan'
      ? requestedScope.plan.targets
      : requestedScope.targets;
    const requestedContextGraphIds = requestedTargets.map(({ contextGraphId }) => contextGraphId);
    if (requestedContextGraphIds.length === 0) {
      this.selectedSwmBootstrapAdmission.request(remotePeer, requestedContextGraphIds);
      return 'not-started';
    }
    if (
      requestedScope.kind === 'selected-public'
      && !this.rfc64SwmRecoveryCoordinatorV1.admitSelectedPublic(
        remotePeer,
        requestedContextGraphIds,
      )
    ) return 'not-started';
    return runSelectedSharedMemoryRetry({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      selectedSharedMemoryLane: {
        admitWork: () => Object.freeze({
          contextGraphIds: Object.freeze([...requestedContextGraphIds]),
          syncFromPeer: () => (
            this.syncSelectedSharedMemoryFromPeerDetailed(
              remotePeer,
              [...requestedContextGraphIds],
              {
                stopOnBackoffWorthyFailure: true,
                source,
                priority: RFC64_SELECTED_SWM_ADMISSION_PRIORITY,
                selectedSwmPriority: true,
                requestedScope,
              },
            )
          ),
        }),
      },
      logInfo: (ctx, message) => this.log.info(ctx, message),
      onPeerSkippedNoSync: (peerId) => {
        this.skippedNoSyncPeers.add(peerId);
      },
      onSyncAccounting: (peerId, outcome) => {
        if (onSyncAccounting) {
          onSyncAccounting(outcome);
        } else {
          this.applySyncOnConnectAccounting(peerId, outcome);
        }
      },
    });
  }

  async planSharedMemorySyncContextGraphs(
    this: DKGAgent,
    remotePeerId: string | undefined,
    contextGraphIds: readonly string[],
    ctx: OperationContext,
    options: {
      requireCompleteProviderMatch?: boolean;
    } = {},
  ): Promise<SharedMemorySyncContextGraphPlan> {
    // M2 (curator-leader convergence): a PRIVATE CG converges by REPLACE-recovering the
    // current state from its CURATOR (the authoritative SWM replica), never the
    // bidirectional mesh union-sync — which corrupts a reconnecting member into {old,new}
    // AND pollutes the curator back (proven on devnet). PUBLIC CGs keep the union path
    // (correct for cold-start / empty target).
    const targets: Rfc64SwmRecoveryTargetV1[] = [];
    // Memoized agent-registry lookup: resolve a curator WALLET -> its libp2p peer
    // via the AGENTS registry (the authoritative agent->peer map), bypassing the
    // dkg:curator/dkg:creator `_meta` triples — a member that pre-created the CG
    // self-stamps both, which would otherwise resolve the member AS the curator.
    let cachedAgents: Array<{ agentAddress?: string; peerId: string }> | undefined;
    // Resolve EVERY libp2p peer the AGENTS registry advertises for a curator
    // wallet, not the first match: `findAgents()` is not a unique wallet->peer
    // map (agent registration is consent-free, so several URIs can share a
    // wallet, and a restarted curator can linger under a stale peerId). The
    // caller only needs to know whether the CONNECTING peer is among them, so a
    // first-match pick could resolve a stale/wrong peer and wrongly defer (or,
    // for a same-wallet Byzantine advertiser, mis-gate) recovery.
    const resolveAgentPeers = async (agentAddrLower: string): Promise<string[]> => {
      if (!cachedAgents) {
        try {
          cachedAgents = await this.discovery.findAgents();
        } catch {
          cachedAgents = [];
        }
      }
      return cachedAgents
        .filter((a) => a.agentAddress?.toLowerCase() === agentAddrLower)
        .map((a) => a.peerId);
    };
    let localPeerId: string | undefined;
    try {
      localPeerId = this.peerId;
    } catch {
      localPeerId = undefined;
    }

    for (const contextGraphId of contextGraphIds) {
      const legacyRootSyncAllowed = this.resolveRfc64CatalogReceiverAuthorityV1(
        contextGraphId,
      ).legacySyncAllowed;
      const namedSubgraphCompatibilityRequired = !legacyRootSyncAllowed
        && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true;
      if (!legacyRootSyncAllowed && !namedSubgraphCompatibilityRequired) {
        this.log.debug(
          ctx,
          `Skipping legacy SWM planning for unsubscribed catalog-authoritative CG "${contextGraphId.slice(0, 28)}"`,
        );
        continue;
      }
      const completeSwmProviders = this.resolveRfc64CompleteSwmProviderPeerIdsV1(
        contextGraphId,
      );
      if (
        completeSwmProviders.length === 0
        && !(await this.canUseSharedMemoryForContextGraph(contextGraphId))
      ) {
        this.log.warn(ctx, `Skipping SWM sync for unauthorized or unconfirmed context graph "${contextGraphId}"`);
        continue;
      }
      const acceptedRecoveryLane = resolveRfc64SwmRecoveryLaneV1(
        this.config.rfc64CatalogBootstrap ?? this.config.rfc64PublicCatalogBootstrap,
        contextGraphId,
      );
      if (
        acceptedRecoveryLane === 'ordinary-private'
        || await this.isPrivateContextGraph(contextGraphId)
      ) {
        if (!remotePeerId) {
          targets.push({ contextGraphId, lane: 'ordinary-private' });
          continue;
        }
        const completeProviderSelected = isRfc64PrivateRecoveryOwnerV1(
          completeSwmProviders,
          remotePeerId,
        );
        if (completeSwmProviders.length > 0 && !completeProviderSelected) {
          this.log.debug(
            ctx,
            `SWM recovery deferred for private CG "${contextGraphId.slice(0, 28)}": connecting peer is not the elected RFC-64 recovery owner`,
          );
          continue;
        }
        const recoverySource = await planPrivateRecoverySource({
          contextGraphId,
          remotePeerId,
          completeProviderSelected,
          localAgentAddresses: this.localAgents.keys(),
          localPeerId,
          isLegacyLocalCurator: () => this.isCuratorOf(contextGraphId),
          resolveStructuralCuratorPeers: async (structuralAgent) => {
            let curatorPeers = await resolveAgentPeers(structuralAgent);
            if (curatorPeers.length === 0) {
              await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
              cachedAgents = undefined;
              curatorPeers = await resolveAgentPeers(structuralAgent);
            }
            return curatorPeers;
          },
          resolveLegacyCuratorPeer: async () => {
            let curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
            if (!curatorPeerId) {
              await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
              curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
            }
            return curatorPeerId;
          },
        });

        if (recoverySource.kind === 'recover') {
          const source = recoverySource.source === 'rfc64-complete-provider'
            ? 'RFC-64 complete provider'
            : recoverySource.source === 'structural-curator'
              ? 'curator peer'
              : 'curator';
          this.log.info(ctx, `SWM recovery ENQUEUED for private CG "${contextGraphId.slice(0, 28)}" from ${source} ${recoverySource.curatorPeerId.slice(0, 12)}`);
          targets.push({ contextGraphId, lane: 'ordinary-private' });
        } else {
          const skipLog = formatPrivateRecoverySkip(
            recoverySource,
            contextGraphId,
            remotePeerId,
          );
          this.log[skipLog.level](ctx, skipLog.message);
        }
        continue;
      }
      if (
        options.requireCompleteProviderMatch
        && (
          remotePeerId === undefined
          || !completeSwmProviders.includes(remotePeerId)
        )
      ) {
        continue;
      }
      targets.push({ contextGraphId, lane: 'selected-public' });
    }
    return enforceRfc64CompleteProviderAuthority(
      { targets },
      remotePeerId,
      (contextGraphId) => this.resolveRfc64CompleteSwmProviderPeerIdsV1(contextGraphId),
      (contextGraphId, peerId) => this.log.debug(
        ctx,
        `SWM sync: rejecting "${contextGraphId}" from ${peerId.slice(-8)} — RFC-64 complete provider selected`,
      ),
    );
  }

  async getSharedMemorySyncContextGraphs(this: DKGAgent, remotePeerId?: string): Promise<string[]> {
    const plan = await this.planSharedMemorySyncContextGraphs(
      remotePeerId,
      this.config.syncContextGraphs ?? [],
      createOperationContext('sync'),
    );
    return sharedMemoryPlanContextGraphIds(plan);
  }

  async ensurePeerAdmittedForRecovery(
    this: DKGAgent,
    peerId: string,
    ctx: OperationContext,
    label: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.networkAdmissionCoordinator.isAcceptedPeer(peerId)) return true;
    if (this.networkAdmissionCoordinator.isRejectedPeer(peerId)) return false;
    try {
      return await this.networkAdmissionCoordinator.ensureAdmitted(peerId, ctx, { signal });
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `${label} admission probe failed for ${peerId.slice(-8)}: ${message}`);
      return false;
    }
  }

  /**
   * Event-driven retry path for the libp2p identify race that otherwise
   * leaves a peer permanently in `skippedNoSyncPeers`. libp2p emits
   * `peer:update` whenever a peer record changes — most importantly when
   * identify completes and the protocol list gets populated for the
   * first time. If the new list now contains `PROTOCOL_SYNC` and we
   * previously skipped this peer for that exact reason, fire one
   * `trySyncFromPeer` immediately.
   *
   * Pairs with {@link reconcileSyncFromConnectedPeers}: the listener
   * handles the common case in <1s (libp2p delivers identify quickly
   * once it arrives), and the periodic reconciler is the safety net for
   * delivery failures of this event itself.
   */
  handlePeerUpdateForSyncRetry(this: DKGAgent, peerId: string, protocols: readonly string[]): void {
    if (peerId === this.node.libp2p.peerId.toString()) return;
    // #1093: keep the confirmed-core set fresh from `peer:update` too.
    // `runSyncOnConnect` reads the protocol list exactly once, racing
    // identify — a core peer whose identify completed late was never
    // re-classified, leaving `knownCorePeerIds` permanently partial and
    // the ACK candidate pool capped below quorum. Identify delivers the
    // complete protocol list, so add-on-present is always safe; we only
    // add (never delete) here because some `peer:update` events fire
    // with a not-yet-populated list and must not evict a known core.
    if (protocols.includes(PROTOCOL_STORAGE_ACK)) {
      this.knownCorePeerIds.add(peerId);
    }
    // V2 is a strict compatibility gate for field-20 folded-private ACKs. Keep
    // empty-list races non-destructive, but clear stale V2 membership when
    // identify delivers a populated protocol list without the V2 ACK protocol.
    if (protocols.includes(PROTOCOL_STORAGE_ACK_V2)) {
      this.knownCorePeerIdsV2.add(peerId);
    } else if (protocols.length > 0) {
      this.knownCorePeerIdsV2.delete(peerId);
    }
    if (!this.skippedNoSyncPeers.has(peerId)) return;
    if (!syncOnConnectEnabled(this.config)) return;
    if (!protocols.includes(PROTOCOL_SYNC)) return;
    const ctx = createOperationContext('sync');
    const shortPeer = peerId.slice(-8);
    void (async () => {
      const admitted = await this.ensurePeerAdmittedForRecovery(peerId, ctx, 'Peer:update sync retry');
      if (!admitted) return;
      if (!this.skippedNoSyncPeers.has(peerId)) return;
      this.skippedNoSyncPeers.delete(peerId);
      this.log.info(ctx, `Peer ${shortPeer} now advertises sync protocol — retrying sync-on-connect`);
      setTimeout(() => {
        void (async () => {
          const probe = await this.getSyncReconcilerProbe(peerId);
          await this.attemptSyncFromPeerWithReconcilerAccounting(
            peerId,
            probe,
            'on-connect',
          );
        })().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Sync retry after peer:update failed for ${shortPeer}: ${message}`);
        });
      }, 0);
    })();
  }

  /**
   * Periodic reconciler for sync-on-connect. Walks every currently
   * connected peer and retries `trySyncFromPeer` for any that either:
   *
   *   - is in {@link skippedNoSyncPeers} and now advertises `PROTOCOL_SYNC`
   *     (covers the case where the `peer:update` listener missed the
   *     event for whatever reason), or
   *   - has no recent clean success or useful-progress cooldown marker, or
   *     whose newest marker is older than {@link SYNC_STALENESS_THRESHOLD_MS}
   *     (covers slow identify, transport-level reconnects that didn't fire
   *     connection:open, and any future failure mode of the event-driven path).
   *
   * Designed to be safe to call concurrently with the event-driven path
   * — `runSyncOnConnect` itself is idempotent via `syncingPeers`.
   */
  async reconcileSyncFromConnectedPeers(this: DKGAgent): Promise<void> {
    if (!this.started) return;
    if (!syncReconcilerEnabled(this.config) || !syncOnConnectEnabled(this.config)) return;
    const now = Date.now();
    const syncTiming = this.config.syncReconcilerTiming;
    const ctx = createOperationContext('sync');
    this.pruneSyncReconcilerState(now);
    for (const pid of this.node.libp2p.getPeers()) {
      const peerId = pid.toString();
      if (this.networkAdmissionCoordinator.isRejectedPeer(peerId)) continue;
      if (this.syncingPeers.has(peerId)) continue;
      const lastOk = this.lastSuccessfulSyncAt.get(peerId);
      const lastDisconnected = this.syncOnConnectDisconnectBoundary(peerId, now);
      const lastProgress = this.lastSyncProgressAt.get(peerId);
      const lastSyncCooldown = Math.max(lastOk ?? 0, lastProgress ?? 0);
      const selectedSwmRetryRequired =
        this.selectedSwmBootstrapAdmission.isRetryRequired(peerId);
      const stale = selectedSwmRetryRequired
        || lastSyncCooldown === 0
        || lastSyncCooldown <= lastDisconnected
        || (now - lastSyncCooldown) >= syncTiming.stalenessThresholdMs;
      if (!stale) continue;
      // Per-peer exponential backoff: a peer that can never be synced
      // (dead / NAT-stuck / persistently stream-resetting) never stamps
      // `lastSuccessfulSyncAt`, so it reads as perpetually stale. Without
      // this gate it would be dialed on every tick forever. The gate
      // applies ONLY to the periodic reconciler — connection:open and
      // peer:update still fire an immediate attempt, so newly-reachable
      // peers are never delayed.
      const backoff = this.syncReconcilerBackoff.get(peerId);
      const probe = await this.getSyncReconcilerProbe(peerId);
      if (backoff && now < backoff.nextRetryAt) {
        if (!this.hasSyncReconcilerProbeChanged(backoff, probe)) {
          continue;
        }
        this.syncReconcilerBackoff.delete(peerId);
      }
      if (!(await this.ensurePeerAdmittedForRecovery(peerId, ctx, 'Sync reconciler'))) continue;
      const shortPeer = peerId.slice(-8);
      this.log.info(ctx, `Sync reconciler retrying ${shortPeer} (last success: ${lastOk == null ? 'never' : `${Math.round((now - lastOk) / 1000)}s ago`}${backoff ? `, prior failures: ${backoff.failures}` : ''})`);
      this.attemptSyncFromPeerWithReconcilerAccounting(peerId, probe, 'reconcile')
        .then(() => undefined)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof SyncOnConnectPostSyncError) {
            const backoffNote = err.backoffEligible ? 'growing peer backoff' : 'retrying without growing peer backoff';
            this.log.warn(ctx, `Sync reconciler post-sync step failed for ${shortPeer}; ${backoffNote}: ${message}`);
            return;
          }
          this.log.warn(ctx, `Sync reconciler retry failed for ${shortPeer}: ${message}`);
        });
    }
  }

  pruneSyncReconcilerState(this: DKGAgent, now = Date.now()): void {
    const syncTiming = this.config.syncReconcilerTiming;
    this.syncCheckpoints.pruneExpired?.(now);
    const connected = new Set(this.node.libp2p.getPeers().map((pid) => pid.toString()));
    for (const [peerId, ts] of this.catchupOnConnectAt) {
      if (!connected.has(peerId) && now - ts >= syncTiming.stalenessThresholdMs) {
        this.catchupOnConnectAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.rfc64ExactCatchupOnConnectAt) {
      if (!connected.has(peerId) && now - ts >= syncTiming.stalenessThresholdMs) {
        this.rfc64ExactCatchupOnConnectAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSyncDisconnectedAt) {
      if (now - ts >= syncTiming.stalenessThresholdMs) {
        this.lastSyncDisconnectedAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSuccessfulSyncAt) {
      if (!connected.has(peerId) && now - ts >= syncTiming.stalenessThresholdMs) {
        this.lastSuccessfulSyncAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSyncProgressAt) {
      if (!connected.has(peerId) && now - ts >= syncTiming.stalenessThresholdMs) {
        this.lastSyncProgressAt.delete(peerId);
      }
    }
    for (const [peerId, backoff] of this.syncReconcilerBackoff) {
      if (!connected.has(peerId) && now >= backoff.nextRetryAt + syncTiming.stalenessThresholdMs) {
        this.syncReconcilerBackoff.delete(peerId);
      }
    }
  }

  /**
   * Snapshot a peer's reachability signals (advertised protocols +
   * connection identity) used to decide whether a backed-off peer is worth
   * re-probing before `nextRetryAt`.
   */
  async getSyncReconcilerProbe(this: DKGAgent, peerId: string): Promise<SyncReconcilerProbe> {
    let protocolsKey: string | null = null;
    try {
      const protocols = await this.getPeerProtocols(peerId);
      protocolsKey = [...protocols].sort().join('\n');
    } catch {
      protocolsKey = null;
    }
    return {
      protocolsKey,
      connectionKey: this.getSyncReconcilerConnectionKey(peerId),
    };
  }

  getSyncReconcilerConnectionKey(this: DKGAgent, peerId: string): string | null {
    try {
      const entries = this.node.libp2p.getConnections()
        .filter((conn) => conn.remotePeer?.toString?.() === peerId)
        .map((conn) => [
          conn.direction,
          conn.timeline?.open ?? 0,
          conn.remoteAddr?.toString?.() ?? '',
        ].join(':'))
        .sort();
      return entries.length > 0 ? entries.join('|') : null;
    } catch {
      return null;
    }
  }

  hasSyncReconcilerProbeChanged(this: DKGAgent, backoff: SyncReconcilerBackoff, probe: SyncReconcilerProbe): boolean {
    return backoff.protocolsKey !== probe.protocolsKey || backoff.connectionKey !== probe.connectionKey;
  }

  /** Apply one coherent sync result to freshness, progress, and retry state. */
  applySyncOnConnectAccounting(
    this: DKGAgent,
    peerId: string,
    outcome: SyncOnConnectPeerOutcome,
    probe?: SyncReconcilerProbe,
  ): void {
    const progressAt = Math.max(Date.now(), (this.lastSyncProgressAt.get(peerId) ?? 0) + 1);
    if (outcome.progress) {
      this.lastSyncProgressAt.set(peerId, progressAt);
    }
    if (outcome.fresh) {
      this.lastSuccessfulSyncAt.set(peerId, progressAt);
    }
    this.skippedNoSyncPeers.delete(peerId);

    if (outcome.reconcilerDisposition === 'clear') {
      this.syncReconcilerBackoff.delete(peerId);
    } else if (outcome.reconcilerDisposition === 'retry' && probe) {
      this.recordSyncReconcilerFailure(peerId, probe);
    }
  }

  /**
   * Grow the per-peer sync-reconciler backoff after an attempt that did
   * not produce a successful sync. `nextRetryAt` advances by
   * `SYNC_BACKOFF_BASE_MS * 2^(failures-1)` (capped at
   * `SYNC_BACKOFF_MAX_MS`) with ±`SYNC_BACKOFF_JITTER` randomisation to
   * de-correlate retries across peers. Reset to absent on successful
   * progress / denial-only clean response (`reconcilerDisposition: clear`). Disconnect
   * no longer clears this immediately; stale disconnected entries are
   * pruned by `pruneSyncReconcilerState`.
   */
  recordSyncReconcilerFailure(this: DKGAgent, peerId: string, probe: SyncReconcilerProbe): void {
    if (!this.started || !this.isPeerConnectedForSyncBackoff(peerId)) return;
    const failures = (this.syncReconcilerBackoff.get(peerId)?.failures ?? 0) + 1;
    const syncTiming = this.config.syncReconcilerTiming;
    // Clamp the exponent so `2 ** exp` can never overflow before the cap.
    const exp = Math.min(failures - 1, 30);
    const delay = Math.min(syncTiming.backoffBaseMs * 2 ** exp, syncTiming.backoffMaxMs);
    const jittered = delay * (1 + (Math.random() * 2 - 1) * syncTiming.backoffJitter);
    this.syncReconcilerBackoff.set(peerId, {
      failures,
      nextRetryAt: Date.now() + jittered,
      protocolsKey: probe.protocolsKey,
      connectionKey: probe.connectionKey,
    });
  }

  isPeerConnectedForSyncBackoff(this: DKGAgent, peerId: string): boolean {
    try {
      return this.node.libp2p.getPeers().some((pid) => pid.toString() === peerId);
    } catch {
      return false;
    }
  }

  /**
   * A.4-lite+: discover Core nodes from the Agent Registry phonebook, gate
   * them on on-chain ShardingTable membership, and keep a small set warm
   * (connection pinned + auto-redialed). Best-effort; never throws into the
   * timer. See `p2p/warm-core-connections.ts`.
   */
  async reconcileWarmCoreConnections(this: DKGAgent): Promise<void> {
    if (!this.started) return;
    const result = await reconcileWarmCoreConnections({
      selfPeerId: this.node.libp2p.peerId.toString(),
      maxCores: WARM_CORE_MAX,
      // Drop Cores not seen within the profile-stale window before the cap, so
      // a stale phonebook slice can't crowd out live Cores or keep redialing
      // dead entries (reuses the directory's freshness threshold).
      staleThresholdMs: AGENT_PROFILE_STALE_THRESHOLD_MS,
      findCoreAgents: async (): Promise<WarmCoreAgent[]> => {
        const agents = await this.discovery.findAgents();
        return agents.map((a) => ({
          peerId: a.peerId,
          nodeRole: a.nodeRole,
          agentAddress: a.agentAddress,
          lastSeen: a.lastSeen,
        }));
      },
      isShardingTableCore: (agentAddress) => this.isShardingTableCore(agentAddress),
      isConnected: (peerId) =>
        this.node.libp2p.getConnections().some((c) => c.remotePeer.toString() === peerId),
      pin: (peerId) => this.pinWarmCore(peerId),
      unpin: (peerId, ctx) => this.unpinWarmCore(peerId, ctx),
      dial: (peerId, ctx) => this.dialWarmCore(peerId, ctx),
      previouslyWarmed: this.warmedCores,
      previouslyFailedUnpins: this.warmCoreFailedUnpins,
      log: (ctx, msg) => this.log.info(ctx, msg),
    });
    // Carry the pinned set into the next tick so stale Cores get unpinned.
    this.warmedCores = result.warmed;
    this.warmCoreFailedUnpins = result.failedUnpins;
  }

  /**
   * Trust gate for warm-core pinning: only pin Cores that are members of the
   * on-chain ShardingTable (staked nodes). Best-effort — when the chain
   * adapter can't answer (no chain bound, optional reads absent) the gate
   * passes so the phonebook `nodeRole='core'` alone decides. A transient
   * RPC failure denies (we don't pin on an unverifiable gate).
   */
  async isShardingTableCore(this: DKGAgent, agentAddress: string | undefined): Promise<boolean> {
    const getIdentityIdForAddress = this.chain.getIdentityIdForAddress?.bind(this.chain);
    const isShardingTableMember = this.chain.isShardingTableMember?.bind(this.chain);
    if (!getIdentityIdForAddress || !isShardingTableMember) return true; // gate unavailable
    // A legacy/mixed-version core profile may not carry an operational wallet.
    // Discovery elsewhere supports profiles without `agentAddress`, so treat
    // its absence as "gate unavailable" (fall back to phonebook nodeRole)
    // rather than a hard denial — otherwise the warm set can collapse to zero
    // in a network with healthy but pre-agentAddress cores.
    if (!agentAddress) return true; // gate unavailable for this profile
    try {
      const identityId = await getIdentityIdForAddress(agentAddress);
      if (identityId === 0n) return false;
      return await isShardingTableMember(identityId);
    } catch {
      return false;
    }
  }

  /**
   * Tag a Core keep-alive in the peerStore — so libp2p's connection manager
   * maintains + auto-redials it (mirrors the relay keep-alive path in
   * `core/node.ts`). Idempotent; does NOT dial (see {@link dialWarmCore}).
   */
  async pinWarmCore(this: DKGAgent, peerIdStr: string): Promise<void> {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(peerIdStr);
    await this.node.libp2p.peerStore.merge(peerId, {
      tags: { [WARM_CORE_KEEPALIVE_TAG]: { value: 100 } },
    });
  }

  /**
   * Remove the warm-core keep-alive tag from a Core that fell out of the warm
   * set, so the connection manager stops protecting/redialing it and the
   * pinned count can't drift above WARM_CORE_MAX over time.
   */
  async unpinWarmCore(this: DKGAgent, peerIdStr: string, ctx: OperationContext): Promise<void> {
    const shortPeer = peerIdStr.slice(-8);
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerId = peerIdFromString(peerIdStr);
      // peerStore.merge deletes a tag whose value is `undefined`.
      await this.node.libp2p.peerStore.merge(peerId, {
        tags: { [WARM_CORE_KEEPALIVE_TAG]: undefined },
      });
      this.log.info(ctx, `warm-core: unpinned ${shortPeer} (no longer selected)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.info(ctx, `warm-core: unpin ${shortPeer} failed: ${message}`);
      throw err;
    }
  }

  /**
   * Dial a (pinned, not-yet-connected) Core via the existing resolve+dial
   * path. Returns true on a successful dial.
   */
  async dialWarmCore(this: DKGAgent, peerIdStr: string, ctx: OperationContext): Promise<boolean> {
    const shortPeer = peerIdStr.slice(-8);
    try {
      await this.connectToPeerId(peerIdStr, { timeoutMs: WARM_CORE_DIAL_TIMEOUT_MS });
      this.log.info(ctx, `warm-core: dialed ${shortPeer}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.info(ctx, `warm-core: dial ${shortPeer} failed (retry next tick): ${message}`);
      return false;
    }
  }

  /**
   * Reconnect-on-gossip: ensure we have a live libp2p path to the sender of
   * a gossip message we just received. GossipSub delivers messages signed by
   * their original publisher, so `from` is the author regardless of how many
   * mesh hops the message took to reach us — making it a reliable signal
   * that the author is online *right now*.
   *
   * Why: two edge nodes behind NAT can briefly lose their direct circuit
   * without either side noticing until the next publish fails. By reacting
   * to incoming gossip with an opportunistic dial, we restore the path long
   * before the application-layer sync protocol is invoked.
   *
   * Best-effort only: for each configured relay that we are already connected
   * to, construct an explicit `/p2p-circuit` multiaddr and dial. Failures are
   * logged but never surface to the caller.
   */
  async maybeDialGossipSender(this: DKGAgent, peerIdStr: string): Promise<void> {
    const selfPeerId = this.node.libp2p.peerId.toString();
    if (peerIdStr === selfPeerId) return;
    if (this.networkAdmissionCoordinator.isRejectedPeer(peerIdStr)) return;

    // Already connected → nothing to do.
    const connected = this.node.libp2p.getPeers().some(p => p.toString() === peerIdStr);
    if (connected) return;

    // Cooldown: a single chatty CG can produce many gossip messages/second.
    // One dial-attempt per peer per GOSSIP_DIAL_COOLDOWN_MS is enough.
    const now = Date.now();
    const last = this.gossipDialAttemptedAt.get(peerIdStr) ?? 0;
    if (now - last < GOSSIP_DIAL_COOLDOWN_MS) return;
    this.gossipDialAttemptedAt.set(peerIdStr, now);

    const ctx = createOperationContext('connect');
    const shortPeer = peerIdStr.slice(-8);

    const { peerIdFromString } = await import('@libp2p/peer-id');
    try {
      peerIdFromString(peerIdStr);
    } catch (err) {
      this.log.warn(ctx, `Skipping gossip redial for invalid peer id ${shortPeer}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const relays = this.config.relayPeers ?? [];
    const connectedPeers = new Set(this.node.libp2p.getPeers().map(p => p.toString()));
    let skippedRelays = 0;

    for (const relayAddr of relays) {
      const relayPeerId = relayAddr.match(/\/p2p\/([^/]+)/)?.[1];
      if (relayPeerId == null || !connectedPeers.has(relayPeerId)) {
        skippedRelays++;
        continue;
      }

      const circuitAddr = `${relayAddr}/p2p-circuit/p2p/${peerIdStr}`;
      try {
        await this.node.libp2p.dial(
          multiaddr(circuitAddr),
          { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) },
        );
        this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via ${relayAddr.slice(-16)}`);
        return;
      } catch {
        // Try next relay. We don't log per-relay failures at INFO to avoid
        // log spam when a peer simply has no reservation anywhere right now.
      }
    }

    this.log.info(ctx, `Reconnect-on-gossip: no path to ${shortPeer} via ${relays.length - skippedRelays}/${relays.length} connected relay(s); will retry after cooldown`);
  }

  /**
   * Pull triples for the given context graphs from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   *
   * Meta and data are fetched in separate pagination loops so that neither
   * response can exceed the 10 MB stream read limit.
   */
  async syncFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[] = [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
    options?: DurableSyncOptions,
  ): Promise<number> {
    const result = await this.syncFromPeerDetailed(
      remotePeerId,
      contextGraphIds,
      onPhase,
      onAccessDenied,
      undefined,
      options,
    );
    return result.insertedTriples;
  }

  async syncFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
    // Phase C — optional gap-safe per-CG delta high-water mark resolver. Backed
    // by a CONTIGUOUS watermark when supplied; omitted ⇒ full scan (default).
    sinceBatchIdFor?: (contextGraphId: string) => string | undefined,
    options?: DurableSyncOptions,
  ): Promise<DurableSyncResult> {
    const ctx = createOperationContext('sync');
    if (!durableSyncEnabled(this.config)) {
      this.log.warn(ctx, `Skipping durable sync from ${remotePeerId.slice(-8)} (DKG_DURABLE_SYNC_ENABLED=0)`);
      return createIncompleteDurableSyncResult();
    }
    const requestedContextGraphCount = contextGraphIds.length;
    contextGraphIds = contextGraphIds.filter((contextGraphId) => (
      this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId).legacySyncAllowed
    ));
    if (contextGraphIds.length !== requestedContextGraphCount) {
      this.log.debug(
        ctx,
        `Skipped ${requestedContextGraphCount - contextGraphIds.length} catalog-authoritative CG(s) from legacy durable sync`,
      );
    }
    if (contextGraphIds.length === 0) return createIncompleteDurableSyncResult();
    // OT-RFC-59 — peel off the public CGs this peer serves via the O(delta) changelog
    // lane; the rest fall through to the legacy full-scan lane below. STRICTLY ADDITIVE:
    // gated on this node's `store.changelog` flag, and ANY failure returns every CG to
    // the legacy lane, so a broken/disabled changelog lane degrades to exactly today's
    // behaviour rather than dropping sync.
    let legacyContextGraphIds = contextGraphIds;
    let changelogResult: DurableSyncResult | undefined;
    // Gate = this node's own changelog is enabled (its store is ChangelogStore-wrapped) —
    // the same flag that makes it a responder. Same signal SC4 uses to advertise the protocol.
    // The changelog lane does not yet expose cancellable verification/store
    // boundaries. Any caller-supplied signal therefore requires the fully
    // signal-aware legacy lane.
    if (
      !options?.signal
      && options?.totalTimeoutMs === undefined
      && asChangelogReader(this.store) !== null
      && contextGraphIds.length > 0
    ) {
      try {
        const lane = await this.runChangelogLane(
          ctx,
          remotePeerId,
          contextGraphIds,
          onAccessDenied,
          options?.priority,
          normalizeSyncAdmissionSource(options?.source),
        );
        changelogResult = lane.result;
        legacyContextGraphIds = lane.remainingLegacyCgs;
        if (changelogResult && (changelogResult.deferredBackpressure ?? 0) > 0) {
          return changelogResult;
        }
      } catch (err) {
        this.log.warn(ctx, `Changelog sync lane failed for ${remotePeerId.slice(-8)}; using legacy sync: ${String(err)}`);
        legacyContextGraphIds = contextGraphIds;
        changelogResult = undefined;
      }
    }
    if (legacyContextGraphIds.length === 0) {
      return changelogResult ?? createIncompleteDurableSyncResult();
    }
    const legacyResult = await this.runLegacyDurableSync(
      ctx, remotePeerId, legacyContextGraphIds, onPhase, onAccessDenied, sinceBatchIdFor, options,
    );
    if (!changelogResult) return legacyResult;
    const accumulator = durableSyncAccumulatorFromResult(changelogResult);
    mergeDurableSyncAccumulatorInto(
      accumulator,
      durableSyncAccumulatorFromResult(legacyResult),
    );
    return finalizeDurableSyncCompletion(accumulator);
  }

  /**
   * The legacy full-scan durable-sync lane (PROTOCOL_SYNC). Extracted verbatim from
   * `syncFromPeerDetailed` so the OT-RFC-59 changelog lane can (a) run it for the CGs it
   * does not handle and (b) fall back to it on `resync` / stall — without re-entering the
   * changelog branch.
   */
  async runLegacyDurableSync(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
    sinceBatchIdFor?: (contextGraphId: string) => string | undefined,
    options?: DurableSyncOptions,
  ): Promise<DurableSyncResult> {
    return (await LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed.call(
      this,
      ctx,
      remotePeerId,
      contextGraphIds,
      onPhase,
      onAccessDenied,
      sinceBatchIdFor,
      options,
    )).result;
  }

  async runLegacyDurableSyncDetailed(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
    sinceBatchIdFor?: (contextGraphId: string) => string | undefined,
    options?: DurableSyncOptions,
  ): Promise<PhysicalDurableSyncResult> {
    const syncAgentsMeta = resolveSyncAgentsMeta(this.config.syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
    const stopOnBackoffWorthyFailure = options?.stopOnBackoffWorthyFailure;
    const exactAssetSelection = options?.exactAssetSelection;
    const exactAssetUals = exactAssetSelection === undefined
      ? undefined
      : exactAssetUalsForSelection(exactAssetSelection);
    const extendedRecovery = exactAssetUals !== undefined
      || options?.settlementSliceTimeoutMs !== undefined;
    const operationBoundary = createDurableSyncOperationBoundary({
      totalTimeoutMs: options?.totalTimeoutMs,
      maximumTimeoutMs: extendedRecovery
        ? DURABLE_RECOVERY_HARD_TIMEOUT_MS
        : undefined,
      signal: options?.signal,
    });
    const authenticationTimeoutMs = normalizeDurableSyncTimeoutMs(options?.totalTimeoutMs);
    const fetchTimeoutMs = createDurableSyncFetchTimeoutMs({
      totalTimeoutMs: options?.totalTimeoutMs,
      exactRecovery: exactAssetUals !== undefined,
      extendedRecovery,
    });
    const orderedContextGraphIds = orderContextGraphIdsByPriority(
      contextGraphIds,
      this.config.syncContextGraphPriorities,
    );
    let exactFetchDisposition: ExactDurableFetchDisposition | undefined;
    const authenticatedExactAssets: ChallengePinnedGraphScopedAsset[] = [];
    const markExactFetchIncomplete = () => {
      if (exactAssetUals === undefined) return;
      exactFetchDisposition = mergeExactDurableFetchDisposition(
        exactFetchDisposition,
        'incomplete',
      );
    };
    const runSync = async (): Promise<PhysicalDurableSyncResult> => {
      const accumulator = await runOrderedContextGraphSyncs<DurableSyncAccumulator>({
        work: orderedContextGraphIds.map((contextGraphId) => ({
          contextGraphId,
          lane: 'durable' as const,
          operationId: `durable:${contextGraphId}:${remotePeerId.slice(-8)}`,
          run: async (remainingContextGraphs) => {
            const detailed = await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(
              this,
              ctx,
              remotePeerId,
              contextGraphId,
              remainingContextGraphs,
              {
                onPhase,
                onAtomicCommitStarted: options?.onAtomicCommitStarted,
                onAccessDenied,
                sinceBatchIdFor,
                stopOnBackoffWorthyFailure,
                fetchTimeoutMs,
                exactAssetSelection,
                authenticationTimeoutMs,
                operationFetchDeadline: operationBoundary.fetchDeadline,
                operationDeadline: operationBoundary.deadline,
                settlementSliceTimeoutMs: options?.settlementSliceTimeoutMs,
                signal: operationBoundary.signal,
                isCurrent: options?.isCurrent,
                durableMetaContinuation: options?.durableMetaContinuation,
              },
            );
            if (detailed.exactFetchDisposition !== undefined) {
              exactFetchDisposition = mergeExactDurableFetchDisposition(
                exactFetchDisposition,
                detailed.exactFetchDisposition,
              );
            }
            if (detailed.authenticatedExactAssets !== undefined) {
              authenticatedExactAssets.push(...detailed.authenticatedExactAssets);
            }
            return durableSyncAccumulatorFromResult(detailed.result);
          },
        })),
        priorities: this.config.syncContextGraphPriorities,
        emptyResult: createDurableSyncAccumulator,
        runWithAdmission: async (item, work) => {
          try {
            return await runSerializedDurableContextGraphSync(
              this,
              remotePeerId,
              item.contextGraphId,
              () => this.runContextGraphSyncWithBackpressure(
                ctx,
                item.contextGraphId,
                item.lane,
                item.operationId,
                work,
                {
                  priorityOverride: options?.priority,
                  operationSignal: operationBoundary.signal,
                  source: options?.source,
                },
              ),
              operationBoundary.signal,
            );
          } catch (error) {
            if (!operationBoundary.signal?.aborted) throw error;
            markExactFetchIncomplete();
            return markDurableTerminalBoundary(createDurableSyncAccumulator(), false);
          }
        },
        merge: mergeDurableSyncAccumulatorInto,
        markDeferred: (summary) => {
          markExactFetchIncomplete();
          recordDurableSyncDiagnostics(summary, { deferredBackpressure: 1 });
          return markDurableTerminalBoundary(summary, false);
        },
        // Preserve already-merged progress, but record that cancellation left
        // requested Context Graphs unvisited so the aggregate cannot finalize
        // as complete.
        markSkipped: (summary) => {
          markExactFetchIncomplete();
          return markDurableTerminalBoundary(summary, false);
        },
        shouldContinue: () => !operationBoundary.signal?.aborted,
        // One CG's backoff-worthy round stays in the merged summary (its
        // terminal boundary is false, so the aggregate cannot finalize
        // complete, and the peer is not stamped fresh) while the remaining
        // CGs still get their turn. Only peer-never-responded rounds may
        // stop the batch, via the ordered fanout's consecutive-failure guard.
        isPeerTransportFailure: (part) => Boolean(
          stopOnBackoffWorthyFailure
          && durableSyncAccumulatorHasPeerTransportFailure(part),
        ),
        onDeferred: (item, error) => this.log.info(
          ctx,
          `Deferring durable sync at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
        ),
      });
      return {
        result: finalizeDurableSyncCompletion(accumulator),
        ...(exactFetchDisposition ? { exactFetchDisposition } : {}),
        ...(authenticatedExactAssets.length === 0
          ? {}
          : { authenticatedExactAssets: Object.freeze([...authenticatedExactAssets]) }),
      };
    };

    const singleFlightKey = durableSyncSingleFlightKey({
      remotePeerId,
      contextGraphIds: orderedContextGraphIds,
      stopOnBackoffWorthyFailure,
      fetchTimeoutMs,
      authenticationTimeoutMs,
      syncAgentsMeta,
      hasPhaseCallback: Boolean(onPhase),
      hasAtomicCommitCallback: Boolean(options?.onAtomicCommitStarted),
      hasAccessDeniedCallback: Boolean(onAccessDenied),
      hasSinceBatchIdResolver: Boolean(sinceBatchIdFor),
      hasSignal: Boolean(operationBoundary.signal),
      hasCurrentFence: Boolean(options?.isCurrent),
      hasChallengePinnedSelection: exactAssetSelection?.kind === 'challenge-pinned',
      exactAssetUals,
      settlementSliceTimeoutMs: options?.settlementSliceTimeoutMs,
      priority: options?.priority,
    });
    const runWithinBoundary = async () => {
      try {
        return await runSync();
      } finally {
        operationBoundary.dispose();
      }
    };
    return singleFlightKey
      ? runSyncSingleFlight(this, singleFlightKey, runWithinBoundary, {
        scope: 'durable',
        source: options?.source,
      })
      : runWithinBoundary();
  }

  /**
   * Foreground VM repair for one bounded set of locally-missing KAs.
   * Upgraded peers serve only these descriptors/payload graphs. Responses from
   * older peers are accepted for rolling compatibility only when their legacy
   * full-CG prefix fits the exact accumulation bounds and covers the requested
   * descriptors. Other legacy responses remain incomplete, fail closed, and
   * rotate to another candidate instead of being verified or stored.
   */
  syncExactKnowledgeAssetsFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    assetUals: readonly string[],
    options?: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    },
  ): Promise<DurableSyncResult>;
  syncExactKnowledgeAssetsFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    selection: ExactAssetSelection,
    options?: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    },
  ): Promise<DurableSyncResult>;
  async syncExactKnowledgeAssetsFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    selectionInput: ExactAssetSelection | readonly string[],
    options: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    } = {},
  ): Promise<DurableSyncResult> {
    const selection: ExactAssetSelection = Array.isArray(selectionInput)
      ? createUalOnlyExactAssetSelection(selectionInput)
      : requireExactAssetSelection(selectionInput);
    return (await this.syncExactKnowledgeAssetsFromPeerDetailed(
      remotePeerId,
      contextGraphId,
      selection,
      options,
    )).result;
  }

  syncExactKnowledgeAssetsFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    assetUals: readonly string[],
    options?: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    },
  ): Promise<ExactKnowledgeAssetSyncResult>;
  syncExactKnowledgeAssetsFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    selection: ExactAssetSelection,
    options?: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    },
  ): Promise<ExactKnowledgeAssetSyncResult>;
  async syncExactKnowledgeAssetsFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    selectionInput: ExactAssetSelection | readonly string[],
    options: {
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    } = {},
  ): Promise<ExactKnowledgeAssetSyncResult> {
    const selection: ExactAssetSelection = Array.isArray(selectionInput)
      ? createUalOnlyExactAssetSelection(selectionInput)
      : requireExactAssetSelection(selectionInput);
    const ctx = createOperationContext('sync');
    const detailed = await this.runLegacyDurableSyncDetailed(
      ctx,
      remotePeerId,
      [contextGraphId],
      undefined,
      undefined,
      undefined,
      {
        exactAssetSelection: selection,
        stopOnBackoffWorthyFailure: true,
        priority: 1_000,
        source: 'vm-recovery',
        signal: options.signal,
        isCurrent: options.isCurrent,
      },
    );
    return {
      result: detailed.result,
      disposition: detailed.exactFetchDisposition ?? 'incomplete',
      ...(detailed.authenticatedExactAssets === undefined
        ? {}
        : { authenticatedAssets: detailed.authenticatedExactAssets }),
    };
  }

  /** Execute one legacy durable Context Graph after its caller owns admission. */
  async runLegacyDurableSyncForContextGraph(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    remainingContextGraphs: number,
    options: LegacyDurableContextGraphOptions = {},
  ): Promise<DurableSyncResult> {
    return (await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(
      this,
      ctx,
      remotePeerId,
      contextGraphId,
      remainingContextGraphs,
      options,
    )).result;
  }

  async runLegacyDurableSyncForContextGraphDetailed(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    remainingContextGraphs: number,
    options: LegacyDurableContextGraphOptions = {},
  ): Promise<PhysicalDurableSyncResult> {
    const {
      onPhase,
      onAtomicCommitStarted,
      onAccessDenied,
      sinceBatchIdFor,
      stopOnBackoffWorthyFailure,
      onVerifiedFullSnapshot,
      fetchTimeoutMs = SYNC_TOTAL_TIMEOUT_MS,
      exactAssetSelection,
      authenticationTimeoutMs = fetchTimeoutMs,
      operationFetchDeadline,
      operationDeadline,
      settlementSliceTimeoutMs,
      signal,
      isCurrent,
      durableMetaContinuation,
    } = options;
    const assertLifecycleCurrent = () => {
      if (isCurrent?.() === false) {
        throw asSyncFetchAbortError(new Error(
          `Exact VM recovery lifecycle for ${contextGraphId} is no longer current`,
        ));
      }
    };
    const syncAgentsMeta = resolveSyncAgentsMeta(this.config.syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
    // The CG name commitment is immutable for an on-chain slot. Prove a
    // local/on-chain binding once per durable-sync invocation, then reuse the
    // successful proof for every KA in that batch. Without this operation-
    // scoped cache, a large CG performs one RPC name-hash read per KA. Only an
    // affirmative proof remains cached; false results and read failures are
    // evicted so a bounded authentication retry performs a fresh chain read.
    const contextGraphBindingProofs = new Map<string, Promise<boolean>>();
    const verifyContextGraphBinding = async (
      localContextGraphId: string,
      onChainContextGraphId: bigint,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      const onChainId = onChainContextGraphId.toString();
      const key = `${localContextGraphId}\0${onChainId}`;
      let proof = contextGraphBindingProofs.get(key);
      if (!proof) {
        proof = this.requireLocalCgMatchesOnChainSlot(
          localContextGraphId,
          onChainId,
          ctx,
          { signal },
        );
        contextGraphBindingProofs.set(key, proof);
      }
      try {
        const matches = await proof;
        if (!matches && contextGraphBindingProofs.get(key) === proof) {
          contextGraphBindingProofs.delete(key);
        }
        return matches;
      } catch (error) {
        if (contextGraphBindingProofs.get(key) === proof) {
          contextGraphBindingProofs.delete(key);
        }
        throw error;
      }
    };
    const contextGraphBudget = createDurableSyncBudget({
      fetchTimeoutMs,
      authenticationTimeoutMs,
      exactRecovery: exactAssetSelection !== undefined,
      operationFetchDeadline,
      extendedRecovery: settlementSliceTimeoutMs !== undefined,
      operationDeadline,
    }).createContextGraphBudget({
      contextGraphId,
      remainingContextGraphs,
    });
    const proofCheckpointStore = exactAssetSelection?.kind === 'challenge-pinned'
      ? new MemorySyncCheckpointStore()
      : undefined;
    const runGraphScopedOperation = createGraphScopedPhysicalOperationFence({
      isClosed: () => this.graphScopedStoreClosed,
      captureSubscription: (operationContextGraphId) =>
        this.subscribedContextGraphs.get(operationContextGraphId),
      captureBindingGeneration: (operationContextGraphId) =>
        this.contextGraphBindingState.capture(operationContextGraphId),
      isBindingGenerationCurrent: (operationContextGraphId, generation) =>
        this.contextGraphBindingState.isGenerationCurrent(
          operationContextGraphId,
          generation,
        ),
      assertLifecycleCurrent,
      asAbortError: asSyncFetchAbortError,
      track: (run) => this.graphScopedStorePhysicalRuns.add(run),
      untrack: (run) => this.graphScopedStorePhysicalRuns.delete(run),
    });
    const durableContext: DurableSyncContext & Partial<Pick<
      ChallengeExactAssetFetchContext,
      'authenticateChallengePinnedAsset'
    >> = {
      ctx,
      remotePeerId,
      contextGraphIds: [contextGraphId],
      onPhase,
      onAccessDenied,
      syncAgentsMeta,
      durableSyncBudget: {
        createContextGraphBudget: () => contextGraphBudget,
      },
      settlementSliceDeadline: settlementSliceTimeoutMs === undefined
        ? undefined
        : Math.min(
            Date.now() + normalizeDurableSyncTimeoutMs(settlementSliceTimeoutMs),
            operationDeadline ?? Number.POSITIVE_INFINITY,
          ),
      signal,
      fetchSyncPages: ({
        ctx: opCtx,
        remotePeerId: peerId,
        contextGraphId: cgId,
        phase,
        graphUri,
        snapshotRef,
        sinceBatchId,
        manifestDigest,
        manifestPrefixDigestAtOffset,
        forceFreshSession,
        shouldStopAfterPage,
        returnAcceptedPrefixOnRetryableTransportFailure,
        requesterScope,
        ephemeralRequesterState,
        fetchContext,
      }) => {
        return this.fetchSyncPages(
          opCtx,
          peerId,
          cgId,
          false,
          phase,
          graphUri,
          fetchContext.deadline,
          {
            snapshotRef,
            sinceBatchId,
            signal: fetchContext.signal,
            forceFreshSession: forceFreshSession
              || onVerifiedFullSnapshot !== undefined,
            manifestDigest,
            manifestPrefixDigestAtOffset,
            shouldStopAfterPage,
            assetUals: exactAssetSelection === undefined
              ? undefined
              : exactAssetUalsForSelection(exactAssetSelection),
            returnAcceptedPrefixOnRetryableTransportFailure,
            requesterScope,
            checkpointStore: ephemeralRequesterState
              ? proofCheckpointStore
              : undefined,
            ephemeralRequesterState,
          },
        );
      },
      sinceBatchIdFor,
      exactAssetSelectionFor: exactAssetSelection?.kind === 'ual-only'
        ? () => exactAssetSelection
        : undefined,
      durableMetaContinuation,
      stopOnBackoffWorthyFailure,
      processDurableBatchInWorker: this.processDurableBatchInWorker.bind(this),
      storeInsert: ({ quads, signal: operationSignal }) => {
        return this.insertSyncedQuadsAndInvalidateListCache(quads, {
          priority: 'background',
          source: 'agent.durableSync.storeInsert',
          signal: operationSignal,
        });
      },
      ...(exactAssetSelection?.kind === 'challenge-pinned'
        ? {
            authenticateChallengePinnedAsset: ({
              asset,
              commitment,
              authenticationDeadline,
              signal: operationSignal,
            }) => runGraphScopedOperation({
              contextGraphId: asset.contextGraphId,
              signal: operationSignal,
              closedError: () => asSyncFetchAbortError(new Error(
                `Challenge-pinned authentication for ${asset.ual} is closed for node shutdown`,
              )),
              bindingChangedError: () => asSyncFetchAbortError(new Error(
                `Context graph binding for ${asset.contextGraphId} changed during challenge authentication`,
              )),
              operation: async ({ assertCurrent }) => {
                const authenticated =
                  await authenticateChallengePinnedGraphScopedAssetWithinDeadline({
                    chain: this.chain,
                    asset,
                    commitment,
                    verifyContextGraphBinding,
                    authenticationDeadline,
                    signal: operationSignal,
                  });
                assertCurrent();
                return authenticated;
              },
            }),
          }
        : {}),
      storeGraphScopedAsset: ({
        asset,
        authenticationDeadline,
        signal: operationSignal,
      }) => runGraphScopedOperation({
        contextGraphId: asset.contextGraphId,
        signal: operationSignal,
        closedError: () => asSyncFetchAbortError(new Error(
          `Graph-scoped store for ${asset.ual} is closed for node shutdown`,
        )),
        bindingChangedError: () => asSyncFetchAbortError(new Error(
          `Context graph binding for ${asset.contextGraphId} changed during graph-scoped store`,
        )),
        operation: async ({
          subscription,
          isBindingCurrent,
          recaptureBindingGeneration,
          assertCurrent,
        }): Promise<GraphScopedMaterializationOutcome> => {
          const authentication = await authenticateDurableGraphScopedAsset({
            chain: this.chain,
            asset,
            verifyContextGraphBinding,
            deadline: authenticationDeadline,
            signal: operationSignal,
            onRetry: (error, attempt, maxAttempts) => {
              this.log.warn(
                ctx,
                `Retrying graph-scoped durable authentication for ${asset.ual} `
                + `after transient chain verification failure (${attempt}/${maxAttempts}): `
                + `${error instanceof Error ? error.message : String(error)}`,
              );
            },
          });
          assertCurrent();
          const verifiedOnChainId = authentication.onChainContextGraphId;
          if (
            verifiedOnChainId
            && subscription?.onChainId
            && subscription.onChainId !== verifiedOnChainId
          ) {
            throw Object.assign(
              new Error(
                `Graph-scoped durable sync ${asset.ual} belongs to on-chain context graph `
                + `${verifiedOnChainId}, but local ${asset.contextGraphId} is already bound to `
                + `${subscription.onChainId}`,
              ),
              { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' },
            );
          }
          if (verifiedOnChainId && subscription && subscription.onChainId === undefined) {
            await this.persistContextGraphSubscriptionStrict(
              asset.contextGraphId,
              { ...subscription, onChainId: verifiedOnChainId, lastReconciledOrdinal: 0 },
              undefined,
              isBindingCurrent,
            );
            assertCurrent();
            this.bindSubscriptionOnChainId(
              asset.contextGraphId,
              subscription,
              verifiedOnChainId,
            );
            recaptureBindingGeneration();
            assertCurrent();
          }
          assertCurrent();
          onAtomicCommitStarted?.(asset.contextGraphId, asset.ual);
          assertCurrent();
          const outcome = await materializeVerifiedGraphScopedAsset({
            store: this.store,
            asset: authentication.asset,
            isCurrent: () => (isCurrent?.() ?? true) && isBindingCurrent(),
            shouldQuarantineCommitted: () => {
              const current = this.subscribedContextGraphs.get(asset.contextGraphId);
              return (subscription !== undefined && current === undefined)
                || (verifiedOnChainId !== null
                  && current !== undefined
                  && current.onChainId !== verifiedOnChainId);
            },
            options: {
              priority: 'background',
              source: 'agent.durableSync.graphScopedMaterialization',
              signal: operationSignal,
            },
            oversizeHooks: {
              recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
            },
          });
          if (outcome === 'applied') {
            this.invalidateListContextGraphsCache();
            this.contextGraphMetaProjection.markDirtyFromQuads(authentication.asset.metadataQuads);
            try {
              const retirement = await reconcileFinalizedSwmTwin({
                store: this.store,
                writeLocks: this.writeLocks,
                asset: authentication.asset,
                retire: (candidate) => this.retireFinalizedSwmTwinCandidate(candidate, ctx),
              });
              if (retirement === 'retired') {
                this.invalidateListContextGraphsCache();
                this.log.info(
                  ctx,
                  `Retired byte-identical SWM twin after durable VM materialization for ${asset.ual}`,
                );
              }
            } catch (cause) {
              // VM materialization is already durable and independently
              // verified. A best-effort tier cleanup must never turn that
              // success into a failed sync; the untouched SWM copy remains
              // safe and the next durable replay can reconcile it again.
              this.log.warn(
                ctx,
                `Deferred SWM twin reconciliation for ${asset.ual}: `
                + `${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
          return outcome;
        },
      }),
      onVerifiedFullSnapshot,
      deleteCheckpoint: (key) => deleteSyncPageCheckpoint(this.syncCheckpoints, key),
      setCheckpoint: (key, checkpoint) => {
        if (checkpoint.binding) {
          this.syncCheckpoints.setManifestBoundOffset(
            key,
            checkpoint.offset,
            checkpoint.binding.manifestDigest,
            Date.now(),
            checkpoint.binding.manifestPrefixDigest,
            checkpoint.binding.terminal,
            checkpoint.responderSessionOffset,
          );
        } else {
          this.syncCheckpoints.set(
            key,
            checkpoint.offset,
            Date.now(),
            checkpoint.responderSessionOffset,
          );
        }
      },
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    };
    if (exactAssetSelection?.kind === 'challenge-pinned') {
      const {
        exactAssetSelectionFor: _exactAssetSelectionFor,
        storeGraphScopedAsset: _storeGraphScopedAsset,
        deleteCheckpoint: _deleteCheckpoint,
        setCheckpoint: _setCheckpoint,
        authenticateChallengePinnedAsset,
        ...challengeContext
      } = durableContext;
      if (authenticateChallengePinnedAsset === undefined) {
        throw new Error('Challenge-pinned exact fetch is missing its authentication consumer');
      }
      const fetched = await runChallengeExactAssetFetch({
        ...challengeContext,
        challengeSelectionFor: () => exactAssetSelection,
        authenticateChallengePinnedAsset,
      });
      return {
        result: fetched.result,
        exactFetchDisposition: fetched.disposition,
        authenticatedExactAssets: fetched.authenticatedAssets,
      };
    }
    if (exactAssetSelection !== undefined) {
      return runDurableSyncDetailed(durableContext);
    }
    return { result: await runDurableSync(durableContext) };
  }

  /**
   * OT-RFC-59 requester lane. For each PUBLIC context graph the peer advertises the
   * changelog protocol for, runs the O(delta) verified-apply driver; returns the CGs it
   * did NOT handle (private, peer lacks the protocol, or per-CG failure) for the legacy
   * lane. Public CGs need no request signing (the responder's ACL gate returns true), so
   * they are the safe first lane; private CGs stay legacy until signed requests land.
   */
  async runChangelogLane(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphIds: string[],
    onAccessDenied?: (contextGraphId: string) => void,
    priority?: number,
    source?: SyncAdmissionSource,
  ): Promise<{ result?: DurableSyncResult; remainingLegacyCgs: string[] }> {
    const peerProtocols = await this.getPeerProtocols(remotePeerId);
    if (!peerProtocols.includes(PROTOCOL_SYNC_CHANGELOG)) {
      return { remainingLegacyCgs: contextGraphIds };
    }
    const legacyCgs: string[] = [];
    const work = [];
    for (const contextGraphId of contextGraphIds) {
      if (await this.isPrivateContextGraph(contextGraphId)) {
        legacyCgs.push(contextGraphId);
        continue;
      }
      work.push({
        contextGraphId,
        lane: 'changelog' as const,
        operationId: `changelog:${contextGraphId}:${remotePeerId.slice(-8)}`,
        run: async (): Promise<DurableSyncAccumulator> => {
          try {
            const result = await this.runChangelogSyncForCg(ctx, remotePeerId, contextGraphId);
            if (result.deniedPhases > 0) onAccessDenied?.(contextGraphId);
            return durableSyncAccumulatorFromResult(result);
          } catch (error) {
            if (getSyncBackpressureBusyError(error)) throw error;
            this.log.warn(ctx, `Changelog sync failed for CG ${contextGraphId} from ${remotePeerId.slice(-8)}; deferring to legacy: ${String(error)}`);
            legacyCgs.push(contextGraphId);
            return createDurableSyncAccumulator();
          }
        },
      });
    }
    const accumulator = await runOrderedContextGraphSyncs<DurableSyncAccumulator>({
      work,
      priorities: this.config.syncContextGraphPriorities,
      emptyResult: createDurableSyncAccumulator,
      runWithAdmission: (item, run) => this.runContextGraphSyncWithBackpressure(
        ctx,
        item.contextGraphId,
        item.lane,
        item.operationId,
        run,
        { priorityOverride: priority, source },
      ),
      merge: mergeDurableSyncAccumulatorInto,
      markDeferred: (summary) => {
        recordDurableSyncDiagnostics(summary, { deferredBackpressure: 1 });
        return markDurableTerminalBoundary(summary, false);
      },
      onDeferred: (item, error) => this.log.info(
        ctx,
        `Deferring changelog sync at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
      ),
    });
    const result = durableSyncAccumulatorHasTerminalBoundary(accumulator)
      ? finalizeDurableSyncCompletion(accumulator)
      : undefined;
    return { result, remainingLegacyCgs: legacyCgs };
  }

  /**
   * Drive the OT-RFC-59 changelog delta lane for ONE public context graph: page from the
   * durable cursor, verify each page (data merkle-checked against its sibling meta via
   * {@link processDurableBatchInWorker}), apply only verified data graphs, and advance the
   * cursor along the verified prefix. Non-empty shared metadata snapshots and peer drops
   * defer to `runResync`, which bootstraps via the legacy lane; its
   * DurableSyncResult (inserts + completeness) is folded into the returned result so a
   * first-contact/resynced CG still reports its inserts (drives the "synced" flags).
   */
  async runChangelogSyncForCg(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    maxRounds?: number,
  ): Promise<DurableSyncResult> {
    let insertedDataTriples = 0;
    let insertedMetaTriples = 0;
    const accumulator = createDurableSyncAccumulator();
    const acceptUnverified = (Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId);
    // One policy shared with the responder and durable requester: this lane
    // admits only public payload plus top-level durable meta, never RFC-64
    // control records, WM/SWM, private data, or another context graph.
    const isGraphAdmitted = (graph: string): boolean =>
      isLegacySyncGraphCandidateV1(graph, contextGraphId, 'changelog');
    const worker = this.getOrCreateSyncVerifyWorker();

    const outcome = await runChangelogSync({
      contextGraphId,
      limit: SYNC_PAGE_SIZE,
      maxRounds,
      getCursor: () => {
        const c = this.changelogCursors.get(remotePeerId, contextGraphId);
        return c ? { era: c.era, seq: c.seq } : undefined;
      },
      setCursor: (era, seq) => this.changelogCursors.set(remotePeerId, contextGraphId, era, seq),
      // W1 §6.3 — the changelog lane's physical send, instrumented through the
      // SAME helpers as the legacy lane but deliberately NOT routed through
      // `sendSyncRequest`: that would drag `withRetry`, single-use payload
      // semantics and the legacy busy validator into a lane that has none of
      // them. Byte accounting is added here because this lane reported ZERO
      // bytes before W1, and its fallbacks re-enter the legacy lane — omitting
      // it would leave the denominator silently partial and uncorrectable
      // after collection.
      //
      // `plane: 'durable'` is exact rather than approximate: `runChangelogLane`
      // admits only public Context Graphs, and `isGraphAdmitted` rejects the
      // `/_shared_memory` and `/_private` planes, so everything this lane
      // transfers is durable. Shared-memory content defers to `runResync`,
      // which is separately instrumented as `transport=legacy`.
      send: async (bytes) => {
        // Read the stop signal ONCE. `node.stopSignal` is a getter over a
        // controller that `stop()` nulls in its finally, so a second read can
        // return undefined mid-shutdown — which would downgrade a `cancelled`
        // attempt to a fabricated `transport_error` failure. `ProtocolRouter`
        // caches the same way for the same reason.
        const stopSignal = this.node.stopSignal;
        // PRE-SEND BOUNDARY, mirroring `sync-transport.ts`'s `throwIfAborted`
        // before `sendStarted = true`. An already-aborted signal is rejected by
        // `ProtocolRouter.sendInner` in its preflight — BEFORE peer admission,
        // before any dial, before a stream is opened — so nothing is physically
        // invoked and no bytes cross the boundary. Recording there would mint an
        // attempt and request bytes for work that never happened, violating I1's
        // stated contract ("exactly one terminal point per physically invoked
        // send") and inflating the very denominators W1 exists to make
        // decision-grade. It is concentrated on the shutdown path: the changelog
        // driver is abort-unaware, so a stop landing inside `applyPage` surfaces
        // as the next round's pre-aborted send.
        //
        // Throw the COERCED form rather than `stopSignal.throwIfAborted()`: that
        // throws `reason` raw, and a non-`AbortError` reason would then reach
        // callers with the wrong `name`, breaking `isSyncOperationCancellation`
        // and turning a cancellation into an error. `asSyncFetchAbortError`
        // returns an `AbortError` reason by identity and wraps anything else
        // with `cause`, which is what the router itself does.
        if (stopSignal?.aborted === true) throw asSyncFetchAbortError(stopSignal.reason);
        const attributes = syncAttemptAttributes({
          transport: 'changelog',
          plane: 'durable',
          phase: 'delta',
        });
        recordSyncAttemptRequestBytes(attributes, bytes.byteLength);
        let outcome: SyncAttemptOutcome = 'transport_error';
        let responseByteLength: number | undefined;
        try {
          const response = await this.messenger.sendToPeer(remotePeerId, PROTOCOL_SYNC_CHANGELOG, bytes, {
            timeoutMs: SYNC_PAGE_TIMEOUT_MS,
            signal: stopSignal ?? undefined,
          });
          responseByteLength = response.byteLength;
          outcome = 'response';
          return response;
        } catch (error) {
          // Terminal state, not message text — the same reasoning as the legacy
          // bracket. This lane has no in-transport validator, so it can never
          // produce `validation_rejected`: a `denied` changelog response is a
          // successfully DELIVERED response that the decoder classifies later.
          //
          // Classified from the CAPTURED signal — not from the error class, and
          // not by re-reading `this.node.stopSignal`.
          //
          // Not the error class: the router coerces a deadline `TimeoutError`
          // into an `AbortError` (`asAbortError`), so any predicate keyed on
          // `name === 'AbortError'` / `code === 'ABORT_ERR'` reports a 45 s
          // transport timeout as a caller cancellation. That is the rule this
          // file states twice — `attempt-telemetry.ts`: "Any pre-response
          // rejection that is not caller cancellation is `transport_error`",
          // and `sync-transport.ts`: "the caller's own signal is the only
          // non-textual evidence of caller cancellation that exists".
          //
          // Not a re-read: `node.stopSignal` is a getter over a controller
          // `stop()` nulls in its finally, so a shutdown completing between the
          // rejection and this line would read "not aborted" and file a real
          // cancellation as a fabricated FAILURE.
          //
          // The captured `AbortSignal` is the durable causal evidence: once
          // aborted it stays aborted for the object's lifetime, even after the
          // node clears the controller behind the getter. `Boolean(...)` rather
          // than `=== true` because the pre-send guard above narrows this to
          // `false | undefined`, and that narrowing is unsound — the signal
          // genuinely flips mid-flight, which the control test proves.
          outcome = Boolean(stopSignal?.aborted) ? 'cancelled' : 'transport_error';
          throw error;
        } finally {
          recordSyncAttempt(attributes, outcome);
          if (responseByteLength !== undefined) {
            recordSyncAttemptResponseBytes(attributes, responseByteLength, outcome);
          }
        }
      },
      // Resync = the legacy verified lane for just this CG (no re-entry into the changelog
      // branch). Fold its result in, and report completeness so the driver only advances
      // the cursor to headSeq when the resync verifiably fetched everything below it.
      runResync: async (dropCandidates) => {
        const pendingDrops = [...new Set(dropCandidates)].filter(isGraphAdmitted);
        let dropsReconciled = pendingDrops.length === 0;
        let curatorAuthoritative = false;
        if (pendingDrops.length > 0) {
          const curator = await this.resolveCuratorPeerIdsForCg(contextGraphId);
          // Merkle verification authenticates returned KAs, not snapshot completeness.
          // Only the uniquely resolved structural curator may make absence authoritative;
          // legacy triples and ambiguous/mismatched registry entries fail closed.
          curatorAuthoritative = !curator.curatorIsLocal
            && !curator.legacyTripleResolved
            && curator.peerIds.length === 1
            && curator.peerIds[0] === remotePeerId;
          if (!curatorAuthoritative) {
            this.log.warn(
              ctx,
              `Leaving ${pendingDrops.length} changelog drop(s) pending for CG ${contextGraphId}: `
              + `peer ${remotePeerId.slice(-8)} is not the uniquely resolved structural curator`,
            );
          }
        }
        const r = await this.runLegacyDurableSyncForContextGraph(
          ctx,
          remotePeerId,
          contextGraphId,
          1,
          {
            onVerifiedFullSnapshot: curatorAuthoritative ? async (snapshot) => {
              let reconciled = true;
              for (const graph of pendingDrops) {
                const metadataGraph = graph.endsWith('/_meta');
                if (metadataGraph && !snapshot.metaFetched) {
                  reconciled = false;
                  continue;
                }
                const present = metadataGraph
                  ? snapshot.verifiedMetaGraphs.has(graph)
                  : snapshot.verifiedDataGraphs.has(graph);
                if (!present) await this.store.dropGraph(graph);
              }
              dropsReconciled = reconciled;
            } : undefined,
          },
        );
        mergeDurableSyncResultIntoAccumulator(accumulator, r);
        const complete = r.complete && dropsReconciled;
        return { complete, insertedTriples: r.insertedTriples };
      },
      logWarn: (m) => this.log.warn(ctx, m),
      applyPage: async (page) => {
        // Parse the page's upsert records per plane (parseAndFilter validates + CG-filters).
        const dataRecs = page.records.filter((r) => r.op === 'upsert' && !r.graph.endsWith('/_meta') && isGraphAdmitted(r.graph));
        const metaRecs = page.records.filter((r) => r.op === 'upsert' && r.graph.endsWith('/_meta') && isGraphAdmitted(r.graph));
        const recordQuadCountByGraph = new Map<string, number>();
        const metaGraphsWithRoot = new Set<string>();
        const dataQuads: Quad[] = [];
        const metaQuads: Quad[] = [];
        for (const rec of dataRecs) {
          const { quads } = await worker.parseAndFilter(rec.quads ?? '', rec.graph, contextGraphId);
          dataQuads.push(...quads);
          recordQuadCountByGraph.set(rec.graph, quads.length);
        }
        for (const rec of metaRecs) {
          const { quads } = await worker.parseAndFilter(rec.quads ?? '', rec.graph, contextGraphId);
          metaQuads.push(...quads);
          recordQuadCountByGraph.set(rec.graph, quads.length);
          const classification = classifyDurableMetaGraph(quads);
          // A meta graph can bind data only if it actually carries a Merkle root.
          if (classification.hasMerkleRoot) metaGraphsWithRoot.add(rec.graph);
        }
        // Merkle-verify data against meta (same worker path legacy sync uses).
        const processed = await this.processDurableBatchInWorker(
          dataQuads,
          metaQuads,
          ctx,
          acceptUnverified,
          {
            kind: 'changelogPage',
            changedDataGraphs: dataRecs.map((record) => record.graph),
          },
        );
        const verifiedByGraph = new Map<string, Quad[]>();
        for (const q of [...processed.verifiedData, ...processed.verifiedMeta]) {
          const arr = verifiedByGraph.get(q.graph);
          if (arr) arr.push(q); else verifiedByGraph.set(q.graph, [q]);
        }
        const verifiedGraphScopedDataGraphs = new Set(
          processed.verifiedGraphScopedDataGraphs,
        );
        recordDurableSyncDiagnostics(accumulator, {
          rejectedKcs: processed.rejectedKcs,
          dataRejectedMissingMeta: processed.dataRejectedMissingMeta,
        });
        const plan = planPageApply({
          records: page.records,
          nextSeq: page.nextSeq,
          priorSeq: page.priorSeq,
          isGraphAdmitted,
          verifiedByGraph,
          recordQuadCountByGraph,
          metaGraphsWithRoot,
          verifiedGraphScopedDataGraphs,
          batchVerifiedCleanly: processed.rejectedKcs === 0 && processed.dataRejectedMissingMeta === 0,
        });
        // Finish every planned data replacement before the driver persists the
        // cursor. A thrown write therefore leaves the cursor retryable; this
        // ordering does not claim that drop+insert itself is one store transaction.
        // Never dropGraph for a zero-quad upsert — planPageApply never emits one,
        // but guard defensively against reintroducing the silent-delete vector.
        for (const op of plan.ops) {
          if (op.op === 'upsert' && op.quads.length === 0) continue;
          await this.store.dropGraph(op.graph);
          if (op.op === 'upsert') {
            await this.insertSyncedQuadsAndInvalidateListCache(op.quads, {
              priority: 'background', source: 'agent.changelogSync.apply',
            });
            if (op.graph.endsWith('/_meta')) insertedMetaTriples += op.quads.length;
            else insertedDataTriples += op.quads.length;
          }
        }
        if (!plan.deferred && processed.rejectedKcs === 0) {
          recordDurableSyncDiagnostics(accumulator, {
            verifiedPrivateOnlyResponses: processed.verifiedPrivateOnlyResponses,
          });
        }
        return { advanceTo: plan.advanceTo, applied: plan.applied, deferred: plan.deferred };
      },
    });
    recordDurableSyncDiagnostics(accumulator, {
      insertedDataTriples,
      insertedMetaTriples,
      insertedTriples: insertedDataTriples + insertedMetaTriples,
    });
    const changelogComplete = outcome.kind === 'delta'
      || (outcome.kind === 'resync' && outcome.complete);
    if (outcome.kind === 'incomplete') {
      recordDurableSyncDiagnostics(accumulator, { failedPhases: 1 });
    }
    if (outcome.kind === 'denied') {
      recordDurableSyncDiagnostics(accumulator, { deniedPhases: 1 });
    }
    // A legacy fallback may have completed its own fetch phases while the
    // changelog drop remains unauthoritative. Preserve inserted progress, but
    // do not surface those phase completions as CG readiness evidence.
    markDurableTerminalBoundary(accumulator, changelogComplete, {
      countCompletedPhase: true,
      clearCompletedPhasesWhenIncomplete: true,
    });
    return finalizeDurableSyncCompletion(accumulator);
  }

  /**
   * Paginate through sync pages for a single graph (data or meta).
   * Uses buildSyncRequest to produce authenticated requests for private CGs.
   */
  /** @deprecated Use the named options object overload. */
  fetchSyncPages(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    snapshotRef?: string,
    sinceBatchId?: string,
    signal?: AbortSignal,
    recovery?: boolean,
    forceFreshSession?: boolean,
    assetUals?: string[],
  ): Promise<SyncPageResult>;

  fetchSyncPages(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    options?: SyncPageFetchOptions,
  ): Promise<SyncPageResult>;

  async fetchSyncPages(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: SyncPhase,
    graphUri: string,
    deadline: number,
    optionsOrSnapshotRef: SyncPageFetchOptions | string | undefined = {},
    legacySinceBatchId?: string,
    legacySignal?: AbortSignal,
    legacyRecovery?: boolean,
    legacyForceFreshSession?: boolean,
    legacyAssetUals?: string[],
  ): Promise<SyncPageResult> {
    const options = normalizeSyncPageFetchOptions(
      optionsOrSnapshotRef,
      legacySinceBatchId,
      legacySignal,
      legacyRecovery,
      legacyForceFreshSession,
      legacyAssetUals,
    );
    const {
      snapshotRef,
      sinceBatchId,
      signal,
      // R9/R10 — member SWM recovery marker. Forks the checkpoint namespace
      // and request-envelope auth mode. Only the recovery driver sets it.
      recovery,
      // Authoritative snapshot callers rotate the responder session even when
      // an unfinished offset-zero requester session remains cached.
      forceFreshSession,
      manifestDigest,
      manifestPrefixDigestAtOffset,
      shouldStopAfterPage,
      // Exact VM recovery filter. Included in checkpoint, coalescing, wire and
      // responder-session identities so offsets never cross asset batches.
      assetUals,
      returnAcceptedPrefixOnRetryableTransportFailure,
      // Internal namespace for state whose retained prefix is unavailable to
      // ordinary coalesced callers.
      requesterScope,
      checkpointStore: requesterCheckpointStore = this.syncCheckpoints,
      ephemeralRequesterState,
      maxAcceptedQuads,
      maxAcceptedHeapBytesEstimate,
    } = options;
    const exactAccumulationLimits = assetUals === undefined
      ? undefined
      : exactSyncPhaseAccumulationLimits(assetUals);
    // A caller signal defines an operation-owned cancellation contract. Do not
    // place those fetches in the shared page map: even equal wall-clock
    // deadlines do not make independently abortable operations compatible.
    const coalescingKey = signal || shouldStopAfterPage
      ? null
      : syncPageFetchCoalescingKey({
        remotePeerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        snapshotRef,
        sinceBatchId,
        recovery,
        forceFreshSession,
        manifestDigest,
        assetUals,
        returnAcceptedPrefixOnRetryableTransportFailure,
        requesterScope,
        maxAcceptedQuads,
        maxAcceptedHeapBytesEstimate,
      });
    const inFlight = inFlightSyncPageFetchesFor(this);
    // Read once, here: this fetch runs inside the admitted operation, so the
    // ambient source is the trigger that both a join and the shared fetch's
    // own attempts belong to.
    const pageFetchSource = activeSyncAdmissionSource();
    const existing = coalescingKey ? inFlight.get(coalescingKey) : undefined;
    if (existing) {
      if (!existing.controller.signal.aborted) {
        // At map-hit time, before any bytes move. An aborted entry below is NOT
        // a join: it is evicted and this caller starts its own fetch.
        recordSyncSingleFlightJoin({
          scope: 'page',
          ownerSource: existing.ownerSource,
          joinerSource: pageFetchSource,
        });
        return waitForSyncPageFetch(existing, signal);
      }
      if (coalescingKey) inFlight.delete(coalescingKey);
    }
    if (signal?.aborted) {
      return Promise.reject(asSyncFetchAbortError(signal.reason));
    }

    const controller = new AbortController();
    const abortSharedFetch = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const nodeStopSignal = this.node.stopSignal;
    const onNodeStop = () => abortSharedFetch(nodeStopSignal?.reason);
    if (nodeStopSignal?.aborted) {
      abortSharedFetch(nodeStopSignal.reason);
    } else if (nodeStopSignal) {
      nodeStopSignal.addEventListener('abort', onNodeStop, { once: true });
    }

    let entry!: InFlightSyncPageFetch;
    const sharedFetch = fetchSyncPages({
      ctx,
      remotePeerId,
      contextGraphId,
      includeSharedMemory,
      phase,
      graphUri,
      snapshotRef,
      sinceBatchId,
      assetUals,
      returnAcceptedPrefixOnRetryableTransportFailure,
      requesterScope,
      maxAcceptedBytes: exactAccumulationLimits?.maxBytes,
      maxAcceptedQuads: exactAccumulationLimits?.maxQuads === undefined
        ? maxAcceptedQuads
        : maxAcceptedQuads === undefined
          ? exactAccumulationLimits.maxQuads
          : Math.min(exactAccumulationLimits.maxQuads, maxAcceptedQuads),
      maxAcceptedHeapBytesEstimate,
      pageSizeProfileCache: syncPageSizeProfileCacheFor(this),
      deadline,
      recovery,
      syncPageTimeoutMs: SYNC_PAGE_TIMEOUT_MS,
      syncRouterAttempts: SYNC_ROUTER_ATTEMPTS,
      syncPageRetryAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
      syncPageSize: durableSyncRequestPageSize(phase),
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      // Caller AbortSignals are waiter-scoped below: one duplicate trigger
      // timing out must not abort the shared fetch for the other waiters. The
      // shared fetch itself is cancelled on node shutdown or when every waiter
      // has detached.
      signal: controller.signal,
      // Legacy sentinel that older (pre-v10-rc) responders still emit on ACL
      // denial. Recognising it in the requester is what keeps mixed-version
      // catch-up correct: without the second sentinel, a curated-CG denial
      // from a legacy peer would be parsed as N-quads, yield 0 triples, and
      // silently get misclassified as "nothing to sync" instead of flipping
      // `deniedPhases`. See also dkg-agent.ts's dual-sentinel response path
      // and the `_extraDeniedResponses` option on `fetchSyncPages` (tier-4 G1).
      extraDeniedResponses: [SYNC_ACCESS_DENIED_MARKER],
      debugSyncProgress: DEBUG_SYNC_PROGRESS,
      protocolSync: PROTOCOL_SYNC,
      checkpointStore: requesterCheckpointStore,
      ephemeralRequesterState,
      forceFreshSession,
      manifestDigest,
      manifestPrefixDigestAtOffset,
      shouldStopAfterPage,
      buildSyncRequest: this.buildSyncRequest.bind(this),
      parseAndFilter: (nquadsText, targetGraphUri, targetContextGraphId) => {
        if (phase === 'snapshot') {
          const quads = parseWorkspacePublicSnapshotNQuads(nquadsText, snapshotRef ?? 'unknown');
          return Promise.resolve({ quads, totalQuads: quads.length });
        }
        return this.getOrCreateSyncVerifyWorker().parseAndFilter(nquadsText, targetGraphUri, targetContextGraphId);
      },
      // Sync sends via the raw `messenger.sendToPeer` pass-through
      // (ProtocolRouter.send), NOT `sendReliable`: /dkg/10.0.2/sync is
      // off the Universal Messenger substrate so its large, never-reused
      // page responses are not cached in message_idempotency (the
      // ~2.9 GB node-ui.db bloat — see PROTOCOL_SYNC declaration). Sync
      // RPC is synchronous-by-contract (the caller needs the page bytes
      // back NOW to advance pagination); `sendToPeer` returns the
      // response bytes directly, and sync's own transport handles fresh-envelope
      // retry + backoff. The named factory owns the single-use router policy so
      // lifecycle code cannot accidentally configure authenticated sync bytes as
      // reusable.
      send: createSingleUseSyncSender(this.messenger),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    }).finally(() => {
      nodeStopSignal?.removeEventListener('abort', onNodeStop);
      if (coalescingKey && inFlight.get(coalescingKey) === entry) {
        inFlight.delete(coalescingKey);
      }
    });
    sharedFetch.catch(() => {
      // The shared fetch can reject after every waiter has already detached.
      // Keep that from becoming unhandled while still propagating failures to
      // active waiters through the original promise.
    });
    entry = { promise: sharedFetch, controller, waiters: 0, ownerSource: pageFetchSource };
    if (coalescingKey) inFlight.set(coalescingKey, entry);
    return waitForSyncPageFetch(entry, signal);
  }

  /**
   * Pull shared memory triples for the given context graphs from a remote peer.
   * SWM data is not merkle-verified (no chain finality) — it is
   * accepted as-is and merged into the local shared memory + SWM meta graphs.
   * The workspaceOwnedEntities set is updated so Rule 4 stays consistent.
   */
  async syncSharedMemoryFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[] = [...(this.config.syncContextGraphs ?? [])],
  ): Promise<number> {
    const result = await this.syncSharedMemoryFromPeerDetailed(remotePeerId, contextGraphIds);
    return result.insertedTriples;
  }

  /**
   * Resolve the CURATOR's libp2p peer id(s) for a context graph, for the WRITE
   * path's strict curator-ack gate (OT-RFC-49 curator-leader: a private-CG write
   * is durable iff the curator applied it). Mirrors the reconnect gate's
   * structural-then-legacy resolution (syncSharedMemoryFromPeerDetailed) but is
   * standalone + single-CG: it does NOT memoize across a batch and does NOT
   * compare against a connecting peer — the write path just needs "who is the
   * curator, is it me, and what peer(s) do I send the reliable apply to".
   *
   * - `curatorIsLocal`: this node owns the curator agent → no remote leg needed
   *   (a curator never reverse-confirms a CG it owns; the local commit IS authority).
   * - `peerIds`: the curator's advertised peer(s) from the AGENTS registry
   *   (structural path) or the single resolved curator peer (legacy triple path).
   *   Empty → curator not resolvable right now → caller must treat the write as
   *   UNCONFIRMED (never silently confirmed).
   * - `legacyTripleResolved`: true when resolution fell back to the
   *   dkg:curator/dkg:creator triples (member-self-stamp defect possible) — the
   *   caller MUST degrade an ambiguous legacy result to unconfirmed, never confirm.
   */
  async resolveCuratorPeerIdsForCg(this: DKGAgent,
    contextGraphId: string,
    options: {
      maxPeerIds?: number;
      pagePeerIds?: number;
      afterPeerId?: string;
      signal?: AbortSignal;
      isCurrent?: () => boolean;
    } = {},
  ): Promise<{
    peerIds: string[];
    curatorIsLocal: boolean;
    legacyTripleResolved: boolean;
    lookupFailed?: boolean;
    overflowed?: boolean;
    nextPageAfterPeerId?: string;
  }> {
    const assertCurrent = (): void => {
      if (options.signal?.aborted || options.isCurrent?.() === false) {
        throw new DOMException('Curator discovery is no longer current', 'AbortError');
      }
    };
    assertCurrent();
    const structuralCuratorDid = deriveCuratorDidFromCgId(contextGraphId);
    if (structuralCuratorDid) {
      const structuralAgent = structuralCuratorDid.slice('did:dkg:agent:'.length).toLowerCase();
      if ([...this.localAgents.keys()].some((addr) => addr.toLowerCase() === structuralAgent)) {
        return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: false };
      }
      const resolve = async (): Promise<{
        peerIds: string[];
        lookupFailed: boolean;
        overflowed?: boolean;
        nextPageAfterPeerId?: string;
      }> => {
        assertCurrent();
        try {
          if (options.maxPeerIds !== undefined
            && typeof this.discovery.findAgentPeerIdsByAddress === 'function') {
            const pagePeerIds = Math.min(
              options.maxPeerIds,
              Math.max(1, Math.floor(options.pagePeerIds ?? options.maxPeerIds)),
            );
            const queryPage = (afterPeerId?: string) =>
              this.discovery.findAgentPeerIdsByAddress(structuralAgent, {
                ...(afterPeerId ? { afterPeerId } : {}),
                limit: (afterPeerId ? pagePeerIds : options.maxPeerIds!) + 1,
                signal: options.signal,
              });
            let pageStartedAtBeginning = !options.afterPeerId;
            let peerIds = await queryPage(options.afterPeerId);
            assertCurrent();
            if (options.afterPeerId && peerIds.length === 0) {
              pageStartedAtBeginning = true;
              peerIds = await queryPage();
            }
            assertCurrent();
            const overflowed = !pageStartedAtBeginning
              || peerIds.length > options.maxPeerIds;
            const bounded = peerIds.slice(0, overflowed ? pagePeerIds : options.maxPeerIds);
            return {
              peerIds: bounded,
              lookupFailed: false,
              overflowed,
              ...(overflowed && bounded[0]
                ? { nextPageAfterPeerId: bounded[bounded.length - 1] }
                : {}),
            };
          }

          const agents = await this.discovery.findAgents({
            agentAddress: structuralAgent,
            signal: options.signal,
          });
          assertCurrent();
          const peerIds = [...new Set(agents
            .filter((a) => a.agentAddress?.toLowerCase() === structuralAgent)
            .map((a) => a.peerId))]
            .sort((left, right) => left.localeCompare(right));
          return { peerIds, lookupFailed: false, overflowed: false };
        } catch {
          assertCurrent();
          return { peerIds: [], lookupFailed: true };
        }
      };
      let resolution = await resolve();
      assertCurrent();
      if (resolution.peerIds.length === 0) {
        assertCurrent();
        const refreshed = await this.refreshMetaFromCurator(contextGraphId, {
          signal: options.signal,
        }).catch((error) => {
          assertCurrent();
          return false;
        });
        assertCurrent();
        resolution = await resolve();
        assertCurrent();
        // An empty local query after a failed/cooldown refresh is not an
        // authoritative empty registry. Preserve any caller-side last-known
        // curator roster unless another writer populated the registry.
        if (!refreshed && !resolution.lookupFailed && resolution.peerIds.length === 0) {
          resolution = { ...resolution, lookupFailed: true };
        }
      }
      return {
        peerIds: resolution.peerIds,
        curatorIsLocal: false,
        legacyTripleResolved: false,
        ...(resolution.lookupFailed ? { lookupFailed: true } : {}),
        ...(resolution.overflowed ? { overflowed: true } : {}),
        ...(resolution.nextPageAfterPeerId
          ? { nextPageAfterPeerId: resolution.nextPageAfterPeerId }
          : {}),
      };
    }
    // Legacy non-wallet-scoped CG: fall back to triple-based curator resolution.
    assertCurrent();
    if (await this.isCuratorOf(contextGraphId, { signal: options.signal })) {
      assertCurrent();
      return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: true };
    }
    assertCurrent();
    let curatorPeerId = await this.resolveCuratorPeerId(contextGraphId, {
      signal: options.signal,
    });
    assertCurrent();
    if (!curatorPeerId) {
      assertCurrent();
      await this.refreshMetaFromCurator(contextGraphId, {
        signal: options.signal,
      })
        .catch((error) => {
          assertCurrent();
          return undefined;
        });
      assertCurrent();
      curatorPeerId = await this.resolveCuratorPeerId(contextGraphId, {
        signal: options.signal,
      });
      assertCurrent();
    }
    if (!curatorPeerId) return { peerIds: [], curatorIsLocal: false, legacyTripleResolved: true };
    if (curatorPeerId === this.peerId) return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: true };
    return { peerIds: [curatorPeerId], curatorIsLocal: false, legacyTripleResolved: true };
  }

  async syncSharedMemoryFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
    options?: OrdinarySharedMemorySyncFromPeerOptions,
  ): Promise<SharedMemorySyncResult> {
    const execution = await this.syncSharedMemoryFromPeerDetailedExecution(
      remotePeerId,
      contextGraphIds,
      options,
    );
    return execution.shared;
  }

  async syncSelectedSharedMemoryFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
    options: SelectedSharedMemorySyncFromPeerOptions,
  ): Promise<SelectedSharedMemorySyncResult> {
    const execution = await this.syncSharedMemoryFromPeerDetailedExecution(
      remotePeerId,
      contextGraphIds,
      options,
    );
    if (execution.kind !== 'selected-shared-memory') {
      throw new Error('Selected shared-memory execution returned an ordinary result');
    }
    return execution;
  }

  /** Internal producer shared by the ordinary and selected typed boundaries. */
  async syncSharedMemoryFromPeerDetailedExecution(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
    options?: OrdinarySharedMemorySyncFromPeerOptions | SelectedSharedMemorySyncFromPeerOptions,
  ): Promise<SharedMemorySyncExecution> {
    const ctx = createOperationContext('sync');
    const requestedScope = options?.selectedSwmPriority === true
      ? options.requestedScope
      : null;
    const requestedTargets = requestedScope === null
      ? null
      : requestedScope.kind === 'rfc64-recovery-plan'
        ? requestedScope.plan.targets
        : requestedScope.targets;
    const execution = (
      shared: SharedMemorySyncResult,
      completedTargetKeys: ReadonlySet<string> = new Set(),
    ): SharedMemorySyncExecution => requestedScope !== null
      ? selectedSharedMemoryExecutionResult(
        requestedScope,
        shared,
        completedTargetKeys,
      )
      : { kind: 'ordinary-shared-memory', shared };
    if (!durableSyncEnabled(this.config)) {
      this.log.warn(ctx, `Skipping shared-memory sync from ${remotePeerId.slice(-8)} (DKG_DURABLE_SYNC_ENABLED=0)`);
      return execution(emptySharedMemorySyncResult());
    }
    const recoverPrivateContextGraph = (contextGraphId: string) => runRecoverContextGraphSwmFromPeer(
      {
        store: this.store,
        writeLocks: this.writeLocks,
        listSubGraphs: (id) => this.listSubGraphs(id),
        createContextGraphSyncDeadline: (remaining) => createContextGraphSyncDeadline({
          remainingContextGraphs: remaining,
        }),
        fetchSyncPages: (ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef) =>
          this.fetchSyncPages(ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, {
            snapshotRef,
            recovery: true,
          }),
        processSharedMemoryBatch: (data, meta, cgId, registered, excluded) =>
          this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(data, meta, cgId, registered, excluded),
        publicSnapshotStore: this.publicSnapshotStore,
        snapshotMaterializer: createSharedMemorySnapshotMaterializer({
          store: this.store,
          writeLocks: this.writeLocks,
          invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
        }),
        recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
        invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
        markMetaProjectionDirty: (quads) => this.contextGraphMetaProjection.markDirtyFromQuads(quads),
        setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
        deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
        ensureOwnedMap: (ownershipKey) => {
          if (!this.workspaceOwnedEntities.has(ownershipKey)) {
            this.workspaceOwnedEntities.set(ownershipKey, new Map());
          }
          return this.workspaceOwnedEntities.get(ownershipKey)!;
        },
        logInfo: (opCtx, message) => this.log.info(opCtx, message),
        logWarn: (opCtx, message) => this.log.warn(opCtx, message),
        includeRootScope: requestedScope !== null
          || this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId).legacySyncAllowed,
      },
      remotePeerId,
      contextGraphId,
    );
    if (
      requestedTargets !== null
      && !sameStringArray(
        requestedTargets.map(({ contextGraphId }) => contextGraphId),
        contextGraphIds,
      )
    ) {
      throw new TypeError('Selected shared-memory request targets do not match its execution scope');
    }
    const planned = options?.selectedSwmPriority === true
      ? undefined
      : options?.sharedMemorySyncPlan;
    const initialPlan = requestedTargets !== null
      ? { targets: requestedTargets }
      : planned && sameStringArray(sharedMemoryPlanContextGraphIds(planned), contextGraphIds)
        ? planned
        : await this.planSharedMemorySyncContextGraphs(remotePeerId, contextGraphIds, ctx);
    // Every plan, including a dedicated RFC-64 execution, passes the ordinary
    // source-authority guard. The RFC-64 boundary adds current-config proof;
    // it does not create a parallel bypass mode inside generic synchronization.
    const plan = enforceRfc64CompleteProviderAuthority(
      initialPlan,
      remotePeerId,
      (contextGraphId) => this.resolveRfc64CompleteSwmProviderPeerIdsV1(contextGraphId),
      (contextGraphId, peerId) => this.log.debug(
        ctx,
        `SWM sync: rejecting preplanned "${contextGraphId}" from ${peerId.slice(-8)} — RFC-64 complete provider selected`,
      ),
    );
    const targetByContextGraph = new Map(
      plan.targets.map((target) => [target.contextGraphId, target] as const),
    );
    const orderedTargets = orderContextGraphIdsByPriority(
      sharedMemoryPlanContextGraphIds(plan),
      this.config.syncContextGraphPriorities,
    ).map((contextGraphId) => {
      const target = targetByContextGraph.get(contextGraphId);
      if (target === undefined) {
        throw new TypeError(`Missing shared-memory target for "${contextGraphId}"`);
      }
      return target;
    });
    const selectedPublicTargets = sharedMemoryPlanTargets(plan, 'selected-public');
    const stopOnBackoffWorthyFailure = options?.stopOnBackoffWorthyFailure;
    const selectedSwmEnabled = Boolean(
      options?.selectedSwmPriority && selectedPublicTargets.length > 0,
    );
    const selectedBootstrapOwner = selectedSwmEnabled
      ? this.selectedSwmBootstrapAdmission.beginTransfer(
        remotePeerId,
        selectedPublicTargets.map(({ contextGraphId }) => contextGraphId),
      )
      : null;
    const selectedMetaRetentionBudget = selectedSwmEnabled
      ? (() => {
        const budget = resolveSyncResponderSnapshotPolicy(
          this.config.syncResponderSnapshotLimits,
          process.env,
        ).budget;
        return selectedSwmMetaRetentionBudgetFor(this, {
          maxRows: budget.maxRows,
          maxBytesEstimate: budget.maxBytesEstimate,
          maxPrefixRows: budget.maxSnapshotRows,
          maxPrefixBytesEstimate: budget.maxSnapshotBytesEstimate,
        });
      })()
      : undefined;
    const createSelectedMetaFetcher = (): SelectedSwmMetaFetcher => {
      const requesterScope = nextSelectedSwmMetaRequesterScope();
      return createSelectedSwmMetaFetcher({
        remotePeerId,
        requesterScope,
        retentionBudget: selectedMetaRetentionBudget!,
        deleteCheckpoint: (key) => deleteSyncPageCheckpoint(this.syncCheckpoints, key),
        fetchPage: (request) => this.fetchSyncPages(
          request.ctx,
          request.remotePeerId,
          request.contextGraphId,
          true,
          'meta',
          request.graphUri,
          request.deadline,
          {
            returnAcceptedPrefixOnRetryableTransportFailure:
              request.returnAcceptedPrefixOnRetryableTransportFailure,
            requesterScope: request.requesterScope,
            maxAcceptedQuads: request.maxAcceptedQuads,
            maxAcceptedHeapBytesEstimate: request.maxAcceptedHeapBytesEstimate,
          },
        ),
      });
    };
    const singleFlightKey = sharedMemorySyncSingleFlightKey({
      remotePeerId,
      contextGraphIds,
      stopOnBackoffWorthyFailure,
      targets: orderedTargets,
      priority: options?.priority,
      selectedSwm: selectedSwmEnabled,
      requestedScope,
    });

    const runSync = async (
      selectedMetaFetcher?: SelectedSwmMetaFetcher,
    ): Promise<SharedMemorySyncExecution> => {
      const subGraphAdmissionByContextGraph = new Map<string, Promise<{ registered: string[]; excluded: string[] }>>();
      const getSubGraphAdmission = (contextGraphId: string) => {
        let admission = subGraphAdmissionByContextGraph.get(contextGraphId);
        if (!admission) {
          admission = getSharedMemorySubGraphAdmission(this.store, contextGraphId, this.listSubGraphs(contextGraphId));
          subGraphAdmissionByContextGraph.set(contextGraphId, admission);
        }
        return admission;
      };

      const syncPublicContextGraph = async (
        contextGraphId: string,
        remainingContextGraphs: number,
      ): Promise<SharedMemorySyncResult> => {
        const result = await runSharedMemorySync({
          ctx,
          remotePeerId,
          contextGraphIds: [contextGraphId],
          createContextGraphSyncDeadline: () => createContextGraphSyncDeadline({
            remainingContextGraphs,
          }),
          fetchSyncPages: (
            ctx2,
            peerId,
            cgId,
            includeSharedMemory,
            phase,
            graphUri,
            deadline,
            fetchOptions,
          ) => this.fetchSyncPages(
            ctx2,
            peerId,
            cgId,
            includeSharedMemory,
            phase,
            graphUri,
            deadline,
            fetchOptions,
          ),
          processSharedMemoryBatch: (wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames, excludedSubGraphNames) =>
            this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(
              wsDataQuads,
              wsMetaQuads,
              contextGraphId,
              registeredSubGraphNames,
              excludedSubGraphNames,
            ),
          getRegisteredSubGraphNames: async (contextGraphId) => (await getSubGraphAdmission(contextGraphId)).registered,
          getExcludedSubGraphNames: async (contextGraphId) => (await getSubGraphAdmission(contextGraphId)).excluded,
          includeRootScope: requestedScope !== null
            || this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId).legacySyncAllowed,
          stopOnBackoffWorthyFailure,
          snapshotEvidencePolicy: selectedSwmEnabled
            ? {
              // Any graph-backed operation sits outside the immutable snapshot
              // walk, including when other operations in the same manifest do
              // have store-backed refs. Until this requester has count/digest-
              // bound transport evidence for every such operation, the selected
              // lane must fail closed.
              accepts: ({
                verifiedMetadataTriples,
                snapshotReferences,
                graphBackedOperations,
              }) => (
                verifiedMetadataTriples === 0
                || (snapshotReferences > 0 && graphBackedOperations === 0)
              ),
            }
            : undefined,
          metadataFetcher: selectedMetaFetcher?.strategy,
          snapshotRecoveryOrder: selectedSwmEnabled ? 'recent-balanced' : 'manifest',
          ensureContextGraph: async (contextGraphId) => {
            const graphManager = new GraphManager(this.store);
            await graphManager.ensureContextGraph(contextGraphId);
          },
          // Everything needed to materialize verified public SWM snapshots,
          // as ONE dependency (a loose optional trio allowed a silent
          // half-configured mode). Graph-scoped (contentScopeVersion 2) KAs
          // carry no dkg:rootEntity, so the aggregate data phase returns 0
          // data quads for them by design — their content arrives as
          // immutable snapshots, and without this the catch-up lane cached
          // every verified snapshot and never wrote one to the store.
          // Thin wiring only: the materialization policy (content-digest
          // guard, MAX head read + duplicate repair, atomic replace, head
          // metadata swap) lives in `swm-snapshot-materializer.ts`. What
          // the agent contributes here is its own resources — the store,
          // the SAME lock map injected into SharedMemoryHandler (sharing
          // the map + key helper is what closes the check-then-replace
          // race with gossip), and list-cache invalidation.
          snapshotMaterializer: createSharedMemorySnapshotMaterializer({
            store: this.store,
            writeLocks: this.writeLocks,
            invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
          }),
          reconcileFinalizedTwin: async (contextGraphId, descriptor) => {
            const retirement = await reconcileFinalizedSwmTwinFromDescriptor({
              store: this.store,
              writeLocks: this.writeLocks,
              contextGraphId,
              descriptor,
              retire: (candidate) => this.retireFinalizedSwmTwinCandidate(candidate, ctx),
            });
            if (retirement === 'retired') {
              this.invalidateListContextGraphsCache();
              this.log.info(
                ctx,
                `Retired byte-identical SWM twin after SWM recovery found finalized VM for ${descriptor.kaUal}`,
              );
            }
            return retirement === 'retired' || retirement === 'already-retired-finalized'
              ? 'suppress-metadata'
              : 'preserve';
          },
          storeInsert: async (quads) => {
            // Oversize guard (OT-RFC-56): drop+tombstone protocol-violating
            // literals BEFORE insert so the SWM page cursor advances instead
            // of the store throwing and the page re-fetching forever.
            const inserted = await insertWithOversizeGuard(
              (kept) => this.store.insert(kept, {
                priority: 'background',
                source: 'agent.sharedMemorySync.storeInsert',
              }),
              quads,
              { recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam) },
              'swm-sync',
            );
            this.contextGraphMetaProjection.markDirtyFromQuads(inserted);
          },
          publicSnapshotStore: this.publicSnapshotStore,
          deleteCheckpoint: (key) => deleteSyncPageCheckpoint(this.syncCheckpoints, key),
          setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
          ensureOwnedMap: (contextGraphId) => {
            if (!this.workspaceOwnedEntities.has(contextGraphId)) {
              this.workspaceOwnedEntities.set(contextGraphId, new Map());
            }
            return this.workspaceOwnedEntities.get(contextGraphId)!;
          },
          logInfo: (opCtx, message) => this.log.info(opCtx, message),
          logWarn: (opCtx, message) => this.log.warn(opCtx, message),
          logDebug: (opCtx, message) => this.log.debug(opCtx, message),
        });
        return result;
      };

      const completedTargetKeys = new Set<string>();
      const selectedContinuationUnits: SelectedSwmContinuationUnit[] = [];
      const work: ContextGraphSyncWork<SharedMemorySyncResult>[] = [];
      for (const target of orderedTargets) {
        const { contextGraphId } = target;
        if (target.lane === 'selected-public') {
          work.push({
            contextGraphId,
            lane: 'shared_memory',
            operationId: `shared-memory:${contextGraphId}:${remotePeerId.slice(-8)}`,
            run: (remainingContextGraphs: number) => syncPublicContextGraph(
              contextGraphId,
              remainingContextGraphs,
            ),
          });
          continue;
        }
        work.push({
          contextGraphId,
          lane: 'swm_recovery',
          operationId: `swm-recovery:${contextGraphId}:${remotePeerId.slice(-8)}`,
          run: async (): Promise<SharedMemorySyncResult> => {
            try {
              const recovered = await recoverContextGraphSwmWithProgressRetries({
                recover: () => recoverPrivateContextGraph(contextGraphId),
                onRetry: ({ completedRound, readySnapshots, totalSnapshots }) => {
                  this.log.info(
                    ctx,
                    `Continuing private SWM recovery for "${contextGraphId}" from ${remotePeerId.slice(-8)} `
                    + `after round ${completedRound}: snapshots=${readySnapshots}/${totalSnapshots}`,
                  );
                },
              });
              const result = emptySharedMemorySyncResult();
              result.insertedDataTriples = recovered.insertedDataQuads;
              result.insertedMetaTriples = recovered.insertedMetaQuads;
              result.insertedTriples = recovered.insertedDataQuads + recovered.insertedMetaQuads;
              result.droppedDataTriples = recovered.droppedDataTriples;
              // A deadline-bounded recovery returns `completed=false` without
              // mutating the store. Keep that retry signal inside this work item
              // so every requester lane shares the same orchestration loop.
              if (recovered.completed) {
                result.completedPhases = 1;
                completedTargetKeys.add(sharedMemoryRecoveryTargetKey(target));
              } else {
                result.failedPhases = 1;
                result.backoffWorthyFailures = 1;
              }
              return result;
            } catch (error) {
              if (getSyncBackpressureBusyError(error)) throw error;
              this.log.warn(ctx, `Curator-recovery for private CG "${contextGraphId}" from ${remotePeerId} failed: ${error instanceof Error ? error.message : String(error)}`);
              return {
                ...emptySharedMemorySyncResult(),
                failedPeers: 1,
                backoffWorthyFailures: 1,
              };
            }
          },
        });
      }

      const initialSummary = await runOrderedContextGraphSyncs({
        work,
        priorities: this.config.syncContextGraphPriorities,
        emptyResult: emptySharedMemorySyncResult,
        runWithAdmission: (item, run) => {
          const selectedPublicWork = selectedSwmEnabled
            && item.lane === 'shared_memory';
          return this.runContextGraphSyncWithBackpressure(
            ctx,
            item.contextGraphId,
            item.lane,
            item.operationId,
            run,
            {
              priorityOverride: selectedPublicWork ? options?.priority : undefined,
              source: options?.source,
              selectedSwmPriority: selectedPublicWork,
            },
          );
        },
        merge: mergeSharedMemorySyncResults,
        onResult: (item, result) => {
          if (
            selectedSwmEnabled
            && item.lane === 'shared_memory'
          ) {
            const metadataContinuation = selectedMetaFetcher!.continuation(
              item.contextGraphId,
            );
            selectedContinuationUnits.push({
              work: {
                ...item,
                run: async (remainingContextGraphs) => {
                  const nextResult = await item.run(remainingContextGraphs);
                  return {
                    result: nextResult,
                    metadataContinuation: selectedMetaFetcher!.continuation(
                      item.contextGraphId,
                    ),
                  };
                },
              },
              initialRound: { result, metadataContinuation },
            });
          }
        },
        markDeferred: (summary) => ({
          ...summary,
          deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
        }),
        // Mirrors the durable fanout: a failed CG round is already recorded in
        // the merged counters and must not cost the remaining CGs their turn.
        // `failedPeers` is the peer-never-responded signal on the public lane;
        // the private curator-recovery lane also reports it for its whole-round
        // failures, which the consecutive-failure guard bounds instead of
        // aborting on the first one.
        isPeerTransportFailure: (part) => Boolean(
          stopOnBackoffWorthyFailure && part.failedPeers > 0,
        ),
        onDeferred: (item, error) => this.log.info(
          ctx,
          `Deferring ${item.lane} at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
        ),
      });

      if (
        !selectedSwmEnabled
        || selectedContinuationUnits.length === 0
        || (initialSummary.deferredBackpressure ?? 0) > 0
      ) {
        if (selectedSwmEnabled && (initialSummary.deferredBackpressure ?? 0) > 0) {
          this.log.info(
            ctx,
            `Selected RFC-64 SWM continuation from ${remotePeerId.slice(-8)} stopped on local backpressure`,
          );
        }
        return execution(initialSummary, completedTargetKeys);
      }

      const continuationExecution = await runSelectedSwmContinuations({
        providerPeerId: remotePeerId,
        units: selectedContinuationUnits,
        priorities: this.config.syncContextGraphPriorities,
        passConfig: resolveSwmCatchupPassConfig(),
        nowMs: catchupPassNowMs,
        emptyResult: emptySharedMemorySyncResult,
        runWithAdmission: (item, run) => this.runContextGraphSyncWithBackpressure(
          ctx,
          item.contextGraphId,
          item.lane,
          item.operationId,
          run,
          {
            priorityOverride: options?.priority,
            source: options?.source,
            selectedSwmPriority: true,
          },
        ),
        merge: mergeSharedMemorySyncResults,
        markDeferred: (summary) => ({
          ...summary,
          deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
        }),
        isPeerTransportFailure: (part) => Boolean(
          stopOnBackoffWorthyFailure && part.failedPeers > 0,
        ),
        onDeferred: (item, error) => this.log.info(
          ctx,
          `Deferring ${item.lane} at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
        ),
        onStop: (stop) => {
          this.log.info(
            ctx,
            `Selected RFC-64 SWM continuation for "${stop.contextGraphId}" stopped after `
            + `${1 + stop.continuationPasses} pass(es): ${stop.reason}`,
          );
        },
        onBackpressure: () => {
          this.log.info(
            ctx,
            `Selected RFC-64 SWM continuation from ${remotePeerId.slice(-8)} stopped on local backpressure`,
          );
        },
        onContinuation: (progress) => {
          this.log.info(
            ctx,
            `Continued selected RFC-64 SWM for "${progress.contextGraphId}" from ${remotePeerId.slice(-8)}: `
            + `continuation progress ${progress.progressBefore} -> ${progress.progressAfter}`,
          );
        },
        onExpiredAfterAdmission: (contextGraphId) => {
          this.log.info(
            ctx,
            `Selected RFC-64 SWM continuation for "${contextGraphId}" expired while awaiting admission`,
          );
        },
      });
      const { summary: continuationSummary } = continuationExecution;
      const finalSummary = mergeSharedMemorySyncResults(
        initialSummary,
        continuationSummary,
      );
      const incompleteSelectedContextGraphs = new Set(
        continuationExecution.incompleteContextGraphIds,
      );
      const continuedSelectedContextGraphs = new Set(
        selectedContinuationUnits.map(({ work: unitWork }) => unitWork.contextGraphId),
      );
      for (const target of selectedPublicTargets) {
        if (
          continuedSelectedContextGraphs.has(target.contextGraphId)
          && !incompleteSelectedContextGraphs.has(target.contextGraphId)
        ) {
          completedTargetKeys.add(sharedMemoryRecoveryTargetKey(target));
        }
      }
      const selectedPublicScopeComplete = selectedPublicTargets.every(
        (target) => completedTargetKeys.has(sharedMemoryRecoveryTargetKey(target)),
      );
      if (selectedBootstrapOwner !== null && selectedPublicScopeComplete) {
        this.selectedSwmBootstrapAdmission.markTransferTerminal(selectedBootstrapOwner);
      }
      // Preserve the raw historical yield/failure counters for diagnostics;
      // the canonical freshness helper bounds the selected continuation's
      // resolution before final on-connect classification consumes it.
      return execution(
        applySelectedSwmFreshnessResolution(
          finalSummary,
          continuationExecution.freshnessResolution,
        ),
        completedTargetKeys,
      );
    };

    return runSyncSingleFlight(this, singleFlightKey, () => (
      selectedSwmEnabled
        ? this.getSelectedSwmMetaTransfers().run(
          remotePeerId,
          createSelectedMetaFetcher,
          (selectedMetaFetcher) => runSync(selectedMetaFetcher),
        )
        : runSync()
    ), {
      scope: 'shared-memory',
      source: options?.source,
    });
  }

  /**
   * recover ONE context graph's `_shared_memory` to current
   * state from a single authoritative peer (member / anchor), applying via
   * REPLACE rather than the shared incremental union path (which corrupts a
   * non-empty store). Invoked by the member-recovery driver after the frontier
   * detects a full / cross-epoch gap; isolated from `runSharedMemorySync` so the
   * incremental path is untouched.
   */
  async recoverContextGraphSwmFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
  ): Promise<RecoverContextGraphSwmResult> {
    const ctx = createOperationContext('sync');
    if (!durableSyncEnabled(this.config)) {
      this.log.warn(ctx, `Skipping SWM recovery from ${remotePeerId.slice(-8)} (DKG_DURABLE_SYNC_ENABLED=0)`);
      return emptySwmRecoveryResult();
    }
    return this.runContextGraphSyncWithBackpressure(
      ctx,
      contextGraphId,
      'swm_recovery',
      `swm-recovery:${contextGraphId}:${remotePeerId.slice(-8)}`,
      () => runRecoverContextGraphSwmFromPeer(
        {
          store: this.store,
          writeLocks: this.writeLocks,
          listSubGraphs: (id) => this.listSubGraphs(id),
          createContextGraphSyncDeadline: (remaining) => createContextGraphSyncDeadline({
            remainingContextGraphs: remaining,
          }),
          fetchSyncPages: (ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef) =>
            this.fetchSyncPages(ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, {
              snapshotRef,
              recovery: true,
            }),
          processSharedMemoryBatch: (data, meta, cgId, registered, excluded) =>
            this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(data, meta, cgId, registered, excluded),
          publicSnapshotStore: this.publicSnapshotStore,
          snapshotMaterializer: createSharedMemorySnapshotMaterializer({
            store: this.store,
            writeLocks: this.writeLocks,
            invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
          }),
          recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam),
          invalidateListContextGraphsCache: () => this.invalidateListContextGraphsCache(),
          markMetaProjectionDirty: (quads) => this.contextGraphMetaProjection.markDirtyFromQuads(quads),
          setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
          deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
          ensureOwnedMap: (ownershipKey) => {
            if (!this.workspaceOwnedEntities.has(ownershipKey)) {
              this.workspaceOwnedEntities.set(ownershipKey, new Map());
            }
            return this.workspaceOwnedEntities.get(ownershipKey)!;
          },
          logInfo: (opCtx, message) => this.log.info(opCtx, message),
          logWarn: (opCtx, message) => this.log.warn(opCtx, message),
          includeRootScope: this.resolveRfc64CatalogReceiverAuthorityV1(
            contextGraphId,
          ).legacySyncAllowed,
        },
        remotePeerId,
        contextGraphId,
      ),
      { source: 'swm-recovery' },
    );
  }

  /**
   * Join or create the one durable VM-recovery owner for a Context Graph.
   *
   * The owner, not an on-connect/explicit/reconcile trigger, chooses the peer.
   * Each physical call is a bounded continuation slice and therefore releases
   * `sync-global` admission before the coordinator schedules the next slice.
   * Only a terminal verified/materialized result resolves as success; forward
   * progress after a timeout remains attached to this promise and is never
   * charged as a failed peer attempt by the outer trigger.
   */
  async syncDurableRecoveryContextGraph(this: DKGAgent,
    contextGraphId: string,
    options: {
      candidatePeerIds?: readonly string[];
      /** Preserve a caller's already-windowed/rotated peer set exactly. */
      restrictToCandidatePeerIds?: boolean;
      /** The caller already completed the sync-protocol probe. */
      candidatesAreSyncCapable?: boolean;
    } = {},
  ): Promise<DurableRecoveryExecution> {
    const ctx = createOperationContext('sync');
    return durableRecoveryRunnerFor(this).run({
      contextGraphId,
      options,
      dependencies: {
        checkpointStore: this.syncCheckpoints,
        isRunning: () => this.started && this.node.stopSignal?.aborted !== true,
        resolvePreferredPeerId: () => this.resolvePreferredSyncPeerId(contextGraphId),
        connectRequestedPeer: async (peerId) => {
          if (await this.networkAdmissionCoordinator.ensureAdmitted(peerId, ctx)) {
            await this.ensurePeerConnected(peerId);
          }
        },
        primeConnections: () => this.primeCatchupConnections(),
        liveConnectionPeerIds: () => this.node.libp2p.getConnections()
          .map((connection) => connection.remotePeer.toString()),
        admitPeer: (peerId) => this.ensurePeerAdmittedForRecovery(
          peerId,
          ctx,
          'Durable recovery peer',
        ),
        isPrivateContextGraph: () => this.isPrivateContextGraph(contextGraphId),
        orderPeerIds: (peerIds, preferredPeerId, privateOnly) => this.selectCatchupPeers(
          peerIds.map((peerId) => ({ toString: () => peerId })),
          preferredPeerId,
          privateOnly,
        ).map((peer) => peer.toString()),
        isSyncCapable: (peerId) => this.waitForSyncProtocol({
          toString: () => peerId,
        }),
        executeSlice: (peerId, durableMetaContinuation) => this.syncFromPeerDetailed(
          peerId,
          [contextGraphId],
          undefined,
          undefined,
          undefined,
          {
            stopOnBackoffWorthyFailure: true,
            totalTimeoutMs: DURABLE_RECOVERY_HARD_TIMEOUT_MS,
            settlementSliceTimeoutMs: DURABLE_RECOVERY_SETTLEMENT_SLICE_TIMEOUT_MS,
            signal: this.node.stopSignal ?? undefined,
            priority: FOREGROUND_CATCHUP_SYNC_PRIORITY,
            source: 'vm-recovery',
            durableMetaContinuation,
          },
        ),
        logDebug: (message) => this.log.debug(ctx, message),
        logInfo: (message) => this.log.info(ctx, message),
        logWarn: (message) => this.log.warn(ctx, message),
      },
    });
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(this: DKGAgent,
    contextGraphId: string,
    options?: ContextGraphCatchupOptions,
  ): Promise<ContextGraphCatchupResult> {
    const ctx = createOperationContext('sync');
    const includeSharedMemory = options?.includeSharedMemory ?? false;
    const mode = options?.mode ?? 'background';
    const sourceOverride = options?.sourceOverride;

    this.trackSyncContextGraph(contextGraphId);

    // `sourceOverride` is deliberately ABSENT from this key: it is attribution
    // metadata, not work identity. Adding it would fork one physical catch-up
    // into one per trigger — real duplicated network traffic bought with a
    // label. The resulting attribution ambiguity is what I6 measures.
    const singleFlightKey = contextGraphCatchupSingleFlightKey({
      contextGraphId,
      includeSharedMemory,
      maxPeers: options?.maxPeers,
      peerRotationKey: options?.peerRotationKey,
      mode,
    });

    return runSyncSingleFlight(this, singleFlightKey, async (): Promise<ContextGraphCatchupResult> => {
      const isPrivateContextGraph = await this.isPrivateContextGraph(contextGraphId);

      const preferredPeerId = await this.resolvePreferredSyncPeerId(contextGraphId);
      if (preferredPeerId) {
        let preferredPeerAdmitted = false;
        try {
          preferredPeerAdmitted = await this.networkAdmissionCoordinator.ensureAdmitted(preferredPeerId, ctx);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Preferred catchup peer ${preferredPeerId.slice(-8)} admission probe failed: ${message}`);
        }
        if (preferredPeerAdmitted) {
          await this.ensurePeerConnected(preferredPeerId);
        }
      }

      await this.primeCatchupConnections();

      const connectedPeers = [...new Map(
        this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
      ).values()];
      const admittedConnectedPeers: Array<{ toString(): string }> = [];
      for (const peer of connectedPeers) {
        if (await this.ensurePeerAdmittedForRecovery(peer.toString(), ctx, 'Connected catchup peer')) {
          admittedConnectedPeers.push(peer);
        }
      }
      const orderedPeers = this.selectCatchupPeers(
        admittedConnectedPeers,
        preferredPeerId,
        isPrivateContextGraph,
      );
      const peerPriorityRanks = new Map<string, number>();
      for (const peer of orderedPeers) {
        const peerId = peer.toString();
        const rank = peerId === preferredPeerId ? 2 : this.knownCorePeerIds.has(peerId) ? 1 : 0;
        if (rank > 0) peerPriorityRanks.set(peerId, rank);
      }
      const graphOwnerSelectsRecoveryPeer = sourceOverride === 'vm-recovery'
        && (this.config.syncContextGraphs ?? []).includes(contextGraphId);
      const peers = graphOwnerSelectsRecoveryPeer
        ? orderedPeers
        : this.selectCatchupPeerWindow(orderedPeers, { ...options, peerPriorityRanks });
      const coreCount = orderedPeers.filter((p) => this.knownCorePeerIds.has(p.toString())).length;
      this.log.info(
        ctx,
        `catchup peer order for "${contextGraphId}": preferred=${preferredPeerId ?? 'none'} cores=${coreCount} total=${orderedPeers.length} selected=${peers.length}`
        + (graphOwnerSelectsRecoveryPeer ? ' owner-ranked=true' : ''),
      );
      return this.runCatchupOverPeers(contextGraphId, includeSharedMemory, peers, {
        totalPeers: orderedPeers.length,
        mode,
        sourceOverride,
      });
    }, {
      scope: 'context-graph',
      source: catchupAdmissionSource(mode, sourceOverride),
    });
  }

  /** Focused VM-recovery operation that returns clean per-peer miss evidence. */
  async syncVmRecoveryFromConnectedPeers(
    this: DKGAgent,
    contextGraphId: string,
    options?: ContextGraphCatchupOptions,
  ): Promise<{ catchup: ContextGraphCatchupResult; cleanMissPeerIds: string[] }> {
    const catchup = await this.syncContextGraphFromConnectedPeers(contextGraphId, options);
    return {
      catchup,
      // Embedders may still override the catch-up method with the pre-evidence
      // result shape. Treat that legacy shape as no proof; production results
      // always carry the immutable field below.
      cleanMissPeerIds: [...(catchup.cleanSharedMemoryPeerIds ?? [])],
    };
  }

  selectCatchupPeerWindow(this: DKGAgent,
    peers: Array<{ toString(): string }>,
    options?: { maxPeers?: number; peerRotationKey?: string; peerPriorityRanks?: ReadonlyMap<string, number> },
  ): Array<{ toString(): string }> {
    const maxPeers = options?.maxPeers;
    if (maxPeers === undefined || !Number.isInteger(maxPeers) || maxPeers <= 0) {
      return peers;
    }

    let start = 0;
    const rotationKey = options?.peerRotationKey;
    const currentPriorityRank = (peerId: string): number => options?.peerPriorityRanks?.get(peerId) ?? 0;
    const rememberRotation = (peerIds: string[], selectedCount: number): void => {
      if (!rotationKey) return;
      if (peerIds.length === 0) {
        this.vmReconcileCatchupPeerCursor.delete(rotationKey);
        this.vmReconcileCatchupPeerOrder.delete(rotationKey);
        return;
      }
      const nextCursor = start + selectedCount;
      const selectedAll = selectedCount >= peerIds.length;
      this.vmReconcileCatchupPeerCursor.delete(rotationKey);
      this.vmReconcileCatchupPeerCursor.set(rotationKey, nextCursor);
      this.vmReconcileCatchupPeerOrder.delete(rotationKey);
      this.vmReconcileCatchupPeerOrder.set(rotationKey, {
        orderedPeers: peerIds,
        nextPeerId: selectedAll ? undefined : peerIds[nextCursor % peerIds.length],
        priorityRanks: Object.fromEntries(
          peerIds
            .map((peerId) => [peerId, currentPriorityRank(peerId)] as const)
            .filter(([, rank]) => rank > 0),
        ),
      });
    };

    if (peers.length <= maxPeers) {
      if (rotationKey) {
        this.pruneVmReconcileState();
        rememberRotation(peers.map((peer) => peer.toString()), peers.length);
      }
      return peers;
    }

    if (rotationKey) {
      this.pruneVmReconcileState();
      const peerIds = peers.map((peer) => peer.toString());
      const previousOrder = this.vmReconcileCatchupPeerOrder.get(rotationKey);
      const nextPeerId = previousOrder?.nextPeerId;
      const previousPriorityRank = (peerId: string): number => previousOrder?.priorityRanks?.[peerId] ?? 0;
      const gainedPriority = (peerId: string): boolean => currentPriorityRank(peerId) > previousPriorityRank(peerId);
      if (nextPeerId) {
        const nextPeerIndex = peerIds.indexOf(nextPeerId);
        if (nextPeerIndex >= 0) {
          const previousPeers = new Set(previousOrder.orderedPeers);
          const firstInvalidatingPeerIndex = peerIds
            .slice(0, nextPeerIndex)
            .findIndex((peerId) => (!previousPeers.has(peerId) && currentPriorityRank(peerId) > 0) || gainedPriority(peerId));
          start = firstInvalidatingPeerIndex >= 0 ? firstInvalidatingPeerIndex : nextPeerIndex;
        } else {
          const previousPeers = new Set(previousOrder.orderedPeers);
          const firstInvalidatingPeerIndex = peerIds.findIndex((peerId) =>
            (!previousPeers.has(peerId) && currentPriorityRank(peerId) > 0) || gainedPriority(peerId),
          );
          start = firstInvalidatingPeerIndex >= 0
            ? firstInvalidatingPeerIndex
            : (this.vmReconcileCatchupPeerCursor.get(rotationKey) ?? 0) % peers.length;
        }
      } else {
        const previousPeers = new Set(previousOrder?.orderedPeers ?? []);
        const firstInvalidatingPeerIndex = peerIds.findIndex((peerId) =>
          !previousPeers.has(peerId) || gainedPriority(peerId),
        );
        start = firstInvalidatingPeerIndex >= 0
          ? firstInvalidatingPeerIndex
          : (this.vmReconcileCatchupPeerCursor.get(rotationKey) ?? 0) % peers.length;
      }
      rememberRotation(peerIds, maxPeers);
    }

    return [...peers.slice(start), ...peers.slice(0, start)].slice(0, maxPeers);
  }

  async runCatchupOverPeers(this: DKGAgent,
    contextGraphId: string,
    includeSharedMemory: boolean,
    peers: Array<{ toString(): string }>,
    stats?: {
      totalPeers?: number;
      mode?: CatchupMode;
      sourceOverride?: SyncAdmissionSource;
      /** Explicit test/embedding override; production resolves the operator env per job. */
      swmCatchupPassConfig?: CatchupPassConfig;
    },
  ): Promise<{
    /** Ordered connected peers before optional caller windowing. */
    connectedPeers: number;
    /** Ordered connected peers before optional caller windowing. */
    totalPeers: number;
    /** Peers selected and evaluated after optional caller windowing. */
    selectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    peersResponded: number;
    peersSucceeded: number;
    deferredBackpressure: number;
    dataSynced: number;
    sharedMemorySynced: number;
    /** A selected peer completed a non-empty SWM snapshot without failure. */
    sharedMemoryCompletedCleanly: boolean;
    /** Immutable evidence owned by this catch-up operation and its single-flight result. */
    cleanSharedMemoryPeerIds: readonly string[];
    denied: boolean;
    deniedPeers: number;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    let syncCapablePeers = 0;
    let peersTried = 0;
    const attemptedPeers = new Set<string>();
    const peersResponded = new Set<string>();
    let deferredBackpressure = 0;
    let dataSynced = 0;
    let sharedMemorySynced = 0;
    let noProtocolPeers = 0;
    const cleanSharedMemoryPeerIds = new Set<string>();
    const diagnostics: CatchupSyncDiagnostics = {
      noProtocolPeers: 0,
      durable: {
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
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
      sharedMemory: {
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
        deferredBackpressure: 0,
        snapshotPlaneIncomplete: 0,
        continuationPasses: 0,
        replayPhaseBytesReceived: 0,
        snapshotPhaseBytesReceived: 0,
      },
    };
    const passTracker = new SwmCatchupPassTracker<SwmSnapshotCoverage>();

    if (DEBUG_SYNC_PROGRESS) {
      this.log.info(
        ctx,
        `Catch-up peer set for "${contextGraphId}": ${peers.map((peer) => peer.toString()).join(', ') || 'none'}`,
      );
    }

    // Phase 1: probe all peers for PROTOCOL_SYNC support serially. This is
    // cheap (peerStore lookup / waitForPeerProtocol), but we keep it a
    // separate pass so Phase 2's Promise.all only kicks off peers we know
    // can serve us — parallel-probing would multiply connection churn for
    // no gain. See the "Run per-peer syncs in parallel" comment below.
    const syncCapable: string[] = [];
    for (const pid of peers) {
      if (DEBUG_SYNC_PROGRESS) {
        this.log.info(ctx, `Checking sync protocol for peer ${pid.toString()} in catch-up for "${contextGraphId}"`);
      }
      const hasSync = await this.waitForSyncProtocol(pid);
      if (!hasSync) {
        noProtocolPeers++;
        if (DEBUG_SYNC_PROGRESS) {
          this.log.warn(ctx, `Peer ${pid.toString()} is connected but not sync-capable for "${contextGraphId}"`);
        }
        continue;
      }
      syncCapable.push(pid.toString());
    }
    syncCapablePeers = syncCapable.length;
    const coordinatedRecovery = (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    let catchupPeers = syncCapable;

    // Run per-peer syncs in parallel. Without parallelism a curated CG
    // denial walks the whole peer set sequentially with 30s+ timeouts
    // each, causing the /api/subscribe catchup job to take minutes to
    // report denial and the UI to give up. We feed per-peer results into
    // v10-rc's new diagnostics shape (bytesReceived / resumedPhases /
    // deniedPhases, from `runDurableSync`), then translate `deniedPhases`
    // into HEAD's `accessDeniedPeers` counter so the existing daemon
    // catchup-status endpoint and UI keep working — see
    // `cli/src/daemon.ts` subscribe job and `catchup-runner.ts`.
    const emptyShared = (): SharedMemorySyncResult => ({
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
      failedPeers: 1,
      failedPhases: 0,
      deniedPhases: 0,
    });
    // Bounded fan-out: at most CATCHUP_MAX_CONCURRENT_PEER_SYNCS peer syncs run
    // at once. The pre-cap unbounded `Promise.all` over every sync-capable peer
    // was the top amplifier of the 2026-07-07 mainnet sync storm — one
    // subscribe/reconcile round on a high-degree node launched N concurrent
    // full-CG durable+SWM pulls that saturated the triple store (StorageACK
    // reads then dead-aired behind them). Every selected peer is still synced
    // and the result array is unchanged (input order, one entry per peer) — the
    // load is just staggered into waves.
    let results: Array<{
      durable: DurableSyncResult;
      shared: SharedMemorySyncResult | null;
    }>;
    if (coordinatedRecovery && syncCapable.length > 0) {
      // The caller has already applied curator/core ordering, maxPeers windowing,
      // rotation, and the sync-protocol probe. Hand that exact candidate set to
      // one graph owner; letting the owner rediscover the whole connection set
      // here would defeat both rotation and graph-level coalescing.
      const recovery = await this.syncDurableRecoveryContextGraph(contextGraphId, {
        candidatePeerIds: syncCapable,
        restrictToCandidatePeerIds: true,
        candidatesAreSyncCapable: true,
      });
      const durableByPeer = new Map(
        recovery.peerResults.map(({ peerId, result }) => [peerId, result]),
      );
      const durableAttemptedPeers = recovery.peerResults.map(({ peerId }) => peerId);
      for (const peerId of durableAttemptedPeers) attemptedPeers.add(peerId);
      catchupPeers = includeSharedMemory ? syncCapable : durableAttemptedPeers;
      if (includeSharedMemory) {
        for (const peerId of catchupPeers) attemptedPeers.add(peerId);
      }
      results = await mapWithConcurrency(
        catchupPeers,
        CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
        async (remotePeerId) => ({
          durable: durableByPeer.get(remotePeerId) ?? createIncompleteDurableSyncResult(),
          shared: includeSharedMemory
            ? await runCatchupPlaneWithPolicy(
                stats?.mode ?? 'background',
                ({ priority, source }) => this.syncSharedMemoryFromPeerDetailed(
                  remotePeerId,
                  [contextGraphId],
                  { ...(priority === undefined ? {} : { priority }), source },
                ).catch(emptyShared),
                { sourceOverride: stats?.sourceOverride },
              )
            : null,
        }),
      );
    } else {
      for (const peerId of catchupPeers) attemptedPeers.add(peerId);
      results = await mapWithConcurrency(
        catchupPeers,
        CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
        async (remotePeerId) => {
          const mode = stats?.mode ?? 'background';
          return runCatchupPlanesWithPolicy({
            mode,
            sourceOverride: stats?.sourceOverride,
            includeSharedMemory,
            syncDurable: ({ priority, source }) => this.syncFromPeerDetailed(
              remotePeerId,
              [contextGraphId],
              undefined,
              undefined,
              undefined,
              { ...(priority === undefined ? {} : { priority }), source },
            ).catch(() => createFailedPeerDurableSyncResult()),
            syncSharedMemory: ({ priority, source }) => this.syncSharedMemoryFromPeerDetailed(
              remotePeerId,
              [contextGraphId],
              { ...(priority === undefined ? {} : { priority }), source },
            ).catch(emptyShared),
          });
        },
      );
    }
    const accessDeniedPeers = new Set<string>();
    let cleanDurableDataSynced = 0;
    let cleanDurablePrivateOnlyCompletions = 0;
    let cleanSharedMemoryDataSynced = 0;
    const peersSucceeded = new Set<string>();
    for (const [resultIndex, r] of results.entries()) {
      const remotePeerId = catchupPeers[resultIndex]!;
      // A peer "succeeded" when its sync round finished without a transport
      // failure, denial, or timeout and either made phase/checkpoint progress,
      // or cleanly completed empty. Empty responses still count as a
      // legitimate host response, but a no-progress timeout must not make the
      // subscribe/VM catch-up path report a successful peer.
      const durableProgress = classifyDurableProgress(r.durable, {
        complete: r.durable.complete,
      });
      const sharedProgress = r.shared ? classifyDurableProgress(r.shared) : null;
      if (sharedProgress?.completedWithoutFailure) {
        cleanSharedMemoryPeerIds.add(remotePeerId);
      }
      if (r.shared) {
        passTracker.recordPeerRound(
          remotePeerId,
          r.shared.swmCoverage,
          Boolean(sharedProgress?.completedWithoutFailure),
        );
      }
      const durableFailed = durableProgress.transportFailed;
      const sharedFailed = Boolean(sharedProgress?.transportFailed);
      const durablePhaseFailed = durableProgress.phaseFailed;
      const sharedPhaseFailed = Boolean(sharedProgress?.phaseFailed);
      const durableDeferred = durableProgress.deferredByBackpressure;
      const sharedDeferred = Boolean(sharedProgress?.deferredByBackpressure);
      const peerDeferred = durableDeferred || sharedDeferred;
      const peerDeniedRound = durableProgress.denied || Boolean(sharedProgress?.denied);
      const peerMadeProgress = durableProgress.madeReadinessProgress
        || Boolean(sharedProgress?.madeReadinessProgress);
      const peerMetadataOnly = !peerMadeProgress
        && (durableProgress.hasMetadataEvidence || Boolean(sharedProgress?.hasMetadataEvidence));
      const peerTimedOut = durableProgress.timedOut || Boolean(sharedProgress?.timedOut);
      // A deferred plane only counts as a response when the peer actually
      // delivered something before local admission pressure stopped the batch.
      const durableResponded = !durableFailed && (!durableDeferred || (
        r.durable.bytesReceived > 0
        || r.durable.completedPhases > 0
        || r.durable.emptyResponses > 0
        || r.durable.insertedMetaTriples > 0
        || r.durable.insertedDataTriples > 0
      ));
      const sharedResponded = Boolean(r.shared && !sharedFailed && (!sharedDeferred || (
        r.shared.bytesReceived > 0
        || r.shared.completedPhases > 0
        || r.shared.emptyResponses > 0
        || r.shared.insertedMetaTriples > 0
        || r.shared.insertedDataTriples > 0
      )));
      // Readiness is a per-plane, per-peer proof. Keep aggregate failures in
      // diagnostics, but do not let a stale/denied peer erase the completed
      // snapshot delivered by another peer. Requiring the inserts and clean
      // completion to belong to the same result also preserves the protection
      // against promoting a partially inserted, subsequently timed-out round.
      // A plane deferred by local admission pressure did not complete, so it
      // cannot stand as readiness evidence either.
      const durableCompletedCleanly = durableProgress.completedReadinessCleanly;
      const sharedMemoryCompletedCleanly = r.shared != null
        && r.shared.insertedDataTriples > 0
        && Boolean(sharedProgress?.completedWithoutFailure);
      if (durableCompletedCleanly) {
        cleanDurableDataSynced += r.durable.insertedDataTriples;
        cleanDurablePrivateOnlyCompletions +=
          durableProgress.hasVerifiedPrivateOnlyResponse ? 1 : 0;
      }
      if (sharedMemoryCompletedCleanly) {
        cleanSharedMemoryDataSynced += r.shared!.insertedDataTriples;
      }
      if (durableResponded || sharedResponded) {
        peersResponded.add(remotePeerId);
      }
      if (
        !durableFailed &&
        !sharedFailed &&
        !durablePhaseFailed &&
        !sharedPhaseFailed &&
        !peerDeniedRound &&
        // Mirrors `catchupPeerSucceeded` in the CLI runner exactly, so the
        // inline and worker-backed catch-up paths classify a peer identically.
        !peerDeferred &&
        !peerTimedOut &&
        !durableProgress.integrityRejected &&
        (peerMadeProgress || !peerMetadataOnly)
      ) {
        peersSucceeded.add(remotePeerId);
      }
      dataSynced += r.durable.insertedDataTriples;
      diagnostics.durable.fetchedMetaTriples += r.durable.fetchedMetaTriples;
      diagnostics.durable.fetchedDataTriples += r.durable.fetchedDataTriples;
      diagnostics.durable.insertedMetaTriples += r.durable.insertedMetaTriples;
      diagnostics.durable.insertedDataTriples += r.durable.insertedDataTriples;
      diagnostics.durable.bytesReceived += r.durable.bytesReceived;
      diagnostics.durable.resumedPhases += r.durable.resumedPhases;
      diagnostics.durable.timedOutPhases += r.durable.timedOutPhases;
      diagnostics.durable.completedPhases += r.durable.completedPhases;
      diagnostics.durable.checkpointAdvances += r.durable.checkpointAdvances;
      diagnostics.durable.emptyResponses += r.durable.emptyResponses;
      diagnostics.durable.metaOnlyResponses += r.durable.metaOnlyResponses;
      diagnostics.durable.verifiedPrivateOnlyResponses +=
        r.durable.verifiedPrivateOnlyResponses;
      diagnostics.durable.dataRejectedMissingMeta += r.durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += r.durable.rejectedKcs;
      diagnostics.durable.failedPeers += r.durable.failedPeers;
      diagnostics.durable.failedPhases += r.durable.failedPhases ?? 0;
      diagnostics.durable.deferredBackpressure = (diagnostics.durable.deferredBackpressure ?? 0)
        + (r.durable.deferredBackpressure ?? 0);
      deferredBackpressure += r.durable.deferredBackpressure ?? 0;
      let peerDenied = durableProgress.denied;
      if (r.shared) {
        sharedMemorySynced += r.shared.insertedDataTriples;
        // The #2050 signals. Without these the in-agent walk silently drops the
        // only per-graph SWM coverage the plane has ever produced, and a job run
        // through the inline runner reports a shortfall it cannot name — while
        // the worker-backed runner reports it fully. Coverage is SELECTED, never
        // summed: independent maxima over resolved and total would combine a peer
        // reporting 178/250 with one reporting 200/200 into 200/250, a state no
        // peer described.
        if (r.shared.swmCoverage) {
          diagnostics.sharedMemory.swmCoverage = selectSwmSnapshotCoverage(
            diagnostics.sharedMemory.swmCoverage,
            r.shared.swmCoverage,
          );
        }
        diagnostics.sharedMemory.snapshotPlaneIncomplete =
          (diagnostics.sharedMemory.snapshotPlaneIncomplete ?? 0)
          + (r.shared.snapshotPlaneIncomplete ?? 0);
        diagnostics.sharedMemory.replayPhaseBytesReceived =
          (diagnostics.sharedMemory.replayPhaseBytesReceived ?? 0)
          + (r.shared.replayPhaseBytesReceived ?? 0);
        diagnostics.sharedMemory.snapshotPhaseBytesReceived =
          (diagnostics.sharedMemory.snapshotPhaseBytesReceived ?? 0)
          + (r.shared.snapshotPhaseBytesReceived ?? 0);
        diagnostics.sharedMemory.fetchedMetaTriples += r.shared.fetchedMetaTriples;
        diagnostics.sharedMemory.fetchedDataTriples += r.shared.fetchedDataTriples;
        diagnostics.sharedMemory.insertedMetaTriples += r.shared.insertedMetaTriples;
        diagnostics.sharedMemory.insertedDataTriples += r.shared.insertedDataTriples;
        diagnostics.sharedMemory.bytesReceived += r.shared.bytesReceived;
        diagnostics.sharedMemory.resumedPhases += r.shared.resumedPhases;
        diagnostics.sharedMemory.timedOutPhases += r.shared.timedOutPhases;
        diagnostics.sharedMemory.completedPhases += r.shared.completedPhases;
        diagnostics.sharedMemory.checkpointAdvances += r.shared.checkpointAdvances;
        diagnostics.sharedMemory.emptyResponses += r.shared.emptyResponses;
        diagnostics.sharedMemory.droppedDataTriples += r.shared.droppedDataTriples;
        diagnostics.sharedMemory.failedPeers += r.shared.failedPeers;
        diagnostics.sharedMemory.failedPhases += r.shared.failedPhases ?? 0;
        diagnostics.sharedMemory.deferredBackpressure = (diagnostics.sharedMemory.deferredBackpressure ?? 0)
          + (r.shared.deferredBackpressure ?? 0);
        deferredBackpressure += r.shared.deferredBackpressure ?? 0;
        peerDenied = peerDenied || Boolean(sharedProgress?.denied);
      }
      if (peerDenied) accessDeniedPeers.add(remotePeerId);
    }

    const accumulateContinuationShared = (
      remotePeerId: string,
      shared: SharedMemorySyncResult,
    ): void => {
      const progress = classifyDurableProgress(shared);
      if (progress.completedWithoutFailure) {
        cleanSharedMemoryPeerIds.add(remotePeerId);
      }
      passTracker.recordPeerRound(
        remotePeerId,
        shared.swmCoverage,
        progress.completedWithoutFailure,
      );

      sharedMemorySynced += shared.insertedDataTriples;
      if (shared.swmCoverage) {
        diagnostics.sharedMemory.swmCoverage = selectSwmSnapshotCoverage(
          diagnostics.sharedMemory.swmCoverage,
          shared.swmCoverage,
        );
      }
      diagnostics.sharedMemory.snapshotPlaneIncomplete =
        (diagnostics.sharedMemory.snapshotPlaneIncomplete ?? 0)
        + (shared.snapshotPlaneIncomplete ?? 0);
      diagnostics.sharedMemory.replayPhaseBytesReceived =
        (diagnostics.sharedMemory.replayPhaseBytesReceived ?? 0)
        + (shared.replayPhaseBytesReceived ?? 0);
      diagnostics.sharedMemory.snapshotPhaseBytesReceived =
        (diagnostics.sharedMemory.snapshotPhaseBytesReceived ?? 0)
        + (shared.snapshotPhaseBytesReceived ?? 0);
      diagnostics.sharedMemory.fetchedMetaTriples += shared.fetchedMetaTriples;
      diagnostics.sharedMemory.fetchedDataTriples += shared.fetchedDataTriples;
      diagnostics.sharedMemory.insertedMetaTriples += shared.insertedMetaTriples;
      diagnostics.sharedMemory.insertedDataTriples += shared.insertedDataTriples;
      diagnostics.sharedMemory.bytesReceived += shared.bytesReceived;
      diagnostics.sharedMemory.resumedPhases += shared.resumedPhases;
      diagnostics.sharedMemory.timedOutPhases += shared.timedOutPhases;
      diagnostics.sharedMemory.completedPhases += shared.completedPhases;
      diagnostics.sharedMemory.checkpointAdvances += shared.checkpointAdvances;
      diagnostics.sharedMemory.emptyResponses += shared.emptyResponses;
      diagnostics.sharedMemory.droppedDataTriples += shared.droppedDataTriples;
      diagnostics.sharedMemory.failedPeers += shared.failedPeers;
      diagnostics.sharedMemory.failedPhases += shared.failedPhases ?? 0;
      diagnostics.sharedMemory.deferredBackpressure =
        (diagnostics.sharedMemory.deferredBackpressure ?? 0)
        + (shared.deferredBackpressure ?? 0);
      deferredBackpressure += shared.deferredBackpressure ?? 0;

      const responded = !progress.transportFailed
        && (!progress.deferredByBackpressure || (
          shared.bytesReceived > 0
          || shared.completedPhases > 0
          || shared.emptyResponses > 0
          || shared.insertedMetaTriples > 0
          || shared.insertedDataTriples > 0
        ));
      if (responded) peersResponded.add(remotePeerId);
      if (
        !progress.transportFailed
        && !progress.phaseFailed
        && !progress.denied
        && !progress.deferredByBackpressure
        && !progress.timedOut
        && !progress.integrityRejected
        && (progress.madeReadinessProgress || !progress.hasMetadataEvidence)
      ) {
        peersSucceeded.add(remotePeerId);
      }
      if (progress.denied) accessDeniedPeers.add(remotePeerId);

      if (shared.insertedDataTriples > 0 && progress.completedWithoutFailure) {
        cleanSharedMemoryDataSynced += shared.insertedDataTriples;
      }
    };

    if (includeSharedMemory) {
      const passConfig = stats?.swmCatchupPassConfig ?? resolveSwmCatchupPassConfig();
      const execution = await runSwmCatchupContinuations({
        units: [{
          key: contextGraphId,
          tracker: passTracker,
          planeProven: () => cleanSharedMemoryDataSynced > 0,
        }],
        config: passConfig,
        nowMs: catchupPassNowMs,
        onStop: (stop) => {
          diagnostics.sharedMemory.continuationStopReason = stop.reason;
          this.log.info(
            ctx,
            `Catch-up SWM pass loop for "${contextGraphId}" stopped after `
            + `${1 + stop.continuationPasses} pass(es): ${stop.reason}`,
          );
        },
        runPass: async ([candidate], deadlineMs) => {
          if (!candidate) return;
          await candidate.runStarted(async (pass) => {
            const mode = stats?.mode ?? 'background';
            const continuationResults = await mapWithConcurrency(
              pass.peers,
              CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
              async (remotePeerId) => {
                if (catchupPassNowMs() >= deadlineMs) return null;
                attemptedPeers.add(remotePeerId);
                const shared = await runCatchupPlaneWithPolicy(
                  mode,
                  ({ priority, source }) => this.syncSharedMemoryFromPeerDetailed(
                    remotePeerId,
                    [contextGraphId],
                    { ...(priority === undefined ? {} : { priority }), source },
                  ).catch(emptyShared),
                  { sourceOverride: stats?.sourceOverride },
                );
                return { remotePeerId, shared };
              },
            );
            for (const result of continuationResults) {
              if (result) accumulateContinuationShared(result.remotePeerId, result.shared);
            }
            this.log.info(
              ctx,
              `Catch-up SWM pass ${1 + pass.continuationPass} for `
              + `"${contextGraphId}": ${pass.peers.length} capable peer(s), progress `
              + `${pass.progressBefore} -> ${pass.progress()} resolved summed across peers`,
            );
          });
        },
      });
      diagnostics.sharedMemory.continuationPasses = execution.continuationPasses;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;
    peersTried = attemptedPeers.size;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers.size} deferred=${deferredBackpressure}`,
    );

    await this.refreshMetaSyncedFlags([contextGraphId]);

    // Insert counts prove that a plane made partial progress, not that its
    // snapshot completed. A timeout/failure can arrive after inserting an
    // early page; promoting readiness from that count poisons the persisted
    // subscription flags and suppresses the next restart/bootstrap attempt.
    // The per-peer clean-completion proof above already excludes planes that
    // were deferred by local admission pressure, so a deferred peer cannot
    // promote readiness — and cannot erase a clean snapshot another peer did
    // deliver.
    const durableCompletedCleanly =
      cleanDurableDataSynced > 0 || cleanDurablePrivateOnlyCompletions > 0;
    const sharedMemoryCompletedCleanly = cleanSharedMemoryDataSynced > 0;
    if (durableCompletedCleanly || sharedMemoryCompletedCleanly) {
      this.markContextGraphSubscriptionState(contextGraphId, {
        // `synced` is the overall graph-readiness bit. A clean SWM-only
        // recovery is still a successful graph proof; the plane-specific bit
        // below records whether that proof included shared memory.
        synced: true,
        ...(sharedMemoryCompletedCleanly ? { sharedMemorySynced: true } : {}),
      });
      this.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        dataSynced: cleanDurableDataSynced,
        sharedMemorySynced: cleanSharedMemoryDataSynced,
        verifiedPrivateOnlyResponses: cleanDurablePrivateOnlyCompletions,
      });
    }

    return {
      connectedPeers: stats?.totalPeers ?? peers.length,
      totalPeers: stats?.totalPeers ?? peers.length,
      selectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      peersResponded: peersResponded.size,
      peersSucceeded: peersSucceeded.size,
      deferredBackpressure,
      dataSynced,
      sharedMemorySynced,
      sharedMemoryCompletedCleanly,
      cleanSharedMemoryPeerIds: Object.freeze([...cleanSharedMemoryPeerIds]),
      denied: accessDeniedPeers.size > 0,
      deniedPeers: accessDeniedPeers.size,
      diagnostics,
    };
  }

  async primeCatchupConnections(this: DKGAgent): Promise<void> {
    const ctx = createOperationContext('sync');
    await primeCatchupConnectionsAtom(
      this.node.libp2p as any,
      this.discovery,
      this.peerId,
      async (peerId) => {
        await this.networkAdmissionCoordinator.ensureAdmitted(peerId, ctx);
      },
    );
  }

  /**
   * Pull `_meta` (and SWM) for a CG immediately after receiving a curator
   * `join-approved` notification, targeting the curator peer directly.
   *
   * Fixes the ~107s window where a freshly-approved curated CG sat
   * unsynced because the previous post-approval call
   * (`syncContextGraphFromConnectedPeers(...).catch(() => {})`):
   *
   *   1. Swallowed every failure mode — including the case where the
   *      regular peer-ranking heuristics produced zero sync attempts
   *      because no other peer announced the CG yet (the freshly-
   *      approved-but-no-meta-yet window). The next sync attempt only
   *      came from the periodic catchup reconciler ~2 min later.
   *
   *   2. Re-walked the full `selectCatchupPeers` ranking even though
   *      we already knew exactly who to ask: the curator peer that
   *      just sent us the approval. Skipping that walk gets us to a
   *      sync attempt within ~1s of approval.
   *
   * Falls back to the standard broadcast catchup if the curator-direct
   * attempt yields zero successful peers — defensive for the case
   * where the inbound notification connection was a one-shot relay
   * that won't re-open for catchup, or the curator process happened
   * to die between sending the approval and the catchup dial.
   */
  async runImmediatePostApprovalSync(this: DKGAgent,
    contextGraphId: string,
    curatorPeerId: string,
  ): Promise<void> {
    const ctx = createOperationContext('sync');
    const curatorShort = curatorPeerId.slice(-8);
    let curatorTargetSucceeded = false;
    const approvedAgentAddress = this.localApprovedAgentByCG.get(contextGraphId);
    if (!approvedAgentAddress) {
      throw new Error(
        `Post-approval sync for "${contextGraphId}" has no approved local agent binding`,
      );
    }
    let expectedDelegateeOpKey: string | undefined;
    try {
      expectedDelegateeOpKey = await inferAdapterPublisherAddress(this.chain);
    } catch {
      // The signed join flow always binds the current libp2p peer, so an
      // adapter that cannot expose its op-key still has a usable proof.
    }
    const curatorMetaRefreshOptions = {
      trustedCuratorPeerId: curatorPeerId,
      force: true,
      memberProof: {
        approvedAgentAddress,
        expectedDelegateePeerId: this.peerId,
        expectedDelegateeOpKey,
      },
    } as const;

    // Curator-direct attempt. Any throw here (relay reservation gone,
    // dial timeout, AbortSignal, transient `Remote closed connection
    // during opening`) MUST fall through to the broadcast fallback
    // below — wrapping both the curator-direct attempt AND the
    // broadcast in a single try/catch reintroduces the silent-stall
    // bug this method exists to fix (Lex review on PR #517 + Codex).
    try {
      if (!(await this.networkAdmissionCoordinator.ensureAdmitted(curatorPeerId, ctx))) {
        this.log.warn(
          ctx,
          `Post-approval sync for "${contextGraphId}": curator ${curatorShort} failed network admission; falling back to broadcast catchup`,
        );
      } else {
        await this.ensurePeerConnected(curatorPeerId);
        const curatorRemote = this.node.libp2p
          .getConnections()
          .find((conn) => conn.remotePeer.toString() === curatorPeerId)?.remotePeer;
        if (curatorRemote) {
          // The regular durable-sync pipeline only persists Merkle-verified KA
          // metadata. Private-CG access-control/definition triples are trusted
          // control-plane metadata and intentionally have no KA Merkle root,
          // so sending them through that pipeline drops them. Pull `_meta`
          // through the dedicated curator path first and persist it verbatim.
          // The peer override is safe here because the join-approved handler
          // authenticated this exact notification sender for this CG before
          // scheduling this method.
          await this.refreshMetaFromCurator(contextGraphId, curatorMetaRefreshOptions);
          let includeSharedMemory = true;
          let totalDataSynced = 0;
          let totalSharedMemorySynced = 0;
          for (let round = 1; round <= MAX_POST_APPROVAL_CURATOR_SYNC_ROUNDS; round += 1) {
            const result = await this.runCatchupOverPeers(
              contextGraphId,
              includeSharedMemory,
              [curatorRemote],
            );
            totalDataSynced += result.dataSynced;
            totalSharedMemorySynced += result.sharedMemorySynced;
            // An insert count only proves partial progress: the SWM requester
            // may have stored early pages before timing out. Stop requesting
            // SWM only after this curator completed the plane cleanly; until
            // then a durable-only success must not suppress SWM bootstrap.
            if (result.sharedMemoryCompletedCleanly) includeSharedMemory = false;

            // A transient first meta read must not turn a successful payload/SWM
            // transfer into a false-ready subscription. Retry once after each
            // catchup round and require a live metadata proof before declaring
            // the curator-targeted bootstrap complete.
            let hasAuthoritativeMeta = await this.hasConfirmedMetaState(contextGraphId)
              .catch(() => false);
            if (!hasAuthoritativeMeta) {
              await this.refreshMetaFromCurator(contextGraphId, curatorMetaRefreshOptions);
              hasAuthoritativeMeta = await this.hasConfirmedMetaState(contextGraphId)
                .catch(() => false);
            }
            if (hasAuthoritativeMeta) {
              await this.refreshMetaSyncedFlags([contextGraphId]);
            }
            if (result.peersSucceeded > 0 && hasAuthoritativeMeta) {
              this.log.info(
                ctx,
                `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} fetched ${totalDataSynced} data + ${totalSharedMemorySynced} SWM triples in ${round} round(s)`,
              );
              curatorTargetSucceeded = true;
              break;
            }

            const madeVerifiedProgress = result.dataSynced > 0 || result.sharedMemorySynced > 0;
            if (
              result.denied
              || !hasAuthoritativeMeta
              || !madeVerifiedProgress
              || round === MAX_POST_APPROVAL_CURATOR_SYNC_ROUNDS
            ) {
              if (result.peersSucceeded === 0) {
                this.log.warn(
                  ctx,
                  `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} produced no successful peer (denied=${result.denied}, progress=${madeVerifiedProgress}, round=${round}); falling back to broadcast catchup`,
                );
              } else {
                this.log.warn(
                  ctx,
                  `Post-approval sync for "${contextGraphId}" transferred payload from curator ${curatorShort} but authoritative metadata is still absent; falling back to broadcast catchup`,
                );
              }
              break;
            }

            this.log.info(
              ctx,
              `Post-approval sync for "${contextGraphId}" made verified partial progress from curator ${curatorShort} `
                + `(data=${result.dataSynced}, SWM=${result.sharedMemorySynced}, round=${round}); retrying curator directly`,
            );
          }
        } else {
          this.log.warn(
            ctx,
            `Post-approval sync for "${contextGraphId}": curator ${curatorShort} not in connected peers after ensurePeerConnected; falling back to broadcast catchup`,
          );
        }
      }
    } catch (err) {
      this.log.warn(
        ctx,
        `Post-approval sync for "${contextGraphId}": curator-direct attempt to ${curatorShort} failed (${err instanceof Error ? err.message : String(err)}); falling back to broadcast catchup`,
      );
    }

    if (!curatorTargetSucceeded) {
      try {
        await this.syncContextGraphFromConnectedPeers(contextGraphId, { includeSharedMemory: true });
      } catch (err) {
        this.log.warn(
          ctx,
          `Post-approval broadcast fallback for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Resume only the authenticated metadata bootstrap for a durable
   * `join-approved` row recovered after restart.
   *
   * The durable approval identifies both the local agent and the curator peer,
   * so it may authorize this exact control-plane metadata fetch. It does not
   * authorize VM, payload, plaintext-recovery, or SWM activation. Those lanes
   * are installed only after the fetched metadata (or the registered chain
   * roster) makes the ordinary read-authority resolver return `allowed`.
   */
  async resumePendingJoinApprovalMetadata(this: DKGAgent,
    contextGraphId: string,
    curatorPeerId: string,
  ): Promise<void> {
    const ctx = createOperationContext('sync');
    const approvedAgentAddress = this.localApprovedAgentByCG.get(contextGraphId);
    if (!approvedAgentAddress) return;

    let expectedDelegateeOpKey: string | undefined;
    try {
      expectedDelegateeOpKey = await inferAdapterPublisherAddress(this.chain);
    } catch {
      // The durable approval always binds the current libp2p peer. An adapter
      // without an observable operational key still has a usable proof.
    }
    const refreshed = await this.refreshMetaFromCurator(contextGraphId, {
      trustedCuratorPeerId: curatorPeerId,
      force: true,
      memberProof: {
        approvedAgentAddress,
        expectedDelegateePeerId: this.peerId,
        expectedDelegateeOpKey,
      },
    }).catch((error) => {
      this.log.warn(
        ctx,
        `Pending join-approval metadata recovery for "${contextGraphId}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    });
    if (!refreshed || !(await this.hasConfirmedMetaState(contextGraphId).catch(() => false))) {
      this.log.warn(
        ctx,
        `Pending join-approval metadata recovery for "${contextGraphId}" did not establish authoritative metadata; keeping data lanes closed`,
      );
      return;
    }

    const authority = await this.resolveContextGraphReadAuthority(contextGraphId, {
      allowSubscriptionFallback: false,
    }).catch(() => ({ outcome: 'unavailable' as const }));
    if (authority.outcome !== 'allowed') {
      this.log.warn(
        ctx,
        `Pending join-approval metadata recovery for "${contextGraphId}" completed but current read authority is ${authority.outcome}; keeping data lanes closed`,
      );
      return;
    }

    await this.refreshMetaSyncedFlags([contextGraphId]);
    const current = this.subscribedContextGraphs.get(contextGraphId);
    if (!current?.subscribed) return;
    this.subscribeToContextGraph(contextGraphId, {
      persist: false,
      syncMode: current.syncMode,
    });
    this.persistLocalNodeMembership(contextGraphId, 'rehydrated-subscription');
    await this.runImmediatePostApprovalSync(contextGraphId, curatorPeerId);
  }

  selectCatchupPeers(this: DKGAgent,
    peers: Array<{ toString(): string }>,
    preferredPeerId?: string,
    privateOnly = false,
  ): Array<{ toString(): string }> {
    return orderCatchupPeers(peers, preferredPeerId, privateOnly, this.knownCorePeerIds);
  }

  /**
   * Resolve the catch-up sync peer ONCE, with both notions the walk needs.
   *
   * They are one resolution, not two: ranking takes the best peer available
   * whatever its provenance, while letting one peer's answer stand for the
   * whole graph requires a metadata-resolved curator. The authenticated
   * join-approval hint ranks but never settles — it can be stale, since a
   * curator that rotated its libp2p key leaves an ordinary member sitting on
   * the id it names.
   *
   * Deriving that distinction from two calls would read `_meta` twice (and run
   * the registry fallback twice for a wallet-address curator) per catch-up, and
   * would hide that the resolver has a side effect — it evicts the bootstrap
   * hint once metadata confirms a curator, so the second call is not the same
   * call as the first.
   */
  async resolveSyncPeerWithProvenance(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<SyncPeerResolution> {
    return resolveCuratorSyncPeer(this, this.preferredSyncPeers, contextGraphId);
  }

  async resolvePreferredSyncPeerId(this: DKGAgent, contextGraphId: string): Promise<string | undefined> {
    // Deliberately NOT routed through the sibling method: each of these is one
    // resolution on its own, and going through `this` would make them
    // unusable against the hand-built receivers several suites call them on.
    return (await resolveCuratorSyncPeer(this, this.preferredSyncPeers, contextGraphId)).peerId;
  }

  /**
   * The sync peer ONLY when it is a metadata-resolved curator.
   *
   * Provenance comes from {@link resolveCuratorSyncPeer} itself. Deriving it
   * here — by comparing the resolved id against the hint — would be wrong in
   * the ordinary case, where the join approval came from the curator and both
   * routes name the SAME peer.
   */
  async resolveAuthoritativeSyncPeerId(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<string | undefined> {
    return authoritativeSyncPeerId(
      await resolveCuratorSyncPeer(this, this.preferredSyncPeers, contextGraphId),
    );
  }

  async ensurePeerConnected(
    this: DKGAgent,
    peerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await ensurePeerConnectedAtom(this.peerResolver, peerId, options);
    if (await this.networkAdmissionCoordinator.ensureAdmitted(
      peerId,
      createOperationContext('connect'),
      options,
    )) return;
    throw new NetworkAdmissionRejectedError(peerId);
  }

  async waitForSyncProtocol(
    this: DKGAgent,
    pid: { toString(): string },
    signal?: AbortSignal,
  ): Promise<boolean> {
    return waitForPeerProtocol(
      this.node.libp2p.peerStore as any,
      pid,
      PROTOCOL_SYNC,
      SYNC_PROTOCOL_CHECK_ATTEMPTS,
      SYNC_PROTOCOL_CHECK_DELAY_MS,
      signal,
    );
  }

  async refreshMetaSyncedFlags(this: DKGAgent, contextGraphIds: Iterable<string>): Promise<void> {
    for (const contextGraphId of contextGraphIds) {
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      if (!sub) continue;
      if (await this.hasConfirmedMetaState(contextGraphId)) {
        // A late private-CG member may never have observed the one-shot public
        // registry announcement that normally supplies the numeric chain id.
        // The authenticated curator snapshot carries that immutable binding in
        // the CG's exact top-level `_meta` graph. Once the full private
        // definition has passed `hasConfirmedMetaState`, bind and persist it as
        // part of the same readiness transition. This also makes a completed
        // catch-up restart-safe instead of leaving `on_chain_id = NULL` in the
        // durable subscription row.
        const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
        const metaGraph = contextGraphMetaGraphUri(contextGraphId);
        const onChainIdPredicate = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
        const onChainHashPredicate = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`;
        const registrationResult = await this.store.query(
          `
            SELECT ?predicate ?value WHERE {
              GRAPH <${metaGraph}> {
                <${contextGraphUri}> ?predicate ?value .
                VALUES ?predicate {
                  <${onChainIdPredicate}>
                  <${onChainHashPredicate}>
                }
              }
            }
          `,
          { source: 'agent.durableSync.registrationBinding' },
        );
        let confirmedOnChainId: string | undefined;
        let confirmedOnChainHash: string | undefined;
        if (registrationResult.type === 'bindings') {
          for (const row of registrationResult.bindings) {
            const predicate = row['predicate'];
            const value = stripLiteral(row['value'] ?? '');
            if (predicate === onChainIdPredicate && /^\d+$/.test(value)) {
              try {
                if (BigInt(value) > 0n) confirmedOnChainId = value;
              } catch {
                // Ignore malformed or out-of-domain metadata fail-closed.
              }
            } else if (
              predicate === onChainHashPredicate
              && /^0x[0-9a-fA-F]{64}$/.test(value)
            ) {
              confirmedOnChainHash = value.toLowerCase();
            }
          }
        }

        let current = this.subscribedContextGraphs.get(contextGraphId) ?? sub;
        let registrationChanged = false;
        let nextOnChainHash = current.onChainHash;
        if (confirmedOnChainId && current.onChainId !== confirmedOnChainId) {
          this.bindSubscriptionOnChainId(contextGraphId, current, confirmedOnChainId);
          registrationChanged = true;
        }
        if (
          confirmedOnChainHash
          && current.onChainHash?.toLowerCase() !== confirmedOnChainHash
        ) {
          nextOnChainHash = confirmedOnChainHash;
          registrationChanged = true;
        }
        if (registrationChanged) {
          this.setContextGraphSubscription(contextGraphId, {
            ...current,
            onChainHash: nextOnChainHash,
          });
          current = this.subscribedContextGraphs.get(contextGraphId) ?? current;
        }

        if (current.metaSynced !== true) {
          this.setContextGraphSubscription(contextGraphId, { ...current, metaSynced: true });
        }
        current = this.subscribedContextGraphs.get(contextGraphId) ?? current;
        if (current.pendingMeta) {
          // Meta arrived; the freshly-joined "waiting for sync" state
          // (set by the join-approved handler) no longer applies — the
          // CG will now surface via the normal `_meta` branch in
          // `listContextGraphs`.
          this.setContextGraphSubscription(contextGraphId, {
            ...current,
            metaSynced: true,
            pendingMeta: false,
          });
        }
        // Private responsibility depends on the live ACL projection, not only
        // on subscription fields. A curator refresh can add/remove the local
        // agent while `metaSynced`, `subscribed`, and the chain binding all stay
        // unchanged, so the canonical setter has no transition to observe.
        // Reconcile after the authoritative metadata proof itself and await the
        // result so callers leave this readiness boundary with a settled
        // default RFC-64 selection.
        await this.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
    }
  }

  setContextGraphSubscription(this: DKGAgent,
    contextGraphId: string,
    next: ContextGraphSubInput,
    options?: { persist?: boolean; updateRehydrationStatus?: boolean },
  ): ContextGraphSub {
    this.invalidateListContextGraphsCache();
    const previous = this.subscribedContextGraphs.get(contextGraphId);
    // A local id is always cleartext unless the subscription explicitly says
    // otherwise through `onChainHash`. This distinction matters for a valid
    // user-chosen id that happens to match the 0x+64-hex wire-id shape.
    const localWireId = this.contextGraphNameCommitment(contextGraphId);
    const wireOnlySubscription =
      this.resolveWireOnlyContextGraphSubscription(contextGraphId);
    const explicitNextWireId = next.onChainHash === undefined
      ? undefined
      : this.contextGraphWireId(next.onChainHash);
    const adoptsWireOnlySubscription =
      wireOnlySubscription !== null
      && (explicitNextWireId === undefined || explicitNextWireId === localWireId)
      && (
        next.onChainId === undefined
        || wireOnlySubscription.subscription.onChainId === undefined
        || next.onChainId === wireOnlySubscription.subscription.onChainId
      );
    const normalizedNext = normalizeContextGraphSubscriptionTransition(previous, {
      ...next,
      ...(adoptsWireOnlySubscription && next.onChainId === undefined
        ? { onChainId: wireOnlySubscription.subscription.onChainId }
        : {}),
      ...(adoptsWireOnlySubscription && next.onChainHash === undefined
        ? { onChainHash: localWireId }
        : {}),
    });
    if (adoptsWireOnlySubscription) {
      // A private chain event reaches an Edge before its join approval and can
      // only identify the graph by the committed name hash. Once a trusted
      // local path supplies the matching cleartext id, that hash-only row is
      // an identity placeholder rather than a second graph. Retire it before
      // publishing the canonical row so its RFC-64 responsibility, binding
      // fence, and receiver lifecycle cannot remain active under the wire id.
      // Host-mode bookkeeping is already wire-keyed and therefore survives
      // this local-identity promotion without rewiring its ciphertext topic.
      this.deleteContextGraphSubscription(wireOnlySubscription.localId);
      if (this.wireIdToLocalCgId.get(localWireId) === wireOnlySubscription.localId) {
        this.wireIdToLocalCgId.delete(localWireId);
      }
      this.log.info(
        createOperationContext('system'),
        `Promoted wire-only Context Graph ${localWireId.slice(0, 18)}… to local identity "${contextGraphId}"`,
      );
    }
    const previousWireId = previous?.onChainHash
      ? this.contextGraphWireId(previous.onChainHash)
      : localWireId;
    const nextOnChainHash = normalizedNext.onChainHash
      ? this.contextGraphWireId(normalizedNext.onChainHash)
      : undefined;
    const nextWireId = nextOnChainHash ?? localWireId;
    const canonicalNext: ContextGraphSub = {
      ...normalizedNext,
      ...(normalizedNext.onChainHash === nextOnChainHash ? {} : { onChainHash: nextOnChainHash }),
    };
    const bindingFacts = this.contextGraphBindingState.applySubscriptionTransition(
      contextGraphId,
      previous,
      canonicalNext,
      nextWireId,
    );
    if (
      previousWireId !== nextWireId
      && this.wireIdToLocalCgId.get(previousWireId) === contextGraphId
    ) {
      this.wireIdToLocalCgId.delete(previousWireId);
    }
    this.subscribedContextGraphs.set(contextGraphId, canonicalNext);
    this.wireIdToLocalCgId.set(nextWireId, contextGraphId);
    const configuredRfc64Authority =
      this.config.rfc64CatalogExecutionPlan.selectedAuthority[contextGraphId];
    if (
      configuredRfc64Authority !== undefined
      && (this.config.nodeRole ?? 'edge') === 'edge'
    ) {
      // A compatibility manifest is authority material only; the ordinary
      // subscription still owns receiver activity. Preserve its immediate
      // bootstrap invalidation while release-native metadata is still being
      // acquired and the dynamic responsibility registry remains fail-closed.
      this.handleRfc64CatalogReceiverSelectionTransitionV1(
        contextGraphId,
        previous?.subscribed === true && (
          configuredRfc64Authority.track2Enabled
          || configuredRfc64Authority.legacySyncAllowed
        ),
        canonicalNext.subscribed === true && (
          configuredRfc64Authority.track2Enabled
          || configuredRfc64Authority.legacySyncAllowed
        ),
      );
    }
    if (
      previous === undefined
      || previous.subscribed !== canonicalNext.subscribed
      || previous.coreHosted !== canonicalNext.coreHosted
      || previous.onChainId !== canonicalNext.onChainId
      || previous.metaSynced !== canonicalNext.metaSynced
    ) {
      void this.reconcileRfc64CatalogResponsibilityV1(contextGraphId).catch((error) => {
        this.log.warn(
          createOperationContext('system'),
          `RFC-64 responsibility resolution failed for "${contextGraphId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    // VM cleanup policy belongs to the lifecycle consumer, not to the binding
    // registry. Invalidating a reverse candidate must also invalidate any work
    // captured against it; otherwise only an inactive subscription needs the
    // ordinary cursor cleanup.
    if (bindingFacts.reverseCandidateCleared) {
      this.forceClearVmReconcileStateForContextGraph(contextGraphId);
    } else if (!bindingFacts.admitted) {
      this.clearVmReconcileStateForContextGraph(contextGraphId);
    }
    // On-demand member subscriptions deliberately keep their live state and
    // readiness process-local. A Core's independent hosting obligation is
    // still durable, though: persistContextGraphSubscription writes a
    // host-only snapshot without converting the member intent to always-on.
    const persistence = projectContextGraphSubscriptionPersistence({
      contextGraphId,
      subscription: canonicalNext,
      syncScoped: (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    });
    if (options?.persist !== false && persistence.action !== 'skip') {
      if (this.config.contextGraphSubscriptionStore) {
        const revision = this.nextContextGraphSubscriptionPersistRevision(contextGraphId);
        this.persistContextGraphSubscription(
          contextGraphId,
          {
            revision,
            updateRehydrationStatus: options?.updateRehydrationStatus !== false,
          },
        );
      }
      if (persistence.persistMemberIntent && canonicalNext.subscribed) {
        this.persistLocalNodeMembership(contextGraphId);
      } else if (persistence.persistMemberIntent) {
        this.deleteContextGraphMember(contextGraphId, 'node', this.peerId);
      }
    }
    return canonicalNext;
  }

  /**
   * Find the chain-created hash-only placeholder authenticated by the exact
   * commitment of a newly learned local id. A hash-shaped cleartext id is not
   * mistaken for a placeholder: the reverse index must point to the raw wire
   * key and that row must explicitly claim the same `onChainHash`.
   */
  resolveWireOnlyContextGraphSubscription(
    this: DKGAgent,
    contextGraphId: string,
  ): { localId: string; wireId: string; subscription: ContextGraphSub } | null {
    const wireId = this.contextGraphNameCommitment(contextGraphId);
    const localId = this.wireIdToLocalCgId.get(wireId);
    if (localId === undefined || localId === contextGraphId || localId !== wireId) {
      return null;
    }
    const subscription = this.subscribedContextGraphs.get(localId);
    if (
      subscription?.onChainHash === undefined
      || this.contextGraphWireId(subscription.onChainHash) !== wireId
    ) {
      return null;
    }
    return { localId, wireId, subscription };
  }

  markContextGraphSubscriptionState(this: DKGAgent, contextGraphId: string, patch: Partial<ContextGraphSub>): void {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    if (!existing) return;
    this.setContextGraphSubscription(contextGraphId, { ...existing, ...patch });
  }

  nextContextGraphSubscriptionPersistRevision(this: DKGAgent, contextGraphId: string): number {
    const revision = (this.contextGraphSubscriptionPersistRevisions.get(contextGraphId) ?? 0) + 1;
    this.contextGraphSubscriptionPersistRevisions.set(contextGraphId, revision);
    return revision;
  }

  cancelContextGraphSubscriptionPersistRevisions(this: DKGAgent, contextGraphId: string): void {
    if (!this.config.contextGraphSubscriptionStore) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return;
    }
    const revision = this.nextContextGraphSubscriptionPersistRevision(contextGraphId);
    this.contextGraphSubscriptionPersistCanceledRevisions.set(contextGraphId, revision);
  }

  claimContextGraphSubscriptionPersistRevision(this: DKGAgent, contextGraphId: string, revision?: number): boolean {
    if (revision == null) return false;
    const canceledRevision = this.contextGraphSubscriptionPersistCanceledRevisions.get(contextGraphId) ?? 0;
    if (revision <= canceledRevision) return false;
    const appliedRevision = this.contextGraphSubscriptionPersistAppliedRevisions.get(contextGraphId) ?? 0;
    if (revision <= appliedRevision) return false;
    this.contextGraphSubscriptionPersistAppliedRevisions.set(contextGraphId, revision);
    return true;
  }

  beginContextGraphSubscriptionPersistRevision(this: DKGAgent, contextGraphId: string, revision?: number): void {
    if (revision == null) return;
    let pending = this.contextGraphSubscriptionPersistPendingRevisions.get(contextGraphId);
    if (!pending) {
      pending = new Set<number>();
      this.contextGraphSubscriptionPersistPendingRevisions.set(contextGraphId, pending);
    }
    pending.add(revision);
  }

  enqueueContextGraphSubscriptionPersistWrite(
    this: DKGAgent,
    contextGraphId: string,
    write: () => Promise<void>,
  ): Promise<void> {
    const previous = this.contextGraphSubscriptionPersistChains.get(contextGraphId) ?? Promise.resolve();
    const run = previous.then(write);
    const chain = run.catch(() => undefined);
    this.contextGraphSubscriptionPersistChains.set(contextGraphId, chain);
    void chain.finally(() => {
      if (this.contextGraphSubscriptionPersistChains.get(contextGraphId) !== chain) return;
      this.contextGraphSubscriptionPersistChains.delete(contextGraphId);
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
    });
    return run;
  }

  enqueueContextGraphMembershipPersistWrite(
    this: DKGAgent,
    key: string,
    write: () => Promise<void>,
    options?: { strict?: boolean },
  ): Promise<void> {
    return this.contextGraphMembershipPersistence.enqueue(key, write, options);
  }

  finishContextGraphSubscriptionPersistRevision(this: DKGAgent, contextGraphId: string, revision?: number): void {
    if (revision == null) return;
    const pending = this.contextGraphSubscriptionPersistPendingRevisions.get(contextGraphId);
    pending?.delete(revision);
    if (pending && pending.size > 0) return;
    this.contextGraphSubscriptionPersistPendingRevisions.delete(contextGraphId);
    this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
  }

  clearContextGraphSubscriptionPersistRevisionStateIfIdle(this: DKGAgent, contextGraphId: string): void {
    if ((this.contextGraphSubscriptionPersistPendingRevisions.get(contextGraphId)?.size ?? 0) > 0) return;
    if (this.contextGraphSubscriptionPersistChains.has(contextGraphId)) return;
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (sub?.subscribed === true || sub?.coreHosted === true) return;
    if (this.contextGraphSubscriptionRehydrationAccountedIds.has(contextGraphId)) return;
    this.contextGraphSubscriptionPersistPendingRevisions.delete(contextGraphId);
    this.contextGraphSubscriptionPersistRevisions.delete(contextGraphId);
    this.contextGraphSubscriptionPersistAppliedRevisions.delete(contextGraphId);
    this.contextGraphSubscriptionPersistCanceledRevisions.delete(contextGraphId);
  }

  updateContextGraphSubscriptionRehydrationStatusAfterPersist(this: DKGAgent,
    contextGraphId: string,
    next?: Pick<ContextGraphSubscriptionRecord, 'subscribed' | 'coreHosted'>,
  ): void {
    const status = this.contextGraphSubscriptionRehydrationStatus;
    if (!status) return;
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return;

    const sortIds = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const wasDormant = this.contextGraphSubscriptionDormancyById.has(contextGraphId);
    const hostedActivatedIds = status.hostedActivatedIds ?? [];
    const wasAccounted = this.contextGraphSubscriptionRehydrationAccountedIds.has(contextGraphId);
    const isPersisted = next?.subscribed === true || next?.coreHosted === true;

    let persistedTotal = status.persistedTotal;
    let activated = status.activated;
    const dormancyById = this.contextGraphSubscriptionDormancyById;
    dormancyById.delete(contextGraphId);
    let nextHostedActivatedIds = hostedActivatedIds.filter((id) => id !== contextGraphId);
    if (next?.coreHosted === true) {
      nextHostedActivatedIds = sortIds([...nextHostedActivatedIds, contextGraphId]);
    }

    if (isPersisted) {
      if (wasDormant) {
        activated += 1;
      } else if (!wasAccounted) {
        persistedTotal += 1;
        activated += 1;
      }
      this.contextGraphSubscriptionRehydrationAccountedIds.add(contextGraphId);
    } else if (wasAccounted) {
      persistedTotal = Math.max(0, persistedTotal - 1);
      if (!wasDormant) {
        activated = Math.max(0, activated - 1);
      }
      this.contextGraphSubscriptionRehydrationAccountedIds.delete(contextGraphId);
    }

    this.contextGraphSubscriptionRehydrationStatus = {
      ...status,
      persistedTotal,
      hostedActivated: nextHostedActivatedIds.length,
      hostedActivatedIds: nextHostedActivatedIds,
      activated,
      updatedAt: Date.now(),
    };
  }

  updateContextGraphSubscriptionRehydrationStatusAfterClear(this: DKGAgent,
    clearedIds: Iterable<string>,
    deactivatedIds: Iterable<string> = [],
  ): void {
    const status = this.contextGraphSubscriptionRehydrationStatus;
    if (!status) return;
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
    const dormancyById = this.contextGraphSubscriptionDormancyById;
    const hostedActivatedIds = [...(status.hostedActivatedIds ?? [])];
    const removeFrom = (ids: string[], id: string): boolean => {
      const index = ids.indexOf(id);
      if (index < 0) return false;
      ids.splice(index, 1);
      return true;
    };
    let persistedTotal = status.persistedTotal;
    let activated = status.activated;
    const clearedSet = new Set(clearedIds);

    for (const id of clearedSet) {
      if (systemContextGraphs.has(id)) continue;
      const wasAccounted = this.contextGraphSubscriptionRehydrationAccountedIds.delete(id);
      const wasDormant = dormancyById.delete(id);
      removeFrom(hostedActivatedIds, id);
      if (!wasAccounted) continue;
      persistedTotal = Math.max(0, persistedTotal - 1);
      if (!wasDormant) {
        activated = Math.max(0, activated - 1);
      }
    }
    for (const id of new Set(deactivatedIds)) {
      if (systemContextGraphs.has(id) || clearedSet.has(id)) continue;
      if (!this.contextGraphSubscriptionRehydrationAccountedIds.has(id)) continue;
      removeFrom(hostedActivatedIds, id);
      if (!dormancyById.has(id)) {
        activated = Math.max(0, activated - 1);
      }
      dormancyById.set(id, 'deactivated');
    }

    this.contextGraphSubscriptionRehydrationStatus = {
      ...status,
      persistedTotal,
      hostedActivated: hostedActivatedIds.length,
      hostedActivatedIds,
      activated,
      updatedAt: Date.now(),
    };
    for (const id of clearedSet) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(id);
    }
  }

  deleteContextGraphSubscription(this: DKGAgent, contextGraphId: string): boolean {
    this.invalidateListContextGraphsCache();
    this.forceClearVmReconcileStateForContextGraph(contextGraphId);
    const previous = this.subscribedContextGraphs.get(contextGraphId);
    const deleted = this.subscribedContextGraphs.delete(contextGraphId);
    if (deleted) {
      const configuredRfc64Authority =
        this.config.rfc64CatalogExecutionPlan.selectedAuthority[contextGraphId];
      if (
        configuredRfc64Authority !== undefined
        && (this.config.nodeRole ?? 'edge') === 'edge'
      ) {
        this.handleRfc64CatalogReceiverSelectionTransitionV1(
          contextGraphId,
          previous?.subscribed === true && (
            configuredRfc64Authority.track2Enabled
            || configuredRfc64Authority.legacySyncAllowed
          ),
          false,
        );
      }
      void this.reconcileRfc64CatalogResponsibilityV1(contextGraphId).catch(() => undefined);
    }
    // Every in-flight binding continuation also captures the subscription
    // object, so deleting this numeric generation cannot revive old work if a
    // new subscription later reuses the same local id.
    this.contextGraphBindingState.delete(contextGraphId);
    return deleted;
  }

  /** RFC-64-owned reaction to one canonical subscription state transition. */
  handleRfc64CatalogReceiverSelectionTransitionV1(
    this: DKGAgent,
    contextGraphId: string,
    previousReceiverActive: boolean,
    nextReceiverActive: boolean,
  ): void {
    if (previousReceiverActive === nextReceiverActive) return;
    if (!nextReceiverActive) {
      this.rfc64PublicCatalogServiceV1?.deactivateReceiverContextGraph(contextGraphId);
      this.clearRfc64CatalogOperationalTargetsV1(contextGraphId);
    }
    this.invalidateRfc64PublicCatalogBootstrapPassV1(contextGraphId);
    this.queueSharedMemoryGossipSubscription(contextGraphId);
    if (nextReceiverActive && this.rfc64PublicCatalogServiceV1 !== undefined) {
      void this.requestRfc64CatalogHeadReplaysFromConnectedPeersV1(contextGraphId)
        .catch(() => undefined);
      // Re-entering the idempotent start boundary also dirties an existing
      // failed repair for this newly active CG, including retryIntervalMs=0.
      this.startRfc64SwmCatalogProjectionSupervisorV1(
        createOperationContext('system'),
      );
    }
  }

  persistContextGraphSubscriptionState(this: DKGAgent, contextGraphId: string): Promise<void> {
    if (!this.config.contextGraphSubscriptionStore) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return Promise.resolve();
    }
    return this.persistContextGraphSubscription(contextGraphId, {
      revision: this.nextContextGraphSubscriptionPersistRevision(contextGraphId),
      updateRehydrationStatus: false,
    });
  }

  persistContextGraphSubscription(this: DKGAgent,
    contextGraphId: string,
    options?: {
      revision?: number;
      updateRehydrationStatus?: boolean;
    },
  ): Promise<void> {
    this.invalidateListContextGraphsCache();
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return Promise.resolve();
    }
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    const persistence = projectContextGraphSubscriptionPersistence({
      contextGraphId,
      subscription: sub,
      syncScoped: (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    });
    if (persistence.action === 'skip') {
      // Some lifecycle paths persist reconciliation watermarks directly
      // instead of going through setContextGraphSubscription. Preserve the
      // process-local lifetime at this lowest shared write boundary too.
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return Promise.resolve();
    }
    // Persist member subscriptions AND (Phase D) public CGs this Core hosts —
    // the host-only record MUST survive restart so a Core that was offline
    // during a publish remembers it hosts the CG and fills its gap. Drop the
    // row only when the node neither subscribes to nor hosts the CG.
    this.beginContextGraphSubscriptionPersistRevision(contextGraphId, options?.revision);
    if (persistence.action === 'delete') {
      return this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, () => store.delete(contextGraphId))
        .then(() => {
          if (
            options?.updateRehydrationStatus === true &&
            this.claimContextGraphSubscriptionPersistRevision(contextGraphId, options.revision)
          ) {
            this.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, undefined);
          }
        })
        .catch((err) => {
          this.log.warn(
            createOperationContext('system'),
            `Failed to delete persisted context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.finishContextGraphSubscriptionPersistRevision(contextGraphId, options?.revision);
        });
    }
    const record = persistence.record;
    return this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, () => store.save(record))
      .then(() => {
        if (
          options?.updateRehydrationStatus === true &&
          this.claimContextGraphSubscriptionPersistRevision(contextGraphId, options.revision)
        ) {
          this.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, record);
        }
      }).catch((err) => {
        this.log.warn(
          createOperationContext('system'),
          `Failed to persist context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }).finally(() => {
        this.finishContextGraphSubscriptionPersistRevision(contextGraphId, options?.revision);
      });
  }

  async persistContextGraphSubscriptionStrict(this: DKGAgent,
    contextGraphId: string,
    subscription?: ContextGraphSub,
    syncScoped?: boolean,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) {
      // The library API has always allowed storeless agents. "Strict" means a
      // configured store failure is surfaced and retried before ACK; absence
      // retains the backward-compatible in-memory approval path.
      return;
    }
    const expectedLiveSub = this.subscribedContextGraphs.get(contextGraphId);
    const expectedBindingGeneration = this.contextGraphBindingState.capture(contextGraphId);
    const sub = subscription ?? expectedLiveSub;
    if (!sub?.subscribed && !sub?.coreHosted) {
      throw new Error(
        `Cannot persist context graph "${contextGraphId}": active subscription or host state is missing`,
      );
    }
    const persistence = projectContextGraphSubscriptionPersistence({
      contextGraphId,
      subscription: sub,
      syncScoped: syncScoped ?? (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    });
    if (persistence.action !== 'save' || !persistence.persistMemberIntent) {
      throw new Error(
        `Cannot acknowledge join approval for "${contextGraphId}": durable subscription intent is missing`,
      );
    }
    const record = persistence.record;
    // Queue behind any fire-and-forget writes scheduled by subscribe/mark so
    // this final authoritative snapshot is the last write before the ACK.
    await this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, async () => {
      const current = this.subscribedContextGraphs.get(contextGraphId);
      if (
        !isCurrent()
        ||
        current !== expectedLiveSub
        || (!current?.subscribed && !current?.coreHosted)
        || !this.contextGraphBindingState.isGenerationCurrent(
          contextGraphId,
          expectedBindingGeneration,
        )
      ) {
        throw asSyncFetchAbortError(new Error(
          `Context graph "${contextGraphId}" changed before its strict subscription snapshot was persisted`,
        ));
      }
      await store.save(record);
    });
  }

  /**
   * Persist the two durable halves of a requester-side join approval.
   *
   * Membership and subscription stores are deliberately separate extension
   * interfaces and cannot share a database transaction. Snapshot the affected
   * rows before writing and compensate in reverse order when either write
   * fails. Storeless agents retain the historical in-memory path; a configured
   * store failure escapes so Messenger leaves the notification retryable.
   */
  async persistJoinApprovalStateStrict(this: DKGAgent,
    contextGraphId: string,
    membership: ContextGraphMembershipRecord,
    subscription: ContextGraphSub,
  ): Promise<void> {
    const membershipStore = this.config.contextGraphMembershipStore;
    const subscriptionStore = this.config.contextGraphSubscriptionStore;
    const normalizedPrincipalId = this.normalizeMembershipPrincipal(
      membership.principalType,
      membership.principalId,
    );
    const membershipKey = `${contextGraphId}\0${membership.principalType}\0${normalizedPrincipalId}`;
    await this.enqueueContextGraphMembershipPersistWrite(membershipKey, () =>
      this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, async () => {
        let previousMembership: (ContextGraphMembershipRecord & {
          firstSeenAt?: number;
          updatedAt: number;
        }) | null = null;
        let previousMembershipKnown = membershipStore === undefined;
        if (membershipStore?.loadAll) {
          const rows = await membershipStore.loadAll();
          previousMembershipKnown = true;
          previousMembership = rows.find((row) =>
            row.contextGraphId === contextGraphId
            && row.principalType === membership.principalType
            && this.normalizeMembershipPrincipal(row.principalType, row.principalId) === normalizedPrincipalId
          ) ?? null;
        }

        let previousSubscription: ContextGraphSubscriptionRecord | null = null;
        if (subscriptionStore) {
          previousSubscription = subscriptionStore.load
            ? await subscriptionStore.load(contextGraphId)
            : (await subscriptionStore.loadAll()).find((row) => row.id === contextGraphId) ?? null;
        }

        const subscriptionRecord: ContextGraphSubscriptionRecord = {
          id: contextGraphId,
          name: subscription.name,
          subscribed: subscription.subscribed,
          synced: subscription.synced,
          sharedMemorySynced: subscription.sharedMemorySynced,
          metaSynced: subscription.metaSynced,
          onChainId: subscription.onChainId,
          onChainHash: subscription.onChainHash,
          lastReconciledOrdinal: subscription.lastReconciledOrdinal,
          coreHosted: subscription.coreHosted,
          syncScoped: true,
        };
        let membershipAttempted = false;
        let subscriptionAttempted = false;
        try {
          if (membershipStore) {
            membershipAttempted = true;
            await membershipStore.upsert({
              ...membership,
              principalId: normalizedPrincipalId,
              updatedAt: Date.now(),
            });
          }
          if (subscriptionStore) {
            subscriptionAttempted = true;
            await subscriptionStore.save(subscriptionRecord);
          }
        } catch (error) {
          const rollbackFailures: unknown[] = [];
          if (subscriptionAttempted && subscriptionStore) {
            try {
              await (previousSubscription
                ? subscriptionStore.save(previousSubscription)
                : subscriptionStore.delete(contextGraphId));
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (membershipAttempted && membershipStore && previousMembershipKnown) {
            try {
              if (previousMembership) await membershipStore.upsert(previousMembership);
              else {
                await membershipStore.delete(
                  contextGraphId,
                  membership.principalType,
                  normalizedPrincipalId,
                );
              }
            } catch (rollbackError) {
              rollbackFailures.push(rollbackError);
            }
          }
          if (rollbackFailures.length > 0) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackFailures
              .map((rollbackError) => rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError))
              .join('; ');
            throw new AggregateError(
              [error, ...rollbackFailures],
              `${originalMessage}; join-approval rollback failed: ${rollbackMessage}`,
            );
          }
          throw error;
        }
      }),
      { strict: true },
    );
  }

  async assertAlreadyMemberDelegationRefresh(this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    carrierPeerId: string,
  ): Promise<void> {
    const signedPeerId = delegation.delegateePeerId;
    if (!signedPeerId || signedPeerId !== carrierPeerId) {
      throw new Error(
        'Already-member delegation refresh carrier mismatch: ' +
        `signed delegateePeerId=${signedPeerId || '<missing>'}, carrier=${carrierPeerId}`,
      );
    }
    if (!Number.isSafeInteger(delegation.issuedAtMs) || delegation.issuedAtMs < 0) {
      throw new Error('Already-member delegation refresh has an invalid issuedAtMs');
    }
    const incomingExpiresAtMs = delegation.expiresAtMs ?? 0;
    if (!Number.isSafeInteger(incomingExpiresAtMs) || incomingExpiresAtMs < 0) {
      throw new Error('Already-member delegation refresh has an invalid expiresAtMs');
    }

    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    const delegationUri = assertSafeIri(
      `did:dkg:agent-delegation:${contextGraphId}:${delegation.agentAddress.toLowerCase()}`,
    );
    const result = await this.store.query(
      `SELECT ?issuedAt ?expiresAt ?peer ?opKey WHERE {
        GRAPH <${metaGraph}> {
          <${delegationUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT}> ?issuedAt .
          OPTIONAL { <${delegationUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expiresAt }
          OPTIONAL { <${delegationUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}> ?peer }
          OPTIONAL { <${delegationUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}> ?opKey }
        }
      } LIMIT 1`,
      { source: 'agent.delegationRefresh.currentState' },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return;

    const row = result.bindings[0] as Record<string, string>;
    const currentIssuedAtMs = Number(stripLiteral(row['issuedAt'] ?? ''));
    const currentExpiresAtMs = row['expiresAt'] == null
      ? 0
      : Number(stripLiteral(row['expiresAt']));
    if (
      !Number.isSafeInteger(currentIssuedAtMs) || currentIssuedAtMs < 0 ||
      !Number.isSafeInteger(currentExpiresAtMs) || currentExpiresAtMs < 0
    ) {
      throw new Error('Stored already-member delegation has an invalid validity timestamp');
    }
    if (delegation.issuedAtMs < currentIssuedAtMs) {
      throw new Error(
        `Stale already-member delegation refresh: issuedAtMs ${delegation.issuedAtMs} ` +
        `is older than active credential ${currentIssuedAtMs}`,
      );
    }
    if (delegation.issuedAtMs > currentIssuedAtMs) return;

    const currentPeerId = row['peer'] == null ? '' : stripLiteral(row['peer']);
    const currentOpKey = row['opKey'] == null ? '' : stripLiteral(row['opKey']).toLowerCase();
    const incomingOpKey = delegation.delegateeOpKey?.toLowerCase() ?? '';
    if (
      signedPeerId !== currentPeerId ||
      incomingOpKey !== currentOpKey ||
      incomingExpiresAtMs !== currentExpiresAtMs
    ) {
      throw new Error(
        `Conflicting already-member delegation refresh at issuedAtMs ${delegation.issuedAtMs}`,
      );
    }
  }

  normalizeMembershipPrincipal(this: DKGAgent,
    principalType: ContextGraphMemberPrincipalType,
    principalId: string,
  ): string {
    if (principalType === 'agent' && ethers.isAddress(principalId)) {
      return ethers.getAddress(principalId);
    }
    return principalId;
  }

  upsertContextGraphMember(this: DKGAgent,
    record: ContextGraphMembershipRecord,
    options?: { strict?: boolean },
  ): Promise<void> {
    const store = this.config.contextGraphMembershipStore;
    if (!store) {
      void this.reconcileRfc64CatalogResponsibilityV1(
        record.contextGraphId,
      ).catch(() => undefined);
      return Promise.resolve();
    }
    const normalizedRecord = {
      ...record,
      principalId: this.normalizeMembershipPrincipal(record.principalType, record.principalId),
    };
    const key = `${normalizedRecord.contextGraphId}\0${normalizedRecord.principalType}\0${normalizedRecord.principalId}`;
    const write = this.enqueueContextGraphMembershipPersistWrite(
      key,
      () => store.upsert({ ...normalizedRecord, updatedAt: Date.now() }),
      { strict: options?.strict === true },
    );
    const refreshAuthority = () => {
      void this.reconcileRfc64CatalogResponsibilityV1(
        normalizedRecord.contextGraphId,
      ).catch(() => undefined);
    };
    if (options?.strict === true) return write.then(refreshAuthority);
    // Background callers stay log-and-continue; durability-sensitive callers
    // opt into the strict path above and receive the original rejection.
    return write.then(refreshAuthority).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to persist context-graph membership for "${normalizedRecord.contextGraphId}" (${normalizedRecord.principalType}:${normalizedRecord.principalId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  deleteContextGraphMember(this: DKGAgent,
    contextGraphId: string,
    principalType: ContextGraphMemberPrincipalType,
    principalId: string,
  ): void {
    const store = this.config.contextGraphMembershipStore;
    if (!store) {
      void this.reconcileRfc64CatalogResponsibilityV1(contextGraphId)
        .catch(() => undefined);
      return;
    }
    const normalizedPrincipalId = this.normalizeMembershipPrincipal(principalType, principalId);
    const key = `${contextGraphId}\0${principalType}\0${normalizedPrincipalId}`;
    void this.enqueueContextGraphMembershipPersistWrite(
      key,
      () => store.delete(contextGraphId, principalType, normalizedPrincipalId),
    ).then(() => this.reconcileRfc64CatalogResponsibilityV1(contextGraphId))
      .catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to delete context-graph membership for "${contextGraphId}" (${principalType}:${normalizedPrincipalId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  persistLocalNodeMembership(this: DKGAgent, contextGraphId: string, source = 'subscription'): void {
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'node',
      principalId: this.peerId,
      role: 'subscriber',
      status: 'active',
      source,
      displayName: this.nodeName,
      metadata: {
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        sharedMemorySynced: sub?.sharedMemorySynced ?? false,
        metaSynced: sub?.metaSynced ?? false,
        ...(sub?.onChainId ? { onChainId: sub.onChainId } : {}),
      },
    });
  }

  getContextGraphSubscriptionRehydrationStatus(this: DKGAgent): ContextGraphSubscriptionRehydrationStatus | null {
    const status = this.contextGraphSubscriptionRehydrationStatus;
    if (!status) return null;
    const dormancy = projectContextGraphDormancy(this.contextGraphSubscriptionDormancyById);
    return {
      ...status,
      hostedActivatedIds: [...(status.hostedActivatedIds ?? [])],
      dormant: dormancy.dormantIds.length,
      ...dormancy,
    };
  }

  async rehydrateContextGraphSubscriptions(this: DKGAgent): Promise<void> {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return;
    const ctx = createOperationContext('init');
    try {
      // System context graphs (AGENTS/ONTOLOGY) are auto-subscribed separately
      // by start(); their persisted rows must NOT be rehydrated here too. Re-
      // activating them is redundant, and counting them against the cap below
      // would let them consume activation slots and leave USER subscriptions
      // dormant. Exclude them from the rehydration set entirely.
      const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
      const persistedRows = await store.loadAll();
      const rows = persistedRows.filter((r) => !systemContextGraphs.has(r.id));

      // Validate the cap before either branch below so diagnostics retain the
      // operator's configured cap even when the independent rehydration gate
      // disables activation entirely.
      const configuredCap = this.config.maxRehydratedContextGraphSubscriptions;
      let cap = DEFAULT_MAX_REHYDRATED_SUBSCRIPTIONS;
      if (configuredCap != null) {
        if (Number.isInteger(configuredCap) && configuredCap >= 0) {
          cap = configuredCap;
        } else {
          this.log.warn(
            ctx,
            `Ignoring invalid maxRehydratedContextGraphSubscriptions=${configuredCap} ` +
              `(must be a non-negative integer); using default ${DEFAULT_MAX_REHYDRATED_SUBSCRIPTIONS}.`,
          );
        }
      }

      // Operator kill-switch: inventory the durable rows for diagnostics but
      // deliberately do not copy any of them into runtime subscription state.
      // In particular, do not install gossip handlers, add automatic sync
      // scope, persist node-membership side effects, or touch the RDF store.
      // A later explicit subscribe remains a normal live activation and updates
      // the status through updateContextGraphSubscriptionRehydrationStatusAfterPersist.
      if (!this.config.contextGraphSubscriptionRehydrationEnabled) {
        const dormancyById = this.contextGraphSubscriptionDormancyById;
        dormancyById.clear();
        for (const row of rows) dormancyById.set(row.id, 'rehydrationDisabled');
        this.contextGraphSubscriptionRehydrationAccountedIds.clear();
        for (const row of rows) {
          this.contextGraphSubscriptionRehydrationAccountedIds.add(row.id);
        }
        const completedAt = Date.now();
        this.contextGraphSubscriptionRehydrationStatus = {
          rehydrationEnabled: false,
          persistedTotal: rows.length,
          systemExcluded: persistedRows.length - rows.length,
          hostedActivated: 0,
          hostedActivatedIds: [],
          activated: 0,
          activationCap: cap,
          capDisabled: cap === 0,
          completedAt,
          updatedAt: completedAt,
        };
        if (rows.length > 0) {
          this.log.info(
            ctx,
            `Context-graph subscription rehydration disabled; left ${rows.length} ` +
              'non-system persisted subscription(s) dormant without modifying durable state',
          );
        }
        return;
      }

      // `pendingMeta` and the agent chosen for the first authenticated sync
      // are deliberately in-memory state. Recover both from the durable
      // join-approved membership fact before activating subscriptions. Load
      // every persisted row (not just the rows that fit under the activation
      // cap) so a dormant subscription still has the right signer when an
      // operator later activates it explicitly.
      const membershipStore = this.config.contextGraphMembershipStore;
      if (membershipStore?.loadAll) {
        try {
          const persistedContextGraphIds = new Set(rows.map((row) => row.id));
          const localAgentAddresses = new Set(
            [...this.localAgents.keys()].map((address) => address.toLowerCase()),
          );
          const newestApprovalByContextGraph = new Map<string, {
            principalId: string;
            updatedAt: number;
            curatorPeerId?: string;
          }>();
          for (const membership of await membershipStore.loadAll()) {
            const principalId = membership.principalId.toLowerCase();
            if (
              membership.principalType !== 'agent' ||
              membership.status !== 'active' ||
              membership.source !== 'join-approved' ||
              !persistedContextGraphIds.has(membership.contextGraphId) ||
              !localAgentAddresses.has(principalId)
            ) {
              continue;
            }
            const existing = newestApprovalByContextGraph.get(membership.contextGraphId);
            if (!existing || membership.updatedAt > existing.updatedAt) {
              newestApprovalByContextGraph.set(membership.contextGraphId, {
                principalId,
                updatedAt: membership.updatedAt,
                curatorPeerId: typeof membership.metadata?.['curatorPeerId'] === 'string' &&
                  membership.metadata['curatorPeerId'].trim()
                  ? membership.metadata['curatorPeerId'].trim()
                  : undefined,
              });
            }
          }
          for (const [contextGraphId, approval] of newestApprovalByContextGraph) {
            this.localApprovedAgentByCG.set(contextGraphId, approval.principalId);
            if (approval.curatorPeerId) {
              this.preferredSyncPeers.set(contextGraphId, approval.curatorPeerId);
            }
          }
        } catch (err) {
          // Membership recovery improves restart liveness but must never make
          // the subscription store itself unavailable. A later explicit join
          // or successful metadata sync still repairs the in-memory hint.
          this.log.warn(
            ctx,
            `Failed to rehydrate join-approved context-graph memberships: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Cap how many subscriptions we ACTIVATE on boot. Activation
      // (in-memory restore + sync-track + gossip subscribe + member persist)
      // does store-touching work per row; a large stale backlog fans this out
      // and starves authenticated store-backed routes (#997 — a node that had
      // "Rehydrated 173" wedged every authenticated write/query while storeless
      // /api/status stayed green). Rows beyond the cap stay PERSISTED but
      // dormant — they re-activate on next explicit access, or an operator
      // prunes them via `DELETE /api/context-graph/subscriptions`. Prioritise
      // core-hosted, then subscribed, so the kept set is the most relevant.
      // NOTE: a dormant (capped-out) row has no in-memory entry, so individual
      // `POST /api/context-graph/unsubscribe` can't target it — the bulk DELETE
      // above is the prune path for the stale backlog by design. (Follow-up:
      // reconcile contextGraphMembershipStore for rows left dormant / cleared so
      // a prior `active` local-node membership row doesn't linger.)
      // coreHosted graphs MUST always be restored — their chain-driven
      // reconcile / host-mode path depends on it — so EXEMPT them from the cap.
      // The cap (a #997 anti-wedge measure) applies only to the non-hosted
      // user-subscription backlog, which is what fans out and starves the store
      // on boot. Sort every group explicitly so the dormant set is stable and
      // operator diagnostics identify the same IDs across restarts.
      const byId = (a: ContextGraphSubscriptionRecord, b: ContextGraphSubscriptionRecord): number =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      const hostedRows = rows.filter((r) => r.coreHosted).sort(byId);
      const userRows = [...rows.filter((r) => !r.coreHosted)].sort(
        (a, b) => (b.subscribed ? 1 : 0) - (a.subscribed ? 1 : 0) || byId(a, b),
      );
      const toActivate = [...hostedRows, ...userRows];
      const dormancyById = this.contextGraphSubscriptionDormancyById;
      dormancyById.clear();
      const activatedRows: ContextGraphSubscriptionRecord[] = [];
      let activatedUserRows = 0;
      for (let i = 0; i < toActivate.length; i++) {
        const row = toActivate[i];
        // The cap limits successful non-hosted activations, not candidates.
        // A denied/unavailable row therefore cannot consume capacity that a
        // later authorized subscription could use.
        if (!row.coreHosted && cap > 0 && activatedUserRows >= cap) {
          dormancyById.set(row.id, 'activationCap');
          continue;
        }
        const approvedAgentAddress = row.subscribed
          ? this.localApprovedAgentByCG.get(row.id)
          : undefined;
        const hasJoinApproval = approvedAgentAddress !== undefined;
        // A crash between a historical false-ready sync and the approval
        // reset could leave all three persisted bits true. The durable
        // join-approved marker identifies a private bootstrap, so prove both
        // the graph metadata and the approved local agent's CURRENT effective
        // allowlist membership before trusting those completion bits again.
        // `getContextGraphAllowedAgents` subtracts revoked-agent tombstones.
        const approvedMetaConfirmed = hasJoinApproval && row.metaSynced === true
          ? await this.hasConfirmedMetaState(row.id).catch(() => false)
          : false;
        const approvedAgentAuthorized = approvedMetaConfirmed && approvedAgentAddress !== undefined
          ? (await this.getContextGraphAllowedAgents(row.id).catch(() => []))
            .some((address) => address.toLowerCase() === approvedAgentAddress)
          : false;
        // A persisted row records synchronization intent, not current read
        // authority. Older daemons could persist a private-CG subscription
        // before proving membership; blindly restoring that row would revive
        // the exact plaintext-recovery path the live subscribe gate closes.
        // Check before installing gossip, sync scope, data lanes, or a
        // membership side effect. Unknown/unavailable authority is deliberately
        // dormant, except that a durable join approval may restore the minimal
        // in-memory state needed for one authenticated metadata fetch. That
        // restricted path cannot activate data lanes until this same authority
        // resolver subsequently returns `allowed`.
        const readAuthority = await this.resolveContextGraphReadAuthority(row.id, {
          allowSubscriptionFallback: false,
        }).catch(() => ({
          outcome: 'unavailable' as const,
          source: 'legacy-local' as const,
          reason: 'unexpected-authority-error',
          metadataBootstrap: 'eligible' as const,
        }));
        // A stale approval cannot override an explicit current membership
        // denial. The authority resolver supplies a typed bootstrap policy so
        // lifecycle code never infers security semantics from diagnostic text.
        const restrictedApprovalBootstrap = hasJoinApproval
          && readAuthority.metadataBootstrap === 'eligible'
          && (
            readAuthority.outcome !== 'allowed'
            || !approvedAgentAuthorized
          );
        if (readAuthority.outcome !== 'allowed' && !restrictedApprovalBootstrap) {
          dormancyById.set(
            row.id,
            readAuthority.outcome === 'denied' ? 'authorityDenied' : 'authorityUnavailable',
          );
          this.log.warn(
            ctx,
            `Left persisted context-graph subscription "${row.id}" dormant: ` +
              `${readAuthority.outcome} by ${readAuthority.source} (${readAuthority.reason})`,
          );
          continue;
        }
        activatedRows.push(row);
        if (!row.coreHosted) activatedUserRows += 1;
        const restorePendingMeta = restrictedApprovalBootstrap;
        this.setContextGraphSubscription(row.id, {
          name: row.name,
          // Every row in the durable store predates or represents explicit
          // restart persistence, so absence of a mode is always-on.
          syncMode: 'always-on',
          subscribed: row.subscribed,
          synced: restorePendingMeta ? false : row.synced,
          sharedMemorySynced: restorePendingMeta ? false : row.sharedMemorySynced,
          metaSynced: restorePendingMeta ? false : row.metaSynced,
          ...(restorePendingMeta
            ? { pendingMeta: true }
            : {}),
          onChainId: row.onChainId,
          onChainHash: row.onChainHash,
          lastReconciledOrdinal: row.lastReconciledOrdinal,
          coreHosted: row.coreHosted,
        }, { persist: false });
        if (row.syncScoped && !restrictedApprovalBootstrap) {
          this.trackSyncContextGraph(row.id);
        }
        if (row.subscribed && !restrictedApprovalBootstrap) {
          this.subscribeToContextGraph(row.id, {
            trackSyncScope: false,
            persist: false,
            syncMode: 'always-on',
          });
          this.persistLocalNodeMembership(row.id, 'rehydrated-subscription');
        }
        if (restrictedApprovalBootstrap) {
          const curatorPeerId = this.preferredSyncPeers.get(row.id);
          this.log.info(
            ctx,
            `Restored persisted context-graph subscription "${row.id}" in restricted pending-metadata mode; VM, payload recovery, and SWM remain closed`,
          );
          if (curatorPeerId) {
            void this.resumePendingJoinApprovalMetadata(row.id, curatorPeerId).catch((error) => {
              this.log.warn(
                ctx,
                `Pending join-approval recovery for "${row.id}" stopped safely: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
          }
        }
        // Upgrade/self-heal path for late private-CG members whose payload and
        // authenticated `_meta` already completed before registration binding
        // persistence was introduced. Do not make them re-download the whole
        // CG merely to repair a NULL `on_chain_id`: the exact meta graph is
        // already proven above, and `refreshMetaSyncedFlags` can bind its
        // immutable registration tuple locally. The strict write makes the
        // repair durable before rehydration reports completion.
        if (approvedMetaConfirmed && !row.onChainId) {
          await this.refreshMetaSyncedFlags([row.id]);
          if (this.subscribedContextGraphs.get(row.id)?.onChainId) {
            await this.persistContextGraphSubscriptionStrict(row.id);
          }
        }
        // Throttle: yield so concurrent store-backed work (routes, sync) can
        // interleave instead of being starved by a synchronous activation burst.
        if ((i + 1) % REHYDRATE_THROTTLE_BATCH === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      const skipped = dormancyById.size;
      this.contextGraphSubscriptionRehydrationAccountedIds.clear();
      for (const row of rows) {
        this.contextGraphSubscriptionRehydrationAccountedIds.add(row.id);
      }
      const completedAt = Date.now();
      this.contextGraphSubscriptionRehydrationStatus = {
        rehydrationEnabled: true,
        persistedTotal: rows.length,
        systemExcluded: persistedRows.length - rows.length,
        hostedActivated: activatedRows.filter((r) => r.coreHosted).length,
        hostedActivatedIds: activatedRows.filter((r) => r.coreHosted).map((r) => r.id),
        activated: activatedRows.length,
        activationCap: cap,
        capDisabled: cap === 0,
        completedAt,
        updatedAt: completedAt,
      };
      const dormancy = projectContextGraphDormancy(dormancyById);
      if (rows.length > 0) {
        this.log.info(
          ctx,
          `Rehydrated ${activatedRows.length} of ${rows.length} non-system persisted context-graph subscription(s)` +
            (skipped > 0
              ? ` (${skipped} left dormant; ` +
                `${activatedRows.filter((r) => r.coreHosted).length} hosted restored)`
              : ''),
        );
      }
      if (dormancy.dormantReasons.activationCap.length > 0) {
        this.log.warn(
          ctx,
          `${dormancy.dormantReasons.activationCap.length} context-graph subscription(s) left dormant by the activation cap. ` +
            `Prune stale ones via 'DELETE /api/context-graph/subscriptions', or raise ` +
            `maxRehydratedContextGraphSubscriptions. Inspect ` +
            `'GET /api/context-graph/subscriptions' for dormant ids.`,
        );
      }
      if (dormancy.dormantReasons.authorityDenied.length > 0) {
        this.log.warn(
          ctx,
          `${dormancy.dormantReasons.authorityDenied.length} context-graph subscription(s) left dormant because current read authority denied this node.`,
        );
      }
      if (dormancy.dormantReasons.authorityUnavailable.length > 0) {
        this.log.warn(
          ctx,
          `${dormancy.dormantReasons.authorityUnavailable.length} context-graph subscription(s) left dormant because current read authority was unavailable; retry after restoring the authority source.`,
        );
      }
    } catch (err) {
      this.log.warn(ctx, `Failed to rehydrate persisted context-graph subscriptions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Operator recovery for #997: tear down every active in-memory subscription
   * (gossip + sync scope) and wipe the persisted backlog, returning the number
   * of persisted rows removed. Reachable via `DELETE /api/context-graph/
   * subscriptions` so a node wedged by stale subscriptions can be reset without
   * hand-editing the SQLite store. Best-effort per CG so one failure can't block
   * the rest.
   */
  async clearContextGraphSubscriptions(this: DKGAgent): Promise<number> {
    const store = this.config.contextGraphSubscriptionStore;
    const ctx = createOperationContext('init');
    // NEVER clear the system context graphs (AGENTS / ONTOLOGY): they are the
    // network control plane — agent discovery + the shared ontology/CG registry
    // — auto-subscribed at start() and always in sync scope. Tearing them down
    // would silently deafen the node to system gossip until the next restart,
    // the opposite of what this recovery endpoint is for. So we only ever clear
    // USER context-graph subscriptions, live and persisted alike. (The store's
    // system-unaware bulk delete is deliberately NOT used here.)
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
    // Clearable = a NON-system, NON-coreHosted user subscription. System CGs are
    // the control plane (above). coreHosted graphs are legitimate hosted graphs
    // that `unsubscribeFromContextGraph` deliberately keeps wired for host-mode /
    // chain reconcile (so a teardown can't fully remove them anyway) and that the
    // rehydration cap already exempts — clearing/counting them here would report a
    // removal that didn't happen. The clear targets only the stale non-hosted
    // backlog, the actual #997 wedge.
    const isClearable = (id: string, coreHosted: boolean | undefined): boolean =>
      !systemContextGraphs.has(id) && coreHosted !== true;

    const activeUserIds = [...this.subscribedContextGraphs.entries()]
      .filter(([id, s]) => isClearable(id, s?.coreHosted))
      .map(([id]) => id);

    // The full persisted clearable backlog (active + dormant rows left behind by
    // the rehydration cap). Counted up front: `unsubscribeFromContextGraph`
    // deletes each active row as a side effect, so a post-teardown count would
    // miss them. Starts empty so a node with NO store reports 0 persisted rows
    // removed (the active teardown is logged separately) rather than a phantom
    // count of the in-memory subs.
    let persistedUserIds: string[] = [];
    if (store) {
      try {
        persistedUserIds = (await store.loadAll())
          .filter((r) => isClearable(r.id, r.coreHosted))
          .map((r) => r.id);
      } catch (err) {
        // Can't enumerate the persisted backlog → the dormant (capped-out) rows
        // would survive and rehydrate after the next restart. Do NOT silently
        // fall back to active-only and report success; surface the failure so the
        // operator resolves the store error and retries. Thrown before any
        // teardown, so nothing is changed.
        throw new Error(
          `clearContextGraphSubscriptions: failed to enumerate persisted subscriptions ` +
            `(${err instanceof Error ? err.message : String(err)}); the backlog was NOT cleared. ` +
            `Resolve the store error and retry.`,
        );
      }
    }
    const activeUserIdsWithPendingStoreWrite = store
      ? activeUserIds.filter((id) => this.contextGraphSubscriptionPersistChains.has(id))
      : [];
    const storeDeleteIds = [...new Set([...persistedUserIds, ...activeUserIdsWithPendingStoreWrite])];
    const total = storeDeleteIds.length;
    const idsToCancel = store ? [...new Set([...storeDeleteIds, ...activeUserIds])] : [];
    // Cancel any in-flight save callbacks that started before this bulk clear.
    for (const id of idsToCancel) {
      this.cancelContextGraphSubscriptionPersistRevisions(id);
    }

    // Tear down active in-memory USER subscriptions (gossip topics + sync scope),
    // then REMOVE the registry entry. `unsubscribeFromContextGraph` only flips
    // `subscribed` to false — it keeps the entry for the host-mode/reconcile path
    // — but this recovery endpoint must leave NO trace of the cleared CGs, or
    // read fallbacks would still see the IDs in `subscribedContextGraphs` even
    // though the persisted rows are gone. (activeUserIds already excludes system
    // + coreHosted CGs, so this only drops the cleared non-hosted user entries.)
    for (const id of activeUserIds) {
      try {
        this.unsubscribeFromContextGraph(id, { persist: false, updateRehydrationStatus: false });
        this.deleteContextGraphMember(id, 'node', this.peerId);
      } catch {
        /* best-effort teardown */
      }
      this.deleteContextGraphSubscription(id);
    }

    // Delete the persisted USER rows (active + dormant). Selective — never the
    // system rows — so a custom store without a system-aware bulk delete is safe.
    // Count ACTUAL deletions: a swallowed store.delete() failure must not be
    // reported as cleared, or this recovery endpoint would answer 200 "all
    // gone" while stale rows survive in the store.
    let cleared = persistedUserIds.length;
    const clearedIds: string[] = [];
    const deactivatedIds: string[] = [];
    const activeUserIdSet = new Set(activeUserIds);
    let failed = 0;
    if (store) {
      cleared = 0;
      for (const id of storeDeleteIds) {
        try {
          await this.enqueueContextGraphSubscriptionPersistWrite(id, () => store.delete(id));
          cleared++;
          clearedIds.push(id);
        } catch (err) {
          failed++;
          if (activeUserIdSet.has(id)) {
            deactivatedIds.push(id);
          }
          this.log.warn(
            ctx,
            `clearContextGraphSubscriptions: failed to delete persisted subscription "${id}": ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }
    if (cleared > 0 || deactivatedIds.length > 0) {
      this.updateContextGraphSubscriptionRehydrationStatusAfterClear(clearedIds, deactivatedIds);
    }

    this.log.info(
      ctx,
      `Cleared ${cleared} of ${total} persisted user context-graph subscription(s)` +
        (failed > 0 ? ` (${failed} failed to delete — see warnings)` : '') +
        `; tore down ${activeUserIds.length} active in-memory subscription(s); system context graphs preserved`,
    );
    return cleared;
  }

  /**
   * Reconcile configured-graph metadata entirely inside the agent boundary.
   * A chain result obtained for repair is also the evidence used by metadata
   * confirmation, so an unregistered placeholder cannot trigger a second
   * chain resolution pass or observe a different slot state.
   */
  async reconcileConfiguredContextGraphMetadata(
    this: DKGAgent,
    contextGraphId: string,
  ): Promise<ConfiguredContextGraphMetadataReconciliationResult> {
    return reconcileConfiguredContextGraphMetadataV1({
      store: this.store,
      resolveActivePublicChainProof: (id, operationContext) =>
        this.resolveActivePublicContextGraphChainProof(id, operationContext),
      isLocallyCurated: (normalizedContextGraphId) =>
        this.isCuratorOf(normalizedContextGraphId),
      confirmMetadata: (normalizedContextGraphId, input, resolveActivePublicChainProof) =>
        confirmContextGraphMetadataV1({
          chain: this.chain,
          resolveActivePublicChainProof,
          isPrivateContextGraph: (id) => this.isPrivateContextGraph(id),
          localApprovedAgentByContextGraph: this.localApprovedAgentByCG,
          peerId: this.peerId,
          store: this.store,
          subscriptions: this.subscribedContextGraphs,
        }, normalizedContextGraphId, input),
    }, contextGraphId);
  }

  async hasConfirmedMetaState(this: DKGAgent,
    contextGraphId: string,
    options?: {
      rejectUnregisteredPlaceholder?: boolean;
    },
  ): Promise<boolean> {
    return confirmContextGraphMetadataV1({
      chain: this.chain,
      resolveActivePublicChainProof: () => this.resolveActivePublicContextGraphChainProof(
        contextGraphId,
        createOperationContext('sync'),
      ),
      isPrivateContextGraph: (id) => this.isPrivateContextGraph(id),
      localApprovedAgentByContextGraph: this.localApprovedAgentByCG,
      peerId: this.peerId,
      store: this.store,
      subscriptions: this.subscribedContextGraphs,
    }, contextGraphId, options);
  }

  async hasConfirmedSharedMemoryMetaState(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    return this.hasConfirmedMetaState(contextGraphId);
  }

  async canUseSharedMemoryForContextGraph(this: DKGAgent,
    contextGraphId: string,
    opts: { callerAgentAddress?: string } = {},
  ): Promise<boolean> {
    if (!(await this.hasConfirmedSharedMemoryMetaState(contextGraphId))) {
      return false;
    }
    return this.canReadContextGraph(contextGraphId, {
      callerAgentAddress: opts.callerAgentAddress,
      allowSubscriptionFallback: false,
    });
  }

  async verifySyncedDataInWorker(this: DKGAgent,
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
  ): Promise<{ data: Quad[]; meta: Quad[]; rejected: number }> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.verify(dataQuads, metaQuads, acceptUnverified);
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return { data: result.data, meta: result.meta, rejected: result.rejected };
  }

  async processDurableBatchInWorker(this: DKGAgent,
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
    mode: DurableBatchVerificationMode = { kind: 'fullSnapshot' },
  ): Promise<DurableBatchProcessResult> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.processDurableBatch(
      dataQuads,
      metaQuads,
      acceptUnverified,
      mode,
    );
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return result;
  }

  getOrCreateSyncVerifyWorker(this: DKGAgent): SyncVerifyWorker {
    if (!this.syncVerifyWorker) {
      this.syncVerifyWorker = new SyncVerifyWorker();
    }
    return this.syncVerifyWorker;
  }

  /**
   * Update the shared memory TTL at runtime. Takes effect immediately for queries
   * and the next cleanup cycle without requiring a restart.
   */
  setSharedMemoryTtlMs(this: DKGAgent, ttlMs: number): void {
    const oldTtl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    (this.config as any).sharedMemoryTtlMs = ttlMs;

    if (oldTtl <= 0 && ttlMs > 0 && !this.swmCleanupTimer) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    } else if (ttlMs <= 0 && this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
  }

  /**
   * Remove expired shared memory operations and their data.
   * Queries SWM meta for operations with publishedAt older than the TTL,
   * deletes the corresponding triples from shared memory and SWM meta,
   * and removes the root entities from workspaceOwnedEntities.
   */
  async cleanupExpiredSharedMemory(this: DKGAgent): Promise<number> {
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl <= 0) return 0;

    const ctx = createOperationContext('share');
    const cutoff = new Date(Date.now() - ttl).toISOString();
    let totalDeleted = 0;

    try {
      const graphManager = new GraphManager(this.store);
      const contextGraphs = await graphManager.listContextGraphs();

      for (const pid of contextGraphs) {
        let graphDeleted = 0;
        let expiredOpsCount = 0;

        // Graph-scoped V2 operations and heads for sub-graph shares live in
        // per-subgraph `…/{subGraph}/_shared_memory_meta` graphs (see
        // GraphManager.sharedMemoryMetaUri), not only in the root
        // `…/_shared_memory_meta` bucket — expire every meta graph.
        const wsMetaGraphs = await listSharedMemoryMetaGraphs(this.store, pid);

        for (const wsMetaGraph of wsMetaGraphs) {
          // Each meta graph describes exactly one SWM data bucket:
          // `…/_shared_memory_meta` ↔ `…/_shared_memory` (root or per-subgraph).
          const wsGraph = wsMetaGraph.slice(0, -'_meta'.length);

          const expiredOps = await this.store.query(
            `SELECT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          }`,
            { source: 'agent.swmCleanup.expiredOperations' },
          );

          if (expiredOps.type !== 'bindings' || expiredOps.bindings.length === 0) continue;
          expiredOpsCount += expiredOps.bindings.length;

          for (const row of expiredOps.bindings) {
            const opUri = row['op'];
            if (!opUri) continue;

            const rootEntitiesResult = await this.store.query(
              `SELECT ?re WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/rootEntity> ?re .
              }
            }`,
              { source: 'agent.swmCleanup.operationRoots' },
            );

            const rootEntities: string[] = [];
            if (rootEntitiesResult.type === 'bindings') {
              for (const r of rootEntitiesResult.bindings) {
                if (r['re']) rootEntities.push(r['re']);
              }
            }

            // Uniform layout: span the per-KA …/_shared_memory/{addr}/{number} graphs + bucket.
            const wsGraphs = await listGraphFamily(this.store, wsGraph);
            for (const re of rootEntities) {
              for (const g of wsGraphs) {
                // Exact root only; then skolemized descendants only (prefix would over-delete e.g. urn:foo vs urn:foobar)
                const exactDeleted = await this.store.deleteByPattern({ graph: g, subject: re });
                graphDeleted += exactDeleted;
                const childPrefix = `${re}/.well-known/genid/`;
                const childDeleted = await this.store.deleteBySubjectPrefix(g, childPrefix);
                graphDeleted += childDeleted;
              }
            }

            // Graph-scoped V2 operations (dkg:contentScopeVersion=2) have no
            // rootEntity rows, so the legacy sweep above no-ops for them and
            // the generic op-subject delete below would strand the rest of the
            // KA: the per-KA SWM assertion graph, the `${kaUal}#dkg-swm-head`
            // subject and the operation's public snapshot graph. Discard them
            // here. The snapshot graph always dies with its operation; the
            // head and assertion graph die only when the head still points at
            // THIS operation — when a newer operation owns the head they carry
            // live data, and a surviving head whose operation rows are gone
            // reads as CORRUPT in resolveKnowledgeAssetWorkspaceHead.
            const v2Meta = await this.store.query(
              `SELECT ?scopeVersion ?kaUal ?snapshotGraph WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion .
                OPTIONAL { <${opUri}> <http://dkg.io/ontology/kaUal> ?kaUal }
                OPTIONAL { <${opUri}> <http://dkg.io/ontology/publicSnapshotGraph> ?snapshotGraph }
              }
            } LIMIT 1`,
              { source: 'agent.swmCleanup.graphScopedMetadata' },
            );
            const v2Row = v2Meta.type === 'bindings' ? v2Meta.bindings[0] : undefined;
            const scopeVersion = v2Row?.['scopeVersion'] === undefined ? NaN : Number(stripLiteral(v2Row['scopeVersion']));
            if (scopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
              const kaUal = v2Row?.['kaUal'];
              const headSubject = kaUal ? `${kaUal}#dkg-swm-head` : '';
              if (headSubject && isSafeIri(headSubject)) {
                // The head is owned by exactly one operation. Join on the
                // dkg:shareOperationId literal (both rows are written by the
                // same `lit()` serializer) so this op's expiry only tears the
                // head down when the head still references it.
                const headOwned = await this.store.query(
                  `SELECT ?assertionGraph WHERE {
                  GRAPH <${wsMetaGraph}> {
                    <${opUri}> <http://dkg.io/ontology/shareOperationId> ?opId .
                    <${headSubject}> <http://dkg.io/ontology/shareOperationId> ?opId .
                    OPTIONAL { <${headSubject}> <http://dkg.io/ontology/assertionGraph> ?assertionGraph }
                  }
                } LIMIT 1`,
                  { source: 'agent.swmCleanup.currentHeadOwner' },
                );
                if (headOwned.type === 'bindings' && headOwned.bindings.length > 0) {
                  // Whole KA expired: drop the per-KA SWM assertion graph and
                  // the current-head subject with the operation.
                  const assertionGraph = headOwned.bindings[0]?.['assertionGraph'];
                  if (assertionGraph && isSafeIri(assertionGraph)) {
                    graphDeleted += await this.store.deleteByPattern({ graph: assertionGraph });
                    await this.store.dropGraph(assertionGraph);
                  }
                  graphDeleted += await this.store.deleteByPattern({ graph: wsMetaGraph, subject: headSubject });
                }
              }
              const snapshotGraph = v2Row?.['snapshotGraph'];
              if (snapshotGraph && isSafeIri(snapshotGraph)) {
                graphDeleted += await this.store.deleteByPattern({ graph: snapshotGraph });
                await this.store.dropGraph(snapshotGraph);
              }
            }

            // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
            const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
            graphDeleted += metaDeleted;

            for (const re of rootEntities) {
              const ownerDeleted = await this.store.deleteByPattern({
                graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
              });
              graphDeleted += ownerDeleted;
            }

            // Evict every per-subgraph ownership key for the expired roots.
            // SWM data now spans the root workspace graph plus the per-KA /
            // subgraph `…/_shared_memory/{addr}/{number}` graphs (wsGraphs), and
            // ownership is cached under one key per graph family:
            // `pid` for the root/bucket and `${pid}\0${subGraph}` for per-subgraph
            // graphs (see sharedMemoryOwnershipKeyFromGraph). Only clearing the
            // `pid`-keyed map would leave the per-subgraph entries behind, so an
            // expired root could still look owned and mis-arbitrate later writes.
            const ownershipKeys = new Set<string>();
            for (const g of wsGraphs) {
              const ownershipKey = sharedMemoryOwnershipKeyFromGraph(pid, g);
              if (ownershipKey) ownershipKeys.add(ownershipKey);
            }
            for (const ownershipKey of ownershipKeys) {
              const ownedSet = this.workspaceOwnedEntities.get(ownershipKey);
              if (!ownedSet) continue;
              for (const re of rootEntities) {
                ownedSet.delete(re);
              }
            }
          }
        }

        totalDeleted += graphDeleted;
        if (expiredOpsCount > 0) {
          this.log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOpsCount} expired operation(s), ${graphDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return totalDeleted;
  }

}

async function listGraphFamily(store: TripleStore, rootGraph: string): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`);
  if (await store.hasGraph(rootGraph)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

async function runRecoverContextGraphSwmFromPeer(
  dependencies: RecoverContextGraphSwmFromPeerDependencies,
  remotePeerId: string,
  contextGraphId: string,
): Promise<RecoverContextGraphSwmResult> {
  const ctx = createOperationContext('sync');
  const admission = await getSharedMemorySubGraphAdmission(
    dependencies.store, contextGraphId, dependencies.listSubGraphs(contextGraphId),
  );
  return recoverContextGraphSwm({
    ctx,
    remotePeerId,
    contextGraphId,
    deadline: dependencies.createContextGraphSyncDeadline(1),
    // R9/R10 — pin recovery=true at the lifecycle boundary so swm-recovery's
    // deps signature stays unchanged. This forks BOTH the checkpoint namespace
    // (R10: a distinct `|recovery` cursor that never mutates the shared
    // incremental-sync cursor) AND the request envelope auth mode (R9: the
    // responder gates via the strict members-only `isMemberRecoveryAuthorized`).
    fetchSyncPages: dependencies.fetchSyncPages,
    processSharedMemoryBatch: dependencies.processSharedMemoryBatch,
    writeLocks: dependencies.writeLocks,
    publicSnapshotStore: dependencies.publicSnapshotStore,
    snapshotMaterializer: dependencies.snapshotMaterializer,
    // SwmRecoveryStore: invalidate the list cache + mark the meta projection
    // dirty on insert (parity with runSharedMemorySync's
    // insertSyncedQuadsAndInvalidateListCache); deletes pass through to the store.
    store: {
      insert: async (quads) => {
        // Oversize guard (OT-RFC-56) — recovered rows are peer data too.
        const inserted = await insertWithOversizeGuard(
          (kept) => dependencies.store.insert(kept, {
            priority: 'background',
            source: 'agent.swmRecovery.insert',
          }),
          quads,
          { recordDrops: (drops, seam) => dependencies.recordDrops(drops, seam) },
          'swm-recovery',
        );
        if (inserted.length > 0) {
          dependencies.invalidateListContextGraphsCache();
          dependencies.markMetaProjectionDirty(inserted);
        }
      },
      replaceGraph: async (graph, quads) => {
        const replaced = await tryReplaceGraphAtomically(
          dependencies.store,
          graph,
          quads,
          {
            priority: 'background',
            source: 'agent.swmRecovery.graphScopedReplace',
          },
        );
        if (!replaced) {
          throw Object.assign(
            new Error('Graph-scoped SWM recovery requires atomic TripleStore.replaceGraph() support'),
            { code: 'SWM_ATOMIC_REPLACE_UNSUPPORTED' },
          );
        }
        dependencies.invalidateListContextGraphsCache();
      },
      deleteByPattern: (pattern) => dependencies.store.deleteByPattern(pattern, {
        priority: 'background',
        source: 'agent.swmRecovery.deleteByPattern',
      }),
      deleteBySubjectPrefix: (graph, prefix) => dependencies.store.deleteBySubjectPrefix(graph, prefix, {
        priority: 'background',
        source: 'agent.swmRecovery.deleteBySubjectPrefix',
      }),
    },
    // Codex high: REPLACE per-root SWM meta (mirror the publisher's
    // deleteMetaForRoot). For each recovered root, drop the op→root-entity
    // links in the curator's fresh-meta graphs, then delete any op left with
    // no remaining roots — so a stale WorkspaceOperation can't survive to
    // TTL-delete the just-recovered root. Runs before swm-recovery inserts the
    // fresh verifiedMeta. Falls back to the base meta graph if none provided.
    replaceMetaForRoots: async (roots, metaGraphs) => {
      const graphs = metaGraphs.length > 0
        ? metaGraphs
        : [contextGraphWorkspaceMetaGraphUri(contextGraphId)];
      const entities = [...new Set(roots.map((r) => r.entity))];
      for (const metaGraph of graphs) {
        for (const entity of entities) {
          const ops = await dependencies.store.query(
            `SELECT DISTINCT ?op WHERE { GRAPH <${metaGraph}> { ?op ${ENTITY_PRED_ALT} <${entity}> } }`,
            {
              priority: 'background',
              source: 'agent.swmRecovery.replaceMetaForRoots.findOps',
            },
          );
          if (ops.type !== 'bindings') continue;
          for (const row of ops.bindings) {
            const op = row['op'];
            if (!op) continue;
            await dependencies.store.delete(
              [
                { subject: op, predicate: DKG_ROOT_ENTITY_LEGACY, object: entity, graph: metaGraph },
                { subject: op, predicate: DKG_ENTITY, object: entity, graph: metaGraph },
              ],
              {
                priority: 'background',
                source: 'agent.swmRecovery.replaceMetaForRoots.deleteLinks',
              },
            );
            const remaining = await dependencies.store.query(
              `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> ${ENTITY_PRED_ALT} ?r } }`,
              {
                priority: 'background',
                source: 'agent.swmRecovery.replaceMetaForRoots.countRoots',
              },
            );
            const raw = remaining.type === 'bindings' ? remaining.bindings[0]?.['c'] : undefined;
            const countVal = raw ? parseInt(String(raw).match(/\d+/)?.[0] ?? '0', 10) : 0;
            if (countVal === 0) {
              await deleteByPatternWithoutCount(
                dependencies.store,
                { graph: metaGraph, subject: op },
                {
                  priority: 'background',
                  source: 'agent.swmRecovery.replaceMetaForRoots.deleteOp',
                },
              );
            }
          }
        }
      }
    },
    replaceMetaForGraphAssets: (assets) =>
      dependencies.snapshotMaterializer.replaceMetaForGraphAssets(assets),
    ensureContextGraph: async (cgId) => {
      const graphManager = new GraphManager(dependencies.store);
      await graphManager.ensureContextGraph(cgId);
    },
    setCheckpoint: (key, offset) => dependencies.setCheckpoint(key, offset),
    deleteCheckpoint: (key) => dependencies.deleteCheckpoint(key),
    getRegisteredSubGraphNames: async () => admission.registered,
    getExcludedSubGraphNames: async () => admission.excluded,
    includeRootScope: dependencies.includeRootScope,
    // R2 — hydrate the Rule-4 ownership cache (same map runSharedMemorySync uses).
    ensureOwnedMap: dependencies.ensureOwnedMap,
    logInfo: (opCtx, message) => dependencies.logInfo(opCtx, message),
    logWarn: (opCtx, message) => dependencies.logWarn(opCtx, message),
  });
}

async function getSharedMemorySubGraphAdmission(
  store: TripleStore,
  contextGraphId: string,
  subGraphsPromise: Promise<Array<{ name: string; uri?: string }>>,
): Promise<{ registered: string[]; excluded: string[] }> {
  const registered: string[] = [];
  const excluded: string[] = [];
  for (const subGraph of await subGraphsPromise) {
    const childContextGraphUri = `${contextGraphDataGraphUri(contextGraphId)}/${subGraph.name}`;
    if (subGraph.uri && subGraph.uri !== childContextGraphUri) continue;
    if (await isKnownContextGraphUri(store, childContextGraphUri)) {
      excluded.push(subGraph.name);
    } else {
      registered.push(subGraph.name);
    }
  }
  return { registered, excluded };
}

async function isKnownContextGraphUri(store: TripleStore, contextGraphUri: string): Promise<boolean> {
  const metaGraph = `${contextGraphUri}/_meta`;
  const result = await store.query(
    `
      ASK {
        GRAPH <${assertSafeIri(metaGraph)}> {
          {
            <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          } UNION {
            <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
          }
        }
      }
    `,
    { source: 'agent.subGraphClassification.knownContextGraph' },
  );
  return result.type === 'boolean' && result.value;
}
/**
 * Enumerate every SWM meta graph of one context graph: the root
 * `…/_shared_memory_meta` bucket plus one `…/{subGraph}/_shared_memory_meta`
 * per sub-graph (graph-scoped V2 sub-graph shares store their operations and
 * heads there — see GraphManager.sharedMemoryMetaUri). Sub-graph names can
 * never start with `_` or contain `/` (validateSubGraphName), so protocol
 * families such as `…/_verifiable_memory/…` or `…/_shared_memory_snapshots/…`
 * can never be misread as a sub-graph meta graph.
 */
async function listSharedMemoryMetaGraphs(store: TripleStore, contextGraphId: string): Promise<string[]> {
  const rootMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  const cgPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  const metaSuffix = '/_shared_memory_meta';
  const metaGraphs = [rootMetaGraph];
  for (const graph of await listGraphsByPrefix(store, cgPrefix)) {
    if (graph === rootMetaGraph || !graph.endsWith(metaSuffix)) continue;
    const subGraphName = graph.slice(cgPrefix.length, graph.length - metaSuffix.length);
    if (!validateSubGraphName(subGraphName).valid) continue;
    metaGraphs.push(graph);
  }
  return metaGraphs;
}
