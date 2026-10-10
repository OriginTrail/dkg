// SPDX-License-Identifier: Apache-2.0

/**
 * SWM host-mode subsystem extracted from dkg-agent.ts as a mixin holder:
 * host-mode store init/reconcile/wire, envelope + ciphertext-chunk ingest,
 * host-catchup + get-chunk request handlers, chain-ordinal VM reconcile, and
 * the catchup/enable/stats entrypoints. Bodies are a 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { orderVmRecoveryCandidates } from './vm-recovery-candidate-order.js';
import {
  isCanonicalAuthoritativeContextGraphId, localContextGraphIdMatchesCommittedNameHash,
} from './context-graph-binding-state.js';
import { isAdmittedContextGraphSubscription } from './context-graph-subscription-policy.js';
import { normalizeContextGraphNameHash } from './context-graph-name-candidate.js';
import { createHash, randomUUID } from 'node:crypto';
import { createSwmHostModeHandler } from './internal/gossip/host-mode-handler.js';
import { Buffer } from 'node:buffer';
import { VmRecoveryCoreTransportPreferencePolicy } from './vm-recovery-core-transport-preference.js';
import { VmRecoveryPassAuthority, type VmRecoveryRegisteredPublicEvidence } from './vm-recovery-pass-authority.js';
import type { ExactBatchStreamOutcome, ExactRecoveryTransportMode } from './sync/requester/exact-recovery-transport.js';
import { performance } from 'node:perf_hooks';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, contextGraphLayerUri, assertionLifecycleUri, contextGraphAssertionUri,
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
  Logger, createOperationContext, sparqlString, isSafeIri, assertSafeIri,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
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
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, isStoreSchedulerBusyError, withDefaultStoreWorkPriority, createTripleStore, tryUpdateWithTouchedGraphs, type TripleStore, type TripleStoreConfig, type QueryOptions, type Quad, type LargeLiteralStorageConfig, type SelectResult } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type ContextGraphAuthoritySnapshot, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type KnowledgeAssetVersionSnapshot, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
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
  readMaterializedVersion, shouldApplyMaterialization, withMaterializationLock,
  isKnowledgeAssetWorkspaceHeadCorruptError,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  resolveKnowledgeAssetWorkspaceHead,
  type MaterializedVersion,
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
import {
  isCoreHostedPublicCgRecorded,
  resolveCoreHostedPublicCgLocalId,
  type CoreHostedPublicCgRecordOutcome,
} from './core-hosted-public-cg-record-decision.js';

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
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { bindRandomSampling, type RandomSamplingHandle, type RandomSamplingStatus } from './random-sampling-bind.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { Messenger, type SloProtocolStats } from './p2p/messenger.js';
import {
  buildReconciledKnowledgeAssetUal,
} from './ka-identity.js';
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
import { getSyncCheckpointKey } from './sync/checkpoint/state.js';
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { registerSyncHandler } from './sync/responder/sync-handler.js';
import { runSyncOnConnect } from './sync/on-connect/sync-on-connect.js';
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
import {
  FinalizationHandler,
  type ChainReconcileLocalCandidate,
  type ChainReconciledKCOutcome,
} from './finalization-handler.js';
import {
  reconcileContextGraph,
  VmReconcileSchedulingRuntime,
  RecentUalSet,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
  type PendingOrdinalRecoveryResult,
  type OrdinalRecoveryTarget,
  type ReconcilePassTimings,
} from './chain-reconciler.js';
import {
  ContextGraphOnChainIdUnresolvedError,
  VmReconcileUnavailableError,
  VmReconcileQueueClosedError,
  type ContextGraphReconcileResult,
  type VmReconcileSource,
} from './vm-reconcile-service.js';
import {
  isUnansweredVmReconcileReadAuthority,
  VmReconcileReadAuthorityUnansweredError,
} from './internal/vm-reconcile-read-authority.js';
import {
  askVmReconcileAgainAfterLocalRpcRefusal,
  VmReconcileLocalRpcRefusalError,
  VmReconcileRefusedSliceReads,
} from './internal/vm-reconcile-local-rpc-refusal.js';
import {
  askVmReconcileAgainAfterOvertakenPass,
  VmReconcileOvertakenError,
} from './internal/vm-reconcile-overtaken-pass.js';
import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
import { resolveVmRecoveryExperimentPolicy } from './vm-recovery-experiment-policy.js';
import { VmRecoveryTimingObserver } from './vm-recovery-timing-observer.js';
import {
  VmRecoveryPhaseRecorder,
  noteVmReconcilePassEnd,
  observeVmRecoveryTiming,
  vmReconcilePassGapMs,
} from './vm-recovery-phase-timing.js';
import {
  existingVmRecoveryPreparation,
  vmRecoveryPreparationFor,
  type VmRecoveryPreparationScope,
} from './vm-recovery-preparation.js';
import { planVmRecoveryTransport, VmRecoveryTransportPreparation, VM_EXACT_MICROBATCH_LIMITS } from './vm-recovery-transport-plan.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from './sync/exact-batch-stream-contract.js';
import { exactBatchStreamUnsupported } from './sync/exact-batch-stream-capability.js';
import {
  VmRecoveryProviderPolicy,
  type VmRecoveryProviderAttempt,
  type VmRecoveryUalDisposition,
} from './vm-recovery-provider-policy.js';
import {
  MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS,
  ExactAssetFetchLifecycleClosedError,
  ExactAssetVersionBehindError,
  exactAssetFetchPeerWindow,
  runExactAssetFetch,
  type ContextGraphAssetFetchResult,
  type ExactAssetFetchEvidence,
} from './sync/exact-asset-fetch.js';
import type {
  VmRefreshAttempt,
  VmRefreshDue,
  VmRefreshQueue,
  VmRefreshTarget,
} from './vm-refresh.js';
import { readVmRefreshVersionView } from './vm-refresh-version-view.js';
import { isBoundedOperationTimeoutError, runBoundedOperation } from './bounded-operation.js';

/** Graph-scoped KA metadata marker; its presence names the metadata graph. */
const GRAPH_KA_CONTENT_SCOPE_VERSION_PREDICATE = 'http://dkg.io/ontology/contentScopeVersion';

function rsHealStoreOptions(operation: string, signal?: AbortSignal): QueryOptions {
  return {
    priority: 'background',
    source: `agent.swm.rsHeal.${operation}`,
    ...(signal ? { signal } : {}),
  };
}

export type RsHealPassResult =
  | { status: 'completed'; inspected: number }
  | { status: 'skipped'; reason: 'not-current' | 'unsupported-store' | 'no-work' | 'invalid-result' | 'failed' }
  | { status: 'deferred'; reason: 'store-busy' };

async function readRsHealStrandedPage(
  store: TripleStore,
  legacyMeta: string,
  scopedMeta: string,
  dkgNamespace: string,
  cursor: string | undefined,
  batchSize: number,
  signal?: AbortSignal,
): Promise<SelectResult | null> {
  const result = await store.query(
    `SELECT ?ual ?b WHERE {
       GRAPH <${legacyMeta}> { ?ual <${dkgNamespace}batchId> ?b }
       FILTER(isIRI(?ual))
       FILTER NOT EXISTS {
         GRAPH <${scopedMeta}> {
           ?ual <${dkgNamespace}batchId> ?b ; <${dkgNamespace}materializedVersion> ?version
         }
       }
       ${cursor ? `FILTER(STR(?ual) > ${sparqlString(cursor)})` : ''}
     }
     ORDER BY STR(?ual)
     LIMIT ${batchSize}`,
    rsHealStoreOptions('enumerate', signal),
  );
  return result.type === 'bindings' ? result : null;
}

function advanceRsHealCursor(
  cursorMap: Map<string, string>,
  cursorKey: string,
  bindings: SelectResult['bindings'],
  batchSize: number,
  maxEntries: number,
): void {
  if (bindings.length === 0 || bindings.length < batchSize) {
    cursorMap.delete(cursorKey);
    return;
  }
  const lastUal = stripBindingQuotes(bindings[bindings.length - 1]?.['ual'] ?? '');
  if (!lastUal || !isSafeIri(lastUal)) {
    // The query constrains ?ual to an IRI, but fail open to a fresh scan rather
    // than pinning a corrupt cursor if an adapter returns malformed bindings.
    cursorMap.delete(cursorKey);
    return;
  }
  cursorMap.delete(cursorKey);
  cursorMap.set(cursorKey, lastUal);
  while (cursorMap.size > maxEntries) {
    const oldest = cursorMap.keys().next().value;
    if (oldest === undefined) break;
    cursorMap.delete(oldest);
  }
}

// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
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
  stripLiteral, jsonLdToQuads,
  type JsonLdContent,
} from './dkg-agent-utils.js';
import {
  PRIVATE_DATA_ANCHOR,
  SYNC_PAGE_SIZE,
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
  SYNC_MIN_GRAPH_BUDGET_MS,
  DEBUG_SYNC_PROGRESS,
  DEFAULT_SWM_TTL_MS,
  SWM_CLEANUP_INTERVAL_MS,
  SYNC_DENIED_RESPONSE,
  GOSSIP_DIAL_COOLDOWN_MS,
  GOSSIP_DIAL_TIMEOUT_MS,
  CATCHUP_ON_CONNECT_COOLDOWN_MS,
  SYNC_RECONCILER_INTERVAL_MS,
  SYNC_STALENESS_THRESHOLD_MS,
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
  SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
} from './dkg-agent-constants.js';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
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
  type ContextGraphSubscriptionStore,
  type SelectedVmReconcileCursorRecord,
  type VmReconcileRotationRecord,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type DurableSyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type DKGAgentConfig,
  type ReplicationEvent,
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
import type { CuratorPeerIdsResolution } from './dkg-agent-lifecycle.js';
import type {
  ContextGraphBindingTarget,
} from './context-graph-binding-state.js';
import { resolveExactBatchStreamEnabled, resolveVmReconcilerEnabled } from './sync/backpressure.js';
import { mapWithConcurrencyDrained } from './map-with-concurrency.js';
import { VM_RECOVERY_SYNC_PRIORITY } from './sync/catchup-policy.js';
import { finalizedContextGraphSnapshotMismatchV1 } from
  './internal/context-graph-authority/finalized-context-graph-binding.js';
import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES,
  withOwnedRpcRequestContext,
  withRpcUsageSite,
} from '@origintrail-official/dkg-chain';

const DEFAULT_HOST_MODE_RECONCILE_BATCH_SIZE = 32;

type VmReconcileEngineResult = Awaited<ReturnType<typeof reconcileContextGraph>>;
type VmReconcileTargetBase = {
  onChainId: string;
  onChainCgId: bigint;
  cursor: CursorState;
  watermarkBefore: number;
};
type VmReconcileSubscriptionTarget = VmReconcileTargetBase
  & ContextGraphBindingTarget
  & {
    kind: 'subscription';
    sub: ContextGraphSub;
  };
type VmReconcileSelectedCursorState = {
  record: SelectedVmReconcileCursorRecord;
  cursor: CursorState;
  bindingGeneration: number;
};
type VmReconcileSelectedTarget = VmReconcileTargetBase & {
  kind: 'rfc64-selected';
  deploymentId: string;
  nameHash: string;
  bindingGeneration: number;
  selectedState: VmReconcileSelectedCursorState;
};
type VmReconcileTarget = VmReconcileSubscriptionTarget | VmReconcileSelectedTarget;
type FinalizedVmReconcileBinding =
  | { kind: 'legacy-current' }
  | { kind: 'absent' }
  | { kind: 'resolved'; nameHash: string; onChainId: string; onChainCgId: bigint };

function requireVmReconcileDeploymentId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(
      'Selected VM reconciliation requires a non-empty chain deploymentId',
    );
  }
  return value.trim();
}

function vmReconcileDeploymentMatches(value: unknown, expected: string): boolean {
  try {
    return requireVmReconcileDeploymentId(value) === expected;
  } catch {
    return false;
  }
}

type VmReconcileExecution = {
  identityCursor: CursorState;
  persistWatermark: (localCgId: string, watermark: number) => void;
  /** Observation only; forwarded to the engine's pass-timing hook. */
  observePassTimings?: ChainReconcilerDeps['observePassTimings'];
  /** Told of the chain reads that fail where the pass goes on without them. */
  refusedReads?: VmReconcileRefusedSliceReads;
};

type VmReconcileOrdinalOptions = {
  /** Re-check a captured local/on-chain binding around slow fetch work. */
  isTargetCurrent?: () => boolean;
  /** Re-prove operation-local selected bindings immediately before materialization. */
  revalidateTarget?: () => Promise<boolean>;
  /**
   * Take the coherent version snapshot that lets a re-run of this ordinal at
   * the same finalized block skip its chain reads. A forward catch-up walk
   * never re-runs a historical ordinal, so it skips the snapshot (several
   * RPC requests per endpoint) there. Default true.
   */
  rememberFinalizedEvidence?: boolean;
  /** Told of the chain read failure that left this ordinal for a later pass. */
  onUnresolvable?: (error: unknown) => void;
};

/**
 * Max age (ms) of a cached `publishPolicy` value the host-mode self-signed
 * admission gate (`isConfirmedPublicForHostMode`) will trust. Deliberately
 * short: it bounds the open→curated downgrade staleness to a few seconds
 * (vs the general 60s `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS`) AND rate-caps the
 * chain RPC to ~1 per window per CG, so spammed public-plaintext gossip can't
 * amplify into a per-message `eth_call` (Branimir review #1239 follow-on).
 */
const HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS = 5_000;

/**
 * Recovery-target root of an ordinal whose KA the node holds nowhere locally:
 * the sweep queues it without reading the chain root. Exact recovery fetches
 * by UAL, so the root only keys the target's rotation record, and every visit
 * that still finds nothing local presents the same key.
 */
const VM_RECONCILE_UNREAD_MERKLE_ROOT = '';

interface VmRecoveryPreparedEntry {
  readonly index: number;
  readonly target: OrdinalRecoveryTarget;
  readonly prepared: {
    readonly slotKey: string;
    readonly record?: VmReconcileRotationRecord;
    readonly suppressed: boolean;
  };
}

interface VmRecoveryBatchAttempt {
  readonly entry: VmRecoveryPreparedEntry;
  readonly installedRecord: VmReconcileRotationRecord | undefined;
  readonly candidatePeerIds: readonly string[];
}

type VmRecoveryBatchExecutionResult =
  | { readonly kind: 'not-started-stale' }
  | { readonly kind: 'stale-after-attempt' }
  | { readonly kind: 'local-admission-deferred' }
  | {
    readonly kind: 'completed';
    readonly outcomes: readonly (readonly [number, OrdinalOutcome])[];
    readonly handledOrdinals: readonly number[];
    readonly attemptedOrdinals: readonly number[];
    readonly providerDisposition: VmRecoveryUalDisposition;
    readonly perUalDispositions: readonly (
      readonly [string, VmRecoveryUalDisposition]
    )[];
    /**
     * The attempt ended without a verdict on the peer's data (it answered busy,
     * or its stream broke) and the pending targets kept their turn at it.
     */
    readonly providerTurnKept: boolean;
  };


function normalizeHostModeReconcileBatchSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOST_MODE_RECONCILE_BATCH_SIZE;
  return Math.max(1, Math.floor(value));
}

/**
 * Strip surrounding quotes from a SPARQL SELECT binding value — mirrors
 * `ka-extractor.ts:stripQuotes` verbatim so the RS-heal resolves the SAME
 * `?ual`/`?root` strings the prover does. IRIs come back bare from both store
 * adapters (oxigraph/sparql-http), so this is a no-op for them; it only peels
 * the `"..."` / `"value"^^<dt>` literal wrappers some result formats apply.
 */
function stripBindingQuotes(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  const ix = v.indexOf('"^^');
  if (v.startsWith('"') && ix !== -1) {
    return v.slice(1, ix);
  }
  return v;
}

async function raceVmReconcileAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  void work.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VmReconcileQueueClosedError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** `peerIds` started `offset` places in, wrapping. */
function rotatePeerIds(peerIds: readonly string[], offset: number): string[] {
  if (peerIds.length === 0) return [];
  const start = offset % peerIds.length;
  return [...peerIds.slice(start), ...peerIds.slice(0, start)];
}

/** Track the raw dependency even if an abort race releases its caller first. */
function trackVmReconcilePhysicalRun<T>(runs: Set<Promise<unknown>>, run: Promise<T>): Promise<T> {
  runs.add(run);
  const retire = () => { runs.delete(run); };
  void run.then(retire, retire);
  return run;
}

export class SwmHostModeMethods extends DKGAgentBase {
  /**
   * OT-RFC-38 LU-6 — initialize the on-disk opaque ciphertext store
   * for hosting curated CG SWM substrate. No-op on edges and on
   * cores where the operator has explicitly opted out via
   * `config.swmHostMode.enabled === false`.
   */
  async initializeSwmHostModeStore(this: DKGAgent): Promise<void> {
    const role = this.config.nodeRole ?? 'edge';
    // OT-RFC-38 LU-6 — host mode is a CORE-NODE-ONLY capability:
    // it holds curated CG ciphertext on behalf of members and
    // serves it back over `PROTOCOL_SWM_HOST_CATCHUP`. Edges
    // have no role in that custody chain and shouldn't retain
    // other CGs' encrypted SWM substrate on disk. Hard-gate
    // here so a copied `core` config dropped onto an edge does
    // NOT accidentally turn it into a ciphertext relay
    // (Codex PR #610 R3).
    if (role !== 'core') return;
    const hostModeCfg = this.config.swmHostMode ?? {};
    const enabled = hostModeCfg.enabled ?? true;
    if (!enabled) return;
    if (!this.config.dataDir) {
      this.log.warn(
        createOperationContext('system'),
        'SWM host-mode requested but no dataDir configured — disk-backed store cannot be created; host-mode disabled',
      );
      return;
    }
    const defaults = SwmHostModeStore.defaultLimits();
    const { join } = await import('node:path');
    const swmHostStartupCtx = createOperationContext('share');
    this.swmHostModeStore = new SwmHostModeStore({
      dataDir: join(this.config.dataDir, 'swm-host'),
      unregisteredLimits: hostModeCfg.unregistered ?? defaults.unregistered,
      registeredLimits: hostModeCfg.registered ?? defaults.registered,
      // B2: surface the orphan-log reconcile report through the
      // agent's log facade so operators can see exactly how many
      // bytes were recovered after a crash.
      onStartupReconcile: ({ orphanLogsRemoved, orphanBytesRemoved }) => {
        this.log.warn(
          swmHostStartupCtx,
          `Host-mode startup reconcile reaped orphan logs: count=${orphanLogsRemoved} bytes=${orphanBytesRemoved} ` +
          `(crashed appendFile→persistMeta windows produce these — they were unservable + unprunable until now)`,
        );
      },
    });
    await this.swmHostModeStore.init();

    // OT-RFC-38 / LU-6 Phase B — sliding-window rate-limiter for
    // pre-registration ciphertext writes. Configurable via the
    // same `swmHostMode` config block so operators can dial limits
    // up/down for testnet vs mainnet. Defaults match SPEC §1.2.4.
    const rlCfg = hostModeCfg.discoveryRateLimit ?? {};
    this.discoveryRateLimit = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: rlCfg.perCuratorBytesPerMinute,
      perCuratorBytesPerHour: rlCfg.perCuratorBytesPerHour,
      coreAggregateBytes: rlCfg.coreAggregateBytes,
    });
    // Seed the per-core aggregate counter from on-disk unregistered
    // ciphertext so a restart doesn't reset the budget. Per-curator
    // windows intentionally cold-start (the abuse-control horizon
    // is "ongoing", not "lifetime").
    try {
      const stats = await this.swmHostModeStore.stats();
      let unregisteredBytesOnDisk = 0;
      for (const cgStats of Object.values(stats.perCg)) {
        if (!cgStats.registered) unregisteredBytesOnDisk += cgStats.bytes;
      }
      this.discoveryRateLimit.seedAggregate(unregisteredBytesOnDisk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(createOperationContext('system'), `Could not seed discovery rate-limit aggregate from disk: ${msg}`);
    }

    this.log.info(
      createOperationContext('system'),
      `SWM host-mode store initialized at ${join(this.config.dataDir, 'swm-host')} (role=${role})`,
    );

  }

  /** Restore disk intent after the durable subscription admission plan exists. */
  async restoreSwmHostModeSubscriptions(this: DKGAgent): Promise<void> {
    if (!this.swmHostModeStore) return;
    const session = this.gossipSession;
    if (session.live() === null) return;
    // OT-RFC-38 LU-6 B3 — restore persisted host-mode subscriptions
    // BEFORE the chain-event poller starts. Chain events older than
    // the poller's lookback window would otherwise be silently lost
    // on restart, stranding CGs that the curator registered weeks
    // ago. The chain-event path + beacons remain the primary
    // mechanisms; this is the "we already knew about this CG before"
    // shortcut that keeps the per-restart re-derivation cheap.
    try {
      const previouslySubscribed = await this.swmHostModeStore.listHostModeSubscribedCgs();
      if (!session.active || this.gossipSession !== session) return;
      if (previouslySubscribed.length > 0) {
        // OT-RFC-49 WS-A — persisted host-mode subscriptions are curated by
        // construction (the curated check ran when each was first wired). With
        // the private-ciphertext strip ON (default) the restore loop must NOT
        // re-engage them: this path calls `wireSwmHostModeHandler` DIRECTLY and
        // so bypasses the subscribe-decline gate in
        // `reconcileSwmHostModeSubscription`. Skipping here closes the
        // restart-reintroduces-custody hole for cores that persisted host-mode
        // subs before the strip rolled out.
        if (this.swmHostModeStripCiphertext()) {
          this.log.info(
            createOperationContext('system'),
            `Skipping restore of ${previouslySubscribed.length} persisted host-mode subscription(s): ` +
            `private-ciphertext strip is ON (OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs)`,
          );
          return;
        }
        this.log.info(
          createOperationContext('system'),
          `Restoring ${previouslySubscribed.length} persisted host-mode subscription(s) from disk`,
        );
        for (const cgId of previouslySubscribed) {
          // Re-engage the gossip handler directly; we trust the
          // previous decision (the curated check ran when the
          // subscription was first wired). The chain-anchored
          // authority check on every envelope ingest still catches
          // revocations even if curator state has changed since.
          try {
            if (!session.active || this.gossipSession !== session) return;
            if (!this.automaticSwmHostModeAdmissionAllowed(cgId)) continue;
            this.wireSwmHostModeHandler(cgId, SUBSCRIPTION_SOURCES.RECONCILER, true);
            // Codex PR #620 R2: also re-probe registration state.
            // Without this, a host-only CG that was registered while
            // the node was offline stays on the 1MiB / 6h pre-reg
            // limits after restart and can prune valid ciphertext
            // permanently — `GraphManager.listContextGraphs()` only
            // sees local store graphs, so the periodic reconciler
            // can't heal it later either.
            await this.maybeMarkRegisteredForHostMode(cgId);
            if (!session.active || this.gossipSession !== session) return;
            this.automaticSwmHostModeAdmissionAllowed(cgId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(
              createOperationContext('system'),
              `Failed to restore host-mode subscription for "${cgId}": ${msg}`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('system'),
        `Failed to list persisted host-mode subscriptions: ${msg}`,
      );
    }
  }

  /**
   * OT-RFC-38 LU-6 — subscribe to a single CG's SWM topic in host
   * mode (store opaque ciphertext envelopes instead of decrypting).
   * No-op when the store isn't initialized, when the CG is system-
   * reserved, or when the node is already subscribed in member mode.
   */
  async reconcileSwmHostModeSubscription(this: DKGAgent,
    contextGraphId: string,
    source: SubscriptionSource = SUBSCRIPTION_SOURCES.RECONCILER,
  ): Promise<void> {
    const session = this.gossipSession;
    const live = session.live();
    if (live === null) return;
    if (!this.swmHostModeStore) return;
    if (!this.automaticSwmHostModeAdmissionAllowed(contextGraphId)) return;
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return;
    if (!this.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)) {
      // Host reconciliation is a second, independent path into the same
      // legacy SWM topic. Catalog authority must remove an already-wired host
      // handler as well as refuse a new one.
      this.unwireSwmHostModeHandler(contextGraphId);
      return;
    }
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      // Member-mode subscription already active — apply path covers
      // local consumption; no need to also opaquely store.
      return;
    }
    const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
    if (this.swmHostModeSubscribed.has(hostKey)) {
      // Codex PR #610 R2: idempotent re-entry on the periodic
      // reconcile path must still re-probe on-chain registration
      // state. Without this, a core that subscribed while the CG
      // was unregistered stays on the 6h/1MiB pre-registration
      // limits forever — even after the CG is registered — and
      // ciphertext gets pruned much earlier than intended.
      // Mirrors the same safeguard in `enableSwmHostModeFor`.
      //
      // The `has()` check goes through `canonicalSwmHostModeKey` so
      // a reconcile call with cleartext finds an entry written by
      // the chain-event/beacon path with the hash form (and vice
      // versa). Codex PR #672 review `id=3302086589`.
      if (
        this.swmHostModeStripCiphertext() &&
        this.swmHostModeCurated.get(hostKey) === false &&
        await this.isCuratedForHostMode(contextGraphId)
      ) {
        // A manually hosted CG can become curated later. Upgrade the cached
        // classification so the existing handler starts stripping immediately.
        if (!session.active || this.gossipSession !== session
          || !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)
          || this.swmHostModeAccessPolicy(contextGraphId) === 0) return;
        session.swmHostModeCurated.set(hostKey, true);
      }
      if (!session.active || this.gossipSession !== session
        || !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)) return;
      await this.maybeMarkRegisteredForHostMode(contextGraphId);
      if (!session.active || this.gossipSession !== session) return;
      this.automaticSwmHostModeAdmissionAllowed(contextGraphId);
      return;
    }

    // Only host curated CGs. Public CGs already have plaintext SWM
    // distribution and don't need an opaque ciphertext custodian.
    //
    // A numeric policy, verified curated beacon or native private metadata
    // proves curation. A name commitment alone does not prove access policy.
    const curated = await this.isCuratedForHostMode(contextGraphId);
    if (!curated || !session.active || this.gossipSession !== session
      || !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)
      || this.swmHostModeAccessPolicy(contextGraphId) === 0) return;

    // OT-RFC-49 WS-A — the private-ciphertext strip. With `stripCiphertext`
    // ON (default), a core declines ALL host-mode custody for a curated CG:
    // "hosting follows access". Random sampling now proves the public
    // `_catalog`, so the core no longer needs the ciphertext — private data
    // lives member-side and members backfill from the curator. Declining the
    // subscribe HERE is the primary choke point: it starves both the legacy
    // `.meta` host-mode ingest AND the LU-11 chunk ingest (both are wired by
    // `wireSwmHostModeHandler`), regardless of how the CG was discovered
    // (reconciler / beacon / chain-event all funnel through this method).
    // Unlike rung-1's narrower `stripNonParticipants` gate, WS-A strips for
    // EVERY curated CG regardless of participation. Set `false` to restore
    // legacy auto-host (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.info(
        createOperationContext('system'),
        `SWM host-mode subscription DECLINED for "${contextGraphId}": private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs; members backfill from the curator)`,
      );
      return;
    }

    this.wireSwmHostModeHandler(contextGraphId, source, true);
    await this.awaitHostModePersistence(contextGraphId);
    if (!session.active || this.gossipSession !== session
      || !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)) return;
    await this.maybeMarkRegisteredForHostMode(contextGraphId);
    if (!session.active || this.gossipSession !== session
      || !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)) return;

    this.log.info(
      createOperationContext('system'),
      `SWM host-mode subscription enabled for "${contextGraphId}" (role=core)`,
    );
  }

  /**
   * OT-RFC-49 WS-A — resolve the private-ciphertext strip kill-switch.
   * Default ON: `stripCiphertext === undefined` strips. Only an explicit
   * `false` restores legacy host-mode custody. Centralised so every gated
   * entry point (subscribe-decline, restart-restore skip, operator-hatch
   * refusal, serve-responder retire) reads the same flag the same way.
   */
  swmHostModeStripCiphertext(this: DKGAgent): boolean {
    return this.config.swmHostMode?.stripCiphertext ?? true;
  }

  /** Exact local identity wins; absent raw wire requests use native routing. */
  swmHostModeLocalId(this: DKGAgent, contextGraphId: string): string {
    if (this.subscribedContextGraphs.has(contextGraphId)
      || this.contextGraphSubscriptionDormancyById.has(contextGraphId)) return contextGraphId;
    const wireId = normalizeContextGraphNameHash(contextGraphId);
    if (wireId === null) return contextGraphId;
    if (this.subscribedContextGraphs.has(wireId)
      || this.contextGraphSubscriptionDormancyById.has(wireId)) return wireId;
    return this.resolveContextGraphIdAlias(wireId) ?? wireId;
  }

  /** Automatic hosting cannot activate saved intent that admission left dormant. */
  automaticSwmHostModeAdmissionAllowed(this: DKGAgent, contextGraphId: string): boolean {
    const localId = this.swmHostModeLocalId(contextGraphId);
    if (!this.contextGraphSubscriptionDormancyById.has(localId)
      || isAdmittedContextGraphSubscription(this.subscribedContextGraphs.get(localId))) return true;
    const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
    // Refusal of A cannot retire an operator handler or another slot's owner B.
    if (this.swmHostModeSubscribed.get(hostKey) !== SUBSCRIPTION_SOURCES.MANUAL
      && this.wireIdToLocalCgId.get(hostKey) === localId) this.unwireSwmHostModeHandler(contextGraphId);
    return false;
  }

  /** Numeric policy is authoritative over metadata and same-hash beacon hints. */
  swmHostModeAccessPolicy(this: DKGAgent, contextGraphId: string): number | undefined {
    let sub = this.subscribedContextGraphs.get(this.swmHostModeLocalId(contextGraphId));
    if (!sub?.onChainId && normalizeContextGraphNameHash(contextGraphId) !== null) {
      const owner = this.wireIdToLocalCgId.get(this.canonicalSwmHostModeKey(contextGraphId));
      sub = owner === undefined ? undefined : this.subscribedContextGraphs.get(owner);
    }
    return sub?.onChainId ? this.onChainAccessPolicyCache.get(sub.onChainId) : undefined;
  }

  /** Manual authority uses current identity, not a retired predecessor's status. */
  manualSwmHostModeLocalId(this: DKGAgent, contextGraphId: string): string {
    if (this.subscribedContextGraphs.has(contextGraphId)) return contextGraphId;
    const wireId = normalizeContextGraphNameHash(contextGraphId);
    if (wireId === null) return contextGraphId;
    if (this.subscribedContextGraphs.has(wireId)) return wireId;
    return this.resolveContextGraphIdAlias(wireId) ?? wireId;
  }

  /** Manual strip-on custody requires this exact routed slot's public proof. */
  isExactPublicManualSwmHostMode(this: DKGAgent, contextGraphId: string, hostKey: string): boolean {
    const localId = this.manualSwmHostModeLocalId(contextGraphId);
    const subscription = this.subscribedContextGraphs.get(localId);
    const onChainId = subscription?.onChainId;
    const wireOwner = this.wireIdToLocalCgId.get(hostKey);
    return isCanonicalAuthoritativeContextGraphId(onChainId)
      && normalizeContextGraphNameHash(subscription?.onChainHash) === hostKey
      && localContextGraphIdMatchesCommittedNameHash(localId, hostKey, id => this.isWireIdKeyedSubscription(id))
      && this.canonicalSwmHostModeKey(contextGraphId) === hostKey
      && (wireOwner === undefined || wireOwner === localId)
      && this.onChainAccessPolicyCache.get(onChainId) === 0;
  }

  /** Curation requires actual policy, signed beacon verification or private metadata. */
  async isCuratedForHostMode(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const policy = this.swmHostModeAccessPolicy(contextGraphId);
    if (policy !== undefined) return policy === 1;
    if (this.beaconCuratorByWireId.has(this.canonicalSwmHostModeKey(contextGraphId))) return true;
    try {
      const privateMetadata = await this.isPrivateContextGraph(this.swmHostModeLocalId(contextGraphId));
      const currentPolicy = this.swmHostModeAccessPolicy(contextGraphId);
      return currentPolicy === undefined ? privateMetadata : currentPolicy === 1;
    } catch {
      return false;
    }
  }

  /**
   * GH #1124 — DEFINITIVE "fully-open CG" check gating the self-signed public
   * host-mode ingest path. "Open" requires BOTH axes, because this codebase
   * separates READ visibility from WRITE authority:
   *   - accessPolicy === 0  → publicly READABLE (SWM is plaintext), AND
   *   - publishPolicy === 1 → OPEN PUBLISH (anyone may write).
   * A public-readable but curated-publish CG (accessPolicy 0, publishPolicy 0 /
   * PCA) still restricts WHO may publish, so the self-signed path must NOT apply
   * — otherwise any key could store plaintext SWM on host-mode cores and bypass
   * the on-chain publisher authorization (otReviewAgent #1239-r3). Curated OR
   * unknown on EITHER axis → false: the conservative ciphertext + allowlist gates
   * stay in force and a chain-event race heals via member catchup, so a curated
   * (or restricted-publish) CG is never misclassified as self-publishable.
   */
  async isConfirmedPublicForHostMode(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    // Resolve via the SHARED on-chain policy resolver rather than a direct
    // cleartext `subscribedContextGraphs` lookup. `getContextGraphOnChainPolicy`
    // re-keys cleartext↔on-chain-id, consults the cache + local `_meta`, AND
    // falls back to a direct chain RPC — so it resolves BOTH policies even for a
    // host-only core keyed by the wire HASH with no local `_meta` (the #1124
    // sharded topology). Both must positively resolve to their open value; any
    // undefined (unknown) → false (safe).
    try {
      // `publishPolicyMaxCacheAgeMs`: publishPolicy is mutable on-chain and the
      // general cache is ≤60s-TTL'd, so it could be stale-PERMISSIVE for up to
      // the TTL after an owner downgrades open→curated publish. This is a
      // security-positive gate (it admits a self-signed plaintext write that host
      // catchup later applies under trustedReplay), so it accepts only a SHORT
      // (~5s) cache window — bounding the downgrade staleness to seconds while
      // rate-capping the chain RPC to ~1 per window per CG (vs an eth_call on
      // every admitted envelope). An RPC failure/timeout leaves publishPolicy
      // undefined → we fail CLOSED (drop; the share heals via retry/catchup
      // once the policy re-resolves).
      const { accessPolicy, publishPolicy } = await this.getContextGraphOnChainPolicy(
        contextGraphId, { publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS },
      );
      return accessPolicy === 0 && publishPolicy === 1;
    } catch {
      return false;
    }
  }

  /**
   * Register the host-mode gossip handler for `contextGraphId` and
   * track its reference so {@link unwireSwmHostModeHandler} can
   * remove ONLY that handler later (without touching member-mode
   * handlers or other consumers of the same topic). Idempotent.
   *
   * Both `reconcileSwmHostModeSubscription` (sharding-driven) and
   * `enableSwmHostModeFor` (operator-driven) funnel through here
   * so the host-mode lifecycle is in one place.
   */
  wireSwmHostModeHandler(this: DKGAgent,
    contextGraphId: string,
    source: SubscriptionSource = SUBSCRIPTION_SOURCES.RECONCILER,
    curated = true,
  ): void {
    const session = this.gossipSession;
    const live = session.live();
    if (live === null) return;
    if (source !== SUBSCRIPTION_SOURCES.MANUAL
      && !this.automaticSwmHostModeAdmissionAllowed(contextGraphId)) return;
    if (!this.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)) {
      const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
      const hadRuntimeHostState = session.swmHostModeHandlers.has(hostKey)
        || session.swmHostModeSubscribed.has(hostKey)
        || session.swmHostModeCurated.has(hostKey);
      this.unwireSwmHostModeHandler(contextGraphId);
      const deletedStaleHandler = session.swmHostModeHandlers.delete(hostKey);
      const deletedStaleSubscription = session.swmHostModeSubscribed.delete(hostKey);
      const deletedStaleClassification = session.swmHostModeCurated.delete(hostKey);
      if (deletedStaleHandler || deletedStaleSubscription || deletedStaleClassification) {
        // Heal partially restored/stale bookkeeping even when its handler
        // reference is absent, which makes unwireSwmHostModeHandler a no-op.
        this.enqueueHostModePersistence(contextGraphId, false);
      } else if (!hadRuntimeHostState) {
        // The restart restore path calls this method from a persisted marker
        // before rebuilding runtime maps. Clear that marker too, otherwise
        // every catalog-authoritative restart would retry the legacy host path.
        this.enqueueHostModePersistence(contextGraphId, false);
      }
      return;
    }
    // OT-RFC-38 / LU-6 Phase B — host-mode subscribes on the wire-form
    // topic. For chain-event-driven auto-subscribe, `contextGraphId`
    // IS the wire id (the core has no cleartext to translate from).
    // For an operator-driven `enableSwmHostModeFor("cleartext-id")`
    // path on a node that's also a member, `gossipWireIdFor`
    // resolves to the curator-committed hash via the local meta.
    //
    // Codex PR #672 review `id=3302086589`: canonicalize FIRST and
    // key both bookkeeping maps off `wireCgId` so a chain-event-
    // driven hash subscribe collides with a later manual-driven
    // cleartext subscribe on the SAME CG and the second call is a
    // genuine no-op (instead of silently wiring a second handler on
    // the same topic).
    const wireCgId = this.canonicalSwmHostModeKey(contextGraphId);
    if (session.swmHostModeHandlers.has(wireCgId)) {
      // Idempotent re-entry — preserve the original source. The first
      // discovery path to wire the handler wins the provenance label;
      // a later path covering the same CG is "also true" but the
      // operator-meaningful answer is "which path got us here first".
      return;
    }
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    session.swmHostModeSubscribed.set(wireCgId, source);
    session.swmHostModeCurated.set(wireCgId, curated);
    live.manager.subscribe(swmTopic);
    const delegate = createSwmHostModeHandler(this, this.log, session, contextGraphId, wireCgId);
    // Manual public custody must remain proven after enable returns or yields.
    // Automatic callbacks retain their existing positive-private admission.
    const handler = source === SUBSCRIPTION_SOURCES.MANUAL
      ? (topic: string, data: Uint8Array, from: string): void => {
        if (this.swmHostModeStripCiphertext()
          && !this.isExactPublicManualSwmHostMode(contextGraphId, wireCgId)) return;
        delegate(topic, data, from);
      }
      : delegate;
    session.swmHostModeHandlers.set(wireCgId, handler);
    live.manager.onMessage(swmTopic, handler);
    // B3: persist the host-mode designation so a restart re-engages
    // this handler before the chain-event poller catches up.
    // Codex PR #620 R2: chain wire/unwire writes through a per-CG
    // serialization queue so mark/unmark calls always land on disk
    // in invocation order. Without this, back-to-back mark→unmark
    // could write `true` after `false` and a restart would re-subscribe
    // a torn-down CG. Still non-blocking at the wire level.
    this.enqueueHostModePersistence(contextGraphId, true);
  }

  /**
   * Surgically remove the host-mode gossip handler for
   * `contextGraphId` (does NOT call `gossip.unsubscribe`, which
   * would drop every handler on the topic). Used when the same
   * core gains member authorization for the CG — apply-and-ack
   * via the member handler then supersedes opaque hosting.
   * Idempotent; no-op when no host handler is registered.
   *
   * Codex PR #610 R3: without this, member- and host-mode
   * handlers would both fire on every gossip message, causing
   * each envelope to be (a) decrypted-and-applied AND (b)
   * appended opaquely. Wasted disk + apply work.
   */
  unwireSwmHostModeHandler(this: DKGAgent, contextGraphId: string): void {
    // Both bookkeeping maps are canonical-keyed (see
    // {@link canonicalSwmHostModeKey}); canonicalize the input
    // before lookup so the unwire path is shape-agnostic just like
    // the wire path.
    const wireCgId = this.canonicalSwmHostModeKey(contextGraphId);
    const handler = this.swmHostModeHandlers.get(wireCgId);
    if (!handler) return;
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    this.gossip.offMessage(swmTopic, handler);
    this.swmHostModeHandlers.delete(wireCgId);
    this.swmHostModeSubscribed.delete(wireCgId);
    this.swmHostModeCurated.delete(wireCgId);
    // B3: clear the persisted host-mode designation so a restart
    // does NOT re-engage. Serialized via the per-CG persistence
    // queue (see `enqueueHostModePersistence` for the ordering
    // rationale).
    this.enqueueHostModePersistence(contextGraphId, false);
  }

  /**
   * Per-CG promise chain for host-mode mark/unmark writes. Codex
   * PR #620 R2: prior fire-and-forget invocation made restart state
   * nondeterministic — a stale mark() write could land AFTER a fresh
   * unmark() and a subsequent restart would re-subscribe a CG that
   * was already torn down.
   *
   * The chain serializes ALL writes for a given CG so they hit disk
   * in invocation order. The wire/unwire callers stay synchronous;
   * persistence is awaited only by the chain itself.
   */
  /**
   * Resolve the on-disk store key for a host-mode persistence
   * mutation. The {@link SwmHostModeStore} is cleartext-keyed by
   * design (`append` / `iterate` / `markRegistered` all key off the
   * cleartext id the gossip envelope carries — see
   * {@link ingestSwmHostModeEnvelope}). The persisted
   * `hostModeSubscribed` flag MUST use that same cleartext key so a
   * `mark` taken in one id shape and a later `unmark` in the other
   * (e.g. beacon/chain auto-host engages by wire-hash, then a
   * promoted-to-member or curator-revoke unwire arrives in cleartext)
   * collapse onto a single `.meta` file instead of leaving the flag
   * stuck under an orphan key — which would re-engage a torn-down CG
   * on the next restart. Wire-form (0x-hash) inputs are translated
   * back through the {@link wireIdToLocalCgId} reverse index; an
   * as-yet-unmapped hash falls back to itself.
   */
  hostModePersistenceStoreKey(this: DKGAgent, rawCgId: string): string {
    if (/^0x[0-9a-fA-F]{64}$/.test(rawCgId)) {
      const lower = rawCgId.toLowerCase();
      return this.wireIdToLocalCgId.get(lower) ?? lower;
    }
    return rawCgId;
  }

  enqueueHostModePersistence(this: DKGAgent, contextGraphId: string, subscribe: boolean): void {
    if (!this.swmHostModeStore) return;
    // The in-memory queue stays wire-keyed so ordering dedups across
    // id shapes (cleartext vs wire-hash for the same CG); the store
    // mutation itself is cleartext-keyed via
    // {@link hostModePersistenceStoreKey}.
    const queueKey = this.canonicalSwmHostModeKey(contextGraphId);
    const storeCgId = this.hostModePersistenceStoreKey(contextGraphId);
    const store = this.swmHostModeStore;
    const op = subscribe ? 'mark' : 'unmark';
    const apply = async (): Promise<void> => {
      try {
        if (subscribe) {
          await store.markHostModeSubscribed(storeCgId);
        } else {
          await store.markHostModeUnsubscribed(storeCgId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug(
          createOperationContext('system'),
          `Host-mode persistence (${op}) failed for "${storeCgId}": ${msg}`,
        );
      }
    };
    const prev = this.hostModePersistenceQueues.get(queueKey) ?? Promise.resolve();
    const next = prev.then(apply, apply);
    this.hostModePersistenceQueues.set(queueKey, next);
    void next.finally(() => {
      if (this.hostModePersistenceQueues.get(queueKey) === next) {
        this.hostModePersistenceQueues.delete(queueKey);
      }
    });
  }

  async awaitHostModePersistence(this: DKGAgent, contextGraphId: string): Promise<void> {
    const pending = this.hostModePersistenceQueues.get(this.canonicalSwmHostModeKey(contextGraphId));
    if (pending) await pending;
  }

  /**
   * Periodic reconciler driven by `hostModeReconcilerTimer`. Sweeps
   * a bounded slice of locally-known CGs and ensures host-mode
   * subscription is in sync. The cursor rotates through the stable
   * sorted set so large stores converge without each tick touching
   * every known graph.
   *
   * Serialized via `hostModeReconcileInflight` so an overlap with
   * the cleanup timer (or a manual call from a test) doesn't
   * double-subscribe.
   */
  async reconcileHostModeSubscriptions(this: DKGAgent): Promise<void> {
    if (!this.swmHostModeStore) return;
    if (this.hostModeReconcileInflight) {
      await this.hostModeReconcileInflight;
      return;
    }
    const inflight = (async () => {
      try {
        const graphManager = new GraphManager(this.store);
        const knownCgs = (
          await graphManager.listContextGraphs({
            source: 'agent.swmHostMode.listContextGraphs',
          })
        ).sort();
        if (knownCgs.length === 0) {
          this.hostModeReconcileCursor = 0;
          return;
        }
        const batchSize = normalizeHostModeReconcileBatchSize(this.config.swmHostMode?.reconcileBatchSize);
        const start = this.hostModeReconcileCursor % knownCgs.length;
        const count = Math.min(batchSize, knownCgs.length);
        for (let i = 0; i < count; i++) {
          const index = (start + i) % knownCgs.length;
          const cgId = knownCgs[index];
          try {
            await this.reconcileSwmHostModeSubscription(cgId);
          } finally {
            this.hostModeReconcileCursor = (index + 1) % knownCgs.length;
          }
        }
      } finally {
        this.hostModeReconcileInflight = undefined;
      }
    })();
    this.hostModeReconcileInflight = inflight;
    await inflight;
  }

  /** Probes the local on-chain meta to decide if a CG is registered. Tolerant of missing chain adapter. */
  async isContextGraphRegisteredOnChain(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    try {
      if (typeof (this.chain as any).getContextGraphOnChain !== 'function') return false;
      const onChain = await (this.chain as any).getContextGraphOnChain(contextGraphId);
      return Boolean(onChain);
    } catch {
      return false;
    }
  }

  /**
   * Tap registered with `gossip.onMessage` for host-mode topics.
   *
   * Two-phase validation before opaque storage:
   *   1. Cheap structural sniff — drop non-envelopes, cross-CG
   *      spoofs, plaintext bursts (curated SWM is always
   *      ciphertext-wrapped).
   *   2. Codex PR #610 R4: cryptographic authority check via
   *      `SharedMemoryHandler.verifyHostModeEnvelopeAuthority` —
   *      verify the envelope signature and confirm the recovered
   *      signer is in the CG's agent allowlist (and `from` is in
   *      the peer allowlist if one is set). Without this, an
   *      unauthorized peer could fill the per-CG FIFO cap with
   *      structurally-valid junk and evict legitimate ciphertext
   *      history once eviction kicked in.
   *
   * We do NOT attempt decryption — the chain key lives on
   * members, not on the hosting core. Members re-verify the
   * envelope signature on replay too via
   * `SharedMemoryHandler.handle({ trustedReplay: true })`.
   */
  async ingestSwmHostModeEnvelope(this: DKGAgent,
    contextGraphId: string,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<void> {
    if (!this.swmHostModeStore) return;
    if (data.length === 0) return;
    const ctx = createOperationContext('share');
    let envelope: GossipEnvelopeMsg | undefined;
    try {
      envelope = decodeGossipEnvelope(data);
    } catch {
      return;
    }
    if (!envelope || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH) {
      return;
    }
    if (envelope.payload.length === 0) return;
    // OT-RFC-38 / LU-6 Phase B — `contextGraphId` is the SUBSCRIPTION
    // key, which can be EITHER cleartext (operator-driven
    // `/host-mode/subscribe`, or a node that's also a CG member) OR
    // the wire-id hash (chain-event / beacon driven auto-host on a
    // host-only core). The envelope itself still carries CLEARTEXT in
    // `envelope.contextGraphId` (see `publishWorkspaceGossip` comment
    // about the "envelope stays cleartext" compromise).
    //
    // The legacy strict equality check rejected the host-only-core
    // path 100% of the time, silently dropping every Phase B auto-
    // hosted envelope. Translate both sides to the wire-form (hash)
    // and compare there — this accepts the envelope whenever it was
    // published for the same CG as the local subscription, regardless
    // of which side speaks cleartext.
    //
    // From here on, prefer `envelope.contextGraphId` as the canonical
    // local key for store + authority lookups: it's the cleartext
    // form, which the meta-graph + chain-fallback resolvers can
    // translate to numeric / chain queries natively, and matches
    // what the member's LU-6 host-catchup request will use to fetch
    // the ciphertext back. This means a host-only core's per-CG
    // store entries are keyed by cleartext from the FIRST received
    // envelope onward — cleaner than maintaining two parallel keys.
    const envelopeWireId = this.gossipWireIdFor(envelope.contextGraphId);
    const subscriptionWireId = this.gossipWireIdFor(contextGraphId);
    if (envelopeWireId !== subscriptionWireId) {
      return;
    }
    const storageCgId = envelope.contextGraphId;
    // Keep the wire-id → cleartext reverse index in sync so the
    // chain-fallback resolver and the catchup-request path can
    // translate either direction without an extra RPC.
    if (storageCgId !== contextGraphId) {
      const storageSubscription = this.subscribedContextGraphs.get(storageCgId) ?? {
        syncMode: 'always-on' as const,
        subscribed: false,
        synced: false,
        pendingMeta: true,
      };
      this.setContextGraphSubscription(storageCgId, {
        ...storageSubscription,
        onChainHash: subscriptionWireId,
      }, { persist: false });
    }
    // Cheap "is this ciphertext" sniff: try to decode as one of the
    // two encrypted carriers; if neither parses, drop early so we
    // don't pay the signature-verify cost on obvious garbage.
    let isCiphertext = false;
    try {
      const enc = decodeEncryptedWorkspacePayload(envelope.payload);
      isCiphertext = enc.type === ENCRYPTED_WORKSPACE_ENVELOPE_TYPE;
    } catch { /* fall through */ }
    if (!isCiphertext) {
      try {
        const skm = decodeSwmSenderKeyMessage(envelope.payload);
        isCiphertext = skm.type === SWM_SENDER_KEY_MESSAGE_TYPE;
      } catch { /* fall through */ }
    }
    // GH #1124 — a curated CG MUST carry ciphertext, so a non-ciphertext
    // envelope there is garbage → drop early. A CONFIRMED-public (open) CG
    // legitimately gossips PLAINTEXT SWM. Resolve the public flag and reuse it
    // for both the plaintext gate and the authority check. UNKNOWN CGs stay on
    // the drop path (safe; member catchup heals once the policy resolves).
    //
    // LAZY by design (Branimir review #1239 follow-on): the self-signed public
    // exception only matters for `!isCiphertext` traffic. So short-circuit on
    // `!isCiphertext` to skip the (now chain-backed) policy resolution entirely
    // on the dominant CIPHERTEXT/curated path — otherwise the bulk of host-mode
    // traffic would pay a synchronous eth_call to compute a value it discards.
    // Security-preserving: a ciphertext envelope on a public CG just stays in the
    // curated authority path / opaque append and heals via catchup.
    const confirmedPublic = !isCiphertext && await this.isConfirmedPublicForHostMode(storageCgId);
    if (!isCiphertext && !confirmedPublic) return;

    // Authority check. Curated traffic verifies the envelope signature against
    // the CG's agent allowlist. For a self-publishable (open) CG, inject the
    // on-chain policy RESOLVER (not a pre-decided flag): the SHARED verifier
    // re-checks accessPolicy===0 && publishPolicy===1 itself, then validates the
    // signature + timestamp-freshness AND binds the inner request to THIS CG —
    // same envelope validation as curated, only the allowlist decision diverges
    // (see SharedMemoryHandler.verifyHostModeEnvelopeAuthority).
    //
    // Use `storageCgId` (cleartext from the envelope) so the meta-graph +
    // chain-fallback resolvers work on the canonical id shape.
    const handler = this.getOrCreateSharedMemoryHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(
      data, storageCgId, fromPeerId,
      // Inject the on-chain policy RESOLVER (not a pre-decided flag) so the
      // verifier enforces accessPolicy===0 && publishPolicy===1 itself and can
      // take the self-signed path even when a STALE participant allowlist
      // survives an open-publish flip. Lazy: pass it only for non-ciphertext,
      // so the dominant ciphertext/curated path pays no chain read (the resolver
      // shares the same ~5s publishPolicy cache window as the confirmedPublic
      // resolution above, so this is at most a warm cache hit, never a 2nd RPC).
      isCiphertext
        ? undefined
        : {
          resolveOpenPublishPolicy: () => this.getContextGraphOnChainPolicy(
            storageCgId, { publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS },
          ),
        },
    );
    if (!verdict.accepted) {
      // 'no agent allowlist' on a NON-public CG is the expected brief chain-event
      // race (curated allowlist not loaded yet) — recoverable via member catchup,
      // so log at debug. Every other rejection (decode / unsigned / signature-or-
      // freshness / peer-not-allowed / CG-mismatch) is a real authority failure
      // operators should see.
      const isTransientRace = verdict.reasonCode === 'NO_AGENT_ALLOWLIST';
      if (isTransientRace) {
        this.log.debug(
          ctx,
          `Host-mode SWM envelope dropped for cg=${storageCgId} from=${fromPeerId}: ${verdict.reason} (transient chain-event race; member will catchup)`,
        );
      } else {
        this.log.warn(
          ctx,
          `Host-mode SWM envelope rejected for cg=${storageCgId} from=${fromPeerId}: ${verdict.reason}`,
        );
      }
      return;
    }

    // OT-RFC-38 / LU-6 Phase B — pre-registration ciphertext rate-
    // limit. Apply only to CGs that have NOT been marked registered
    // on the host-mode store (registered CGs are gated by chain
    // economics + the on-chain participant allowlist, not the
    // freemium-tier per-wallet windows). The rate-limit decision
    // mutates `discoveryRateLimit` ONLY when it admits, so a
    // rejection here does not consume any per-curator budget.
    //
    // Step 1: opportunistically flip the store's `registered` flag
    // BEFORE the rate-limit decision. Without this, an envelope
    // that arrives on a CG that was registered on chain seconds
    // earlier (but where the periodic reconciler hasn't swept yet)
    // would still hit the per-curator window and likely get dropped
    // — a known race when the curator publishes immediately after
    // their `registerContextGraph` tx confirms.
    await this.maybeMarkRegisteredForHostMode(storageCgId);
    let isRegistered = false;
    try {
      isRegistered = await this.swmHostModeStore.isRegistered(storageCgId);
    } catch {
      isRegistered = false;
    }
    if (!isRegistered && this.discoveryRateLimit) {
      // `beaconCuratorByWireId` is keyed by the WIRE id (hash);
      // `subscriptionWireId` IS the wire id already (we hashed
      // `contextGraphId` above), so look up directly.
      const curatorEoa = this.beaconCuratorByWireId.get(subscriptionWireId);
      if (!curatorEoa) {
        // No beacon was ever received for this wire id, yet
        // ciphertext arrived. Two legitimate windows produce this:
        //   - The CG is registered on chain but the local node has
        //     not seen the `ContextGraphCreated` event yet (the
        //     event poller's lookback hasn't covered the block).
        //     Mitigated by the `maybeMarkRegisteredForHostMode`
        //     call above — but that's best-effort and a transient
        //     RPC failure can leave us here.
        //   - An attacker is trying to bypass the per-wallet window
        //     by skipping the beacon broadcast.
        // We fail OPEN in both cases: the per-CG byte cap +
        // pre-reg TTL on the SwmHostModeStore is the safety net.
        // Promoting this from "drop" to "log + admit" trades a
        // marginal abuse window (an unauthenticated wallet can
        // burn one per-CG byte cap before the chain reconciler
        // catches up) for not losing freshly-registered CG
        // ciphertext during the chain-event race. The chain-
        // economics gate on actually-registered CGs makes the
        // exposure bounded.
        this.log.debug(
          ctx,
          `Host-mode admitting pre-reg cg=${storageCgId} wireId=${subscriptionWireId.slice(0, 12)}… without curator binding (no beacon yet; per-CG byte cap remains the safety net)`,
        );
      } else {
        const admission = this.discoveryRateLimit.admit(curatorEoa, data.length);
        if (!admission.admit) {
          this.log.warn(
            ctx,
            `Host-mode rejected pre-reg envelope cg=${storageCgId} curator=${curatorEoa}: ${admission.reason}`,
          );
          return;
        }
      }
    }
    // GH #1124 — make a CONFIRMED-PUBLIC host-only (non-member) core ACK-CAPABLE.
    // The opaque `append` below retains the raw envelope so this host can serve
    // member host-catchup (LU-6 replay), but the StorageACKHandler a publisher
    // dials reads `<cg>/_shared_memory` from `this.store` (loadSWMQuads /
    // sharedMemoryReadBothFilter) — it has NO path into SwmHostModeStore. So
    // without ALSO applying the plaintext into that triple-store graph, a
    // non-member host would still DECLINE `NO_DATA_IN_SWM` and a public CG's
    // storage-ACK quorum stays unreachable on a host-mode (non-member) topology
    // — the exact bug this PR claims to fix. Reuse the member apply path
    // (`handle`) on the SAME, already-authority-verified envelope bytes; for a
    // public CG it routes the plaintext quads to the per-KA SWM layer the ACK
    // handler reads (graph-agnostic merkle, no re-skolemize), so the recompute
    // matches and this host signs a quorum-eligible ACK exactly as a member does.
    //
    // SECURITY — the `if (confirmedPublic)` wrapper is the SOLE authority gate
    // for this apply, and it is LOAD-BEARING: on a host-only core `handle()`
    // CANNOT distinguish curated from public (a non-member holds no local `_meta`
    // allowlist nor accessPolicy, so a curated AND a public CG both resolve to
    // `agentGateAddresses === null` && `hasPrivateAccessPolicy === false`, and
    // `handle()` would apply plaintext for EITHER). What guarantees this CG is
    // genuinely public is `isConfirmedPublicForHostMode` — accessPolicy === 0
    // (immutable) AND a FORCED-fresh publishPolicy === 1 (fail-closed on RPC
    // error). DO NOT hoist this apply out of the `confirmedPublic` branch or
    // reuse a `confirmedPublic` resolved further from the apply — either silently
    // re-opens curated-plaintext injection into a non-member's SWM store.
    // `verifyHostModeEnvelopeAuthority` already bound sig + 5-min freshness + CG +
    // `publisherPeerId === fromPeerId` on these exact `data` bytes one block up,
    // so `handle({ trustedReplay: true })` skips only the transport re-checks it
    // already performed — for a public CG (agentGateAddresses === null) it skips
    // no cryptography. Mirrors the catchup-replay call (~line 3575).
    if (confirmedPublic) {
      try {
        const apply = await handler.handle(data, fromPeerId, undefined, { trustedReplay: true });
        if (apply.applied) {
          this.log.info(
            ctx,
            `Host-mode applied confirmed-public SWM plaintext cg=${storageCgId} triples=${apply.insertedTriples ?? 0} (now ACK-capable)`,
          );
        } else {
          // Apply declined (validation / CAS / dedup). Keep going to the opaque
          // append so member catchup still works; this host just won't ACK this
          // share (it falls back to the pre-fix NO_DATA_IN_SWM decline). Logged
          // at WARN so a SYSTEMATIC public-CG apply failure is observable here
          // rather than only downstream as quorum-unmet.
          const reason = 'reason' in apply ? apply.reason : 'unknown';
          this.log.warn(
            ctx,
            `Host-mode confirmed-public SWM apply NOT applied cg=${storageCgId}: ${reason} (host keeps opaque copy for catchup but will DECLINE NO_DATA_IN_SWM on ACK)`,
          );
        }
      } catch (err) {
        // Never let an apply error drop the opaque retention path below.
        this.log.warn(
          ctx,
          `Host-mode confirmed-public SWM apply threw cg=${storageCgId}: ${err instanceof Error ? err.message : String(err)} (opaque retention below unaffected)`,
        );
      }
    }

    const seqno = await this.swmHostModeStore.append(storageCgId, data);
    this.log.debug(
      ctx,
      `Host-mode stored opaque SWM envelope cg=${storageCgId} seqno=${seqno} bytes=${data.length}`,
    );
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — chunked-ciphertext SWM ingest.
   * Receives per-chunk SWM gossip envelopes
   * (`type='share-write-chunked'`) that the publisher fans out via
   * `_resolveEncryptInlineChunked`, verifies envelope authority
   * against the curated CG's agent allowlist (same gate as the
   * legacy host-mode store), strips the 32-byte `batchId` prefix
   * from the payload, and persists the remaining ciphertext bytes
   * under the deterministic chunk-store subject so the V2 ACK
   * verifier can recompute the publisher's claimed
   * `ciphertextChunksRoot` keyed by `(cgId, batchId, chunkIndex)`.
   *
   * Persistence model: one base64-encoded literal per chunk, in the
   * per-CG named graph `ciphertextChunkStoreGraph(cgId)` under the
   * subject `ciphertextChunkStoreSubject(batchId, chunkIndex)`. The
   * store insert is idempotent — the same chunk arriving twice (or
   * out of order) overwrites the existing triple harmlessly because
   * `subject + predicate + graph` is unique.
   *
   * Late-join cores that come online after a publish has finalised
   * end up here only opportunistically (if a peer's mesh re-floods
   * the chunked envelope), which is unreliable; commit 7 adds the
   * `GetCiphertextChunk` sync verb that pulls missing chunks
   * explicitly via the protocol router.
   */
  async ingestSwmCiphertextChunkEnvelope(this: DKGAgent,
    contextGraphId: string,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<void> {
    if (data.length === 0) return;
    const ctx = createOperationContext('share');
    let envelope: GossipEnvelopeMsg | undefined;
    try {
      envelope = decodeGossipEnvelope(data);
    } catch {
      return;
    }
    if (!envelope || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED) {
      return;
    }
    if (envelope.payload.length <= 32) {
      // Chunked payload format: [32-byte batchId][ciphertext...].
      // Anything shorter can't carry a single ciphertext byte.
      this.log.debug(
        ctx,
        `LU-11: ignoring chunked envelope on cg=${contextGraphId} from=${fromPeerId} with truncated payload (${envelope.payload.length} bytes)`,
      );
      return;
    }
    if (typeof envelope.swmMessageIndex !== 'number' || envelope.swmMessageIndex < 0) {
      this.log.debug(
        ctx,
        `LU-11: ignoring chunked envelope on cg=${contextGraphId} with invalid swmMessageIndex=${envelope.swmMessageIndex}`,
      );
      return;
    }

    // Subscription CG-id can be either cleartext (operator / member
    // path) or wire-form hash (chain-event auto-subscribe). Compare
    // both sides in wire-form so any combination accepts.
    const envelopeWireId = this.gossipWireIdFor(envelope.contextGraphId);
    const subscriptionWireId = this.gossipWireIdFor(contextGraphId);
    if (envelopeWireId !== subscriptionWireId) return;
    const storageCgId = envelope.contextGraphId;

    // Verify envelope signature against the curated CG's agent
    // allowlist — exactly the same authority check the host-mode
    // store uses; without it, any topic-reachable peer could plant
    // arbitrary ciphertext under a victim's (cgId, batchId) keys.
    const handlerSm = this.getOrCreateSharedMemoryHandler();
    const verdict = await handlerSm.verifyHostModeEnvelopeAuthority(data, storageCgId, fromPeerId);
    if (!verdict.accepted) {
      // Same transient-race classification as the LU-6 host-mode
      // path: "no agent allowlist yet" is the post-create / pre-
      // chain-event window; everything else is a real auth failure.
      const isTransientRace = verdict.reason === 'no agent allowlist on context graph';
      const logFn = isTransientRace ? this.log.debug.bind(this.log) : this.log.warn.bind(this.log);
      logFn(
        ctx,
        `LU-11: chunked envelope auth ${isTransientRace ? 'deferred' : 'rejected'} for cg=${storageCgId} from=${fromPeerId} swmMessageIndex=${envelope.swmMessageIndex}: ${verdict.reason}`,
      );
      return;
    }

    const batchId = envelope.payload.subarray(0, 32);
    const ciphertext = envelope.payload.subarray(32);
    const chunkIndex = envelope.swmMessageIndex;
    // Codex review on PR #715 (refined round 2 on PR #727): canonicalize
    // the cgId used in the per-CG named graph via
    // `canonicalChunkStoreCgIdOrNull` so persist (here) and lookup
    // (`handleGetCiphertextChunk`, V2 ACK loadChunk, prover extractor)
    // converge on the same wire-form key. The persist site falls back
    // to the raw `storageCgId` (legacy shape) when canonicalization
    // can't safely resolve — the gossip envelope's `contextGraphId`
    // is typically already cleartext / wire-form, so the null path is
    // unlikely here, but the fallback keeps insert semantics safe and
    // mirrors the lookup-side wildcard fallback rather than
    // fabricating a bad keccak-of-decimal-string.
    const persistCanonical = this.canonicalChunkStoreCgIdOrNull(storageCgId);
    const chunksGraph = ciphertextChunkStoreGraph(persistCanonical ?? storageCgId);
    const subject = ciphertextChunkStoreSubject(batchId, chunkIndex);
    const literal = `"${Buffer.from(ciphertext).toString('base64')}"`;
    try {
      await this.store.insert([{
        subject,
        predicate: CIPHERTEXT_CHUNK_PREDICATE,
        object: literal,
        graph: chunksGraph,
      }]);
    } catch (err) {
      this.log.warn(
        ctx,
        `LU-11: failed to persist chunk cg=${storageCgId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    this.log.info(
      ctx,
      `LU-11: persisted ciphertext chunk cg=${storageCgId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex} bytes=${ciphertext.length}`,
    );
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — curator-side: record a CG so the
   * periodic beacon timer keeps re-announcing it AND broadcast an
   * immediate first beacon. Called from {@link createContextGraph}
   * for curated CGs.
   *
   * Best-effort. Failures (no chain signer, no listening cores yet,
   * gossip publish error) are logged at WARN and do not block CG
   * creation — without a beacon the CG falls back to the chain-event
   * auto-subscribe path on register, which still works for cores
   * that come online after registration.
   */
  /**
   * @param curatorAgentAddress
   *   Optional explicit curator agent address (typically the
   *   `opts.callerAgentAddress` resolved from the create-CG token).
   *   When provided AND a matching workspace agent has a private
   *   key, the beacon is signed by THAT agent so the wireId-pinned
   *   `curatorEoa` matches what host-catchup envelopes will recover.
   *   Without this, multi-agent nodes silently default to the first
   *   workspace agent and the catchup path can authorize the wrong
   *   identity. Codex review on PR #916.
   */
  async registerCgForBeaconAnnouncement(this: DKGAgent,
    localCgId: string,
    accessPolicy: number,
    curatorAgentAddress?: string,
  ): Promise<void> {
    if (accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
      // Public CGs don't need pre-registration auto-host: their
      // SWM substrate carries plaintext that any core can apply
      // directly via the gossip subscription. The beacon flow is
      // specifically for curated ciphertext custody.
      return;
    }
    // Prefer the caller-specified curator agent on multi-agent
    // nodes; only fall back to the default workspace agent when
    // the caller didn't pin one.
    const callerScopedSigner = this.getWorkspaceSigningAgentForAddress(curatorAgentAddress);
    if (curatorAgentAddress && !callerScopedSigner) {
      // The caller pinned a curator that isn't in `localAgents`
      // with a privateKey. Defaulting to another agent here would
      // mint a beacon whose `curatorEoa` doesn't match what the
      // host-catchup path later recovers — silently pinning the
      // wrong identity is worse than skipping the beacon. Drop
      // the registration and log; the chain-event auto-subscribe
      // path on register still works for cores that come online
      // after registration.
      this.log.warn(
        createOperationContext('system'),
        `Beacon registration skipped for "${localCgId}": caller curator ${curatorAgentAddress} has no local signer; would pin wrong curator EOA`,
      );
      return;
    }
    const beaconAgentSigner = callerScopedSigner ?? this.getWorkspaceGossipSigningAgent();
    const chainSignerEoa = beaconAgentSigner ? null : await this.getRegistrationTxSignerAddress();
    const curatorEoa = beaconAgentSigner?.agentAddress ?? chainSignerEoa;
    if (!curatorEoa) {
      this.log.warn(
        createOperationContext('system'),
        `Beacon registration skipped for "${localCgId}": no DKG agent signer or chain tx signer; pre-registration auto-host won't run for this CG`,
      );
      return;
    }
    const wireId = this.gossipWireIdFor(localCgId);
    this.beaconRegistry.set(localCgId, {
      wireId,
      curatorEoa: curatorEoa.toLowerCase(),
      ...(beaconAgentSigner?.privateKey ? { signerPrivateKey: beaconAgentSigner.privateKey } : {}),
      accessPolicy,
    });
    await this.broadcastCgDiscoveryBeacon(localCgId);
  }

  /**
   * Single-shot broadcast of the CG-discovery beacon for one
   * locally-curated CG. Idempotent w.r.t. cores: a core that
   * already auto-subscribed treats a duplicate beacon as a refresh
   * (timestamp + signature still validate against the same curator
   * EOA + nameHash; rate-limit doesn't count beacons themselves).
   */
  async broadcastCgDiscoveryBeacon(this: DKGAgent, localCgId: string): Promise<void> {
    const entry = this.beaconRegistry.get(localCgId);
    if (!entry) return;
    const ctx = createOperationContext('share');
    let beacon;
    try {
      beacon = await mintCgDiscoveryBeacon({
        nameHash: entry.wireId,
        accessPolicy: entry.accessPolicy,
        curatorEoa: entry.curatorEoa,
        sign: async (digest) => {
          if (entry.signerPrivateKey) {
            return new ethers.Wallet(entry.signerPrivateKey).signMessage(digest);
          }
          // Chain adapter's `signMessage` returns `{r, vs}`; re-
          // serialise to the 65-byte hex shape ethers expects. The
          // EVM adapter routes through `Signer.signMessage` which
          // applies the EIP-191 framing, matching what
          // `verifyCgDiscoveryBeacon` recovers.
          if (typeof this.chain.signMessage !== 'function') {
            throw new Error('chain adapter does not implement signMessage');
          }
          const { r, vs } = await this.chain.signMessage(digest);
          const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
          return sig.serialized;
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Beacon mint failed for "${localCgId}" (wireId=${entry.wireId.slice(0, 12)}…): ${msg}`);
      return;
    }
    try {
      this.gossip.subscribe(DKG_CG_DISCOVERY_TOPIC);
      await this.gossip.publish(DKG_CG_DISCOVERY_TOPIC, encodeCgDiscoveryBeacon(beacon));
      this.log.info(
        ctx,
        `Beacon broadcast for "${localCgId}" wireId=${entry.wireId.slice(0, 12)}… curator=${entry.curatorEoa.slice(0, 10)}…`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(ctx, `Beacon publish for "${localCgId}" had no subscribers / failed: ${msg}`);
    }
  }

  async getWorkspaceCatchupSigner(this: DKGAgent, contextGraphId: string): Promise<{ privateKey: string } | null> {
    const wireId = this.gossipWireIdFor(contextGraphId);
    for (const entry of this.beaconRegistry.values()) {
      if (entry.signerPrivateKey && entry.wireId.toLowerCase() === wireId.toLowerCase()) {
        return { privateKey: entry.signerPrivateKey };
      }
    }

    const allowedAgents = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.catchUpSigner,
      () => this.getContextGraphAgentGateAddresses(contextGraphId),
    ).catch(() => null);
    if (!allowedAgents || allowedAgents.length === 0) return null;
    const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (record.privateKey && allowedSet.has(record.agentAddress.toLowerCase())) {
        return { privateKey: record.privateKey };
      }
    }
    return null;
  }

  /**
   * Re-announce every CG in {@link beaconRegistry}. Driven by
   * {@link beaconReannounceTimer} on the
   * {@link BEACON_REANNOUNCE_INTERVAL_MS} cadence. Sequential to
   * keep memory bounded on agents with many CGs; the per-broadcast
   * cost is dominated by one keccak256 + one EIP-191 sign + one
   * gossip publish, all << 1ms on commodity hardware.
   */
  async reannounceAllBeacons(this: DKGAgent): Promise<void> {
    for (const localCgId of this.beaconRegistry.keys()) {
      await this.broadcastCgDiscoveryBeacon(localCgId);
    }
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — core-side: subscribe to the global
   * discovery topic. Wired from {@link start} once the agent has
   * a working gossip handle AND has confirmed `nodeRole === 'core'`
   * with host mode enabled. Idempotent — the gossip layer dedupes
   * subscribe/onMessage calls for the same topic.
   */
  subscribeCgDiscoveryTopic(this: DKGAgent): void {
    this.gossip.subscribe(DKG_CG_DISCOVERY_TOPIC);
    this.gossip.onMessage(DKG_CG_DISCOVERY_TOPIC, (_topic, data, from) => {
      this.handleIncomingCgDiscoveryBeacon(data, from).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(createOperationContext('share'), `Beacon handler error from ${from}: ${msg}`);
      });
    });
  }

  /**
   * Validate a received beacon and, on accept, register the
   * `wireId → curator EOA` mapping plus delegate to the host-mode
   * reconciler — which applies the sharding-table + role checks the
   * same way the chain-event auto-subscribe path does.
   *
   * Rejections are logged at DEBUG (one per failed beacon would
   * flood logs on a busy network); we surface only the first
   * rejection per curator per minute. Accepted beacons log at INFO.
   */
  async handleIncomingCgDiscoveryBeacon(this: DKGAgent, data: Uint8Array, fromPeer: string): Promise<void> {
    if (!this.swmHostModeStore) return;
    const ctx = createOperationContext('share');
    const beacon = decodeCgDiscoveryBeacon(data);
    if (!beacon) {
      this.log.debug(ctx, `Beacon from ${fromPeer} dropped: malformed wire bytes`);
      return;
    }
    const verdict = verifyCgDiscoveryBeacon(beacon, Math.floor(Date.now() / 1000));
    if (!verdict.ok) {
      this.log.debug(ctx, `Beacon from ${fromPeer} rejected: ${verdict.reason}`);
      return;
    }
    if (beacon.accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
      // Public CG beacons are a no-op for host mode — the curator
      // shouldn't have broadcast one; ignore quietly.
      return;
    }
    const wireId = beacon.nameHash;
    const curatorEoa = beacon.curatorEoa;

    const previousCurator = this.beaconCuratorByWireId.get(wireId);
    if (previousCurator && previousCurator !== curatorEoa) {
      // Two different wallets claiming the same wireId is a hash
      // collision OR a curator-rotation event. Reject the second
      // claim (first-claim-wins) so an attacker can't hijack the
      // budget bookkeeping for an already-trusted CG.
      this.log.warn(
        ctx,
        `Beacon from ${fromPeer} for wireId=${wireId.slice(0, 12)}… rejected: ` +
          `claimed curator ${curatorEoa.slice(0, 10)}… contradicts pinned ${previousCurator.slice(0, 10)}…`,
      );
      return;
    }
    this.beaconCuratorByWireId.set(wireId, curatorEoa);

    // Stage the synthetic subscription record + wire-id reverse mapping through
    // the canonical subscription mutator. The hash is the local id for cores
    // that did not create or join the CG.
    if (!this.subscribedContextGraphs.has(wireId)) {
      this.setContextGraphSubscription(wireId, {
        subscribed: false,
        synced: false,
        onChainHash: wireId,
        pendingMeta: true,
      }, { persist: false });
    } else {
      const existing = this.subscribedContextGraphs.get(wireId)!;
      this.setContextGraphSubscription(wireId, { ...existing, onChainHash: wireId }, { persist: false });
    }

    try {
      await this.reconcileSwmHostModeSubscription(wireId, SUBSCRIPTION_SOURCES.BEACON);
      this.log.info(
        ctx,
        `Beacon-driven auto-host engaged for wireId=${wireId.slice(0, 12)}… (curator=${curatorEoa.slice(0, 10)}…, from=${fromPeer})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Beacon-driven host-mode reconcile failed for ${wireId.slice(0, 12)}…: ${msg}`);
    }
  }

  /**
   * Receiver handler for `/dkg/10.0.1/swm-host-catchup`. Responds
   * with stored ciphertext envelopes for the requested CG, paged
   * by `sinceSeqno`. Always returns a structured response; denial
   * is communicated via the `denied` field rather than throwing
   * (which would make the messenger substrate classify the call as
   * a transport failure and retry).
   */
  async handleSwmHostCatchup(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    if (!this.swmHostModeStore) {
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: 'host-mode not enabled on this node',
        entries: [],
      });
    }
    // OT-RFC-49 WS-A — RETIRE the host-mode catch-up egress. With the
    // private-ciphertext strip ON (default), a stripped core serves nothing
    // private: this responder only ever returns private SWM ciphertext, so
    // we deny BEFORE decoding the request. Members backfill from the curator
    // (REPLACE-recovery), never from a core. Set `stripCiphertext:false` to
    // restore legacy serving (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.debug(
        ctx,
        `host-catchup served NOTHING from=${fromPeerId}: private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores serve zero private SWM ciphertext)`,
      );
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: 'private-ciphertext strip is on (OT-RFC-49 WS-A): host-mode custody retired',
        entries: [],
      });
    }
    let req;
    try {
      req = decodeSwmHostCatchupRequest(data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: `malformed request: ${reason}`,
        entries: [],
      });
    }

    // OT-RFC-38 LU-6 B1: signature + freshness + replay-defence +
    // chain-anchored authorization. Pre-B1 the handler treated the
    // libp2p peer-id as an authority token, which leaked metadata
    // (existence/timing/volume of curated CGs) to any connected peer
    // that knew or guessed the wire id — see comment block below at
    // the authorization branch for the threat-model rationale.
    const authResult = await this.authorizeSwmHostCatchupRequest(req, fromPeerId, Date.now());
    if (!authResult.ok) {
      this.log.info(
        ctx,
        `host-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${req.requesterEoa}: ${authResult.reason}`,
      );
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: false,
        denied: authResult.reason,
        entries: [],
      });
    }

    const maxEntries = req.maxEntries ?? SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES;
    const maxBytes = req.maxBytes ?? SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES;
    let raw;
    try {
      raw = await this.swmHostModeStore.iterate(req.contextGraphId, req.sinceSeqno, maxEntries + 1);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `host-catchup iterate failed cg=${req.contextGraphId} from=${fromPeerId}: ${reason}`);
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: false,
        denied: `store error: ${reason}`,
        entries: [],
      });
    }
    const truncatedByEntries = raw.length > maxEntries;
    if (truncatedByEntries) raw = raw.slice(0, maxEntries);
    const entries: SwmHostCatchupResponseEntry[] = [];
    let runningBytes = 0;
    let truncatedByBytes = false;
    let skippedOversizeFirst = false;
    for (const entry of raw) {
      // Codex PR #610 round-2 #4: don't bypass the byte cap for the
      // first entry. Pre-fix, the `entries.length > 0` guard meant a
      // single oversize envelope (close to or above `maxBytes`) was
      // always returned even when it exceeded the caller's cap. The
      // base64 expansion (~33% overhead) plus protocol-router wrapper
      // pushed responses past the messenger's 10 MiB read limit and
      // made catchup fail for legitimate large shares. Treat an
      // oversize first entry as truncation instead — the caller
      // either bumps `maxBytes` and retries or skips past the
      // problematic seqno.
      const base64Size = Math.ceil(entry.envelopeBytes.length / 3) * 4;
      if (runningBytes + base64Size > maxBytes) {
        if (entries.length === 0) skippedOversizeFirst = true;
        truncatedByBytes = true;
        break;
      }
      entries.push({
        seqno: entry.seqno,
        timestampMs: entry.timestampMs,
        envelopeB64: Buffer.from(entry.envelopeBytes).toString('base64'),
      });
      runningBytes += base64Size;
    }
    if (skippedOversizeFirst) {
      const oversizeSeqno = raw[0]?.seqno ?? req.sinceSeqno;
      const oversizeBase64 = Math.ceil((raw[0]?.envelopeBytes.length ?? 0) / 3) * 4;
      this.log.warn(
        ctx,
        `host-catchup oversize entry at seqno=${oversizeSeqno} cg=${req.contextGraphId} from=${fromPeerId}: ` +
        `envelope alone exceeds maxBytes=${maxBytes} after base64 (~${oversizeBase64}B) — returning denied`,
      );
      // Surface as `denied` so the caller breaks out of its
      // pagination loop instead of spinning forever on a seqno that
      // can't fit in the response (would otherwise loop because
      // `nextSeqno` stays equal to `sinceSeqno` when entries=0).
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: true,
        denied: `oversize-entry: seqno=${oversizeSeqno} envelope=${oversizeBase64}B > maxBytes=${maxBytes}`,
        entries: [],
      });
    }
    const nextSeqno = entries.length > 0 ? entries[entries.length - 1].seqno : req.sinceSeqno;
    this.log.info(
      ctx,
      `host-catchup served cg=${req.contextGraphId} from=${fromPeerId} sinceSeqno=${req.sinceSeqno} entries=${entries.length} bytes=${runningBytes} truncated=${truncatedByEntries || truncatedByBytes}`,
    );
    return encodeSwmHostCatchupResponse({
      version: SWM_HOST_CATCHUP_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      nextSeqno,
      truncated: truncatedByEntries || truncatedByBytes,
      entries,
    });
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — responder for the
   * `/dkg/10.0.2/get-ciphertext-chunk` sync verb. Loads one
   * `(cgId, batchId, chunkIndex)` ciphertext from the local
   * triple-store-backed chunk store and returns the base64 bytes
   * (or a typed denial: bad signature, unauthorized, missing
   * chunk). Authorization piggybacks on the existing LU-6
   * UNION-of-authorities gate: any source that recognises the
   * requester EOA accepts (on-chain participants, beacon curator,
   * local agent gate, libp2p peer allowlist). PR-B will refine
   * this to include a sharding-table-membership chain probe so
   * late-joining hosting cores (which won't be on the agent
   * allowlist) can backfill ciphertexts they need to participate
   * in RFC-39 random sampling.
   */
  async handleGetCiphertextChunk(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    // OT-RFC-49 WS-A — RETIRE the LU-11 ciphertext-chunk peer-serve. With the
    // private-ciphertext strip ON (default), a stripped core serves no private
    // ciphertext — INCLUDING via the OT-RFC-39 node-operator authority branch
    // below, which would otherwise admit any registered operator. We deny
    // BEFORE decoding so the strip is a hard, unconditional cutoff regardless
    // of requester authority. Set `stripCiphertext:false` to restore the
    // legacy chunk-serve (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.debug(
        ctx,
        `LU-11 chunk-catchup served NOTHING from=${fromPeerId}: private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores serve zero private SWM ciphertext, incl. the RFC-39 node-operator branch)`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        batchIdHex: '',
        chunkIndex: -1,
        denied: 'private-ciphertext strip is on (OT-RFC-49 WS-A): host-mode custody retired',
      });
    }
    let req: CiphertextChunkCatchupRequest;
    try {
      req = decodeCiphertextChunkCatchupRequest(data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        batchIdHex: '',
        chunkIndex: -1,
        denied: `malformed request: ${reason}`,
      });
    }
    const nowMs = Date.now();
    const verify = verifySignedCiphertextChunkCatchupRequest(req, nowMs);
    if (!verify.ok || !verify.recoveredSigner) {
      this.log.info(
        ctx,
        `LU-11 chunk-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${req.requesterEoa} chunkIndex=${req.chunkIndex}: ${verify.reason}`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: verify.reason ?? 'signature verification failed',
      });
    }
    const requesterEoa = verify.recoveredSigner;
    if (!this.ciphertextChunkCatchupReplayGuard.recordIfFresh(requesterEoa, req.nonce, req.issuedAtMs, nowMs)) {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'replayed chunk-catchup nonce',
      });
    }

    // Reuse the LU-6 host-catchup authorization shape via a thin
    // adapter — same UNION-of-authorities logic, but the chunk-catchup
    // request payload lacks `sinceSeqno`/`maxEntries`/`maxBytes` so
    // we pack the chunked-request fields into the shared verifier's
    // shape with zero-defaults for the unused slots. (The shared
    // authorization helper only reads `contextGraphId` and the EOA;
    // the other fields are signature-digest input, not authorization
    // input.)
    let authOk = false;
    let authReason: string = 'no authority source available for context graph';
    const requesterLower = requesterEoa.toLowerCase();
    let anyAuthorityFound = false;
    try {
      const chainParticipants = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.chunkServe,
        () => this.resolveOnChainParticipantAgents(req.contextGraphId),
      );
      if (chainParticipants !== null) {
        anyAuthorityFound = true;
        if (chainParticipants.some((a) => a.toLowerCase() === requesterLower)) authOk = true;
      }
    } catch { /* probe failure non-fatal */ }
    if (!authOk) {
      try {
        const beaconCurator = await this.resolveBeaconPinnedCuratorEoa(req.contextGraphId);
        if (beaconCurator) {
          anyAuthorityFound = true;
          if (beaconCurator.toLowerCase() === requesterLower) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    if (!authOk) {
      try {
        const agentGate = await withRpcUsageSite(
          CG_AUTH_RPC_SITES.chunkServe,
          () => this.getContextGraphAgentGateAddresses(req.contextGraphId),
        );
        if (agentGate !== null) {
          anyAuthorityFound = true;
          if (agentGate.some((a) => a.toLowerCase() === requesterLower)) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    if (!authOk) {
      try {
        const allowedPeers = await this.resolveSwmAllowedPeersForCurrentAuthority(
          req.contextGraphId,
        );
        if (allowedPeers !== null) {
          anyAuthorityFound = true;
          if (allowedPeers.includes(fromPeerId)) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    // OT-RFC-39 fifth authority — registered node operator.
    //
    // The four authorities above are MEMBER- or CURATOR-shaped: they
    // gate "can this EOA decrypt / participate in" the CG. Curated
    // CGs almost never list every sharding-table core in
    // `allowedAgents` (curators only enrol agents that need to
    // decrypt), so the existing layers deny EVERY core-to-core
    // chunk fetch — exactly the late-join scenario OT-RFC-39 is
    // designed to fix. Closing that gap means admitting any peer
    // whose EOA is a registered node operator (identityId > 0n on
    // chain). Three reasons this is safe for the CIPHERTEXT path
    // (and not generalisable to plaintext catchup):
    //
    //  1. The bytes carried are AEAD-encrypted with the curator's
    //     sender key. A node operator without the sender key gets
    //     opaque ciphertext that is computationally indistinguishable
    //     from random, so no decryption power leaks.
    //
    //  2. The on-chain `(ciphertextChunksRoot, ciphertextChunkCount)`
    //     commitment is already public — anyone observing chain state
    //     learns "curated KC X has N chunks of size up to S each"
    //     without needing the wire fetch. The metadata our responder
    //     reveals is a strict subset of what the chain already
    //     reveals.
    //
    //  3. Registering an on-chain identity costs TRAC stake — it's
    //     a Sybil-resistant credential. Pairing the EOA recovery
    //     above (which proves the requester holds the operator key)
    //     with a non-zero identityId restricts ciphertext fetch to
    //     the same trust set the random-sampling picker draws from,
    //     which is the spec-intended population for hosting.
    //
    // Wire effect: the late-join sync verb now succeeds for any
    // sharding-table core requesting chunks for any curated CG. The
    // prover's auto-backfill can complete; the missed core proves
    // its hosting and earns rewards on the period it would otherwise
    // forfeit.
    if (!authOk && typeof this.chain.getIdentityIdForAddress === 'function') {
      try {
        const reqIdentityId = await this.chain.getIdentityIdForAddress(requesterEoa);
        if (reqIdentityId > 0n) {
          anyAuthorityFound = true;
          authOk = true;
          this.log.debug(
            ctx,
            `LU-11 chunk-catchup admitted via OT-RFC-39 node-operator authority cg=${req.contextGraphId} requesterEoa=${requesterEoa} identityId=${reqIdentityId.toString()}`,
          );
        }
      } catch (err) {
        this.log.debug(
          ctx,
          `LU-11 chunk-catchup node-operator probe failed cg=${req.contextGraphId} requesterEoa=${requesterEoa}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!authOk) {
      authReason = anyAuthorityFound
        ? 'requester EOA not in any of: on-chain participants, beacon curator, local agent-gate, allowedPeers, node-operator-registry'
        : 'no authority source available for context graph';
      this.log.info(
        ctx,
        `LU-11 chunk-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${requesterEoa} chunkIndex=${req.chunkIndex}: ${authReason}`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: authReason,
      });
    }

    // Locate the chunk. Codex review (round 2) on PR #727: pin to the
    // per-CG named graph when we can safely canonicalize `req.contextGraphId`
    // (cleartext / bare-hex / locally-registered numeric on-chain id),
    // and fall back to the wildcard `GRAPH ?g` scan when we can't. The
    // previous PR #715 fix would have keccak'd a literal decimal string
    // like "42" and produced a hash that did NOT match the curator
    // nameHash → "chunk not found" for any requester that addressed
    // the CG by its numeric on-chain id, narrowing the public API in
    // a way that wasn't advertised. Scoped pinning still gives us the
    // multi-CG identical-KC isolation we wanted from PR #715 whenever
    // canonicalization succeeds; the wildcard fallback preserves the
    // historical responder contract for the catching-up / numeric-id
    // cases.
    const canonicalCgIdForChunks = this.canonicalChunkStoreCgIdOrNull(req.contextGraphId);
    const chunksGraphForLookup = canonicalCgIdForChunks
      ? ciphertextChunkStoreGraph(canonicalCgIdForChunks)
      : null;
    const graphClause = chunksGraphForLookup
      ? `GRAPH <${chunksGraphForLookup}>`
      : 'GRAPH ?g';
    const subject = ciphertextChunkStoreSubject(req.batchId, req.chunkIndex);
    const sparql = `SELECT ?o WHERE { ${graphClause} { <${subject}> <${CIPHERTEXT_CHUNK_PREDICATE}> ?o } } LIMIT 1`;
    let result;
    try {
      result = await this.store.query(sparql, { source: 'agent.ciphertextChunkCatchup' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `LU-11 chunk-catchup store query failed cg=${req.contextGraphId} chunkIndex=${req.chunkIndex}: ${reason}`);
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: `store error: ${reason}`,
      });
    }
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'chunk not found',
      });
    }
    const literal = result.bindings[0]?.['o'];
    if (typeof literal !== 'string') {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'chunk stored value malformed',
      });
    }
    const ciphertextB64 = literal.startsWith('"') && literal.endsWith('"')
      ? literal.slice(1, -1)
      : literal;
    this.log.debug(
      ctx,
      `LU-11 chunk-catchup served cg=${req.contextGraphId} from=${fromPeerId} batchId=${ethers.hexlify(req.batchId).slice(0, 18)}... chunkIndex=${req.chunkIndex} bytes=${Buffer.from(ciphertextB64, 'base64').length}`,
    );
    return encodeCiphertextChunkCatchupResponse({
      version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      batchIdHex: ethers.hexlify(req.batchId),
      chunkIndex: req.chunkIndex,
      ciphertextB64,
    });
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — requester for the
   * `/dkg/10.0.2/get-ciphertext-chunk` sync verb. Pulls one
   * `(cgId, batchId, chunkIndex)` ciphertext from a known host and
   * (when `persist === true`) writes it into the local per-chunk
   * store so the V2 ACK verifier sees it on the next pass. Returns
   * the raw decoded response so callers can inspect denial reasons
   * or feed bytes to a member-side verifier.
   *
   * Late-joining hosting cores call this in a loop to backfill the
   * `(cgId, batchId, 0..count-1)` set after seeing
   * `KnowledgeCollectionCiphertextCommitmentSet` on chain or
   * `MISSING_CIPHERTEXT_CHUNKS` from a V2 ACK request they
   * routed forward. Loop policy + peer selection are intentionally
   * caller-owned — this method is the single-pull primitive.
   */
  async fetchCiphertextChunkFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    batchId: Uint8Array,
    chunkIndex: number,
    options?: {
      persist?: boolean;
      /**
       * @deprecated Reserved for a future alternate-signer plumb-through.
       *   No-op today: the closure below always uses
       *   `this.chain.signMessage`. Kept on the public signature so
       *   existing TypeScript callers continue to compile through the
       *   rc.12 line (Codex review round 2 on PR #727 flagged
       *   removing it as a breaking API change). Will be removed in a
       *   future intentional major-version break — either replaced by
       *   a real signer callback (`sign?: (digest) => Promise<string>`)
       *   or dropped entirely if no caller ever materialises.
       */
      signWithChainAdapter?: boolean;
    },
  ): Promise<CiphertextChunkCatchupResponse> {
    if (batchId.length !== 32) {
      throw new Error(`fetchCiphertextChunkFromPeer requires a 32-byte batchId; got ${batchId.length}`);
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(`fetchCiphertextChunkFromPeer requires a non-negative chunkIndex; got ${chunkIndex}`);
    }
    const ctx = createOperationContext('share');
    // Codex review on PR #715 / #717 / #727: the option above is a
    // back-compat no-op. The implementation requires a chain adapter
    // with `signMessage`; there is no real alternate-signer path yet,
    // so callers must wire the chain. Honest error if absent.
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('fetchCiphertextChunkFromPeer: chain adapter does not expose signMessage; the LU-11 sync verb requires an operator-key signer');
    }
    const sign = async (digest: Uint8Array) => {
      // Match the host-catchup pattern: chain.signMessage returns
      // {r, vs}; re-serialise to the 65-byte EIP-191 hex shape.
      const { r, vs } = await this.chain.signMessage!(digest);
      const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
      return sig.serialized;
    };
    const signedReq = await mintSignedCiphertextChunkCatchupRequest({
      contextGraphId,
      batchId,
      chunkIndex,
      sign,
    });
    const reqBytes = encodeCiphertextChunkCatchupRequest(signedReq);
    const sendResult = await this.messenger.sendReliable(remotePeerId, PROTOCOL_GET_CIPHERTEXT_CHUNK, reqBytes);
    if (!sendResult.delivered) {
      throw new Error(`LU-11 chunk-catchup transport failed: ${sendResult.error}`);
    }
    const resp = decodeCiphertextChunkCatchupResponse(sendResult.response);
    if (options?.persist && resp.ciphertextB64) {
      const subject = ciphertextChunkStoreSubject(batchId, chunkIndex);
      const literal = `"${resp.ciphertextB64}"`;
      // Codex review on PR #715 (refined round 2 on PR #727): use the
      // central canonical helper so this persist site matches the
      // ingest persist site exactly, including the safe fallback when
      // canonicalization can't resolve. `contextGraphId` here is the
      // local CG id the prover-side backfill passed in (cleartext
      // resolved via `resolveLocalCgIdByOnChainId` in
      // `buildCiphertextChunkBackfill`), so the helper normally
      // returns a wire hash; the null path is theoretical defense.
      const persistCanonical = this.canonicalChunkStoreCgIdOrNull(contextGraphId);
      const chunksGraphForPersist = ciphertextChunkStoreGraph(persistCanonical ?? contextGraphId);
      try {
        await this.store.insert([{
          subject,
          predicate: CIPHERTEXT_CHUNK_PREDICATE,
          object: literal,
          graph: chunksGraphForPersist,
        }]);
        this.log.debug(
          ctx,
          `LU-11 chunk-catchup persisted cg=${contextGraphId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex} from=${remotePeerId}`,
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `LU-11 chunk-catchup persistence failed cg=${contextGraphId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return resp;
  }

  /**
   * OT-RFC-39 — resolve a numeric on-chain CG id (the form the prover
   * sees from `createChallenge` / `getKAContextGraphId`) back to the
   * local cleartext id this agent registered the CG under. Scans
   * `subscribedContextGraphs` because the reverse map is keyed by the
   * wire-form `onChainHash`, not the numeric id. Returns null when
   * this node has never seen the CG (legitimate during the chain-event
   * replay race window after restart — caller falls back to passing
   * the numeric id as a string, which the responder's authorization
   * layer also resolves via on-chain participant lookup).
   */
  resolveLocalCgIdByOnChainId(this: DKGAgent, onChainId: bigint): string | null {
    const target = onChainId.toString();
    // Multiple local records can share one on-chain id: a synthetic
    // hash-keyed host record (`subscribed: false`, minted from
    // `ContextGraphCreated`) can coexist with the real subscribed cleartext
    // CG. Prefer the subscribed match so live KACG nudges + reconcile target
    // the CG a user actually reads; fall back to the first record otherwise
    // (the host-only / post-restart replay-window case callers tolerate).
    let fallback: string | null = null;
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId !== target) continue;
      if (sub.subscribed) return localId;
      if (fallback === null) fallback = localId;
    }
    return fallback;
  }

  bumpContextGraphBindingGeneration(this: DKGAgent, localCgId: string): number {
    return this.contextGraphBindingState.bump(localCgId);
  }

  captureContextGraphBindingGeneration(this: DKGAgent, localCgId: string): number {
    return this.contextGraphBindingState.capture(localCgId);
  }

  isContextGraphBindingGenerationCurrent(
    this: DKGAgent,
    localCgId: string,
    generation: number,
  ): boolean {
    return this.contextGraphBindingState.isGenerationCurrent(localCgId, generation);
  }

  /** Invalidate an untrusted reverse candidate and every VM cursor tied to it. */
  clearSubscriptionReverseNameHashBinding(
    this: DKGAgent,
    localCgId: string,
  ): boolean {
    if (!this.contextGraphBindingState.clear(localCgId)) return false;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
    return true;
  }

  /**
   * Bind (or rebind) a local CG to an on-chain CG id, resetting the
   * chain-driven reconcile watermark if the bound id actually CHANGES.
   *
   * The persisted `lastReconciledOrdinal` is the count of contiguous KAs
   * promoted for a *specific* on-chain graph. If the same local CG id is later
   * repaired/recreated under a different on-chain id, that watermark no longer
   * refers to the same chain graph — reusing it would make the sweep start at
   * the wrong ordinal and permanently skip earlier KAs. So when the id changes
   * we zero the watermark and drop the in-memory cursor; the reset is persisted
   * together with the new id, keeping it restart-safe.
   */
  bindSubscriptionOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    newOnChainId: string,
  ): void {
    const transition = this.contextGraphBindingState.bindAuthoritative(
      localCgId,
      sub,
      newOnChainId,
    );
    if (!transition.changed) return;
    this.vmReconcileScheduling?.releaseLiveHold(localCgId);
    // Some verified late-binding paths intentionally mutate the canonical
    // in-memory subscription only after their durable write commits. They do
    // not subsequently pass through setContextGraphSubscription(), so without
    // this notification a subscribed Edge can remain outside the RFC-64
    // responsibility registry until restart even though its chain id is now
    // authoritative. Clone-based callers still let the canonical setter own
    // the transition and avoid an eager decision against the old row.
    if (this.subscribedContextGraphs.get(localCgId) === sub) {
      this.scheduleRfc64CatalogResponsibilityReconciliationV1(
        localCgId,
      );
    }
    if (!transition.onChainIdChanged) return;
    // The bound on-chain id actually CHANGED (repair / recreate / re-register).
    // Any prior reconcile progress refers to the OLD chain graph and must be
    // dropped, otherwise the sweep resumes at the wrong ordinal and skips
    // early KAs of the new graph. Progress can hide in two places: the
    // persisted `lastReconciledOrdinal` watermark AND an in-memory cursor that
    // still holds `ahead` ordinals while its watermark is 0 (e.g. ordinals
    // reconciled but waiting on confirmation depth). Reset BOTH on any id
    // change — not only when the persisted watermark happens to be positive.
    const hadProgress =
      (sub.lastReconciledOrdinal ?? 0) > 0 || this.reconcileCursors.has(localCgId);
    sub.lastReconciledOrdinal = 0;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
    if (hadProgress) {
      this.log.info(
        createOperationContext('system'),
        `VM reconcile: on-chain id for "${localCgId}" changed ` +
        `${transition.previous?.onChainId}->${newOnChainId}; reset reconcile watermark + cursor to 0`,
      );
    }
  }

  /**
   * Inverse of {@link bindSubscriptionOnChainId}: drop a local CG's on-chain
   * id together with every piece of reconcile progress made against it. The
   * persisted watermark and the in-memory cursor count ordinals of the graph
   * that id named, so neither may survive the id. The canonical setter
   * persists the unbound row.
   */
  unbindSubscriptionOnChainId(this: DKGAgent, localCgId: string): void {
    const sub = this.subscribedContextGraphs.get(localCgId);
    if (sub === undefined) return;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
    this.setContextGraphSubscription(localCgId, { ...sub, onChainId: undefined, lastReconciledOrdinal: 0 });
  }

  /**
   * Install a reverse-derived VM candidate without promoting it to the shared
   * authoritative `onChainId` field. The candidate is process-local and every
   * VM use revalidates it against the current complete name-hash inventory.
   */
  bindSubscriptionReverseNameHashOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    newOnChainId: string,
    nameHash: string,
  ): void {
    const transition = this.contextGraphBindingState.bindReverseCandidate(
      localCgId,
      sub,
      newOnChainId,
      nameHash,
    );
    if (!transition.changed) return;
    this.vmReconcileScheduling?.releaseLiveHold(localCgId);
    const hadProgress =
      (sub.lastReconciledOrdinal ?? 0) > 0 || this.reconcileCursors.has(localCgId);
    if (hadProgress) {
      sub.lastReconciledOrdinal = 0;
      this.forceClearVmReconcileStateForContextGraph(localCgId);
    }
    if (hadProgress) {
      this.log.info(
        createOperationContext('system'),
        `VM reconcile: reverse-derived on-chain id for "${localCgId}" changed ` +
        `${transition.previous?.onChainId ?? 'unbound'}->${newOnChainId}; ` +
        'reset reconcile watermark + cursor to 0',
      );
    }
  }

  async readCoreHostedPublicCgAccessPolicy(this: DKGAgent, onChainId: string): Promise<0 | 1 | null> {
    const numericId = BigInt(onChainId);
    const readTimeoutMs = chainAuthorityReadBudgetsOf(this).requestTimeoutMs;
    const raceChainRead = async <T>(start: () => T | Promise<T>): Promise<T | typeof TIMEOUT_SENTINEL> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), readTimeoutMs);
        timer.unref?.();
      });
      let work: Promise<T>;
      try {
        work = Promise.resolve(start()).finally(() => { if (timer) clearTimeout(timer); });
      } catch (err) {
        if (timer) clearTimeout(timer);
        throw err;
      }
      return Promise.race([work, timeout]);
    };
    const readAccessPolicy = async (useCache: boolean): Promise<0 | 1 | null> => {
      const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
      if (typeof getAccessPolicy !== 'function') return null;
      const cached = this.onChainAccessPolicyCache.get(onChainId);
      if (useCache && (cached === 0 || cached === 1)) return cached;
      try {
        const policy = await raceChainRead(() => getAccessPolicy.call(this.chain, numericId));
        if (policy === TIMEOUT_SENTINEL) {
          this.log.warn(
            createOperationContext('system'),
            `recordCoreHostedPublicCg(${onChainId}): getContextGraphAccessPolicy timed out after ` +
            `${readTimeoutMs}ms — treating hosted CG access policy as UNKNOWN`,
          );
          return null;
        }
        if (policy === 0 || policy === 1) {
          this.onChainAccessPolicyCache.set(onChainId, policy);
          return policy;
        }
        return null;
      } catch {
        return null;
      }
    };

    const isActive = this.chain.isContextGraphActiveOnChain;
    if (typeof isActive !== 'function') return readAccessPolicy(true);
    try {
      const live = await raceChainRead(() => isActive.call(this.chain, numericId));
      if (live === true) return readAccessPolicy(false);
      if (live !== TIMEOUT_SENTINEL) return null;
      this.log.warn(
        createOperationContext('system'),
        `recordCoreHostedPublicCg(${onChainId}): isContextGraphActiveOnChain timed out after ` +
        `${readTimeoutMs}ms — falling back to ACK-backed access policy read`,
      );
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `recordCoreHostedPublicCg(${onChainId}): isContextGraphActiveOnChain failed: ` +
        `${err instanceof Error ? err.message : String(err)} — falling back to ACK-backed access policy read`,
      );
    }

    try {
      // StorageACK signing proves this specific registration was live enough
      // to host. If the optional liveness probe itself flakes, preserve the
      // host-tracking path and only fail closed when the policy read is unknown.
      return await readAccessPolicy(true);
    } catch {
      return null;
    }
  }

  /**
   * Phase D (Cores fill their own gaps) — the StorageACK finality gate awaits
   * this before a Core signs an ACK for a PUBLIC CG: signing makes the Core a
   * storage node for it, so mark the CG `coreHosted` (persisted) so the
   * chain-driven VM reconciler runs for it across restarts even without a
   * member subscription. A Core that was offline during the *next* publish
   * then learns the missed KA from chain on restart and pulls it core-first.
   *
   * The row is keyed by the SWM namespace holding the ACK copy (see
   * {@link resolveCoreHostedPublicCgLocalId}); an existing row there is merged
   * into, never replaced, and a persisted row that has not been rehydrated yet
   * is left alone. Public-only by design: a Core never receives a curated
   * CG's plaintext, so there is nothing to promote to VM; its curated
   * obligation is the verified `<cg>/_catalog` the catalog ACK persists.
   * Idempotent. With `durable`, `recorded`/`already-recorded` also mean the
   * row has been written through the strict subscription-store path;
   * `nudge: false` leaves the first reconcile to the periodic sweep.
   */
  async recordCoreHostedPublicCg(
    this: DKGAgent,
    cgId: string,
    swmGraphId?: string,
    options: {
      durable?: boolean;
      nudge?: boolean;
      /**
       * The caller verified on chain that this namespace names `cgId` (the
       * StorageACK gate checks the committed name hash). A member row of the
       * namespace that has no on-chain binding yet (a freshly registered
       * graph) is then bound from the ACK instead of waiting for a binding.
       */
      namespaceVerified?: boolean;
    } = {},
  ): Promise<CoreHostedPublicCgRecordOutcome> {
    if (this.coreHostRecordingsClosed) return 'closed';
    if (!this.vmReconcileEnabled()) return 'vm-reconcile-disabled';
    const recordingGeneration = this.coreHostRecordingGeneration;
    let numeric: bigint;
    try {
      numeric = BigInt(cgId);
    } catch {
      return 'invalid-id'; // non-numeric id can't be reconciled against the chain ordinal list
    }
    if (numeric <= 0n) return 'invalid-id';

    const numericStr = numeric.toString();
    const localCgId = resolveCoreHostedPublicCgLocalId({ onChainId: numeric, swmGraphId });
    const alreadyRecorded = () => options.durable === true
      ? this.persistCoreHostedPublicCgStrict(localCgId, numericStr, recordingGeneration)
      : Promise.resolve('already-recorded' as const);
    // Pre-read guards that need no chain: a dormant persisted row, and a
    // member subscription whose own binding is missing or points elsewhere.
    const blocked = (): CoreHostedPublicCgRecordOutcome | undefined => {
      // A cleartext namespace for a graph whose committed name hash this node
      // already holds (a #2744 name-hash placeholder, or a bound cleartext
      // row) must be that name; anything else would split the graph across
      // namespaces. The placeholder is then left alone.
      if (localCgId !== numericStr) {
        const mapped = this.resolveLocalCgIdByOnChainId(numeric);
        const committed = mapped === null ? undefined : this.subscribedContextGraphs.get(mapped)?.onChainHash;
        if (
          committed !== undefined
          && this.contextGraphWireId(committed) !== this.contextGraphNameCommitment(localCgId)
        ) {
          return 'namespace-conflict';
        }
      }
      const existing = this.subscribedContextGraphs.get(localCgId);
      if (this.contextGraphSubscriptionDormancyById.has(localCgId)
        && !isAdmittedContextGraphSubscription(existing)) return 'dormant';
      if (existing === undefined) return undefined;
      if (!existing.subscribed) return undefined;
      if (existing.onChainId === undefined) {
        return options.namespaceVerified === true || localCgId === numericStr ? undefined : 'binding-pending';
      }
      return existing.onChainId === numericStr ? undefined : 'namespace-conflict';
    };

    // Chain-free early-out BEFORE the reads. This hook fires ahead of EVERY
    // StorageACK sign, so checking "already recorded" only after the liveness +
    // policy reads cost two RPC requests per ACK forever on a hosted public CG,
    // just to reach a no-op. Nothing is decided here: the row was recorded from
    // a live-then-policy read on its first observation, and an already-recorded
    // row is left untouched whatever the chain says now. Every path that can
    // still RECORD a graph falls through to the fresh reads below.
    if (isCoreHostedPublicCgRecorded(
      this.subscribedContextGraphs.get(localCgId),
      numericStr,
    )) return alreadyRecorded();
    const blockedBeforeRead = blocked();
    if (blockedBeforeRead !== undefined) return blockedBeforeRead;

    // Existence-gated read when the adapter exposes liveness; otherwise use
    // the ACK-backed compatibility path because signing a StorageACK proves
    // this specific CG registration is live enough for host tracking.
    const policy = await this.readCoreHostedPublicCgAccessPolicy(numericStr);
    if (this.coreHostRecordingGeneration !== recordingGeneration) return 'closed';
    if (policy === 1) return 'curated'; // not the public VM-promote path
    if (policy !== 0) return 'policy-unknown'; // unknown / not-live right now

    // Re-checked after the await: a concurrent first ACK may have recorded it,
    // or rehydration may have activated the namespace's persisted row.
    const existing = this.subscribedContextGraphs.get(localCgId);
    if (isCoreHostedPublicCgRecorded(existing, numericStr)) return alreadyRecorded();
    const blockedAfterRead = blocked();
    if (blockedAfterRead !== undefined) return blockedAfterRead;
    if (existing?.onChainId !== undefined && existing.onChainId !== numericStr) {
      // A host-only row for another graph still owes that graph's copies in
      // this namespace. Rebind only once that graph is gone from the chain
      // (a re-registration under the same name).
      const previousLive = await this.isCoreHostedGraphStillLive(existing.onChainId);
      if (this.coreHostRecordingGeneration !== recordingGeneration) return 'closed';
      if (previousLive) return 'namespace-conflict';
    }

    let next: ContextGraphSub;
    if (existing) {
      // Rebind through the helper so a CG re-created/rebound under the same
      // local id drops its stale reconcile watermark + in-memory cursor before
      // we persist the new on-chain id. A bare `onChainId` overwrite would keep
      // the old `lastReconciledOrdinal`, making the sweep resume at the prior
      // graph's ordinal and permanently skip the new graph's early KAs.
      this.bindSubscriptionOnChainId(localCgId, existing, numericStr);
      existing.coreHosted = true;
      next = existing;
    } else {
      next = {
        syncMode: 'always-on',
        subscribed: false,
        synced: false,
        onChainId: numericStr,
        coreHosted: true,
      };
    }
    this.setContextGraphSubscription(localCgId, next);
    this.log.info(
      createOperationContext('system'),
      `Phase D: marked public cg=${numericStr} as core-hosted under "${localCgId}" ` +
      '(will chain-reconcile to VM across restarts)',
    );
    const outcome = options.durable === true
      ? await this.persistCoreHostedPublicCgStrict(localCgId, numericStr, recordingGeneration)
      : 'recorded';
    // Nudge a reconcile now so the first hosted publish lands promptly; the
    // periodic sweep is the safety net.
    if (options.nudge !== false && this.vmReconcileScheduling) {
      void this.vmReconcileScheduling.triggerLive(localCgId);
    }
    return outcome === 'already-recorded' ? 'recorded' : outcome;
  }

  /**
   * Whether a previously hosted graph is still live on chain. Unknown counts
   * as live: an unanswered read must not let another graph take over the
   * namespace.
   */
  async isCoreHostedGraphStillLive(this: DKGAgent, onChainId: string): Promise<boolean> {
    const isActive = this.chain.isContextGraphActiveOnChain;
    if (typeof isActive !== 'function') return true;
    let numericId: bigint;
    try {
      numericId = BigInt(onChainId);
    } catch {
      return false;
    }
    try {
      return await isActive.call(this.chain, numericId) !== false;
    } catch {
      return true;
    }
  }

  /**
   * Write a core-hosted row through the strict subscription-store path, once
   * per (graph, on-chain id) and process. The ordinary setter persists in the
   * background and only logs a failed write, which is not enough for a row a
   * StorageACK signature depends on. A concurrent writer replacing the row
   * between snapshot and write is retried against the current row.
   */
  async persistCoreHostedPublicCgStrict(
    this: DKGAgent,
    localCgId: string,
    onChainId: string,
    recordingGeneration: number,
  ): Promise<'already-recorded' | 'persist-failed' | 'closed'> {
    const durableKey = `${localCgId}\0${onChainId}`;
    if (this.coreHostedDurableRecords.has(durableKey)) return 'already-recorded';
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.coreHostRecordingGeneration !== recordingGeneration) return 'closed';
      if (!isCoreHostedPublicCgRecorded(this.subscribedContextGraphs.get(localCgId), onChainId)) {
        return 'persist-failed';
      }
      try {
        await this.persistContextGraphSubscriptionProjectionStrict({
          contextGraphId: localCgId,
          requireDurableMemberIntent: false,
          operation: 'core hosting',
        });
        this.coreHostedDurableRecords.add(durableKey);
        return 'already-recorded';
      } catch (err) {
        lastError = err;
      }
    }
    this.log.warn(
      createOperationContext('system'),
      `Phase D: could not persist core-hosted cg=${onChainId} ("${localCgId}"): ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return 'persist-failed';
  }

  async drainCoreHostRecordings(this: DKGAgent): Promise<void> {
    const ctx = createOperationContext('system');
    while (this.coreHostRecordings.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), DKGAgentBase.CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        Promise.allSettled([...this.coreHostRecordings])
          .then(() => 'drained' as const)
          .finally(() => { if (timer) clearTimeout(timer); }),
        timeout,
      ]);
      if (outcome === 'timeout') {
        const pending = this.coreHostRecordings.size;
        this.log.warn(
          ctx,
          `Phase D: timed out draining ${pending} core-host recording(s) after ` +
          `${DKGAgentBase.CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS}ms; continuing shutdown`,
        );
        this.coreHostRecordings.clear();
        this.coreHostRecordingGeneration += 1;
        return;
      }
    }
  }

  // ===== Phase B — chain-driven VM reconciliation (B.4 agent wiring) =========

  /**
   * Phase E/F — emit one reconciliation telemetry event. Logs a structured
   * `chain-promote` line (grep surface) and forwards to the optional ops-metrics
   * sink (Phase F). Best-effort: never throws, never awaits the sink.
   */
  emitReplication(this: DKGAgent, ev: Omit<ReplicationEvent, 'ts'>): void {
    const event: ReplicationEvent = { ts: Date.now(), ...ev };
    const parts = [
      `chain-promote action=${event.action}`,
      `cg=${event.contextGraphId}`,
      event.onChainCgId ? `onChainCg=${event.onChainCgId}` : '',
      event.ordinal !== undefined ? `ordinal=${event.ordinal}` : '',
      event.kaId ? `ka=${event.kaId}` : '',
      event.fromWatermark !== undefined && event.toWatermark !== undefined ? `cursor=${event.fromWatermark}->${event.toWatermark}` : '',
      event.head !== undefined ? `head=${event.head}` : '',
      event.reconciled !== undefined ? `reconciled=${event.reconciled}` : '',
      event.pending !== undefined ? `pending=${event.pending}` : '',
      event.ual ? `ual=${event.ual}` : '',
      // JSON-encode `detail` so embedded quotes/newlines can't break the
      // structured `key=value` log line or inject bogus key/value fragments.
      event.detail ? `detail=${JSON.stringify(event.detail)}` : '',
    ].filter(Boolean);
    this.log.info(createOperationContext('system'), parts.join(' '));
    const sink = this.config.onReplicationEvent;
    if (sink) {
      try {
        sink(event);
      } catch (err) {
        this.log.warn(createOperationContext('system'), `onReplicationEvent sink threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * True iff the operator has not switched chain-driven VM reconciliation off
   * (`vmReconcilerEnabled` / DKG_VM_RECONCILER_ENABLED) and the chain adapter
   * exposes the per-CG registration-ordinal reads the reconciler needs. Gates
   * core-hosted recording, the live nudge, the sweep timer and the coalescer,
   * so non-V10 / no-chain nodes pay nothing. The periodic peer-sync switch
   * (`syncReconcilerEnabled`) deliberately does not participate: cores that
   * contained peer sync must keep promoting the data they ACK.
   */
  vmReconcileEnabled(this: DKGAgent): boolean {
    return (
      resolveVmReconcilerEnabled(this.config.vmReconcilerEnabled)
      &&
      this.chain.chainId !== 'none' &&
      typeof this.chain.getContextGraphKCCount === 'function' &&
      typeof this.chain.getContextGraphKCAt === 'function' &&
      typeof this.chain.getLatestMerkleRoot === 'function'
    );
  }

  /**
   * RFC-64 catalogs are authoritative only for SWM. A selected public policy
   * still expresses operator intent to keep that CG's finalized VM locally,
   * but the VM inventory itself must come from the chain reconciler.
   *
   * Intersect the accepted policy manifest with the explicit sync scope so an
   * accepted-but-unselected CG never becomes background VM work. This is a
   * pure scope check: it creates no member subscription, gossip listener, or
   * durable subscription row. This is the one owner of current/legacy catalog
   * input normalization and of subscription/core-host exclusions.
   */
  rfc64SelectedVmReconcileTargetIds(this: DKGAgent): readonly string[] {
    // Catalog mode removes the CG from the legacy durable/SWM scope, but VM
    // remains chain-inventoried and must not disappear with that authority
    // hand-off (or with the Track-2 kill switch). The immutable RFC-64
    // selection therefore remains an independent VM-reconcile intent source.
    const acceptedPolicies = this.config.rfc64CatalogBootstrap?.acceptedPolicies
      ?? this.config.rfc64PublicCatalogBootstrap?.acceptedPublicPolicies
      ?? [];
    const explicitlySelected = new Set([
      ...(this.config.syncContextGraphs ?? []),
      ...Object.keys(this.config.rfc64CatalogExecutionPlan.selectedAuthority),
    ]);
    const selected = new Set<string>();
    for (const { policyEnvelope } of acceptedPolicies) {
      const { accessPolicy, contextGraphId } = policyEnvelope.payload;
      if (accessPolicy !== 0 || !explicitlySelected.has(contextGraphId)) continue;
      const localEntry = this.subscribedContextGraphs.get(contextGraphId);
      if (localEntry?.subscribed === true || localEntry?.coreHosted === true) continue;
      selected.add(contextGraphId);
    }
    return [...selected].sort();
  }

  isRfc64SelectedVmReconcileTargetAllowed(
    this: DKGAgent,
    contextGraphId: string,
  ): boolean {
    return this.rfc64SelectedVmReconcileTargetIds().includes(contextGraphId);
  }

  /**
   * GH #1098 — bind `sub.onChainId` for a subscribed-but-unbound CG from the
   * locally-resolvable OnChainId quad (publisher ontology broadcast / durable
   * _meta sync), then persist. The chain `ContextGraphCreated` handler only
   * binds CURATED CGs and the ACK-signer hook only fires for cores in a
   * publish's storage-ACK set, so a pre-subscribed PUBLIC member would otherwise
   * stay unbound — stranded on the unreliable one-shot finalization gossip.
   * Canonical VM target resolution owns binding, strict persistence and cursor
   * resets for periodic, live and explicit requests. It accepts any non-null id:
   * `getContextGraphOnChainId` never falls back to `localCgId`, so a
   * `resolved === localCgId` match is legitimate for a direct CG. Best-effort:
   * a store/RPC hiccup yields null instead of throwing. Returns the bound id.
   */
  async selfPrimeSubscriptionOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    targetOnChainId?: bigint,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const bindingGeneration = this.contextGraphBindingState.capture(localCgId);
    const isSubscriptionCurrent = () => isCurrent()
      && this.subscribedContextGraphs.get(localCgId) === sub
      && sub.subscribed
      && !this.contextGraphBindingState.hasBindingCandidate(localCgId, sub)
      && this.contextGraphBindingState.isGenerationCurrent(localCgId, bindingGeneration);
    if (!isSubscriptionCurrent()) return null;
    let resolved: (
      | { onChainId: string; provenance: 'authoritative' | 'ontology' }
      | { onChainId: string; provenance: 'reverse-name-hash'; nameHash: string }
    ) | null = null;
    try {
      resolved = await raceVmReconcileAbort(
        this.resolveContextGraphOnChainIdBinding(localCgId, {
          signal,
          source: 'agent.vmReconcile.resolveOnChainId',
        }),
        signal,
      );
    } catch {
      return null;
    }
    if (!isSubscriptionCurrent() || !resolved) return null;
    if (targetOnChainId !== undefined && resolved.onChainId !== String(targetOnChainId)) return null;
    if (resolved.provenance !== 'reverse-name-hash') {
      try {
        // An on-demand subscription binds in memory only; durable rows are
        // saved before the binding becomes visible.
        await this.persistContextGraphSyncStateStrict(
          localCgId,
          { ...sub, onChainId: resolved.onChainId },
          'on-chain id binding',
          isSubscriptionCurrent,
        );
      } catch {
        return null;
      }
    }
    if (!isSubscriptionCurrent()) return null;
    if (resolved.provenance === 'reverse-name-hash') {
      this.bindSubscriptionReverseNameHashOnChainId(
        localCgId,
        sub,
        resolved.onChainId,
        resolved.nameHash,
      );
    } else {
      this.bindSubscriptionOnChainId(localCgId, sub, resolved.onChainId);
    }
    return resolved.onChainId;
  }

  /**
   * GH #1098 (Phase B) — body of the live `onKARegisteredToContextGraph` nudge,
   * extracted so the branch is directly testable. A
   * `KnowledgeAssetRegisteredToContextGraph` event carries only `{ kaId, cgId }`
   * (no ordinal), so this just triggers a coalesced reconcile for the matching
   * local CG. Two cases:
   *
   *  1. The on-chain id is already bound to a local CG → trigger its reconcile
   *     (when subscribed or core-hosted).
   *  2. A known reverse-binding candidate matches the id → schedule its existing
   *     revalidation path. Unknown ids cause no unbound store lookups; the
   *     bounded periodic safety net resolves pre-subscribed public graphs.
   *
   * Best-effort and idempotent: a missed nudge heals on the periodic sweep.
   * Returns the local CG id that was reconciled, or null if none matched.
   */
  async handleKARegisteredNudge(
    this: DKGAgent,
    onChainId: string,
    kaId: bigint,
    ctx: OperationContext,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !signal?.aborted
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    if (!isLifecycleCurrent()) return null;
    let targetOnChain: bigint | null = null;
    try { targetOnChain = BigInt(onChainId); } catch { targetOnChain = null; }

    const localCgId = targetOnChain === null ? null : this.resolveLocalCgIdByOnChainId(targetOnChain);
    if (!localCgId) {
      // Reverse candidates are in-memory scheduling hints. Do not resolve
      // every unbound subscription for an unrelated live registration.
      if (targetOnChain !== null) {
        for (const [lcg, sub] of this.subscribedContextGraphs) {
          if (!isLifecycleCurrent()) return null;
          if (
            sub.subscribed
            && this.contextGraphBindingState.matchesReverseCandidate(
              lcg,
              sub,
              targetOnChain.toString(),
            )
          ) {
            // Candidate equality is only a scheduling hint. The dispatched VM
            // target resolver re-enumerates the name hash before any chain/store
            // use, so an appended duplicate still fails closed.
            this.log.info(
              ctx,
              `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> schedule reverse-candidate revalidation for "${lcg}"`,
            );
            if (this.vmReconcileScheduling && isLifecycleCurrent()) {
              signal?.throwIfAborted();
              void this.vmReconcileScheduling.triggerLive(lcg);
            }
            return lcg;
          }

        }
      }
      return null; // chain replay hasn't resolved the cleartext CG yet; periodic sweep is the safety net
    }

    const sub = this.subscribedContextGraphs.get(localCgId);
    // Populate VM for CGs we member-subscribe to OR (Phase D) public CGs this
    // Core hosts — a hosted Core fills its own gaps too.
    if (!isLifecycleCurrent() || (!sub?.subscribed && !sub?.coreHosted)) return null;
    this.log.info(ctx, `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> reconcile "${localCgId}"`);
    if (this.vmReconcileScheduling && isLifecycleCurrent()) {
      signal?.throwIfAborted();
      void this.vmReconcileScheduling.triggerLive(localCgId);
      // Core-hosted rows are keyed by the SWM namespace of their ACK copies,
      // so one on-chain graph can have several; each promotes its own copies.
      for (const [otherCgId, other] of this.subscribedContextGraphs) {
        if (otherCgId === localCgId || other.coreHosted !== true) continue;
        if (other.onChainId !== targetOnChain?.toString()) continue;
        void this.vmReconcileScheduling.triggerLive(otherCgId);
      }
    }
    return localCgId;
  }

  /**
   * #2858 — body of the live `KnowledgeAssetUpdated` nudge.
   *
   * An update keeps the KA id and moves its latest root. The ordinal sweep
   * never revisits a settled ordinal, and a node whose only copy is a
   * confirmed VM copy (a member of a catalog graph, a core outside the update's
   * ACK set) has no other lane that brings the new version. This decides from
   * local state alone, with no chain read, for every VM-reconcile target graph
   * that holds a confirmed copy of the KA; a queued target gets a reconcile
   * pass, whose refresh worker reads the chain and fetches the current version
   * ({@link startVmRefreshWorker}).
   *
   * - A copy at another root is queued for a refresh.
   * - A copy already at the event's root is skipped when it reflects the
   *   update: the event's own transaction confirmed it (the publisher), or it
   *   was materialized from a chain view at or after the event's block (a
   *   replayed event). Otherwise it may be an older version with the same
   *   content, so a version check is queued.
   * - When the workspace already stages a newer version than the confirmed
   *   copy (the publisher mid-update, a core holding the update's ACK copy, a
   *   member that recovered its curator's shared memory), the target waits
   *   `VM_REFRESH_STAGED_GRACE_MS` for the lane that staged it; on a member no
   *   lane promotes it, and the refresh does.
   *
   * The event's root is only a trigger: an older or superseded event is
   * settled by the worker's chain read, never materialized. Every no-op is
   * logged at debug. A store read that fails, or a full target set, throws, so
   * the event lane holds the event and dispatches it again after its failure
   * backoff instead of losing it.
   *
   * Returns the refresh targets newly queued.
   */
  async handleKAUpdatedNudge(
    this: DKGAgent,
    kaId: bigint,
    merkleRoot: Uint8Array,
    ctx: OperationContext,
    options: {
      readonly blockNumber?: number;
      readonly logIndex?: number;
      readonly blockHash?: string;
      readonly txHash?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<VmRefreshTarget[]> {
    const { signal } = options;
    const blockNumber = options.blockNumber !== undefined
      && Number.isSafeInteger(options.blockNumber)
      && options.blockNumber >= 0
      ? options.blockNumber
      : undefined;
    const eventTxHash = typeof options.txHash === 'string' && options.txHash.length > 0
      ? options.txHash.toLowerCase()
      : undefined;
    const logIndex = options.logIndex !== undefined
      && Number.isSafeInteger(options.logIndex)
      && options.logIndex >= 0
      ? options.logIndex
      : undefined;
    const blockHash = typeof options.blockHash === 'string' && options.blockHash.length > 0
      ? options.blockHash.toLowerCase()
      : undefined;
    signal?.throwIfAborted();
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !signal?.aborted
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    if (!isLifecycleCurrent() || kaId <= 0n || merkleRoot.length !== 32) return [];
    this.expireVmRefreshTargets(ctx);
    const update = `update${blockNumber === undefined ? '' : ` at block ${blockNumber}`}`;

    let ual: string;
    let holders: string[];
    try {
      const storageAddr = this.chain.getDKGKnowledgeAssetsAddress
        ? await this.chain.getDKGKnowledgeAssetsAddress()
        : undefined;
      if (!storageAddr) return [];
      ual = buildReconciledKnowledgeAssetUal(this.chain.chainId, storageAddr, kaId);
      holders = await this.localGraphsDescribingKnowledgeAsset(ual);
    } catch (err) {
      throw new Error(
        `VM refresh: could not read which local graphs hold KA ${kaId} for its ${update}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const eventRoot = ethers.hexlify(merkleRoot).toLowerCase();
    const queued: VmRefreshTarget[] = [];
    if (holders.length === 0) {
      this.log.debug(ctx, `VM refresh: no local graph holds ${ual}; nothing to refresh`);
    }
    for (const localCgId of holders) {
      if (!isLifecycleCurrent()) break;
      if (!this.isVmReconcileTargetSelected(localCgId)) {
        this.log.debug(
          ctx,
          `VM refresh: "${localCgId}" holds ${ual} but is not a VM reconcile target; not queued`,
        );
        continue;
      }
      let local: Awaited<ReturnType<DKGAgent['readVmRefreshLocalState']>>;
      let coversUpdate = false;
      try {
        local = await this.readVmRefreshLocalState(localCgId, ual);
        if (local.kind === 'confirmed' && local.merkleRoot === eventRoot) {
          coversUpdate = await this.vmRefreshCopyCoversUpdate(
            localCgId,
            ual,
            local.transactionHash,
            eventTxHash,
            blockNumber,
            blockHash,
          );
        }
      } catch (err) {
        throw new Error(
          `VM refresh: could not read the copy of ${ual} in "${localCgId}" for its ${update}: `
            + `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (local.kind !== 'confirmed') {
        this.log.debug(ctx, `VM refresh: ${ual} in "${localCgId}" not queued: no confirmed copy`);
        continue;
      }
      const sameRoot = local.merkleRoot === eventRoot;
      if (coversUpdate) {
        this.log.debug(
          ctx,
          `VM refresh: ${ual} in "${localCgId}" not queued: the copy holds this update`,
        );
        continue;
      }
      if (!isLifecycleCurrent()) break;
      const target: VmRefreshTarget = {
        localCgId,
        ual,
        kaId,
        merkleRoot: eventRoot,
        ...(blockNumber === undefined ? {} : { blockNumber }),
        ...(logIndex === undefined ? {} : { logIndex }),
        ...(blockHash === undefined ? {} : { blockHash }),
        ...(eventTxHash === undefined ? {} : { txHash: eventTxHash }),
        ...(sameRoot ? { checkVersion: true } : {}),
      };
      const delayMs = local.staged ? DKGAgentBase.VM_REFRESH_STAGED_GRACE_MS : 0;
      // A replayed event (a lane re-scan) leaves the held target and its
      // backoff alone.
      const offered = this.vmRefreshQueue.offer(target, delayMs);
      if (offered === 'held') {
        this.log.debug(ctx, `VM refresh: ${ual} in "${localCgId}" already has this or a newer update queued`);
        continue;
      }
      if (offered === 'full') {
        throw new Error(
          `VM refresh: ${this.vmRefreshQueue.size} targets are held, the most allowed, so the `
            + `${update} of ${ual} in "${localCgId}" waits for some to settle`,
        );
      }
      queued.push(target);
      if (sameRoot) {
        this.log.debug(
          ctx,
          `VM refresh: ${ual} in "${localCgId}" holds its update's root; version check queued`,
        );
      } else if (local.staged) {
        this.log.info(
          ctx,
          `VM refresh: ${ual} in "${localCgId}" does not hold its update's root and stages a newer `
            + `version; refresh queued in ${Math.round(delayMs / 1000)}s unless that version is promoted first`,
        );
      } else {
        this.log.info(
          ctx,
          `VM refresh: ${ual} in "${localCgId}" does not hold its update's root; refresh queued`,
        );
      }
      // A delayed target is not due yet: the graph's next reconcile pass
      // starts the worker.
      if (delayMs === 0 && this.vmReconcileScheduling && isLifecycleCurrent()) {
        this.vmReconcileScheduling.triggerLive(localCgId);
      }
    }
    return queued;
  }

  /**
   * #2858 — whether a copy at an update's root already reflects that update:
   * the update's own transaction confirmed it, or it was materialized from a
   * chain view at or after the update's block, which already held the update.
   * Neither fact proves fork lineage when the event carries a block hash,
   * because the same transaction can be included on a replacement fork.
   */
  async vmRefreshCopyCoversUpdate(
    this: DKGAgent,
    localCgId: string,
    ual: string,
    copyTxHash: string | undefined,
    eventTxHash: string | undefined,
    eventBlock: number | undefined,
    eventBlockHash: string | undefined,
  ): Promise<boolean> {
    if (eventBlockHash !== undefined) return false;
    if (eventTxHash !== undefined && copyTxHash === eventTxHash) return true;
    if (eventBlock === undefined) return false;
    const materialized = await readMaterializedVersion(
      this.store,
      contextGraphMetaUri(localCgId),
      ual,
      { source: 'agent.vmRefresh.materializedVersion', priority: 'background' },
    );
    return materialized !== null && materialized.blockNumber >= eventBlock;
  }

  /** #2858 — give up the refresh targets held past `VM_REFRESH_MAX_AGE_MS`, with a warning each. */
  expireVmRefreshTargets(this: DKGAgent, ctx: OperationContext): void {
    // Narrow test agents built without the base constructor have no queue.
    const queue = this.vmRefreshQueue as VmRefreshQueue | undefined;
    if (queue === undefined) return;
    for (const given of queue.expire()) {
      this.log.warn(
        ctx,
        `VM refresh: gave up on ${given.ual} in "${given.localCgId}" after `
          + `${Math.round(given.heldMs / 60_000)} min and ${given.failures} failed attempt(s) `
          + `(${queue.givenUpTotal} given up so far); its copy waits for the KA's next update `
          + 'or an asset fetch',
      );
    }
  }

  /**
   * #2858 — highest block the update event lane may persist as scanned: just
   * below the oldest held target's event, so a restart replays that event and
   * its target is recorded again. Targets held past their maximum age are
   * given up first, so one that never settles cannot hold the cursor for good.
   */
  vmRefreshPersistCeiling(this: DKGAgent): number | undefined {
    this.expireVmRefreshTargets(createOperationContext('system'));
    const oldest = (this.vmRefreshQueue as VmRefreshQueue | undefined)?.oldestBlockNumber();
    return oldest === undefined ? undefined : oldest - 1;
  }

  /** #2858 — the refresh lane's state, for `/api/status`. */
  getVmRefreshStatus(this: DKGAgent): {
    heldTargets: number;
    persistCeiling: number | null;
    givenUpTotal: number;
    refusedTotal: number;
  } {
    const queue = this.vmRefreshQueue as VmRefreshQueue | undefined;
    const oldest = queue?.oldestBlockNumber();
    return {
      heldTargets: queue?.size ?? 0,
      persistCeiling: oldest === undefined ? null : oldest - 1,
      givenUpTotal: queue?.givenUpTotal ?? 0,
      refusedTotal: queue?.refusedTotal ?? 0,
    };
  }

  /**
   * Local graphs whose root metadata graph describes this graph-scoped KA.
   * One subject-bound read; the caller filters them to reconcile targets.
   */
  async localGraphsDescribingKnowledgeAsset(this: DKGAgent, ual: string): Promise<string[]> {
    const result = await this.store.query(
      `SELECT DISTINCT ?g WHERE { GRAPH ?g { <${assertSafeIri(ual)}> `
        + `<${GRAPH_KA_CONTENT_SCOPE_VERSION_PREDICATE}> ?version } }`,
      { source: 'agent.vmRefresh.holders', priority: 'background' },
    );
    if (result.type !== 'bindings') return [];
    const prefix = 'did:dkg:context-graph:';
    const suffix = '/_meta';
    const holders = new Set<string>();
    for (const row of result.bindings) {
      const graph = row['g'];
      if (typeof graph !== 'string' || !graph.startsWith(prefix) || !graph.endsWith(suffix)) {
        continue;
      }
      const localCgId = graph.slice(prefix.length, graph.length - suffix.length);
      if (localCgId.length > 0 && contextGraphMetaUri(localCgId) === graph) holders.add(localCgId);
    }
    return [...holders];
  }

  /**
   * What the refresh lane decides on for one KA in one graph: the root and
   * assertion version the confirmed graph-scoped copy recorded, the
   * transaction that confirmed it when it is receipt-backed, and whether the
   * workspace stages a newer version than that copy. A staged version only
   * delays the refresh (see `VM_REFRESH_STAGED_GRACE_MS`). A head at the
   * confirmed version or older stages nothing newer; a corrupt one is read
   * past by the exact fetch.
   */
  async readVmRefreshLocalState(
    this: DKGAgent,
    localCgId: string,
    ual: string,
  ): Promise<
    | { readonly kind: 'none' }
    | {
      readonly kind: 'confirmed';
      readonly merkleRoot: string;
      readonly assertionVersion: bigint;
      readonly transactionHash?: string;
      readonly staged: boolean;
    }
  > {
    const read = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(this.store, {
      contextGraphId: localCgId,
      ual,
    });
    if (read.state !== 'confirmed') return { kind: 'none' };
    let staged = false;
    try {
      const head = await resolveKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager: new GraphManager(this.store),
        contextGraphId: localCgId,
        kaUal: ual,
        ...(read.envelope.subGraphName ? { subGraphName: read.envelope.subGraphName } : {}),
      });
      staged = head !== undefined
        && BigInt(head.assertionVersion) > BigInt(read.envelope.assertionVersion);
    } catch (err) {
      if (!isKnowledgeAssetWorkspaceHeadCorruptError(err)) throw err;
    }
    const transactionHash = read.envelope.transactionHash?.trim().toLowerCase();
    return {
      kind: 'confirmed',
      merkleRoot: ethers.hexlify(read.envelope.merkleRoot).toLowerCase(),
      assertionVersion: BigInt(read.envelope.assertionVersion),
      ...(transactionHash ? { transactionHash } : {}),
      staged,
    };
  }

  /**
   * #2858 — start this graph's refresh worker when it has due targets and
   * none is running. The worker runs beside the reconcile pass that starts
   * it, in the background RPC class and store lane, so the pass never waits
   * on a peer for a refresh. At most `VM_REFRESH_MAX_WORKERS` run at once; a
   * graph left waiting starts on its next pass or when a running worker ends.
   * Returns the graph's running worker, if any.
   */
  startVmRefreshWorker(
    this: DKGAgent,
    localCgId: string,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> | undefined {
    // Narrow test agents built without the base constructor have neither.
    const queue = this.vmRefreshQueue as VmRefreshQueue | undefined;
    const workers = this.vmRefreshWorkers as Map<string, Promise<void>> | undefined;
    if (queue === undefined || workers === undefined) return undefined;
    const running = workers.get(localCgId);
    if (running !== undefined) return running;
    if (signal?.aborted || !isTargetCurrent() || !queue.hasDue(localCgId)) return undefined;
    if (workers.size >= DKGAgentBase.VM_REFRESH_MAX_WORKERS) {
      this.log.debug(
        createOperationContext('system'),
        `VM refresh for "${localCgId}" waits for a free worker`,
      );
      return undefined;
    }
    const worker: Promise<void> = withOwnedRpcRequestContext(
      { requestClass: 'background', ...(signal ? { signal } : {}) },
      () => withDefaultStoreWorkPriority(
        'background',
        () => this.runVmRefreshesForCg(localCgId, onChainId, isTargetCurrent, signal),
      ),
    ).catch((err: unknown) => {
      this.log.warn(
        createOperationContext('system'),
        `VM refresh worker for "${localCgId}" stopped: `
          + `${err instanceof Error ? err.message : String(err)}`,
      );
    }).finally(() => {
      if (workers.get(localCgId) === worker) workers.delete(localCgId);
      if (signal?.aborted || this.vmReconcileRotationClosed) return;
      // Hand the freed slot on: this graph past its per-run bound, or a graph
      // that found every slot taken. Their passes start the workers.
      let free = DKGAgentBase.VM_REFRESH_MAX_WORKERS - workers.size;
      for (const dueCgId of queue.dueContextGraphIds()) {
        if (free <= 0) break;
        if (workers.has(dueCgId)) continue;
        if (!this.isVmReconcileTargetSelected(dueCgId)) {
          // The graph left VM reconciliation; no pass will work its targets.
          queue.clearContextGraph(dueCgId);
          continue;
        }
        void this.vmReconcileScheduling?.triggerLive(dueCgId);
        free -= 1;
      }
    });
    workers.set(localCgId, worker);
    trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, worker);
    return worker;
  }

  /**
   * Work off up to `VM_REFRESH_MAX_PER_PASS` of this graph's due refresh
   * targets. Each attempt is bounded by `VM_REFRESH_ATTEMPT_TIMEOUT_MS` and
   * its peer steps by `VM_REFRESH_PEER_STEP_TIMEOUT_MS`, and every outcome is
   * settled and logged: an attempt that fails, times out or finds no holder
   * backs off and asks the next peer window when it is due again. A closing
   * lifecycle or a replaced reconcile target keeps the target for the next
   * worker. Never throws.
   */
  async runVmRefreshesForCg(
    this: DKGAgent,
    localCgId: string,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    // Narrow test agents built without the base constructor have no queue.
    const queue = this.vmRefreshQueue as VmRefreshQueue | undefined;
    if (queue === undefined) return;
    const due = queue.due(localCgId, DKGAgentBase.VM_REFRESH_MAX_PER_PASS);
    if (due.length === 0) return;
    const ctx = createOperationContext('system');
    const stopped = (target: VmRefreshTarget): boolean => {
      if (!signal?.aborted && isTargetCurrent()) return false;
      this.log.debug(
        ctx,
        `VM refresh of ${target.ual} in "${localCgId}" deferred: its reconcile target closed`,
      );
      return true;
    };
    for (const target of due) {
      if (stopped(target)) return;
      let attempt: VmRefreshAttempt;
      let failed = false;
      try {
        attempt = await runBoundedOperation(
          (attemptSignal) => this.refreshConfirmedVmCopy(
            target,
            onChainId,
            isTargetCurrent,
            attemptSignal,
          ),
          {
            timeoutMs: DKGAgentBase.VM_REFRESH_ATTEMPT_TIMEOUT_MS,
            label: `VM refresh of ${target.ual}`,
            ...(signal ? { signal } : {}),
          },
        );
      } catch (err) {
        if (stopped(target)) return;
        failed = true;
        attempt = {
          outcome: 'retry',
          detail: isBoundedOperationTimeoutError(err)
            ? err.message
            : `failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (stopped(target)) return;
      const retryAt = queue.settle(target, attempt.outcome);
      const subject = `${target.ual} in "${localCgId}"`;
      if (attempt.outcome === 'refreshed') {
        this.log.info(ctx, `VM refresh: ${subject} now holds the current version (${attempt.detail})`);
      } else if (attempt.outcome === 'retry') {
        const retry = retryAt === undefined
          ? 'retrying on a later pass'
          : `retrying in ${Math.max(0, Math.round((retryAt - Date.now()) / 1000))}s`;
        const message = `VM refresh of ${subject} did not complete (${attempt.detail}); ${retry}`;
        if (failed) this.log.warn(ctx, message);
        else this.log.info(ctx, message);
      } else {
        this.log.debug(ctx, `VM refresh of ${subject} settled as ${attempt.outcome}: ${attempt.detail}`);
      }
    }
  }

  /**
   * One refresh attempt: settle from local state when the copy already holds
   * the event's root, otherwise read the chain's current root. A copy at that
   * root is current (the event was older or superseded — nothing is rolled
   * back); a different one is fetched as the exact current version, which
   * replaces the older assertion in place. `signal` is the attempt's own: it
   * stops the fetch at the attempt deadline.
   */
  async refreshConfirmedVmCopy(
    this: DKGAgent,
    target: VmRefreshDue,
    onChainId: string,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<VmRefreshAttempt> {
    const local = await this.readVmRefreshLocalState(target.localCgId, target.ual);
    if (local.kind === 'none') {
      return { outcome: 'not-applicable', detail: 'no confirmed copy is held any more' };
    }
    // A version still staged here was not promoted by the lane that staged it
    // (or nothing on this node promotes it). The exact fetch below verifies it
    // against the chain like any other copy, and a staged version newer than
    // the chain's stays in the workspace: the fetch writes only Verifiable
    // Memory.
    // A copy at the update's root is current, unless the nudge found it
    // there already: then only the chain's version can tell (a repeated root).
    if (!target.checkVersion && local.merkleRoot === target.merkleRoot) {
      return { outcome: 'current', detail: 'the copy holds the update root' };
    }
    if (typeof this.chain.getLatestMerkleRoot !== 'function') {
      return { outcome: 'not-applicable', detail: 'the chain adapter reads no latest root' };
    }
    let chainRoot = ethers.hexlify(
      await this.chain.getLatestMerkleRoot(target.kaId, { signal }),
    ).toLowerCase();
    if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
    let chainVersion: bigint | undefined;
    if (chainRoot === local.merkleRoot) {
      // An older or superseded event, a read that has not seen the update yet
      // (a lagging endpoint, a confirmation depth above one), or an update
      // that repeated the copy's root. Settle only on a coherent view at or
      // after the update's block, by version as well as root.
      const confirmed = await this.confirmVmRefreshCurrentAtEventBlock(
        target,
        local,
        isTargetCurrent,
        signal,
      );
      if (confirmed.kind === 'settled') return confirmed.attempt;
      // The pinned view names a newer version: fetch it.
      chainRoot = confirmed.chainRoot;
      chainVersion = confirmed.rootCount;
    }

    let result: ContextGraphAssetFetchResult;
    try {
      result = await this.runExactAssetFetchForContextGraph(target.localCgId, [target.ual], {
        isCurrent: () => isTargetCurrent() && !signal?.aborted,
        ...(signal ? { signal } : {}),
        expectedOnChainId: onChainId,
        maxPeers: DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
        // Each retry asks the next window of candidates, so a holder outside
        // the first few peers is still reached.
        peerWindowIndex: target.failures,
        // An update keeps the UAL. Its old responder session can outlive the
        // previous version, so every refresh attempt needs a new snapshot.
        forceFreshExactSession: true,
        // A candidate that cannot be reached (after a restart, the curator
        // is often not connected yet) yields to the next one.
        peerStepTimeoutMs: DKGAgentBase.VM_REFRESH_PEER_STEP_TIMEOUT_MS,
        // Evidence that has not seen the update would settle on the old version.
        ...((target.proofBlockNumber ?? target.blockNumber) === undefined
          ? {} : { minVersionBlock: target.proofBlockNumber ?? target.blockNumber }),
      });
    } catch (err) {
      // This adapter cannot prove an exact version at all. Anything else,
      // including a conflict such as a version snapshot the endpoints did
      // not agree on, is retried after backoff.
      if (err instanceof VmReconcileUnavailableError) {
        return { outcome: 'not-applicable', detail: 'this adapter cannot prove an exact version' };
      }
      if (err instanceof ExactAssetVersionBehindError) {
        return { outcome: 'retry', detail: err.message };
      }
      throw err;
    }
    const status = result.items[0]?.status;
    if (status === 'materialized' || status === 'fetched') {
      return { outcome: 'refreshed', detail: `${status} after ${result.peerAttempts} peer attempt(s)` };
    }
    if (status === 'already-present') {
      return { outcome: 'current', detail: 'the exact inspection found the current version' };
    }
    // The exact inspection can refuse a refreshed copy while a workspace head
    // names another version (an older one, or one staged ahead of the chain);
    // the confirmed copy itself is the answer here.
    const after = await this.readVmRefreshLocalState(target.localCgId, target.ual);
    if (
      after.kind === 'confirmed'
      && after.merkleRoot === chainRoot
      && (chainVersion === undefined || after.assertionVersion >= chainVersion)
    ) {
      return { outcome: 'refreshed', detail: 'the confirmed copy holds the chain root' };
    }
    return {
      outcome: 'retry',
      detail: `no peer served the current version; ${result.peerAttempts} peer attempt(s)`,
    };
  }

  /**
   * #2858 — the copy holds the root a live chain read returned. That read can
   * predate the update (a lagging endpoint, a confirmation depth above one),
   * and a root names content, not a version: an update may repeat an earlier
   * root. So settle from a coherent view at or after the event's block:
   * `current` when it holds the copy's root at a version no newer than the
   * copy's, `retry` while it has not reached that block, and the root and
   * version it shows otherwise, which the caller then fetches. On an adapter
   * that reads no pinned view, the live read settles it.
   */
  async confirmVmRefreshCurrentAtEventBlock(
    this: DKGAgent,
    target: VmRefreshDue,
    local: { readonly merkleRoot: string; readonly assertionVersion: bigint },
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'settled'; readonly attempt: VmRefreshAttempt }
    | { readonly kind: 'newer'; readonly chainRoot: string; readonly rootCount: bigint }
  > {
    const current = {
      kind: 'settled',
      attempt: { outcome: 'current', detail: 'the copy holds the chain root and version' },
    } as const;
    if (typeof this.chain.readKnowledgeAssetVersionSnapshot !== 'function') return current;
    // Without a view the attempt retries, and says why the adapter had none when it reports that.
    const versionRead = await readVmRefreshVersionView(
      this.chain.readKnowledgeAssetVersionSnapshot.bind(this.chain), target.kaId, signal,
    );
    if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
    if (versionRead.view === null) return { kind: 'settled', attempt: versionRead.retry };
    const { view } = versionRead;
    const proofBlock = target.proofBlockNumber ?? target.blockNumber;
    if (proofBlock !== undefined && view.blockNumber < proofBlock) {
      return {
        kind: 'settled',
        attempt: {
          outcome: 'retry',
          detail: `the chain view at block ${view.blockNumber} is behind the update's block `
            + `${proofBlock}`,
        },
      };
    }
    const viewRoot = view.latestRoot.toLowerCase();
    return viewRoot === local.merkleRoot && view.rootCount <= local.assertionVersion
      ? current
      : { kind: 'newer', chainRoot: viewRoot, rootCount: view.rootCount };
  }

  /**
   * Canonical evidence-gated VM reconciliation operation for one CG.
   *
   * All callers enter the same dispatcher; the admitted domain operation is
   * decomposed below into target resolution, repair, reconcile dependencies,
   * telemetry, and result adaptation.
   */
  async runVmReconcileForCg(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource = 'manual',
  ): Promise<ContextGraphReconcileResult> {
    if (this.started && !this.vmReconcileRuntimeReady) {
      throw new VmReconcileQueueClosedError();
    }
    return this.ensureVmReconcileScheduling().dispatch(localCgId, source);
  }

  /**
   * Fetch a small, explicit set of RFC64 Knowledge Assets.
   *
   * This operator path is independent of the background chain reconciler. It
   * proves every requested UAL against the chain, uses the exact-asset wire
   * filter, and never scans or replaces the complete Context Graph. It also
   * leaves the graph's contiguous reconcile watermark unchanged: a small
   * fetch is not proof that any ordinal range is complete.
   */
  async fetchContextGraphAssets(
    this: DKGAgent,
    localCgId: string,
    requestedUals: readonly string[],
    options: { peerIds?: readonly string[] } = {},
  ): Promise<ContextGraphAssetFetchResult> {
    if (this.started && (!this.vmReconcileRuntimeReady || this.graphScopedStoreClosed)) {
      throw new VmReconcileQueueClosedError();
    }

    const subscription = this.subscribedContextGraphs.get(localCgId);
    if (!subscription?.subscribed && !subscription?.coreHosted) {
      throw new ContextGraphNotFoundError(localCgId);
    }
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const signal = this.vmReconcileLifecycleController?.signal;
    const isCurrent = (): boolean => {
      const current = this.subscribedContextGraphs.get(localCgId);
      return !this.vmReconcileRotationClosed
        && !this.graphScopedStoreClosed
        && !signal?.aborted
        && this.vmReconcileLifecycleGeneration === lifecycleGeneration
        && current === subscription
        && Boolean(current?.subscribed || current?.coreHosted);
    };
    if (!isCurrent()) throw new VmReconcileQueueClosedError();
    // Exact-asset recovery is another VM materialization entry point and must
    // not trust the persisted subscription bit as membership proof.
    const authorityRead = (async () => {
      try {
        return await withRpcUsageSite(
          CG_AUTH_RPC_SITES.exactAssetFetch,
          () => this.canReadContextGraph(localCgId, {
            allowSubscriptionFallback: false,
            signal,
          }),
        );
      } finally {
        // A bounded caller may return while shared durable index work remains.
        // Keep that physical read in the VM lifecycle drain before releasing
        // the exact-asset worker.
        await this.chain.contextGraphAuthorityIndexRevisionReader?.whenIdle();
      }
    })();
    trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, authorityRead);
    const canRead = await raceVmReconcileAbort(authorityRead, signal).catch(() => false);
    if (!isCurrent()) throw new VmReconcileQueueClosedError();
    if (!canRead) throw new ContextGraphNotFoundError(localCgId);
    // Bound through the prototype, as narrow hosts that borrow this operator
    // method do not carry the shared tail.
    return SwmHostModeMethods.prototype.runExactAssetFetchForContextGraph.call(
      this,
      localCgId,
      requestedUals,
      {
        isCurrent,
        ...(signal ? { signal } : {}),
        ...(options.peerIds === undefined ? {} : { peerIds: options.peerIds }),
        ...(subscription.onChainId ? { expectedOnChainId: subscription.onChainId } : {}),
      },
    );
  }

  /**
   * The exact-asset fetch once its caller has proved read authority and owns
   * the lifecycle: chain evidence, local inspection against the current root
   * and version, a bounded peer traversal, and re-inspection. Shared by the
   * operator fetch above and the VM refresh lane ({@link refreshConfirmedVmCopy}).
   */
  async runExactAssetFetchForContextGraph(
    this: DKGAgent,
    localCgId: string,
    requestedUals: readonly string[],
    options: {
      isCurrent: () => boolean;
      signal?: AbortSignal;
      peerIds?: readonly string[];
      expectedOnChainId?: string;
      maxPeers?: number;
      /**
       * Retry number of the caller. Curators head every window, since on a
       * curated graph they may be the only holders; the curator and the
       * ordinary tiers each start past the peers earlier windows asked.
       */
      peerWindowIndex?: number;
      /** See `runExactAssetFetch`: evidence older than this block is refused. */
      minVersionBlock?: number;
      /**
       * Wall clock for curator resolution and for each candidate's
       * preparation (connect, protocol probe, admission). A candidate past it
       * is skipped for the next one; resolution past it falls back to the
       * preferred and connected peers. Unset leaves both to `signal`.
       */
      peerStepTimeoutMs?: number;
      /** Start a new exact-asset snapshot for this update refresh attempt. */
      forceFreshExactSession?: boolean;
    },
  ): Promise<ContextGraphAssetFetchResult> {
    const { isCurrent, signal, peerStepTimeoutMs } = options;
    /** One network step, under `peerStepTimeoutMs` when the caller set it. */
    const runPeerStep = <T>(
      label: string,
      step: (stepSignal: AbortSignal | undefined) => Promise<T>,
    ): Promise<T> => (peerStepTimeoutMs === undefined
      ? step(signal)
      : runBoundedOperation(step, {
        timeoutMs: peerStepTimeoutMs,
        label,
        ...(signal ? { signal } : {}),
      }));
    if (
      typeof this.chain.getKAContextGraphId !== 'function'
      || typeof this.chain.readKnowledgeAssetVersionSnapshot !== 'function'
    ) {
      throw new VmReconcileUnavailableError();
    }
    const getKAContextGraphId = this.chain.getKAContextGraphId.bind(this.chain);
    const readKnowledgeAssetVersionSnapshot =
      this.chain.readKnowledgeAssetVersionSnapshot.bind(this.chain);

    const ctx = createOperationContext('system');
    const finalizer = this.getOrCreateFinalizationHandler();
    const physicalRun = runExactAssetFetch({
      contextGraphId: localCgId,
      requestedUals,
      ...(options.peerIds === undefined ? {} : { peerIds: options.peerIds }),
      ...(options.expectedOnChainId ? { expectedOnChainId: options.expectedOnChainId } : {}),
      ...(options.maxPeers === undefined ? {} : { maxPeers: options.maxPeers }),
      ...(options.minVersionBlock === undefined
        ? {}
        : { minVersionBlock: options.minVersionBlock }),
    }, {
      chainId: this.chain.chainId,
      signal,
      isCurrent,
      getKAContextGraphId: (kaId, readSignal) =>
        getKAContextGraphId(kaId, { signal: readSignal }),
      readKnowledgeAssetVersionSnapshot: (kaId, readSignal, onUnavailable) =>
        readKnowledgeAssetVersionSnapshot(kaId, { signal: readSignal, onUnavailable }),
      verifyLocalContextGraph: (onChainCgId) =>
        this.requireLocalCgMatchesOnChainSlot(
          localCgId,
          onChainCgId,
          ctx,
          { signal },
        ),
      inspectLocal: async (item: ExactAssetFetchEvidence) => {
        if (!isCurrent()) throw new VmReconcileQueueClosedError();
        const outcome = await finalizer.handleExactChainReconciledKC({
          contextGraphId: localCgId,
          onChainCgId: item.onChainCgId,
          ual: item.ual,
          assertionVersion: item.assertionVersion,
          merkleRoot: item.merkleRoot,
          publisherAddress: item.publisherAddress,
          kaId: item.kaId,
          batchId: item.batchId,
          versionBlock: item.versionBlock,
          authorAddress: item.authorAddress,
          // The public-authority consumer validates this lease after its last
          // store/CG-gate await; stale evidence falls back to live reads.
          versionSnapshot: Object.freeze({
            ...item.versionSnapshot,
            latestRoot: item.merkleRoot.slice(),
          }),
          signal,
        }, ctx);
        if (outcome === 'promoted') return 'materialized';
        if (outcome === 'already-confirmed' || outcome === 'stale-target') return 'present';
        return 'missing';
      },
      resolvePeerIds: async () => {
        const curatorResolution = await runPeerStep(
          `Curator resolution for "${localCgId}"`,
          (stepSignal) => this.resolveCuratorPeerIdsForCg(localCgId, {
            maxPeerIds: MAX_CONTEXT_GRAPH_ASSET_FETCH_PEERS,
            signal: stepSignal,
            isCurrent,
          }),
        ).catch((error: unknown) => {
          if (isBoundedOperationTimeoutError(error)) {
            this.log.info(ctx, `Exact asset fetch: ${error.message}; asking connected peers`);
          }
          return { peerIds: [] as string[] };
        });
        if (!isCurrent()) throw new VmReconcileQueueClosedError();
        const connectedPeerIds = this.node?.libp2p?.getConnections?.()
          ?.map((connection) => connection.remotePeer.toString()) ?? [];
        const usable = (peerId: string | undefined): peerId is string =>
          Boolean(peerId && peerId !== this.peerId);
        const curators = [...new Set(curatorResolution.peerIds.filter(usable))];
        const curatorSet = new Set(curators);
        const ordinary = [...new Set(
          [this.preferredSyncPeers.get(localCgId), ...connectedPeerIds].filter(usable),
        )].filter((peerId) => !curatorSet.has(peerId));
        const windowIndex = options.peerWindowIndex !== undefined
          && Number.isSafeInteger(options.peerWindowIndex)
          && options.peerWindowIndex > 0
          ? options.peerWindowIndex
          : 0;
        const windowSize = exactAssetFetchPeerWindow(options.maxPeers);
        const curatorSlots = Math.min(curators.length, windowSize);
        return [
          ...rotatePeerIds(curators, windowIndex * curatorSlots),
          ...rotatePeerIds(ordinary, windowIndex * (windowSize - curatorSlots)),
        ];
      },
      // A step past its bound rejects; the traversal logs it and moves on to
      // the next candidate.
      preparePeer: (peerId) => runPeerStep('Peer preparation', async (stepSignal) => {
        await this.ensurePeerConnected(peerId, { signal: stepSignal });
        if (!isCurrent()) throw new VmReconcileQueueClosedError();
        const remotePeer = this.node.libp2p.getConnections()
          .find((connection) => connection.remotePeer.toString() === peerId)
          ?.remotePeer;
        if (!remotePeer || !(await this.waitForSyncProtocol(remotePeer, stepSignal))) return false;
        return this.ensurePeerAdmittedForRecovery(
          peerId,
          ctx,
          'Exact asset fetch peer',
          stepSignal,
        );
      }),
      fetchFromPeer: async (peerId, uals) => {
        await this.syncExactKnowledgeAssetsFromPeerDetailed(
          peerId,
          localCgId,
          [...uals],
          {
            signal,
            isCurrent,
            // The same UAL can move to a new root while the responder still
            // holds its older exact-asset page session. A refresh must start
            // from a new snapshot on every attempt; its pages still share one
            // session within this invocation.
            forceFreshExactSession: options.forceFreshExactSession === true,
          },
        );
      },
      flush: async () => {
        await this.store.flush?.({
          priority: 'background',
          source: 'agent.exactAssetFetch.flush',
        });
      },
      log: (message) => this.log.info(ctx, message),
    }).catch((error) => {
      if (error instanceof VmReconcileQueueClosedError
        || error instanceof ExactAssetFetchLifecycleClosedError) {
        throw new VmReconcileQueueClosedError();
      }
      throw error;
    });

    trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, physicalRun);
    return raceVmReconcileAbort(physicalRun, signal);
  }

  ensureVmReconcileScheduling(
    this: DKGAgent,
  ): VmReconcileSchedulingRuntime<ContextGraphReconcileResult> {
    if (this.started && !this.vmReconcileRuntimeReady) {
      throw new VmReconcileQueueClosedError();
    }
    let scheduling = this.vmReconcileScheduling;
    if (!scheduling) {
      scheduling = new VmReconcileSchedulingRuntime(
        (localCgId, source) => this.executeVmReconcileForCg(localCgId, source),
        (localCgId, err) => {
          // Retired name-hash id: not a failure, nothing retries it
          // (see supersedingContextGraphIdFor).
          const supersedingId = this.supersedingContextGraphIdFor?.(localCgId);
          if (supersedingId) {
            this.log.debug(
              createOperationContext('system'),
              `VM reconcile for "${localCgId}" stopped: superseded by cleartext adoption of "${supersedingId}"`,
            );
            return;
          }
          // Reported where the graph was parked (executeVmReconcileForCg): it
          // is asked again shortly and does not wait for the sweep.
          if (
            err instanceof VmReconcileReadAuthorityUnansweredError
            || err instanceof VmReconcileLocalRpcRefusalError
            || err instanceof VmReconcileOvertakenError
          ) return;
          this.log.warn(
            createOperationContext('system'),
            `VM reconcile for "${localCgId}" failed; retrying on the periodic sweep: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
        {
          concurrency: DKGAgentBase.VM_RECONCILE_CONCURRENCY,
          maxPending: DKGAgentBase.VM_RECONCILE_QUEUE_MAX_PENDING,
          maxForegroundBurst: DKGAgentBase.VM_RECONCILE_MAX_FOREGROUND_BURST,
          discoveryBatchSize: DKGAgentBase.VM_RECONCILE_UNBOUND_BATCH_SIZE,
          periodicBoundBatchSize: DKGAgentBase.VM_RECONCILE_PERIODIC_BOUND_BATCH_SIZE,
        },
      );
      this.vmReconcileScheduling = scheduling;
    }
    return scheduling;
  }

  async executeVmReconcileForCg(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource,
  ): Promise<ContextGraphReconcileResult> {
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    if (!isLifecycleCurrent()) throw new VmReconcileQueueClosedError();
    // Retired name-hash id: it names no local graph any more, the answer target
    // resolution would give without a chain read (see supersedingContextGraphIdFor).
    if (this.supersedingContextGraphIdFor?.(localCgId)) throw new ContextGraphNotFoundError(localCgId);
    // Automatic passes (the historical catch-up walk above all) run in the
    // background RPC class and store lane, so they cannot take the capacity
    // reserved for publishing, StorageACKs and API reads. An operator's
    // manual request keeps the caller's class.
    const runInLane = <T>(work: () => Promise<T>): Promise<T> => source === 'manual'
      ? work()
      : withOwnedRpcRequestContext(
        { requestClass: 'background', ...(lifecycleSignal ? { signal: lifecycleSignal } : {}) },
        () => withDefaultStoreWorkPriority('background', work),
      );
    // A chain read attempt that the node's own RPC admission refused was
    // never sent, so it says nothing about the graph. An automatic pass that
    // meets one leaves the graph waiting to be asked again shortly, as after
    // an unanswered read-authority check. Without that its next attempt is
    // the graph's turn in the periodic sweep, and after a failed pass its
    // live nudges are dropped until then. An operator's request, any other
    // failure, and a graph the wait does not take end as they always did.
    const askAgainAfterLocalRpcRefusal = (refusal: unknown, isCurrent: () => boolean): boolean =>
      askVmReconcileAgainAfterLocalRpcRefusal({
        contextGraphId: localCgId,
        refusal,
        automatic: source !== 'manual',
        defer: () => this.vmReconcileScheduling?.deferForLocalRpcRefusal(localCgId, {
          signal: lifecycleSignal,
          isCurrent,
          canAdmit: () => this.vmRecoverySyncAdmissionAvailable(localCgId),
        }),
        log: (level, message) => this.log[level](createOperationContext('system'), message),
      });
    const physicalRun = runInLane(async (): Promise<ContextGraphReconcileResult> => {
      const passStartedAt = performance.now();
      const passGapMs = vmReconcilePassGapMs(this, localCgId, passStartedAt);
      const target = await this.resolveVmReconcileTarget(
        localCgId,
        isLifecycleCurrent,
        lifecycleSignal,
      ).catch((err: unknown): never => {
        if (!(err instanceof VmReconcileReadAuthorityUnansweredError)) throw err;
        // The chain read behind the read-authority check got no answer, which
        // is the node's RPC budget or its endpoint and not the graph. An
        // automatic pass leaves the graph waiting to be asked again; without
        // that its next attempt is the periodic sweep, up to a full interval
        // after the read would have been answered. It is asked again only
        // while its fetch could start, the readiness every waiter uses. An
        // operator's request, and a graph the wait cannot take, end as they
        // always did.
        const waiting = source === 'manual'
          ? undefined
          : this.vmReconcileScheduling?.deferForReadAuthority(localCgId, {
              signal: lifecycleSignal,
              isCurrent: isLifecycleCurrent,
              canAdmit: () => this.vmRecoverySyncAdmissionAvailable(localCgId),
            });
        if (waiting === undefined) throw new ContextGraphNotFoundError(localCgId);
        const message = `VM reconcile for "${localCgId}" is waiting for read authority `
          + `(${err.readAuthority}): the chain read got no answer; asking again shortly`;
        if (waiting === 'parked') this.log.info(createOperationContext('system'), message);
        else this.log.debug(createOperationContext('system'), message);
        throw err;
      });
      const resolveTargetMs = performance.now() - passStartedAt;
      const isTargetCurrent = () => isLifecycleCurrent()
        && this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration);
      if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      // #2858 — confirmed copies behind an on-chain update. The ordinal cursor
      // never revisits a settled ordinal, so a worker beside this pass
      // refreshes them. The pass never waits on it, and a slice that fails
      // does not hold it back.
      this.startVmRefreshWorker(localCgId, target.onChainId, isTargetCurrent, lifecycleSignal);

      // Reconcile on a private cursor snapshot. The caller-facing abort race may
      // finish before an adapter physically settles; a stale continuation must
      // never mutate the live cursor or persist a watermark into a new binding.
      const workingCursor: CursorState = {
        watermark: target.cursor.watermark,
        ahead: new Map(target.cursor.ahead),
        scanOrdinal: target.cursor.scanOrdinal,
      };
      let pendingWatermark: number | undefined;
      let result: VmReconcileEngineResult;
      let engineTimings: ReconcilePassTimings | undefined;
      const refusedReads = new VmReconcileRefusedSliceReads();
      try {
        result = await reconcileContextGraph(
          this.createVmReconcileDeps(
            localCgId,
            lifecycleGeneration,
            target,
            lifecycleSignal,
            {
              identityCursor: target.cursor,
              persistWatermark: (_lcg, watermark) => { pendingWatermark = watermark; },
              observePassTimings: (timings) => { engineTimings = timings; },
              refusedReads,
            },
          ),
          workingCursor,
          localCgId,
          target.onChainCgId,
        );
      } catch (err) {
        // A rejected pass keeps what it proved (see `reconcileContextGraph`):
        // its held completions and scan position move to the live cursor, so
        // the retry neither re-verifies settled ordinals nor restarts the
        // slice. The watermark and its persistence stay with a successful pass.
        if (isTargetCurrent()) {
          for (const [heldOrdinal, observedBlock] of workingCursor.ahead) {
            if (heldOrdinal >= target.cursor.watermark && !target.cursor.ahead.has(heldOrdinal)) {
              target.cursor.ahead.set(heldOrdinal, observedBlock);
            }
          }
          target.cursor.scanOrdinal = Math.max(target.cursor.watermark, workingCursor.scanOrdinal);
        }
        throw err;
      }
      if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      let flushMs = 0;
      if (result.reconciled > 0 || pendingWatermark !== undefined) {
        const flushStartedAt = performance.now();
        await this.store.flush?.({
          priority: 'background',
          source: 'agent.vmReconcile.materialization.flush',
        });
        flushMs = performance.now() - flushStartedAt;
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      let watermarkMs = 0;
      if (pendingWatermark !== undefined) {
        const watermarkStartedAt = performance.now();
        await this.persistVmReconcileWatermark(
          localCgId,
          pendingWatermark,
          target,
        );
        watermarkMs = performance.now() - watermarkStartedAt;
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      target.cursor.watermark = workingCursor.watermark;
      target.cursor.ahead = new Map(workingCursor.ahead);
      target.cursor.scanOrdinal = workingCursor.scanOrdinal;
      const response = this.toContextGraphReconcileResult(localCgId, source, target, result);
      this.emitVmReconcileTelemetry(localCgId, target, result, response.status);
      observeVmRecoveryTiming(() => {
        const timings = engineTimings;
        this.log.info(
          createOperationContext('system'),
          `VM reconcile pass timing for "${localCgId}": source=${source} `
            + `gapSincePreviousPassMs=${passGapMs === undefined ? '-' : Math.round(passGapMs)} `
            + `resolveTargetMs=${Math.round(resolveTargetMs)} `
            + `headReadMs=${Math.round(timings?.headReadMs ?? 0)} blockReadMs=${Math.round(timings?.blockReadMs ?? 0)} `
            + `scanMs=${Math.round(timings?.scanMs ?? 0)} recoverMs=${Math.round(timings?.recoverMs ?? 0)} `
            + `engineMs=${Math.round(timings?.totalMs ?? 0)} flushMs=${Math.round(flushMs)} `
            + `watermarkMs=${Math.round(watermarkMs)} totalMs=${Math.round(performance.now() - passStartedAt)} `
            + `processed=${result.processed} reconciled=${result.reconciled} pending=${result.pending} `
            + `continue=${result.shouldContinueImmediately ? 1 : 0}`,
        );
      });
      // A slice that met a refused read keeps the graph's ask-again window
      // as it is, whichever way it continues below.
      if (refusedReads.met) this.vmReconcileScheduling?.noteLocalRpcRefusal(localCgId);
      // The reconciler owns the continuation policy: productive slices, stale
      // bindings, and explicit provider rotations continue immediately, while
      // pending-only historical inventory yields to the periodic sweep.
      const localAdmissionWait = {
        signal: lifecycleSignal,
        isCurrent: isTargetCurrent,
        canAdmit: () => this.vmRecoverySyncAdmissionAvailable(localCgId),
      };
      if (isTargetCurrent() && result.localAdmissionDeferred) {
        this.vmReconcileScheduling?.retryLocalAdmission(localCgId, localAdmissionWait);
      } else if (isLifecycleCurrent() && result.shouldContinueImmediately) {
        // A graph that just fetched from peers takes its next turn behind the
        // graphs the node's sync admission refused while it did. Without that
        // the freed capacity goes back to whichever pass asks first, which is
        // this one, and the others repeat their passes to be refused again.
        const yielded = result.recoveryAttempted === true
          && !result.staleTarget
          && isTargetCurrent()
          && this.vmReconcileScheduling?.yieldLocalAdmissionTurn(localCgId, localAdmissionWait) === true;
        if (!yielded) this.vmReconcileScheduling?.triggerLive(localCgId);
      } else if (
        isTargetCurrent()
        && !askAgainAfterLocalRpcRefusal(
          refusedReads.askAgainFor({ visited: result.processed, outstanding: result.pending }),
          isTargetCurrent,
        )
      ) {
        // RS heal is bounded, best-effort maintenance. Run it only after the
        // useful VM slice completed and only when that slice has no urgent
        // continuation. Store pressure must defer maintenance, never erase the
        // main reconcile result or prevent foreground ordinal progress. A slice
        // that is asked again for the reads it went without has its
        // continuation in that pass.
        if (target.kind === 'subscription') {
          try {
            await this.healStrandedScopedKCs(
              localCgId,
              target,
              isTargetCurrent,
              lifecycleSignal,
            );
          } catch (err) {
            // Defensive isolation at the dispatcher boundary: the heal method
            // reduces known pressure to a deferred result, but a future repair
            // regression must still never erase an already-computed VM result.
            this.log.warn(
              createOperationContext('system'),
              `RS heal after VM reconcile for "${localCgId}" was skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      noteVmReconcilePassEnd(this, localCgId, performance.now());
      return response;
    }).catch((err: unknown): never => {
      // The pass ended on the refused read itself, the asset count above all.
      // It still ends as a failed pass, so live nudges from elsewhere stay
      // held; only the wait's own nudge lifts that hold.
      if (askAgainAfterLocalRpcRefusal(err, isLifecycleCurrent)) {
        throw new VmReconcileLocalRpcRefusalError(err);
      }
      // The pass stopped because its target is no longer the graph's current
      // one, on a node that is not shutting down: the graph's row was stored
      // again under it, by a subscribe request for a graph the node already
      // holds, for one. That is not a failure of the graph. Asked again
      // shortly, it gets a pass on the row as it is now; left as a failed pass
      // it lost its live nudges until its turn in the periodic sweep. Only a
      // graph the sweep would still select is asked again.
      const stillReconciled = () => isLifecycleCurrent()
        && this.isVmReconcileTargetSelected(localCgId);
      const overtaken = askVmReconcileAgainAfterOvertakenPass({
        contextGraphId: localCgId,
        error: err,
        automatic: source !== 'manual',
        stillReconciled,
        defer: () => this.vmReconcileScheduling?.deferForOvertakenPass(localCgId, {
          signal: lifecycleSignal,
          isCurrent: stillReconciled,
          canAdmit: () => this.vmRecoverySyncAdmissionAvailable(localCgId),
        }),
        log: (level, message) => this.log[level](createOperationContext('system'), message),
      });
      if (overtaken) throw new VmReconcileOvertakenError(err);
      throw err;
    });
    trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, physicalRun);
    return raceVmReconcileAbort(physicalRun, lifecycleSignal);
  }

  async resolveVmReconcileTarget(
    this: DKGAgent,
    localCgId: string,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<VmReconcileTarget> {
    // System bootstrap/control graphs never have a ContextGraphStorage id.
    // Keep this guard at the canonical execution boundary as well as in sweep
    // selection so manual/live callers cannot turn them into historical
    // reverse-name scans.
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(localCgId)) {
      throw new ContextGraphNotFoundError(localCgId);
    }
    const existingSubscription = this.subscribedContextGraphs.get(localCgId);
    // Local-origin graphs are deliberately off-chain until registration (or
    // authoritative registration recovery) installs a numeric binding. Keep
    // this invariant at the execution boundary too: a job admitted just before
    // create/register state changed must not fall through to cold name-hash
    // discovery. Remote unbound subscriptions still use the self-prime path.
    if (
      this.localContextGraphProvenance.hasLocalCreate(localCgId)
      && (existingSubscription === undefined
        || !this.contextGraphBindingState.hasBindingCandidate(
          localCgId,
          existingSubscription,
        ))
    ) {
      throw new ContextGraphNotFoundError(localCgId);
    }
    // Registration is the exclusive owner of the local -> numeric binding
    // transition. A reconcile admitted just before the selection snapshot
    // changed must retire without starting a competing cold lookup.
    if (this.contextGraphRegistrationsInFlight?.has(localCgId)) {
      throw new VmReconcileQueueClosedError();
    }
    // The operator switch is the outer boundary for every reconcile target.
    // Keep it ahead of subscription self-prime and selected-only name-hash
    // resolution so a disabled reconciler performs no target-specific chain
    // IO as a side effect of probing availability.
    if (!this.vmReconcileEnabled()) {
      throw new VmReconcileUnavailableError();
    }
    let sub = existingSubscription;
    const existingBinding = sub === undefined
      ? undefined
      : this.contextGraphBindingState.currentBindingFor(localCgId, sub);
    const acceptedUnregistered = existingBinding?.bindingKind !== 'authoritative'
      && this.hasAcceptedRfc64UnregisteredAuthorityV1(localCgId);
    if (
      acceptedUnregistered
      && this.chain.contextGraphAuthorityIndexRevisionReader === undefined
    ) {
      throw new ContextGraphNotFoundError(localCgId);
    }
    if (!sub?.subscribed && !sub?.coreHosted) {
      if (!this.isRfc64SelectedVmReconcileTargetAllowed(localCgId)) {
        throw new ContextGraphNotFoundError(localCgId);
      }
      // This branch is definitionally an accepted RFC-64 PUBLIC policy (the
      // selector rejects private policy envelopes) and carries no member row
      // that could have been poisoned. Resolve it through the dedicated
      // selected target path without doing a second general read probe.
      return this.resolveSelectedVmReconcileTarget(localCgId, isCurrent, signal);
    }
    if (existingBinding?.bindingKind !== 'authoritative') {
      const bindingGeneration = this.contextGraphBindingState.capture(localCgId);
      const finalized = await this.resolveFinalizedVmReconcileBinding(
        localCgId,
        isCurrent,
        signal,
      );
      if (finalized.kind === 'absent') {
        if (acceptedUnregistered) throw new ContextGraphNotFoundError(localCgId);
        throw new ContextGraphOnChainIdUnresolvedError(localCgId);
      }
      if (finalized.kind === 'legacy-current' && acceptedUnregistered) {
        throw new ContextGraphNotFoundError(localCgId);
      }
      if (finalized.kind === 'resolved') {
        const currentNameHash = sub.onChainHash === undefined
          ? this.contextGraphNameCommitment(localCgId)
          : this.contextGraphWireId(sub.onChainHash);
        if (
          !isCurrent()
          || this.subscribedContextGraphs.get(localCgId) !== sub
          || currentNameHash !== finalized.nameHash
          || !this.contextGraphBindingState.isGenerationCurrent(
            localCgId,
            bindingGeneration,
          )
        ) {
          throw new VmReconcileQueueClosedError();
        }
        const boundSubscription = { ...sub, onChainHash: finalized.nameHash };
        this.bindSubscriptionOnChainId(localCgId, boundSubscription, finalized.onChainId);
        sub = this.setContextGraphSubscription(localCgId, boundSubscription);
      }
    }
    // Central defense for periodic, live-chain, and manual reconciliation.
    // Every dispatcher entry point converges here and must independently prove
    // read authority. Never let a persisted subscription authorize itself.
    let authorityDecision: ContextGraphReadAuthorityDecision | undefined;
    const authorityRead = withRpcUsageSite(
      CG_AUTH_RPC_SITES.vmReconcile,
      () => this.canReadContextGraph(localCgId, {
        allowSubscriptionFallback: false,
        onReadAuthorityDecision: (decision) => { authorityDecision = decision; },
      }),
    );
    // Cancellation releases the dispatcher worker, but an underlying store/RPC
    // read may ignore it. Keep that physical dependency in the shutdown drain.
    trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, authorityRead);
    const canRead = await raceVmReconcileAbort(authorityRead, signal).catch(() => false);
    if (!isCurrent()) throw new VmReconcileQueueClosedError();
    if (!canRead) {
      // Still a refusal for this pass. The class only records that the chain
      // never answered, so scheduling can ask again instead of treating the
      // graph as unreadable until the next sweep.
      const decision = authorityDecision;
      if (isUnansweredVmReconcileReadAuthority(decision)) {
        throw new VmReconcileReadAuthorityUnansweredError(localCgId, decision);
      }
      throw new ContextGraphNotFoundError(localCgId);
    }
    if (
      this.contextGraphBindingState.currentBindingFor(localCgId, sub) === undefined
      && sub.subscribed
    ) {
      await this.selfPrimeSubscriptionOnChainId(
        localCgId,
        sub,
        undefined,
        isCurrent,
        signal,
      );
      sub = this.subscribedContextGraphs.get(localCgId);
    }
    if (!sub) {
      throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    }
    let binding = this.contextGraphBindingState.currentBindingFor(localCgId, sub);
    if (!binding) throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    if (binding.bindingKind === 'reverse-name-hash') {
      // This is the sole boundary that converts an untrusted process-local
      // reverse candidate into a VM target. Re-enumerate before every use; a
      // duplicate, changed commitment, or RPC failure rejects the target.
      const revalidated = await this.resolveCurrentNameHashContextGraphBinding(localCgId, {
        signal,
      });
      if (!isCurrent()) throw new VmReconcileQueueClosedError();
      sub = this.subscribedContextGraphs.get(localCgId);
      const current = sub
        ? this.contextGraphBindingState.currentBindingFor(localCgId, sub)
        : undefined;
      if (
        !sub
        || current?.bindingKind !== 'reverse-name-hash'
        || revalidated?.provenance !== 'reverse-name-hash'
        || revalidated.onChainId !== current.onChainId
        || revalidated.nameHash !== current.nameHash
      ) {
        throw new ContextGraphOnChainIdUnresolvedError(localCgId);
      }
      binding = current;
    }
    let cursor = this.reconcileCursors.get(localCgId);
    if (!cursor) {
      cursor = createCursorState(
        binding.bindingKind === 'authoritative'
          ? sub.lastReconciledOrdinal ?? 0
          : 0,
      );
      this.reconcileCursors.set(localCgId, cursor);
    }
    return {
      kind: 'subscription',
      sub,
      ...binding,
      onChainCgId: BigInt(binding.onChainId),
      cursor,
      bindingGeneration: this.contextGraphBindingState.capture(localCgId),
      watermarkBefore: cursor.watermark,
    };
  }

  /** Resolve one VM binding from the adapter's finalized authority-index horizon. */
  async resolveFinalizedVmReconcileBinding(
    this: DKGAgent,
    localCgId: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<FinalizedVmReconcileBinding> {
    const indexReader = this.chain.contextGraphAuthorityIndexRevisionReader;
    if (indexReader === undefined) return { kind: 'legacy-current' };
    try {
      // Reconciliation reads the same finalized authority index as the catalog
      // refresh pass, so it shares the one governor rather than opening a
      // second ungoverned lane into the pool. A reconcile deferred by an open
      // circuit is retried by the queue's own cadence, so failing closed here
      // costs a pass, not a binding.
      return await this.rfc64AuthorityReadCoordinatorV1.run(
        signal,
        async (readSignal, evidence) => {
          const resolution = await raceVmReconcileAbort(
            this.resolveFinalizedContextGraphAuthorityTargetsV1(
              [localCgId],
              evidence.agentResolverReadOptions(readSignal),
            ),
            signal,
          );
          if (!isCurrent()) throw new VmReconcileQueueClosedError();
          if (resolution.kind === 'legacy-current') return resolution;
          const target = resolution.targets.get(localCgId);
          if (target === undefined) return { kind: 'absent' as const };
          let snapshot: ContextGraphAuthoritySnapshot;
          if (target.kind === 'resolved-snapshot') {
            snapshot = target.finalizedSnapshot;
          } else {
            if (this.contextGraphAuthorityReaderCapability.status !== 'supported') {
              throw new Error('Finalized VM authority target has no snapshot reader');
            }
            snapshot = await raceVmReconcileAbort(
              this.contextGraphAuthorityReaderCapability.reader
                .getContextGraphAuthoritySnapshot(
                  target.expectedOnChainId,
                  evidence.chainReadOptions(readSignal),
                ),
              signal,
            );
          }
          if (!isCurrent()) throw new VmReconcileQueueClosedError();
          const expectedNameHash = this.contextGraphWireId(target.expectedNameHash);
          const expectedOnChainId = target.expectedOnChainId.toString(10);
          if (
            target.expectedOnChainId <= 0n
            || target.expectedOnChainId > ethers.MaxUint256
            || finalizedContextGraphSnapshotMismatchV1(snapshot, {
              onChainId: target.expectedOnChainId,
              nameHash: expectedNameHash,
            }) !== undefined
          ) {
            throw new Error(`Invalid finalized VM authority evidence for "${localCgId}"`);
          }
          return {
            kind: 'resolved' as const,
            nameHash: expectedNameHash,
            onChainId: expectedOnChainId,
            onChainCgId: target.expectedOnChainId,
          };
        },
      );
    } catch (err) {
      if (err instanceof VmReconcileQueueClosedError || signal?.aborted || !isCurrent()) {
        throw new VmReconcileQueueClosedError();
      }
      throw err;
    } finally {
      await indexReader.whenIdle();
    }
  }

  async resolveSelectedVmReconcileTarget(
    this: DKGAgent,
    localCgId: string,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<VmReconcileSelectedTarget> {
    const nameHash = this.contextGraphNameCommitment(localCgId);
    let resolved: bigint | null = null;
    const finalized = await this.resolveFinalizedVmReconcileBinding(
      localCgId,
      isCurrent,
      signal,
    );
    if (finalized.kind === 'absent') {
      throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    }
    if (finalized.kind === 'resolved') {
      resolved = finalized.onChainCgId;
    } else {
      const resolveByNameHash = this.chain.resolveContextGraphIdByNameHash;
      if (typeof resolveByNameHash !== 'function') {
        throw new ContextGraphOnChainIdUnresolvedError(localCgId);
      }
      try {
        resolved = await raceVmReconcileAbort(
          resolveByNameHash.call(this.chain, nameHash, { signal }),
          signal,
        );
      } catch (err) {
        if (
          err instanceof VmReconcileQueueClosedError
          || signal?.aborted
          || !isCurrent()
        ) throw new VmReconcileQueueClosedError();
        // A resolver rejection can carry chain-integrity evidence (for example,
        // two current numeric slots claiming the same name hash) or an RPC
        // consistency failure. Preserve it for callers and operators; only a
        // genuine `null` result below means that no current binding exists.
        throw err;
      }
    }
    if (!isCurrent() || !this.isRfc64SelectedVmReconcileTargetAllowed(localCgId)) {
      throw new VmReconcileQueueClosedError();
    }
    if (resolved === null || resolved <= 0n) {
      throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    }
    const deploymentId = requireVmReconcileDeploymentId(this.chain.deploymentId);
    const onChainId = resolved.toString();
    let selectedState = this.selectedVmReconcileCursors.get(localCgId);
    if (
      selectedState?.record.deploymentId !== deploymentId
      || selectedState.record.onChainContextGraphId !== onChainId
      || selectedState.record.nameHash !== nameHash
    ) {
      let watermark = 0;
      try {
        const persisted = await this.config.selectedVmReconcileCursorStore
          ?.loadSelectedVmReconcileCursor?.(deploymentId, localCgId, onChainId);
        if (
          persisted?.deploymentId === deploymentId
          && persisted.contextGraphId === localCgId
          && persisted.onChainContextGraphId === onChainId
          && persisted.nameHash === nameHash
          && Number.isSafeInteger(persisted.watermark)
          && persisted.watermark >= 0
        ) watermark = persisted.watermark;
      } catch {
        // Durable progress is an optimization, not binding authority. A broken
        // row safely falls back to a complete chain-inventory scan from zero.
      }
      if (!isCurrent() || !this.isRfc64SelectedVmReconcileTargetAllowed(localCgId)) {
        throw new VmReconcileQueueClosedError();
      }
      selectedState = {
        record: {
          deploymentId,
          contextGraphId: localCgId,
          onChainContextGraphId: onChainId,
          nameHash,
          watermark,
        },
        cursor: createCursorState(watermark),
        bindingGeneration: ++this.selectedVmReconcileBindingGeneration,
      };
      this.selectedVmReconcileCursors.set(localCgId, selectedState);
    }
    return {
      kind: 'rfc64-selected',
      deploymentId,
      onChainId,
      onChainCgId: resolved,
      nameHash,
      cursor: selectedState.cursor,
      bindingGeneration: selectedState.bindingGeneration,
      selectedState,
      watermarkBefore: selectedState.cursor.watermark,
    };
  }

  isVmReconcileTargetCurrent(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileTarget,
    lifecycleGeneration: number,
    expectedCursor: CursorState = target.cursor,
  ): boolean {
    if (
      this.vmReconcileRotationClosed
      || this.vmReconcileLifecycleGeneration !== lifecycleGeneration
    ) return false;
    if (target.kind === 'rfc64-selected') {
      const current = this.selectedVmReconcileCursors.get(localCgId);
      return this.isRfc64SelectedVmReconcileTargetAllowed(localCgId)
        && vmReconcileDeploymentMatches(this.chain.deploymentId, target.deploymentId)
        && current === target.selectedState
        && current.cursor === expectedCursor
        && current.bindingGeneration === target.bindingGeneration
        && current.record.deploymentId === target.deploymentId
        && current.record.onChainContextGraphId === target.onChainId
        && current.record.nameHash === target.nameHash;
    }
    const current = this.subscribedContextGraphs.get(localCgId);
    return current === target.sub
      && this.contextGraphBindingState.targetStillCurrent(localCgId, current, target)
      && this.reconcileCursors.get(localCgId) === expectedCursor;
  }

  async revalidateVmReconcileTarget(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileTarget,
    lifecycleGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration)) {
      return false;
    }
    if (target.kind === 'subscription') {
      if (target.bindingKind === 'authoritative') return true;
      try {
        const finalized = await this.resolveFinalizedVmReconcileBinding(
          localCgId,
          () => this.isVmReconcileTargetCurrent(
            localCgId,
            target,
            lifecycleGeneration,
          ),
          signal,
        );
        if (finalized.kind !== 'legacy-current') {
          return finalized.kind === 'resolved'
            && finalized.onChainId === target.onChainId
            && finalized.nameHash === target.nameHash
            && this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration);
        }
        const resolved = await this.resolveCurrentNameHashContextGraphBinding(localCgId, {
          signal,
        });
        return resolved?.provenance === 'reverse-name-hash'
          && resolved.onChainId === target.onChainId
          && resolved.nameHash === target.nameHash
          && this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration);
      } catch {
        return false;
      }
    }
    try {
      const finalized = await this.resolveFinalizedVmReconcileBinding(
        localCgId,
        () => this.isVmReconcileTargetCurrent(
          localCgId,
          target,
          lifecycleGeneration,
        ),
        signal,
      );
      if (finalized.kind !== 'legacy-current') {
        return finalized.kind === 'resolved'
          && finalized.onChainId === target.onChainId
          && finalized.nameHash === target.nameHash
          && this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration);
      }
      const resolveByNameHash = this.chain.resolveContextGraphIdByNameHash;
      if (typeof resolveByNameHash !== 'function') return false;
      const resolved = await raceVmReconcileAbort(
        resolveByNameHash.call(this.chain, target.nameHash, { signal }),
        signal,
      );
      return resolved?.toString() === target.onChainId
        && this.isVmReconcileTargetCurrent(localCgId, target, lifecycleGeneration);
    } catch {
      return false;
    }
  }

  createVmReconcileDeps(
    this: DKGAgent,
    localCgId: string,
    lifecycleGeneration: number,
    target: VmReconcileTarget,
    signal?: AbortSignal,
    execution?: VmReconcileExecution,
  ): ChainReconcilerDeps {
    const capturedCursor = execution?.identityCursor ?? target.cursor;
    const refusedReads = execution?.refusedReads;
    const isTargetCurrent = (): boolean => this.isVmReconcileTargetCurrent(
      localCgId,
      target,
      lifecycleGeneration,
      capturedCursor,
    );
    const revalidateTarget = () => this.revalidateVmReconcileTarget(
      localCgId,
      target,
      lifecycleGeneration,
      signal,
    );
    return {
      getKCCount: async (cg) => {
        const head = Number(await this.chain.getContextGraphKCCount!(cg));
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
        if (!Number.isSafeInteger(head) || head < 0) {
          throw new Error(`Invalid on-chain KC count for context graph "${localCgId}": ${head}`);
        }
        return head;
      },
      getHeadBlock: async () => {
        // Capability-absent chains disable the reorg gate; transient RPC
        // failures still throw so the durable watermark cannot advance.
        if (typeof this.chain.getBlockNumber !== 'function') return undefined;
        let headBlock: number;
        try {
          headBlock = await this.chain.getBlockNumber();
        } catch (err) {
          // The engine holds the watermark and ends the slice; its pass is told why.
          refusedReads?.headBlockFailed(err);
          throw err;
        }
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
        return headBlock;
      },
      reconcileOrdinal: (lcg, ocg, ordinal, headBlock, context) =>
        this.reconcileChainOrdinal(lcg, ocg, ordinal, headBlock, {
          isTargetCurrent,
          revalidateTarget,
          rememberFinalizedEvidence: context === undefined
            || context.headOrdinal - ordinal <= DKGAgentBase.VM_RECONCILE_BATCH_SIZE,
          ...(refusedReads
            ? { onUnresolvable: (err: unknown) => refusedReads.ordinalFailed(err) }
            : {}),
        }),
      recoverPendingOrdinals: (lcg, ocg, targets, headBlock) =>
        this.recoverVmReconcileBatch(
          lcg,
          ocg,
          targets,
          headBlock,
          isTargetCurrent,
          signal,
          revalidateTarget,
        ),
      maxOrdinalsPerPass: DKGAgentBase.VM_RECONCILE_BATCH_SIZE,
      maxOrdinalConcurrency: DKGAgentBase.VM_RECONCILE_ORDINAL_CONCURRENCY,
      // Selected-only Edges are often cold and explicitly ask for a useful
      // current view. Reserve 75% of each bounded slice for the newest missing
      // chain ordinals while the remaining 25% advances history. Member/Core
      // targets retain strict oldest-first order.
      // Both RFC-64 configuration-only targets and ordinary Edge
      // subscriptions represent explicit user intent.  A durable Edge
      // subscription must not silently fall back to the historical-first
      // Core lane merely because it has a ContextGraphSub row (the public
      // subscribe API creates exactly that row).  Keep Core reconciliation
      // historical-first: Core nodes own whole-corpus completeness, while an
      // Edge user first needs a useful current view without starving history.
      recentOrdinalsPerPass: (
        target.kind === 'rfc64-selected'
        || (
          (this.config.nodeRole ?? 'edge') === 'edge'
          && target.kind === 'subscription'
          && target.sub.subscribed
        )
      )
        ? Math.max(1, Math.floor(DKGAgentBase.VM_RECONCILE_BATCH_SIZE * 0.75))
        : 0,
      isTargetCurrent: () => isTargetCurrent(),
      persistWatermark: (lcg, watermark) => {
        if (!isTargetCurrent()) return;
        if (execution) execution.persistWatermark(lcg, watermark);
        else void this.persistVmReconcileWatermark(
          lcg,
          watermark,
          target,
        );
      },
      confirmationDepth: DKGAgentBase.VM_RECONCILE_CONFIRMATION_DEPTH,
      log: (msg) => this.log.info(createOperationContext('system'), msg),
      ...(execution?.observePassTimings ? { observePassTimings: execution.observePassTimings } : {}),
    };
  }

  async persistVmReconcileWatermark(
    this: DKGAgent,
    localCgId: string,
    watermark: number,
    target: VmReconcileTarget,
  ): Promise<void> {
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const isTargetCurrent = () => this.isVmReconcileTargetCurrent(
      localCgId,
      target,
      lifecycleGeneration,
    );
    if (!isTargetCurrent()) return;
    const previous = target.cursor.watermark;
    if (target.kind === 'rfc64-selected') {
      const nextRecord: SelectedVmReconcileCursorRecord = {
        deploymentId: target.deploymentId,
        contextGraphId: localCgId,
        onChainContextGraphId: target.onChainId,
        nameHash: target.nameHash,
        watermark,
      };
      await this.config.selectedVmReconcileCursorStore
        ?.saveSelectedVmReconcileCursor?.(nextRecord);
      if (!isTargetCurrent()) return;
      target.selectedState.record = nextRecord;
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'cursor-advance',
        fromWatermark: previous,
        toWatermark: watermark,
      });
      return;
    }
    const sub = this.subscribedContextGraphs.get(localCgId);
    if (!sub || sub !== target.sub) return;
    if (target.bindingKind === 'reverse-name-hash') {
      // Reverse-derived progress is valid only for this process-local,
      // revalidated target. The live cursor advances after this returns; never
      // copy its watermark into the shared/durable subscription object.
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'cursor-advance',
        fromWatermark: previous,
        toWatermark: watermark,
      });
      return;
    }
    // Authoritative progress follows the subscription's own lifetime. A durable
    // row (always-on member intent, or a Core's host-only obligation) is saved
    // before the live cursor moves. An on-demand subscription writes nothing:
    // like the subscription itself, its progress lives only in this process.
    await this.persistContextGraphSyncStateStrict(
      localCgId,
      { ...sub, lastReconciledOrdinal: watermark },
      'VM reconcile cursor',
      isTargetCurrent,
    );
    if (!isTargetCurrent()) return;
    sub.lastReconciledOrdinal = watermark;
    this.emitReplication({
      contextGraphId: localCgId,
      onChainCgId: target.onChainId,
      action: 'cursor-advance',
      fromWatermark: previous,
      toWatermark: watermark,
    });
  }

  toContextGraphReconcileResult(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource,
    target: VmReconcileTarget,
    result: VmReconcileEngineResult,
  ): ContextGraphReconcileResult {
    const status: ContextGraphReconcileResult['status'] = target.watermarkBefore > result.head
      ? 'watermark-ahead'
      : result.watermark >= result.head
        ? 'current'
        : result.reconciled > 0
          ? 'progress'
          : 'pending';
    return {
      contextGraphId: localCgId,
      onChainId: target.onChainId,
      source,
      status,
      attempted: target.watermarkBefore < result.head,
      headOrdinal: result.head,
      watermarkBefore: target.watermarkBefore,
      watermarkAfter: result.watermark,
      reconciledOrdinals: result.reconciled,
      unresolvedOrdinals: result.pending,
    };
  }

  emitVmReconcileTelemetry(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileTarget,
    result: VmReconcileEngineResult,
    status: ContextGraphReconcileResult['status'],
  ): void {
    if (status === 'watermark-ahead') {
      this.log.warn(
        createOperationContext('system'),
        `VM reconcile evidence mismatch for "${localCgId}": watermark=${target.watermarkBefore} head=${result.head}`,
      );
    }
    if (result.reconciled > 0 || result.pending > 0) {
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'sweep',
        head: result.head,
        toWatermark: result.watermark,
        reconciled: result.reconciled,
        pending: result.pending,
      });
    }
    if (
      result.reconciled > 0
      && target.kind === 'subscription'
      && target.sub.coreHosted
      && !target.sub.subscribed
    ) {
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'core-fill',
        head: result.head,
        toWatermark: result.watermark,
        reconciled: result.reconciled,
      });
    }
  }

  /**
   * RELOCATE stranded legacy-label KCs into the SCOPED per-onChainId graphs
   * the Random Sampling prover reads.
   *
   * The bug: when a KC is finalized BEFORE its on-chain cgId is locally
   * resolvable, finalization falls back to writing it into the LEGACY label
   * graphs (`<cg>/_meta` + `<cg>` root data) instead of the scoped
   * `<cg>/context/<onChainId>/_meta` + `.../context/<onChainId>` graphs. The
   * RS prover (`extractV10KCFromStore`) only reads the scoped graphs, so such
   * a KC reports `kc-not-synced` forever even though the node holds it.
   *
   * This COPIES (never moves/deletes) the legacy KC into the scoped graphs so
   * the prover can find it, while leaving the label-graph view intact.
   *
   * CONTENT-BINDING RULE: the data/meta copies go through
   * `this.store.update(INSERT…WHERE)` so the terms NEVER leave the store. A
   * `query()`/CONSTRUCT → `insert(quads)` round-trip would double backslashes
   * in escape-bearing literals and change the leaf bytes the on-chain
   * `challengeRoot` was committed over, making the proof permanently
   * unprovable. The projection (root + `.well-known/genid/` descendants,
   * minus post-publish trustLevel stamps) mirrors `ka-extractor.ts` exactly.
   *
   * Idempotent + version-guarded so a re-run is a no-op and a later stale
   * writer cannot clobber. NEVER calls `isAlreadyConfirmed` — that read-both
   * guard is the permanence mechanism that made the legacy promotion stick.
   */
  async healStrandedScopedKCs(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileSubscriptionTarget,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<RsHealPassResult> {
    try {
      const capturedOnChainId = target.onChainId;
      const canApply = () => isCurrent()
        && (!(this.subscribedContextGraphs instanceof Map)
          || this.subscribedContextGraphs.get(localCgId) === target.sub)
        && this.contextGraphBindingState.targetStillCurrent(
          localCgId,
          target.sub,
          target,
        );
      if (!canApply()) {
        return { status: 'skipped', reason: 'not-current' };
      }
      // Server-side byte-safe copy is the ONLY safe relocation mechanism; if the
      // backend can't do SPARQL UPDATE we bail rather than risk a lossy JS round-trip.
      if (typeof this.store.update !== 'function') {
        return { status: 'skipped', reason: 'unsupported-store' };
      }
      // #1549: every server-side INSERT in this RS-heal path has a statically-known
      // target graph, so `touchedGraphs` is REQUIRED — the index then maintains
      // itself incrementally (a bounded `hasGraph`) instead of marking the whole
      // index dirty and forcing a full store scan on the next enumeration. Requiring
      // it (not optional) closes the escape hatch: a future `update(sparql)` here that
      // forgot to declare its graph would silently fall back to dirtying the index.
      const update = async (sparql: string, touchedGraphs: readonly string[]): Promise<void> => {
        const updated = await tryUpdateWithTouchedGraphs(
          this.store,
          sparql,
          touchedGraphs,
          rsHealStoreOptions('materialize', signal),
        );
        if (!updated) throw new Error('RS heal requires server-side update() support');
      };

      const DKG = 'http://dkg.io/ontology/';
      const legacyMeta = contextGraphMetaUri(localCgId);
      const scopedMeta = contextGraphMetaUri(localCgId, capturedOnChainId);
      const rootData = contextGraphDataUri(localCgId);
      const scopedData = contextGraphDataUri(localCgId, capturedOnChainId);
      // The publisher's OWN one-shot publish() writes confirmed PUBLIC data to a
      // per-KA verifiable-memory (VM) graph — NOT the legacy root data graph (the
      // receiver/#1259 strand fills root data). So the data reads below look in
      // BOTH: legacy root data UNION the stranded KC's EXACT VM graph (derived
      // per-KC from its batchId inside the loop). Reading VM-only would regress
      // the receiver heal; prefix-scanning every VM graph could pull a DIFFERENT
      // KA's triples for a root IRI that recurs across per-KA VM graphs.

      // 2a ASK-guard: is there at least one incomplete scoped KC? Requiring the
      // batch id and materialization version together makes a legacy partial
      // write retryable instead of permanently hiding it from future sweeps.
      const askGuard = await this.store.query(
        `ASK {
           GRAPH <${legacyMeta}> { ?ual <${DKG}batchId> ?b }
           FILTER NOT EXISTS {
             GRAPH <${scopedMeta}> {
               ?ual <${DKG}batchId> ?b ; <${DKG}materializedVersion> ?version
             }
           }
         }`,
        rsHealStoreOptions('guard', signal),
      );
      if (!canApply()) return { status: 'skipped', reason: 'not-current' };
      if (askGuard.type !== 'boolean') return { status: 'skipped', reason: 'invalid-result' };
      if (!askGuard.value) return { status: 'skipped', reason: 'no-work' };

      // 2b: enumerate one bounded page. A per-CG lexical cursor means a
      // permanently incomplete KC cannot pin the first page forever; after the
      // final page the cursor wraps and the next sweep retries earlier gaps.
      const cursorKey = `${localCgId}\u0000${capturedOnChainId}`;
      const cursorMap = this.rsHealCursorByCg ?? new Map<string, string>();
      const cursor = cursorMap.get(cursorKey);
      const stranded = await readRsHealStrandedPage(
        this.store,
        legacyMeta,
        scopedMeta,
        DKG,
        cursor,
        DKGAgentBase.RS_HEAL_BATCH_SIZE,
        signal,
      );
      if (!canApply()) return { status: 'skipped', reason: 'not-current' };
      if (!stranded) return { status: 'skipped', reason: 'invalid-result' };
      if (stranded.bindings.length === 0) {
        advanceRsHealCursor(
          cursorMap,
          cursorKey,
          stranded.bindings,
          DKGAgentBase.RS_HEAL_BATCH_SIZE,
          DKGAgentBase.RS_HEAL_CG_STATE_MAX_ENTRIES,
        );
        return { status: 'skipped', reason: 'no-work' };
      }

      for (const row of stranded.bindings) {
        if (!canApply()) return { status: 'skipped', reason: 'not-current' };
        // Bindings come back stripped to bare values by the store adapters
        // (oxigraph/sparql-http both emit IRIs unwrapped); strip + validate
        // exactly as the extractor does for its `ual`.
        const ual = stripBindingQuotes(row['ual'] ?? '');
        if (!ual || !isSafeIri(ual)) continue;
        // Derive the stranded KC's EXACT per-KA VM graph from its batchId. The
        // chain adapter sets batchId === kaId for the createKnowledgeAssets
        // publish path (evm-adapter-publish.ts / evm-adapter-base.ts), so ?b is
        // the minted kaId; author/number unpack from it exactly as publish() does.
        // Binding the exact graph (vs scanning `_verifiable_memory/*`) prevents
        // copying another KA's triples for a root IRI that recurs across per-KA
        // VM graphs (e.g. an updated entity republished under a new kaId).
        const bMatch = /^"?(\d+)/.exec(String(row['b'] ?? ''));
        if (!bMatch) continue;
        const kaId = BigInt(bMatch[1]);
        const vmGraph = contextGraphLayerUri(
          localCgId,
          MemoryLayer.VerifiableMemory,
          '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
          kaId & ((1n << 96n) - 1n),
        );
        try {
          await withMaterializationLock(scopedMeta, ual, async () => {
            if (!canApply()) return;
            // A KC may carry no `dkg:materializedVersion` stamp in legacy meta:
            // the publisher's OWN one-shot publish writes the KC into the legacy
            // label `_meta` but never stamps a version (only the
            // receiver/finalization path calls writeMaterializedVersion). Such a
            // KC strands in legacy forever — chain-reconcile skips it
            // (`isAlreadyConfirmed` sees the legacy `status=confirmed`) and the
            // heal used to bail here on the null version. Relocate it anyway,
            // stamping the LOWEST version {0,0}: the GH#842 ordering guard then
            // lets any real update (block>0) win over this floor and never the
            // reverse, so it can never clobber a genuine update.
            const version = (await readMaterializedVersion(
              this.store,
              legacyMeta,
              ual,
              rsHealStoreOptions('version.readLegacy', signal),
            ))
              ?? { blockNumber: 0, txIndex: 0 };
            if (!canApply()) return;
            if (!(await shouldApplyMaterialization(
              this.store,
              scopedMeta,
              ual,
              version,
              undefined,
              rsHealStoreOptions('version.checkScoped', signal),
            ))) return; // idempotent
            if (!canApply()) return;

            assertSafeIri(ual);

            // Resolve roots from legacy meta with the extractor's read-both UNION.
            const rootsRes = await this.store.query(
              `SELECT ?root WHERE {
                 GRAPH <${legacyMeta}> {
                   { ?ka <${DKG}partOf> <${ual}> ; <${DKG}rootEntity> ?root . }
                   UNION
                   { <${ual}> <${DKG}rootEntity> ?root . }
                 }
               }`,
              rsHealStoreOptions('roots', signal),
            );
            if (!canApply() || rootsRes.type !== 'bindings') return;
            const roots: string[] = [];
            const seen = new Set<string>();
            for (const r of rootsRes.bindings) {
              const root = stripBindingQuotes(r['root'] ?? '');
              if (root && !seen.has(root) && isSafeIri(root)) {
                seen.add(root);
                roots.push(root);
              }
            }
            if (roots.length === 0) return;

            // CRASH-PARTIAL GUARD (all-or-nothing across roots): the extractor
            // roots a concatenation over EVERY root, so if ANY root's legacy
            // data is missing locally this is a Factor-B sync gap, not a
            // relocation. Write NOTHING — must NOT trade kc-not-synced for
            // KCDataMissingError. ASK each root first.
            for (const root of roots) {
              const present = await this.store.query(
                `ASK {
                   {
                     GRAPH <${rootData}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                     }
                   } UNION {
                     GRAPH <${vmGraph}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                     }
                   }
                 }`,
                rsHealStoreOptions('rootPresent', signal),
              );
              if (!canApply() || present.type !== 'boolean' || !present.value) return;
            }

            // DATA copy (per root) — MANDATORY server-side, byte-safe, read-both
            // (legacy root data UNION per-KA VM graph). Skip the post-publish
            // trustLevel stamps in BOTH branches so the recomputed leaf set stays
            // bit-identical with the on-chain merkleLeafCount.
            for (const root of roots) {
              if (!canApply()) return;
              await update(
                `INSERT { GRAPH <${scopedData}> { ?s ?p ?o } } WHERE {
                   {
                     GRAPH <${rootData}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                       FILTER(?p != <${TRUST_LEVEL_PREDICATE}> && ?p != <${LEGACY_TRUST_LEVEL_PREDICATE}>)
                     }
                   } UNION {
                     GRAPH <${vmGraph}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                       FILTER(?p != <${TRUST_LEVEL_PREDICATE}> && ?p != <${LEGACY_TRUST_LEVEL_PREDICATE}>)
                     }
                   }
                 }`,
                [scopedData],
              );
              if (!canApply()) return;
            }

            // `update()` is not an atomic transaction on every supported HTTP
            // store. Remove the completion marker first, copy metadata without
            // that marker, and stamp completion only after the copy succeeds.
            // Any partial copy therefore remains visible to the next heal.
            if (!canApply()) return;
            await update(
              `DELETE WHERE {
                 GRAPH <${scopedMeta}> {
                   <${ual}> <${DKG}materializedVersion> ?oldVersion
                 }
               }`,
              [scopedMeta],
            );
            if (!canApply()) return;
            await update(
              `INSERT {
                 GRAPH <${scopedMeta}> { ?s ?p ?o }
               }
               WHERE {
                 GRAPH <${legacyMeta}> {
                   ?s ?p ?o .
                   FILTER(?s = <${ual}> || STRSTARTS(STR(?s), "${ual}/"))
                   FILTER(?p != <${DKG}materializedVersion>)
                 }
               }`,
              [scopedMeta],
            );
            if (!canApply()) return;
            await update(
              `INSERT DATA {
                 GRAPH <${scopedMeta}> {
                   <${ual}> <${DKG}materializedVersion> "${version.blockNumber}:${version.txIndex}"
                 }
               }`,
              [scopedMeta],
            );

            if (canApply()) {
              this.log.info(
                createOperationContext('system'),
                `RS heal: relocated stranded legacy KC ${ual} -> scoped cg=${capturedOnChainId} (${roots.length} root(s))`,
              );
            }
          }, { signal });
        } catch (err) {
          if (isStoreSchedulerBusyError(err)) throw err;
          if (signal?.aborted || !canApply()) {
            return { status: 'skipped', reason: 'not-current' };
          }
          this.log.warn(
            createOperationContext('system'),
            `RS heal: relocate failed for ${ual} (cg=${capturedOnChainId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      advanceRsHealCursor(
        cursorMap,
        cursorKey,
        stranded.bindings,
        DKGAgentBase.RS_HEAL_BATCH_SIZE,
        DKGAgentBase.RS_HEAL_CG_STATE_MAX_ENTRIES,
      );
      return { status: 'completed', inspected: stranded.bindings.length };
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `RS heal sweep for "${localCgId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // A scheduler rejection means this maintenance sweep has lost admission.
      // Stop immediately; the periodic reconciler will retry on its next tick
      // instead of flooding the remaining backlog into the queue.
      if (isStoreSchedulerBusyError(err)) {
        return { status: 'deferred', reason: 'store-busy' };
      }
      return { status: 'skipped', reason: 'failed' };
    }
  }

  initializeVmReconcilePublicCoreTransportPreferencePolicy(this: DKGAgent): void {
    this.vmReconcilePublicCoreTransportPreferencePolicy ??= new VmRecoveryCoreTransportPreferencePolicy({
      now: () => this.vmReconcileRotationNow(),
      connectionKey: peerId => this.getSyncReconcilerConnectionKey(peerId),
      supportsCore: peerId => this.peerCapabilityRegistry.supportsCore(peerId),
      holderReuseEnabled: resolveExactBatchStreamEnabled,
      captureScope: (localCgId, candidatePeerIds) => typeof this.chain.deploymentId === 'string' ? {
        deploymentId: this.chain.deploymentId,
        lifecycleGeneration: this.vmReconcileLifecycleGeneration,
        bindingGeneration: this.contextGraphBindingState.capture(localCgId),
        selectedBindingGeneration: this.selectedVmReconcileCursors.get(localCgId)?.bindingGeneration,
        candidatePeerIds: [...candidatePeerIds],
      } : undefined,
      scopeIsCurrent: (localCgId, scope) => this.chain.deploymentId === scope.deploymentId
        && this.vmReconcileLifecycleGeneration === scope.lifecycleGeneration
        && !this.vmReconcileRotationClosed
        && this.contextGraphBindingState.capture(localCgId) === scope.bindingGeneration
        && this.selectedVmReconcileCursors.get(localCgId)?.bindingGeneration === scope.selectedBindingGeneration
        && this.vmReconcilePeerMembershipMatches(
          new Set(scope.candidatePeerIds),
          this.vmReconcileObservedCandidatePeerIds(localCgId),
        ),
    }, {
      ttlMs: DKGAgentBase.VM_RECONCILE_PUBLIC_CORE_TRANSPORT_TTL_MS,
      maxEntries: DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES,
    });
  }

  vmReconcileRotationNow(this: DKGAgent): number {
    return performance.now();
  }

  vmReconcileRotationSlotKey(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
  ): string {
    return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
  }

  clearVmReconcileRotationStateForSlot(
    this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
  ): void {
    this.vmReconcileRotationState.delete(`${localCgId}\0${onChainCgId.toString()}\0${ordinal}`);
  }

  vmReconcileRotationFingerprint(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
  ): string {
    return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
  }

  vmReconcileObservedCandidatePeerIds(
    this: DKGAgent,
    localCgId: string,
  ): string[] {
    const curatorOrder = this.vmReconcileCuratorPeersByCg.get(localCgId) ?? [];
    const libp2p = (this.node as any)?.libp2p;
    const getConnections = libp2p?.getConnections;
    if (typeof getConnections !== 'function') {
      return curatorOrder.slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    }
    const peersById = new Map<string, { toString(): string }>();
    for (const connection of getConnections.call(libp2p) as Array<{
      remotePeer?: { toString(): string };
    }>) {
      const peer = connection.remotePeer;
      const peerId = peer?.toString();
      if (!peer || !peerId || peerId === this.peerId || peersById.has(peerId)) continue;
      peersById.set(peerId, peer);
    }
    // `getConnections()` iteration order is transport state, not candidate
    // identity. Sort before tiering/capping so harmless connection reorder can
    // never replace one member of the bounded proof roster.
    const canonicalPeers = [...peersById.values()].sort((left, right) =>
      left.toString().localeCompare(right.toString()));
    const ordinaryOrder = this.selectCatchupPeers(
      canonicalPeers,
      this.preferredSyncPeers.get(localCgId),
      false,
    )
      .map((peer) => peer.toString());
    // Structural curators are authoritative and may contain the only holder.
    // Ordinary connected peers are opportunistic fallback, but they must all
    // remain visible inside the bounded proof roster. Capping this tier at the
    // per-pass transport limit made the same three high-ranked peers the entire
    // roster forever, so a fourth connected replica could never be reached.
    // `VmRecoveryProviderPolicy` still caps each physical pass below; retaining
    // the larger bounded roster only lets subsequent passes continue rotation.
    const boundedCurators = [...new Set(curatorOrder)]
      .slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    const curatorSet = new Set(boundedCurators);
    const ordinaryBudget = Math.max(
      0,
      DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX - boundedCurators.length,
    );
    const boundedOrdinary = ordinaryOrder
      .filter((peerId) => !curatorSet.has(peerId))
      .slice(0, ordinaryBudget);
    return [...boundedCurators, ...boundedOrdinary];
  }

  vmReconcilePeerMembershipMatches(
    this: DKGAgent,
    left: ReadonlySet<string>,
    right: readonly string[],
  ): boolean {
    return left.size === right.length && right.every((peerId) => left.has(peerId));
  }

  touchVmReconcileRotationRecord(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
  ): void {
    if (this.vmReconcileRotationState.get(slotKey) !== record) return;
    this.vmReconcileRotationState.delete(slotKey);
    this.vmReconcileRotationState.set(slotKey, record);
  }

  prepareVmReconcileRotationTarget(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    candidatePeerIds: readonly string[],
    now: number,
    curatorRosterConfirmed = true,
  ): {
    slotKey: string;
    record?: VmReconcileRotationRecord;
    suppressed: boolean;
  } {
    const slotKey = this.vmReconcileRotationSlotKey(target);
    if (this.vmReconcileRotationClosed) return { slotKey, suppressed: true };

    const fingerprint = this.vmReconcileRotationFingerprint(target);
    let record = this.vmReconcileRotationState.get(slotKey);
    if (record && record.fingerprint !== fingerprint) {
      this.vmReconcileRotationState.delete(slotKey);
      record = undefined;
    }
    if (
      record?.phase === 'backoff'
      && record.backoffKind === 'clean-absence'
      && (!record.curatorRosterConfirmed || !curatorRosterConfirmed)
    ) {
      // Absence gathered while curator discovery was unavailable must not
      // suppress the next lookup: that lookup may reveal the only holder.
      this.vmReconcileRotationState.delete(slotKey);
      record = undefined;
    }
    if (candidatePeerIds.length === 0) {
      // A transient empty socket view cannot invalidate a completed proof: doing
      // so would redial and refetch every sweep after ordinary disconnects.
      // Partial evidence is different and remains fail-open; drop it so the next
      // non-empty roster starts a genuinely fresh cycle.
      if (record?.phase === 'backoff' && now < record.nextRetryAt) {
        this.touchVmReconcileRotationRecord(slotKey, record);
        return { slotKey, record, suppressed: true };
      }
      this.vmReconcileRotationState.delete(slotKey);
      return { slotKey, suppressed: false };
    }

    if (!record) {
      const nextRecord: VmReconcileRotationRecord = {
        localCgId: target.localCgId,
        onChainCgId: target.onChainCgId,
        ordinal: target.ordinal,
        fingerprint,
        phase: 'collecting',
        candidatePeerIds: new Set(candidatePeerIds),
        attemptedPeerIds: new Set(),
        cleanAbsentPeerIds: new Set(),
        curatorRosterConfirmed,
        collectionDeadlineAt: now + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
        failures: 0,
        nextRetryAt: 0,
      };
      if (!this.installVmReconcileRotationRecord(slotKey, nextRecord)) {
        // Preserve the pressure bound at cap: an unowned target cannot retain
        // exponential retry state, so running elevated exact transport here
        // would replay it every sweep. Defer until an expired/resolved slot is
        // available; this is process-local scheduling, never absence evidence.
        return { slotKey, suppressed: true };
      }
      return {
        slotKey,
        record: nextRecord,
        suppressed: false,
      };
    }

    const membershipUnchanged = this.vmReconcilePeerMembershipMatches(
      record.candidatePeerIds,
      candidatePeerIds,
    );
    const rosterProofUpgraded = !record.curatorRosterConfirmed && curatorRosterConfirmed;
    if (!membershipUnchanged) {
      const priorCycleWasIncomplete = record.backoffKind === 'incomplete-cycle'
        || [...record.attemptedPeerIds]
          .some((peerId) => !record.cleanAbsentPeerIds.has(peerId));
      const previousCandidatePeerIds = record.candidatePeerIds;
      const nextCandidatePeerIds = new Set(candidatePeerIds);
      record.candidatePeerIds = new Set(candidatePeerIds);
      record.curatorRosterConfirmed = curatorRosterConfirmed;
      const removedPeer = [...previousCandidatePeerIds]
        .some((peerId) => !nextCandidatePeerIds.has(peerId));
      if (removedPeer) {
        // A proof roster is a set, not an accumulation of surviving credits.
        // Any removal/replacement invalidates the whole cycle so shrink can
        // never manufacture exhaustion or preserve an active suppression.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        record.attemptedPeerIds.clear();
        record.cleanAbsentPeerIds.clear();
        record.lastAttemptedPeerId = undefined;
        record.collectionDeadlineAt = now
          + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      } else if (!rosterProofUpgraded) {
        // Pure growth preserves valid credits for retained identities, but the
        // newly observed peer is uncredited and immediately breaks backoff.
        // Do not let a publication-window incomplete response compound into
        // multi-minute suppression merely because startup discovers the same
        // recovery roster one peer at a time. Clean-absence history still
        // keeps its exponential damping; only transport/timing uncertainty
        // starts a fresh base-delay epoch when the evidence universe grows.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        if (priorCycleWasIncomplete) record.failures = 0;
        record.collectionDeadlineAt = now
          + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      }
    } else {
      record.curatorRosterConfirmed = curatorRosterConfirmed;
    }
    if (rosterProofUpgraded) {
      // A peer response gathered while curator discovery was unconfirmed is
      // useful transport evidence, not authoritative absence proof. Reprobe
      // the complete now-authoritative roster even when that roster also grew.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.nextRetryAt = 0;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.lastAttemptedPeerId = undefined;
      record.collectionDeadlineAt = now
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
    }
    if (record.phase === 'backoff') {
      if (now < record.nextRetryAt) {
        this.touchVmReconcileRotationRecord(slotKey, record);
        return { slotKey, record, suppressed: true };
      }
      // A deadline only opens a new collection cycle. It never earns another
      // failure/backoff without fresh clean-absence evidence from every peer.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.collectionDeadlineAt = now
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      record.nextRetryAt = 0;
    } else if (now >= record.collectionDeadlineAt) {
      // Expired partial evidence fails open and releases its cache slot. Return
      // evidence-free for this pass so a repeatedly ineligible roster cannot
      // refresh all collecting entries just before capacity admission runs.
      this.vmReconcileRotationState.delete(slotKey);
      return { slotKey, suppressed: false };
    }

    this.touchVmReconcileRotationRecord(slotKey, record);
    return { slotKey, record, suppressed: false };
  }

  enterVmReconcileRotationBackoff(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
    kind: NonNullable<VmReconcileRotationRecord['backoffKind']> = 'clean-absence',
  ): void {
    record.failures += 1;
    const exponentialBackoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_BASE_MS
        * 2 ** Math.max(0, record.failures - 1),
    );
    const jitterSample = createHash('sha256')
      .update(`${this.peerId}\0${slotKey}\0${record.fingerprint}\0${record.failures}`)
      .digest()
      .readUInt32BE(0) / 0x1_0000_0000;
    const backoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      Math.max(1, Math.round(exponentialBackoff * (0.8 + jitterSample * 0.4))),
    );
    record.phase = 'backoff';
    record.backoffKind = kind;
    record.collectionDeadlineAt = 0;
    record.nextRetryAt = this.vmReconcileRotationNow() + backoff;
  }

  vmReconcileUncreditedCandidateOrder(
    this: DKGAgent,
    record: VmReconcileRotationRecord,
  ): string[] {
    const candidates = [...record.candidatePeerIds];
    if (candidates.length === 0) return candidates;
    const lastIndex = record.lastAttemptedPeerId === undefined
      ? -1
      : candidates.indexOf(record.lastAttemptedPeerId);
    const start = lastIndex < 0 ? 0 : (lastIndex + 1) % candidates.length;
    return [
      ...candidates.slice(start),
      ...candidates.slice(0, start),
    ].filter((peerId) => !record.attemptedPeerIds.has(peerId));
  }

  /** Return whether a peer's current connection is known to ignore exact filters. */
  vmReconcileExactFilterUnsupported(this: DKGAgent, peerId: string): boolean {
    const cache = this.vmReconcileExactPeerCapabilities;
    if (!cache) return false;
    const entry = cache.get(peerId);
    if (!entry) return false;
    const now = this.vmReconcileRotationNow();
    if (entry.expiresAt <= now) {
      cache.delete(peerId);
      return false;
    }
    const connectionKey = this.getSyncReconcilerConnectionKey(peerId);
    if (connectionKey === null || connectionKey !== entry.connectionKey) {
      cache.delete(peerId);
      return false;
    }
    // Touch the entry so the bounded map evicts the least recently consulted
    // peer when a large curator roster rotates through it.
    cache.delete(peerId);
    cache.set(peerId, entry);
    return true;
  }

  /** Remember a clean legacy exact miss for this connection only. */
  rememberVmReconcileExactFilterUnsupported(this: DKGAgent, peerId: string): void {
    const cache = this.vmReconcileExactPeerCapabilities;
    if (!cache) return;
    const connectionKey = this.getSyncReconcilerConnectionKey(peerId);
    if (connectionKey === null) return;
    cache.delete(peerId);
    cache.set(peerId, {
      connectionKey,
      expiresAt: this.vmReconcileRotationNow()
        + DKGAgentBase.VM_RECONCILE_EXACT_CAPABILITY_TTL_MS,
    });
    while (cache.size > DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /**
   * Select one physical peer for a VM-recovery target. A peer that returned an
   * exact hit in this slice is preferred for one bounded microbatch; a peer
   * whose current connection is cached as legacy remains eligible and is routed
   * to bounded full sync by the executor. The provider policy owns every
   * mutable transition so partial responses revoke affinity consistently.
   * Unavailable peers and the global considered-peer cap remain authoritative.
   */
  selectVmReconcileExactCandidate(
    this: DKGAgent,
    record: VmReconcileRotationRecord | undefined,
    fallbackCandidatePeerIds: readonly string[],
    policy: VmRecoveryProviderPolicy,
    binding?: { localCgId: string; onChainCgId: string; experimentalStreamPeerIds?: ReadonlySet<string> },
  ): string | undefined {
    const uncreditedCandidateOrder = record
      ? this.vmReconcileUncreditedCandidateOrder(record)
      : fallbackCandidatePeerIds;
    const preferredPeerId = binding
      ? this.vmReconcilePublicCoreTransportPreferencePolicy.preferredPeer(
          binding.localCgId, binding.onChainCgId, uncreditedCandidateOrder,
        )
      : undefined;
    const now = this.vmReconcileRotationNow();
    const { order, heldOffPeerIds } = orderVmRecoveryCandidates({
      candidatePeerIds: uncreditedCandidateOrder,
      preferredPeerId,
      streamPeerIds: binding?.experimentalStreamPeerIds,
      lastAttemptedPeerId: record?.lastAttemptedPeerId,
      hasSetback: (peerId) => binding !== undefined
        && record?.streamSetbackPeerIds?.has(peerId) === true
        && this.vmReconcileStreamSetbackPolicy.inSetbackStreak(binding.localCgId, peerId, now),
      isHeldOff: (peerId) => binding !== undefined
        && this.vmReconcileStreamSetbackPolicy.heldOff(binding.localCgId, peerId, now),
    });
    return policy.selectNextCandidate(
      order,
      DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
      heldOffPeerIds,
    );
  }

  findVmReconcileRotationReplacement(
    this: DKGAgent,
    requestingCgId?: string,
  ): [string, VmReconcileRotationRecord] | undefined {
    if (this.vmReconcileRotationState.size < DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      return undefined;
    }
    const now = this.vmReconcileRotationNow();
    for (const entry of this.vmReconcileRotationState) {
      const [, record] = entry;
      if (
        (record.phase === 'backoff' && now < record.nextRetryAt)
        || (record.phase === 'collecting' && now < record.collectionDeadlineAt)
      ) continue;
      return entry;
    }
    if (!requestingCgId) return undefined;
    const countsByCg = new Map<string, number>();
    for (const record of this.vmReconcileRotationState.values()) {
      countsByCg.set(record.localCgId, (countsByCg.get(record.localCgId) ?? 0) + 1);
    }
    if ((countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const entry of this.vmReconcileRotationState) {
      if ((countsByCg.get(entry[1].localCgId) ?? 0) > 1) return entry;
    }
    return undefined;
  }

  canInstallVmReconcileRotationRecord(this: DKGAgent, requestingCgId?: string): boolean {
    if (this.vmReconcileRotationState.size < DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      return true;
    }
    return this.findVmReconcileRotationReplacement(requestingCgId) !== undefined;
  }

  installVmReconcileRotationRecord(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
  ): boolean {
    if (this.vmReconcileRotationClosed || this.vmReconcileRotationState.has(slotKey)) {
      return false;
    }
    const replacement = this.findVmReconcileRotationReplacement(record.localCgId);
    if (!replacement) {
      if (this.vmReconcileRotationState.size >= DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
        return false;
      }
      this.vmReconcileRotationState.set(slotKey, record);
      return this.vmReconcileRotationState.get(slotKey) === record;
    }

    // Donation and requester installation are one synchronous state transition.
    // Restore the donor if installation exits or throws before ownership moves.
    const [replacementKey, replacementRecord] = replacement;
    let installed = false;
    this.vmReconcileRotationState.delete(replacementKey);
    try {
      if (this.vmReconcileRotationClosed || this.vmReconcileRotationState.has(slotKey)) {
        return false;
      }
      this.vmReconcileRotationState.set(slotKey, record);
      installed = this.vmReconcileRotationState.get(slotKey) === record;
      return installed;
    } finally {
      if (!installed && !this.vmReconcileRotationState.has(replacementKey)) {
        this.vmReconcileRotationState.set(replacementKey, replacementRecord);
      }
    }
  }

  clearVmReconcileRotationStateForContextGraph(
    this: DKGAgent,
    localCgId: string,
  ): void {
    const prefix = `${localCgId}\0`;
    for (const key of this.vmReconcileRotationState.keys()) {
      if (key.startsWith(prefix)) this.vmReconcileRotationState.delete(key);
    }
    this.vmReconcileTransportBudgetPolicy.forgetContextGraph(localCgId);
    this.vmReconcileStreamSetbackPolicy.forgetContextGraph(localCgId);
    this.vmReconcileRotationAdmissionCursorByCg.delete(localCgId);
    this.vmReconcilePublicCoreTransportPreferencePolicy?.forgetContextGraph(localCgId);
    existingVmRecoveryPreparation(this)?.discard(localCgId);
  }

  closeVmReconcileRotationState(this: DKGAgent): void {
    this.vmReconcileLifecycleController?.abort();
    this.vmReconcileLifecycleGeneration = (this.vmReconcileLifecycleGeneration ?? 0) + 1;
    this.vmReconcileRotationClosed = true;
    this.vmReconcileScheduling?.resetSweep();
    // Some lifecycle tests intentionally construct a narrow partial agent
    // without running the base constructor. Shutdown must remain best-effort
    // for that supported test seam and never mask later teardown failures.
    this.vmReconcileRotationState?.clear();
    this.vmReconcileTransportBudgetPolicy?.clear();
    this.vmReconcileStreamSetbackPolicy?.clear();
    this.vmReconcileRotationAdmissionCursorByCg?.clear();
    this.vmReconcileCuratorPeersByCg?.clear();
    this.vmReconcileCuratorPageCursorByCg?.clear();
    this.vmReconcileExactPeerCapabilities?.clear();
    this.vmReconcilePublicCoreTransportPreferencePolicy?.clear();
    this.vmRefreshQueue?.clear();
    // Cancel speculative sizing reads and let shutdown wait for them to settle.
    const preparation = existingVmRecoveryPreparation(this);
    if (preparation && this.vmReconcilePhysicalRuns) {
      trackVmReconcilePhysicalRun(this.vmReconcilePhysicalRuns, preparation.close());
    } else {
      void preparation?.close();
    }
  }

  openVmReconcileRotationState(this: DKGAgent): void {
    if (!this.vmReconcileLifecycleController || this.vmReconcileLifecycleController.signal.aborted) {
      this.vmReconcileLifecycleController = new AbortController();
    }
    this.vmReconcileRotationClosed = false;
  }

  vmReconcileRecoveryTargetMatches(
    this: DKGAgent,
    expected: OrdinalRecoveryTarget,
    actual: OrdinalRecoveryTarget,
  ): boolean {
    return expected.localCgId === actual.localCgId
      && expected.onChainCgId === actual.onChainCgId
      && expected.ordinal === actual.ordinal
      && expected.ual === actual.ual
      && expected.merkleRoot.toLowerCase() === actual.merkleRoot.toLowerCase();
  }

  settleVmReconcileRotationAttempt(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    peerId: string | undefined,
    disposition: 'found' | 'clean-absent' | 'incomplete',
    expectedCandidatePeerIds: readonly string[],
    capturedRecord: VmReconcileRotationRecord,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    if (this.vmReconcileRotationClosed) return;
    const slotKey = this.vmReconcileRotationSlotKey(target);
    if (this.vmReconcileRotationState.get(slotKey) !== capturedRecord) return;
    if (!this.vmReconcilePeerMembershipMatches(
      capturedRecord.candidatePeerIds,
      expectedCandidatePeerIds,
    )) return;
    if (peerId !== undefined && !capturedRecord.candidatePeerIds.has(peerId)) return;

    if (peerId !== undefined) {
      capturedRecord.attemptedPeerIds.add(peerId);
      // This attempt gave a verdict: an earlier setback with the peer is history.
      capturedRecord.streamSetbackPeerIds?.delete(peerId);
      if (disposition === 'clean-absent') capturedRecord.cleanAbsentPeerIds.add(peerId);
      // Preserve fairly accumulated proof progress while other targets share
      // the bounded peer budget. A cycle expires only after this slot itself
      // stops making physical progress for the effective maximum.
      capturedRecord.collectionDeadlineAt = this.vmReconcileRotationNow()
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
    }
    const scheduledEveryPeer = [...capturedRecord.candidatePeerIds]
      .every((candidatePeerId) => capturedRecord.attemptedPeerIds.has(candidatePeerId)
        || unavailablePeerIds.has(candidatePeerId));
    const cleanAbsentFromEveryPeer = [...capturedRecord.candidatePeerIds]
      .every((candidatePeerId) => capturedRecord.cleanAbsentPeerIds.has(candidatePeerId));
    if (cleanAbsentFromEveryPeer && capturedRecord.curatorRosterConfirmed) {
      this.enterVmReconcileRotationBackoff(slotKey, capturedRecord, 'clean-absence');
    } else if (scheduledEveryPeer && capturedRecord.curatorRosterConfirmed) {
      // This is retry suppression only, never absence proof. It prevents a
      // legacy peer that ignores the exact filter from replaying the same
      // bounded prefix at elevated priority every sweep.
      this.enterVmReconcileRotationBackoff(slotKey, capturedRecord, 'incomplete-cycle');
    }
    this.touchVmReconcileRotationRecord(slotKey, capturedRecord);
  }

  /**
   * Hand a target its turn at `peerId` back after an attempt that ended
   * without a verdict on the peer's data. The peer is uncredited again, so the
   * cycle cannot complete, and so cannot back off, without asking it. Removing
   * a mark is safe against any roster, which is why membership is not checked.
   * The setback is noted on the target, for candidate selection to order by.
   */
  releaseVmReconcileRotationAttempt(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    peerId: string,
    capturedRecord: VmReconcileRotationRecord,
  ): void {
    if (this.vmReconcileRotationClosed) return;
    const slotKey = this.vmReconcileRotationSlotKey(target);
    if (this.vmReconcileRotationState.get(slotKey) !== capturedRecord) return;
    capturedRecord.attemptedPeerIds.delete(peerId);
    (capturedRecord.streamSetbackPeerIds ??= new Set()).add(peerId);
    this.touchVmReconcileRotationRecord(slotKey, capturedRecord);
  }

  creditVmReconcileCleanAbsence(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    peerId: string,
    expectedCandidatePeerIds: readonly string[],
    capturedRecord: VmReconcileRotationRecord,
  ): void {
    this.settleVmReconcileRotationAttempt(
      target,
      peerId,
      'clean-absent',
      expectedCandidatePeerIds,
      capturedRecord,
    );
  }

  installVmReconcileActiveFetchCooldown(this: DKGAgent, localCgId: string, now: number): symbol {
    const owner = Symbol(localCgId);
    this.vmReconcileFetchCooldowns.delete(localCgId);
    this.vmReconcileFetchCooldowns.set(localCgId, { startedAt: now, owner });
    return owner;
  }

  readVmReconcileActiveFetchCooldown(
    this: DKGAgent,
    localCgId: string,
  ): Readonly<{ startedAt: number; owner: symbol }> | undefined {
    return this.vmReconcileFetchCooldowns.get(localCgId);
  }

  clearVmReconcileActiveFetchCooldown(
    this: DKGAgent,
    localCgId: string,
    expectedOwner?: symbol,
  ): boolean {
    const current = this.vmReconcileFetchCooldowns.get(localCgId);
    if (expectedOwner !== undefined && current?.owner !== expectedOwner) return false;
    return this.vmReconcileFetchCooldowns.delete(localCgId);
  }

  shouldRunVmReconcileActiveFetch(this: DKGAgent, localCgId: string): boolean {
    const now = Date.now();
    this.pruneVmReconcileState(now);
    const lastFetchAt = this.vmReconcileFetchCooldowns.get(localCgId)?.startedAt;
    if (lastFetchAt !== undefined && now - lastFetchAt < DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS) {
      return false;
    }
    if (lastFetchAt !== undefined) this.clearVmReconcileActiveFetchCooldown(localCgId);
    this.installVmReconcileActiveFetchCooldown(localCgId, now);
    return true;
  }

  pruneVmReconcileState(this: DKGAgent, now = Date.now()): void {
    for (const [localCgId, cooldown] of this.vmReconcileFetchCooldowns) {
      if (now - cooldown.startedAt >= DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS) {
        this.clearVmReconcileActiveFetchCooldown(localCgId);
      }
    }
    while (this.vmReconcileFetchCooldowns.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileFetchCooldowns.keys().next().value;
      if (oldestKey === undefined) break;
      this.clearVmReconcileActiveFetchCooldown(oldestKey);
    }

    while (this.vmReconcileCatchupPeerCursor.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCatchupPeerCursor.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCatchupPeerCursor.delete(oldestKey);
      this.vmReconcileCatchupPeerOrder.delete(oldestKey);
    }
    while (this.vmReconcileCatchupPeerOrder.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCatchupPeerOrder.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCatchupPeerOrder.delete(oldestKey);
      this.vmReconcileCatchupPeerCursor.delete(oldestKey);
    }
    while (this.vmReconcileCuratorPeersByCg.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCuratorPeersByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCuratorPeersByCg.delete(oldestKey);
    }
    while (
      this.vmReconcileCuratorPageCursorByCg.size
      > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES
    ) {
      const oldestKey = this.vmReconcileCuratorPageCursorByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCuratorPageCursorByCg.delete(oldestKey);
    }
    while (
      this.vmReconcileRotationAdmissionCursorByCg.size
      > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES
    ) {
      const oldestKey = this.vmReconcileRotationAdmissionCursorByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileRotationAdmissionCursorByCg.delete(oldestKey);
    }
  }

  clearVmReconcileStateForContextGraph(this: DKGAgent, localCgId: string): void {
    const sub = this.subscribedContextGraphs.get(localCgId);
    if (sub?.subscribed || sub?.coreHosted) return;
    // Passive subscription/discovery rows do not own RFC-64 selected-only
    // progress. Clear subscription-owned reconciliation state while retaining
    // the independently selected, deployment-fenced cursor.
    this.forceClearVmReconcileStateForContextGraph(localCgId, {
      includeSelectedCursor: false,
    });
  }

  forceClearVmReconcileStateForContextGraph(
    this: DKGAgent,
    localCgId: string,
    options: { includeSelectedCursor?: boolean } = {},
  ): void {
    this.reconcileCursors.delete(localCgId);
    if (
      options.includeSelectedCursor !== false
      && this.selectedVmReconcileCursors.delete(localCgId)
    ) {
      this.selectedVmReconcileBindingGeneration += 1;
    }
    this.clearVmReconcileRotationStateForContextGraph(localCgId);
    this.vmReconcileCuratorPeersByCg.delete(localCgId);
    this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
    this.clearVmReconcileActiveFetchCooldown(localCgId);
    this.vmReconcileCatchupPeerCursor.delete(localCgId);
    this.vmReconcileCatchupPeerOrder.delete(localCgId);
    this.clearRecentVmReconcileStateForContextGraph(localCgId);
    this.vmRefreshQueue?.clearContextGraph(localCgId);
  }

  clearRecentVmReconcileStateForContextGraph(this: DKGAgent, localCgId: string): void {
    this.recentReconciledUals.deleteByPrefix(`${localCgId}\0`);
    this.vmReconcileFinalizedSlotEvidence.deleteByPrefix(`${localCgId}\0`);
  }

  vmReconcileCacheKey(this: DKGAgent, localCgId: string, ual: string, merkleRoot: Uint8Array): string {
    const rootHex = Array.from(merkleRoot, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${localCgId}\0${ual}#${rootHex}`;
  }

  /**
   * Resolve the exact finalized height used by the adapter's coherent KA
   * snapshot. Absent/invalid adapter depth disables the fast path rather than
   * guessing at finality.
   */
  vmReconcileFinalizedBlockAtHead(
    this: DKGAgent,
    headBlock: number | undefined,
  ): number | undefined {
    if (!Number.isSafeInteger(headBlock) || headBlock === undefined || headBlock < 0) {
      return undefined;
    }
    const confirmations = this.chain.getFinalityConfirmations?.();
    if (!Number.isSafeInteger(confirmations) || confirmations === undefined || confirmations <= 0) {
      return undefined;
    }
    const finalizedBlock = headBlock - confirmations + 1;
    return finalizedBlock >= 0 ? finalizedBlock : undefined;
  }

  vmReconcileFinalizedSlotKey(
    this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
  ): string {
    return `${localCgId}\0finalized-slot:${onChainCgId}:${ordinal}`;
  }

  async confirmAndRememberVmReconcileFinalizedSlot(
    this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    finalizedBlock: number | undefined,
    kaId: bigint,
    merkleRoot: Uint8Array,
    publisherAddress: string,
  ): Promise<void> {
    if (
      finalizedBlock === undefined
      || !this.chain.readKnowledgeAssetVersionSnapshot
    ) return;
    let snapshot: KnowledgeAssetVersionSnapshot | null | undefined;
    try {
      snapshot = await this.chain.readKnowledgeAssetVersionSnapshot(kaId);
      if (
        !snapshot
        || snapshot.knowledgeAssetId !== kaId
        || snapshot.blockNumber !== finalizedBlock
        || typeof snapshot.blockHash !== 'string'
        || !ethers.isHexString(snapshot.blockHash, 32)
        || typeof snapshot.knowledgeAssetStorageAddress !== 'string'
        || !ethers.isAddress(snapshot.knowledgeAssetStorageAddress)
        || !Number.isSafeInteger(snapshot.knowledgeAssetStorageGeneration)
        || snapshot.knowledgeAssetStorageGeneration! < 0
        || snapshot.rootCount <= 0n
        || !ethers.isHexString(snapshot.latestRoot, 32)
        || !ethers.isAddress(snapshot.latestAuthor)
        || merkleRoot.length !== 32
        || !ethers.isAddress(snapshot.latestPublisher)
        || !ethers.isAddress(publisherAddress)
        || ethers.getAddress(snapshot.latestPublisher) === ethers.ZeroAddress
        || ethers.getAddress(snapshot.latestAuthor) === ethers.ZeroAddress
        || ethers.getAddress(publisherAddress) === ethers.ZeroAddress
        || !ethers.getBytes(snapshot.latestRoot).every(
          (byte, index) => byte === merkleRoot[index],
        )
        || ethers.getAddress(snapshot.latestPublisher) !== ethers.getAddress(publisherAddress)
      ) return;
    } catch {
      // The successful reconciliation remains truthful; a failed validation
      // merely withholds the same-finalized-block fast path.
      return;
    }
    if (!snapshot) return;
    this.vmReconcileFinalizedSlotEvidence.set(
      this.vmReconcileFinalizedSlotKey(localCgId, onChainCgId, ordinal),
      {
        kaId,
        snapshot: Object.freeze({ ...snapshot }),
      },
    );
  }

  vmReconcileCacheKeyPrefix(this: DKGAgent, cacheKey: string): string {
    const separator = cacheKey.lastIndexOf('#');
    return separator >= 0 ? cacheKey.slice(0, separator + 1) : `${cacheKey}#`;
  }

  pruneVmReconcileCacheKeySiblings(this: DKGAgent, cacheKey: string): void {
    const prefix = this.vmReconcileCacheKeyPrefix(cacheKey);
    this.recentReconciledUals.deleteByPrefix(prefix, cacheKey);
  }

  /**
   * Execute one provider after connection/network readiness. The caller owns
   * roster, packing, and provider affinity; local sync admission starts the
   * physical attempt before rotation marks are installed. This executor owns
   * exact or cached legacy work, per-UAL chain revalidation, and settlement.
   * Returns immutable evidence for the caller to merge. A stale lifecycle is
   * discriminated by whether the physical attempt had already been admitted;
   * only the pre-admission variant guarantees zero attempt side effects.
   */
  async executeVmRecoveryBatch(this: DKGAgent, input: {
    localCgId: string;
    onChainCgId: bigint;
    peerId: string;
    attempts: readonly VmRecoveryBatchAttempt[];
    unavailablePeerIds: readonly string[];
    headBlock: number | undefined;
    signal?: AbortSignal;
    isRecoveryCurrent: () => boolean;
    revalidateTarget?: () => Promise<boolean>;
    ctx: OperationContext;
    exactRecoveryTransportMode?: ExactRecoveryTransportMode;
    /** Bound legacy peers only while a public stream-capable alternative exists. */
    legacyAttemptTimeoutMs?: number;
    /**
     * The owning pass's own fresh positive registered-public answer, for the exchange's
     * pre-flight to rely on instead of reading it a second time. Only this exchange gets it.
     */
    registeredPublicEvidence?: VmRecoveryRegisteredPublicEvidence;
    /** Observation only: charged for the exchange and the post-fetch revalidation. */
    phases?: VmRecoveryPhaseRecorder;
  }): Promise<VmRecoveryBatchExecutionResult> {
    const {
      localCgId,
      onChainCgId,
      peerId,
      attempts,
      unavailablePeerIds,
      headBlock,
      signal,
      isRecoveryCurrent,
      revalidateTarget,
      ctx,
      exactRecoveryTransportMode = 'stream-preferred',
      legacyAttemptTimeoutMs,
      registeredPublicEvidence,
      phases,
    } = input;
    const unavailablePeerIdSet = new Set(unavailablePeerIds);

    // The caller's last guard can race an unsubscribe/rebind before this
    // executor begins. Do not retain attempt evidence or emit a fetch event
    // until this exact lifecycle has been re-proved at the ownership boundary.
    if (!isRecoveryCurrent()) return { kind: 'not-started-stale' };

    const useCachedLegacyFallback = exactRecoveryTransportMode !== 'stream-required'
      && this.vmReconcileExactFilterUnsupported(peerId);

    const handledOrdinals: number[] = [];
    const attemptedOrdinals: number[] = [];
    const outcomes: Array<readonly [number, OrdinalOutcome]> = [];
    let workStarted = false;
    const onWorkStarted = (): void => {
      if (workStarted || !isRecoveryCurrent()) return;
      workStarted = true;
      for (const attempt of attempts) {
        const batchTarget = attempt.entry.target;
        this.vmReconcileTransportBudgetPolicy.recordAdmitted(batchTarget, peerId);
        handledOrdinals.push(batchTarget.ordinal);
        attemptedOrdinals.push(batchTarget.ordinal);
        const record = attempt.installedRecord;
        const slotKey = this.vmReconcileRotationSlotKey(batchTarget);
        if (record && this.vmReconcileRotationState.get(slotKey) === record
          && record.fingerprint === this.vmReconcileRotationFingerprint(batchTarget)) {
          record.lastAttemptedPeerId = peerId;
          record.attemptedPeerIds.add(peerId);
          record.collectionDeadlineAt = this.vmReconcileRotationNow()
            + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
          this.touchVmReconcileRotationRecord(slotKey, record);
        }
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          action: 'fetch',
          ordinal: batchTarget.ordinal,
          kaId: batchTarget.kaId,
          ual: batchTarget.ual,
          detail: useCachedLegacyFallback
            ? 'legacy-sync'
            : attempts.length > 1 ? 'exact-asset-batch' : 'exact-asset',
        });
      }
    };
    let disposition: VmRecoveryUalDisposition = 'incomplete';
    let streamOutcome: ExactBatchStreamOutcome | undefined;
    let localAdmissionDeferred = false;
    const legacyAttemptStartedAt = Date.now();
    const remainingLegacyAttemptMs = (): number | undefined => legacyAttemptTimeoutMs === undefined
      ? undefined
      : Math.max(0, legacyAttemptTimeoutMs - (Date.now() - legacyAttemptStartedAt));
    const runLegacyFallback = async (): Promise<void> => {
      const remainingMs = remainingLegacyAttemptMs();
      // Both the exact-filter probe and a full-scan fallback belong to one
      // provider turn. Do not grant a fresh long deadline after the probe has
      // already spent the bounded legacy window.
      if (remainingMs !== undefined && remainingMs < SYNC_MIN_GRAPH_BUDGET_MS) {
        this.log.info(ctx, `VM legacy fallback for "${localCgId}" from ${peerId.slice(-8)} skipped: attempt budget exhausted`);
        return;
      }
      try {
        const fallback = await this.runLegacyDurableSyncDetailed(
          ctx,
          peerId,
          [localCgId],
          undefined,
          undefined,
          undefined,
          {
            stopOnBackoffWorthyFailure: true,
            priority: VM_RECOVERY_SYNC_PRIORITY,
            source: 'vm-recovery',
            onWorkStarted,
            signal,
            isCurrent: isRecoveryCurrent,
            ...(remainingMs === undefined ? {} : { totalTimeoutMs: remainingMs }),
          },
        );
        if (fallback.admission === 'work-started') onWorkStarted();
        // An admitted exact request retains its attempt through a refused
        // fallback. Only the original never-started operation can defer.
        localAdmissionDeferred = !workStarted && fallback.admission === 'local-admission-deferred';
        this.log.info(
          ctx,
          `VM legacy fallback for "${localCgId}" from ${peerId.slice(-8)}: fetched=${fallback.result.fetchedDataTriples + fallback.result.fetchedMetaTriples} inserted=${fallback.result.insertedTriples} failed=${fallback.result.failedPeers + fallback.result.failedPhases}`,
        );
      } catch (fallbackError) {
        this.log.info(
          ctx,
          `VM legacy fallback for "${localCgId}" from ${peerId.slice(-8)} failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    };
    const exchangeInterval = phases?.begin();
    try {
      if (useCachedLegacyFallback) {
        await runLegacyFallback();
      } else {
        const detailed = await this.syncExactKnowledgeAssetsFromPeerDetailed(
          peerId,
          localCgId,
          attempts.map(({ entry }) => entry.target.ual),
          {
            signal, isCurrent: isRecoveryCurrent, onWorkStarted, exactRecoveryTransportMode,
            ...(legacyAttemptTimeoutMs === undefined ? {} : { totalTimeoutMs: legacyAttemptTimeoutMs }),
            ...(registeredPublicEvidence ? { registeredPublicEvidence } : {}),
          },
        );
        const { result } = detailed;
        disposition = detailed.disposition;
        streamOutcome = detailed.streamOutcome;
        // A fresh capability response is physical peer evidence even when
        // its later ordinary fallback cannot acquire local capacity.
        if (detailed.admission === 'work-started' || detailed.responderCapability !== undefined) onWorkStarted();
        localAdmissionDeferred = !workStarted && detailed.admission === 'local-admission-deferred';
        if (exactRecoveryTransportMode !== 'stream-required' && detailed.responderCapability === 'legacy-filter-unsupported') {
          this.rememberVmReconcileExactFilterUnsupported(peerId);
          if (isRecoveryCurrent() && disposition === 'incomplete') {
            await runLegacyFallback();
          }
        }
        this.log.info(
          ctx,
          `VM exact fetch for "${localCgId}" from ${peerId.slice(-8)}: requested=${attempts.length} fetched=${result.fetchedDataTriples + result.fetchedMetaTriples} inserted=${result.insertedTriples} failed=${result.failedPeers + result.failedPhases} deferred=${result.deferredBackpressure} disposition=${disposition}`,
        );
      }
    } catch (error) {
      this.log.info(
        ctx,
        `VM exact fetch for "${localCgId}" from ${peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (phases && exchangeInterval) phases.chargeSince('exchange', exchangeInterval.startedAt, exchangeInterval.before);
    if (!isRecoveryCurrent()) return { kind: workStarted ? 'stale-after-attempt' : 'not-started-stale' };
    if (localAdmissionDeferred) return { kind: 'local-admission-deferred' };

    // A stream that answered busy or broke says nothing about the peer's data.
    // The policy decides whether the targets still pending keep their turn at it.
    let providerTurnKept = false;
    if (workStarted && streamOutcome !== undefined) {
      if (streamOutcome === 'complete') {
        this.vmReconcileStreamSetbackPolicy.recordServed(localCgId, peerId, this.vmReconcileRotationNow());
      } else {
        const setback = this.vmReconcileStreamSetbackPolicy.recordSetback(
          localCgId, peerId, streamOutcome, this.vmReconcileRotationNow(),
        );
        providerTurnKept = setback.keepsTurn;
        observeVmRecoveryTiming(() => this.log.info(
          ctx,
          `VM exact recovery stream setback for "${localCgId}" from ${peerId.slice(-8)}: `
            + `kind=${streamOutcome} assets=${attempts.length} keepsTurn=${setback.keepsTurn ? 1 : 0} `
            + `holdOffMs=${setback.holdOffMs}`,
        ));
      }
    }

    const perUalDispositions = new Map<string, VmRecoveryUalDisposition>();
    // The batch's targets are re-verified side by side, with the scan's own
    // bound, so their chain reads can leave in one request. Like the scan, a
    // target that throws stops the ones not yet started and the batch rejects
    // only once the ones in flight have finished: nothing here outlives the
    // pass. They are settled in order below: each step still sees the rotation
    // state its predecessor left.
    const revalidateBatch = (): Promise<OrdinalOutcome[]> => mapWithConcurrencyDrained(
      attempts,
      DKGAgentBase.VM_RECONCILE_ORDINAL_CONCURRENCY,
      (attempt) => this.reconcileChainOrdinal(
        localCgId,
        onChainCgId,
        attempt.entry.target.ordinal,
        headBlock,
        {
          isTargetCurrent: isRecoveryCurrent,
          revalidateTarget,
        },
      ),
    );
    const revalidated = await (phases ? phases.measure('post-fetch', revalidateBatch) : revalidateBatch());
    if (!isRecoveryCurrent()) return { kind: 'stale-after-attempt' };
    for (const [attemptIndex, attempt] of attempts.entries()) {
      const batchTarget = attempt.entry.target;
      const outcome = revalidated[attemptIndex]!;
      outcomes.push([batchTarget.ordinal, outcome]);
      const perTargetDisposition: VmRecoveryUalDisposition = (
        outcome.status === 'reconciled' || outcome.status === 'already'
      )
        ? 'found'
        : disposition === 'clean-absent'
          ? 'clean-absent'
          : 'incomplete';
      perUalDispositions.set(batchTarget.ual, perTargetDisposition);
      if (outcome.status === 'pending' && outcome.recovery) {
        if (!workStarted) continue;
        const batchRecord = attempt.installedRecord;
        if (!batchRecord || this.vmReconcileRotationClosed) continue;
        if (
          this.vmReconcileRotationState.get(this.vmReconcileRotationSlotKey(batchTarget))
          !== batchRecord
        ) continue;
        const candidateMembershipAfter = this.vmReconcileObservedCandidatePeerIds(localCgId);
        if (providerTurnKept) {
          this.releaseVmReconcileRotationAttempt(batchTarget, peerId, batchRecord);
        }
        if (!this.vmReconcilePeerMembershipMatches(
          batchRecord.candidatePeerIds,
          candidateMembershipAfter,
        )) {
          this.prepareVmReconcileRotationTarget(
            outcome.recovery,
            candidateMembershipAfter,
            this.vmReconcileRotationNow(),
          );
        } else if (!providerTurnKept
          && this.vmReconcileRecoveryTargetMatches(batchTarget, outcome.recovery)) {
          this.settleVmReconcileRotationAttempt(
            batchTarget,
            peerId,
            perTargetDisposition,
            attempt.candidatePeerIds,
            batchRecord,
            unavailablePeerIdSet,
          );
        }
      } else {
        this.vmReconcileRotationState.delete(this.vmReconcileRotationSlotKey(batchTarget));
      }
    }
    return {
      kind: 'completed',
      outcomes,
      handledOrdinals,
      attemptedOrdinals,
      providerDisposition: disposition,
      perUalDispositions: [...perUalDispositions],
      providerTurnKept,
    };
  }

  /**
   * Drain one exact missing-KA batch. The initial ordinal scan has already
   * proven these UALs are not locally materialized, so no already-confirmed KA
   * enters the wire request. After every peer response we re-run local chain
   * verification and remove completed KAs before considering another peer.
   */
  async recoverVmReconcileBatch(this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly OrdinalRecoveryTarget[],
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
    revalidateTarget?: () => Promise<boolean>,
  ): Promise<PendingOrdinalRecoveryResult> {
    const rotationGeneration = this.vmReconcileLifecycleGeneration;
    const isRecoveryCurrent = () => !this.vmReconcileRotationClosed
      && !signal?.aborted
      && this.vmReconcileLifecycleGeneration === rotationGeneration
      && isTargetCurrent();
    const ctx = createOperationContext('system');
    // Advisory sizing preparation (opt-in, default off). Created lazily and
    // owned by this host; every hint is bound to this exact recovery operation.
    const readUpdateContextForPreparation = this.chain.getKnowledgeAssetUpdateContext;
    const experimentPolicy = resolveVmRecoveryExperimentPolicy(this.config.vmRecoveryPrefetchEnabled, existingVmRecoveryPreparation(this)?.limits);
    const preparation = experimentPolicy.prefetchEnabled
      ? vmRecoveryPreparationFor(
        this,
        typeof readUpdateContextForPreparation === 'function'
          ? { readUpdateContext: (id, readOptions) => readUpdateContextForPreparation.call(this.chain, id, readOptions) }
          : null,
      )
      : undefined;
    const preparationScope: VmRecoveryPreparationScope = {
      localCgId,
      onChainCgId,
      generation: rotationGeneration,
      ...(signal ? { signal } : {}),
      isCurrent: isRecoveryCurrent,
    };
    const transportPreparation = preparation
      ? new VmRecoveryTransportPreparation(preparation, preparationScope) : undefined;
    const timing = new VmRecoveryTimingObserver(localCgId, (message) => this.log.info(ctx, message));
    const phases = timing.phases;
    const noRecovery = (
      continuationOrdinal?: number,
      cooldownOnly = false,
    ): PendingOrdinalRecoveryResult => ({
      outcomes: new Map(),
      attemptedOrdinals: [],
      continuationOrdinal,
      hasImmediateRecoveryWork: false,
      cooldownOnly,
    });
    let activeFetchCooldownOwner: symbol | undefined;
    const staleRecovery = (): PendingOrdinalRecoveryResult => {
      // Active-fetch admission installs this cooldown before any async
      // provider or transport boundary. If the target lifecycle changes while
      // one of those boundaries is pending, the discarded attempt must not
      // delay the replacement lifecycle by a full reconcile sweep. Ownership
      // prevents a late stale attempt from clearing the replacement's token.
      if (activeFetchCooldownOwner !== undefined) {
        this.clearVmReconcileActiveFetchCooldown(localCgId, activeFetchCooldownOwner);
      }
      return noRecovery();
    };
    if (!isRecoveryCurrent()) return staleRecovery();
    if (targets.length === 0) return noRecovery();

    const expectedOnChainCgId = onChainCgId.toString();
    const currentTargets = targets.filter((target) =>
      target.localCgId === localCgId && target.onChainCgId === expectedOnChainCgId);
    if (currentTargets.length === 0) return noRecovery();
    const admissionCursor = (
      this.vmReconcileRotationAdmissionCursorByCg.get(localCgId) ?? 0
    ) % currentTargets.length;
    const admissionDistance = (index: number) => (
      index - admissionCursor + currentTargets.length
    ) % currentTargets.length;

    // Suppression consults only the already-observed, capped connection view.
    // This is intentionally before curator resolution, dialing, protocol waits,
    // and admission probes. Every target reached this method only after the
    // production ordinal/finalization check proved it still pending locally.
    const observedCandidatePeerIds = this.vmReconcileObservedCandidatePeerIds(localCgId);
    const now = this.vmReconcileRotationNow();
    const initiallyOwnedSlotKeys = new Set(currentTargets.flatMap((target) => {
      const slotKey = this.vmReconcileRotationSlotKey(target);
      const record = this.vmReconcileRotationState.get(slotKey);
      return record?.fingerprint === this.vmReconcileRotationFingerprint(target)
        ? [slotKey]
        : [];
    }));
    const hasUnownedTarget = currentTargets.some((target) =>
      !initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)));
    const reservedReplacementSlotKey = hasUnownedTarget
      ? this.findVmReconcileRotationReplacement(localCgId)?.[0]
      : undefined;
    const initialPreparations = currentTargets
      .map((target, index) => ({
        index,
        target,
        hasOwnedRecord: initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)),
      }))
      // Use the same fair admission order before network work. Besides handing
      // expired capacity to a waiter, this makes an all-live saturated cache
      // return below without paying curator-resolution cost for work that
      // cannot retain its retry state.
      .sort((left, right) => Number(left.hasOwnedRecord) - Number(right.hasOwnedRecord)
        || admissionDistance(left.index) - admissionDistance(right.index))
      .map(({ index, target }) => {
        const slotKey = this.vmReconcileRotationSlotKey(target);
        const existing = this.vmReconcileRotationState.get(slotKey);
        if (!existing || existing.fingerprint !== this.vmReconcileRotationFingerprint(target)) {
          // The pre-network pass only consults already-earned suppression. A new
          // cycle is installed after curator resolution so its first roster is
          // authoritative-first; a stale fingerprint is invalidated immediately.
          if (existing) this.vmReconcileRotationState.delete(slotKey);
          const capacityAvailable = this.canInstallVmReconcileRotationRecord(localCgId);
          return {
            index,
            target,
            prepared: {
              slotKey,
              record: undefined,
              suppressed: this.vmReconcileRotationClosed || !capacityAvailable,
            },
          };
        }
        if (slotKey === reservedReplacementSlotKey) {
          // Keep the donor intact, but do not renew it before the waiter reaches
          // post-resolution installation. An earlier lifecycle exit leaves the
          // original record untouched; a successful install replaces it atomically.
          return {
            index,
            target,
            prepared: { slotKey, record: existing, suppressed: true },
          };
        }
        return {
          index,
          target,
          prepared: this.prepareVmReconcileRotationTarget(
            target,
            observedCandidatePeerIds,
            now,
            existing.curatorRosterConfirmed,
          ),
        };
      })
      .sort((left, right) => left.index - right.index);
    const initiallyEligible = initialPreparations
      .filter(({ prepared }) => !prepared.suppressed)
      .map(({ target }) => target);
    if (initiallyEligible.length === 0) {
      const suppressedRecords = initialPreparations
        .map(({ prepared }) => prepared.record)
        .filter((record): record is VmReconcileRotationRecord => record !== undefined);
      const nextRetryInMs = suppressedRecords.length === 0
        ? 0
        : Math.max(0, Math.min(...suppressedRecords.map((record) => record.nextRetryAt)) - now);
      this.log.info(
        ctx,
        `VM exact fetch for "${localCgId}" skipped by exact-recovery backoff `
          + `(slots=${suppressedRecords.length} candidates=${observedCandidatePeerIds.length} `
          + `failures=${Math.max(0, ...suppressedRecords.map((record) => record.failures))} `
          + `retryInMs=${Math.round(nextRetryInMs)})`,
      );
      return noRecovery();
    }

    // Damping: the batched path deliberately skips the per-UAL negative cache
    // (consulting it primes connections to every discovered agent — the walk
    // this path exists to avoid), so the per-CG active-fetch cooldown is the
    // short-term damper between fresh rotation attempts. Completed clean-
    // absence rotations use the slot-specific exponential backoff above;
    // transient/incomplete attempts retain this sweep-interval cooldown.
    if (!this.shouldRunVmReconcileActiveFetch(localCgId)) {
      this.log.info(ctx, `VM exact fetch for "${localCgId}" skipped by per-CG cooldown`);
      return noRecovery(initiallyEligible[0]?.ordinal, true);
    }
    activeFetchCooldownOwner = this.readVmReconcileActiveFetchCooldown(localCgId)?.owner;

    // Capture the authenticated join-approval hint before consulting metadata:
    // older member snapshots can contain a legacy creator self-stamp that is
    // unrelated to a wallet-scoped CG's structural curator. The structural
    // registry resolver is authoritative for `0x…/slug` graphs and can return
    // every node registered to that curator wallet.
    const approvedCuratorPeerId = this.preferredSyncPeers.get(localCgId);
    const cachedCuratorPeerIds = [
      ...(this.vmReconcileCuratorPeersByCg.get(localCgId) ?? []),
    ];
    const curatorPageCursor = this.vmReconcileCuratorPageCursorByCg.get(localCgId);
    const curatorResolution = await phases.measure('roster', () => this.resolveCuratorPeerIdsForCg(localCgId, {
      maxPeerIds: DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
      // Once overflow is proven, expose exactly one new ordered peer per pass.
      // One target can spend only one peer attempt, so advancing by more would
      // skip candidates when a CG has a single missing KA.
      pagePeerIds: 1,
      afterPeerId: curatorPageCursor,
      signal,
      isCurrent: isRecoveryCurrent,
    })
      .catch((): CuratorPeerIdsResolution => ({
        peerIds: [] as [],
        curatorIsLocal: false,
        legacyTripleResolved: false,
        lookupFailed: true,
      })));
    if (!isRecoveryCurrent()) return staleRecovery();
    const allResolvedCuratorPeerIds = [...new Set(curatorResolution.peerIds
      .filter((peerId) => peerId && peerId !== this.peerId))]
      .sort((left, right) => left.localeCompare(right));
    // Runtime adapter for older custom hosts. The canonical return type below
    // does not admit pagination without a rosterStatus discriminant.
    const legacyPagination = curatorResolution as unknown as {
      overflowed?: boolean;
      nextPageAfterPeerId?: string;
    };
    const curatorRosterStatus = curatorResolution.rosterStatus;
    const curatorRosterOverflow = (curatorRosterStatus
        ? curatorRosterStatus !== 'complete' : legacyPagination.overflowed === true)
      || allResolvedCuratorPeerIds.length > DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX;
    if (curatorRosterOverflow) {
      this.log.warn(
        ctx,
        `VM exact fetch curator roster for "${localCgId}" cannot establish a complete bounded roster `
          + `(ordered transport page=${allResolvedCuratorPeerIds.length}, `
          + `proofCap=${DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX}); `
          + 'walking the registry without negative-proof suppression',
      );
    }
    const resolutionSucceeded = curatorResolution.lookupFailed !== true
      && !curatorRosterOverflow;
    // Even an invalid oversized result remains useful for bounded fail-open
    // transport. Rotate a bounded window through it using the existing cache as
    // the cursor: a fixed prefix (or a formerly authoritative cached roster)
    // could otherwise hide a newly added holder forever. The window remains
    // explicitly unconfirmed below, so it can never support absence proof.
    const overflowTransportUniverse = [...new Set([
      ...allResolvedCuratorPeerIds,
      approvedCuratorPeerId,
    ].filter((peerId): peerId is string => Boolean(peerId && peerId !== this.peerId)))];
    const cachedOverflowStart = cachedCuratorPeerIds.length > 0
      ? overflowTransportUniverse.indexOf(cachedCuratorPeerIds[0]!)
      : -1;
    const overflowWindowStart = cachedOverflowStart < 0
      ? 0
      : (cachedOverflowStart + 1) % overflowTransportUniverse.length;
    const overflowTransportPeerIds = Array.from(
      { length: Math.min(
        DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
        overflowTransportUniverse.length,
      ) },
      (_, offset) => overflowTransportUniverse[
        (overflowWindowStart + offset) % overflowTransportUniverse.length
      ]!,
    );
    const resolvedCuratorPeerIds = curatorRosterOverflow
      ? (curatorRosterStatus === 'continue' || curatorRosterStatus === 'cycle'
          || legacyPagination.nextPageAfterPeerId)
        ? allResolvedCuratorPeerIds
        : overflowTransportPeerIds
      : allResolvedCuratorPeerIds;
    let legacyPreferredPeerId: string | undefined;
    if (resolutionSucceeded && !curatorResolution.curatorIsLocal
      && resolvedCuratorPeerIds.length === 0) {
      legacyPreferredPeerId = await phases.measure(
        'roster',
        () => this.resolvePreferredSyncPeerId(localCgId),
      );
    }
    if (!isRecoveryCurrent()) return staleRecovery();
    const authoritativeCuratorPeerIds = resolutionSucceeded
      ? resolvedCuratorPeerIds
      : curatorRosterOverflow
        ? resolvedCuratorPeerIds
        : cachedCuratorPeerIds;
    const curatorPeerIds = [...new Set([
      ...authoritativeCuratorPeerIds,
      legacyPreferredPeerId,
      approvedCuratorPeerId,
    ].filter((peerId): peerId is string => Boolean(peerId && peerId !== this.peerId)))]
      .slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    // Persist the bounded full authoritative roster. Individual passes still
    // connect/probe at most VM_RECONCILE_EXACT_PEER_MAX peers, while each
    // target's rotation record carries progress across those windows.
    if (resolutionSucceeded) {
      this.vmReconcileCuratorPeersByCg.delete(localCgId);
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
    } else if (curatorRosterStatus === 'continue') {
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
      this.vmReconcileCuratorPageCursorByCg.set(
        localCgId,
        curatorResolution.nextPageAfterPeerId,
      );
    } else if (curatorRosterStatus === 'cycle') {
      // The recovery owner, not the page reader, decides when to restart. A
      // cleared cursor makes the next scheduled recovery begin a fresh cycle.
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
    } else if (curatorRosterStatus === undefined && legacyPagination.nextPageAfterPeerId) {
      // Preserve custom SDK implementations that still return the prior fields.
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
      this.vmReconcileCuratorPageCursorByCg.set(localCgId, legacyPagination.nextPageAfterPeerId);
    }
    if (!curatorResolution.curatorIsLocal) {
      if (curatorPeerIds.length > 0) {
        this.vmReconcileCuratorPeersByCg.delete(localCgId);
        this.vmReconcileCuratorPeersByCg.set(localCgId, curatorPeerIds);
      } else {
        // Without the durable phonebook an empty curator tier usually means
        // the owner's profile was never fetched, and this pass can only ask
        // peers it is already connected to. One bounded phonebook fetch serves
        // every graph; its completion re-schedules this graph's recovery.
        this.requestOnDemandAgentsPhonebook(localCgId, 'vm-reconcile');
      }
    }
    this.pruneVmReconcileState();

    const connectedByPeerId = new Map(
      this.node.libp2p.getConnections()
        .map((connection) => [connection.remotePeer.toString(), connection.remotePeer]),
    );
    // Use the exact same memory-only canonicalizer as the suppression gate.
    // Curator resolution may connect a missing peer, but it must not substitute
    // a different ranking algorithm and invalidate an otherwise stable roster.
    const orderedPeerIds = this.vmReconcileObservedCandidatePeerIds(localCgId);
    // Only an explicit experimental run may reorder these existing capped
    // transport candidates. The proof roster and every target's independent
    // attempted/absence credits stay unchanged. Identify does not prove data.
    const experimentalStreamPeerIds = new Set<string>();
    // Observation only: why this pass did or did not choose the stream wire.
    let streamAdvertisedCount = 0;
    const advertisedStreamPeers = new Set<string>();
    // The registered-public answer that gates the stream wire. Retry eligibility, the wire
    // choice and the log label all derive from this one typed observation.
    const passAuthority = new VmRecoveryPassAuthority(undefined, undefined, experimentPolicy.authorityRetry);
    const readRegisteredPublicAuthority = async (): Promise<void> => {
      await phases.measure('authority', () => passAuthority.read(() => this.resolveRegisteredContextGraphAuthority(localCgId, {
        authorityReadMode: 'finalized-index-or-live', signal,
      })));
      if (passAuthority.isPublic && isRecoveryCurrent()) {
        for (const advertisedPeerId of advertisedStreamPeers) experimentalStreamPeerIds.add(advertisedPeerId);
      }
    };
    const prepareThisPassTargets = (): void => {
      if (!experimentPolicy.prefetchEnabled || orderedPeerIds.length === 0) return;
      // The planner sizes this pass's own targets as soon as a provider is chosen.
      // Start that early, but never ahead of the registered-authority read that gates
      // the wire: a miss there costs far more than the sizing it would overlap. The
      // first target keeps its own live read (a probe sizes its single asset itself),
      // so preparing never adds a read the unprepared path would not make. Pure
      // metadata: nothing is marked handled or attempted.
      transportPreparation?.preparePass(currentTargets
        .slice(1)
        .map((candidate) => ({ kaId: candidate.kaId })));
    };
    if (resolveExactBatchStreamEnabled()) {
      const transportInterval = phases.begin();
      const advertised = await Promise.all(orderedPeerIds
        .filter((peerId) => connectedByPeerId.has(peerId)
          && this.peerCapabilityRegistry.supportsCore(peerId)
          && !exactBatchStreamUnsupported(this, peerId, this.getSyncReconcilerConnectionKey(peerId), Date.now(),
            this.captureExperimentalExactBatchRefusalScope(localCgId)))
        .map(async (peerId) => {
          try { return (await this.getPeerProtocols(peerId)).includes(EXACT_BATCH_STREAM_PROTOCOL) ? peerId : undefined; }
          catch { return undefined; }
        }));
      phases.chargeSince('transport', transportInterval.startedAt, transportInterval.before);
      streamAdvertisedCount = advertised.filter((peerId) => peerId !== undefined).length;
      if (streamAdvertisedCount > 0) {
        for (const advertisedPeerId of advertised) {
          if (advertisedPeerId !== undefined) advertisedStreamPeers.add(advertisedPeerId);
        }
        await readRegisteredPublicAuthority();
        if (!isRecoveryCurrent()) return staleRecovery();
        prepareThisPassTargets();
        if (experimentPolicy.authorityRetry.kind === 'spaced' && passAuthority.missed) {
          // A miss here is usually the shared local request budget, not the graph: the
          // read's detached resolution keeps warming the projection cache after its
          // deadline. Give it a short, bounded moment and ask once more before the
          // pass commits to the legacy singleton wire for every provider it tries.
          const retry = await phases.measure('authority', () => passAuthority.waitForMissRetry(signal));
          if (!isRecoveryCurrent()) return staleRecovery();
          if (retry) await readRegisteredPublicAuthority();
          if (!isRecoveryCurrent()) return staleRecovery();
        }
      }
    }
    prepareThisPassTargets();

    // Curator preparation may have grown or shrunk the connected candidate
    // set. Re-evaluate every target against that observed change. Any roster
    // change breaks backoff and starts a fresh proof cycle.
    const preparedEntries = currentTargets
      .map((target, index) => ({
        index,
        target,
        hasOwnedRecord: initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)),
      }))
      // At a full cap, give deferred targets first claim on an expired slot.
      // Otherwise an expired owner encountered first would renew itself before
      // any waiter could enter, starving stable-order overflow indefinitely.
      .sort((left, right) => Number(left.hasOwnedRecord) - Number(right.hasOwnedRecord)
        || admissionDistance(left.index) - admissionDistance(right.index))
      .map(({ index, target }) => ({
        index,
        target,
        prepared: this.prepareVmReconcileRotationTarget(
          target,
          orderedPeerIds,
          this.vmReconcileRotationNow(),
          resolutionSucceeded,
        ),
      }))
      .sort((left, right) => left.index - right.index);
    const newlyAdmitted = preparedEntries
      .filter(({ target, prepared }) => prepared.record
        && !initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)));
    if (newlyAdmitted.length > 0) {
      const lastAdmitted = newlyAdmitted.reduce((latest, entry) => (
        admissionDistance(entry.index) > admissionDistance(latest.index) ? entry : latest
      ));
      this.vmReconcileRotationAdmissionCursorByCg.delete(localCgId);
      this.vmReconcileRotationAdmissionCursorByCg.set(
        localCgId,
        (lastAdmitted.index + 1) % currentTargets.length,
      );
    }
    const eligible = preparedEntries
      .map((entry) => {
        const { record } = entry.prepared;
        if (
          record
          && this.vmReconcileRotationState.get(entry.prepared.slotKey) !== record
        ) {
          // A later slot may have replaced an expired record while the batch
          // was prepared. Defer the now-unowned target: elevated transport
          // without retained retry state would violate the pressure bound.
          return {
            ...entry,
            prepared: { slotKey: entry.prepared.slotKey, suppressed: true },
          };
        }
        return entry;
      })
      .filter((entry) => !entry.prepared.suppressed)
      // Installed collecting records get first use of the bounded peer set so
      // overflow cannot consume the one peer they still need to complete. The
      // original target order remains stable within each class.
      .sort((left, right) => {
        const leftInstalled = left.prepared.record
          && this.vmReconcileRotationState.get(left.prepared.slotKey) === left.prepared.record
          ? 1 : 0;
        const rightInstalled = right.prepared.record
          && this.vmReconcileRotationState.get(right.prepared.slotKey) === right.prepared.record
          ? 1 : 0;
        return rightInstalled - leftInstalled || left.index - right.index;
      });

    const outcomes = new Map<number, OrdinalOutcome>();
    const attemptedOrdinals = new Set<number>();
    // A clean exact hit proves only that this peer held the requested asset,
    // not the whole CG. It is nevertheless the best bounded candidate for one
    // byte/leaf-aware microbatch of untouched targets in this same slice. One
    // clean absence or incomplete response removes the hint immediately.
    const providerPolicy = new VmRecoveryProviderPolicy();
    const handledBatchOrdinals = new Set<number>();
    let recoveryWorkRan = false;
    let localAdmissionDeferred = false;

    for (let eligibleIndex = 0; eligibleIndex < eligible.length; eligibleIndex += 1) {
      if (!isRecoveryCurrent()) break;
      const entry = eligible[eligibleIndex]!;
      const { target } = entry;
      if (handledBatchOrdinals.has(target.ordinal)) continue;
      const batchTiming = timing.beginBatch();
      const record = entry.prepared.record;
      const installedRecord = record
        && this.vmReconcileRotationState.get(this.vmReconcileRotationSlotKey(target)) === record
        ? record
        : undefined;
      const candidatePeerIds = installedRecord
        ? [...installedRecord.candidatePeerIds]
        : orderedPeerIds;

      // Rotate every physical outcome, including incomplete responses, without
      // conflating the attempt cursor with clean-absence evidence. Try the
      // target's next available peer. Protocol/admission failures remain
      // uncredited, but consume this target's turn so another missing KA gets
      // the next physical peer slot in the same bounded pass.
      let peerId: string | undefined;
      if (
        advertisedStreamPeers.size > 0
        && passAuthority.retryDue()
      ) {
        // One pass can try several providers over minutes, and every wire choice below
        // follows this single registered-public observation. A transient miss at pass
        // start (the read shares a saturated local request budget; its detached
        // resolution keeps warming the projection cache) would otherwise pin every
        // later provider of the pass to the legacy singleton wire. Read it again, at
        // most once per interval, before choosing the next provider.
        await readRegisteredPublicAuthority();
        if (!isRecoveryCurrent()) return staleRecovery();
      }
      const candidatePeerId = this.selectVmReconcileExactCandidate(
        installedRecord,
        orderedPeerIds,
        providerPolicy,
        { localCgId, onChainCgId: expectedOnChainCgId, experimentalStreamPeerIds },
      );
      // One policy capture owns every later transition and token fence.
      const preferenceAttempt = this.vmReconcilePublicCoreTransportPreferencePolicy.capture(
        localCgId, expectedOnChainCgId, orderedPeerIds,
      );
      if (candidatePeerId) {
        let connectedPeer = connectedByPeerId.get(candidatePeerId);
        if (!connectedPeer) {
          await phases.measure('peer-ready', () => this.ensurePeerConnected(candidatePeerId, { signal }).catch((error) => {
            this.log.info(
              ctx,
              `VM exact fetch could not connect candidate peer ${candidatePeerId.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }));
          if (!isRecoveryCurrent()) return staleRecovery();
          const connection = this.node.libp2p.getConnections()
            .find((candidate) => candidate.remotePeer.toString() === candidatePeerId);
          connectedPeer = connection?.remotePeer;
          if (connectedPeer) connectedByPeerId.set(candidatePeerId, connectedPeer);
        }
        recoveryWorkRan = true;
        const protocolReady = connectedPeer
          ? await phases.measure('peer-ready', () => this.waitForSyncProtocol(connectedPeer!, signal))
          : false;
        if (!isRecoveryCurrent()) return staleRecovery();
        if (!connectedPeer || !protocolReady) {
          providerPolicy.markUnavailable(candidatePeerId);
        } else {
          // Network boundary: a merely-connected peer is not necessarily
          // admitted to this DKG network. Never send an authenticated exact
          // request to an unverified or rejected peer.
          const peerAdmitted = await phases.measure('peer-ready', () => this.ensurePeerAdmittedForRecovery(
            candidatePeerId,
            ctx,
            'VM exact fetch',
            signal,
          ));
          if (!isRecoveryCurrent()) return staleRecovery();
          if (!peerAdmitted) providerPolicy.markUnavailable(candidatePeerId);
          else peerId = candidatePeerId;
        }
      }
      if (!peerId) {
        if (candidatePeerId) {
          this.vmReconcilePublicCoreTransportPreferencePolicy.revoke(preferenceAttempt, candidatePeerId);
        }
        // A failed connection/protocol/network-admission probe still consumes
        // its bounded provider turn. A ready peer is marked only by the exact
        // executor after local sync capacity admits its physical work.
        if (candidatePeerId) {
          attemptedOrdinals.add(target.ordinal);
          if (installedRecord) {
            installedRecord.lastAttemptedPeerId = candidatePeerId;
            installedRecord.attemptedPeerIds.add(candidatePeerId);
            installedRecord.collectionDeadlineAt = this.vmReconcileRotationNow()
              + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
            this.touchVmReconcileRotationRecord(this.vmReconcileRotationSlotKey(target), installedRecord);
          }
        }
        if (installedRecord) {
          this.settleVmReconcileRotationAttempt(
            target,
            undefined,
            'incomplete',
            candidatePeerIds,
            installedRecord,
            providerPolicy.unavailablePeerIds(),
          );
        }
        continue;
      }
      const carriedHolder = this.vmReconcilePublicCoreTransportPreferencePolicy.canReuse(
        preferenceAttempt, peerId, candidatePeerIds,
      );
      if (carriedHolder) providerPolicy.seedProvenHolder(peerId);
      const providerAttempt = providerPolicy.beginAttempt(peerId);
      if (!providerAttempt) continue;
      const admittedConnectionKey = this.getSyncReconcilerConnectionKey(peerId);
      // Choose the admitted singleton probe or rotation-compatible holder
      // prefix before sizing; one pipeline owns its selection and wire mode.
      const candidateAttempts: VmRecoveryBatchAttempt[] = [];
      if (providerAttempt.kind === 'probe') {
        candidateAttempts.push({ entry, installedRecord, candidatePeerIds });
      } else {
        for (let candidateIndex = eligibleIndex; candidateIndex < eligible.length; candidateIndex += 1) {
          const candidateEntry = eligible[candidateIndex]!;
          const candidateTarget = candidateEntry.target;
          if (handledBatchOrdinals.has(candidateTarget.ordinal)) continue;
          const candidateRecord = candidateEntry.prepared.record;
          const candidateInstalledRecord = candidateRecord
            && this.vmReconcileRotationState.get(
              this.vmReconcileRotationSlotKey(candidateTarget),
            ) === candidateRecord
            ? candidateRecord
            : undefined;
          // The current target already passed connection/network admission.
          // Later candidates must still prove
          // this peer remains uncredited in their independent rotation record.
          const peerEligible = candidateIndex === eligibleIndex
            || (candidateInstalledRecord
              ? this.vmReconcileUncreditedCandidateOrder(candidateInstalledRecord).includes(peerId)
              : orderedPeerIds.includes(peerId));
          if (!peerEligible) break;
          candidateAttempts.push({
            entry: candidateEntry,
            installedRecord: candidateInstalledRecord,
            candidatePeerIds: candidateInstalledRecord
              ? [...candidateInstalledRecord.candidatePeerIds]
              : orderedPeerIds,
          });
        }
      }
      const streamEligibleProvider = passAuthority.isPublic && experimentalStreamPeerIds.has(peerId)
        && !exactBatchStreamUnsupported(this, peerId, admittedConnectionKey, Date.now(),
          this.captureExperimentalExactBatchRefusalScope(localCgId));
      let transportPlan: Awaited<ReturnType<typeof planVmRecoveryTransport<VmRecoveryBatchAttempt>>>;
      transportPlan = await phases.measure('sizing', () => planVmRecoveryTransport({
        candidates: candidateAttempts.map(attempt => ({
          attempt, kaId: attempt.entry.target.kaId, assetUal: attempt.entry.target.ual,
        })),
        providerAttemptKind: providerAttempt.kind, onChainCgId,
        streamEligible: streamEligibleProvider, registeredPublicAccess: passAuthority.isPublic,
        legacyAttemptTimeoutMs: this.vmReconcileTransportBudgetPolicy.timeoutFor({
          target, peerId, providerAttemptKind: providerAttempt.kind,
          registeredPublicAccess: passAuthority.isPublic,
          competingStreamAvailable: experimentalStreamPeerIds.size > 0
            && !experimentalStreamPeerIds.has(peerId),
          streamEligible: streamEligibleProvider,
        }),
        signal, isCurrent: isRecoveryCurrent,
        observeSizing: batchTiming.observeSizing,
        // Start reads in candidate order with a small bound so each read's
        // deadline measures its own round trip, not its wait in the local
        // RPC governor behind earlier candidates.
        ...experimentPolicy.sizing,
        ...(experimentPolicy.prefetchEnabled ? {
          probeRemainder: eligible.slice(eligibleIndex + 1)
            .filter(candidate => !handledBatchOrdinals.has(candidate.target.ordinal))
            .map(candidate => ({ kaId: candidate.target.kaId })),
        } : {}),
      }, {
        createSizingReader: () => {
          const readContext = this.chain.getKnowledgeAssetUpdateContext;
          return typeof readContext === 'function'
            ? { readUpdateContext: (kaId, readOptions) => readContext.call(this.chain, kaId, readOptions) }
            : null;
        },
        resolvePublicAccess: async contextGraphId => (await withRpcUsageSite(
          CG_AUTH_RPC_SITES.vmSizing,
          // This bounded observation controls soft sizing only. Canonical
          // root/version/binding authority is still checked per asset.
          () => this.readLiveOnChainAccessPolicy(
            contextGraphId.toString(), ctx, { freshness: 'bounded' },
          ),
        )) === 0,
        preparation: transportPreparation,
      }));
      if (!isRecoveryCurrent()) return providerAttempt.kind === 'probe' ? staleRecovery() : noRecovery();
      const {
        attempts: batchAttempts, transportMode: exactRecoveryTransportMode,
        publicAccessEvidence: publicRecoveryAccessVerified, packing, legacyAttemptTimeoutMs,
      } = transportPlan;
      if (batchAttempts.length === 0) {
        this.vmReconcilePublicCoreTransportPreferencePolicy.revoke(preferenceAttempt, peerId);
        this.log.warn(
          ctx,
          `VM exact recovery selector for "${localCgId}" exceeds the executor cap; `
            + `ordinal=${target.ordinal} selectorCap=${VM_EXACT_MICROBATCH_LIMITS.maxSelectorBytes}`,
        );
        if (installedRecord) {
          this.settleVmReconcileRotationAttempt(
            target,
            undefined,
            'incomplete',
            candidatePeerIds,
            installedRecord,
            providerPolicy.unavailablePeerIds(),
          );
        }
        providerPolicy.finishAttempt(
          providerAttempt,
          'incomplete',
          new Map<string, VmRecoveryUalDisposition>([[target.ual, 'incomplete']]),
        );
        continue;
      }
      observeVmRecoveryTiming(() => this.log.info(
        ctx,
        `VM exact recovery transport for "${localCgId}" from ${peerId.slice(-8)}: kind=${providerAttempt.kind} `
          + `transport=${exactRecoveryTransportMode} assets=${batchAttempts.length} `
          + `streamAdvertised=${streamAdvertisedCount} streamPeers=${experimentalStreamPeerIds.size} `
          + `registeredAuthority=${passAuthority.label}`,
      ));
      if (packing !== undefined) {
        this.log.info(
          ctx,
          `VM exact recovery plan for "${localCgId}" from ${peerId.slice(-8)}: `
            + `assets=${batchAttempts.length} estimatedBytes=${packing.estimatedBytes} `
            + `estimatedLeaves=${packing.estimatedLeaves} `
            + `completeFootprints=${packing.completeFootprints} transport=${exactRecoveryTransportMode}`,
        );
      }

      if (carriedHolder && !this.vmReconcilePublicCoreTransportPreferencePolicy.revalidateReuse(
        preferenceAttempt, peerId, admittedConnectionKey,
      )) {
        // Sizing outlived the captured holder proof; the next slice must probe.
        if (activeFetchCooldownOwner !== undefined) {
          this.clearVmReconcileActiveFetchCooldown(localCgId, activeFetchCooldownOwner);
        }
        return {
          outcomes, attemptedOrdinals: [...attemptedOrdinals],
          continuationOrdinal: target.ordinal, hasImmediateRecoveryWork: true, cooldownOnly: false,
        };
      }
      // Only while preparation is on: the exchange may rely on this pass's own fresh positive
      // answer instead of reading it again. The handle dies with the exchange.
      const registeredPublicEvidence = experimentPolicy.sharePassAuthorityEvidence
        ? passAuthority.evidence({ contextGraphId: localCgId, signal, isCurrent: isRecoveryCurrent })
        : undefined;
      const execution = await this.executeVmRecoveryBatch({
        localCgId,
        onChainCgId,
        peerId,
        attempts: batchAttempts,
        unavailablePeerIds: [...providerPolicy.unavailablePeerIds()],
        headBlock,
        signal,
        isRecoveryCurrent,
        revalidateTarget,
        ctx,
        exactRecoveryTransportMode,
        ...(legacyAttemptTimeoutMs === undefined ? {} : { legacyAttemptTimeoutMs }),
        ...(registeredPublicEvidence ? { registeredPublicEvidence } : {}),
        phases,
      }).finally(() => registeredPublicEvidence?.revoke());
      if (execution.kind === 'local-admission-deferred') {
        // Capacity is node-local, so trying other providers would burn their
        // turns under the same refusal. Retain all peer evidence and yield the
        // whole slice for the scheduler's bounded local retry.
        localAdmissionDeferred = true;
        break;
      }
      if (execution.kind !== 'completed' || !isRecoveryCurrent()) return staleRecovery();
      batchTiming.complete({ peerId, assets: batchAttempts.length,
        candidates: eligible.length - eligibleIndex, kind: providerAttempt.kind,
        transport: exactRecoveryTransportMode, streamAdvertised: streamAdvertisedCount,
        streamPeers: experimentalStreamPeerIds.size, registeredAuthority: passAuthority.label });
      for (const [ordinal, outcome] of execution.outcomes) outcomes.set(ordinal, outcome);
      for (const ordinal of execution.handledOrdinals) handledBatchOrdinals.add(ordinal);
      for (const ordinal of execution.attemptedOrdinals) attemptedOrdinals.add(ordinal);
      if (execution.providerTurnKept) {
        // Busy or a broken stream: the peer is not spent for this slice. It is
        // asked again, with a fresh probe, once its hold-off has passed.
        providerPolicy.releaseAttempt(providerAttempt);
      } else {
        providerPolicy.finishAttempt(
          providerAttempt,
          execution.providerDisposition,
          new Map(execution.perUalDispositions),
        );
      }
      const completelyVerified = execution.providerDisposition === 'found'
        && execution.perUalDispositions.length === batchAttempts.length
        && execution.perUalDispositions.every(([, disposition]) => disposition === 'found');
      const preferenceSettlement = this.vmReconcilePublicCoreTransportPreferencePolicy.settle(preferenceAttempt, {
        peerId, connectionKey: admittedConnectionKey, completelyVerified,
        publicAccessVerified: publicRecoveryAccessVerified,
        reusedHolder: providerAttempt.kind === 'proven-holder-reuse', carriedHolder,
      });
      if (preferenceSettlement.yield) {
        this.log.info(ctx, `VM exact recovery yield: reason=verified-core-turn assets=${batchAttempts.length} `
          + `publicSizingAccess=${publicRecoveryAccessVerified === undefined ? 'unknown' : publicRecoveryAccessVerified} `
          + `holderCreditPresent=${preferenceSettlement.holderCreditPresent}`);
        break;
      }
    }

    const eligibleOrdinals = new Set(eligible.map(({ target }) => target.ordinal));
    const unattemptedContinuationOrdinal = currentTargets.find((target) =>
      eligibleOrdinals.has(target.ordinal) && !attemptedOrdinals.has(target.ordinal))?.ordinal;
    const hasImmediateRecoveryWork = eligible.some(({ target }) => {
      const outcome = outcomes.get(target.ordinal);
      const record = this.vmReconcileRotationState.get(
        this.vmReconcileRotationSlotKey(target),
      );
      if (
        record?.phase !== 'collecting'
        || record.fingerprint !== this.vmReconcileRotationFingerprint(target)
        || this.vmReconcileUncreditedCandidateOrder(record).length === 0
      ) return false;
      // When revalidation ran, it must still describe the same pending target.
      // A protocol/admission failure can consume an attempt before producing
      // an outcome; the matching retained record is then sufficient proof that
      // another bounded provider attempt remains immediately runnable.
      return outcome === undefined
        ? attemptedOrdinals.has(target.ordinal)
        : outcome.status === 'pending'
          && outcome.recovery !== undefined
          && this.vmReconcileRecoveryTargetMatches(target, outcome.recovery);
    });
    const continuationOrdinal = unattemptedContinuationOrdinal;

    // Mirror the inline path's cooldown policy, but do not turn a bounded peer
    // slice into a one-minute stall while the retained rotation record proves
    // there is novel work left. Each trailing pass still obeys the hard peer,
    // ordinal and global-sync admission caps; it merely reaches the next target
    // or untried provider without waiting for the periodic safety-net sweep.
    // Once every retained provider cycle is exhausted, the ordinary cooldown /
    // negative backoff applies exactly as before.
    if (!isRecoveryCurrent()) return staleRecovery();
    if (localAdmissionDeferred) {
      if (activeFetchCooldownOwner !== undefined) {
        this.clearVmReconcileActiveFetchCooldown(localCgId, activeFetchCooldownOwner);
      }
      return {
        outcomes,
        attemptedOrdinals: [...attemptedOrdinals],
        continuationOrdinal: unattemptedContinuationOrdinal,
        hasImmediateRecoveryWork: false,
        cooldownOnly: false,
        localAdmissionDeferred: true,
      };
    }
    const recoveredAny = [...outcomes.values()]
      .some((outcome) => outcome.status === 'reconciled' || outcome.status === 'already');
    if (
      !recoveryWorkRan
      || recoveredAny
      || continuationOrdinal !== undefined
      || hasImmediateRecoveryWork
    ) {
      if (activeFetchCooldownOwner !== undefined) {
        this.clearVmReconcileActiveFetchCooldown(localCgId, activeFetchCooldownOwner);
      }
    } else {
      if (
        activeFetchCooldownOwner !== undefined
        && this.readVmReconcileActiveFetchCooldown(localCgId)?.owner === activeFetchCooldownOwner
      ) {
        this.installVmReconcileActiveFetchCooldown(localCgId, Date.now());
      }
    }
    timing.finish(eligible.length, preparation ? () => preparation.stats() : undefined);
    return {
      outcomes,
      attemptedOrdinals: [...attemptedOrdinals],
      // Continue only at work that this eligible pass did not attempt. Pending
      // attempts are rotated inside `remaining` to give untouched targets the
      // next peer, but once every submitted target has consumed one attempt
      // the outer fair scan must wrap from its watermark on the next cycle.
      continuationOrdinal,
      hasImmediateRecoveryWork,
      cooldownOnly: false,
    };
  }

  /**
   * Reconcile a single per-CG registration ordinal: resolve the kaId + its
   * latest on-chain merkle root + publisher, build the UAL, and ask the
   * finalization handler to promote the matching local SWM snapshot to VM
   * (verifying the CG binding from chain). When no local SWM matches, run an
   * queue the exact target for bounded batch recovery. A successful result is
   * validated against one coherent pinned version snapshot before it earns a
   * same-finalized-block shortcut; a new block always reads again. `headBlock`
   * remains the independent cursor observation for the reorg-depth gate. See
   * {@link OrdinalOutcome} for the status contract.
   *
   * Local first: before any root, publisher or version read, the handler
   * classifies what the store holds for the KA. A confirmed VM copy with
   * nothing else to promote settles as `already`, and an
   * asset held nowhere locally goes straight to the exact-recovery queue, both
   * without chain reads. Only local state whose outcome depends on the root
   * takes the chain-backed path below.
   */
  async reconcileChainOrdinal(this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options: VmReconcileOrdinalOptions = {},
  ): Promise<OrdinalOutcome> {
    const ctx = createOperationContext('system');
    const versionBlock = headBlock ?? 0;
    this.pruneVmReconcileState();

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }

    const unresolvable = (err: unknown): OrdinalOutcome => {
      // RPC lag / unknown kaId — leave for the next sweep.
      options.onUnresolvable?.(err);
      this.log.info(ctx, `Phase B: ordinal ${ordinal} of cg ${onChainCgId} not resolvable yet: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'pending' };
    };
    let kaId: bigint;
    let storageAddr: string | undefined;
    let ual: string;
    try {
      kaId = await this.chain.getContextGraphKCAt!(onChainCgId, BigInt(ordinal));
      storageAddr = this.chain.getDKGKnowledgeAssetsAddress
        ? await this.chain.getDKGKnowledgeAssetsAddress()
        : undefined;
      if (!storageAddr) return { status: 'skip' };
      ual = buildReconciledKnowledgeAssetUal(this.chain.chainId, storageAddr, kaId);
    } catch (err) {
      return unresolvable(err);
    }

    const fh = this.getOrCreateFinalizationHandler();
    // A core that holds only its StorageACK copy of a sub-graph KA has no
    // lifecycle or VM metadata naming the sub-graph; its ledger does.
    const ledgerSubGraphName = await this.storageAckLedgerSubGraphName(localCgId, ual);
    const targetMayMaterialize = async (): Promise<boolean> => {
      if (options.isTargetCurrent && !options.isTargetCurrent()) return false;
      if (!options.revalidateTarget) return true;
      try {
        return await options.revalidateTarget();
      } catch {
        return false;
      }
    };

    // Handlers without the classifier (older hosts, narrow test doubles) keep
    // the chain-backed path for every ordinal.
    const localCandidate: ChainReconcileLocalCandidate =
      typeof fh.classifyChainReconcileLocalCandidate === 'function'
        ? await fh.classifyChainReconcileLocalCandidate({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          ual,
          kaId,
          batchId: kaId,
          ...(ledgerSubGraphName ? { subGraphName: ledgerSubGraphName } : {}),
        }, ctx)
        : { kind: 'present' };
    if (localCandidate.kind === 'confirmed-vm') {
      // Trusted at the root the copy was confirmed at, with no chain read. An
      // update to it reaches VM through the `KnowledgeAssetUpdated` refresh
      // (`handleKAUpdatedNudge`), not through this walk: a settled ordinal is
      // never visited again.
      if (!(await targetMayMaterialize())) return { status: 'skip' };
      this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
      this.emitReplication({
        contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
        action: 'already', ordinal, kaId: kaId.toString(), ual, detail: 'local-vm',
      });
      return { status: 'already', blockNumber: headBlock ?? 0 };
    }
    if (localCandidate.kind === 'none') {
      // Nothing local can match any root, so the chain-backed path could only
      // answer `no-swm`. Queue the same exact-recovery target it would; the
      // recovery batch keeps its rotation backoff, cooldown and peer gating.
      if (!(await targetMayMaterialize())) return { status: 'skip' };
      this.emitReplication({
        contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
        action: 'defer', ordinal, kaId: kaId.toString(), ual, detail: 'no-local-copy',
      });
      return {
        status: 'pending',
        recovery: {
          localCgId,
          onChainCgId: onChainCgId.toString(),
          ordinal,
          ual,
          merkleRoot: VM_RECONCILE_UNREAD_MERKLE_ROOT,
          kaId: kaId.toString(),
          reason: 'no-swm',
        },
      };
    }
    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }

    let merkleRoot: Uint8Array;
    let publisherAddress: string;
    let finalizedSlotBlock: number | undefined;
    let cacheKey = '';
    try {
      finalizedSlotBlock = this.vmReconcileFinalizedBlockAtHead(headBlock);
      if (finalizedSlotBlock !== undefined) {
        const finalizedSlotKey = this.vmReconcileFinalizedSlotKey(
          localCgId,
          onChainCgId,
          ordinal,
        );
        const evidence = this.vmReconcileFinalizedSlotEvidence.get(finalizedSlotKey);
        if (evidence !== undefined) {
          let current = false;
          if (
            evidence.kaId === kaId
            && evidence.snapshot.blockNumber === finalizedSlotBlock
            && typeof evidence.snapshot.knowledgeAssetStorageAddress === 'string'
            && ethers.isAddress(storageAddr)
            && ethers.isAddress(evidence.snapshot.knowledgeAssetStorageAddress)
            && ethers.getAddress(storageAddr)
              === ethers.getAddress(evidence.snapshot.knowledgeAssetStorageAddress)
            && this.chain.knowledgeAssetVersionSnapshotIsCurrent
          ) {
            try {
              current = await this.chain.knowledgeAssetVersionSnapshotIsCurrent(
                kaId,
                evidence.snapshot,
              );
            } catch {
              // Optimization-only lease unavailable: preserve the unchanged live
              // root/publisher/materialization path below.
            }
          }
          if (options.isTargetCurrent && !options.isTargetCurrent()) {
            return { status: 'skip' };
          }
          if (current) {
            this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
            return { status: 'already', blockNumber: headBlock! };
          }
          this.vmReconcileFinalizedSlotEvidence.delete(finalizedSlotKey);
        }
      }

      merkleRoot = await this.chain.getLatestMerkleRoot!(kaId);
      cacheKey = this.vmReconcileCacheKey(localCgId, ual, merkleRoot);

      publisherAddress = (this.chain.getLatestMerkleRootPublisher
        ? await this.chain.getLatestMerkleRootPublisher(kaId)
        : '') ?? '';
    } catch (err) {
      return unresolvable(err);
    }

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }
    const reconcileInput = {
      contextGraphId: localCgId,
      onChainCgId: onChainCgId.toString(),
      ual,
      merkleRoot,
      publisherAddress,
      kaId,
      // V10 context-graph inventory stores one packed KA per batch.
      batchId: kaId,
      versionBlock,
      ...(ledgerSubGraphName ? { subGraphName: ledgerSubGraphName } : {}),
    };

    // The sweep fails its whole pass on the first ordinal that throws. A
    // corrupt SWM head is one KA's local damage: report it and leave only this
    // ordinal pending, so the rest of the graph keeps reconciling.
    const reconcileKnowledgeAsset = async (): Promise<ChainReconciledKCOutcome | undefined> => {
      try {
        return await fh.handleChainReconciledKC(reconcileInput, ctx);
      } catch (err) {
        if (!isKnowledgeAssetWorkspaceHeadCorruptError(err)) throw err;
        this.log.warn(
          ctx,
          `Phase B: corrupt graph-scoped SWM head for ${ual} (ordinal ${ordinal} of cg ${onChainCgId}); `
            + `leaving it for the next sweep: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          action: 'defer',
          ordinal,
          kaId: kaId.toString(),
          ual,
          detail: 'corrupt-swm-head',
        });
        return undefined;
      }
    };

    if (!(await targetMayMaterialize())) return { status: 'skip' };
    const outcome = await reconcileKnowledgeAsset();
    if (outcome === undefined) return { status: 'pending' };
    if (outcome === 'no-swm' || outcome === 'verified-vm-metadata-pending') {
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: onChainCgId.toString(),
        action: 'defer',
        ordinal,
        kaId: kaId.toString(),
        ual,
        detail: outcome,
      });
      return {
        status: 'pending',
        recovery: {
          localCgId,
          onChainCgId: onChainCgId.toString(),
          ordinal,
          ual,
          merkleRoot: Array.from(
            merkleRoot,
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
          kaId: kaId.toString(),
          reason: outcome,
        },
      };
    }

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }

    // Cursor finality remains tied to this sweep's raw head observation. The
    // pinned version block orders materialized metadata but must not shorten
    // the independent reconciliation confirmation-depth gate.
    const completionBlock = headBlock ?? 0;
    const rememberSlotBlock = options.rememberFinalizedEvidence === false
      ? undefined
      : finalizedSlotBlock;
    switch (outcome) {
      case 'promoted':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        await this.confirmAndRememberVmReconcileFinalizedSlot(
          localCgId,
          onChainCgId,
          ordinal,
          rememberSlotBlock,
          kaId,
          merkleRoot,
          publisherAddress,
        );
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'promote', ordinal, kaId: kaId.toString(), ual,
        });
        return { status: 'reconciled', blockNumber: completionBlock };
      case 'already-confirmed':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        await this.confirmAndRememberVmReconcileFinalizedSlot(
          localCgId,
          onChainCgId,
          ordinal,
          rememberSlotBlock,
          kaId,
          merkleRoot,
          publisherAddress,
        );
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'already', ordinal, kaId: kaId.toString(), ual,
        });
        return { status: 'already', blockNumber: completionBlock };
      case 'stale-target':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        // A newer root won; do not prune its cache/recent state.
        this.recentReconciledUals.add(cacheKey);
        await this.confirmAndRememberVmReconcileFinalizedSlot(
          localCgId,
          onChainCgId,
          ordinal,
          rememberSlotBlock,
          kaId,
          merkleRoot,
          publisherAddress,
        );
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'already', ordinal, kaId: kaId.toString(), ual,
        });
        return { status: 'already', blockNumber: completionBlock };
      case 'receipt-revalidation-pending':
      case 'unverified':
      default:
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'defer', ordinal, kaId: kaId.toString(), ual, detail: outcome,
        });
        return { status: 'pending' };
    }
  }

  /**
   * OT-RFC-39 — build the per-tick auto-backfill closure handed to the
   * Random Sampling prover via {@link bindRandomSampling}. The closure
   * is invoked when `extractCiphertextChunksFromStore` reports
   * `CiphertextChunksMissingError`; it pulls the missing chunks from
   * authorized peers and persists them so the prover's one-shot retry
   * can build the proof.
   *
   * Peer discovery uses the same source the publish path uses:
   * `gossip.getSubscribers(contextGraphWorkspaceTopic(wireId))`. Every
   * authorized hosting core subscribes to that topic to receive the
   * chunked-publish gossip, so the subscriber snapshot is the natural
   * "who can answer me right now" set. Falls back to "no peers" when
   * the local cleartext CG id is unknown (chain replay hasn't caught
   * up yet) — the prover then logs `kc-not-synced` and re-ticks in
   * 30s, by which time the chain handler has populated
   * `subscribedContextGraphs`.
   *
   * Authorization happens on the RESPONDER side
   * (`handleGetCiphertextChunk`): every peer the requester contacts
   * verifies the request's recovered EOA against the on-chain
   * participant set / beacon curator / agent-gate / allowedPeers.
   * Requesters that aren't in any authority set get a `denied` ACK
   * and we skip to the next peer.
   *
   * Cap policy: one fetch per missing chunk per peer; iterate peers
   * until a chunk lands or we exhaust the list. No retries inside the
   * hook — the prover's outer 30s loop is the natural retry boundary.
   */
  buildCiphertextChunkBackfill(this: DKGAgent,
    ctx: OperationContext,
  ): (req: { cgId: bigint; batchId: Uint8Array; missingIndexes: number[] }) => Promise<{ fetched: number; failures: number; reason?: string }> {
    return async ({ cgId, batchId, missingIndexes }) => {
      if (missingIndexes.length === 0) return { fetched: 0, failures: 0 };

      const localCgId = this.resolveLocalCgIdByOnChainId(cgId);
      if (!localCgId) {
        return {
          fetched: 0,
          failures: missingIndexes.length,
          reason: 'cg-not-locally-registered',
        };
      }

      const wireId = this.gossipWireIdFor(localCgId);
      const workspaceTopic = contextGraphWorkspaceTopic(wireId);
      let selfPeer: string | null = null;
      try { selfPeer = this.peerId; } catch { /* pre-start */ }
      const allSubscribers = this.gossip.getSubscribers(workspaceTopic);
      const candidatePeers = Array.from(new Set(
        allSubscribers.filter((p) => p && p !== selfPeer),
      ));

      if (candidatePeers.length === 0) {
        return {
          fetched: 0,
          failures: missingIndexes.length,
          reason: 'no-peers',
        };
      }

      const batchIdHex = ethers.hexlify(batchId).slice(0, 18);
      this.log.info(
        ctx,
        `LU-11 backfill start cg=${localCgId} batchId=${batchIdHex}... missing=${missingIndexes.length} peers=${candidatePeers.length}`,
      );

      let fetched = 0;
      let failures = 0;
      let lastDenied: string | undefined;
      for (const idx of missingIndexes) {
        let got = false;
        for (const peer of candidatePeers) {
          try {
            const resp = await this.fetchCiphertextChunkFromPeer(peer, localCgId, batchId, idx, {
              persist: true,
            });
            if (resp.denied) {
              lastDenied = resp.denied;
              continue;
            }
            if (resp.ciphertextB64) {
              got = true;
              break;
            }
          } catch (err) {
            this.log.debug(
              ctx,
              `LU-11 backfill peer=${peer} chunk=${idx} cg=${localCgId} error: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
            );
          }
        }
        if (got) fetched++;
        else failures++;
      }

      this.log.info(
        ctx,
        `LU-11 backfill done cg=${localCgId} batchId=${batchIdHex}... fetched=${fetched} failures=${failures}${lastDenied ? ` lastDenied=${lastDenied}` : ''}`,
      );
      return {
        fetched,
        failures,
        ...(failures > 0 && fetched === 0 && lastDenied ? { reason: `all-denied: ${lastDenied}` } : {}),
        ...(failures > 0 && fetched === 0 && !lastDenied ? { reason: 'no-responders' } : {}),
      };
    };
  }

  /**
   * OT-RFC-38 LU-6 B1 — authorize a signed `swm-host-catchup` request.
   *
   * Layered checks (deny-by-default):
   *   1. Signature recovery + freshness (issuedAtMs within window).
   *   2. Replay-nonce uniqueness (per-responder LRU).
   *   3. Chain-anchored: `requesterEoa ∈ participantAgents` for the CG.
   *      Definitive when chain context is available — the on-chain
   *      participant set IS the curated access policy.
   *   4. Pre-registration fallback: `requesterEoa == beaconCurator`.
   *      Curators can always catch up themselves before paying gas to
   *      register, mirroring `ingestSwmHostModeEnvelope`.
   *   5. Member-side allowlist fallback: when the local node has
   *      explicit peer-allowlist meta (member CG context, not host-only
   *      core), require `fromPeerId ∈ allowedPeers`. Defence in depth
   *      against a signed-but-out-of-band requester.
   *   6. Ciphertext-only fallback: registered node-operator EOAs may
   *      fetch opaque host-mode envelopes, matching LU-11 chunk catchup.
   *   7. Otherwise: DENY. The previous behaviour ("serve openly when
   *      no authority source available") was the metadata-leak vector
   *      Codex flagged on PR #610 round-2 #6.
   *
   * Returns `{ ok: true, recoveredSigner }` on accept or
   * `{ ok: false, reason }` with a wire-suitable string.
   */
  async authorizeSwmHostCatchupRequest(this: DKGAgent,
    req: ReturnType<typeof decodeSwmHostCatchupRequest>,
    fromPeerId: string,
    nowMs: number,
  ): Promise<{ ok: true; recoveredSigner: string } | { ok: false; reason: string }> {
    // 1. signature + freshness. `verifySignedCatchupRequest` re-runs
    //    `computeCatchupRequestDigest` over the same numerical fields
    //    the client signed; pass defined defaults for the optional
    //    `maxEntries`/`maxBytes` so the encoded uint256 layout matches.
    const verify = verifySignedCatchupRequest(
      {
        version: req.version,
        contextGraphId: req.contextGraphId,
        sinceSeqno: req.sinceSeqno,
        maxEntries: req.maxEntries ?? 0,
        maxBytes: req.maxBytes ?? 0,
        requesterEoa: req.requesterEoa,
        issuedAtMs: req.issuedAtMs,
        nonce: req.nonce,
        sig: req.sig,
      },
      nowMs,
    );
    if (!verify.ok || !verify.recoveredSigner) {
      return { ok: false, reason: verify.reason ?? 'signature verification failed' };
    }
    const requesterEoa = verify.recoveredSigner;

    // 2. replay-defence
    if (!this.catchupReplayGuard.recordIfFresh(requesterEoa, req.nonce, req.issuedAtMs, nowMs)) {
      return { ok: false, reason: 'replayed catchup nonce' };
    }

    // The authority sources below use UNION semantics: any source
    // that recognises the requester EOA (or, as transport-layer
    // fallback, the peer-id) is sufficient to accept. Codex PR #618
    // R2 caught a fail-closed bug in the prior implementation where
    // `chainParticipants` was treated as authoritative — if the
    // chain returned a set that didn't include a legitimate
    // delegatee or allowed-agent, we'd hard-deny without checking
    // the locally-persisted allowlist. The current logic accepts
    // on the first match across:
    //   3a. on-chain participant agents
    //   3b. beacon-pinned curator (pre-registration)
    //   3c. locally-persisted agent-gate set (allowedAgent UNION
    //       participantAgent from _meta + subscription cache)
    //   3d. transport-layer allowedPeers (libp2p peer-id allowlist)
    //   3e. registered node-operator EOA for ciphertext-only host catchup
    // Only if none accept do we deny.
    const requesterLower = requesterEoa.toLowerCase();
    let anyAuthoritySourceFound = false;

    try {
      const chainParticipants = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.hostCatchUp,
        () => this.resolveOnChainParticipantAgents(req.contextGraphId),
      );
      if (chainParticipants !== null) {
        anyAuthoritySourceFound = true;
        if (chainParticipants.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Adapter probe failure is non-fatal; fall through to other sources.
    }

    try {
      const beaconCurator = await this.resolveBeaconPinnedCuratorEoa(req.contextGraphId);
      if (beaconCurator) {
        anyAuthoritySourceFound = true;
        if (beaconCurator.toLowerCase() === requesterLower) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Beacon cache miss is non-fatal.
    }

    // Locally-persisted agent gate: `getContextGraphAgentGateAddresses`
    // unions `dkg:allowedAgent` + `dkg:participantAgent` from the CG's
    // `_meta` graph and the in-memory subscription cache. On a member-
    // side host this is the canonical allowlist + delegatee set;
    // chain-derived sets often miss recently-approved delegatees that
    // haven't been mirrored on chain yet.
    try {
      const agentGate = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.hostCatchUp,
        () => this.getContextGraphAgentGateAddresses(req.contextGraphId),
      );
      if (agentGate !== null) {
        anyAuthoritySourceFound = true;
        if (agentGate.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Local-meta probe failure is non-fatal.
    }

    // Transport-layer ACL (libp2p peer-id allowlist). Only meaningful
    // on nodes that have persisted the CG's `allowedPeers`; host-only
    // cores never see it.
    try {
      const allowedPeers = await this.resolveSwmAllowedPeersForCurrentAuthority(
        req.contextGraphId,
      );
      if (allowedPeers !== null) {
        anyAuthoritySourceFound = true;
        if (allowedPeers.includes(fromPeerId)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // local-meta probe failure is non-fatal; the deny below still applies.
    }

    // Ciphertext host-catchup parity with LU-11 chunk-catchup: the responder
    // serves opaque SWM envelopes, not decrypted triples. A requester that can
    // prove control of a registered node-operator EOA is allowed to fetch these
    // bytes so host-only cores and member daemons whose operational wallet is
    // distinct from their DKG agent address can recover missed ciphertext.
    if (typeof this.chain.getIdentityIdForAddress === 'function') {
      try {
        const reqIdentityId = await this.chain.getIdentityIdForAddress(requesterEoa);
        if (reqIdentityId > 0n) {
          anyAuthoritySourceFound = true;
          this.log.debug(
            createOperationContext('share'),
            `host-catchup admitted via node-operator authority cg=${req.contextGraphId} requesterEoa=${requesterEoa} identityId=${reqIdentityId.toString()}`,
          );
          return { ok: true, recoveredSigner: requesterEoa };
        }
      } catch (err) {
        this.log.debug(
          createOperationContext('share'),
          `host-catchup node-operator probe failed cg=${req.contextGraphId} requesterEoa=${requesterEoa}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const reason = anyAuthoritySourceFound
      ? 'requester EOA not in any of: on-chain participants, beacon curator, local agent-gate, allowedPeers, node-operator-registry'
      : 'no authority source available for context graph';
    return { ok: false, reason };
  }

  /**
   * Member-side helper: fetches opaque ciphertext envelopes for
   * `contextGraphId` from a single remote peer (typically a core
   * that has been observed as a host) and re-feeds each through
   * the local `SharedMemoryHandler.handle()` so the existing
   * Sender-Key decrypt-and-apply path runs verbatim. Returns the
   * counters from the apply loop.
   *
   * Iterates pages internally — when the responder marks the
   * response `truncated`, the helper resends with `sinceSeqno`
   * updated to `nextSeqno` until either the response comes back
   * non-truncated or `maxRounds` is reached.
   */
  async catchupSwmFromHost(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    options?: { sinceSeqno?: number; maxRounds?: number; maxEntriesPerRound?: number },
  ): Promise<{
    rounds: number;
    fetched: number;
    /**
     * Number of envelopes whose apply path returned `applied: true`.
     * NOT the same as triples — one envelope can carry many quads.
     * For triples-applied accounting, callers MUST sum
     * {@link appliedTriples}. Codex PR #610 R2 caught the previous
     * conflation where `memory.ts` aggregated this count into a
     * field named `totalInsertedTriples`.
     */
    applied: number;
    /**
     * Total triples (N-Quads) inserted by successful replays.
     * Summed from `SharedMemoryApplyOutcome.insertedTriples`.
     */
    appliedTriples: number;
    skipped: number;
    nextSeqno: number;
    denied?: string;
  }> {
    const ctx = createOperationContext('share');
    let sinceSeqno = options?.sinceSeqno ?? 0;
    const maxRounds = Math.max(1, options?.maxRounds ?? 8);
    const maxEntries = options?.maxEntriesPerRound ?? SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES;
    const maxBytes = SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES;
    // OT-RFC-38 LU-6 B1 — every catchup request is signed by the
    // requesting participant key so the host can authenticate via
    // on-chain / agent-gated membership without trusting the libp2p
    // peer-id.
    //
    // Codex PR #618 R2: we deliberately do NOT pre-compute the
    // requester EOA from `getRegistrationTxSignerAddress()`. The
    // chain adapter's tx-signer can differ from its message-signer
    // (per the helper's own doc-comment), and workspace-agent
    // deployments can sign with a local custodial agent key instead.
    // `mintSignedCatchupRequest` recovers the actual signer from
    // the signature itself and binds the digest to it — no caller-
    // side lookup needed.
    const workspaceCatchupSigner = await this.getWorkspaceCatchupSigner(contextGraphId);
    if (!workspaceCatchupSigner && typeof this.chain.signMessage !== 'function') {
      const reason = 'chain adapter does not implement signMessage — cannot mint signed catchup request';
      this.log.warn(ctx, `host-catchup ${reason} to=${remotePeerId} cg=${contextGraphId}`);
      return { rounds: 0, fetched: 0, applied: 0, appliedTriples: 0, skipped: 0, nextSeqno: sinceSeqno, denied: reason };
    }
    let rounds = 0;
    let fetched = 0;
    let applied = 0;
    let appliedTriples = 0;
    let skipped = 0;
    let lastDenied: string | undefined;
    while (rounds < maxRounds) {
      rounds += 1;
      const signedReq = await mintSignedCatchupRequest({
        contextGraphId,
        sinceSeqno,
        maxEntries,
        maxBytes,
        // requesterEoa intentionally omitted — the helper recovers
        // the signer from the signature itself, which is the only
        // way to guarantee the digest binds to the actual signing
        // key (the chain adapter's tx-signer and message-signer can
        // differ). See `MintSignedCatchupRequestInput.requesterEoa`
        // doc comment for the full rationale.
        sign: async (digest) => {
          if (workspaceCatchupSigner) {
            return new ethers.Wallet(workspaceCatchupSigner.privateKey).signMessage(digest);
          }
          const { r, vs } = await this.chain.signMessage!(digest);
          const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
          return sig.serialized;
        },
      });
      const reqBytes = encodeSwmHostCatchupRequest({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId,
        sinceSeqno,
        maxEntries,
        maxBytes,
        requesterEoa: signedReq.requesterEoa,
        issuedAtMs: signedReq.issuedAtMs,
        nonce: signedReq.nonce,
        sig: signedReq.sig,
      });
      let sendResult;
      try {
        sendResult = await this.messenger.sendReliable(remotePeerId, PROTOCOL_SWM_HOST_CATCHUP, reqBytes);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `host-catchup call failed to=${remotePeerId} cg=${contextGraphId}: ${reason}`);
        break;
      }
      if (!sendResult.delivered) {
        // `queued: true` means the substrate is retrying in the
        // background; we don't get the response on this call. Treat
        // it as a transport failure for this round so the caller can
        // try another peer.
        const reason = 'error' in sendResult ? sendResult.error : 'undelivered';
        this.log.info(ctx, `host-catchup undelivered to=${remotePeerId} cg=${contextGraphId}: ${reason}`);
        break;
      }
      const resp = decodeSwmHostCatchupResponse(sendResult.response);
      // Codex PR #610 R3: cross-CG safety. The wire response
      // echoes the contextGraphId; a buggy or hostile host
      // could return valid envelopes for a DIFFERENT CG. We
      // hand the bytes to `SharedMemoryHandler.handle()` with
      // `trustedReplay: true`, which bypasses transport
      // identity checks — without this guard the inner
      // payload would apply to whichever CG the envelope was
      // bound to, NOT the CG we asked for. Reject the entire
      // response before replaying anything from it.
      if (resp.contextGraphId !== contextGraphId) {
        const reason = `cgId mismatch in host response: requested="${contextGraphId}" got="${resp.contextGraphId}"`;
        this.log.warn(ctx, `host-catchup ${reason} from=${remotePeerId}`);
        lastDenied = reason;
        break;
      }
      if (resp.denied) {
        lastDenied = resp.denied;
        this.log.info(ctx, `host-catchup denied by=${remotePeerId} cg=${contextGraphId}: ${resp.denied}`);
        break;
      }
      if (resp.entries.length === 0) {
        break;
      }
      const handler = this.getOrCreateSharedMemoryHandler();
      for (const entry of resp.entries) {
        fetched += 1;
        const envelope = Buffer.from(entry.envelopeB64, 'base64');
        try {
          const outcome = await handler.handle(
            new Uint8Array(envelope),
            remotePeerId,
            undefined,
            { trustedReplay: true },
          );
          if (outcome.applied) {
            applied += 1;
            // Triples per envelope is variable; track it separately
            // from the envelope count so callers reporting a
            // triples total don't undercount. Codex PR #610 R2.
            appliedTriples += outcome.insertedTriples ?? 0;
          } else {
            skipped += 1;
            const reason = 'reason' in outcome ? outcome.reason : 'unknown';
            this.log.debug(
              ctx,
              `host-catchup envelope skipped cg=${contextGraphId} seqno=${entry.seqno}: ${reason}`,
            );
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `host-catchup apply failed cg=${contextGraphId} seqno=${entry.seqno}: ${reason}`);
          skipped += 1;
        }
      }
      sinceSeqno = resp.nextSeqno;
      if (!resp.truncated) break;
    }
    return { rounds, fetched, applied, appliedTriples, skipped, nextSeqno: sinceSeqno, ...(lastDenied ? { denied: lastDenied } : {}) };
  }

  /**
   * Member-side helper: fans out `catchupSwmFromHost` across all
   * currently-connected peers. Used as a fallback when standard
   * catchup (sync from CG members) returns 0 — typical of the
   * scenario where every CG member is simultaneously offline and
   * only cores still hold the substrate. Returns the per-peer
   * outcomes.
   */
  async catchupSwmFromConnectedHosts(this: DKGAgent,
    contextGraphId: string,
    options?: { sinceSeqno?: number; maxRounds?: number; maxEntriesPerRound?: number; peers?: string[] },
  ): Promise<Array<{
    peerId: string;
    rounds: number;
    fetched: number;
    applied: number;
    appliedTriples: number;
    skipped: number;
    nextSeqno: number;
    denied?: string;
    error?: string;
  }>> {
    const ctx = createOperationContext('share');
    const explicitPeers = options?.peers;
    const rawCandidates: string[] = (() => {
      if (explicitPeers && explicitPeers.length > 0) return [...new Set(explicitPeers)];
      const connections = this.node.libp2p.getConnections();
      const seen = new Set<string>();
      for (const c of connections) {
        const id = c.remotePeer.toString();
        if (id !== this.peerId) seen.add(id);
      }
      return [...seen];
    })();
    // Contact reliable Core hosts first. This serial loop still reaches
    // every candidate, but Cores first means faster time-to-first-data
    // and a better resume-seqno baseline before any flaky edge is tried.
    const candidates = orderCatchupPeers(rawCandidates, undefined, false, this.peerCapabilityRegistry.snapshotCorePeerIds())
      .map((p) => p.toString());
    const coreCount = candidates.filter((id) => this.peerCapabilityRegistry.supportsCore(id)).length;
    this.log.info(
      ctx,
      `host-catchup peer order for "${contextGraphId}": cores=${coreCount} total=${candidates.length}`,
    );
    const results: Array<{
      peerId: string;
      rounds: number;
      fetched: number;
      applied: number;
      appliedTriples: number;
      skipped: number;
      nextSeqno: number;
      denied?: string;
      error?: string;
    }> = [];
    for (const peerId of candidates) {
      try {
        // Codex PR #610 round-2 #2: resume from the highest seqno we
        // previously consumed from this (cgId, peerId), not from 0.
        // Pre-fix, every fallback catchup re-downloaded the entire
        // host log even when the member was already up-to-date,
        // inflating `totalInsertedTriples` (counting redundant
        // applies) and burning bandwidth on a steady-state member
        // that just happened to ask. Explicit `options.sinceSeqno`
        // still wins so operators / callers can force a re-scan.
        const resumeSeqno =
          options?.sinceSeqno !== undefined
            ? options.sinceSeqno
            : this.lastHostCatchupSeqno.get(contextGraphId)?.get(peerId) ?? 0;
        const r = await this.catchupSwmFromHost(peerId, contextGraphId, {
          sinceSeqno: resumeSeqno,
          maxRounds: options?.maxRounds,
          maxEntriesPerRound: options?.maxEntriesPerRound,
        });
        if (r.nextSeqno > 0) {
          let perPeer = this.lastHostCatchupSeqno.get(contextGraphId);
          if (!perPeer) {
            perPeer = new Map();
            this.lastHostCatchupSeqno.set(contextGraphId, perPeer);
          }
          perPeer.set(peerId, r.nextSeqno);
        }
        results.push({ peerId, ...r });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `host-catchup peer=${peerId} cg=${contextGraphId} failed: ${reason}`);
        results.push({ peerId, rounds: 0, fetched: 0, applied: 0, appliedTriples: 0, skipped: 0, nextSeqno: options?.sinceSeqno ?? 0, error: reason });
      }
    }
    return results;
  }

  /** Diagnostics surface for the host-mode store (or `null` when not initialized). */
  async getSwmHostModeStats(this: DKGAgent): Promise<{
    enabled: boolean;
    cgCount: number;
    totalBytes: number;
    totalEntries: number;
    subscribedCgIds: string[];
  } | null> {
    if (!this.swmHostModeStore) {
      return { enabled: false, cgCount: 0, totalBytes: 0, totalEntries: 0, subscribedCgIds: [] };
    }
    const stats = await this.swmHostModeStore.stats();
    return { enabled: true, ...stats, subscribedCgIds: [...this.swmHostModeSubscribed.keys()] };
  }

  /**
   * PR5 — ACK-provenance lookup for the StorageACK handler. Returns
   * which of the four LU-6 Phase B discovery paths caused this node
   * to be hosting the CG identified by ANY of the passed candidate
   * ids at the time of the call. `'member'` when the CG is in
   * member-mode (decrypt+apply handler is authoritative), the
   * recorded host-mode source when it's in host-mode, or `undefined`
   * when neither — the latter means the core has no live subscription
   * for the CG, which should never happen on a successful ACK code
   * path but is plumbed through defensively so a future race doesn't
   * crash the ACK encoder.
   *
   * Takes multiple candidate ids because the two consulted maps are
   * keyed differently: `sharedMemoryGossipRegistered` (member-mode)
   * uses the CALLER-supplied cleartext id verbatim, while
   * `swmHostModeSubscribed` (host-mode) is canonical-keyed by the
   * wire-form hash via {@link canonicalSwmHostModeKey}. The
   * StorageACK handler has the numeric on-chain `cgId`, the
   * cleartext `swmGraphId`, and may have pre-computed the wire hash;
   * passing the full set lets us hit member-mode on any cleartext
   * shape AND host-mode on any candidate after canonicalisation. The
   * `seen` set dedupes both raw and canonical forms so the per-call
   * cost stays O(distinct shapes).
   *
   * Public so `StorageACKHandlerConfig.getSubscriptionSourceForCg`
   * can bind directly to it at agent wire-up time (in `lifecycle.ts`).
   */
  getSwmSubscriptionSource(this: DKGAgent, ...candidateIds: Array<string | undefined>): SubscriptionSource | undefined {
    const seen = new Set<string>();
    for (const id of candidateIds) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.sharedMemoryGossipRegistered.has(id)) {
        return SUBSCRIPTION_SOURCES.MEMBER;
      }
      // Host-mode bookkeeping is canonical-keyed (Codex PR #672
      // review `id=3302086589`); resolve every candidate through
      // `canonicalSwmHostModeKey` before lookup so any of the
      // numeric / cleartext / hash shapes hits the same entry.
      const canonical = this.canonicalSwmHostModeKey(id);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        const hostSource = this.swmHostModeSubscribed.get(canonical);
        if (hostSource) return hostSource;
      }
    }
    return undefined;
  }

  /**
   * OT-RFC-38 LU-6 — operator-driven host-mode subscribe.
   *
   * Forcibly enables host-mode subscription for `contextGraphId`
   * even when the local store has no CG metadata yet. Designed for
   * Phase A where sharding-table auto-discovery is approximated by
   * an explicit operator designation per core. Idempotent.
   *
   * Returns `{ subscribed, alreadySubscribed, hostingEnabled, memberMode }`:
   *  - `subscribed`: true if the call actually wired the topic listener
   *    on this invocation (false on re-entry when already subscribed).
   *  - `alreadySubscribed`: mirror of `subscribed === false`.
   *  - `hostingEnabled`: whether the host-mode store is initialized
   *    on this node (false on edges or when explicitly disabled).
   *  - `memberMode`: true if this CG is already in member-mode on
   *    this node — host-mode subscription is refused because the
   *    two would race / duplicate every apply (Codex PR #610 R4).
   */
  async enableSwmHostModeFor(this: DKGAgent, contextGraphId: string): Promise<{
    subscribed: boolean;
    alreadySubscribed: boolean;
    hostingEnabled: boolean;
    memberMode?: boolean;
  }> {
    const session = this.gossipSession;
    if (!session.active) return { subscribed: false, alreadySubscribed: false, hostingEnabled: false };
    if (!this.swmHostModeStore) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: false };
    }
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    if (!this.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)) {
      this.unwireSwmHostModeHandler(contextGraphId);
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    // Codex PR #610 R4: refuse host-mode subscribe when the same
    // CG is already in member-mode on this node. Wiring both
    // handlers would cause every gossip message to be (a)
    // decrypted-and-applied via the member handler AND (b)
    // opaquely appended via the host handler. The reconciler
    // path already refuses this; the operator-driven entrypoint
    // must do the same to keep the invariant globally true.
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      this.log.info(
        createOperationContext('system'),
        `SWM host-mode subscribe refused for "${contextGraphId}": local node is already a CG member (member-mode handler is authoritative)`,
      );
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true, memberMode: true };
    }
    const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
    const localId = this.manualSwmHostModeLocalId(contextGraphId);
    const subscription = this.subscribedContextGraphs.get(localId);
    const onChainId = subscription?.onChainId;
    const onChainHash = subscription?.onChainHash;
    const generation = this.contextGraphBindingState.capture(localId);
    const handler = session.swmHostModeHandlers.get(hostKey);
    const source = session.swmHostModeSubscribed.get(hostKey);
    const wireOwner = this.wireIdToLocalCgId.get(hostKey);
    const requestIsCurrent = (): boolean => session.active && this.gossipSession === session
      && this.manualSwmHostModeLocalId(contextGraphId) === localId
      && this.subscribedContextGraphs.get(localId) === subscription
      && subscription?.onChainId === onChainId && subscription?.onChainHash === onChainHash
      && this.contextGraphBindingState.isGenerationCurrent(localId, generation)
      && this.canonicalSwmHostModeKey(contextGraphId) === hostKey
      && this.wireIdToLocalCgId.get(hostKey) === wireOwner;
    const curated = await this.isCuratedForHostMode(contextGraphId);
    if (!requestIsCurrent()
      || session.swmHostModeHandlers.get(hostKey) !== handler
      || session.swmHostModeSubscribed.get(hostKey) !== source) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    const strip = this.swmHostModeStripCiphertext();
    const publicPolicy = this.isExactPublicManualSwmHostMode(contextGraphId, hostKey);
    const ownsHandler = handler !== undefined && wireOwner === localId;
    // Absence of private evidence is not public proof. Close only this owner's
    // existing dispatch; retain its operator provenance and durable marker.
    if (strip && !publicPolicy) {
      if (ownsHandler) session.swmHostModeCurated.set(hostKey, true);
      this.log.info(createOperationContext('system'),
        `SWM host-mode subscribe REFUSED for "${contextGraphId}": private-ciphertext strip requires exact public access policy`,
      );
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    if (strip && (handler !== undefined || source !== undefined) && !ownsHandler) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    if (this.swmHostModeSubscribed.has(hostKey)) {
      // Idempotent re-entry: even when the subscription is already
      // active, re-probe registration state. This handles the
      // legitimate "CG was unregistered when first subscribed,
      // operator later registered it on-chain, operator re-calls
      // /host-mode/subscribe" flow without forcing a daemon restart.
      //
      // The `has()` check goes through `canonicalSwmHostModeKey` so
      // a manual subscribe with the cleartext id finds an entry the
      // chain-event/beacon path wrote with the wire-hash form (and
      // vice versa). Codex PR #672 review `id=3302086589` — without
      // this canonicalisation the second subscribe would wire a
      // duplicate gossip handler on the same topic and double every
      // host-mode ingest/persistence.
      // Exact public policy can reopen this owner after an unknown-policy
      // refusal. Strip-off re-entry retains positive private classification.
      this.swmHostModeCurated.set(
        hostKey,
        strip && ownsHandler && source === SUBSCRIPTION_SOURCES.MANUAL
          ? false : this.swmHostModeCurated.get(hostKey) === true || curated,
      );
      await this.maybeMarkRegisteredForHostMode(contextGraphId);
      if (!requestIsCurrent() || session.swmHostModeHandlers.get(hostKey) !== handler
        || session.swmHostModeSubscribed.get(hostKey) !== source
        || (strip && !this.isExactPublicManualSwmHostMode(contextGraphId, hostKey))) {
        return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
      }
      return { subscribed: false, alreadySubscribed: true, hostingEnabled: true };
    }
    this.wireSwmHostModeHandler(contextGraphId, SUBSCRIPTION_SOURCES.MANUAL, strip ? false : curated);
    const createdHandler = session.swmHostModeHandlers.get(hostKey);
    const createdIsCurrent = (): boolean => requestIsCurrent() && createdHandler !== undefined
      && session.swmHostModeHandlers.get(hostKey) === createdHandler
      && session.swmHostModeSubscribed.get(hostKey) === SUBSCRIPTION_SOURCES.MANUAL
      && (!strip || this.isExactPublicManualSwmHostMode(contextGraphId, hostKey));
    await this.awaitHostModePersistence(contextGraphId);
    if (!createdIsCurrent()) return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    // Codex PR #610 R1 comment 5: a core that only knows the CG by
    // topic id (the explicit /host-mode/subscribe entrypoint) must
    // still transition the store to the registered-CG limits as
    // soon as the on-chain record exists. Without this probe the
    // store would stay on the 6h/1MiB pre-registration defaults
    // forever and prune ciphertext from registered CGs much
    // earlier than intended.
    await this.maybeMarkRegisteredForHostMode(contextGraphId);
    if (!createdIsCurrent()) return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    this.log.info(
      createOperationContext('system'),
      `SWM host-mode subscription explicitly enabled for "${contextGraphId}" via API (role=${this.config.nodeRole ?? 'edge'})`,
    );
    return { subscribed: true, alreadySubscribed: false, hostingEnabled: true };
  }

  /**
   * Probe on-chain registration and flip the host-mode store's
   * per-CG cursor to the registered-CG limits when the CG is
   * already known to the contracts. Safe to call repeatedly and on
   * unregistered CGs — both branches early-return without touching
   * the store.
   */
  async maybeMarkRegisteredForHostMode(this: DKGAgent, contextGraphId: string): Promise<void> {
    if (!this.swmHostModeStore) return;
    try {
      // OT-RFC-38 / LU-6 Phase B — three-way registration probe.
      //
      //   1. Legacy: ask the chain adapter directly (if it exposes
      //      `getContextGraphOnChain(cleartextId)`). The default
      //      adapter doesn't, so this returns false on most setups.
      //
      //   2. Host-only-core path: the chain-event handler populated
      //      `subscribedContextGraphs.get(wireIdHash).onChainId` when
      //      it observed `ContextGraphCreated(nameHash, ...)`. If the
      //      cleartext hash hits an entry with `onChainId`, the CG IS
      //      registered.
      //
      //   3. Member-side path: a node that created the CG locally and
      //      then registered keeps `subscribedContextGraphs.get(cleartext)
      //      .onChainId` populated. This is the cleartext-keyed
      //      shortcut.
      //
      // Any positive probe flips the store flag so the registered
      // per-CG byte cap (64MB) replaces the pre-reg cap (1MB) and
      // the pre-reg rate-limit short-circuits in
      // `ingestSwmHostModeEnvelope` (registered CGs are gated by
      // chain economics, not the freemium-tier window).
      let registered = await this.isContextGraphRegisteredOnChain(contextGraphId);
      if (!registered) {
        const directSub = this.subscribedContextGraphs.get(contextGraphId);
        if (directSub?.onChainId) registered = true;
      }
      if (!registered) {
        try {
          const wireId = this.gossipWireIdFor(contextGraphId);
          const wireSub = this.subscribedContextGraphs.get(wireId);
          if (wireSub?.onChainId) registered = true;
        } catch { /* malformed cleartext — fall through */ }
      }
      if (registered) await this.swmHostModeStore.markRegistered(contextGraphId);
    } catch { /* best-effort; pre-registration defaults stay in place */ }
  }

}
