// SPDX-License-Identifier: Apache-2.0

/**
 * Context-graph registration / sub-graph subsystem extracted from dkg-agent.ts
 * as a mixin holder: on-chain registration + policy reads, stored
 * registration options, allowed-peers, sub-graph create/list/remove,
 * local-CG materialization, and endorsement trust-target helpers. 1:1 move;
 * methods take `this: DKGAgent` so cross-calls resolve against the composed
 * class.
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
  assertRdfLiteralMutf8Safe,
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

export class ContextGraphRegistryMethods extends DKGAgentBase {
  /**
   * Check whether a context graph has been registered on-chain.
   */
  async isContextGraphRegistered(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered';
  }

  /**
   * OT-RFC-38 / LU-6 Phase B (Codex PR #610 round-2 #5) — cheap
   * preflight for the deferred-registration auto-register-then-
   * publish flow. Returns true iff this agent has at least one
   * locally-owned entity staged in shared memory for the given CG.
   *
   * Used by `memory.ts` to short-circuit BEFORE spending gas on
   * `registerContextGraph` when the publish would have failed anyway
   * (e.g. SWM empty because the agent never wrote, or the user
   * cleared SWM after staging). Pre-fix, the flow registered first
   * and then surfaced a 500 from the publish leg — wasting the
   * registration gas on a publish that couldn't succeed.
   *
   * Note: this only catches the "no local writes" case. Invalid
   * `selection.rootEntities` (referencing entities never staged)
   * still fails inside `publishFromSharedMemory` after register —
   * the cheap preflight here doesn't materialise the selection.
   */
  hasPendingSharedMemoryWrites(this: DKGAgent, contextGraphId: string): boolean {
    const owned = this.workspaceOwnedEntities.get(contextGraphId);
    return owned !== undefined && owned.size > 0;
  }

  async getContextGraphOnChainId(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const subscribed = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (subscribed) return subscribed;

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> ?id } } LIMIT 1`,
      { signal: options.signal },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const value = result.bindings[0]?.['id'];
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  }

  /**
   * Issue #872 — best-effort read of the on-chain
   * `(accessPolicy, publishPolicy)` enum pair for a CG. Sources, in
   * order:
   *
   *   1. {@link onChainAccessPolicyCache} / {@link onChainPublishPolicyCache} —
   *      populated eagerly by the `ContextGraphCreated` chain-event
   *      handler. The keys are the on-chain numeric ids; if the caller
   *      passed a cleartext local id, we re-key via
   *      {@link subscribedContextGraphs} or {@link getContextGraphOnChainId}.
   *
   *   2. Local `_meta` / ontology triple store for `accessPolicy`
   *      only. The CG creator also persists `dkg:publishPolicy` in
   *      `_meta` at create time, but that triple is not updated by
   *      `updatePublishPolicy`, so it is never used as an
   *      authorization-positive publish-policy answer here.
   *
   *   3. Direct chain RPC (Codex round-3 fix): for registered CGs
   *      where the cache leaves `publishPolicy` undefined/stale, or
   *      where steps 1 and 2 still leave `accessPolicy` undefined,
   *      query the contract directly via
   *      `chain.getContextGraphAccessPolicy` /
   *      `chain.getContextGraphPublishPolicy`. The result populates
   *      the in-memory cache so subsequent calls don't re-query.
   *
   * Steps 2 and 3 are GATED on {@link isContextGraphRegistered}
   * (Codex round-2 fix): unregistered locally-created CGs reflect
   * create-time *intent* via local triples, not an on-chain
   * commitment, and the chain itself has no record. Treating local
   * source as authoritative pre-registration would bypass the
   * owner-guard on a CG the curator hasn't actually committed to.
   *
   * Returns `{}` (both fields `undefined`) when neither source has an
   * answer. Callers MUST treat `undefined` fields as unknown — fail
   * closed for policy-gated decisions rather than assuming a
   * permissive default. Failures in the chain RPC fallback (RPC
   * unavailable, contract not deployed, transient errors) are logged
   * and the field is left undefined.
   */
  async getContextGraphOnChainPolicy(this: DKGAgent, contextGraphId: string, options?: {
    /**
     * Cap the age (ms) of a cached `publishPolicy` entry this call will accept;
     * default `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` (60s). `publishPolicy` is
     * mutable on-chain (`PublishPolicyUpdated`) and the agent has no event
     * watcher, so the cache can be stale-PERMISSIVE for up to its age after an
     * owner downgrades open→curated publish. Most callers (e.g. the
     * import-artifact owner guard) tolerate the full 60s. A SECURITY-POSITIVE
     * admission decision (host-mode self-signed plaintext ingest, see
     * `isConfirmedPublicForHostMode`) passes a SHORT window
     * (`HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS` = 5s): an open→curated
     * downgrade is then honored within seconds, AND — because the resolver
     * writes through to this same cache — the chain RPC is rate-capped to ~1
     * per window per CG instead of an `eth_call` on every admitted envelope
     * (Branimir review #1239 follow-on). An RPC failure/timeout still leaves
     * `publishPolicy` undefined → the caller fails closed. (`accessPolicy` is
     * immutable on-chain, so its cache read below is left un-TTL'd.)
     */
    publishPolicyMaxCacheAgeMs?: number;
  }): Promise<{
    accessPolicy?: number;
    publishPolicy?: number;
  }> {
    let accessPolicy = this.onChainAccessPolicyCache.get(contextGraphId);
    // Codex review on #872 — `publishPolicy` is mutable on-chain
    // (`PublishPolicyUpdated`) but the cache is only seeded by
    // `ContextGraphCreated`. Treat entries older than
    // `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` as stale so the chain-RPC
    // fallback below re-verifies before the caller relaxes the
    // import-artifact owner guard. The accessPolicy cache is left
    // untouched here: it's also used by SWM gossip authorization paths
    // (lines ~1779, ~8403, ~10073) where stale-permissive cannot
    // escalate privilege (gossip decrypt is gated by sender-key
    // issuance) and stale-restrictive only causes a transient deny.
    const isPublishPolicyCacheFresh = (key: string): boolean => {
      const fetchedAt = this.onChainPublishPolicyCacheUpdatedAt.get(key);
      if (fetchedAt === undefined) return false;
      // A security-positive caller can shrink the accepted cache age (e.g. the
      // host-mode admission gate passes ~5s) so an open→curated downgrade is
      // re-verified within seconds, while still rate-capping the chain RPC to
      // ~1 per window per CG. Default is the general 60s TTL.
      const maxAge = options?.publishPolicyMaxCacheAgeMs ?? ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS;
      return Date.now() - fetchedAt <= maxAge;
    };
    let publishPolicy = isPublishPolicyCacheFresh(contextGraphId)
      ? this.onChainPublishPolicyCache.get(contextGraphId)
      : undefined;
    // Track the resolved numeric on-chain id so we can both look it
    // up in the cache (round-2) and use it as the chain-RPC fallback
    // key (round-3). Lazily resolved — creators may pass the
    // numeric id directly in which case no extra SPARQL is needed.
    let onChainId: string | undefined;

    if (accessPolicy === undefined || publishPolicy === undefined) {
      onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
        ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
        ?? undefined;
      if (onChainId && onChainId !== contextGraphId) {
        if (accessPolicy === undefined) accessPolicy = this.onChainAccessPolicyCache.get(onChainId);
        if (publishPolicy === undefined && isPublishPolicyCacheFresh(onChainId)) {
          publishPolicy = this.onChainPublishPolicyCache.get(onChainId);
        }
      }
    }

    // Codex review (round 2, finding B): the local access-policy
    // fallback below reads triples that `createContextGraph` writes
    // synchronously — BEFORE
    // `registerContextGraph` confirms the CG on-chain. For a CG
    // that's still in the local-only `unregistered` state, those
    // triples reflect the creator's *intent*, not an on-chain
    // commitment. Treating them as authoritative would let the read
    // relaxation kick in for a CG the curator hasn't actually
    // committed to making public, bypassing the owner guard.
    //
    // Codex review (round 6, line 15487 — 2026-06-01): the prior gate
    // only consulted `dkg:registrationStatus = "registered"`, which
    // `registerContextGraph` writes ON THE CREATOR'S NODE only. Non-
    // creator peers bootstrap CG metadata via `ensureContextGraphLocally`
    // with status="unregistered" and never flip it. After a daemon
    // restart the chain-event cache loses its in-memory entries, the
    // status check still returns false, this gate fails closed, and
    // cross-agent reads on legitimately public+open CGs regress to
    // 403 for non-creators.
    //
    // Accept any of these as proof of an on-chain commitment:
    //   - `dkg:registrationStatus = "registered"` (creator path), OR
    //   - a non-zero numeric `onChainId` already resolved from
    //     subscribed state or local meta (replicator path — the
    //     on-chain id is only ever known if the chain assigned it).
    //
    // An unregistered locally-created CG has neither, so the gate
    // still fails closed for it.
    if (accessPolicy === undefined || publishPolicy === undefined) {
      const registeredViaStatus = await this.isContextGraphRegistered(contextGraphId).catch(() => false);
      let registeredViaOnChainId = false;
      if (!registeredViaStatus) {
        if (onChainId === undefined) {
          onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
            ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
            ?? undefined;
        }
        if (onChainId) {
          try {
            registeredViaOnChainId = BigInt(onChainId) > 0n;
          } catch {
            registeredViaOnChainId = false;
          }
        }
      }
      if (!registeredViaStatus && !registeredViaOnChainId) {
        return {
          ...(accessPolicy === 0 || accessPolicy === 1 ? { accessPolicy } : {}),
          ...(publishPolicy === 0 || publishPolicy === 1 ? { publishPolicy } : {}),
        };
      }
    }

    if (accessPolicy === undefined) {
      const stored = await this.readLocalAccessPolicyEnum(contextGraphId).catch(() => undefined);
      if (stored !== undefined) accessPolicy = stored;
    }

    // Codex review (round 3): non-creator peers never receive the
    // `dkg:publishPolicy` triple — it's only written to local
    // `_meta` on the creator's node. They observe the chain event
    // at subscribe time which populates the in-memory caches above,
    // but those caches are lost on daemon restart. Without a
    // durable replicated source, `publishPolicy` permanently
    // disappears for non-creator peers once the chain poller's
    // replay window rolls past the create block — which makes
    // `isPublicOpenContextGraph()` return false and cross-agent
    // `/import-artifact/*` reads regress to 403 on legitimately
    // public + open CGs.
    //
    // Fall back to a direct chain RPC for the missing fields. The
    // fallback is gated on `registered === true` above so an
    // unregistered local-only CG cannot poison the answer; the
    // chain itself is the authoritative source. Failures (RPC
    // unavailable, contract not deployed, transient errors) leave
    // the field undefined and the daemon route falls back to the
    // strict guard — fail-closed.
    if (
      (accessPolicy === undefined || publishPolicy === undefined)
      && this.chain
    ) {
      if (onChainId === undefined) {
        onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId
          ?? (await this.getContextGraphOnChainId(contextGraphId).catch(() => null))
          ?? undefined;
      }
      let numericId: bigint | undefined;
      if (onChainId) {
        try {
          const parsed = BigInt(onChainId);
          if (parsed > 0n) numericId = parsed;
        } catch {
          numericId = undefined;
        }
      }
      if (numericId !== undefined) {
        const rpcCtx = createOperationContext('resolve');
        // Round-4 fix: bound each chain-RPC call so an unreachable
        // RPC stack (every endpoint returning 429 / hanging on
        // connect) cannot block the caller past the daemon-ready
        // budget. The fallback is an optimisation — failing fast
        // and returning undefined is correct (fail-closed via the
        // strict guard at the route layer). 2.5s is tight enough
        // to stay well under the 45s daemon-ready budget even when
        // both fallbacks fire back-to-back, while still allowing a
        // single slow eth_call hop to succeed under normal load.
        const CHAIN_RPC_FALLBACK_TIMEOUT_MS = 2_500;
        const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T | typeof TIMEOUT_SENTINEL> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
            timer = setTimeout(() => {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.${label}(${onChainId}) timed out after ${CHAIN_RPC_FALLBACK_TIMEOUT_MS}ms — treating as UNKNOWN (fail-closed)`,
              );
              resolve(TIMEOUT_SENTINEL);
            }, CHAIN_RPC_FALLBACK_TIMEOUT_MS);
            // Allow node to exit even if the chain promise never
            // settles (test scenario: dead RPC + fake daemon).
            timer.unref?.();
          });
          return Promise.race([
            p.finally(() => { if (timer) clearTimeout(timer); }),
            timeout,
          ]);
        };
        if (publishPolicy === undefined) {
          const getPublishPolicy = this.chain.getContextGraphPublishPolicy;
          if (typeof getPublishPolicy === 'function') {
            try {
              const result = await withTimeout(
                getPublishPolicy.call(this.chain, numericId),
                'getContextGraphPublishPolicy',
              );
              if (result !== TIMEOUT_SENTINEL) {
                const pp = result?.publishPolicy;
                if (pp === 0 || pp === 1) {
                  publishPolicy = pp;
                  this.onChainPublishPolicyCache.set(onChainId!, pp);
                  this.onChainPublishPolicyCacheUpdatedAt.set(onChainId!, Date.now());
                }
              }
            } catch (err) {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.getContextGraphPublishPolicy(${onChainId}) failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        if (accessPolicy === undefined) {
          const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
          if (typeof getAccessPolicy === 'function') {
            try {
              const ap = await withTimeout(
                getAccessPolicy.call(this.chain, numericId),
                'getContextGraphAccessPolicy',
              );
              if (ap !== TIMEOUT_SENTINEL && (ap === 0 || ap === 1)) {
                accessPolicy = ap;
                this.onChainAccessPolicyCache.set(onChainId!, ap);
              }
            } catch (err) {
              this.log.warn(
                rpcCtx,
                `getContextGraphOnChainPolicy: chain.getContextGraphAccessPolicy(${onChainId}) failed — treating as UNKNOWN (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }

    return {
      ...(accessPolicy === 0 || accessPolicy === 1 ? { accessPolicy } : {}),
      ...(publishPolicy === 0 || publishPolicy === 1 ? { publishPolicy } : {}),
    };
  }

  /**
   * Issue #872 — read the persisted `dkg:accessPolicy` literal from
   * the ontology graph (open CGs) or `_meta` (curated CGs) and map it
   * back to the on-chain enum (`"public"` → `0`, `"private"` → `1`).
   * Returns `undefined` when no triple is present locally. Used by
   * {@link getContextGraphOnChainPolicy} as a fallback after the
   * chain-event cache miss.
   */
  async readLocalAccessPolicyEnum(this: DKGAgent, contextGraphId: string): Promise<number | undefined> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return undefined;
    }
    const stripped = (await this.getCgMeta(contextGraphId)).accessPolicy;
    if (stripped === 'public') return 0;
    if (stripped === 'private') return 1;
    return undefined;
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — read create-time `publishPolicy` and
   * `publishAuthorityAccountId` persisted by `createContextGraph`.
   * Returns `{}` when neither is set, mirroring the existing
   * "register-time-only knobs are undefined" behaviour for legacy CGs
   * created before this PR landed.
   *
   * Consumed by the deferred-registration auto-register call in the
   * VM-publish daemon route (`memory.ts`) to preserve the user's
   * create-time choice instead of silently falling back to the
   * access-policy-derived default. Codex PR #610 fd5b31f1 follow-up.
   */
  async getStoredContextGraphRegistrationOptions(this: DKGAgent, contextGraphId: string): Promise<{
    publishPolicy?: number;
    publishAuthorityAccountId?: bigint;
  }> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?pp ?paa WHERE { GRAPH <${cgMetaGraph}> {
        OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PUBLISH_POLICY}> ?pp }
        OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PUBLISH_AUTHORITY_ACCOUNT_ID}> ?paa }
      } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return {};
    const row = result.bindings[0] ?? {};
    const out: { publishPolicy?: number; publishAuthorityAccountId?: bigint } = {};
    const rawPp = row['pp'];
    if (typeof rawPp === 'string') {
      const stripped = rawPp.replace(/^"|"$/g, '');
      const n = Number(stripped);
      if (n === 0 || n === 1) out.publishPolicy = n;
    }
    const rawPaa = row['paa'];
    if (typeof rawPaa === 'string') {
      const stripped = rawPaa.replace(/^"|"$/g, '');
      try {
        const v = BigInt(stripped);
        if (v > 0n) out.publishAuthorityAccountId = v;
      } catch { /* not a valid bigint literal — skip */ }
    }
    return out;
  }

  /**
   * Get the peer allowlist for a context graph (if curated).
   * Returns null if no allowlist is set (open CG).
   */
  async getContextGraphAllowedPeers(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const peers = (await this.getCgMeta(contextGraphId, { signal: options.signal })).allowedPeers;
    return peers.length > 0 ? peers : null;
  }

  // ── Sub-Graph Management ───────────────────────────────────────────────

  /**
   * Create a named sub-graph within a context graph.
   * Registers it in the CG's `_meta` graph and creates the named graph in storage.
   * Sub-graphs use convention-based URI partitioning — no on-chain enforcement in V10.0.
   *
   * V10.0 replication behavior:
   * - Registration triples are stored locally by the admin. Peers also auto-register
   *   sub-graphs on gossip publish, SWM write, and finalization replay paths:
   *   `gossip-publish-handler.ts`, `workspace-handler.ts`, and
   *   `finalization-handler.ts` call `ensureSubGraph()` and backfill the full
   *   `_meta` registration when it is missing.
   * - Because `subGraphName` is carried on the wire (in the workspace publish request
   *   and the N-Quads' named-graph field), replicated data is routed into the correct
   *   sub-graph named graph on receiving nodes — not into the root data graph.
   * - On-chain contracts are unaware of sub-graphs; enforcement remains convention-based.
   */
  async createSubGraph(this: DKGAgent, contextGraphId: string, subGraphName: string, opts?: {
    description?: string;
    authorizedWriters?: string[];
  }): Promise<{ uri: string }> {
    const { validateSubGraphName, contextGraphSubGraphUri: sgUri } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) throw new Error(`Context graph "${contextGraphId}" does not exist`);

    const gm = new GraphManager(this.store);
    const uri = sgUri(contextGraphId, subGraphName);

    // Idempotency: check if already registered before inserting
    const existing = await this.listSubGraphs(contextGraphId);
    if (existing.some(sg => sg.name === subGraphName)) {
      this.log.info(
        createOperationContext('system'),
        `Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" → ${uri}`,
      );
      return { uri };
    }

    const { generateSubGraphRegistration } = await import('@origintrail-official/dkg-publisher');
    const registrationQuads = generateSubGraphRegistration({
      contextGraphId,
      subGraphName,
      createdBy: this.peerId,
      authorizedWriters: opts?.authorizedWriters,
      description: opts?.description,
      timestamp: new Date(),
    });

    await gm.ensureSubGraph(contextGraphId, subGraphName);
    await this.store.insert(registrationQuads);
    this.contextGraphMetaProjection.markDirty(contextGraphId);

    this.log.info(
      createOperationContext('system'),
      `Created sub-graph "${subGraphName}" in context graph "${contextGraphId}" → ${uri}`,
    );
    return { uri };
  }

  /**
   * List registered sub-graphs for a context graph.
   * Queries the CG's `_meta` graph for `dkg:SubGraph` registrations.
   */
  async listSubGraphs(this: DKGAgent, contextGraphId: string): Promise<Array<{
    uri: string;
    name: string;
    createdBy: string;
    createdAt?: string;
    description?: string;
  }>> {
    return (await this.getCgMeta(contextGraphId)).subGraphs;
  }

  /**
   * Remove a sub-graph registration from `_meta` and drop its named graphs.
   * Does NOT delete on-chain data — this is a local bookkeeping operation.
   */
  async removeSubGraph(this: DKGAgent, contextGraphId: string, subGraphName: string): Promise<void> {
    const { validateSubGraphName } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const gm = new GraphManager(this.store);

    const { subGraphDeregistrationSparql } = await import('@origintrail-official/dkg-publisher');
    try {
      await this.store.query(subGraphDeregistrationSparql(contextGraphId, subGraphName));
    } catch {
      // SPARQL DELETE WHERE may not be supported — delete quads manually
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
      await this.store.deleteByPattern({ graph: metaGraph, subject: subGraphUri });
    }

    const dataUri = gm.subGraphUri(contextGraphId, subGraphName);
    const metaUri = gm.subGraphMetaUri(contextGraphId, subGraphName);
    const privateUri = gm.subGraphPrivateUri(contextGraphId, subGraphName);
    const swmUri = gm.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaUri = gm.sharedMemoryMetaUri(contextGraphId, subGraphName);
    for (const uri of [dataUri, metaUri, privateUri, swmUri, swmMetaUri]) {
      try { await this.store.dropGraph(uri); } catch { /* graph may not exist */ }
    }

    // Drop assertion graphs under the sub-graph prefix
    const sgPrefix = `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`;
    const allGraphs = await listGraphsByPrefix(this.store, sgPrefix);
    for (const g of allGraphs) {
      if (g.startsWith(sgPrefix)) {
        try { await this.store.dropGraph(g); } catch { /* graph may not exist */ }
      }
    }

    // Clear SWM ownership cache for this sub-graph
    const ownershipKey = `${contextGraphId}\0${subGraphName}`;
    this.publisher.clearSubGraphOwnership(ownershipKey);
    this.contextGraphMetaProjection.markDirty(contextGraphId);

    this.log.info(
      createOperationContext('system'),
      `Removed sub-graph "${subGraphName}" from context graph "${contextGraphId}"`,
    );
  }

  /**
   * Idempotent "ensure" variant of createContextGraph for boot-time defaults.
   * If the context graph already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples. No on-chain registration
   * — use {@link registerContextGraph} for that.
   *
   * For curated CGs (detected by access policy in existing triples, or by the
   * caller passing `curated: true`), definition triples are written to the CG's
   * own `_meta` graph — never to ONTOLOGY — so they don't leak to the network.
   */
  async ensureContextGraphLocal(this: DKGAgent, opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    // OT-RFC-56 §4.6: this writer inserts the CG registration record RAW into
    // the network-replicated ONTOLOGY graph, bypassing the guarded publish
    // routes — the exact producer hole behind the 2026-07-08 mainnet
    // "skyocean" 177KB-description poison. Enforce the protocol literal
    // limit BEFORE any write; caller-correctable (CG creation is interactive).
    assertRdfLiteralMutf8Safe(`"${opts.name}"`, {
      label: 'contextGraph.name', subject: opts.id, predicate: DKG_ONTOLOGY.SCHEMA_NAME,
    });
    if (opts.description) {
      assertRdfLiteralMutf8Safe(`"${opts.description}"`, {
        label: 'contextGraph.description', subject: opts.id, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
      });
    }

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      // Bootstrap is a subscriber path: do NOT mint or backfill ownership
      // here. Creator/curator are stamped by `createContextGraph` (explicit
      // create) and `registerContextGraph` (explicit on-chain mint). When
      // every node backfilled itself on boot the `_meta` graph accumulated
      // one curator triple per node and `getContextGraphOwner`'s
      // `LIMIT 1` made ownership nondeterministic — any subscriber could
      // win the unordered query and look like the curator.
      this.subscribeToContextGraph(opts.id);
      this.setContextGraphSubscription(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        metaSynced: true,
        onChainId: this.subscribedContextGraphs.get(opts.id)?.onChainId,
      });
      return;
    }

    const gm = new GraphManager(this.store);
    const contextGraphUri = contextGraphDataGraphUri(opts.id);
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    // Curated CGs write definition triples to _meta so they stay invisible
    // to other nodes that sync ONTOLOGY. Open CGs go to ONTOLOGY for
    // network-wide discovery.
    const defGraph = opts.curated ? cgMetaGraph : ontologyGraph;

    // No creator/curator triples here — bootstrap is a subscriber-style
    // path. Ownership is established only when a node explicitly calls
    // `createContextGraph` (UI flow) or `registerContextGraph` (on-chain
    // mint), which both stamp the calling node. Stamping every booting
    // node would let `getContextGraphOwner` ("LIMIT 1" over `dkg:curator`)
    // resolve to an arbitrary subscriber and create a registration race
    // where node B mints a second V10 CG before node A's `onChainId`
    // propagates.
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${opts.curated ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // _meta triples: only registration status. `dkg:curator` is written
    // by `registerContextGraph` (or `createContextGraph` for the UI
    // create path) so exactly one node owns the graph locally.
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
    );

    if (opts.description) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    await this.store.insert(quads);
    this.contextGraphMetaProjection.markDirtyFromQuads(quads);
    await gm.ensureContextGraph(opts.id);

    this.subscribeToContextGraph(opts.id);
    this.setContextGraphSubscription(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    this.log.info(ctx, `Ensured context graph "${opts.id}" locally (${opts.curated ? 'curated' : 'open'})`);
  }

  async resolveEndorsementTrustTargets(this: DKGAgent,
    contextGraphId: string,
    targetUalOrRoot: string,
  ): Promise<string[]> {
    assertSafeIri(targetUalOrRoot);
    const dataGraph = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    const target = `<${targetUalOrRoot}>`;
    const namespaces = ['http://dkg.io/ontology/', 'https://dkg.network/ontology#'];
    const existsPatterns = [
      `GRAPH ?vmg { ${target} ?p ?o } FILTER(STRSTARTS(STR(?vmg), "${dataGraph}/_verifiable_memory/") || STR(?vmg) = "${dataGraph}") BIND(${target} AS ?hit)`,
      `GRAPH <${metaGraph}> { ${target} ?p ?o } BIND(${target} AS ?hit)`,
      ...namespaces.flatMap((ns) => [
        `GRAPH <${metaGraph}> { ?ka <${ns}rootEntity> ${target} } BIND(${target} AS ?hit)`,
        `GRAPH <${metaGraph}> { ?ka <${ns}partOf> ${target} } BIND(?ka AS ?hit)`,
      ]),
    ];

    const exists = await this.store.query(
      `SELECT ?hit WHERE { ${existsPatterns.map((p) => `{ ${p} }`).join(' UNION ')} } LIMIT 1`,
    );
    if (exists.type !== 'bindings' || exists.bindings.length === 0) {
      throw new Error(
        `Endorsement target ${targetUalOrRoot} was not found in context graph ${contextGraphId}`,
      );
    }

    // Read-both note (RFC ka-metadata-trim P3.1): the first pattern matches
    // the collapsed shape (`rootEntity` directly on the UAL target), the
    // second the legacy `<ual>/<n> partOf <ual>` token rows synced from older
    // nodes. Both were already queried here — no migration needed.
    const rootPatterns = namespaces.flatMap((ns) => [
      `GRAPH <${metaGraph}> { ${target} <${ns}rootEntity> ?root . }`,
      `GRAPH <${metaGraph}> { ?ka <${ns}partOf> ${target} ; <${ns}rootEntity> ?root . }`,
    ]);
    const roots = await this.store.query(
      `SELECT DISTINCT ?root WHERE { ${rootPatterns.map((p) => `{ ${p} }`).join(' UNION ')} }`,
    );
    const rootEntities = roots.type === 'bindings'
      ? (roots.bindings as Record<string, string>[]).map((row) => row.root).filter(Boolean)
      : [];
    return rootEntities.length > 0 ? rootEntities : [targetUalOrRoot];
  }

  async stampTrustLevel(this: DKGAgent,
    graph: string,
    subjects: Iterable<string>,
    level: TrustLevel,
  ): Promise<void> {
    const quads = buildTrustLevelQuads(subjects, level, graph) as Quad[];
    for (const quad of quads) {
      await this.store.deleteByPattern({
        graph: quad.graph,
        subject: quad.subject,
        predicate: TRUST_LEVEL_PREDICATE,
      });
    }
    if (quads.length > 0) {
      await this.store.insert(quads);
    }
  }

  async getSubjectsForRoots(this: DKGAgent, graph: string, roots: Iterable<string>): Promise<string[]> {
    const safeGraph = assertSafeIri(graph);
    const rootEntities = [...new Set([...roots].filter(Boolean))];
    if (rootEntities.length === 0) return [];
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${sparqlString(e)} || STRSTARTS(STR(?s), ${sparqlString(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT DISTINCT ?s WHERE { GRAPH <${safeGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    const subjects = new Set(rootEntities);
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        if (row.s) subjects.add(row.s);
      }
    }
    return [...subjects];
  }

  // ENDORSE

}

async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}
