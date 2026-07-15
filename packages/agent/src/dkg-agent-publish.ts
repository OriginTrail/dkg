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
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  contextGraphCatalogUri,
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
  ASSERTION_SEAL_PREDICATES,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  LegacyKnowledgeAssetReadOnlyError,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
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
  withSpan,
  getMetrics,
  assertQuadLiteralsMutf8Safe,
} from '@origintrail-official/dkg-core';
import { SpanStatusCode } from '@opentelemetry/api';
import { GraphManager, PrivateContentStore, createTripleStore, loadSharedMemoryQuadsForScope, canonicalSharedMemoryScopeWriteGraph, type SharedMemoryGraphScope, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  computeTripleHashV10 as computeTripleHash,
  computeFlatKCRootV10 as computeFlatKCRoot,
  computePrivateRootV10 as computePrivateRoot,
  skolemizeByEntity,
  skolemizeKnowledgeAsset,
  skolemizeKnowledgeAssetParts,
  assertNoKnowledgeAssetPayloadNamedGraphs,
  isReservedSubject,
  canonicalPublishPayload,
  generatedPrivateCatalogTripleKeys,
  appendMissingGeneratedPrivateCatalogFloor,
  replaceCatalogPartitionWithGeneratedPrivateFloor,
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
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
  type CollectedACK,
  type LiftRequestAuthorSeal, type KnowledgeAssetVmPublishRequest,
  type AsyncKnowledgeAssetVmPublishPreflightResult,
  type AsyncKnowledgeAssetVmPublishRecoveryInput,
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
import { sharedMemoryScopeForFinalizedLifecycle } from './finalized-lifecycle-swm.js';

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
import { emitPublicProjection, buildPublicProjection } from './context-graph-public-projection.js';
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
  type SelectSwmFanoutPeersResult,
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
import { applyPublishedNamedKaVmLifecycle } from './named-ka-vm-lifecycle.js';
import { normalizeRecoveredNamedKaPublish } from './named-ka-publish-recovery.js';
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
import { reconcileAndAllocateKaNumber, readMaxKaNumberWithRetry, isTransientChainError } from './allocator.js';
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

/**
 * #1116 (round 11) — stable code tagged on the `assertionFinalize` throws that are
 * recoverable SIGNING/CHAIN CAPABILITY GAPS (no local signing key, non-V10 chain
 * adapter, KA-number reconcile read failure, no KaNumberAllocator) as opposed to
 * VALIDATION/INTEGRITY errors (empty draft, reserved-only/unsafe content, preSigned
 * mismatch, author-change, stale/corrupt seal). The seal-by-default `promote()`
 * classifies on this code: a capability gap is wrapped as UNSEALED_SHARE_BLOCKED;
 * a validation error is rethrown with its original message so the caller sees the
 * real input problem. New graph-scoped KAs never enter SWM without a seal.
 */
export const SEAL_CAPABILITY_GAP_CODE = 'SEAL_CAPABILITY_GAP';

export type ResolveCuratedChainKeyContextOptions = {
  /**
   * Binding-only id for AEAD associated data. This value must never affect
   * plaintext/encrypted policy selection.
   */
  aeadBindingContextGraphId?: string;
};

function normalizeOptionalContextGraphId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function rejectOversizedRdfLiterals(quads: Quad[] | undefined, label: string): void {
  if (!quads || quads.length === 0) return;
  assertQuadLiteralsMutf8Safe(quads, { label });
}

export function buildPrivateCatalogDefaultGraphQuads(cgDid: string, assertionUri: string): Quad[] {
  // `graph` is a non-empty placeholder only (buildPublicProjection requires
  // one); normalize it back to the default assertion graph before writing.
  return buildPublicProjection({ ual: cgDid, accessPolicy: 'private', graph: assertionUri })
    .map((quad) => ({ ...quad, graph: '' }));
}

function prepareQueuedKnowledgeAssetVmPublishOptions(input: {
  contextGraphId: string;
  snapshotQuads: readonly Quad[];
  onChainContextGraphId?: string;
  resolvedEncryptInlinePayload: PublishOptions['encryptInlinePayload'];
  resolvedEncryptInlineChunked: PublishOptions['encryptInlineChunked'];
  queuedEncryptInlinePayload: PublishOptions['encryptInlinePayload'];
  queuedEncryptInlineChunked: PublishOptions['encryptInlineChunked'];
}): Pick<
  PublishOptions,
  | 'quads'
  | 'encryptInlinePayload'
  | 'encryptInlineChunked'
  | 'trustedNonManifestCatalogTriples'
> {
  const encryptionOptions = {
    encryptInlinePayload:
      input.resolvedEncryptInlinePayload ?? input.queuedEncryptInlinePayload,
    encryptInlineChunked:
      input.resolvedEncryptInlineChunked ?? input.queuedEncryptInlineChunked,
  };
  if (!input.onChainContextGraphId || !input.resolvedEncryptInlinePayload) {
    return { quads: [...input.snapshotQuads], ...encryptionOptions };
  }

  const preparedCatalog = appendMissingGeneratedPrivateCatalogFloor(
    input.contextGraphId,
    input.snapshotQuads,
  );
  return {
    quads: preparedCatalog.quads,
    ...encryptionOptions,
    trustedNonManifestCatalogTriples:
      preparedCatalog.trustedNonManifestCatalogTriples,
  };
}

/**
 * Record the publish outcome metric (total + duration) for BOTH publish entry
 * points (`_publish` direct + `_publishFromSharedMemory`). A module-level
 * function (NOT a `this` method) so the metric sequence isn't pasted into two
 * flows AND so `PublishMethods.prototype._publish.call(stub, …)` unit tests —
 * which invoke `_publish` with a hand-built `this` — don't break on a missing
 * sibling method.
 */
function recordPublishOutcome(
  outcome: string,
  source: 'direct' | 'swm',
  startedAt: number,
  chainId?: string,
): void {
  const attrs = { outcome, source, ...(chainId ? { chain_id: chainId } : {}) };
  getMetrics().publishTotal.add(1, attrs);
  getMetrics().publishDuration.record(Date.now() - startedAt, attrs);
}

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
        // OT-RFC-49 WS-A — for a PRIVATE allowlist CG, this flips the gossip
        // leg OFF so curated SWM ciphertext stays off the public mesh and
        // reaches the roster over the reliable substrate only. Resolved on
        // the same planning path that already runs `isPrivateContextGraph`
        // for enumeration, so no extra store round-trip beyond its cache.
        isPrivate: await this.isPrivateContextGraph(contextGraphId),
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

    let substrateMembers = plan.substrateMembers;
    let fanoutSelection: SelectSwmFanoutPeersResult | undefined;
    if (plan.useSubstrate && plan.substrateMembers.length > 0) {
      fanoutSelection = this.selectSwmFanoutPeersForActiveShare({
        contextGraphId,
        candidatePeers: plan.substrateMembers,
        enumerationSource: plan.enumerationSource,
      });
      substrateMembers = fanoutSelection.selectedPeers;
      if (
        plan.enumerationSource === 'topic-subscribers'
        && (
          substrateMembers.length !== plan.substrateMembers.length
          || fanoutSelection.skippedRecentPeers.length > 0
        )
      ) {
        this.log.info(
          ctx,
          `SWM public fan-out narrowed cgId=${contextGraphId} `
          + `selected=${substrateMembers.length}/${plan.substrateMembers.length} `
          + `knownGood=${fanoutSelection.knownGoodPeers.length} `
          + `unknownProbe=${fanoutSelection.unknownProbedPeers.length} `
          + `skippedRecent=${fanoutSelection.skippedRecentPeers.length}`,
        );
      }
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
    // #1227 regression fix: gate + track on the FULL dialable set
    // (`plan.substrateMembers`), NOT the churn-selector-narrowed
    // `substrateMembers` send set. The active-fanout selector only
    // bounds which peers we ATTEMPT this round (to limit churn); the
    // ack-quorum's `expectedMembers` must stay the complete
    // roundtrip-eligible roster so a peer the selector skipped this
    // round still counts toward quorum once it acks (via gossip or a
    // later top-up). Narrowing `expectedMembers` to the probe-limited
    // subset silently dropped real subscribers from the quorum target
    // — the same class of bug the codex-RED note in
    // `enumerate-cg-members.ts` (`members` must not shrink
    // `expectedMembers`) was added to prevent.
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
    if (plan.useSubstrate && substrateMembers.length > 0) {
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
            members: substrateMembers,
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
                // #1227 regression fix: only feed TERMINAL initial-fanout
                // outcomes (delivered→good, failed/rejected→failed/
                // unsupported) into the active-fanout churn selector. A
                // transient `queued`/`retryable`/`inFlight` outcome
                // classifies as `nonTerminal` and would be cached with the
                // negative TTL (2m) — which is longer than the watchdog
                // interval (30s), so it suppressed the SAME share's first
                // watchdog top-up of that very peer (the watchdog exists
                // precisely to retry those queued/transient peers). Cross-
                // share churn limiting still works: a genuinely failed/
                // unsupported peer is remembered, and the top-up path
                // (swmSubstrateTopUp) keeps feeding its own outcomes.
                if (
                  plan.enumerationSource === 'topic-subscribers'
                  && classifySwmFanoutPeerOutcome(record) !== 'nonTerminal'
                ) {
                  this.recordSwmFanoutPeerRecord(contextGraphId, record);
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
            + `selected=${substrateMembers.length} `
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
    } else if (plan.useSubstrate && plan.enumerationSource === 'topic-subscribers') {
      this.log.info(
        ctx,
        `SWM public substrate fan-out skipped cgId=${contextGraphId}: `
        + `no eligible peers after recent outcome filtering `
        + `(candidates=${plan.substrateMembers.length})`,
      );
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
      // OT-RFC-43 §F2 — the attested packed id MUST live in the signing author's own
      // namespace (high 160 bits == author); otherwise the seal is locally valid but
      // unminted (the contract rejects a namespace-mismatched id with
      // KaIdNamespaceMismatch). Validate here, BEFORE workspace staging, so a bad
      // attestation never leaves an orphan WM write.
      const preSigned = opts.preSignedAuthorAttestation;
      // Presence/type guard first — an untyped (JS / older-client) caller that omits
      // the new field would otherwise hit `undefined >> 96n` and surface a cryptic
      // "cannot mix BigInt" TypeError instead of this stable contract error.
      if (typeof preSigned.reservedKaId !== 'bigint') {
        throw new Error(
          'publishAsync: preSignedAuthorAttestation.reservedKaId is required and must be a bigint — ' +
            'the packed (uint160(author) << 96) | number the author signed into the digest (OT-RFC-43 §F2).',
        );
      }
      if ((preSigned.reservedKaId >> 96n) !== BigInt(ethers.getAddress(preSigned.authorAddress))) {
        throw new Error(
          `publishAsync: preSignedAuthorAttestation reservedKaId namespace mismatch — ` +
            `id ${preSigned.reservedKaId} is not in author ${ethers.getAddress(preSigned.authorAddress)}'s ` +
            `namespace. The packed kaId must be (uint160(author) << 96) | number (OT-RFC-43 §F2).`,
        );
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
    rejectOversizedRdfLiterals(publicQuads, 'publishAsync.publicQuads');
    rejectOversizedRdfLiterals(privateQuads, 'publishAsync.privateQuads');

    if (opts?.transitionType !== undefined && opts.transitionType !== 'CREATE') {
      throw new InvalidContentError(
        'publishAsync creates one new atomic Knowledge Asset; use the KA update API for MUTATE or REVOKE',
      );
    }
    if (opts?.priorVersion !== undefined) {
      throw new InvalidContentError('publishAsync priorVersion is only valid for the legacy root-lift path');
    }
    if (opts?.namespace !== undefined || opts?.scope !== undefined || opts?.authority !== undefined) {
      throw new InvalidContentError(
        'publishAsync no longer accepts legacy root-lift namespace, scope, or authority metadata',
      );
    }
    if (
      this.chain.isV10Ready?.() !== true
      || typeof this.chain.getEvmChainId !== 'function'
      || typeof this.chain.getKnowledgeAssetsLifecycleAddress !== 'function'
    ) {
      throw Object.assign(
        new Error('publishAsync requires a V10-capable chain so every queued KA has a sealed UAL identity'),
        { code: SEAL_CAPABILITY_GAP_CODE },
      );
    }

    const accessPolicy = opts?.accessPolicy
      ?? (privateQuads.length > 0 ? 'ownerOnly' : 'public');
    const allowedPeers = [...new Set(
      (opts?.allowedPeers ?? []).map((peerId) => peerId.trim()).filter(Boolean),
    )];
    if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
      throw new InvalidContentError('publishAsync allowList policy requires allowedPeers');
    }
    if (accessPolicy !== 'allowList' && allowedPeers.length > 0) {
      throw new InvalidContentError('publishAsync allowedPeers requires allowList policy');
    }

    const fallbackAuthor = opts?.preSignedAuthorAttestation === undefined
      && opts?.authorAgentAddress === undefined
      ? await this.publisher.publisherFallbackAuthorAddress()
      : undefined;
    const lifecycleAgentAddress = ethers.getAddress(
      opts?.preSignedAuthorAttestation?.authorAddress
        ?? opts?.authorAgentAddress
        ?? fallbackAuthor
        ?? (() => {
          throw Object.assign(
            new Error('publishAsync cannot create a rootless KA because no author signer is available'),
            { code: SEAL_CAPABILITY_GAP_CODE },
          );
        })(),
    );
    const assertionName = `async-${randomUUID()}`;

    // Reuse the named-KA lifecycle rather than maintaining a second async
    // content model. Finalize canonicalizes the complete RDF set once, assigns
    // the UAL, and materializes the exact WM graph; promote moves that graph to
    // SWM and persists the immutable operation snapshot consumed by the queue.
    await this.publisher.assertionCreate(
      contextGraphId,
      assertionName,
      lifecycleAgentAddress,
      opts?.subGraphName,
    );
    if (publicQuads.length > 0) {
      await this.publisher.assertionWrite(
        contextGraphId,
        assertionName,
        lifecycleAgentAddress,
        publicQuads,
        opts?.subGraphName,
      );
    }
    if (privateQuads.length > 0) {
      await this.publisher.assertionWritePrivate(
        contextGraphId,
        assertionName,
        lifecycleAgentAddress,
        privateQuads,
        opts?.subGraphName,
      );
    }

    await this.assertionFinalize(
      contextGraphId,
      assertionName,
      lifecycleAgentAddress,
      {
        subGraphName: opts?.subGraphName,
        ...(opts?.preSignedAuthorAttestation
          ? {
              preSignedAuthorAttestation: {
                address: opts.preSignedAuthorAttestation.authorAddress,
                expectedMerkleRoot: opts.preSignedAuthorAttestation.expectedMerkleRoot,
                reservedKaId: opts.preSignedAuthorAttestation.reservedKaId,
                signature: opts.preSignedAuthorAttestation.signature,
              },
              schemeVersion: opts.preSignedAuthorAttestation.schemeVersion,
            }
          : {}),
        ...(opts?.authorAgentAddress
          ? { authorAgentAddress: opts.authorAgentAddress }
          : {}),
        ...(opts?.authorSignTypedData
          ? { authorSignTypedData: opts.authorSignTypedData }
          : {}),
      },
    );

    const gossipSigner = opts?.localOnly
      ? null
      : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    const confirmBeforeCommit = opts?.localOnly
      ? undefined
      : await this.buildCuratorAckConfirmer(contextGraphId, gossipSigner, {}, ctx);
    const onChainContextGraphId = await this.getContextGraphOnChainId(contextGraphId) ?? undefined;
    const trustedNonManifestCatalogTriples = await this.isPrivateContextGraph(contextGraphId)
      ? generatedPrivateCatalogTripleKeys(contextGraphId)
      : undefined;
    const promoted = await this.publisher.assertionPromote(
      contextGraphId,
      assertionName,
      lifecycleAgentAddress,
      {
        subGraphName: opts?.subGraphName,
        publisherPeerId: this.node.peerId.toString(),
        senderAgentAddress: gossipSigner?.agentAddress,
        localOnly: opts?.localOnly === true,
        accessPolicy,
        allowedPeers,
        trustedNonManifestCatalogTriples,
        onChainContextGraphId,
        confirmBeforeCommit,
      },
    );
    if (!promoted.shareOperationId) {
      throw new Error(`publishAsync did not produce an immutable SWM snapshot for ${assertionName}`);
    }
    if (!opts?.localOnly && promoted.gossipMessage) {
      await this.publishWorkspaceGossip(
        contextGraphId,
        promoted.gossipMessage,
        ctx,
        gossipSigner,
        promoted.shareOperationId,
      );
    }
    await this._stampSwmPointer(
      contextGraphId,
      assertionName,
      lifecycleAgentAddress,
      opts?.subGraphName,
    );

    const intent = await this.resolveFinalizedAssertionVmPublishIntent(
      contextGraphId,
      assertionName,
      {
        agentAddress: lifecycleAgentAddress,
        subGraphName: opts?.subGraphName,
        publishEpochs: opts?.publishEpochs,
        accessPolicy,
        allowedPeers,
        entityProofs: opts?.entityProofs,
        publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride,
      },
    );
    const asyncPublisher = new TripleStoreAsyncLiftPublisher(this.store, {
      publicSnapshotStore: this.publicSnapshotStore,
    });
    const captureID = await asyncPublisher.enqueueKnowledgeAssetVmPublish(intent);
    return { captureID };
  }

  async _publish(this: DKGAgent,
    contextGraphId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: PublishOpts,
  ): Promise<PublishResult> {
   return withSpan('agent.publish', async (span) => {
    const chainId = typeof this.chain?.chainId === 'string' && this.chain.chainId !== 'none' ? this.chain.chainId : undefined;
    const publishStartedAt = Date.now();
    // try/catch so a throw before the success metric (local publish / broadcast
    // / chain) is still counted — withSpan marks the span ERROR + rethrows; this
    // adds the matching publishTotal{outcome:'error'} so failures aren't invisible.
    try {
    span.setAttributes({
      'dkg.context_graph_id': contextGraphId,
      'dkg.triple_count': quads.length,
      'dkg.has_private': !!privateQuads && privateQuads.length > 0,
      ...(chainId ? { 'dkg.chain_id': chainId } : {}),
    });
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to context graph "${contextGraphId}" with ${quads.length} triples`);
    rejectOversizedRdfLiterals(quads, 'agent.publish.quads');
    rejectOversizedRdfLiterals(privateQuads, 'agent.publish.privateQuads');

    const isSystem = contextGraphId === SYSTEM_CONTEXT_GRAPHS.AGENTS || contextGraphId === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY;
    if (!isSystem && !this.subscribedContextGraphs.has(contextGraphId)) {
      const exists = await this.contextGraphExists(contextGraphId);
      if (!exists) {
        throw new Error(
          `Context graph "${contextGraphId}" does not exist. Create it first with createContextGraph().`,
        );
      }
    }
    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    const suppliedOnChainId = normalizeOptionalContextGraphId(opts?.onChainContextGraphId);
    let derivedOnChainId: string | undefined;
    try {
      derivedOnChainId = normalizeOptionalContextGraphId(await this.getContextGraphOnChainId(contextGraphId));
    } catch (err) {
      if (!suppliedOnChainId) throw err;
      this.log.warn(
        ctx,
        `Could not verify caller-supplied on-chain cgId ${suppliedOnChainId} for "${contextGraphId}" ` +
          `before publish policy resolution; treating it as an explicit target: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
    const onChainId = suppliedOnChainId ?? derivedOnChainId;
    const explicitPublishPolicyTarget = suppliedOnChainId && suppliedOnChainId !== derivedOnChainId
      ? suppliedOnChainId
      : undefined;
    const publishBindingOptions = onChainId
      ? { aeadBindingContextGraphId: onChainId }
      : undefined;

    // Every new on-chain KA uses the V2 atomic content model. Curated CGs
    // include their deterministic public catalog floor in that same asset;
    // the exact trust-key set is passed to the publisher for policy checks.
    const graphScopedDirectPublish = onChainId != null
      && this.chain.isV10Ready?.() === true
      && typeof this.chain.getEvmChainId === 'function'
      && typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function';
    const preparedCatalog = graphScopedDirectPublish
      && await this.isPrivateContextGraph(contextGraphId)
      ? replaceCatalogPartitionWithGeneratedPrivateFloor(contextGraphId, quads)
      : undefined;
    const publishQuads = preparedCatalog?.quads ?? quads;

    // RFC-001 §9.x — sign-at-creation. The publisher refuses on-chain
    // publishes without a `precomputedAttestation`, so the agent
    // mints one here at the publish boundary using the publisher
    // fallback signer (legacy `agent.publish(quads)` callers don't
    // carry author identity hints — mode (a) of Phase 4: daemon signs
    // as itself). The seal binds (chainId, kav10Address, merkleRoot,
    // authorAddress, reservedKaId) — it is CG-independent (#1116); the
    // CG is bound at publish via PublishParams.contextGraphId + the
    // separate ACK digest, and the author-namespaced one-shot
    // reservedKaId is the replay defense. Any drift between the
    // agent-computed merkleRoot and the publisher's recompute surfaces
    // as the publisher's `expectedMerkleRoot mismatch` guard. Skip when
    // the chain isn't V10-capable or the CG isn't on-chain — the
    // publisher will go tentative anyway.
    let precomputedAttestation: PublishOptions['precomputedAttestation'];
    if (
      onChainId != null &&
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
    ) {
      try {
        precomputedAttestation = await this._buildPrecomputedAttestationForSelection(
          contextGraphId,
          publishQuads,
          {
            targetOnChainCgId: onChainId,
            // Round 4 review §11 — propagate privateQuads so the
            // pre-seal merkle includes their per-entity private roots
            // (the publisher computes `kcMerkleRoot` over public
            // leaves + privateRoots; without this, every V10 publish
            // with private content silently downgrades to tentative on
            // the publisher's `expectedMerkleRoot` guard).
            privateQuads,
            graphScoped: graphScopedDirectPublish,
          },
        );
      } catch (err) {
        this.log.error(
          ctx,
          `Inline rootless seal preparation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
    }

    let graphScopeOptions: Pick<
      PublishOptions,
      | 'contentScopeVersion'
      | 'kaUal'
      | 'assertionVersion'
      | 'publicTripleCount'
      | 'privateMerkleRoot'
      | 'privateTripleCount'
    > = {};
    if (graphScopedDirectPublish) {
      if (!precomputedAttestation) {
        throw new Error('Rootless direct publish requires a precomputed author attestation');
      }
      const canonical = await skolemizeKnowledgeAssetParts(publishQuads, privateQuads ?? []);
      const privateMerkleRoot = computePrivateRoot(canonical.privateQuads);
      const authorAddress = ethers.getAddress(precomputedAttestation.authorAddress).toLowerCase();
      const reservedKaId = precomputedAttestation.reservedKaId;
      if ((reservedKaId >> 96n) !== BigInt(authorAddress)) {
        throw new Error(
          `Rootless direct publish reserved kaId ${reservedKaId} is outside author ${authorAddress}'s namespace`,
        );
      }
      const kaNumber = reservedKaId & ((1n << 96n) - 1n);
      graphScopeOptions = {
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: `did:dkg:${this.chain.chainId}/${authorAddress}/${kaNumber}`,
        assertionVersion: '1',
        publicTripleCount: canonical.publicQuads.length,
        ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
        privateTripleCount: canonical.privateQuads.length,
      };
    }

    // OT-RFC-38 / LU-5 — curated CG ACK payloads ship as AEAD ciphertext
    // (see _resolveEncryptInlinePayload jsdoc for the chainKey resolution).
    // Direct `publish()` (non-SWM path) needs the same protection — without
    // it cores would still see plaintext for curated direct-publish, which
    // defeats the point. PublishOpts here doesn't carry an explicit
    // authorAgentAddress, so we let _resolveEncryptInlinePayload fall back
    // to `defaultAgentAddress ?? peerId`.
    //
    // Codex PR #608 R2 #12 / GH #1309: keep policy target provenance
    // separate from the AEAD binding id. Agent-derived same-CG ids bind
    // AEAD to the canonical on-chain id without being treated as explicit
    // remaps; caller-supplied mismatches stay explicit policy targets.
    const encryptInlinePayload = await this._resolveEncryptInlinePayload(
      contextGraphId,
      opts?.subGraphName,
      undefined,
      explicitPublishPolicyTarget,
      publishBindingOptions,
    );
    // OT-RFC-38 LU-11 — also resolve the chunked emitter for curated
    // CGs. When set, the publisher prefers this path: chunks fan out
    // via SWM gossip and the V2 ACK carries only the commitment.
    // Public CGs resolve to `undefined` inside the chain-confirmed resolver.
    const encryptInlineChunked = await this._resolveEncryptInlineChunked(
      contextGraphId,
      opts?.subGraphName,
      undefined,
      explicitPublishPolicyTarget,
      publishBindingOptions,
    );

    const result = await this.publisher.publish({
      contextGraphId,
      quads: publishQuads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      subGraphName: opts?.subGraphName,
      operationCtx: ctx,
      onPhase,
      skipContextGraphEnsure: true,
      v10ACKProvider,
      publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride,
      publishContextGraphId: onChainId ?? undefined,
      publishEpochs: opts?.publishEpochs,
      precomputedAttestation,
      trustedNonManifestCatalogTriples:
        preparedCatalog?.trustedNonManifestCatalogTriples,
      ...graphScopeOptions,
      encryptInlinePayload,
      encryptInlineChunked,
    });

    span.setAttribute('dkg.publish_status', result.status);
    if (result.status === 'failed') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.addEvent('publish_failed', { error: String(result.contextGraphError ?? '') });
    }

    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(contextGraphId, result, ctx, {
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
    });
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kaId=${result.kaId}`);

    // refresh the private CG's public projection now the root
    // is committed. No-op unless configured; best-effort and error-isolated so
    // it can never affect the publish just completed.
    await this.emitPublicProjectionAfterPublish(contextGraphId, result, ctx);

    recordPublishOutcome(result.status, 'direct', publishStartedAt, chainId);

    return result;
    } catch (err) {
      recordPublishOutcome('error', 'direct', publishStartedAt, chainId);
      throw err;
    }
   });
  }

  /**
   * emit/refresh the public projection of a private CG once
   * its VM publish is confirmed on chain. Binds the private CG into the public
   * graph as a discoverable, verifiable node (floor: `a dkg:PrivateContextGraph`,
   * UAL, `dct:accessRights dkg:Private`, `dkg:committedRoot`) while disclosing
   * nothing beyond chain state (§5.9.1).
   *
   * No-op unless `publicProjectionContextGraphId` is configured; skips public
   * CGs (they are their own public face, handled inside `emitPublicProjection`)
   * and the discovery CG itself (recursion guard). Fully error-isolated — a
   * projection failure logs and returns, never affecting the triggering publish.
   */
  async emitPublicProjectionAfterPublish(
    this: DKGAgent,
    contextGraphId: string,
    result: PublishResult,
    ctx: OperationContext,
  ): Promise<void> {
    try {
      const target = this.config.publicProjectionContextGraphId;
      // Off unless configured; never project the discovery CG into itself.
      if (!target || contextGraphId === target) return;
      // Only a confirmed publish has a real on-chain committed root.
      if (result.status !== 'confirmed' || result.merkleRoot.length !== 32) return;
      const committedRoot = `0x${Buffer.from(result.merkleRoot).toString('hex')}`;

      await emitPublicProjection(
        {
          isPrivateContextGraph: (id) => this.isPrivateContextGraph(id),
          // B7 — the catalog subject is the context-graph DID
          // (`did:dkg:context-graph:<id>`), NOT the knowledge-asset UAL
          // (`result.ual`). Resolving from the CG id makes every publish refresh
          // the SAME catalog entry (one stable subject per CG) that open-serve
          // and the in-finalize injection also key off.
          resolveUal: async (id) => contextGraphDataUri(id),
          // B8 — persist the projection under the SOURCE CG's `_catalog` graph
          // (`<source-cg>/_catalog`), the exact graph open-serve reads via
          // `contextGraphCatalogUri`. The previous TARGET-CG data graph left
          // outsiders with an empty `<source-cg>/_catalog`.
          projectionGraph: (id) => contextGraphCatalogUri(id),
          // buildPublicProjection already stamps each quad's graph from
          // `projectionGraph` (the source `_catalog`), so the insert lands them
          // in the right named graph — matching the canonical publisher catalog
          // persist (dkg-publisher.ts persistCatalogEntry).
          //
          // R8 — CLEAR/REPLACE, not append. `committedRoot` changes every
          // publish, so a bare insert accumulates multiple `dkg:committedRoot`
          // (and floor) triples for the SAME catalog subject (the CG DID) in
          // `<source-cg>/_catalog`, leaving open-serve unable to tell which root
          // is current. Mirror `persistCatalogEntry`: purge the prior rows for
          // each catalog subject in this graph before inserting the refreshed
          // entry. `graph` is the callback's third arg (= `contextGraphCatalogUri(id)`,
          // emitPublicProjection line 225), so delete-graph === insert-graph by
          // construction; subjects derive from the quads (one stable CG DID),
          // deleting exactly what we replace. Then invalidate the projection
          // cache so a cached CG record picks up the new committed root — the
          // floor predicates (rdf:type / dct:accessRights) are in
          // CATALOG_META_PREDICATES, so this dirties the right entry.
          publishProjection: async (_id, quads, graph) => {
            const subjects = new Set(quads.map((q) => q.subject));
            for (const subject of subjects) {
              await this.store.deleteByPattern({ graph, subject });
            }
            await this.store.insert(quads);
            this.contextGraphMetaProjection.markDirtyFromQuads(quads);
          },
          log: (level, message) =>
            level === 'warn' ? this.log.warn(ctx, message) : this.log.info(ctx, message),
        },
        contextGraphId,
        committedRoot,
      );
    } catch (err) {
      // Defense-in-depth: emitPublicProjection already isolates its own errors,
      // but a bug in target/root resolution must never break a good publish.
      this.log.warn(ctx, `public projection skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async update(this: DKGAgent,
    kaId: bigint, contextGraphId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: {
      onPhase?: PhaseCallback;
      operationCtx?: OperationContext;
      precomputedUpdateAttestation?: PublishOptions['precomputedUpdateAttestation'];
      publisherOverride?: DKGPublisher;
      subGraphName?: string;
      contentScopeVersion?: PublishOptions['contentScopeVersion'];
      kaUal?: PublishOptions['kaUal'];
      assertionVersion?: PublishOptions['assertionVersion'];
      publicTripleCount?: PublishOptions['publicTripleCount'];
      privateMerkleRoot?: PublishOptions['privateMerkleRoot'];
      privateTripleCount?: PublishOptions['privateTripleCount'];
    },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kaId=${kaId} in context graph "${contextGraphId}" with ${quads.length} triples`);
    rejectOversizedRdfLiterals(quads, 'agent.update.quads');
    rejectOversizedRdfLiterals(privateQuads, 'agent.update.privateQuads');
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

    // OT-RFC-49 / WS-D — curated-UPDATE discrimination + floor re-projection.
    // A1: resolve the single-blob curated AEAD hook the SAME way the publish
    // path does (dkg-agent-publish.ts:1257 _resolveEncryptInlinePayload). The
    // resolver returns a function for a curated CG (accessPolicy=curated) and
    // `undefined` for a public CG, so the function's truthiness IS the curated
    // gate — exactly what the producer keys `useEncryptedInlineUpdate` off of.
    // No separate accessPolicy read is needed. The 4th arg mirrors publish: the
    // target on-chain cgId is now binding-only so the AEAD key derives from
    // the canonical id consumers verify against without reclassifying the
    // same-CG update as an explicit remap.
    const updateEncryptInlinePayload = await this._resolveEncryptInlinePayload(
      contextGraphId,
      opts?.subGraphName,
      undefined,
      undefined,
      updateOnChainId
        ? { aeadBindingContextGraphId: updateOnChainId }
        : undefined,
    );
    const isCuratedUpdate = typeof updateEncryptInlinePayload === 'function';

    // ALSO resolve the chunked SWM emitter — the MEMBER-DISTRIBUTION path. A
    // curated update must actively fan the updated private payload out to CG
    // members (OT-RFC-49: cores hold zero ciphertext, members hold it), exactly
    // as curated publish does — otherwise members silently fall behind a
    // committed update. The producer prefers this side-effecting chunked emitter
    // over the pure single-blob hook. Like publish, it THROWS for a curated CG
    // with no workspace-gossip signer (cores reject unsigned chunked envelopes):
    // fail-closed — you cannot update a curated CG you cannot distribute to
    // members. Public CGs → `undefined` (no-op), unchanged.
    const updateEncryptInlineChunked = isCuratedUpdate
      ? await this._resolveEncryptInlineChunked(
          contextGraphId,
          opts?.subGraphName,
          undefined,
          undefined,
          updateOnChainId
            ? { aeadBindingContextGraphId: updateOnChainId }
            : undefined,
        )
      : undefined;

    // A2: USER DECISION (a) — deterministic floor RE-PROJECTION (not read-and-
    // merge). For a curated update, the public `_catalog` floor MUST be in the
    // quads handed to the publisher so `partitionCatalogQuads` can lift it back
    // out, commit a non-zero `newCatalogRoot`, and satisfy the on-chain
    // `CuratedCGRequiresCatalogCommitment` gate — even for a metadata-only
    // update (Open Decision #2: every curated update re-commits the floor).
    // The update analogue of `_ensureCuratedCatalogInSwm`: route through the
    // SAME publisher-boundary preparation helper so the generated quads and
    // exact trust allow-list are byte-identical across publish and update.
    // STRIP-THEN-APPEND: drop any catalog quads the caller's
    // payload already carries (the from-SWM `publishFromFinalizedAssertion`
    // path at 3213 can re-load a previously-injected floor) so the floor is
    // never duplicated, then append exactly the fresh projection. The graph
    // is cosmetic — `partitionCatalogQuads` matches on subject (the CG DID)
    // and the catalog root excludes the graph term — so we stamp the canonical
    // CG-DID data graph for clarity. Public updates skip this block entirely (no
    // floor, no hook) and are unchanged on a HEALTHY chain. NB: update() now
    // resolves the access policy unconditionally (~:1442), exactly as the publish
    // path always has — so under a DEGRADED / stale policy probe a public update
    // fails closed (throws) consistently with publish, where the OLD update path
    // would have proceeded. Fail-closed, never a leak; see PR #1208 notes.
    const preparedUpdateCatalog = isCuratedUpdate && updateOnChainId != null
      ? replaceCatalogPartitionWithGeneratedPrivateFloor(
          contextGraphId,
          quads,
          contextGraphDataUri(contextGraphId),
        )
      : undefined;
    const updateQuads = preparedUpdateCatalog?.quads ?? quads;

    const publisher = opts?.publisherOverride ?? this.publisher;
    const publisherUpdateOptions = {
      contextGraphId,
      privateQuads,
      publisherPeerId: this.node.peerId.toString(),
      publishContextGraphId: updateOnChainId ?? undefined,
      operationCtx: ctx,
      onPhase,
      subGraphName: opts?.subGraphName,
      precomputedUpdateAttestation: opts?.precomputedUpdateAttestation,
      contentScopeVersion: opts?.contentScopeVersion,
      kaUal: opts?.kaUal,
      assertionVersion: opts?.assertionVersion,
      publicTripleCount: opts?.publicTripleCount,
      privateMerkleRoot: opts?.privateMerkleRoot,
      privateTripleCount: opts?.privateTripleCount,
      trustedNonManifestCatalogTriples:
        preparedUpdateCatalog?.trustedNonManifestCatalogTriples,
      v10UpdateACKProvider,
      // Curated → wire the single-blob AEAD hook so the producer's
      // `useEncryptedInlineUpdate` gate fires (catalog commit). Public →
      // `undefined` (no catalog); unchanged on a healthy chain.
      encryptInlinePayload: updateEncryptInlinePayload,
      // Curated → the chunked emitter the producer prefers to fan the updated
      // private payload out to CG members (member distribution). Public → undefined.
      encryptInlineChunked: updateEncryptInlineChunked,
    };
    const result = opts?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
      ? await publisher.updateKnowledgeAssetFromSharedMemory(kaId, publisherUpdateOptions)
      : await publisher.update(kaId, { ...publisherUpdateOptions, quads: updateQuads });
    this.log.info(ctx, `Update complete — status=${result.status}`);

    onPhase?.('broadcast', 'start');
    if (result.onChainResult && result.publicQuads) {
      try {
        const isGraphUpdate = opts?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION;
        const graphScope = isGraphUpdate
          ? createGraphKnowledgeAssetScope(opts?.kaUal ?? '', opts?.assertionVersion ?? '')
          : undefined;
        const dataGraph = graphScope
          ? knowledgeAssetLayerGraphUri(
              contextGraphId,
              MemoryLayer.VerifiableMemory,
              graphScope,
              opts?.subGraphName,
            )
          : `did:dkg:context-graph:${contextGraphId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          contextGraphId: contextGraphId,
          batchId: kaId,
          nquads: nquadsBytes,
          manifest: graphScope
            ? []
            : result.kaManifest.map((m) => ({
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
          ...(graphScope
            ? {
                contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
                kaUal: graphScope.ual,
                assertionVersion: graphScope.assertionVersion,
                publicTripleCount: opts?.publicTripleCount ?? 0,
                ...(opts?.privateMerkleRoot
                  ? { privateMerkleRoot: opts.privateMerkleRoot }
                  : {}),
                privateTripleCount: opts?.privateTripleCount ?? 0,
                subGraphName: opts?.subGraphName,
              }
            : {}),
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
  async share(this: DKGAgent, contextGraphId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string; awaitCuratorAck?: boolean; curatorAckTimeoutMs?: number }): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `Sharing ${quads.length} quads to SWM for context graph ${contextGraphId}${sgLabel}${opts?.localOnly ? ' (local-only)' : ''}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);

    // Strict curator-ack gate (OT-RFC-49 curator-leader): require the curator's
    // applied-ack BEFORE the local commit for a gated private-CG write (see
    // buildCuratorAckConfirmer). Undefined → legacy best-effort path.
    const confirmBeforeCommit = await this.buildCuratorAckConfirmer(contextGraphId, gossipSigner, opts, ctx);

    const { shareOperationId, message } = await this.publisher.writeToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
      confirmBeforeCommit,
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
      // (When the curator-ack gate confirmed above, the curator already
      // holds this write; the fan-out here is the cross-version safety net
      // + propagation to the OTHER members. A redundant curator delivery is
      // idempotent — swm.redundantApplies.)
      await this.publishWorkspaceGossip(contextGraphId, message, ctx, gossipSigner, shareOperationId);
    }
    return { shareOperationId };
  }

  /**
   * Build the strict curator-ack gate's `confirmBeforeCommit` callback for a
   * private-CG SWM write (OT-RFC-49 curator-leader), or `undefined` when the gate
   * does not apply. The callback runs inside the publisher's `_shareImpl`, under
   * the per-CG write lock, between message-build and the first store mutation —
   * so the lock is held across the curator round-trip (writes serialize through
   * the curator) and a non-confirmation aborts the write with zero local state.
   *
   * Returns `undefined` (legacy best-effort path, no gate) when: the write is
   * `localOnly`; the gate is off (per-call `awaitCuratorAck` ?? config
   * `swmAwaitCuratorAck` ?? false); the CG is public; or this node IS the curator
   * (its own commit is authoritative — a curator never confirms with itself).
   * Shared by `share()`, `conditionalShare()`, and the WM→SWM `promote()` path
   * (all flow through the publisher's `confirmBeforeCommit` seam). Public because
   * the mixin-split `promote()` lives in a different class (cf. publishWorkspaceGossip).
   */
  async buildCuratorAckConfirmer(this: DKGAgent,
    contextGraphId: string,
    gossipSigner: Parameters<DKGAgent['encodeWorkspaceGossipMessage']>[2],
    opts: { localOnly?: boolean; awaitCuratorAck?: boolean; curatorAckTimeoutMs?: number } | undefined,
    ctx: OperationContext,
  ): Promise<((message: Uint8Array) => Promise<{ applied: boolean; rejected?: boolean }>) | undefined> {
    const wantCuratorAck = !opts?.localOnly
      && (opts?.awaitCuratorAck ?? this.config.swmAwaitCuratorAck ?? false);
    if (!wantCuratorAck) return undefined;
    if (!(await this.isPrivateContextGraph(contextGraphId))) return undefined;
    const curator = await this.resolveCuratorPeerIdsForCg(contextGraphId);
    if (curator.curatorIsLocal) return undefined;
    const timeoutMs = opts?.curatorAckTimeoutMs ?? DKGAgentBase.SWM_CURATOR_ACK_TIMEOUT_MS;
    return async (message: Uint8Array) => {
      // The publisher hands us the INNER workspace payload. The curator's
      // PROTOCOL_SWM_UPDATE handler expects the SAME signed gossip-message
      // envelope the substrate fan-out sends (encodeWorkspaceGossipMessage),
      // NOT the raw inner bytes — sending the inner bytes fails protobuf decode
      // on the receiver (a permanent rejection). Encode identically.
      const wireMessage = await this.encodeWorkspaceGossipMessage(contextGraphId, message, gossipSigner);
      return this.confirmCuratorApplied(contextGraphId, curator.peerIds, wireMessage, timeoutMs, ctx);
    };
  }

  /**
   * STRICT curator-ack confirmer for a gated SWM write (OT-RFC-49 curator-leader).
   * Reliably delivers the exact wire `message` to the curator's peer(s) and waits
   * for an applied-ack. Returns `{ applied: true }` ONLY on a `delivered` (empty)
   * reply — which the receiver returns ONLY after it persisted the write
   * (`handleSwmUpdate`: empty reply ⇔ `outcome.applied`). `{ applied: false,
   * rejected: true }` on the 0x01 permanent-rejection sentinel; `{ applied: false }`
   * for an unresolved curator, a timeout, a transient (0x02) rejection, or a send
   * throw — every "not definitely applied" case fails CLOSED so the publisher
   * aborts the write with no local persistence. A `delivered` from ANY advertised
   * curator peer wins (the write landed); rejection only when no peer applied it.
   */
  private async confirmCuratorApplied(this: DKGAgent,
    contextGraphId: string,
    curatorPeerIds: string[],
    message: Uint8Array,
    timeoutMs: number,
    ctx: OperationContext,
  ): Promise<{ applied: boolean; rejected?: boolean }> {
    if (curatorPeerIds.length === 0) {
      this.log.info(ctx, `SWM curator-ack: curator peer unresolved for "${contextGraphId.slice(0, 28)}" — write cannot be confirmed (fail-closed)`);
      return { applied: false };
    }
    let sawRejection = false;
    for (const peerId of curatorPeerIds) {
      try {
        const sendResult = await this.messenger.sendReliable(peerId, PROTOCOL_SWM_UPDATE, message, {
          messageId: `swm-curator-confirm-${ctx.operationId}-${peerId.slice(0, 8)}`,
          timeoutMs,
        });
        const classified = classifySendResult(peerId, sendResult);
        if (classified.outcome === 'delivered') {
          return { applied: true };
        }
        if (classified.outcome === 'rejected') {
          // Permanent refusal from a curator peer (allowlist / signature /
          // validation). Keep trying the curator's other advertised peers in
          // case this one is stale/wrong, but remember it for the verdict.
          sawRejection = true;
        }
        // retryable / failed / queued / inFlight → not confirmed; try next peer.
      } catch (err) {
        this.log.debug(ctx, `SWM curator-ack: send to ${peerId.slice(0, 12)} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return sawRejection ? { applied: false, rejected: true } : { applied: false };
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
    opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string; callerAgentAddress?: string; awaitCuratorAck?: boolean; curatorAckTimeoutMs?: number },
  ): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${contextGraphId}${sgLabel}`);
    const shouldCreateImplicitContextGraph = await this.shouldCreateImplicitSharedMemoryContextGraph(contextGraphId);
    const gossipSigner = opts?.localOnly ? null : await this.resolveWorkspaceGossipSigningAgent(contextGraphId);
    // Strict curator-ack gate — same seam as share() (both flow through _shareImpl).
    const confirmBeforeCommit = await this.buildCuratorAckConfirmer(contextGraphId, gossipSigner, opts, ctx);
    const { shareOperationId, message } = await this.publisher.writeConditionalToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
      subGraphName: opts?.subGraphName,
      localOnly: opts?.localOnly,
      senderAgentAddress: gossipSigner?.agentAddress,
      confirmBeforeCommit,
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
    this.contextGraphMetaProjection.markDirtyFromQuads(quads);
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
   * Prepare the only valid graph-scoped share mode. Mutable WM content is
   * finalized here; a draft-free retry is left untouched for assertionPromote
   * to validate against its durable exact SWM/VM state.
   */
  async prepareAtomicAssertionShare(
    this: DKGAgent,
    contextGraphId: string,
    name: string,
    agentAddress: string,
    opts?: {
      subGraphName?: string;
      authorAgentAddress?: string;
      preSignedAuthorAttestation?: PreSignedAuthorAttestation;
    },
  ): Promise<void> {
    const [publicDraft, privateDraft] = await Promise.all([
      this.publisher.assertionQuery(
        contextGraphId,
        name,
        agentAddress,
        opts?.subGraphName,
      ),
      this.publisher.assertionQueryPrivate(
        contextGraphId,
        name,
        agentAddress,
        opts?.subGraphName,
      ),
    ]);
    if (publicDraft.length === 0 && privateDraft.length === 0) return;
    await this.assertionFinalize(contextGraphId, name, agentAddress, opts);
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
      authorSignTypedData?: (
        typedData: AuthorAttestationTypedData,
      ) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
      schemeVersion?: number;
    },
  ): Promise<{
    assertionUri: string;
    merkleRoot: Uint8Array;
    authorAddress: string;
    /** Internal lifecycle identity used by seal-in-SWM migration. */
    reservedKaId: bigint;
    /** Internal exact payload boundary used by seal-in-SWM migration. */
    rootEntities: string[];
    contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
    kaUal: string;
    assertionVersion: string;
    publicTripleCount: number;
    privateMerkleRoot?: Uint8Array;
    privateTripleCount: number;
    schemeVersion: number;
    chainId: bigint;
    kav10Address: string;
    eip712Digest: string;
  }> {
    if (
      opts?.preSignedAuthorAttestation != null
      && (opts.authorAgentAddress != null || opts.authorSignTypedData != null)
    ) {
      throw new Error(
        'assertionFinalize: preSignedAuthorAttestation is mutually exclusive with authorAgentAddress / authorSignTypedData',
      );
    }
    if (opts?.authorSignTypedData != null && opts.authorAgentAddress == null) {
      throw new Error('assertionFinalize: authorSignTypedData requires authorAgentAddress');
    }

    // 1. Resolve URIs.
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleUri = assertionLifecycleUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const sourceWmGraphUri = await this.publisher.wmGraphUri(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );
    const xsdInteger = '<http://www.w3.org/2001/XMLSchema#integer>';
    const stampFinalizedLifecycle = async (
      assertionVersion: string | bigint,
      finalizedMerkleRoot: Uint8Array,
    ): Promise<void> => {
      // Keep the v2 mutation gate present throughout recovery. The assertion
      // version may need replacement, but a failure after its delete is safe:
      // the durable seal is written first and an idempotent finalize retry
      // repairs this row before returning.
      await this.store.deleteByPattern({
        graph: metaGraph,
        subject: lifecycleUri,
        predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
      });
      await this.store.insert([
        {
          subject: lifecycleUri,
          predicate: ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION,
          object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^${xsdInteger}`,
          graph: metaGraph,
        },
        {
          subject: lifecycleUri,
          predicate: ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION,
          object: `"${assertionVersion}"^^${xsdInteger}`,
          graph: metaGraph,
        },
      ]);
      const merkleHexBare = ethers.hexlify(finalizedMerkleRoot).slice(2);
      await this._stampPointerIfDivergedFromVm(
        lifecycleUri,
        WM_CURRENT_ASSERTION_PRED,
        merkleHexBare,
        metaGraph,
      );
    };

    // Read any durable seal before loading the private partition. A completed
    // finalize removes the mutable private draft, so an idempotent retry must
    // recover that partition from the immutable `(UAL, assertionVersion)` graph.
    const existingMetaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const existingMetaQuads =
      existingMetaResult.type === 'quads' ? existingMetaResult.quads : [];
    let existingSeal: AssertionSeal | undefined;
    try {
      existingSeal = parseAssertionSealQuads(existingMetaQuads, assertionUri);
    } catch (err) {
      throw new Error(
        `assertionFinalize: existing _meta seal for <${assertionUri}> is corrupt: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const privateStore = new PrivateContentStore(this.store, new GraphManager(this.store));

    // 2. Pull the assertion's quads. Refuse to finalize an empty
    //    assertion — there's nothing to commit. The public DCAT catalog entry
    //    for a private CG is injected ONLY AFTER this validation (below), so a
    //    catalog-only assertion (zero user-authored quads) is correctly
    //    rejected here rather than slipping through on the catalog quad alone.
    const rawQuads = await this.publisher.assertionQuery(
      contextGraphId,
      name,
      agentAddress,
      opts?.subGraphName,
    );
    let rawPrivateQuads = await this.publisher.assertionQueryPrivate(
      contextGraphId,
      name,
      agentAddress,
      opts?.subGraphName,
    );
    if (
      rawPrivateQuads.length === 0
      && existingSeal?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
      && existingSeal.kaUal !== undefined
      && existingSeal.assertionVersion !== undefined
      && (existingSeal.privateTripleCount ?? 0) > 0
    ) {
      rawPrivateQuads = await privateStore.getKnowledgeAssetPrivateTriples(
        contextGraphId,
        createGraphKnowledgeAssetScope(existingSeal.kaUal, existingSeal.assertionVersion),
        opts?.subGraphName,
      );
    }
    if (rawQuads.length === 0 && rawPrivateQuads.length === 0) {
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
    const userQuads = rawQuads.filter((q) => !isReservedSubject(q.subject) && !isTrustLevelQuad(q));
    const userPrivateQuads = rawPrivateQuads.filter(
      (q) => !isReservedSubject(q.subject) && !isTrustLevelQuad(q),
    );
    if (userQuads.length === 0 && userPrivateQuads.length === 0) {
      throw new Error(
        `Cannot finalize assertion <${assertionUri}>: every quad has a ` +
          `reserved-namespace subject (urn:dkg:file:* / urn:dkg:extraction:*) ` +
          `which is filtered out before SWM. Add at least one user-authored ` +
          `public or private quad on a non-reserved subject before finalizing.`,
      );
    }

    // Finalization is the first irreversible boundary: canonicalization below
    // intentionally reduces the submitted RDF dataset to its atomic triple set.
    // Reject payload-level named graphs before that reduction, otherwise equal
    // SPOs in different graphs could collapse and the later promote guard would
    // only see the already-flattened canonical WM graph. Check both partitions;
    // private draft quads preserve their graph terms too.
    assertNoKnowledgeAssetPayloadNamedGraphs(userQuads, userPrivateQuads);

    // B6 — inject the public DCAT catalog entry for a PRIVATE CG ONLY AFTER the
    // "≥1 real user-authored quad" contract has been validated against
    // `userQuads` above, so a catalog-only assertion can never finalize.
    // The entry rides in the CG's OWN merkle root as a public KA whose subject
    // is the context-graph DID (`contextGraphDataUri(contextGraphId)` ===
    // `did:dkg:context-graph:<contextGraphId>`), the SAME subject open-serve
    // reads from `<source-cg>/_catalog`. Persisted to the WM graph so
    // promote/reload carry it; the publish-path partition keeps it out of the
    // ciphertext and routes it to the public `_catalog` sink. The catalog quads
    // are appended to `quads` (the merkle input) so the root the seal commits
    // matches the root the publisher recomputes after reloading WM (which then
    // includes the catalog) — the leaf hash is over (subject, predicate, object)
    // only, so the placeholder `graph` here does not affect the root.
    // Idempotent across re-finalize: identical quads dedupe in the WM store.
    const quads = [...userQuads];
    const trustedGeneratedCatalogTriples = (await this.isPrivateContextGraph(contextGraphId))
      ? generatedPrivateCatalogTripleKeys(contextGraphId)
      : undefined;
    if (trustedGeneratedCatalogTriples) {
      const cgDid = contextGraphDataUri(contextGraphId);
      const catalogQuads = buildPrivateCatalogDefaultGraphQuads(cgDid, assertionUri);
      await this.publisher.assertionWrite(contextGraphId, name, agentAddress, catalogQuads, opts?.subGraphName);
      quads.push(...catalogQuads);
    }

    // 3. Canonicalize the COMPLETE RDF set once at KA scope. Subjects are data,
    // not partitions: 1,000 distinct subjects still produce one asset, one
    // Merkle tree, and (downstream) one graph operation. The linear skolemizer
    // also permits a valid all-blank-node component, which the root-based model
    // could not represent.
    const normalizedParts = await skolemizeKnowledgeAssetParts(quads, userPrivateQuads, {
      // The first finalize sees user data already checked at assertionWrite;
      // an interrupted retry can see our own canonical WM target. Accept only
      // exact c14nN terms here, never arbitrary names in the reserved prefix.
      allowCanonicalSkolemTerms: true,
    });
    const normalizedKnowledgeAssetQuads = normalizedParts.publicQuads;
    const normalizedPrivateKnowledgeAssetQuads = normalizedParts.privateQuads;
    const privateMerkleRoot = computePrivateRoot(normalizedPrivateKnowledgeAssetQuads);
    const privateTripleCount = normalizedPrivateKnowledgeAssetQuads.length;
    const merkleRoot = computeFlatKCRoot(
      normalizedKnowledgeAssetQuads,
      privateMerkleRoot ? [privateMerkleRoot] : [],
    );
    const publicTripleCount = normalizedKnowledgeAssetQuads.length;
    const callerExpectedMerkleRoot = opts?.preSignedAuthorAttestation?.expectedMerkleRoot;
    if (
      callerExpectedMerkleRoot !== undefined
      && (
        callerExpectedMerkleRoot.length !== merkleRoot.length
        || !callerExpectedMerkleRoot.every((byte, index) => byte === merkleRoot[index])
      )
    ) {
      throw new Error(
        `assertionFinalize: preSignedAuthorAttestation expectedMerkleRoot mismatch — ` +
          `caller=${ethers.hexlify(callerExpectedMerkleRoot)}, ` +
          `canonical=${ethers.hexlify(merkleRoot)}.`,
      );
    }

    // 4. Idempotency: if a seal already exists for this assertion,
    //    return it as-is when the merkleRoot matches. Mismatch means
    //    the assertion was mutated since the previous finalize —
    //    refuse to overwrite silently.
    if (existingSeal) {
      if (existingSeal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
        throw new LegacyKnowledgeAssetReadOnlyError();
      }
      if (
        !existingSeal.kaUal ||
        !existingSeal.assertionVersion ||
        existingSeal.publicTripleCount === undefined ||
        existingSeal.privateTripleCount === undefined
      ) {
        throw new Error(`Graph-scoped assertion seal for <${assertionUri}> is incomplete`);
      }
      const existingPrivateRoot = existingSeal.privateMerkleRoot;
      const privateRootMatches =
        existingPrivateRoot === undefined
          ? privateMerkleRoot === undefined
          : privateMerkleRoot !== undefined
            && existingPrivateRoot.length === privateMerkleRoot.length
            && existingPrivateRoot.every((byte, index) => byte === privateMerkleRoot[index]);
      if (
        existingSeal.publicTripleCount !== publicTripleCount
        || existingSeal.privateTripleCount !== privateTripleCount
        || !privateRootMatches
      ) {
        throw new Error(
          `assertionFinalize: assertion <${assertionUri}> private/public partition differs from its existing seal`,
        );
      }
      if (
        existingSeal.merkleRoot.length !== merkleRoot.length ||
        !existingSeal.merkleRoot.every((b, i) => b === merkleRoot[i])
      ) {
        throw new Error(
          `assertionFinalize: assertion <${assertionUri}> is already finalized with a ` +
            `different merkleRoot (existing=${ethers.hexlify(existingSeal.merkleRoot)}, ` +
            `current=${ethers.hexlify(merkleRoot)}). In-place mutation of a finalized assertion ` +
            `breaks the author signature and is rejected. To edit already-shared/published ` +
            `content, start a sanctioned edit loop with POST /api/knowledge-assets/{name}/wm/pull-from ` +
            `(which re-opens a fresh draft and clears the stale seal), or discard and re-create the assertion.`,
        );
      }
      // Seal exists and matches — return the existing record. The rebuilt digest
      // must bind the SAME reservedKaId the original signature committed to
      // (§F2): prefer the value persisted on the seal; for a seal that predates
      // the binding, repack from the lifecycle-URN kaId stamp.
      let reReservedKaId = existingSeal.reservedKaId;
      if (reReservedKaId === undefined) {
        const reKaIdRes = await this.store.query(
          `SELECT ?n WHERE { GRAPH <${metaGraph}> { <${assertionLifecycleUri(contextGraphId, agentAddress, name, opts?.subGraphName)}> <${KA_ID_PRED}> ?n } } LIMIT 1`,
        );
        const reNum =
          reKaIdRes.type === 'bindings' && reKaIdRes.bindings[0]?.['n'] !== undefined
            ? BigInt(String(reKaIdRes.bindings[0]['n']).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim())
            : 0n;
        reReservedKaId = (BigInt(ethers.getAddress(existingSeal.authorAddress)) << 96n) | reNum;
      }
      const typedData = buildAuthorAttestationTypedData({
        chainId: existingSeal.chainId,
        kav10Address: existingSeal.kav10Address,
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        reservedKaId: reReservedKaId,
        schemeVersion: existingSeal.authorSchemeVersion,
      });
      // A prior attempt may have stopped after the target swap, after the seal,
      // or before source cleanup. Re-materialize and repair in that order so an
      // idempotent finalize always converges to one exact canonical WM graph.
      const canonicalWmGraphUri = await this.publisher.materializeCanonicalWorkingMemory(
        contextGraphId,
        existingSeal.kaUal,
        existingSeal.assertionVersion,
        normalizedKnowledgeAssetQuads,
        opts?.subGraphName,
      );
      const existingScope = createGraphKnowledgeAssetScope(
        existingSeal.kaUal,
        existingSeal.assertionVersion,
      );
      await privateStore.replaceKnowledgeAssetPrivateTriples(
        contextGraphId,
        existingScope,
        normalizedPrivateKnowledgeAssetQuads,
        opts?.subGraphName,
      );
      await stampFinalizedLifecycle(
        existingSeal.assertionVersion,
        existingSeal.merkleRoot,
      );
      await this.publisher.cleanupCanonicalWorkingMemorySources(
        contextGraphId,
        name,
        agentAddress,
        canonicalWmGraphUri,
        [sourceWmGraphUri],
        opts?.subGraphName,
      );
      await privateStore.deleteKnowledgeAssetPrivateDraft(
        contextGraphId,
        agentAddress,
        name,
        opts?.subGraphName,
      );
      return {
        assertionUri,
        merkleRoot: existingSeal.merkleRoot,
        authorAddress: existingSeal.authorAddress,
        reservedKaId: reReservedKaId,
        rootEntities: [],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: existingSeal.kaUal,
        assertionVersion: existingSeal.assertionVersion,
        publicTripleCount: existingSeal.publicTripleCount,
        ...(existingSeal.privateMerkleRoot !== undefined
          ? { privateMerkleRoot: existingSeal.privateMerkleRoot }
          : {}),
        privateTripleCount: existingSeal.privateTripleCount,
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
      // #1116 (round 11) — CAPABILITY GAP (non-V10 chain adapter). Tagged with a
      // stable code so seal-before-share can distinguish a recoverable capability
      // gap (→ UNSEALED_SHARE_BLOCKED) from a validation
      // error (which must propagate). See SEAL_CAPABILITY_GAP_CODE.
      throw Object.assign(
        new Error(
          'assertionFinalize requires a V10-capable chain adapter that exposes ' +
            'getEvmChainId() and getKnowledgeAssetsLifecycleAddress(); the current adapter does not.',
        ),
        { code: SEAL_CAPABILITY_GAP_CODE },
      );
    }
    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsLifecycleAddress();

    // 6. (removed, #1116) The seal is now context-graph-independent: the
    //    EIP-712 AuthorAttestation no longer binds the on-chain CG id, so
    //    finalize works on an UNREGISTERED CG and performs no chain write /
    //    registration. CG binding happens at publish time (the contract's
    //    PublishParams.contextGraphId + the separate ACK digest).

    // 7. Resolve author. preSigned > custodial agent > publisher fallback.
    const schemeVersion = opts?.schemeVersion ?? AUTHOR_SCHEME_VERSION_V1;
    let authorAddress: string;
    let signerPrivateKey: string | undefined;
    let preSigned: PreSignedAuthorAttestation | undefined;
    if (opts?.preSignedAuthorAttestation != null) {
      preSigned = opts.preSignedAuthorAttestation;
      authorAddress = preSigned.address;
    } else if (opts?.authorSignTypedData != null) {
      // Self-sovereign callback: the daemon builds the exact typed data after
      // canonicalization and allocation, while the caller retains its key.
      authorAddress = ethers.getAddress(opts.authorAgentAddress!);
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
        // #1116 (round 11) — CAPABILITY GAP (no local signing key for this agent).
        throw Object.assign(
          new Error(
            `assertionFinalize: custodial agent ${opts.authorAgentAddress} has no private key on file`,
          ),
          { code: SEAL_CAPABILITY_GAP_CODE },
        );
      }
      authorAddress = opts.authorAgentAddress;
    } else {
      // Publisher-wallet fallback: use the daemon's own publisher EOA
      // as the author. This preserves Phase 4 mode (a) — node admin
      // signs on its own behalf when no agent attribution is supplied.
      const fallbackAddress = await this.publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress) {
        // #1116 (round 11) — CAPABILITY GAP (no publisher signer configured).
        throw Object.assign(
          new Error(
            'assertionFinalize: no agent override supplied and no publisher signer is available. ' +
              'Either supply authorAgentAddress / preSignedAuthorAttestation, or configure a publisher private key on the daemon.',
          ),
          { code: SEAL_CAPABILITY_GAP_CODE },
        );
      }
      authorAddress = fallbackAddress;
    }

    // ── OT-RFC-43 §F2 — resolve the reserved kaId BEFORE signing ──
    // The AuthorAttestation digest now binds reservedKaId, so the packed id must
    // be known before buildAuthorAttestationTypedData. This is the SINGLE
    // allocation point (publishFromFinalizedAssertion REUSES it). Rules:
    //   • preSigned author → honour the slot they signed over (no allocation);
    //   • update of a previously-stamped name → reuse the stable existing number;
    //   • fresh create with an allocator → reconcile-once then allocate ONE number;
    //   • no allocator → 0n (non-Option-1; the on-chain namespace check rejects).
    const lifecycleScopeResult = await this.store.query(
      `SELECT ?scope ?version ?vm WHERE { GRAPH <${metaGraph}> {
        OPTIONAL { <${lifecycleUri}> <${ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION}> ?scope }
        OPTIONAL { <${lifecycleUri}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION}> ?version }
        OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
      } } LIMIT 1`,
    );
    const lifecycleScopeRow = lifecycleScopeResult.type === 'bindings'
      ? lifecycleScopeResult.bindings[0]
      : undefined;
    const stripLifecycleLiteral = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      return String(value).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim();
    };
    const persistedScopeVersion = stripLifecycleLiteral(lifecycleScopeRow?.['scope']);
    const persistedAssertionVersion = stripLifecycleLiteral(lifecycleScopeRow?.['version']);
    const hasConfirmedVm = lifecycleScopeRow?.['vm'] !== undefined;
    if (persistedScopeVersion !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    let assertionVersion = 1n;
    if (hasConfirmedVm) {
      if (persistedAssertionVersion === undefined) {
        throw new Error(
          `Graph-scoped lifecycle <${lifecycleUri}> is missing its assertion version`,
        );
      }
      assertionVersion = BigInt(persistedAssertionVersion) + 1n;
    } else if (persistedAssertionVersion !== undefined) {
      assertionVersion = BigInt(persistedAssertionVersion);
    }
    const existingKaIdRes = await this.store.query(
      `SELECT ?n WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${KA_ID_PRED}> ?n } } LIMIT 1`,
    );
    const hasExistingKaId =
      existingKaIdRes.type === 'bindings' && existingKaIdRes.bindings.length > 0;
    const packReservedKaId = (addr: string, num: bigint): bigint =>
      (BigInt(ethers.getAddress(addr)) << 96n) | num;
    const parseStampedNumber = (raw: unknown): bigint =>
      BigInt(String(raw).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim());
    let reservedKaId: bigint;
    // freshNumber is set ONLY when a NEW number must be stamped on the lifecycle
    // URN (fresh create, or a preSigned author whose slot isn't yet stamped).
    let freshNumber: bigint | undefined;
    if (preSigned) {
      if (hasExistingKaId) {
        // The lifecycle already owns a stable slot. A re-finalize / update must
        // commit to THAT id, not whatever the caller signed over — otherwise the
        // persisted seal + on-chain mint (publishFromFinalizedAssertion reuses the
        // stamped `dkg:kaId`) would name a different KA than `_meta` points at.
        // The signature binds reservedKaId (§F2), so a caller who signed a
        // different number is rejected rather than silently re-slotted.
        const stampedKaId = packReservedKaId(
          authorAddress,
          parseStampedNumber(existingKaIdRes.bindings[0]['n']),
        );
        if (preSigned.reservedKaId !== stampedKaId) {
          throw new Error(
            `assertionFinalize: preSignedAuthorAttestation reservedKaId mismatch — ` +
              `caller signed over ${preSigned.reservedKaId} but lifecycle "${name}" is already ` +
              `stamped at kaId ${stampedKaId}. A re-finalize/update must attest the existing ` +
              `stable slot (OT-RFC-43 §F2).`,
          );
        }
        reservedKaId = stampedKaId;
        freshNumber = undefined;
      } else {
        // Fresh slot: the caller-signed id MUST live in the author's own
        // namespace (high 160 bits == author). Otherwise we'd persist a local
        // seal + `_meta` for an id the on-chain mint later rejects with
        // KaIdNamespaceMismatch — sealed locally, unpublishable. Reject here.
        if ((preSigned.reservedKaId >> 96n) !== BigInt(ethers.getAddress(authorAddress))) {
          throw new Error(
            `assertionFinalize: preSignedAuthorAttestation reservedKaId namespace mismatch — ` +
              `id ${preSigned.reservedKaId} is not in author ${ethers.getAddress(authorAddress)}'s ` +
              `namespace. The packed kaId must be (uint160(author) << 96) | number (OT-RFC-43 §F2).`,
          );
        }
        reservedKaId = preSigned.reservedKaId;
        freshNumber = reservedKaId & ((1n << 96n) - 1n);
      }
    } else if (hasExistingKaId) {
      // The lifecycle already owns a stable slot. The stamped `dkg:kaId` number
      // was allocated in the ORIGINAL author's namespace — its packed id is
      // (uint160(originalAuthor) << 96) | number, recorded authoritatively in the
      // co-stamped `dkg:reservedUal` (did:dkg:<chainId>/<authorAddrLower>/<number>).
      // Repacking the SAME number with a CHANGED authorAddress would name a
      // different KA than `_meta`/the lifecycle points at, and the on-chain mint
      // (publishFromFinalizedAssertion reuses the stamped `dkg:kaId`) would reject
      // it with KaIdNamespaceMismatch — sealed locally, unpublishable. Preserve the
      // original author bits and reject author changes on an already-stamped name
      // (OT-RFC-43 §F2).
      const stampedNumber = parseStampedNumber(existingKaIdRes.bindings[0]['n']);
      const reservedUalRes = await this.store.query(
        `SELECT ?u WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${RESERVED_UAL_PRED}> ?u } } LIMIT 1`,
      );
      const stampedReservedUal =
        reservedUalRes.type === 'bindings' && reservedUalRes.bindings[0]?.['u'] !== undefined
          ? String(reservedUalRes.bindings[0]['u']).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim()
          : undefined;
      // did:dkg:<chainId>/<addrLower>/<number> — the second path segment is the
      // original author. A pre-binding seal may lack `dkg:reservedUal`; only then
      // do we fall back to the current author (no recorded original to preserve).
      const originalAuthor = stampedReservedUal?.split('/')[1];
      if (originalAuthor !== undefined) {
        if (ethers.getAddress(originalAuthor) !== ethers.getAddress(authorAddress)) {
          throw new Error(
            `assertionFinalize: cannot change authorship of already-stamped lifecycle "${name}" — ` +
              `the stable kaId number ${stampedNumber} was reserved in author ` +
              `${ethers.getAddress(originalAuthor)}'s namespace, but this finalize attributes the ` +
              `assertion to ${ethers.getAddress(authorAddress)}. Repacking the number under a new ` +
              `author would target a different KA than the lifecycle (and on-chain mint) points at ` +
              `and be rejected on mint with KaIdNamespaceMismatch. Discard and re-create under the ` +
              `new author to allocate a fresh slot, or finalize as the original author (OT-RFC-43 §F2).`,
          );
        }
        // Author unchanged — pack with the preserved original author bits.
        reservedKaId = packReservedKaId(originalAuthor, stampedNumber);
      } else {
        reservedKaId = packReservedKaId(authorAddress, stampedNumber);
      }
    } else if (this.kaNumberAllocator) {
      const key = authorAddress.toLowerCase();
      if (!this.reconciledKaAuthors.has(key)) {
        let chainMax = -1n;
        if (typeof this.chain.getMaxKaNumberForAuthor === 'function') {
          try {
            // Retry transient RPC failures (429/timeout/5xx) on the floor read
            // so a rate-limited public RPC doesn't hard-fail finalize.
            chainMax = await readMaxKaNumberWithRetry(this.chain.getMaxKaNumberForAuthor.bind(this.chain), authorAddress);
          } catch (err) {
            // #1116 (round 11) — CAPABILITY GAP (the chain read to reconcile the
            // KA-number floor failed — a transient/RPC capability problem, not bad input).
            // PR #1319 review: tag the transient/deterministic verdict so the daemon
            // HTTP layer (respondIfReconcileUnavailable) only 503s a genuinely
            // retryable failure — a deterministic revert falls through to its normal mapping.
            throw Object.assign(
              new Error(
                `OT-RFC-43 A2: failed to reconcile KA-number floor for author ${authorAddress} at finalize: ` +
                  (err instanceof Error ? err.message : String(err)),
              ),
              { code: SEAL_CAPABILITY_GAP_CODE, retryable: isTransientChainError(err) },
            );
          }
        }
        if (chainMax >= 0n) {
          // Pass the bigint straight through (PR #976 F6) — `Number()` would lose precision past 2^53.
          this.kaNumberAllocator.reconcile(authorAddress, chainMax);
        }
        this.kaNumberAllocator.markReconciled();
        this.reconciledKaAuthors.add(key);
      }
      freshNumber = BigInt(this.kaNumberAllocator.allocate(authorAddress).number);
      reservedKaId = packReservedKaId(authorAddress, freshNumber);
    } else {
      // OT-RFC-43 §F2 — no pre-signed slot, no previously-stamped kaId, and no
      // kaNumberAllocator configured on this daemon. We cannot mint a valid
      // reserved kaId: the packed id must be (uint160(author) << 96) | number,
      // so a 0n placeholder is NOT in author ${authorAddress}'s namespace and the
      // on-chain mint rejects it with KaIdNamespaceMismatch — the seal would be
      // signed and persisted but permanently unpublishable. Fail fast rather than
      // bind an unusable placeholder into the AuthorAttestation digest.
      // #1116 (round 11) — CAPABILITY GAP (no kaNumberAllocator configured on this
      // daemon — a node-config capability gap, resolvable by configuring one or
      // supplying a preSigned slot; not a bad-input/validation error).
      throw Object.assign(
        new Error(
          `assertionFinalize: cannot reserve a kaId for author ${authorAddress} — ` +
            `no preSignedAuthorAttestation (which would carry its own slot) and no ` +
            `kaNumberAllocator is configured on this daemon (OT-RFC-43 §F2). The packed ` +
            `kaId must be (uint160(author) << 96) | number; a 0n placeholder is rejected ` +
            `on-chain (KaIdNamespaceMismatch), leaving the seal unpublishable. Configure a ` +
            `KaNumberAllocator on the agent (daemon lifecycle) or supply a ` +
            `preSignedAuthorAttestation whose reservedKaId lives in the author's namespace.`,
        ),
        { code: SEAL_CAPABILITY_GAP_CODE },
      );
    }

    // 8. Build EIP-712 typed data (binds reservedKaId — OT-RFC-43 §F2).
    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      merkleRoot,
      authorAddress,
      reservedKaId,
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
    } else if (opts?.authorSignTypedData != null) {
      const compact = await opts.authorSignTypedData(typedData);
      const sig = ethers.Signature.from({
        r: ethers.hexlify(compact.r),
        yParityAndS: ethers.hexlify(compact.vs),
      });
      const isContractAuthor =
        typeof this.chain.hasContractCode === 'function'
          ? await this.chain.hasContractCode(authorAddress)
          : false;
      if (!isContractAuthor) {
        const recovered = ethers.recoverAddress(eip712Digest, sig);
        if (recovered.toLowerCase() !== authorAddress.toLowerCase()) {
          throw new Error(
            `assertionFinalize: authorSignTypedData signer mismatch — ` +
              `signature recovers ${recovered} but address claims ${authorAddress}.`,
          );
        }
      }
      r = ethers.getBytes(sig.r);
      vs = ethers.getBytes(sig.yParityAndS);
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
    const kaNumber = reservedKaId & ((1n << 96n) - 1n);
    const kaUal = `did:dkg:${this.chain.chainId}/${authorAddress.toLowerCase()}/${kaNumber}`;
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
      reservedKaId,
      finalizedAtIso,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal,
      assertionVersion,
      publicTripleCount,
      privateMerkleRoot,
      privateTripleCount,
    });

    // ── OT-RFC-43 A2 — stamp the per-author kaId + reservedUal + WM pointer ──
    // The number was resolved/allocated ABOVE (single allocation, before the
    // EIP-712 sign — OT-RFC-43 §F2). Here we only PERSIST it:
    //   dkg:kaId          = number (xsd:integer)
    //   dkg:reservedUal   = did:dkg:<chainId>/<agentAddrLower>/<number>
    //   dkg:wmCurrentAssertion = the seal merkle hex (bare, no 0x)
    // publishFromFinalizedAssertion READS dkg:kaId off `_meta` and threads it
    // down so the publisher REUSES it. freshNumber is set only for a fresh create
    // (or a not-yet-stamped preSigned slot); an update of a previously-stamped
    // name keeps its STABLE kaId — no re-stamp.
    if (freshNumber !== undefined) {
      sealQuads.push({
        subject: lifecycleUri,
        predicate: KA_ID_PRED,
        object: `"${freshNumber}"^^${xsdInteger}`,
        graph: metaGraph,
      });
      sealQuads.push({
        subject: lifecycleUri,
        predicate: RESERVED_UAL_PRED,
        object: `"${kaUal}"`,
        graph: metaGraph,
      });
    }

    // Crash-safe commit order:
    //   1. atomically materialize the complete canonical target;
    //   2. persist the seal (and a fresh identity, when needed);
    //   3. repair lifecycle pointers/version;
    //   4. remove obsolete source graphs.
    // Any interruption leaves either the original source or the canonical
    // target plus enough durable seal data for the idempotent branch above to
    // finish the transition on retry.
    const canonicalWmGraphUri = await this.publisher.materializeCanonicalWorkingMemory(
      contextGraphId,
      kaUal,
      assertionVersion,
      normalizedKnowledgeAssetQuads,
      opts?.subGraphName,
    );
    const canonicalScope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      contextGraphId,
      canonicalScope,
      normalizedPrivateKnowledgeAssetQuads,
      opts?.subGraphName,
    );
    await this.store.insert(sealQuads);
    await stampFinalizedLifecycle(assertionVersion, merkleRoot);
    await this.publisher.cleanupCanonicalWorkingMemorySources(
      contextGraphId,
      name,
      agentAddress,
      canonicalWmGraphUri,
      [sourceWmGraphUri],
      opts?.subGraphName,
    );
    await privateStore.deleteKnowledgeAssetPrivateDraft(
      contextGraphId,
      agentAddress,
      name,
      opts?.subGraphName,
    );

    return {
      assertionUri,
      merkleRoot,
      authorAddress,
      reservedKaId,
      rootEntities: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal,
      assertionVersion: assertionVersion.toString(),
      publicTripleCount,
      ...(privateMerkleRoot !== undefined ? { privateMerkleRoot } : {}),
      privateTripleCount,
      schemeVersion,
      chainId,
      kav10Address,
      eip712Digest,
    };
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
      /** Compute the V2 one-asset commitment instead of legacy per-root commitments. */
      graphScoped?: boolean;
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

    const privateQuads = opts?.privateQuads ?? [];
    let merkleRoot: Uint8Array;
    if (opts?.graphScoped) {
      const canonical = await skolemizeKnowledgeAssetParts(quads, privateQuads);
      const privateRoot = computePrivateRoot(canonical.privateQuads);
      merkleRoot = computeFlatKCRoot(
        canonical.publicQuads,
        privateRoot ? [privateRoot] : [],
      );
    } else {
      const trustedCatalogOnChainId = opts?.targetOnChainCgId
        ?? await this.getContextGraphOnChainId(contextGraphId);
      const canonical = canonicalPublishPayload(
        quads,
        privateQuads,
        trustedCatalogOnChainId != null && (await this.isPrivateContextGraph(contextGraphId))
          ? { trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(contextGraphId) }
          : undefined,
      );
      merkleRoot = canonical.kcMerkleRoot;
    }

    const chainId = await this.chain.getEvmChainId();
    const kav10Address = await this.chain.getKnowledgeAssetsLifecycleAddress();
    // #1116: the AuthorAttestation no longer binds the on-chain CG id, so the
    // selection-publish seal is also CG-independent. The CG the publisher mints
    // into is resolved separately at publish time (targetOnChainCgId/v10CgId).

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

    // OT-RFC-43 §F2 — allocate the reserved kaId for this ephemeral selection
    // publish and bind it into the signed digest; the publisher mints with this
    // exact id (it travels on the returned precomputedAttestation). preSigned
    // authors supply their own slot; with no allocator we fall to 0n (the on-chain
    // namespace check then rejects).
    let selReservedKaId: bigint;
    if (preSigned) {
      // Same namespace guard as assertionFinalize: the caller-signed id must be
      // in the author's own namespace, or the publisher mints an id the chain
      // rejects (KaIdNamespaceMismatch) after the seal is already built.
      if ((preSigned.reservedKaId >> 96n) !== BigInt(ethers.getAddress(authorAddress))) {
        throw new Error(
          `Selection-based VM publish: preSignedAuthorAttestation reservedKaId namespace mismatch — ` +
            `id ${preSigned.reservedKaId} is not in author ${ethers.getAddress(authorAddress)}'s ` +
            `namespace (packed kaId must be (uint160(author) << 96) | number, OT-RFC-43 §F2).`,
        );
      }
      selReservedKaId = preSigned.reservedKaId;
    } else if (this.kaNumberAllocator) {
      const selKey = authorAddress.toLowerCase();
      if (!this.reconciledKaAuthors.has(selKey)) {
        let selChainMax = -1n;
        if (typeof this.chain.getMaxKaNumberForAuthor === 'function') {
          try {
            // Retry transient RPC failures (429/timeout/5xx) on the floor read.
            selChainMax = await readMaxKaNumberWithRetry(this.chain.getMaxKaNumberForAuthor.bind(this.chain), authorAddress);
          } catch (err) {
            // PR #1319 review: tag the transient/deterministic verdict (same as the
            // finalize path) so the daemon only 503s a genuinely retryable failure;
            // a deterministic revert falls through to its normal mapping.
            throw Object.assign(
              new Error(
                `OT-RFC-43 §F2: failed to reconcile KA-number floor for author ${authorAddress} (selection publish): ` +
                  (err instanceof Error ? err.message : String(err)),
              ),
              { retryable: isTransientChainError(err) },
            );
          }
        }
        if (selChainMax >= 0n) this.kaNumberAllocator.reconcile(authorAddress, selChainMax);
        this.kaNumberAllocator.markReconciled();
        this.reconciledKaAuthors.add(selKey);
      }
      selReservedKaId =
        (BigInt(ethers.getAddress(authorAddress)) << 96n) |
        BigInt(this.kaNumberAllocator.allocate(authorAddress).number);
    } else {
      // §F2 — same as the finalize path's no-allocator branch: with no preSigned
      // slot and no kaNumberAllocator we cannot reserve a kaId in the author's
      // namespace, and a 0n placeholder is rejected on-chain (KaIdNamespaceMismatch).
      // This selection publish is on-chain-bound (the seal is signed + minted, never
      // persisted), so fail fast rather than sign an id the mint will reject.
      throw new Error(
        `_buildPrecomputedAttestationForSelection: cannot reserve a kaId for author ` +
          `${authorAddress} — no preSignedAuthorAttestation and no kaNumberAllocator ` +
          `configured (OT-RFC-43 §F2). The packed kaId must be (uint160(author) << 96) | ` +
          `number; a 0n placeholder is rejected on-chain. Configure a KaNumberAllocator ` +
          `or supply a preSignedAuthorAttestation whose reservedKaId is in the author's namespace.`,
      );
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      merkleRoot,
      authorAddress,
      reservedKaId: selReservedKaId,
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
      reservedKaId: selReservedKaId,
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
    explicitPolicyTargetContextGraphId: string | undefined,
    logPrefix: string,
    options?: ResolveCuratedChainKeyContextOptions,
  ): Promise<{ chainKey: Uint8Array; aeadCgId: string; senderAddress: string } | undefined> {
    const ctx = createOperationContext('publish');
    const targetCgId = explicitPolicyTargetContextGraphId ?? contextGraphId;
    const probeIsCurated = async (cgId: string, opts?: { rawOnChainSlot?: boolean }): Promise<boolean | null> => {
      // Consume the SHARED tri-state resolver (the same one behind the
      // SWM-gossip gate) so the publish-inline path can never DIVERGE from it,
      // and — critically (#884 review 🔴 GZh-c) — so a genuine UNKNOWN is
      // PRESERVED here instead of collapsing to "not public ⇒ plaintext". The
      // resolver already does the live-on-chain proof, identity binding, and
      // bounded reads; a thrown RPC rejection is caught below and also
      // fails closed.
      let policyState: 0 | 1 | 'unregistered' | 'unknown';
      try {
        if (opts?.rawOnChainSlot && /^\d+$/.test(cgId.trim())) {
          const policy = await this.readLiveOnChainAccessPolicy(cgId.trim(), ctx);
          policyState = policy === 0 || policy === 1 ? policy : 'unknown';
        } else {
          policyState = await this.resolveOnChainAccessPolicyState(cgId, ctx);
        }
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
    const explicitRawTarget = explicitPolicyTargetContextGraphId !== undefined && /^\d+$/.test(targetCgId.trim());
    let sourceIsCurated: boolean | null;
    let targetIsCurated: boolean | null;
    if (targetCgId !== contextGraphId && explicitRawTarget) {
      targetIsCurated = await probeIsCurated(targetCgId, { rawOnChainSlot: true });
      sourceIsCurated = targetIsCurated == null ? null : await probeIsCurated(contextGraphId);
    } else {
      sourceIsCurated = await probeIsCurated(contextGraphId);
      targetIsCurated = targetCgId === contextGraphId
        ? sourceIsCurated
        : await probeIsCurated(targetCgId);
    }
    if (targetIsCurated == null || (targetCgId !== contextGraphId && sourceIsCurated == null && !targetIsCurated)) {
      throw new Error(
        `${logPrefix}: publish access-policy is unknown — ` +
        `source CG "${contextGraphId}" curated=${sourceIsCurated ?? 'unknown'}, ` +
        `target CG "${targetCgId}" curated=${targetIsCurated ?? 'unknown'}. ` +
        `Refusing to choose plaintext vs encrypted inline payload without chain-confirmed policy.`,
      );
    }
    if (targetCgId !== contextGraphId && sourceIsCurated == null && targetIsCurated) {
      this.log.warn(
        ctx,
        `${logPrefix}: source CG "${contextGraphId}" access-policy is unknown, but explicit target ` +
        `on-chain CG "${targetCgId}" is chain-confirmed curated; selecting encrypted direct publish payload.`,
      );
    }
    if (targetCgId !== contextGraphId && sourceIsCurated != null && sourceIsCurated !== targetIsCurated) {
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
      aeadCgId: options?.aeadBindingContextGraphId ?? explicitPolicyTargetContextGraphId ?? contextGraphId,
      senderAddress,
    };
  }

  async _resolveEncryptInlinePayload(this: DKGAgent,
    contextGraphId: string,
    subGraphName?: string,
    authorAgentAddress?: string,
    explicitPolicyTargetContextGraphId?: string,
    options?: ResolveCuratedChainKeyContextOptions,
  ): Promise<((plaintext: Uint8Array) => Promise<Uint8Array>) | undefined> {
    const resolved = await this._resolveCuratedChainKeyContext(
      contextGraphId, subGraphName, authorAgentAddress, explicitPolicyTargetContextGraphId, 'LU-5', options,
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
    explicitPolicyTargetContextGraphId?: string,
    options?: ResolveCuratedChainKeyContextOptions,
  ): Promise<
    | ((input: { plaintextNquads: Uint8Array; batchId: Uint8Array; publishOperationId: string }) => Promise<{
        ciphertextChunksRoot: Uint8Array;
        ciphertextChunkCount: number;
        totalCiphertextBytes: number;
        ciphertextChunks: Uint8Array[];
      }>)
    | undefined
  > {
    const resolved = await this._resolveCuratedChainKeyContext(
      contextGraphId, subGraphName, authorAgentAddress, explicitPolicyTargetContextGraphId, 'LU-11', options,
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
      ciphertextChunks: Uint8Array[];
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
        const persistCanonical = this.canonicalChunkStoreCgIdOrNull(contextGraphId);
        const chunksGraph = ciphertextChunkStoreGraph(persistCanonical ?? contextGraphId);
        const subject = ciphertextChunkStoreSubject(input.batchId, i);
        const literal = `"${Buffer.from(ct).toString('base64')}"`;
        try {
          await this.store.insert([{
            subject,
            predicate: CIPHERTEXT_CHUNK_PREDICATE,
            object: literal,
            graph: chunksGraph,
          }]);
        } catch (err) {
          log.warn(
            ctx,
            `LU-11: failed to persist local ciphertext chunk cgId=${contextGraphId} ` +
            `batchId=${batchIdHex.slice(0, 18)}... op=${input.publishOperationId} chunkIndex=${i}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          throw err;
        }
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
        ciphertextChunks,
      };
    };
  }

  async _loadSelectedSWMQuads(this: DKGAgent,
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    subGraphName?: string,
    scope: SharedMemoryGraphScope = { kind: 'complete-family' },
  ): Promise<Quad[]> {
    const swmGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
    const options = {
      querySource: 'agent.resolveLiftWorkspaceSlice',
      rootEntitiesErrorMessage: ({ inputCount, hadInput }: { inputCount: number; hadInput: boolean }) => (
        hadInput
          ? `_loadSelectedSWMQuads: no valid rootEntities provided ` +
              `(all ${inputCount} entries failed IRI validation) ` +
              `for context graph ${contextGraphId}`
          : `_loadSelectedSWMQuads: no rootEntities supplied for context graph ${contextGraphId}`
      ),
    } as const;
    return loadSharedMemoryQuadsForScope(this.store, swmGraph, selection, scope, options);
  }

  /**
   * #1116 — transparent register-then-publish (OT-RFC-38 LU-6).
   *
   * The seal is now context-graph-independent, so `finalize` no longer
   * registers the CG on-chain. Registration is therefore deferred to publish
   * time: the FIRST VM publish of a CG implicitly registers it (the moment the
   * user accepts the chain cost). Idempotent — `registerContextGraph`
   * short-circuits when an on-chain id already exists, so re-publishes don't
   * double-mint. Preserves create-time `publishPolicy`/PCA via the stored
   * registration options. Throws on registration failure (insufficient TRAC /
   * no signer) so the route can surface a clear 4xx.
   *
   * Mirrors the legacy bridge's auto-register block
   * (`daemon/routes/memory.ts`); the canonical `/vm/publish` route calls this
   * before `publishFromFinalizedAssertion`.
   */
  async ensureRegisteredForPublish(
    this: DKGAgent,
    contextGraphId: string,
    opts?: { callerAgentAddress?: string },
  ): Promise<void> {
    const existingOnChainId = await this.getContextGraphOnChainId(contextGraphId);
    if (existingOnChainId) return;
    // #1085 — the publish path has no request-body policy, so it reads the
    // stored create-time policy + PCA directly from the canonical store reader
    // and forwards BOTH. Deliberately NOT wrapped in a catch: a stored-read
    // failure must propagate (fail-loud) rather than silently register the CG
    // under the default policy — dropping the create-time policy on-chain is
    // exactly the #1085 regression, and hard to reverse. (The /register route
    // owns the best-effort fall-back for its own interactive call site, and
    // applies its own body-wins override.)
    const { publishPolicy, publishAuthorityAccountId } = await this.getStoredContextGraphRegistrationOptions(contextGraphId);
    try {
      await this.registerContextGraph(contextGraphId, {
        ...(opts?.callerAgentAddress != null ? { callerAgentAddress: opts.callerAgentAddress } : {}),
        ...(publishPolicy !== undefined ? { publishPolicy } : {}),
        ...(publishAuthorityAccountId !== undefined
          ? { publishAuthorityAccountId }
          : {}),
      });
    } catch (err: any) {
      // #1116 (round 5) — check-then-act race. Two first-publishers of the same
      // CG can both pass the `existingOnChainId` check, then one's
      // registerContextGraph lands first; the loser throws "already registered
      // on-chain". That's success, not failure — the CG IS registered. Confirm
      // an on-chain id now exists (the winner's) and return; rethrow anything
      // else (a genuine registration failure: insufficient TRAC / no signer).
      // No double-mint: registerContextGraph itself short-circuits on a present
      // id; this only swallows the benign concurrent-winner rejection.
      if (
        /already registered on-chain/i.test(err?.message ?? String(err)) &&
        (await this.getContextGraphOnChainId(contextGraphId))
      ) {
        return;
      }
      throw err;
    }
  }

  /**
   * RFC-001 §9.x — publish a previously-finalized assertion to the
   * verifiable-memory chain.
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
  async resolveFinalizedAssertionVmPublishIntent(this: DKGAgent,
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      agentAddress?: string;
      publishEpochs?: number;
      clearSharedMemoryAfter?: boolean;
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: readonly string[];
      entityProofs?: boolean;
      publisherNodeIdentityIdOverride?: bigint | `${bigint}`;
      publisherOverride?: DKGPublisher;
    },
  ): Promise<KnowledgeAssetVmPublishRequest> {
    const agentAddress = opts?.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const publisher = opts?.publisherOverride ?? this.publisher;
    const history = await this.assertion.history(contextGraphId, name, {
      agentAddress,
      ...(opts?.subGraphName ? { subGraphName: opts.subGraphName } : {}),
    });
    if (!history) {
      throw new Error(
        `publishFromFinalizedAssertion: assertion "${name}" in context graph "${contextGraphId}" is not finalized or does not exist.`,
      );
    }
    if (!(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName))) {
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" in context graph "${contextGraphId}": it is not a complete full share ` +
            `resident in Shared Memory. Seal and share the full asset before publishing.`,
        ),
        { code: 'PUBLISH_NOT_FULL_SHARE' },
      );
    }

    const metaGraph = contextGraphMetaUri(contextGraphId);
    const assertionUri = contextGraphAssertionUri(contextGraphId, agentAddress, name, opts?.subGraphName);
    const metaResult = await this.store.query(
      `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
    );
    const metaQuads = metaResult.type === 'quads' ? metaResult.quads : [];
    const seal = parseAssertionSealQuads(metaQuads, assertionUri);
    if (!seal) {
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" asynchronously: the current SWM share is not sealed. ` +
            `Finalize and share the full asset before publishing.`,
        ),
        { code: 'PUBLISH_INTENT_STALE' },
      );
    }
    if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    if (
      seal.kaUal === undefined
      || seal.assertionVersion === undefined
      || seal.publicTripleCount === undefined
      || seal.privateTripleCount === undefined
    ) {
      throw new Error(`Graph-scoped assertion seal for <${assertionUri}> is incomplete`);
    }
    const accessPolicy = opts?.accessPolicy
      ?? (seal.privateTripleCount > 0 ? 'ownerOnly' : 'public');
    const allowedPeers = [...new Set(
      (opts?.allowedPeers ?? []).map((peerId) => peerId.trim()).filter(Boolean),
    )];
    if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
      throw new Error('Queued Knowledge Asset allowList policy requires allowedPeers');
    }
    if (accessPolicy !== 'allowList' && allowedPeers.length > 0) {
      throw new Error('Queued Knowledge Asset allowedPeers requires allowList policy');
    }
    const latestPromote = [...history.events]
      .reverse()
      .find((event) => event.type === 'promoted' && event.shareOperationId);
    const shareOperationId = latestPromote?.shareOperationId?.trim() ?? history.currentShareOperationId?.trim();
    if (!shareOperationId) {
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" asynchronously: the current SWM share is missing a shareOperationId. ` +
            `Re-share the asset through /api/knowledge-assets/${encodeURIComponent(name)}/swm/share before publishing.`,
        ),
        { code: 'PUBLISH_INTENT_STALE' },
      );
    }

    const merkleBare = ethers.hexlify(seal.merkleRoot).slice(2);
    if (!merkleBare) {
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" asynchronously: the current SWM share has no sealed assertion pointer. ` +
            `Finalize and share the full asset before publishing.`,
        ),
        { code: 'PUBLISH_INTENT_STALE' },
      );
    }
    const sealMerkleRoot = (merkleBare.startsWith('0x') ? merkleBare : `0x${merkleBare}`) as `0x${string}`;
    const queuedSeal: LiftRequestAuthorSeal = {
      merkleRoot: ethers.hexlify(seal.merkleRoot) as `0x${string}`,
      authorAddress: ethers.getAddress(seal.authorAddress) as `0x${string}`,
      signature: {
        r: ethers.hexlify(seal.authorAttestationR) as `0x${string}`,
        vs: ethers.hexlify(seal.authorAttestationVS) as `0x${string}`,
      },
      schemeVersion: seal.authorSchemeVersion,
      ...(seal.reservedKaId !== undefined ? { reservedKaId: seal.reservedKaId.toString() as `${bigint}` } : {}),
    };
    const publisherOverrideString = opts?.publisherNodeIdentityIdOverride !== undefined
      ? opts.publisherNodeIdentityIdOverride.toString() as `${bigint}`
      : undefined;
    const canonicalIntent = {
      contextGraphId,
      name,
      agentAddress,
      subGraphName: opts?.subGraphName ?? null,
      shareOperationId,
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      publicTripleCount: seal.publicTripleCount,
      privateMerkleRoot: seal.privateMerkleRoot
        ? ethers.hexlify(seal.privateMerkleRoot).toLowerCase()
        : null,
      privateTripleCount: seal.privateTripleCount,
      accessPolicy,
      allowedPeers,
      entityProofs: opts?.entityProofs ?? null,
      sealMerkleRoot: sealMerkleRoot.toLowerCase(),
      seal: queuedSeal,
      sealChainId: seal.chainId.toString(),
      sealKav10Address: ethers.getAddress(seal.kav10Address),
      sealFinalizedAtIso: seal.finalizedAtIso,
      wmCurrentAssertion: history.wmCurrentAssertion ?? null,
      swmCurrentAssertion: history.swmCurrentAssertion ?? null,
      vmCurrentAssertion: history.vmCurrentAssertion ?? null,
      kaNumber: history.kaNumber ?? null,
      reservedUal: history.reservedUal ?? null,
      publishEpochs: opts?.publishEpochs ?? null,
      clearSharedMemoryAfter: opts?.clearSharedMemoryAfter ?? null,
      publisherNodeIdentityIdOverride: publisherOverrideString ?? null,
    };
    const intentKey = `sha256:${createHash('sha256').update(JSON.stringify(canonicalIntent)).digest('hex')}`;

    return {
      contextGraphId,
      name,
      agentAddress,
      ...(opts?.subGraphName ? { subGraphName: opts.subGraphName } : {}),
      shareOperationId,
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: seal.kaUal,
      assertionVersion: seal.assertionVersion,
      publicTripleCount: seal.publicTripleCount,
      ...(seal.privateMerkleRoot
        ? { privateMerkleRoot: ethers.hexlify(seal.privateMerkleRoot) as `0x${string}` }
        : {}),
      privateTripleCount: seal.privateTripleCount,
      accessPolicy,
      ...(allowedPeers.length > 0 ? { allowedPeers } : {}),
      ...(opts?.entityProofs !== undefined ? { entityProofs: opts.entityProofs } : {}),
      seal: queuedSeal,
      sealChainId: seal.chainId.toString() as `${bigint}`,
      sealKav10Address: ethers.getAddress(seal.kav10Address) as `0x${string}`,
      sealFinalizedAtIso: seal.finalizedAtIso,
      sealMerkleRoot,
      intentKey,
      ...(history.wmCurrentAssertion ? { wmCurrentAssertion: history.wmCurrentAssertion } : {}),
      ...(history.swmCurrentAssertion ? { swmCurrentAssertion: history.swmCurrentAssertion } : {}),
      ...(history.vmCurrentAssertion ? { vmCurrentAssertion: history.vmCurrentAssertion } : {}),
      ...(history.kaNumber ? { kaNumber: history.kaNumber } : {}),
      ...(history.reservedUal ? { reservedUal: history.reservedUal } : {}),
      ...(opts?.publishEpochs !== undefined ? { publishEpochs: opts.publishEpochs } : {}),
      ...(opts?.clearSharedMemoryAfter !== undefined ? { clearSharedMemoryAfter: opts.clearSharedMemoryAfter } : {}),
      ...(publisherOverrideString !== undefined ? { publisherNodeIdentityIdOverride: publisherOverrideString } : {}),
    };
  }

  async preflightKnowledgeAssetVmPublishSnapshot(
    this: DKGAgent,
    request: KnowledgeAssetVmPublishRequest,
  ): Promise<void> {
    const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
    const snapshotMetadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);
    try {
      const resolved = await resolveLiftWorkspaceSlice({
        store: this.store,
        graphManager: new GraphManager(this.store),
        request: snapshot,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      validateLiftPublishPayload({
        request: snapshot,
        metadata: snapshotMetadata,
        resolved,
      });
      if (resolved.quads.length === 0 && (resolved.privateQuads ?? []).length === 0) {
        throw new Error(
          `No queued shared-memory snapshot quads for context graph ${request.contextGraphId} ` +
            `share operation ${request.shareOperationId}`,
        );
      }
    } catch (err) {
      if (err instanceof LegacyKnowledgeAssetReadOnlyError) throw err;
      const wrapped = new Error(
        `Cannot enqueue VM publish for "${request.name}" because share snapshot ` +
          `${request.shareOperationId} is unavailable or stale. Re-share the knowledge asset before enqueueing: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      (wrapped as Error & { code?: string }).code = 'PUBLISH_INTENT_STALE';
      throw wrapped;
    }
  }

  async preflightQueuedKnowledgeAssetVmPublishExecution(
    this: DKGAgent,
    request: KnowledgeAssetVmPublishRequest,
    opts?: { publisherOverride?: DKGPublisher },
  ): Promise<AsyncKnowledgeAssetVmPublishPreflightResult> {
    if (
      request.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
      || request.kaUal === undefined
      || request.assertionVersion === undefined
      || request.publicTripleCount === undefined
      || request.privateTripleCount === undefined
      || request.roots.length !== 0
    ) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    createGraphKnowledgeAssetScope(request.kaUal, request.assertionVersion);
    const bareRoot = (value?: string | null): string | undefined => {
      const trimmed = value?.trim().toLowerCase();
      if (!trimmed) return undefined;
      return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
    };
    const stale = (message: string): Error & { code: 'PUBLISH_INTENT_STALE' } =>
      Object.assign(new Error(message), { code: 'PUBLISH_INTENT_STALE' as const });

    const queuedSealBare = bareRoot(request.sealMerkleRoot);
    if (!queuedSealBare) {
      throw stale(`Queued VM publish for "${request.name}" is missing a seal merkle root.`);
    }

    const agentAddress = request.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const publisher = opts?.publisherOverride ?? this.publisher;
    const history = await this.assertion.history(request.contextGraphId, request.name, {
      agentAddress,
      ...(request.subGraphName ? { subGraphName: request.subGraphName } : {}),
    });
    if (!history) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `the named lifecycle record is no longer available.`,
      );
    }

    const liveVmBare = bareRoot(history.vmCurrentAssertion);
    const liveSwmBare = bareRoot(history.swmCurrentAssertion);
    if (liveSwmBare && liveSwmBare !== queuedSealBare) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `SWM pointer is ${liveSwmBare}, queued seal is ${queuedSealBare}.`,
      );
    }

    const liveWmBare = bareRoot(history.wmCurrentAssertion);
    const queuedWmBare = bareRoot(request.wmCurrentAssertion) ?? queuedSealBare;
    if (liveWmBare && liveWmBare !== queuedWmBare) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `WM pointer is ${liveWmBare}, queued WM pointer was ${queuedWmBare}.`,
      );
    }

    if (liveVmBare === queuedSealBare) {
      return { action: 'noop', reason: 'already-published' };
    }

    const queuedVmBare = bareRoot(request.vmCurrentAssertion);
    if (liveVmBare && (!queuedVmBare || liveVmBare !== queuedVmBare)) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
        `VM pointer is ${liveVmBare}, queued VM pointer was ${queuedVmBare ?? 'none'}.`,
      );
    }

    const liveShareComplete = await publisher.hasSwmShareComplete(
      request.contextGraphId,
      request.name,
      agentAddress,
      request.subGraphName,
    );
    if (!liveShareComplete) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `the queued full-share marker is no longer active for shareOperationId ${request.shareOperationId}.`,
      );
    }

    if (!liveSwmBare) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `SWM pointer is none, queued seal is ${queuedSealBare}.`,
      );
    }
    if (!liveWmBare) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `WM pointer is none, queued WM pointer was ${queuedWmBare}.`,
      );
    }

    const liveShareOperationId = history.currentShareOperationId?.trim();
    if (!liveShareOperationId || liveShareOperationId !== request.shareOperationId.trim()) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `shareOperationId is ${liveShareOperationId ?? 'none'}, queued shareOperationId was ${request.shareOperationId}.`,
      );
    }

    if (history.kaNumber && request.kaNumber && history.kaNumber !== request.kaNumber) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `KA number is ${history.kaNumber}, queued KA number was ${request.kaNumber}.`,
      );
    }
    if (history.reservedUal && request.reservedUal && history.reservedUal !== request.reservedUal) {
      throw stale(
        `Knowledge asset VM publish intent for "${request.name}" changed after enqueue: ` +
          `reserved UAL is ${history.reservedUal}, queued reserved UAL was ${request.reservedUal}.`,
      );
    }

    return { action: 'execute' };
  }

  async _stampQueuedKnowledgeAssetVmPublishedLifecycle(
    this: DKGAgent,
    request: KnowledgeAssetVmPublishRequest,
    publishedUal: string,
    packedKaId?: bigint,
    merkleRoot: string = request.sealMerkleRoot,
  ): Promise<void> {
    const agentAddress = request.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    await applyPublishedNamedKaVmLifecycle(this.store, {
      contextGraphId: request.contextGraphId,
      agentAddress,
      name: request.name,
      subGraphName: request.subGraphName,
      publishedUal,
      merkleRoot,
      packedKaId,
    });
  }

  async _writeQueuedKnowledgeAssetVmPublishReceipt(
    this: DKGAgent,
    request: KnowledgeAssetVmPublishRequest,
    txHash: string,
    blockNumber: number,
    packedKaId: bigint,
  ): Promise<void> {
    const agentAddress = request.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const assertionUri = contextGraphAssertionUri(
      request.contextGraphId,
      agentAddress,
      request.name,
      request.subGraphName,
    );
    await this.store.insert(buildAssertionPublishReceiptQuads({
      assertionUri,
      metaGraph: contextGraphMetaUri(request.contextGraphId),
      txHash,
      blockNumber: BigInt(blockNumber),
      kaId: packedKaId,
    }));
  }

  async finalizeRecoveredQueuedKnowledgeAssetVmPublish(
    this: DKGAgent,
    input: AsyncKnowledgeAssetVmPublishRecoveryInput,
  ): Promise<void> {
    const ctx = createOperationContext('publishFromSWM');
    try {
      await this._finalizeRecoveredQueuedKnowledgeAssetVmPublish(input, ctx);
    } catch (error) {
      this.log.warn(
        ctx,
        `Named KA recovery for "${input.request.name}" remains pending: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      throw error;
    }
  }

  async _finalizeRecoveredQueuedKnowledgeAssetVmPublish(
    this: DKGAgent,
    input: AsyncKnowledgeAssetVmPublishRecoveryInput,
    ctx: OperationContext,
  ): Promise<void> {
    const { request, job, recovery } = input;
    if (
      request.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
      || request.kaUal === undefined
      || request.assertionVersion === undefined
      || request.roots.length !== 0
    ) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    const recovered = await normalizeRecoveredNamedKaPublish({
      request,
      job,
      recovery,
      chain: this.chain,
    });

    const onChainCgId = normalizeOptionalContextGraphId(
      await this.getContextGraphOnChainId(request.contextGraphId),
    );
    if (!onChainCgId) {
      throw Object.assign(
        new Error(
          `Named KA recovery rejected for "${request.name}": ` +
            `context graph ${request.contextGraphId} has no local on-chain id binding`,
        ),
        { code: 'KA_VM_RECOVERY_INCONSISTENT' },
      );
    }

    const materialization = await this.getOrCreateFinalizationHandler().handleChainReconciledKC({
      contextGraphId: request.contextGraphId,
      onChainCgId,
      ual: recovered.localUal,
      merkleRoot: ethers.getBytes(recovered.materialization.merkleRoot),
      publisherAddress: recovered.materialization.publisherAddress,
      kaId: recovered.reservedKaId,
      versionBlock: recovered.materialization.versionBlock,
      authorAddress: recovered.materialization.authorAddress,
      subGraphName: request.subGraphName,
    }, ctx);
    if (
      materialization !== 'promoted' &&
      materialization !== 'already-confirmed' &&
      materialization !== 'stale-target'
    ) {
      throw Object.assign(
        new Error(
          `Named KA recovery rejected for "${request.name}": ` +
            `VM materialization is not ready (${materialization}); recovery will retry`,
        ),
        { code: 'KA_VM_RECOVERY_INCONSISTENT' },
      );
    }

    // Both writes are idempotent. If a store operation fails part-way through,
    // the queue remains tx-bearing and the next recovery pass completes it.
    await this._writeQueuedKnowledgeAssetVmPublishReceipt(
      request,
      recovered.txHash,
      recovered.receiptBlockNumber,
      recovered.reservedKaId,
    );
    // `stale-target` means a still-newer local version won the race. Do not
    // regress its pointer; the exact publish receipt is nevertheless repaired.
    if (materialization !== 'stale-target') {
      await this._stampQueuedKnowledgeAssetVmPublishedLifecycle(
        request,
        recovered.receiptUal,
        recovered.reservedKaId,
        recovered.materialization.merkleRoot,
      );
    }

    // SWM-source materialization owns its exact transition. VM-only recovery
    // must not run a second, unlocked cleanup: a newer unpublished assertion
    // can already occupy the same per-KA SWM graph. Publisher lifecycle owns
    // the shared writer-lock cleanup needed to close that wider race.
    this.log.info(
      ctx,
      `Recovered confirmed named KA publish ${recovered.receiptUal} from ${job.status} job ${job.jobId}` +
        (recovered.materialization.superseded ? ' (materialized current superseding version)' : ''),
    );
  }

  async publishQueuedKnowledgeAssetVmPublish(
    this: DKGAgent,
    request: KnowledgeAssetVmPublishRequest,
    publishOptions: PublishOptions,
    opts?: {
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      publisherOverride?: DKGPublisher;
    },
  ): Promise<PublishResult & { assertionUri: string; seal: AssertionSeal }> {
    const ctx = opts?.operationCtx ?? publishOptions.operationCtx ?? createOperationContext('publishFromSWM');
    const publisher = opts?.publisherOverride ?? this.publisher;
    if (request.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    if (
      request.roots.length !== 0
      || request.kaUal === undefined
      || request.assertionVersion === undefined
      || request.publicTripleCount === undefined
      || request.privateTripleCount === undefined
    ) {
      throw new Error('Queued graph-scoped VM publish has an incomplete KA content envelope');
    }
    const graphScope = createGraphKnowledgeAssetScope(
      request.kaUal,
      request.assertionVersion,
    );
    const queuedPrivateMerkleRoot = request.privateMerkleRoot
      ? ethers.getBytes(request.privateMerkleRoot)
      : undefined;
    const agentAddress = request.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const assertionUri = contextGraphAssertionUri(
      request.contextGraphId,
      agentAddress,
      request.name,
      request.subGraphName,
    );
    const lifecycleUri = assertionLifecycleUri(
      request.contextGraphId,
      agentAddress,
      request.name,
      request.subGraphName,
    );
    const metaGraph = contextGraphMetaUri(request.contextGraphId);

    const seal: AssertionSeal = {
      merkleRoot: ethers.getBytes(request.seal.merkleRoot),
      authorAddress: ethers.getAddress(request.seal.authorAddress),
      authorAttestationR: ethers.getBytes(request.seal.signature.r),
      authorAttestationVS: ethers.getBytes(request.seal.signature.vs),
      authorSchemeVersion: request.seal.schemeVersion,
      chainId: BigInt(request.sealChainId),
      kav10Address: ethers.getAddress(request.sealKav10Address),
      finalizedAtIso: request.sealFinalizedAtIso,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: graphScope.ual,
      assertionVersion: graphScope.assertionVersion,
      publicTripleCount: request.publicTripleCount,
      ...(queuedPrivateMerkleRoot ? { privateMerkleRoot: queuedPrivateMerkleRoot } : {}),
      privateTripleCount: request.privateTripleCount,
      rootEntities: [],
      ...(request.seal.reservedKaId !== undefined ? { reservedKaId: BigInt(request.seal.reservedKaId) } : {}),
    };
    const queuedMerkleRoot = ethers.hexlify(seal.merkleRoot).toLowerCase();
    if (queuedMerkleRoot !== request.sealMerkleRoot.toLowerCase()) {
      throw Object.assign(
        new Error(
          `Queued VM publish for "${request.name}" has inconsistent seal roots: ` +
            `${request.sealMerkleRoot} != ${queuedMerkleRoot}.`,
        ),
        { code: 'PUBLISH_INTENT_STALE' },
      );
    }

    if (
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function'
    ) {
      const liveChainId = await this.chain.getEvmChainId();
      const liveKav10 = await this.chain.getKnowledgeAssetsLifecycleAddress();
      if (liveChainId !== seal.chainId) {
        throw new Error(
          `publishQueuedKnowledgeAssetVmPublish: seal binds chainId=${seal.chainId.toString()} but daemon ` +
            `is configured for chainId=${liveChainId.toString()}. Re-finalize the assertion against the target chain.`,
        );
      }
      if (liveKav10.toLowerCase() !== seal.kav10Address.toLowerCase()) {
        throw new Error(
          `publishQueuedKnowledgeAssetVmPublish: seal binds KAv10=${seal.kav10Address} but daemon ` +
            `is configured for KAv10=${liveKav10}.`,
        );
      }
    }

    const snapshotParts = await skolemizeKnowledgeAssetParts(
      publishOptions.quads.map((q) => ({ ...q, graph: '' })),
      (publishOptions.privateQuads ?? []).map((q) => ({ ...q, graph: '' })),
      { allowCanonicalSkolemTerms: true },
    );
    const snapshotQuads = snapshotParts.publicQuads;
    const snapshotPrivateQuads = snapshotParts.privateQuads;
    if (snapshotQuads.length === 0 && snapshotPrivateQuads.length === 0) {
      throw new Error(
        `No queued shared-memory snapshot quads for context graph ${request.contextGraphId} ` +
          `share operation ${request.shareOperationId}`,
      );
    }
    if (
      snapshotQuads.length !== seal.publicTripleCount
      || snapshotPrivateQuads.length !== seal.privateTripleCount
    ) {
      throw new Error(
        `Queued graph-scoped VM publish triple-count mismatch for ${graphScope.ual}: ` +
          `seal=${seal.publicTripleCount}/${seal.privateTripleCount}, ` +
          `snapshot=${snapshotQuads.length}/${snapshotPrivateQuads.length}`,
      );
    }
    const snapshotPrivateRoot = computePrivateRoot(snapshotPrivateQuads);
    const privateRootMatches = seal.privateMerkleRoot === undefined
      ? snapshotPrivateRoot === undefined
      : snapshotPrivateRoot !== undefined
        && seal.privateMerkleRoot.length === snapshotPrivateRoot.length
        && seal.privateMerkleRoot.every((byte, index) => byte === snapshotPrivateRoot[index]);
    if (!privateRootMatches) {
      throw new Error(`Queued graph-scoped VM publish private Merkle mismatch for ${graphScope.ual}`);
    }
    const snapshotMerkleRoot = computeFlatKCRoot(
      snapshotQuads,
      snapshotPrivateRoot ? [snapshotPrivateRoot] : [],
    );
    if (
      snapshotMerkleRoot.length !== seal.merkleRoot.length
      || !snapshotMerkleRoot.every((byte, index) => byte === seal.merkleRoot[index])
    ) {
      throw new Error(`Queued graph-scoped VM publish Merkle mismatch for ${graphScope.ual}`);
    }

    const pointerRes = await this.store.query(
      `SELECT ?vm ?kaNum WHERE { GRAPH <${metaGraph}> {
        OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
        OPTIONAL { <${lifecycleUri}> <${KA_ID_PRED}> ?kaNum }
      } } LIMIT 1`,
    );
    const stripLit = (v?: string) => v?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
    const pointerRow = pointerRes.type === 'bindings' ? pointerRes.bindings[0] : undefined;
    const vmCurrent = request.vmCurrentAssertion ?? stripLit(pointerRow?.['vm']);
    const stampedNumberStr = request.kaNumber ?? stripLit(pointerRow?.['kaNum']);

    if (graphScope.agentAddress.toLowerCase() !== seal.authorAddress.toLowerCase()) {
      throw new Error(
        `Queued graph-scoped seal author ${seal.authorAddress} does not match UAL author ${graphScope.agentAddress}`,
      );
    }
    if (
      stampedNumberStr !== undefined
      && stampedNumberStr !== ''
      && BigInt(stampedNumberStr) !== BigInt(graphScope.kaNumber)
    ) {
      throw new Error(
        `Queued lifecycle kaId number ${stampedNumberStr} does not match UAL number ${graphScope.kaNumber}`,
      );
    }
    const packedKaId =
      (BigInt(graphScope.agentAddress) << 96n)
      | BigInt(graphScope.kaNumber);
    if (seal.reservedKaId !== undefined && seal.reservedKaId !== packedKaId) {
      throw new Error(
        `Queued seal reservedKaId ${seal.reservedKaId} does not match UAL-derived kaId ${packedKaId}`,
      );
    }
    const sharedMemoryScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: {
        agentAddress: graphScope.agentAddress,
        kaNumber: BigInt(graphScope.kaNumber),
      },
    };

    const newMerkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);
    let result: PublishResult;
    const clearPublishedGraph = async (label: string): Promise<void> => {
      try {
        await publisher.clearPublishedKnowledgeAssetSwm(
          request.contextGraphId,
          sharedMemoryScope,
          request.subGraphName,
          ctx,
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to clear published SWM graph after confirmed queued ${label} of <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };
    const clearRemainingSharedMemory = async (): Promise<void> => {
      try {
        await publisher.clearRemainingSharedMemory(request.contextGraphId, request.subGraphName, ctx);
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to clear remaining SWM after confirmed queued publish of <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };
    const onChainCapable =
      typeof this.chain.getEvmChainId === 'function' &&
      typeof this.chain.getKnowledgeAssetsLifecycleAddress === 'function';
    let queuedOnChainContextGraphId: string | undefined;

    if (vmCurrent && packedKaId !== undefined) {
      const updateAttestation = await this._buildPrecomputedUpdateAttestationForSeal(
        packedKaId,
        seal,
        publisher,
      );
      result = await this.update(
        packedKaId,
        request.contextGraphId,
        snapshotQuads,
        snapshotPrivateQuads,
        {
          operationCtx: ctx,
          onPhase: opts?.onPhase ?? publishOptions.onPhase,
          precomputedUpdateAttestation: updateAttestation,
          publisherOverride: publisher,
          subGraphName: request.subGraphName,
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: graphScope.ual,
          assertionVersion: graphScope.assertionVersion,
          publicTripleCount: seal.publicTripleCount,
          ...(snapshotPrivateRoot ? { privateMerkleRoot: snapshotPrivateRoot } : {}),
          privateTripleCount: seal.privateTripleCount,
        },
      );

      if (result.status === 'confirmed') {
        await clearPublishedGraph('update');
        if (request.clearSharedMemoryAfter === true) {
          await clearRemainingSharedMemory();
        }
      }

      if (result.status === 'confirmed') {
        try {
          const priorBare = vmCurrent.startsWith('0x') ? vmCurrent.slice(2) : vmCurrent;
          const priorUri = `${lifecycleUri}#assertion-${priorBare}`;
          await this._stampPointer(lifecycleUri, VM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
          await this._stampPointerIfDivergedFromVm(lifecycleUri, WM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
          await this.store.insert([
            { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasRevisionOf', object: priorUri, graph: metaGraph },
            { subject: priorUri, predicate: VM_CURRENT_ASSERTION_PRED, object: `"${priorBare}"`, graph: metaGraph },
          ]);
        } catch (err) {
          this.log.warn(
            ctx,
            `Failed to stamp queued update provenance for <${lifecycleUri}>: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } else {
      const recoveredReservedKaId = seal.reservedKaId ?? packedKaId;
      if (recoveredReservedKaId === undefined && onChainCapable) {
        throw new Error(
          `publishQueuedKnowledgeAssetVmPublish: cannot recover the reservedKaId for <${assertionUri}>. ` +
            `Re-finalize the assertion before publishing asynchronously.`,
        );
      }
      const queuedSnapshotOnChainContextGraphId = normalizeOptionalContextGraphId(publishOptions.publishContextGraphId);
      if (onChainCapable) {
        try {
          queuedOnChainContextGraphId = normalizeOptionalContextGraphId(
            await this.getContextGraphOnChainId(request.contextGraphId),
          ) ?? queuedSnapshotOnChainContextGraphId;
        } catch (err) {
          if (!queuedSnapshotOnChainContextGraphId) throw err;
          this.log.warn(
            ctx,
            `Could not verify queued on-chain cgId ${queuedSnapshotOnChainContextGraphId} for "${request.contextGraphId}" ` +
              `before async VM publish; using the immutable queued snapshot binding: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
          queuedOnChainContextGraphId = queuedSnapshotOnChainContextGraphId;
        }
      }
      if (onChainCapable && !queuedOnChainContextGraphId) {
        throw Object.assign(
          new Error(`Context graph "${request.contextGraphId}" is not registered on-chain.`),
          { code: 'CG_NOT_REGISTERED' },
        );
      }
      const publisherPublishOptions = { ...publishOptions };
      delete publisherPublishOptions.publishContextGraphId;
      const publishBindingOptions = queuedOnChainContextGraphId
        ? { aeadBindingContextGraphId: queuedOnChainContextGraphId }
        : undefined;
      const resolvedEncryptInlinePayload = await this._resolveEncryptInlinePayload(
        request.contextGraphId,
        request.subGraphName,
        undefined,
        undefined,
        publishBindingOptions,
      );
      const resolvedEncryptInlineChunked = await this._resolveEncryptInlineChunked(
        request.contextGraphId,
        request.subGraphName,
        undefined,
        undefined,
        publishBindingOptions,
      );
      // #1670 — finalized private assertions seal the deterministic public
      // catalog floor, but assertionPromote deliberately keeps that synthetic
      // root out of the per-user-root immutable share snapshot. The synchronous
      // named-KA path reconstructs the floor in SWM before publishing; queued
      // execution must do the same from deterministic inputs. Without it the
      // publisher has no catalog commitment/staging bytes, so cores fall back to
      // their (intentionally absent) curated SWM copy and decline NO_DATA_IN_SWM.
      //
      // The queued preparation boundary requires both a verified on-chain CG binding
      // and a live curated-policy encryption result. That keeps local-only and
      // public CGs untouched and prevents queued mapper placeholders from
      // manufacturing trusted catalog triples. The shared preparation boundary performs exact-key
      // de-duplication for legacy snapshots and returns the trust allow-list
      // with the quads so queued/update/sync paths cannot drift independently.
      const queuedPublishPreparation = prepareQueuedKnowledgeAssetVmPublishOptions({
        contextGraphId: request.contextGraphId,
        snapshotQuads,
        onChainContextGraphId: queuedOnChainContextGraphId,
        resolvedEncryptInlinePayload,
        resolvedEncryptInlineChunked,
        queuedEncryptInlinePayload: publishOptions.encryptInlinePayload,
        queuedEncryptInlineChunked: publishOptions.encryptInlineChunked,
      });
      result = await publisher.publish({
        ...publisherPublishOptions,
        contextGraphId: request.contextGraphId,
        quads: queuedPublishPreparation.quads,
        privateQuads: snapshotPrivateQuads.length > 0 ? snapshotPrivateQuads : undefined,
        publisherPeerId: publishOptions.publisherPeerId ?? this.peerId,
        subGraphName: request.subGraphName,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: graphScope.ual,
        assertionVersion: graphScope.assertionVersion,
        publicTripleCount: seal.publicTripleCount,
        ...(snapshotPrivateRoot ? { privateMerkleRoot: snapshotPrivateRoot } : {}),
        privateTripleCount: seal.privateTripleCount,
        operationCtx: ctx,
        onPhase: opts?.onPhase ?? publishOptions.onPhase,
        skipContextGraphEnsure: true,
        v10ACKProvider: publishOptions.v10ACKProvider ?? this.createV10ACKProvider(request.contextGraphId),
        publishEpochs: request.publishEpochs ?? publishOptions.publishEpochs,
        publisherNodeIdentityIdOverride: request.publisherNodeIdentityIdOverride !== undefined
          ? BigInt(request.publisherNodeIdentityIdOverride)
          : publishOptions.publisherNodeIdentityIdOverride,
        precomputedAttestation: {
          expectedMerkleRoot: seal.merkleRoot,
          authorAddress: seal.authorAddress,
          signature: { r: seal.authorAttestationR, vs: seal.authorAttestationVS },
          schemeVersion: seal.authorSchemeVersion,
          reservedKaId: recoveredReservedKaId ?? 0n,
        },
        onChainContextGraphId: queuedOnChainContextGraphId,
        encryptInlinePayload: queuedPublishPreparation.encryptInlinePayload,
        encryptInlineChunked: queuedPublishPreparation.encryptInlineChunked,
        ...(queuedPublishPreparation.trustedNonManifestCatalogTriples
          ? {
              trustedNonManifestCatalogTriples:
                queuedPublishPreparation.trustedNonManifestCatalogTriples,
            }
          : {}),
      });

      if (result.status === 'confirmed' && result.onChainResult) {
        try {
          await this._writeQueuedKnowledgeAssetVmPublishReceipt(
            request,
            result.onChainResult.txHash ?? '',
            result.onChainResult.blockNumber ?? 0,
            seal.reservedKaId ?? result.onChainResult.kaId ?? result.onChainResult.batchId ?? 0n,
          );
        } catch (err) {
          this.log.warn(
            ctx,
            `Failed to write publish receipt for <${assertionUri}>: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      if (result.status === 'confirmed') {
        await clearPublishedGraph('publish');
        if (request.clearSharedMemoryAfter === true) {
          await clearRemainingSharedMemory();
        }
      }
    }

    if (result.status === 'confirmed') {
      try {
        await this._stampQueuedKnowledgeAssetVmPublishedLifecycle(
          request,
          result.ual,
          packedKaId ?? seal.reservedKaId ?? result.onChainResult?.kaId ?? result.kaId,
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to stamp queued VM lifecycle marker for <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities: string[] = [];
      const broadcastCgId = queuedOnChainContextGraphId ?? (onChainCapable
        ? normalizeOptionalContextGraphId(await this.getContextGraphOnChainId(request.contextGraphId))
        : undefined);
      const keepRootCopyOnLabel = true;
      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        contextGraphId: request.contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        txIndex: result.onChainResult.txIndex ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities,
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        targetContextGraphId: result.contextGraphError ? undefined : broadcastCgId,
        subGraphName: request.subGraphName,
        keepRootCopyOnLabel,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        assertionVersion: graphScope.assertionVersion,
        publicTripleCount: seal.publicTripleCount,
        ...(snapshotPrivateRoot ? { privateMerkleRoot: snapshotPrivateRoot } : {}),
        privateTripleCount: seal.privateTripleCount,
        accessPolicy: result.accessPolicy ?? 'ownerOnly',
        allowedPeers: result.allowedPeers ?? [],
      };
      const topic = contextGraphFinalizationTopic(request.contextGraphId);
      try {
        await this.gossip.publish(topic, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast queued finalization for ${result.ual} to ${topic}${broadcastCgId ? ` (contextGraph=${broadcastCgId})` : ''}`);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }

      try {
        const gm = new GraphManager(this.store);
        const wsMetaGraph = request.subGraphName
          ? gm.sharedMemoryMetaUri(request.contextGraphId, request.subGraphName)
          : contextGraphWorkspaceMetaGraphUri(request.contextGraphId);
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

    if (result.status === 'confirmed') {
      try {
        await publisher.clearSwmShareComplete(request.contextGraphId, request.name, agentAddress, request.subGraphName);
      } catch (err) {
        this.log.warn(
          ctx,
          `Failed to clear swmShareComplete after queued publish of <${lifecycleUri}>: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return { ...result, assertionUri, seal };
  }

  async publishFromFinalizedAssertion(this: DKGAgent,
    contextGraphId: string,
    name: string,
    opts?: {
      subGraphName?: string;
      agentAddress?: string;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      publisherNodeIdentityIdOverride?: bigint;
      publishEpochs?: number;
      clearSharedMemoryAfter?: boolean;
      publisherOverride?: DKGPublisher;
    },
  ): Promise<PublishResult & { assertionUri: string; seal: AssertionSeal }> {
    const agentAddress = opts?.agentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const publisher = opts?.publisherOverride ?? this.publisher;
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
    if (seal.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new LegacyKnowledgeAssetReadOnlyError();
    }
    if (
      seal.kaUal === undefined
      || seal.assertionVersion === undefined
      || seal.publicTripleCount === undefined
    ) {
      throw new Error(`Graph-scoped assertion seal for <${assertionUri}> is incomplete`);
    }
    const graphScope = createGraphKnowledgeAssetScope(
      seal.kaUal,
      seal.assertionVersion,
    );

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

    // #1116 (round 9, reviewer 🔴 #1/#2) — MARKER GATE. A valid seal is no longer
    // SUFFICIENT to publish: it must be backed by a LIVE complete full share
    // resident in SWM (the swmShareComplete marker). This closes the whole
    // seal-staleness class at the consumer: a stale full seal that survived a
    // subset re-share (subset never re-seals) or an already-consumed share
    // (confirmed publish drains SWM + clears the marker, round 9 step 3) would
    // otherwise be publishable via the merkle-still-matches path under the KA
    // name. Placed AFTER the seal-read (so a genuinely-unfinalized asset still
    // throws "is not finalized" — preserving that precondition) and BEFORE the
    // create-vs-update routing + SWM gather, so it covers BOTH the MINT and UPDATE
    // paths. A legitimate full-share publish has the marker (assertionPromote set
    // it on the full share); an UPDATE re-publish re-sets it via the required
    // re-promote (a confirmed publish drained SWM, so a re-publish MUST re-share).
    if (!(await publisher.hasSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName))) {
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" in context graph "${contextGraphId}": it is not a complete full share ` +
            `resident in Shared Memory (a subset/partial share, an explicitly-unsealed share, or an ` +
            `already-consumed/published share). Seal and share the full asset (entities:"all") before publishing.`,
        ),
        { code: 'PUBLISH_NOT_FULL_SHARE' },
      );
    }

    // Merge note (PR #1107 ← main): #1097's "auto-promote a sealed-but-unstaged
    // assertion before publish" was dropped here. main reworked the memory
    // model so that publishing a finalized-but-unshared assertion is an
    // explicit caller precondition — `publishFromFinalizedAssertion` surfaces
    // the actionable "No quads in shared memory" error and the vm/publish route
    // maps it to a clean 409 VM_PUBLISH_PRECONDITION (see
    // packages/cli/test/knowledge-assets-route.test.ts). Auto-promoting here
    // defeats that precondition (it stages the data, so the publish proceeds
    // instead of returning 409), so main's explicit share→publish contract
    // supersedes the PR's auto-promote approach to the same issue.

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

    if (graphScope.agentAddress.toLowerCase() !== seal.authorAddress.toLowerCase()) {
      throw new Error(
        `Graph-scoped seal author ${seal.authorAddress} does not match UAL author ${graphScope.agentAddress}`,
      );
    }
    const packedKaId =
      (BigInt(graphScope.agentAddress) << 96n)
      | BigInt(graphScope.kaNumber);
    if (
      stampedNumberStr !== undefined
      && stampedNumberStr !== ''
      && BigInt(stampedNumberStr) !== BigInt(graphScope.kaNumber)
    ) {
      throw new Error(
        `Lifecycle kaId number ${stampedNumberStr} does not match graph-scoped UAL number ${graphScope.kaNumber}`,
      );
    }
    const newMerkleHexBare = ethers.hexlify(seal.merkleRoot).slice(2);
    const recoveredReservedKaId = seal.reservedKaId ?? packedKaId;
    if (recoveredReservedKaId !== packedKaId) {
      throw new Error(
        `Graph-scoped seal reservedKaId ${recoveredReservedKaId} does not match UAL-derived kaId ${packedKaId}`,
      );
    }
    const sharedMemoryScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: {
        agentAddress: graphScope.agentAddress,
        kaNumber: BigInt(graphScope.kaNumber),
      },
    };
    const scopedSwmQuads = await this._loadSelectedSWMQuads(
      contextGraphId,
      'all',
      opts?.subGraphName,
      sharedMemoryScope,
    );
    const privateStore = new PrivateContentStore(this.store, new GraphManager(this.store));
    const scopedPrivateQuads = await privateStore.getKnowledgeAssetPrivateTriples(
      contextGraphId,
      graphScope,
      opts?.subGraphName,
    );
    if (scopedSwmQuads.length === 0 && scopedPrivateQuads.length === 0) {
      throw new Error(
        `No quads in shared memory for context graph ${contextGraphId} matching graph-scoped ` +
          `KA ${graphScope.ual} (neither public nor private content is present)`,
      );
    }
    const canonicalParts = await skolemizeKnowledgeAssetParts(
      scopedSwmQuads,
      scopedPrivateQuads,
      { allowCanonicalSkolemTerms: true },
    );
    const canonicalSwmQuads = canonicalParts.publicQuads;
    const canonicalPrivateQuads = canonicalParts.privateQuads;
    if (canonicalSwmQuads.length !== seal.publicTripleCount) {
      throw new Error(
        `Graph-scoped SWM triple count mismatch for ${graphScope.ual}: ` +
          `seal=${seal.publicTripleCount}, store=${canonicalSwmQuads.length}`,
      );
    }
    if (canonicalPrivateQuads.length !== seal.privateTripleCount) {
      throw new Error(
        `Graph-scoped private triple count mismatch for ${graphScope.ual}: ` +
          `seal=${seal.privateTripleCount}, store=${canonicalPrivateQuads.length}`,
      );
    }
    const privateMerkleRoot = computePrivateRoot(canonicalPrivateQuads);
    const privateRootMatches = seal.privateMerkleRoot === undefined
      ? privateMerkleRoot === undefined
      : privateMerkleRoot !== undefined
        && seal.privateMerkleRoot.length === privateMerkleRoot.length
        && seal.privateMerkleRoot.every((byte, index) => byte === privateMerkleRoot[index]);
    if (!privateRootMatches) {
      throw new Error(
        `Graph-scoped private Merkle root mismatch for ${graphScope.ual}: ` +
          `seal=${seal.privateMerkleRoot ? ethers.hexlify(seal.privateMerkleRoot) : '(none)'}, ` +
          `store=${privateMerkleRoot ? ethers.hexlify(privateMerkleRoot) : '(none)'}`,
      );
    }
    const swmMerkleRoot = computeFlatKCRoot(
      canonicalSwmQuads,
      privateMerkleRoot ? [privateMerkleRoot] : [],
    );
    if (
      swmMerkleRoot.length !== seal.merkleRoot.length
      || !swmMerkleRoot.every((byte, index) => byte === seal.merkleRoot[index])
    ) {
      throw new Error(
        `Graph-scoped SWM Merkle root mismatch for ${graphScope.ual}: ` +
          `seal=${ethers.hexlify(seal.merkleRoot)}, store=${ethers.hexlify(swmMerkleRoot)}`,
      );
    }

    let result: PublishResult;
    if (vmCurrent) {
      // ── UPDATE PATH ──
      // The name already has a confirmed VM version. Reuse its kaId and call
      // the on-chain update primitive. The publisher's update path recomputes
      // the merkle from the SWM-selected quads and requires a
      // precomputedUpdateAttestation over (kaId, newMerkleRoot, author); we
      // mint it here from the seal's merkle using the seal's author signer.
      const updateQuads = canonicalSwmQuads;
      const updateAttestation = await this._buildPrecomputedUpdateAttestationForSeal(
        packedKaId,
        seal,
        publisher,
      );
      result = await this.update(
        packedKaId,
        contextGraphId,
        updateQuads.map((q) => ({ ...q, graph: '' })),
        canonicalPrivateQuads.map((q) => ({ ...q, graph: '' })),
        {
          operationCtx: opts?.operationCtx,
          onPhase: opts?.onPhase,
          precomputedUpdateAttestation: updateAttestation,
          publisherOverride: publisher,
          subGraphName: opts?.subGraphName,
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: graphScope.ual,
          assertionVersion: graphScope.assertionVersion,
          publicTripleCount: seal.publicTripleCount,
          ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
          privateTripleCount: seal.privateTripleCount,
        },
      );

      // #1099: the update primitive (`publisher.update`) has no SWM-drain of
      // its own — only the mint path's `publishFromSharedMemory` cleans SWM
      // after chain confirmation. Without this, every edit-loop update left
      // the re-shared SWM copy in place forever (locally AND on every replica
      // that mirrored the share), so SWM and VM permanently disagreed.
      if (result.status === 'confirmed') {
        try {
          await publisher.clearPublishedKnowledgeAssetSwm(
            contextGraphId,
            sharedMemoryScope,
            opts?.subGraphName,
            opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          );
        } catch (err) {
          this.log.warn(
            opts?.operationCtx ?? createOperationContext('publishFromSWM'),
            `Failed to clear SWM after confirmed update of <${lifecycleUri}>: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }

      // Stamp UPDATE provenance + re-stamp VM/WM pointers to the new merkle.
      if (result.status === 'confirmed' || result.status === 'tentative') {
        try {
          const priorBare = vmCurrent.startsWith('0x') ? vmCurrent.slice(2) : vmCurrent;
          const priorUri = `${lifecycleUri}#assertion-${priorBare}`;
          // Re-point VM to the new merkle (drop-then-set), then record the
          // revision chain via prov:wasRevisionOf <prior>. RFC ka-metadata-trim
          // Phase 2: WM converges back to VM after the update mint, so the
          // divergence-only stamp DELETES any stale WM row instead of
          // duplicating the new merkle (readers COALESCE missing wm → vm).
          await this._stampPointer(lifecycleUri, VM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
          await this._stampPointerIfDivergedFromVm(lifecycleUri, WM_CURRENT_ASSERTION_PRED, newMerkleHexBare, metaGraph);
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
      // §F2 / OT-RFC-43 A2 — recover the packed id the seal's signature
      // committed to: prefer the persisted seal.reservedKaId, else the
      // lifecycle-URN kaId re-packed above. Both are undefined only for a
      // legacy seal that predates the §F2 binding AND was never stamped with a
      // lifecycle kaId.
      // #1116 (round 5) — no-data preflight BEFORE the inner publisher's
      // CG-not-registered guard. `publishFromSharedMemory` checks registration
      // (throws CG_NOT_REGISTERED) BEFORE its own no-quads check, so an
      // UNregistered CG + valid seal + EMPTY sealed SWM would surface
      // CG_NOT_REGISTERED first — the /vm/publish route then auto-registers
      // (burning mint gas) and only the retry hits the no-quads 409. The legacy
      // memory.ts publish path had a SWM preflight to avoid exactly this; mirror
      // it here so the no-data precondition fires for ALL callers regardless of
      // registration. Match the publisher's wording so the route's existing 409
      // mapping (/No quads in shared memory/) still applies.
      result = await this.publishFromSharedMemory(
        contextGraphId,
        'all',
        {
          operationCtx: opts?.operationCtx,
          onPhase: opts?.onPhase,
          subGraphName: opts?.subGraphName,
          publisherNodeIdentityIdOverride: opts?.publisherNodeIdentityIdOverride,
          publishEpochs: opts?.publishEpochs,
          reservedKaId: recoveredReservedKaId,
          sharedMemoryScope,
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: graphScope.ual,
          assertionVersion: graphScope.assertionVersion,
          publicTripleCount: seal.publicTripleCount,
          ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
          privateTripleCount: seal.privateTripleCount,
          // Wired through to the inner publisher.publish() via
          // publishFromSharedMemory's `precomputedAttestation` option.
          // Skips the publisher's signing entirely.
          precomputedAttestation: {
            expectedMerkleRoot: seal.merkleRoot,
            authorAddress: seal.authorAddress,
            signature: { r: seal.authorAttestationR, vs: seal.authorAttestationVS },
            schemeVersion: seal.authorSchemeVersion,
            // §F2 — the exact packed id the seal's signature committed to. The
            // throw above guarantees this is defined whenever the publish is
            // going on-chain; the `?? 0n` only survives for mock/no-chain runs
            // where it is never submitted.
            reservedKaId: recoveredReservedKaId ?? 0n,
          },
          publisherOverride: publisher,
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

    // Exact scope owns published-root cleanup. A caller's explicit request to
    // clear every remaining share is a separate family-wide destructive action
    // that runs only after a confirmed publish/update.
    if (result.status === 'confirmed' && opts?.clearSharedMemoryAfter === true) {
      await publisher.clearRemainingSharedMemory(
        contextGraphId,
        opts?.subGraphName,
        opts?.operationCtx ?? createOperationContext('publishFromSWM'),
      );
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
            { subject: subj, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
          ]);
        }
        await this.store.deleteByPattern({ subject: lifecycleUri, predicate: STATE_PRED, graph: metaGraph });
        await this.store.insert([
          { subject: lifecycleUri, predicate: STATE_PRED, object: '"published"', graph: metaGraph },
        ]);
        // #1104: reconcile the KA's dual identity. `dkg:reservedUal`
        // (chain/author/kaNumber, stamped at finalize) and the published
        // UAL (chain/contract/tokenId, returned by vm/publish) are both
        // permanent — record the published UAL on the lifecycle URN
        // (drop-then-set, so updates re-point to the latest published UAL).
        //
        // Merge note (PR #1107 ← main): #1095's separate `published`
        // prov:Activity EVENT minting was dropped here — main's RFC
        // ka-metadata-trim deliberately removed `generateAssertionPublishedMetadata`,
        // and main already stamps `dkg:state="published"` above (which
        // `deriveStatus` maps to `vm-confirmed`), so the lifecycle STATE fix
        // #1095 targeted is satisfied without the trimmed event entity.
        if (result.ual) {
          try {
            const PUBLISHED_UAL_PRED = 'http://dkg.io/ontology/publishedUal';
            await this.store.deleteByPattern({ subject: lifecycleUri, predicate: PUBLISHED_UAL_PRED, graph: metaGraph });
            await this.store.insert([
              { subject: lifecycleUri, predicate: PUBLISHED_UAL_PRED, object: `"${result.ual}"`, graph: metaGraph },
            ]);
          } catch (err) {
            this.log.warn(
              opts?.operationCtx ?? createOperationContext('publishFromSWM'),
              `Failed to record publishedUal for <${lifecycleUri}>: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        // SUBSTRATE-2 — re-point dkg:assertionGraph to the per-KA verifiable-
        // memory graph this publish actually wrote
        // (…/_verifiable_memory/{author}/{number}). promote() left the pointer on
        // the SWM graph, which the post-confirm SWM cleanup then empties — so
        // without this re-stamp the _meta index follows a stale pointer to an
        // empty graph instead of the live VM data. Mirrors the wm→swm re-stamp
        // in generateAssertionPromotedMetadata, for the swm→vm transition. The
        // graph URI is derived from the minted kaId exactly as the data write
        // (publishFromSharedMemory at dkg-publisher.ts: VerifiableMemory layer,
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
          // Derive the VM graph URI from the packed KA id (author<<96 | number)
          // that named the …/_verifiable_memory/{author}/{number} graph. Prefer
          // the finalize-reserved id we threaded down as `reservedKaId`, then an
          // explicit on-chain `kaId` if the adapter reports one. Only fall back
          // to `result.kaId` for legacy/no-chain shapes. Do NOT use
          // `onChainResult.batchId`: on some adapters batchId is batch metadata,
          // not the packed KA id.
          const vmKaId = packedKaId ?? result.onChainResult.kaId ?? result.kaId;
          if (vmKaId !== undefined && vmKaId !== null) {
            const vmKaIdBig = BigInt(vmKaId);
            const vmAuthor = '0x' + (vmKaIdBig >> 96n).toString(16).padStart(40, '0');
            const vmNumber = vmKaIdBig & ((1n << 96n) - 1n);
            const vmGraph = contextGraphLayerUri(contextGraphId, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber, opts?.subGraphName);
            await this.store.deleteByPattern({ subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, graph: metaGraph });
            await this.store.insert([
              { subject: lifecycleUri, predicate: ASSERTION_GRAPH_PRED, object: vmGraph, graph: metaGraph },
            ]);
            // RFC ka-metadata-trim Phase 2 (corrected by adversarial review
            // F4) — WM-graph marker flip at the VM transition.
            // `assertionCreate` stamps `<wmGraph> dkg:memoryLayer "WM"` on the
            // per-KA number-keyed WM graph URI (assertionPromote flips it in
            // place to "SWM"). The flip above only covers the lifecycle URN
            // and the legacy name-keyed assertion URI; the data-graph-URI
            // marker would otherwise read "SWM" forever — misleading, since
            // the data now lives at VM. We UPDATE it to "VM" rather than
            // DELETE it: `assertAssertionDataPersisted` (dkg-publisher.ts)
            // reads this exact row as its "already promoted → harmless no-op"
            // witness, so deleting it would make a stale re-promote after a
            // successful publish misfire AssertionNotPersistedError when the
            // preserved extraction markers are present (Codex #898 case).
            // Any non-"WM" value short-circuits that guard, so "VM" keeps the
            // no-op witness AND tells the truth about the layer.
            const wmGraph = contextGraphLayerUri(contextGraphId, MemoryLayer.WorkingMemory, vmAuthor, vmNumber, opts?.subGraphName);
            await this.store.deleteByPattern({ subject: wmGraph, predicate: MEMORY_LAYER_PRED, graph: metaGraph });
            await this.store.insert([
              { subject: wmGraph, predicate: MEMORY_LAYER_PRED, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
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

    // #1116 (round 9, reviewer 🔴 #2) — a CONFIRMED publish CONSUMES the SWM full
    // share: the mint path (publishFromSharedMemory) and the update path both
    // DRAIN the published roots from SWM after on-chain confirmation. The
    // swmShareComplete marker asserts "a complete full share is resident in SWM",
    // which no longer holds once SWM is drained. Clear it (best-effort, after the
    // chain commit) so a post-publish finalize(layer:"swm") can't pass the gate
    // against an empty SWM, and the next publish requires a fresh full share (which
    // re-sets the marker via assertionPromote). Covers BOTH MINT and UPDATE.
    if (result.status === 'confirmed') {
      try {
        await publisher.clearSwmShareComplete(contextGraphId, name, agentAddress, opts?.subGraphName);
      } catch (err) {
        this.log.warn(
          opts?.operationCtx ?? createOperationContext('publishFromSWM'),
          `Failed to clear swmShareComplete after confirmed publish of <${lifecycleUri}>: ` +
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
    publisherOverride?: DKGPublisher,
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
      const publisher = publisherOverride ?? this.publisher;
      const fallbackAddress = await publisher.publisherFallbackAuthorAddress();
      if (!fallbackAddress || fallbackAddress.toLowerCase() !== seal.authorAddress.toLowerCase()) {
        throw new Error(
          `publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation for author ` +
            `${seal.authorAddress} — no custodial key on file and it is not the publisher EOA. ` +
            `Use the /api/update route with a pre-signed UpdateAuthorAttestation instead.`,
        );
      }
      const compact = await publisher.signAuthorAttestationAsPublisher(typedData);
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
   * RFC ka-metadata-trim Phase 2 — divergence-only wm/swm pointer stamp.
   * `dkg:vmCurrentAssertion` is always materialised; the wm/swm pointers are
   * only written when they DIVERGE from the current VM value (the common
   * "all three equal" steady state is implicit). When the new value equals
   * VM, any prior row for `pred` is deleted instead (drop-then-skip), so a
   * stale divergent pointer never lingers. Readers COALESCE a missing wm/swm
   * to the vm value (see `agent.assertion.history()`), which also keeps
   * old-store rows (always materialised) readable unchanged.
   */
  async _stampPointerIfDivergedFromVm(
    this: DKGAgent,
    lifecycleUri: string,
    pred: string,
    merkleHex: string,
    metaGraph: string,
  ): Promise<void> {
    const bare = merkleHex.startsWith('0x') ? merkleHex.slice(2) : merkleHex;
    let vmBare: string | undefined;
    try {
      const res = await this.store.query(
        `SELECT ?vm WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm } } LIMIT 1`,
      );
      const raw = res.type === 'bindings' ? res.bindings[0]?.['vm'] : undefined;
      vmBare = raw?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
    } catch {
      // On a failed VM read fall back to the always-write behaviour below —
      // an extra convergent row is harmless (readers COALESCE), a missing
      // divergent row is not.
    }
    if (vmBare !== undefined && vmBare === bare) {
      await this.store.deleteByPattern({ subject: lifecycleUri, predicate: pred, graph: metaGraph });
      return;
    }
    await this._stampPointer(lifecycleUri, pred, bare, metaGraph);
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
      // RFC ka-metadata-trim Phase 2: divergence-only — a re-promote of
      // already-published content (swm == vm) materialises no row; readers
      // COALESCE a missing swm pointer to vm.
      await this._stampPointerIfDivergedFromVm(lifecycleUri, SWM_CURRENT_ASSERTION_PRED, merkleHexBare, metaGraph);
    } catch (err) {
      this.log.warn(
        createOperationContext('share'),
        `Failed to stamp swmCurrentAssertion for "${name}" in "${contextGraphId}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * OT-RFC-49 — ensure a curated CG's public `_catalog` floor projection is in
   * the SWM before a from-SWM publish that bypassed `assertionFinalize`.
   *
   * Mirrors the finalize-path injection (`assertionFinalize`): the catalog
   * subject is `contextGraphDataUri(contextGraphId)` — the EXACT subject the
   * publisher's `partitionCatalogQuads` matches — and the floor quads come from
   * the SAME preparation helper as queued publish and update, so the committed
   * catalog and exact trust allow-list cannot drift across those paths.
   *
    * IDEMPOTENT: repeated insertion dedupes in the store/V10 Merkle path because
    * the floor is deterministic, so `catalogLeafCount` stays stable across
    * finalize-path and direct from-SWM publishes.
   *
   * Returns a possibly-extended `selection`: for a `{rootEntities}` publish the
   * CG-DID catalog subject is appended so it is in scope for BOTH the author seal
   * (`_loadSelectedSWMQuads`) and the publisher's reload — which scope identically.
   * For `selection: 'all'` the selection is returned unchanged (both already read
   * the whole SWM graph). The generated floor is written into the same explicit
   * graph scope as the publish; otherwise an exact named-lifecycle read would
   * correctly exclude a floor left in the legacy bucket.
   */
  async _ensureCuratedCatalogInSwm(this: DKGAgent,
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    subGraphName: string | undefined,
    ctx: OperationContext,
    scope: SharedMemoryGraphScope = { kind: 'complete-family' },
  ): Promise<'all' | { rootEntities: string[] }> {
    const swmGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
    const catalogTargetGraph = canonicalSharedMemoryScopeWriteGraph(swmGraph, scope);
    const cgDid = contextGraphDataUri(contextGraphId);
    const { quads: catalogQuads } = appendMissingGeneratedPrivateCatalogFloor(
      contextGraphId,
      [],
      catalogTargetGraph,
    );
    await this.store.insert(catalogQuads);
    this.log.info(
      ctx,
      `OT-RFC-49: ensured ${catalogQuads.length}-quad public _catalog floor in SWM for curated CG ${contextGraphId} (from-SWM publish without finalize)`,
    );
    if (selection !== 'all' && !selection.rootEntities.includes(cgDid)) {
      return { rootEntities: [...selection.rootEntities, cgDid] };
    }
    return selection;
  }

  /**
   * Publish shared memory content: read from SWM graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * SWM state can promote it to canonical without re-downloading the full payload.
   *
   * #1116 (round 9) — INTENTIONALLY NOT marker-gated. This is the
   * "publish an arbitrary caller-selected SWM slice" internal escape hatch
   * retained for substrate mechanics (#1087): it mints a FRESH inline seal over the
   * selected slice rather than consuming a finalized named lifecycle, so the
   * swmShareComplete full-share invariant does not apply. The marker gate lives on
   * `publishFromFinalizedAssertion` (the named-lifecycle /vm/publish path) only.
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
      sharedMemoryScope?: SharedMemoryGraphScope;
      contentScopeVersion?: PublishOptions['contentScopeVersion'];
      kaUal?: PublishOptions['kaUal'];
      assertionVersion?: PublishOptions['assertionVersion'];
      publicTripleCount?: PublishOptions['publicTripleCount'];
      privateMerkleRoot?: PublishOptions['privateMerkleRoot'];
      privateTripleCount?: PublishOptions['privateTripleCount'];
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
      publisherOverride?: DKGPublisher;
    },
  ): Promise<PublishResult> {
   return withSpan('agent.publish_from_swm', async (span) => {
    const chainId = typeof this.chain?.chainId === 'string' && this.chain.chainId !== 'none' ? this.chain.chainId : undefined;
    const publishStartedAt = Date.now();
    // try/catch so a throw before the success metric is still counted as an
    // error outcome (see the direct-publish path for the rationale).
    try {
    span.setAttributes({
      'dkg.context_graph_id': contextGraphId,
      'dkg.selection': selection === 'all' ? 'all' : 'roots',
      ...(chainId ? { 'dkg.chain_id': chainId } : {}),
    });
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const effectiveSubCG = options?.subContextGraphId ?? options?.contextGraphId;
    // `ctxGraphIdStr` doubles as `publishContextGraphId` for REMAP-flow
    // publishes — the publisher uses its presence as a signal to DELETE the
    // original copy from the default data graph. Keep it empty for non-REMAP
    // publishes so we don't accidentally trigger the delete.
    const ctxGraphIdStr = effectiveSubCG != null ? String(effectiveSubCG) : undefined;

    const onChainId = ctxGraphIdStr ?? (await this.getContextGraphOnChainId(contextGraphId)) ?? undefined;

    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    // OT-RFC-49 — inject the public `_catalog` projection for a curated CG
    // publishing from raw SWM through the internal substrate shortcut that did
    // NOT go through `assertionFinalize` — which is what
    // normally injects the catalog. Without it the reloaded payload carries no
    // catalog, the on-chain catalog commitment stays zero, and the core ACK
    // falls back to SWM-lookup and DECLINEs `NO_DATA_IN_SWM`. Run BEFORE the
    // author seal below so the attestation's merkleRoot covers the catalog, and
    // idempotent so a finalize-path publish (where the catalog is already in SWM)
    // is unaffected. Gated on an on-chain id so a local-only publish gets nothing
    // spurious. Returns a possibly-extended selection so the CG-DID catalog
    // subject is in scope for a `{rootEntities}` publish too (the seal-read and
    // the publisher reload scope identically).
    const hasGeneratedPrivateCatalog = onChainId != null && (await this.isPrivateContextGraph(contextGraphId));
    const trustedNonManifestCatalogTriples = hasGeneratedPrivateCatalog
      ? generatedPrivateCatalogTripleKeys(contextGraphId)
      : undefined;
    if (hasGeneratedPrivateCatalog) {
      selection = await this._ensureCuratedCatalogInSwm(
        contextGraphId,
        selection,
        options?.subGraphName,
        ctx,
        options?.sharedMemoryScope,
      );
    }

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
        options?.sharedMemoryScope,
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
      ctxGraphIdStr,
      onChainId
        ? { aeadBindingContextGraphId: onChainId }
        : undefined,
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
      ctxGraphIdStr,
      onChainId
        ? { aeadBindingContextGraphId: onChainId }
        : undefined,
    );
    if (encryptInlineChunked) {
      this.log.info(ctx, `LU-11: curated CG ${contextGraphId} — chunked path active (per-chunk SWM gossip + V2 ACK)`);
    }

    const publisher = options?.publisherOverride ?? this.publisher;
    const result = await publisher.publishFromSharedMemory(contextGraphId, selection, {
      operationCtx: ctx,
      clearSharedMemoryAfter: options?.clearSharedMemoryAfter,
      onPhase: options?.onPhase,
      publishContextGraphId: ctxGraphIdStr,
      onChainContextGraphId: onChainId,
      contextGraphSignatures: options?.contextGraphSignatures,
      v10ACKProvider,
      publisherPeerId: this.peerId,
      trustedNonManifestCatalogTriples,
      subGraphName: options?.subGraphName,
      publisherNodeIdentityIdOverride: options?.publisherNodeIdentityIdOverride,
      publishEpochs: options?.publishEpochs,
      precomputedAttestation: resolvedSeal,
      // OT-RFC-43 A2 — reuse the finalize-stamped packed kaId (no re-allocate).
      reservedKaId: options?.reservedKaId,
      sharedMemoryScope: options?.sharedMemoryScope,
      contentScopeVersion: options?.contentScopeVersion,
      kaUal: options?.kaUal,
      assertionVersion: options?.assertionVersion,
      publicTripleCount: options?.publicTripleCount,
      privateMerkleRoot: options?.privateMerkleRoot,
      privateTripleCount: options?.privateTripleCount,
      encryptInlinePayload,
      encryptInlineChunked,
    });

    span.setAttribute('dkg.publish_status', result.status);
    if (result.status === 'failed') {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.addEvent('publish_failed', { error: String(result.contextGraphError ?? '') });
    }

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
        ...(options?.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION
          ? {
              contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
              assertionVersion: String(options.assertionVersion),
              publicTripleCount: options.publicTripleCount ?? 0,
              ...(options.privateMerkleRoot
                ? { privateMerkleRoot: options.privateMerkleRoot }
                : {}),
              privateTripleCount: options.privateTripleCount ?? 0,
              accessPolicy: result.accessPolicy ?? 'ownerOnly',
              allowedPeers: result.allowedPeers ?? [],
            }
          : {}),
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

    recordPublishOutcome(result.status, 'swm', publishStartedAt, chainId);

    return result;
    } catch (err) {
      recordPublishOutcome('error', 'swm', publishStartedAt, chainId);
      throw err;
    }
   });
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
