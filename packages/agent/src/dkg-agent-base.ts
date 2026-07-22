// SPDX-License-Identifier: Apache-2.0

/**
 * Field + constructor base for the DKGAgent god-class, extracted as the
 * foundation of the mixin split. DKGAgent (and the per-subsystem method
 * holder classes) extend this so they share a single set of instance fields
 * and the constructor via `this`. Formerly-`private` instance fields are
 * `protected` here so holder subclasses can reach them; behaviour is
 * unchanged. The constructor is `protected` (was `private`) so subclasses can
 * be declared; external construction still goes through `DKGAgent.create`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolveVmReconcileStartupMaxDelayMs } from './startup-jitter.js';
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
  isSparqlUpdateOperation,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, isExternalBackend, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig, type QueryOptions } from '@origintrail-official/dkg-storage';
import { emptyRpcUsageWindow, EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo, type RpcUsageWindow } from '@origintrail-official/dkg-chain';
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
  type PromoteTerminalJobClearer,
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

import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler, type ChatAclCheck, type SkillAclCheck } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, canonicalAgentDidSubject, collectPublishableMultiaddrs, type AgentProfileConfig } from './profile.js';
import {
  signAgentDelegation,
  verifyAgentDelegation,
  type SignedAgentDelegation,
} from './auth/agent-delegation.js';
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { bindRandomSampling, type RandomSamplingDisabledReason, type RandomSamplingHandle, type RandomSamplingStatus } from './random-sampling-bind.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { Messenger, type SloProtocolStats } from './p2p/messenger.js';
import { NetworkAdmissionService } from './p2p/network-admission.js';
import { NetworkAdmissionCoordinator } from './p2p/network-admission-coordinator.js';
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
import {
  type SwmFanoutPeerSelector,
} from './swm/swm-fanout-peer-selection.js';
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
import { insertWithOversizeGuard } from './sync/oversize-filter.js';
import { OversizeTombstoneLog } from './sync/oversize-tombstones.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore, MemoryChangelogCursorStore } from './sync/checkpoint/state.js';
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
import {
  reconcileContextGraph,
  VmReconcileDispatcher,
  RecentUalSet,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
} from './chain-reconciler.js';
import type { ContextGraphReconcileResult } from './vm-reconcile-service.js';
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
  type ContextGraphSubscriptionRehydrationStatus,
  type ContextGraphSubscriptionStore,
  type VmReconcileNegativeRecord,
  type ContextGraphMemberPrincipalType,
  type ContextGraphMemberStatus,
  type ContextGraphMembershipRecord,
  type ContextGraphMembershipStore,
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type ResolvedDKGAgentConfig,
  type ReplicationEvent,
  type SyncReconcilerBackoff,
} from './dkg-agent-types.js';
import type { SyncCheckpointStore, ChangelogCursorStore } from './sync/checkpoint/state.js';
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
import { ContextGraphMetaProjection } from './context-graph-meta-projection.js';
import { ContextGraphJoinAdmissionLockManager } from './context-graph-join-admission-lock.js';
import { ContextGraphMembershipMutationStore } from './context-graph-membership-mutation.js';
import type { DKGAgent } from './dkg-agent.js';

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

export function createListContextGraphsCacheInvalidatingStore(
  innerStore: TripleStore,
  invalidate: () => void,
  // #1863 — `targetGraph` lets a single-graph destructive mutation (replaceSubject)
  // dirty the projection by graph rather than by inserted quads (covers deletes).
  markProjectionDirty?: (quads?: readonly Quad[], targetGraph?: string) => void,
): TripleStore {
  const invalidateAfterMutation = async <T>(
    work: () => Promise<T>,
    changed: (result: T) => boolean,
    markDirty?: (result: T) => void,
  ): Promise<T> => {
    const result = await work();
    if (changed(result)) {
      invalidate();
      markDirty?.(result);
    }
    return result;
  };
  const wrapper: TripleStore & { readonly innerStore: TripleStore } = {
    innerStore,
    get queryCancellation() {
      return innerStore.queryCancellation;
    },
    getPressureSnapshot() {
      return innerStore.getPressureSnapshot?.();
    },
    insert(quads, options) {
      return invalidateAfterMutation(
        () => innerStore.insert(quads, options),
        () => quads.length > 0,
        () => markProjectionDirty?.(quads),
      );
    },
    delete(quads, options) {
      return invalidateAfterMutation(
        () => innerStore.delete(quads, options),
        () => quads.length > 0,
        () => markProjectionDirty?.(),
      );
    },
    deleteByPattern(pattern, options) {
      return invalidateAfterMutation(
        () => innerStore.deleteByPattern(pattern, options),
        removed => removed > 0,
        () => markProjectionDirty?.(),
      );
    },
    query(sparql, options) {
      return invalidateAfterMutation(
        () => innerStore.query(sparql, options),
        () => isSparqlUpdateOperation(sparql),
        () => markProjectionDirty?.(),
      );
    },
    hasGraph(graphUri, options) {
      return innerStore.hasGraph(graphUri, options);
    },
    createGraph(graphUri) {
      return innerStore.createGraph(graphUri);
    },
    dropGraph(graphUri, options) {
      return invalidateAfterMutation(
        () => innerStore.dropGraph(graphUri, options),
        () => true,
        () => markProjectionDirty?.(),
      );
    },
    replaceGraph: innerStore.replaceGraph
      ? (graphUri, quads, options) => invalidateAfterMutation(
          () => innerStore.replaceGraph!(graphUri, quads, options),
          () => true,
          () => markProjectionDirty?.(),
        )
      : undefined,
    // Rootless KA materialization replaces the assertion graph and its UAL
    // metadata subject in one backend transaction. Preserve that optional
    // capability through the agent decorator just like replaceGraph/update;
    // omitting it makes every capable production backend appear unsupported.
    replaceGraphAndSubject: innerStore.replaceGraphAndSubject
      ? (graphUri, graphQuads, metaGraphUri, metadataSubject, metadataQuads, options) =>
          invalidateAfterMutation(
            () => innerStore.replaceGraphAndSubject!(
              graphUri,
              graphQuads,
              metaGraphUri,
              metadataSubject,
              metadataQuads,
              options,
            ),
            () => true,
            () => markProjectionDirty?.([...graphQuads, ...metadataQuads]),
          )
      : undefined,
    // #1863 — the async-lift publisher persists a job transition via this atomic
    // single-subject replace. Preserve the optional capability through the agent
    // decorator just like replaceGraph/replaceGraphAndSubject/update; omitting it
    // makes every capable production backend appear unsupported, so the publisher
    // silently falls back to non-atomic delete-then-insert and the fix is a no-op.
    replaceSubject: innerStore.replaceSubject
      ? (graphUri, subject, quads, options) =>
          invalidateAfterMutation(
            () => innerStore.replaceSubject!(graphUri, subject, quads, options),
            () => true,
            // Dirty the projection by the TARGET GRAPH, not the inserted quads:
            // a subject replace can DELETE projection-relevant metadata (or insert
            // non-relevant/empty rows), which quad-keyed dirtying would miss. The
            // target graph covers both delete and insert (#1863). No-op for a
            // non-CG graph (e.g. the control-plane graph), so no hot-path churn.
            () => markProjectionDirty?.(undefined, graphUri),
          )
      : undefined,
    listGraphs(options) {
      return innerStore.listGraphs(options);
    },
    listGraphsByPrefix(prefix, options) {
      return innerStore.listGraphsByPrefix
        ? innerStore.listGraphsByPrefix(prefix, options)
        : innerStore.listGraphs(options).then((graphs) => graphs.filter((graph) => graph.startsWith(prefix)));
    },
    deleteBySubjectPrefix(graphUri, prefix, options) {
      return invalidateAfterMutation(
        () => innerStore.deleteBySubjectPrefix(graphUri, prefix, options),
        removed => removed > 0,
        () => markProjectionDirty?.(),
      );
    },
    countQuads(graphUri, options) {
      return innerStore.countQuads(graphUri, options);
    },
    // Defined iff the inner store supports it, so the capability propagates
    // truthfully up the decorator chain (callers gate on `typeof store.update
    // === 'function'`). A server-side UPDATE can create/drop named graphs and
    // mutate projected content, so it invalidates the listGraphs cache and
    // marks the projection dirty just like insert/delete.
    update: innerStore.update
      ? (sparql, options) => invalidateAfterMutation(
        () => innerStore.update!(sparql, options),
        () => true,
        () => markProjectionDirty?.(),
      )
      : undefined,
    flush: innerStore.flush ? (options) => innerStore.flush!(options) : undefined,
    close() {
      return innerStore.close();
    },
  };
  return wrapper;
}

export class DKGAgentBase {
  readonly wallet: AgentWallet;
  readonly node: DKGNode;
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly queryEngine: DKGQueryEngine;
  readonly discovery: DiscoveryClient;
  readonly profileManager: ProfileManager;
  /**
   * Lazily-constructed WM→SWM async-promote queue (see
   * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md`). Routes call into it via
   * `agent.assertion.promoteAsync(...)`. PR #3 will wire an in-process
   * worker loop that periodically calls `claimNext` + `succeed`/`fail`;
   * for now, only the public enqueue/inspect surface is reachable. We
   * stash the impl as `private` and expose it via the `promoteQueue`
   * getter so the worker (a daemon-side concern) and tests can drive
   * the queue directly without going through the assertion subsurface.
   */
  // Typed with the terminal-clear capability at the ownership boundary (not cast at the
  // getter): the only assigned value is `TripleStoreAsyncPromoteQueue`, which implements it,
  // and any test/subclass substituting a queue must now satisfy the clearer at compile time.
  protected _promoteQueue?: AsyncPromoteQueue & PromoteTerminalJobClearer;
  /**
   * Override for tests / future operator config. When set before
   * `promoteQueue` is first accessed, the queue is constructed with
   * these overrides folded into the defaults.
   */
  protected _promoteQueueConfig?: Partial<AsyncPromoteQueueConfig>;
  gossip!: GossipSubManager;
  router!: ProtocolRouter;
  messenger!: Messenger;
  networkAdmission: NetworkAdmissionService = new NetworkAdmissionService();
  networkAdmissionCoordinator!: NetworkAdmissionCoordinator;
  /** Single in-process peer-address resolver (RFC 07 §3). Used by Messenger
   * today; ProtocolRouter / /api/connect migrate in PR-3 / PR-4. */
  peerResolver!: PeerResolver;
  readonly eventBus: TypedEventBus;
  protected readonly chain: ChainAdapter;
  /** Shared memory-owned root entities per context graph: entity → creatorPeerId. Used by publisher and shared memory handler. */
  protected readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  protected readonly contextGraphMetaProjection: ContextGraphMetaProjection;
  /**
   * OT-RFC-38 / LU-6 Phase B (Codex PR #610 round-2 #2) — highest
   * `nextSeqno` already consumed per (contextGraphId, hostPeerId)
   * pair from a successful `catchupSwmFromHost` round. Drives
   * `catchupSwmFromConnectedHosts` resume so steady-state members
   * don't re-download the entire host log every time the daemon's
   * standard catchup returns 0 and falls back to host-catchup.
   *
   * In-memory only: a daemon restart resets the cursor and the
   * first post-restart fallback rebuilds from `0`. That's correct —
   * after restart we don't trust our prior position estimate, and
   * the host's `seenShareOps`/sender-key replay-prevention layer
   * dedupes the re-applied envelopes so the only cost is one
   * round-trip of bandwidth, not duplicate state.
   */
  protected readonly lastHostCatchupSeqno: Map<string, Map<string, number>> = new Map();
  /** Shared write locks so gossip writes serialize against local CAS writes. */
  protected readonly writeLocks: Map<string, Promise<void>>;
  protected readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  protected sharedMemoryHandler?: InstanceType<typeof SharedMemoryHandler>;
  protected gossipPublishHandler?: GossipPublishHandler;
  protected finalizationHandler?: FinalizationHandler;
  /**
   * OT-RFC-38 LU-6 — opaque ciphertext store used only when this
   * node is a core hosting curated CG substrate on behalf of members.
   * Lazily constructed on first use; absent on edge nodes by default.
   */
  protected swmHostModeStore?: SwmHostModeStore;
  /**
   * CGs we've subscribed to in host mode (cores only), with the
   * discovery-path source that caused each subscription. PR5
   * ACK-provenance telemetry reads this map to populate the
   * `subscriptionSource` field on every signed StorageACK.
   *
   * Sources track the four LU-6 Phase B discovery paths defined in
   * `SUBSCRIPTION_SOURCES`: `chain-event`, `beacon`, `reconciler`,
   * `manual`. Member-mode CGs are NOT in this map — the StorageACK
   * handler routes them via `sharedMemoryGossipRegistered` (source =
   * `member`) instead.
   *
   * Keys are ALWAYS the canonical wire-form id (the curator-committed
   * `nameHash`, normalized through {@link canonicalSwmHostModeKey} /
   * {@link gossipWireIdFor}). Phase B's four discovery paths receive
   * the CG id in different shapes — chain-event/beacon already carry
   * the hash, while reconciler/manual typically receive the cleartext
   * local id or whatever string the operator POSTed — so each
   * insert/lookup/delete site canonicalizes first. Codex PR #672
   * review comment `id=3302086589` flagged the pre-canonicalization
   * regression: a chain-event subscribe (hash key) followed by a
   * manual subscribe (cleartext key) would miss `has()` and wire a
   * second handler on the same topic, causing duplicate host-mode
   * ingest/persistence and ambiguous provenance.
   *
   * On daemon restart, CGs reconstructed from `swmHostModeStore` boot
   * back through the `reconcileSwmHostModeSubscription` periodic
   * sweep, which defaults their source to `reconciler` (the original
   * cause is not persisted on disk and the periodic sweep IS what
   * restored them). Operators who need to differentiate "originally
   * subscribed via beacon" from "restored on restart" should consult
   * the daemon log at subscribe time, not the live `subscriptionSource`
   * field.
   */
  protected readonly swmHostModeSubscribed = new Map<string, SubscriptionSource>();
  /**
   * Cached curation classification for each host-mode handler. The handler
   * reads this map before dispatch so the strip can cover both legacy and
   * chunked envelopes without a store-backed policy lookup per message.
   */
  protected readonly swmHostModeCurated = new Map<string, boolean>();
  /**
   * Per-CG reference to the host-mode gossip handler closure. Kept
   * so we can call `gossip.offMessage(topic, handler)` to remove
   * JUST the host-mode handler when the same core later becomes
   * member-authorized for the CG, without disturbing other handlers
   * for the same topic. Codex PR #610 R3 caught the duplicate-apply
   * defect where both host- and member-mode handlers ran in
   * parallel after authorization flipped, causing every gossip
   * message to be both decrypted-and-applied AND opaquely appended.
   *
   * Keyed by the canonical wire-form id (same invariant as
   * `swmHostModeSubscribed`); see {@link canonicalSwmHostModeKey}.
   */
  protected readonly swmHostModeHandlers = new Map<string, (topic: string, data: Uint8Array, from: string) => void>();
  /** Async lock for the host-mode reconciler so simultaneous calls don't double-subscribe. */
  protected hostModeReconcileInflight?: Promise<void>;
  /** Rotating cursor for bounded host-mode reconcile sweeps over known context graphs. */
  protected hostModeReconcileCursor = 0;
  /**
   * OT-RFC-43 A2 — the KA-number allocator, retained on the agent (also
   * forwarded to the publisher as `kaAllocator`). Held here so
   * `assertionFinalize` can ALLOCATE-AT-FINALIZE (single source of truth):
   * it reconciles + allocates once at seal time, stamps the packed kaId on the
   * lifecycle URN, and the publish path REUSES the stamped id instead of
   * allocating a second time (eliminates double-allocation). `undefined` for
   * mock/no-chain/pre-Option-1 flows.
   */
  readonly kaNumberAllocator?: import('./allocator.js').KaNumberAllocator;
  /**
   * Authors whose KA-number floor has already been reconciled against the
   * chain this process (mirrors the publisher's `reconciledKaAuthors`). Lazy,
   * once-per-author. Keyed by lowercased address.
   */
  protected readonly reconciledKaAuthors = new Set<string>();
  protected readonly log = new Logger('DKGAgent');

  /**
   * Per-cgId count of SWM gossip publish failures. Populated by
   * publishWorkspaceGossip's catch block (rc.9 PR-A / SWM reliable
   * fan-out plan, Step 0). Exposed via /api/slo `gossip.publishFailures`.
   * Process-lifetime in-memory only — no persistence; on daemon
   * restart counters reset. Sufficient for soak measurement; if
   * operators ever need cross-restart aggregation, escalate to a
   * SQLite table.
   *
   * Codex PR #570 R5 caught that the map would grow unbounded for any
   * caller that fails publishes against arbitrary cgIds. To prevent
   * runaway memory + a permanently bloated /api/slo payload, we cap
   * the per-cgId set at SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS. Overflow
   * counters are summed into `swmGossipPublishFailuresOverflow` so the
   * total stays accurate; a sticky `swmGossipPublishFailuresTruncated`
   * flag tells operators that the per-cgId breakdown is partial.
   */
  protected readonly swmGossipPublishFailures = new Map<string, number>();
  protected swmGossipPublishFailuresOverflow = 0;
  protected swmGossipPublishFailuresTruncated = false;
  static readonly SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS = 1024;

  /**
   * Per-cgId, per-outcome counters for substrate-fan-out SWM
   * shares (rc.9 PR-C / SWM reliable fan-out plan, Step 3).
   * Populated by the {@link FanOutBookkeeper} the agent passes to
   * `executeSubstrateFanOut` inside `publishWorkspaceGossip`.
   * Same overflow-cap shape as `swmGossipPublishFailures` (Codex
   * PR #570 R5/R8): the per-cgId map is hard-capped at
   * {@link SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS}; once exceeded,
   * the cgId with the GLOBAL smallest total (delivered + queued +
   * inFlight + failed) gets evicted into
   * {@link swmSubstrateFanoutOverflow} so the grand total stays
   * accurate. A sticky {@link swmSubstrateFanoutTruncated} flag
   * tells `/api/slo` consumers that the per-cgId breakdown is
   * partial.
   *
   * `delivered` is the only "good" outcome — `rejected` means
   * the receiver explicitly dropped the share for a permanent
   * reason (peer not in allowlist, bad signature, validation
   * failed; PR-C codex R6 split this out from `delivered` so
   * the metric doesn't overstate end-to-end success), `queued`
   * means the substrate accepted the entry into the durable
   * outbox (will retry; not a delivery confirmation), `inFlight`
   * means another sender already owns the attempt, `failed` is
   * the unrecoverable case. PR-D will add an ACK / watchdog that
   * upgrades `queued → delivered` after the receiver confirms.
   */
  protected readonly swmSubstrateFanoutDelivered = new Map<string, number>();
  protected readonly swmSubstrateFanoutRejected = new Map<string, number>();
  /**
   * rc.9 PR-D (codex follow-up from PR-G #G1): per-cgId count
   * of substrate sends that returned the FANOUT_RESPONSE_RETRYABLE
   * sentinel. NOT counted as delivered; SwmAckQuorum's watchdog
   * fires substrate top-up.
   */
  protected readonly swmSubstrateFanoutRetryable = new Map<string, number>();
  protected readonly swmSubstrateFanoutQueued = new Map<string, number>();
  protected readonly swmSubstrateFanoutInFlight = new Map<string, number>();
  protected readonly swmSubstrateFanoutFailed = new Map<string, number>();
  protected swmSubstrateFanoutOverflow = {
    delivered: 0,
    rejected: 0,
    retryable: 0,
    queued: 0,
    inFlight: 0,
    failed: 0,
  };
  protected swmSubstrateFanoutTruncated = false;
  static readonly SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS = 1024;

  /**
   * rc.9 PR-G codex follow-up #G2: in-flight substrate fan-out
   * promises detached from the foreground `share()` call. Pre-PR-G
   * `publishWorkspaceGossip` awaited both the substrate and
   * gossip legs together, which meant one slow / offline
   * allowlisted peer could hold `share()` open for up to
   * `SWM_SUBSTRATE_FANOUT_TIMEOUT_MS` (15s) — a regression from
   * the pre-rc.9 gossip-only path that returned in tens of ms.
   *
   * Now we fire substrate fan-out without awaiting it, await
   * only the (fast) gossip publish, and return. The substrate
   * promise still runs to completion in the background — its
   * bookkeeper still updates the per-cgId counter maps as each
   * peer's send completes, and its `.then()` still emits the
   * fan-out INFO summary log. Failures (which executeSubstrateFanOut
   * already swallows internally via Promise.allSettled) get a
   * defensive `.catch()` to log any escaped error without
   * crashing the unhandled-rejection handler.
   *
   * The Set holds the wrapped promises (after the bookkeeper +
   * INFO-log chain is attached) so tests can drain them via
   * `awaitInFlightSubstrateFanOuts()`. .finally() removes each
   * promise on completion so the Set stays bounded by
   * concurrency, not by cumulative shares.
   */
  protected readonly inFlightSubstrateFanOuts = new Set<Promise<void>>();
  /**
   * Member-count cap above which public CGs fall back to gossip-
   * only delivery (substrate fan-out is N-round-trips, so cost
   * grows linearly in members; gossip cost is independent of N).
   * Configurable via `DKG_SWM_SUBSTRATE_MAX_MEMBERS` env so soak
   * runs can sweep the parameter without rebuilding. Curated CGs
   * (`source: 'allowlist'`) are NOT truncated by this cap — see
   * `chooseFanOutTier` jsdoc for the rationale.
   */
  protected readonly swmSubstrateMaxMembers: number = (() => {
    const raw = process.env.DKG_SWM_SUBSTRATE_MAX_MEMBERS;
    if (!raw) return 100;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 100;
    return n;
  })();
  /**
   * Per-send substrate timeout for SWM update fan-out. Matches the
   * 15s reliability SLO the messenger targets for chat. Kept as a
   * named constant so the soak script can correlate /api/slo
   * `protocols['/dkg/10.0.1/swm-update']` p99 latency against the
   * timeout budget.
   */
  static readonly SWM_SUBSTRATE_FANOUT_TIMEOUT_MS = 15_000;

  /**
   * Per-curator-peer timeout for the STRICT curator-ack gate on a private-CG
   * write (OT-RFC-49 curator-leader). Shorter than the 15s fan-out budget
   * because it sits synchronously on the HTTP write path: too long makes a
   * write hang when the curator is slow/unreachable; too short produces false
   * `unconfirmed` errors for a curator that would have applied it. 5s is the
   * default; callers may override via `share({ curatorAckTimeoutMs })`.
   */
  static readonly SWM_CURATOR_ACK_TIMEOUT_MS = 5_000;

  /**
   * Lazy CGMemberEnumerator — single instance per agent. Holds the
   * 60s membership cache shared across every share to the same
   * cgId within a window. See {@link getOrCreateCGMemberEnumerator}.
   */
  protected cgMemberEnumerator?: CGMemberEnumerator;

  /**
   * Lazy SwmAckQuorum — single instance per agent. Tracks
   * outstanding SWM shares to compute per-share delivery quorum
   * across the gossip + substrate hybrid (rc.9 PR-D, RFC-003
   * §4.2 + §5). Substrate-acked peers from PR-C's
   * `executeSubstrateFanOut` pre-populate the `acked` set so the
   * gossip-side `PROTOCOL_SWM_SHARE_ACK` arrivals fill in the
   * remaining gap. See {@link getOrCreateSwmAckQuorum}.
   */
  protected swmAckQuorum?: SwmAckQuorum;
  protected swmAckQuorumTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Active SWM sender-side peer outcome cache. Public CG fan-out uses this
   * to keep stale/flapping subscriber peers out of the short-term
   * substrate/ACK set without changing private allowlist semantics.
   */
  protected swmFanoutPeerSelector?: SwmFanoutPeerSelector;
  /**
   * Period at which `SwmAckQuorum.tick()` runs. Picked to match
   * RFC-003 §5.2 ("watchdog tick: 5s") — a finer cadence buys
   * nothing useful (watchdogMs is 30s by default, deadlineHardMs
   * is 5min, so 5s is already 6x and 60x resolution respectively).
   */
  static readonly SWM_ACK_QUORUM_TICK_MS = 5_000;

  /**
   * Phase B — chain-driven VM reconciliation sweep cadence. The periodic sweep
   * is the safety net behind the live `KnowledgeAssetRegisteredToContextGraph`
   * nudge: it guarantees eventual reconciliation even if an event was missed or
   * a fetch transiently failed. Env-overridable for ops tuning.
   */
  static readonly VM_RECONCILE_SWEEP_INTERVAL_MS =
    Number(process.env['DKG_VM_RECONCILE_INTERVAL_MS']) || 60_000;
  // The periodic sweep is a missed-event safety net, not startup readiness.
  // Spread its first run across the configured cadence so a rolling fleet
  // restart does not immediately launch a full reconciliation scan on every
  // node. Live chain nudges remain available from startup.
  static readonly VM_RECONCILE_STARTUP_MAX_DELAY_MS =
    resolveVmReconcileStartupMaxDelayMs(
      process.env['DKG_VM_RECONCILE_STARTUP_MAX_DELAY_MS'],
      DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS,
    );
  static readonly VM_RECONCILE_NEGATIVE_BACKOFF_BASE_MS =
    Math.max(5_000, DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS);
  static readonly VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS =
    Number(process.env['DKG_VM_RECONCILE_BACKOFF_MAX_MS']) || 10 * 60_000;
  static readonly VM_RECONCILE_CACHE_MAX_ENTRIES =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_CACHE_MAX_ENTRIES']) || 1_000);
  static readonly VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS']) || 2_000);
  static readonly VM_RECONCILE_CG_STATE_MAX_ENTRIES =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_CG_STATE_MAX_ENTRIES']) || 1_000);
  static readonly VM_RECONCILE_QUEUE_MAX_PENDING =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_QUEUE_MAX_PENDING']) || 256);
  /**
   * Maximum chain ordinals one CG may process before yielding the single VM
   * worker. Ten keeps exact missing-KA pulls useful while bounding cross-CG
   * latency and the per-request UAL filter.
   */
  static readonly VM_RECONCILE_BATCH_SIZE =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_BATCH_SIZE']) || 10);
  /**
   * Parallel ordinal work per CG. Combined with the default two-CG dispatcher
   * concurrency this caps chain/store pressure at ten in-flight ordinals.
   */
  static readonly VM_RECONCILE_ORDINAL_CONCURRENCY =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_ORDINAL_CONCURRENCY']) || 5);
  /** Keep a slow peer recovery for one CG from blocking every other CG. */
  static readonly VM_RECONCILE_CONCURRENCY =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_CONCURRENCY']) || 2);
  static readonly VM_RECONCILE_MAX_FOREGROUND_BURST =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_MAX_FOREGROUND_BURST']) || 8);
  static readonly VM_RECONCILE_SHUTDOWN_TIMEOUT_MS =
    Math.max(1, Number(process.env['DKG_VM_RECONCILE_SHUTDOWN_TIMEOUT_MS']) || 5_000);
  static readonly CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS =
    Math.max(1, Number(process.env['DKG_CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS']) || 5_000);
  /**
   * Blocks a completed ordinal must be buried by before its watermark advance
   * commits (reorg gate). The data is promoted to VM eagerly; only the cursor
   * advance waits. Observation-block based (see `reconcileChainOrdinal`), so
   * this is effectively "wait N blocks of chain progress after we observed the
   * registration before trusting the watermark".
   */
  static readonly VM_RECONCILE_CONFIRMATION_DEPTH =
    Number(process.env['DKG_VM_RECONCILE_CONFIRMATION_DEPTH']) || 5;

  static readonly LIST_CONTEXT_GRAPHS_CACHE_TTL_MS =
    readNonNegativeNumberEnv('DKG_LIST_CONTEXT_GRAPHS_CACHE_TTL_MS', 5_000);
  static readonly LIST_CONTEXT_GRAPHS_CACHE_MAX =
    Math.max(1, Number(process.env['DKG_LIST_CONTEXT_GRAPHS_CACHE_MAX']) || 32);
  static readonly LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS =
    Math.max(1, Number(process.env['DKG_LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS']) || 200);
  static readonly LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS =
    Math.max(1, Number(process.env['DKG_LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS']) || 5_000);
  static readonly LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS =
    Math.max(1, Number(process.env['DKG_LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS']) || 5_000);
  /**
   * Per-row list enrichment can issue several store queries. Keep the aggregate
   * fan-out comfortably below the store scheduler's normal-queue limit even on
   * nodes that have discovered hundreds of context graphs.
   */
  static readonly LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY =
    Math.min(8, Math.max(
      1,
      Math.floor(Number(process.env['DKG_LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY']) || 4),
    ));

  protected messageHandler: MessageHandler | null = null;
  protected chainPoller: ChainEventPoller | null = null;
  protected swmCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase B — periodic chain-driven VM reconciliation sweep timer. */
  protected vmReconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase B — unified per-CG coalescing and node-wide admission policy. */
  protected vmReconcileDispatcher?: VmReconcileDispatcher<ContextGraphReconcileResult>;
  /** Next eligible CG index for bounded periodic-sweep admission. */
  protected vmReconcileSweepCursor = 0;
  /** Deterministically staggered cold-start prime, separate from the interval. */
  protected vmReconcileStartupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Process-wide sweep single-flight; interval/startup callers join this promise. */
  protected vmReconcileSweepInFlight: Promise<void> | null = null;
  /** Phase B — in-memory reconcile cursor per local CG id (watermark + `ahead`). */
  protected readonly reconcileCursors = new Map<string, CursorState>();
  /** Phase B — bounded dedupe of recently-reconciled UALs (live-burst guard). */
  protected readonly recentReconciledUals = new RecentUalSet();
  /**
   * In-flight core-hosted recordings launched from the synchronous StorageACK
   * pre-sign hook. Tracked so rejections are logged and graceful stop() can
   * flush the host-only `coreHosted` flag before teardown.
   */
  protected readonly coreHostRecordings = new Set<Promise<void>>();
  /** Stop-time gate: once true, ACK hooks must not start new core-host writes. */
  protected coreHostRecordingsClosed = false;
  /** Monotonic guard: continuations from abandoned drain generations must not persist after restart. */
  protected coreHostRecordingGeneration = 0;
  /** Phase D/A4 — per-UAL retry damping after a chain ordinal has no matching local SWM snapshot. */
  protected readonly vmReconcileNegativeCache = new Map<string, Omit<VmReconcileNegativeRecord, 'cacheKey'>>();
  /** Keys already consulted in the durable store during this process lifetime. */
  protected readonly vmReconcileNegativeCacheHydrated = new Set<string>();
  protected readonly vmReconcileNegativeCacheKeysByCg = new Map<string, Set<string>>();
  /** Phase D/A4 — per-CG active-fetch cooldown so one sweep cannot fan out repeated fetches. */
  protected readonly vmReconcileFetchCooldownAt = new Map<string, number>();
  /** Phase D/A4 — round-robin cursor over the already ordered catch-up peer list. */
  protected readonly vmReconcileCatchupPeerCursor = new Map<string, number>();
  protected readonly vmReconcileCatchupPeerOrder = new Map<string, {
    orderedPeers: string[];
    nextPeerId?: string;
    priorityRanks?: Record<string, number>;
  }>();
  protected hostModeReconcilerTimer: ReturnType<typeof setInterval> | null = null;
  protected hostModePruneTimer: ReturnType<typeof setInterval> | null = null;
  // rc.9 PR-10: joinApprovalRetryQueue + joinApprovalRetryTimer
  // deleted. The substrate's SQLite-backed ProtocolOutbox + its
  // scheduled tick (`Messenger.processOutboxTick`) replace the in-memory
  // queue: persistence across restart, generic per-protocol coverage,
  // identical backoff-ladder semantics. Operator-facing diagnostics
  // (`listPendingJoinApprovalRetries`) are stubbed to [] until PR-12
  // adds a per-protocol substrate-outbox view.
  /**
   * Periodic tick driving `Messenger.processOutboxTick` for the
   * Universal Messenger substrate outbox (rc.9 PR-3+). The
   * rc.8-era chat-specific `MessageOutbox` was deleted in PR-3 in
   * favour of the substrate's SQLite-backed generic outbox; the
   * substrate now carries every short-message protocol that opts
   * onto `/dkg/10.0.x` with x ≥ 1.
   */
  protected messengerOutboxTimer: ReturnType<typeof setInterval> | null = null;
  protected randomSamplingHandle: RandomSamplingHandle | null = null;
  protected randomSamplingIdentityId = 0n;
  protected randomSamplingDisabledReason: RandomSamplingDisabledReason = 'not_started';
  protected randomSamplingBindRetryTimer: ReturnType<typeof setInterval> | null = null;
  protected randomSamplingBindRetryInFlight = false;
  protected storageACKRegistrationRetryTimer: ReturnType<typeof setTimeout> | null = null;
  protected storageACKRegistrationRetryInFlight = false;
  // #894 / Codex PR #901 round-3 :1685: `ensureProfile()` is a mutating
  // multi-tx flow (createProfile + stake) that can legitimately outlast the
  // boot read-timeout. Guards against the boot path AND the StorageACK retry
  // re-submitting `ensureProfile()` while a prior one may still be settling on
  // chain — which would risk a duplicate profile / double-stake.
  protected profileProvisioningInFlight = false;
  protected readonly config: ResolvedDKGAgentConfig;
  protected started = false;
  protected readonly subscribedContextGraphs = new Map<string, ContextGraphSub>();
  protected contextGraphSubscriptionRehydrationStatus: ContextGraphSubscriptionRehydrationStatus | null = null;
  protected readonly contextGraphSubscriptionRehydrationAccountedIds = new Set<string>();
  protected readonly contextGraphSubscriptionPersistRevisions = new Map<string, number>();
  protected readonly contextGraphSubscriptionPersistAppliedRevisions = new Map<string, number>();
  protected readonly contextGraphSubscriptionPersistCanceledRevisions = new Map<string, number>();
  protected readonly contextGraphSubscriptionPersistPendingRevisions = new Map<string, Set<number>>();
  protected readonly contextGraphSubscriptionPersistChains = new Map<string, Promise<void>>();
  protected readonly listContextGraphsCache = new Map<string, {
    expiresAt: number;
    rows: Array<Record<string, unknown>>;
  }>();
  protected readonly listContextGraphsInFlight = new Map<string, Promise<Array<Record<string, unknown>>>>();
  protected listContextGraphsCacheGeneration = 0;
  protected listContextGraphsCacheNow(): number {
    return performance.now();
  }

  protected listContextGraphsCacheAllowed(): boolean {
    if (this.config.store) {
      return false;
    }
    const storeConfig = this.config.storeConfig;
    if (!storeConfig) return true;
    if (isExternalBackend(storeConfig.backend)) return storeConfig.options?.managedByDkg === true;
    return isLocalOxigraphConfig(storeConfig);
  }

  protected invalidateListContextGraphsCache(): void {
    this.listContextGraphsCacheGeneration += 1;
    this.listContextGraphsCache.clear();
    this.listContextGraphsInFlight.clear();
  }

  /**
   * Oversize tombstone log — lazily constructed so every sync-ingest seam
   * shares one bounded ring + JSONL file (OT-RFC-56 §4.2). See
   * sync/oversize-filter.ts for the guard this records for.
   */
  private oversizeTombstoneLogInstance?: OversizeTombstoneLog;
  protected get oversizeTombstoneLog(): OversizeTombstoneLog {
    if (!this.oversizeTombstoneLogInstance) {
      this.oversizeTombstoneLogInstance = new OversizeTombstoneLog({
        dataDir: this.config.dataDir,
        logWarn: (message) => this.log.warn(createOperationContext('sync'), message),
      });
    }
    return this.oversizeTombstoneLogInstance;
  }

  /**
   * Sync-ingest store insert (durable sync + registry meta pulls). Guarded by
   * the oversize filter (OT-RFC-56): quads whose literal exceeds the protocol
   * size invariant are dropped + tombstoned BEFORE the insert, so the sync
   * offset cursor advances past pages containing them instead of the store
   * throwing and the page being re-fetched from every peer forever (the
   * 2026-07-08 mainnet poison-literal retry storm).
   */
  protected async insertSyncedQuadsAndInvalidateListCache(quads: Quad[], options?: QueryOptions): Promise<void> {
    const inserted = await insertWithOversizeGuard(
      (kept) => this.store.insert(kept, options),
      quads,
      { recordDrops: (drops, seam) => this.oversizeTombstoneLog.record(drops, seam) },
      'durable-sync',
    );
    if (inserted.length > 0) {
      this.invalidateListContextGraphsCache();
      this.contextGraphMetaProjection.markDirtyFromQuads(inserted);
    }
  }
  protected readonly gossipRegistered = new Set<string>();
  protected readonly sharedMemoryGossipRegistered = new Set<string>();
  protected readonly seenOnChainIds = new Set<string>();
  /**
   * OT-RFC-38 / LU-6 Phase B — reverse index from `onChainHash` (the
   * curator-committed wire id) to the local cleartext id. Lets the
   * receive path translate a wire-form envelope back to the local CG
   * record in O(1) without scanning `subscribedContextGraphs`. The
   * canonical write site is wherever `subscribedContextGraphs.onChainHash`
   * is set (chain-event handler, register-on-chain success path, join-
   * approved payload handler) — direct writes elsewhere can drift, so
   * keep the two maps in lockstep via {@link recordCgWireId}. Keyed
   * by lowercase 0x-prefixed hex.
   */
  protected readonly wireIdToLocalCgId = new Map<string, string>();
  /**
   * OT-RFC-38 / LU-6 Phase B — curator-side beacon registry.
   *
   * Each CG the local node CREATED that wants pre-registration
   * auto-host registers an entry here. The periodic re-announce
   * timer (see {@link beaconReannounceTimer}) iterates this map
   * every {@link BEACON_REANNOUNCE_INTERVAL_MS} and broadcasts a
   * fresh-`ts`-signed beacon for each entry on the global
   * `dkg/cg-discovery` topic so cores joining the network late can
   * still discover and auto-host the CG before the curator pays
   * gas to register it on chain.
   *
   * Keyed by LOCAL CG id (cleartext or hash, whatever the create
   * flow recorded). Values include the wire id (always the hash)
   * the curator commits to so re-announces don't have to re-derive.
   *
   * Lifecycle:
   *   - `registerCgForBeaconAnnouncement` (called from
   *     `createContextGraph` for curated CGs) inserts.
   *   - `unregisterCgFromBeaconAnnouncement` (called from CG
   *     deletion / unsubscribe paths) removes.
   *   - Stays populated AFTER on-chain registration so cores that
   *     came online after the `ContextGraphCreated` event was
   *     emitted (and rolled off the chain poller's lookback window)
   *     still get the beacon — chain events are the primary path
   *     but beacons are the safety net.
   */
  protected readonly beaconRegistry = new Map<string, {
    wireId: string;
    curatorEoa: string;
    signerPrivateKey?: string;
    accessPolicy: number;
  }>();
  /**
   * OT-RFC-38 / LU-6 Phase B — core-side reverse map: which curator
   * EOA last beaconed each wire id. Populated by the beacon
   * listener; consulted by {@link ingestSwmHostModeEnvelope} when
   * the CG is NOT yet on-chain-registered, so the per-curator
   * sliding-window budget (see {@link DiscoveryRateLimit}) can be
   * applied against the wallet that authored the beacon — not
   * against the libp2p peer id (which rotates and can't be tied
   * to identity / abuse history).
   */
  protected readonly beaconCuratorByWireId = new Map<string, string>();
  /**
   * OT-RFC-38 / LU-6 — replay-defence cache for signed
   * `swm-host-catchup` requests. Tracks recent (requesterEoa, nonce)
   * pairs so a request lifted off the wire can't be replayed against
   * the same responder while the freshness window is still open.
   * See {@link CatchupReplayGuard}.
   */
  protected readonly catchupReplayGuard = new CatchupReplayGuard();
  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — separate replay LRU for the chunk
   * sync verb. Kept distinct from the host-catchup guard so a single
   * EOA's two concurrent streams (one for the LU-6 envelope catchup,
   * one for per-chunk backfill) never collide on nonce uniqueness.
   */
  protected readonly ciphertextChunkCatchupReplayGuard = createCiphertextChunkCatchupReplayGuard();
  /**
   * OT-RFC-38 / LU-6 Phase B — periodic beacon re-announce timer
   * (curators only). See {@link beaconRegistry} jsdoc.
   */
  protected beaconReannounceTimer?: ReturnType<typeof setInterval>;
  /**
   * PR feat/chain-agents-cg-phonebook — periodic agent-profile
   * heartbeat. Re-publishes the profile to the `agents` Context
   * Graph on `AGENT_PROFILE_HEARTBEAT_MS` cadence (operator
   * override via `config.network.agentProfileHeartbeatMs`; `0`
   * disables). Undefined until {@link start} runs and `null` after
   * {@link stop} clears it.
   */
  protected agentProfileHeartbeatTimer?: ReturnType<typeof setInterval>;
  /**
   * Heartbeat-tick coalescing flag. When a heartbeat is already
   * in flight, the next tick logs + skips instead of queueing — this
   * keeps the queue depth at 1 even if publish latency exceeds the
   * heartbeat cadence (slow chain RPC, congested gossip mesh).
   *
   * NOT a correctness gate against concurrent `publishProfile()`
   * callers — startup, key-rotation, and revocation also call
   * `publishProfile()` directly, and they bypass this flag. The
   * correctness gate is the `publishProfileTail` mutex below.
   */
  protected agentProfileHeartbeatInFlight = false;
  /**
   * Serialization mutex for `publishProfile()`. Tail-promise chain:
   * each new caller `await`s the prior call (success or failure) and
   * only then runs its own publish. Codex review of PR #700 round 2
   * flagged that the heartbeat-only inFlight guard left a race
   * window between the heartbeat tick and the existing `startup` /
   * key-rotation / revocation callers, both of which mutate
   * `ProfileManager.currentKcId` and rewrite the registry triples
   * on every call. Serializing inside `publishProfile()` covers
   * every entry point at the lowest level instead of duplicating
   * the guard at every caller.
   */
  protected publishProfileTail: Promise<unknown> = Promise.resolve();
  /**
   * Coalesces startup and first-join profile readiness checks. The regular
   * publish tail serializes writes, but without this promise two concurrent
   * readiness callers could still queue duplicate profile KAs while neither
   * has observed the first result yet.
   */
  protected ensureProfilePublishedInFlight?: Promise<void>;
  /**
   * OT-RFC-38 / LU-6 Phase B — sliding-window rate-limiter applied
   * to pre-registration (beacon-discovered) ciphertext writes.
   * Bounds the freemium-tier abuse vector: any wallet can broadcast
   * beacons and trigger cores to host ciphertext, so cores cap how
   * many bytes per wallet they admit per minute / per hour and how
   * much total pre-registration ciphertext they hold across all
   * wallets. Lazily constructed on the core role; undefined on
   * edges (which never auto-host).
   */
  protected discoveryRateLimit?: DiscoveryRateLimit;
  /**
   * OT-RFC-38 / LU-5: per-core cache of on-chain CG access policies,
   * keyed by the on-chain numeric id (uint256). Populated by:
   *   1. `onContextGraphCreated` chain-event handler (eager) — fills in
   *      the access policy as soon as the core sees the `ContextGraphCreated`
   *      / `NameClaimed` event from chain, BEFORE the publisher's
   *      first publish intent arrives.
   *   2. {@link resolveCgCurationForAck} (lazy) — when local store has no
   *      access-policy triple AND the cache is cold, the resolver falls
   *      back to a single `chain.getContextGraphAccessPolicy` RPC and
   *      memoizes the answer here.
   *
   * `1` = curated/private, `0` = public, `undefined` = not yet
   * resolved. Callers MUST NOT interpret missing-from-cache as a
   * positive curation signal — fall through to the chain.
   */
  protected readonly onChainAccessPolicyCache = new Map<string, number>();
  /**
   * #884 review — one-shot guard so the "chain adapter exposes
   * getContextGraphAccessPolicy but NOT the isContextGraphActiveOnChain
   * liveness probe" diagnostic (emitted by {@link readLiveOnChainAccessPolicy})
   * is logged once per process instead of on every share/publish, while still
   * giving operators a NON-silent signal that public-on-chain CGs are being
   * kept on the encrypted path for this adapter.
   */
  protected warnedMissingCgLivenessProbe = false;
  /**
   * Issue #872 — companion cache for the per-CG `publishPolicy` enum
   * (`0` = curators-only, `1` = open). Populated lazily by the
   * `ContextGraphCreated` chain-event handler (the event already
   * carries both enums; the only thing missing was the cache slot).
   * Consumed by {@link getContextGraphOnChainPolicy} so daemon routes
   * can decide whether to apply owner-scoped guards or relax them for
   * public + open CGs without a per-request RPC. `undefined` means
   * the chain answer hasn't reached this node yet — callers MUST
   * treat that as unknown (fail-closed) rather than a positive
   * "publish-policy is open" signal.
   *
   * Codex review on #872 — `publishPolicy` is mutable on-chain via
   * `ContextGraphStorage.updatePublishPolicy` (which emits
   * `PublishPolicyUpdated`), but this cache is only seeded from the
   * `ContextGraphCreated` event. Without listening to the update event
   * AND without a freshness check, a stale `1` survives until daemon
   * restart and keeps `isPublicOpenContextGraph()` relaxing the
   * import-artifact owner guard after a curator flips the CG from
   * open → curated. The TTL companion map below stamps every cache
   * write with `Date.now()`; reads in `getContextGraphOnChainPolicy`
   * treat entries older than {@link ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS}
   * as miss and fall through to the chain-RPC fallback (which already
   * exists for the round-3 non-creator-peer path). Stale data drifts
   * authoritative within at most one TTL window. The bound is set
   * conservatively because the cache gates an authorization decision —
   * one extra eth_call per minute per active CG is cheap.
   */
  protected readonly onChainPublishPolicyCache = new Map<string, number>();
  /**
   * Codex review on #872 — companion timestamp map for {@link onChainPublishPolicyCache}.
   * `now - fetchedAt > ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` is treated
   * as a cache miss. Kept as a sibling map (rather than refactoring the
   * cache value to `{ value, fetchedAt }`) so existing test fixtures
   * that read `cache.get(id)` and expect a bare number still pass.
   */
  protected readonly onChainPublishPolicyCacheUpdatedAt = new Map<string, number>();
  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed participant-agent
   * allowlist cache. Keyed by `contextGraphId.toString()` (stringified
   * on-chain numeric id; the resolver normalises any cleartext form
   * to numeric before consulting). Values are EIP-55 checksum
   * addresses sourced from `chain.getContextGraphParticipantAgents`.
   *
   * Consulted by `resolveOnChainParticipantAgents` (wired into
   * `SharedMemoryHandler.chainAgentGateOracle`) to authenticate
   * host-mode gossip envelopes on cores that have no local meta
   * for the CG. Stale entries are tolerable: on chain the allowlist
   * is mutable but changes slowly, and admitting a previously-
   * removed agent only affects ciphertext acceptance into the host-
   * mode store — the CG members' decrypt path remains gated by the
   * sender-key issuance, so a stale allowlist hit can't escalate
   * privilege. Invalidation is therefore best-effort (on receipt of
   * `ContextGraphAgentsUpdated`-class events; not yet wired) and
   * the cache TTL is intentionally long (process lifetime).
   *
   * Empty arrays cache the answer too (negative caching for ids
   * with no agents) — without it, the resolver would keep paying
   * the RPC every envelope for an unknown id, opening a DoS lever.
   */
  protected readonly onChainParticipantAgentsCache = new Map<string, string[]>();
  protected readonly peerHealth = new Map<string, PeerHealth>();
  protected readonly knownCorePeerIds = new Set<string>();
  protected readonly knownCorePeerIdsV2 = new Set<string>();
  /**
   * Last chain-reported ACK quorum (ParametersStorage
   * minimumRequiredSignatures), refreshed by the V10 ACK provider before
   * each collect. `getACKCandidatePeers` uses it so the confirmed-core
   * shortcut tracks the REAL runtime quorum instead of the hard-coded
   * default (Codex review on PR #1107).
   */
  protected lastKnownRequiredACKs?: number;
  protected readonly syncingPeers = new Set<string>();
  protected readonly seenPrivateSyncRequestIds = new Map<string, number>();
  protected readonly metaRefreshTimestamps = new Map<string, number>();
  protected readonly preferredSyncPeers = new Map<string, string>();
  /** Stable key for state that must be scoped to one signed join generation. */
  protected joinRequestTrackingKey(
    contextGraphId: string,
    agentAddress: string,
    requestGeneration: string,
  ): string {
    return `${contextGraphId}::${agentAddress.toLowerCase()}::${requestGeneration.toLowerCase()}`;
  }
  /**
   * Remembers the libp2p peer ID that delivered each pending join request
   * to this curator. Keyed by context graph, agent, and signed request
   * generation so a delayed request cannot redirect a newer decision.
   *
   * This is the authoritative source when we later need to notify that
   * requester about approval/rejection — the agent registry can be stale
   * (a requester may P2P-reach us before their agent profile has indexed
   * locally), so without this map we'd drop notifications and leave the
   * invitee stuck on "Join request sent, awaiting approval". See
   * `notifyJoinApproval` / `notifyJoinRejection`.
   *
   * In-memory only: survives for the curator's process lifetime, which
   * matches the approval window in practice. On restart we fall back to
   * the agent registry.
   */
  protected readonly joinRequestOriginPeers = new Map<string, string>();
  /**
   * Requester-side hint: which local agent did WE pick when signing the
   * join-delegation for a given context graph?
   *
   * Used by `findLocalAgentForContextGraph` to bind sync envelopes to
   * the actually-approved agent in the brief window between
   * `join-approved` arriving and the curator's `_meta` graph being
   * synced into our local store. Without this hint, a multi-agent node
   * would fall back to `defaultAgentAddress` for the first
   * post-approval catch-up, the responder's per-agent delegation lookup
   * would miss the real claim, and sync would silently fail until the
   * next `_meta` round-trip propagated the allowlist.
   *
   * Populated in two places:
   *  1. `signJoinRequest` — the moment we sign for a CG, we know our
   *     intent. Single-agent nodes are a no-op here (the default IS the
   *     agent), but it's free to maintain.
   *  2. The `join-approved` handler — definitive: the curator just
   *     told us this exact agent was promoted. Survives sign-then-restart
   *     because the curator's notification re-establishes the hint.
   *
   * Lower-cased agent address. In-memory only — restart loses it, but
   * after restart the `_meta` allowlist will have been synced (it's the
   * very first thing post-approval), so the hint is no longer needed.
   * Keyed by raw `contextGraphId` (no normalisation needed — every
   * caller already has the canonical id).
   */
  protected readonly localApprovedAgentByCG = new Map<string, string>();
  /**
   * Symmetric companion to `joinRequestOriginPeers`, populated on the
   * REQUESTER side. Only the explicit invite-supplied curator is remembered
   * when it accepts (or durably queues) a request. We remember that peer so a
   * subsequent `join-approved` / `join-rejected` notification can be
   * authenticated against the exact signed request generation — without
   * requiring the requester
   * to have synced the CG's `_meta` graph (which is impossible by
   * definition: a curated CG denies meta sync until approval, and the
   * rejection notification is the one case where the request will
   * never be approved).
   *
   * Keyed identically (context graph, lower-cased agent, request generation).
   * Stored as a Set because the broadcast may legitimately reach
   * multiple curator nodes for the same CG (multi-curator deployments
   * are not yet a feature, but the data shape doesn't preclude them).
   *
   * Why this is the right authority surface: a peer that previously
   * accepted `{ok: true}` to a join request has already been trusted
   * with the request's authenticity; trusting them with the matching
   * decision is no expansion of attack surface. A peer that lied
   * about `ok: true` could already grief the requester by silently
   * dropping the request — letting them also forge a fake "rejected"
   * notification just collapses the same denial-of-service window
   * faster, never widens it.
   *
   * This remains a compatibility/diagnostic cache. The durable requester
   * join-state row is the primary authority and survives restarts; `_meta`
   * curator resolution is the final fallback for older rows.
   */
  protected readonly joinRequestAcceptedBy = new Map<string, Set<string>>();
  /**
   * Shared serialization lane for manual approvals, automatic admissions,
   * and policy changes. Keeping all three on the same per-CG queue makes a
   * switch back to `manual` linearizable with in-flight join requests.
   */
  protected readonly contextGraphJoinAdmissionLockManager = new ContextGraphJoinAdmissionLockManager();
  protected readonly contextGraphMembershipMutations = new ContextGraphMembershipMutationStore();
  /** In-memory ingress buckets; values are accepted request timestamps. */
  protected readonly contextGraphJoinIngressBuckets = new Map<string, number[]>();
  /** Active + queued incoming requests per CG (policy/admin operations excluded). */
  protected readonly contextGraphJoinIngressDepth = new Map<string, number>();
  protected contextGraphJoinIngressLastCleanupAt = 0;
  /**
   * Exact signed requests that crossed the membership mutation boundary but
   * still need status/audit repair. A short-lived marker lets Messenger retry
   * bypass its own just-consumed ingress token without weakening limits for a
   * different payload. The ordinary 60s buckets have expired when this does.
   */
  protected readonly contextGraphJoinAdmissionRepairDigests = new Map<string, {
    expiresAt: number;
    policyEpoch?: number;
  }>();
  /** Manual-policy requests waiting on the CG queue; checked by admissions. */
  protected readonly contextGraphJoinPolicyDisableIntentCounts = new Map<string, number>();
  /**
   * Per-peer timestamp of the last reconnect-on-gossip dial we attempted.
   * Prevents a noisy topic from generating a dial storm against a peer we
   * already tried recently. See DOC: p2p-resilience.md.
   */
  protected readonly gossipDialAttemptedAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the last catchup-on-connect we queued, to dedupe
   * connection:open events when the same peer briefly churns between
   * direct + relayed connections within a short window.
   */
  protected readonly catchupOnConnectAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the last time all live connections to that peer
   * were gone. Used to avoid suppressing reconnect catch-up with a
   * `lastSuccessfulSyncAt` value from before an offline gap.
   */
  protected readonly lastSyncDisconnectedAt = new Map<string, number>();
  /**
   * Peers whose most recent sync attempt found that their advertised
   * protocol list did NOT include `PROTOCOL_SYNC` — almost always a
   * libp2p identify race on the inbound side of `connection:open`,
   * not a real "this peer doesn't speak sync" answer. The `peer:update`
   * listener drains entries from this set the moment libp2p reports
   * an updated protocol list that contains `PROTOCOL_SYNC`, and the
   * periodic reconciler treats membership as a strong hint to retry.
   *
   * Entries are cleared on `connection:close` and after sync progress or a
   * clean denial-only response.
   */
  protected readonly skippedNoSyncPeers = new Set<string>();
  /**
   * Per-peer timestamp of the most recent successful run of sync-on-connect.
   * Driven by `runSyncOnConnect.onPeerSynced`. Used by the periodic
   * reconciler to skip peers that have already synced recently — the
   * staleness threshold is intentionally larger than the reconciler
   * interval so a single missed tick doesn't immediately retry every
   * connected peer.
   */
  protected readonly lastSuccessfulSyncAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the most recent sync-on-connect attempt that made
   * useful progress. This is split from `lastSuccessfulSyncAt` so partial
   * progress with a timeout clears peer-level backoff without marking the
   * peer fresh for reconnect suppression. Denial-only rounds intentionally do
   * not write this long-lived marker; ACL approval has no peer-update event,
   * so denied peers must remain eligible on the next reconciler cadence.
   */
  protected readonly lastSyncProgressAt = new Map<string, number>();
  /**
   * Per-peer sync-reconciler backoff. `failures` is the count of
   * consecutive reconciler attempts that did NOT produce a successful
   * sync; `nextRetryAt` is the epoch-ms before which the reconciler
   * skips this peer. Reset on useful progress or a clean denial-only response
   * (`onPeerSynced`) and pruned after stale disconnects. See
   * `SYNC_BACKOFF_BASE_MS`.
   */
  protected readonly syncReconcilerBackoff = new Map<string, SyncReconcilerBackoff>();
  protected syncReconcilerTimer: ReturnType<typeof setInterval> | null = null;
  /** A.4-lite+: periodic warm/pinned Core-connection reconcile (opt-in). */
  protected warmCoreTimer: ReturnType<typeof setInterval> | null = null;
  /** Cores keep-alive-pinned on the last warm-core pass, so the next pass can
   *  unpin Cores that fell out of the selection (stale-pin / cap-drift guard). */
  protected warmedCores: Set<string> = new Set();
  /** Stale warm-core keep-alive removals that failed and should be retried. */
  protected warmCoreFailedUnpins: Set<string> = new Set();
  /**
   * v10-rc sync-refactor: per-(peer+CG) checkpoint offsets so the paged
   * sync requester in `sync/requester/page-fetch.ts` can resume where it
   * left off, and the worker-hosted verify path (`sync-verify-worker.ts`)
   * can run CPU-bound hash checks off the main thread. Both introduced
   * by PR #237 (sync-refactor-rebased).
   */
  protected syncCheckpoints: SyncCheckpointStore = new MemorySyncCheckpointStore();
  protected changelogCursors: ChangelogCursorStore = new MemoryChangelogCursorStore();
  protected syncVerifyWorker?: SyncVerifyWorker;

  /** Registered agents on this node: agentAddress → AgentKeyRecord */
  protected readonly localAgents = new Map<string, AgentKeyRecord>();
  /** Agent token → agentAddress lookup for Bearer-based agent resolution */
  protected readonly agentTokenIndex = new Map<string, string>();
  /** The default "owner" agent address (first operational wallet, auto-registered on boot) */
  protected defaultAgentAddress: string | undefined;
  protected readonly swmSenderKeySendStates = new Map<string, LocalSwmSenderKeySendState>();
  protected readonly swmSenderKeyReceiveStates = new Map<string, LocalSwmSenderKeyReceiveState>();
  protected swmSenderKeyStateLoaded = false;
  /**
   * PR-2 (SWM-fanout plan): pending sender-key package fanouts that
   * landed in the "no advertised peerId" branch of
   * `createAndDistributeSwmSenderKeyEpoch`. Keyed by lowercased
   * `recipientAgentAddress` so the connection:open listener can drain
   * by agent identity (the only handle we have when we minted the row
   * without a peerId). Per-key triple `(senderAgentAddress,
   * recipientKeyId, epochId)` deduplicates within an agent.
   *
   * Persisted with the SWM sender-key state file when `dataDir` is
   * configured. Older epochs are evicted whenever a newer epoch is
   * enqueued for the same `(sender, recipient)` pair — the supersession
   * matches what the membership-hash flow already implies sender-side,
   * and avoids the "queued package for epoch N replays after we've
   * rolled to N+1" footgun.
  */
  protected readonly pendingSenderKeyByAgent = new Map<string, PendingSenderKeyEntry[]>();
  protected readonly pendingSenderKeyDrainByAgent = new Map<string, Promise<number>>();
  /** Per-CG serialized host-mode persistence queue (moved here from the host-mode cluster during the mixin split). */
  protected readonly hostModePersistenceQueues = new Map<string, Promise<void>>();
  /** System graph holding agent-registry triples (moved here so holder classes can reference it). */
  static readonly AGENT_SYSTEM_GRAPH = 'did:dkg:system/agents';
  /** Pending chat handler/ACL captured before the messenger is wired (moved here during the mixin split). */
  protected _pendingChatHandler: ChatHandler | null = null;
  protected _pendingChatAcl: ChatAclCheck | null = null;
  /** GH #462 — pending skill ACL captured before the messenger is wired. */
  protected _pendingSkillAcl: SkillAclCheck | null = null;

  protected constructor(
    config: ResolvedDKGAgentConfig,
    wallet: DKGAgentWallet,
    node: DKGNode,
    store: TripleStore,
    publisher: DKGPublisher,
    queryEngine: DKGQueryEngine,
    eventBus: TypedEventBus,
    chain: ChainAdapter,
    workspaceOwnedEntities: Map<string, Map<string, string>>,
    writeLocks: Map<string, Promise<void>>,
    publicSnapshotStore?: WorkspacePublicSnapshotStore,
  ) {
    this.config = config;
    this.wallet = wallet;
    this.node = node;
    this.store = store;
    this.contextGraphMetaProjection = new ContextGraphMetaProjection(store);
    this.publisher = publisher;
    this.queryEngine = queryEngine;
    this.workspaceOwnedEntities = workspaceOwnedEntities;
    this.writeLocks = writeLocks;
    this.publicSnapshotStore = publicSnapshotStore;
    this.eventBus = eventBus;
    this.chain = chain;
    // OT-RFC-43 A2 — retain the allocator so finalize can allocate-at-finalize
    // (the publisher gets the same instance as `kaAllocator`).
    this.kaNumberAllocator = config.kaNumberAllocator;
    this.discovery = new DiscoveryClient(queryEngine);
    this.profileManager = new ProfileManager(publisher, store);
    this.networkAdmissionCoordinator = new NetworkAdmissionCoordinator({
      admission: this.networkAdmission,
      selfPeerId: '',
      sign: (payload) => wallet.sign(payload),
      sendIdentityProbe: async () => {
        throw new Error('network admission coordinator is not started');
      },
      getConnections: () => [],
      deletePeerFromPeerStore: async () => {},
    });
    this.publisher.setWorkspaceAgentRecipientResolver((input) => (this as unknown as DKGAgent).resolveWorkspaceRecipientsGated(input));
    this.publisher.setWorkspaceSenderKeyEncryptor((input) => (this as unknown as DKGAgent).encryptWorkspacePayloadWithSenderKey(input));
    this.syncCheckpoints = config.syncCheckpointStore ?? this.syncCheckpoints;
    this.changelogCursors = config.changelogCursorStore ?? this.changelogCursors;
  }

  /**
   * RpcUsageDrainable: drain the chain adapter's raw JSON-RPC usage window
   * (delta since the previous drain — the provider-billing unit). The
   * adapter capability is optional; an adapter without it reports an empty
   * window here, so consumers never see the optionality. Keeps `chain`
   * protected instead of the daemon reaching through a cast.
   */
  drainRpcUsage(): RpcUsageWindow {
    return this.chain.drainRpcUsage?.() ?? emptyRpcUsageWindow();
  }
}
