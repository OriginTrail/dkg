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

export class JoinRequestMethods extends DKGAgentBase {
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
    this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
      contextGraphId,
      agentAddress: delegation.agentAddress,
      agentName,
    });
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

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(this: DKGAgent, contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

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

    await this.inviteAgentToContextGraph(contextGraphId, agentAddress, callerAgentAddress, delegation);

    // Mark request as approved
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"approved"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
    });
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
    // operator visibility — the substrate's periodic tick + on-connect
    // flush will drive the retry to eventual delivery without our help.
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
   * Re-attempt delivery of a single chat outbox entry. Centralised so
   * the periodic tick + the connection:open opportunistic flush share
   * one code path. Returns the entry's current state so the caller can
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
   * minutes. Daemon logs showed 31 `connection:open` events from P
   * (all inbound, all via R) + 20 opportunistic-flush attempts, all
   * failing dialProtocol — and then the moment ONE outbound connection
   * succeeded (which populated peerStore from outbound identify), the
   * very next opportunistic-flush delivered the queued message.
   *
   * The clean fix would be inside libp2p (`dialProtocol` should reuse
   * an existing open connection of any direction — see PR 5 in the
   * postmortem follow-up plan), but until that lands, populating
   * peerStore from the inbound circuit's address gives the dialer
   * something to find on the very next attempt.
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
          `Substrate will retry on its own backoff ladder + on the invitee's next reconnect.`,
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
   * Two-tier delivery:
   *   1. Targeted send to `curatorPeerId` first (if the V10 invite carried
   *      one — the common case). On success returns immediately, avoiding
   *      a fan-out to dozens of unrelated peers.
   *   2. Fallback broadcast in PARALLEL to every other connected peer via
   *      `Promise.allSettled`. This bounds total wall-clock time to one
   *      per-peer timeout (~5s) regardless of peer count, and lets the
   *      request still find its curator when the targeted dial fails or
   *      no curator peer id is known (legacy invites).
   *
   * The earlier sequential-await loop scaled as O(connected-peers ×
   * per-peer-timeout). On a real testnet node connected to 30+ peers the
   * worst-case wait was ~2.5 minutes per click; observed 2-3 min in the
   * field. Targeted-first collapses the common case to one round-trip,
   * and parallel broadcast caps the fallback at the timeout.
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
  ): Promise<{ delivered: number; errors: string[]; alreadyMember?: boolean }> {
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

    // Track whether the targeted send to `curatorPeerId` SUCCEEDED.
    // Two reasons matter for the broadcast fallback:
    //  - if it succeeded, curator is excluded from broadcast targets
    //    (no point re-sending), and we record it as the trusted
    //    decision sender.
    //  - if it failed (timeout, transient connection drop, response
    //    other than `ok`), curator is INCLUDED in the broadcast so a
    //    second chance over a fresh stream still finds them. The
    //    earlier behaviour skipped curator unconditionally — a single
    //    transient error then meant the request never reached them.
    let curatorTargetedSuccess = false;
    if (curatorPeerId !== this.peerId) {
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
          // Only the explicit invite-supplied curator is recorded as a
          // trusted decision sender — see `isTrustedJoinDecisionSender`
          // for why we won't trust arbitrary broadcast acceptors.
          recordAcceptedBy(curatorPeerId);
          curatorTargetedSuccess = true;
          const alreadyMember = !!response.alreadyMember;
          this.log.info(
            ctx,
            `Forwarded join request for "${contextGraphId}" from ${agentAddress}: 1 curator(s) received (direct${alreadyMember ? ', already-member' : ''})`,
          );
          return { delivered: 1, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
        }
        // Curator was reachable but rejected the request. Log + record
        // the reason so the joiner can see WHY (e.g. "unknown CG"
        // implies the cgId in the invite text is wrong).
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
        // Targeted dial failed — fall through to broadcast WITH curator
        // re-included as a target.
        const msg = dialErr instanceof Error ? dialErr.message : String(dialErr);
        this.log.warn(
          ctx,
          `Targeted join-request dial to curator ${curatorPeerId.slice(-8)} failed: ${msg}`,
        );
        errors.push(`${curatorPeerId.slice(-8)}: dial failed (${msg})`);
      }
    }

    // Reaching here means either (a) `curatorPeerId` was unset (legacy
    // multiaddr invite — broadcast is the only delivery option), or (b)
    // the targeted curator dial threw a transport error and broadcast
    // re-includes curatorPeerId in the cohort as a second chance over a
    // fresh stream. Non-curator peers that receive PROTOCOL_JOIN_REQUEST
    // for a CG they don't curate respond `{ ok: false, error: 'not
    // curator' }` and don't relay (see handler at dkg-agent.ts:1788),
    // so a broader "drop V10 broadcast entirely" cleanup is tracked as
    // a follow-up rather than landed here.
    const peers = this.node.libp2p.getPeers();
    const broadcastTargets = peers
      .map((p) => p.toString())
      .filter((id) => id !== this.peerId && (!curatorTargetedSuccess || id !== curatorPeerId));
    const results = await Promise.allSettled(
      broadcastTargets.map(async (remotePeerId) => {
        // rc.9 PR-10: substrate send. Broadcast queued = treat as
        // failure for this peer (the cohort is parallel — losing one
        // peer is fine, the others may succeed).
        const sendResult = await this.messenger.sendReliable(
          remotePeerId,
          PROTOCOL_JOIN_REQUEST,
          payloadBytes,
          { timeoutMs: JOIN_REQUEST_SEND_TIMEOUT_MS },
        );
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        const response = JSON.parse(new TextDecoder().decode(sendResult.response));
        return { remotePeerId, response };
      }),
    );
    let delivered = 0;
    let alreadyMember = false;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { remotePeerId, response } = r.value;
      if (response.ok) {
        delivered++;
        // SECURITY: do NOT cache broadcast acceptors as trusted
        // decision senders. Any peer can ack `{ ok: true }` (e.g.
        // because they speak the protocol) — caching them here would
        // let a non-curator peer subsequently forge a join-approved
        // notification and have it accepted (see
        // `isTrustedJoinDecisionSender`). Trust is granted only to
        // the explicit `curatorPeerId` from the invite (above) or
        // to the recorded curator triple in `_meta` (the fallback
        // inside `isTrustedJoinDecisionSender`).
        //
        // The matched curator inside the broadcast cohort can still
        // deliver the decision: the joiner will accept it via the
        // `_meta` curator-triple path once that triple lands locally
        // (curator metadata is gossiped along with the CG itself).
        if (remotePeerId === curatorPeerId) {
          recordAcceptedBy(remotePeerId);
          if (response.alreadyMember) alreadyMember = true;
        }
      } else if (response.error !== 'unknown CG') {
        errors.push(`${remotePeerId.slice(-8)}: ${response.error}`);
      }
    }

    this.log.info(
      ctx,
      `Forwarded join request for "${contextGraphId}" from ${agentAddress}: ${delivered} curator(s) received (broadcast over ${broadcastTargets.length} peer(s)${alreadyMember ? ', already-member' : ''})`,
    );
    return { delivered, errors, ...(alreadyMember ? { alreadyMember: true } : {}) };
  }

}
