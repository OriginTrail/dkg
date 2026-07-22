import { createHash, randomUUID } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  deriveCuratorDidFromCgId,
  MemoryLayer,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
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
  DEFAULT_GENESIS_ID, getGenesisQuads, computeNetworkId, SYSTEM_CONTEXT_GRAPHS, DKG_ONTOLOGY,
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral, isSafeIri, assertSafeIri,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  buildTrustLevelQuads,
  isTrustLevelQuad,
  buildAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, type AuthorAttestationTypedData,
  buildAssertionSealQuads, buildAssertionPublishReceiptQuads,
  type AssertionSeal,
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
  ENTITY_PRED_ALT,
  LegacyKnowledgeAssetReadOnlyError,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { canonicalRootlessLifecycleGraph } from './rootless-lifecycle-graph.js';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, isContextGraphChainScanPartialError, type EVMAdapterConfig, type ChainAdapter, type ContextGraphOnChain, type ContextGraphChainScanOptions, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
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
  resolveStorageAckTiming,
  selectACKCandidatePeersWithDiagnostics,
  type PublishOptions, type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  // OT-RFC-43 A2/B3 — per-layer pointers + derived status helper.
  deriveStatus, type KaStatus,
  WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED, VM_CURRENT_ASSERTION_PRED,
  KA_ID_PRED, RESERVED_UAL_PRED,
  type CollectedACK, type V10CoreNodeACK, type V10ACKProviderParams,
  type ACKCollectorDeps,
  type ACKTransportFactory,
  type WorkspaceAgentRecipient,
  type WorkspaceAgentRecipientResolution,
  type WorkspaceAgentRecipientResolverInput,
  type WorkspaceSenderKeyEncryptInput,
  type SharedMemoryPublicSnapshotStorageConfig, type WorkspacePublicSnapshotStore,
  DEFAULT_REQUIRED_ACKS,
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
import {
  normalizeSyncContextGraphPriorities,
  validateSyncResponderSnapshotLimitsConfig,
} from './sync/policy.js';
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
import { FinalizationHandler, KEEP_ROOT_COPY_PREDICATE } from './finalization-handler.js';
import { reconcileContextGraph, RecentUalSet, type ChainReconcilerDeps, type OrdinalOutcome } from './chain-reconciler.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
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
  strip, stripLiteral, jsonLdToQuads,
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
  type ContextGraphDiscoveryMetadata,
  type ContextGraphDiscoveryOptions,
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
  type ContextGraphWritePreflightProbe,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type ContextGraphJoinPolicyMode,
  type ContextGraphJoinPolicyRecord,
  type ContextGraphJoinPolicyAuditEventType,
  type ContextGraphJoinPolicyAuditEvent,
  type ContextGraphJoinPolicyRateReservation,
  type ContextGraphJoinPolicyStore,
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type DKGAgentConfig,
  type Rfc64CatalogAccessPolicyAuthorityConfigV1,
  type DKGAgentACKTransportOptions,
  type ImportedArtifactByteStore,
  type ReplicationEvent,
  type ResolvedDKGAgentConfig,
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
import { DKGAgentBase, createListContextGraphsCacheInvalidatingStore } from './dkg-agent-base.js';
import { reconcileAndAllocateKaNumber } from './allocator.js';
import { applyMixins } from './dkg-agent-apply-mixins.js';
import { OwnershipMethods } from './dkg-agent-ownership.js';
import { ContextGraphResolveMethods } from './dkg-agent-cg-resolve.js';
import { CclPolicyMethods } from './dkg-agent-ccl.js';
import { EndorseVerifyMethods } from './dkg-agent-endorse.js';
import {
  Rfc64CatalogMethods,
  snapshotRfc64CatalogAccessPolicyAuthorityV1,
  snapshotRfc64CatalogDeploymentProfileV1,
} from './dkg-agent-rfc64-catalog.js';
import { Rfc64CatalogAutoPublishMethods } from './dkg-agent-rfc64-catalog-auto-publish.js';
import { Rfc64CatalogBootstrapMethods } from './dkg-agent-rfc64-catalog-bootstrap.js';
import { Rfc64CatalogUpsertMethods } from './dkg-agent-rfc64-catalog-upsert.js';
import {
  snapshotRfc64PublicCatalogAutoPublishConfigV1,
  snapshotRfc64PublicCatalogBootstrapConfigV1,
} from './rfc64/catalog-authority-config-v1.js';
import { Rfc64CatalogSyncMethods } from './dkg-agent-rfc64-catalog-sync.js';
import { ContextGraphRegistryMethods } from './dkg-agent-cg-registry.js';
import { JoinRequestMethods } from './dkg-agent-join.js';
import { SwmSubstrateMethods } from './dkg-agent-swm-substrate.js';
import { QueryMethods } from './dkg-agent-query.js';
import { AgentRegistryMethods } from './dkg-agent-registry.js';
import { WorkspaceCryptoMethods } from './dkg-agent-crypto.js';
import { LifecycleSyncMethods } from './dkg-agent-lifecycle.js';
import {
  PublishMethods,
  SEAL_CAPABILITY_GAP_CODE,
} from './dkg-agent-publish.js';
import { SwmHostModeMethods } from './dkg-agent-swm-host.js';
import { ContextGraphMethods } from './dkg-agent-context-graph.js';
import { ImportedArtifactMethods } from './imported-artifact.js';
// Public surface re-exported so external consumers that import directly
// from `./dkg-agent.js` keep working. The new file `dkg-agent-types.ts`
// is the canonical home; `packages/agent/src/index.ts` re-exports from
// there.
export {
  ContextGraphNotFoundError,
  InvalidContentError,
};
export type {
  CclPublishedResultEntry,
  CclPublishedEvaluationRecord,
  PublishOpts,
  PublishAsyncOpts,
  PublishAsyncQuadEnvelope,
  PublishAsyncContent,
  PeerHealth,
  PeerConnectionSnapshot,
  PeerDiagnostics,
  ChatSendResult,
  ContextGraphSub,
  ContextGraphDiscoveryMetadata,
  ContextGraphDiscoveryOptions,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  ContextGraphWritePreflightProbe,
  ContextGraphMemberPrincipalType,
  ContextGraphMemberStatus,
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
  ContextGraphJoinPolicyMode,
  ContextGraphJoinPolicyRecord,
  ContextGraphJoinPolicyAuditEventType,
  ContextGraphJoinPolicyAuditEvent,
  ContextGraphJoinPolicyRateReservation,
  ContextGraphJoinPolicyStore,
  DurableSyncDiagnostics,
  SharedMemorySyncDiagnostics,
  CatchupSyncDiagnostics,
  DKGAgentConfig,
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  DKGAgentACKTransportOptions,
  ImportedArtifactByteStore,
};

/**
 * OT-RFC-43 A2 (decision 5) — the `agent.assertion.history()` return shape:
 * the core `AssertionDescriptor` plus the three per-layer pointers, the
 * §10.5.4 derived status, and the finalize-stamped KA identity. The pointers
 * are merkle-root hex (bare, no 0x); divergence between them (e.g.
 * `wmCurrentAssertion !== vmCurrentAssertion`) is the observable signal that a
 * layer is ahead of another.
 */
export interface AssertionHistoryDescriptor extends AssertionDescriptor {
  /** Merkle hex of the assertion currently sealed in WM (bare, no 0x). */
  wmCurrentAssertion?: string;
  /** Merkle hex of the assertion shared into SWM. */
  swmCurrentAssertion?: string;
  /** Merkle hex of the assertion confirmed on-chain (VM). */
  vmCurrentAssertion?: string;
  /** Latest SWM share operation id stamped on the lifecycle subject. */
  currentShareOperationId?: string;
  /** OT-RFC-43 §10.5.4 derived overall status. */
  status: KaStatus;
  /** The per-author KA NUMBER (low 96 bits) stamped at finalize, as a string. */
  kaNumber?: string;
  /** did:dkg:<chainId>/<agentAddrLower>/<number> reserved at finalize. */
  reservedUal?: string;
  /**
   * #1104 — did:dkg:<chainId>/<kasContract>/<packed kaId> recorded at the
   * first confirmed vm/publish (re-stamped on updates). This is the on-chain
   * resolvable UAL; `reservedUal` remains the author-namespace identity
   * minted at finalize. Both are permanent; this field is the link.
   */
  publishedUal?: string;
}

export type DiscoverContextGraphsFromChainOptions = {
  throwOnChainScanFailure?: boolean;
  pageBudget?: number;
  mode?: 'listAll' | 'incremental' | 'seedFull' | 'seedFromCursor';
  incremental?: boolean;
  seedIncrementalWatermark?: boolean;
  resumeFromCursor?: boolean;
};

type NormalizedContextGraphDiscoveryScan =
  | { mode: 'listAll' }
  | { mode: 'incremental'; pageBudget?: number }
  | { mode: 'seedFull' }
  | { mode: 'seedFromCursor'; pageBudget?: number };

function normalizeContextGraphDiscoveryScan(
  options: DiscoverContextGraphsFromChainOptions,
): NormalizedContextGraphDiscoveryScan {
  if (options.mode !== undefined) {
    if (options.mode === 'incremental') {
      return {
        mode: 'incremental',
        ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
      };
    }
    if (options.mode === 'seedFull') return { mode: 'seedFull' };
    if (options.mode === 'seedFromCursor') {
      return {
        mode: 'seedFromCursor',
        ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
      };
    }
    if (options.mode === 'listAll') return { mode: 'listAll' };
    throw new Error(`Unsupported context graph chain discovery scan mode: ${String(options.mode)}`);
  }

  if (options.incremental === true) {
    return {
      mode: 'incremental',
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }

  if (options.seedIncrementalWatermark === true) {
    if (options.resumeFromCursor === true) {
      return {
        mode: 'seedFromCursor',
        ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
      };
    }
    return { mode: 'seedFull' };
  }

  return { mode: 'listAll' };
}

function legacyChainListScanOptions(
  options: DiscoverContextGraphsFromChainOptions,
): ContextGraphChainScanOptions | undefined {
  if (options.mode !== undefined) return undefined;
  if (options.incremental === true) {
    return {
      incremental: true,
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  if (options.seedIncrementalWatermark === true) {
    return {
      seedIncrementalWatermark: true,
      ...(options.resumeFromCursor !== undefined ? { resumeFromCursor: options.resumeFromCursor } : {}),
      ...(options.pageBudget !== undefined ? { pageBudget: options.pageBudget } : {}),
    };
  }
  return undefined;
}

function assertLegacyStorageAckAlias(
  value: unknown,
  label: string,
  options: { allowZero: boolean },
): void {
  const validInteger = Number.isSafeInteger(value);
  const validRange = options.allowZero
    ? (value as number) >= 0
    : (value as number) > 0;
  if (!validInteger || !validRange) {
    throw new Error(
      `${label} must be a ${options.allowZero ? 'non-negative' : 'positive'} ` +
      'safe integer number of milliseconds',
    );
  }
}

function throwStorageAckTimingConflict(): never {
  throw new Error(
    'DKGAgentConfig.storageAckTiming must not conflict with legacy ' +
    'ackHandlerDeadlineMs/ackSendTimeoutMs aliases',
  );
}

function normalizeStorageAckConfig(config: DKGAgentConfig): ResolvedDKGAgentConfig {
  const hasStorageAckTiming = config.storageAckTiming !== undefined && config.storageAckTiming !== null;
  const hasLegacyTiming =
    config.ackHandlerDeadlineMs !== undefined ||
    config.ackSendTimeoutMs !== undefined;

  const timing = resolveStorageAckTiming(
    hasStorageAckTiming
      ? config.storageAckTiming
      : hasLegacyTiming
        ? {
            handlerDeadlineMs: config.ackHandlerDeadlineMs,
            sendTimeoutMs: config.ackSendTimeoutMs,
          }
        : undefined,
    'DKGAgentConfig.storageAckTiming',
  );

  if (hasStorageAckTiming && config.ackHandlerDeadlineMs !== undefined) {
    assertLegacyStorageAckAlias(
      config.ackHandlerDeadlineMs,
      'DKGAgentConfig.ackHandlerDeadlineMs',
      { allowZero: true },
    );
    if (config.ackHandlerDeadlineMs !== timing.handlerDeadlineMs) {
      throwStorageAckTimingConflict();
    }
  }
  if (hasStorageAckTiming && config.ackSendTimeoutMs !== undefined) {
    assertLegacyStorageAckAlias(
      config.ackSendTimeoutMs,
      'DKGAgentConfig.ackSendTimeoutMs',
      { allowZero: false },
    );
    if (config.ackSendTimeoutMs !== timing.sendTimeoutMs) {
      throwStorageAckTimingConflict();
    }
  }

  const {
    storageAckTiming: _storageAckTiming,
    ackHandlerDeadlineMs: _ackHandlerDeadlineMs,
    ackSendTimeoutMs: _ackSendTimeoutMs,
    ...rest
  } = config;
  return {
    ...rest,
    storageAckTiming: timing,
  };
}

interface ACKReliableMessenger {
  sendRequestOwned(
    peerId: string,
    protocol: string,
    data: Uint8Array,
    opts: { timeoutMs: number },
  ): Promise<{ delivered: boolean; error?: unknown; response?: Uint8Array }>;
}

function createACKSendP2P(input: {
  messenger: ACKReliableMessenger;
  timeoutMs: number;
}): ACKCollectorDeps['sendP2P'] {
  return async (peerId: string, protocol: string, data: Uint8Array) => {
    const sendResult = await input.messenger.sendRequestOwned(peerId, protocol, data, {
      timeoutMs: input.timeoutMs,
    });
    if (!sendResult.delivered) {
      throw new Error(`substrate send already in flight (transport): ${sendResult.error}`);
    }
    if (!sendResult.response) {
      throw new Error('substrate delivered (transport) without response');
    }
    return sendResult.response;
  };
}

/**
 * High-level facade that ties together all DKG agent capabilities:
 * identity, networking, publishing, querying, discovery, and messaging.
 *
 * Usage:
 *   const agent = await DKGAgent.create({ name: 'MyBot', skills: [...] });
 *   await agent.start();
 *   const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
 *   const response = await agent.invokeSkill(offerings[0], inputData);
 *   await agent.stop();
 */
export class DKGAgent extends DKGAgentBase {
  private chainContextGraphScanFailure:
    | { signature: string; count: number }
    | undefined;

  static async create(inputConfig: DKGAgentConfig): Promise<DKGAgent> {
    validateSyncResponderSnapshotLimitsConfig(inputConfig.syncResponderSnapshotLimits);
    const config = normalizeStorageAckConfig({
      ...inputConfig,
      syncContextGraphPriorities: normalizeSyncContextGraphPriorities(
        inputConfig.syncContextGraphPriorities,
      ),
    });
    const rfc64CatalogDeploymentProfile = snapshotRfc64CatalogDeploymentProfileV1(
      config.rfc64CatalogDeploymentProfile,
    );
    const rfc64CatalogAccessPolicyAuthority = snapshotRfc64CatalogAccessPolicyAuthorityV1(
      config.rfc64CatalogAccessPolicyAuthority,
    );
    const rfc64PublicCatalogAutoPublish = snapshotRfc64PublicCatalogAutoPublishConfigV1(
      config.rfc64PublicCatalogAutoPublish,
    );
    const rfc64PublicCatalogBootstrap = snapshotRfc64PublicCatalogBootstrapConfigV1(
      config.rfc64PublicCatalogBootstrap,
    );
    let wallet: DKGAgentWallet;
    if (config.dataDir) {
      try {
        wallet = await DKGAgentWallet.load(config.dataDir);
      } catch {
        wallet = await DKGAgentWallet.generate();
        await wallet.save(config.dataDir);
      }
    } else {
      wallet = await DKGAgentWallet.generate();
    }
    const log = new Logger('DKGAgent');
    const ctx = createOperationContext('system');
    let store: TripleStore;
    if (config.store) {
      store = config.store;
    } else if (config.storeConfig) {
      store = await createTripleStore(applyDefaultLargeLiteralStorage(config.storeConfig, config.dataDir, config.largeLiteralStorage));
      log.info(ctx, `Triple store backend: ${config.storeConfig.backend}`);
    } else if (config.dataDir) {
      const { join } = await import('node:path');
      const persistPath = join(config.dataDir, 'store.nq');
      store = await createTripleStore({
        backend: 'oxigraph-worker',
        options: { path: persistPath },
        largeLiteralStorage: defaultLargeLiteralStorage(config.dataDir, config.largeLiteralStorage),
      });
      log.info(ctx, `Persistent triple store (worker thread): ${persistPath}`);
    } else {
      store = await createTripleStore({ backend: 'oxigraph' });
      log.warn(ctx, `No dataDir — triple store is in-memory (data will be lost on restart)`);
    }

    const nodeRole = config.nodeRole ?? 'edge';
    let chain: ChainAdapter;
    let opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
      if (!opKeys?.length && typeof (chain as any).getOperationalPrivateKey === 'function') {
        opKeys = [(chain as any).getOperationalPrivateKey()];
      }
    } else if (config.chainConfig && opKeys?.length) {
      const evmConfigBase = {
        rpcUrl: config.chainConfig.rpcUrl,
        rpcUrls: config.chainConfig.rpcUrls,
        walletRpcUrls: config.chainConfig.walletRpcUrls,
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        tokenAddress: config.chainConfig.tokenAddress,
        chainId: config.chainConfig.chainId,
        receiptTimeoutMs: config.chainConfig.receiptTimeoutMs,
        approvalPolicy: config.chainConfig.approvalPolicy,
        cgRegistryScanPageSize: config.chainConfig.cgRegistryScanPageSize,
        minPublisherNativeWei: config.chainConfig.minPublisherNativeWei,
        minPublisherTracWei: config.chainConfig.minPublisherTracWei,
        contextGraphRegistryScanCursorStore: config.contextGraphRegistryScanCursorStore,
      };
      if (config.chainConfig.adminPrivateKey) {
        chain = new EVMChainAdapter({ ...evmConfigBase, adminPrivateKey: config.chainConfig.adminPrivateKey });
      } else {
        chain = new EVMChainAdapter({ ...evmConfigBase, allowNoAdminSigner: true });
      }
    } else {
      chain = new NoChainAdapter();
    }

    const eventBus = new TypedEventBus();
    const keypair = wallet.keypair;

    const genesisId = config.genesisId ?? config.networkIdentity?.genesisId ?? DEFAULT_GENESIS_ID;

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store, genesisId);
    const computedNetworkId = await computeNetworkId(genesisId);
    if (config.networkIdentity?.genesisId && config.networkIdentity.genesisId !== genesisId) {
      throw new Error(
        `DKGAgentConfig.networkIdentity.genesisId (${config.networkIdentity.genesisId}) ` +
        `must match the selected genesisId (${genesisId})`,
      );
    }
    if (config.networkIdentity?.networkId && config.networkIdentity.networkId !== computedNetworkId) {
      throw new Error(
        `DKGAgentConfig.networkIdentity.networkId (${config.networkIdentity.networkId}) ` +
        `must match computeNetworkId(${genesisId}) (${computedNetworkId})`,
      );
    }
    const adapterChainId = chain.chainId !== 'none' ? chain.chainId : undefined;
    if (config.networkIdentity?.chainId && adapterChainId && config.networkIdentity.chainId !== adapterChainId) {
      throw new Error(
        `DKGAgentConfig.networkIdentity.chainId (${config.networkIdentity.chainId}) ` +
        `must match the chain adapter id (${adapterChainId})`,
      );
    }
    const networkIdentity = {
      ...config.networkIdentity,
      genesisId,
      networkId: computedNetworkId,
      chainId: adapterChainId ?? config.networkIdentity?.chainId,
    };
    const resolvedConfig: ResolvedDKGAgentConfig = {
      ...config,
      genesisId,
      networkIdentity,
      rfc64CatalogAccessPolicyAuthority,
      rfc64CatalogDeploymentProfile,
      rfc64PublicCatalogAutoPublish,
      rfc64PublicCatalogBootstrap,
    };

    const port = config.listenPort ?? 0;
    const host = config.listenHost ?? '0.0.0.0';
    const nodeConfig: DKGNodeConfig = {
      listenAddresses: [`/ip4/${host}/tcp/${port}`],
      announceAddresses: config.announceAddresses,
      bootstrapPeers: config.bootstrapPeers,
      relayPeers: config.relayPeers,
      enableMdns: !config.bootstrapPeers?.length && !config.relayPeers?.length,
      privateKey: keypair.secretKey,
      nodeRole,
      relayServerCapacity: config.relayServerCapacity,
      relayReservationCount: config.relayReservationCount,
      nodeVersion: config.nodeVersion,
      networkIdentity,
      ...pickNetworkTunables(config),
    };

    const node = new DKGNode(nodeConfig);
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();
    const publicSnapshotStore = createPublicSnapshotStore(config.dataDir, config.sharedMemoryPublicSnapshotStorage);
    const legacyAdapterOperationalKey = opKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(config.publisherAddress);
    const publisherAddressMatchesLegacyKey = Boolean(
      configuredPublisherAddress &&
      legacyAdapterOperationalAddress &&
      configuredPublisherAddress.toLowerCase() === legacyAdapterOperationalAddress.toLowerCase(),
    );
    const adapterCanPublishFromAdvertisedSigner = await adapterAdvertisesPublisherSigner(chain);
    const useLegacyAdapterOperationalKeyFallback = Boolean(
      config.chainAdapter &&
      legacyAdapterOperationalKey &&
      !adapterCanPublishFromAdvertisedSigner &&
      (!configuredPublisherAddress || publisherAddressMatchesLegacyKey),
    );
    let agentRef: DKGAgent | undefined;
    const agentStore = createListContextGraphsCacheInvalidatingStore(
      store,
      () => {
        agentRef?.invalidateListContextGraphsCache();
      },
      (quads) => {
        if (!agentRef) return;
        if (quads) agentRef.contextGraphMetaProjection.markDirtyFromQuads(quads);
        else agentRef.contextGraphMetaProjection.markAllDirty();
      },
    );

    const publisher = new DKGPublisher({
      store: agentStore,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: useLegacyAdapterOperationalKeyFallback ? legacyAdapterOperationalKey : undefined,
      publisherAddress: config.publisherAddress,
      publisherAddressResolver: config.publisherAddress || useLegacyAdapterOperationalKeyFallback
        ? undefined
        : (contextGraphId?: bigint) => inferAdapterPublisherAddress(chain, contextGraphId),
      sharedMemoryOwnedEntities: workspaceOwnedEntities,
      writeLocks,
      publicSnapshotStore,
      // OT-RFC-43 Option 1 — deterministic packed reservedKaId minting.
      kaAllocator: config.kaNumberAllocator,
      // RFC ka-metadata-trim P3.3 — `metadata.provenanceEvents` (default true).
      provenanceEvents: config.metadataProvenanceEvents,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} shared memory ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct shared memory ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    // GH #748: one-shot migration of SWM `prov:wasAttributedTo` from
    // peer-ID string literals to agent DID URIs. Idempotent via a
    // per-CG marker; non-fatal on failure (match the pattern above).
    try {
      const migrated = await publisher.migrateSwmAttributionToAgentDid();
      if (migrated.rewritten > 0 || migrated.skipped > 0) {
        const log = new Logger('DKGAgent');
        log.info(
          createOperationContext('init'),
          `Migrated SWM attribution across ${migrated.swmMetaGraphs} SWM meta graph(s): rewrote ${migrated.rewritten} literal(s) to agent DID, ${migrated.skipped} unresolved`,
        );
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to migrate SWM attribution to agent DID, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    const queryEngine = new DKGQueryEngine(agentStore);

    const agent = new DKGAgent(
      resolvedConfig, wallet, node, agentStore, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks, publicSnapshotStore,
    );
    agentRef = agent;
    if (config.importedArtifactByteStore) {
      agent.registerImportedArtifactByteStore(config.importedArtifactByteStore);
    }
    return agent;
  }

  public getACKSignerCandidateWallets(ctx: OperationContext): ethers.Wallet[] {
    const operationalKeys = this.config.chainAdapter
      ? []
      : (this.config.chainConfig?.operationalKeys ?? []);
    const keys = [
      this.config.ackSignerKey,
      ...operationalKeys,
      typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined,
    ].filter((key): key is string => Boolean(key));

    const wallets: ethers.Wallet[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      try {
        const wallet = new ethers.Wallet(key);
        const addressKey = wallet.address.toLowerCase();
        if (seen.has(addressKey)) continue;
        seen.add(addressKey);
        wallets.push(wallet);
      } catch (err) {
        this.log.warn(ctx, `Ignoring invalid ACK signer key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return wallets;
  }

  public async resolveConfirmedACKSigner(
    identityId: bigint,
    candidates: ethers.Wallet[],
    ctx: OperationContext,
  ): Promise<ACKSignerResolution> {
    const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
    if (typeof isOperationalWalletRegistered !== 'function') {
      this.log.warn(
        ctx,
        'V10 StorageACK signer disabled: chain adapter does not implement required on-chain operational wallet confirmation',
      );
      return { wallet: null, retryable: false };
    }

    let sawLookupError = false;
    for (const wallet of candidates) {
      try {
        if (await isOperationalWalletRegistered.call(this.chain, identityId, wallet.address)) {
          return { wallet, retryable: false };
        }
      } catch (err) {
        sawLookupError = true;
        this.log.warn(
          ctx,
          `Unable to confirm ACK signer ${wallet.address} on-chain: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (sawLookupError) {
      this.log.warn(
        ctx,
        `V10 StorageACK handler registration deferred: signer confirmation failed due lookup error(s)`,
      );
      return { wallet: null, retryable: true };
    }

    this.log.warn(
      ctx,
      `V10 StorageACK signer disabled: no candidate key is confirmed on-chain as ` +
      `OPERATIONAL_KEY for identity ${identityId}`,
    );
    return { wallet: null, retryable: false };
  }

  // Overload: raw quads
  async publish(contextGraphId: string, quads: Quad[], privateQuads?: Quad[], opts?: PublishOpts): Promise<PublishResult>;
  // Overload: JSON-LD (bare doc = private, or { public?, private? } envelope)
  async publish(contextGraphId: string, content: JsonLdContent, opts?: PublishOpts): Promise<PublishResult>;
  async publish(
    contextGraphId: string,
    input: Quad[] | JsonLdContent,
    thirdArg?: Quad[] | PublishOpts,
    fourthArg?: PublishOpts,
  ): Promise<PublishResult> {
    // JSON-LD: convert to quads, then publish
    if (!Array.isArray(input)) {
      const { publicQuads, privateQuads } = await jsonLdToQuads(input);
      return this._publish(contextGraphId, publicQuads, privateQuads, thirdArg as PublishOpts);
    }
    // Quad[]: pass through directly
    if (Array.isArray(thirdArg)) {
      return this._publish(contextGraphId, input as Quad[], thirdArg, fourthArg);
    }
    return this._publish(contextGraphId, input as Quad[], undefined, thirdArg ?? fourthArg);
  }

  async networkId(): Promise<string> {
    return computeNetworkId(this.config.genesisId);
  }

  get peerId(): string {
    return this.node.peerId;
  }

  get nodeName(): string {
    return this.config.name;
  }

  get nodeFramework(): string | undefined {
    return this.config.framework;
  }

  get identityId(): bigint {
    return this.publisher.getIdentityId();
  }

  /**
   * Sign the context graph participant digest: keccak256(contextGraphId, merkleRoot).
   * Returns the caller's identity ID and compact ECDSA (r, vs) values that the
   * ContextGraphs contract can verify via ecrecover.
   */
  async signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> {
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('Chain adapter does not support signMessage');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, ethers.hexlify(merkleRoot)],
    );
    const sig = await this.chain.signMessage(ethers.getBytes(digest));
    return { identityId: this.identityId, ...sig };
  }

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  /** Returns a snapshot of the context graph subscription registry. */
  getSubscribedContextGraphs(): ReadonlyMap<string, ContextGraphSub> {
    return this.subscribedContextGraphs;
  }

  /** Returns the latest health snapshot for all known peers. */
  getPeerHealth(): ReadonlyMap<string, PeerHealth> {
    return this.peerHealth;
  }

  async getPeerProtocols(peerId: string): Promise<string[]> {
    return diagnostics.getPeerProtocols(this.node, peerId);
  }

  /**
   * Snapshot of the Universal Messenger SLO histogram + counters
   * across every protocol the substrate has seen traffic for.
   * Source of truth for the rc.9 ship-gate overnight soak; surfaced
   * via the daemon's localhost-only `/api/slo` endpoint.
   *
   * rc.9 PR-12.
   */
  getMessengerSloStats(): Record<string, SloProtocolStats> {
    return this.messenger.getSloStats();
  }

  /**
   * Snapshot of SWM gossip publish health (rc.9 PR-A).
   *
   * - `publishFailures` — per-cgId count of failed `gossip.publish`
   *   calls. Pre-rc.9 these were silently swallowed; now they're
   *   observable. A non-zero counter is operator-visible signal that
   *   some shares went out-of-band only (local commit succeeded;
   *   catch-up will run via `runSyncOnConnect` on the next peer
   *   reconnect).
   * - `publishFailuresOverflow` — sum of counters that were evicted
   *   when the per-cgId tracking set crossed
   *   `SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS`. Always 0 in normal
   *   deployments; non-zero only when a caller has been failing
   *   publishes against thousands of distinct cgIds.
   * - `publishFailuresTruncated` — sticky boolean, true once the
   *   eviction path has fired. Surfaced via Codex PR #570 R5 so
   *   operators see that the per-cgId breakdown is partial even
   *   though the grand total (`sum(publishFailures) +
   *   publishFailuresOverflow`) is still accurate.
   */
  getSwmGossipStats(): {
    publishFailures: Record<string, number>;
    publishFailuresOverflow: number;
    publishFailuresTruncated: boolean;
  } {
    return diagnostics.getSwmGossipStats({
      publishFailures: this.swmGossipPublishFailures,
      publishFailuresOverflow: this.swmGossipPublishFailuresOverflow,
      publishFailuresTruncated: this.swmGossipPublishFailuresTruncated,
    });
  }

  /**
   * Snapshot of receiver-side SWM apply metrics (rc.9 PR-A).
   *
   * - `redundantApplies` — per-cgId count of times
   *   `SharedMemoryHandler.handle()` saw a (cgId, shareOpId) it had
   *   already processed within the TTL window AND both deliveries
   *   actually applied to the store. Used to inform the rc10
   *   decision on whether to add explicit receiver-side dedup
   *   (Concern-2 in the SWM reliable fan-out plan).
   * - `redundantAppliesLowerBound` — sticky boolean, true once the
   *   seenShareOps cap eviction had to trim a still-live entry.
   *   Surfaced via Codex PR #570 R3 so operators can detect that
   *   the metric has become a lower bound (configured cap too small
   *   for current throughput).
   * - `redundantAppliesOverflow` — sum of per-cgId counters evicted
   *   into the overflow bucket when the per-cgId map crossed the
   *   `redundantAppliesMaxCgs` cap. Surfaced via Codex PR #570 R9.
   * - `redundantAppliesTruncated` — sticky boolean, true once R9
   *   eviction has fired. Means the per-cgId breakdown is partial;
   *   the grand total is still `sum(redundantApplies) +
   *   redundantAppliesOverflow`.
   *
   * Returns the empty / pristine snapshot if the SharedMemoryHandler
   * has not yet been initialised (no SWM share has ever been received
   * locally).
   */
  getSwmHandlerStats(): {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
  } {
    return diagnostics.getSwmHandlerStats(this.sharedMemoryHandler);
  }

  async getPeerDiagnostics(peerId: string): Promise<PeerDiagnostics> {
    return diagnostics.getPeerDiagnostics(
      {
        node: this.node,
        messenger: this.messenger,
        peerHealth: this.peerHealth,
        lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
        syncReconcilerBackoff: this.syncReconcilerBackoff,
      },
      peerId,
    );
  }

  /**
   * Ping all known peers to check liveness. Updates the peerHealth map with
   * latency and last-seen timestamps. Returns the number of peers that responded.
   */
  async pingPeers(): Promise<number> {
    return diagnostics.pingPeers({ node: this.node, peerHealth: this.peerHealth, log: this.log });
  }

  /**
   * Record metadata learned through a discovery channel, then apply the
   * temporary role policy required until core host-mode custody is independent
   * from member subscriptions (#1611):
   *
   * - edge: catalogue only; explicit subscribe/create/join owns activation
   * - core: newly discovered graphs auto-subscribe so ACK-capable nodes keep
   *   the publish/finalization handlers needed to host network data
   *
   * Existing unsubscribed rows are never reactivated here. That preserves an
   * operator's explicit unsubscribe while still allowing authoritative
   * metadata (including an on-chain binding) to enrich the catalogue.
   */
  recordDiscoveredContextGraph(
    contextGraphId: string,
    metadata: ContextGraphDiscoveryMetadata,
    options: ContextGraphDiscoveryOptions = {},
  ): ContextGraphSub {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    const next: ContextGraphSub = {
      ...existing,
      name: metadata.name ?? existing?.name,
      subscribed: existing?.subscribed === true,
      synced: existing?.synced === true,
      sharedMemorySynced: existing?.sharedMemorySynced === true,
      metaSynced: existing?.metaSynced === true,
      participantAgents: metadata.participantAgents ?? existing?.participantAgents,
    };

    if (metadata.onChainId) {
      const bindingChanged = !!existing?.onChainId && existing.onChainId !== metadata.onChainId;
      this.bindSubscriptionOnChainId(contextGraphId, next, metadata.onChainId);
      if (bindingChanged && metadata.onChainHash === undefined) {
        next.onChainHash = undefined;
      }
    }
    if (metadata.onChainHash !== undefined) next.onChainHash = metadata.onChainHash;

    // Discovery-only rows stay in-memory. Metadata learned for an already
    // active member/host row is part of that durable state and must survive a
    // restart (notably a later-discovered onChainId).
    const persistEnrichment = existing?.subscribed === true || existing?.coreHosted === true;
    this.setContextGraphSubscription(contextGraphId, next, { persist: persistEnrichment });

    if (!existing && (this.config.nodeRole ?? 'edge') === 'core') {
      this.subscribeToContextGraph(contextGraphId, {
        trackSyncScope: options.trackSyncScope,
      });
    }

    return this.subscribedContextGraphs.get(contextGraphId) ?? next;
  }

  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, {
      id: string;
      name: string;
      source: 'ontology' | 'meta';
      onChainId?: string;
    }>();

    const collectEntries = (
      rows: Record<string, string>[],
      source: 'ontology' | 'meta',
    ) => {
      for (const row of rows) {
        const uri = row['ctxGraph'] ?? '';
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!id) continue;
        if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

        const existing = discoveredEntries.get(id);
        const rowName = row['name'] ? stripLiteral(row['name']) : undefined;
        const rowOnChainId = row['onChainId'] ? stripLiteral(row['onChainId']) : undefined;
        const ontologyWins = existing?.source === 'meta' && source === 'ontology';
        discoveredEntries.set(id, {
          id,
          name: rowName ?? existing?.name ?? id,
          source: !existing || ontologyWins ? source : existing.source,
          onChainId: rowOnChainId ?? existing?.onChainId,
        });
      }
    };

    const ontologyResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (ontologyResult.type === 'bindings') {
      collectEntries(ontologyResult.bindings as Record<string, string>[], 'ontology');
    }

    // Chain discovery persists the authoritative binding even when it cannot
    // persist a complete rdf:type/name definition. Read those binding-only
    // rows as catalogue entries so an edge restart remains useful while the
    // chain RPC is unavailable.
    const onChainBindingResult = await this.store.query(`
      SELECT ?ctxGraph ?name ?onChainId WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?onChainId .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (onChainBindingResult.type === 'bindings') {
      collectEntries(onChainBindingResult.bindings as Record<string, string>[], 'ontology');
    }

    const metaResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH ?metaGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
          FILTER(STRENDS(STR(?metaGraph), "/_meta"))
        }
      }
    `);
    if (metaResult.type === 'bindings') {
      collectEntries(metaResult.bindings as Record<string, string>[], 'meta');
    }

    this.log.debug(ctx, `Discovery scan found ${discoveredEntries.size} CG(s) in store`);

    for (const { id, name, source, onChainId } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) {
        // Enrich an existing active/hosted record and persist the binding. The
        // central recorder deliberately does not reactivate an existing
        // unsubscribed row, preserving explicit unsubscribe semantics.
        this.recordDiscoveredContextGraph(id, { name, onChainId });
        const current = this.subscribedContextGraphs.get(id) ?? existing;
        // A restart re-seeds `subscribedContextGraphs` from persisted state but
        // does NOT re-add the CG to the SWM-sync scope (`config.syncContextGraphs`,
        // what `getSyncContextGraphs()` and sync-on-connect's shared-memory pass
        // iterate). For a PRIVATE CG the member is a participant in, that means a
        // reconnecting member would data-sync the CG but its on-connect SWM pass
        // would never cover it — the curator-leader REPLACE gate never sees it, so
        // the member stays stale forever. Re-track the sync scope here for curated
        // CGs so this same connect cycle's `newlyDiscovered` set picks it up
        // (refreshing its meta-synced flag) and the shared-memory pass recovers it.
        // `trackSyncContextGraph` is idempotent, so public/already-scoped CGs are
        // unaffected. Gate on `existing.subscribed`: `unsubscribeFromContextGraph`
        // keeps the record but flips `subscribed` to false and drops the CG from
        // `syncContextGraphs`, so re-tracking an explicitly-unsubscribed (or
        // host-only) private CG here would silently undo that operator choice on
        // every discovery scan. Only re-track CGs the node is still a live
        // subscriber of.
        if (current.subscribed && await this.isPrivateContextGraph(id) && this.trackSyncContextGraph(id)) {
          this.log.info(ctx, `Re-tracked already-subscribed private CG "${id.slice(0, 28)}" into the SWM-sync scope on discovery`);
        }
        continue;
      }

      // Both public and curated definitions use the same role boundary:
      //
      // - Edge nodes catalogue the graph only. A user must explicitly
      //   subscribe, create, write, or complete join-approved before the edge
      //   installs gossip handlers and catch-up scope.
      //
      // - Core nodes auto-subscribe while core ACK custody still depends on
      //   the member-subscription machinery. This is a compatibility bridge;
      //   coreHosted remains an independent, ACK-proven durable obligation.
      //   Remove this bridge only with the host-mode separation in #1611.
      //
      //   NOTE: we use `isPrivateContextGraph` (which reads the
      //   ontology OR the _meta graph for `dkg:accessPolicy
      //   "private"`, and also treats any CG with a `DKG_ALLOWED_
      //   AGENT` allowlist as private) rather than
      //   `source === 'meta'`, because the ontology-vs-meta
      //   collision resolver above lets an ontology row shadow a
      //   meta row when both exist for the same id.
      const isCurated = await this.isPrivateContextGraph(id);

      const recorded = this.recordDiscoveredContextGraph(id, { name, onChainId });
      const roleOutcome = recorded.subscribed ? 'auto-subscribed for core hosting' : 'catalogued for explicit edge opt-in';
      this.log.info(
        ctx,
        `Discovered ${isCurated ? 'private/allowlisted ' : ''}context graph "${name}" (${id}) from ${source} store — ${roleOutcome}`,
      );
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store`);
    }
    return discovered;
  }

  async hasContextGraphRegistryScanWatermark(): Promise<boolean> {
    return await this.chain.hasContextGraphRegistryScanWatermark?.() ?? false;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * catalogue any not yet known locally without activating membership.
   *
   * Defaults to a full scan so SDK callers can rebuild missing local state.
   * Background daemon loops may opt into incremental scans to reuse the
   * chain adapter watermark.
   *
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(
    options: DiscoverContextGraphsFromChainOptions = {},
  ): Promise<number> {
    const ctx = createOperationContext('system');
    const scanMode = normalizeContextGraphDiscoveryScan(options);
    const legacyListOptions = legacyChainListScanOptions(options);
    const useLegacyListFallback =
      scanMode.mode !== 'listAll' &&
      legacyListOptions !== undefined &&
      !this.chain.scanContextGraphRegistryPages &&
      !!this.chain.listContextGraphsFromChain;
    if (scanMode.mode === 'listAll' && !this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }
    if (scanMode.mode !== 'listAll' && !this.chain.scanContextGraphRegistryPages && !useLegacyListFallback) {
      this.log.info(ctx, 'Chain adapter does not support scanContextGraphRegistryPages — skipping');
      return 0;
    }

    let onChainContextGraphs: ContextGraphOnChain[] = [];
    let partialChainScan = false;
    let partialChainScanError: unknown;
    const handleChainScanFailure = (err: unknown): ContextGraphOnChain[] | undefined => {
      const message = err instanceof Error ? err.message : String(err);
      const signature = message
        .replace(/stopped after block \d+/g, 'stopped after block N')
        .replace(/\[\d+,\s*\d+\]/g, '[range]')
        .replace(/\b\d+\s+eth_getLogs calls/g, 'N eth_getLogs calls');
      if (this.chainContextGraphScanFailure?.signature !== signature) {
        this.log.warn(ctx, `Chain context graph scan failed: ${message}`);
        this.chainContextGraphScanFailure = { signature, count: 1 };
      } else {
        this.chainContextGraphScanFailure.count += 1;
      }
      const partialError = isContextGraphChainScanPartialError(err);
      if (options.throwOnChainScanFailure && !partialError) throw err;
      if (!partialError) return undefined;
      partialChainScan = true;
      partialChainScanError = err;
      return err.partialResults;
    };

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }
    const readDurableContextGraphOnChainId = async (contextGraphId: string): Promise<string | null> => {
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
      const result = await this.store.query(
        `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?id } } LIMIT 1`,
      );
      if (result.type !== 'bindings' || result.bindings.length === 0) return null;
      const value = result.bindings[0]?.['id'];
      return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
    };

    let discovered = 0;
    const applyDiscoveredContextGraphs = async (contextGraphs: ContextGraphOnChain[]): Promise<void> => {
      for (const p of contextGraphs) {
        if (knownOnChainIds.has(p.contextGraphId)) {
          if (!p.name) continue;
          const durableOnChainId = await readDurableContextGraphOnChainId(p.name);
          if (durableOnChainId === p.contextGraphId) continue;
          knownOnChainIds.delete(p.contextGraphId);
        }

        if (!p.name) {
          // Hash-only entry (metadata not revealed) — record for dedup but don't
          // subscribe to gossip topics since hash-keyed topics are unusable.
          this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
          knownOnChainIds.add(p.contextGraphId);
          continue;
        }

        // Curated CGs (accessPolicy=1) must not silently land in non-participants' lists.
        // We can't query the V10 ContextGraphs participant set from a NameRegistry event alone,
        // so apply the strict default: only catalogue when this node's wallet matches
        // `creator` (the address that called claimName). Real participants will have the CG
        // surfaced through manual subscribe / catch-up triggered by their curator.
        if (Number(p.accessPolicy) === 1) {
          const isCurator = !!this.defaultAgentAddress
            && typeof p.creator === 'string'
            && p.creator.toLowerCase() === this.defaultAgentAddress.toLowerCase();
          if (!isCurator) {
            this.log.info(ctx, `Skipping private chain entry "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — not curator`);
            knownOnChainIds.add(p.contextGraphId);
            continue;
          }
        }

        // Persist the on-chain ID to the ontology graph so the publisher's
        // VM registration guard can find it via RDF (it has no access to
        // the in-memory subscribedContextGraphs map).
        const cgUri = contextGraphDataGraphUri(p.name);
        const ontoGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
        // Single-valued binding guard (RS heal): on-chain id is immutable; clear
        // any prior value so the cgId resolver / heal never read a multi-valued
        // (LIMIT-1-nondeterministic) binding.
        // Keep this durable write before in-memory catalogue mutation: cursor
        // pages are acked after this function returns, and an in-memory onChainId
        // alone must not make a retry skip the RDF binding.
        await this.store.deleteByPattern({
          graph: ontoGraph,
          subject: cgUri,
          predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        });
        await this.store.insert([{
          subject: cgUri,
          predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
          object: `"${p.contextGraphId}"`,
          graph: ontoGraph,
        }]);

        this.recordDiscoveredContextGraph(p.name, {
          name: p.name,
          onChainId: p.contextGraphId,
        }, { trackSyncScope: false });
        this.contextGraphMetaProjection.markDirty(p.name);
        const roleOutcome = (this.config.nodeRole ?? 'edge') === 'core'
          ? 'auto-subscribed for core ACK hosting'
          : 'catalogued (not subscribed)';
        this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — ${roleOutcome}`);
        knownOnChainIds.add(p.contextGraphId);
        discovered++;
      }
    };

    if (scanMode.mode === 'listAll' || useLegacyListFallback) {
      try {
        onChainContextGraphs = await this.chain.listContextGraphsFromChain!(
          undefined,
          useLegacyListFallback ? legacyListOptions : undefined,
        );
      } catch (err) {
        const partialResults = handleChainScanFailure(err);
        if (!partialResults) return 0;
        onChainContextGraphs = partialResults;
      }
      await applyDiscoveredContextGraphs(onChainContextGraphs);
    } else {
      const iterator = this.chain.scanContextGraphRegistryPages!(scanMode)[Symbol.asyncIterator]();
      try {
        while (true) {
          let next: Awaited<ReturnType<typeof iterator.next>>;
          try {
            next = await iterator.next();
          } catch (err) {
            const partialResults = handleChainScanFailure(err);
            if (!partialResults) return 0;
            break;
          }
          if (next.done) break;
          await applyDiscoveredContextGraphs(next.value.contextGraphs);
          await next.value.ack();
        }
      } finally {
        await iterator.return?.();
      }
    }
    if (!partialChainScan && this.chainContextGraphScanFailure) {
      this.log.info(
        ctx,
        `Chain context graph scan recovered after ${this.chainContextGraphScanFailure.count} failed attempt(s)`,
      );
      this.chainContextGraphScanFailure = undefined;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    if (options.throwOnChainScanFailure && partialChainScanError) throw partialChainScanError;
    return discovered;
  }

  /**
   * Snapshot of the V10 Random Sampling prover's recent activity.
   * Returns a disabled-handle status when the prover never started
   * (edge node, no identity, awaiting admission, missing chain methods). Used by the
   * daemon's `/api/random-sampling/status` route + the CLI's
   * `random-sampling status` subcommand.
   */
  getRandomSamplingStatus(): RandomSamplingStatus {
    if (this.randomSamplingHandle) return this.randomSamplingHandle.getStatus();
    return {
      enabled: false,
      role: (this.config.nodeRole ?? 'edge') as 'core' | 'edge',
      identityId: this.randomSamplingIdentityId.toString(),
      disabledReason: this.randomSamplingDisabledReason,
      loop: null,
    };
  }

  /** Wait for the chain scan launched during `start()` through a stable public boundary. */
  async awaitInitialChainPoll(): Promise<void> {
    await this.chainPoller?.waitForCurrentPoll();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      // Await so any in-flight poll (and its HTTP keep-alive socket) settles
      // BEFORE we tear down the chain adapter — otherwise the RPC connection
      // closure surfaces as an `ECONNRESET` unhandled rejection from inside
      // ethers (the same flake that has been hitting `publisher [2/4]` in CI).
      await this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
    if (this.hostModeReconcilerTimer) {
      clearInterval(this.hostModeReconcilerTimer);
      this.hostModeReconcilerTimer = null;
    }
    if (this.hostModePruneTimer) {
      clearInterval(this.hostModePruneTimer);
      this.hostModePruneTimer = null;
    }
    if (this.beaconReannounceTimer) {
      clearInterval(this.beaconReannounceTimer);
      this.beaconReannounceTimer = undefined;
    }
    if (this.agentProfileHeartbeatTimer) {
      clearInterval(this.agentProfileHeartbeatTimer);
      this.agentProfileHeartbeatTimer = undefined;
    }
    if (this.syncReconcilerTimer) {
      clearInterval(this.syncReconcilerTimer);
      this.syncReconcilerTimer = null;
    }
    if (this.warmCoreTimer) {
      clearInterval(this.warmCoreTimer);
      this.warmCoreTimer = null;
    }
    if (this.vmReconcileTimer) {
      clearInterval(this.vmReconcileTimer);
      this.vmReconcileTimer = null;
    }
    if (this.vmReconcileStartupTimer) {
      clearTimeout(this.vmReconcileStartupTimer);
      this.vmReconcileStartupTimer = null;
    }
    // Close admission before any network/store teardown. Pending reconciles
    // are rejected immediately and therefore can never start after shutdown
    // begins; an already-active pass gets a bounded grace period because
    // cancelling midway could strand a partially applied VM transition.
    const vmReconcileDispatcher = this.vmReconcileDispatcher;
    if (vmReconcileDispatcher) {
      const drain = vmReconcileDispatcher.close();
      let drainTimedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          drainTimedOut = true;
          resolve();
        }, DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS);
        timeoutHandle.unref?.();
      });
      await Promise.race([drain, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (drainTimedOut) {
        this.log.warn(
          createOperationContext('system'),
          `DKGAgent.stop: ${vmReconcileDispatcher.snapshot().active} VM reconcile job(s) still active after ${DKGAgentBase.VM_RECONCILE_SHUTDOWN_TIMEOUT_MS}ms drain bound — proceeding with shutdown`,
        );
      }
    }
    this.coreHostRecordingsClosed = true;
    await this.drainCoreHostRecordings();
    if (this.messengerOutboxTimer) {
      clearInterval(this.messengerOutboxTimer);
      this.messengerOutboxTimer = null;
    }
    try {
      await this.messenger.stopOutboxDrain();
    } catch (error) {
      this.log.warn(
        createOperationContext('system'),
        `DKGAgent.stop: outbox retry drain failed during shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.swmAckQuorumTimer) {
      clearInterval(this.swmAckQuorumTimer);
      this.swmAckQuorumTimer = null;
    }
    // rc.9 PR-10: joinApprovalRetryTimer + joinApprovalRetryQueue
    // deleted; substrate outbox owns retry state and drains itself
    // via the messengerOutboxTimer cleared just above.
    this.clearRandomSamplingBindRetry();
    this.clearStorageACKRegistrationRetry();
    this.storageACKRegistrationRetryInFlight = false;
    if (this.randomSamplingHandle) {
      try { await this.randomSamplingHandle.stop(); } catch { /* swallow on shutdown */ }
      this.randomSamplingHandle = null;
    }
    // rc.9 PR-G codex follow-up #G3: drain background substrate
    // fan-outs spawned by `publishWorkspaceGossip` (G2's
    // fire-and-forget detach) before tearing down libp2p. Without
    // this drain, a process that calls `share()` and then
    // shuts down (test runs, soak script SIGTERM, daemon
    // restart) could abandon mid-flight per-peer substrate sends
    // — regressing the pre-G2 guarantee that share() didn't
    // return until every substrate attempt either succeeded or
    // landed in the durable outbox. The bookkeeper still feeds
    // the per-cgId counters during the drain, so /api/slo's
    // last sample before shutdown reflects the true completion
    // state.
    //
    // We bound the wait with `Promise.race` against
    // `SWM_SUBSTRATE_FANOUT_TIMEOUT_MS + 1s`. Per-peer sends
    // already have that timeout; the +1s slack covers post-
    // timeout cleanup (counter update + INFO log emit) for
    // peers that hit the timeout right as `stop()` is called.
    // After the bound we proceed with libp2p teardown even if
    // some fan-outs remain — better to enforce a shutdown SLA
    // than to hang the process indefinitely on one unresponsive
    // peer. The unfinished sends will fall back to outbox on
    // recoverable failures (queued count bumps) just as they
    // would under any other teardown.
    if (this.inFlightSubstrateFanOutCount() > 0) {
      const drainBoundMs = DKGAgent.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS + 1000;
      await Promise.race([
        this.awaitInFlightSubstrateFanOuts(),
        new Promise<void>((resolve) => setTimeout(resolve, drainBoundMs).unref?.()),
      ]);
      if (this.inFlightSubstrateFanOutCount() > 0) {
        this.log.warn(
          createOperationContext('share'),
          `DKGAgent.stop: ${this.inFlightSubstrateFanOutCount()} substrate fan-outs still in flight after ${drainBoundMs}ms drain bound — proceeding with shutdown (outbox will pick up residual queued sends on next start)`,
        );
      }
    }
    // OT-RFC-64 Gate 1: unregister the public catalog protocols and drain the
    // receiver scheduler (awaiting in-flight durable stage writes) while the
    // router, node, and control-object store are all still live — before
    // node.stop() below and before closeRfc64PersistenceV1() releases the store.
    try {
      await this.closeRfc64PublicCatalogBootstrapV1();
      await this.closeRfc64PublicCatalogServiceV1();
    } catch (err) {
      this.log.warn(
        createOperationContext('connect'),
        `RFC-64 public catalog service close failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Tear down any pooled wire-protocol overlays before libp2p
    // stops so per-peer streams close gracefully rather than via
    // libp2p teardown (which would surface as recoverable resets
    // and trigger spurious outbox retries on the very last cycle).
    try {
      await this.router.closePooling();
    } catch {
      // best-effort; libp2p teardown below will close residual streams
    }
    await this.node.stop();
    if (this.syncVerifyWorker) {
      await this.syncVerifyWorker.close();
      this.syncVerifyWorker = undefined;
    }
    // OT-RFC-64 inventory consumers are now stopped. Release the exclusive
    // inventory foundation before the triple store closes, but finish the
    // remaining teardown even when close enters its deliberate fail-stop
    // state. The original close failure is re-thrown after teardown so the
    // operator receives a failed shutdown rather than a false success.
    let inventoryCloseFailed = false;
    let inventoryCloseFailure: unknown;
    try {
      await this.closeRfc64PersistenceV1();
    } catch (error) {
      inventoryCloseFailed = true;
      inventoryCloseFailure = error;
    }
    // Flush WM to disk before exit so the debounced 50ms flush in the
    // Oxigraph adapter can't lose the latest inserts when the process
    // exits. See docs/bugs/wm-persistence-regression.md.
    //
    // `store.close()` now THROWS on durable-write failures (ENOSPC,
    // EACCES, EROFS, etc.) — see oxigraph.ts. We log loudly but do not
    // re-throw because shutdown is unwinding other state too; surfacing
    // the failure to the operator (via stderr + ideally the exit code)
    // is what matters here.
    try {
      await this.store.close();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[DKGAgent.stop] WM final flush FAILED on shutdown: ${(err as Error).message}. ` +
          `The store on disk may be missing recent inserts — operator should investigate ` +
          `(disk full, permission revoked, filesystem read-only, …). ` +
          `See docs/bugs/wm-persistence-regression.md for the durability contract.`,
      );
    }
    this.started = false;
    if (inventoryCloseFailed) throw inventoryCloseFailure;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore, genesisId?: string): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const genesisQuads = getGenesisQuads(genesisId);
    const networkDefinition = genesisQuads.find(
      q => q.predicate === DKG_ONTOLOGY.DKG_GENESIS_VERSION && q.graph === '',
    );
    if (!networkDefinition) {
      throw new Error(`Genesis ${genesisId ?? 'default'} is missing its network definition`);
    }

    const existingGenesis = await store.query(
      `SELECT ?network WHERE {
        ?network <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_NETWORK}> .
        ?network <${DKG_ONTOLOGY.DKG_GENESIS_VERSION}> ?v .
      }`,
    );
    if (existingGenesis.type === 'bindings') {
      const existingSubjects = existingGenesis.bindings
        .map((binding: any) => String(binding.network?.value ?? binding.network).replace(/^<|>$/g, ''));
      const foreignSubjects = existingSubjects.filter(subject => subject !== networkDefinition.subject);
      if (foreignSubjects.length > 0) {
        throw new Error(
          `Triple store contains a different genesis (${foreignSubjects.join(', ')}) than selected ` +
          `${networkDefinition.subject}. Start with an empty DKG home or run the network reset/migration ` +
          `before switching genesis.`,
        );
      }
      if (existingSubjects.includes(networkDefinition.subject)) return;
    }

    // Insert genesis quads
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
  }

  /**
   * Candidate peer pool for ACK collection (#1093 / #1482).
   *
   * `knownCorePeerIds` is populated from identify-time protocol lists in
   * `runSyncOnConnect`, but identify races `connection:open` — so the set
   * routinely contains only a SUBSET of the actually-connected core nodes
   * (the rest were read before their protocol list was populated and were
   * never re-classified). The old behaviour returned that subset as soon
   * as it was non-empty, which permanently capped the ACK pool below
   * quorum (`pool_below_quorum`) and bricked publishing on core nodes.
   *
   * Fix: return confirmed cores FIRST followed by the remaining connected
   * ACK-eligible peers. Do not narrow to a quorum-sized identify-derived tier:
   * the collector fixes the pool once and retries within it, so one stale or
   * saturated classified peer can make quorum impossible while healthy
   * connected-but-unclassified cores sit idle. External callers can still set
   * `ackCandidatePeerIds` as a true allowlist; configured public networks use
   * `preferredACKPeerIds` for relay ranking without excluding connected
   * non-relay cores. Signer validity is enforced per collected ACK against
   * chain truth (operational key + sharding-table membership), so a stale
   * foreign-network connection costs a wasted dial, while hard-gating on the
   * bundled relay list bricked publishing when those relays were degraded
   * (2026-07-07 Base/Gnosis mainnet incident).
   *
   * Folded-private publishes require `PROTOCOL_STORAGE_ACK_V2` because their
   * PublishIntent carries field 20 (`privateMerkleRoots`). Prefer peers that
   * explicitly advertise V2, but do not make peer-store protocol metadata the
   * only gate: StorageACK handlers register after identity resolution, often
   * after peers are already connected, and libp2p identify does not always
   * refresh the stored protocol list. NOTE the wire protocol is not a
   * version gate either — nodes have registered the V2 protocol id (for
   * the LU-11 chunked-ciphertext intent) since v10.0.0-rc.15, so a
   * pre-field-20 core ACCEPTS the V2 dial, silently drops
   * `privateMerkleRoots` on decode, and fails its root recompute (decline
   * or stream abort) rather than failing negotiation. Only the
   * collector-side signature/root checks and on-chain ACK verification
   * are authoritative.
   *
   * `requiredACKs` is still passed through for candidate diagnostics/logging
   * and to keep the selector contract aligned with the collector, but it must
   * not cap the pool. The collector's per-peer verification and on-chain ACK
   * validation remain authoritative.
   */
  public getACKCandidatePeers(protocol: string = PROTOCOL_STORAGE_ACK): string[] {
    const connectedPeerIds = new Set<string>();
    for (const peer of this.node.libp2p.getPeers()) {
      connectedPeerIds.add(peer.toString());
    }
    for (const connection of this.node.libp2p.getConnections()) {
      connectedPeerIds.add(connection.remotePeer.toString());
    }
    const requiredACKs = this.lastKnownRequiredACKs ?? DEFAULT_REQUIRED_ACKS;
    const selection = selectACKCandidatePeersWithDiagnostics({
      connectedPeers: [...connectedPeerIds],
      selfPeerId: this.peerId,
      ackCandidatePeerIds: this.config.ackCandidatePeerIds,
      preferredACKPeerIds: this.config.preferredACKPeerIds,
      verifiedSameNetworkPeerIds: this.networkAdmissionCoordinator.enabled
        ? this.networkAdmissionCoordinator.verifiedSameNetworkPeerIds()
        : undefined,
      knownCorePeerIds: this.knownCorePeerIds,
      knownCorePeerIdsV2: this.knownCorePeerIdsV2,
      requiredACKs,
      protocol,
    });
    const selected = selection.diagnostics
      .filter((diagnostic) => diagnostic.selected)
      .map((diagnostic) => `${diagnostic.peerId.slice(-8)}:${diagnostic.tier}${diagnostic.preferred ? ':preferred' : ''}`)
      .join(',');
    const filtered = selection.diagnostics
      .filter((diagnostic) => !diagnostic.selected)
      .slice(0, 8)
      .map((diagnostic) => `${diagnostic.peerId.slice(-8)}:${diagnostic.reason}`)
      .join(',');
    this.log.info(
      createOperationContext('publish'),
      `[ACKCollector] Selected ${selection.peers.length}/${selection.diagnostics.length} ACK candidate peer(s) ` +
      `(required=${requiredACKs}, protocol=${protocol}, selected=${selected || 'none'}, filtered=${filtered || 'none'})`,
    );
    return selection.peers;
  }

  public createACKTransportFactory(
    options: DKGAgentACKTransportOptions = {},
  ): ACKTransportFactory {
    const timeoutMs = options.sendTimeoutMs ?? this.config.storageAckTiming.sendTimeoutMs;
    return () => ({
      publisherPeerId: this.peerId,
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: this.createACKSendP2P(timeoutMs),
      getConnectedCorePeers: (protocol?: string) => this.getACKCandidatePeers(protocol),
      log: options.log,
    });
  }

  private createACKSendP2P(
    timeoutMs = this.config.storageAckTiming.sendTimeoutMs,
  ): ACKCollectorDeps['sendP2P'] {
    const send = createACKSendP2P({
      messenger: this.messenger,
      timeoutMs,
    });
    return async (peerId: string, protocol: string, data: Uint8Array) => {
      if (!this.networkAdmissionCoordinator.isAcceptedPeer(peerId)) {
        throw new Error(`peer ${peerId.slice(-8)} is not admitted for active-network ACK collection`);
      }
      return send(peerId, protocol, data);
    };
  }

  /**
   * Create a V10 ACK provider callback for the publisher.
   * Uses ACKCollector to broadcast PublishIntent and collect StorageACKs
   * via direct P2P from connected core nodes. The required number of ACKs
   * is read from chain ParametersStorage.minimumRequiredSignatures().
   */
  createV10ACKProvider(contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    // `isV10Ready()` is the authoritative V10 capability gate. Using it
    // (instead of probing for `createKnowledgeAssets`) keeps
    // `NoChainAdapter` — whose stub methods throw — out of the V10 path.
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    // Require on-chain identity verification to prevent accepting unverified ACKs
    // that would fail on-chain and waste gas. Fall back to legacy path if unavailable.
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    // The H5 prefix requires a numeric chain id AND the deployed KAV10
    // address. Without BOTH, the collector cannot build a digest that
    // matches what core-node ACK handlers sign, so refuse to hand back a
    // provider at all rather than crash on the first publish with
    // `chain.getEvmChainId is not a function`. Mirrors the guard at
    // `packages/cli/src/publisher-runner.ts:createV10ACKProviderForPublisher`.
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: this.createACKSendP2P(),
      getConnectedCorePeers: (protocol?: string) => this.getACKCandidatePeers(protocol),
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      // Surface the structured verifier when the chain adapter implements
      // it. Translates a thrown chain-side exception into an explicit
      // `'rpc-error'` reason so the ACKCollector can log infra failures
      // distinctly from definitive key/stake rejections — pre-PR this
      // try/catch swallowed RPC errors as `false`, conflating them.
      verifyIdentityDetailed: typeof this.chain.verifyACKIdentityDetailed === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId);
            } catch {
              return { valid: false, reason: 'rpc-error' as const };
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('publish');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (params: V10ACKProviderParams) => {
      // Fail loud on non-numeric or non-positive CG ids: V10 publish requires
      // a real on-chain context graph and the contract rejects `cgId == 0`
      // with `ZeroContextGraphId`. Reject `<= 0n` (not `=== 0n`) because
      // `BigInt("-1")` returns `-1n` without throwing — a naive zero check
      // would let negative ids through to the evm-adapter pre-tx guard,
      // where ethers' uint256 encoder would throw a cryptic low-level
      // error. Matches the same guard in dkg-publisher, storage-ack-handler,
      // and async publisher-runner so ACK signers, ACK verifiers, and the
      // chain submitter all agree on the legal domain. `contextGraphId`
      // here is the TARGET on-chain id — `swmGraphId` (optional) is the
      // source SWM graph name and is NOT required to be numeric.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(params.contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${params.contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      const allowsEmptyPublicTree = params.ackMode.kind === 'curated-catalog';
      if (
        !Number.isInteger(params.merkleLeafCount)
        || params.merkleLeafCount < 0
        || (params.merkleLeafCount === 0 && !allowsEmptyPublicTree)
      ) {
        throw new Error(
          `V10 ACK collection requires a positive integer merkleLeafCount for public KAs ` +
          `(zero is valid only for curated-catalog ACKs); got ${params.merkleLeafCount}.`,
        );
      }

      // PR3: chain pre-flight reads are split into individual try/catch
      // shells so a failure can be promoted to the typed
      // `RpcPreconditionError` with the specific adapter method that
      // died. Without this discriminator, dzudza-style RPC rate-limits
      // (`-32016 over rate limit` on `eth_chainId`) get logged as the
      // same opaque "V10 ACK collection failed" string as a peer-side
      // QuorumUnmet — operators cannot tell whether to fix their RPC
      // config or their network topology.
      let requiredACKs: number | undefined;
      if (typeof chain.getMinimumRequiredSignatures === 'function') {
        try {
          requiredACKs = await chain.getMinimumRequiredSignatures();
        } catch (err) {
          throw wrapAsRpcPreconditionIfApplicable(err, 'getMinimumRequiredSignatures');
        }
      }
      // Cache the runtime quorum BEFORE collect() so candidate diagnostics
      // report the chain's real requiredACKs instead of the hard-coded default.
      if (typeof requiredACKs === 'number' && requiredACKs > 0) {
        this.lastKnownRequiredACKs = requiredACKs;
      }

      // H5 prefix inputs — both come from the chain adapter so that
      // publisher-side digest construction matches what core-node handlers
      // produced on their side. These are required for any V10 path; the
      // adapter must implement them.
      let chainIdBig: bigint;
      try {
        chainIdBig = await chain.getEvmChainId();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getEvmChainId');
      }
      let kav10Address: string;
      try {
        kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getKnowledgeAssetsLifecycleAddress');
      }

      const result = await collector.collect({
        merkleRoot: params.merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: params.contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize: params.publicByteSize,
        isPrivate: params.ackMode.kind !== 'public',
        kaCount: params.kaCount,
        rootEntities: params.rootEntities,
        chainId: chainIdBig,
        kav10Address,
        requiredACKs,
        stagingQuads: params.stagingQuads,
        epochs: params.epochs,
        tokenAmount: params.tokenAmount,
        swmGraphId: params.swmGraphId,
        subGraphName: params.subGraphName,
        merkleLeafCount: params.merkleLeafCount,
        assetUal: params.assetUal,
        contentScopeVersion: params.contentScopeVersion,
        kaUal: params.kaUal,
        assertionVersion: params.assertionVersion,
        publicTripleCount: params.publicTripleCount,
        privateMerkleRoot: params.privateMerkleRoot,
        privateTripleCount: params.privateTripleCount,
        accessPolicy: params.accessPolicy,
        allowedPeers: params.allowedPeers,
        ackMode: params.ackMode,
      });
      return result.acks;
    };
  }

  /**
   * V10 UPDATE counterpart to {@link createV10ACKProvider}. Returns a
   * closure the publisher calls (after it has sourced the on-chain digest
   * fields via `chain.getUpdateAckDigestFields`) to collect core-node
   * UPDATE StorageACKs over `PROTOCOL_STORAGE_UPDATE_ACK` via the shared
   * {@link ACKCollector.collectUpdate}. Returns `undefined` when the
   * adapter is not V10-capable (same guards as the publish provider), so
   * the publisher leaves `v10UpdateACKs` undefined and the adapter falls
   * back to self-signing on a minSig=1 network.
   */
  createV10UpdateACKProvider(_contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: this.createACKSendP2P(),
      getConnectedCorePeers: (protocol?: string) => this.getACKCandidatePeers(protocol),
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      verifyIdentityDetailed: typeof this.chain.verifyACKIdentityDetailed === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId);
            } catch {
              return { valid: false, reason: 'rpc-error' as const };
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('update');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (params: {
      kaId: bigint;
      contextGraphId: string;
      preUpdateMerkleRootCount: bigint;
      newMerkleRoot: Uint8Array;
      newByteSize: bigint;
      newTokenAmount: bigint;
      mintAmount: bigint;
      burnTokenIds: bigint[];
      newMerkleLeafCount: number;
      newCatalogRoot?: Uint8Array;
      newCatalogLeafCount?: number;
      // OT-RFC-49 / WS-D — `true` for a curated update (the producer sets it
      // from `useEncryptedInlineUpdate`). Forwarded into `collectUpdate` so it
      // stamps `UpdateIntent.isEncryptedPayload`, gating the cores' inline-
      // catalog rebuild/verify/persist path. Undefined for public updates,
      // which carry no catalog (unchanged on a healthy chain). Mirrors the publish
      // closure passing `isEncryptedPayload` into `collect`.
      isEncryptedPayload?: boolean;
      stagingQuads?: Uint8Array;
      swmGraphId?: string;
      subGraphName?: string;
      contentScopeVersion?: number;
      kaUal?: string;
      assertionVersion?: string;
      publicTripleCount?: number;
      privateMerkleRoot?: Uint8Array;
      privateTripleCount?: number;
    }): Promise<V10CoreNodeACK[]> => {
      // The TARGET cgId for the digest is the on-chain numeric id the
      // adapter resolved (`params.contextGraphId`). Reject non-numeric /
      // non-positive ids the same way the publish provider does — the
      // contract rejects `contextGraphId == 0`.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(params.contextGraphId);
      } catch {
        throw new Error(
          `V10 UPDATE ACK collection requires a numeric on-chain context graph id; got '${params.contextGraphId}'.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 UPDATE ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}.`,
        );
      }
      const allowsEmptyPublicTree = params.isEncryptedPayload === true;
      if (
        !Number.isInteger(params.newMerkleLeafCount)
        || params.newMerkleLeafCount < 0
        || (params.newMerkleLeafCount === 0 && !allowsEmptyPublicTree)
      ) {
        throw new Error(
          `V10 UPDATE ACK collection requires a positive integer newMerkleLeafCount for public KAs ` +
          `(zero is valid only for curated encrypted updates); got ${params.newMerkleLeafCount}.`,
        );
      }

      let requiredACKs: number | undefined;
      if (typeof chain.getMinimumRequiredSignatures === 'function') {
        try {
          requiredACKs = await chain.getMinimumRequiredSignatures();
        } catch (err) {
          throw wrapAsRpcPreconditionIfApplicable(err, 'getMinimumRequiredSignatures');
        }
      }
      // Cache the runtime quorum BEFORE collect() so candidate diagnostics
      // report the chain's real requiredACKs instead of the hard-coded default.
      if (typeof requiredACKs === 'number' && requiredACKs > 0) {
        this.lastKnownRequiredACKs = requiredACKs;
      }

      let chainIdBig: bigint;
      try {
        chainIdBig = await chain.getEvmChainId();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getEvmChainId');
      }
      let kav10Address: string;
      try {
        kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getKnowledgeAssetsLifecycleAddress');
      }

      const result = await collector.collectUpdate({
        kaId: params.kaId,
        contextGraphId: cgIdBigInt,
        preUpdateMerkleRootCount: params.preUpdateMerkleRootCount,
        newMerkleRoot: params.newMerkleRoot,
        newByteSize: params.newByteSize,
        newTokenAmount: params.newTokenAmount,
        mintAmount: params.mintAmount,
        burnTokenIds: params.burnTokenIds,
        newMerkleLeafCount: params.newMerkleLeafCount,
        newCatalogRoot: params.newCatalogRoot,
        newCatalogLeafCount: params.newCatalogLeafCount,
        chainId: chainIdBig,
        kav10Address,
        publisherPeerId: this.peerId,
        requiredACKs,
        swmGraphId: params.swmGraphId,
        subGraphName: params.subGraphName,
        stagingQuads: params.stagingQuads,
        // OT-RFC-49 / WS-D — stamp `UpdateIntent.isEncryptedPayload` for a
        // curated update so cores rebuild/verify/persist the inline catalog.
        isEncryptedPayload: params.isEncryptedPayload,
        contentScopeVersion: params.contentScopeVersion,
        kaUal: params.kaUal,
        assertionVersion: params.assertionVersion,
        publicTripleCount: params.publicTripleCount,
        privateMerkleRoot: params.privateMerkleRoot,
        privateTripleCount: params.privateTripleCount,
      });
      return result.acks;
    };
  }

  async broadcastPublish(
    contextGraphId: string,
    result: PublishResult,
    ctx: OperationContext,
    policy?: {
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: string[];
      /** Curated assertions stay on encrypted member channels. */
      curated?: boolean;
    },
  ): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const isGraphScoped = result.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION;
    if (isGraphScoped && policy?.curated) {
      this.log.info(
        ctx,
        `Skipping ordinary publish gossip for curated graph-scoped KA ${result.ual}; ` +
          'the assertion is distributed only through encrypted member channels',
      );
      return;
    }
    const graphScope = isGraphScoped
      ? createGraphKnowledgeAssetScope(result.ual, result.assertionVersion ?? '')
      : undefined;
    const exactGraph = graphScope
      ? knowledgeAssetLayerGraphUri(
          contextGraphId,
          MemoryLayer.VerifiableMemory,
          graphScope,
          result.subGraphName,
        )
      : undefined;
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return exactGraph
        ? `<${q.subject}> <${q.predicate}> ${obj} <${exactGraph}> .`
        : `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const accessPolicy = result.accessPolicy
      ?? policy?.accessPolicy
      ?? ((result.privateTripleCount ?? 0) > 0 ? 'ownerOnly' : 'public');
    const allowedPeers = result.allowedPeers ?? policy?.allowedPeers ?? [];

    const onChain = result.onChainResult;
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: new TextEncoder().encode(ntriples),
      contextGraphId: contextGraphId,
      kas: isGraphScoped
        ? []
        : result.kaManifest.map(ka => ({
            tokenId: ka.tokenId,
            rootEntity: ka.rootEntity,
            privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
            privateTripleCount: ka.privateTripleCount ?? 0,
          })),
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: onChain?.publisherAddress ?? '',
      startKAId: onChain?.startKAId ?? 0n,
      endKAId: onChain?.endKAId ?? 0n,
      chainId: this.chain.chainId,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash: onChain?.txHash ?? '',
      blockNumber: onChain?.blockNumber ?? 0,
      operationId: ctx.operationId,
      subGraphName: result.subGraphName,
      ...(graphScope
        ? {
            contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
            assertionVersion: graphScope.assertionVersion,
            publicTripleCount: result.publicTripleCount ?? 0,
            ...(result.privateMerkleRoot
              ? { privateMerkleRoot: result.privateMerkleRoot }
              : {}),
            privateTripleCount: result.privateTripleCount ?? 0,
            accessPolicy,
            allowedPeers,
          }
        : {}),
    });

    const topic = contextGraphPublishTopic(contextGraphId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  get assertion() {
    const agent = this;
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    return {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string; agentAddress?: string }): Promise<string> {
        // D1 (identity-at-create): mint the KA number/UAL at create so the UAL is the
        // KA's identity from the first write. assertionCreate only allocates when the
        // draft has no preserved kaId (the re-open guard lives there), so passing the
        // callback is safe — re-opens reuse the preserved identity.
        //
        // Gate on a valid 0x EVM author: when no default agent is registered,
        // `agentAddress` falls back to the libp2p peerId, which the allocator rejects
        // (`ethers.getAddress` throws). A peerId-author draft falls back to the legacy
        // name-keyed WM graph instead of hard-failing create. Mirrors the publisher's
        // own self-allocation guard.
        // Allow an explicit author (the daemon's import-file route acts for the request's
        // agent) so the kaNumber mints for the RIGHT address and data lands in that agent's
        // per-KA …/_working_memory/{addr}/{number} graph (not the default agent's, and not
        // the legacy name-keyed fallback used when no number is minted).
        const author = opts?.agentAddress ?? agentAddress;
        const isEvmAuthor = /^0x[a-fA-F0-9]{40}$/.test(author);
        const allocateKaNumber = agent.kaNumberAllocator && isEvmAuthor
          ? () => reconcileAndAllocateKaNumber(agent.kaNumberAllocator!, agent.chain, agent.reconciledKaAuthors, author)
          : undefined;
        return agent.publisher.assertionCreate(contextGraphId, name, author, opts?.subGraphName, { allocateKaNumber });
      },

      /**
       * Write triples to a WM assertion. Accepts:
       * - `Quad[]` — standard quad array (same as publish/share)
       * - `JsonLdContent` — JSON-LD document, auto-converted to quads
       * - `Array<{ subject, predicate, object }>` — simple triple array
       */
      async write(
        contextGraphId: string,
        name: string,
        input: import('@origintrail-official/dkg-storage').Quad[] | JsonLdContent | Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string; agentAddress?: string },
      ): Promise<void> {
        const writeAgentAddress = opts?.agentAddress ?? agentAddress;
        let publicQuads: import('@origintrail-official/dkg-storage').Quad[] = [];
        let privateQuads: import('@origintrail-official/dkg-storage').Quad[] = [];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          publicQuads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          ({ publicQuads, privateQuads } = await jsonLdToQuads(
            input as JsonLdContent,
            { syntheticPrivateAnchor: false },
          ));
        } else {
          publicQuads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        if (publicQuads.length > 0) {
          await agent.publisher.assertionWrite(
            contextGraphId,
            name,
            writeAgentAddress,
            publicQuads,
            opts?.subGraphName,
          );
        }
        if (privateQuads.length > 0) {
          await agent.publisher.assertionWritePrivate(
            contextGraphId,
            name,
            writeAgentAddress,
            privateQuads,
            opts?.subGraphName,
          );
        }
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string; agentAddress?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        const queryAgentAddress = opts?.agentAddress ?? agentAddress;
        return agent.publisher.assertionQuery(contextGraphId, name, queryAgentAddress, opts?.subGraphName);
      },
      async queryPrivate(contextGraphId: string, name: string, opts?: { subGraphName?: string; agentAddress?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        const queryAgentAddress = opts?.agentAddress ?? agentAddress;
        return agent.publisher.assertionQueryPrivate(contextGraphId, name, queryAgentAddress, opts?.subGraphName);
      },
      /** Re-open a sealed rootless KA from its exact SWM/VM graph. */
      async pullFrom(
        contextGraphId: string,
        name: string,
        sourceLayer: 'swm' | 'vm',
        opts?: { subGraphName?: string; agentAddress?: string; onConflict?: 'reject' | 'replace' },
      ): Promise<{
        seeded: number;
        seededPublic: number;
        seededPrivate: number;
        fromLayer: 'swm' | 'vm';
        contentScopeVersion: number;
        kaUal: string;
        assertionVersion: string;
      }> {
        const pullAgentAddress = opts?.agentAddress ?? agentAddress;
        return agent.publisher.assertionPullFrom(contextGraphId, name, pullAgentAddress, sourceLayer, {
          ...(opts?.subGraphName !== undefined ? { subGraphName: opts.subGraphName } : {}),
          ...(opts?.onConflict !== undefined ? { onConflict: opts.onConflict } : {}),
        });
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string; agentAddress?: string; authorAgentAddress?: string; preSignedAuthorAttestation?: PreSignedAuthorAttestation; awaitCuratorAck?: boolean; curatorAckTimeoutMs?: number; skipSeal?: boolean }): Promise<{ promotedCount: number; sealed: boolean; publishReady: boolean; shareOperationId?: string }> {
        const promoteAgentAddress = opts?.agentAddress ?? agentAddress;
        if (opts?.skipSeal) {
          throw Object.assign(
            new Error(
              'Graph-scoped Knowledge Assets must be finalized before sharing; unsealed SWM mutation is read-only legacy behavior.',
            ),
            { code: 'UNSEALED_SHARE_BLOCKED' },
          );
        }
        if (opts?.entities && opts.entities !== 'all') {
          throw Object.assign(
            new Error(
              'A graph-scoped Knowledge Asset is atomic. Create a new KA instead of sharing a subject subset.',
            ),
            { code: 'KA_ATOMIC_SHARE_REQUIRED' },
          );
        }
        // Seal-before-share: the on-chain publish path
        // (`publishFromFinalizedAssertion`) requires a FINALIZED assertion, and
        // the seal must be computed over the Working-Memory content BEFORE
        // promote moves it to SWM and empties WM (you cannot finalize afterwards
        // — no quads left to hash). The canonical create→finalize→promote→publish
        // flow already finalizes; this makes the UI/HTTP promote→publish flow —
        // which has no explicit finalize step — work too.
        //
        // ALWAYS call `assertionFinalize`, never a "does a seal already exist?"
        // short-circuit. assertionFinalize is itself idempotent: it returns the
        // EXISTING seal untouched when its merkleRoot still matches the current
        // WM (so an explicit finalize's author signature is preserved, never
        // clobbered with the daemon signer), and it THROWS if the assertion was
        // edited after finalize (stale seal) or the seal is corrupt. The old
        // existence-only skip bypassed that check and would promote stale content
        // that fails later at publish with a confusing merkleRoot mismatch.
        // Thread the caller's author through (mirroring the explicit finalize
        // route) so the seal attests the intended author rather than silently
        // falling back to the daemon signer.
        //
        // Atomic-share options were normalized above. The helper owns draft
        // readiness; assertionPromote owns exact SWM/VM replay validation.
        try {
          await agent.prepareAtomicAssertionShare(contextGraphId, name, promoteAgentAddress, {
            subGraphName: opts?.subGraphName,
            authorAgentAddress: opts?.authorAgentAddress,
            preSignedAuthorAttestation: opts?.preSignedAuthorAttestation,
          });
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          // Classify finalize failures so capability gaps retain a stable API
          // code while validation/integrity errors keep their original detail.
          //
          // Capability gaps carry the stable SEAL_CAPABILITY_GAP code (tagged at the
          // assertionFinalize throw sites). The message regex is a back-compat
          // fallback ONLY for the same known capability messages, in case an error
          // was re-wrapped and lost its code — it must NOT broaden the net to
          // validation errors.
          const isCapabilityGap =
            err?.code === SEAL_CAPABILITY_GAP_CODE ||
            /requires a V10-capable chain adapter|has no private key on file|no publisher signer is available|failed to reconcile KA-number floor|no\s+kaNumberAllocator is configured/i.test(msg);
          if (!isCapabilityGap) {
            // Validation/integrity (incl. the stale-seal / corrupt-seal cases that
            // were previously special-cased) — fail fast with the real error. WM is
            // preserved because we throw BEFORE assertionPromote.
            throw err;
          }
          // Fail closed before assertionPromote so WM remains intact.
          throw Object.assign(
            new Error(
              `Cannot seal "${name}" for sharing to Shared Memory — the asset would be left ` +
                `unpublishable and Working Memory was NOT emptied. ${msg}`,
            ),
            {
              code: 'UNSEALED_SHARE_BLOCKED',
              recovery:
                'Resolve the signing capability (a local agent key + a V10 chain adapter), then retry.',
            },
          );
        }
        const sealed = true;
        // Resolve the gossip signer up-front (mirrors `share()` /
        // `conditionalShare()` patterns) so the publisher can wrap the
        // promoted SWM gossip in the Sender Key encrypted envelope.
        // Without this, private/agent-gated CGs receive plaintext
        // gossip and the new `SharedMemoryHandler` check rejects it.
        const gossipSigner = await agent.resolveWorkspaceGossipSigningAgent(contextGraphId);
        // Strict curator-ack gate (OT-RFC-49 curator-leader) for the WM→SWM
        // promote path — the same confirmer as share()/conditionalShare(). When
        // armed (private CG, gate enabled, curator remote), assertionPromote
        // requires the curator's applied-ack BEFORE it moves WM→SWM, so an
        // unconfirmed promote aborts (CuratorUnconfirmedError → 503) leaving WM
        // intact instead of silently committing a write the curator never got.
        const confirmBeforeCommit = await agent.buildCuratorAckConfirmer(
          contextGraphId,
          gossipSigner,
          { awaitCuratorAck: opts?.awaitCuratorAck, curatorAckTimeoutMs: opts?.curatorAckTimeoutMs },
          createOperationContext('share'),
        );
        const { promotedCount, gossipMessage, promotedAllRoots, shareOperationId } = await agent.publisher.assertionPromote(
          contextGraphId, name, promoteAgentAddress,
          {
            ...(opts?.subGraphName !== undefined ? { subGraphName: opts.subGraphName } : {}),
            publisherPeerId: agent.node.peerId.toString(),
            senderAgentAddress: gossipSigner?.agentAddress,
            confirmBeforeCommit,
          },
        );
        if (gossipMessage) {
          try {
            // Preserve the immutable operation id through the fan-out seam.
            // Direct share() already does this; assertion promotion previously
            // dropped it, so receiver acknowledgements/watchdog retries could
            // not be correlated for imported (including Markdown) KAs.
            await agent.publishWorkspaceGossip(
              contextGraphId,
              gossipMessage,
              createOperationContext('share'),
              gossipSigner,
              shareOperationId,
            );
          } catch (err: any) {
            agent.log.warn(createOperationContext('share'), `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
          }
        }
        // OT-RFC-43 A2 (decision 2) — stamp dkg:swmCurrentAssertion on the
        // lifecycle URN so the SWM pointer is observable (and can diverge from
        // WM/VM). Best-effort; never blocks the share result.
        await agent._stampSwmPointer(contextGraphId, name, promoteAgentAddress, opts?.subGraphName);
        // #1116 (round 9) — the swmShareComplete marker mark/clear now lives INSIDE
        // assertionPromote (co-located with the member-row REPLACE, gated on the
        // same isFullCompletePromote), so it stays in lockstep with the rows for
        // EVERY caller of the public assertionPromote — not just this wrapper. The
        // `promotedAllRoots` result is still used below for `publishReady`.
        // A repaired/replayed share has promotedCount=0 but retains its durable
        // shareOperationId. It is just as publish-ready as the first response;
        // a VM no-op has no share operation id and remains false here.
        const publishReady = sealed && promotedAllRoots && !!shareOperationId;
        return { promotedCount, sealed, publishReady, ...(shareOperationId ? { shareOperationId } : {}) };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string; agentAddress?: string }): Promise<void> {
        const discardAgentAddress = opts?.agentAddress ?? agentAddress;
        return agent.publisher.assertionDiscard(contextGraphId, name, discardAgentAddress, opts?.subGraphName);
      },

      /**
       * RFC-001 §9.x — finalize a Working Memory assertion.
       *
       * This is the moment the assertion's content is cryptographically
       * committed to a chain target: the daemon computes the canonical
       * merkleRoot from the assertion's quads, builds the EIP-712
       * AuthorAttestation typed data, signs it (or verifies a pre-signed
       * payload), and stamps the result as a block of `_meta` triples
       * keyed by the assertion URI.
       *
       * After finalize, the assertion's content is sealed: subsequent
       * `write` calls would invalidate the seal. The seal travels with
       * the assertion through SWM gossip (because `_meta` propagates by
       * default) and is consumed verbatim by the chain publish path —
       * publish never re-signs or re-hashes.
       *
       * Authorship resolution mirrors `publishFromSharedMemory`:
       *   1. `preSignedAuthorAttestation` wins (self-sovereign agents).
       *   2. `authorAgentAddress` → custodial agent's private key from
       *      the local keystore.
       *   3. Otherwise → throw. The route layer is responsible for
       *      defaulting to the request token's agent (or to the
       *      publisher EOA when an admin token is presented).
       *
       * Idempotent: re-finalizing an already-sealed assertion with the
       * same content returns the existing seal without re-signing. A
       * conflicting re-finalize (different content / author) throws.
       */
      async finalize(
        contextGraphId: string,
        name: string,
        opts?: {
          subGraphName?: string;
          agentAddress?: string;
          authorAgentAddress?: string;
          preSignedAuthorAttestation?: PreSignedAuthorAttestation;
          authorSignTypedData?: (
            typedData: AuthorAttestationTypedData,
          ) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
          schemeVersion?: number;
          /**
           * @deprecated `"swm"` remains recognizable only so mixed-version
           * callers get the stable `LEGACY_KA_READ_ONLY` error. New KAs are
           * sealed in WM and shared atomically; existing root-scoped SWM assets
           * are readable but cannot be reconstructed, resealed, or migrated.
           */
          layer?: 'wm' | 'swm';
        },
      ): Promise<{
        assertionUri: string;
        merkleRoot: Uint8Array;
        authorAddress: string;
        schemeVersion: number;
        chainId: bigint;
        kav10Address: string;
        eip712Digest: string;
      }> {
        const finalizeAgentAddress = opts?.agentAddress ?? agentAddress;
        if (opts?.layer === 'swm') {
          throw new LegacyKnowledgeAssetReadOnlyError();
        }
        return agent.assertionFinalize(contextGraphId, name, finalizeAgentAddress, {
          subGraphName: opts?.subGraphName,
          authorAgentAddress: opts?.authorAgentAddress,
          preSignedAuthorAttestation: opts?.preSignedAuthorAttestation,
          authorSignTypedData: opts?.authorSignTypedData,
          schemeVersion: opts?.schemeVersion,
        });
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionHistoryDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Lifecycle URNs predate the canonical lowercase per-layer graph layout
        // and therefore preserve the address spelling used by their writer.
        // An explicit author-scoped read may supply the same EVM identity in a
        // different case (notably an address copied from the now-canonical WM
        // graph URI). Try the caller spelling first for exact legacy semantics,
        // then its EIP-55 and lowercase equivalents. The resolved subject must
        // be carried into the event/root queries below; rebuilding it from the
        // caller spelling would silently split one lifecycle into two.
        const lifecycleAddresses = [addr];
        if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
          const lowercase = addr.toLowerCase();
          const checksummed = ethers.getAddress(lowercase);
          for (const candidate of [checksummed, lowercase]) {
            if (!lifecycleAddresses.includes(candidate)) lifecycleAddresses.push(candidate);
          }
        }

        let lifecycleUri: string | undefined;
        let row: Record<string, string> | undefined;
        for (const lifecycleAddress of lifecycleAddresses) {
          const candidateLifecycleUri = assertionLifecycleUri(
            contextGraphId,
            lifecycleAddress,
            name,
            opts?.subGraphName,
          );
          const entityResult = await agent.store.query(
            `SELECT ?state ?memoryLayer ?assertionGraph ?wm ?swm ?vm ?currentShareOpId ?kaNum ?reservedUal ?publishedUal ?contentScopeVersion WHERE {
              GRAPH <${metaGraph}> {
                <${candidateLifecycleUri}> <${DKG_NS}state> ?state .
                OPTIONAL { <${candidateLifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
                OPTIONAL { <${candidateLifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
                OPTIONAL { <${candidateLifecycleUri}> <${WM_CURRENT_ASSERTION_PRED}> ?wm }
                OPTIONAL { <${candidateLifecycleUri}> <${SWM_CURRENT_ASSERTION_PRED}> ?swm }
                OPTIONAL { <${candidateLifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
                OPTIONAL { <${candidateLifecycleUri}> <${DKG_NS}shareOperationId> ?currentShareOpId }
                OPTIONAL { <${candidateLifecycleUri}> <${KA_ID_PRED}> ?kaNum }
                OPTIONAL { <${candidateLifecycleUri}> <${RESERVED_UAL_PRED}> ?reservedUal }
                OPTIONAL { <${candidateLifecycleUri}> <${DKG_NS}publishedUal> ?publishedUal }
                OPTIONAL { <${candidateLifecycleUri}> <${DKG_NS}contentScopeVersion> ?contentScopeVersion }
              }
            } LIMIT 1`,
          );
          if (entityResult.type === 'bindings' && entityResult.bindings.length > 0) {
            lifecycleUri = candidateLifecycleUri;
            row = entityResult.bindings[0];
            break;
          }
        }
        if (!lifecycleUri || !row) return null;

        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const persistedGraphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);
        // RFC ka-metadata-trim Phase 2 — the wm/swm pointers are only
        // materialised when they DIVERGE from VM (the "all three equal"
        // steady state is implicit). COALESCE a missing wm/swm to the vm
        // value; old-store rows (always materialised) read identically.
        const vmCurrentAssertion = strip(row['vm']);
        const wmCurrentAssertion = strip(row['wm']) ?? vmCurrentAssertion;
        const swmCurrentAssertion = strip(row['swm']) ?? vmCurrentAssertion;
        const currentShareOperationId = strip(row['currentShareOpId']);
        const kaNumberStr = strip(row['kaNum']);
        const reservedUal = strip(row['reservedUal']);
        const publishedUal = strip(row['publishedUal']);
        const graphUri = canonicalRootlessLifecycleGraph({
          contextGraphId,
          contentScopeVersion: strip(row['contentScopeVersion']),
          reservedUal,
          memoryLayer: layerStr,
          subGraphName: opts?.subGraphName,
          persistedGraph: persistedGraphUri,
        });

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        // RFC ka-metadata-trim Phase 0: the `OPTIONAL { ?event dkg:kcUal }`
        // clause was removed — its only producer was the dead
        // `generateAssertionPublishedMetadata` writer, so the binding never
        // surfaced for live events.
        // RFC ka-metadata-trim Phase 2 — read-both event shape:
        //   - `dkg:fromLayer`/`dkg:toLayer` are no longer written (they are
        //     100% determined by the event class); OPTIONAL here for
        //     old-store rows, derived below otherwise.
        //   - the event-side `dkg:rootEntity` rows are no longer written for
        //     promote events; OPTIONAL here for old-store rows, with the
        //     stable lifecycle-subject member stamp as the fallback below.
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              OPTIONAL { ?event <${DKG_NS}fromLayer> ?fromLayer }
              OPTIONAL { ?event <${DKG_NS}toLayer> ?toLayer }
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Member entities on the STABLE lifecycle subject (SUBSTRATE-1 stamp,
        // written at promote). Read-both (ENTITY_PRED_ALT) + DISTINCT because
        // dual-written replica rows carry the same object under both names.
        const subjectRoots: string[] = [];
        const subjectRootsResult = await agent.store.query(
          `SELECT DISTINCT ?root WHERE {
            GRAPH <${metaGraph}> { <${lifecycleUri}> ${ENTITY_PRED_ALT} ?root }
          }`,
        );
        if (subjectRootsResult.type === 'bindings') {
          for (const b of subjectRootsResult.bindings) {
            if (b['root']) subjectRoots.push(b['root']);
          }
        }

        // Layer transition by event class (the writers no longer persist it):
        //   created  ⇒ none→WM   · promoted  ⇒ WM→SWM
        //   updated  ⇒ VM→VM     · discarded ⇒ WM→none
        const LAYER_BY_TYPE: Record<string, { from: string; to: string }> = {
          created: { from: 'none', to: MemoryLayer.WorkingMemory },
          promoted: { from: MemoryLayer.WorkingMemory, to: MemoryLayer.SharedWorkingMemory },
          published: { from: MemoryLayer.SharedWorkingMemory, to: MemoryLayer.VerifiableMemory },
          updated: { from: MemoryLayer.VerifiableMemory, to: MemoryLayer.VerifiableMemory },
          discarded: { from: MemoryLayer.WorkingMemory, to: 'none' },
        };

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              const derived = LAYER_BY_TYPE[typeSuffix];
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? derived?.from ?? '',
                toLayer: strip(b['toLayer']) ?? derived?.to ?? '',
                shareOperationId: strip(b['shareOpId']),
                rootEntities: b['rootEntity'] ? [b['rootEntity']] : undefined,
              });
            } else if (b['rootEntity']) {
              const existing = eventMap.get(eventUri)!;
              if (!existing.rootEntities) existing.rootEntities = [];
              if (!existing.rootEntities.includes(b['rootEntity'])) {
                existing.rootEntities.push(b['rootEntity']);
              }
            }
          }
          // RFC ka-metadata-trim Phase 2 — promote events written by this
          // release carry no event-side member rows; surface the lifecycle-
          // subject member stamp instead so `events[].rootEntities` (API/MCP
          // descriptor pass-through) keeps resolving.
          for (const ev of eventMap.values()) {
            if (ev.type === 'promoted' && !ev.rootEntities && subjectRoots.length > 0) {
              ev.rootEntities = [...subjectRoots];
            }
            if (ev.type === 'promoted' && !ev.shareOperationId && currentShareOperationId) {
              ev.shareOperationId = currentShareOperationId;
            }
          }
        }

        // OT-RFC-43 A2 (decision 5) — derive the §10.5.4 status from the
        // pointers + state and surface the three pointers so per-layer
        // divergence (WM ahead of VM after pull-from, etc.) is observable.
        const pointers = { state: stateStr, wmCurrentAssertion, swmCurrentAssertion, vmCurrentAssertion };
        return {
          contextGraphId,
          agentAddress: addr,
          name,
          state: stateStr,
          memoryLayer: (layerStr as MemoryLayer) ?? null,
          assertionGraph: graphUri,
          events: [...eventMap.values()],
          wmCurrentAssertion,
          swmCurrentAssertion,
          vmCurrentAssertion,
          currentShareOperationId,
          status: deriveStatus(pointers),
          kaNumber: kaNumberStr,
          reservedUal,
          publishedUal,
        };
      },

      /**
       * OT-RFC-43 B3 — resolve a Knowledge Asset by its packed kaId back to a
       * lifecycle descriptor. The B3 route classifier packs an incoming
       * `(agent, number)` or `did:dkg` UAL into `kaId`; this unpacks the low
       * 96 bits (the per-author NUMBER) and matches the `dkg:kaId` stamped on
       * the lifecycle URN at finalize. Works pre-publish (the stamp exists
       * post-finalize) AND post-publish. Returns the same descriptor shape as
       * `history()`.
       */
      async resolveByKaId(
        contextGraphId: string,
        kaId: bigint,
        opts?: { subGraphName?: string },
      ): Promise<AssertionHistoryDescriptor | null> {
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        // number = kaId & ((1<<96)-1) — the per-author low-96-bit half.
        const number = kaId & ((1n << 96n) - 1n);
        const expectedAuthor = '0x' + (kaId >> 96n).toString(16).padStart(40, '0');
        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;
        // FILTER on the integer value so a typed literal ("N"^^xsd:integer)
        // matches regardless of the store's lexical canonicalisation.
        const PROV_NS = 'http://www.w3.org/ns/prov#';
        const res = await agent.store.query(
          `SELECT ?lifecycle ?name ?author WHERE {
            GRAPH <${metaGraph}> {
              ?lifecycle <${DKG_NS}kaId> ?n .
              FILTER(?n = ${number})
              OPTIONAL { ?lifecycle <${DKG_NS}assertionName> ?name }
              OPTIONAL { ?lifecycle <${PROV_NS}wasAttributedTo> ?author }
            }
          }`,
        );
        if (res.type !== 'bindings' || res.bindings.length === 0) return null;

        let resolvedName: string | undefined;
        let resolvedAgent: string | undefined;
        for (const b of res.bindings) {
          const candidateName = strip(b['name']);
          if (!candidateName) continue;
          // Recover the author in the EXACT case stored on the lifecycle URN so the
          // history() rebuild (which re-derives urn:dkg:assertion:{cg}[:{sub}]:{author}:{name})
          // matches. We do NOT parse dkg:assertionGraph for this: for any KA that
          // has a kaId (the only kind resolveByKaId matches) the pointer is the
          // layer-keyed form (…/_working_memory|_shared_…|_verifiable_memory/{author}/{number}),
          // never the legacy /assertion/{agent}/{name} shape, and the VM re-stamp
          // lowercases the address (derived from the packed kaId bits) — so a
          // pointer parse would hand history() a case-mismatched author that fails
          // to resolve published assets authored by anyone but the default agent.
          // Slice the author out of the matched lifecycle URN instead, bounding the
          // cut with the already-known cg / sub / name (robust to ':' in cg/name).
          let candidateAgent: string | undefined;
          const lifecycleUrn = b['lifecycle'];
          if (typeof lifecycleUrn === 'string') {
            const sub = opts?.subGraphName;
            const prefix = `urn:dkg:assertion:${contextGraphId}:${sub ? `${sub}:` : ''}`;
            const suffix = `:${candidateName}`;
            if (lifecycleUrn.startsWith(prefix) && lifecycleUrn.endsWith(suffix)) {
              const mid = lifecycleUrn.slice(prefix.length, lifecycleUrn.length - suffix.length);
              if (mid && !mid.includes(':')) candidateAgent = mid;
            }
          }
          // Fallback: the prov:wasAttributedTo author DID (did:dkg:agent:<author>)
          // for any record whose URN bounds we couldn't pin down.
          if (!candidateAgent) {
            const author = b['author'];
            if (typeof author === 'string') {
              const am = author.match(/^did:dkg:agent:(.+)$/);
              if (am) candidateAgent = am[1];
            }
          }
          if (candidateAgent?.toLowerCase() === expectedAuthor.toLowerCase()) {
            resolvedName = candidateName;
            resolvedAgent = candidateAgent;
            break;
          }
        }
        if (!resolvedName || !resolvedAgent) return null;
        return this.history(contextGraphId, resolvedName, {
          subGraphName: opts?.subGraphName,
          ...(resolvedAgent ? { agentAddress: resolvedAgent } : {}),
        });
      },

      // ── Async promote (RFC: docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md) ──
      //
      // These five methods are thin pass-throughs to the queue. The
      // worker that actually drains the queue lives in the daemon (PR
      // #3); on this surface we only enqueue, inspect, cancel, and
      // recover. No memoryGraphChanged event is emitted at enqueue time
      // — emission happens when the worker reports success.
      async promoteAsync(
        contextGraphId: string,
        name: string,
        opts?: { entities?: readonly string[] | 'all'; subGraphName?: string; agentAddress?: string; authorAgentAddress?: string },
      ): Promise<{ jobId: string }> {
        const promoteAgentAddress = opts?.agentAddress ?? agentAddress;
        const jobId = await agent.promoteQueue.enqueue({
          contextGraphId,
          assertionName: name,
          subGraphName: opts?.subGraphName,
          entities: opts?.entities ?? 'all',
          ...(promoteAgentAddress ? { agentAddress: promoteAgentAddress } : {}),
          ...(opts?.authorAgentAddress ? { authorAgentAddress: opts.authorAgentAddress } : {}),
        });
        return { jobId };
      },
      async getPromoteAsyncStatus(jobId: string): Promise<PromoteJob | null> {
        return agent.promoteQueue.getStatus(jobId);
      },
      async listPromoteAsyncJobs(filter?: PromoteListFilter): Promise<PromoteJob[]> {
        return agent.promoteQueue.list(filter);
      },
      async cancelPromoteAsync(jobId: string): Promise<void> {
        return agent.promoteQueue.cancel(jobId);
      },
      async recoverPromoteAsync(jobId: string): Promise<void> {
        return agent.promoteQueue.recover(jobId);
      },
    };
  }

  /**
   * Lazily-constructed async-promote queue. First access materialises
   * the `TripleStoreAsyncPromoteQueue` against `this.store`; subsequent
   * accesses return the same instance. The queue's control graph
   * (`urn:dkg:promote-queue:control-plane`) lives in the same triple
   * store as everything else, so it survives daemon restarts.
   *
   * Exposed publicly so PR #3's worker loop can drive the worker-side
   * surface (`claimNext` / `heartbeat` / `succeed` / `fail` /
   * `recordCommitMarker` / `recoverOnStartup`) without the assertion
   * subsurface having to leak those methods to user-facing callers.
   */
  get promoteQueue(): AsyncPromoteQueue {
    if (!this._promoteQueue) {
      this._promoteQueue = new TripleStoreAsyncPromoteQueue(this.store, this._promoteQueueConfig ?? {});
    }
    return this._promoteQueue;
  }

  /**
   * Override the promote-queue config (e.g. inject deterministic
   * `now`/`idGenerator` for tests, or tune `maxRetries`/`leaseMs` from
   * daemon config). Must be called BEFORE the first `promoteQueue`
   * access; throws otherwise so the override doesn't silently no-op.
   */
  configurePromoteQueue(config: Partial<AsyncPromoteQueueConfig>): void {
    if (this._promoteQueue) {
      throw new Error('configurePromoteQueue must be called before the queue is first accessed');
    }
    this._promoteQueueConfig = config;
  }

}


export interface DKGAgent extends ImportedArtifactMethods, ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods, ContextGraphResolveMethods, OwnershipMethods, Rfc64CatalogMethods, Rfc64CatalogSyncMethods, Rfc64CatalogUpsertMethods, Rfc64CatalogAutoPublishMethods, Rfc64CatalogBootstrapMethods {}
applyMixins(DKGAgent, [ImportedArtifactMethods, ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods, ContextGraphResolveMethods, OwnershipMethods, Rfc64CatalogMethods, Rfc64CatalogSyncMethods, Rfc64CatalogUpsertMethods, Rfc64CatalogAutoPublishMethods, Rfc64CatalogBootstrapMethods]);
