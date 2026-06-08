// SPDX-License-Identifier: Apache-2.0

/**
 * Publish / share write-pipeline extracted from dkg-agent.ts as a mixin
 * holder: gossip publish, publishAsync/_publish, update/share/conditionalShare,
 * assertionFinalize + precomputed attestation, curated-key + inline-encrypt
 * resolution, publishFrom{FinalizedAssertion,SharedMemory}, and the on-chain
 * register/batch/identity entrypoints. Bodies are a 1:1 move; methods take
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
  contextGraphVerifiedMemoryUri, contextGraphVerifiedMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  contextGraphLayerUri,
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
  buildAuthorAttestationTypedData, buildUpdateAuthorAttestationTypedData, AUTHOR_SCHEME_VERSION_V1, type AuthorAttestationTypedData,
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
  // OT-RFC-43 A2 — per-layer pointer + KA-id predicates and stamp helpers.
  KA_ID_PRED, RESERVED_UAL_PRED,
  WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED, VM_CURRENT_ASSERTION_PRED,
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
import { reconcileContextGraph, ReconcileCoalescer, RecentUalSet, type ChainReconcilerDeps, type OrdinalOutcome } from './chain-reconciler.js';
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

export class PublishMethods extends DKGAgentBase {
  async publishWorkspaceGossip(this: DKGAgent,
    contextGraphId: string,
    message: Uint8Array,
    ctx: OperationContext,
    resolvedSigner?: (AgentKeyRecord & { privateKey: string }) | null,
    /**
     * Publisher-minted unique share ID. When provided, this share
     * is registered with `SwmAckQuorum` after fan-out so the
     * watchdog can fire substrate top-up if gossip-side acks
     * don't reach quorum within `watchdogMs`. Omitted by
     * callers that aren't tracking per-share delivery (legacy
     * code paths and tests); the share still publishes
     * identically — only the quorum tracking is skipped.
     *
     * The cheapest way to keep backward compat with the existing
     * three call sites: ONLY `share()` provides this for now.
     * `liftToShared` / `sharedMemoryCAS` can add it in a
     * follow-up if/when soak shows their share types benefit
     * from quorum tracking too.
     */
    shareOperationId?: string,
  ): Promise<void> {
    // OT-RFC-38 / LU-6 Phase B — derive the wire-form id ONCE at the
    // publish-side boundary and use it consistently across the topic,
    // envelope, and signing payload. The curator's local id stays
    // cleartext for everything inside the agent (display, CLI, meta-
    // graph queries). On the wire, only the hash leaves the node.
    //
    // If `contextGraphId` has no recorded wire id (e.g. pre-Phase-B
    // CG, or a CG created locally but not yet registered), the helper
    // falls back to computing `keccak256(bytes(contextGraphId))`
    // deterministically — so members can fan out a share immediately
    // after `createContextGraph()` and before `registerContextGraph()`
    // / a beacon broadcast, and the receivers who derive the wire id
    // the same way meet them on the right topic.
    // OT-RFC-38 / LU-6 Phase B compromise — the gossip TOPIC uses the
    // wire-form (hash) id so hosting cores can auto-subscribe via the
    // chain-event path without ever learning cleartext, but the
    // ENVELOPE itself still carries cleartext in `contextGraphId`.
    // Rationale: keeping cleartext inside the envelope preserves the
    // existing inner-vs-envelope id consistency check (curator can't
    // hijack CG-B with CG-A's encrypted payload), and lets the
    // receiver's meta-graph queries (`getContextGraphAgentGateAddresses`,
    // `getContextGraphAllowedPeers`, etc.) hit member-side local
    // triples directly without a hash → cleartext translation.
    //
    // The trade-off: subscribed hosting cores learn the cleartext CG
    // name even though they can't read the encrypted payload. For
    // curated CGs the DATA is encrypted, so this leaks only the CG's
    // human-readable label, not its contents. A follow-up iteration
    // can migrate the envelope id to hash and add a translation layer
    // (inner senderKey.contextGraphId hashed before the consistency
    // check, agent-gate queries take a `wireToLocalCg` injection) once
    // the freemium-tier launch baseline has stabilised.
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const topic = contextGraphWorkspaceTopic(wireCgId);
    const signer = resolvedSigner === undefined
      ? await this.resolveWorkspaceGossipSigningAgent(contextGraphId)
      : resolvedSigner;
    const wireMessage = await this.encodeWorkspaceGossipMessage(contextGraphId, message, signer);

    // rc.9 PR-C (SWM reliable fan-out plan, Step 3): tier-switch
    // between substrate fan-out (point-to-point reliable via
    // /dkg/10.0.1/swm-update) and GossipSub mesh based on CG
    // membership shape. See `chooseFanOutTier` jsdoc + RFC-003 §6
    // for the full policy. Both legs run when the policy says so
    // — receiver-side dedup via SharedMemoryHandler's seenShareOps
    // (PR-A) absorbs the resulting double-delivery cleanly and
    // PR-A's `swm.redundantApplies` gauge makes it observable.
    //
    // Enumeration cost: at most one SPARQL query + one
    // getSubscribers() call per CG per 60s window (enumerator
    // caches). Independent of share rate.
    //
    // Errors are intentionally NOT re-thrown — share() in the
    // caller already committed locally; transport failures here
    // become observable via /api/slo (gossip.publishFailures +
    // swm.substrateFanout) and the next sync-on-reconnect is the
    // ultimate safety net.
    //
    // PR-C Codex R1 (planning-throw safety): `enumerate()` calls
    // `getContextGraphAllowedPeers()` + `isPrivateContextGraph()`
    // which both run SPARQL queries against `this.store`. A
    // triple-store query failure (worker timeout, transient
    // backend hiccup, corrupt graph) would otherwise bubble out
    // of `publishWorkspaceGossip` and reject `share()` AFTER the
    // local commit already succeeded — silently changing the
    // pre-PR-C "share() never re-throws on transport failure"
    // contract. Wrap planning in the same swallow-and-log shell
    // as the gossip publish: on throw, fall back to a gossip-only
    // plan (exactly the pre-PR-C behaviour for this share). The
    // next share to the same cgId pays the SPARQL retry; the
    // 60s enumeration cache means a one-off blip is recovered on
    // the next call.
    let plan: FanOutPlan;
    try {
      const enumeration = await this.getOrCreateCGMemberEnumerator().enumerate(contextGraphId);
      plan = chooseFanOutTier({
        enumeration,
        maxSubstrateMembers: this.swmSubstrateMaxMembers,
      });
    } catch (err) {
      const errClass = err instanceof Error
        ? (err.name && err.name !== 'Error' ? err.name : err.constructor.name)
        : typeof err;
      const errMessage = err instanceof Error ? err.message : String(err);
      this.log.warn(
        ctx,
        `SWM fan-out planning FAILED for cgId=${contextGraphId} errorClass="${errClass}" error="${errMessage}" — falling back to gossip-only (pre-PR-C behaviour)`,
      );
      plan = {
        useSubstrate: false,
        useGossip: true,
        substrateMembers: [],
        enumeratedMembers: [],
        enumerationSource: 'none',
        enumeratedCount: 0,
      };
    }

    // rc.9 PR-D codex follow-up #D5 (rebased onto PR-G's G2
    // detach): register the SwmAckQuorum tracker BEFORE
    // substrate + gossip fire so a fast receiver's
    // PROTOCOL_SWM_SHARE_ACK arrival lands against a known
    // shareOperationId.
    //
    // Pre-D5 the track call ran AFTER `Promise.all([substrate,
    // gossip])`, so a fast receiver could:
    //   1. apply the gossip payload,
    //   2. send PROTOCOL_SWM_SHARE_ACK back to us,
    //   3. our handler runs `swmAckQuorum.onAck(opId, peer)`,
    //   4. but the record doesn't exist yet → ack DROPPED,
    //   5. quorum stays short → spurious watchdog top-up fires.
    //
    // PR-G's G2 detach made that race even tighter since
    // share() now returns BEFORE substrate finishes. Tracking
    // up-front side-steps both — the quorum record is alive
    // the moment any wire packet leaves this method.
    //
    // We track with `preAckedFromSubstrate: []` and pipe
    // substrate-delivered peers into the quorum via the
    // bookkeeper instead — they go through `onAck()` exactly
    // like gossip-applied receivers do, so the quorum
    // arithmetic is identical regardless of which transport
    // delivered first.
    //
    // Three preconditions for tracking:
    //   1. Caller supplied a shareOperationId (`share()` does;
    //      legacy callers don't).
    //   2. The plan ran a gossip leg — SwmShareAck only covers
    //      gossip-applied receivers. A hypothetical future
    //      no-gossip / substrate-only plan would already cover
    //      quorum via PR-C's substrate counters.
    //   3. We have at least one ack-roundtrip-eligible peer
    //      (`plan.substrateMembers.length > 0`). PR-K change:
    //      pre-PR-K keyed off `plan.enumeratedMembers.length` to
    //      keep the gossip-only-too-many-subscribers branch
    //      tracking (PR-D #D3, codex RED #3 on PR #584), on the
    //      assumption that any gossip-deliverable peer can ALSO
    //      send a SwmShareAck back. The 2026-05-18 Miles<->Lex
    //      soak refuted that assumption: when both peers have
    //      only limited Circuit Relay V2 connectivity, gossip
    //      delivery works (mesh-forwarded, no reservation
    //      budget consumed) but `messenger.sendReliable` for
    //      `/dkg/10.0.1/swm-share-ack` exhausts the limited
    //      reservation just like substrate fan-out does — the
    //      ack never returns. With ack-quorum keyed to
    //      enumeratedMembers, those shares stayed `pending` for
    //      the full deadlineHardMs window then hit
    //      `deadlineExpired`, making `completed=0` indefinitely
    //      even though delivery actually worked.
    //
    //      Switching to `substrateMembers` collapses the
    //      visibility model: ack-quorum now tracks the subset
    //      we can substrate-roundtrip-eligible with (= same
    //      reachability the `isPeerDialable` predicate accepts
    //      after PR-K's limited-circuit filter). For CGs whose
    //      eligible set is empty (all subscribers behind
    //      limited relays), we publish via gossip and skip
    //      quorum tracking entirely — gossip is best-effort,
    //      we don't pretend we can verify those deliveries.
    //      Cross-peer SWM-inbox SPARQL remains the ground-truth
    //      check.
    const ackQuorumActive = !!shareOperationId
      && plan.useGossip
      && plan.substrateMembers.length > 0;
    let trackedQuorum: SwmAckQuorum | null = null;
    if (ackQuorumActive && shareOperationId) {
      trackedQuorum = this.getOrCreateSwmAckQuorum();
      trackedQuorum.track({
        shareOperationId,
        cgId: contextGraphId,
        expectedMembers: plan.substrateMembers,
        preAckedFromSubstrate: [],
        payload: wireMessage,
        enumerationSource: plan.enumerationSource,
      });
    }

    // rc.9 PR-G #G2: substrate fan-out is detached from the
    // share() critical path — share() awaits only the gossip
    // publish (fast). Substrate runs in the background and
    // feeds per-peer outcomes through the bookkeeper as each
    // send completes. The bookkeeper does double duty:
    //   1. Bump per-(cgId, outcome) counters for /api/slo.
    //   2. (PR-D #D5) Feed substrate-`delivered` peers into
    //      the quorum via onAck so they count toward the same
    //      quorum target as gossip-side acks.
    if (plan.useSubstrate) {
      const baseBookkeeper = this.substrateFanoutBookkeeper();
      // PR-J: capture per-peer outcomes for the optional detail
      // line emitted when anything queues/fails/is rejected. Lets
      // operators see WHICH peer is failing rather than just an
      // aggregate "queued=4" with no way to attribute it.
      const perPeerDetail: { peerId: string; outcome: string; error: string }[] = [];
      const substratePromise: Promise<void> = (async () => {
        try {
          const substrateResult = await executeSubstrateFanOut({
            contextGraphId,
            protocolId: PROTOCOL_SWM_UPDATE,
            payload: wireMessage,
            members: plan.substrateMembers,
            sendTimeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS,
            substrate: this.messenger,
            bookkeeper: {
              recordOutcome: (cgId, record) => {
                if (
                  trackedQuorum
                  && shareOperationId
                  && record.outcome === 'delivered'
                ) {
                  trackedQuorum.onAck(shareOperationId, record.peerId);
                }
                if (
                  record.outcome === 'queued'
                  || record.outcome === 'failed'
                  || record.outcome === 'rejected'
                  || record.outcome === 'retryable'
                ) {
                  perPeerDetail.push({
                    peerId: record.peerId,
                    outcome: record.outcome,
                    error: record.error,
                  });
                }
                baseBookkeeper.recordOutcome(cgId, record);
              },
            },
          });
          this.log.info(
            ctx,
            `SWM substrate fan-out cgId=${contextGraphId} source=${plan.enumerationSource} `
            + `enumerated=${plan.enumeratedCount} `
            + `attempted=${substrateResult.attempted} `
            + `delivered=${substrateResult.delivered} rejected=${substrateResult.rejected} `
            + `retryable=${substrateResult.retryable} `
            + `queued=${substrateResult.queued} `
            + `inFlight=${substrateResult.inFlight} failed=${substrateResult.failed} `
            + `also_gossiped=${plan.useGossip}`,
          );
          // PR-J per-peer detail. Logged at WARN so it surfaces in
          // operator dashboards that filter by level (the aggregate
          // INFO line is the steady-state observability; this is the
          // "something's wrong, here's who" follow-up).
          if (perPeerDetail.length > 0) {
            const summary = perPeerDetail
              .map((d) => `${d.peerId.slice(-12)}=${d.outcome}` + (d.error ? `(${d.error.slice(0, 80)})` : ''))
              .join(' ');
            this.log.warn(
              ctx,
              `SWM substrate fan-out non-delivered detail cgId=${contextGraphId} peers=[${summary}]`,
            );
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(
            ctx,
            `SWM substrate fan-out cgId=${contextGraphId} threw out of allSettled boundary: ${reason}`,
          );
        }
      })();
      const tracked = substratePromise.finally(() => {
        this.inFlightSubstrateFanOuts.delete(tracked);
      });
      this.inFlightSubstrateFanOuts.add(tracked);
    }

    if (plan.useGossip) {
      await this.publishViaGossip(contextGraphId, topic, wireMessage, ctx);
    }

    if (!plan.useSubstrate && plan.enumerationSource === 'topic-subscribers' && plan.enumeratedCount > this.swmSubstrateMaxMembers) {
      // Public CG above the threshold: gossip-only. Surface the
      // gate trip at INFO so soak postmortems can correlate share
      // delivery against transport choice without grepping for
      // a separate decision log.
      this.log.info(
        ctx,
        `SWM gossip-only (public CG above substrate cap) cgId=${contextGraphId} `
        + `enumerated=${plan.enumeratedCount} cap=${this.swmSubstrateMaxMembers}`,
      );
    }
  }

  /**
   * Pre-rc.9-PR-C body of `publishWorkspaceGossip` — the
   * GossipSub publish + loud-fail counter from PR-A. Extracted
   * into a named helper so the tier-switch above can call it
   * conditionally (alongside or instead of the substrate fan-out
   * leg) without duplicating the failure-bookkeeping logic.
   */
  async publishViaGossip(this: DKGAgent,
    contextGraphId: string,
    topic: string,
    wireMessage: Uint8Array,
    ctx: OperationContext,
  ): Promise<void> {
    try {
      await this.gossip.publish(topic, wireMessage);
    } catch (err) {
      // rc.9 PR-A (SWM reliable fan-out plan, Step 0): replace the
      // pre-rc.9 silent log.warn with a structured failure record so
      // operators can see exactly which shares dropped. The local SWM
      // commit already happened in the caller; on-connect-sync will
      // catch remote peers up eventually. We intentionally do NOT
      // re-throw — share() should still return success because the
      // local commit succeeded — but the failure becomes observable
      // via the new /api/slo `gossip.publishFailures` counter and the
      // WARN log now carries the cgId + error class + error message
      // for greppability (Codex PR #570 R6: previously the comment
      // claimed "error class" but the implementation only logged
      // err.message, collapsing distinct failure types).
      // Codex PR #570 R12: source the running failure count from
      // `recordSwmGossipPublishFailure`'s return value, not by
      // re-reading the map. Pre-fix, when the just-incremented
      // entry was itself the smallest and got evicted into the
      // overflow bucket on the very same call, the subsequent
      // map.get() returned 0 (or an older count for a recycled
      // cgId), producing misleading `failureCountForCg=0` log lines
      // for a cgId that had just failed. We now log the actual
      // post-increment count, and flag the overflow case explicitly
      // so operators can see why the per-cgId breakdown in
      // /api/slo's `gossip.publishFailures` may not show this cgId.
      const { failureCountForCg, evictedToOverflow } = this.recordSwmGossipPublishFailure(contextGraphId);
      const errClass = err instanceof Error
        ? (err.name && err.name !== 'Error' ? err.name : err.constructor.name)
        : typeof err;
      const errMessage = err instanceof Error ? err.message : String(err);
      const overflowSuffix = evictedToOverflow
        ? ' (evicted to overflow bucket; per-cgId breakdown truncated)'
        : '';
      this.log.warn(
        ctx,
        `Gossip publish FAILED for topic="${topic}" cgId=${contextGraphId} errorClass="${errClass}" error="${errMessage}" failureCountForCg=${failureCountForCg}${overflowSuffix}`,
      );
    }
  }

  /**
   * PR-A R5+R8: bookkeep a gossip-publish failure with a hard cap on
   * the per-cgId tracking set. Once we cross
   * SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS distinct cgIds, the entry
   * with the GLOBAL smallest count is evicted into
   * `swmGossipPublishFailuresOverflow` and a sticky
   * `swmGossipPublishFailuresTruncated` flag is set so /api/slo can
   * surface "the per-cgId breakdown is partial; total count is still
   * accurate". This keeps the most-failing cgIds visible
   * (operationally what operators care about) while bounding memory /
   * response size.
   *
   * Codex PR #570 R8: the eviction comparison MUST include the
   * just-incremented entry. Otherwise a stream of one-off failures
   * against fresh cgIds (count=1 each) would each evict an existing
   * HOT cgId (count>=2), even though the new entry is by definition
   * the smallest. With this comparison, when the new entry IS the
   * smallest, it's the one that gets evicted into overflow — leaving
   * the existing hot spots intact, exactly what operators want.
   *
   * Codex PR #570 R12: returns the post-increment count and an
   * `evictedToOverflow` flag so the caller's WARN log accurately
   * reflects what just happened without having to re-read the map
   * (which is stale if THIS cgId was the one evicted into the
   * overflow bucket on the same call).
   */
  recordSwmGossipPublishFailure(this: DKGAgent, contextGraphId: string): {
    failureCountForCg: number;
    evictedToOverflow: boolean;
  } {
    const next = (this.swmGossipPublishFailures.get(contextGraphId) ?? 0) + 1;
    this.swmGossipPublishFailures.set(contextGraphId, next);
    let evictedToOverflow = false;
    if (this.swmGossipPublishFailures.size > DKGAgentBase.SWM_GOSSIP_FAILURE_MAX_TRACKED_CGS) {
      let smallestCg: string | null = null;
      let smallestCount = Infinity;
      for (const [cg, count] of this.swmGossipPublishFailures) {
        if (count < smallestCount) {
          smallestCount = count;
          smallestCg = cg;
        }
      }
      if (smallestCg !== null) {
        this.swmGossipPublishFailures.delete(smallestCg);
        this.swmGossipPublishFailuresOverflow += smallestCount;
        if (!this.swmGossipPublishFailuresTruncated) {
          this.swmGossipPublishFailuresTruncated = true;
        }
        if (smallestCg === contextGraphId) {
          evictedToOverflow = true;
        }
      }
    }
    return { failureCountForCg: next, evictedToOverflow };
  }

  async publishAsync(this: DKGAgent,
    contextGraphIdOrUal: string,
    content: PublishAsyncContent,
    opts?: PublishAsyncOpts,
  ): Promise<{ captureID: string }> {
    const contextGraphId = normalizePublishContextGraphId(contextGraphIdOrUal);
    const ctx = opts?.operationCtx ?? createOperationContext('publish');

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new ContextGraphNotFoundError(contextGraphId);
    }

    // Validate caller-controlled options before workspace staging so a rejected publishAsync leaves no orphan data.
    if (opts?.preSignedAuthorAttestation !== undefined) {
      if (opts?.authorAgentAddress !== undefined) {
        throw new Error('publishAsync: preSignedAuthorAttestation and authorAgentAddress are mutually exclusive');
      }
      if (opts?.authorSignTypedData !== undefined) {
        throw new Error('publishAsync: preSignedAuthorAttestation and authorSignTypedData are mutually exclusive');
      }
    }
    if (opts?.authorSignTypedData !== undefined && opts?.authorAgentAddress === undefined) {
      throw new Error('publishAsync: authorSignTypedData requires authorAgentAddress');
    }
    if (opts?.authorAgentAddress != null && opts.authorSignTypedData == null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(`publishAsync: ${opts.authorAgentAddress} is not a registered local agent`);
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `publishAsync: agent ${opts.authorAgentAddress} is self-sovereign — supply ` +
            'authorSignTypedData callback or preSignedAuthorAttestation instead',
        );
      }
    }

    let publicQuads: Quad[];
    let privateQuads: Quad[];
    try {
      if (isPublishAsyncQuadEnvelope(content)) {
        publicQuads = assertQuadArray(content.publicQuads, 'publicQuads');
        privateQuads = assertQuadArray(content.privateQuads, 'privateQuads');
      } else {
        const parsed = await jsonLdToQuads(content as JsonLdContent, {
          defaultVisibility: 'private',
          syntheticPrivateAnchor: false,
        });
        publicQuads = parsed.publicQuads;
        privateQuads = parsed.privateQuads;
      }
    } catch (err) {
      if (err instanceof InvalidContentError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new InvalidContentError(`Invalid JSON-LD content: ${message}`);
    }

    if (publicQuads.length === 0 && privateQuads.length === 0) {
      throw new InvalidContentError('Content must include at least one public or private payload');
    }

    const partitioned = partitionPublishAsyncQuads(publicQuads, privateQuads);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(
      contextGraphId,
      partitioned.publicQuads,
      {
        publisherPeerId: this.peerId,
        operationCtx: ctx,
        subGraphName: opts?.subGraphName,
        localOnly: opts?.localOnly,
        senderAgentAddress: gossipSigner?.agentAddress,
      },
    );

    if (partitioned.privateQuadsByRoot.size > 0) {
      const privateStore = new PrivateContentStore(this.store, new GraphManager(this.store));
      for (const [rootEntity, rootPrivateQuads] of partitioned.privateQuadsByRoot) {
        await privateStore.storePrivateTriplesForOperation(
          contextGraphId,
          shareOperationId,
          rootEntity,
          rootPrivateQuads,
          opts?.subGraphName,
        );
      }
    }

    const liftRequestDraft = {
      swmId: shareOperationId,
      shareOperationId,
      roots: partitioned.roots,
      contextGraphId,
      namespace: opts?.namespace ?? 'async-publish',
      scope: opts?.scope ?? 'context-graph',
      transitionType: opts?.transitionType ?? 'CREATE',
      authority: opts?.authority ?? { type: 'owner', proofRef: `urn:dkg:publish-async:${shareOperationId}` },
      priorVersion: opts?.priorVersion,
      subGraphName: opts?.subGraphName,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      entityProofs: opts?.entityProofs,
      publishEpochs: opts?.publishEpochs,
      // Stringify bigint for JSON-safe persistence; preserve `0n` (mode d).
      publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride !== undefined
        ? (opts.publisherNodeIdentityIdOverride.toString() as `${bigint}`)
        : undefined,
    } as const;

    // Seal-build: caller-callback errors propagate; daemon-internal misses degrade to sealless (sync `_publish` parity).
    let seal: LiftRequestAuthorSeal | undefined;
    if (opts?.preSignedAuthorAttestation) {
      seal = preSignedAttestationToLiftSeal(opts.preSignedAuthorAttestation);
    } else if (opts?.authorSignTypedData !== undefined) {
      seal = await this.buildAsyncLiftSeal(liftRequestDraft, opts?.authorAgentAddress, opts.authorSignTypedData);
    } else {
      try {
        seal = await this.buildAsyncLiftSeal(liftRequestDraft, opts?.authorAgentAddress, undefined);
      } catch (err) {
        this.log.warn(ctx, `Async seal mint failed; on-chain publish will fall back to tentative: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(this.store, {
      publicSnapshotStore: this.publicSnapshotStore,
    });
    const captureID = await asyncPublisher.lift({
      ...liftRequestDraft,
      ...(seal !== undefined ? { seal } : {}),
    });

    if (!opts?.localOnly) {
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner);
    }

    return { captureID };
  }

  /** Build the EIP-712 author seal for the lift request. Runs the same
   *  canonicalization + subtraction pipeline as the publisher so the
   *  merkle matches at processNext-time. Returns undefined on non-V10 chains. */
  async buildAsyncLiftSeal(this: DKGAgent,
    request: {
      readonly contextGraphId: string;
      readonly subGraphName?: string;
      readonly shareOperationId: string;
      readonly roots: readonly string[];
      readonly namespace: string;
      readonly scope: string;
      readonly transitionType: LiftTransitionType;
      readonly authority: LiftAuthorityProof;
      readonly priorVersion?: string;
      readonly accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      readonly allowedPeers?: readonly string[];
      readonly swmId: string;
    },
    authorAgentAddress?: string,
    authorSignTypedData?: (typedData: AuthorAttestationTypedData) => Promise<{ r: Uint8Array; vs: Uint8Array }>,
  ): Promise<LiftRequestAuthorSeal | undefined> {
    if (this.chain.isV10Ready?.() !== true) return undefined;
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

    const onChainId = await this.getContextGraphOnChainId(request.contextGraphId);
    if (onChainId == null) return undefined; // CG not on-chain — publisher goes tentative


    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsLifecycleAddress();
    if (chainId === undefined || kav10Address === undefined) return undefined;

    const graphManager = new GraphManager(this.store);
    const resolved = await resolveLiftWorkspaceSlice({
      request,
      store: this.store,
      graphManager,
      publicSnapshotStore: this.publicSnapshotStore,
    });

    // Rewrite raw root URIs (urn:uuid:…) → canonical (dkg:cg:ns:scope/…-hash).
    const validated = validateLiftPublishPayload({
      request: { ...request, authority: request.authority } as LiftRequest,
      resolved,
    });

    // Strip already-finalized quads (no-op for non-CREATE). Matches publisher.
    const subtracted = await subtractFinalizedExactQuads({
      store: this.store,
      graphManager,
      request: { ...request, authority: request.authority } as LiftRequest,
      validation: validated.validation,
      resolved: validated.resolved,
    });

    // Full overlap → publisher returns noop without checking the seal.
    if (
      subtracted.resolved.quads.length === 0 &&
      (subtracted.resolved.privateQuads?.length ?? 0) === 0
    ) {
      return undefined;
    }

    const canonical = canonicalPublishPayload(
      subtracted.resolved.quads,
      subtracted.resolved.privateQuads ?? [],
    );

    // Resolve author: callback → custodial keystore → publisher fallback. User-input pre-validated in publishAsync entry.
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    if (authorSignTypedData !== undefined) {
      authorAddress = authorAgentAddress as string;
    } else if (authorAgentAddress != null) {
      signerPrivateKey = this.getCustodialAgentPrivateKey(authorAgentAddress);
      if (!signerPrivateKey) return undefined;
      authorAddress = authorAgentAddress;
    } else {
      const fallback = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallback) return undefined;
      authorAddress = fallback;
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: BigInt(onChainId),
      merkleRoot: canonical.kcMerkleRoot,
      authorAddress,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });

    const { r, vs } = await (
      authorSignTypedData !== undefined
        ? authorSignTypedData(typedData)
        : signerPrivateKey
          ? signWithPrivateKey(signerPrivateKey, typedData)
          : this.publisher.signAuthorAttestationAsPublisher(typedData)
    );

    return {
      merkleRoot: ethers.hexlify(canonical.kcMerkleRoot) as `0x${string}`,
      authorAddress: authorAddress as `0x${string}`,
      signature: {
        r: ethers.hexlify(r) as `0x${string}`,
        vs: ethers.hexlify(vs) as `0x${string}`,
      },
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    };
  }

  async _publish(this: DKGAgent,
    contextGraphId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: PublishOpts,
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to context graph "${contextGraphId}" with ${quads.length} triples`);

    const isSystem = contextGraphId === SYSTEM_CONTEXT_GRAPHS.AGENTS || contextGraphId === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY;
    if (!isSystem) {
      const exists = await this.contextGraphExists(contextGraphId);
      if (!exists) {
        throw new Error(
          `Context graph "${contextGraphId}" does not exist. Create it first with createContextGraph().`,
        );
      }
    }
    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    const onChainId = await this.getContextGraphOnChainId(contextGraphId);

    // RFC-001 §9.x — sign-at-creation. The publisher refuses on-chain
    // publishes without a `precomputedAttestation`, so the agent
    // mints one here at the publish boundary using the publisher
    // fallback signer (legacy `agent.publish(quads)` callers don't
    // carry author identity hints — mode (a) of Phase 4: daemon signs
    // as itself). The seal binds (chainId, kav10Address,
    // contextGraphId, merkleRoot, authorAddress); any drift between
    // the agent-computed merkleRoot and the publisher's recompute
    // surfaces as the publisher's `expectedMerkleRoot mismatch`
    // guard. Skip when the chain isn't V10-capable or the CG isn't
    // on-chain — the publisher will go tentative anyway.
    let precomputedAttestation: PublishOptions['precomputedAttestation'];
    if (
      onChainId != null &&
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
    ) {
      try {
        precomputedAttestation = await this._buildPrecomputedAttestationForSelection(
          contextGraphId,
          quads,
          {
            targetOnChainCgId: onChainId,
            // Round 4 review §11 — propagate privateQuads so the
            // pre-seal merkle includes their per-entity private roots
            // (the publisher computes `kcMerkleRoot` over public
            // leaves + privateRoots; without this, every V10 publish
            // with private content silently downgrades to tentative on
            // the publisher's `expectedMerkleRoot` guard).
            privateQuads,
          },
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `Inline seal mint failed; on-chain publish will fall back to tentative: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // OT-RFC-38 / LU-5 — curated CG ACK payloads ship as AEAD ciphertext
    // (see _resolveEncryptInlinePayload jsdoc for the chainKey resolution).
    // Direct `publish()` (non-SWM path) needs the same protection — without
    // it cores would still see plaintext for curated direct-publish, which
    // defeats the point. PublishOpts here doesn't carry an explicit
    // authorAgentAddress, so we let _resolveEncryptInlinePayload fall back
    // to `defaultAgentAddress ?? peerId`.
    //
    // Codex PR #608 R2 #12: thread the target on-chain CG id through so
    // the AEAD key derives from the canonical id consumers will use to
    // verify/decrypt the published KC. Falls back to the source id when
    // there's no remap, which is the common case.
    const encryptInlinePayload = await this._resolveEncryptInlinePayload(
      contextGraphId,
      opts?.subGraphName,
      undefined,
      onChainId ?? undefined,
    );
    // OT-RFC-38 LU-11 — also resolve the chunked emitter for curated
    // CGs. When set, the publisher prefers this path: chunks fan out
    // via SWM gossip and the V2 ACK carries only the commitment.
    // Public CGs short-circuit to `undefined` here just like the
    // single-blob resolver above.
    const encryptInlineChunked = await this._resolveEncryptInlineChunked(
      contextGraphId,
      opts?.subGraphName,
      undefined,
      onChainId ?? undefined,
    );

    const result = await this.publisher.publish({
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      subGraphName: opts?.subGraphName,
      operationCtx: ctx,
      onPhase,
      v10ACKProvider,
      publishContextGraphId: onChainId ?? undefined,
      publishEpochs: opts?.publishEpochs,
      precomputedAttestation,
      encryptInlinePayload,
      encryptInlineChunked,
    });

    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(contextGraphId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kaId=${result.kaId}`);
    return result;
  }

  async update(this: DKGAgent,
    kaId: bigint, contextGraphId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: {
      onPhase?: PhaseCallback;
      operationCtx?: OperationContext;
      precomputedUpdateAttestation?: PublishOptions['precomputedUpdateAttestation'];
    },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kaId=${kaId} in context graph "${contextGraphId}" with ${quads.length} triples`);
    // GH #842: thread the on-chain cgId so the publisher can promote the update
    // payload into the per-cgId partition the RS prover reads. Without it,
    // updated KAs stay unprovable (data-corrupted / leaf-count-mismatch).
    // Best-effort: a store/ontology failure here must NOT abort the on-chain
    // update — the RS sync is a downstream concern and the unguarded await
    // would let any local lookup error tank the entire update RPC (Codex
    // review #3 on PR #845).
    let updateOnChainId: string | null = null;
    try {
      updateOnChainId = await this.getContextGraphOnChainId(contextGraphId);
    } catch (err) {
      this.log.warn(
        ctx,
        `Failed to resolve on-chain cgId for "${contextGraphId}" prior to update; per-cgId RS promotion will be skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // V10 UPDATE StorageACK quorum. Wired here so BOTH update entry points
    // reach it: the public `agent.update(...)` API and the A2 create-vs-
    // update branch in `publishFromFinalizedAssertion` (which calls
    // `this.update(...)`). The provider resolves the on-chain digest
    // fields inside the publisher (via `chain.getUpdateAckDigestFields`)
    // and collects core-node ACKs over `PROTOCOL_STORAGE_UPDATE_ACK`. The
    // numeric on-chain cgId (`updateOnChainId`) is the ACK domain; we fall
    // back to the cleartext `contextGraphId` only when the on-chain id
    // could not be resolved (the provider re-resolves the digest cgId from
    // the adapter regardless, so the digest TARGET stays chain-truth).
    const v10UpdateACKProvider = this.createV10UpdateACKProvider(updateOnChainId ?? contextGraphId);
    const result = await this.publisher.update(kaId, {
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.node.peerId.toString(),
      publishContextGraphId: updateOnChainId ?? undefined,
      operationCtx: ctx,
      onPhase,
      precomputedUpdateAttestation: opts?.precomputedUpdateAttestation,
      v10UpdateACKProvider,
    });
    this.log.info(ctx, `Update complete — status=${result.status}`);

    onPhase?.('broadcast', 'start');
    if (result.onChainResult && result.publicQuads) {
      try {
        const dataGraph = `did:dkg:context-graph:${contextGraphId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          contextGraphId: contextGraphId,
          batchId: kaId,
          nquads: nquadsBytes,
          manifest: result.kaManifest.map((m) => ({
            rootEntity: m.rootEntity,
            privateMerkleRoot: m.privateMerkleRoot,
            privateTripleCount: m.privateTripleCount ?? 0,
          })),
          publisherPeerId: this.node.peerId.toString(),
          publisherAddress: result.onChainResult.publisherAddress,
          txHash: result.onChainResult.txHash,
          blockNumber: result.onChainResult.blockNumber,
          newMerkleRoot: result.merkleRoot,
          timestampMs: Date.now(),
          operationId: ctx.operationId,
        });
        const topic = contextGraphUpdateTopic(contextGraphId);
        await this.gossip.publish(topic, message);
        this.log.info(ctx, `Broadcast KA update for batchId=${kaId} on ${topic}`);
      } catch (err) {
        this.log.warn(ctx, `Failed to broadcast KA update: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    onPhase?.('broadcast', 'end');

    return result;
  }

  /**
   * Write quads to the context graph's shared memory (no chain, no TRAC).
   * When localOnly is false (default), replicates via GossipSub shared memory topic.
   * When localOnly is true, stores locally without broadcasting — use for private data.
   */
  async share(this: DKGAgent, contextGraphId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string }): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `Sharing ${quads.length} quads to SWM for context graph ${contextGraphId}${sgLabel}${opts?.localOnly ? ' (local-only)' : ''}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
    });
    if (shouldCreateImplicitContextGraph) {
      await this.ensureImplicitSharedMemoryContextGraph(contextGraphId, {
        callerAgentAddress: opts?.callerAgentAddress,
      });
    }
    if (!opts?.localOnly) {
      // rc.9 PR-D: pass shareOperationId so publishWorkspaceGossip
      // can register the share with SwmAckQuorum and the watchdog
      // can fire substrate top-up if gossip-side acks miss quorum.
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner, shareOperationId);
    }
    return { shareOperationId };
  }

  /**
   * Compare-and-swap shared memory write. Verifies each condition against the
   * current shared memory graph before applying the write atomically.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(this: DKGAgent,
    contextGraphId: string,
    quads: Quad[],
    conditions: CASCondition[],
    opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string },
  ): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${contextGraphId}${sgLabel}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const { shareOperationId, message } = await this.publisher.writeConditionalToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
    });
    if (shouldCreateImplicitContextGraph) {
      await this.ensureImplicitSharedMemoryContextGraph(contextGraphId, {
        callerAgentAddress: opts?.callerAgentAddress,
      });
    }
    if (!opts?.localOnly) {
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner, shareOperationId);
    }
    return { shareOperationId };
  }

  async hasAuthoritativeContextGraphDefinition(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(`
      ASK WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        }
        UNION
        {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
        }
      }
    `);
    return result.type === 'boolean' && result.value === true;
  }

  async shouldCreateImplicitSharedMemoryContextGraph(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    if (await this.hasAuthoritativeContextGraphDefinition(contextGraphId)) {
      return false;
    }

    if ((await this.getContextGraphAgentGateAddresses(contextGraphId)) !== null) {
      return false;
    }

    const existingSub = this.subscribedContextGraphs.get(contextGraphId);
    if (existingSub?.metaSynced === false) {
      throw new Error(
        `Context graph "${contextGraphId}" is awaiting metadata sync; refusing to infer public metadata from an SWM write`,
      );
    }

    return true;
  }

  async ensureImplicitSharedMemoryContextGraph(this: DKGAgent,
    contextGraphId: string,
    opts: { callerAgentAddress?: string } = {},
  ): Promise<void> {
    if (!(await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId))) {
      return;
    }

    const gm = new GraphManager(this.store);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const now = new Date().toISOString();
    const existingSub = this.subscribedContextGraphs.get(contextGraphId);
    const name = existingSub?.name ?? contextGraphId;
    const curatorAgentAddress = opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${escapeSparqlLiteral(name)}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${this.peerId}`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(contextGraphId)}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: '"full"', graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"public"', graph: ontologyGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: '"unregistered"', graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${curatorAgentAddress}`, graph: cgMetaGraph },
    ];

    await this.store.insert(quads);
    await gm.ensureContextGraph(contextGraphId);
    await this.store.flush?.();
    this.subscribeToContextGraph(contextGraphId);
    this.setContextGraphSubscription(contextGraphId, {
      ...existingSub,
      name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    if (curatorAgentAddress) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: curatorAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'implicit-swm-write',
      });
    }

    this.log.info(
      createOperationContext('share'),
      `Implicitly registered public context graph "${contextGraphId}" from first SWM write`,
    );
  }

  /**
   * RFC-001 §9.x — finalize an assertion: compute merkleRoot, build the
   * EIP-712 AuthorAttestation typed data, sign (or accept pre-signed),
   * and write seal triples to the CG `_meta` graph keyed by the
   * assertion URI.
   *
   * Implementation lives on the class (not inside the `assertion` getter
   * closure) so that the substantial business logic — keystore lookup,
   * EIP-712 binding, idempotency check, seal write — is independently
   * testable and visible in stack traces.
   *
   * See `assertion.finalize` (the public-facing wrapper) for usage docs.
   */
  async assertionFinalize(this: DKGAgent,
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      schemeVersion?: number;
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
    if (
      opts?.authorAgentAddress != null &&
      opts?.preSignedAuthorAttestation != null
    ) {
      throw new Error(
        'assertionFinalize: authorAgentAddress and preSignedAuthorAttestation are mutually exclusive',
      );
    }

    // 1. Resolve URIs.
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);

    // 2. Pull the assertion's quads. Refuse to finalize an empty
    //    assertion — there's nothing to commit.
    const rawQuads = await this.publisher.assertionQuery(
      contextGraphId,
      name,
      agentAddress,
      opts?.subGraphName,
    );
    if (rawQuads.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: it has no quads. ` +
          `Write at least one quad with /api/knowledge-assets/${name}/wm/write before finalizing.`,
      );
    }

    // 2b. Apply the same `isReservedSubject` filter that
    //     `assertionPromote` runs at promote time. WM-only bookkeeping
    //     rows in the `urn:dkg:file:` / `urn:dkg:extraction:` namespaces
    //     (file descriptors, ExtractionProvenance blocks — see
    //     `19_MARKDOWN_CONTENT_TYPE.md §10.2`) are stripped before the
    //     assertion crosses the SWM boundary, so the seal MUST hash
    //     the post-strip set or it commits to a root the publish path
    //     can never recompute. (Round 4 review §8 — "assertionFinalize
    //     hashes WM-only urn:dkg:file: rows".)
    const quads = rawQuads.filter((q) => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
    if (quads.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: every quad has a ` +
          `reserved-namespace subject (urn:dkg:file:* / urn:dkg:extraction:*) ` +
          `which is filtered out before SWM. Add at least one user-authored ` +
          `quad on a non-reserved subject before finalizing.`,
      );
    }

    // 3. Compute merkleRoot using the SAME algorithm the publisher
    //    uses at publish-time (V10: keccak256-based merkle, sort+dedupe
    //    leaves). Drift between these two compute paths is the silent
    //    failure mode this whole architecture is trying to eliminate —
    //    so we reuse the publisher's exported helpers verbatim.
    //
    //    Round 5 review §1 — `kaMap` may contain unsafe-IRI roots
    //    (e.g. RFC-3987-valid IRIs with `|` `^` etc that fail
    //    `isSafeIri`'s SPARQL-interpolation rules). Those cannot be
    //    referenced from the SPARQL CONSTRUCT that
    //    `publishFromFinalizedAssertion` uses to reload the
    //    promoted-SWM payload, so they MUST NOT contribute to the
    //    sealed merkleRoot — otherwise the seal commits to a root
    //    the publish path can never recompute. Reject finalize
    //    instead of silently dropping content: silent-drop hides a
    //    real input error and would let a partial assertion ship
    //    with a seal that doesn't cover all of its quads.
    //    Defense-in-depth: the current oxigraph storage adapter
    //    rejects most unsafe characters at write time, so this guard
    //    is rarely triggered through `assertion.write`. It still
    //    matters for non-oxigraph adapters and for code paths that
    //    seed the WM graph directly (bulk-import / `_meta` fixtures
    //    / future storage backends). The canonical wire pin lives
    //    at `core/test/assertion-seal-root-entities.test.ts` —
    //    `buildAssertionSealQuads` rejects unsafe roots at the seal
    //    boundary. This guard surfaces the same failure earlier
    //    with a more actionable message.
    const kaMap = skolemizeByEntity(quads);
    const allRootEntities = [...kaMap.keys()];
    const unsafeRootEntities = allRootEntities.filter((r) => !isSafeIri(r));
    if (unsafeRootEntities.length > 0) {
      const sample = unsafeRootEntities
        .slice(0, 3)
        .map((r) => `<${r}>`)
        .join(', ');
      const more = unsafeRootEntities.length > 3 ? ` (+${unsafeRootEntities.length - 3} more)` : '';
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: ${unsafeRootEntities.length} root ` +
          `entit${unsafeRootEntities.length === 1 ? 'y has' : 'ies have'} an unsafe IRI: ${sample}${more}. ` +
          `The publish path reloads SWM via SPARQL CONSTRUCT scoped to these roots — unsafe IRIs ` +
          `would be filtered, recomputing a different merkleRoot from the truncated payload, so the ` +
          `sealed assertion could never be republished. Rename these subjects to safe IRIs ` +
          `(no blank nodes, control chars, or unbalanced delimiters) before finalizing.`,
      );
    }
    const allSkolemizedQuads = [...kaMap.values()].flat();
    const merkleRoot = computeFlatKCRoot(allSkolemizedQuads, []);
    // 3b. Capture rootEntities from the SAME `skolemizeByEntity` call that
    //     drives the merkle leaves. The seal binds these so
    //     `publishFromFinalizedAssertion` can scope its SWM CONSTRUCT
    //     instead of bundling everything currently sitting in shared
    //     memory (Round 4 review §9). Now safe by construction — the
    //     guard above guarantees every key passes `isSafeIri`.
    const rootEntities = allRootEntities;
    if (rootEntities.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: skolemizeByEntity produced ` +
          `no root entities. The assertion has no quads; add at least one ` +
          `user-authored quad on a non-reserved subject before finalizing.`,
      );
    }

    // 4. Idempotency: if a seal already exists for this assertion,
    //    return it as-is when the merkleRoot matches. Mismatch means
    //    the assertion was mutated since the previous finalize —
    //    refuse to overwrite silently.
    const existingMetaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const existingMetaQuads =
      existingMetaResult.type === 'quads' ? existingMetaResult.quads : [];
    let existingSeal: AssertionSeal | undefined;
    try {
      existingSeal = parseAssertionSealQuads(existingMetaQuads, assertionUri);
    } catch (err) {
      // Corrupt seal — surface to the caller. Do NOT silently overwrite
      // because the original author's signature is still on record and
      // overwriting would lose the audit trail.
      throw new Error(
        `assertionFinalize: existing _meta seal for <${assertionUri}> is corrupt: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (existingSeal) {
      if (
        existingSeal.merkleRoot.length !== merkleRoot.length ||
        !existingSeal.merkleRoot.every((b, i) => b === merkleRoot[i])
      ) {
        throw new Error(
          `assertionFinalize: assertion <${assertionUri}> is already finalized with a ` +
            `different merkleRoot (existing=${ethers.hexlify(existingSeal.merkleRoot)}, ` +
            `current=${ethers.hexlify(merkleRoot)}). Discard and re-create the assertion if ` +
            `you intended to change its content; in-place mutation of a finalized assertion ` +
            `breaks the author signature and is rejected.`,
        );
      }
      // Seal exists and matches — return the existing record.
      const typedData = buildAuthorAttestationTypedData({
        chainId: existingSeal.chainId,
        kav10Address: existingSeal.kav10Address,
        contextGraphId: await this.requireOnChainContextGraphId(contextGraphId),
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        schemeVersion: existingSeal.authorSchemeVersion,
      });
      return {
        assertionUri,
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        schemeVersion: existingSeal.authorSchemeVersion,
        chainId: existingSeal.chainId,
        kav10Address: existingSeal.kav10Address,
        eip712Digest: ethers.TypedDataEncoder.hash(
          typedData.domain,
          typedData.types,
          typedData.message,
        ),
      };
    }

    // 5. Resolve chain identity. Finalize commits to a specific
    //    `(chainId, kav10Address)` pair — both must be available.
    if (
      typeof this.chain.getEvmChainId !== 'function' ||
      typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function'
    ) {
      throw new Error(
        'assertionFinalize requires a V10-capable chain adapter that exposes ' +
          'getEvmChainId() and getKnowledgeAssetsLifecycleAddress(); the current adapter does not.',
      );
    }
    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsLifecycleAddress();

    // 6. Resolve the on-chain CG id — the EIP-712 digest binds to it.
    const onChainCgId = await this.requireOnChainContextGraphId(contextGraphId);

    // 7. Resolve author. preSigned > custodial agent > publisher fallback.
    const schemeVersion = opts?.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    let preSigned: PreSignedAuthorAttestation | undefined;
    if (opts?.preSignedAuthorAttestation != null) {
      preSigned = opts.preSignedAuthorAttestation;
      authorAddress = preSigned.address;
    } else if (opts?.authorAgentAddress != null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(
          `assertionFinalize: authorAgentAddress ${opts.authorAgentAddress} is not a registered local agent on this node`,
        );
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `assertionFinalize: agent ${opts.authorAgentAddress} is registered as self-sovereign — ` +
            `this node does not hold its private key. Use preSignedAuthorAttestation instead.`,
        );
      }
      signerPrivateKey = this.getCustodialAgentPrivateKey(opts.authorAgentAddress);
      if (!signerPrivateKey) {
        throw new Error(
          `assertionFinalize: custodial agent ${opts.authorAgentAddress} has no private key on file`,
        );
      }
      authorAddress = opts.authorAgentAddress;
    } else {
      // Publisher-wallet fallback: use the daemon's own publisher EOA
      // as the author. This preserves Phase 4 mode (a) — node admin
      // signs on its own behalf when no agent attribution is supplied.
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress) {
        throw new Error(
          'assertionFinalize: no agent override supplied and no publisher signer is available. ' +
            'Either supply authorAgentAddress / preSignedAuthorAttestation, or configure a publisher private key on the daemon.',
        );
      }
      authorAddress = fallbackAddress;
    }

    // 8. Build EIP-712 typed data.
    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: onChainCgId,
      merkleRoot,
      authorAddress,
      schemeVersion,
    });
    const eip712Digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );

    // 9. Produce the compact signature (r, vs).
    let r: Uint8Array;
    let vs: Uint8Array;
    if (preSigned) {
      const sig = ethers.Signature.from({
        r: ethers.hexlify(preSigned.signature.r),
        yParityAndS: ethers.hexlify(preSigned.signature.vs),
      });
      // Off-chain seal-integrity preflight: only EOAs can be verified
      // by ECDSA recover-and-compare. For smart-contract authors
      // (incl. EIP-7702-delegated EOAs), the on-chain
      // `_verifyAuthorAttestation` dispatches to
      // `IERC1271.isValidSignature` and is the authoritative check —
      // the off-chain ECDSA recover would (correctly) report a
      // mismatch since 1271 wallets typically sign through an owner
      // EOA that's distinct from the wallet contract address. Skip the
      // off-chain check for contract authors so the seal-build pipeline
      // doesn't reject 1271 publishes that the chain would accept.
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(authorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(eip712Digest, sig);
        if (recovered.toLowerCase() !== authorAddress.toLowerCase()) {
          throw new Error(
            `assertionFinalize: preSignedAuthorAttestation signer mismatch — ` +
              `signature recovers ${recovered} but address claims ${authorAddress}.`,
          );
        }
      }
      r = preSigned.signature.r;
      vs = preSigned.signature.vs;
    } else if (signerPrivateKey) {
      const wallet = new ethers.Wallet(
        signerPrivateKey.startsWith('0x') ? signerPrivateKey : '0x' + signerPrivateKey,
      );
      const sigHex = await wallet.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      );
      const sig = ethers.Signature.from(sigHex);
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
    } else {
      // Publisher fallback: ask the publisher to sign with its own
      // wallet. Returns the compact (r, vs) form.
      const compact = await this.publisher.signAuthorAttestationAsPublisher(typedData);
      r = compact.r;
      vs = compact.vs;
    }

    // 10. Persist the seal as `_meta` triples.
    const finalizedAtIso = new Date().toISOString();
    const sealQuads = buildAssertionSealQuads({
      assertionUri,
      metaGraph,
      merkleRoot,
      authorAddress,
      authorAttestationR: r,
      authorAttestationVS: vs,
      authorSchemeVersion: schemeVersion,
      chainId,
      kav10Address,
      finalizedAtIso,
      rootEntities,
    });

    // ── OT-RFC-43 A2 — ALLOCATE-AT-FINALIZE + per-layer WM pointer ──
    //
    // This is the SINGLE source of truth for the packed kaId (eliminates the
    // double-allocation the publish path used to do). If an allocator is
    // present we reconcile its per-author floor once (lazy, cached on the
    // agent), allocate the next (author, number), and stamp on the LIFECYCLE
    // URN (NOT the assertion-graph URI):
    //   dkg:kaId          = number (xsd:integer)
    //   dkg:reservedUal   = did:dkg:<chainId>/<agentAddrLower>/<number>
    //   dkg:wmCurrentAssertion = the seal merkle hex (bare, no 0x)
    // publishFromFinalizedAssertion then READS dkg:kaId off `_meta` and
    // threads it down so the publisher REUSES it instead of allocating again.
    //
    // We persist the WM pointer + kaId stamp atomically with the seal.
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const merkleHexBare = ethers.hexlify(merkleRoot).slice(2);

    // Has this lifecycle ALREADY reserved a kaId? (An update to a name that
    // was previously finalized + published — its kaId must stay STABLE across
    // versions, so we MUST NOT allocate a fresh number and overwrite it.) The
    // assertion-graph seal is cleared on discard+recreate, but the kaId stamp
    // lives on the lifecycle URN and survives, so this is the reliable signal.
    const xsdInteger = '<http://www.w3.org/2001/XMLSchema#integer>';
    const existingKaIdRes = await this.store.query(
      `SELECT ?n WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${KA_ID_PRED}> ?n } } LIMIT 1`,
    );
    const hasExistingKaId =
      existingKaIdRes.type === 'bindings' && existingKaIdRes.bindings.length > 0;

    // Re-stamp the WM pointer (idempotent: drop any prior value first so a
    // re-finalize / update advances WM without accumulating stale pointers).
    await this._stampPointer(lifecycleUri, WM_CURRENT_ASSERTION_PRED, merkleHexBare, metaGraph);

    if (this.kaNumberAllocator && !hasExistingKaId) {
      const author = authorAddress;
      const key = author.toLowerCase();
      if (!this.reconciledKaAuthors.has(key)) {
        let chainMax = -1n;
        if (typeof this.chain.getMaxKaNumberForAuthor === 'function') {
          try {
            chainMax = await this.chain.getMaxKaNumberForAuthor(author);
          } catch (err) {
            throw new Error(
              `OT-RFC-43 A2: failed to reconcile KA-number floor for author ${author} at finalize: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        if (chainMax >= 0n) {
          // Pass the bigint straight through (PR #976 F6) — `Number()` would lose precision past 2^53.
          this.kaNumberAllocator.reconcile(author, chainMax);
        }
        this.kaNumberAllocator.markReconciled();
        this.reconciledKaAuthors.add(key);
      }
      const { number } = this.kaNumberAllocator.allocate(author);
      // chainId here is the EVM uint256 from getEvmChainId(); the reservedUal
      // uses the adapter's canonical chainId string to match resolveKaUal's
      // UAL shape (did:dkg:<chainId>/<addr>/<number>).
      const reservedUal = `did:dkg:${this.chain.chainId}/${author.toLowerCase()}/${number}`;
      sealQuads.push({
        subject: lifecycleUri,
        predicate: KA_ID_PRED,
        object: `"${number}"^^${xsdInteger}`,
        graph: metaGraph,
      });
      sealQuads.push({
        subject: lifecycleUri,
        predicate: RESERVED_UAL_PRED,
        object: `"${reservedUal}"`,
        graph: metaGraph,
      });
    }

    await this.store.insert(sealQuads);

    return {
      assertionUri,
      merkleRoot,
      authorAddress,
      schemeVersion,
      chainId,
      kav10Address,
      eip712Digest,
    };
  }

  /**
   * Helper: resolve the on-chain context graph id used by the EIP-712
   * AuthorAttestation domain. Throws when the CG is not yet
   * registered on-chain — finalize cannot bind a sig to a missing CG.
   */
  async requireOnChainContextGraphId(this: DKGAgent, contextGraphId: string): Promise<bigint> {
    const onChainId = await this.getContextGraphOnChainId(contextGraphId);
    if (onChainId == null) {
      throw new Error(
        `Context graph "${contextGraphId}" is not registered on-chain. ` +
          `Run 'dkg context-graph register ${contextGraphId}' before finalizing an assertion ` +
          `targeted at it; finalize binds the author signature to the on-chain CG id.`,
      );
    }
    try {
      return BigInt(onChainId);
    } catch {
      throw new Error(
        `Context graph "${contextGraphId}" has a non-numeric on-chain id ("${onChainId}") — ` +
          `the EIP-712 binding requires a uint256.`,
      );
    }
  }

  /**
   * RFC-001 §9.x — selection-based publish bridge.
   *
   * Mints a `precomputedAttestation` inline for a given quads bag,
   * without writing seal triples to `_meta`. Used by
   * `publishFromSharedMemory(selection)` to preserve the
   * "agent picks rootEntities post-hoc, then publishes" UX while
   * keeping the sign-at-creation invariant: the seal is computed and
   * signed at the agent boundary, before the publisher gets the
   * payload. The publisher then refuses the on-chain publish if the
   * seal is absent or its merkleRoot doesn't match what it recomputes
   * from the quads (defence against in-flight tampering between
   * selection and broadcast).
   *
   * Author resolution mirrors `assertionFinalize`:
   *   1. `preSignedAuthorAttestation` (self-sovereign agent's pre-sig)
   *   2. `authorAgentAddress` (custodial agent — daemon holds the key)
   *   3. publisher fallback (the daemon's own publisher EOA signs)
   *
   * Unlike `assertionFinalize`, the seal is NOT persisted: it lives
   * only in the publish call. This is by design — selection-based
   * publishes are inherently ephemeral curations, not long-lived
   * named assertions. If you need persistent seal provenance, use the
   * named-assertion lifecycle (`createAssertion` + `appendToAssertion`
   * + `finalizeAssertion` + `publishFromFinalizedAssertion`).
   */
  async _buildPrecomputedAttestationForSelection(this: DKGAgent,
    contextGraphId: string,
    quads: Quad[],
    opts?: {
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      schemeVersion?: number;
      /**
       * On-chain CG id the seal binds to. Defaults to the source
       * `contextGraphId`'s on-chain id; override for remap-flow
       * publishes (`publishContextGraphId` / `subContextGraphId` set
       * on the publish call) where the assertion lives in a different
       * CG than the SWM source.
       */
      targetOnChainCgId?: bigint | string;
      /**
       * Private quads for the same publish. Round 4 review §11 —
       * `DKGPublisher.publish` computes `kcMerkleRoot` over the
       * concatenation of public quads + private roots (see
       * `dkg-publisher.ts:1567-1575`). The seal must hash the same
       * leaves or every V10 publish with `privateQuads` falls back to
       * `tentative` on the publisher's `expectedMerkleRoot mismatch`
       * guard. Pass them through so the agent's pre-seal merkle
       * matches what the publisher will recompute.
       */
      privateQuads?: Quad[];
    },
  ): Promise<PublishOptions['precomputedAttestation']> {
    if (
      opts?.authorAgentAddress != null &&
      opts?.preSignedAuthorAttestation != null
    ) {
      throw new Error(
        '_buildPrecomputedAttestationForSelection: authorAgentAddress and preSignedAuthorAttestation are mutually exclusive',
      );
    }
    if (
      typeof this.chain.getEvmChainId !== 'function' ||
      typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function'
    ) {
      throw new Error(
        'Selection-based VM publish requires a V10-capable chain adapter that exposes ' +
          'getEvmChainId() and getKnowledgeAssetsLifecycleAddress().',
      );
    }

    const kaMap = skolemizeByEntity(quads);
    const allSkolemizedQuads = [...kaMap.values()].flat();
    // Mirror the publisher's per-rootEntity private partition + root
    // derivation (see `dkg-publisher.ts:1526-1570`). Each public root
    // entity gets the private quads whose subjects either equal it or
    // skolemize beneath its `…/.well-known/genid/` namespace; each
    // such non-empty bag becomes a `computePrivateRootV10` leaf in the
    // KC merkle. The order MUST follow the publisher's manifest
    // iteration over `kaMap`, which is the insertion order — same map
    // we built two lines up.
    const privateQuads = opts?.privateQuads ?? [];
    const privateRoots: Uint8Array[] = [];
    for (const rootEntity of kaMap.keys()) {
      if (privateQuads.length === 0) break;
      const entityPrivateQuads = privateQuads.filter(
        (q) =>
          q.subject === rootEntity ||
          q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length === 0) continue;
      const root = computePrivateRoot(entityPrivateQuads);
      if (root) privateRoots.push(root);
    }
    const merkleRoot = computeFlatKCRoot(allSkolemizedQuads, privateRoots);

    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsLifecycleAddress();
    const onChainCgId =
      opts?.targetOnChainCgId !== undefined
        ? BigInt(opts.targetOnChainCgId)
        : await this.requireOnChainContextGraphId(contextGraphId);

    const schemeVersion = opts?.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    let preSigned: PreSignedAuthorAttestation | undefined;
    if (opts?.preSignedAuthorAttestation != null) {
      preSigned = opts.preSignedAuthorAttestation;
      authorAddress = preSigned.address;
    } else if (opts?.authorAgentAddress != null) {
      const mode = this.getLocalAgentMode(opts.authorAgentAddress);
      if (mode === undefined) {
        throw new Error(
          `Selection-based VM publish: authorAgentAddress ${opts.authorAgentAddress} is not a registered local agent on this node`,
        );
      }
      if (mode === 'self-sovereign') {
        throw new Error(
          `Selection-based VM publish: agent ${opts.authorAgentAddress} is registered as self-sovereign — ` +
            `this node does not hold its private key. Use preSignedAuthorAttestation instead.`,
        );
      }
      signerPrivateKey = this.getCustodialAgentPrivateKey(opts.authorAgentAddress);
      if (!signerPrivateKey) {
        throw new Error(
          `Selection-based VM publish: custodial agent ${opts.authorAgentAddress} has no private key on file`,
        );
      }
      authorAddress = opts.authorAgentAddress;
    } else {
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress) {
        throw new Error(
          'Selection-based VM publish: no agent override supplied and no publisher signer is available. ' +
            'Either supply authorAgentAddress / preSignedAuthorAttestation, or configure a publisher private key on the daemon.',
        );
      }
      authorAddress = fallbackAddress;
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: onChainCgId,
      merkleRoot,
      authorAddress,
      schemeVersion,
    });
    const eip712Digest = ethers.TypedDataEncoder.hash(
      typedData.domain,
      typedData.types,
      typedData.message,
    );

    let r: Uint8Array;
    let vs: Uint8Array;
    if (preSigned) {
      const sig = ethers.Signature.from({
        r: ethers.hexlify(preSigned.signature.r),
        yParityAndS: ethers.hexlify(preSigned.signature.vs),
      });
      // Same EOA-vs-1271 dispatch as `assertionFinalize` (see comment
      // there). Skip ECDSA recover for smart-contract / 7702-delegated
      // authors so the on-chain `IERC1271.isValidSignature` branch can
      // be the authoritative check.
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(authorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(eip712Digest, sig);
        if (recovered.toLowerCase() !== authorAddress.toLowerCase()) {
          throw new Error(
            `Selection-based VM publish: preSignedAuthorAttestation signer mismatch — ` +
              `signature recovers ${recovered} but address claims ${authorAddress}.`,
          );
        }
      }
      r = preSigned.signature.r;
      vs = preSigned.signature.vs;
    } else if (signerPrivateKey) {
      const wallet = new ethers.Wallet(
        signerPrivateKey.startsWith('0x') ? signerPrivateKey : '0x' + signerPrivateKey,
      );
      const sigHex = await wallet.signTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
      );
      const sig = ethers.Signature.from(sigHex);
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
    } else {
      const compact = await this.publisher.signAuthorAttestationAsPublisher(typedData);
      r = compact.r;
      vs = compact.vs;
    }

    return {
      expectedMerkleRoot: merkleRoot,
      authorAddress,
      signature: { r, vs },
      schemeVersion,
    };
  }

  /**
   * Load the quads that a selection-based publish would target.
   * Mirrors the SPARQL CONSTRUCT inside
   * `publisher.publishFromSharedMemory` so the agent can pre-compute
   * the assertion seal over the same content the publisher will see
   * at broadcast time. Any drift (e.g. concurrent SWM mutation
   * between this load and the publisher's load) surfaces as the
   * publisher's `expectedMerkleRoot mismatch` error rather than a
   * silent wrong-content publish.
   */
  /**
   * OT-RFC-38 / LU-5 — produce an inline-payload AEAD callback for
   * curated CGs so cores receive opaque ciphertext instead of
   * plaintext nquads. Returns `undefined` for public CGs (the
   * publisher then keeps its existing plaintext-inline behaviour).
   *
   * Keyed via the publisher's swm-sender-key send-state `chainKey`
   * snapshot: every CG member who holds this key (delivered via
   * setup packages + ratchet steps) can recompute the same payload
   * key and decrypt later when LU-7 catchup / LU-8 verification
   * lands. If the publisher hasn't bootstrapped a send-state yet
   * (e.g. publish before any SWM write), we fall back to
   * `undefined` and let the publisher's existing path apply — for
   * a curated CG that means the cores will decline with
   * NO_DATA_IN_SWM (same observable as today, the §1.1 bug). The
   * agent surfaces a warn so operators see the configuration miss.
   */
  /**
   * Shared resolution between LU-5 (`_resolveEncryptInlinePayload`) and
   * LU-11 (`_resolveEncryptInlineChunked`). Probes the access policy,
   * bootstraps / rotates the swm-sender-key epoch, and returns the
   * effective `chainKey` + AEAD CG-id binding. Returns `undefined` for
   * public CGs so the caller stays on the plaintext-inline path.
   *
   * The original LU-5 method body lived inline here pre-LU-11; pulling
   * it into a helper avoided drifting two near-identical curated-
   * probe / epoch-rotation blocks once chunked emission joined the
   * picture. All semantics (probe order, rotation triggers, fail-
   * closed branches, error texts) are preserved.
   */
  async _resolveCuratedChainKeyContext(this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | undefined,
    authorAgentAddress: string | undefined,
    publishContextGraphId: string | undefined,
    logPrefix: string,
  ): Promise<{ chainKey: Uint8Array; aeadCgId: string; senderAddress: string } | undefined> {
    const ctx = createOperationContext('publish');
    const targetCgId = publishContextGraphId ?? contextGraphId;
    const probeIsCurated = async (cgId: string): Promise<boolean | null> => {
      // Consume the SHARED tri-state resolver (the same one behind the
      // SWM-gossip gate) so the publish-inline path can never DIVERGE from it,
      // and — critically (#884 review 🔴 GZh-c) — so a genuine UNKNOWN is
      // PRESERVED here instead of collapsing to "not public ⇒ plaintext". The
      // resolver already does the live-on-chain proof, identity binding, and
      // bounded reads; a thrown RPC rejection is caught below and also
      // fails closed.
      let policyState: 0 | 1 | 'unregistered' | 'unknown';
      try {
        policyState = await this.resolveOnChainAccessPolicyState(cgId, ctx);
      } catch (err) {
        this.log.warn(ctx, `${logPrefix}: chain access-policy probe for ${cgId} failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      // PUBLIC on-chain ⇒ never curated for SWM-encryption purposes, even with
      // an allowedAgent list (that governs publish authority). Decide this
      // BEFORE `isPrivateContextGraph`, whose allowlist-implies-private
      // heuristic would otherwise force encrypted inline payloads onto a public
      // CG and diverge from the plaintext SWM-gossip path.
      if (policyState === 0) return false;
      // PRIVATE on-chain ⇒ curated ⇒ encrypted inline payload.
      if (policyState === 1) return true;
      if (policyState === 'unknown') {
        // Resolvable on-chain but UNPROVABLE (not live / stale mapping / no
        // liveness probe / timeout). A positive LOCAL curated signal is a safe
        // downgrade-to-encrypted (never a leak), so honor it; otherwise keep
        // the UNKNOWN so the caller REFUSES (throws "publish access-policy is
        // unknown") rather than silently choosing plaintext for what may be a
        // private CG.
        try {
          if (await this.isPrivateContextGraph(cgId)) return true;
        } catch { /* can't add a positive curated signal — stay unknown */ }
        return null;
      }
      // 'unregistered': no on-chain slot at all (a pure-local CG). Fall back to
      // the local allowlist-implies-private heuristic; absent that, keep the
      // long-standing plaintext-inline default for local-only workspaces.
      try {
        if (await this.isPrivateContextGraph(cgId)) return true;
      } catch { /* fall through to the plaintext-inline default */ }
      return false;
    };
    const sourceIsCurated = await probeIsCurated(contextGraphId);
    const targetIsCurated = targetCgId === contextGraphId
      ? sourceIsCurated
      : await probeIsCurated(targetCgId);
    if (targetIsCurated == null || (targetCgId !== contextGraphId && sourceIsCurated == null)) {
      throw new Error(
        `${logPrefix}: publish access-policy is unknown — ` +
        `source CG "${contextGraphId}" curated=${sourceIsCurated ?? 'unknown'}, ` +
        `target CG "${targetCgId}" curated=${targetIsCurated ?? 'unknown'}. ` +
        `Refusing to choose plaintext vs encrypted inline payload without chain-confirmed policy.`,
      );
    }
    if (targetCgId !== contextGraphId && sourceIsCurated !== targetIsCurated) {
      throw new Error(
        `${logPrefix}: remap publish source/target access-policy mismatch — ` +
        `source CG "${contextGraphId}" curated=${sourceIsCurated}, ` +
        `target CG "${targetCgId}" curated=${targetIsCurated}. ` +
        `Refusing to publish: encrypting against the wrong CG's policy ` +
        `would either leak plaintext (curated→public) or be rejected by ` +
        `cores (public→curated). Reconcile the source and target ` +
        `access policies before retrying.`,
      );
    }
    if (!targetIsCurated) return undefined;

    const senderAddress = authorAgentAddress
      ?? this.defaultAgentAddress
      ?? this.peerId;

    await this.loadSwmSenderKeyState();
    const sender = this.getLocalSigningAgentForAddress(senderAddress);
    if (!sender) {
      throw new Error(
        `${logPrefix}: curated CG ${contextGraphId}: cannot bootstrap swm-sender-key — ` +
        `no local custodial signing key for agent ${senderAddress}. ` +
        `Refusing to publish curated CG payload via the plaintext-inline fallback.`,
      );
    }
    const resolution = await resolveWorkspaceAgentRecipients(this.store, { contextGraphId });
    if (!resolution.requiresEncryption) {
      throw new Error(
        `${logPrefix}: curated CG ${contextGraphId}: access-policy says curated but recipient resolver ` +
        `returned no agent recipients. Refusing to publish to avoid plaintext leak.`,
      );
    }
    if (resolution.recipients.length === 0) {
      throw new Error(
        `${logPrefix}: curated CG ${contextGraphId}: no DKG agent recipients available — ` +
        `add at least one allowed agent before publishing.`,
      );
    }
    const recipientSet = new Set(resolution.recipients.map((r) => r.agentAddress.toLowerCase()));
    if (!recipientSet.has(ethers.getAddress(senderAddress).toLowerCase())) {
      throw new Error(
        `${logPrefix}: curated CG ${contextGraphId}: sender ${senderAddress} is not in the recipient set — ` +
        `add yourself to the allowedAgents before publishing.`,
      );
    }
    const membershipHash = computeSwmSenderKeyMembershipHash({
      contextGraphId,
      subGraphName,
      members: resolution.recipients.map((r) => ({
        agentAddress: r.agentAddress,
        recipientKeyId: r.recipientKeyId,
      })),
    });

    const stateKey = swmSenderStateKey(contextGraphId, subGraphName, senderAddress);
    let state = this.swmSenderKeySendStates.get(stateKey);
    if (!state || state.membershipHash !== membershipHash) {
      const reason = !state
        ? 'no persisted state'
        : `membership changed (was=${state.membershipHash} now=${membershipHash})`;
      this.log.info(
        ctx,
        `${logPrefix}: bootstrapping/rotating swm-sender-key epoch for curated CG ${contextGraphId} ` +
        `(sender=${senderAddress}, recipients=${resolution.recipients.length}, reason=${reason})`,
      );
      const pruned = this.prunePendingSenderKeysForEpochRotation({
        contextGraphId,
        subGraphName,
        senderAgentAddress: senderAddress,
      });
      if (pruned > 0) {
        this.log.warn(
          ctx,
          `${logPrefix}: pruned ${pruned} stale pending SWM sender-key setup package(s) ` +
          `for curated CG ${contextGraphId}${subGraphName ? `/${subGraphName}` : ''} sender ${senderAddress}`,
        );
        await this.saveSwmSenderKeyState();
      }
      state = await this.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId,
        subGraphName,
        sender,
        recipients: resolution.recipients,
        membershipHash,
        ctx,
      });
      this.swmSenderKeySendStates.set(stateKey, state);
      await this.saveSwmSenderKeyState();
    } else {
      await this.drainPendingSenderKeyForRecipients(resolution.recipients, ctx);
    }

    return {
      chainKey: state.chainKey,
      aeadCgId: publishContextGraphId ?? contextGraphId,
      senderAddress,
    };
  }

  async _resolveEncryptInlinePayload(this: DKGAgent,
    contextGraphId: string,
    subGraphName?: string,
    authorAgentAddress?: string,
    publishContextGraphId?: string,
  ): Promise<((plaintext: Uint8Array) => Promise<Uint8Array>) | undefined> {
    const resolved = await this._resolveCuratedChainKeyContext(
      contextGraphId, subGraphName, authorAgentAddress, publishContextGraphId, 'LU-5',
    );
    if (!resolved) return undefined;
    const { chainKey, aeadCgId } = resolved;
    return async (plaintextNquads: Uint8Array): Promise<Uint8Array> => {
      return encryptV10PublishPayload({
        chainKey,
        contextGraphId: aeadCgId,
        plaintext: plaintextNquads,
      });
    };
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — produce the chunked-AEAD inline
   * callback for curated CGs. Returns `undefined` for public CGs so
   * the LU-5 callback (also resolved unconditionally for curated CGs)
   * stays as the only path.
   *
   * The returned closure does THREE things on the publish hot path:
   *
   *   1. slice plaintext into `CIPHERTEXT_CHUNK_SIZE_BYTES`-sized
   *      pieces (last chunk smaller),
   *   2. AEAD-encrypt each chunk with a publish-operation-deterministic
   *      nonce (`deriveChunkNonce(publishOperationId, chunkIndex)`) so
   *      retries produce bit-identical ciphertext and idempotent SWM
   *      writes (idempotency is the spec's only protection against double-
   *      gossip racing the on-chain commitment), while distinct publish
   *      attempts rotate the AEAD nonce domain even if they share the
   *      same merkle root,
   *   3. fan each ciphertext chunk out as a V2 SWM gossip envelope
   *      (`type = 'share-write-chunked'`, `swmMessageIndex = i`,
   *      payload = `[batchId(32)][ct_i]`) on the curated CG's
   *      workspace topic — so hosting cores (RFC-38 LU-6 host-mode)
   *      persist the bytes opaquely keyed by
   *      `(cgId, batchId, swmMessageIndex)` and members decrypt
   *      locally with the same chainKey they already hold.
   *
   * The returned `ciphertextChunksRoot` is the keccak256 root over
   * `keccak256(ct_i)` leaves in `swmMessageIndex` order (see
   * `buildCiphertextChunksRoot` in `@origintrail-official/dkg-core`).
   * That same root lands on-chain via
   * `KnowledgeAssetsV10.PublishParams.ciphertextChunksRoot` and binds
   * the SWM-gossiped bytes to the chain commitment — RFC-39 random
   * sampling samples `(cgId, batchId, chunkId)` against this root.
   */
  async _resolveEncryptInlineChunked(this: DKGAgent,
    contextGraphId: string,
    subGraphName?: string,
    authorAgentAddress?: string,
    publishContextGraphId?: string,
  ): Promise<
    | ((input: { plaintextNquads: Uint8Array; batchId: Uint8Array; publishOperationId: string }) => Promise<{
        ciphertextChunksRoot: Uint8Array;
        ciphertextChunkCount: number;
        totalCiphertextBytes: number;
      }>)
    | undefined
  > {
    const resolved = await this._resolveCuratedChainKeyContext(
      contextGraphId, subGraphName, authorAgentAddress, publishContextGraphId, 'LU-11',
    );
    if (!resolved) return undefined;
    const { chainKey, aeadCgId } = resolved;
    const wireCgId = this.gossipWireIdFor(contextGraphId);
    const topic = contextGraphWorkspaceTopic(wireCgId);
    const signer = await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    if (!signer) {
      throw new Error(
        `LU-11: curated CG ${contextGraphId}: cannot resolve a workspace-gossip signing agent — ` +
        `cores reject unsigned chunked envelopes. Add a local custodial signing key for an ` +
        `allowed agent before publishing.`,
      );
    }
    const signerWallet = new ethers.Wallet(signer.privateKey);
    const signerAgentAddress = signer.agentAddress;
    const log = this.log;
    const ctx = createOperationContext('publish');
    const gossip = this.gossip;

    return async (input: { plaintextNquads: Uint8Array; batchId: Uint8Array; publishOperationId: string }): Promise<{
      ciphertextChunksRoot: Uint8Array;
      ciphertextChunkCount: number;
      totalCiphertextBytes: number;
    }> => {
      if (input.batchId.length !== 32) {
        throw new Error(
          `LU-11: chunked emit requires a 32-byte batchId (V10 KC merkleRoot); got ${input.batchId.length}`,
        );
      }
      if (input.publishOperationId.length === 0) {
        throw new Error('LU-11: chunked emit requires a non-empty publishOperationId');
      }
      const plaintextChunks = sliceIntoCiphertextChunks(input.plaintextNquads);
      const { ciphertextChunks } = encryptChunked({
        chainKey,
        contextGraphId: aeadCgId,
        plaintextChunks,
        publishOperationId: input.publishOperationId,
      });
      const { root, leafCount } = buildCiphertextChunksRoot(ciphertextChunks);
      const batchIdHex = ethers.hexlify(input.batchId);
      let totalCiphertextBytes = 0;
      for (let i = 0; i < ciphertextChunks.length; i++) {
        const ct = ciphertextChunks[i];
        totalCiphertextBytes += ct.length;
        const payload = new Uint8Array(input.batchId.length + ct.length);
        payload.set(input.batchId, 0);
        payload.set(ct, input.batchId.length);
        const timestamp = new Date().toISOString();
        const signingPayload = computeGossipSigningPayloadV2(
          GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
          contextGraphId,
          timestamp,
          payload,
          i,
        );
        const signature = await signerWallet.signMessage(signingPayload);
        const envelope = encodeGossipEnvelope({
          version: GOSSIP_ENVELOPE_VERSION,
          type: GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
          contextGraphId,
          agentAddress: signerAgentAddress,
          timestamp,
          signature: ethers.getBytes(signature),
          payload,
          swmMessageIndex: i,
        });
        try {
          await gossip.publish(topic, envelope);
        } catch (err) {
          log.warn(
            ctx,
            `LU-11: chunked gossip publish failed for cgId=${contextGraphId} ` +
            `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} chunkIndex=${i}: ${
              err instanceof Error ? err.message : String(err)
            } — cores without this chunk will DECLINE the V2 ACK; ` +
            `late-join sync can backfill once the catchup verb lands.`,
          );
        }
      }
      log.info(
        ctx,
        `LU-11: emitted ${ciphertextChunks.length} ciphertext chunks ` +
        `(${totalCiphertextBytes} bytes total) for curated CG ${contextGraphId} ` +
        `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} on topic ${topic}`,
      );
      return {
        ciphertextChunksRoot: root,
        ciphertextChunkCount: leafCount,
        totalCiphertextBytes,
      };
    };
  }

  async _loadSelectedSWMQuads(this: DKGAgent,
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    subGraphName?: string,
  ): Promise<Quad[]> {
    const swmGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
    let sparql: string;
    if (selection === 'all') {
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } FILTER((STRSTARTS(STR(?g), "${swmGraph}/") && !STRSTARTS(STR(?g), "${swmGraph}/staging/")) || STR(?g) = "${swmGraph}") }`;
    } else {
      // Round 4 review §10 — mirror the `isSafeIri` filter that
      // `DKGPublisher.publishFromSharedMemory` applies before its own
      // SPARQL CONSTRUCT. Without this guard a caller could craft a
      // `selection.rootEntities` value containing `>` / SPARQL syntax
      // that breaks out of the `<…>` IRI literal and rewrites the
      // pre-seal CONSTRUCT into a wider scope. Both seams must agree
      // on the IRI shape that survives interpolation; the `_meta`
      // seal writer (`buildAssertionSealQuads`) applies the same
      // reject-set when it persists rootEntities so any value that
      // round-trips through finalize → publish is safe here.
      const roots = [...new Set(
        selection.rootEntities
          .map((r) => String(r).trim())
          .filter((r) => isSafeIri(r)),
      )];
      if (roots.length === 0) {
        const hadInput = selection.rootEntities.length > 0;
        throw new Error(
          hadInput
            ? `_loadSelectedSWMQuads: no valid rootEntities provided ` +
                `(all ${selection.rootEntities.length} entries failed IRI validation) ` +
                `for context graph ${contextGraphId}`
            : `_loadSelectedSWMQuads: no rootEntities supplied for context graph ${contextGraphId}`,
        );
      }
      const values = roots.map((r) => `<${r}>`).join(' ');
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        GRAPH ?g {
          VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )
        }
        FILTER((STRSTARTS(STR(?g), "${swmGraph}/") && !STRSTARTS(STR(?g), "${swmGraph}/staging/")) || STR(?g) = "${swmGraph}")
      }`;
    }
    const result = await this.store.query(sparql);
    return result.type === 'quads' ? result.quads : [];
  }

  /**
   * RFC-001 §9.x — publish a previously-finalized assertion to the
   * verified-memory chain.
   *
   * Reads the seal from `_meta`, plumbs the seal's
   * `(merkleRoot, authorAddress, signature, schemeVersion)` into the
   * publisher as `precomputedAttestation`, and lets
   * `publishFromSharedMemory` handle everything else (CG registration
   * check, ACK collection, on-chain submission, post-confirmation
   * cleanup).
   *
   * Pre-condition: the assertion's quads have already been promoted
   * into SWM via `assertion.promote()`. The publisher pulls quads
   * from the canonical CG `_shared-memory` graph; if the assertion
   * hasn't been promoted yet, publish will see an empty/wrong quad
   * set and the merkleRoot sanity check inside `publish()` will fire.
   */
  async publishFromFinalizedAssertion(this: DKGAgent,
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      publisherNodeIdentityIdOverride?: bigint;
      publishEpochs?: number;
      clearSharedMemoryAfter?: boolean;
    },
  ): Promise<PublishResult & { assertionUri: string; seal: AssertionSeal }> {
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);

    // 1. Read the seal from _meta.
    const metaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const metaQuads = metaResult.type === 'quads' ? metaResult.quads : [];
    const seal = parseAssertionSealQuads(metaQuads, assertionUri);
    if (!seal) {
      throw new Error(
        `publishFromFinalizedAssertion: assertion <${assertionUri}> is not finalized. ` +
          `Call /api/knowledge-assets/${name}/wm/finalize before publishing.`,
      );
    }

    // 2. Cross-check chain target — refuse to publish a sig signed
    //    against a different deployment than this daemon currently
    //    points at. This is the cross-deployment safety the EIP-712
    //    domain is buying us; surface as an early 4xx-equivalent
    //    rather than a tx revert.
    if (
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
    ) {
      const liveChainId = await this.chain.getEvmChainId();
      const liveKav10 = await this.chain.getKnowledgeAssetsLifecycleAddress();
      if (liveChainId !== seal.chainId) {
        throw new Error(
          `publishFromFinalizedAssertion: seal binds chainId=${seal.chainId.toString()} but daemon ` +
            `is configured for chainId=${liveChainId.toString()}. The author signature is not valid ` +
            `against this chain. Re-finalize the assertion against the target chain.`,
        );
      }
      if (liveKav10.toLowerCase() !== seal.kav10Address.toLowerCase()) {
        throw new Error(
          `publishFromFinalizedAssertion: seal binds KAv10=${seal.kav10Address} but daemon ` +
            `is configured for KAv10=${liveKav10}. The signature is not valid against this deployment.`,
        );
      }
    }

    // ── OT-RFC-43 A2 (decision 3) — CREATE-VS-UPDATE ROUTING ──
    //
    // BEFORE minting, read the per-layer VM pointer + the stamped kaId off the
    // LIFECYCLE URN. If dkg:vmCurrentAssertion is SET this name has already
    // been confirmed on-chain → this is an UPDATE (publish the SAME name
    // twice), so call the update path with the existing kaId instead of a
    // fresh mint. Otherwise → MINT, reusing the finalize-stamped kaId.
    //
    // This is the LOCAL named-lifecycle path only; the gossip-receiver
    // "Complexity C" path (resolveUalByBatchId / update-handler.ts) is
    // untouched.
    const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const xsdInt = 'http://www.w3.org/2001/XMLSchema#integer';
    const pointerRes = await this.store.query(
      `SELECT ?vm ?kaNum WHERE { GRAPH <${metaGraph}> {
        OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
        OPTIONAL { <${lifecycleUri}> <${KA_ID_PRED}> ?kaNum }
      } } LIMIT 1`,
    );
    const stripLit = (v?: string) => v?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
    const pointerRow = pointerRes.type === 'bindings' ? pointerRes.bindings[0] : undefined;
    const vmCurrent = stripLit(pointerRow?.['vm']);
    const stampedNumberStr = stripLit(pointerRow?.['kaNum']);

    // Re-pack the stamped per-author NUMBER into the full packed kaId:
    //   kaId = (uint160(author) << 96) | number   (matches KaNumberAllocator)
    let packedKaId: bigint | undefined;
    if (stampedNumberStr != null && stampedNumberStr !== '') {
      try {
        const authorBits = BigInt(ethers.getAddress(seal.authorAddress));
        packedKaId = (authorBits << 96n) | BigInt(stampedNumberStr);
      } catch (err) {
        this.log.warn(
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          `Failed to re-pack stamped kaId number "${stampedNumberStr}" for <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const newMerkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);

    let result: PublishResult;
    if (vmCurrent && packedKaId !== undefined) {
      // ── UPDATE PATH ──
      // The name already has a confirmed VM version. Reuse its kaId and call
      // the on-chain update primitive. The publisher's update path recomputes
      // the merkle from the SWM-selected quads and requires a
      // precomputedUpdateAttestation over (kaId, newMerkleRoot, author); we
      // mint it here from the seal's merkle using the seal's author signer.
      const updateQuads = await this._loadSelectedSWMQuads(
        contextGraphId,
        { rootEntities: seal.rootEntities },
        opts?.subGraphName,
      );
      const updateAttestation = await this._buildPrecomputedUpdateAttestationForSeal(
        packedKaId,
        seal,
      );
      result = await this.update(
        packedKaId,
        contextGraphId,
        updateQuads.map((q) => ({ ...q, graph: '' })),
        [],
        {
          operationCtx: opts?.operationCtx,
          onPhase: opts?.onPhase,
          precomputedUpdateAttestation: updateAttestation,
        },
      );

      // Stamp UPDATE provenance + re-stamp VM/WM pointers to the new merkle.
      if (result.status === 'confirmed' || result.status === 'tentative') {
        try {
          const priorBare = vmCurrent.startsWith('0x') ? vmCurrent.slice(2) : vmCurrent;
          const priorUri = `${lifecycleUri}#assertion-${priorBare}`;
          // Re-point VM + WM to the new merkle (drop-then-set), then record the
          // revision chain via prov:wasRevisionOf <prior>.
          await this._stampPointer(lifecycleUri, VM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
          await this._stampPointer(lifecycleUri, WM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
          await this.store.insert([
            { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
            { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: `"${priorBare}"`, graph: metaGraph },
          ]);
        } catch (err) {
          this.log.warn(
            opts?.operationCtx ?? createOperationContext('publishFromSWM'),
            `Failed to stamp update provenance for <${lifecycleUri}>: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } else {
      // ── MINT PATH ──
      // Round 4 review §9 — scope the SWM CONSTRUCT to the seal's
      // `rootEntities` instead of `'all'`. The seal's rootEntities were
      // captured at finalize time so this selection deterministically yields
      // the post-promote SWM slice the seal commits to.
      //
      // OT-RFC-43 A2 (decision 1) — REUSE the finalize-stamped kaId. We thread
      // `reservedKaId: packedKaId` down so ensureReservedKaId short-circuits
      // (no second allocation). When no allocator stamped one (mock/no-chain),
      // packedKaId is undefined and the publisher keeps its existing behavior.
      result = await this.publishFromSharedMemory(
        contextGraphId,
        { rootEntities: seal.rootEntities },
        {
          operationCtx: opts?.operationCtx,
          onPhase: opts?.onPhase,
          subGraphName: opts?.subGraphName,
          publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride,
          publishEpochs: opts?.publishEpochs,
          clearSharedMemoryAfter: opts?.clearSharedMemoryAfter,
          reservedKaId: packedKaId,
          // Wired through to the inner publisher.publish() via
          // publishFromSharedMemory's `precomputedAttestation` option.
          // Skips the publisher's signing entirely.
          precomputedAttestation: {
            expectedMerkleRoot: seal.merkleRoot,
            authorAddress: seal.authorAddress,
            signature: { r: seal.authorAttestationR, vs: seal.authorAttestationVS },
            schemeVersion: seal.authorSchemeVersion,
          },
        },
      );

      // On confirmed mint, stamp VM pointer + publish receipt on _meta.
      if (result.status === 'confirmed' && result.onChainResult) {
        try {
          const receiptQuads = buildAssertionPublishReceiptQuads({
            assertionUri,
            metaGraph,
            txHash: result.onChainResult.txHash ?? '',
            blockNumber: BigInt(result.onChainResult.blockNumber ?? 0),
            kaId: result.onChainResult.batchId ?? 0n,
          });
          await this.store.insert(receiptQuads);
        } catch (err) {
          this.log.warn(
            opts?.operationCtx ?? createOperationContext('publishFromSWM'),
            `Failed to write publish receipt for <${assertionUri}>: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    // OT-RFC-43 A2 (decision 2) — stamp the VM pointer on the lifecycle URN
    // whenever the publish/update is confirmed. (For the mint path this is the
    // first VM pointer; for the update path the DELETE/INSERT above already set
    // it, and this idempotent re-stamp is a no-op.)
    if (result.status === 'confirmed' || result.status === 'tentative') {
      try {
        await this._stampPointer(lifecycleUri, VM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
        // OT-RFC-44 Design B — the assertion now lives at Verifiable Memory, so
        // make its lifecycle marker match the on-chain reality: flip
        // dkg:memoryLayer -> "VM" and dkg:state -> "published". The VM record is
        // thus equivalent to the WM/SWM ones, with the extra transaction metadata
        // (dkg:vmCurrentAssertion + dkg:kaId + the on-chain UAL) layered on top.
        // Promote stamps memoryLayer "SWM" on BOTH the lifecycle-URN and the
        // data-graph-URI forms, so flip both — otherwise the published assertion
        // lingers in the Shared-Memory layer (the dedicated published-metadata
        // flip never fired: its trigger gate joins on dkg:rootEntity/dkg:agent
        // predicates the lifecycle record does not carry).
        const MEMORY_LAYER_PRED = 'http://dkg.io/ontology/memoryLayer';
        const STATE_PRED = 'http://dkg.io/ontology/state';
        for (const subj of [lifecycleUri, assertionUri]) {
          await this.store.deleteByPattern({ subject: subj, predicate: MEMORY_LAYER_PRED, graph: metaGraph });
          await this.store.insert([
            { subject: subj, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiedMemory}"`, graph: metaGraph },
          ]);
        }
        await this.store.deleteByPattern({ subject: lifecycleUri, predicate: STATE_PRED, graph: metaGraph });
        await this.store.insert([
          { subject: lifecycleUri, predicate: STATE_PRED, object: '"published"', graph: metaGraph },
        ]);
        // SUBSTRATE-2 — re-point dkg:assertionGraph to the per-KA verified-
        // memory graph this publish actually wrote
        // (…/_verified_memory/{author}/{number}). promote() left the pointer on
        // the SWM graph, which the post-confirm SWM cleanup then empties — so
        // without this re-stamp the _meta index follows a stale pointer to an
        // empty graph instead of the live VM data. Mirrors the wm→swm re-stamp
        // in generateAssertionPromotedMetadata, for the swm→vm transition. The
        // graph URI is derived from the minted kaId exactly as the data write
        // (publishFromSharedMemory at dkg-publisher.ts: VerifiedMemory layer,
        // {kaId>>96}, {kaId & 2^96-1}, subGraphName) derives it, so the pointer
        // and the data always name the same graph.
        //
        // Gated on confirmed + onChainResult: that's the exact branch that ran
        // the post-confirmation VM data write, so the graph is guaranteed to
        // exist. A `tentative` publish (no on-chain result yet) hasn't written
        // VM data, so we leave the pointer alone rather than aim it at a graph
        // that doesn't exist yet.
        if (result.status === 'confirmed' && result.onChainResult) {
          const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';
          // Derive the VM graph URI from the SAME kaId the data write used.
          // `result.kaId` is the canonical packed id (author<<96 | number)
          // returned by the publishFromSharedMemory/update call above — i.e. the
          // exact id that named the …/_verified_memory/{author}/{number} graph,
          // so the pointer and the data always agree. `packedKaId` (the reserved,
          // finalize-stamped id threaded down as `reservedKaId`) is an equal
          // fallback. We deliberately do NOT use `onChainResult.batchId`: it only
          // equals the packed kaId on some adapters (when tokenId !== kaId it is
          // a separate batch identifier), which would point the pointer at the
          // wrong graph.
          const vmKaId = result.kaId ?? packedKaId;
          if (vmKaId !== undefined && vmKaId !== null) {
            const vmKaIdBig = BigInt(vmKaId);
            const vmAuthor = '0x' + (vmKaIdBig >> 96n).toString(16).padStart(40, '0');
            const vmNumber = vmKaIdBig & ((1n << 96n) - 1n);
            const vmGraph = contextGraphLayerUri(contextGraphId, MemoryLayer.VerifiedMemory, vmAuthor, vmNumber, opts?.subGraphName);
            await this.store.deleteByPattern({ subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, graph: metaGraph });
            await this.store.insert([
              { subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, object: vmGraph, graph: metaGraph },
            ]);
          }
        }
      } catch (err) {
        this.log.warn(
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          `Failed to stamp VM lifecycle marker for <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return { ...result, assertionUri, seal };
  }

  /**
   * OT-RFC-43 A2 — mint a `precomputedUpdateAttestation` over
   * `UpdateAuthorAttestation(kaId, newMerkleRoot=seal.merkleRoot, author)` for
   * the in-process update path. Signs with the SAME author the seal recorded:
   * a custodial agent's local key when available, otherwise the publisher EOA
   * (the finalize-time publisher fallback). Self-sovereign authors whose keys
   * the daemon doesn't hold must use the explicit `/api/update` route with a
   * pre-signed attestation.
   */
  async _buildPrecomputedUpdateAttestationForSeal(
    this: DKGAgent,
    kaId: bigint,
    seal: AssertionSeal,
  ): Promise<NonNullable<PublishOptions['precomputedUpdateAttestation']>> {
    const typedData = buildUpdateAuthorAttestationTypedData({
      chainId: seal.chainId,
      kav10Address: seal.kav10Address,
      kaId,
      newMerkleRoot: seal.merkleRoot,
      authorAddress: seal.authorAddress,
      schemeVersion: seal.authorSchemeVersion,
    });
    const custodialKey = this.getCustodialAgentPrivateKey(seal.authorAddress);
    let r: Uint8Array;
    let vs: Uint8Array;
    if (custodialKey) {
      const wallet = new ethers.Wallet(custodialKey.startsWith('0x') ? custodialKey : '0x' + custodialKey);
      const sigHex = await wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
      const sig = ethers.Signature.from(sigHex);
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
    } else {
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress || fallbackAddress.toLowerCase() !== seal.authorAddress.toLowerCase()) {
        throw new Error(
          `publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation for author ` +
            `${seal.authorAddress} — no custodial key on file and it is not the publisher EOA. ` +
            `Use the /api/update route with a pre-signed UpdateAuthorAttestation instead.`,
        );
      }
      const compact = await this.publisher.signAuthorAttestationAsPublisher(typedData);
      r = compact.r;
      vs = compact.vs;
    }
    return {
      expectedNewMerkleRoot: seal.merkleRoot,
      authorAddress: seal.authorAddress,
      signature: { r, vs },
      schemeVersion: seal.authorSchemeVersion,
    };
  }

  /**
   * OT-RFC-43 A2 — idempotent per-layer pointer (re)stamp on the lifecycle URN.
   * Drop-then-set the single value for `pred`. Uses `deleteByPattern` + `insert`
   * (NOT a SPARQL UPDATE string) because the oxigraph storage adapter's
   * `query()` rejects DELETE/INSERT — `stampLayerPointerSparql` is reserved for
   * backends that accept UPDATE via query(). `merkleHex` is stored bare (no 0x).
   */
  async _stampPointer(
    this: DKGAgent,
    lifecycleUri: string,
    pred: string,
    merkleHex: string,
    metaGraph: string,
  ): Promise<void> {
    const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
    await this.store.deleteByPattern({ subject: lifecycleUri, predicate: pred, graph: metaGraph });
    await this.store.insert([
      { subject: lifecycleUri, predicate: pred, object: `"${bare}"`, graph: metaGraph },
    ]);
  }

  /**
   * OT-RFC-43 A2 (decision 2) — stamp `dkg:swmCurrentAssertion` on the
   * lifecycle URN when an assertion is promoted/shared into SWM. The pointer
   * value is the assertion's sealed merkle root hex (read from the seal on the
   * assertion-graph URI). Best-effort: a missing seal (a non-finalized
   * promote) leaves the SWM pointer unset, which `deriveStatus` reads as "not
   * yet wm-sealed for SWM". Never throws — the SWM share itself already
   * committed.
   */
  async _stampSwmPointer(
    this: DKGAgent,
    contextGraphId: string,
    name: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<void> {
    try {
      const metaGraph = contextGraphMetaUri(contextGraphId);
      const assertionUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
      const lifecycleUri = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
      const metaResult = await this.store.query(
        `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
      );
      const metaQuads = metaResult.type === 'quads' ? metaResult.quads : [];
      const seal = parseAssertionSealQuads(metaQuads, assertionUri);
      if (!seal) return; // not finalized — nothing to point at
      const merkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);
      await this._stampPointer(lifecycleUri, SWM_CURRENT_ASSERTION_PRED, merkleHexBare, metaGraph);
    } catch (err) {
      this.log.warn(
        createOperationContext('share'),
        `Failed to stamp swmCurrentAssertion for "${name}" in "${contextGraphId}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Publish shared memory content: read from SWM graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * SWM state can promote it to canonical without re-downloading the full payload.
   */
  async publishFromSharedMemory(this: DKGAgent,
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      clearSharedMemoryAfter?: boolean;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      /** @deprecated Use subContextGraphId */
      contextGraphId?: string | bigint;
      subContextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
      subGraphName?: string;
      /**
       * Per-publish override for the on-chain
       * `KnowledgeAssetsV10.PublishParams.publisherNodeIdentityId`
       * attribution field (RFC-001 §4). Threaded as a per-call option
       * into `publisher.publishFromSharedMemory` — no global mutation,
       * so concurrent publishes with conflicting overrides are safe.
       *
       * Lets an edge-mode operator route a publish through the
       * home-core's `publishFromSharedMemory` while attributing the
       * publishing-factor credit (and PCA discount, when the submitter
       * is on the named core's `authorizedKeys`) to a different core.
       * `0n` is a valid explicit value and means "no attribution"
       * (RFC-001 §4(d)) — the contract validates this case and the
       * publish proceeds on-chain. The publisher's own
       * `publisherNodeIdentityId` is unchanged and continues to be
       * used for ACK self-signing and signer resolution.
       */
      publisherNodeIdentityIdOverride?: bigint;
      publishEpochs?: number;
      /**
       * OT-RFC-43 A2 (decision 1) — precomputed packed kaId stamped at
       * `assertionFinalize` (ALLOCATE-AT-FINALIZE). When set, the publisher's
       * `ensureReservedKaId` REUSES it instead of allocating again, so a
       * finalize→publish for one KA mints exactly the stamped id (no
       * double-allocation). Undefined for direct/mock publishes — the
       * publisher then keeps its existing allocate-at-publish behavior.
       */
      reservedKaId?: bigint;
      /**
       * RFC-001 §9.x — pre-computed attestation captured by
       * `agent.assertion.finalize()`. When the caller has already
       * sealed a named assertion they can plumb the seal here verbatim
       * and the publisher forwards it unchanged.
       *
       * If omitted AND the publish is going on-chain (V10-capable
       * adapter + on-chain CG id), the agent mints a seal inline at
       * the selection boundary using `authorAgentAddress` /
       * `preSignedAuthorAttestation` / publisher fallback. This is the
       * "selection-based publish" UX bridge — agents/users keep
       * picking rootEntities post-hoc, but the seal is still computed
       * and signed before the publisher sees the payload.
       */
      precomputedAttestation?: PublishOptions['precomputedAttestation'];
      /**
       * Agent address to attribute authorship to when minting an
       * inline seal at this layer. Must be a registered local agent
       * with custodial keys (the daemon holds the private key). For
       * self-sovereign agents use `preSignedAuthorAttestation`. Has
       * no effect when `precomputedAttestation` is also supplied.
       */
      authorAgentAddress?: string;
      /**
       * Pre-signed AuthorAttestation by a self-sovereign agent whose
       * private key isn't held by the daemon. Has no effect when
       * `precomputedAttestation` is also supplied. Mutually exclusive
       * with `authorAgentAddress`.
       */
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
      /** Author scheme version override (defaults to AUTHOR_SCHEME_VERSION_V1). */
      schemeVersion?: number;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const effectiveSubCG = options?.subContextGraphId ?? options?.contextGraphId;
    // `ctxGraphIdStr` doubles as `publishContextGraphId` for REMAP-flow
    // publishes — the publisher uses its presence as a signal to DELETE the
    // original copy from the default data graph. Keep it empty for non-REMAP
    // publishes so we don't accidentally trigger the delete.
    const ctxGraphIdStr = effectiveSubCG != null ? String(effectiveSubCG) : undefined;

    const onChainId = ctxGraphIdStr ?? (await this.getContextGraphOnChainId(contextGraphId)) ?? undefined;

    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    // RFC-001 §9.x — selection-based publish bridge. If the caller
    // already sealed the content (named-assertion lifecycle) they
    // pass `precomputedAttestation` through and we forward verbatim.
    // Otherwise, when we know we're going on-chain (V10 adapter + CG
    // has on-chain id), we mint the seal here at the selection
    // boundary so the publisher's "no on-chain publish without
    // precomputedAttestation" guard is satisfied.
    let resolvedSeal = options?.precomputedAttestation;
    if (
      !resolvedSeal &&
      onChainId != null &&
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
    ) {
      const swmQuads = await this._loadSelectedSWMQuads(
        contextGraphId,
        selection,
        options?.subGraphName,
      );
      if (swmQuads.length > 0) {
        resolvedSeal = await this._buildPrecomputedAttestationForSelection(
          contextGraphId,
          swmQuads,
          {
            targetOnChainCgId: onChainId,
            ...(options?.authorAgentAddress != null
              ? { authorAgentAddress: options.authorAgentAddress }
              : {}),
            ...(options?.preSignedAuthorAttestation != null
              ? { preSignedAuthorAttestation: options.preSignedAuthorAttestation }
              : {}),
            ...(options?.schemeVersion !== undefined
              ? { schemeVersion: options.schemeVersion }
              : {}),
          },
        );
      }
    }

    // OT-RFC-38 / LU-5 — for curated CGs (any private flavour: peer
    // allowlist OR agent allowlist), wrap the inline ACK payload with
    // AEAD using the publisher's swm-sender-key chainKey so cores hold
    // opaque bytes, not plaintext. Public CGs leave this undefined and
    // continue with the existing plaintext-inline path.
    //
    // Codex PR #608 R2 #12: bind AEAD to the target on-chain CG id
    // (`onChainId`) so consumers using the canonical chain id can
    // decrypt — without this, remap publishes (source SWM cg != target
    // chain cg) produced undecryptable payloads.
    const encryptInlinePayload = await this._resolveEncryptInlinePayload(
      contextGraphId,
      options?.subGraphName,
      options?.authorAgentAddress,
      onChainId ?? undefined,
    );
    if (encryptInlinePayload) {
      this.log.info(ctx, `LU-5: curated CG ${contextGraphId} — wrapping inline ACK payload with chain-key AEAD`);
    }
    // OT-RFC-38 LU-11 — also resolve the chunked emitter. Publisher
    // prefers the chunked path when both are set; single-blob remains
    // the unconditional fallback for any code path that resolves the
    // chunked callback to `undefined` (currently impossible since
    // both helpers share the curated probe, but kept defensively to
    // future-proof CG types whose chunked path might lag rollout).
    const encryptInlineChunked = await this._resolveEncryptInlineChunked(
      contextGraphId,
      options?.subGraphName,
      options?.authorAgentAddress,
      onChainId ?? undefined,
    );
    if (encryptInlineChunked) {
      this.log.info(ctx, `LU-11: curated CG ${contextGraphId} — chunked path active (per-chunk SWM gossip + V2 ACK)`);
    }

    const result = await this.publisher.publishFromSharedMemory(contextGraphId, selection, {
      operationCtx: ctx,
      clearSharedMemoryAfter: options?.clearSharedMemoryAfter,
      onPhase: options?.onPhase,
      publishContextGraphId: ctxGraphIdStr,
      onChainContextGraphId: onChainId,
      contextGraphSignatures: options?.contextGraphSignatures,
      v10ACKProvider,
      subGraphName: options?.subGraphName,
      publisherNodeIdentityIdOverride: options?.publisherNodeIdentityIdOverride,
      publishEpochs: options?.publishEpochs,
      precomputedAttestation: resolvedSeal,
      // OT-RFC-43 A2 — reuse the finalize-stamped packed kaId (no re-allocate).
      reservedKaId: options?.reservedKaId,
      encryptInlinePayload,
      encryptInlineChunked,
    });

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities = result.kaManifest.map(ka => ka.rootEntity);

      // Always carry the resolved on-chain CG id in the finalization gossip
      // so receiving cores promote SWM into the per-cgId `_meta` namespace
      // (`<cgName>/context/<cgId>/_meta`) that the RS prover reads from.
      // Without this the prover 404'd with `KCNotFoundError` on every
      // freshly-published KC even though the SWM payload had been
      // replicated — see scripts/devnet-test-rfc39-comprehensive.sh
      // Scenario A. We pass the *publisher-resolved* `onChainId` (which
      // includes both explicit REMAP targets and the auto-lookup fallback)
      // rather than the REMAP-only `ctxGraphIdStr`.
      const broadcastCgId = onChainId != null ? String(onChainId) : undefined;
      // PR #779 / #774 followup: tell receivers whether the publisher
      // kept a root-graph copy of the canonical quads. Same-graph
      // publishes (no explicit `subContextGraphId` / `publishContextGraphId`)
      // dual-write to the root `<cg>` graph and the per-on-chain-id
      // partition `<cg>/context/<ctxGraphId>` so label-scoped queries
      // resolve. Explicit-`subContextGraphId` / remap publishes delete
      // the root copy on purpose (`dkg-publisher.ts` ~line 1393), so
      // receivers MUST NOT dual-write either — otherwise a remap-style
      // KC would re-appear under the source CG's label on every replica.
      // `ctxGraphIdStr` is the publisher-side `publishContextGraphId`
      // (set on REMAP/explicit-subCG calls, undefined otherwise) — the
      // exact same signal the publisher uses to gate its own root delete.
      const keepRootCopyOnLabel = !ctxGraphIdStr;
      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        contextGraphId: contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        // GH#842: thread the real `(block, txIndex)` so receivers stamp the
        // exact same materialised version as the local publish promotion —
        // otherwise a same-block update vs publish would tie on the wire
        // and the stale publish-promotion could clobber the update.
        txIndex: result.onChainResult.txIndex ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities,
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        targetContextGraphId: result.contextGraphError ? undefined : broadcastCgId,
        subGraphName: options?.subGraphName,
        keepRootCopyOnLabel,
      };

      const topic = contextGraphFinalizationTopic(contextGraphId);
      try {
        await this.gossip.publish(topic, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast finalization for ${result.ual} to ${topic}${broadcastCgId ? ` (contextGraph=${broadcastCgId})` : ''}${result.contextGraphError ? ' (ctx-graph registration failed, omitting targetContextGraphId)' : ''}`);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }

      // Durable keep-root signal. The gossip envelope's `keepRootCopyOnLabel`
      // only reaches peers online for the broadcast; a subscriber that missed
      // it later recovers the publish via the chain-driven reconcile sweep,
      // which has no wire to learn the dual-write intent from. Persist the same
      // decision per root into SWM workspace meta — co-located with the per-root
      // `privateMerkleRoot` that already replicates to subscribers — so the
      // reconcile path can mirror the gossip dual-write decision. Read back by
      // `FinalizationHandler.getKeepRootCopySignal`. Updates reuse a root
      // entity, so replace any prior value rather than accumulate.
      try {
        const gm = new GraphManager(this.store);
        const wsMetaGraph = options?.subGraphName
          ? gm.sharedMemoryMetaUri(contextGraphId, options.subGraphName)
          : contextGraphWorkspaceMetaGraphUri(contextGraphId);
        const keepLiteral = `"${keepRootCopyOnLabel}"`;
        for (const root of rootEntities.filter(isSafeIri)) {
          await this.store.deleteByPattern({
            subject: root,
            predicate: KEEP_ROOT_COPY_PREDICATE,
            graph: wsMetaGraph,
          });
          await this.store.insert([{
            subject: root,
            predicate: KEEP_ROOT_COPY_PREDICATE,
            object: keepLiteral,
            graph: wsMetaGraph,
          }]);
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to persist keepRootCopyOnLabel signal for ${result.ual}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(this: DKGAgent,
    ...args: Parameters<DKGAgent['publishFromSharedMemory']>
  ): ReturnType<DKGAgent['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
  }

  /**
   * Register a new M/N signature-gated context graph on-chain.
   */
  async registerContextGraphOnChain(this: DKGAgent, params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.createOnChainContextGraph !== 'function') {
      throw new Error('createOnChainContextGraph not available on chain adapter');
    }
    const result = await this.chain.createOnChainContextGraph(params);
    const contextGraphId = result.contextGraphId.toString();
    // LU-2: per SPEC_CG_MEMORY_MODEL the on-chain CG no longer carries a
    // hosting committee — hosts are picked from the network sharding table
    // at publish time, so there is no per-CG `hosting-node` member roster
    // to upsert here. Participant-agent membership is unchanged.
    for (const agentAddress of params.participantAgents ?? []) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: agentAddress,
        role: 'participant-agent',
        status: 'active',
        source: 'on-chain-registration',
      });
    }
    this.log.info(ctx, `Created on-chain context graph ${result.contextGraphId}`);
    return result;
  }

  /**
   * Link an already-published KC batch to a context graph.
   * Collects participant signatures and calls addBatchToContextGraph on-chain.
   */
  async addBatchToContextGraph(this: DKGAgent, params: {
    contextGraphId: string | bigint;
    batchId: bigint;
    merkleRoot?: Uint8Array;
    participantSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  }): Promise<{ success: boolean }> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.verify !== 'function') {
      throw new Error('verify not available on chain adapter');
    }

    let merkleRoot = params.merkleRoot;
    if (!merkleRoot) {
      const batch = (this.chain as any).getBatch?.(params.batchId);
      merkleRoot = batch?.merkleRoot;
    }

    const result = await this.chain.verify({
      contextGraphId: BigInt(params.contextGraphId),
      batchId: params.batchId,
      merkleRoot,
      signerSignatures: params.participantSignatures ?? [],
    });
    this.log.info(ctx, `addBatchToContextGraph: batch=${params.batchId} → ctxGraph=${params.contextGraphId} success=${result.success}`);
    return { success: result.success };
  }

  /**
   * Provision the node's on-chain profile (createProfile + stake) exactly once
   * at a time. `ensureProfile()` is a mutating multi-tx flow that can outlast
   * the boot read-timeout, so this guards against the boot path AND the
   * StorageACK retry both calling it while a prior submission may still be
   * settling — which could create a duplicate profile / double-stake (Codex
   * PR #901 round-3 :1685). It is NOT raced against a timeout: the staking tx
   * must run to completion. While a provisioning is in flight, concurrent
   * callers re-read the (possibly now-created) identity via `getIdentityId()`
   * instead of submitting a second `ensureProfile()`.
   */
  async provisionProfileGuarded(this: DKGAgent, ctx: OperationContext): Promise<bigint> {
    if (this.profileProvisioningInFlight) {
      // A provisioning is already running (boot or a prior retry). Don't submit
      // a second createProfile+stake — just read whatever identity exists now.
      this.log.info(ctx, 'Profile provisioning already in flight — re-reading identity instead of re-submitting');
      return this.chain.getIdentityId();
    }
    this.profileProvisioningInFlight = true;
    try {
      return await this.chain.ensureProfile({ nodeName: this.config.name });
    } finally {
      this.profileProvisioningInFlight = false;
    }
  }

  /**
   * (Re-)attempt on-chain identity registration. Safe to call multiple times.
   * Returns the identityId (>0n on success, 0n if chain is not configured).
   */
  async ensureIdentity(this: DKGAgent): Promise<bigint> {
    if (this.chain.chainId === 'none') return 0n;
    const effectiveRole = this.config.nodeRole ?? 'edge';
    const ctx = createOperationContext('system');
    let identityId = 0n;
    try {
      identityId = await this.chain.getIdentityId();
      if (identityId === 0n && effectiveRole === 'core') {
        this.log.info(ctx, 'ensureIdentity: no on-chain identity, creating profile...');
        identityId = await this.chain.ensureProfile({ nodeName: this.config.name });
        this.log.info(ctx, `ensureIdentity: profile created, identityId=${identityId}`);
      } else if (identityId === 0n) {
        return 0n;
      }
    } catch (err) {
      this.log.warn(ctx, `ensureIdentity error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        identityId = await this.chain.getIdentityId();
      } catch { /* ignore */ }
    }
    if (identityId > 0n) {
      this.publisher.setIdentityId(identityId);
    }
    return identityId;
  }

}
