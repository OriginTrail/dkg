// SPDX-License-Identifier: Apache-2.0

/**
 * Context-graph lifecycle methods (create / register / invite / remove /
 * rename / allowed-agents) extracted from dkg-agent.ts as a mixin holder.
 * Methods take `this: DKGAgent` so cross-calls resolve against the composed
 * class; the holder extends DKGAgentBase for shared field state. Behaviour is
 * unchanged — bodies are a 1:1 move. Assembled onto DKGAgent via applyMixins.
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
import { GraphManager, PrivateContentStore, createTripleStore, deleteByPatternWithoutCount, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type PrepareContextGraphRegistrationOptions, type PreparedContextGraphRegistration, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  ContextGraphRegistrationPreparationUnsupportedError,
  PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
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
import { ethers } from 'ethers';
import { join } from 'node:path';
import {
  DKGQueryEngine, QueryHandler,
  emptyQueryResultForKind,
  validateReadOnlySparql,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
import { buildAuthoritativePublicMetaQuads } from './context-graph-public-meta-proof.js';

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
import { parsePositiveUint256 } from './positive-uint256.js';
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
import type { ContextGraphJoinAdmissionLockToken } from './context-graph-join-admission-lock.js';
import type { PreparedContextGraphMembershipMutation } from './context-graph-membership-mutation.js';

/* eslint-disable @typescript-eslint/no-this-alias */

interface ContextGraphAgentInviteMutationPlan {
  contextGraphId: string;
  agentAddress: string;
  delegation?: SignedAgentDelegation;
  alreadyAllowed: boolean;
  noOp: boolean;
  cgMetaGraph: string;
  delegationUri?: string;
  quadsToInsert: Quad[];
  curatorAgentAddress?: string;
}

export type PreparedContextGraphAgentInviteMutation =
  PreparedContextGraphMembershipMutation<ContextGraphAgentInviteMutationPlan>;

interface ContextGraphRegistrationPreparer {
  /** Resolve the exact signer represented by this selected execution context. */
  publisherFallbackAuthorAddress(): Promise<string | undefined>;
  prepareContextGraphRegistration(
    options?: PrepareContextGraphRegistrationOptions,
  ): Promise<PreparedContextGraphRegistration>;
}

interface ContextGraphRegistrationSignerPolicy {
  publishPolicy: number;
  publishAuthorityAccountId?: bigint;
  curatorAddress: string;
  eoaAuthorityAddress?: string;
}

/**
 * Keep app authorization policy separate from the chain preparation API. If
 * that API evolves, only this policy-to-option mapping needs to change.
 */
function requiredContextGraphRegistrationSigner(
  policy: ContextGraphRegistrationSignerPolicy,
): string | undefined {
  if (policy.publishPolicy !== EVM_PUBLISH_CURATED) return undefined;
  return policy.publishAuthorityAccountId !== undefined
    ? policy.curatorAddress
    : policy.eoaAuthorityAddress;
}

export class ContextGraphMethods extends DKGAgentBase {
  async createContextGraph(this: DKGAgent, opts: {
    id: string;
    name: string;
    description?: string;
    replicationPolicy?: string;
    accessPolicy?: number;
    /** @deprecated Use allowedAgents. Peer allowlist for curated CGs. */
    allowedPeers?: string[];
    /** Agent address allowlist for curated CGs. Omit for open CGs. */
    allowedAgents?: string[];
    /** Participant agent addresses for on-chain context graphs. */
    participantAgents?: string[];
    /**
     * Optional contribution-policy override persisted at create time
     * so the deferred-registration path
     * (auto-register-on-first-VM-publish at memory.ts) preserves the
     * user's create-time choice. `0` = curators-only, `1` = open.
     * When omitted, registration derives the default from accessPolicy.
     */
    publishPolicy?: number;
    /**
     * Optional PCA (publish-curated-authority) account id persisted
     * at create time. When set, registerContextGraph uses it to
     * register the CG under a delegated authority instead of the
     * raw EOA-curated path. Persisted alongside publishPolicy for
     * the same deferred-registration reason — without persistence,
     * auto-register would silently drop PCA-curated configs.
     */
    publishAuthorityAccountId?: bigint | string | number;
    /** When true, skips gossip subscription and broadcast. Data stays local-only. */
    private?: boolean;
    /** Caller's agent address (resolved from token). Used for curator/creator triples. */
    callerAgentAddress?: string;
  }): Promise<void> {
    const ctx = createOperationContext('system');
    const gm = new GraphManager(this.store);
    gm.assertNewContextGraphId(opts.id);
    // OT-RFC-56 §4.6: name/description land as raw literals in a
    // network-replicated graph — enforce the protocol limit before ANY
    // side effect (see ensureContextGraphLocal for the incident context).
    assertRdfLiteralMutf8Safe(`"${opts.name}"`, {
      label: 'contextGraph.name', subject: opts.id, predicate: DKG_ONTOLOGY.SCHEMA_NAME,
    });
    if (opts.description) {
      assertRdfLiteralMutf8Safe(`"${opts.description}"`, {
        label: 'contextGraph.description', subject: opts.id, predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
      });
    }
    const contextGraphUri = `did:dkg:context-graph:${opts.id}`;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      throw new Error(`Context graph "${opts.id}" already exists`);
    }

    const hasLocalAccessControl = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || opts.private === true
      || !!opts.allowedAgents?.length
      || !!opts.allowedPeers?.length;
    if (opts.participantAgents && opts.participantAgents.length > 0 && !hasLocalAccessControl) {
      throw new Error(
        'participantAgents are on-chain registration metadata for curated context graphs. ' +
        'Set accessPolicy: 1 (or private: true) and use allowedAgents for local access control.',
      );
    }

    const isCurated = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || (opts.allowedAgents && opts.allowedAgents.length > 0)
      || (opts.allowedPeers && opts.allowedPeers.length > 0);
    // OT-RFC-38 / LU-6 Phase B (Codex PR #610 fd5b31f1 fix): persist
    // `publishPolicy` and `publishAuthorityAccountId` when supplied.
    // Pre-fix, both were register-time-only — fine in the original
    // "register synchronously at create-time" model. But this PR made
    // deferred registration the default (`memory.ts` auto-registers
    // on first VM publish, no longer requiring the user to call
    // `/register` first). Without persistence, the auto-register call
    // forwarded only `callerAgentAddress`, silently dropping the
    // user's create-time choice and falling back to the access-policy-
    // derived default. That broke valid combinations like
    // curated-access + open-contribution (publishPolicy=1) and PCA-
    // curated registration. Persisting at create time and reading at
    // register time keeps the user's intent end-to-end.
    if (opts.publishPolicy !== undefined && opts.publishPolicy !== 0 && opts.publishPolicy !== 1) {
      throw new Error(
        '`publishPolicy` must be 0 (curators-only) or 1 (open).',
      );
    }
    let normalisedPublishAuthorityAccountId: bigint | undefined;
    if (opts.publishAuthorityAccountId !== undefined) {
      normalisedPublishAuthorityAccountId = parsePositiveUint256(
        opts.publishAuthorityAccountId,
        '`publishAuthorityAccountId`',
      );
      // PCA is only meaningful on curated-contribution registrations.
      // Mirror the daemon-route guard so direct agent callers can't
      // accidentally smuggle a PCA id onto an open-publish CG.
      if (opts.publishPolicy === 1) {
        throw new Error(
          '`publishAuthorityAccountId` is only valid with curated publishPolicy (0).',
        );
      }
    }

    if (opts.private) {
      this.log.info(ctx, `Creating private context graph "${opts.id}" (local-only, no gossip)`);
    } else if (isCurated) {
      this.log.info(ctx, `Creating curated context graph "${opts.id}" (invite-only, definition hidden from ONTOLOGY)`);
    } else {
      this.log.info(ctx, `Creating context graph "${opts.id}" (P2P, no chain)`);
    }

    // Curated CGs store definition triples in their own _meta graph so they
    // are NOT discoverable via ONTOLOGY sync. Only invited/subscribed nodes
    // will see them. Open CGs go to ONTOLOGY for network-wide discovery.
    const defGraph = isCurated ? cgMetaGraph : ontologyGraph;

    // DKG_CREATOR records the libp2p peer ID of the hosting node — this is
    // the deterministic handle used by `resolveCuratorPeerId()` to dial the
    // curator for meta refreshes. It must NOT be replaced with a wallet DID.
    //
    // DKG_CURATOR records the caller's wallet identity and is what ownership
    // checks consult (via `getContextGraphOwner`). When a non-default local
    // agent creates a CG, its wallet DID ends up here so later authorization
    // — threaded through daemon routes as `callerAgentAddress` — can match.
    //
    // On-chain operations (registerContextGraph, verify) still bind to the
    // node wallet; per-agent chain signers are a known future enhancement.
    const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
    const curatorDid = `did:dkg:agent:${opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`;
    const quads: Quad[] = [
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${contextGraphPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"${opts.replicationPolicy ?? 'full'}"`, graph: defGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${isCurated || opts.private ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // Store registration status and curator in _meta. Also persist
    // `publishPolicy` / `publishAuthorityAccountId` when supplied so
    // the deferred-registration path (memory.ts auto-register on
    // first VM publish) can re-load the user's create-time choices.
    // See the boundary block above for rationale (Codex PR #610
    // fd5b31f1 follow-up).
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
    );
    if (!isCurated && !opts.private) {
      quads.push(...buildAuthoritativePublicMetaQuads(opts.id));
    }
    if (opts.publishPolicy !== undefined) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_PUBLISH_POLICY,
        object: `"${opts.publishPolicy}"`,
        graph: cgMetaGraph,
      });
    }
    if (normalisedPublishAuthorityAccountId !== undefined) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_PUBLISH_AUTHORITY_ACCOUNT_ID,
        object: `"${normalisedPublishAuthorityAccountId.toString()}"`,
        graph: cgMetaGraph,
      });
    }

    // Store peer allowlist for curated CGs (with validation)
    if (opts.allowedPeers && opts.allowedPeers.length > 0) {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      for (const peer of opts.allowedPeers) {
        try { peerIdFromString(peer); } catch {
          throw new Error(`Invalid peer ID in allowedPeers: "${peer}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
        }
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
          object: `"${escapeSparqlLiteral(peer)}"`,
          graph: cgMetaGraph,
        });
      }
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${this.peerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Store agent allowlist (V10 agent identity model)
    if (opts.allowedAgents && opts.allowedAgents.length > 0) {
      const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
      for (const addr of opts.allowedAgents) {
        if (!ethAddrRe.test(addr)) {
          throw new Error(`Invalid Ethereum address in allowedAgents: "${addr}".`);
        }
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${addr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store explicit on-chain participant agents separately from the local
    // curated allowlist. These addresses are forwarded to
    // ContextGraphs.createContextGraph participantAgents on registration.
    if (opts.participantAgents && opts.participantAgents.length > 0) {
      if (opts.participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
        throw new Error(`participantAgents cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses.`);
      }
      const seenParticipantAgents = new Set<string>();
      for (const addr of opts.participantAgents) {
        if (!ethers.isAddress(addr)) {
          throw new Error(`Invalid Ethereum address in participantAgents: "${addr}".`);
        }
        const checksumAddress = ethers.getAddress(addr);
        if (checksumAddress === ethers.ZeroAddress) {
          throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
        }
        const key = checksumAddress.toLowerCase();
        if (seenParticipantAgents.has(key)) {
          throw new Error(`Duplicate Ethereum address in participantAgents: "${checksumAddress}".`);
        }
        seenParticipantAgents.add(key);
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
          object: `"${checksumAddress}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Auto-include creator in allowlist for curated/private CGs
    if (isCurated || opts.private) {
      const creatorAddr = opts.callerAgentAddress ?? this.defaultAgentAddress;
      if (creatorAddr) {
        quads.push({
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${creatorAddr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // LU-2: per SPEC_CG_MEMORY_MODEL the legacy hosting-committee model
    // (per-CG `participantIdentityIds` + `requiredSignatures`) is gone.
    // Hosts are picked from the network sharding table at publish time
    // and the ACK quorum is the system parameter
    // `parametersStorage.minimumRequiredSignatures()`. The creator's
    // curator role is recorded above as `dkg:curator`; we no longer
    // also auto-add the creator's chain identity as a hosting-node.

    if (opts.description) {
      quads.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    // Provenance activity
    const activityUri = `did:dkg:activity:create-context-graph:${opts.id}:${Date.now()}`;
    quads.push(
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.PROV_GENERATED_BY, object: activityUri, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.PROV_ACTIVITY, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ASSOCIATED_WITH, object: `did:dkg:agent:${this.peerId}`, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ENDED_AT_TIME, object: `"${now}"`, graph: defGraph },
    );

    await this.store.insert(quads);
    this.invalidateListContextGraphsCache();
    this.contextGraphMetaProjection.markDirtyFromQuads(quads);
    await gm.ensureNewContextGraph(opts.id);

    // Force the triple-store flush BEFORE the SQLite caches are written.
    // Without this, a daemon crash within 50ms of the insert would lose the
    // declaration triples (best-effort debounced flush) while SQLite's WAL
    // would survive — leaving ghost CGs that show up in the dashboard but
    // don't exist in the graph. Awaiting flush here makes the create durable
    // before the caller is told it succeeded.
    await this.store.flush?.();

    this.setContextGraphSubscription(opts.id, {
      name: opts.name,
      subscribed: !opts.private,
      synced: true,
      metaSynced: true,
    });

    if (opts.private || isCurated) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'node',
        principalId: this.peerId,
        role: 'curator',
        status: 'active',
        source: 'local-create',
        displayName: this.nodeName,
      });
    }

    const curatorAgentAddress = opts.callerAgentAddress ?? this.defaultAgentAddress;
    if (curatorAgentAddress) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: curatorAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'local-create',
      });
    }

    for (const peer of opts.allowedPeers ?? []) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'node',
        principalId: peer,
        role: 'participant',
        status: 'active',
        source: 'allowed-peer',
      });
    }

    for (const addr of opts.allowedAgents ?? []) {
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: addr,
        role: 'participant',
        status: 'active',
        source: 'allowed-agent',
      });
    }

    for (const addr of opts.participantAgents ?? []) {
      if (!ethers.isAddress(addr)) continue;
      this.upsertContextGraphMember({
        contextGraphId: opts.id,
        principalType: 'agent',
        principalId: ethers.getAddress(addr),
        role: 'participant-agent',
        status: 'active',
        source: 'participant-agent',
      });
    }


    // On-chain registration is intentionally NOT done here — per v10 spec
    // §2.2 / §2.3 Context Graphs are a local-first primitive. A CG exists
    // the moment its definition triples land in the store; it can be
    // shared with peers over gossip (SWM writes/reads work across the
    // subscriber set), joined, sub-graphed, and queried without ever
    // touching chain state. Verifiable Memory is the value-add layer that
    // requires chain registration, and earlier revisions silently minted
    // a `ContextGraphs.createContextGraph` tx from inside this method
    // whenever the adapter supported it. That broke the "free CG"
    // contract the API advertises (HTTP caller opts in via
    // `register: true` on `/api/context-graph/create`), caused surprise
    // TRAC spend, and made test §27e's "VM publish on unregistered CG
    // should fail" impossible to satisfy — the CG was always already
    // registered by the time the test ran.
    //
    // Callers that want on-chain registration MUST now take the
    // explicit path: either `POST /api/context-graph/create` with
    // `register: true` (daemon chains a `registerContextGraph` call
    // after this method returns) or `POST /api/context-graph/register`
    // on an existing local CG. Both paths go through
    // {@link registerContextGraph}, which preserves the creator /
    // curator checks and writes the V10 `onChainId` + flips
    // `dkg:registrationStatus` to `"registered"`. Until then the CG
    // carries the `unregistered` marker inserted above, and
    // `dkg-publisher`'s `publishFromSharedMemory` guard
    // (`packages/publisher/src/dkg-publisher.ts:569-594`) throws
    // `Context graph "<id>" is not registered on-chain` on any VM
    // publish attempt.

    // OT-RFC-38 LU-6: every locally-created CG (curated OR public,
    // member OR not) should trigger the host-mode subscription
    // reconciler so a core that pre-creates a CG it isn't a member
    // of starts hosting its substrate immediately instead of waiting
    // up to 30s for the next periodic tick.
    if (isCurated || opts.private) {
      this.queueSharedMemoryGossipSubscription(opts.id);
    }

    // OT-RFC-38 / LU-6 Phase B — register this CG for the discovery
    // beacon so cores can pre-register-auto-host it (the freemium
    // tier path). Only curated CGs have ciphertext custody to
    // delegate; private (local-only) and public CGs don't run the
    // beacon. The first beacon is broadcast immediately so cores
    // listening before the curator pays gas can already start
    // hosting.
    if (isCurated && !opts.private) {
      this.registerCgForBeaconAnnouncement(
        opts.id,
        BEACON_ACCESS_POLICY_CURATED,
        opts.callerAgentAddress,
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Beacon registration for "${opts.id}" failed: ${msg}`);
      });
    }

    if (!opts.private) {
      this.subscribeToContextGraph(opts.id, { syncMode: 'always-on' });

      // Curated CGs: definition lives in _meta, NOT in ONTOLOGY. Do not
      // broadcast to the network — only invited nodes will discover it via
      // the explicit subscribe→sync flow.
      if (!isCurated) {
        const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
        const broadcastQuads = quads.filter(q => q.graph === ontologyGraph);
        const nquads = broadcastQuads.map(q => {
          const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
          return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
        }).join('\n');

        const msg = encodePublishRequest({
          ual: `did:dkg:context-graph:${opts.id}`,
          nquads: new TextEncoder().encode(nquads),
          contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
          kas: [],
          publisherIdentity: this.wallet.keypair.publicKey,
          publisherAddress: '',
          startKAId: 0,
          endKAId: 0,
          chainId: '',
          publisherSignatureR: new Uint8Array(0),
          publisherSignatureVs: new Uint8Array(0),
        });

        try {
          await this.gossip.publish(ontologyTopic, msg);
        } catch {
          // No peers subscribed — ok for now
        }
      }
    }
  }

  /**
   * Register an existing context graph on-chain. This is the explicit upgrade
   * step that unlocks Verifiable Memory, chain-based discovery, and economic
   * participation. Requires native gas. Direct registration also requires the
   * configured TRAC deposit; an eligible PCA-backed registration consumes one
   * quota-backed waiver instead.
   */
  async registerContextGraph(this: DKGAgent, id: string, opts?: {
    /** @deprecated V10 ContextGraphs registration ignores metadata reveal. */
    revealOnChain?: boolean;
    accessPolicy?: number;
    publishPolicy?: number;
    callerAgentAddress?: string;
    publishAuthorityAccountId?: bigint;
    /** Attempt-scoped PCA economic coverage; never persisted as graph policy. */
    registrationPcaAccountId?: bigint;
    /** Narrow registration capability selected by the publish path. */
    publisher?: ContextGraphRegistrationPreparer;
    /**
     * When `true`, refuse curated EOA-mode registration if the
     * calling agent's address differs from the configured chain
     * signer (the pre-existing strict invariant). When `false`
     * (default), the chain signer is auto-promoted to be the
     * on-chain governance owner and the calling agent is recorded
     * as a participantAgent so curated-SWM writes still pass the
     * agent gate. See the inline rationale in the implementation
     * for the trade-offs (local DKG_CURATOR keeps the calling
     * agent; on-chain governance NFT goes to the chain signer).
     */
    strictEoaCuratorMatch?: boolean;
  }): Promise<{ onChainId: string; txHash?: string }> {
    const ctx = createOperationContext('system');
    new GraphManager(this.store).assertNewContextGraphId(id);

    if (opts?.revealOnChain === true) {
      this.log.warn(
        ctx,
        'revealOnChain is deprecated and ignored by V10 ContextGraphs registration; metadata reveal uses the legacy name registry path.',
      );
    }

    const exists = await this.contextGraphExists(id);
    if (!exists) {
      throw new Error(`Context graph "${id}" does not exist locally. Create it first.`);
    }

    if (this.chain.chainId === 'none') {
      throw new Error('On-chain registration requires a configured chain adapter');
    }

    const rawRegistrationPcaAccountId = opts?.registrationPcaAccountId as unknown;
    const registrationPcaAccountId = rawRegistrationPcaAccountId == null
      ? undefined
      : parsePositiveUint256(rawRegistrationPcaAccountId, 'Registration PCA account id');

    // Only the address-scoped curator can register a CG on-chain.
    // Peer IDs are transport contact handles for sync/meta refresh, not EVM
    // authority identifiers. For legacy local CGs that only have a creator
    // peer DID, the local creator node may lazily stamp its address curator
    // before registering; foreign peer-only CGs must first sync a curator.
    //
    // If no owner triple exists yet (bootstrap CGs created via
    // `ensureContextGraphLocal` deliberately do not stamp ownership), the
    // calling node lazily becomes both creator/contact and curator here.
    // This keeps the stamp single-writer (no race over `LIMIT 1`).
    const selfPeerDid = `did:dkg:agent:${this.peerId}`;
    const stampAddressCurator = async (): Promise<string> => {
      const curatorAddress = opts?.callerAgentAddress ?? this.defaultAgentAddress;
      if (!curatorAddress || !ethers.isAddress(curatorAddress)) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an address-scoped curator. ` +
          'Use an authenticated agent wallet or configure a default agent address.',
        );
      }

      const cgMetaGraph = contextGraphMetaUri(id);
      const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const contextGraphUri = `did:dkg:context-graph:${id}`;
      const accessPolicyResult = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
        { source: 'agent.contextGraph.register.accessPolicy' },
      );
      const apValue = accessPolicyResult.type === 'bindings'
        ? accessPolicyResult.bindings[0]?.['ap']?.replace(/^"|"$/g, '')
        : undefined;
      const isCurated = apValue === 'private';
      const defGraph = isCurated ? cgMetaGraph : ontologyGraph;
      const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
      const curatorDid = `did:dkg:agent:${curatorAddress}`;
      // Defensive: replace any stray creator/curator triples (e.g. from
      // a previous build that backfilled per node) so this register call
      // becomes the single source of truth.
      await deleteByPatternWithoutCount(this.store, { graph: defGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await deleteByPatternWithoutCount(this.store, { graph: cgMetaGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await deleteByPatternWithoutCount(this.store, { graph: cgMetaGraph, subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR });
      const authorityQuads: Quad[] = [
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
        { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
      ];
      if (!isCurated) {
        authorityQuads.push(...buildAuthoritativePublicMetaQuads(id));
      }
      await this.store.insert(authorityQuads);
      this.invalidateListContextGraphsCache();
      this.contextGraphMetaProjection.markDirty(id);
      this.log.info(ctx, `Stamped local node as creator contact and address curator for "${id}" (registration-time lazy stamp)`);
      return curatorDid;
    };

    let owner = await this.getContextGraphCurator(id);
    if (!owner) {
      const existingCreator = await this.getContextGraphCreator(id);
      if (existingCreator && !this.isCallerOrNodeOwner(existingCreator, opts?.callerAgentAddress)) {
        throw new Error(
          `Context graph "${id}" has no address-scoped curator and was created by ${existingCreator}. ` +
          'Sync curator metadata or ask the curator to register it on-chain.',
        );
      }
      owner = await stampAddressCurator();
    } else {
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (!ethers.isAddress(ownerTail)) {
        if (owner === selfPeerDid) {
          owner = await stampAddressCurator();
        } else {
          throw new Error(
            `Context graph "${id}" has a peer-scoped curator (${owner}) and cannot be registered on-chain by this node. ` +
            'Sync address-scoped curator metadata or ask the curator to register it on-chain.',
          );
        }
      }
    }
    if (!this.isCallerOrNodeAddressOwner(owner, opts?.callerAgentAddress)) {
      throw new Error(
        `Only the context graph curator can register it on-chain. ` +
        `Curator=${owner}, caller=${`did:dkg:agent:${opts?.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`,
      );
    }
    let ownerAddress = ethers.getAddress(owner.replace(/^did:dkg:agent:/, ''));
    // Check if already registered
    const cgMetaGraph = contextGraphMetaUri(id);
    const contextGraphUri = `did:dkg:context-graph:${id}`;
    const statusResult = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
      { source: 'agent.contextGraph.register.status' },
    );
    if (statusResult.type === 'bindings' && statusResult.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered') {
      const existingOnChainId = this.subscribedContextGraphs.get(id)?.onChainId;
      throw new Error(`Context graph "${id}" is already registered on-chain${existingOnChainId ? ` (${existingOnChainId})` : ''}`);
    }

    // Read existing description and access policy. Curated CGs store
    // definition in _meta rather than ONTOLOGY, so check both locations.
    const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const descResult = await this.store.query(
      `SELECT ?desc WHERE {
        { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
        UNION
        { GRAPH <${cgMetaGraph}> { <${contextGraphUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
      } LIMIT 1`,
      { source: 'agent.contextGraph.register.description' },
    );
    const description = descResult.type === 'bindings' ? descResult.bindings[0]?.['desc']?.replace(/^"|"$/g, '') : undefined;

    let resolvedLocalAccessPolicy = opts?.accessPolicy;
    if (resolvedLocalAccessPolicy !== undefined && resolvedLocalAccessPolicy !== LOCAL_ACCESS_OPEN && resolvedLocalAccessPolicy !== LOCAL_ACCESS_CURATED) {
      throw new Error('accessPolicy must be 0 (open) or 1 (private/curated)');
    }
    // Closes #774 finding #1 — `dkg context-graph register
    // --access-policy 1` against a CG that was created public used to
    // silently register on-chain as curated while the local CG stayed
    // public. The subsequent `dkg publish my-cg` then tripped the
    // pre-publish LU-5 guard with a CG-policy-mismatch error and the
    // operator had no easy way to recover (the LU-5 guard is correct
    // — encrypting against the wrong CG's policy would leak plaintext
    // OR be rejected by cores).
    //
    // Fail fast at register time with a clear remediation pointer so
    // the operator never gets into the half-registered state. The
    // single-call API (`POST /api/context-graph/create
    // {accessPolicy:1, register:true, allowedAgents:[…]}`) and the
    // CLI `dkg context-graph create my-cg --access-policy 1` BOTH set
    // the local access policy at create time — those remain the
    // supported paths for curated CGs.
    // `isPrivateContextGraph()` reflects the CURRENT local ACL state,
    // not strictly the create-time policy: a CG created public can
    // later be locked down via allowlist mutations and would then
    // also report `actualLocalIsCurated = true`. Phrase the error in
    // terms of the current ACL state so the message stays accurate
    // regardless of which write flipped the local policy (Codex r2
    // on #777). The remediation pointer covers both atomic-create
    // paths because that is the only supported way to bring the CG
    // out of the mismatched state.
    const actualLocalIsCurated = await this.isPrivateContextGraph(id);
    if (
      resolvedLocalAccessPolicy !== undefined
      && ((resolvedLocalAccessPolicy === LOCAL_ACCESS_CURATED) !== actualLocalIsCurated)
    ) {
      const localStr = actualLocalIsCurated ? 'private/curated (1)' : 'public/open (0)';
      const requestedStr = resolvedLocalAccessPolicy === LOCAL_ACCESS_CURATED
        ? 'private/curated (1)'
        : 'public/open (0)';
      throw new Error(
        `Context graph "${id}" currently has local access policy=${localStr} but register was called with --access-policy ${requestedStr}. ` +
        `register cannot change the local access policy — encrypting against a different policy than the CG actually has would either leak plaintext or be rejected by cores ` +
        `(this is what the pre-publish LU-5 guard then refuses). ` +
        `To create a curated CG atomically, use one of: ` +
        `(a) \`dkg context-graph create <id> --access-policy 1 --allowed-agent <addr>\`, ` +
        `(b) the single-call API \`POST /api/context-graph/create { accessPolicy: 1, register: true, allowedAgents: [...] }\`. ` +
        `Then register without --access-policy.`,
      );
    }
    if (resolvedLocalAccessPolicy === undefined) {
      resolvedLocalAccessPolicy = actualLocalIsCurated
        ? LOCAL_ACCESS_CURATED
        : LOCAL_ACCESS_OPEN;
    }
    if (opts?.publishPolicy !== undefined && opts.publishPolicy !== EVM_PUBLISH_CURATED && opts.publishPolicy !== EVM_PUBLISH_OPEN) {
      throw new Error('publishPolicy must be 0 (curated) or 1 (open)');
    }
    const publishPolicy = opts?.publishPolicy ?? (resolvedLocalAccessPolicy === LOCAL_ACCESS_CURATED
      ? EVM_PUBLISH_CURATED
      : EVM_PUBLISH_OPEN);
    // PCA account id is ONLY honored from the explicit option here.
    // We deliberately do NOT fall back to a stored value (Codex PR
    // #502 round-6): legacy CGs created under the old create-time
    // persistence could have stale/bad ids that would silently replay
    // on every register retry that omits the param. With explicit-only
    // resolution, `undefined` unambiguously means "no PCA".
    //
    // The option type advertises `bigint`, but untyped / JS callers can
    // pass `1` or `'1'` — comparing a non-bigint to `0n` would throw a
    // raw `TypeError: Cannot mix BigInt and other types` instead of the
    // actionable validation error this API is supposed to provide
    // (Codex PR #502 round-8). Coerce safely before the `<= 0n` check.
    const rawPublishAuthorityAccountId = opts?.publishAuthorityAccountId as unknown;
    const requestedPublishAuthorityAccountId = rawPublishAuthorityAccountId == null
      ? undefined
      : parsePositiveUint256(rawPublishAuthorityAccountId, 'PCA account id');
    const publishAuthorityAccountId = requestedPublishAuthorityAccountId;
    // PCA account ids are only invalid when the publish policy is
    // open (`publishPolicy === EVM_PUBLISH_OPEN`) — that combination
    // is incoherent on-chain because `isAuthorizedPublisher`'s PCA
    // branch never fires for open publish policy.
    //
    // We do NOT also reject `accessPolicy=0 (public/discoverable)`
    // here: the on-chain `ContextGraphs.createContextGraph` contract
    // explicitly supports `{ accessPolicy: 0, publishPolicy: 0,
    // publishAuthorityAccountId: !=0 }` — a publicly-discoverable CG
    // where only the PCA owner / authorized publishers can write.
    // Rejecting that combo client-side blocks a valid registration
    // mode (Codex PR #502 round-7).
    if (publishAuthorityAccountId !== undefined && publishPolicy === EVM_PUBLISH_OPEN) {
      throw new Error('PCA account id can only be used with curated publish policy.');
    }
    // NOTE: we intentionally defer persisting `requestedPublishAuthorityAccountId`
    // until *after* on-chain registration succeeds (further down). If we
    // wrote it here and the subsequent owner check / on-chain call failed
    // with a bad PCA id, the bad id would stick in local CG metadata and
    // every retry would replay the same failure (Codex review #502-1).
    const isPcaCurated = publishPolicy === EVM_PUBLISH_CURATED
      && publishAuthorityAccountId !== undefined;

    // Per SPEC_CG_MEMORY_MODEL on-chain CGs are now edge-owned by
    // default — no per-CG hosting committee, no per-CG quorum override.
    // Hosts come from the sharding table at publish time; ACK quorum
    // is `parametersStorage.minimumRequiredSignatures()`.

    // Check if already registered on-chain (prevents duplicate minting).
    // A local OnChainId triple alone is not enough — devnet restarts and
    // partial failures can leave ontology id "1" while the chain slot is
    // inactive, which would skip registration and strand publishes.
    const existingOnChainId = await this.getContextGraphOnChainId(id);
    if (existingOnChainId) {
      let onChainLive = false;
      if (typeof this.chain.isContextGraphActiveOnChain === 'function') {
        try {
          onChainLive = await this.chain.isContextGraphActiveOnChain(BigInt(existingOnChainId));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(
            ctx,
            `Context graph "${id}" has local on-chain id ${existingOnChainId}, but liveness could not be verified: ${reason}`,
          );
          throw new Error(
            `Context graph "${id}" has local on-chain id ${existingOnChainId}, but liveness could not be verified. ` +
            `Refusing to re-register until the existing slot can be checked: ${reason}`,
          );
        }
      }
      if (onChainLive) {
        this.log.info(ctx, `Context graph "${id}" already has on-chain ID ${existingOnChainId} — skipping chain call`);
        await deleteByPatternWithoutCount(this.store, {
          graph: cgMetaGraph,
          subject: contextGraphUri,
          predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
        });
        await this.store.insert([
          { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
        ]);
        this.contextGraphMetaProjection.markDirty(id);
        return { onChainId: existingOnChainId, txHash: undefined };
      }
      this.log.warn(
        ctx,
        `Context graph "${id}" has local on-chain id ${existingOnChainId} but it is not active on-chain — re-registering`,
      );
      const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      await deleteByPatternWithoutCount(this.store, {
        graph: ontologyGraph,
        subject: contextGraphUri,
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
      });
      const sub = this.subscribedContextGraphs.get(id);
      if (sub) {
        this.forceClearVmReconcileStateForContextGraph(id);
        this.setContextGraphSubscription(id, { ...sub, onChainId: undefined, lastReconciledOrdinal: 0 });
      }
    }

    // LU-2: edge-owned CG pattern — no `participantIdentityIds`/
    // `requiredSignatures` derivation. Edge agents that lack an
    // on-chain identity can still register CGs.
    let participantAgents = await this.getContextGraphParticipantAgentAddresses(id);
    if (participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
      throw new Error(
        `Context graph "${id}" cannot be registered on-chain: participantAgents cannot exceed ` +
        `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after merging local allowedAgents.`,
      );
    }
    let publishAuthority: string | undefined;
    if (isPcaCurated) {
      if (typeof this.chain.getPublishingConvictionAccountOwner !== 'function') {
        throw new Error('PCA curated context graph registration requires chain adapter PCA owner lookup support.');
      }
      // Translate KNOWN nonexistent-token reverts on the PCA NFT into
      // a stable, caller-input-shaped error so the daemon route can
      // map it cleanly to 404. Anything else (RPC outage, network
      // glitch, adapter-internal failure) is rethrown with its
      // original class/message so the daemon's catch surfaces it as a
      // retriable 500/503 rather than a misleading 404 (Codex review
      // #502-3 follow-up: don't blanket-translate every adapter
      // failure as "does not exist").
      try {
        publishAuthority = ethers.getAddress(
          await this.chain.getPublishingConvictionAccountOwner(publishAuthorityAccountId),
        );
      } catch (lookupErr: any) {
        const lookupMsg = String(lookupErr?.message ?? lookupErr ?? '');
        const errCode = String(lookupErr?.code ?? '');
        // Patterns we recognise as "this PCA token doesn't exist":
        //   - OZ ERC721 custom error (modern: `ERC721NonexistentToken`,
        //     legacy: `ERC721: invalid token ID` / `nonexistent token`).
        //   - The built-in `MockChainAdapter.getPublishingConvictionAccountOwner`
        //     throws `Mock: PCA account <id> does not exist` (production
        //     mock used by SDK callers). Recognized via the broader
        //     `/PCA account \d+ does not exist/` pattern (Codex PR #502
        //     round-6: this matcher used to recognize only the test
        //     double's wording, so the built-in mock path bypassed
        //     normalization).
        //   - The agent-test test double's `No mock PCA owner for
        //     account ...` parity throw.
        //   - ethers v6 surfaces these as `BAD_DATA` / `CALL_EXCEPTION`
        //     with the OZ error name in the message.
        const isNonexistentToken =
          /ERC721NonexistentToken/.test(lookupMsg)
          || /invalid token ID/i.test(lookupMsg)
          || /nonexistent token/i.test(lookupMsg)
          || /PCA account \d+ does not exist/.test(lookupMsg)
          || /No mock PCA owner for account/.test(lookupMsg)
          || (errCode === 'CALL_EXCEPTION' && /ERC721/.test(lookupMsg));
        if (isNonexistentToken) {
          throw new Error(
            `PCA account ${publishAuthorityAccountId} does not exist or cannot be looked up: ${lookupMsg}`,
          );
        }
        throw lookupErr;
      }
    }

    const adapterPreparer = this.chain.prepareOnChainContextGraphRegistration;
    const adapterCanPrepare = typeof adapterPreparer === 'function';
    let eoaAuthorityAddress: string | undefined;
    if (publishPolicy === EVM_PUBLISH_CURATED && !isPcaCurated) {
      if (opts?.publisher) {
        const selectedAddress = await opts.publisher.publisherFallbackAuthorAddress();
        eoaAuthorityAddress = selectedAddress ? ethers.getAddress(selectedAddress) : undefined;
        if (!eoaAuthorityAddress) {
          throw new Error(
            'Selected publisher does not expose an EOA for curated context-graph registration.',
          );
        }
      } else if (adapterCanPrepare) {
        const adapterAuthority = await this.getChainPublishAuthorityAddress(id)
          ?? await this.getRegistrationTxSignerAddress();
        eoaAuthorityAddress = adapterAuthority ? ethers.getAddress(adapterAuthority) : undefined;
        if (!eoaAuthorityAddress) {
          throw new Error(
            'Chain adapter does not expose an EOA for curated context-graph registration.',
          );
        }
      } else {
        // Legacy direct registration must describe the adapter that will submit
        // the transaction, never an unrelated agent/default publisher context.
        const adapterSigner = await this.getRegistrationTxSignerAddress();
        eoaAuthorityAddress = adapterSigner ? ethers.getAddress(adapterSigner) : undefined;
      }
    }

    const requiredRegistrationSigner = requiredContextGraphRegistrationSigner({
      publishPolicy,
      publishAuthorityAccountId,
      curatorAddress: ownerAddress,
      eoaAuthorityAddress,
    });
    const preparationOptions: PrepareContextGraphRegistrationOptions = {
      ...(registrationPcaAccountId !== undefined ? { registrationPcaAccountId } : {}),
      ...(requiredRegistrationSigner !== undefined
        ? { registrationSignerAddress: requiredRegistrationSigner }
        : {}),
    };
    let preparedRegistration: PreparedContextGraphRegistration | undefined;
    if (opts?.publisher) {
      // A supplied preparer carries a selected publisher binding (not merely an
      // optimization), so failure must not silently fall back to another signer.
      try {
        preparedRegistration = await opts.publisher.prepareContextGraphRegistration(preparationOptions);
      } catch (error) {
        if (
          !(error instanceof ContextGraphRegistrationPreparationUnsupportedError)
          || registrationPcaAccountId !== undefined
        ) {
          throw error;
        }

        // Old adapters predate sealed registration preparation. Preserve their
        // ordinary paid path only when direct submission cannot switch away
        // from the selected publisher. Unknown-on-both-sides retains the exact
        // legacy behavior; a mismatch or one-sided unknown fails closed.
        const [selectedPublisherAddress, directSignerAddress] = await Promise.all([
          opts.publisher.publisherFallbackAuthorAddress(),
          this.getRegistrationTxSignerAddress(),
        ]);
        const normalizedSelected = selectedPublisherAddress
          ? ethers.getAddress(selectedPublisherAddress)
          : undefined;
        const normalizedDirect = directSignerAddress
          ? ethers.getAddress(directSignerAddress)
          : undefined;
        const preservesSelectedPublisher = normalizedSelected && normalizedDirect
          ? normalizedSelected.toLowerCase() === normalizedDirect.toLowerCase()
          : normalizedSelected === undefined && normalizedDirect === undefined;
        if (!preservesSelectedPublisher) {
          throw new Error(
            'Selected publisher cannot prepare context-graph registration and cannot be proven to match ' +
            'the legacy direct chain signer.',
          );
        }
      }
    } else if (adapterPreparer) {
      preparedRegistration = await adapterPreparer.call(this.chain, preparationOptions);
    } else if (registrationPcaAccountId !== undefined) {
      throw new Error(
        'Registration PCA coverage requires chain adapter prepared context-graph registration support.',
      );
    }

    const preparedSignerAddress = preparedRegistration
      ? ethers.getAddress(preparedRegistration.signerAddress)
      : undefined;
    if (
      requiredRegistrationSigner
      && preparedSignerAddress
      && preparedSignerAddress.toLowerCase() !== requiredRegistrationSigner.toLowerCase()
    ) {
      throw new Error(
        `Prepared context-graph registration signer ${preparedSignerAddress} does not match required curator signer ${requiredRegistrationSigner}.`,
      );
    }

    // EOA-curated registration advertises the tx signer as publish authority.
    // Prepared flows use the sealed signer; legacy direct adapters retain the
    // pre-existing resolver path.
    if (publishPolicy === EVM_PUBLISH_CURATED && !isPcaCurated) {
      publishAuthority = eoaAuthorityAddress;
    }

    let registrationSignerAddress = preparedSignerAddress;
    if (isPcaCurated && !registrationSignerAddress) {
      registrationSignerAddress = await this.getRegistrationTxSignerAddress();
    }

    if (publishPolicy === EVM_PUBLISH_CURATED) {
      // PCA registration mirrors the post-#1366 on-chain authorization:
      // either the PCA owner OR a wallet registered to this exact PCA may
      // create the CG. Keep the local curator and registration-tx signer
      // identical in both modes so the local owner and the Context Graph NFT
      // owner cannot silently diverge:
      //
      //   owner mode: local curator == tx signer == PCA owner
      //   agent mode: local curator == tx signer == registered PCA agent
      //
      // The advertised publishAuthority remains the live PCA owner in both
      // modes, as required by ContextGraphs._validatePCACoherence. In agent
      // mode the registered agent owns the newly minted CG NFT while the PCA
      // owner and every registered PCA agent remain authorized publishers.
      if (isPcaCurated && publishAuthority) {
        if (!registrationSignerAddress) {
          throw new Error(
            `Context graph "${id}" cannot be PCA-registered: the chain adapter does not expose its registration-tx signer, so PCA owner/agent authorization cannot be verified. PCA mode requires a chain adapter that surfaces its signer (e.g. via \`signerAddress\` / \`getSignerAddress()\` / \`getOperationalPrivateKey()\`).`,
          );
        }
        const normalizedChainSigner = ethers.getAddress(registrationSignerAddress);
        const signerIsOwner = normalizedChainSigner.toLowerCase() === publishAuthority.toLowerCase();
        if (ownerAddress.toLowerCase() !== normalizedChainSigner.toLowerCase()) {
          throw new Error(
            `Context graph "${id}" cannot be PCA-registered: local curator ${ownerAddress} differs from registration chain signer ${normalizedChainSigner}. The local curator must control the wallet that will own the on-chain Context Graph NFT.`,
          );
        }

        if (!signerIsOwner) {
          if (typeof this.chain.getConvictionAgentAccountId !== 'function') {
            throw new Error(
              'PCA curated context graph registration by an agent requires chain adapter PCA agent lookup support.',
            );
          }
          const signerAccountId = await this.chain.getConvictionAgentAccountId(
            normalizedChainSigner,
            { strict: true },
          );
          if (signerAccountId !== publishAuthorityAccountId) {
            throw new Error(
              `Context graph "${id}" cannot be PCA-registered: chain signer ${normalizedChainSigner} is not a registered agent of PCA account ${publishAuthorityAccountId} ` +
              `(registered account: ${signerAccountId}). The signer must own the PCA or be registered to that exact account.`,
            );
          }
          this.log.info(
            ctx,
            `PCA-curated CG "${id}": registered agent ${normalizedChainSigner} will own the Context Graph NFT; ` +
            `PCA account ${publishAuthorityAccountId} owner ${publishAuthority} remains the live publish authority.`,
          );
        }
      } else if (publishAuthority && ownerAddress.toLowerCase() !== publishAuthority.toLowerCase()) {
        // EOA mode: publishAuthority is the chain signer; local curator must
        // equal it unless the explicit auto-promotion path below is allowed.
        if (opts?.strictEoaCuratorMatch) {
          // Opt-in strict mode for callers that explicitly want
          // the legacy "curator agent MUST equal chain signer"
          // invariant (e.g. multi-tenant cores where the operator
          // does NOT want every agent's CG governance to default
          // to the node's chain signer).
          throw new Error(
            `Context graph "${id}" cannot be registered as curated by local curator ${ownerAddress} because ` +
            `the configured chain signer is ${publishAuthority} and strictEoaCuratorMatch was requested. ` +
            `Either retry with strictEoaCuratorMatch=false to auto-promote the chain signer as on-chain owner, ` +
            `or register from an agent whose address matches ${publishAuthority}.`,
          );
        }
        // Auto-promote chain signer to on-chain governance owner.
        //
        // Why this is safe and what it means:
        //
        //  * Structural: `ContextGraphs.createContextGraph` mints
        //    the governance NFT to `msg.sender`, which is always
        //    the chain signer. Previously we refused to register
        //    when `local curator agent ≠ chain signer` to avoid
        //    the silent divergence "local says agent owns it /
        //    chain says signer owns it". That refusal blocked a
        //    legitimate single-operator flow ("I am the human
        //    behind this core; I use an agent wallet for my UI
        //    interactions; the node's chain signer is also mine")
        //    with a hard error and no automatic resolution.
        //
        //  * The relaxation: register the CG with chain signer
        //    as the on-chain owner/publishAuthority (matches
        //    msg.sender, no divergence), AND record the calling
        //    agent as a `DKG_PARTICIPANT_AGENT` so the curated-
        //    SWM agent gate (`getContextGraphAgentGateAddresses`
        //    in SharedMemoryHandler) accepts their writes.
        //    LU-5's no-attribution VM publish (attributionId=0)
        //    continues to work because it never depends on the
        //    publisher being the on-chain `publishAuthority` —
        //    only ACK quorum over the agent signature.
        //
        //  * Local UI consistency: the local `DKG_CURATOR` triple
        //    keeps its existing value (the calling agent). UIs
        //    that say "your CG" continue to say that. The new
        //    `DKG_CHAIN_OWNER` triple records who actually holds
        //    the governance NFT so introspection / dashboards
        //    can surface the asymmetry.
        //
        //  * The trade-off: future on-chain governance ops
        //    (change publishPolicy, transfer the NFT, etc.)
        //    require the chain signer, not the calling agent.
        //    For single-operator setups this is the same human;
        //    for true multi-tenant cores, operators should set
        //    `strictEoaCuratorMatch: true` or use PCA mode.
        this.log.info(
          ctx,
          `Curated CG "${id}": calling agent ${ownerAddress} ≠ chain signer ${publishAuthority}. ` +
          `Auto-promoting chain signer as on-chain governance owner and adding the calling agent as a participantAgent. ` +
          `Local DKG_CURATOR stays ${ownerAddress}; on-chain NFT mints to ${publishAuthority}. ` +
          `Pass { strictEoaCuratorMatch: true } to suppress this relaxation.`,
        );
        // Persist the calling agent as a local participant agent
        // so SWM writes pass the agent gate. Idempotent — RDF
        // triples deduplicate.
        await this.store.insert([
          {
            subject: contextGraphUri,
            predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
            object: `"${ethers.getAddress(ownerAddress)}"`,
            graph: cgMetaGraph,
          },
        ]);
        this.contextGraphMetaProjection.markDirty(id);
        // Re-fetch participantAgents so the on-chain
        // registration also lists the calling agent (matches
        // what the local agent gate now enforces).
        participantAgents = await this.getContextGraphParticipantAgentAddresses(id);
        if (participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
          throw new Error(
            `Context graph "${id}" cannot be registered on-chain: participantAgents cannot exceed ` +
            `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after auto-adding the calling agent as a participant.`,
          );
        }
        // Treat the chain signer as the local on-chain owner from
        // here on — downstream PCA/signer parity checks compare
        // against this value.
        ownerAddress = publishAuthority;
      }
      if (
        !publishAuthority
        && opts?.callerAgentAddress
        && this.defaultAgentAddress
        && opts.callerAgentAddress.toLowerCase() !== this.defaultAgentAddress.toLowerCase()
      ) {
        throw new Error(
          `Context graph "${id}" cannot be registered as curated by non-default local curator ` +
          `${opts.callerAgentAddress} without chain signer introspection. Per-agent chain signers are not supported yet.`,
        );
      }
    }

    // OT-RFC-38 / LU-6 Phase B — compute the curator-committed wire id
    // BEFORE the chain call. Doing this here (rather than letting the
    // chain adapter default it) keeps the curator/host topic invariant
    // tight: we publish the same hash on chain that we'll later use
    // for the SWM gossip topic, envelope `contextGraphId`, signing
    // payload, and host-mode store key. If we let any layer compute a
    // different value, members would publish on topic-A while cores
    // host on topic-B and the substrate silently fragments.
    //
    // Cleartext is UTF-8 encoded; matches what `keccak256(bytes(s))`
    // returns in Solidity for `bytes(string)` casts. Lowercase 0x-
    // prefixed hex string (ethers' canonical shape) — must round-trip
    // bit-identically through `getNameHash(uint256)` and the
    // `ContextGraphCreated.nameHash` topic, otherwise host-mode auto-
    // subscribe will key on the wrong topic.
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();

    const result = await this.registerContextGraphOnChain({
      accessPolicy: resolvedLocalAccessPolicy,
      publishPolicy,
      ...(publishAuthority ? { publishAuthority } : {}),
      ...(isPcaCurated ? { publishAuthorityAccountId } : {}),
      participantAgents,
      nameHash,
    }, preparedRegistration);
    const onChainId = result.contextGraphId.toString();

    this.log.info(ctx, `Context graph "${id}" registered on-chain: ${onChainId} (nameHash=${nameHash.slice(0, 18)}…)`);

    // Update _meta with registered status and the member-syncable on-chain
    // binding.  The ontology copy remains for system-graph discovery, while
    // the authenticated CG-local copy lets a late member learn the immutable
    // slot from the curator's private `_meta` snapshot.  A private joiner may
    // have missed the one-shot ontology gossip emitted below and must not be
    // left unable to start chain-driven VM reconciliation as a result.
    await deleteByPatternWithoutCount(this.store, {
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
    });
    // Single-valued binding guard (RS heal): the on-chain id is immutable, so
    // clear any prior value before insert — the cgId resolver / heal read this
    // and must never see a multi-valued (LIMIT-1-nondeterministic) binding.
    await deleteByPatternWithoutCount(this.store, {
      graph: ontologyGraph,
      subject: contextGraphUri,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
    });
    await deleteByPatternWithoutCount(this.store, {
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
    });
    await this.store.insert([
      { subject: contextGraphUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId}"`, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${onChainId}"`, graph: cgMetaGraph },
      // Persist the wire-id commitment in the cg's _meta graph so a
      // restart can resume host-mode subscription on the correct
      // topic without re-reading the chain event.
      { subject: contextGraphUri, predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${nameHash}"`, graph: cgMetaGraph },
    ]);
    this.invalidateListContextGraphsCache();
    this.contextGraphMetaProjection.markDirty(id);
    // We no longer persist `publishAuthorityAccountId` locally even on
    // success (Codex PR #502 round-6 follow-through): with the
    // stored-value fallback gone, nothing reads it. A CG can only
    // register on-chain once anyway — re-reads of the stored id
    // wouldn't be useful.

    // Update in-memory subscription record and ensure we're subscribed
    const sub = this.subscribedContextGraphs.get(id);
    if (sub) {
      const next = { ...sub, onChainHash: nameHash };
      this.bindSubscriptionOnChainId(id, next, onChainId);
      this.setContextGraphSubscription(id, next, { persist: false });
      this.subscribeToContextGraph(id, {
        trackSyncScope: true,
        syncMode: 'always-on',
      });
      if (!next.subscribed) {
        this.log.info(ctx, `Subscribed to newly registered context graph "${id}"`);
      }
      this.persistContextGraphSubscription(id);
    }

    // Registration status is in _meta — it propagates to peers via sync, not
    // gossip, so that only the authenticated sync path can update it.
    // Broadcast the ontology-graph OnChainId quad so peers see the link.
    try {
      const onChainNquad = `<${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId> "${onChainId}" <${ontologyGraph}> .`;
      const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      const regMsg = encodePublishRequest({
        ual: `did:dkg:context-graph:${id}`,
        nquads: new TextEncoder().encode(onChainNquad),
        contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
        kas: [],
        publisherIdentity: this.wallet.keypair.publicKey,
        publisherAddress: '',
        startKAId: 0,
        endKAId: 0,
        chainId: '',
        publisherSignatureR: new Uint8Array(0),
        publisherSignatureVs: new Uint8Array(0),
      });
      await this.gossip.publish(ontologyTopic, regMsg);
    } catch (err) {
      this.log.debug(ctx, `Registration gossip broadcast failed (peers may not be subscribed yet): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { onChainId };
  }

  /**
   * Invite a peer to join an existing context graph.
   * Adds the peer to the local allowlist in `_meta`.
   */
  async inviteToContextGraph(this: DKGAgent, contextGraphId: string, peerId: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');

    // Validate peer ID format (libp2p Ed25519 base58btc, e.g. 12D3KooW…)
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      peerIdFromString(peerId);
    } catch {
      throw new Error(`Invalid peer ID format: "${peerId}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    // Only the curator/creator can manage the allowlist
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage peer invitations');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const escapedPeerId = escapeSparqlLiteral(peerId);

    const existingAllowlist = await this.getContextGraphAllowedPeers(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If this is the first allowlist entry (CG was open), also add our own
    // peer ID so the curator doesn't lock themselves out.
    if (existingAllowlist === null || existingAllowlist.length === 0) {
      const curatorPeerId = escapeSparqlLiteral(this.peerId);
      quadsToInsert.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${curatorPeerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Skip if already in the allowlist (idempotent).
    //
    // Codex review on #873 — the `warnIfAllowlistWriteOnPublicCg`
    // call must come AFTER this early-return. Pre-fix, the warning
    // ran first and logged "writing allowlist quad" even on
    // re-invites that didn't insert anything, so operators got
    // misleading audit trails for no-op calls.
    if (existingAllowlist?.includes(peerId)) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'node',
        principalId: peerId,
        role: 'participant',
        status: 'active',
        source: 'allowed-peer',
      });
      this.log.info(ctx, `Peer ${peerId} already in allowlist for "${contextGraphId}" — skipping`);
      return;
    }

    quadsToInsert.push({
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${escapedPeerId}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);
    this.invalidateListContextGraphsCache();
    this.contextGraphMetaProjection.markDirtyFromQuads(quadsToInsert);

    // Issue #865 — log a clear warning AFTER the allowlist quad has
    // landed on a CG with an explicit `accessPolicy="public"` triple.
    // The allowlist write is allowed (legitimate uses include
    // populating an authorized-publisher set on a public-but-curated-
    // publish CG), but post-#865 the publisher's
    // `isPrivateContextGraph` no longer silently flips the CG to
    // curated just because an allowlist was written — so the
    // operator should know the allowlist is informational for read
    // access on this CG.
    //
    // Codex review round 5 on #873 (line 17485) — call site is
    // post-insert so the breadcrumb only fires for writes that
    // actually hit the store. A failing `store.insert` throws to the
    // caller before we reach this point, so the warn is a faithful
    // record of persisted state.
    await this.warnIfAllowlistWriteOnPublicCg(contextGraphId, ctx, 'inviteToContextGraph (peer)');

    if (existingAllowlist === null || existingAllowlist.length === 0) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'node',
        principalId: this.peerId,
        role: 'curator',
        status: 'active',
        source: 'allowed-peer',
        displayName: this.nodeName,
      });
    }
    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'node',
      principalId: peerId,
      role: 'participant',
      status: 'active',
      source: 'allowed-peer',
    });

    // Allowlist updates are in _meta and propagate to peers via the
    // authenticated sync protocol, not unauthenticated gossip.

    this.log.info(ctx, `Invited peer ${peerId} to context graph "${contextGraphId}"`);
  }

  /**
   * Invite an agent (by Ethereum address) to join an existing context graph.
   * Adds the agent to the local allowlist in `_meta`.
   */
  async inviteAgentToContextGraph(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
    delegation?: SignedAgentDelegation,
  ): Promise<void> {
    return this.withContextGraphJoinAdmissionLock(contextGraphId, (admissionLockToken) =>
      this.commitInviteAgentToContextGraph(
        admissionLockToken,
        contextGraphId,
        agentAddress,
        callerAgentAddress,
        delegation,
      ));
  }

  /** Policy-agnostic invite orchestration; caller must hold the CG admission lock. */
  async commitInviteAgentToContextGraph(this: DKGAgent,
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
    delegation?: SignedAgentDelegation,
  ): Promise<void> {
    const prepared = await this.prepareInviteAgentToContextGraph(
      admissionLockToken,
      contextGraphId,
      agentAddress,
      callerAgentAddress,
      delegation,
    );
    await this.commitPreparedInviteAgentToContextGraph(
      admissionLockToken,
      contextGraphId,
      prepared,
    );
  }

  /**
   * Complete every awaited invite preflight and return a single-use opaque
   * mutation capability. Preparing never changes membership state.
   */
  async prepareInviteAgentToContextGraph(this: DKGAgent,
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
    delegation?: SignedAgentDelegation,
  ): Promise<PreparedContextGraphAgentInviteMutation> {
    this.contextGraphJoinAdmissionLockManager.assertHeld(contextGraphId, admissionLockToken);
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage invitations');

    const existingParticipants = await this.getPrivateContextGraphParticipants(contextGraphId);
    const alreadyAllowed = existingParticipants?.some(
      (a) => a.toLowerCase() === agentAddress.toLowerCase(),
    ) ?? false;

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const quadsToInsert: Quad[] = [];
    const curatorAgentAddress = (!existingParticipants || existingParticipants.length === 0)
      ? this.defaultAgentAddress
      : undefined;

    if (curatorAgentAddress) {
      quadsToInsert.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${curatorAgentAddress}"`,
        graph: cgMetaGraph,
      });
    }

    // Codex review on #873 — only push the bare allowlist quad when
    // the list is actually growing. Re-approving an existing agent
    // with a fresh delegation overwrites the delegation node (below)
    // but must not re-insert the DKG_ALLOWED_AGENT triple.
    if (!alreadyAllowed) {
      quadsToInsert.push({
        subject: contextGraphUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${agentAddress}"`,
        graph: cgMetaGraph,
      });
    }

    let delegationUri: string | undefined;
    if (delegation) {
      const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
      const DKG = 'https://dkg.network/ontology#';
      delegationUri = `did:dkg:agent-delegation:${contextGraphId}:${agentAddress.toLowerCase()}`;
      quadsToInsert.push({ subject: delegationUri, predicate: RDF_TYPE, object: `${DKG}AgentDelegation`, graph: cgMetaGraph });
      quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${agentAddress.toLowerCase()}"`, graph: cgMetaGraph });
      quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: `"${delegation.issuedAtMs}"`, graph: cgMetaGraph });
      if (delegation.expiresAtMs && delegation.expiresAtMs > 0) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${delegation.expiresAtMs}"`, graph: cgMetaGraph });
      }
      if (delegation.delegateePeerId) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${delegation.delegateePeerId}"`, graph: cgMetaGraph });
      }
      if (delegation.delegateeOpKey) {
        quadsToInsert.push({ subject: delegationUri, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY, object: `"${delegation.delegateeOpKey.toLowerCase()}"`, graph: cgMetaGraph });
      }
    }

    return this.contextGraphMembershipMutations.prepare(
      admissionLockToken,
      contextGraphId,
      {
        contextGraphId,
        agentAddress,
        delegation,
        alreadyAllowed,
        noOp: alreadyAllowed && !delegation,
        cgMetaGraph,
        delegationUri,
        quadsToInsert,
        curatorAgentAddress,
      },
    );
  }

  /**
   * Cross the membership write boundary using a prepared capability. There
   * are no awaited preflights before the first store mutation in this method.
   */
  async commitPreparedInviteAgentToContextGraph(this: DKGAgent,
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    prepared: PreparedContextGraphAgentInviteMutation,
  ): Promise<void> {
    this.contextGraphJoinAdmissionLockManager.assertHeld(contextGraphId, admissionLockToken);
    const plan = this.contextGraphMembershipMutations.consume(
      admissionLockToken,
      contextGraphId,
      prepared,
    );
    const {
      agentAddress,
      delegation,
      alreadyAllowed,
      noOp,
      cgMetaGraph,
      delegationUri,
      quadsToInsert,
      curatorAgentAddress,
    } = plan;
    const ctx = createOperationContext('system');

    // Preserve idempotent manual re-invites while keeping even the local
    // membership projection on the commit side of the prepared capability.
    if (noOp) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: agentAddress,
        role: 'participant',
        status: 'active',
        source: 'allowed-agent',
      });
      this.log.info(ctx, `Agent ${agentAddress} already in allowlist for "${contextGraphId}" — skipping`);
      return;
    }

    // A synchronous admission-specific guard can run after prepare returns
    // and immediately before this call. The first awaited operation here is
    // therefore also the first persistent membership mutation.
    if (delegationUri) {
      await deleteByPatternWithoutCount(this.store, { graph: cgMetaGraph, subject: delegationUri });
    }
    await this.store.insert(quadsToInsert);
    this.invalidateListContextGraphsCache();

    this.contextGraphMetaProjection.markDirtyFromQuads(quadsToInsert);

    if (curatorAgentAddress) {
      this.upsertContextGraphMember({
        contextGraphId,
        principalType: 'agent',
        principalId: curatorAgentAddress,
        role: 'curator',
        status: 'active',
        source: 'allowed-agent',
      });
    }

    // Issue #865 — companion warning to the peer-invite path above.
    // Allowlist writes on explicit-public CGs are allowed (the
    // publishPolicy=curated + accessPolicy=public combination is a
    // valid CG mode where the allowlist gates publishers, not
    // subscribers), but the operator should know that the read-side
    // gate stays open per the explicit `accessPolicy="public"`.
    //
    // Codex review round 4/5 on #873 — fires AFTER `store.insert`
    // succeeds so the breadcrumb is a faithful record of persisted
    // state (a failing insert throws before this point). Gated on
    // `!alreadyAllowed` because re-approves that only refresh a
    // delegation don't grow the allowlist, so they don't warrant
    // the public-CG breadcrumb.
    if (!alreadyAllowed) {
      await this.warnIfAllowlistWriteOnPublicCg(contextGraphId, ctx, 'inviteAgentToContextGraph');
    }

    this.upsertContextGraphMember({
      contextGraphId,
      principalType: 'agent',
      principalId: agentAddress,
      role: 'participant',
      status: 'active',
      source: 'allowed-agent',
    });

    this.log.info(
      ctx,
      delegation
        ? `Invited agent ${agentAddress} to context graph "${contextGraphId}" with delegation (peer=${delegation.delegateePeerId ?? 'n/a'}, opKey=${delegation.delegateeOpKey ?? 'n/a'})`
        : `Invited agent ${agentAddress} to context graph "${contextGraphId}"`,
    );
  }

  /**
   * Remove an agent from a context graph's allowlist.
   */
  async removeAgentFromContextGraph(this: DKGAgent, contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    return this.withContextGraphJoinAdmissionLock(contextGraphId, (admissionLockToken) =>
      this.commitRemoveAgentFromContextGraph(
        admissionLockToken,
        contextGraphId,
        agentAddress,
        callerAgentAddress,
      ));
  }

  /** Internal agent-membership removal; caller must hold the CG admission lock. */
  async commitRemoveAgentFromContextGraph(
    this: DKGAgent,
    admissionLockToken: ContextGraphJoinAdmissionLockToken,
    contextGraphId: string,
    agentAddress: string,
    callerAgentAddress?: string,
  ): Promise<void> {
    this.contextGraphJoinAdmissionLockManager.assertHeld(contextGraphId, admissionLockToken);
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage participants');

    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);

    await deleteByPatternWithoutCount(this.store, {
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
    });
    // Also drop any agent-delegation for this agent, otherwise their
    // node retains sync access via the delegation gate (peer-id /
    // op-key allowlist) even after the agent is removed from the
    // primary allowlist. See `inviteAgentToContextGraph` for the
    // matching write side.
    const delegationUri = `did:dkg:agent-delegation:${contextGraphId}:${agentAddress.toLowerCase()}`;
    await deleteByPatternWithoutCount(this.store, { graph: cgMetaGraph, subject: delegationUri });
    // Persist a LOCAL tombstone so the recipient resolver excludes this
    // agent from future sender-key wraps even when peer-sync has
    // replicated the original `dkg:allowedAgent` triple onto this store
    // (happens whenever multiple peers pre-create the CG with the same
    // initial allowlist — see C1 devnet harness). Without the tombstone
    // the delete above is racy: a fresh sync round can re-insert the
    // revoked agent before the curator's next write resolves recipients,
    // and the next sender-key epoch ends up wrapped for them too — a
    // silent post-revoke read by a kicked member.
    await this.store.insert([{
      graph: cgMetaGraph,
      subject: contextGraphUri,
      predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
      object: `"${agentAddress}"`,
    }]);
    this.invalidateListContextGraphsCache();
    this.contextGraphMetaProjection.markDirty(contextGraphId);
    this.deleteContextGraphMember(contextGraphId, 'agent', agentAddress);
    // Reconciled after the projection is invalidated at the end of removal.
    // Drop any cached sender-key send state for this CG so the next
    // write re-resolves recipients (now excluding the revoked agent
    // via the tombstone) and mints a fresh epoch. Without this the
    // curator would keep using the pre-revoke chain key + epoch, which
    // was already distributed to the revoked agent.
    const cgPrefix = `${contextGraphId}\0`;
    for (const key of [...this.swmSenderKeySendStates.keys()]) {
      if (key.startsWith(cgPrefix)) {
        this.swmSenderKeySendStates.delete(key);
      }
    }
    await this.saveSwmSenderKeyState();
    // `queueSharedMemoryGossipSubscription` may start a metadata projection
    // read while the revocation mutation is still completing. Invalidate once
    // more after all awaited removal work so that an in-flight pre-revoke
    // snapshot cannot become the clean cached value returned to the very next
    // admission check.
    this.contextGraphMetaProjection.markDirty(contextGraphId);
    this.queueSharedMemoryGossipSubscription(contextGraphId);

    this.log.info(ctx, `Removed agent ${agentAddress} from context graph "${contextGraphId}" (tombstoned)`);
  }

  /**
   * Rename a context graph (updates its `schema:name` display label).
   *
   * Writes into BOTH the ONTOLOGY graph (primary source for
   * `listContextGraphs()` on open CGs) and the CG's `_meta` graph
   * (used as the private/curated CG definition index) so the rename is
   * durable regardless of which graph type the CG was originally created
   * in. Previous display-name triples are wiped from both graphs first
   * to guarantee idempotent rename (no "two names in the store").
   *
   * Authorization: same as other CG mutations — only the creator can
   * rename. Enforced via `assertCallerIsOwner`.
   */
  async renameContextGraph(this: DKGAgent,
    contextGraphId: string,
    name: string,
    callerAgentAddress?: string,
  ): Promise<void> {
    const ctx = createOperationContext('system');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new Error('Context graph name must be a non-empty string.');
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'rename context graph');

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
    const schemaName = DKG_ONTOLOGY.SCHEMA_NAME;

    await deleteByPatternWithoutCount(this.store, {
      subject: contextGraphUri,
      predicate: schemaName,
      graph: ontologyGraph,
    });
    await deleteByPatternWithoutCount(this.store, {
      subject: contextGraphUri,
      predicate: schemaName,
      graph: cgMetaGraph,
    });

    const escaped = `"${escapeSparqlLiteral(trimmed)}"`;
    await this.store.insert([
      { subject: contextGraphUri, predicate: schemaName, object: escaped, graph: ontologyGraph },
      { subject: contextGraphUri, predicate: schemaName, object: escaped, graph: cgMetaGraph },
    ]);
    this.invalidateListContextGraphsCache();
    this.contextGraphMetaProjection.markDirty(contextGraphId);

    this.log.info(ctx, `Renamed context graph "${contextGraphId}" to "${trimmed}"`);
  }

  /**
   * List allowed agents for a context graph.
   */
  async getContextGraphAllowedAgents(this: DKGAgent, contextGraphId: string): Promise<string[]> {
    // Subtract `dkg:revokedAgent` tombstones from the allowlist union
    // so a curator who has called `removeAgentFromContextGraph` sees
    // their authoritative view, not the union with peer-sync-replicated
    // copies of the original allowlist. Without this, the /participants
    // endpoint and every sync-auth check that consults this method would
    // silently re-include a revoked agent the moment another node's
    // local CG metadata gossiped back (see C1 devnet harness for the
    // reproducer + `removeAgentFromContextGraph` for the write side).
    const meta = await this.getCgMeta(contextGraphId);
    const allowed = meta.allowedAgents;
    const revoked = new Set(meta.revokedAgents.map((addr) => addr.toLowerCase()));
    if (revoked.size === 0) return allowed;
    return allowed.filter((addr) => !revoked.has(addr.toLowerCase()));
  }

  // ---------------------------------------------------------------------------
  // Join Request — signed request / approval flow for curated CGs
  // ---------------------------------------------------------------------------

  /**
   * Create a signed join request for a curated context graph.
   * The requesting agent signs `keccak256(contextGraphId ‖ agentAddress ‖ timestamp)`
   * with its custodial wallet, producing a verifiable proof of identity.
   */
}
