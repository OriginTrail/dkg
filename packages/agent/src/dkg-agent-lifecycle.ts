// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle + sync subsystem extracted from dkg-agent.ts as a mixin holder:
 * start() boot orchestration, random-sampling prover wiring, peer/CG sync
 * (warm-core, catchup, paged fetch, sync-verify worker), subscription-state
 * bookkeeping, and shared-memory TTL cleanup. 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
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
import { runSyncOnConnect, SyncOnConnectPostSyncError, type SyncOnConnectOutcome, type SyncOnConnectPeerOutcome } from './sync/on-connect/sync-on-connect.js';
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
import { reconcileContextGraph, ReconcileCoalescer, RecentUalSet, type ChainReconcilerDeps, type OrdinalOutcome } from './chain-reconciler.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
// rc.9 PR-10: JoinApprovalRetryQueue removed — substrate outbox
// (durable, SQLite-backed) replaces it. We keep a minimal local
/**
 * Default cap on how many persisted context-graph subscriptions are activated
 * (gossip-subscribed + sync-tracked) on startup. A large backlog of stale
 * subscriptions otherwise fans out store-touching gossip/sync work that
 * starves authenticated store-backed routes (issue #997). Override via
 * `DKGAgentConfig.maxRehydratedContextGraphSubscriptions` (0 disables).
 */
const DEFAULT_MAX_REHYDRATED_SUBSCRIPTIONS = 64;
/** Yield to the event loop every N activations so concurrent store work can interleave. */
const REHYDRATE_THROTTLE_BATCH = 8;

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

export class LifecycleSyncMethods extends DKGAgentBase {
  async start(this: DKGAgent): Promise<void> {
    if (this.started) return;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    await this.node.start();
    this.started = true;
    this.log.info(ctx, `Node started, peer ID: ${this.node.peerId.toString()}`);

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
    this.router = new ProtocolRouter(this.node, { peerResolver });
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
      // stall-walk (`messenger.maybeScheduleDhtWalk`) was hardcoded
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
    this.gossip = new GossipSubManager(this.node, this.eventBus);
    await this.loadSwmSenderKeyState();
    await this.initializeSwmHostModeStore();
    await this.rehydrateContextGraphSubscriptions();

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
    const queryRemoteHandler = new QueryHandler(this.queryEngine, queryAccessConfig);
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
              // Codex PR #608: independently verify the publisher's
              // `isEncryptedPayload=true` claim against this node's
              // local view of the CG. `isPrivateContextGraph()` is the
              // same predicate the SWM data-plane uses to gate
              // sync / share auth, so the ACK path stays consistent
              // for curators / members that have already synced the
              // CG metadata locally.
              //
              // Chain fallback (regression fix, post-R5): for a CG that
              // a non-curator core just learned about via on-chain
              // event but whose meta-graph triples haven't been
              // gossipped yet, the local-store probes both miss. The
              // `ContextGraphCreated` event handler eagerly seeds
              // `onChainAccessPolicyCache`, but for cores that started
              // AFTER a CG's create-block (or missed the event), we
              // also do a single lazy chain read via
              // `chain.getContextGraphAccessPolicy`. The chain is the
              // source of truth — Solidity stores the policy as a
              // uint8 on `ContextGraphStorage`. `cgId` here is the
              // PublishIntent's on-chain numeric id (see
              // `core/proto/publish-intent.ts:62` — "TARGET on-chain
              // numeric CG id"), so it maps directly to the contract
              // call.
              //
              // Returns `null` when curation is genuinely indeterminate
              // (chain adapter doesn't expose the getter; chain read
              // throws). The handler treats `null !== true` as
              // fail-closed, preserving the original auth-bypass guard.
              isCgCurated: async (cgId: string, _swmGraphId?: string) => {
                // Codex PR #608 R3 #1325: only the TARGET cgId determines
                // whether the published payload is encrypted. The source
                // `swmGraphId` is the LOCAL SWM graph name and can't
                // override chain truth — a remap from a private local
                // staging graph onto a public on-chain CG must take the
                // plaintext path the chain expects, not the opaque one.
                // Previously this probed BOTH and returned true if either
                // looked private, letting curated-shape envelopes ride a
                // public-CG publish.
                try {
                  if (await this.isPrivateContextGraph(cgId)) return true;
                } catch { /* fall through to chain probe */ }
                const cached = this.onChainAccessPolicyCache.get(cgId);
                if (cached !== undefined) {
                  return cached === 1;
                }
                const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
                if (typeof getAccessPolicy !== 'function') {
                  return null;
                }
                let numericId: bigint;
                try {
                  numericId = BigInt(cgId);
                } catch {
                  return null;
                }
                if (numericId <= 0n) {
                  return null;
                }
                try {
                  const policy = await getAccessPolicy.call(this.chain, numericId);
                  if (policy === 0 || policy === 1) {
                    this.onChainAccessPolicyCache.set(cgId, policy);
                    return policy === 1;
                  }
                  return null;
                } catch (err) {
                  this.log.warn(
                    ctx,
                    `isCgCurated: chain.getContextGraphAccessPolicy(${cgId}) failed — treating as UNKNOWN (fail-closed at handler): ` +
                    (err instanceof Error ? err.message : String(err)),
                  );
                  return null;
                }
              },
              isSignerRegistered: async () => {
                const isOperationalWalletRegistered = this.chain.isOperationalWalletRegistered;
                if (typeof isOperationalWalletRegistered !== 'function') return false;
                return isOperationalWalletRegistered.call(
                  this.chain,
                  onChainIdentityId,
                  ackSignerWallet.address,
                );
              },
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
                void this.recordCoreHostedPublicCg(cgId, swmGraphId);
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
            // OT-RFC-38 LU-11 / OT-RFC-39 — V2 protocol id. Same
            // handler instance, distinct libp2p protocol. Publishers
            // running the chunked emit path negotiate V2 explicitly
            // so pre-LU-11 cores (V1-only) never see a V2 envelope;
            // the handler dispatches on `intent.ackProtocolVersion`
            // internally — V2 envelopes hit the chunked verify
            // branch, V1 envelopes (if any ever arrive on the V2
            // protocol id, which spec-conforming clients won't send)
            // fall through to the legacy single-blob / public-CG
            // paths.
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
        onContextGraphCreated: async ({ contextGraphId, creator, accessPolicy, publishPolicy, nameHash, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain context graph ${contextGraphId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy}, publishPolicy ${publishPolicy ?? '?'}, nameHash ${nameHash ? nameHash.slice(0, 10) + '…' : '(opt-out)'})`);

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
            const hashLower = nameHash.toLowerCase();
            // Stage a synthetic subscription record for the host-only
            // case: cores hosting CGs they never joined have no
            // cleartext; the hash IS their local id. `recordCgWireId`
            // would no-op on this without a pre-existing record, so
            // upsert a minimal stub first.
            if (!this.subscribedContextGraphs.has(hashLower)) {
              this.subscribedContextGraphs.set(hashLower, {
                subscribed: false,
                synced: false,
                onChainId: contextGraphId,
                onChainHash: hashLower,
                pendingMeta: true,
              });
            } else {
              const existing = this.subscribedContextGraphs.get(hashLower)!;
              this.bindSubscriptionOnChainId(hashLower, existing, contextGraphId);
              existing.onChainHash = hashLower;
            }
            this.recordCgWireId(hashLower, hashLower);

            // Delegate to the host-mode reconciler — it owns the
            // sharding-table check, swmHostMode flag, and the wire-up
            // of the host-mode gossip handler. Async + best-effort:
            // the periodic reconciler covers the timer-driven fallback
            // path, so a missed event here heals on the next sweep.
            void this.reconcileSwmHostModeSubscription(
              hashLower,
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
              const localCgId = this.resolveLocalCgIdByOnChainId(BigInt(onChainId));
              if (!localCgId) return; // chain replay hasn't resolved the cleartext CG yet; sweep heals it
              const sub = this.subscribedContextGraphs.get(localCgId);
              // Populate VM for CGs we member-subscribe to OR (Phase D) public
              // CGs this Core hosts — a hosted Core fills its own gaps too.
              if (!sub?.subscribed && !sub?.coreHosted) return;
              this.log.info(ctx, `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> reconcile "${localCgId}"`);
              if (this.reconcileCoalescer) void this.reconcileCoalescer.trigger(localCgId);
            }
          : undefined,
      });
      this.chainPoller.start();
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
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logDebug: (ctx, message) => this.log.debug(ctx, message),
    });

    // Join-request protocol: receives signed join requests forwarded by peers.
    // Stores them locally if this node is the curator; ACKs with "ok" or "error".
    // rc.9 PR-10: migrated onto the Universal Messenger substrate
    // (wire prefix bumped to /dkg/10.0.1/join-request). messenger.register
    // wraps the handler with envelope-decode + receiver-side dedup;
    // the application logic below is unchanged.
    this.messenger.register(PROTOCOL_JOIN_REQUEST, async (data, peerIdStr) => {
      const peerId = { toString: () => peerIdStr, toBytes: () => new Uint8Array() };
      try {
        const payload = JSON.parse(new TextDecoder().decode(data));

        // Handle "join-approved" notifications from curator → requester.
        // Only process if this node owns the target agentAddress AND the
        // sender is a peer we previously trusted as a curator candidate
        // for THIS specific (cgId, agentAddress) pair (or, as a fallback,
        // matches the curator triple in our local _meta graph — which
        // works for already-approved members getting re-approved).
        if (payload.type === 'join-approved') {
          const { contextGraphId, agentAddress: approvedAddr } = payload;
          // Require BOTH fields. Earlier the address was treated as
          // optional, so a forged payload carrying only `contextGraphId`
          // would skip the trusted-sender check, subscribe this node,
          // and emit JOIN_APPROVED unconditionally. Mirror the
          // rejection handler: if either field is missing, drop.
          if (contextGraphId && approvedAddr) {
            const isLocalAgent = [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === approvedAddr.toLowerCase(),
            );
            if (!isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            const senderTrusted = await this.isTrustedJoinDecisionSender(
              contextGraphId,
              approvedAddr,
              peerId.toString(),
            );
            if (!senderTrusted) {
              this.log.warn(
                createOperationContext('system'),
                `Dropping join-approved for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
              );
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            this.preferredSyncPeers.set(contextGraphId, peerId.toString());
            // Curator just confirmed `approvedAddr` is the principal —
            // record it BEFORE auto-subscribe / sync kick in, so the
            // first post-approval `buildSyncRequest` claims the right
            // agent (the curator's `_meta` graph hasn't been synced
            // yet at this point on multi-agent nodes).
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
            this.subscribeToContextGraph(contextGraphId, { deferSharedMemoryGossipSubscribe: true });
            this.upsertContextGraphMember({
              contextGraphId,
              principalType: 'agent',
              principalId: approvedAddr,
              role: 'participant',
              status: 'active',
              source: 'join-approved',
            });
            this.joinRequestAcceptedBy.delete(`${contextGraphId}::${approvedAddr.toLowerCase()}`);
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
            this.markContextGraphSubscriptionState(contextGraphId, {
              pendingMeta: true,
              metaSynced: false,
            });
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
          const { contextGraphId, agentAddress: rejectedAddr } = payload;
          if (!contextGraphId || !rejectedAddr) {
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
            peerId.toString(),
          );
          if (!senderTrusted) {
            this.log.warn(
              createOperationContext('system'),
              `Dropping join-rejected for "${contextGraphId}" from ${peerId.toString()} — sender did not previously accept the join request and is not the recorded curator`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          this.log.info(createOperationContext('system'), `Join request rejected for "${contextGraphId}"`);
          this.upsertContextGraphMember({
            contextGraphId,
            principalType: 'agent',
            principalId: rejectedAddr,
            role: 'requester',
            status: 'removed',
            source: 'join-rejected',
          });
          this.joinRequestAcceptedBy.delete(`${contextGraphId}::${rejectedAddr.toLowerCase()}`);
          // Drop the optimistic "this CG belongs to <rejectedAddr>" hint
          // seeded by `signJoinRequest`. Otherwise multi-agent nodes keep
          // building authenticated sync requests on behalf of the rejected
          // agent and the curator denies the very next catch-up after a
          // *different* local agent is allowlisted, until something else
          // overwrites the map.
          const localHint = this.localApprovedAgentByCG.get(contextGraphId);
          if (localHint && localHint === rejectedAddr.toLowerCase()) {
            this.localApprovedAgentByCG.delete(contextGraphId);
          }
          this.eventBus.emit(DKGEvent.JOIN_REJECTED, {
            contextGraphId,
            agentAddress: rejectedAddr,
          });
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        const { contextGraphId, delegation, agentName } = payload as {
          contextGraphId?: string;
          delegation?: SignedAgentDelegation;
          agentName?: string;
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
        if (!contextGraphId || !delegation?.agentAddress || !delegation?.signature) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag}: rejected — missing fields ` +
              `(contextGraphId=${!!contextGraphId} agentAddress=${!!delegation?.agentAddress} signature=${!!delegation?.signature})`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
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
        // suffixes pass through (case-sensitive base58). The cgId-derived
        // owner DID (`deriveCuratorDidFromCgId`) preserves whatever case
        // the cgId shipped with, while the locally-stored agent address
        // is typically `ethers.getAddress`'d to checksummed form — both
        // collapse to the same string here.
        const ownerNorm = normalizeAgentDid(owner);
        const selfDid = `did:dkg:agent:${this.peerId}`;
        const selfAgentDid = this.defaultAgentAddress
          ? normalizeAgentDid(`did:dkg:agent:${this.defaultAgentAddress}`)
          : null;
        const isCurator = ownerNorm === selfDid ||
          (selfAgentDid !== null && ownerNorm === selfAgentDid) ||
          [...this.localAgents.keys()].some((addr) => ownerNorm === normalizeAgentDid(`did:dkg:agent:${addr}`));
        if (!isCurator) {
          this.log.warn(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": rejected — not curator (owner=${owner})`,
          );
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'not curator' }));
        }
        this.log.info(
          requestCtx,
          `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": accepted, verifying delegation for ${delegation.agentAddress}`,
        );
        this.verifyJoinRequest(contextGraphId, delegation);

        // Remember which peer actually delivered this request so we can
        // send approval/rejection back to the same peer later, even if
        // the agent registry hasn't indexed them yet.
        const originKey = `${contextGraphId}::${delegation.agentAddress.toLowerCase()}`;
        this.joinRequestOriginPeers.set(originKey, peerId.toString());

        // Already-member short-circuit: if the requester is already in
        // the allowlist (e.g. they were added directly via add-agent,
        // or are re-pasting an old invite), skip the pending-request
        // dance and immediately fire `join-approved` so their UI flips
        // to success without curator action. Safe to disclose because
        // `verifyJoinRequest` already proved the requester owns the
        // private key for `agentAddress` — only the legitimate owner
        // learns "you're already a member".
        const allowed = await this.getContextGraphAllowedAgents(contextGraphId);
        const addrLower = delegation.agentAddress.toLowerCase();
        const alreadyMember = allowed.some((a) => a.toLowerCase() === addrLower);
        if (alreadyMember) {
          this.log.info(
            requestCtx,
            `PROTOCOL_JOIN_REQUEST from ${peerTag} for "${contextGraphId}": already-member short-circuit for ${delegation.agentAddress}`,
          );
          this.notifyJoinApproval(contextGraphId, delegation.agentAddress).catch(() => {});
          return new TextEncoder().encode(JSON.stringify({ ok: true, alreadyMember: true }));
        }

        await this.storePendingJoinRequest(contextGraphId, delegation, agentName);
        // Note: `storePendingJoinRequest` itself now emits JOIN_REQUEST_RECEIVED.
        // No duplicate emit here.
        return new TextEncoder().encode(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Mirror the per-rejection-path warns above. The most common
        // throw-site is `verifyJoinRequest` (signature/scope/expiry
        // failure); without this log the curator silently NACKs and the
        // joiner sees only "no reachable curator".
        this.log.warn(
          createOperationContext('system'),
          `PROTOCOL_JOIN_REQUEST handler error: ${msg}`,
        );
        return new TextEncoder().encode(JSON.stringify({ ok: false, error: msg }));
      }
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
      // rc.9 PR-10: the dedicated join-approval on-connect flush is
      // gone. The substrate's `Messenger.processOutboxOnConnect` (a
      // few lines further down in this handler) now covers join-
      // approved retries too, since /dkg/10.0.1/join-request is now
      // a substrate-managed protocol.

      // Reverse-path peerStore enrichment for inbound circuit-relay
      // connections, then the symmetric chat-outbox flush.
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
      // running enrichment and the outbox flush in parallel
      // fire-and-forget meant the first flush attempt could
      // still hit `dialProtocol` against an EMPTY peerStore and
      // fail with the same "no valid addresses" error this PR is
      // meant to heal — pushing recovery onto the next 30s tick
      // or another reconnect. Sequence the two: await enrichment
      // first, then flush. Both stay wrapped in their own
      // try/catch so an enrichment failure logs a warning and
      // still lets the outbox flush proceed (it might succeed
      // anyway via a stale-but-usable cached path).
      //
      // The whole chain runs as a fire-and-forget IIFE so the
      // listener itself doesn't await — libp2p's
      // `connection:open` emitter is synchronous and we don't
      // want to slow down other listeners.
      void (async () => {
        try {
          await this.enrichPeerStoreFromInboundCircuit(evt.detail);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Reverse-path peerStore enrichment failed for ${remotePeer}: ${message}`);
        }
        // Universal Messenger substrate (rc.9 PR-2/PR-3): drain
        // the generic outbox for this peer. Replaces the rc.8
        // chat-specific outbox flush — the substrate now carries
        // chat (PR-3) and will carry every other short-message
        // protocol after PR-8..PR-11.
        try {
          await this.messenger.processOutboxOnConnect(remotePeer);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `Opportunistic Messenger-outbox retry on connect failed for ${remotePeer}: ${message}`);
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
      })();

      const now = Date.now();
      const lastSuccessfulSync = this.lastSuccessfulSyncAt.get(remotePeer);
      const lastDisconnected = this.lastSyncDisconnectedAt.get(remotePeer) ?? 0;
      if (
        lastSuccessfulSync != null &&
        lastSuccessfulSync > lastDisconnected &&
        now - lastSuccessfulSync < SYNC_STALENESS_THRESHOLD_MS
      ) {
        return;
      }
      const last = this.catchupOnConnectAt.get(remotePeer) ?? 0;
      if (last > lastDisconnected && now - last < CATCHUP_ON_CONNECT_COOLDOWN_MS) return;
      this.catchupOnConnectAt.set(remotePeer, now);
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
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
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
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
      const pruneEveryMs = this.config.swmHostMode?.pruneIntervalMs ?? 5 * 60_000;
      this.reconcileHostModeSubscriptions().catch(() => {});
      this.hostModeReconcilerTimer = setInterval(() => {
        this.reconcileHostModeSubscriptions().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(createOperationContext('system'), `Host-mode reconciler tick failed: ${msg}`);
        });
      }, reconcileEveryMs);
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
    this.syncReconcilerTimer = setInterval(() => {
      this.reconcileSyncFromConnectedPeers().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Sync reconciler tick failed: ${message}`);
      });
    }, SYNC_RECONCILER_INTERVAL_MS);
    if (this.syncReconcilerTimer.unref) this.syncReconcilerTimer.unref();

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
      this.reconcileCoalescer = new ReconcileCoalescer((localCgId) => this.runVmReconcileForCg(localCgId));
      const runSweep = (): void => {
        this.runVmReconcileSweep().catch((err: unknown) => {
          this.log.warn(ctx, `VM reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
      // Prime once after startup so a late subscriber catches up immediately,
      // then on a steady cadence.
      runSweep();
      this.vmReconcileTimer = setInterval(runSweep, DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS);
      if (this.vmReconcileTimer.unref) this.vmReconcileTimer.unref();
      this.log.info(ctx, `Chain-driven VM reconciliation armed (sweep ${DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS}ms, depth ${DKGAgentBase.VM_RECONCILE_CONFIRMATION_DEPTH})`);
    }

    // rc.9 PR-10: dedicated join-approval retry tick removed. The
    // substrate's Messenger.processOutboxTick (set up immediately
    // below) now drives retries for /dkg/10.0.1/join-request the
    // same way it does for chat — same cadence, same backoff ladder,
    // persisted across daemon restart.

    // Periodic tick for the chat outbox retry queue. See
    // MESSAGE_OUTBOX_TICK_MS for the rationale (silent-drop on
    // transport failure used to lose operator-typed messages from
    // `dkg_send_message`; this is the safety-net retry loop that turns
    // them into eventual successes, complemented by the
    // opportunistic-on-reconnect path in the connection:open listener).
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
    if (rsRole !== 'core' || this.chain.chainId === 'none') return 'disabled';

    let rsIdentityId = 0n;
    try {
      rsIdentityId = await this.chain.getIdentityId();
    } catch (err) {
      this.log.warn(
        ctx,
        `V10 Random Sampling identity lookup failed; prover bind will retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 'retryable';
    }

    if (rsIdentityId === 0n) {
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=0, chain=${this.chain.chainId}); will retry`);
      }
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
        // OT-RFC-39 late-join sync — gives the prover an escape hatch
        // when its tick fires on a curated KC whose ciphertext chunks
        // never reached this core's local triple store (typically: the
        // core was offline during the curator's publish, or joined the
        // CG after the gossip envelopes rolled off the mesh). The hook
        // pulls the missing chunks from authorized peers on demand via
        // `PROTOCOL_GET_CIPHERTEXT_CHUNK` and persists them, after
        // which the prover retries the extract exactly once. See
        // `buildCiphertextChunkBackfill` for the discovery + fetch
        // policy.
        ciphertextChunkBackfill: this.buildCiphertextChunkBackfill(ctx),
        // Codex review on PR #715 — let the prover's extractor pin
        // the per-CG named graph instead of scanning `GRAPH ?g`. We
        // chain `resolveLocalCgIdByOnChainId` (numeric → cleartext)
        // then `gossipWireIdFor` (cleartext → curator nameHash, the
        // wire form), matching what `ingestSwmCiphertextChunkEnvelope`
        // and the V2 ACK loadChunk persist/look up under. Returns
        // null when the local node doesn't have the CG metadata yet
        // (chain replay still catching up); the extractor falls back
        // to wildcard scanning for that tick, identical to pre-fix
        // behaviour, so a missing local map degrades to "no
        // cross-CG collision guard for this tick" rather than
        // "extract fails outright".
        canonicalCgIdForChunkStore: (cgId: bigint): string | null => {
          const local = this.resolveLocalCgIdByOnChainId(cgId);
          if (local === null) return null;
          return this.gossipWireIdFor(local);
        },
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
        handle.start();
        this.clearRandomSamplingBindRetry();
        this.log.info(ctx, `V10 Random Sampling prover started (identityId=${rsIdentityId})`);
        return 'started';
      }
      if (logDisabled) {
        this.log.info(ctx, `V10 Random Sampling prover not started (identity=${rsIdentityId}, chain=${this.chain.chainId})`);
      }
      return 'disabled';
    } catch (err) {
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
    return runSyncOnConnect({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      knownCorePeerIds: this.knownCorePeerIds,
      getSyncContextGraphs: () => this.config.syncContextGraphs ?? [],
      syncFromPeer: (peerId, contextGraphIds) => this.syncFromPeerDetailed(
        peerId,
        contextGraphIds ?? [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
      ),
      refreshMetaSyncedFlags: (contextGraphIds) => this.refreshMetaSyncedFlags(contextGraphIds),
      discoverContextGraphsFromStore: () => this.discoverContextGraphsFromStore(),
      syncSharedMemoryFromPeer: (peerId, contextGraphIds) => this.syncSharedMemoryFromPeerDetailed(peerId, contextGraphIds),
      syncSharedMemoryOnConnect: this.config.syncSharedMemoryOnConnect ?? true,
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
    if (!this.skippedNoSyncPeers.has(peerId)) return;
    if (!protocols.includes(PROTOCOL_SYNC)) return;
    this.skippedNoSyncPeers.delete(peerId);
    const ctx = createOperationContext('sync');
    const shortPeer = peerId.slice(-8);
    this.log.info(ctx, `Peer ${shortPeer} now advertises sync protocol — retrying sync-on-connect`);
    setTimeout(() => {
      this.trySyncFromPeer(peerId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Sync retry after peer:update failed for ${shortPeer}: ${message}`);
      });
    }, 0);
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
    const now = Date.now();
    const ctx = createOperationContext('sync');
    this.pruneSyncReconcilerState(now);
    for (const pid of this.node.libp2p.getPeers()) {
      const peerId = pid.toString();
      if (this.syncingPeers.has(peerId)) continue;
      const lastOk = this.lastSuccessfulSyncAt.get(peerId);
      const lastDisconnected = this.lastSyncDisconnectedAt.get(peerId) ?? 0;
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
      const shortPeer = peerId.slice(-8);
      this.log.info(ctx, `Sync reconciler retrying ${shortPeer} (last success: ${lastOk == null ? 'never' : `${Math.round((now - lastOk) / 1000)}s ago`}${backoff ? `, prior failures: ${backoff.failures}` : ''})`);
      let syncAccountingClearedBackoff = false;
      this.trySyncFromPeer(peerId, () => {
        syncAccountingClearedBackoff = true;
      })
        .then((outcome) => {
          if (outcome === 'skipped-no-sync' || outcome === 'already-syncing' || outcome === 'not-started') {
            return;
          }
          // `onPeerSynced` clears the backoff when a round makes progress or
          // gets a clean denial. Only useful progress writes the cooldown
          // marker; denial-only rounds must remain eligible next tick because
          // a later ACL approval does not emit peer:update/connection:open.
          // If the attempt resolved without advancing either marker, treat it
          // as a genuine sync failure so peer backoff grows unless sync
          // accounting explicitly cleared backoff for this attempt. A peer
          // that still does not advertise PROTOCOL_SYNC is handled above and
          // remains eligible on every reconciler tick, so a missed identify
          // update cannot stretch into a 5/10/20/60-minute delay.
          if (
            !syncAccountingClearedBackoff &&
            this.lastSuccessfulSyncAt.get(peerId) === lastOk &&
            this.lastSyncProgressAt.get(peerId) === lastProgress
          ) {
            this.recordSyncReconcilerFailure(peerId, probe);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof SyncOnConnectPostSyncError) {
            if (err.backoffEligible) {
              this.recordSyncReconcilerFailure(peerId, probe);
            }
            const backoffNote = err.backoffEligible ? 'growing peer backoff' : 'retrying without growing peer backoff';
            this.log.warn(ctx, `Sync reconciler post-sync step failed for ${shortPeer}; ${backoffNote}: ${message}`);
            return;
          }
          this.recordSyncReconcilerFailure(peerId, probe);
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
      log: (ctx, msg) => this.log.info(ctx, msg),
    });
    // Carry the pinned set into the next tick so stale Cores get unpinned.
    this.warmedCores = result.warmed;
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
  ): Promise<number> {
    const result = await this.syncFromPeerDetailed(remotePeerId, contextGraphIds, onPhase, onAccessDenied);
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
  ): Promise<DurableSyncResult> {
    const ctx = createOperationContext('sync');
    return runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds,
      onPhase,
      onAccessDenied,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
      fetchSyncPages: this.fetchSyncPages.bind(this),
      sinceBatchIdFor,
      processDurableBatchInWorker: this.processDurableBatchInWorker.bind(this),
      storeInsert: (quads) => this.store.insert(quads),
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
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
  ): Promise<SyncPageResult> {
    return fetchSyncPages({
      ctx,
      remotePeerId,
      contextGraphId,
      includeSharedMemory,
      phase,
      graphUri,
      snapshotRef,
      sinceBatchId,
      deadline,
      syncPageTimeoutMs: SYNC_PAGE_TIMEOUT_MS,
      syncRouterAttempts: SYNC_ROUTER_ATTEMPTS,
      syncPageRetryAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
      syncPageSize: SYNC_PAGE_SIZE,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      signal,
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
      // response bytes directly, and sync's own `withRetry`
      // (sync-transport.ts) handles retry + backoff. The per-attempt
      // `messageId` minted by sync-transport.ts is now unused by this
      // adapter — harmless, left in place to keep the transport surface
      // stable (reverts rc.9 PR-E for sync only).
      send: async (peerId, protocolId, data, sendTimeoutMs, _messageId, sendSignal) =>
        this.messenger.sendToPeer(peerId, protocolId, data, { timeoutMs: sendTimeoutMs, signal: sendSignal }),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
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

  async syncSharedMemoryFromPeerDetailed(this: DKGAgent,
    remotePeerId: string,
    contextGraphIds: string[],
  ): Promise<SharedMemorySyncResult> {
    const ctx = createOperationContext('sync');
    const allowedContextGraphIds: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      if (await this.canUseSharedMemoryForContextGraph(contextGraphId)) {
        allowedContextGraphIds.push(contextGraphId);
      } else {
        this.log.warn(ctx, `Skipping SWM sync for unauthorized or unconfirmed context graph "${contextGraphId}"`);
      }
    }
    if (allowedContextGraphIds.length === 0) {
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
      };
    }
    const subGraphAdmissionByContextGraph = new Map<string, Promise<{ registered: string[]; excluded: string[] }>>();
    const getSubGraphAdmission = (contextGraphId: string) => {
      let admission = subGraphAdmissionByContextGraph.get(contextGraphId);
      if (!admission) {
        admission = getSharedMemorySubGraphAdmission(this.store, contextGraphId, this.listSubGraphs(contextGraphId));
        subGraphAdmissionByContextGraph.set(contextGraphId, admission);
      }
      return admission;
    };

    return runSharedMemorySync({
      ctx,
      remotePeerId,
      contextGraphIds: allowedContextGraphIds,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
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
      ensureContextGraph: async (contextGraphId) => {
        const graphManager = new GraphManager(this.store);
        await graphManager.ensureContextGraph(contextGraphId);
      },
      storeInsert: (quads) => this.store.insert(quads),
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
  }

  createContextGraphSyncDeadline(this: DKGAgent, remainingContextGraphs: number): number {
    const divisor = Math.max(1, remainingContextGraphs);
    const budgetMs = Math.max(SYNC_MIN_GRAPH_BUDGET_MS, Math.floor(SYNC_TOTAL_TIMEOUT_MS / divisor));
    return Date.now() + budgetMs;
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(this: DKGAgent,
    contextGraphId: string,
    options?: { includeSharedMemory?: boolean; maxPeers?: number; peerRotationKey?: string },
  ): Promise<{
    connectedPeers: number;
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
    dataSynced: number;
    sharedMemorySynced: number;
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
    const isPrivateContextGraph = await this.isPrivateContextGraph(contextGraphId);

    this.trackSyncContextGraph(contextGraphId);

    const preferredPeerId = await this.resolvePreferredSyncPeerId(contextGraphId);
    if (preferredPeerId) {
      await this.ensurePeerConnected(preferredPeerId);
    }

    await this.primeCatchupConnections();

    const orderedPeers = this.selectCatchupPeers(
      [...new Map(
        this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
      ).values()],
      preferredPeerId,
      isPrivateContextGraph,
    );
    const peers = this.selectCatchupPeerWindow(orderedPeers, options);
    const coreCount = orderedPeers.filter((p) => this.knownCorePeerIds.has(p.toString())).length;
    this.log.info(
      ctx,
      `catchup peer order for "${contextGraphId}": preferred=${preferredPeerId ?? 'none'} cores=${coreCount} total=${orderedPeers.length} selected=${peers.length}`,
    );
    return this.runCatchupOverPeers(contextGraphId, includeSharedMemory, peers, {
      connectedPeers: orderedPeers.length,
    });
  }

  selectCatchupPeerWindow(this: DKGAgent,
    peers: Array<{ toString(): string }>,
    options?: { maxPeers?: number; peerRotationKey?: string },
  ): Array<{ toString(): string }> {
    const maxPeers = options?.maxPeers;
    if (maxPeers === undefined || !Number.isInteger(maxPeers) || maxPeers <= 0) {
      return peers;
    }

    if (peers.length <= maxPeers) {
      return peers;
    }

    let start = 0;
    const rotationKey = options?.peerRotationKey;
    if (rotationKey) {
      this.pruneVmReconcileState();
      const peerIds = peers.map((peer) => peer.toString());
      const previousOrder = this.vmReconcileCatchupPeerOrder.get(rotationKey);
      const nextPeerId = previousOrder?.nextPeerId;
      if (nextPeerId) {
        const nextPeerIndex = peerIds.indexOf(nextPeerId);
        if (nextPeerIndex >= 0) {
          const previousPeers = new Set(previousOrder.orderedPeers);
          const hasNewPrioritizedPeer = peerIds
            .slice(0, nextPeerIndex)
            .some((peerId) => !previousPeers.has(peerId));
          start = hasNewPrioritizedPeer ? 0 : nextPeerIndex;
        } else {
          const previousPeers = new Set(previousOrder.orderedPeers);
          const firstNewPeerIndex = peerIds.findIndex((peerId) => !previousPeers.has(peerId));
          start = firstNewPeerIndex >= 0
            ? firstNewPeerIndex
            : (this.vmReconcileCatchupPeerCursor.get(rotationKey) ?? 0) % peers.length;
        }
      } else {
        start = (this.vmReconcileCatchupPeerCursor.get(rotationKey) ?? 0) % peers.length;
      }
      const nextIndex = (start + maxPeers) % peers.length;
      this.vmReconcileCatchupPeerCursor.delete(rotationKey);
      this.vmReconcileCatchupPeerCursor.set(rotationKey, nextIndex);
      this.vmReconcileCatchupPeerOrder.delete(rotationKey);
      this.vmReconcileCatchupPeerOrder.set(rotationKey, {
        orderedPeers: peerIds,
        nextPeerId: peerIds[nextIndex],
      });
    }

    return [...peers.slice(start), ...peers.slice(0, start)].slice(0, maxPeers);
  }

  async runCatchupOverPeers(this: DKGAgent,
    contextGraphId: string,
    includeSharedMemory: boolean,
    peers: Array<{ toString(): string }>,
    stats?: { connectedPeers?: number },
  ): Promise<{
    connectedPeers: number;
    selectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    peersResponded: number;
    peersSucceeded: number;
    dataSynced: number;
    sharedMemorySynced: number;
    denied: boolean;
    deniedPeers: number;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    let syncCapablePeers = 0;
    let peersTried = 0;
    let peersResponded = 0;
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
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
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
    const emptyDurable = (): DurableSyncResult => ({
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
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 1,
      failedPhases: 0,
      deniedPhases: 0,
    });
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
    const results = await Promise.all(syncCapable.map(async (remotePeerId) => {
      const durable = await this.syncFromPeerDetailed(
        remotePeerId,
        [contextGraphId],
      ).catch(emptyDurable);
      const shared = includeSharedMemory
        ? await this.syncSharedMemoryFromPeerDetailed(remotePeerId, [contextGraphId]).catch(emptyShared)
        : null;
      return { durable, shared };
    }));
    let accessDeniedPeers = 0;
    let peersSucceeded = 0;
    for (const r of results) {
      // A peer "succeeded" when its sync round finished without a transport
      // failure/denial and either made phase/checkpoint progress, or cleanly
      // completed with no timeout. Empty responses still count as a
      // legitimate host response, but a no-progress timeout must not make the
      // subscribe/VM catch-up path report a successful peer.
      const durableFailed = r.durable.failedPeers > 0;
      const sharedFailed = r.shared ? r.shared.failedPeers > 0 : false;
      const durablePhaseFailed = (r.durable.failedPhases ?? 0) > 0;
      const sharedPhaseFailed = r.shared ? (r.shared.failedPhases ?? 0) > 0 : false;
      const peerDeniedRound = r.durable.deniedPhases > 0
        || (r.shared ? r.shared.deniedPhases > 0 : false);
      const durableProgress = r.durable.insertedDataTriples > 0
        || r.durable.checkpointAdvances > 0
        || (r.durable.completedPhases > 0 && r.durable.resumedPhases > 0);
      const sharedProgress = r.shared
        ? r.shared.insertedDataTriples > 0
          || r.shared.checkpointAdvances > 0
          || (r.shared.completedPhases > 0 && r.shared.resumedPhases > 0)
        : false;
      const peerMadeProgress = durableProgress || sharedProgress;
      const peerMetadataOnly = !peerMadeProgress && (
        r.durable.insertedMetaTriples > 0
        || r.durable.metaOnlyResponses > 0
        || (r.shared ? r.shared.insertedMetaTriples > 0 : false)
      );
      const peerTimedOut = r.durable.timedOutPhases > 0 || (r.shared ? r.shared.timedOutPhases > 0 : false);
      if (!durableFailed || (r.shared && !sharedFailed)) {
        peersResponded++;
      }
      if (
        !durableFailed &&
        !sharedFailed &&
        !durablePhaseFailed &&
        !sharedPhaseFailed &&
        !peerDeniedRound &&
        (peerMadeProgress || (!peerTimedOut && !peerMetadataOnly))
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
      diagnostics.durable.dataRejectedMissingMeta += r.durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += r.durable.rejectedKcs;
      diagnostics.durable.failedPeers += r.durable.failedPeers;
      diagnostics.durable.failedPhases += r.durable.failedPhases ?? 0;
      let peerDenied = r.durable.deniedPhases > 0;
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
        peerDenied = peerDenied || r.shared.deniedPhases > 0;
      }
      if (peerDenied) accessDeniedPeers++;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers}`,
    );

    await this.refreshMetaSyncedFlags([contextGraphId]);

    if (dataSynced > 0 || sharedMemorySynced > 0) {
      this.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        dataSynced,
        sharedMemorySynced,
      });
    }

    return {
      connectedPeers: stats?.connectedPeers ?? peers.length,
      selectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      peersResponded,
      peersSucceeded,
      dataSynced,
      sharedMemorySynced,
      denied: accessDeniedPeers > 0,
      deniedPeers: accessDeniedPeers,
      diagnostics,
    };
  }

  async primeCatchupConnections(this: DKGAgent): Promise<void> {
    await primeCatchupConnectionsAtom(this.node.libp2p as any, this.discovery, this.peerId);
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

    // Curator-direct attempt. Any throw here (relay reservation gone,
    // dial timeout, AbortSignal, transient `Remote closed connection
    // during opening`) MUST fall through to the broadcast fallback
    // below — wrapping both the curator-direct attempt AND the
    // broadcast in a single try/catch reintroduces the silent-stall
    // bug this method exists to fix (Lex review on PR #517 + Codex).
    try {
      await this.ensurePeerConnected(curatorPeerId);
      const curatorRemote = this.node.libp2p
        .getConnections()
        .find((conn) => conn.remotePeer.toString() === curatorPeerId)?.remotePeer;
      if (curatorRemote) {
        const result = await this.runCatchupOverPeers(contextGraphId, true, [curatorRemote]);
        if (result.peersSucceeded > 0) {
          this.log.info(
            ctx,
            `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} fetched ${result.dataSynced} data + ${result.sharedMemorySynced} SWM triples`,
          );
          curatorTargetSucceeded = true;
        } else {
          this.log.warn(
            ctx,
            `Post-approval sync for "${contextGraphId}" from curator ${curatorShort} produced no successful peer (denied=${result.denied}); falling back to broadcast catchup`,
          );
        }
      } else {
        this.log.warn(
          ctx,
          `Post-approval sync for "${contextGraphId}": curator ${curatorShort} not in connected peers after ensurePeerConnected; falling back to broadcast catchup`,
        );
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
    const preferredPeerId = this.preferredSyncPeers.get(contextGraphId);
    if (preferredPeerId) return preferredPeerId;

    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (curatorPeerId) {
      this.preferredSyncPeers.set(contextGraphId, curatorPeerId);
    }
    return curatorPeerId;
  }

  async ensurePeerConnected(this: DKGAgent, peerId: string): Promise<void> {
    await ensurePeerConnectedAtom(this.node.libp2p as any, this.discovery, peerId);
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
        if (sub.metaSynced !== true) {
          sub.metaSynced = true;
          this.persistContextGraphSubscription(contextGraphId);
        }
        if (sub.pendingMeta) {
          // Meta arrived; the freshly-joined "waiting for sync" state
          // (set by the join-approved handler) no longer applies — the
          // CG will now surface via the normal `_meta` branch in
          // `listContextGraphs`.
          sub.pendingMeta = false;
        }
        this.queueSharedMemoryGossipSubscription(contextGraphId);
      }
    }
  }

  setContextGraphSubscription(this: DKGAgent,
    contextGraphId: string,
    next: ContextGraphSub,
    options?: { persist?: boolean },
  ): ContextGraphSub {
    this.subscribedContextGraphs.set(contextGraphId, next);
    if (!next.subscribed && !next.coreHosted) {
      this.clearVmReconcileStateForContextGraph(contextGraphId);
    }
    if (options?.persist !== false) {
      this.persistContextGraphSubscription(contextGraphId);
      if (next.subscribed) {
        this.persistLocalNodeMembership(contextGraphId);
      } else {
        this.deleteContextGraphMember(contextGraphId, 'node', this.peerId);
      }
    }
    return next;
  }

  markContextGraphSubscriptionState(this: DKGAgent, contextGraphId: string, patch: Partial<ContextGraphSub>): void {
    const existing = this.subscribedContextGraphs.get(contextGraphId);
    if (!existing) return;
    this.setContextGraphSubscription(contextGraphId, { ...existing, ...patch });
  }

  persistContextGraphSubscriptionState(this: DKGAgent, contextGraphId: string): void {
    this.persistContextGraphSubscription(contextGraphId);
  }

  persistContextGraphSubscription(this: DKGAgent, contextGraphId: string): void {
    const store = this.config.contextGraphSubscriptionStore;
    if (!store) return;
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    // Persist member subscriptions AND (Phase D) public CGs this Core hosts —
    // the host-only record MUST survive restart so a Core that was offline
    // during a publish remembers it hosts the CG and fills its gap. Drop the
    // row only when the node neither subscribes to nor hosts the CG.
    if (!sub?.subscribed && !sub?.coreHosted) {
      void store.delete(contextGraphId).catch((err) => {
        this.log.warn(
          createOperationContext('system'),
          `Failed to delete persisted context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }
    void store.save({
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
    }).catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Failed to persist context-graph subscription for "${contextGraphId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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

  upsertContextGraphMember(this: DKGAgent, record: ContextGraphMembershipRecord): void {
    const store = this.config.contextGraphMembershipStore;
    if (!store) return;
    const normalizedRecord = {
      ...record,
      principalId: this.normalizeMembershipPrincipal(record.principalType, record.principalId),
    };
    const updatedAt = Date.now();
    void store.upsert({ ...normalizedRecord, updatedAt }).catch((err) => {
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
      const rows = (await store.loadAll()).filter((r) => !systemContextGraphs.has(r.id));
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
      // on boot. Prioritise subscribed rows within the capped set.
      const hostedRows = rows.filter((r) => r.coreHosted);
      const userRows = [...rows.filter((r) => !r.coreHosted)].sort(
        (a, b) => (b.subscribed ? 1 : 0) - (a.subscribed ? 1 : 0),
      );
      const cappedUserRows = cap > 0 ? userRows.slice(0, cap) : userRows;
      const toActivate = [...hostedRows, ...cappedUserRows];
      for (let i = 0; i < toActivate.length; i++) {
        const row = toActivate[i];
        this.setContextGraphSubscription(row.id, {
          name: row.name,
          subscribed: row.subscribed,
          synced: row.synced,
          sharedMemorySynced: row.sharedMemorySynced,
          metaSynced: row.metaSynced,
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
        // Throttle: yield so concurrent store-backed work (routes, sync) can
        // interleave instead of being starved by a synchronous activation burst.
        if ((i + 1) % REHYDRATE_THROTTLE_BATCH === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      const skipped = userRows.length - cappedUserRows.length;
      if (rows.length > 0) {
        this.log.info(
          ctx,
          `Rehydrated ${toActivate.length} of ${rows.length} persisted context-graph subscription(s)` +
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
            `maxRehydratedContextGraphSubscriptions.`,
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
    const total = persistedUserIds.length;

    // Tear down active in-memory USER subscriptions (gossip topics + sync scope),
    // then REMOVE the registry entry. `unsubscribeFromContextGraph` only flips
    // `subscribed` to false — it keeps the entry for the host-mode/reconcile path
    // — but this recovery endpoint must leave NO trace of the cleared CGs, or
    // read fallbacks would still see the IDs in `subscribedContextGraphs` even
    // though the persisted rows are gone. (activeUserIds already excludes system
    // + coreHosted CGs, so this only drops the cleared non-hosted user entries.)
    for (const id of activeUserIds) {
      try {
        this.unsubscribeFromContextGraph(id);
      } catch {
        /* best-effort teardown */
      }
      this.subscribedContextGraphs.delete(id);
    }

    // Delete the persisted USER rows (active + dormant). Selective — never the
    // system rows — so a custom store without a system-aware bulk delete is safe.
    // Count ACTUAL deletions: a swallowed store.delete() failure must not be
    // reported as cleared, or this recovery endpoint would answer 200 "all
    // gone" while stale rows survive in the store.
    let cleared = persistedUserIds.length;
    let failed = 0;
    if (store) {
      cleared = 0;
      for (const id of persistedUserIds) {
        try {
          await store.delete(id);
          cleared++;
        } catch (err) {
          failed++;
          this.log.warn(
            ctx,
            `clearContextGraphSubscriptions: failed to delete persisted subscription "${id}": ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    this.log.info(
      ctx,
      `Cleared ${cleared} of ${total} persisted user context-graph subscription(s)` +
        (failed > 0 ? ` (${failed} failed to delete — see warnings)` : '') +
        `; tore down ${activeUserIds.length} active in-memory subscription(s); system context graphs preserved`,
    );
    return cleared;
  }

  async hasConfirmedMetaState(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return true;
    }

    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const metaResult = await this.store.query(
      `ASK WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (metaResult.type === 'boolean' && metaResult.value === true) {
      return true;
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
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
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
  ): Promise<import('./sync-verify-worker.js').DurableBatchProcessResult> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.processDurableBatch(dataQuads, metaQuads, acceptUnverified);
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
        const wsGraph = contextGraphWorkspaceGraphUri(pid);
        const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(pid);
        let graphDeleted = 0;

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
          const wsGraphs = (await this.store.listGraphs()).filter(g => g === wsGraph || g.startsWith(`${wsGraph}/`));
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

          // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
          const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
          graphDeleted += metaDeleted;

          for (const re of rootEntities) {
            const ownerDeleted = await this.store.deleteByPattern({
              graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
            graphDeleted += ownerDeleted;
          }

          const ownedSet = this.workspaceOwnedEntities.get(pid);
          if (ownedSet) {
            for (const re of rootEntities) {
              ownedSet.delete(re);
            }
          }
        }

        totalDeleted += graphDeleted;
        if (expiredOps.bindings.length > 0) {
          this.log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOps.bindings.length} expired operation(s), ${graphDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return totalDeleted;
  }

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
