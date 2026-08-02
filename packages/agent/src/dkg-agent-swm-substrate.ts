// SPDX-License-Identifier: Apache-2.0

/**
 * SWM substrate / shared-memory subsystem extracted from dkg-agent.ts as a
 * mixin holder: CG gossip subscription reconcile, SWM share-ACK handling and
 * quorum tracking, substrate top-up + fan-out bookkeeping/eviction, and the
 * lazily-constructed gossip/shared-memory/update/finalization handlers. 1:1
 * move; methods take `this: DKGAgent` so cross-calls resolve against the
 * composed class.
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
  Logger, createOperationContext, logKaLifecycleEvent, sparqlString, escapeSparqlLiteral, isSafeIri, assertSafeIri,
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
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
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
} from '@origintrail-official/dkg-publisher';
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
import {
  classifySwmFanoutPeerOutcome,
  createSwmFanoutPeerSelector,
  type SelectSwmFanoutPeersInput,
  type SelectSwmFanoutPeersResult,
  type SwmFanoutPeerOutcome,
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
  type DurableSyncDiagnostics,
  type SharedMemorySyncDiagnostics,
  type CatchupSyncDiagnostics,
  type DurableSyncResult,
  type SharedMemorySyncResult,
  type DKGAgentConfig,
  type ReplicationEvent,
} from './dkg-agent-types.js';
import { resolveContextGraphSyncMode } from './context-graph-subscription-policy.js';
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

export class SwmSubstrateMethods extends DKGAgentBase {
  subscribeToContextGraph(this: DKGAgent, contextGraphId: string, options?: {
    trackSyncScope?: boolean;
    persist?: boolean;
    deferSharedMemoryGossipSubscribe?: boolean;
    syncMode?: 'on-demand' | 'always-on';
  }): ContextGraphSub {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    const removedConfiguredAdmissionOverlay = options?.trackSyncScope !== false
      ? this.contextGraphSubscriptionDurableAdmissionOverrides.delete(contextGraphId)
      : false;
    const syncAdmission = options?.trackSyncScope === false
      ? existing?.syncAdmission ?? 'none'
      : 'explicit';
    this.reconcileContextGraphSyncAdmission(contextGraphId, {
      subscribed: true,
      admission: syncAdmission,
    });
    // Opening an already durable graph must never silently downgrade it to a
    // process-local subscription. An explicit always-on request may promote an
    // existing on-demand subscription, while an omitted mode preserves the
    // current lifetime (or the legacy always-on default for a new graph).
    const syncMode = resolveContextGraphSyncMode({
      existing,
      requested: options?.syncMode,
      hasDormantDurableIntent:
        this.contextGraphSubscriptionRehydrationStatus?.dormantIds.includes(contextGraphId) === true,
    });
    const persist = syncMode === 'on-demand' ? false : options?.persist;

    // SWM gossip subscribe runs `canReadContextGraph` against the local
    // `_meta` graph. On a fresh `join-approved` notification the curator
    // has just written the allowlist into ITS _meta, but the requesting
    // node hasn't synced that allowlist yet — so the very first SWM
    // gossip subscribe attempt fails with `local node is not authorized`,
    // emitting a misleading WARN. The real fix is to land the allowlist
    // first via `runImmediatePostApprovalSync`; once `_meta` syncs,
    // `refreshMetaSyncedFlags` re-queues the SWM gossip subscribe (line
    // 3738) and it succeeds silently. This option lets the join-approved
    // path opt out of the immediate SWM subscribe and rely on that
    // self-heal — see urn:dkg:finding:swm-gap-1-initial-sync-race.
    const deferSwmGossip = options?.deferSharedMemoryGossipSubscribe === true;

    // Idempotent: skip if gossip handlers already installed for this context graph.
    if (this.gossipRegistered.has(contextGraphId)) {
      if (!deferSwmGossip) {
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
      if (
        !existing?.subscribed
        || existing.syncMode !== syncMode
        || existing.syncAdmission !== syncAdmission
        || removedConfiguredAdmissionOverlay
      ) {
        return this.setContextGraphSubscription(
          contextGraphId,
          {
            ...existing,
            subscribed: true,
            synced: existing?.synced ?? false,
            syncMode,
            syncAdmission,
          },
          { persist },
        );
      }
      return existing;
    }
    this.gossipRegistered.add(contextGraphId);

    const publishTopic = contextGraphPublishTopic(contextGraphId);
    const appTopic = contextGraphAppTopic(contextGraphId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(appTopic);

    const subscription = this.setContextGraphSubscription(
      contextGraphId,
      {
        ...existing,
        subscribed: true,
        synced: existing?.synced ?? false,
        syncMode,
        syncAdmission,
      },
      { persist },
    );

    this.gossip.onMessage(publishTopic, async (_topic, data, from) => {
      const gph = this.getOrCreateGossipPublishHandler();
      await gph.handlePublishMessage(data, contextGraphId, undefined, from);
    });

    if (!deferSwmGossip) {
      this.queueSharedMemoryGossipSubscription(contextGraphId);
    }

    const updateTopic = contextGraphUpdateTopic(contextGraphId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const uh = this.getOrCreateUpdateHandler();
      await uh.handle(data, from);
    });

    const finalizationTopic = contextGraphFinalizationTopic(contextGraphId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data, from) => {
      const fh = this.getOrCreateFinalizationHandler();
      await fh.handleFinalizationMessage(data, contextGraphId, from);
    });

    return subscription;
  }

  /**
   * Inverse of {@link subscribeToContextGraph}: drop the LIVE member
   * subscription (publish / app / update / finalization + member-mode SWM
   * gossip, and the sync scope) while preserving any `coreHosted` hosting
   * obligation. After this the node no longer receives the finalization
   * gossip fast-path, so a publish it misses can ONLY be recovered through
   * the chain-driven `coreHosted` reconcile sweep — which is exactly the
   * Phase D path. The persisted subscription row survives iff `coreHosted`
   * (see {@link persistContextGraphSubscription}), so the host-only state
   * (`subscribed=0, coreHosted=1`) is restart-safe.
   *
   * This is intentionally NOT a destructive teardown: it deletes no VM/SWM
   * data and leaves SWM host-mode hosting intact (re-evaluated below). Its
   * primary use is to manufacture a pure host-only core for validation on a
   * devnet where storage cores otherwise auto-subscribe to everything they
   * host, masking the host-only fill path.
   */
  unsubscribeFromContextGraph(this: DKGAgent,
    contextGraphId: string,
    options?: { persist?: boolean; updateRehydrationStatus?: boolean },
  ): void {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    if (!existing) return;
    this.contextGraphSubscriptionDurableAdmissionOverrides.delete(contextGraphId);

    // Drop every sync-admission lane through the canonical owner.
    this.reconcileContextGraphSyncAdmission(contextGraphId, {
      subscribed: false,
      admission: 'none',
    });

    // Tear down the per-CG gossip topics. These four carry only the member
    // handlers installed by `subscribeToContextGraph`, so a topic-wide
    // `unsubscribe` is safe here (unlike the SWM topic, handled separately).
    if (this.gossipRegistered.has(contextGraphId)) {
      for (const topic of [
        contextGraphPublishTopic(contextGraphId),
        contextGraphAppTopic(contextGraphId),
        contextGraphUpdateTopic(contextGraphId),
        contextGraphFinalizationTopic(contextGraphId),
      ]) {
        try { this.gossip.unsubscribe(topic); } catch { /* best-effort */ }
      }
      this.gossipRegistered.delete(contextGraphId);
    }

    // Tear down member-mode SWM gossip. `gossip.unsubscribe` drops every
    // handler on the topic (incl. any host-mode listener), so we clear the
    // host-mode bookkeeping too and then let `reconcileSwmHostModeSubscription`
    // re-wire the host listener if hosting is still applicable (no-op on edges
    // and on cores with swmHostMode disabled).
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      try { this.gossip.unsubscribe(swmTopic); } catch { /* best-effort */ }
      this.sharedMemoryGossipRegistered.delete(contextGraphId);
      const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
      this.swmHostModeSubscribed.delete(hostKey);
      this.swmHostModeCurated.delete(hostKey);
      this.swmHostModeHandlers.delete(hostKey);
      this.enqueueHostModePersistence(contextGraphId, false);
    }

    // Flip the live-subscription flag off, keeping `coreHosted` (and every
    // other field) intact. Persisted: the row is kept iff `coreHosted`.
    this.setContextGraphSubscription(
      contextGraphId,
      { ...existing, subscribed: false, syncAdmission: 'none' },
      { persist: options?.persist ?? true, updateRehydrationStatus: options?.updateRehydrationStatus },
    );

    void this.reconcileSwmHostModeSubscription(contextGraphId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `SWM host-mode re-eval after unsubscribe from "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    this.log.info(
      createOperationContext('system'),
      `Unsubscribed from "${contextGraphId}" (coreHosted=${existing.coreHosted === true}); live gossip dropped, chain reconcile path retained if hosting`,
    );
  }

  queueSharedMemoryGossipSubscription(this: DKGAgent, contextGraphId: string): void {
    void this.reconcileSharedMemoryGossipSubscription(contextGraphId).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `SWM gossip subscription check failed for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async reconcileSharedMemoryGossipSubscription(this: DKGAgent, contextGraphId: string): Promise<void> {
    // Reconcile is the membership boundary; rebuild this CG's policy view
    // before deciding whether to keep or drop the SWM subscription.
    this.contextGraphMetaProjection.markDirty(contextGraphId);
    // OT-RFC-38 / LU-6 Phase B — subscribe on the wire-form (hash) topic.
    // Members compute the hash from their local cleartext id via
    // {@link gossipWireIdFor}; cores hosting CGs they never joined
    // already have the hash AS their local id (chain-event auto-
    // subscribe / discovery-beacon path), so `gossipWireIdFor` is the
    // identity for them.
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    const isRegistered = this.sharedMemoryGossipRegistered.has(contextGraphId);
    const ctx = createOperationContext('system');
    if (!(await this.canUseSharedMemoryForContextGraph(contextGraphId))) {
      if (isRegistered) {
        // `gossip.unsubscribe()` drops EVERY handler on the topic,
        // not just the member-mode one. If this core was already
        // hosting the curated SWM in HOST MODE (LU-6), losing
        // member authorisation here would also kill the host
        // listener, and `swmHostModeSubscribed` would still be set
        // — making `reconcileSwmHostModeSubscription()` early-
        // return on the next pass and stranding the hosting state
        // until restart (Codex PR #610 R1 comment 4).
        //
        // We work around the topic-wide unsubscribe by clearing
        // host-mode bookkeeping (handler ref + subscribed flag)
        // here so the immediate `reconcileSwmHostModeSubscription()`
        // call below will re-wire the host listener if host mode
        // is still applicable.
        //
        // Codex PR #620 follow-up: the in-memory deletes above are
        // not enough — the persisted `hostModeSubscribed=true` flag
        // would survive restart and the B3 startup-restore loop
        // (`initializeSwmHostModeStore`) would re-subscribe a CG
        // this node has just been told it's no longer authorized
        // for. Enqueue a persistence=false write here so the
        // `.meta` reflects the same teardown as the in-memory
        // maps. If the immediate `reconcileSwmHostModeSubscription`
        // below decides host mode IS still applicable, it'll
        // re-engage via `wireSwmHostModeHandler` → enqueue
        // persistence=true again. The per-CG queue
        // (`enqueueHostModePersistence`) serialises the pair so the
        // final on-disk state always matches the final in-memory
        // intent — no possible interleave where the "false" lands
        // after a later "true" and re-subscribes on next boot.
        this.gossip.unsubscribe(swmTopic);
        this.sharedMemoryGossipRegistered.delete(contextGraphId);
        // Host-mode maps are canonical-keyed (wire-form hash); delete
        // by canonical id so this cleanup hits the entry regardless
        // of which discovery path wired it. Without this, the
        // immediate `reconcileSwmHostModeSubscription()` call below
        // would see a stale entry and early-return.
        const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
        this.swmHostModeSubscribed.delete(hostKey);
        this.swmHostModeCurated.delete(hostKey);
        this.swmHostModeHandlers.delete(hostKey);
        this.enqueueHostModePersistence(contextGraphId, false);
        this.log.warn(ctx, `SWM gossip unsubscribed for "${contextGraphId}": local node is no longer authorized`);
      } else {
        this.log.warn(ctx, `SWM gossip subscription denied for "${contextGraphId}": local node is not authorized`);
      }
      // OT-RFC-38 LU-6: even if the local node is not a CG member,
      // a CORE node may still serve as a ciphertext host for the
      // curated SWM substrate. We delegate to the host-mode
      // reconciler — which is a no-op on edges and on cores when
      // the swmHostMode config is disabled.
      await this.reconcileSwmHostModeSubscription(contextGraphId);
      return;
    }

    if (isRegistered) return;

    // Codex PR #610 R3: if this core was previously hosting the
    // curated SWM in HOST MODE, member authorization now takes
    // over — apply-and-ack via the member handler replaces opaque
    // hosting. Surgically remove the host-mode handler (without
    // dropping every handler on the topic) so we don't double-
    // process every envelope (apply + opaque append).
    this.unwireSwmHostModeHandler(contextGraphId);

    this.sharedMemoryGossipRegistered.add(contextGraphId);
    this.gossip.subscribe(swmTopic);
    this.gossip.onMessage(swmTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateSharedMemoryHandler();
      const outcome = await wh.handle(data, from);
      // Emit SwmShareAck on gossip-applied shares so the
      // publisher's SwmAckQuorum can compute per-share delivery
      // quorum. PR-H bug 2 made this symmetric — `handleSwmUpdate`
      // emits one too on substrate-applied shares — so the
      // quorum sees the same ack signal regardless of which
      // transport delivered. A peer reachable via BOTH
      // transports may produce two acks (substrate bookkeeper
      // + this receiver ack); that's fine — `SwmAckQuorum.onAck`
      // dedups via `record.acked.has(fromPeerId)`.
      //
      // Best-effort throughout: missing metadata fields, failed
      // sendReliable, throws — all swallowed. The publisher's
      // watchdog will fire substrate top-up if the ack count
      // doesn't reach quorum, which makes the ack channel an
      // opportunistic fast-path rather than a correctness
      // requirement.
      if (!outcome.applied) return;
      this.maybeEmitSwmShareAck(outcome).catch(() => { /* swallowed; logged inside */ });
    });
  }

  /**
   * Receiver handler for `PROTOCOL_SWM_SHARE_ACK`. Extracted into
   * a named method (mirrors `handleSwmUpdate`'s shape) so the
   * spoof-rejection contract from PR-D codex follow-up #D2 can
   * be unit-tested in isolation without spinning up a real
   * Messenger registration. Always returns `new Uint8Array()`
   * at the wire level — senders don't read the response (acks
   * use fire-and-forget `sendToPeer` per #D1).
   */
  public async handleSwmShareAck(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    try {
      const ack = decodeSwmShareAck(data);
      // rc.9 PR-D codex follow-up #D2: authoritative ack identity
      // is the libp2p-authenticated `fromPeerId`, NOT the
      // self-asserted `ack.ackPeerId` in the protobuf body.
      // Pre-D2 we trusted the body, which let any peer that had
      // learned a `shareOperationId` spoof acks on behalf of
      // other expected members — suppressing watchdog top-up
      // for those members and degrading delivery quorum
      // reliability. The body's `ackPeerId` is kept on the wire
      // for forward-compat with a possible future relayed-ack
      // path (where `fromPeerId` would be a relay node, not the
      // original receiver), but in the current direct-Messenger
      // world we reject any non-empty mismatch as either a
      // misconfiguration or a spoof attempt.
      if (ack.ackPeerId && ack.ackPeerId !== fromPeerId) {
        this.log.warn(
          createOperationContext('share', ack.shareOperationId),
          `SWM share ack body/transport peerId mismatch — body=${ack.ackPeerId} transport=${fromPeerId} — dropping (potential spoof)`,
        );
        return new Uint8Array();
      }
      const quorum = this.getOrCreateSwmAckQuorum();
      const record = quorum.inspect(ack.shareOperationId);
      if (record?.enumerationSource === 'topic-subscribers') {
        this.recordSwmFanoutPeerOutcome(record.cgId, fromPeerId, 'good');
      }
      quorum.onAck(ack.shareOperationId, fromPeerId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('share'),
        `SWM share ack decode failed from ${fromPeerId}: ${reason}`,
      );
    }
    return new Uint8Array();
  }

  /**
   * Test-only view onto {@link handleSwmShareAck} for the PR-D
   * codex follow-up #D2 regression. Production traffic invokes
   * the same handler via the `messenger.register()` callback
   * registered in {@link initialize}; tests need the same
   * arrow-function shape without having to intercept the
   * register call (which happens before the test can install
   * its messenger stub). Not part of the public API; method
   * exists purely to make the spoof-rejection contract testable.
   */
  async getOrCreateSwmShareAckHandlerForTests(this: DKGAgent): Promise<(data: Uint8Array, from: string) => Promise<Uint8Array>> {
    return (data, from) => this.handleSwmShareAck(data, from);
  }

  /**
   * Test-only inspector for SwmAckQuorum's tracked-record
   * snapshot, exposed so integration tests can assert on the
   * `acked` / `expectedMembers` after driving ack arrivals
   * through `handleSwmShareAck`. Returns `undefined` for
   * unknown shareOperationIds (matches the underlying
   * component's `inspect()` contract — once a record completes
   * quorum or expires, it's reaped). Not part of the public
   * API surface; the production caller talks to the quorum
   * directly via `getOrCreateSwmAckQuorum()`.
   */
  getSwmAckQuorumRecordSnapshotForTests(this: DKGAgent, shareOperationId: string): {
    acked: readonly string[];
    expectedMembers: readonly string[];
    ackPct: number;
  } | undefined {
    return this.swmAckQuorum?.inspect(shareOperationId);
  }

  getOrCreateSwmFanoutPeerSelector(this: DKGAgent): SwmFanoutPeerSelector {
    if (!this.swmFanoutPeerSelector) {
      this.swmFanoutPeerSelector = createSwmFanoutPeerSelector();
    }
    return this.swmFanoutPeerSelector;
  }

  selectSwmFanoutPeersForActiveShare(this: DKGAgent, input: SelectSwmFanoutPeersInput): SelectSwmFanoutPeersResult {
    return this.getOrCreateSwmFanoutPeerSelector().select(input);
  }

  recordSwmFanoutPeerOutcome(
    this: DKGAgent,
    contextGraphId: string,
    peerId: string,
    outcome: SwmFanoutPeerOutcome,
  ): void {
    this.getOrCreateSwmFanoutPeerSelector().record(contextGraphId, peerId, outcome);
  }

  recordSwmFanoutPeerRecord(this: DKGAgent, contextGraphId: string, record: FanOutPeerRecord): void {
    this.recordSwmFanoutPeerOutcome(
      contextGraphId,
      record.peerId,
      classifySwmFanoutPeerOutcome(record),
    );
  }

  getSwmFanoutPeerOutcomeForTests(this: DKGAgent, contextGraphId: string, peerId: string, now?: number): SwmFanoutPeerOutcome | undefined {
    return this.swmFanoutPeerSelector?.get(contextGraphId, peerId, now);
  }

  /**
   * Best-effort send of `PROTOCOL_SWM_SHARE_ACK` to the share's
   * publisher peer after a successful gossip-path apply.
   * Extracted into a named method so the receiver contract can
   * be unit-tested in isolation without spinning up a real
   * GossipSub subscription.
   *
   * Self-acks are filtered: if the publisher peerId equals our
   * own (we both published AND happened to receive our own
   * gossip back via the mesh — rare but possible), we skip the
   * send because the publisher-side track() already counts the
   * local apply via the substrate pre-acked set / never enters
   * the watchdog branch.
   */
  public async maybeEmitSwmShareAck(this: DKGAgent, outcome: {
    applied: true;
    assetUal?: string;
    cgId?: string;
    shareOperationId?: string;
    publisherPeerId?: string;
  }): Promise<void> {
    const { assetUal, cgId, shareOperationId, publisherPeerId } = outcome;
    if (!shareOperationId || !publisherPeerId) return;
    let selfPeerId: string;
    try {
      selfPeerId = this.peerId;
    } catch {
      return;
    }
    if (publisherPeerId === selfPeerId) return;

    const ackBytes = encodeSwmShareAck({ shareOperationId, ackPeerId: selfPeerId });
    const ackCtx = createOperationContext('share', shareOperationId);
    // rc.9 PR-D codex follow-up #D1: use fire-and-forget
    // `sendToPeer` instead of durable `sendReliable`. Pre-D1
    // the ack went through the substrate outbox — but
    // PROTOCOL_SWM_SHARE_ACK is a new rc.9-PR-D-only protocol,
    // and during a rolling upgrade the publisher peer may not
    // have it registered yet. A `sendReliable` to an
    // unsupported protocol enqueues into the outbox and retries
    // forever on protocol negotiation, accumulating a permanent
    // queued row per received share. By contrast `sendToPeer`
    // just delegates to `ProtocolRouter.send`: one network
    // attempt, no envelope, no idempotency cache, no outbox row.
    // On any failure (peer offline, protocol unsupported,
    // stream reset) we WARN and drop — that's the right
    // semantic anyway since acks are pure observability: a
    // missed ack just means the watchdog will eventually fire
    // substrate top-up, which the receiver dedups via
    // `seenShareOps`. Losing an ack is recoverable; persisting
    // a doomed retry forever is not.
    try {
      await this.messenger.sendToPeer(publisherPeerId, PROTOCOL_SWM_SHARE_ACK, ackBytes, {
        timeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS,
      });
      if (assetUal) {
        logKaLifecycleEvent(this.log, ackCtx, {
          assetUal,
          stage: 'swm_share',
          event: 'swm_share_ack_sent',
          role: 'receiver',
          localPeerId: selfPeerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: publisherPeerId,
          metadata: {
            contextGraphId: cgId,
            shareOperationId,
            outcome: 'sent',
          },
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (assetUal) {
        logKaLifecycleEvent(this.log, ackCtx, {
          assetUal,
          stage: 'swm_share',
          event: 'swm_share_ack_failed',
          role: 'receiver',
          localPeerId: selfPeerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: publisherPeerId,
          level: 'warn',
          metadata: {
            contextGraphId: cgId,
            shareOperationId,
            outcome: 'failed',
            reason,
          },
        });
      }
      this.log.warn(
        ackCtx,
        `SWM share ack to ${publisherPeerId} failed (best-effort, watchdog will retry the share if quorum slips): ${reason}`,
      );
    }
  }

  /**
   * Add a context graph to runtime sync scope so sync-on-connect includes it.
   * System context graphs are already included by default and are skipped here.
   */
  public trackSyncContextGraph(this: DKGAgent, contextGraphId: string): boolean {
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]);
    if (systemContextGraphs.has(contextGraphId)) return false;

    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.has(contextGraphId)) return false;
    syncSet.add(contextGraphId);
    this.config.syncContextGraphs = [...syncSet];
    return true;
  }

  getOrCreateGossipPublishHandler(this: DKGAgent): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedContextGraphs,
        {
          contextGraphExists: (id) => this.contextGraphExists(id),
          // Gossip validation compares `approvedBy`/`revokedBy` against the
          // contextGraph owner. Those triples are emitted with `dkg:creator` (peer
          // DID) so peers validate against the same creator-scoped DID.
          // `dkg:curator` (wallet DID) is for local authorization only.
          getContextGraphOwner: (id) => this.getContextGraphCreator(id),
          setContextGraphSubscription: (id, next, options) => this.setContextGraphSubscription(id, next, options),
          recordDiscoveredContextGraph: (id, next) => { this.recordDiscoveredContextGraph(id, next); },
          hasConfirmedMetaState: (id) => this.hasConfirmedMetaState(id),
          getCgMeta: (id) => this.getCgMeta(id),
          getContextGraphOnChainId: (id) => this.getContextGraphOnChainId(id),
          markCgMetaDirtyFromQuads: (quads) => { this.contextGraphMetaProjection.markDirtyFromQuads(quads); },
          persistContextGraphSubscription: (id) => this.persistContextGraphSubscriptionState(id),
        },
        { requireContextGraphSubscriptionSetter: true },
      );
    }
    return this.gossipPublishHandler;
  }

  getOrCreateSharedMemoryHandler(this: DKGAgent): InstanceType<typeof SharedMemoryHandler> {
    if (!this.sharedMemoryHandler) {
      this.sharedMemoryHandler = new SharedMemoryHandler(this.store, this.eventBus, {
        sharedMemoryOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
        localAgentAddresses: () => [...this.localAgents.keys()],
        contextGraphMetaOracle: (cgId: string) => this.getCgMeta(cgId),
        // Same live on-chain predicate the SENDER uses to decide plaintext vs
        // encrypted SWM (`resolveWorkspaceRecipientsGated`). Wiring it here
        // keeps both sides of the wire on one authority. Without it the
        // receiver judged from local allowedAgent/participantAgent triples and
        // permanently dropped the plaintext writes the sender is supposed to
        // send on a public CG — silently breaking member->curator SWM shares on
        // every public/curated context graph.
        publicAccessPolicyOnChainOracle: (cgId: string) =>
          this.isContextGraphPublicOnChain(cgId, createOperationContext('share')),
        markContextGraphMetaDirtyFromQuads: (quads) => { this.contextGraphMetaProjection.markDirtyFromQuads(quads); },
        // OT-RFC-38 / LU-6 Phase B: chain-backed agent-allowlist
        // fallback. Cores hosting curated CGs they are NOT members
        // of have no local meta for the allowlist — without this,
        // every host-mode envelope fails verification with "no
        // agent allowlist on context graph" and the LU-6 substrate
        // collapses for any CG the hosting core didn't itself
        // create or join. See `resolveOnChainParticipantAgents`.
        chainAgentGateOracle: (cgId: string) => this.resolveOnChainParticipantAgents(cgId),
        // OT-RFC-38 / LU-6 Phase B — final fallback when chain has no
        // answer yet. Looks up the curator EOA the local node pinned
        // from this CG's discovery beacon. Hits during the pre-reg
        // and chain-event-race windows where the chain oracle is cold
        // but a valid beacon has already verified the curator's
        // signature, so admitting envelopes signed by that EOA is
        // safe. See `resolveBeaconPinnedCuratorEoa`.
        beaconCuratorOracle: (cgId: string) => this.resolveBeaconPinnedCuratorEoa(cgId),
        workspaceRecipientPrivateKeys: () => this.getLocalWorkspaceRecipientPrivateKeys(),
        workspaceSenderKeyDecryptor: (message: SwmSenderKeyMessageMsg, contextGraphId: string, ctx: OperationContext) =>
          this.decryptWorkspacePayloadWithSenderKey(message, contextGraphId, ctx),
        lifecycleLogOptions: {
          localPeerId: () => this.peerId,
          localNodeIdentityId: () => this.identityId.toString(),
        },
        publicSnapshotStore: this.publicSnapshotStore,
      });
    }
    return this.sharedMemoryHandler;
  }

  /**
   * Lazy single-instance CGMemberEnumerator. The enumerator owns
   * a 60s membership cache so a burst of N shares to the same CG
   * within the window pays one SPARQL query + one
   * `getSubscribers` call total, not N.
   *
   * Deps are bound here to:
   *  - `getContextGraphAllowedPeers` — the same accessor
   *    `authorizePrivateSyncRequest` uses; returns null for CGs
   *    with no `DKG_ALLOWED_PEER` allowlist triples (curated by
   *    peer-allowlist returns the array; agent-gated returns
   *    null, then `isPrivateContextGraph` discriminates).
   *  - `isPrivateContextGraph` — closes the agent-gated-CG
   *    misclassification hole (codex review on #571 bug #1): a CG
   *    private via `DKG_ALLOWED_AGENT` without `DKG_ALLOWED_PEER`
   *    falls into `source: 'none'` (fail closed) instead of
   *    falling through to live topic subscribers.
   *  - `getTopicSubscribers` — wrapping `GossipSubManager`'s
   *    PR-B-added subscriber-snapshot accessor (best-effort, may
   *    lag by one heartbeat interval; documented in
   *    GossipSubManager.getSubscribers).
   *  - `getSelfPeerId` — never fan out to ourselves; the local apply
   *    already happened in the caller of `publishWorkspaceGossip`.
   *    Passed as a thunk (not the resolved string) because
   *    `this.peerId` throws `DKGNode not started` before libp2p has
   *    booted — eagerly capturing it here would break pre-start
   *    `share()` callers (PR-C codex R8). The thunk lets any throw
   *    bubble out of `enumerate()`, where the R1 try/catch in
   *    `publishWorkspaceGossip` rescues into the gossip-only path.
   */
  /**
   * Liveness predicate for the SUBSTRATE TARGET subset of an
   * enumerated CG. Returns true iff `sendReliable` has a
   * realistic chance of putting bytes on the wire to this peer.
   *
   * **Reachability MUST match what `sendReliable` actually tries**
   * (codex RED #1 on #584). The router's send path consults
   * `libp2p.getConnections` (live) AND `libp2p.peerStore` (cached
   * addresses for dial). Filtering only on `getPeers()` would
   * silently drop legitimate substrate targets that we briefly
   * disconnected from but still have addresses for. We
   * OR-combine the two sources to mirror the send path:
   * connected OR peerStore-known.
   *
   * PeerId hygiene (codex RED #4 on #584 round 2):
   * `libp2p.peerStore.get` requires a `PeerId` object, NOT a
   * string. A type-cast call throws on the disconnected-but-
   * known path in the real libp2p API, which would make this
   * predicate return false for peers we DO have cached addresses
   * for — dropping legitimate substrate targets. We parse with
   * `peerIdFromString` first; on parse failure (malformed
   * gossipsub entry) the catch returns false (safe drop).
   *
   * Pre-start: if libp2p hasn't booted, `getPeers()` throws →
   * caught → return false → substrate target set is empty →
   * substrate fan-out is a no-op (gossip still runs). The
   * pre-start GossipSub subscriber list is normally empty anyway.
   *
   * Single source of truth: this method is consumed BOTH by the
   * CG enumerator (filters topic-subscribers to populate
   * `substrateEligibleMembers`) AND by `swmSubstrateTopUp` (re-
   * filters watchdog missingPeers so the top-up doesn't keep
   * blasting ghost peers that ackQuorum legitimately tracks but
   * substrate can't reach). PR-J round 2 introduces the second
   * use to close the watchdog leg of the same soak bug — without
   * it, the queued counter would inflate once per 30s tick
   * instead of once per share.
   */
  async isPeerDialable(this: DKGAgent, peerId: string): Promise<boolean> {
    try {
      // Test-stub fast path: short peer ids like '12D3KooWPeerA'
      // don't pass libp2p's base58 length check in
      // peerIdFromString. Preserve pre-PR-K
      // "connected ⇒ dialable" semantics for them so existing
      // integration tests that stub gossip subscribers with
      // these short ids keep working.
      const { peerIdFromString } = await import('@libp2p/peer-id');
      let pid: ReturnType<typeof peerIdFromString>;
      try {
        pid = peerIdFromString(peerId);
      } catch {
        return this.node.libp2p.getPeers().some((p) => p.toString() === peerId);
      }

      // PR-K filter tier 1: connectivity. Reject peers whose
      // ONLY live connections are *limited* Circuit Relay V2
      // reservations. Limited reservations cap data (~128 KiB)
      // and duration (~2 min) per stream; the aggressive
      // per-cycle traffic of SWM substrate fan-out exhausts
      // these caps almost immediately, after which every
      // `messenger.sendReliable` hits a stream-reset / aborted
      // error that `isRecoverableSendError` (correctly)
      // classifies as recoverable. The outbox queues + retries
      // forever, each retry eating fresh budget — a death
      // spiral the 2026-05-18 Miles<->Lex soak surfaced as
      // `swm-update: d=0 q=2031` after ~60 cycles, with both
      // peers behind NAT and connected only via limited relays.
      const conns = this.node.libp2p.getConnections(pid);
      if (conns.length > 0) {
        const hasNonLimited = conns.some((c) => !((c as unknown as { limits?: unknown }).limits));
        if (!hasNonLimited) return false;
      } else {
        // No live connection — fall back to peerStore-cached
        // addresses. A future dial may yield a non-limited
        // path; if it doesn't, the next isPeerDialable call
        // catches it via the connected branch above.
        const peerForAddrs = await this.node.libp2p.peerStore.get(pid);
        if ((peerForAddrs?.addresses?.length ?? 0) === 0) return false;
      }

      // PR-K filter tier 2: protocol support. The substrate
      // fan-out specifically uses `/dkg/10.0.1/swm-update`. rc8
      // beacon relays subscribe to gossip topics (they
      // participate in the mesh-forwarding to deliver shares)
      // but they don't register a handler for the rc9-only
      // `/dkg/10.0.1/swm-update` protocol — sendReliable to
      // them errors with `"Protocol selection failed - could
      // not negotiate /dkg/10.0.1/swm-update"`, which
      // `isRecoverableSendError` matches via the
      // `"could not negotiate"` substring and queues for
      // perpetual retry. (The classifier rule itself is
      // correct for transient connection-warmup negotiation
      // failures; pre-filtering at enumeration is the
      // surgical fix.)
      //
      // Surfaced by the PR-K verification soak (2026-05-18,
      // post-restart with PR-K tier 1 only): all 4 queued
      // sends in the first cycle were to Hetzner beacon
      // relays (12D3KooW...mkauaijsNrWw etc), each erroring
      // with "could not negotiate". The relays themselves
      // are direct TCP connections (NOT limited circuits) so
      // tier 1 doesn't catch them.
      try {
        const peer = await this.node.libp2p.peerStore.get(pid);
        const protos = peer?.protocols ?? [];
        if (!protos.includes(PROTOCOL_SWM_UPDATE)) return false;
      } catch {
        // peerStore.get can throw on cold-cache miss for a
        // peer we've just learned about via peer-exchange. Be
        // conservative: if we can't confirm protocol support,
        // skip substrate fan-out for them this round. The next
        // isPeerDialable call (after the next peerStore
        // identify exchange) will succeed if they speak it.
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  getOrCreateCGMemberEnumerator(this: DKGAgent): CGMemberEnumerator {
    if (!this.cgMemberEnumerator) {
      this.cgMemberEnumerator = createCGMemberEnumerator({
        getContextGraphAllowedPeers: (cgId) => this.getContextGraphAllowedPeers(cgId),
        isPrivateContextGraph: (cgId) => this.isPrivateContextGraph(cgId),
        getTopicSubscribers: (topic) => this.gossip.getSubscribers(topic),
        // OT-RFC-38 / LU-6 Phase B — substrate caller passes the local
        // cleartext id; resolver derives the wire-form topic for the
        // peer-subscriber probe so the substrate doesn't query the
        // wrong topic and conclude a CG has no gossip subscribers.
        topicForCG: (cgId) => contextGraphWorkspaceTopic(this.gossipWireIdFor(cgId)),
        getSelfPeerId: () => this.peerId,
        // PR-J liveness filter: marks the substrate target subset
        // (NOT `members`/`enumeratedMembers`) so the substrate
        // fan-out doesn't waste sends on peers we have no
        // addressing for. Bug fix for the 2026-05-18 Miles<->Lex
        // soak where 3-of-4 enumerated public-CG subscribers were
        // ghosts (peer-exchange residue) and every substrate send
        // queued forever.
        //
        // **Reachability MUST match what `sendReliable` actually
        // tries** (codex RED #1 on #584 round 1). The router's
        // send path consults libp2p.getConnections (live) AND
        // libp2p.peerStore (cached addresses for dial). Filtering
        // only on `getPeers()` would silently drop legitimate
        // substrate targets that we briefly disconnected from but
        // still have addresses for. We OR-combine the two sources
        // to mirror the send path: connected OR peerStore-known.
        //
        // PeerId hygiene (codex RED #4 on #584 round 2):
        // libp2p.peerStore.get requires a `PeerId` object, NOT a
        // string. The pre-fix cast threw on the disconnected-but-
        // known path (real libp2p) and silently returned `false`,
        // making the filter drop legitimate subscribers that
        // SHOULD have been dialable. Parse with `peerIdFromString`
        // first; on parse failure (malformed gossipsub entry)
        // fall through to the catch → false → safe drop.
        //
        // Pre-start: if libp2p hasn't booted, `getPeers()` throws
        // → caught → return false → substrate target subset
        // becomes empty for this CG → substrate fan-out is a
        // no-op (gossip leg still runs). The pre-start GossipSub
        // subscriber list is normally empty anyway since we
        // haven't joined the mesh yet, so this path is rare in
        // practice.
        isPeerDialable: (peerId) => this.isPeerDialable(peerId),
      });
    }
    return this.cgMemberEnumerator;
  }

  /**
   * Lazy single-instance SwmAckQuorum (rc.9 PR-D). Constructs on
   * first share through `publishWorkspaceGossip` and lives for
   * the agent's lifetime. The 5s tick is wired here too — kept
   * inside the lazy constructor so an agent that never shares
   * pays no timer overhead.
   *
   * `substrateTopUp` callback is implemented inline against
   * `messenger.sendReliable(PROTOCOL_SWM_UPDATE, ...)` so the
   * watchdog re-fires through the exact same protocol PR-C's
   * substrate fan-out uses — receivers (`handleSwmUpdate`) are
   * idempotent on (cgId, shareOperationId), so a top-up arriving
   * for a peer that already got the gossip-leg is dedup'd
   * server-side via `seenShareOps`. Top-up uses Promise.allSettled
   * (mirrors `executeSubstrateFanOut`) so one slow peer doesn't
   * tail-latency the rest. Failures get swallowed — the substrate's
   * own outbox handles retry.
   */
  /**
   * Watchdog-driven substrate top-up for SwmAckQuorum.
   * Extracted into a named method (mirrors PR-C's
   * `handleSwmUpdate` / PR-D's `handleSwmShareAck` shape) so
   * the per-outcome classification contract from rc.9 PR-D
   * codex follow-up #D6 can be unit-tested in isolation
   * without driving real-time watchdog ticks.
   *
   * Per-peer outcomes (classified via the SAME
   * `classifySendResult` the main fan-out uses):
   *   - `delivered` → call `swmAckQuorum.onAck` so the peer
   *     counts toward quorum. PROTOCOL_SWM_UPDATE does NOT
   *     emit `PROTOCOL_SWM_SHARE_ACK` (acks ride the gossip
   *     applier path only), so without this call a successful
   *     top-up never moves the peer into `acked` and the
   *     share stays `pending` until `deadlineHardMs` even
   *     after the actual delivery succeeded.
   *   - `retryable` (0x02 sentinel) → no-op; next watchdog
   *     tick fires another top-up, giving upstream state more
   *     time to converge.
   *   - `rejected` (0x01 sentinel) → no-op; receiver
   *     permanently rejected the share, retrying won't help.
   *     (Pre-PR-D receivers that fell back to the throw path
   *     instead of the sentinel surface this as `failed`
   *     here — also a no-op for the same reason.)
   *   - `queued` / `inFlight` / `failed` → no-op; the
   *     substrate outbox owns retry for these.
   */
  async swmSubstrateTopUp(this: DKGAgent, {
    shareOperationId, cgId, payload, missingPeers,
  }: {
    shareOperationId: string;
    cgId: string;
    payload: Uint8Array;
    missingPeers: readonly string[];
  }): Promise<void> {
    const ctx = createOperationContext('share', shareOperationId);
    // PR-J round 2: ackQuorum's `expectedMembers` is now the FULL
    // enumerated set (gossip-eligible) per codex RED #3 on #584.
    // `missingPeers` therefore includes peers ackQuorum tracks but
    // substrate can't reach (ghost peer-exchange entries, or
    // gossip-only-reachable peers without peerStore addresses).
    // Re-apply the same dialability filter here so the watchdog
    // top-up doesn't keep blasting wire sends that will queue
    // forever — that would inflate the `swm.substrateFanout.queued`
    // counter once per 30s tick for each ghost, recreating the
    // soak bug at watchdog cadence instead of share cadence.
    //
    // Filtered-out peers remain in ackQuorum's expectedMembers and
    // get reaped via deadlineHardMs if they never ack (a metric
    // blip, not a wire-load regression — exactly the tradeoff
    // codex called out as "noise we can't distinguish from
    // legitimate churn" in the round-2 review).
    const dialabilityChecks = await Promise.all(missingPeers.map((p) => this.isPeerDialable(p)));
    const dialableMissingPeers = missingPeers.filter((_, idx) => dialabilityChecks[idx]);
    if (dialableMissingPeers.length === 0) {
      this.log.info(
        ctx,
        `SWM ack-quorum watchdog skipping substrate top-up for ${shareOperationId} (cg=${cgId}): no dialable peers among ${missingPeers.length} missing`,
      );
      return;
    }
    const quorumRecord = this.swmAckQuorum?.inspect(shareOperationId);
    let topUpPeers = dialableMissingPeers;
    if (quorumRecord?.enumerationSource === 'topic-subscribers') {
      const selection = this.selectSwmFanoutPeersForActiveShare({
        contextGraphId: cgId,
        candidatePeers: dialableMissingPeers,
        enumerationSource: 'topic-subscribers',
      });
      topUpPeers = selection.selectedPeers;
      if (selection.skippedRecentPeers.length > 0 || topUpPeers.length !== dialableMissingPeers.length) {
        this.log.info(
          ctx,
          `SWM public top-up narrowed cg=${cgId} selected=${topUpPeers.length}/${dialableMissingPeers.length} `
          + `knownGood=${selection.knownGoodPeers.length} `
          + `unknownProbe=${selection.unknownProbedPeers.length} `
          + `skippedRecent=${selection.skippedRecentPeers.length}`,
        );
      }
      if (topUpPeers.length === 0) {
        this.log.info(
          ctx,
          `SWM public top-up skipped for ${shareOperationId} (cg=${cgId}): all ${dialableMissingPeers.length} dialable peer(s) are inside recent negative TTL`,
        );
        return;
      }
    }
    this.log.info(
      ctx,
      `SWM ack-quorum watchdog firing substrate top-up for ${shareOperationId} to ${topUpPeers.length}/${missingPeers.length} peer(s) (cg=${cgId}, dialable=${dialableMissingPeers.length})`,
    );
    // PR-H bug 1: route per-peer outcomes to the right ack-quorum
    // hook. Pre-PR-H ignored outcomes entirely except for
    // `delivered` → onAck; the watchdog couldn't fire again so
    // shares sat until `deadlineHardMs` (5 min) on transient
    // receiver errors.
    //
    // PR-H round 2 (codex feedback on #582):
    //   - `delivered` → onAck (terminal-success; counts toward
    //     quorum).
    //   - `rejected` (0x01 sentinel) / `failed` → dropPeer; the
    //     peer is permanently out of this share's recipient set.
    //     Round 1 just no-op'd on these, which (combined with
    //     rearmWatchdog rebuilding `missingPeers` from
    //     `expectedMembers \ acked`) re-sent permanently-bad
    //     payloads to the same rejected peer on every subsequent
    //     watchdog tick. Dropping shrinks both the top-up target
    //     set AND the quorum denominator, so a CG where 1/3
    //     peers permanently rejects can still hit quorum on the
    //     remaining 2 acks instead of waiting out
    //     `deadlineHardMs`.
    //   - `retryable` (0x02 sentinel) / `queued` / `inFlight` →
    //     count toward `rearmCount`. `queued`/`inFlight` was a
    //     round-1 gap: the substrate outbox owns wire retry for
    //     those outcomes, but the outbox doesn't notify back
    //     into the ack-quorum when its eventual retry hits the
    //     receiver. The watchdog firing again at next interval
    //     is the loosely-coupled signal — if the outbox
    //     succeeded AND the receiver ack'd via gossip, quorum
    //     already grew via `onAck` from the SWM_SHARE_ACK
    //     receiver and the next watchdog will see the record
    //     already completed (no-op). If still missing, the next
    //     top-up cycle gives both the outbox and the receiver
    //     another chance, bounded by `deadlineHardMs`. Open
    //     follow-up: full outbox→quorum wiring (markDelivered
    //     observer surfacing response sentinels back to the
    //     publisher) would tighten this further; out of scope
    //     for this PR — see PR #582 comments / follow-up issue.
    let rearmCount = 0;
    await Promise.allSettled(topUpPeers.map(async (peerId: string) => {
      try {
        const sendResult = await this.messenger.sendReliable(peerId, PROTOCOL_SWM_UPDATE, payload, {
          messageId: `swm-topup-${shareOperationId}-${peerId}`,
          timeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS,
        });
        const classified = classifySendResult(peerId, sendResult);
        if (quorumRecord?.enumerationSource === 'topic-subscribers') {
          this.recordSwmFanoutPeerRecord(cgId, classified);
        }
        switch (classified.outcome) {
          case 'delivered':
            this.swmAckQuorum?.onAck(shareOperationId, peerId);
            break;
          case 'rejected':
          case 'failed':
            this.swmAckQuorum?.dropPeer(shareOperationId, peerId);
            break;
          case 'retryable':
          case 'queued':
          case 'inFlight':
            rearmCount += 1;
            break;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (quorumRecord?.enumerationSource === 'topic-subscribers') {
          this.recordSwmFanoutPeerOutcome(cgId, peerId, 'failed');
        }
        this.swmAckQuorum?.dropPeer(shareOperationId, peerId);
        this.log.warn(ctx, `SWM top-up to ${peerId} failed: ${reason}`);
      }
    }));
    if (rearmCount > 0) {
      this.log.info(
        ctx,
        `SWM top-up saw ${rearmCount} non-terminal outcome(s) — re-arming watchdog`,
      );
      this.swmAckQuorum?.rearmWatchdog(shareOperationId);
    }
  }

  /**
   * Test-only view onto {@link swmSubstrateTopUp} for the
   * PR-D codex follow-up #D6 regression. Bypasses the
   * watchdog's setInterval so tests can pin the per-outcome
   * classification → onAck wiring without real-time flake.
   */
  async invokeSwmSubstrateTopUpForTests(this: DKGAgent, args: {
    shareOperationId: string;
    cgId: string;
    payload: Uint8Array;
    missingPeers: readonly string[];
  }): Promise<void> {
    return this.swmSubstrateTopUp(args);
  }

  getOrCreateSwmAckQuorum(this: DKGAgent): SwmAckQuorum {
    if (!this.swmAckQuorum) {
      this.swmAckQuorum = createSwmAckQuorum({
        substrateTopUp: (args) => this.swmSubstrateTopUp(args),
        observers: {
          onQuorumCompleted: (e: {
            shareOperationId: string; cgId: string; ackedCount: number; expectedCount: number; ackPct: number;
          }) => {
            this.log.debug(
              createOperationContext('share', e.shareOperationId),
              `SWM share quorum reached cg=${e.cgId} acked=${e.ackedCount}/${e.expectedCount} (${(e.ackPct * 100).toFixed(1)}%)`,
            );
          },
          onWatchdogFired: (e: {
            shareOperationId: string; cgId: string; missingCount: number; expectedCount: number;
          }) => {
            this.log.warn(
              createOperationContext('share', e.shareOperationId),
              `SWM share watchdog fired cg=${e.cgId} missing=${e.missingCount}/${e.expectedCount}`,
            );
          },
          onDeadlineExpired: (e: {
            shareOperationId: string; cgId: string; ackedCount: number; expectedCount: number; ackPct: number;
            missingPeers: readonly string[]; enumerationSource: 'allowlist' | 'topic-subscribers' | 'none';
          }) => {
            if (e.enumerationSource === 'topic-subscribers') {
              for (const peerId of e.missingPeers) {
                this.recordSwmFanoutPeerOutcome(e.cgId, peerId, 'nonTerminal');
              }
            }
            this.log.warn(
              createOperationContext('share', e.shareOperationId),
              `SWM share deadline expired cg=${e.cgId} acked=${e.ackedCount}/${e.expectedCount} (${(e.ackPct * 100).toFixed(1)}%) — offline peers will recover via runSyncOnConnect`,
            );
          },
        },
      });
      this.swmAckQuorumTimer = setInterval(() => {
        try {
          this.swmAckQuorum?.tick();
        } catch (err) {
          // Defensive — tick() should not throw, but if some
          // future observer/callback path breaks the contract we'd
          // rather drop one tick than crash the daemon's tick loop.
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(createOperationContext('system'), `SWM ack-quorum tick failed: ${reason}`);
        }
      }, DKGAgentBase.SWM_ACK_QUORUM_TICK_MS);
      const t = this.swmAckQuorumTimer as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
    return this.swmAckQuorum;
  }

  /**
   * {@link FanOutBookkeeper} implementation backed by the four
   * per-cgId outcome maps + the overflow buckets. Mirrors the
   * Codex PR #570 R5/R8 shape from `recordSwmGossipPublishFailure`:
   * once the per-cgId map crosses
   * `SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS`, the cgId with the
   * GLOBAL smallest TOTAL count (summed across all four outcome
   * maps) is evicted into the appropriate overflow bucket, so the
   * grand total stays accurate and the hot cgIds stay visible.
   *
   * Returned as a single object literal (not a class) so the
   * tier-switch in `publishWorkspaceGossip` can pass it inline
   * to `executeSubstrateFanOut` without extra plumbing.
   */
  substrateFanoutBookkeeper(this: DKGAgent): FanOutBookkeeper {
    return {
      recordOutcome: (cgId: string, record: FanOutPeerRecord) => {
        this.recordSwmSubstrateFanoutOutcome(cgId, record);
      },
    };
  }

  /**
   * Increment the per-(cgId, outcome) substrate counter and apply
   * the overflow-cap eviction policy. Returns the post-increment
   * count for the caller's WARN log on `failed` outcomes (parity
   * with `recordSwmGossipPublishFailure`'s R12-fix shape).
   */
  recordSwmSubstrateFanoutOutcome(this: DKGAgent, cgId: string, record: FanOutPeerRecord): void {
    const targetMap = this.substrateFanoutMapFor(record.outcome);
    targetMap.set(cgId, (targetMap.get(cgId) ?? 0) + 1);
    this.maybeEvictSubstrateFanoutCgId(cgId);
  }

  substrateFanoutMapFor(this: DKGAgent, outcome: FanOutPeerRecord['outcome']): Map<string, number> {
    switch (outcome) {
      case 'delivered': return this.swmSubstrateFanoutDelivered;
      case 'rejected':  return this.swmSubstrateFanoutRejected;
      case 'retryable': return this.swmSubstrateFanoutRetryable;
      case 'queued':    return this.swmSubstrateFanoutQueued;
      case 'inFlight':  return this.swmSubstrateFanoutInFlight;
      case 'failed':    return this.swmSubstrateFanoutFailed;
    }
  }

  substrateFanoutTotalForCg(this: DKGAgent, cgId: string): number {
    return (this.swmSubstrateFanoutDelivered.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutRejected.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutRetryable.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutQueued.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutInFlight.get(cgId) ?? 0)
      + (this.swmSubstrateFanoutFailed.get(cgId) ?? 0);
  }

  /**
   * If the per-cgId tracking set is at or above
   * `SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS`, find the cgId with
   * the smallest TOTAL count (summed across all four outcome
   * maps), drain its four per-outcome counts into the overflow
   * buckets, and delete it from the four maps. Setting the
   * sticky `swmSubstrateFanoutTruncated` flag tells operators
   * the per-cgId breakdown on /api/slo is partial.
   *
   * Eviction key = TOTAL across outcomes (not any single map),
   * because the operator-facing definition of "hot cgId" is "lots
   * of substrate activity", regardless of how it broke down. A
   * cgId with 100 delivers is hotter than a cgId with 5 failed,
   * even though `failed` is the more alarming outcome.
   */
  maybeEvictSubstrateFanoutCgId(this: DKGAgent, _justBumped: string): void {
    // Use any of the five maps to count distinct tracked cgIds —
    // they're populated together via `substrateFanoutTotalForCg`.
    const distinctCgIds = new Set<string>([
      ...this.swmSubstrateFanoutDelivered.keys(),
      ...this.swmSubstrateFanoutRejected.keys(),
      ...this.swmSubstrateFanoutRetryable.keys(),
      ...this.swmSubstrateFanoutQueued.keys(),
      ...this.swmSubstrateFanoutInFlight.keys(),
      ...this.swmSubstrateFanoutFailed.keys(),
    ]);
    if (distinctCgIds.size <= DKGAgentBase.SWM_SUBSTRATE_FANOUT_MAX_TRACKED_CGS) return;

    let smallestCg: string | null = null;
    let smallestTotal = Infinity;
    for (const cg of distinctCgIds) {
      const total = this.substrateFanoutTotalForCg(cg);
      if (total < smallestTotal) {
        smallestTotal = total;
        smallestCg = cg;
      }
    }
    if (smallestCg === null) return;

    this.swmSubstrateFanoutOverflow.delivered += this.swmSubstrateFanoutDelivered.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.rejected  += this.swmSubstrateFanoutRejected.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.retryable += this.swmSubstrateFanoutRetryable.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.queued    += this.swmSubstrateFanoutQueued.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.inFlight  += this.swmSubstrateFanoutInFlight.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutOverflow.failed    += this.swmSubstrateFanoutFailed.get(smallestCg) ?? 0;
    this.swmSubstrateFanoutDelivered.delete(smallestCg);
    this.swmSubstrateFanoutRejected.delete(smallestCg);
    this.swmSubstrateFanoutRetryable.delete(smallestCg);
    this.swmSubstrateFanoutQueued.delete(smallestCg);
    this.swmSubstrateFanoutInFlight.delete(smallestCg);
    this.swmSubstrateFanoutFailed.delete(smallestCg);
    this.swmSubstrateFanoutTruncated = true;
  }

  /**
   * Snapshot of the substrate fan-out counters for /api/slo.
   * Same surface shape as `getSwmGossipStats()` / `getSwmHandlerStats()`
   * — pure read, safe to call from a fresh daemon (returns
   * pristine zeroes when no shares have fanned out yet). Pre-
   * serializing into `Record<string, number>` happens via
   * `Object.fromEntries` consistent with the existing /api/slo
   * shape.
   */
  /**
   * Test/observability helper (rc.9 PR-G codex follow-up #G2).
   * Resolves once every detached substrate fan-out spawned by
   * `publishWorkspaceGossip` has settled (counters updated,
   * INFO log emitted). Production code DOES NOT need to call
   * this — the whole point of the G2 detach is that share()
   * returns without waiting on the substrate side. Used by
   * integration tests that assert on substrate counters after
   * a `share()` call, and by the soak script's shutdown flush
   * so in-flight outbox writes don't get lost across process
   * boundaries.
   *
   * Returns a snapshot of the in-flight set at call time, so a
   * fan-out enqueued AFTER this call returns will not be awaited.
   * Callers that need full drain should loop until
   * `inFlightSubstrateFanOutCount() === 0`.
   */
  async awaitInFlightSubstrateFanOuts(this: DKGAgent): Promise<void> {
    await Promise.allSettled([...this.inFlightSubstrateFanOuts]);
  }

  /** Sibling of {@link awaitInFlightSubstrateFanOuts} — gauge for diagnostic / drain-loop use. */
  inFlightSubstrateFanOutCount(this: DKGAgent): number {
    return this.inFlightSubstrateFanOuts.size;
  }

  getSwmSubstrateFanoutStats(this: DKGAgent): {
    delivered: Record<string, number>;
    rejected: Record<string, number>;
    retryable: Record<string, number>;
    queued: Record<string, number>;
    inFlight: Record<string, number>;
    failed: Record<string, number>;
    overflow: { delivered: number; rejected: number; retryable: number; queued: number; inFlight: number; failed: number };
    truncated: boolean;
  } {
    return {
      delivered: Object.fromEntries(this.swmSubstrateFanoutDelivered),
      rejected: Object.fromEntries(this.swmSubstrateFanoutRejected),
      retryable: Object.fromEntries(this.swmSubstrateFanoutRetryable),
      queued: Object.fromEntries(this.swmSubstrateFanoutQueued),
      inFlight: Object.fromEntries(this.swmSubstrateFanoutInFlight),
      failed: Object.fromEntries(this.swmSubstrateFanoutFailed),
      overflow: {
        delivered: this.swmSubstrateFanoutOverflow.delivered,
        rejected: this.swmSubstrateFanoutOverflow.rejected,
        retryable: this.swmSubstrateFanoutOverflow.retryable,
        queued: this.swmSubstrateFanoutOverflow.queued,
        inFlight: this.swmSubstrateFanoutOverflow.inFlight,
        failed: this.swmSubstrateFanoutOverflow.failed,
      },
      truncated: this.swmSubstrateFanoutTruncated,
    };
  }

  /**
   * Snapshot of the SwmAckQuorum counters for /api/slo (rc.9
   * PR-D). Returns pristine zeroes when the quorum tracker hasn't
   * been lazy-constructed yet (no shares have been published, or
   * none of them met the tracking preconditions in
   * `publishWorkspaceGossip`). Safe to call from a fresh daemon.
   *
   * Counter semantics (cumulative since process start, except
   * `pending` which is an instantaneous gauge):
   *   - tracked          — every successful `track()` call
   *   - completed        — records that reached quorumThreshold
   *   - watchdogFired    — records where the watchdog fired
   *                        substrate top-up (at most once per
   *                        record)
   *   - deadlineExpired  — records reaped at deadlineHardMs
   *                        without reaching quorum
   *   - pending          — currently tracked (not yet completed
   *                        or expired)
   *
   * A healthy soak surfaces: `completed >> watchdogFired >>
   * deadlineExpired`. A spike in `deadlineExpired` is the
   * operator alarm — those peers will recover via
   * `runSyncOnConnect` but the share's per-recipient delivery
   * window blew past the 5min budget.
   */
  getSwmAckQuorumStats(this: DKGAgent): {
    tracked: number;
    completed: number;
    watchdogFired: number;
    deadlineExpired: number;
    pending: number;
  } {
    if (!this.swmAckQuorum) {
      return { tracked: 0, completed: 0, watchdogFired: 0, deadlineExpired: 0, pending: 0 };
    }
    return this.swmAckQuorum.stats();
  }

  private updateHandler?: UpdateHandler;

  getOrCreateUpdateHandler(this: DKGAgent): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchContextGraphs: this.publisher.knownBatchContextGraphs,
        // GH #842: let the receiver promote applied updates into the per-cgId
        // partition the RS prover reads, so updated KAs are provable on all
        // nodes, not just the publisher.
        resolveOnChainCgId: (cgName: string) => this.getContextGraphOnChainId(cgName),
      });
    }
    return this.updateHandler;
  }

  getOrCreateFinalizationHandler(this: DKGAgent): FinalizationHandler {
    if (!this.finalizationHandler) {
      this.finalizationHandler = new FinalizationHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        {
          eventBus: this.eventBus,
          // Defensive: resolve a missing pre-cd68fa689 wire CG id locally.
          resolveContextGraphOnChainId: (cgName: string) =>
            this.getContextGraphOnChainId(cgName),
          markContextGraphMetaDirtyFromQuads: (quads) => {
            this.contextGraphMetaProjection.markDirtyFromQuads(quads);
          },
          runtime: this.finalizationRuntime,
          writeLocks: this.writeLocks,
        },
      );
    }
    return this.finalizationHandler;
  }

}
