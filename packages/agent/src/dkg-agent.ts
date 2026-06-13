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
  // OT-RFC-43 A2/B3 — per-layer pointers + derived status helper.
  deriveStatus, type KaStatus,
  WM_CURRENT_ASSERTION_PRED, SWM_CURRENT_ASSERTION_PRED, VM_CURRENT_ASSERTION_PRED,
  KA_ID_PRED, RESERVED_UAL_PRED,
  type CollectedACK, type V10CoreNodeACK, type LiftAuthorityProof, type LiftTransitionType,
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
import { reconcileAndAllocateKaNumber } from './allocator.js';
import { applyMixins } from './dkg-agent-apply-mixins.js';
import { OwnershipMethods } from './dkg-agent-ownership.js';
import { ContextGraphResolveMethods } from './dkg-agent-cg-resolve.js';
import { CclPolicyMethods } from './dkg-agent-ccl.js';
import { EndorseVerifyMethods } from './dkg-agent-endorse.js';
import { ContextGraphRegistryMethods } from './dkg-agent-cg-registry.js';
import { JoinRequestMethods } from './dkg-agent-join.js';
import { SwmSubstrateMethods } from './dkg-agent-swm-substrate.js';
import { QueryMethods } from './dkg-agent-query.js';
import { AgentRegistryMethods } from './dkg-agent-registry.js';
import { WorkspaceCryptoMethods } from './dkg-agent-crypto.js';
import { LifecycleSyncMethods } from './dkg-agent-lifecycle.js';
import { PublishMethods } from './dkg-agent-publish.js';
import { SwmHostModeMethods } from './dkg-agent-swm-host.js';
import { ContextGraphMethods } from './dkg-agent-context-graph.js';
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
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
  ContextGraphMemberPrincipalType,
  ContextGraphMemberStatus,
  ContextGraphMembershipRecord,
  ContextGraphMembershipStore,
  DurableSyncDiagnostics,
  SharedMemorySyncDiagnostics,
  CatchupSyncDiagnostics,
  DKGAgentConfig,
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
  /** OT-RFC-43 §10.5.4 derived overall status. */
  status: KaStatus;
  /** The per-author KA NUMBER (low 96 bits) stamped at finalize, as a string. */
  kaNumber?: string;
  /** did:dkg:<chainId>/<agentAddrLower>/<number> reserved at finalize. */
  reservedUal?: string;
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

  static async create(config: DKGAgentConfig): Promise<DKGAgent> {
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
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        tokenAddress: config.chainConfig.tokenAddress,
        chainId: config.chainConfig.chainId,
        approvalPolicy: config.chainConfig.approvalPolicy,
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

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store);

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
    const publisher = new DKGPublisher({
      store,
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

    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks, publicSnapshotStore,
    );
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
    return computeNetworkId();
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
   * Scan the local ONTOLOGY graph and curated/private _meta graphs for context
   * graph definitions and auto-subscribe to any that aren't yet in the
   * subscription registry. Called after syncFromPeer to catch context graphs
   * discovered via ONTOLOGY sync or authenticated _meta sync.
   */
  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, { id: string; name: string; source: 'ontology' | 'meta' }>();

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
        const name = row['name'] ? stripLiteral(row['name']) : existing?.name ?? id;

        if (!existing || (existing.source === 'meta' && source === 'ontology')) {
          discoveredEntries.set(id, { id, name, source });
        }
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

    for (const { id, name, source } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) continue;

      // Two kinds of discovered CG, two different opt-in semantics:
      //
      // - Open / public CG (no curated _meta graph locally): Viktor's
      //   v10-rc hardening (commit b9a73e7e "better sync") says do
      //   NOT auto-subscribe — a node shouldn't auto-ingest every
      //   public CG a peer happens to know about. Explicit subscribe
      //   (UI "Join" / `subscribeToContextGraph`) is the opt-in.
      //
      // - Curated / private CG (access policy "private" or has an
      //   allowlist): auto-subscribe so `trySyncFromPeer`'s
      //   "newly discovered CGs" catchup pass (see dkg-agent.ts
      //   ~#1009) actually fetches the KC data on the same connect
      //   cycle. Without this, a freshly invited node would see
      //   the CG registered locally but never pull any KCs —
      //   regressed the e2e-privacy "B discovers and syncs a
      //   private CG in a single connect cycle via trySyncFromPeer"
      //   test. `authorizeSyncRequest` still enforces the allowlist
      //   on the responder side, so auto-subscribing here cannot
      //   leak private data to non-participants; it only means
      //   "attempt the catchup now instead of deferring it".
      //   NOTE: we use `isPrivateContextGraph` (which reads the
      //   ontology OR the _meta graph for `dkg:accessPolicy
      //   "private"`, and also treats any CG with a `DKG_ALLOWED_
      //   AGENT` allowlist as private) rather than
      //   `source === 'meta'`, because the ontology-vs-meta
      //   collision resolver above lets an ontology row shadow a
      //   meta row when both exist for the same id.
      const isCurated = await this.isPrivateContextGraph(id);

      if (isCurated) {
        // Seed the subscription entry BEFORE calling subscribeToContextGraph
        // so the `...existing` spread in `subscribeToContextGraph` preserves
        // the discovered human-readable `name` (otherwise the UI/listing
        // APIs fall back to the raw CG id).
        //
        // `synced: false` is the truthful state at discovery — we have
        // the definition triple but no CG content yet. The catchup
        // runner flips it to true once data has actually been pulled
        // (see `markContextGraphSubscriptionState` at
        // routes/context-graph.ts:1301).
        //
        // Intentionally leave `metaSynced` FALSE here for the same
        // reason: the gossip handler's "deny until _meta is synced"
        // guard must stay armed until the authenticated allowlist
        // (`_meta` graph) has actually arrived. The follow-up
        // `refreshMetaSyncedFlags(newlyDiscovered)` call from
        // `trySyncFromPeer` will flip it once the allowlist has been
        // fetched via the authenticated sync path.
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: false,
          onChainId: undefined,
        }, { persist: false });
        this.subscribeToContextGraph(id);
        this.log.info(ctx, `Discovered invited context graph "${name}" (${id}) — auto-subscribed (private/allowlisted)`);
      } else {
        // Same truthful-flag rationale as the curated branch above:
        // `synced` reflects "have CG data locally", not "have heard the
        // definition triple from gossip."
        this.setContextGraphSubscription(id, {
          name,
          subscribed: false,
          synced: false,
          metaSynced: source === 'meta',
          onChainId: undefined,
        }, { persist: false });
        this.log.info(ctx, `Discovered context graph "${name}" (${id}) from ${source} store — added as discoverable only`);
      }
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store`);
    }
    return discovered;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }

    let onChainContextGraphs;
    try {
      onChainContextGraphs = await this.chain.listContextGraphsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain context graph scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainContextGraphs) {
      if (knownOnChainIds.has(p.contextGraphId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.contextGraphId);
        continue;
      }

      // Curated CGs (accessPolicy=1) must not silently land in non-participants' lists.
      // We can't query the V10 ContextGraphs participant set from a NameRegistry event alone,
      // so apply the strict default: only auto-subscribe when this node's wallet matches
      // `creator` (the address that called claimName). Real participants will have the CG
      // surfaced through manual subscribe / catch-up triggered by their curator.
      if (Number(p.accessPolicy) === 1) {
        const isCurator = !!this.defaultAgentAddress
          && typeof p.creator === 'string'
          && p.creator.toLowerCase() === this.defaultAgentAddress.toLowerCase();
        if (!isCurator) {
          this.log.info(ctx, `Skipping auto-subscribe to curated chain entry "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — not curator`);
          knownOnChainIds.add(p.contextGraphId);
          continue;
        }
      }

      this.setContextGraphSubscription(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        metaSynced: false,
        onChainId: p.contextGraphId,
      });
      this.subscribeToContextGraph(p.name, { trackSyncScope: false });

      // Persist the on-chain ID to the ontology graph so the publisher's
      // VM registration guard can find it via RDF (it has no access to
      // the in-memory subscribedContextGraphs map).
      const cgUri = contextGraphDataGraphUri(p.name);
      const ontoGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
      await this.store.insert([{
        subject: cgUri,
        predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`,
        object: `"${p.contextGraphId}"`,
        graph: ontoGraph,
      }]);

      this.contextGraphMetaProjection.markDirty(p.name);
      this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    return discovered;
  }

  /**
   * Snapshot of the V10 Random Sampling prover's recent activity.
   * Returns a disabled-handle status when the prover never started
   * (edge node, no identity, missing chain methods). Used by the
   * daemon's `/api/random-sampling/status` route + the CLI's
   * `random-sampling status` subcommand.
   */
  getRandomSamplingStatus(): RandomSamplingStatus {
    if (this.randomSamplingHandle) return this.randomSamplingHandle.getStatus();
    return {
      enabled: false,
      role: (this.config.nodeRole ?? 'edge') as 'core' | 'edge',
      identityId: '0',
      loop: null,
    };
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
    if (this.messengerOutboxTimer) {
      clearInterval(this.messengerOutboxTimer);
      this.messengerOutboxTimer = null;
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
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    await gm.ensureContextGraph(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) return;

    // Insert genesis quads
    const genesisQuads = getGenesisQuads();
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
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
      // rc.9 PR-11: ACKCollector now routes through messenger.send
      // Reliable so /dkg/10.0.1/storage-ack gets envelope wrap +
      // sender-side idempotency. ACKCollector's own MAX_RETRIES=3 loop
      // sits on top; queued counts as a per-peer failure that the
      // collector handles via its existing retry-then-skip path.
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const sendResult = await this.messenger.sendReliable(peerId, protocol, data);
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        return sendResult.response;
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        // Prefer peers confirmed as core nodes (advertise StorageACK protocol).
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        // Fallback: return all connected peers during early startup before
        // protocol discovery completes. Since only core nodes register the
        // StorageACK handler, requests to edge nodes fail at protocol
        // negotiation (fast, no error logs on the remote side).
        return connected;
      },
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

    return async (
      merkleRoot: Uint8Array,
      contextGraphId: string,
      kaCount: number,
      rootEntities: string[],
      publicByteSize: bigint,
      stagingQuads: Uint8Array | undefined,
      epochs: number | undefined,
      tokenAmount: bigint | undefined,
      swmGraphId: string | undefined,
      subGraphName: string | undefined,
      merkleLeafCount: number,
      isEncryptedPayload?: boolean,
      // OT-RFC-38 LU-11 — when present, the publisher's chunked
      // emitter has already AEAD-encrypted + SWM-gossiped per-chunk
      // ciphertexts. The collector routes through V2 ACK with empty
      // stagingQuads and these fields populating PublishIntent.
      chunkedCommitment?: {
        ciphertextChunksRoot: Uint8Array;
        ciphertextChunkCount: number;
      },
    ) => {
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
        cgIdBigInt = BigInt(contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (!Number.isInteger(merkleLeafCount) || merkleLeafCount < 1) {
        throw new Error(
          `V10 ACK collection requires a positive integer merkleLeafCount; got ${merkleLeafCount}. ` +
          'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
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
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize,
        isPrivate: isEncryptedPayload === true,
        kaCount,
        rootEntities,
        chainId: chainIdBig,
        kav10Address,
        requiredACKs,
        stagingQuads,
        epochs,
        tokenAmount,
        swmGraphId,
        subGraphName,
        merkleLeafCount,
        isEncryptedPayload,
        chunkedCommitment,
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
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const sendResult = await this.messenger.sendReliable(peerId, protocol, data);
        if (!sendResult.delivered) {
          throw new Error(`substrate queued (transport): ${sendResult.error}`);
        }
        return sendResult.response;
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        return connected;
      },
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
      newCiphertextChunksRoot?: Uint8Array;
      newCiphertextChunkCount?: number;
      stagingQuads?: Uint8Array;
      swmGraphId?: string;
      subGraphName?: string;
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
      if (!Number.isInteger(params.newMerkleLeafCount) || params.newMerkleLeafCount < 1) {
        throw new Error(
          `V10 UPDATE ACK collection requires a positive integer newMerkleLeafCount; got ${params.newMerkleLeafCount}.`,
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
        newCiphertextChunksRoot: params.newCiphertextChunksRoot,
        newCiphertextChunkCount: params.newCiphertextChunkCount,
        chainId: chainIdBig,
        kav10Address,
        publisherPeerId: this.peerId,
        requiredACKs,
        swmGraphId: params.swmGraphId,
        subGraphName: params.subGraphName,
        stagingQuads: params.stagingQuads,
      });
      return result.acks;
    };
  }

  async broadcastPublish(contextGraphId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const onChain = result.onChainResult;
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: new TextEncoder().encode(ntriples),
      contextGraphId: contextGraphId,
      kas: result.kaManifest.map(ka => ({
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
        opts?: { subGraphName?: string },
      ): Promise<void> {
        let quads: import('@origintrail-official/dkg-storage').Quad[];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          quads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          const { publicQuads, privateQuads } = await jsonLdToQuads(input as JsonLdContent);
          quads = [...publicQuads, ...privateQuads];
        } else {
          quads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        return agent.publisher.assertionWrite(contextGraphId, name, agentAddress, quads, opts?.subGraphName);
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        return agent.publisher.assertionQuery(contextGraphId, name, agentAddress, opts?.subGraphName);
      },
      /** OT-RFC-43 §10.5.3 — seed a fresh WM draft from this file's SWM/VM state. */
      async pullFrom(
        contextGraphId: string,
        name: string,
        sourceLayer: 'swm' | 'vm',
        opts?: { subGraphName?: string; onConflict?: 'reject' | 'replace' },
      ): Promise<{ seeded: number; fromLayer: 'swm' | 'vm'; entities: number }> {
        return agent.publisher.assertionPullFrom(contextGraphId, name, agentAddress, sourceLayer, opts);
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string; authorAgentAddress?: string; preSignedAuthorAttestation?: PreSignedAuthorAttestation }): Promise<{ promotedCount: number }> {
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
        // Only auto-finalize a FULL promote: the seal covers ALL roots, but a
        // selective promote (`opts.entities` subset) ships only some — sealing
        // all then promoting a subset makes `publishFromFinalizedAssertion`
        // recompute a different merkleRoot. A selective promote must be finalized
        // explicitly with a matching scope.
        const promotingAllEntities = !opts?.entities || opts.entities === 'all';
        if (promotingAllEntities) {
          try {
            await agent.assertionFinalize(contextGraphId, name, agentAddress, {
              subGraphName: opts?.subGraphName,
              authorAgentAddress: opts?.authorAgentAddress,
              preSignedAuthorAttestation: opts?.preSignedAuthorAttestation,
            });
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            // Seal-integrity failures — the assertion was edited after finalize
            // (stale seal) or the seal is corrupt — MUST fail fast: promoting
            // unsealed would empty WM and leave only a later, confusing publish
            // error. Re-throw so the caller re-finalizes (or discards) first.
            if (/already finalized with a different merkleRoot|seal for .* is corrupt/i.test(msg)) {
              throw err;
            }
            // Deliberate no-regression fallback for CAPABILITY gaps only — the
            // node can't sign for this author (no local key / non-V10 adapter /
            // unregistered CG): warn and promote UNSEALED exactly as before; the
            // later publish surfaces the explicit-finalize requirement.
            agent.log.warn(
              createOperationContext('share'),
              `Auto-finalize before promote skipped for "${name}": ${msg}. ` +
                `Promoting unsealed; publishing to Verifiable Memory will require an explicit finalize first.`,
            );
          }
        }
        // Resolve the gossip signer up-front (mirrors `share()` /
        // `conditionalShare()` patterns) so the publisher can wrap the
        // promoted SWM gossip in the Sender Key encrypted envelope.
        // Without this, private/agent-gated CGs receive plaintext
        // gossip and the new `SharedMemoryHandler` check rejects it.
        const gossipSigner = await agent.resolveWorkspaceGossipSigningAgent(contextGraphId);
        const { promotedCount, gossipMessage } = await agent.publisher.assertionPromote(
          contextGraphId, name, agentAddress,
          {
            ...opts,
            publisherPeerId: agent.node.peerId.toString(),
            senderAgentAddress: gossipSigner?.agentAddress,
          },
        );
        if (gossipMessage) {
          try {
            await agent.publishWorkspaceGossip(contextGraphId, gossipMessage, createOperationContext('share'), gossipSigner);
          } catch (err: any) {
            agent.log.warn(createOperationContext('share'), `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
          }
        }
        // OT-RFC-43 A2 (decision 2) — stamp dkg:swmCurrentAssertion on the
        // lifecycle URN so the SWM pointer is observable (and can diverge from
        // WM/VM). Best-effort; never blocks the share result.
        await agent._stampSwmPointer(contextGraphId, name, agentAddress, opts?.subGraphName);
        return { promotedCount };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        return agent.publisher.assertionDiscard(contextGraphId, name, agentAddress, opts?.subGraphName);
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
        return agent.assertionFinalize(contextGraphId, name, agentAddress, opts);
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionHistoryDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const lifecycleUri = assertionLifecycleUri(contextGraphId, addr, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Query assertion entity (current state + layer + OT-RFC-43 A2 pointers).
        const entityResult = await agent.store.query(
          `SELECT ?state ?memoryLayer ?assertionGraph ?wm ?swm ?vm ?kaNum ?reservedUal WHERE {
            GRAPH <${metaGraph}> {
              <${lifecycleUri}> <${DKG_NS}state> ?state .
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
              OPTIONAL { <${lifecycleUri}> <${WM_CURRENT_ASSERTION_PRED}> ?wm }
              OPTIONAL { <${lifecycleUri}> <${SWM_CURRENT_ASSERTION_PRED}> ?swm }
              OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
              OPTIONAL { <${lifecycleUri}> <${KA_ID_PRED}> ?kaNum }
              OPTIONAL { <${lifecycleUri}> <${RESERVED_UAL_PRED}> ?reservedUal }
            }
          } LIMIT 1`,
        );
        if (entityResult.type !== 'bindings' || entityResult.bindings.length === 0) return null;

        const row = entityResult.bindings[0];
        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const graphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);
        const wmCurrentAssertion = strip(row['wm']);
        const swmCurrentAssertion = strip(row['swm']);
        const vmCurrentAssertion = strip(row['vm']);
        const kaNumberStr = strip(row['kaNum']);
        const reservedUal = strip(row['reservedUal']);

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?kcUal ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              ?event <${DKG_NS}fromLayer> ?fromLayer .
              ?event <${DKG_NS}toLayer> ?toLayer .
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}kcUal> ?kcUal }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? '',
                toLayer: strip(b['toLayer']) ?? '',
                shareOperationId: strip(b['shareOpId']),
                kcUal: strip(b['kcUal']),
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
          status: deriveStatus(pointers),
          kaNumber: kaNumberStr,
          reservedUal,
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
        opts?: { entities?: readonly string[] | 'all'; subGraphName?: string },
      ): Promise<{ jobId: string }> {
        const jobId = await agent.promoteQueue.enqueue({
          contextGraphId,
          assertionName: name,
          subGraphName: opts?.subGraphName,
          entities: opts?.entities ?? 'all',
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


export interface DKGAgent extends ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods, ContextGraphResolveMethods, OwnershipMethods {}
applyMixins(DKGAgent, [ContextGraphMethods, SwmHostModeMethods, PublishMethods, LifecycleSyncMethods, WorkspaceCryptoMethods, AgentRegistryMethods, QueryMethods, SwmSubstrateMethods, JoinRequestMethods, ContextGraphRegistryMethods, EndorseVerifyMethods, CclPolicyMethods, ContextGraphResolveMethods, OwnershipMethods]);
