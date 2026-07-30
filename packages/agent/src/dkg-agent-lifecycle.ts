// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle + sync subsystem extracted from dkg-agent.ts as a mixin holder:
 * start() boot orchestration, random-sampling prover wiring, peer/CG sync
 * (warm-core, catchup, paged fetch, sync-verify worker), subscription-state
 * bookkeeping, and shared-memory TTL cleanup. 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { createHash } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_SYNC_POOLED, PROTOCOL_SYNC_CHANGELOG, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_NETWORK_IDENTITY,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  ENTITY_PRED_ALT, DKG_ENTITY, DKG_ROOT_ENTITY_LEGACY,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  deriveCuratorDidFromCgId,
  MemoryLayer,
  computeACKDigest,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeGossipEnvelope,
  computeGossipSigningPayload,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  decodeGossipEnvelope, type GossipEnvelopeMsg,
  decodeEncryptedWorkspacePayload, ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  decodeSwmSenderKeyMessage, SWM_SENDER_KEY_MESSAGE_TYPE,
  getGenesisQuads, computeNetworkId, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  validateSubGraphName,
  Logger, createOperationContext, isKaPublishLifecycleDebugLoggingEnabled, isStorageACKDecline, sparqlString, escapeSparqlLiteral, isSafeIri, assertSafeIri,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  buildTrustLevelQuads,
  isTrustLevelQuad,
  buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, type AuthorAttestationTypedData,
  buildAssertionSealQuads, buildAssertionPublishReceiptQuads,
  parseAssertionSealQuads, type AssertionSeal,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  computeWorkspaceAgentEncryptionKeyRevocationPayload,
  decodeWorkspaceEncryptionKey,
  encodeWorkspaceEncryptionKey,
  workspaceAgentEncryptionKeyId,
  SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
  SWM_SENDER_KEY_PACKAGE_ACK_RETRYABLE_REASON_CODES,
  SWM_SENDER_KEY_PACKAGE_VERSION,
  computeSwmSenderKeyMembershipHash,
  computeSwmSenderKeyPackageAAD,
  decodeWorkspacePublishRequest,
  decodeSwmSenderKeyPackage,
  decodeSwmSenderKeyPackageAck,
  decryptSwmSenderKeyMessage,
  decryptSwmSenderKeyPackage,
  encodeSwmSenderKeyMessage,
  encodeSwmSenderKeyPackage,
  encodeSwmSenderKeyPackageAck,
  encodeSwmShareAck,
  decodeSwmShareAck,
  encryptSwmSenderKeyMessage,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  ratchetSwmSenderChainKey,
  uint64ForProto,
  SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT,
  type DKGNodeConfig, type OperationContext, type GetView, type AssertionDescriptor, type AssertionEvent, type AssertionState,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageAckReasonCode,
  type SwmSenderKeyPackageMsg,
  type WorkspaceRecipientEncryptionKey,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  type MessageIdempotencyStore,
  type ProtocolOutboxStore,
  type ProtocolOutboxEntry,
  encryptV10PublishPayload,
  encryptChunked,
  buildCiphertextChunksRoot,
  computeGossipSigningPayloadV2,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
  type SubscriptionSource,
  SUBSCRIPTION_SOURCES,
  pickNetworkTunables,
  withRetry,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, asChangelogReader, tryReplaceGraphAtomically, type ChangelogReader, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { readChangelogDeltaPage } from './sync/responder/graph-plan.js';
import { decodeChangelogRequest, encodeChangelogResponse } from './sync/changelog/wire.js';
import { runChangelogSync, planPageApply } from './sync/requester/changelog-sync.js';
import {
  authenticateVerifiedGraphScopedAsset,
  materializeVerifiedGraphScopedAsset,
  type VerifiedGraphScopedAsset,
  type VerifyContextGraphBinding,
} from './sync/requester/graph-scoped-materialization.js';
import {
  EVMChainAdapter,
  NoChainAdapter,
  buildKnowledgeAssetUal,
  createRpcTimeoutError,
  enrichEvmError,
  isChainRpcTransportError,
  type ChainAdapter,
  type CreateContextGraphParams,
  type CreateOnChainContextGraphParams,
  type CreateOnChainContextGraphResult,
  type EVMAdapterConfig,
  type TxResult,
  type V10PublishingConvictionAccountInfo,
} from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler, createStorageAckLifecycleObserver, withSignerRegistrationCache,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, skolemizeByEntity, isReservedSubject, computePrivateRootV10 as computePrivateRoot,
  canonicalPublishPayload,
  resolveLiftWorkspaceSlice,
  validateLiftPublishPayload,
  subtractFinalizedExactQuads,
  TripleStoreAsyncLiftPublisher,
  TripleStoreAsyncPromoteQueue,
  FileWorkspacePublicSnapshotStore,
  parseWorkspacePublicSnapshotNQuads,
  type AsyncPromoteQueue, type AsyncPromoteQueueConfig,
  type PromoteJob, type PromoteListFilter,
  wrapAsRpcPreconditionIfApplicable,
  type PublishOptions, type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  type CollectedACK,
  type WorkspaceAgentRecipient,
  type WorkspaceAgentRecipientResolution,
  type WorkspaceAgentRecipientResolverInput,
  type WorkspaceSenderKeyEncryptInput,
  type SharedMemoryPublicSnapshotStorageConfig, type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { join } from 'node:path';
import {
  DKGQueryEngine, QueryHandler,
  emptyQueryResultForKind,
  validateReadOnlySparql,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
import { buildAuthoritativePrivateMetaAskQuery } from './context-graph-private-meta-proof.js';
import { buildAuthoritativePublicMetaAskQuery } from './context-graph-public-meta-proof.js';
import { repairCreatorPublicMetaProjections } from './context-graph-public-meta-repair.js';

import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler, type ChatAclCheck } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, canonicalAgentDidSubject, collectPublishableMultiaddrs, type AgentProfileConfig } from './profile.js';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  type SignedAgentDelegation,
} from './auth/agent-delegation.js';
import {
  SyncVerifyWorker,
  type DurableBatchProcessResult,
  type DurableBatchVerificationMode,
} from './sync-verify-worker.js';
import { classifyDurableMetaGraph } from './sync/durable-integrity.js';
import { bindRandomSampling, type RandomSamplingHandle, type RandomSamplingStatus } from './random-sampling-bind.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { Messenger, type SloProtocolStats } from './p2p/messenger.js';
import { createSingleUseSyncSender } from './p2p/sync-transport.js';
import { NetworkAdmissionService } from './p2p/network-admission.js';
import {
  NetworkAdmissionCoordinator,
  NetworkAdmissionRejectedError,
} from './p2p/network-admission-coordinator.js';
import { createNetworkAdmissionProtocolCheck } from './p2p/network-admission-protocol-adapter.js';
import {
  createCGMemberEnumerator,
  type CGMemberEnumerator,
} from './swm/enumerate-cg-members.js';
import {
  chooseFanOutTier,
  executeSubstrateFanOut,
  classifySendResult,
  FANOUT_RESPONSE_REJECTED,
  FANOUT_RESPONSE_RETRYABLE,
  type FanOutBookkeeper,
  type FanOutPeerRecord,
  type FanOutPlan,
} from './swm/substrate-fanout.js';
import {
  createSwmAckQuorum,
  type SwmAckQuorum,
} from './swm/ack-quorum.js';
import { SwmHostModeStore, type SwmHostModeStoreLimits } from './swm/host-mode-store.js';
import {
  BEACON_ACCESS_POLICY_CURATED,
  BEACON_REANNOUNCE_INTERVAL_MS,
  DKG_CG_DISCOVERY_TOPIC,
  decodeCgDiscoveryBeacon,
  encodeCgDiscoveryBeacon,
  mintCgDiscoveryBeacon,
  verifyCgDiscoveryBeacon,
} from './swm/cg-discovery-beacon.js';
import { DiscoveryRateLimit } from './swm/discovery-rate-limit.js';
import {
  decodeSwmHostCatchupRequest,
  encodeSwmHostCatchupRequest,
  encodeSwmHostCatchupResponse,
  decodeSwmHostCatchupResponse,
  DEFAULT_MAX_BYTES as SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES as SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES,
  SWM_HOST_CATCHUP_WIRE_VERSION,
  type SwmHostCatchupResponseEntry,
} from './swm/host-catchup-wire.js';
import {
  CatchupReplayGuard,
  mintSignedCatchupRequest,
  verifySignedCatchupRequest,
} from './swm/host-catchup-sign.js';
import {
  createCiphertextChunkCatchupReplayGuard,
  decodeCiphertextChunkCatchupRequest,
  encodeCiphertextChunkCatchupRequest,
  encodeCiphertextChunkCatchupResponse,
  decodeCiphertextChunkCatchupResponse,
  mintSignedCiphertextChunkCatchupRequest,
  verifySignedCiphertextChunkCatchupRequest,
  CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
  type CiphertextChunkCatchupRequest,
  type CiphertextChunkCatchupResponse,
} from './swm/ciphertext-chunk-catchup.js';
import { waitForPeerProtocol } from './p2p/protocol-readiness.js';
import { orderCatchupPeers } from './p2p/peer-selection.js';
import { reconcileWarmCoreConnections, type WarmCoreAgent } from './p2p/warm-core-connections.js';
import { fetchSyncPages, type SyncPageResult } from './sync/requester/page-fetch.js';
import { requireExactAssetUals } from './sync/exact-assets.js';
import { insertWithOversizeGuard, type OversizeGuardHooks } from './sync/oversize-filter.js';
import { runOversizeSweep } from './sync/oversize-sweep.js';
import { getSyncCheckpointKey } from './sync/checkpoint/state.js';
import {
  createContextGraphSyncDeadline,
  createDurableSyncBudget,
  EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS,
  normalizeDurableSyncTimeoutMs,
} from './sync/requester/durable-sync-budget.js';
import {
  runDurableSync,
  type VerifiedFullSnapshot,
} from './sync/requester/durable-sync.js';
import { resolveSyncAgentsMeta, shouldWithholdAgentsDurableMeta } from './sync/agents-meta-policy.js';
import { runSharedMemorySync, sharedMemoryOwnershipKeyFromGraph } from './sync/requester/shared-memory-sync.js';
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
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import {
  registerSyncHandler,
  resolveSyncResponderSnapshotPolicy,
} from './sync/responder/sync-handler.js';
import { runSyncOnConnect, SyncOnConnectPostSyncError, type SyncOnConnectOutcome, type SyncOnConnectPeerOutcome } from './sync/on-connect/sync-on-connect.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import { CATCHUP_MAX_CONCURRENT_PEER_SYNCS } from './sync/catchup-concurrency.js';
import {
  runCatchupPlanesWithPolicy,
  type CatchupMode,
} from './sync/catchup-policy.js';
import {
  classifyDurableProgress,
  createDurableSyncAccumulator,
  createFailedPeerDurableSyncResult,
  createIncompleteDurableSyncResult,
  durableSyncAccumulatorHasBackoffWorthyFailure,
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
  resolveNonNegativeIntegerSwitch,
  resolveSyncGlobalBackpressure,
  withGlobalSyncBackpressure,
} from './sync/backpressure.js';
import {
  contextGraphPriority,
  countSyncPriorityClasses,
  orderContextGraphIdsByPriority,
  syncPriorityClass,
  type SyncSchedulerLane,
} from './sync/policy.js';
import {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  ensureWorkspaceEncryptionKey,
  hashAgentToken,
  activeWorkspaceEncryptionKeys,
  appendCustodialWorkspaceEncryptionKey,
  revokeCustodialWorkspaceEncryptionKey,
  attachRevocationToWorkspaceEncryptionKey,
  migrateLegacyWorkspaceEncryptionFields,
  refreshDefaultEncryptionKeyView,
  type AgentKeyRecord,
  type KeystoreEntry,
  type WorkspaceEncryptionKeyEntry,
} from './agent-keystore.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler, KEEP_ROOT_COPY_PREDICATE } from './finalization-handler.js';
import { reconcileContextGraph, RecentUalSet, type ChainReconcilerDeps, type OrdinalOutcome } from './chain-reconciler.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
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
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import {
  strip, stripLiteral, jsonLdToQuads,
  type JsonLdContent,
} from './dkg-agent-utils.js';
import {
  PRIVATE_DATA_ANCHOR,
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_PAGE_RETRY_ATTEMPTS,
  SYNC_TOTAL_TIMEOUT_MS,
  SYNC_PAGE_TIMEOUT_MS,
  SYNC_ROUTER_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_ATTEMPTS,
  SYNC_PROTOCOL_CHECK_DELAY_MS,
  SYNC_AUTH_MAX_AGE_MS,
  JOIN_DELEGATION_VALIDITY_MS,
  JOIN_REQUEST_SEND_TIMEOUT_MS,
  SYNC_ACCESS_DENIED_MARKER,
  LOCAL_ACCESS_OPEN,
  LOCAL_ACCESS_CURATED,
  EVM_PUBLISH_CURATED,
  EVM_PUBLISH_OPEN,
  MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS,
  META_REFRESH_COOLDOWN_MS,
  DEBUG_SYNC_PROGRESS,
  DEFAULT_SWM_TTL_MS,
  SWM_CLEANUP_INTERVAL_MS,
  SYNC_DENIED_RESPONSE,
  GOSSIP_DIAL_COOLDOWN_MS,
  GOSSIP_DIAL_TIMEOUT_MS,
  CATCHUP_ON_CONNECT_COOLDOWN_MS,
  SYNC_RECONNECT_FLAP_GRACE_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_MAX_MS,
  SYNC_BACKOFF_JITTER,
  RANDOM_SAMPLING_BIND_RETRY_MS,
  STORAGE_ACK_REGISTRATION_RETRY_MS,
  JOIN_APPROVAL_RETRY_TICK_MS,
  MESSAGE_OUTBOX_TICK_MS,
  AGENT_PROFILE_HEARTBEAT_MS,
  AGENT_PROFILE_STALE_THRESHOLD_MS,
  WARM_CORE_CONNECTIONS_ENABLED,
  WARM_CORE_RECONCILE_INTERVAL_MS,
  WARM_CORE_MAX,
  WARM_CORE_KEEPALIVE_TAG,
  WARM_CORE_DIAL_TIMEOUT_MS,
  CIPHERTEXT_CHUNK_SIZE_BYTES,
  BOOT_CHAIN_IDENTITY_TIMEOUT_MS,
  MIN_STORAGE_ACK_REGISTRATION_RETRY_MS,
  TIMEOUT_SENTINEL,
  ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS,
  CHAIN_POLICY_READ_TIMEOUT_MS,
  SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
} from './dkg-agent-constants.js';
import { raceWithBootTimeout, isTransientBootChainError } from './dkg-agent-boot.js';
import * as diagnostics from './dkg-agent-diagnostics.js';
import {
  ContextGraphNotFoundError,
  InvalidContentError,
  StaleSenderKeyTargetError,
  SwmSenderKeySetupRejectionError,
  SyncAccessDeniedError,
  type PreSignedAuthorAttestation,
  type LocalSwmSenderKeySendState,
  type LocalSwmSenderKeyReceiveState,
  type PendingSenderKeyEntry,
  type RandomSamplingStartResult,
  type ACKSignerResolution,
  type SyncRequestEnvelope,
  type CclPublishedResultEntry,
  type CclPublishedEvaluationRecord,
  type PublishOpts,
  type PublishAsyncOpts,
  type PublishAsyncQuadEnvelope,
  type PublishAsyncContent,
  type PeerHealth,
  type PeerConnectionSnapshot,
  type PeerDiagnostics,
  type ChatSendResult,
  type ContextGraphSub,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionRehydrationStatus,
  type ContextGraphSubscriptionStore,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type DKGAgentConfig,
  type ReplicationEvent,
  type SyncReconcilerProbe,
  type SyncReconcilerBackoff,
} from './dkg-agent-types.js';
import {
  normalizePublishContextGraphId,
  isPublishAsyncQuadEnvelope,
  assertQuadArray,
  normalizeAgentDid,
  joinDelegationScope,
  normalizeSyncPhase,
  normalizeAdapterPublisherAddress,
  recoverCompactSigner,
  adapterOperationalPrivateKeyAddress,
  adapterHasOperationalPrivateKey,
  adapterGenericSignMessageMatchesAddress,
  adapterAdvertisesPublisherSigner,
  privateKeyAddress,
  inferAdapterPublisherAddress,
  defaultLargeLiteralStorage,
  createPublicSnapshotStore,
  applyDefaultLargeLiteralStorage,
  isLocalOxigraphConfig,
  sliceIntoCiphertextChunks,
} from './dkg-agent-helpers.js';
import {
  swmSenderStateKey,
  swmReceiverStateKey,
  serializeSwmSenderSendState,
  serializeSwmSenderReceiveState,
  serializePendingSenderKeyEntry,
  deserializeSwmSenderSendState,
  deserializeSwmSenderReceiveState,
  deserializePendingSenderKeyEntry,
} from './dkg-agent-swm-state.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { deterministicStartupJitterMs, scheduleAfterStartupJitter } from './startup-jitter.js';

const DEFAULT_HOST_MODE_RECONCILE_JITTER_RATIO = 0.15;
type InFlightSyncPageFetch = {
  promise: Promise<SyncPageResult>;
  controller: AbortController;
  waiters: number;
};
type ContextGraphCatchupResult = Awaited<ReturnType<DKGAgent['runCatchupOverPeers']>>;

const inFlightSyncPageFetchesByAgent = new WeakMap<DKGAgent, Map<string, InFlightSyncPageFetch>>();
const inFlightSyncSingleFlightsByAgent = new WeakMap<DKGAgent, Map<string, Promise<unknown>>>();
const alreadyMemberDelegationRefreshChains = new WeakMap<DKGAgent, Map<string, Promise<void>>>();
const durableContextGraphSyncChains = new WeakMap<DKGAgent, Map<string, Promise<void>>>();

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
  assetUals?: readonly string[];
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
    params.assetUals ?? null,
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

function runSyncSingleFlight<T>(
  agent: DKGAgent,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  let inFlight = inFlightSyncSingleFlightsByAgent.get(agent);
  if (!inFlight) {
    inFlight = new Map();
    inFlightSyncSingleFlightsByAgent.set(agent, inFlight);
  }
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
  inFlight.set(key, promise);
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
  exactAssetUals?: readonly string[];
  priority?: number;
}): string | null {
  if (
    params.hasPhaseCallback
    || params.hasAtomicCommitCallback
    || params.hasAccessDeniedCallback
    || params.hasSinceBatchIdResolver
    || params.hasSignal
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
    priority: params.priority ?? null,
  });
}

function sharedMemorySyncSingleFlightKey(params: {
  remotePeerId: string;
  contextGraphIds: readonly string[];
  stopOnBackoffWorthyFailure?: boolean;
  publicContextGraphIds: readonly string[];
  privateRecoverFromCurator: readonly string[];
  priority?: number;
}): string {
  return syncSingleFlightKey('shared-memory-sync', {
    remotePeerId: params.remotePeerId,
    contextGraphIds: params.contextGraphIds,
    stopOnBackoffWorthyFailure: params.stopOnBackoffWorthyFailure === true,
    publicContextGraphIds: params.publicContextGraphIds,
    privateRecoverFromCurator: params.privateRecoverFromCurator,
    priority: params.priority ?? null,
  });
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

function createDurableSyncOperationBoundary(options: {
  totalTimeoutMs?: number;
  signal?: AbortSignal;
}): {
  deadline?: number;
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (options.totalTimeoutMs === undefined) {
    return {
      signal: options.signal,
      dispose: () => {},
    };
  }

  const timeoutMs = normalizeDurableSyncTimeoutMs(options.totalTimeoutMs);
  const deadline = Date.now() + timeoutMs;
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
  publicContextGraphIds: string[];
  privateRecoverFromCurator: string[];
  eligibleContextGraphIds: string[];
};

type RecoverContextGraphSwmOptions = Parameters<typeof recoverContextGraphSwm>[0];

interface RecoverContextGraphSwmFromPeerDependencies {
  store: TripleStore;
  listSubGraphs: (contextGraphId: string) => ReturnType<DKGAgent['listSubGraphs']>;
  createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  fetchSyncPages: RecoverContextGraphSwmOptions['fetchSyncPages'];
  processSharedMemoryBatch: RecoverContextGraphSwmOptions['processSharedMemoryBatch'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  isGraphAssetMaterialized: NonNullable<RecoverContextGraphSwmOptions['isGraphAssetMaterialized']>;
  recordDrops: OversizeGuardHooks['recordDrops'];
  invalidateListContextGraphsCache: () => void;
  markMetaProjectionDirty: (quads: Quad[]) => void;
  setCheckpoint: RecoverContextGraphSwmOptions['setCheckpoint'];
  deleteCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  ensureOwnedMap: RecoverContextGraphSwmOptions['ensureOwnedMap'];
  logInfo: NonNullable<RecoverContextGraphSwmOptions['logInfo']>;
  logWarn: NonNullable<RecoverContextGraphSwmOptions['logWarn']>;
}

type SyncReconcilerAttemptOutcome = SyncOnConnectOutcome | 'not-started' | 'deferred-backpressure';

export interface ContextGraphCatchupOptions {
  includeSharedMemory?: boolean;
  maxPeers?: number;
  peerRotationKey?: string;
  /**
   * Foreground mode receives scheduler priority and bounded local-deferral
   * retries. Background mode remains best-effort and never waits for capacity.
   */
  mode?: CatchupMode;
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
   * Cancels the whole durable operation. Paging and graph-scoped chain
   * authentication observe the signal directly; verification and atomic
   * materialization check it before any subsequent commit boundary.
   */
  signal?: AbortSignal;
  /**
   * Called synchronously after graph-scoped authentication succeeds and
   * immediately before atomic materialization is dispatched. This is a
   * settlement boundary, not a generic progress callback.
   */
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  /** Internal VM-recovery filter; only these locally-missing KAs are stored. */
  exactAssetUals?: string[];
  /** Admission override for foreground VM recovery. */
  priority?: number;
};

type LegacyDurableContextGraphOptions = {
  onPhase?: PhaseCallback;
  onAtomicCommitStarted?: (contextGraphId: string, ual: string) => void;
  onAccessDenied?: (contextGraphId: string) => void;
  sinceBatchIdFor?: (contextGraphId: string) => string | undefined;
  stopOnBackoffWorthyFailure?: boolean;
  onVerifiedFullSnapshot?: (snapshot: VerifiedFullSnapshot) => Promise<void>;
  fetchTimeoutMs?: number;
  exactAssetUals?: string[];
  authenticationTimeoutMs?: number;
  operationDeadline?: number;
  signal?: AbortSignal;
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
  return resolveBooleanSwitch(config.syncReconcilerEnabled, 'DKG_SYNC_RECONCILER_ENABLED', true);
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
  };
}

function mergeSharedMemorySyncResults(
  a: SharedMemorySyncResult,
  b: SharedMemorySyncResult,
): SharedMemorySyncResult {
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
  async runContextGraphSyncWithBackpressure<T>(this: DKGAgent,
    ctx: OperationContext,
    contextGraphId: string,
    lane: SyncSchedulerLane,
    label: string,
    work: () => Promise<T>,
    priorityOverride?: number,
    operationSignal?: AbortSignal,
  ): Promise<T> {
    const priority = priorityOverride
      ?? contextGraphPriority(this.config.syncContextGraphPriorities, contextGraphId);
    const admissionBoundary = combineSyncAdmissionSignals(
      this.node.stopSignal ?? undefined,
      operationSignal,
    );
    try {
      return await withGlobalSyncBackpressure(
        {
          policy: resolveSyncGlobalBackpressure(this.config),
          ctx,
          label,
          contextGraphId,
          lane,
          priority,
          priorityClass: syncPriorityClass(priority),
          signal: admissionBoundary.signal,
          logInfo: (opCtx, message) => this.log.info(opCtx, message),
        },
        work,
      );
    } finally {
      admissionBoundary.dispose();
    }
  }

  async start(this: DKGAgent): Promise<void> {
    if (this.started) return;
    this.coreHostRecordingGeneration += 1;
    this.coreHostRecordingsClosed = false;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    // OT-RFC-64: persistent inventory ownership and the complete bounded
    // startup purge precede node.start(), protocol registration, and every
    // network consumer. No dataDir intentionally leaves the feature dormant.
    await this.prepareRfc64PersistenceV1();
    try {
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
      isPeerAccepted: createNetworkAdmissionProtocolCheck(this.networkAdmissionCoordinator),
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
      // The dial fast-path (ProtocolRouter) already prefers
      // PeerResolver.resolve() on every attempt, but the outbox
      // stall-walk (the Messenger peer-recovery scheduler) was hardcoded
      // to a DHT-only path — so an entry that timed out 5x because
      // its addresses were stale couldn't recover by consulting
      // agents-CG. Routing through PeerResolver picks up the
      // phonebook fallback automatically; the raw findPeer call
      // remains the step-2 DHT lookup inside resolve(), so we don't
      // lose any pre-existing recovery path.
      resolvePeer: async (peerId, { signal }) => {
        await peerResolver.resolve(peerId, { signal }).catch(() => undefined);
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
    this.startRfc64PublicCatalogServiceV1(ctx);
    this.startRfc64PublicCatalogBootstrapV1(ctx);

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
                const syncPressure = getSyncBackpressureSnapshot(resolveSyncGlobalBackpressure(this.config));
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

          // Bind an already-explicit cleartext subscription directly from the
          // chain event's name commitment. Public CGs do not enter the curated
          // host-mode block below, so without this store-free comparison a cold
          // receiver could know the right graph name yet remain dependent on an
          // ontology triple that durable sync has not materialized.
          if (nameHash) {
            this.bindOnChainContextGraphIdFromNameHash(nameHash, contextGraphId);
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
          if (nameHash && accessPolicy === 1) {
            // Register the wire id → numeric id mapping so the receive
            // path's chain fallback resolver (Scope A) can take a hash
            // input and find the on-chain participant agents without an
            // RPC round-trip per envelope.
            const hashLower = this.contextGraphWireId(nameHash);
            const indexedLocalId = this.wireIdToLocalCgId.get(hashLower);
            const localId = indexedLocalId ?? hashLower;
            // Stage a synthetic subscription record for the host-only
            // case: cores hosting CGs they never joined have no
            // cleartext; the hash IS their local id. `recordCgWireId`
            // would no-op on this without a pre-existing record, so
            // upsert a minimal stub first.
            if (!this.subscribedContextGraphs.has(localId)) {
              this.setContextGraphSubscription(localId, {
                subscribed: false,
                synced: false,
                onChainHash: hashLower,
                pendingMeta: true,
              }, { persist: false });
            } else if (indexedLocalId === undefined) {
              // A local subscription already uses the event's hash as its
              // cleartext id, but did not explicitly claim wire-id identity.
              // Treat this as an ambiguous hash-shaped-name collision instead
              // of rebinding or auto-hosting the unrelated on-chain graph.
              this.log.warn(
                ctx,
                `Skipping host-mode auto-subscribe for ${hashLower.slice(0, 18)}…: ` +
                  'the same string is already used by an uncommitted local CG id',
              );
              return;
            }
            this.bindOnChainContextGraphIdFromNameHash(
              hashLower,
              contextGraphId,
              { persist: false },
            );

            // Delegate to the host-mode reconciler — it owns the
            // sharding-table check, swmHostMode flag, and the wire-up
            // of the host-mode gossip handler. Async + best-effort:
            // the periodic reconciler covers the timer-driven fallback
            // path, so a missed event here heals on the next sweep.
            void this.reconcileSwmHostModeSubscription(
              localId,
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
    const syncGlobalPolicy = resolveSyncGlobalBackpressure(this.config);
    const configuredPriorityCounts = countSyncPriorityClasses(this.config.syncContextGraphPriorities);
    this.log.info(ctx, `Resolved sync policy ${JSON.stringify({
      snapshotGlobalRows: snapshotPolicy.budget.maxRows,
      snapshotGlobalBytesEstimate: snapshotPolicy.budget.maxBytesEstimate,
      snapshotLocalRows: snapshotPolicy.budget.maxSnapshotRows,
      snapshotLocalBytesEstimate: snapshotPolicy.budget.maxSnapshotBytesEstimate,
      syncGlobalInflightLimit: syncGlobalPolicy.limit ?? 0,
      syncGlobalQueueLimit: syncGlobalPolicy.queueLimit ?? 0,
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
            );
            if (!decisionApplied) {
              this.log.warn(
                createOperationContext('system'),
                `Dropping join-approved for "${contextGraphId}" from ${peerId.toString()} — request generation is stale, unknown, or already terminal`,
              );
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            const approvedSubscription: ContextGraphSub = {
              ...this.subscribedContextGraphs.get(contextGraphId),
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
      this.subscribeToContextGraph(systemContextGraph);
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

    // On new peer connection, request sync of system context graphs so we discover
    // agents that published their profiles before we came online.
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
          return;
        }
        if (!admitted) return;
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

    // Start periodic SWM maintenance. TTL expiry may be disabled, but exact
    // finalized graph-scoped copies still need bounded idle cleanup.
    this.cleanupExpiredSharedMemory().catch(() => {});
    this.swmCleanupTimer = setInterval(() => {
      this.cleanupExpiredSharedMemory().catch(() => {});
    }, SWM_CLEANUP_INTERVAL_MS);
    if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();

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
      this.syncReconcilerTimer = setInterval(() => {
        this.reconcileSyncFromConnectedPeers().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Sync reconciler tick failed: ${message}`);
        });
      }, SYNC_RECONCILER_INTERVAL_MS);
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

    // Phase B — chain-driven VM reconciliation. The coalescer collapses a burst
    // of live KACG nudges for a CG into a single sweep; the periodic timer is
    // the safety net that backfills missed events / transient fetch failures and
    // catches up late subscribers (the "Monday Fun Facts" case). Only armed when
    // the chain adapter exposes the per-CG registration-ordinal reads.
    if (this.vmReconcileEnabled()) {
      this.ensureVmReconcileDispatcher();
      const runSweep = (): void => {
        this.runVmReconcileSweep().catch((err: unknown) => {
          this.log.warn(ctx, `VM reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      // Prime once after a deterministic per-peer delay. A simultaneous
      // four-node cold rollout must not turn into four synchronized Oxigraph
      // scans; keeping this deterministic also makes restart behaviour and
      // regression tests reproducible.
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

    // Wire V10 Random Sampling prover. Edge nodes no-op. Core nodes with
    // transient identity/RPC startup failures retry in the background so
    // one flaky `getIdentityId()` call does not disable proving until the
    // next process restart.
    const rsStart = await this.tryStartRandomSamplingProver(ctx, true);
    if (rsStart === 'retryable') {
      this.scheduleRandomSamplingBindRetry(ctx);
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
      const handle = await bindRandomSampling({
        role: rsRole,
        chain: this.chain,
        store: this.store,
        identityId: rsIdentityId,
        walPath: this.config.randomSamplingWalPath,
        useWorkerThread: this.config.randomSamplingUseWorkerThread ?? true,
        tickIntervalMs: this.config.randomSamplingTickIntervalMs,
        log: this.randomSamplingLogger(ctx),
      });
      if (this.randomSamplingHandle && this.randomSamplingHandle !== handle) {
        try { await this.randomSamplingHandle.stop(); } catch { /* swallow bind replacement cleanup */ }
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
    this.lastSyncDisconnectedAt.delete(remotePeer);
    this.lastSuccessfulSyncAt.delete(remotePeer);
    this.lastSyncProgressAt.delete(remotePeer);
    this.syncReconcilerBackoff.delete(remotePeer);
    this.warmedCores.delete(remotePeer);
    this.warmCoreFailedUnpins.delete(remotePeer);
  }

  queueSyncFromPeerOnConnect(
    this: DKGAgent,
    remotePeer: string,
    handleSyncError: (remotePeer: string, err: unknown) => void,
    delayMs = 3000,
  ): boolean {
    if (!syncOnConnectEnabled(this.config)) {
      return false;
    }
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(remotePeer)) {
      return false;
    }
    const now = Date.now();
    const disconnectBoundary = this.syncOnConnectDisconnectBoundary(remotePeer, now);
    const lastSuccessfulSync = this.lastSuccessfulSyncAt.get(remotePeer);
    if (
      lastSuccessfulSync != null &&
      lastSuccessfulSync > disconnectBoundary &&
      now - lastSuccessfulSync < SYNC_STALENESS_THRESHOLD_MS
    ) {
      return false;
    }

    const lastQueued = this.catchupOnConnectAt.get(remotePeer) ?? 0;
    if (lastQueued > disconnectBoundary && now - lastQueued < CATCHUP_ON_CONNECT_COOLDOWN_MS) {
      return false;
    }

    const backoff = this.syncReconcilerBackoff.get(remotePeer);
    if (backoff && now < backoff.nextRetryAt) {
      return false;
    }

    this.catchupOnConnectAt.set(remotePeer, now);
    setTimeout(() => {
      this.runSyncFromPeerOnConnect(remotePeer, handleSyncError).catch((err: unknown) => {
        handleSyncError(remotePeer, err);
      });
    }, delayMs);
    return true;
  }

  async runSyncFromPeerOnConnect(
    this: DKGAgent,
    remotePeer: string,
    handleSyncError: (remotePeer: string, err: unknown) => void,
  ): Promise<void> {
    if (!syncOnConnectEnabled(this.config)) {
      return;
    }
    const now = Date.now();
    const backoff = this.syncReconcilerBackoff.get(remotePeer);
    if (backoff && now < backoff.nextRetryAt) return;

    const probe = await this.getSyncReconcilerProbe(remotePeer);
    try {
      await this.attemptSyncFromPeerWithReconcilerAccounting(remotePeer, probe);
    } catch (err: unknown) {
      handleSyncError(remotePeer, err);
    }
  }

  async attemptSyncFromPeerWithReconcilerAccounting(
    this: DKGAgent,
    remotePeer: string,
    probe: SyncReconcilerProbe,
  ): Promise<SyncReconcilerAttemptOutcome> {
    const lastOk = this.lastSuccessfulSyncAt.get(remotePeer);
    const lastProgress = this.lastSyncProgressAt.get(remotePeer);
    let syncAccountingClearedBackoff = false;
    try {
      const outcome = await this.trySyncFromPeer(remotePeer, () => {
        syncAccountingClearedBackoff = true;
      });
      if (outcome === 'deferred-backpressure') {
        this.log.info(
          createOperationContext('sync'),
          `Deferring sync from peer ${remotePeer.slice(-8)} due to local backpressure`,
        );
        return outcome;
      }
      if (
        outcome !== 'skipped-no-sync' &&
        outcome !== 'already-syncing' &&
        outcome !== 'not-started' &&
        !syncAccountingClearedBackoff &&
        this.lastSuccessfulSyncAt.get(remotePeer) === lastOk &&
        this.lastSyncProgressAt.get(remotePeer) === lastProgress
      ) {
        this.recordSyncReconcilerFailure(remotePeer, probe);
      }
      return outcome;
    } catch (err: unknown) {
      const backpressureError = getSyncBackpressureBusyError(err);
      if (backpressureError) {
        this.log.info(
          createOperationContext('sync'),
          `Deferring sync from peer ${remotePeer.slice(-8)} due to local backpressure: ${backpressureError.message}`,
        );
        return 'deferred-backpressure';
      }
      if (err instanceof SyncOnConnectPostSyncError) {
        if (err.backoffEligible) {
          this.recordSyncReconcilerFailure(remotePeer, probe);
        }
      } else {
        this.recordSyncReconcilerFailure(remotePeer, probe);
      }
      throw err;
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
  ): Promise<SyncOnConnectOutcome | 'not-started'> {
    if (!this.started) {
      return 'not-started';
    }
    if (!syncOnConnectEnabled(this.config)) {
      return 'not-started';
    }
    if (!this.networkAdmissionCoordinator.isAcceptedPeer(remotePeer)) {
      return 'not-started';
    }
    const sharedMemorySyncPlans = new Map<string, Promise<SharedMemorySyncContextGraphPlan>>();
    const getSharedMemorySyncPlan = (peerId: string): Promise<SharedMemorySyncContextGraphPlan> => {
      let plan = sharedMemorySyncPlans.get(peerId);
      if (!plan) {
        plan = this.planSharedMemorySyncContextGraphs(
          peerId,
          this.config.syncContextGraphs ?? [],
          createOperationContext('sync'),
        );
        sharedMemorySyncPlans.set(peerId, plan);
      }
      return plan;
    };
    return runSyncOnConnect({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      knownCorePeerIds: this.knownCorePeerIds,
      knownCorePeerIdsV2: this.knownCorePeerIdsV2,
      getSyncContextGraphs: () => this.config.syncContextGraphs ?? [],
      getSharedMemorySyncContextGraphs: async (peerId) => (await getSharedMemorySyncPlan(peerId)).eligibleContextGraphIds,
      syncFromPeer: (peerId, contextGraphIds) => this.syncFromPeerDetailed(
        peerId,
        contextGraphIds ?? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
        undefined,
        undefined,
        undefined,
        { stopOnBackoffWorthyFailure: true },
      ),
      refreshMetaSyncedFlags: (contextGraphIds) => this.refreshMetaSyncedFlags(contextGraphIds),
      discoverContextGraphsFromStore: () => this.discoverContextGraphsFromStore(),
      syncSharedMemoryFromPeer: async (peerId, contextGraphIds) => this.syncSharedMemoryFromPeerDetailed(peerId, contextGraphIds, {
        stopOnBackoffWorthyFailure: true,
        sharedMemorySyncPlan: await getSharedMemorySyncPlan(peerId),
      }),
      syncSharedMemoryOnConnect: syncOnConnectEnabled(this.config) && (this.config.syncSharedMemoryOnConnect ?? true),
      logInfo: (ctx, message) => this.log.info(ctx, message),
      onPeerSkippedNoSync: (peerId) => {
        this.skippedNoSyncPeers.add(peerId);
      },
      onPeerSynced: (peerId, outcome) => {
        const progressAt = Math.max(Date.now(), (this.lastSyncProgressAt.get(peerId) ?? 0) + 1);
        if (outcome?.progress) {
          this.lastSyncProgressAt.set(peerId, progressAt);
        }
        if (outcome?.fresh ?? true) {
          this.lastSuccessfulSyncAt.set(peerId, progressAt);
        }
        this.skippedNoSyncPeers.delete(peerId);
        this.syncReconcilerBackoff.delete(peerId);
        if (outcome) {
          onSyncAccounting?.(outcome);
        }
      },
    });
  }

  async planSharedMemorySyncContextGraphs(
    this: DKGAgent,
    remotePeerId: string | undefined,
    contextGraphIds: readonly string[],
    ctx: OperationContext,
  ): Promise<SharedMemorySyncContextGraphPlan> {
    // M2 (curator-leader convergence): a PRIVATE CG converges by REPLACE-recovering the
    // current state from its CURATOR (the authoritative SWM replica), never the
    // bidirectional mesh union-sync — which corrupts a reconnecting member into {old,new}
    // AND pollutes the curator back (proven on devnet). PUBLIC CGs keep the union path
    // (correct for cold-start / empty target).
    const publicContextGraphIds: string[] = [];
    const privateRecoverFromCurator: string[] = [];
    const eligibleContextGraphIds: string[] = [];
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
      if (!(await this.canUseSharedMemoryForContextGraph(contextGraphId))) {
        this.log.warn(ctx, `Skipping SWM sync for unauthorized or unconfirmed context graph "${contextGraphId}"`);
        continue;
      }
      if (await this.isPrivateContextGraph(contextGraphId)) {
        if (!remotePeerId) {
          eligibleContextGraphIds.push(contextGraphId);
          continue;
        }
        // The curator (curator-leader) is the authoritative SWM replica; it never
        // reverse-syncs a CG it owns. Decide curatorship AND resolve the curator's
        // peer by the STRUCTURAL curator — the wallet-scoped id prefix `0x<addr>` —
        // NOT the dkg:curator/dkg:creator triples. A member that locally pre-created
        // the CG (the rfc38 multi-member onboarding pattern) self-stamps its OWN
        // wallet as a dkg:curator triple and its OWN peer as dkg:creator, which makes
        // BOTH isCuratorOf() and resolveCuratorPeerId() resolve the member AS the
        // curator — so the gate would skip the member's own recovery and it would
        // silently never converge (a zero-byte-core durability failure). The id
        // prefix is authoritative; only the node owning that agent is the curator.
        const structuralCuratorDid = deriveCuratorDidFromCgId(contextGraphId);
        if (structuralCuratorDid) {
          const structuralAgent = structuralCuratorDid.slice('did:dkg:agent:'.length).toLowerCase();
          if ([...this.localAgents.keys()].some((addr) => addr.toLowerCase() === structuralAgent)) {
            this.log.debug(ctx, `SWM sync: skipping "${contextGraphId}" — local node is the curator (never reverse-syncs a CG it owns)`);
            continue;
          }
          // Resolve the structural curator's peer via the agent registry. On a
          // reconnect the registry may not be populated yet, so refresh meta once.
          let curatorPeers = await resolveAgentPeers(structuralAgent);
          if (curatorPeers.length === 0) {
            await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
            cachedAgents = undefined; // force a fresh registry read after the refresh
            curatorPeers = await resolveAgentPeers(structuralAgent);
          }
          if (curatorPeers.length === 0) {
            this.log.info(ctx, `SWM recovery skipped for private CG "${contextGraphId.slice(0, 28)}": curator (${structuralAgent.slice(0, 10)}) peer not resolved yet`);
          } else if (!curatorPeers.includes(remotePeerId)) {
            this.log.info(ctx, `SWM recovery deferred for private CG "${contextGraphId.slice(0, 28)}": connecting peer ${remotePeerId.slice(0, 12)} is not among the curator's ${curatorPeers.length} registered peer(s)`);
          } else {
            this.log.info(ctx, `SWM recovery ENQUEUED for private CG "${contextGraphId.slice(0, 28)}" from curator peer ${remotePeerId.slice(0, 12)}`);
            privateRecoverFromCurator.push(contextGraphId);
            eligibleContextGraphIds.push(contextGraphId);
          }
          continue;
        }
        // Legacy non-wallet-scoped CG (no structural curator): fall back to the
        // triple-based curator resolution.
        if (await this.isCuratorOf(contextGraphId)) {
          this.log.debug(ctx, `SWM sync: skipping "${contextGraphId}" — local node is the curator (never reverse-syncs a CG it owns)`);
          continue;
        }
        let curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
        if (!curatorPeerId) {
          await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
          curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
        }
        if (!curatorPeerId) {
          this.log.info(ctx, `SWM recovery skipped for private CG "${contextGraphId.slice(0, 28)}": curator peerId not resolved`);
        } else if (localPeerId && curatorPeerId === localPeerId) {
          this.log.info(ctx, `SWM recovery skipped for private CG "${contextGraphId.slice(0, 28)}": local node resolves AS the curator`);
        } else if (curatorPeerId !== remotePeerId) {
          this.log.info(ctx, `SWM recovery deferred for private CG "${contextGraphId.slice(0, 28)}": connecting peer is not the curator`);
        } else {
          this.log.info(ctx, `SWM recovery ENQUEUED for private CG "${contextGraphId.slice(0, 28)}" from curator ${curatorPeerId.slice(0, 12)}`);
          privateRecoverFromCurator.push(contextGraphId);
          eligibleContextGraphIds.push(contextGraphId);
        }
        continue;
      }
      publicContextGraphIds.push(contextGraphId);
      eligibleContextGraphIds.push(contextGraphId);
    }
    return { publicContextGraphIds, privateRecoverFromCurator, eligibleContextGraphIds };
  }

  async getSharedMemorySyncContextGraphs(this: DKGAgent, remotePeerId?: string): Promise<string[]> {
    const plan = await this.planSharedMemorySyncContextGraphs(
      remotePeerId,
      this.config.syncContextGraphs ?? [],
      createOperationContext('sync'),
    );
    return plan.eligibleContextGraphIds;
  }

  async ensurePeerAdmittedForRecovery(
    this: DKGAgent,
    peerId: string,
    ctx: OperationContext,
    label: string,
  ): Promise<boolean> {
    if (this.networkAdmissionCoordinator.isAcceptedPeer(peerId)) return true;
    if (this.networkAdmissionCoordinator.isRejectedPeer(peerId)) return false;
    try {
      return await this.networkAdmissionCoordinator.ensureAdmitted(peerId, ctx);
    } catch (err: unknown) {
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
        this.trySyncFromPeer(peerId).catch((err: unknown) => {
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
      const stale = lastSyncCooldown === 0
        || lastSyncCooldown <= lastDisconnected
        || (now - lastSyncCooldown) >= SYNC_STALENESS_THRESHOLD_MS;
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
      this.attemptSyncFromPeerWithReconcilerAccounting(peerId, probe)
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
    this.syncCheckpoints.pruneExpired?.(now);
    const connected = new Set(this.node.libp2p.getPeers().map((pid) => pid.toString()));
    for (const [peerId, ts] of this.catchupOnConnectAt) {
      if (!connected.has(peerId) && now - ts >= SYNC_STALENESS_THRESHOLD_MS) {
        this.catchupOnConnectAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSyncDisconnectedAt) {
      if (now - ts >= SYNC_STALENESS_THRESHOLD_MS) {
        this.lastSyncDisconnectedAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSuccessfulSyncAt) {
      if (!connected.has(peerId) && now - ts >= SYNC_STALENESS_THRESHOLD_MS) {
        this.lastSuccessfulSyncAt.delete(peerId);
      }
    }
    for (const [peerId, ts] of this.lastSyncProgressAt) {
      if (!connected.has(peerId) && now - ts >= SYNC_STALENESS_THRESHOLD_MS) {
        this.lastSyncProgressAt.delete(peerId);
      }
    }
    for (const [peerId, backoff] of this.syncReconcilerBackoff) {
      if (!connected.has(peerId) && now >= backoff.nextRetryAt + SYNC_STALENESS_THRESHOLD_MS) {
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

  /**
   * Grow the per-peer sync-reconciler backoff after an attempt that did
   * not produce a successful sync. `nextRetryAt` advances by
   * `SYNC_BACKOFF_BASE_MS * 2^(failures-1)` (capped at
   * `SYNC_BACKOFF_MAX_MS`) with ±`SYNC_BACKOFF_JITTER` randomisation to
   * de-correlate retries across peers. Reset to absent on successful
   * progress / denial-only clean response (`onPeerSynced`). Disconnect
   * no longer clears this immediately; stale disconnected entries are
   * pruned by `pruneSyncReconcilerState`.
   */
  recordSyncReconcilerFailure(this: DKGAgent, peerId: string, probe: SyncReconcilerProbe): void {
    if (!this.started || !this.isPeerConnectedForSyncBackoff(peerId)) return;
    const failures = (this.syncReconcilerBackoff.get(peerId)?.failures ?? 0) + 1;
    // Clamp the exponent so `2 ** exp` can never overflow before the cap.
    const exp = Math.min(failures - 1, 30);
    const delay = Math.min(SYNC_BACKOFF_BASE_MS * 2 ** exp, SYNC_BACKOFF_MAX_MS);
    const jittered = delay * (1 + (Math.random() * 2 - 1) * SYNC_BACKOFF_JITTER);
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
    const syncAgentsMeta = resolveSyncAgentsMeta(this.config.syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META);
    const stopOnBackoffWorthyFailure = options?.stopOnBackoffWorthyFailure;
    const operationBoundary = createDurableSyncOperationBoundary({
      totalTimeoutMs: options?.totalTimeoutMs,
      signal: options?.signal,
    });
    const authenticationTimeoutMs = normalizeDurableSyncTimeoutMs(options?.totalTimeoutMs);
    const fetchTimeoutMs = options?.exactAssetUals && options.totalTimeoutMs === undefined
      ? EXACT_RECOVERY_DURABLE_TRANSFER_TIMEOUT_MS
      : authenticationTimeoutMs;
    const orderedContextGraphIds = orderContextGraphIdsByPriority(
      contextGraphIds,
      this.config.syncContextGraphPriorities,
    );
    const runSync = async () => finalizeDurableSyncCompletion(await runOrderedContextGraphSyncs<DurableSyncAccumulator>({
      work: orderedContextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        lane: 'durable' as const,
        operationId: `durable:${contextGraphId}:${remotePeerId.slice(-8)}`,
        run: async (remainingContextGraphs) => durableSyncAccumulatorFromResult(
          await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
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
              exactAssetUals: options?.exactAssetUals,
              authenticationTimeoutMs,
              operationDeadline: operationBoundary.deadline,
              signal: operationBoundary.signal,
            },
          ),
        ),
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
              options?.priority,
              operationBoundary.signal,
            ),
            operationBoundary.signal,
          );
        } catch (error) {
          if (!operationBoundary.signal?.aborted) throw error;
          return markDurableTerminalBoundary(createDurableSyncAccumulator(), false);
        }
      },
      merge: mergeDurableSyncAccumulatorInto,
      markDeferred: (summary) => {
        recordDurableSyncDiagnostics(summary, { deferredBackpressure: 1 });
        return markDurableTerminalBoundary(summary, false);
      },
      // Preserve already-merged progress, but record that cancellation left
      // requested Context Graphs unvisited so the aggregate cannot finalize
      // as complete.
      markSkipped: (summary) => markDurableTerminalBoundary(summary, false),
      shouldContinue: () => !operationBoundary.signal?.aborted,
      shouldStop: (part) => Boolean(
        stopOnBackoffWorthyFailure
        && durableSyncAccumulatorHasBackoffWorthyFailure(part),
      ),
      onDeferred: (item, error) => this.log.info(
        ctx,
        `Deferring durable sync at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
      ),
    }));

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
      exactAssetUals: options?.exactAssetUals,
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
      ? runSyncSingleFlight(this, singleFlightKey, runWithinBoundary)
      : runWithinBoundary();
  }

  /**
   * Foreground VM repair for one bounded set of locally-missing KAs.
   * Upgraded peers serve only these descriptors/payload graphs. Responses from
   * older peers are accepted for rolling compatibility, but runDurableSync
   * filters them back to this exact set before verification or storage.
   */
  async syncExactKnowledgeAssetsFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    requestedAssetUals: string[],
  ): Promise<DurableSyncResult> {
    const assetUals = requireExactAssetUals(requestedAssetUals);
    const ctx = createOperationContext('sync');
    return this.runLegacyDurableSync(
      ctx,
      remotePeerId,
      [contextGraphId],
      undefined,
      undefined,
      undefined,
      {
        exactAssetUals: assetUals,
        stopOnBackoffWorthyFailure: true,
        priority: 1_000,
      },
    );
  }

  /** Execute one legacy durable Context Graph after its caller owns admission. */
  async runLegacyDurableSyncForContextGraph(this: DKGAgent,
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    remainingContextGraphs: number,
    options: LegacyDurableContextGraphOptions = {},
  ): Promise<DurableSyncResult> {
    const {
      onPhase,
      onAtomicCommitStarted,
      onAccessDenied,
      sinceBatchIdFor,
      stopOnBackoffWorthyFailure,
      onVerifiedFullSnapshot,
      fetchTimeoutMs = SYNC_TOTAL_TIMEOUT_MS,
      exactAssetUals,
      authenticationTimeoutMs = fetchTimeoutMs,
      operationDeadline,
      signal,
    } = options;
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
      exactRecovery: exactAssetUals !== undefined,
      operationDeadline,
    }).createContextGraphBudget({
      contextGraphId,
      remainingContextGraphs,
    });
    return runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds: [contextGraphId],
      onPhase,
      onAccessDenied,
      syncAgentsMeta,
      durableSyncBudget: {
        createContextGraphBudget: () => contextGraphBudget,
      },
      signal,
      fetchSyncPages: ({
        ctx: opCtx,
        remotePeerId: peerId,
        contextGraphId: cgId,
        phase,
        graphUri,
        snapshotRef,
        sinceBatchId,
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
          snapshotRef,
          sinceBatchId,
          fetchContext.signal,
          undefined,
          onVerifiedFullSnapshot !== undefined,
          exactAssetUals,
        );
      },
      sinceBatchIdFor,
      exactAssetUalsFor: exactAssetUals ? () => exactAssetUals : undefined,
      stopOnBackoffWorthyFailure,
      processDurableBatchInWorker: this.processDurableBatchInWorker.bind(this),
      storeInsert: ({ quads, signal: operationSignal }) => {
        return this.insertSyncedQuadsAndInvalidateListCache(quads, {
          priority: 'background',
          source: 'agent.durableSync.storeInsert',
          signal: operationSignal,
        });
      },
      storeGraphScopedAsset: async ({
        asset,
        authenticationDeadline,
        signal: operationSignal,
      }) => {
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
        if (operationSignal?.aborted) {
          throw asSyncFetchAbortError(operationSignal.reason);
        }
        const verifiedOnChainId = authentication.onChainContextGraphId;
        const subscription = this.subscribedContextGraphs.get(asset.contextGraphId);
        if (verifiedOnChainId && subscription && subscription.onChainId !== verifiedOnChainId) {
          this.bindSubscriptionOnChainId(
            asset.contextGraphId,
            subscription,
            verifiedOnChainId,
          );
          this.persistContextGraphSubscriptionState(asset.contextGraphId);
        }
        if (operationSignal?.aborted) {
          throw asSyncFetchAbortError(operationSignal.reason);
        }
        onAtomicCommitStarted?.(asset.contextGraphId, asset.ual);
        const outcome = await materializeVerifiedGraphScopedAsset({
          store: this.store,
          asset: authentication.asset,
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
        }
        return outcome;
      },
      onVerifiedFullSnapshot,
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
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
        priority,
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
    const cgDataUri = contextGraphDataUri(contextGraphId);
    // In-scope iff the graph is this CG's own public data plane. Rejects the reserved
    // changelog graph, any other CG, and the private/SWM planes (deferred to legacy).
    const isForeignGraph = (graph: string): boolean => {
      const inCg = graph === cgDataUri || graph.startsWith(`${cgDataUri}/`);
      if (!inCg) return true;
      return graph.includes('/_private') || graph.includes('/_shared_memory');
    };
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
      send: (bytes) => this.messenger.sendToPeer(remotePeerId, PROTOCOL_SYNC_CHANGELOG, bytes, {
        timeoutMs: SYNC_PAGE_TIMEOUT_MS,
        signal: this.node.stopSignal ?? undefined,
      }),
      // Resync = the legacy verified lane for just this CG (no re-entry into the changelog
      // branch). Fold its result in, and report completeness so the driver only advances
      // the cursor to headSeq when the resync verifiably fetched everything below it.
      runResync: async (dropCandidates) => {
        const pendingDrops = [...new Set(dropCandidates)].filter((graph) => !isForeignGraph(graph));
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
        const dataRecs = page.records.filter((r) => r.op === 'upsert' && !r.graph.endsWith('/_meta') && !isForeignGraph(r.graph));
        const metaRecs = page.records.filter((r) => r.op === 'upsert' && r.graph.endsWith('/_meta') && !isForeignGraph(r.graph));
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
          isForeignGraph,
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
  async fetchSyncPages(this: DKGAgent,
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
    // R9/R10 — member SWM recovery marker. Forks the checkpoint namespace (R10)
    // and the request envelope auth mode (R9). Only the recovery driver sets it.
    recovery?: boolean,
    // Authoritative snapshot callers must rotate the responder session even
    // when an unfinished offset-zero requester session is still cached.
    forceFreshSession?: boolean,
    // Exact VM recovery filter. Kept in the checkpoint, coalescing, wire, and
    // responder-session identities so offsets can never cross asset batches.
    assetUals?: string[],
  ): Promise<SyncPageResult> {
    // A caller signal defines an operation-owned cancellation contract. Do not
    // place those fetches in the shared page map: even equal wall-clock
    // deadlines do not make independently abortable operations compatible.
    const coalescingKey = signal
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
        assetUals,
      });
    const inFlight = inFlightSyncPageFetchesFor(this);
    const existing = coalescingKey ? inFlight.get(coalescingKey) : undefined;
    if (existing) {
      if (!existing.controller.signal.aborted) {
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
      deadline,
      recovery,
      syncPageTimeoutMs: SYNC_PAGE_TIMEOUT_MS,
      syncRouterAttempts: SYNC_ROUTER_ATTEMPTS,
      syncPageRetryAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
      syncPageSize: SYNC_REQUEST_PAGE_SIZE,
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
      checkpointStore: this.syncCheckpoints,
      forceFreshSession,
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
    entry = { promise: sharedFetch, controller, waiters: 0 };
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
  ): Promise<{ peerIds: string[]; curatorIsLocal: boolean; legacyTripleResolved: boolean }> {
    const structuralCuratorDid = deriveCuratorDidFromCgId(contextGraphId);
    if (structuralCuratorDid) {
      const structuralAgent = structuralCuratorDid.slice('did:dkg:agent:'.length).toLowerCase();
      if ([...this.localAgents.keys()].some((addr) => addr.toLowerCase() === structuralAgent)) {
        return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: false };
      }
      const resolve = async (): Promise<string[]> => {
        let agents: Array<{ agentAddress?: string; peerId: string }>;
        try {
          agents = await this.discovery.findAgents();
        } catch {
          agents = [];
        }
        return agents
          .filter((a) => a.agentAddress?.toLowerCase() === structuralAgent)
          .map((a) => a.peerId);
      };
      let curatorPeers = await resolve();
      if (curatorPeers.length === 0) {
        await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
        curatorPeers = await resolve();
      }
      return { peerIds: curatorPeers, curatorIsLocal: false, legacyTripleResolved: false };
    }
    // Legacy non-wallet-scoped CG: fall back to triple-based curator resolution.
    if (await this.isCuratorOf(contextGraphId)) {
      return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: true };
    }
    let curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!curatorPeerId) {
      await this.refreshMetaFromCurator(contextGraphId).catch(() => undefined);
      curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    }
    if (!curatorPeerId) return { peerIds: [], curatorIsLocal: false, legacyTripleResolved: true };
    if (curatorPeerId === this.peerId) return { peerIds: [], curatorIsLocal: true, legacyTripleResolved: true };
    return { peerIds: [curatorPeerId], curatorIsLocal: false, legacyTripleResolved: true };
  }

  async syncSharedMemoryFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
    options?: {
      stopOnBackoffWorthyFailure?: boolean;
      sharedMemorySyncPlan?: SharedMemorySyncContextGraphPlan;
      /** Admission override for foreground catch-up. */
      priority?: number;
    },
  ): Promise<SharedMemorySyncResult> {
    const ctx = createOperationContext('sync');
    if (!durableSyncEnabled(this.config)) {
      this.log.warn(ctx, `Skipping shared-memory sync from ${remotePeerId.slice(-8)} (DKG_DURABLE_SYNC_ENABLED=0)`);
      return emptySharedMemorySyncResult();
    }
    const recoverPrivateContextGraph = (contextGraphId: string) => runRecoverContextGraphSwmFromPeer(
      {
        store: this.store,
        listSubGraphs: (id) => this.listSubGraphs(id),
        createContextGraphSyncDeadline: (remaining) => createContextGraphSyncDeadline({
          remainingContextGraphs: remaining,
        }),
        fetchSyncPages: (ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef) =>
          this.fetchSyncPages(ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef, undefined, undefined, true),
        processSharedMemoryBatch: (data, meta, cgId, registered, excluded) =>
          this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(data, meta, cgId, registered, excluded),
        publicSnapshotStore: this.publicSnapshotStore,
        isGraphAssetMaterialized: async (asset) => {
          const result = await this.store.query(
            `ASK { GRAPH <${assertSafeIri(asset.metaGraph)}> { ` +
              `<${assertSafeIri(asset.headSubject)}> ` +
              `<http://dkg.io/ontology/assertionGraph> ` +
              `<${assertSafeIri(asset.assertionGraph)}> . } }`,
            {
              priority: 'background',
              source: 'agent.swmRecovery.isGraphAssetMaterialized',
            },
          );
          return result.type === 'boolean' && result.value;
        },
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
      },
      remotePeerId,
      contextGraphId,
    );
    const planned = options?.sharedMemorySyncPlan;
    const plan = planned && sameStringArray(planned.eligibleContextGraphIds, contextGraphIds)
      ? planned
      : await this.planSharedMemorySyncContextGraphs(remotePeerId, contextGraphIds, ctx);
    const publicContextGraphIds = orderContextGraphIdsByPriority(
      plan.publicContextGraphIds,
      this.config.syncContextGraphPriorities,
    );
    const privateRecoverFromCurator = orderContextGraphIdsByPriority(
      plan.privateRecoverFromCurator,
      this.config.syncContextGraphPriorities,
    );
    const stopOnBackoffWorthyFailure = options?.stopOnBackoffWorthyFailure;
    const singleFlightKey = sharedMemorySyncSingleFlightKey({
      remotePeerId,
      contextGraphIds,
      stopOnBackoffWorthyFailure,
      publicContextGraphIds,
      privateRecoverFromCurator,
      priority: options?.priority,
    });

    const runSync = async (): Promise<SharedMemorySyncResult> => {
      const subGraphAdmissionByContextGraph = new Map<string, Promise<{ registered: string[]; excluded: string[] }>>();
      const getSubGraphAdmission = (contextGraphId: string) => {
        let admission = subGraphAdmissionByContextGraph.get(contextGraphId);
        if (!admission) {
          admission = getSharedMemorySubGraphAdmission(this.store, contextGraphId, this.listSubGraphs(contextGraphId));
          subGraphAdmissionByContextGraph.set(contextGraphId, admission);
        }
        return admission;
      };

      const syncPublicContextGraph = (contextGraphId: string, remainingContextGraphs: number) => runSharedMemorySync({
              ctx,
              remotePeerId,
              contextGraphIds: [contextGraphId],
              createContextGraphSyncDeadline: () => createContextGraphSyncDeadline({
                remainingContextGraphs,
              }),
              fetchSyncPages: this.fetchSyncPages.bind(this),
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
              stopOnBackoffWorthyFailure,
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
              deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
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

      const publicSet = new Set(publicContextGraphIds);
      const privateRecoverySet = new Set(privateRecoverFromCurator);
      const work: ContextGraphSyncWork<SharedMemorySyncResult>[] = [];
      for (const contextGraphId of plan.eligibleContextGraphIds) {
        if (publicSet.has(contextGraphId)) {
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
        if (!privateRecoverySet.has(contextGraphId)) continue;
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

      return runOrderedContextGraphSyncs({
        work,
        priorities: this.config.syncContextGraphPriorities,
        emptyResult: emptySharedMemorySyncResult,
        runWithAdmission: (item, run) => this.runContextGraphSyncWithBackpressure(
          ctx,
          item.contextGraphId,
          item.lane,
          item.operationId,
          run,
          options?.priority,
        ),
        merge: mergeSharedMemorySyncResults,
        markDeferred: (summary) => ({
          ...summary,
          deferredBackpressure: (summary.deferredBackpressure ?? 0) + 1,
        }),
        shouldStop: (part) => Boolean(
          stopOnBackoffWorthyFailure && (part.backoffWorthyFailures ?? 0) > 0,
        ),
        onDeferred: (item, error) => this.log.info(
          ctx,
          `Deferring ${item.lane} at CG ${item.contextGraphId} due to local backpressure: ${error.message}`,
        ),
      });
    };

    return runSyncSingleFlight(this, singleFlightKey, runSync);
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
          listSubGraphs: (id) => this.listSubGraphs(id),
          createContextGraphSyncDeadline: (remaining) => createContextGraphSyncDeadline({
            remainingContextGraphs: remaining,
          }),
          fetchSyncPages: (ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef) =>
            this.fetchSyncPages(ctx2, peerId, cgId, includeSharedMemory, phase, graphUri, deadline, snapshotRef, undefined, undefined, true),
          processSharedMemoryBatch: (data, meta, cgId, registered, excluded) =>
            this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(data, meta, cgId, registered, excluded),
          publicSnapshotStore: this.publicSnapshotStore,
          isGraphAssetMaterialized: async (asset) => {
            const result = await this.store.query(
              `ASK { GRAPH <${assertSafeIri(asset.metaGraph)}> { ` +
                `<${assertSafeIri(asset.headSubject)}> ` +
                `<http://dkg.io/ontology/assertionGraph> ` +
                `<${assertSafeIri(asset.assertionGraph)}> . } }`,
              {
                priority: 'background',
                source: 'agent.swmRecovery.isGraphAssetMaterialized',
              },
            );
            return result.type === 'boolean' && result.value;
          },
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
        },
        remotePeerId,
        contextGraphId,
      ),
    );
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(this: DKGAgent,
    contextGraphId: string,
    options?: ContextGraphCatchupOptions,
  ): Promise<{
    /** Ordered connected peers before optional maxPeers windowing. */
    connectedPeers: number;
    /** Ordered connected peers before optional maxPeers windowing. */
    totalPeers: number;
    /** Peers selected and evaluated after optional maxPeers windowing. */
    selectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    /**
     * Subset of `peersTried` whose sync-capable peer produced a non-transport-
     * failed round. Denials, metadata-only rows, and timeout-after-response
     * still count as responses; daemon status mapping uses this to avoid
     * reporting reachable-but-failed peers as curator-offline.
     */
    peersResponded: number;
    /**
     * Subset of `peersTried` whose sync round finished without a transport
     * failure, without an explicit ACL denial, and with either real progress
     * or a clean non-metadata-only empty completion.
     */
    peersSucceeded: number;
    /** Context Graph admissions deferred by local scheduler pressure. */
    deferredBackpressure: number;
    dataSynced: number;
    sharedMemorySynced: number;
    /** A selected peer completed a non-empty SWM snapshot without failure. */
    sharedMemoryCompletedCleanly: boolean;
    /**
     * `true` iff at least one peer in this run explicitly denied the sync
     * by emitting a denial sentinel (`syncDenied` marker raised from
     * `sync/requester/page-fetch.ts`, rolled up via `deniedPhases`). Kept
     * as a boolean for the subscribe job's terminal status mapping.
     */
    denied: boolean;
    /**
     * Number of peers that explicitly denied at least one durable/SWM phase
     * during this context-graph catch-up run.
     */
    deniedPeers: number;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    const includeSharedMemory = options?.includeSharedMemory ?? false;
    const mode = options?.mode ?? 'background';

    this.trackSyncContextGraph(contextGraphId);

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
      const peers = this.selectCatchupPeerWindow(orderedPeers, { ...options, peerPriorityRanks });
      const coreCount = orderedPeers.filter((p) => this.knownCorePeerIds.has(p.toString())).length;
      this.log.info(
        ctx,
        `catchup peer order for "${contextGraphId}": preferred=${preferredPeerId ?? 'none'} cores=${coreCount} total=${orderedPeers.length} selected=${peers.length}`,
      );
      return this.runCatchupOverPeers(contextGraphId, includeSharedMemory, peers, {
        totalPeers: orderedPeers.length,
        mode,
      });
    });
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
    stats?: { totalPeers?: number; mode?: CatchupMode },
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
    denied: boolean;
    deniedPeers: number;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    let syncCapablePeers = 0;
    let peersTried = 0;
    let peersResponded = 0;
    let deferredBackpressure = 0;
    let dataSynced = 0;
    let sharedMemorySynced = 0;
    let noProtocolPeers = 0;
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
      },
    };

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
    peersTried = syncCapable.length;

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
    const results = await mapWithConcurrency(
      syncCapable,
      CATCHUP_MAX_CONCURRENT_PEER_SYNCS,
      async (remotePeerId) => {
        const mode = stats?.mode ?? 'background';
        return runCatchupPlanesWithPolicy({
          mode,
          includeSharedMemory,
          syncDurable: ({ priority }) => this.syncFromPeerDetailed(
            remotePeerId,
            [contextGraphId],
            undefined,
            undefined,
            undefined,
            priority === undefined ? undefined : { priority },
          ).catch(() => createFailedPeerDurableSyncResult()),
          syncSharedMemory: ({ priority }) => this.syncSharedMemoryFromPeerDetailed(
            remotePeerId,
            [contextGraphId],
            priority === undefined ? undefined : { priority },
          ).catch(emptyShared),
        });
      },
    );
    let accessDeniedPeers = 0;
    let cleanDurableDataSynced = 0;
    let cleanDurablePrivateOnlyCompletions = 0;
    let cleanSharedMemoryDataSynced = 0;
    let peersSucceeded = 0;
    for (const r of results) {
      // A peer "succeeded" when its sync round finished without a transport
      // failure, denial, or timeout and either made phase/checkpoint progress,
      // or cleanly completed empty. Empty responses still count as a
      // legitimate host response, but a no-progress timeout must not make the
      // subscribe/VM catch-up path report a successful peer.
      const durableProgress = classifyDurableProgress(r.durable, {
        complete: r.durable.complete,
      });
      const sharedProgress = r.shared ? classifyDurableProgress(r.shared) : null;
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
        peersResponded++;
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
        peersSucceeded++;
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
      if (peerDenied) accessDeniedPeers++;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers} deferred=${deferredBackpressure}`,
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
      peersResponded,
      peersSucceeded,
      deferredBackpressure,
      dataSynced,
      sharedMemorySynced,
      sharedMemoryCompletedCleanly,
      denied: accessDeniedPeers > 0,
      deniedPeers: accessDeniedPeers,
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

  selectCatchupPeers(this: DKGAgent,
    peers: Array<{ toString(): string }>,
    preferredPeerId?: string,
    privateOnly = false,
  ): Array<{ toString(): string }> {
    return orderCatchupPeers(peers, preferredPeerId, privateOnly, this.knownCorePeerIds);
  }

  async resolvePreferredSyncPeerId(this: DKGAgent, contextGraphId: string): Promise<string | undefined> {
    // resolveCuratorPeerId consults authoritative metadata first and only then
    // falls back to the authenticated join-approval hint. Calling it before
    // reading preferredSyncPeers prevents that bootstrap hint from pinning all
    // later catchups to a curator that metadata has superseded.
    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    return curatorPeerId ?? this.preferredSyncPeers.get(contextGraphId);
  }

  async ensurePeerConnected(this: DKGAgent, peerId: string): Promise<void> {
    await ensurePeerConnectedAtom(this.node.libp2p as any, this.discovery, peerId);
    if (await this.networkAdmissionCoordinator.ensureAdmitted(peerId, createOperationContext('connect'))) return;
    throw new NetworkAdmissionRejectedError(peerId);
  }

  async waitForSyncProtocol(this: DKGAgent, pid: { toString(): string }): Promise<boolean> {
    return waitForPeerProtocol(
      this.node.libp2p.peerStore as any,
      pid,
      PROTOCOL_SYNC,
      SYNC_PROTOCOL_CHECK_ATTEMPTS,
      SYNC_PROTOCOL_CHECK_DELAY_MS,
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
        const registrationResult = await this.store.query(`
          SELECT ?predicate ?value WHERE {
            GRAPH <${metaGraph}> {
              <${contextGraphUri}> ?predicate ?value .
              VALUES ?predicate {
                <${onChainIdPredicate}>
                <${onChainHashPredicate}>
              }
            }
          }
        `);
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
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
    }
  }

  setContextGraphSubscription(this: DKGAgent,
    contextGraphId: string,
    next: ContextGraphSub,
    options?: { persist?: boolean; updateRehydrationStatus?: boolean },
  ): ContextGraphSub {
    this.invalidateListContextGraphsCache();
    const previous = this.subscribedContextGraphs.get(contextGraphId);
    // A local id is always cleartext unless the subscription explicitly says
    // otherwise through `onChainHash`. This distinction matters for a valid
    // user-chosen id that happens to match the 0x+64-hex wire-id shape.
    const localWireId = this.contextGraphNameCommitment(contextGraphId);
    const previousWireId = previous?.onChainHash
      ? this.contextGraphWireId(previous.onChainHash)
      : localWireId;
    const nextOnChainHash = next.onChainHash
      ? this.contextGraphWireId(next.onChainHash)
      : undefined;
    const nextWireId = nextOnChainHash ?? localWireId;
    const canonicalNext = next.onChainHash === nextOnChainHash
      ? next
      : { ...next, onChainHash: nextOnChainHash };
    if (
      previousWireId !== nextWireId
      && this.wireIdToLocalCgId.get(previousWireId) === contextGraphId
    ) {
      this.wireIdToLocalCgId.delete(previousWireId);
    }
    this.subscribedContextGraphs.set(contextGraphId, canonicalNext);
    this.wireIdToLocalCgId.set(nextWireId, contextGraphId);
    if (!canonicalNext.subscribed && !canonicalNext.coreHosted) {
      this.clearVmReconcileStateForContextGraph(contextGraphId);
    }
    if (options?.persist !== false) {
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
      if (canonicalNext.subscribed) {
        this.persistLocalNodeMembership(contextGraphId);
      } else {
        this.deleteContextGraphMember(contextGraphId, 'node', this.peerId);
      }
    }
    return canonicalNext;
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
    next?: ContextGraphSub,
  ): void {
    const status = this.contextGraphSubscriptionRehydrationStatus;
    if (!status) return;
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return;

    const sortIds = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const wasDormant = status.dormantIds.includes(contextGraphId);
    const hostedActivatedIds = status.hostedActivatedIds ?? [];
    const wasAccounted = this.contextGraphSubscriptionRehydrationAccountedIds.has(contextGraphId);
    const isPersisted = next?.subscribed === true || next?.coreHosted === true;

    let persistedTotal = status.persistedTotal;
    let activated = status.activated;
    let dormantIds = status.dormantIds.filter((id) => id !== contextGraphId);
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
      dormant: dormantIds.length,
      dormantIds,
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
    const dormantIds = [...status.dormantIds];
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
      const wasDormant = removeFrom(dormantIds, id);
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
      if (!dormantIds.includes(id)) {
        activated = Math.max(0, activated - 1);
        dormantIds.push(id);
      }
    }
    dormantIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    this.contextGraphSubscriptionRehydrationStatus = {
      ...status,
      persistedTotal,
      hostedActivated: hostedActivatedIds.length,
      hostedActivatedIds,
      activated,
      dormant: dormantIds.length,
      dormantIds,
      updatedAt: Date.now(),
    };
    for (const id of clearedSet) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(id);
    }
  }

  deleteContextGraphSubscription(this: DKGAgent, contextGraphId: string): boolean {
    this.invalidateListContextGraphsCache();
    this.forceClearVmReconcileStateForContextGraph(contextGraphId);
    return this.subscribedContextGraphs.delete(contextGraphId);
  }

  persistContextGraphSubscriptionState(this: DKGAgent, contextGraphId: string): void {
    if (!this.config.contextGraphSubscriptionStore) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return;
    }
    this.persistContextGraphSubscription(contextGraphId, {
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
  ): void {
    this.invalidateListContextGraphsCache();
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) {
      this.clearContextGraphSubscriptionPersistRevisionStateIfIdle(contextGraphId);
      return;
    }
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    // Persist member subscriptions AND (Phase D) public CGs this Core hosts —
    // the host-only record MUST survive restart so a Core that was offline
    // during a publish remembers it hosts the CG and fills its gap. Drop the
    // row only when the node neither subscribes to nor hosts the CG.
    this.beginContextGraphSubscriptionPersistRevision(contextGraphId, options?.revision);
    if (!sub?.subscribed && !sub?.coreHosted) {
      void this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, () => store.delete(contextGraphId))
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
      return;
    }
    const record = {
      id: contextGraphId,
      name: sub.name,
      subscribed: sub.subscribed,
      synced: sub.synced,
      sharedMemorySynced: sub.sharedMemorySynced,
      metaSynced: sub.metaSynced,
      onChainId: sub.onChainId,
      onChainHash: sub.onChainHash,
      lastReconciledOrdinal: sub.lastReconciledOrdinal,
      coreHosted: sub.coreHosted,
      syncScoped: (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    };
    void this.enqueueContextGraphSubscriptionPersistWrite(contextGraphId, () => store.save(record))
      .then(() => {
        if (
          options?.updateRehydrationStatus === true &&
          this.claimContextGraphSubscriptionPersistRevision(contextGraphId, options.revision)
        ) {
          this.updateContextGraphSubscriptionRehydrationStatusAfterPersist(contextGraphId, sub);
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
  ): Promise<void> {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) {
      // The library API has always allowed storeless agents. "Strict" means a
      // configured store failure is surfaced and retried before ACK; absence
      // retains the backward-compatible in-memory approval path.
      return;
    }
    const sub = subscription ?? this.subscribedContextGraphs.get(contextGraphId);
    if (!sub?.subscribed) {
      throw new Error(
        `Cannot acknowledge join approval for "${contextGraphId}": active subscription state is missing`,
      );
    }
    const record = {
      id: contextGraphId,
      name: sub.name,
      subscribed: sub.subscribed,
      synced: sub.synced,
      sharedMemorySynced: sub.sharedMemorySynced,
      metaSynced: sub.metaSynced,
      onChainId: sub.onChainId,
      onChainHash: sub.onChainHash,
      lastReconciledOrdinal: sub.lastReconciledOrdinal,
      coreHosted: sub.coreHosted,
      syncScoped: syncScoped ?? (this.config.syncContextGraphs ?? []).includes(contextGraphId),
    };
    // Queue behind any fire-and-forget writes scheduled by subscribe/mark so
    // this final authoritative snapshot is the last write before the ACK.
    await this.enqueueContextGraphSubscriptionPersistWrite(
      contextGraphId,
      () => store.save(record),
    );
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

    let previousMembership: (ContextGraphMembershipRecord & {
      firstSeenAt?: number;
      updatedAt: number;
    }) | null = null;
    let previousMembershipKnown = membershipStore === undefined;
    if (membershipStore?.loadAll) {
      const rows = await membershipStore.loadAll();
      previousMembershipKnown = true;
      previousMembership = rows.find((row) =>
        row.contextGraphId === contextGraphId &&
        row.principalType === membership.principalType &&
        this.normalizeMembershipPrincipal(row.principalType, row.principalId) === normalizedPrincipalId
      ) ?? null;
    }

    let previousSubscription: ContextGraphSubscriptionRecord | null = null;
    if (subscriptionStore) {
      previousSubscription = subscriptionStore.load
        ? await subscriptionStore.load(contextGraphId)
        : (await subscriptionStore.loadAll()).find((row) => row.id === contextGraphId) ?? null;
    }

    let membershipAttempted = false;
    let subscriptionAttempted = false;
    try {
      // Membership is the prepare record; the subscription row is the durable
      // activation/rehydration commit marker and must remain last. A legacy
      // membership store without a read API may retain an idempotent prepared
      // row after failure, but it can never leave a restart-visible active
      // subscription without the membership fact it depends on.
      if (membershipStore) membershipAttempted = true;
      await this.upsertContextGraphMember(membership, { strict: true });
      if (subscriptionStore) subscriptionAttempted = true;
      await this.persistContextGraphSubscriptionStrict(
        contextGraphId,
        subscription,
        true,
      );
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      // A store may reject after applying a write, so compensate every
      // attempted operation whose prior value was observable, including the
      // one that surfaced the failure. Never guess absence for a legacy
      // membership store without loadAll(): deleting there could erase a
      // valid pre-existing row after an upsert that rejected before mutation.
      if (subscriptionAttempted && subscriptionStore) {
        try {
          await this.enqueueContextGraphSubscriptionPersistWrite(
            contextGraphId,
            () => previousSubscription
              ? subscriptionStore.save(previousSubscription)
              : subscriptionStore.delete(contextGraphId),
          );
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (membershipAttempted && membershipStore && previousMembershipKnown) {
        try {
          if (previousMembership) {
            await membershipStore.upsert(previousMembership);
          } else {
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
      return Promise.resolve();
    }
    const normalizedRecord = {
      ...record,
      principalId: this.normalizeMembershipPrincipal(record.principalType, record.principalId),
    };
    const updatedAt = Date.now();
    const write = store.upsert({ ...normalizedRecord, updatedAt });
    if (options?.strict === true) return write;
    // Background callers stay log-and-continue; durability-sensitive callers
    // opt into the strict path above and receive the original rejection.
    return write.catch((err) => {
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
    if (!store) return;
    const normalizedPrincipalId = this.normalizeMembershipPrincipal(principalType, principalId);
    void store.delete(contextGraphId, principalType, normalizedPrincipalId).catch((err) => {
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
    return {
      ...status,
      hostedActivatedIds: [...(status.hostedActivatedIds ?? [])],
      dormantIds: [...status.dormantIds],
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
      // Validate the cap: it's external config, so a fractional / negative /
      // NaN value would otherwise do something surprising (0.5 → 1 row,
      // -1/NaN → silently disables the cap). Accept only a non-negative integer
      // (0 = "no cap"); fall back to the default otherwise.
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
      const cappedUserRows = cap > 0 ? userRows.slice(0, cap) : userRows;
      const toActivate = [...hostedRows, ...cappedUserRows];
      const dormantRows = cap > 0 ? userRows.slice(cap) : [];
      for (let i = 0; i < toActivate.length; i++) {
        const row = toActivate[i];
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
        const restorePendingMeta = hasJoinApproval && !approvedAgentAuthorized;
        this.setContextGraphSubscription(row.id, {
          name: row.name,
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
        if (row.syncScoped) {
          this.trackSyncContextGraph(row.id);
        }
        if (row.subscribed) {
          this.subscribeToContextGraph(row.id, { trackSyncScope: false, persist: false });
          this.persistLocalNodeMembership(row.id, 'rehydrated-subscription');
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
      const skipped = dormantRows.length;
      this.contextGraphSubscriptionRehydrationAccountedIds.clear();
      for (const row of rows) {
        this.contextGraphSubscriptionRehydrationAccountedIds.add(row.id);
      }
      const completedAt = Date.now();
      this.contextGraphSubscriptionRehydrationStatus = {
        persistedTotal: rows.length,
        systemExcluded: persistedRows.length - rows.length,
        hostedActivated: hostedRows.length,
        hostedActivatedIds: hostedRows.map((r) => r.id),
        activated: toActivate.length,
        dormant: skipped,
        activationCap: cap,
        capDisabled: cap === 0,
        dormantIds: dormantRows.map((r) => r.id),
        completedAt,
        updatedAt: completedAt,
      };
      if (rows.length > 0) {
        this.log.info(
          ctx,
          `Rehydrated ${toActivate.length} of ${rows.length} non-system persisted context-graph subscription(s)` +
            (skipped > 0
              ? ` (${skipped} non-hosted left dormant — over the ${cap} activation cap; ` +
                `${hostedRows.length} hosted always restored)`
              : ''),
        );
      }
      if (skipped > 0) {
        this.log.warn(
          ctx,
          `${skipped} context-graph subscription(s) left dormant to avoid store contention (#997). ` +
            `Prune stale ones via 'DELETE /api/context-graph/subscriptions', or raise ` +
            `maxRehydratedContextGraphSubscriptions. Inspect ` +
            `'GET /api/context-graph/subscriptions' for dormant ids.`,
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

  async hasConfirmedMetaState(this: DKGAgent,
    contextGraphId: string,
    options?: { rejectUnregisteredPlaceholder?: boolean },
  ): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return true;
    }

    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    // `ensureContextGraphLocal` historically wrote only this marker into
    // `_meta`, then labelled the subscription `metaSynced=true`. That row is
    // local bootstrap intent, not metadata learned from the curator. Exclude
    // it from the positive proof and remember it so the ontology declaration
    // below cannot turn the same shadow into a false-public confirmation.
    const unregisteredPlaceholderResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${metaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> "unregistered" .
        }
      }`,
    );
    const hasUnregisteredPlaceholder = unregisteredPlaceholderResult.type === 'boolean' &&
      unregisteredPlaceholderResult.value === true;
    let hasActivePublicOnChainProof: boolean | undefined;
    if (hasUnregisteredPlaceholder && options?.rejectUnregisteredPlaceholder === true) {
      // Replicas do not rewrite the creator's local registrationStatus marker,
      // so a legitimately registered public CG can still say "unregistered".
      // Preserve that shape only on fresh positive chain proof (tracked
      // non-zero id, active slot, accessPolicy=public); a legacy local shadow
      // has no such proof, and a private slot cannot borrow its public ontology
      // fallback.
      hasActivePublicOnChainProof = await this.isContextGraphPublicOnChain(
        contextGraphId,
        createOperationContext('sync'),
      ).catch(() => false);
    }
    // Curated/private CG creation in 10.0.6 emits this complete definition in
    // `_meta`: type + private policy + creator peer DID + curator wallet DID.
    // Requiring both identities prevents an incidental/provenance type triple
    // (or a lone allowlist/policy write) from making bootstrap look complete.
    const approvedAgentAddress = this.localApprovedAgentByCG.get(contextGraphId);
    let expectedDelegateeOpKey: string | undefined;
    if (approvedAgentAddress) {
      try {
        expectedDelegateeOpKey = await inferAdapterPublisherAddress(this.chain);
      } catch {
        // The libp2p peer binding remains sufficient when no op-key is exposed.
      }
    }
    const authoritativeDefinitionResult = await this.store.query(
      buildAuthoritativePrivateMetaAskQuery(
        contextGraphId,
        approvedAgentAddress
          ? {
              approvedAgentAddress,
              expectedDelegateePeerId: this.peerId,
              expectedDelegateeOpKey,
            }
          : undefined,
      ),
    );
    if (
      authoritativeDefinitionResult.type === 'boolean' &&
      authoritativeDefinitionResult.value === true
    ) {
      return true;
    }

    // Public subscriptions have no member credential to prove. A complete
    // root definition that explicitly says `accessPolicy="public"` is the
    // corresponding authoritative metadata gate; publisher allowlists do not
    // alter that read/subscription policy. Keep this separate from the private
    // definition above so private bootstrap still requires the current local
    // member delegation.
    const authoritativePublicDefinitionResult = await this.store.query(
      buildAuthoritativePublicMetaAskQuery(contextGraphId),
    );
    if (
      authoritativePublicDefinitionResult.type === 'boolean' &&
      authoritativePublicDefinitionResult.value === true &&
      // A replica may retain the creator's local-only placeholder. When the
      // caller explicitly rejects that shape, preserve the existing fresh
      // active-public chain requirement instead of trusting the shadow alone.
      (!hasUnregisteredPlaceholder || options?.rejectUnregisteredPlaceholder !== true || hasActivePublicOnChainProof)
    ) {
      return true;
    }

    // A tracked, active registration with live accessPolicy=public is an
    // independent authority. This covers chain-discovered subscriptions whose
    // local ontology/control projection has not landed yet. The registry
    // resolver is fail-closed: it requires an identity-bound on-chain id,
    // liveness, and policy=public, so a private or stale slot cannot pass.
    if (hasActivePublicOnChainProof === undefined) {
      hasActivePublicOnChainProof = await this.isContextGraphPublicOnChain(
        contextGraphId,
        createOperationContext('sync'),
      ).catch(() => false);
    }
    if (hasActivePublicOnChainProof) return true;

    // `ensureContextGraphLocal` remains authoritative for explicit public
    // network defaults, including namespaced defaults. Reject that otherwise-
    // valid shape for trusted join/pending bootstrap state or when a caller
    // explicitly classifies it as remote. The one remote exception requires
    // fresh active-public chain proof; a slash heuristic or onChainId alone
    // would break defaults or let a private slot borrow the public fallback.
    if (
      hasUnregisteredPlaceholder &&
      (
        this.localApprovedAgentByCG.has(contextGraphId) ||
        (
          !hasActivePublicOnChainProof &&
          (
            options?.rejectUnregisteredPlaceholder === true ||
            this.subscribedContextGraphs.get(contextGraphId)?.pendingMeta === true
          )
        )
      )
    ) {
      return false;
    }

    // Ontology-only fallback: a CG declared `rdf:type dkg:ContextGraph` can be
    // treated as confirmably-public for the gossip race-opener ONLY when
    // no local evidence of a restriction exists. Raw contextGraph declaration
    // is not enough on its own — `inviteToContextGraph` writes
    // `dkg:allowedPeer` straight to `_meta` without updating ontology, so
    // a CG that was announced publicly and later allowlisted would look
    // "just a contextGraph" here even though the curator expects the allowlist
    // to gate gossip. Require `isPrivateContextGraph()` (now also reads
    // `DKG_ALLOWED_PEER`) to explicitly return false before honoring the
    // bypass.
    if (await this.isPrivateContextGraph(contextGraphId)) {
      return false;
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const ontologyResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        }
      }`,
    );
    return ontologyResult.type === 'boolean' && ontologyResult.value === true;
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
    (this.config as any).sharedMemoryTtlMs = ttlMs;

    if (!this.swmCleanupTimer) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
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
    const ctx = createOperationContext('share');
    const cutoff = ttl > 0 ? new Date(Date.now() - ttl).toISOString() : undefined;
    let totalDeleted = 0;
    let finalizedCleanupBudget = 4;

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
          if (finalizedCleanupBudget > 0) {
            try {
              const cleaned = await this.getOrCreateFinalizationHandler()
                .cleanupFinalizedGraphScopedSwmWhenIdle({
                  contextGraphId: pid,
                  swmMetaGraph: wsMetaGraph,
                  maxCandidates: finalizedCleanupBudget,
                });
              finalizedCleanupBudget -= cleaned;
            } catch (error) {
              this.log.warn(
                ctx,
                `Deferred finalized-SWM cleanup failed for ${wsMetaGraph}: `
                  + `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (!cutoff) continue;

          const expiredOps = await this.store.query(
            `SELECT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          }`,
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
    publicSnapshotStore: dependencies.publicSnapshotStore,
    isGraphAssetMaterialized: dependencies.isGraphAssetMaterialized,
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
              await dependencies.store.deleteByPattern(
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
    replaceMetaForGraphAssets: async (assets) => {
      for (const asset of assets) {
        const linkedOperations = await dependencies.store.query(
          `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(asset.metaGraph)}> { ` +
            `<${assertSafeIri(asset.headSubject)}> <http://dkg.io/ontology/shareOperationId> ?shareId . ` +
            `?op <http://dkg.io/ontology/shareOperationId> ?shareId ; ` +
            `<http://dkg.io/ontology/kaUal> <${assertSafeIri(asset.kaUal)}> . } }`,
          {
            priority: 'background',
            source: 'agent.swmRecovery.replaceMetaForGraphAssets.findOperations',
          },
        );
        const operationSubjects = new Set<string>([asset.operationSubject]);
        if (linkedOperations.type === 'bindings') {
          for (const row of linkedOperations.bindings) {
            const operation = row['op'];
            if (operation) operationSubjects.add(operation);
          }
        }
        await dependencies.store.deleteByPattern(
          { graph: asset.metaGraph, subject: asset.headSubject },
          {
            priority: 'background',
            source: 'agent.swmRecovery.replaceMetaForGraphAssets.deleteHead',
          },
        );
        for (const operationSubject of operationSubjects) {
          await dependencies.store.deleteByPattern(
            { graph: asset.metaGraph, subject: operationSubject },
            {
              priority: 'background',
              source: 'agent.swmRecovery.replaceMetaForGraphAssets.deleteOperation',
            },
          );
        }
      }
    },
    ensureContextGraph: async (cgId) => {
      const graphManager = new GraphManager(dependencies.store);
      await graphManager.ensureContextGraph(cgId);
    },
    setCheckpoint: (key, offset) => dependencies.setCheckpoint(key, offset),
    deleteCheckpoint: (key) => dependencies.deleteCheckpoint(key),
    getRegisteredSubGraphNames: async () => admission.registered,
    getExcludedSubGraphNames: async () => admission.excluded,
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
  const result = await store.query(`
    ASK {
      GRAPH <${assertSafeIri(metaGraph)}> {
        {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        } UNION {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
        }
      }
    }
  `);
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
