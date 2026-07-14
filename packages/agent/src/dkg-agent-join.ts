// SPDX-License-Identifier: Apache-2.0

/**
 * Join-request subsystem extracted from dkg-agent.ts as a mixin holder:
 * delegation signing/verification, pending join-request persistence,
 * approve/reject/redeliver flows, private join notifications, and
 * cross-curator join-request forwarding. 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
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
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral, isSafeIri, assertSafeIri,
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
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  resolveWorkspaceAgentRecipientKeys,
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
  type CollectedACK, type LiftAuthorityProof, type LiftTransitionType,
  type LiftRequest, type LiftRequestAuthorSeal,
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
  type ContextGraphSubscriptionRecord,
  type ContextGraphSubscriptionStore,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type ContextGraphJoinPolicyMode,
  type ContextGraphJoinPolicyRecord,
  type ContextGraphJoinPolicyRateReservation,
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
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
  partitionPublishAsyncQuads,
  signWithPrivateKey,
  preSignedAttestationToLiftSeal,
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

const OPEN_ENROLLMENT_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
const OPEN_ENROLLMENT_NODE_APPROVALS_PER_HOUR = 100;
const OPEN_ENROLLMENT_MAX_MEMBERS = 10_000;
const OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR = 1_000;
const OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH = 128;
const MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH = 1_000;
const JOIN_REQUEST_INGRESS_WINDOW_MS = 60_000;
const JOIN_REQUEST_INGRESS_PER_PEER = 20;
const JOIN_REQUEST_INGRESS_PER_AGENT = 6;
const JOIN_REQUEST_INGRESS_PER_CONTEXT_GRAPH = 100;
const JOIN_REQUEST_INGRESS_MAX_QUEUE_DEPTH = 64;

export interface ContextGraphJoinPolicyStatus {
  contextGraphId: string;
  mode: ContextGraphJoinPolicyMode;
  source: 'default' | 'persisted';
  ownerDid: string;
  ownerAgentAddress: string;
  maxMembers?: number;
  maxApprovalsPerHour?: number;
  memberCount: number;
  approvalsLastHour?: number;
  nodeApprovalsLastHour?: number;
  updatedAt?: number;
}

export interface IncomingJoinRequestDecision {
  status: 'pending' | 'approved';
  autoApproved: boolean;
  alreadyMember?: boolean;
  reason?: string;
}

const RETRYABLE_JOIN_ADMISSION_ERROR_NAME = 'RetryableJoinAdmissionError';

function retryableJoinAdmissionError(error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(
    `Automatic join admission crossed its membership mutation boundary but did not finish: ${cause.message}`,
  );
  wrapped.name = RETRYABLE_JOIN_ADMISSION_ERROR_NAME;
  return wrapped;
}

function joinRequestDigest(delegation: SignedAgentDelegation): string {
  return createHash('sha256')
    .update(JSON.stringify({
      agentAddress: delegation.agentAddress.toLowerCase(),
      scope: delegation.scope,
      issuedAtMs: delegation.issuedAtMs,
      expiresAtMs: delegation.expiresAtMs ?? 0,
      delegateePeerId: delegation.delegateePeerId ?? '',
      delegateeOpKey: delegation.delegateeOpKey?.toLowerCase() ?? '',
      signature: delegation.signature,
    }))
    .digest('hex');
}

function joinAdmissionRepairKey(
  contextGraphId: string,
  delegation: SignedAgentDelegation,
): string {
  return `${contextGraphId}::${joinRequestDigest(delegation)}`;
}

function isBoundedOpenEnrollmentPolicy(
  policy: ContextGraphJoinPolicyRecord,
  contextGraphId: string,
): boolean {
  return policy.version === 1
    && policy.contextGraphId === contextGraphId
    && policy.mode === 'open'
    && Number.isInteger(policy.maxMembers)
    && policy.maxMembers! > 0
    && policy.maxMembers! <= OPEN_ENROLLMENT_MAX_MEMBERS
    && Number.isInteger(policy.maxApprovalsPerHour)
    && policy.maxApprovalsPerHour! > 0
    && policy.maxApprovalsPerHour! <= OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR;
}

export class JoinRequestMethods extends DKGAgentBase {
  async flushJoinApprovalDurably(this: DKGAgent): Promise<void> {
    // Local/debounced stores expose flush; remote transactional adapters make
    // their awaited mutation durable directly and intentionally omit it.
    await this.store.flush?.();
  }

  hasRetryableContextGraphJoinAdmission(
    this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
  ): boolean {
    const key = joinAdmissionRepairKey(contextGraphId, delegation);
    const expiresAt = this.contextGraphJoinAdmissionRepairDigests.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.contextGraphJoinAdmissionRepairDigests.delete(key);
      return false;
    }
    return true;
  }

  markRetryableContextGraphJoinAdmission(
    this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
  ): void {
    const now = Date.now();
    if (this.contextGraphJoinAdmissionRepairDigests.size > 10_000) {
      for (const [key, expiresAt] of this.contextGraphJoinAdmissionRepairDigests) {
        if (expiresAt <= now) this.contextGraphJoinAdmissionRepairDigests.delete(key);
      }
    }
    this.contextGraphJoinAdmissionRepairDigests.set(
      joinAdmissionRepairKey(contextGraphId, delegation),
      now + JOIN_REQUEST_INGRESS_WINDOW_MS,
    );
  }

  clearRetryableContextGraphJoinAdmission(
    this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
  ): void {
    this.contextGraphJoinAdmissionRepairDigests.delete(
      joinAdmissionRepairKey(contextGraphId, delegation),
    );
  }

  /**
   * Bound untrusted join ingress before signature verification or the per-CG
   * promise queue. Returns a release callback for the accepted queue slot.
   */
  reserveContextGraphJoinIngress(
    this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    carrierPeerId: string,
  ): () => void {
    const now = Date.now();
    const cutoff = now - JOIN_REQUEST_INGRESS_WINDOW_MS;
    if (
      now - this.contextGraphJoinIngressLastCleanupAt >= JOIN_REQUEST_INGRESS_WINDOW_MS
      || this.contextGraphJoinIngressBuckets.size > 10_000
    ) {
      for (const [key, timestamps] of this.contextGraphJoinIngressBuckets) {
        const active = timestamps.filter((timestamp) => timestamp > cutoff);
        if (active.length === 0) this.contextGraphJoinIngressBuckets.delete(key);
        else this.contextGraphJoinIngressBuckets.set(key, active);
      }
      this.contextGraphJoinIngressLastCleanupAt = now;
    }

    const boundedKey = (kind: string, value: string) =>
      `${kind}:${createHash('sha256').update(value).digest('hex')}`;
    const checks: Array<[string, number, string]> = [
      [boundedKey('peer', carrierPeerId), JOIN_REQUEST_INGRESS_PER_PEER, 'peer'],
      [boundedKey('cg', contextGraphId), JOIN_REQUEST_INGRESS_PER_CONTEXT_GRAPH, 'context graph'],
      [boundedKey('agent', agentAddress.toLowerCase()), JOIN_REQUEST_INGRESS_PER_AGENT, 'agent'],
    ];
    for (const [key, limit, label] of checks) {
      const active = (this.contextGraphJoinIngressBuckets.get(key) ?? [])
        .filter((timestamp) => timestamp > cutoff);
      if (active.length >= limit) {
        throw new Error(`Join-request ${label} rate limit exceeded; retry later.`);
      }
    }

    const depth = this.contextGraphJoinIngressDepth.get(contextGraphId) ?? 0;
    if (depth >= JOIN_REQUEST_INGRESS_MAX_QUEUE_DEPTH) {
      throw new Error(`Join-request queue for "${contextGraphId}" is busy; retry later.`);
    }
    for (const [key] of checks) {
      const active = (this.contextGraphJoinIngressBuckets.get(key) ?? [])
        .filter((timestamp) => timestamp > cutoff);
      active.push(now);
      this.contextGraphJoinIngressBuckets.set(key, active);
    }
    this.contextGraphJoinIngressDepth.set(contextGraphId, depth + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.contextGraphJoinIngressDepth.get(contextGraphId) ?? 1;
      if (current <= 1) this.contextGraphJoinIngressDepth.delete(contextGraphId);
      else this.contextGraphJoinIngressDepth.set(contextGraphId, current - 1);
    };
  }

  /** Serialize policy changes and admission decisions for one CG. */
  async withContextGraphJoinAdmissionLock<T>(
    this: DKGAgent,
    contextGraphId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.contextGraphJoinAdmissionQueues.get(contextGraphId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate);
    this.contextGraphJoinAdmissionQueues.set(contextGraphId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.contextGraphJoinAdmissionQueues.get(contextGraphId) === current) {
        this.contextGraphJoinAdmissionQueues.delete(contextGraphId);
      }
    }
  }

  resolveLocalJoinPolicyOwnerAddress(this: DKGAgent, ownerDid: string): string | null {
    const ownerNorm = normalizeAgentDid(ownerDid);
    return [...this.localAgents.keys()].find(
      (address) => ownerNorm === normalizeAgentDid(`did:dkg:agent:${address}`),
    ) ?? null;
  }

  async assertJoinPolicyTarget(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress: string | undefined,
    requirePrivate: boolean,
  ): Promise<{ ownerDid: string; ownerAgentAddress: string; memberCount: number }> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      throw new Error('Open enrollment cannot be configured for a system context graph.');
    }
    await this.assertContextGraphOwner(contextGraphId, callerAgentAddress, 'manage join policy');
    const ownerDid = await this.getContextGraphOwner(contextGraphId);
    if (!ownerDid) {
      throw new Error(`Context graph "${contextGraphId}" has no registered owner.`);
    }
    const ownerAgentAddress = this.resolveLocalJoinPolicyOwnerAddress(ownerDid);
    if (!ownerAgentAddress) {
      throw new Error(
        `Open enrollment requires an agent-owned context graph whose exact owner is registered on this node. Owner=${ownerDid}`,
      );
    }
    if (requirePrivate) {
      const accessPolicy = await this.getExplicitAccessPolicy(contextGraphId);
      if (accessPolicy !== 'private') {
        throw new Error(
          `Open enrollment is only available for context graphs with an explicit private access policy; "${contextGraphId}" is ${accessPolicy ?? 'unconfirmed'}.`,
        );
      }
    }
    // This is a total private-recipient cap, not merely an allowlist-row cap:
    // participant agents receive ciphertext keys and private read authority too.
    // Use the fresh authoritative union (allowed + participant - revoked).
    const activeMembers = await this.getMemberRecoveryGate(contextGraphId) ?? [];
    return {
      ownerDid,
      ownerAgentAddress,
      memberCount: new Set(activeMembers.map((address) => address.toLowerCase())).size,
    };
  }

  async getContextGraphJoinPolicy(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress?: string,
  ): Promise<ContextGraphJoinPolicyStatus> {
    const target = await this.assertJoinPolicyTarget(contextGraphId, callerAgentAddress, false);
    const stored = this.config.contextGraphJoinPolicyStore
      ? await this.config.contextGraphJoinPolicyStore.load(contextGraphId)
      : null;
    if (!stored) {
      return {
        contextGraphId,
        mode: 'manual',
        source: 'default',
        ownerDid: target.ownerDid,
        ownerAgentAddress: target.ownerAgentAddress,
        memberCount: target.memberCount,
      };
    }
    const ownerMatches = normalizeAgentDid(stored.ownerDid) === normalizeAgentDid(target.ownerDid);
    const safeMode: ContextGraphJoinPolicyMode = isBoundedOpenEnrollmentPolicy(stored, contextGraphId) && ownerMatches
      ? 'open'
      : 'manual';
    const usage = await this.config.contextGraphJoinPolicyStore!
      .getAutomaticApprovalUsage(contextGraphId, Date.now());
    return {
      contextGraphId,
      mode: safeMode,
      source: 'persisted',
      ownerDid: target.ownerDid,
      ownerAgentAddress: target.ownerAgentAddress,
      ...(safeMode === 'open' && stored.maxMembers ? { maxMembers: stored.maxMembers } : {}),
      ...(safeMode === 'open' && stored.maxApprovalsPerHour
        ? { maxApprovalsPerHour: stored.maxApprovalsPerHour }
        : {}),
      memberCount: target.memberCount,
      approvalsLastHour: usage.contextGraphApprovalsLastHour,
      nodeApprovalsLastHour: usage.nodeApprovalsLastHour,
      updatedAt: stored.updatedAt,
    };
  }

  async setContextGraphJoinPolicy(
    this: DKGAgent,
    contextGraphId: string,
    input: {
      mode: ContextGraphJoinPolicyMode;
      maxMembers?: number;
      maxApprovalsPerHour?: number;
      acknowledgeOpenEnrollment?: boolean;
    },
    callerAgentAddress?: string,
  ): Promise<ContextGraphJoinPolicyStatus> {
    if (input.mode !== 'manual' && input.mode !== 'open') {
      throw new Error('Join policy mode must be "manual" or "open".');
    }
    const policyStore = this.config.contextGraphJoinPolicyStore;
    if (!policyStore) {
      throw new Error('Durable context graph join-policy storage is not configured.');
    }

    const isDisable = input.mode === 'manual';
    if (isDisable) {
      // Do not publish a cancellation signal until the caller is proven to be
      // the current exact owner. The target is checked again under the lock,
      // but this preflight prevents a non-owner local token from transiently
      // forcing legitimate automatic admissions back to pending.
      await this.assertJoinPolicyTarget(contextGraphId, callerAgentAddress, false);
      this.contextGraphJoinPolicyDisableIntentCounts.set(
        contextGraphId,
        (this.contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId) ?? 0) + 1,
      );
    }
    try {
      return await this.withContextGraphJoinAdmissionLock(contextGraphId, async () => {
      const target = await this.assertJoinPolicyTarget(
        contextGraphId,
        callerAgentAddress,
        input.mode === 'open',
      );
      if (input.mode === 'open' && input.acknowledgeOpenEnrollment !== true) {
        throw new Error('Open enrollment requires explicit acknowledgement. Re-run with --yes.');
      }
      if (input.mode === 'open') {
        if (!Number.isInteger(input.maxMembers) || input.maxMembers! <= 0 || input.maxMembers! > OPEN_ENROLLMENT_MAX_MEMBERS) {
          throw new Error(`maxMembers must be an integer between 1 and ${OPEN_ENROLLMENT_MAX_MEMBERS}.`);
        }
        if (!Number.isInteger(input.maxApprovalsPerHour) || input.maxApprovalsPerHour! <= 0 || input.maxApprovalsPerHour! > OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR) {
          throw new Error(
            `maxApprovalsPerHour must be an integer between 1 and ${OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR}.`,
          );
        }
        if (input.maxMembers! < target.memberCount) {
          throw new Error(
            `maxMembers cannot be lower than the current active private-member count (${target.memberCount}).`,
          );
        }
      }

      // `updatedAt` doubles as a monotonic policy epoch. Millisecond wall-clock
      // alone can collide across rapid disable/re-enable transitions, so advance
      // past the previous record even when both writes occur in the same tick.
      const previousRecord = await policyStore.load(contextGraphId);
      const now = Math.max(Date.now(), (previousRecord?.updatedAt ?? 0) + 1);
      const record: ContextGraphJoinPolicyRecord = {
        version: 1,
        contextGraphId,
        mode: input.mode,
        ownerDid: target.ownerDid,
        ...(input.mode === 'open'
          ? {
              maxMembers: input.maxMembers!,
              maxApprovalsPerHour: input.maxApprovalsPerHour!,
            }
          : {}),
        updatedAt: now,
      };
      try {
        await policyStore.saveWithAudit(record, {
          timestamp: now,
          contextGraphId,
          eventType: 'join_policy_changed',
          actor: `did:dkg:agent:${callerAgentAddress ?? target.ownerAgentAddress}`,
          outcome: input.mode,
          policyVersion: record.version,
          details: input.mode === 'open'
            ? {
                maxMembers: record.maxMembers,
                maxApprovalsPerHour: record.maxApprovalsPerHour,
              }
            : undefined,
        });
      } catch (error) {
        throw new Error(
          `Join policy transition was not persisted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        contextGraphId,
        mode: record.mode,
        source: 'persisted',
        ownerDid: target.ownerDid,
        ownerAgentAddress: target.ownerAgentAddress,
        ...(record.maxMembers ? { maxMembers: record.maxMembers } : {}),
        ...(record.maxApprovalsPerHour ? { maxApprovalsPerHour: record.maxApprovalsPerHour } : {}),
        memberCount: target.memberCount,
        updatedAt: record.updatedAt,
      };
      });
    } finally {
      if (isDisable) {
        const remaining = (this.contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId) ?? 1) - 1;
        if (remaining <= 0) this.contextGraphJoinPolicyDisableIntentCounts.delete(contextGraphId);
        else this.contextGraphJoinPolicyDisableIntentCounts.set(contextGraphId, remaining);
      }
    }
  }

  /**
   * An idempotent retry from an already-admitted member may refresh its
   * transport credential, but it must not roll that credential backwards or
   * swap the signed peer/key at the same issuance timestamp.
   */
  async assertAlreadyMemberDelegationRefresh(
    this: DKGAgent,
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

  /**
   * Persist an incoming request and, when every open-enrollment gate passes,
   * commit approval under the same lock used by policy changes. A failed
   * automatic decision is deliberately converted back into the ordinary
   * manual pending flow rather than rejecting or partially admitting it.
   */
  async processIncomingJoinRequest(
    this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName: string | undefined,
    carrierPeerId: string,
    options: { ingressReserved?: boolean } = {},
  ): Promise<IncomingJoinRequestDecision> {
    if (agentName !== undefined && (typeof agentName !== 'string' || agentName.length > OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH)) {
      throw new Error(`Join-request agentName must be a string of at most ${OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH} characters.`);
    }
    const requestDigest = joinRequestDigest(delegation);
    const isKnownRepairRetry = this.hasRetryableContextGraphJoinAdmission(
      contextGraphId,
      delegation,
    );
    // P2P callers reserve immediately after parsing the bounded frame, before
    // doing any store lookup or signature work. Direct/local callers enter
    // here, so retain the same protection for them without double-counting a
    // reservation already held by the lifecycle handler.
    const releaseIngress = options.ingressReserved || isKnownRepairRetry
      ? () => {}
      : this.reserveContextGraphJoinIngress(
          contextGraphId,
          delegation.agentAddress,
          carrierPeerId,
        );
    try {
      this.verifyJoinRequest(contextGraphId, delegation);
      return await this.withContextGraphJoinAdmissionLock(contextGraphId, async () => {
      const policyStore = this.config.contextGraphJoinPolicyStore;
      // Close the check-then-lock race with the lifecycle handler: two
      // concurrent requests can both observe "not a member" before the first
      // one commits. Re-check under the admission lock so the second request
      // refreshes the existing delegation idempotently without consuming a
      // member/rate slot or rewriting an approved row back to pending.
      const initialMeta = await this.getCgMeta(contextGraphId);
      const revokedNow = initialMeta.revokedAgents.some(
        (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
      );
      const activeMembersNow = await this.getMemberRecoveryGate(contextGraphId) ?? [];
      if (!revokedNow && activeMembersNow.some((address) => address.toLowerCase() === delegation.agentAddress.toLowerCase())) {
        const ownerDid = await this.getContextGraphOwner(contextGraphId);
        const ownerAgentAddress = ownerDid
          ? this.resolveLocalJoinPolicyOwnerAddress(ownerDid)
          : null;
        await this.assertAlreadyMemberDelegationRefresh(contextGraphId, delegation, carrierPeerId);
        let refreshMutationStarted = false;
        try {
          await this.commitInviteAgentToContextGraph(
            contextGraphId,
            delegation.agentAddress,
            ownerAgentAddress ?? undefined,
            delegation,
            () => { refreshMutationStarted = true; },
          );
          // If a prior admission stopped after writing the allowlist, a signed
          // transport retry completes the durable state machine. Direct invites
          // have no moderation row and remain a no-op.
          const moderationStatus = await this.getJoinRequestStatus(
            contextGraphId,
            delegation.agentAddress,
          );
          const hasJoinRequest = await this.hasJoinRequestRecord(
            contextGraphId,
            delegation.agentAddress,
          );
          if (moderationStatus !== 'approved' && hasJoinRequest) {
            await this.markJoinRequestApproved(contextGraphId, delegation.agentAddress);
          }
          // TripleStore inserts are debounced; an approval response is a durable
          // authorization contract, so do not ACK until the refreshed delegation
          // and any crash-repair status transition are on disk.
          await this.flushJoinApprovalDurably();
          const recoveredAutomaticApproval = hasJoinRequest && policyStore
            ? await policyStore.commitAutomaticApproval({
                timestamp: Date.now(),
                contextGraphId,
                actor: ownerDid ?? 'unknown-owner',
                agentAddress: delegation.agentAddress,
                requestDigest,
                details: { recoveredFromMemberRetry: true },
              })
            : false;
          this.notifyJoinApproval(contextGraphId, delegation.agentAddress).catch(() => {});
          this.clearRetryableContextGraphJoinAdmission(contextGraphId, delegation);
          return {
            status: 'approved',
            autoApproved: recoveredAutomaticApproval,
            alreadyMember: true,
          };
        } catch (error) {
          if (refreshMutationStarted) {
            this.markRetryableContextGraphJoinAdmission(contextGraphId, delegation);
            throw retryableJoinAdmissionError(error);
          }
          throw error;
        }
      }

      const existingRequestStatus = await this.getJoinRequestStatus(
        contextGraphId,
        delegation.agentAddress,
      );
      if (
        existingRequestStatus !== 'pending'
        && await this.countPendingJoinRequests(contextGraphId) >= MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH
      ) {
        throw new Error(
          `Join-request queue for "${contextGraphId}" is full (${MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH}); try again after curator review.`,
        );
      }
      await this.storePendingJoinRequest(contextGraphId, delegation, agentName, { emitNotification: false });
      let automaticEvaluationStarted = false;

      const leavePending = async (reason: string, eventType: 'join_auto_decision' | 'join_admission_throttled' | 'join_admission_failed' = 'join_auto_decision') => {
        if (policyStore && automaticEvaluationStarted) {
          await policyStore.appendAudit({
            timestamp: Date.now(),
            contextGraphId,
            eventType,
            agentAddress: delegation.agentAddress,
            outcome: 'pending',
            reason,
            requestDigest,
          }).catch(() => {});
        }
        this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
          contextGraphId,
          agentAddress: delegation.agentAddress,
          agentName,
        });
        return { status: 'pending', autoApproved: false, reason } as IncomingJoinRequestDecision;
      };

      if (!policyStore) return leavePending('join-policy-store-unavailable');
      if ((this.contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId) ?? 0) > 0) {
        return leavePending('manual-policy-requested');
      }
      let policy: ContextGraphJoinPolicyRecord | null;
      try {
        policy = await policyStore.load(contextGraphId);
      } catch {
        return leavePending('join-policy-read-failed');
      }
      if (!policy || policy.mode !== 'open') return leavePending('manual-policy');
      automaticEvaluationStarted = true;
      if (!isBoundedOpenEnrollmentPolicy(policy, contextGraphId)) {
        return leavePending('invalid-open-policy');
      }

      let target: { ownerDid: string; ownerAgentAddress: string; memberCount: number };
      try {
        target = await this.assertJoinPolicyTarget(contextGraphId, policy.ownerDid.replace(/^did:dkg:agent:/, ''), true);
      } catch (error) {
        return leavePending(`policy-target-invalid:${error instanceof Error ? error.message : String(error)}`);
      }
      if (normalizeAgentDid(policy.ownerDid) !== normalizeAgentDid(target.ownerDid)) {
        return leavePending('policy-owner-changed');
      }
      if (!delegation.delegateePeerId || delegation.delegateePeerId !== carrierPeerId) {
        return leavePending('carrier-peer-mismatch');
      }
      const now = Date.now();
      if (delegation.issuedAtMs < now - OPEN_ENROLLMENT_REQUEST_MAX_AGE_MS) {
        return leavePending('request-too-old');
      }
      if (
        !delegation.expiresAtMs ||
        delegation.expiresAtMs <= now ||
        delegation.expiresAtMs <= delegation.issuedAtMs ||
        delegation.expiresAtMs - delegation.issuedAtMs > JOIN_DELEGATION_VALIDITY_MS
      ) {
        return leavePending('invalid-automatic-delegation-window');
      }
      const meta = await this.getCgMeta(contextGraphId);
      if (meta.revokedAgents.some((address) => address.toLowerCase() === delegation.agentAddress.toLowerCase())) {
        return leavePending('agent-revoked');
      }
      try {
        await resolveWorkspaceAgentRecipientKeys(this.store, delegation.agentAddress);
      } catch {
        return leavePending('verified-active-encryption-key-required');
      }

      const maxMembers = policy.maxMembers ?? 0;
      if (!Number.isInteger(maxMembers) || maxMembers <= 0 || target.memberCount >= maxMembers) {
        return leavePending('member-cap-reached', 'join_admission_throttled');
      }
      const maxApprovalsPerHour = policy.maxApprovalsPerHour ?? 0;
      if (!Number.isInteger(maxApprovalsPerHour) || maxApprovalsPerHour <= 0) {
        return leavePending('invalid-approval-rate-cap');
      }

      let reservation: ContextGraphJoinPolicyRateReservation;
      try {
        reservation = await policyStore.reserveAutomaticApproval({
          contextGraphId,
          timestamp: now,
          contextGraphLimit: maxApprovalsPerHour,
          nodeLimit: OPEN_ENROLLMENT_NODE_APPROVALS_PER_HOUR,
          actor: target.ownerDid,
          agentAddress: delegation.agentAddress,
          requestDigest,
          policyVersion: policy.version,
          policyEpoch: policy.updatedAt,
        });
      } catch {
        return leavePending('approval-rate-store-failed', 'join_admission_failed');
      }
      if (!reservation.allowed) {
        return leavePending(reservation.reason ?? 'approval-rate-cap-reached', 'join_admission_throttled');
      }

      let membershipMutationStarted = false;
      try {
        // Re-read immediately before the irreversible membership mutation.
        if ((this.contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId) ?? 0) > 0) {
          return leavePending('policy-disabled-before-commit');
        }
        const currentPolicy = await policyStore.load(contextGraphId);
        if (
          !currentPolicy ||
          !isBoundedOpenEnrollmentPolicy(currentPolicy, contextGraphId) ||
          normalizeAgentDid(currentPolicy.ownerDid) !== normalizeAgentDid(target.ownerDid) ||
          currentPolicy.updatedAt !== policy.updatedAt
        ) {
          return leavePending('policy-disabled-before-commit');
        }
        let finalTarget: { ownerDid: string; ownerAgentAddress: string; memberCount: number };
        try {
          finalTarget = await this.assertJoinPolicyTarget(
            contextGraphId,
            target.ownerAgentAddress,
            true,
          );
        } catch (error) {
          return leavePending(
            `policy-target-invalid-before-commit:${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (normalizeAgentDid(finalTarget.ownerDid) !== normalizeAgentDid(target.ownerDid)) {
          return leavePending('policy-owner-changed-before-commit');
        }
        const finalMeta = await this.getCgMeta(contextGraphId);
        if (finalMeta.revokedAgents.some(
          (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
        )) {
          return leavePending('agent-revoked-before-commit');
        }
        const finalMembers = new Set(
          (await this.getMemberRecoveryGate(contextGraphId) ?? [])
            .map((address) => address.toLowerCase()),
        );
        if (!finalMembers.has(delegation.agentAddress.toLowerCase()) && finalMembers.size >= maxMembers) {
          return leavePending('member-cap-reached-before-commit', 'join_admission_throttled');
        }
        try {
          await resolveWorkspaceAgentRecipientKeys(this.store, delegation.agentAddress);
        } catch {
          return leavePending('encryption-key-invalid-before-commit');
        }
        await this.commitJoinRequestApproval(
          contextGraphId,
          delegation.agentAddress,
          target.ownerAgentAddress,
          () => {
            if ((this.contextGraphJoinPolicyDisableIntentCounts.get(contextGraphId) ?? 0) > 0) {
              throw new Error('Open enrollment was switched to manual before the membership mutation.');
            }
            membershipMutationStarted = true;
          },
          false,
        );
        const committedAuditRecorded = await policyStore.commitAutomaticApproval({
          timestamp: Date.now(),
          contextGraphId,
          actor: target.ownerDid,
          agentAddress: delegation.agentAddress,
          requestDigest,
          details: {
            memberCountBefore: finalMembers.size,
            maxMembers,
            contextGraphApprovalsLastHour: reservation.contextGraphApprovalsLastHour,
            nodeApprovalsLastHour: reservation.nodeApprovalsLastHour,
          },
        });
        if (!committedAuditRecorded) {
          throw new Error('Automatic approval reservation is missing from the durable audit store.');
        }
        this.notifyJoinApproval(contextGraphId, delegation.agentAddress).catch(() => {});
        this.clearRetryableContextGraphJoinAdmission(contextGraphId, delegation);
        return { status: 'approved', autoApproved: true };
      } catch (error) {
        // Messenger caches every successful application response. Once the
        // membership mutation has started, returning `{status:"pending"}` would
        // suppress the only retry capable of repairing moderation/audit state.
        if (membershipMutationStarted) {
          this.markRetryableContextGraphJoinAdmission(contextGraphId, delegation);
          throw retryableJoinAdmissionError(error);
        }
        return leavePending(
          `automatic-approval-failed:${error instanceof Error ? error.message : String(error)}`,
          'join_admission_failed',
        );
      }
      });
    } finally {
      releaseIngress();
    }
  }
  /**
   * Create a context graph. All CGs start as free, P2P collaborative spaces.
   * No blockchain transaction is required. On-chain registration is a separate
   * explicit step via {@link registerContextGraph}.
   *
   * The `private` flag still works for truly local-only CGs (no gossip, no sync).
   * For curated CGs, provide `allowedPeers` to restrict gossip writes to listed peers.
   */
  async signJoinRequest(this: DKGAgent,
    contextGraphId: string,
    agentAddress?: string,
  ): Promise<SignedAgentDelegation> {
    const addr = agentAddress ?? this.defaultAgentAddress;
    if (!addr) throw new Error('No agent address available');

    const agent = this.localAgents.get(addr);
    if (!agent?.privateKey) {
      throw new Error(`No private key for agent ${addr} — self-sovereign agents must sign externally`);
    }

    // Bind to BOTH delegatee shapes when available so the agent's
    // approval survives rotation of either key. The libp2p peer-id is
    // always available; the operational key is available when the chain
    // adapter advertises one (typical V10 nodes do).
    const delegateePeerId = this.peerId;
    let delegateeOpKey: string | undefined;
    try {
      delegateeOpKey = await inferAdapterPublisherAddress(this.chain);
    } catch {
      // Best-effort — delegateePeerId alone is sufficient.
    }

    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + JOIN_DELEGATION_VALIDITY_MS;

    const signed = await signAgentDelegation({
      agentAddress: addr,
      scope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
      issuedAtMs,
      expiresAtMs,
      delegateePeerId,
      delegateeOpKey,
      agentPrivateKey: agent.privateKey,
    });
    // Remember our intent so multi-agent post-approval sync binds to
    // the right agent before `_meta` catches up. Last-write-wins is
    // intentional: a node that re-signs with a different agent has
    // changed its intent for this CG.
    this.localApprovedAgentByCG.set(contextGraphId, addr.toLowerCase());
    return signed;
  }

  /**
   * Verify a signed join-request delegation. Re-uses the generic
   * `verifyAgentDelegation` primitive and pins the scope to this CG.
   * Throws on any failure.
   */
  verifyJoinRequest(this: DKGAgent, contextGraphId: string, delegation: SignedAgentDelegation): SignedAgentDelegation {
    verifyAgentDelegation(delegation, { expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId) });
    return delegation;
  }

  /**
   * Store a pending join request — the agent's signed delegation — in
   * the CG's `_meta` graph. The curator can later approve or reject.
   *
   * Persists the FULL delegation (agentAddress, scope, issuedAtMs,
   * expiresAtMs, delegateePeerId, delegateeOpKey, signature) so that
   * approval can re-verify against the same digest, and so that the
   * approved delegatee identifiers can be promoted into the CG's
   * allowlist via `inviteAgentToContextGraph` without round-tripping
   * the joiner.
   */
  async storePendingJoinRequest(this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName?: string,
    options: { emitNotification?: boolean } = {},
  ): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${delegation.agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: requestUri });

    // Escape every user-controllable literal. `contextGraphId`, `delegation.scope`,
    // and `agentName` flow from joiner input and can contain `"` or `\`, which
    // would produce invalid N-Quads and fail the insert (or open a SPARQL
    // injection surface). Other fields are validated upstream:
    //   - `agentAddress` and `signature` are 0x-hex (verifyAgentDelegation
    //     recovers an EVM address, so non-hex throws before we get here)
    //   - `issuedAtMs` / `expiresAtMs` are numbers serialised by JS
    //   - `delegateePeerId` / `delegateeOpKey` are protocol-shaped identifiers.
    const quads: Quad[] = [
      { subject: requestUri, predicate: RDF_TYPE, object: `${DKG}JoinRequest`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}agentAddress`, object: `"${delegation.agentAddress}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}contextGraphId`, object: `"${escapeSparqlLiteral(contextGraphId)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}signature`, object: `"${delegation.signature}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestTimestamp`, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestStatus`, object: `"pending"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}delegationScope`, object: `"${escapeSparqlLiteral(delegation.scope)}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph },
    ];
    if (delegation.expiresAtMs && delegation.expiresAtMs > 0) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${delegation.expiresAtMs}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateePeerId) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER, object: `"${delegation.delegateePeerId}"`, graph: cgMetaGraph });
    }
    if (delegation.delegateeOpKey) {
      quads.push({ subject: requestUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY, object: `"${delegation.delegateeOpKey.toLowerCase()}"`, graph: cgMetaGraph });
    }
    if (agentName) {
      quads.push({ subject: requestUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(agentName)}"`, graph: cgMetaGraph });
    }
    await this.store.insert(quads);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: delegation.agentAddress,
      role: 'requester',
      status: 'pending',
      source: 'join-request',
      ...(agentName ? { displayName: agentName } : {}),
      metadata: { timestamp: delegation.issuedAtMs },
    });
    const ctx = createOperationContext('system');
    this.log.info(ctx, `Stored pending join request from ${delegation.agentAddress} for "${contextGraphId}"`);
    // Emit JOIN_REQUEST_RECEIVED here (single source of truth) so the daemon's
    // lifecycle.ts hook turns it into a SQLite notification + SSE broadcast
    // for the curator's UI bell. Previously this emit lived only on the P2P
    // handler in `setupNetworkHandlers`, so a join request that reached the
    // curator via the HTTP `request-join` route's `isCurator` branch (e.g.
    // when joiner and curator are the same node, or when a relay/bridge
    // re-posts the request locally) silently stored without surfacing in
    // notifications. Centralising the emit here means every successful
    // store — regardless of inbound path — produces a notification.
    if (options.emitNotification !== false) {
      this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
        contextGraphId,
        agentAddress: delegation.agentAddress,
        agentName,
      });
    }
  }

  /**
   * Reload a stored join-request delegation in its full
   * `SignedAgentDelegation` shape so it can be re-verified at approval
   * time and its delegatee identifiers promoted into the CG allowlist.
   */
  async loadPendingJoinDelegation(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
  ): Promise<SignedAgentDelegation | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    // Pin to `requestStatus = "pending"` so a previously-rejected (or
    // already-approved) request is not re-loaded and re-approved by
    // mistake — the join-request URI persists across status transitions
    // (only `requestStatus` flips), so without this filter
    // `approveJoinRequest` could resurrect a rejection.
    const result = await this.store.query(
      `SELECT ?sig ?ts ?scope ?expires ?peer ?opkey WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}signature> ?sig ;
                          <${DKG}requestTimestamp> ?ts ;
                          <${DKG}requestStatus> "pending" .
          OPTIONAL { <${requestUri}> <${DKG}delegationScope> ?scope }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expires }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_PEER}> ?peer }
          OPTIONAL { <${requestUri}> <${DKG_ONTOLOGY.DKG_DELEGATION_DELEGATEE_KEY}> ?opkey }
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    const row = result.bindings[0];
    const signature = strip(row['sig']);
    const issuedAtMs = parseInt(strip(row['ts']), 10) || 0;
    const expires = row['expires'] ? parseInt(strip(row['expires']), 10) || 0 : 0;
    const scope = row['scope'] ? strip(row['scope']) : joinDelegationScope(this.chain.deploymentId, contextGraphId);
    const delegateePeerId = row['peer'] ? strip(row['peer']) : undefined;
    const delegateeOpKey = row['opkey'] ? strip(row['opkey']) : undefined;
    if (!signature || !issuedAtMs) return null;
    if (!delegateePeerId && !delegateeOpKey) {
      // Legacy pending row from before the delegation rework — has
      // signature + timestamp but no delegatee identifiers, so the
      // new verifier would reject it with a generic "at least one
      // delegatee identifier is required". Throw a curator-readable
      // error with a migration hint instead.
      throw new Error(
        `Pending join request from ${agentAddress} predates the V10 delegation rework ` +
        `(missing delegatee identifiers). Reject this request and ask the joiner to re-submit; ` +
        `the upgrade is a clean break in the join-request wire format.`,
      );
    }
    return {
      agentAddress,
      scope,
      issuedAtMs,
      ...(expires ? { expiresAtMs: expires } : {}),
      ...(delegateePeerId ? { delegateePeerId } : {}),
      ...(delegateeOpKey ? { delegateeOpKey } : {}),
      signature,
    };
  }

  /**
   * List pending join requests for a context graph.
   */
  async listPendingJoinRequests(this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress?: string,
  ): Promise<Array<{ agentAddress: string; name?: string; signature: string; timestamp: number; status: string }>> {
    // GH #757 — join-request moderation data is curator-only. Gate the read
    // server-side (the same owner check approve/reject already enforce), so a
    // valid non-curator token can't enumerate another CG's pending requests.
    await this.assertContextGraphOwner(contextGraphId, callerAgentAddress, 'view join requests');
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?addr ?name ?sig ?ts ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}agentAddress> ?addr ;
               <${DKG}signature> ?sig ;
               <${DKG}requestTimestamp> ?ts ;
               <${DKG}requestStatus> ?status .
          OPTIONAL { ?req <https://schema.org/name> ?name }
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    return result.bindings.map((row) => ({
      agentAddress: strip(row['addr']),
      name: row['name'] ? strip(row['name']) : undefined,
      signature: strip(row['sig']),
      timestamp: parseInt(strip(row['ts']), 10) || 0,
      status: strip(row['status']),
    })).filter((r) => r.status === 'pending');
  }

  /** Internal bounded-queue accounting; does not expose moderation records. */
  async countPendingJoinRequests(this: DKGAgent, contextGraphId: string): Promise<number> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT (COUNT(?req) AS ?count) WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}requestStatus> "pending" .
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return 0;
    const raw = result.bindings[0]['count'];
    const match = typeof raw === 'string' ? raw.match(/\d+/) : null;
    return match ? Number(match[0]) : 0;
  }

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(this: DKGAgent, contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    return this.withContextGraphJoinAdmissionLock(contextGraphId, () =>
      this.commitJoinRequestApproval(contextGraphId, agentAddress, callerAgentAddress));
  }

  /** Internal approval body; caller must hold the per-CG admission lock. */
  async commitJoinRequestApproval(
    this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
    beforeMembershipMutation?: () => void,
    notifyRequester = true,
  ): Promise<void> {
    await this.assertContextGraphOwner(contextGraphId, callerAgentAddress, 'manage join requests');
    const delegation = await this.loadPendingJoinDelegation(contextGraphId, agentAddress);
    if (!delegation) {
      throw new Error(`No pending join request found from ${agentAddress}`);
    }
    // Re-verify the signed delegation against the CURRENT clock —
    // approval is an authorisation event so the delegation's
    // expiry must still be in force. If the curator took longer than
    // the joiner's `expiresAtMs` to review, the joiner has to re-sign
    // (their UI will surface the now-expired pending request and
    // prompt them); silently promoting an expired delegation into the
    // sync allowlist would defeat the whole point of binding an expiry
    // into the signed payload. The standard `JOIN_DELEGATION_VALIDITY_MS`
    // is 1 year so this is a non-issue in practice.
    verifyAgentDelegation(delegation, {
      expectedScope: joinDelegationScope(this.chain.deploymentId, contextGraphId),
    });

    const meta = await this.getCgMeta(contextGraphId);
    if (meta.revokedAgents.some(
      (address) => address.toLowerCase() === agentAddress.toLowerCase(),
    )) {
      throw new Error(
        `Agent ${agentAddress} is revoked from "${contextGraphId}". Clear the revocation separately before approving a new join request.`,
      );
    }

    // Every production adapter implements SPARQL UPDATE. Refuse to cross the
    // membership boundary on a custom adapter that cannot atomically replace
    // the moderation status.
    if (typeof this.store.update !== 'function') {
      throw new Error(
        'Join approval requires atomic SPARQL UPDATE support from the configured triple store.',
      );
    }

    await this.commitInviteAgentToContextGraph(
      contextGraphId,
      agentAddress,
      callerAgentAddress,
      delegation,
      beforeMembershipMutation,
    );
    await this.markJoinRequestApproved(contextGraphId, agentAddress);
    // `insert()` only schedules TripleStore's debounced persistence. Flush the
    // allowlist, delegation, and moderation status as one success boundary so a
    // power loss immediately after the HTTP/P2P ACK cannot erase membership.
    await this.flushJoinApprovalDurably();

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    if (notifyRequester) {
      this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
        this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  /** Complete the moderation side of an approval; safe to repeat after retry. */
  async markJoinRequestApproved(this: DKGAgent, contextGraphId: string, agentAddress: string): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const requestStatus = 'https://dkg.network/ontology#requestStatus';
    if (typeof this.store.update !== 'function') {
      throw new Error(
        'Join approval requires atomic SPARQL UPDATE support from the configured triple store.',
      );
    }
    // A single backend mutation means failure leaves the old `pending` value
    // intact; there is no delete/insert window where the status is absent.
    await this.store.update(`
      DELETE { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> ?oldStatus . } }
      INSERT { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> "approved" . } }
      WHERE  { OPTIONAL { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> ?oldStatus . } } }
    `, { touchedGraphs: [cgMetaGraph], source: 'join-approval-status' });
  }

  /**
   * Send a P2P notification to the approved agent so their node
   * automatically retries the subscription.
   *
   * Delivers the message ONLY to the requester's peer, resolved via the
   * local agent registry. The earlier implementation broadcast to every
   * connected peer and relied on each recipient's handler to filter by
   * `agentAddress`. That leaked membership information for curated
   * context graphs: every peer on the P2P network learned that
   * `agentAddress` had just been invited to `contextGraphId`, which is
   * exactly the metadata a curated CG is supposed to hide.
   *
   * If the requester isn't in the local registry we fall back to a
   * best-effort dial through their relay address when available. We do
   * NOT broadcast in any case — the invitee will re-learn on their next
   * subscribe attempt if the direct notification fails.
   */
  public async notifyJoinApproval(this: DKGAgent, contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    if (result.delivered) {
      return;
    }
    // rc.9 PR-10: the substrate outbox already holds the queued send
    // (deliverPrivateJoinNotification → messenger.sendReliable enqueues
    // on failure). All we do here is log the transport failure for
    // operator visibility. The substrate's periodic tick is the only automatic
    // retry trigger and will drive delivery once the persisted backoff is due.
    const ctx = createOperationContext('system');
    this.log.warn(
      ctx,
      `join-approval for "${contextGraphId}" → ${agentAddress} not delivered now ` +
        `(error=${result.error ?? 'unknown'}). Curator-local state is correct; ` +
        `substrate outbox holds the queued send and will retry on its backoff ladder.`,
    );
  }

  /**
   * Re-fire the `join-approved` P2P notification for a previously-approved
   * agent. Idempotent and safe to call multiple times; only the most recent
   * delivery state matters.
   *
   * Used by:
   *   * The substrate's periodic outbox tick, transparent to this call
   *     (rc.9 PR-10).
   *   * The operator-facing route `POST /api/context-graph/{id}/redeliver-approval`,
   *     which lets an operator (or peer agent via the chat MCP) re-poke
   *     the curator when the automated retry isn't fast enough.
   *
   * Returns delivery details so the caller can surface them in HTTP
   * responses / MCP tool output. Throws on caller errors (no approval row,
   * malformed agent address) so the route handler can return a 4xx.
   */
  async redeliverJoinApproval(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    _callerAgentAddress?: string,
  ): Promise<{
    delivered: boolean;
    peerId: string | null;
    attempts: number;
    error: string | null;
  }> {
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }
    const status = await this.getJoinRequestStatus(contextGraphId, agentAddress);
    if (status !== 'approved') {
      // We deliberately don't accept `pending` here. A pending request
      // means the curator hasn't actually approved — re-firing a
      // join-approved notification in that state would be a protocol
      // violation. The caller should go through approveJoinRequest.
      throw new Error(
        `Cannot redeliver join-approval for "${contextGraphId}" → ${agentAddress}: ` +
          `request status is "${status ?? 'none'}", expected "approved". ` +
          `Approve the request first (or have the joiner re-submit if there is no record).`,
      );
    }
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    const result = await this.deliverPrivateJoinNotification(
      contextGraphId,
      agentAddress,
      payload,
      'join-approval',
    );
    // rc.9 PR-10: attempts counter is no longer tracked at the agent
    // layer (substrate outbox owns retry bookkeeping per messageId).
    // Operators interested in retry depth can read it from the
    // substrate diagnostic surface that PR-12 adds. Until then we
    // surface a flat attempts=1 for delivered / 0 for queued so the
    // operator UI keeps rendering without code changes; the
    // delivered/error pair is the source of truth.
    if (result.delivered) {
      return {
        delivered: true,
        peerId: result.peerId,
        attempts: 1,
        error: null,
      };
    }
    return {
      delivered: false,
      peerId: result.peerId,
      attempts: 0,
      error: result.error,
    };
  }

  /**
   * Read the `requestStatus` of a join request. Returns `'pending' |
   * 'approved' | 'rejected'` or `null` if no row exists. Used by
   * `redeliverJoinApproval` to validate the operator-driven re-fire
   * path; not exported as a public method to avoid leaking the raw
   * status string into other code paths (the dedicated `loadPending…`
   * / `redeliver…` helpers are the supported API).
   */
  async getJoinRequestStatus(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
  ): Promise<'pending' | 'approved' | 'rejected' | null> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}requestStatus> ?status .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const raw = result.bindings[0]['status'];
    if (typeof raw !== 'string') return null;
    const stripped = raw.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '');
    if (stripped === 'pending' || stripped === 'approved' || stripped === 'rejected') {
      return stripped;
    }
    return null;
  }

  /**
   * Persist the requester-side result of an authenticated curator decision.
   *
   * Curator moderation rows are intentionally redacted from private-CG meta
   * sync, so the requester must not depend on those rows arriving over the
   * wire. Store only the final status under the same join-request subject;
   * sync responders redact that subject prefix, keeping this decision local.
   */
  async recordLocalJoinRequestDecision(
    this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const requestStatus = 'https://dkg.network/ontology#requestStatus';

    if (typeof this.store.update === 'function') {
      await this.store.update(`
        DELETE { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> ?oldStatus . } }
        INSERT { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> "${status}" . } }
        WHERE  { OPTIONAL { GRAPH <${cgMetaGraph}> { <${requestUri}> <${requestStatus}> ?oldStatus . } } }
      `, { touchedGraphs: [cgMetaGraph], source: `local-join-${status}-status` });
    } else {
      // Compatibility fallback for custom stores without SPARQL UPDATE.
      // The curator remains authoritative if a crash lands between these two
      // mutations, and an approval can be redelivered to repair local state.
      await this.store.deleteByPattern({
        graph: cgMetaGraph,
        subject: requestUri,
        predicate: requestStatus,
      });
      await this.store.insert([{
        subject: requestUri,
        predicate: requestStatus,
        object: `"${status}"`,
        graph: cgMetaGraph,
      }]);
    }

    // Embedded stores debounce disk persistence. Do not ACK the curator until
    // the local decision survives a requester restart.
    await this.store.flush?.();
  }

  /** True when the moderation entity exists even if its status write was interrupted. */
  async hasJoinRequestRecord(
    this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
  ): Promise<boolean> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const result = await this.store.query(
      `SELECT ?type WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${RDF_TYPE}> ?type .
          FILTER(?type = <${DKG}JoinRequest>)
        }
      } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * Snapshot of pending approval retries. Surfaced via the daemon for
   * operator-facing diagnostics ("how many approvals are stuck on
   * transport, and how long since the first failure?").
   *
   * rc.9 PR-10: stubbed to return [] until PR-12 rebuilds the
   * operator diagnostic surface on top of the substrate outbox.
   * The substrate is now driving retries durably and transparently;
   * operators who need raw state can inspect the
   * `protocol_outbox` SQLite table directly in the interim.
   */
  listPendingJoinApprovalRetries(this: DKGAgent): JoinApprovalRetryEntry[] {
    return [];
  }

  /**
   * Periodic tick: walk the retry queue and fire `redeliverJoinApproval`
   * for every entry whose `nextAttemptAt` has passed. Also evicts
   * entries past their max age (24h since first failure by default).
   * Failures re-enqueue with longer backoffs; successes clear the entry.
   * Errors thrown by `redeliverJoinApproval` (e.g. the row went away
   * because the curator manually cleaned it up) are caught and the
   * entry is dropped to prevent the tick from spinning on a permanently
   * unrecoverable target.
   */
  // rc.9 PR-10: processJoinApprovalRetryQueueTick +
  // processJoinApprovalRetryQueueOnConnect deleted. The substrate's
  // Messenger.processOutboxTick covers /dkg/10.0.1/join-request
  // automatically (same as chat in
  // PR-3), so the two dedicated processors are obsolete. Operator
  // re-fire route POST /api/context-graph/{id}/redeliver-approval is
  // unchanged — it still calls redeliverJoinApproval which now
  // simply re-issues the substrate send.

  /**
   * Re-attempt delivery of a single chat outbox entry from the periodic
   * scheduler. Returns the entry's current state so the caller can
   * decide what to log.
   *
   * Goes through `messageHandler.sendChat` directly (bypassing
   * `DKGAgent.sendChat`) so a successful retry doesn't recursively
   * re-enqueue or re-mint a fresh `messageId` — the outbox owns the
   * messageId for the lifetime of the entry.
   */
  /**
   * "Reverse-path peerStore enrichment" — when an inbound circuit-relay
   * connection from peer P via relay R opens, echo the inbound circuit
   * back as an outbound multiaddr for P (`<R>/p2p-circuit/p2p/<P>`)
   * and merge it into the local peerStore.
   *
   * The Miles↔Lex May 2026 6h soak postmortem identified the "Window D"
   * class: an inbound circuit connection from P was open and live, but
   * every `libp2p.dialProtocol(P, ...)` retry on our side failed with
   * "The dial request has no valid addresses for peer" for several
   * minutes. Reverse-path enrichment ensures the next scheduled retry sees a
   * usable address without letting connection churn bypass persisted backoff.
   *
   * The clean fix would be inside libp2p (`dialProtocol` should reuse
   * an existing open connection of any direction — see PR 5 in the
   * postmortem follow-up plan), but until that lands, populating
   * peerStore from the inbound circuit's address gives the dialer
   * something to find on the next scheduled attempt.
   *
   * Public so a unit test can exercise it directly without standing up
   * a full libp2p network (the listener that calls it is registered
   * inside the giant `start()` method and is not easily mockable
   * end-to-end).
   *
   * Guarantees:
   * - Direct connections are a no-op (nothing to enrich — the dialer
   *   already has the address it used to open the connection).
   * - Outbound connections are a no-op (peerStore was already
   *   populated to make the dial; re-merging the same address is
   *   harmless but pointless).
   * - Throws are swallowed by the caller's `.catch()` — the
   *   `connection:open` listener must never propagate exceptions.
   * - Merging an address libp2p already knows about is a no-op
   *   (`peerStore.merge` dedupes internally).
   *
   * Trade-off (referenced from `docs/archive/UPSTREAM_ISSUE_DRAFT.md`):
   * `peerStore.merge` can wake the connection manager to dial direct,
   * which has been observed to disrupt streams mid-negotiation. We're
   * NOT in mid-negotiation here (the call runs from
   * `connection:open`, not from inside `newStream`), and the address
   * we're merging IS the same relay path that the inbound connection
   * already uses — so the worst case is the CM redundantly dialing
   * out through R, which is exactly what we want.
   */
  async enrichPeerStoreFromInboundCircuit(this: DKGAgent, connection: {
    direction: 'inbound' | 'outbound';
    remoteAddr?: { toString(): string };
    remotePeer: { toString(): string };
  }): Promise<void> {
    if (connection.direction !== 'inbound') return;
    const remoteStr = connection.remoteAddr?.toString();
    if (!remoteStr) return;
    const circIdx = remoteStr.indexOf('/p2p-circuit');
    if (circIdx < 0) return;

    const remotePeer = connection.remotePeer.toString();
    if (remotePeer === this.node.libp2p.peerId.toString()) return;

    // Reverse-path multiaddr: take the relay prefix up to (but not
    // including) the `/p2p-circuit` segment, append the canonical
    // `/p2p-circuit/p2p/<P>` suffix. Works whether the inbound
    // remoteAddr ends at `/p2p-circuit` (the typical listener-side
    // shape) OR already includes a trailing `/p2p/<self>` (defensive
    // — older libp2p versions and some test transports surface the
    // explicit-destination shape). Slicing on the FIRST occurrence
    // of `/p2p-circuit` is correct either way.
    const relayPrefix = remoteStr.slice(0, circIdx);
    const reverseAddrStr = `${relayPrefix}/p2p-circuit/p2p/${remotePeer}`;

    const { peerIdFromString } = await import('@libp2p/peer-id');
    const { multiaddr } = await import('@multiformats/multiaddr');
    const pid = peerIdFromString(remotePeer);
    const reverseAddr = multiaddr(reverseAddrStr);
    await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [reverseAddr] });
  }

  /**
   * Reject a pending join request.
   */
  async rejectJoinRequest(this: DKGAgent, contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    return this.withContextGraphJoinAdmissionLock(contextGraphId, () =>
      this.commitJoinRequestRejection(contextGraphId, agentAddress, callerAgentAddress));
  }

  /** Internal rejection body; caller must hold the per-CG admission lock. */
  async commitJoinRequestRejection(this: DKGAgent, contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    // SECURITY (G1): reject is a curator-only ACL decision. Previously this
    // method had NO owner check while `approveJoinRequest` was gated (via
    // `inviteAgentToContextGraph` → `assertCallerIsOwner`), so any local-token
    // caller could reject a pending request — and the route only ran the
    // write preflight (CG-exists/locally-writable), not a curator check.
    // Mirror the approve path: assert the caller is the CG owner/curator
    // BEFORE mutating state or notifying the joiner. Throws "Only the context
    // graph curator can …" (403 at the route) for a non-curator.
    await this.assertContextGraphOwner(contextGraphId, callerAgentAddress, 'manage join requests');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"rejected"`,
      graph: cgMetaGraph,
    }]);
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: agentAddress,
      role: 'requester',
      status: 'removed',
      source: 'join-rejected',
    });

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Rejected join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so their UI can flip from the stale
    // "Join request sent, awaiting approval" state to a clear denied
    // state. Non-fatal: if the invitee is unreachable they'll just
    // re-learn on their next subscribe attempt.
    this.notifyJoinRejection(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of rejection: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the rejected agent. Same privacy model
   * as `notifyJoinApproval` — delivered only to the rejectee's peer,
   * never broadcast. See that method's doc comment for rationale.
   */
  async notifyJoinRejection(this: DKGAgent, contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-rejected',
      contextGraphId,
      agentAddress,
    });
    // Discard the result object — rejection deliveries don't enter the
    // retry queue. The semantics are intentionally weaker than approval:
    // if the rejection notification is lost the joiner observes silence,
    // which they'll already treat as "still pending" and either re-poll
    // or eventually time out. That's a much milder failure than a lost
    // approval (which leaves a sync-blocked invitee with no recovery path).
    await this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-rejection');
  }

  /**
   * Resolve the target agent's peer ID and send the payload only to that
   * peer. Never broadcasts — leaking a curated CG's membership to every
   * peer on the network is a real privacy violation, and dropping the
   * notification is a far milder failure (the invitee relearns on next
   * subscribe).
   *
   * Two resolution sources, in order:
   *
   *   1. `joinRequestOriginPeers` — the peer that actually delivered the
   *      original join request over P2P. Set by the handler at register
   *      time and persists for the curator's process lifetime. This
   *      avoids a regression from the old broadcast implementation: the
   *      requester may reach us via P2P before their agent profile is
   *      indexed locally, so relying on `findAgents()` alone would drop
   *      every approval/rejection until registry replication catches up.
   *   2. `discovery.findAgents()` fallback for the case where the
   *      curator restarted between receiving the request and acting on
   *      it (and thus lost the in-memory peer mapping).
   *
   * @returns void (logged success/failure; callers treat this as
   *          fire-and-forget)
   */
  async deliverPrivateJoinNotification(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    payload: string,
    label: 'join-approval' | 'join-rejection',
  ): Promise<{ delivered: boolean; peerId: string | null; error: string | null }> {
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const addrLower = agentAddress.toLowerCase();

    let targetPeerId: string | null = null;

    // Preferred source: the peer that actually delivered the join
    // request. This is always correct for the common flow and doesn't
    // depend on registry replication timing.
    const originKey = `${contextGraphId}::${addrLower}`;
    const rememberedPeerId = this.joinRequestOriginPeers.get(originKey);
    if (rememberedPeerId) {
      targetPeerId = rememberedPeerId;
    }

    // Always consult the registry when we either had no remembered peer
    // OR we have one but no live connection to it right now. This fixes
    // two related regressions:
    //
    //   * If the requester disconnected between submitting the request
    //     and the curator acting on it, with only the remembered-peer
    //     path we'd have no relay address to redial and the
    //     notification would be silently dropped even though the
    //     registry knows exactly how to reach them.
    //   * If the requester reconnected with a brand-new peer ID (e.g.
    //     ephemeral peer IDs, node restart on a volatile host), the
    //     remembered ID is now stale. Sending to a dead peer ID just
    //     times out; the registry's current peer ID is authoritative.
    //
    // So when the remembered peer isn't connected, we REPLACE it with
    // the registry's current peer ID (not just supplement it with a
    // relay hint), which is what Codex N25 asks for. Registry lookup is
    // cheap (local graph query).
    const rememberedIsConnected = rememberedPeerId
      ? this.node.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === rememberedPeerId)
      : false;
    if (!targetPeerId || !rememberedIsConnected) {
      try {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === addrLower);
        if (match) {
          // Take the registry's peer ID whenever we don't have a live
          // connection to the remembered one — it may be fresher.
          targetPeerId = match.peerId;
        }
      } catch {
        // Registry unavailable — we'll just skip delivery below if we
        // also have no live connection to the remembered peer.
      }
    }

    if (!targetPeerId) {
      const errMsg = `no origin peer remembered and agent not in local registry`;
      this.log.warn(
        ctx,
        `Cannot deliver ${label} for "${contextGraphId}" to ${agentAddress} — ${errMsg}. ` +
          `Dropping notification (invitee will re-learn on next subscribe).`,
      );
      return { delivered: false, peerId: null, error: errMsg };
    }

    if (targetPeerId === this.peerId) {
      this.log.info(ctx, `Skipping ${label} to ${agentAddress}: target is this node`);
      // Self-loopback "delivery" is treated as success — there is no peer to
      // retry against and the local state is authoritative anyway.
      return { delivered: true, peerId: targetPeerId, error: null };
    }

    try {
      // rc.9 PR-10: send via the Universal Messenger substrate. If
      // the substrate can't deliver synchronously it enqueues into
      // the SQLite outbox and retries in the background — this
      // replaces the deleted in-memory JoinApprovalRetryQueue. Note
      // queued counts as "not delivered now" so the caller can log
      // the failure; the substrate keeps trying behind the scenes.
      const sendResult = await this.messenger.sendReliable(
        targetPeerId,
        PROTOCOL_JOIN_REQUEST,
        payloadBytes,
        { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
      );
      if (!sendResult.delivered) {
        this.log.warn(
          ctx,
          `${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}) ` +
          `queued in substrate outbox: ${sendResult.error}. ` +
          `Substrate will retry on its persisted backoff schedule.`,
        );
        return { delivered: false, peerId: targetPeerId, error: sendResult.error };
      }
      this.log.info(ctx, `Delivered ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId})`);
      // The join request is finalised now — forget the origin peer so
      // the map doesn't grow unbounded over the curator's lifetime.
      this.joinRequestOriginPeers.delete(originKey);
      return { delivered: true, peerId: targetPeerId, error: null };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        ctx,
        `Could not deliver ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}): ${errMsg}`,
      );
      return { delivered: false, peerId: targetPeerId, error: errMsg };
    }
  }

  /**
   * Forward a signed join request to the curator via P2P.
   *
   * Delivery is only to the explicit `curatorPeerId` carried in the V10
   * invite. A signed join credential contains the private CG identifier and
   * agent metadata; broadcasting it to unrelated peers after a targeted
   * transport failure is both useless (non-curators do not relay it) and a
   * privacy leak. The reliable messenger owns retries to the exact curator.
   *
   * Every peer that returns `{ok: true}` (whether via targeted or
   * broadcast path) is recorded in `joinRequestAcceptedBy` so the
   * matching `join-approved` / `join-rejected` notification can be
   * authenticated against them later (see that field's doc comment).
   *
   * Returns the number of peers that accepted the request.
   */
  async forwardJoinRequest(this: DKGAgent,
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName: string | undefined,
    curatorPeerId: string,
  ): Promise<{ delivered: number; errors: string[]; alreadyMember?: boolean; autoApproved?: boolean }> {
    if (!curatorPeerId) {
      // Required: V10 invites carry the curator's libp2p peer-id
      // (`<cgId>\n<peerId>`). Without it we can't authenticate the
      // returning `join-approved` / `join-rejected` notification —
      // caching arbitrary broadcast acceptors as trusted decision
      // senders is a security hole (any peer that ack'd the broadcast
      // could later forge a decision message). Fail fast at the entry
      // point with a clear error so the UI can surface it to the user.
      throw new Error(
        `forwardJoinRequest requires curatorPeerId. ` +
        `The invite code must include the curator's peer id (V10 format: "<cgId>\\n<peerId>"). ` +
        `Ask the curator to share an updated invite code.`,
      );
    }
    const payload = JSON.stringify({ contextGraphId, delegation, agentName });
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const errors: string[] = [];
    const agentAddress = delegation.agentAddress;
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;

    const recordAcceptedBy = (remotePeerId: string): void => {
      let set = this.joinRequestAcceptedBy.get(acceptedKey);
      if (!set) {
        set = new Set<string>();
        this.joinRequestAcceptedBy.set(acceptedKey, set);
      }
      set.add(remotePeerId);
    };

    const forgetAcceptedBy = (remotePeerId: string): void => {
      const set = this.joinRequestAcceptedBy.get(acceptedKey);
      if (!set) return;
      set.delete(remotePeerId);
      if (set.size === 0) this.joinRequestAcceptedBy.delete(acceptedKey);
    };

    // Open enrollment may approve and notify before the request-response
    // round-trip has returned. Trust the explicit invite-supplied curator
    // before sending so that immediate `join-approved` cannot lose a race
    // against the old post-response cache write. This is not a trust
    // expansion: the requester already selected this exact peer from the
    // curator's invite and sends the signed delegation only to it first.
    if (curatorPeerId !== this.peerId) {
      recordAcceptedBy(curatorPeerId);
      try {
        // rc.9 PR-10: substrate send. queued surfaces as a throw
        // (matches the legacy sendToPeer ergonomics so the existing
        // catch path with broadcast fallback still kicks in).
        const sendResult = await this.messenger.sendReliable(
          curatorPeerId,
          PROTOCOL_JOIN_REQUEST,
          payloadBytes,
          { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
        );
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        const responseBytes = sendResult.response;
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        if (response.ok) {
          // Only the explicit invite-supplied curator is a trusted decision
          // sender — it was pre-recorded above to cover immediate approval.
          const alreadyMember = !!response.alreadyMember;
          const autoApproved = !!response.autoApproved;
          this.log.info(
            ctx,
            `Forwarded join request for "${contextGraphId}" from ${agentAddress}: 1 curator(s) received ` +
              `(direct${alreadyMember ? ', already-member' : ''}${autoApproved ? ', auto-approved' : ''})`,
          );
          return {
            delivered: 1,
            errors,
            ...(alreadyMember ? { alreadyMember: true } : {}),
            ...(autoApproved ? { autoApproved: true } : {}),
          };
        }
        // Curator was reachable but rejected the request. Log + record
        // the reason so the joiner can see WHY (e.g. "unknown CG"
        // implies the cgId in the invite text is wrong).
        forgetAcceptedBy(curatorPeerId);
        const rejectReason = response.error ?? 'unknown';
        this.log.warn(
          ctx,
          `Targeted join-request to curator ${curatorPeerId.slice(-8)} returned non-ok: ${rejectReason}`,
        );
        if (response.error && response.error !== 'unknown CG') {
          errors.push(`${curatorPeerId.slice(-8)}: ${response.error}`);
        } else if (response.error === 'unknown CG') {
          // Surface "unknown CG" too — silent-filter was hiding the
          // most common invite-text-mismatch failure mode.
          errors.push(`${curatorPeerId.slice(-8)}: unknown CG`);
        }
        // The curator gave us an authoritative answer — no point
        // broadcasting the signed delegation to non-curator peers
        // (PROTOCOL_JOIN_REQUEST handler at dkg-agent.ts:1788 returns
        // `not curator` and does not relay; broadcasting just leaks the
        // delegation payload to unrelated peers without any chance of
        // delivery). Return the rejection now.
        return { delivered: 0, errors };
      } catch (dialErr) {
        forgetAcceptedBy(curatorPeerId);
        const msg = dialErr instanceof Error ? dialErr.message : String(dialErr);
        this.log.warn(
          ctx,
          `Targeted join-request dial to curator ${curatorPeerId.slice(-8)} failed: ${msg}`,
        );
        errors.push(`${curatorPeerId.slice(-8)}: dial failed (${msg})`);
        return { delivered: 0, errors };
      }
    }
    return {
      delivered: 0,
      errors: ['Curator peer id resolves to this node; submit the join request locally.'],
    };
  }

}
