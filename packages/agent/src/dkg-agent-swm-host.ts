// SPDX-License-Identifier: Apache-2.0

/**
 * SWM host-mode subsystem extracted from dkg-agent.ts as a mixin holder:
 * host-mode store init/reconcile/wire, envelope + ciphertext-chunk ingest,
 * host-catchup + get-chunk request handlers, chain-ordinal VM reconcile, and
 * the catchup/enable/stats entrypoints. Bodies are a 1:1 move; methods take
 * `this: DKGAgent` so cross-calls resolve against the composed class.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, contextGraphLayerUri, assertionLifecycleUri, contextGraphAssertionUri,
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
  Logger, createOperationContext, getMetrics, sparqlString, isSafeIri, assertSafeIri,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  LEGACY_TRUST_LEVEL_PREDICATE,
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
import { GraphManager, PrivateContentStore, StoreSchedulerBusyError, asChangelogReader, asGraphWriteGenSource, createTripleStore, tryUpdateWithTouchedGraphs, type TripleStore, type TripleStoreConfig, type QueryOptions, type Quad, type LargeLiteralStorageConfig, type SelectResult } from '@origintrail-official/dkg-storage';
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
  readMaterializedVersion, shouldApplyMaterialization, withMaterializationLock,
  type MaterializedVersion,
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
import { buildReconciledKnowledgeAssetUal } from './ka-identity.js';
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
import {
  reconcileContextGraph,
  RecentUalSet,
  VmReconcileDispatcher,
  type ChainReconcilerDeps,
  type OrdinalOutcome,
  type PendingOrdinalRecoveryResult,
  type OrdinalRecoveryTarget,
} from './chain-reconciler.js';
import {
  ContextGraphOnChainIdUnresolvedError,
  VmReconcileUnavailableError,
  VmReconcileQueueClosedError,
  type ContextGraphReconcileResult,
  type VmReconcileSource,
} from './vm-reconcile-service.js';
import { createCursorState, type CursorState } from './reconcile-cursor.js';
import {
  enrichVmRecoveryFootprints,
  planVmRecoveryMicrobatch,
  VmRecoveryProviderPolicy,
  type VmRecoveryTargetFootprint,
  type VmRecoveryUalDisposition,
} from './vm-recovery-microbatch.js';
import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';
import {
  encodeExactAssetUals,
  MAX_EXACT_SYNC_ASSETS,
} from './sync/exact-assets.js';

function rsHealStoreOptions(operation: string, signal?: AbortSignal): QueryOptions {
  return {
    priority: 'background',
    source: `agent.swm.rsHeal.${operation}`,
    ...(signal ? { signal } : {}),
  };
}

function isStoreSchedulerBusyError(err: unknown): boolean {
  return err instanceof StoreSchedulerBusyError || (
    typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === 'STORE_SCHEDULER_BUSY'
  );
}

export type RsHealPassResult =
  | { status: 'completed'; inspected: number }
  | { status: 'skipped'; reason: 'not-current' | 'unsupported-store' | 'no-work' | 'invalid-result' | 'failed' }
  | { status: 'deferred'; reason: 'store-busy' };

async function readRsHealStrandedPage(
  store: TripleStore,
  legacyMeta: string,
  scopedMeta: string,
  dkgNamespace: string,
  cursor: string | undefined,
  batchSize: number,
  signal?: AbortSignal,
): Promise<SelectResult | null> {
  const result = await store.query(
    `SELECT ?ual ?b WHERE {
       GRAPH <${legacyMeta}> { ?ual <${dkgNamespace}batchId> ?b }
       FILTER(isIRI(?ual))
       FILTER NOT EXISTS {
         GRAPH <${scopedMeta}> {
           ?ual <${dkgNamespace}batchId> ?b ; <${dkgNamespace}materializedVersion> ?version
         }
       }
       ${cursor ? `FILTER(STR(?ual) > ${sparqlString(cursor)})` : ''}
     }
     ORDER BY STR(?ual)
     LIMIT ${batchSize}`,
    rsHealStoreOptions('enumerate', signal),
  );
  return result.type === 'bindings' ? result : null;
}

function advanceRsHealCursor(
  cursorMap: Map<string, string>,
  cursorKey: string,
  bindings: SelectResult['bindings'],
  batchSize: number,
  maxEntries: number,
): void {
  if (bindings.length === 0 || bindings.length < batchSize) {
    cursorMap.delete(cursorKey);
    return;
  }
  const lastUal = stripBindingQuotes(bindings[bindings.length - 1]?.['ual'] ?? '');
  if (!lastUal || !isSafeIri(lastUal)) {
    // The query constrains ?ual to an IRI, but fail open to a fresh scan rather
    // than pinning a corrupt cursor if an adapter returns malformed bindings.
    cursorMap.delete(cursorKey);
    return;
  }
  cursorMap.delete(cursorKey);
  cursorMap.set(cursorKey, lastUal);
  while (cursorMap.size > maxEntries) {
    const oldest = cursorMap.keys().next().value;
    if (oldest === undefined) break;
    cursorMap.delete(oldest);
  }
}

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
type VmReconcileSwmNamespace = { metaGraph: string; dataGraph: string };
type VmReconcileSwmCandidateNamespaces = { namespaces: VmReconcileSwmNamespace[]; complete: boolean };
type VmReconcileSwmCandidateState = {
  swmGen: string | null;
  candidateNamespaces: VmReconcileSwmNamespace[];
  peerTopologyKey: string;
};
import { multiaddr } from '@multiformats/multiaddr';
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import {
  stripLiteral, jsonLdToQuads,
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
  type VmReconcileRotationRecord,
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
import type {
  ContextGraphBindingTarget,
} from './context-graph-binding-state.js';

const DEFAULT_HOST_MODE_RECONCILE_BATCH_SIZE = 32;

type VmReconcileEngineResult = Awaited<ReturnType<typeof reconcileContextGraph>>;
type VmReconcileTargetBase = {
  sub: ContextGraphSub;
  onChainCgId: bigint;
  cursor: CursorState;
  watermarkBefore: number;
};
type VmReconcileTarget = VmReconcileTargetBase & ContextGraphBindingTarget;

type VmReconcileExecution = {
  identityCursor: CursorState;
  persistWatermark: (localCgId: string, watermark: number) => void;
};

type VmReconcileOrdinalOptions = {
  /** Shared by every ordinal in one bounded pass. */
  acquireActiveFetchPermit?: () => boolean;
  /** Cap peer rotations for the one batch fetch; omitted preserves legacy behavior. */
  maxPeerAttempts?: number;
  /** Re-check a captured local/on-chain binding around slow fetch work. */
  isTargetCurrent?: () => boolean;
  /** Collect the missing KA for one batch fetch instead of fetching inline. */
  deferActiveFetch?: boolean;
  /** Reuse the version-bound footprint captured by the initial inventory scan. */
  recoveryFootprint?: VmRecoveryChainFootprint;
};

/**
 * Max age (ms) of a cached `publishPolicy` value the host-mode self-signed
 * admission gate (`isConfirmedPublicForHostMode`) will trust. Deliberately
 * short: it bounds the open→curated downgrade staleness to a few seconds
 * (vs the general 60s `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS`) AND rate-caps the
 * chain RPC to ~1 per window per CG, so spammed public-plaintext gossip can't
 * amplify into a per-message `eth_call` (Branimir review #1239 follow-on).
 */
const HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS = 5_000;

// Exact VM data responses are page-only and capped at 64 rows per page. Keep
// one recovery microbatch near 64 non-empty pages so a single large graph does
// not monopolize the global sync admission. This is a soft scheduling/fairness
// cap, not a wire or correctness limit: an individually larger KA is still
// admitted alone and remains bounded by the exact executor's hard guards.
const VM_EXACT_MICROBATCH_PAGE_FAIRNESS_LEAVES = 4_096n;

const VM_EXACT_MICROBATCH_LIMITS = Object.freeze({
  // Executor capability: the current exact-sync envelope accepts at most ten.
  maxAssets: MAX_EXACT_SYNC_ASSETS,
  // Soft recovery-window targets. A single public KA may exceed either; it is
  // still admitted alone while the exact executor's own hard byte/quad guards
  // remain authoritative.
  targetBytes: 24n * 1024n * 1024n,
  targetLeaves: VM_EXACT_MICROBATCH_PAGE_FAIRNESS_LEAVES,
  fixedBytesPerAsset: 64n * 1024n,
  bytesPerLeafOverhead: 128n,
  byteSizeMultiplierBps: 11_500n,
  // Hard exact-selector cap, evaluated with the executor's real encoder.
  maxSelectorBytes: 16 * 1024,
});

function normalizeHostModeReconcileBatchSize(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HOST_MODE_RECONCILE_BATCH_SIZE;
  return Math.max(1, Math.floor(value));
}

/**
 * Strip surrounding quotes from a SPARQL SELECT binding value — mirrors
 * `ka-extractor.ts:stripQuotes` verbatim so the RS-heal resolves the SAME
 * `?ual`/`?root` strings the prover does. IRIs come back bare from both store
 * adapters (oxigraph/sparql-http), so this is a no-op for them; it only peels
 * the `"..."` / `"value"^^<dt>` literal wrappers some result formats apply.
 */
function stripBindingQuotes(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  const ix = v.indexOf('"^^');
  if (v.startsWith('"') && ix !== -1) {
    return v.slice(1, ix);
  }
  return v;
}

async function raceVmReconcileAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  void work.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VmReconcileQueueClosedError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export class SwmHostModeMethods extends DKGAgentBase {
  /**
   * OT-RFC-38 LU-6 — initialize the on-disk opaque ciphertext store
   * for hosting curated CG SWM substrate. No-op on edges and on
   * cores where the operator has explicitly opted out via
   * `config.swmHostMode.enabled === false`.
   */
  async initializeSwmHostModeStore(this: DKGAgent): Promise<void> {
    const role = this.config.nodeRole ?? 'edge';
    // OT-RFC-38 LU-6 — host mode is a CORE-NODE-ONLY capability:
    // it holds curated CG ciphertext on behalf of members and
    // serves it back over `PROTOCOL_SWM_HOST_CATCHUP`. Edges
    // have no role in that custody chain and shouldn't retain
    // other CGs' encrypted SWM substrate on disk. Hard-gate
    // here so a copied `core` config dropped onto an edge does
    // NOT accidentally turn it into a ciphertext relay
    // (Codex PR #610 R3).
    if (role !== 'core') return;
    const hostModeCfg = this.config.swmHostMode ?? {};
    const enabled = hostModeCfg.enabled ?? true;
    if (!enabled) return;
    if (!this.config.dataDir) {
      this.log.warn(
        createOperationContext('system'),
        'SWM host-mode requested but no dataDir configured — disk-backed store cannot be created; host-mode disabled',
      );
      return;
    }
    const defaults = SwmHostModeStore.defaultLimits();
    const { join } = await import('node:path');
    const swmHostStartupCtx = createOperationContext('share');
    this.swmHostModeStore = new SwmHostModeStore({
      dataDir: join(this.config.dataDir, 'swm-host'),
      unregisteredLimits: hostModeCfg.unregistered ?? defaults.unregistered,
      registeredLimits: hostModeCfg.registered ?? defaults.registered,
      // B2: surface the orphan-log reconcile report through the
      // agent's log facade so operators can see exactly how many
      // bytes were recovered after a crash.
      onStartupReconcile: ({ orphanLogsRemoved, orphanBytesRemoved }) => {
        this.log.warn(
          swmHostStartupCtx,
          `Host-mode startup reconcile reaped orphan logs: count=${orphanLogsRemoved} bytes=${orphanBytesRemoved} ` +
          `(crashed appendFile→persistMeta windows produce these — they were unservable + unprunable until now)`,
        );
      },
    });
    await this.swmHostModeStore.init();

    // OT-RFC-38 / LU-6 Phase B — sliding-window rate-limiter for
    // pre-registration ciphertext writes. Configurable via the
    // same `swmHostMode` config block so operators can dial limits
    // up/down for testnet vs mainnet. Defaults match SPEC §1.2.4.
    const rlCfg = hostModeCfg.discoveryRateLimit ?? {};
    this.discoveryRateLimit = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: rlCfg.perCuratorBytesPerMinute,
      perCuratorBytesPerHour: rlCfg.perCuratorBytesPerHour,
      coreAggregateBytes: rlCfg.coreAggregateBytes,
    });
    // Seed the per-core aggregate counter from on-disk unregistered
    // ciphertext so a restart doesn't reset the budget. Per-curator
    // windows intentionally cold-start (the abuse-control horizon
    // is "ongoing", not "lifetime").
    try {
      const stats = await this.swmHostModeStore.stats();
      let unregisteredBytesOnDisk = 0;
      for (const cgStats of Object.values(stats.perCg)) {
        if (!cgStats.registered) unregisteredBytesOnDisk += cgStats.bytes;
      }
      this.discoveryRateLimit.seedAggregate(unregisteredBytesOnDisk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(createOperationContext('system'), `Could not seed discovery rate-limit aggregate from disk: ${msg}`);
    }

    this.log.info(
      createOperationContext('system'),
      `SWM host-mode store initialized at ${join(this.config.dataDir, 'swm-host')} (role=${role})`,
    );

    // OT-RFC-38 LU-6 B3 — restore persisted host-mode subscriptions
    // BEFORE the chain-event poller starts. Chain events older than
    // the poller's lookback window would otherwise be silently lost
    // on restart, stranding CGs that the curator registered weeks
    // ago. The chain-event path + beacons remain the primary
    // mechanisms; this is the "we already knew about this CG before"
    // shortcut that keeps the per-restart re-derivation cheap.
    try {
      const previouslySubscribed = await this.swmHostModeStore.listHostModeSubscribedCgs();
      if (previouslySubscribed.length > 0) {
        // OT-RFC-49 WS-A — persisted host-mode subscriptions are curated by
        // construction (the curated check ran when each was first wired). With
        // the private-ciphertext strip ON (default) the restore loop must NOT
        // re-engage them: this path calls `wireSwmHostModeHandler` DIRECTLY and
        // so bypasses the subscribe-decline gate in
        // `reconcileSwmHostModeSubscription`. Skipping here closes the
        // restart-reintroduces-custody hole for cores that persisted host-mode
        // subs before the strip rolled out.
        if (this.swmHostModeStripCiphertext()) {
          this.log.info(
            createOperationContext('system'),
            `Skipping restore of ${previouslySubscribed.length} persisted host-mode subscription(s): ` +
            `private-ciphertext strip is ON (OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs)`,
          );
          return;
        }
        this.log.info(
          createOperationContext('system'),
          `Restoring ${previouslySubscribed.length} persisted host-mode subscription(s) from disk`,
        );
        for (const cgId of previouslySubscribed) {
          // Re-engage the gossip handler directly; we trust the
          // previous decision (the curated check ran when the
          // subscription was first wired). The chain-anchored
          // authority check on every envelope ingest still catches
          // revocations even if curator state has changed since.
          try {
            this.wireSwmHostModeHandler(cgId, SUBSCRIPTION_SOURCES.RECONCILER, true);
            // Codex PR #620 R2: also re-probe registration state.
            // Without this, a host-only CG that was registered while
            // the node was offline stays on the 1MiB / 6h pre-reg
            // limits after restart and can prune valid ciphertext
            // permanently — `GraphManager.listContextGraphs()` only
            // sees local store graphs, so the periodic reconciler
            // can't heal it later either.
            await this.maybeMarkRegisteredForHostMode(cgId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(
              createOperationContext('system'),
              `Failed to restore host-mode subscription for "${cgId}": ${msg}`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        createOperationContext('system'),
        `Failed to list persisted host-mode subscriptions: ${msg}`,
      );
    }
  }

  /**
   * OT-RFC-38 LU-6 — subscribe to a single CG's SWM topic in host
   * mode (store opaque ciphertext envelopes instead of decrypting).
   * No-op when the store isn't initialized, when the CG is system-
   * reserved, or when the node is already subscribed in member mode.
   */
  async reconcileSwmHostModeSubscription(this: DKGAgent,
    contextGraphId: string,
    source: SubscriptionSource = SUBSCRIPTION_SOURCES.RECONCILER,
  ): Promise<void> {
    if (!this.swmHostModeStore) return;
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) return;
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      // Member-mode subscription already active — apply path covers
      // local consumption; no need to also opaquely store.
      return;
    }
    const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
    if (this.swmHostModeSubscribed.has(hostKey)) {
      // Codex PR #610 R2: idempotent re-entry on the periodic
      // reconcile path must still re-probe on-chain registration
      // state. Without this, a core that subscribed while the CG
      // was unregistered stays on the 6h/1MiB pre-registration
      // limits forever — even after the CG is registered — and
      // ciphertext gets pruned much earlier than intended.
      // Mirrors the same safeguard in `enableSwmHostModeFor`.
      //
      // The `has()` check goes through `canonicalSwmHostModeKey` so
      // a reconcile call with cleartext finds an entry written by
      // the chain-event/beacon path with the hash form (and vice
      // versa). Codex PR #672 review `id=3302086589`.
      if (
        this.swmHostModeStripCiphertext() &&
        this.swmHostModeCurated.get(hostKey) === false &&
        await this.isCuratedForHostMode(contextGraphId)
      ) {
        // A manually hosted CG can become curated later. Upgrade the cached
        // classification so the existing handler starts stripping immediately.
        this.swmHostModeCurated.set(hostKey, true);
      }
      await this.maybeMarkRegisteredForHostMode(contextGraphId);
      return;
    }

    // Only host curated CGs. Public CGs already have plaintext SWM
    // distribution and don't need an opaque ciphertext custodian.
    //
    // OT-RFC-38 / LU-6 Phase B — three-source curation probe in
    // cheapest-first order. The local SPARQL probe (the original
    // gate) only finds the access-policy triple for CGs the local
    // node CREATED or JOINED with metadata; for a chain-event-
    // driven host-only core OR a beacon-driven pre-reg auto-host,
    // no local meta exists and `isPrivateContextGraph` returns
    // false, stranding the subscription. We supplement it with:
    //
    //   (a) `subscribedContextGraphs[contextGraphId].onChainHash` —
    //       set ONLY by code paths that already proved curation
    //       (chain-event handler with accessPolicy==1, beacon
    //       handler with accessPolicy==BEACON_ACCESS_POLICY_CURATED,
    //       successful curator-side `registerContextGraph` on a
    //       curated CG). Cheapest of the three.
    //   (b) `onChainAccessPolicyCache` — populated by the chain-
    //       event poller; keyed by on-chain numeric id. Falls
    //       through to the existing per-CG cache for CGs whose
    //       cleartext is unknown locally.
    //
    // Any of the three returning "curated" is sufficient. If all
    // three return "not curated", we bail (same as before). The
    // probe is shared with `enableSwmHostModeFor` via
    // {@link isCuratedForHostMode} so the operator-hatch close
    // (OT-RFC-49 WS-A) sees the SAME curation answer as auto-host —
    // critically, the host-only-core case where there's no local
    // `_meta` and `isPrivateContextGraph` alone returns false.
    const curated = await this.isCuratedForHostMode(contextGraphId);
    if (!curated) return;

    // OT-RFC-49 WS-A — the private-ciphertext strip. With `stripCiphertext`
    // ON (default), a core declines ALL host-mode custody for a curated CG:
    // "hosting follows access". Random sampling now proves the public
    // `_catalog`, so the core no longer needs the ciphertext — private data
    // lives member-side and members backfill from the curator. Declining the
    // subscribe HERE is the primary choke point: it starves both the legacy
    // `.meta` host-mode ingest AND the LU-11 chunk ingest (both are wired by
    // `wireSwmHostModeHandler`), regardless of how the CG was discovered
    // (reconciler / beacon / chain-event all funnel through this method).
    // Unlike rung-1's narrower `stripNonParticipants` gate, WS-A strips for
    // EVERY curated CG regardless of participation. Set `false` to restore
    // legacy auto-host (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.info(
        createOperationContext('system'),
        `SWM host-mode subscription DECLINED for "${contextGraphId}": private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores custody zero private SWM ciphertext for curated CGs; members backfill from the curator)`,
      );
      return;
    }

    this.wireSwmHostModeHandler(contextGraphId, source, true);
    await this.awaitHostModePersistence(contextGraphId);

    await this.maybeMarkRegisteredForHostMode(contextGraphId);

    this.log.info(
      createOperationContext('system'),
      `SWM host-mode subscription enabled for "${contextGraphId}" (role=core)`,
    );
  }

  /**
   * OT-RFC-49 WS-A — resolve the private-ciphertext strip kill-switch.
   * Default ON: `stripCiphertext === undefined` strips. Only an explicit
   * `false` restores legacy host-mode custody. Centralised so every gated
   * entry point (subscribe-decline, restart-restore skip, operator-hatch
   * refusal, serve-responder retire) reads the same flag the same way.
   */
  swmHostModeStripCiphertext(this: DKGAgent): boolean {
    return this.config.swmHostMode?.stripCiphertext ?? true;
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — the three-source curation probe used to decide
   * whether a CG warrants host-mode custody, in cheapest-first order:
   *
   *   (a) `subscribedContextGraphs[id].onChainHash` — set ONLY by paths that
   *       already proved curation (chain-event handler with accessPolicy==1,
   *       beacon handler with BEACON_ACCESS_POLICY_CURATED, curator-side
   *       register of a curated CG);
   *   (b) `onChainId` + `onChainAccessPolicyCache===1` — populated by the
   *       chain-event poller, keyed by numeric on-chain id;
   *   (c) `isPrivateContextGraph` — the local `_meta` accessPolicy/allowlist
   *       read (the original gate; the only one a host-only core CANNOT
   *       satisfy, since it never holds the cleartext `_meta`).
   *
   * Any positive ⇒ curated. A probe throw is treated as NOT curated (the same
   * bail-out `reconcileSwmHostModeSubscription` had inline). Extracted so the
   * OT-RFC-49 WS-A operator-hatch close in {@link enableSwmHostModeFor} sees
   * the EXACT same curation answer as the auto-host path — without this, a
   * host-only core (no local `_meta`) would fail an `isPrivateContextGraph`-only
   * check, leaving the operator override open for precisely the case WS-A
   * exists to close.
   */
  async isCuratedForHostMode(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (sub?.onChainHash) return true;
    if (sub?.onChainId && this.onChainAccessPolicyCache.get(sub.onChainId) === 1) return true;
    try {
      return await this.isPrivateContextGraph(contextGraphId);
    } catch {
      return false;
    }
  }

  /**
   * GH #1124 — DEFINITIVE "fully-open CG" check gating the self-signed public
   * host-mode ingest path. "Open" requires BOTH axes, because this codebase
   * separates READ visibility from WRITE authority:
   *   - accessPolicy === 0  → publicly READABLE (SWM is plaintext), AND
   *   - publishPolicy === 1 → OPEN PUBLISH (anyone may write).
   * A public-readable but curated-publish CG (accessPolicy 0, publishPolicy 0 /
   * PCA) still restricts WHO may publish, so the self-signed path must NOT apply
   * — otherwise any key could store plaintext SWM on host-mode cores and bypass
   * the on-chain publisher authorization (otReviewAgent #1239-r3). Curated OR
   * unknown on EITHER axis → false: the conservative ciphertext + allowlist gates
   * stay in force and a chain-event race heals via member catchup, so a curated
   * (or restricted-publish) CG is never misclassified as self-publishable.
   */
  async isConfirmedPublicForHostMode(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    // Resolve via the SHARED on-chain policy resolver rather than a direct
    // cleartext `subscribedContextGraphs` lookup. `getContextGraphOnChainPolicy`
    // re-keys cleartext↔on-chain-id, consults the cache + local `_meta`, AND
    // falls back to a direct chain RPC — so it resolves BOTH policies even for a
    // host-only core keyed by the wire HASH with no local `_meta` (the #1124
    // sharded topology). Both must positively resolve to their open value; any
    // undefined (unknown) → false (safe).
    try {
      // `publishPolicyMaxCacheAgeMs`: publishPolicy is mutable on-chain and the
      // general cache is ≤60s-TTL'd, so it could be stale-PERMISSIVE for up to
      // the TTL after an owner downgrades open→curated publish. This is a
      // security-positive gate (it admits a self-signed plaintext write that host
      // catchup later applies under trustedReplay), so it accepts only a SHORT
      // (~5s) cache window — bounding the downgrade staleness to seconds while
      // rate-capping the chain RPC to ~1 per window per CG (vs an eth_call on
      // every admitted envelope). An RPC failure/timeout leaves publishPolicy
      // undefined → we fail CLOSED (drop; the share heals via retry/catchup
      // once the policy re-resolves).
      const { accessPolicy, publishPolicy } = await this.getContextGraphOnChainPolicy(
        contextGraphId, { publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS },
      );
      return accessPolicy === 0 && publishPolicy === 1;
    } catch {
      return false;
    }
  }

  /**
   * Register the host-mode gossip handler for `contextGraphId` and
   * track its reference so {@link unwireSwmHostModeHandler} can
   * remove ONLY that handler later (without touching member-mode
   * handlers or other consumers of the same topic). Idempotent.
   *
   * Both `reconcileSwmHostModeSubscription` (sharding-driven) and
   * `enableSwmHostModeFor` (operator-driven) funnel through here
   * so the host-mode lifecycle is in one place.
   */
  wireSwmHostModeHandler(this: DKGAgent,
    contextGraphId: string,
    source: SubscriptionSource = SUBSCRIPTION_SOURCES.RECONCILER,
    curated = true,
  ): void {
    // OT-RFC-38 / LU-6 Phase B — host-mode subscribes on the wire-form
    // topic. For chain-event-driven auto-subscribe, `contextGraphId`
    // IS the wire id (the core has no cleartext to translate from).
    // For an operator-driven `enableSwmHostModeFor("cleartext-id")`
    // path on a node that's also a member, `gossipWireIdFor`
    // resolves to the curator-committed hash via the local meta.
    //
    // Codex PR #672 review `id=3302086589`: canonicalize FIRST and
    // key both bookkeeping maps off `wireCgId` so a chain-event-
    // driven hash subscribe collides with a later manual-driven
    // cleartext subscribe on the SAME CG and the second call is a
    // genuine no-op (instead of silently wiring a second handler on
    // the same topic).
    const wireCgId = this.canonicalSwmHostModeKey(contextGraphId);
    if (this.swmHostModeHandlers.has(wireCgId)) {
      // Idempotent re-entry — preserve the original source. The first
      // discovery path to wire the handler wins the provenance label;
      // a later path covering the same CG is "also true" but the
      // operator-meaningful answer is "which path got us here first".
      return;
    }
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    this.swmHostModeSubscribed.set(wireCgId, source);
    this.swmHostModeCurated.set(wireCgId, curated);
    this.gossip.subscribe(swmTopic);
    const handler = (_topic: string, data: Uint8Array, from: string) => {
      // Fail closed when the classification is absent. Only an explicitly
      // non-curated manual subscription retains the public host-mode hatch.
      if (
        this.swmHostModeStripCiphertext() &&
        this.swmHostModeCurated.get(wireCgId) !== false
      ) {
        this.log.debug(
          createOperationContext('share'),
          `Dropping host-mode envelope on cg=${contextGraphId} from=${from}: ` +
          `private-ciphertext strip is ON for a curated CG (OT-RFC-49 WS-A)`,
        );
        return;
      }
      // OT-RFC-38 LU-11: peek envelope type and dispatch. Chunked
      // envelopes (`type='share-write-chunked'`) take the V2 chunk
      // persistence path; everything else flows through the legacy
      // host-mode store unchanged. Failed decode falls through to
      // `ingestSwmHostModeEnvelope` which is also defensive — the
      // dispatch here is best-effort, not a security boundary.
      let envelopeType: string | undefined;
      try {
        const peek = decodeGossipEnvelope(data);
        envelopeType = peek?.type;
      } catch { /* drop into legacy path */ }
      if (envelopeType === GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED) {
        this.ingestSwmCiphertextChunkEnvelope(contextGraphId, data, from).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(
            createOperationContext('system'),
            `LU-11: chunked SWM ingest failed for "${contextGraphId}": ${msg}`,
          );
        });
        return;
      }
      this.ingestSwmHostModeEnvelope(contextGraphId, data, from).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(
          createOperationContext('system'),
          `Host-mode SWM ingest failed for "${contextGraphId}": ${msg}`,
        );
      });
    };
    this.swmHostModeHandlers.set(wireCgId, handler);
    this.gossip.onMessage(swmTopic, handler);
    // B3: persist the host-mode designation so a restart re-engages
    // this handler before the chain-event poller catches up.
    // Codex PR #620 R2: chain wire/unwire writes through a per-CG
    // serialization queue so mark/unmark calls always land on disk
    // in invocation order. Without this, back-to-back mark→unmark
    // could write `true` after `false` and a restart would re-subscribe
    // a torn-down CG. Still non-blocking at the wire level.
    this.enqueueHostModePersistence(contextGraphId, true);
  }

  /**
   * Surgically remove the host-mode gossip handler for
   * `contextGraphId` (does NOT call `gossip.unsubscribe`, which
   * would drop every handler on the topic). Used when the same
   * core gains member authorization for the CG — apply-and-ack
   * via the member handler then supersedes opaque hosting.
   * Idempotent; no-op when no host handler is registered.
   *
   * Codex PR #610 R3: without this, member- and host-mode
   * handlers would both fire on every gossip message, causing
   * each envelope to be (a) decrypted-and-applied AND (b)
   * appended opaquely. Wasted disk + apply work.
   */
  unwireSwmHostModeHandler(this: DKGAgent, contextGraphId: string): void {
    // Both bookkeeping maps are canonical-keyed (see
    // {@link canonicalSwmHostModeKey}); canonicalize the input
    // before lookup so the unwire path is shape-agnostic just like
    // the wire path.
    const wireCgId = this.canonicalSwmHostModeKey(contextGraphId);
    const handler = this.swmHostModeHandlers.get(wireCgId);
    if (!handler) return;
    const swmTopic = contextGraphWorkspaceTopic(wireCgId);
    this.gossip.offMessage(swmTopic, handler);
    this.swmHostModeHandlers.delete(wireCgId);
    this.swmHostModeSubscribed.delete(wireCgId);
    this.swmHostModeCurated.delete(wireCgId);
    // B3: clear the persisted host-mode designation so a restart
    // does NOT re-engage. Serialized via the per-CG persistence
    // queue (see `enqueueHostModePersistence` for the ordering
    // rationale).
    this.enqueueHostModePersistence(contextGraphId, false);
  }

  /**
   * Per-CG promise chain for host-mode mark/unmark writes. Codex
   * PR #620 R2: prior fire-and-forget invocation made restart state
   * nondeterministic — a stale mark() write could land AFTER a fresh
   * unmark() and a subsequent restart would re-subscribe a CG that
   * was already torn down.
   *
   * The chain serializes ALL writes for a given CG so they hit disk
   * in invocation order. The wire/unwire callers stay synchronous;
   * persistence is awaited only by the chain itself.
   */
  /**
   * Resolve the on-disk store key for a host-mode persistence
   * mutation. The {@link SwmHostModeStore} is cleartext-keyed by
   * design (`append` / `iterate` / `markRegistered` all key off the
   * cleartext id the gossip envelope carries — see
   * {@link ingestSwmHostModeEnvelope}). The persisted
   * `hostModeSubscribed` flag MUST use that same cleartext key so a
   * `mark` taken in one id shape and a later `unmark` in the other
   * (e.g. beacon/chain auto-host engages by wire-hash, then a
   * promoted-to-member or curator-revoke unwire arrives in cleartext)
   * collapse onto a single `.meta` file instead of leaving the flag
   * stuck under an orphan key — which would re-engage a torn-down CG
   * on the next restart. Wire-form (0x-hash) inputs are translated
   * back through the {@link wireIdToLocalCgId} reverse index; an
   * as-yet-unmapped hash falls back to itself.
   */
  hostModePersistenceStoreKey(this: DKGAgent, rawCgId: string): string {
    if (/^0x[0-9a-fA-F]{64}$/.test(rawCgId)) {
      const lower = rawCgId.toLowerCase();
      return this.wireIdToLocalCgId.get(lower) ?? lower;
    }
    return rawCgId;
  }

  enqueueHostModePersistence(this: DKGAgent, contextGraphId: string, subscribe: boolean): void {
    if (!this.swmHostModeStore) return;
    // The in-memory queue stays wire-keyed so ordering dedups across
    // id shapes (cleartext vs wire-hash for the same CG); the store
    // mutation itself is cleartext-keyed via
    // {@link hostModePersistenceStoreKey}.
    const queueKey = this.canonicalSwmHostModeKey(contextGraphId);
    const storeCgId = this.hostModePersistenceStoreKey(contextGraphId);
    const store = this.swmHostModeStore;
    const op = subscribe ? 'mark' : 'unmark';
    const apply = async (): Promise<void> => {
      try {
        if (subscribe) {
          await store.markHostModeSubscribed(storeCgId);
        } else {
          await store.markHostModeUnsubscribed(storeCgId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug(
          createOperationContext('system'),
          `Host-mode persistence (${op}) failed for "${storeCgId}": ${msg}`,
        );
      }
    };
    const prev = this.hostModePersistenceQueues.get(queueKey) ?? Promise.resolve();
    const next = prev.then(apply, apply);
    this.hostModePersistenceQueues.set(queueKey, next);
    void next.finally(() => {
      if (this.hostModePersistenceQueues.get(queueKey) === next) {
        this.hostModePersistenceQueues.delete(queueKey);
      }
    });
  }

  async awaitHostModePersistence(this: DKGAgent, contextGraphId: string): Promise<void> {
    const pending = this.hostModePersistenceQueues.get(this.canonicalSwmHostModeKey(contextGraphId));
    if (pending) await pending;
  }

  /**
   * Periodic reconciler driven by `hostModeReconcilerTimer`. Sweeps
   * a bounded slice of locally-known CGs and ensures host-mode
   * subscription is in sync. The cursor rotates through the stable
   * sorted set so large stores converge without each tick touching
   * every known graph.
   *
   * Serialized via `hostModeReconcileInflight` so an overlap with
   * the cleanup timer (or a manual call from a test) doesn't
   * double-subscribe.
   */
  async reconcileHostModeSubscriptions(this: DKGAgent): Promise<void> {
    if (!this.swmHostModeStore) return;
    if (this.hostModeReconcileInflight) {
      await this.hostModeReconcileInflight;
      return;
    }
    const inflight = (async () => {
      try {
        const graphManager = new GraphManager(this.store);
        const knownCgs = (
          await graphManager.listContextGraphs({
            source: 'agent.swmHostMode.listContextGraphs',
          })
        ).sort();
        if (knownCgs.length === 0) {
          this.hostModeReconcileCursor = 0;
          return;
        }
        const batchSize = normalizeHostModeReconcileBatchSize(this.config.swmHostMode?.reconcileBatchSize);
        const start = this.hostModeReconcileCursor % knownCgs.length;
        const count = Math.min(batchSize, knownCgs.length);
        for (let i = 0; i < count; i++) {
          const index = (start + i) % knownCgs.length;
          const cgId = knownCgs[index];
          try {
            await this.reconcileSwmHostModeSubscription(cgId);
          } finally {
            this.hostModeReconcileCursor = (index + 1) % knownCgs.length;
          }
        }
      } finally {
        this.hostModeReconcileInflight = undefined;
      }
    })();
    this.hostModeReconcileInflight = inflight;
    await inflight;
  }

  /** Probes the local on-chain meta to decide if a CG is registered. Tolerant of missing chain adapter. */
  async isContextGraphRegisteredOnChain(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    try {
      if (typeof (this.chain as any).getContextGraphOnChain !== 'function') return false;
      const onChain = await (this.chain as any).getContextGraphOnChain(contextGraphId);
      return Boolean(onChain);
    } catch {
      return false;
    }
  }

  /**
   * Tap registered with `gossip.onMessage` for host-mode topics.
   *
   * Two-phase validation before opaque storage:
   *   1. Cheap structural sniff — drop non-envelopes, cross-CG
   *      spoofs, plaintext bursts (curated SWM is always
   *      ciphertext-wrapped).
   *   2. Codex PR #610 R4: cryptographic authority check via
   *      `SharedMemoryHandler.verifyHostModeEnvelopeAuthority` —
   *      verify the envelope signature and confirm the recovered
   *      signer is in the CG's agent allowlist (and `from` is in
   *      the peer allowlist if one is set). Without this, an
   *      unauthorized peer could fill the per-CG FIFO cap with
   *      structurally-valid junk and evict legitimate ciphertext
   *      history once eviction kicked in.
   *
   * We do NOT attempt decryption — the chain key lives on
   * members, not on the hosting core. Members re-verify the
   * envelope signature on replay too via
   * `SharedMemoryHandler.handle({ trustedReplay: true })`.
   */
  async ingestSwmHostModeEnvelope(this: DKGAgent,
    contextGraphId: string,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<void> {
    if (!this.swmHostModeStore) return;
    if (data.length === 0) return;
    const ctx = createOperationContext('share');
    let envelope: GossipEnvelopeMsg | undefined;
    try {
      envelope = decodeGossipEnvelope(data);
    } catch {
      return;
    }
    if (!envelope || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH) {
      return;
    }
    if (envelope.payload.length === 0) return;
    // OT-RFC-38 / LU-6 Phase B — `contextGraphId` is the SUBSCRIPTION
    // key, which can be EITHER cleartext (operator-driven
    // `/host-mode/subscribe`, or a node that's also a CG member) OR
    // the wire-id hash (chain-event / beacon driven auto-host on a
    // host-only core). The envelope itself still carries CLEARTEXT in
    // `envelope.contextGraphId` (see `publishWorkspaceGossip` comment
    // about the "envelope stays cleartext" compromise).
    //
    // The legacy strict equality check rejected the host-only-core
    // path 100% of the time, silently dropping every Phase B auto-
    // hosted envelope. Translate both sides to the wire-form (hash)
    // and compare there — this accepts the envelope whenever it was
    // published for the same CG as the local subscription, regardless
    // of which side speaks cleartext.
    //
    // From here on, prefer `envelope.contextGraphId` as the canonical
    // local key for store + authority lookups: it's the cleartext
    // form, which the meta-graph + chain-fallback resolvers can
    // translate to numeric / chain queries natively, and matches
    // what the member's LU-6 host-catchup request will use to fetch
    // the ciphertext back. This means a host-only core's per-CG
    // store entries are keyed by cleartext from the FIRST received
    // envelope onward — cleaner than maintaining two parallel keys.
    const envelopeWireId = this.gossipWireIdFor(envelope.contextGraphId);
    const subscriptionWireId = this.gossipWireIdFor(contextGraphId);
    if (envelopeWireId !== subscriptionWireId) {
      return;
    }
    const storageCgId = envelope.contextGraphId;
    // Keep the wire-id → cleartext reverse index in sync so the
    // chain-fallback resolver and the catchup-request path can
    // translate either direction without an extra RPC.
    if (storageCgId !== contextGraphId) {
      const storageSubscription = this.subscribedContextGraphs.get(storageCgId) ?? {
        syncMode: 'always-on' as const,
        subscribed: false,
        synced: false,
        pendingMeta: true,
      };
      this.setContextGraphSubscription(storageCgId, {
        ...storageSubscription,
        onChainHash: subscriptionWireId,
      }, { persist: false });
    }
    // Cheap "is this ciphertext" sniff: try to decode as one of the
    // two encrypted carriers; if neither parses, drop early so we
    // don't pay the signature-verify cost on obvious garbage.
    let isCiphertext = false;
    try {
      const enc = decodeEncryptedWorkspacePayload(envelope.payload);
      isCiphertext = enc.type === ENCRYPTED_WORKSPACE_ENVELOPE_TYPE;
    } catch { /* fall through */ }
    if (!isCiphertext) {
      try {
        const skm = decodeSwmSenderKeyMessage(envelope.payload);
        isCiphertext = skm.type === SWM_SENDER_KEY_MESSAGE_TYPE;
      } catch { /* fall through */ }
    }
    // GH #1124 — a curated CG MUST carry ciphertext, so a non-ciphertext
    // envelope there is garbage → drop early. A CONFIRMED-public (open) CG
    // legitimately gossips PLAINTEXT SWM. Resolve the public flag and reuse it
    // for both the plaintext gate and the authority check. UNKNOWN CGs stay on
    // the drop path (safe; member catchup heals once the policy resolves).
    //
    // LAZY by design (Branimir review #1239 follow-on): the self-signed public
    // exception only matters for `!isCiphertext` traffic. So short-circuit on
    // `!isCiphertext` to skip the (now chain-backed) policy resolution entirely
    // on the dominant CIPHERTEXT/curated path — otherwise the bulk of host-mode
    // traffic would pay a synchronous eth_call to compute a value it discards.
    // Security-preserving: a ciphertext envelope on a public CG just stays in the
    // curated authority path / opaque append and heals via catchup.
    const confirmedPublic = !isCiphertext && await this.isConfirmedPublicForHostMode(storageCgId);
    if (!isCiphertext && !confirmedPublic) return;

    // Authority check. Curated traffic verifies the envelope signature against
    // the CG's agent allowlist. For a self-publishable (open) CG, inject the
    // on-chain policy RESOLVER (not a pre-decided flag): the SHARED verifier
    // re-checks accessPolicy===0 && publishPolicy===1 itself, then validates the
    // signature + timestamp-freshness AND binds the inner request to THIS CG —
    // same envelope validation as curated, only the allowlist decision diverges
    // (see SharedMemoryHandler.verifyHostModeEnvelopeAuthority).
    //
    // Use `storageCgId` (cleartext from the envelope) so the meta-graph +
    // chain-fallback resolvers work on the canonical id shape.
    const handler = this.getOrCreateSharedMemoryHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(
      data, storageCgId, fromPeerId,
      // Inject the on-chain policy RESOLVER (not a pre-decided flag) so the
      // verifier enforces accessPolicy===0 && publishPolicy===1 itself and can
      // take the self-signed path even when a STALE participant allowlist
      // survives an open-publish flip. Lazy: pass it only for non-ciphertext,
      // so the dominant ciphertext/curated path pays no chain read (the resolver
      // shares the same ~5s publishPolicy cache window as the confirmedPublic
      // resolution above, so this is at most a warm cache hit, never a 2nd RPC).
      isCiphertext
        ? undefined
        : {
          resolveOpenPublishPolicy: () => this.getContextGraphOnChainPolicy(
            storageCgId, { publishPolicyMaxCacheAgeMs: HOST_MODE_PUBLISH_POLICY_MAX_CACHE_AGE_MS },
          ),
        },
    );
    if (!verdict.accepted) {
      // 'no agent allowlist' on a NON-public CG is the expected brief chain-event
      // race (curated allowlist not loaded yet) — recoverable via member catchup,
      // so log at debug. Every other rejection (decode / unsigned / signature-or-
      // freshness / peer-not-allowed / CG-mismatch) is a real authority failure
      // operators should see.
      const isTransientRace = verdict.reasonCode === 'NO_AGENT_ALLOWLIST';
      if (isTransientRace) {
        this.log.debug(
          ctx,
          `Host-mode SWM envelope dropped for cg=${storageCgId} from=${fromPeerId}: ${verdict.reason} (transient chain-event race; member will catchup)`,
        );
      } else {
        this.log.warn(
          ctx,
          `Host-mode SWM envelope rejected for cg=${storageCgId} from=${fromPeerId}: ${verdict.reason}`,
        );
      }
      return;
    }

    // OT-RFC-38 / LU-6 Phase B — pre-registration ciphertext rate-
    // limit. Apply only to CGs that have NOT been marked registered
    // on the host-mode store (registered CGs are gated by chain
    // economics + the on-chain participant allowlist, not the
    // freemium-tier per-wallet windows). The rate-limit decision
    // mutates `discoveryRateLimit` ONLY when it admits, so a
    // rejection here does not consume any per-curator budget.
    //
    // Step 1: opportunistically flip the store's `registered` flag
    // BEFORE the rate-limit decision. Without this, an envelope
    // that arrives on a CG that was registered on chain seconds
    // earlier (but where the periodic reconciler hasn't swept yet)
    // would still hit the per-curator window and likely get dropped
    // — a known race when the curator publishes immediately after
    // their `registerContextGraph` tx confirms.
    await this.maybeMarkRegisteredForHostMode(storageCgId);
    let isRegistered = false;
    try {
      isRegistered = await this.swmHostModeStore.isRegistered(storageCgId);
    } catch {
      isRegistered = false;
    }
    if (!isRegistered && this.discoveryRateLimit) {
      // `beaconCuratorByWireId` is keyed by the WIRE id (hash);
      // `subscriptionWireId` IS the wire id already (we hashed
      // `contextGraphId` above), so look up directly.
      const curatorEoa = this.beaconCuratorByWireId.get(subscriptionWireId);
      if (!curatorEoa) {
        // No beacon was ever received for this wire id, yet
        // ciphertext arrived. Two legitimate windows produce this:
        //   - The CG is registered on chain but the local node has
        //     not seen the `ContextGraphCreated` event yet (the
        //     event poller's lookback hasn't covered the block).
        //     Mitigated by the `maybeMarkRegisteredForHostMode`
        //     call above — but that's best-effort and a transient
        //     RPC failure can leave us here.
        //   - An attacker is trying to bypass the per-wallet window
        //     by skipping the beacon broadcast.
        // We fail OPEN in both cases: the per-CG byte cap +
        // pre-reg TTL on the SwmHostModeStore is the safety net.
        // Promoting this from "drop" to "log + admit" trades a
        // marginal abuse window (an unauthenticated wallet can
        // burn one per-CG byte cap before the chain reconciler
        // catches up) for not losing freshly-registered CG
        // ciphertext during the chain-event race. The chain-
        // economics gate on actually-registered CGs makes the
        // exposure bounded.
        this.log.debug(
          ctx,
          `Host-mode admitting pre-reg cg=${storageCgId} wireId=${subscriptionWireId.slice(0, 12)}… without curator binding (no beacon yet; per-CG byte cap remains the safety net)`,
        );
      } else {
        const admission = this.discoveryRateLimit.admit(curatorEoa, data.length);
        if (!admission.admit) {
          this.log.warn(
            ctx,
            `Host-mode rejected pre-reg envelope cg=${storageCgId} curator=${curatorEoa}: ${admission.reason}`,
          );
          return;
        }
      }
    }
    // GH #1124 — make a CONFIRMED-PUBLIC host-only (non-member) core ACK-CAPABLE.
    // The opaque `append` below retains the raw envelope so this host can serve
    // member host-catchup (LU-6 replay), but the StorageACKHandler a publisher
    // dials reads `<cg>/_shared_memory` from `this.store` (loadSWMQuads /
    // sharedMemoryReadBothFilter) — it has NO path into SwmHostModeStore. So
    // without ALSO applying the plaintext into that triple-store graph, a
    // non-member host would still DECLINE `NO_DATA_IN_SWM` and a public CG's
    // storage-ACK quorum stays unreachable on a host-mode (non-member) topology
    // — the exact bug this PR claims to fix. Reuse the member apply path
    // (`handle`) on the SAME, already-authority-verified envelope bytes; for a
    // public CG it routes the plaintext quads to the per-KA SWM layer the ACK
    // handler reads (graph-agnostic merkle, no re-skolemize), so the recompute
    // matches and this host signs a quorum-eligible ACK exactly as a member does.
    //
    // SECURITY — the `if (confirmedPublic)` wrapper is the SOLE authority gate
    // for this apply, and it is LOAD-BEARING: on a host-only core `handle()`
    // CANNOT distinguish curated from public (a non-member holds no local `_meta`
    // allowlist nor accessPolicy, so a curated AND a public CG both resolve to
    // `agentGateAddresses === null` && `hasPrivateAccessPolicy === false`, and
    // `handle()` would apply plaintext for EITHER). What guarantees this CG is
    // genuinely public is `isConfirmedPublicForHostMode` — accessPolicy === 0
    // (immutable) AND a FORCED-fresh publishPolicy === 1 (fail-closed on RPC
    // error). DO NOT hoist this apply out of the `confirmedPublic` branch or
    // reuse a `confirmedPublic` resolved further from the apply — either silently
    // re-opens curated-plaintext injection into a non-member's SWM store.
    // `verifyHostModeEnvelopeAuthority` already bound sig + 5-min freshness + CG +
    // `publisherPeerId === fromPeerId` on these exact `data` bytes one block up,
    // so `handle({ trustedReplay: true })` skips only the transport re-checks it
    // already performed — for a public CG (agentGateAddresses === null) it skips
    // no cryptography. Mirrors the catchup-replay call (~line 3575).
    if (confirmedPublic) {
      try {
        const apply = await handler.handle(data, fromPeerId, undefined, { trustedReplay: true });
        if (apply.applied) {
          this.log.info(
            ctx,
            `Host-mode applied confirmed-public SWM plaintext cg=${storageCgId} triples=${apply.insertedTriples ?? 0} (now ACK-capable)`,
          );
        } else {
          // Apply declined (validation / CAS / dedup). Keep going to the opaque
          // append so member catchup still works; this host just won't ACK this
          // share (it falls back to the pre-fix NO_DATA_IN_SWM decline). Logged
          // at WARN so a SYSTEMATIC public-CG apply failure is observable here
          // rather than only downstream as quorum-unmet.
          const reason = 'reason' in apply ? apply.reason : 'unknown';
          this.log.warn(
            ctx,
            `Host-mode confirmed-public SWM apply NOT applied cg=${storageCgId}: ${reason} (host keeps opaque copy for catchup but will DECLINE NO_DATA_IN_SWM on ACK)`,
          );
        }
      } catch (err) {
        // Never let an apply error drop the opaque retention path below.
        this.log.warn(
          ctx,
          `Host-mode confirmed-public SWM apply threw cg=${storageCgId}: ${err instanceof Error ? err.message : String(err)} (opaque retention below unaffected)`,
        );
      }
    }

    const seqno = await this.swmHostModeStore.append(storageCgId, data);
    this.log.debug(
      ctx,
      `Host-mode stored opaque SWM envelope cg=${storageCgId} seqno=${seqno} bytes=${data.length}`,
    );
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — chunked-ciphertext SWM ingest.
   * Receives per-chunk SWM gossip envelopes
   * (`type='share-write-chunked'`) that the publisher fans out via
   * `_resolveEncryptInlineChunked`, verifies envelope authority
   * against the curated CG's agent allowlist (same gate as the
   * legacy host-mode store), strips the 32-byte `batchId` prefix
   * from the payload, and persists the remaining ciphertext bytes
   * under the deterministic chunk-store subject so the V2 ACK
   * verifier can recompute the publisher's claimed
   * `ciphertextChunksRoot` keyed by `(cgId, batchId, chunkIndex)`.
   *
   * Persistence model: one base64-encoded literal per chunk, in the
   * per-CG named graph `ciphertextChunkStoreGraph(cgId)` under the
   * subject `ciphertextChunkStoreSubject(batchId, chunkIndex)`. The
   * store insert is idempotent — the same chunk arriving twice (or
   * out of order) overwrites the existing triple harmlessly because
   * `subject + predicate + graph` is unique.
   *
   * Late-join cores that come online after a publish has finalised
   * end up here only opportunistically (if a peer's mesh re-floods
   * the chunked envelope), which is unreliable; commit 7 adds the
   * `GetCiphertextChunk` sync verb that pulls missing chunks
   * explicitly via the protocol router.
   */
  async ingestSwmCiphertextChunkEnvelope(this: DKGAgent,
    contextGraphId: string,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<void> {
    if (data.length === 0) return;
    const ctx = createOperationContext('share');
    let envelope: GossipEnvelopeMsg | undefined;
    try {
      envelope = decodeGossipEnvelope(data);
    } catch {
      return;
    }
    if (!envelope || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED) {
      return;
    }
    if (envelope.payload.length <= 32) {
      // Chunked payload format: [32-byte batchId][ciphertext...].
      // Anything shorter can't carry a single ciphertext byte.
      this.log.debug(
        ctx,
        `LU-11: ignoring chunked envelope on cg=${contextGraphId} from=${fromPeerId} with truncated payload (${envelope.payload.length} bytes)`,
      );
      return;
    }
    if (typeof envelope.swmMessageIndex !== 'number' || envelope.swmMessageIndex < 0) {
      this.log.debug(
        ctx,
        `LU-11: ignoring chunked envelope on cg=${contextGraphId} with invalid swmMessageIndex=${envelope.swmMessageIndex}`,
      );
      return;
    }

    // Subscription CG-id can be either cleartext (operator / member
    // path) or wire-form hash (chain-event auto-subscribe). Compare
    // both sides in wire-form so any combination accepts.
    const envelopeWireId = this.gossipWireIdFor(envelope.contextGraphId);
    const subscriptionWireId = this.gossipWireIdFor(contextGraphId);
    if (envelopeWireId !== subscriptionWireId) return;
    const storageCgId = envelope.contextGraphId;

    // Verify envelope signature against the curated CG's agent
    // allowlist — exactly the same authority check the host-mode
    // store uses; without it, any topic-reachable peer could plant
    // arbitrary ciphertext under a victim's (cgId, batchId) keys.
    const handlerSm = this.getOrCreateSharedMemoryHandler();
    const verdict = await handlerSm.verifyHostModeEnvelopeAuthority(data, storageCgId, fromPeerId);
    if (!verdict.accepted) {
      // Same transient-race classification as the LU-6 host-mode
      // path: "no agent allowlist yet" is the post-create / pre-
      // chain-event window; everything else is a real auth failure.
      const isTransientRace = verdict.reason === 'no agent allowlist on context graph';
      const logFn = isTransientRace ? this.log.debug.bind(this.log) : this.log.warn.bind(this.log);
      logFn(
        ctx,
        `LU-11: chunked envelope auth ${isTransientRace ? 'deferred' : 'rejected'} for cg=${storageCgId} from=${fromPeerId} swmMessageIndex=${envelope.swmMessageIndex}: ${verdict.reason}`,
      );
      return;
    }

    const batchId = envelope.payload.subarray(0, 32);
    const ciphertext = envelope.payload.subarray(32);
    const chunkIndex = envelope.swmMessageIndex;
    // Codex review on PR #715 (refined round 2 on PR #727): canonicalize
    // the cgId used in the per-CG named graph via
    // `canonicalChunkStoreCgIdOrNull` so persist (here) and lookup
    // (`handleGetCiphertextChunk`, V2 ACK loadChunk, prover extractor)
    // converge on the same wire-form key. The persist site falls back
    // to the raw `storageCgId` (legacy shape) when canonicalization
    // can't safely resolve — the gossip envelope's `contextGraphId`
    // is typically already cleartext / wire-form, so the null path is
    // unlikely here, but the fallback keeps insert semantics safe and
    // mirrors the lookup-side wildcard fallback rather than
    // fabricating a bad keccak-of-decimal-string.
    const persistCanonical = this.canonicalChunkStoreCgIdOrNull(storageCgId);
    const chunksGraph = ciphertextChunkStoreGraph(persistCanonical ?? storageCgId);
    const subject = ciphertextChunkStoreSubject(batchId, chunkIndex);
    const literal = `"${Buffer.from(ciphertext).toString('base64')}"`;
    try {
      await this.store.insert([{
        subject,
        predicate: CIPHERTEXT_CHUNK_PREDICATE,
        object: literal,
        graph: chunksGraph,
      }]);
    } catch (err) {
      this.log.warn(
        ctx,
        `LU-11: failed to persist chunk cg=${storageCgId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    this.log.info(
      ctx,
      `LU-11: persisted ciphertext chunk cg=${storageCgId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex} bytes=${ciphertext.length}`,
    );
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — curator-side: record a CG so the
   * periodic beacon timer keeps re-announcing it AND broadcast an
   * immediate first beacon. Called from {@link createContextGraph}
   * for curated CGs.
   *
   * Best-effort. Failures (no chain signer, no listening cores yet,
   * gossip publish error) are logged at WARN and do not block CG
   * creation — without a beacon the CG falls back to the chain-event
   * auto-subscribe path on register, which still works for cores
   * that come online after registration.
   */
  /**
   * @param curatorAgentAddress
   *   Optional explicit curator agent address (typically the
   *   `opts.callerAgentAddress` resolved from the create-CG token).
   *   When provided AND a matching workspace agent has a private
   *   key, the beacon is signed by THAT agent so the wireId-pinned
   *   `curatorEoa` matches what host-catchup envelopes will recover.
   *   Without this, multi-agent nodes silently default to the first
   *   workspace agent and the catchup path can authorize the wrong
   *   identity. Codex review on PR #916.
   */
  async registerCgForBeaconAnnouncement(this: DKGAgent,
    localCgId: string,
    accessPolicy: number,
    curatorAgentAddress?: string,
  ): Promise<void> {
    if (accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
      // Public CGs don't need pre-registration auto-host: their
      // SWM substrate carries plaintext that any core can apply
      // directly via the gossip subscription. The beacon flow is
      // specifically for curated ciphertext custody.
      return;
    }
    // Prefer the caller-specified curator agent on multi-agent
    // nodes; only fall back to the default workspace agent when
    // the caller didn't pin one.
    const callerScopedSigner = this.getWorkspaceSigningAgentForAddress(curatorAgentAddress);
    if (curatorAgentAddress && !callerScopedSigner) {
      // The caller pinned a curator that isn't in `localAgents`
      // with a privateKey. Defaulting to another agent here would
      // mint a beacon whose `curatorEoa` doesn't match what the
      // host-catchup path later recovers — silently pinning the
      // wrong identity is worse than skipping the beacon. Drop
      // the registration and log; the chain-event auto-subscribe
      // path on register still works for cores that come online
      // after registration.
      this.log.warn(
        createOperationContext('system'),
        `Beacon registration skipped for "${localCgId}": caller curator ${curatorAgentAddress} has no local signer; would pin wrong curator EOA`,
      );
      return;
    }
    const beaconAgentSigner = callerScopedSigner ?? this.getWorkspaceGossipSigningAgent();
    const chainSignerEoa = beaconAgentSigner ? null : await this.getRegistrationTxSignerAddress();
    const curatorEoa = beaconAgentSigner?.agentAddress ?? chainSignerEoa;
    if (!curatorEoa) {
      this.log.warn(
        createOperationContext('system'),
        `Beacon registration skipped for "${localCgId}": no DKG agent signer or chain tx signer; pre-registration auto-host won't run for this CG`,
      );
      return;
    }
    const wireId = this.gossipWireIdFor(localCgId);
    this.beaconRegistry.set(localCgId, {
      wireId,
      curatorEoa: curatorEoa.toLowerCase(),
      ...(beaconAgentSigner?.privateKey ? { signerPrivateKey: beaconAgentSigner.privateKey } : {}),
      accessPolicy,
    });
    await this.broadcastCgDiscoveryBeacon(localCgId);
  }

  /**
   * Single-shot broadcast of the CG-discovery beacon for one
   * locally-curated CG. Idempotent w.r.t. cores: a core that
   * already auto-subscribed treats a duplicate beacon as a refresh
   * (timestamp + signature still validate against the same curator
   * EOA + nameHash; rate-limit doesn't count beacons themselves).
   */
  async broadcastCgDiscoveryBeacon(this: DKGAgent, localCgId: string): Promise<void> {
    const entry = this.beaconRegistry.get(localCgId);
    if (!entry) return;
    const ctx = createOperationContext('share');
    let beacon;
    try {
      beacon = await mintCgDiscoveryBeacon({
        nameHash: entry.wireId,
        accessPolicy: entry.accessPolicy,
        curatorEoa: entry.curatorEoa,
        sign: async (digest) => {
          if (entry.signerPrivateKey) {
            return new ethers.Wallet(entry.signerPrivateKey).signMessage(digest);
          }
          // Chain adapter's `signMessage` returns `{r, vs}`; re-
          // serialise to the 65-byte hex shape ethers expects. The
          // EVM adapter routes through `Signer.signMessage` which
          // applies the EIP-191 framing, matching what
          // `verifyCgDiscoveryBeacon` recovers.
          if (typeof this.chain.signMessage !== 'function') {
            throw new Error('chain adapter does not implement signMessage');
          }
          const { r, vs } = await this.chain.signMessage(digest);
          const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
          return sig.serialized;
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Beacon mint failed for "${localCgId}" (wireId=${entry.wireId.slice(0, 12)}…): ${msg}`);
      return;
    }
    try {
      this.gossip.subscribe(DKG_CG_DISCOVERY_TOPIC);
      await this.gossip.publish(DKG_CG_DISCOVERY_TOPIC, encodeCgDiscoveryBeacon(beacon));
      this.log.info(
        ctx,
        `Beacon broadcast for "${localCgId}" wireId=${entry.wireId.slice(0, 12)}… curator=${entry.curatorEoa.slice(0, 10)}…`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(ctx, `Beacon publish for "${localCgId}" had no subscribers / failed: ${msg}`);
    }
  }

  async getWorkspaceCatchupSigner(this: DKGAgent, contextGraphId: string): Promise<{ privateKey: string } | null> {
    const wireId = this.gossipWireIdFor(contextGraphId);
    for (const entry of this.beaconRegistry.values()) {
      if (entry.signerPrivateKey && entry.wireId.toLowerCase() === wireId.toLowerCase()) {
        return { privateKey: entry.signerPrivateKey };
      }
    }

    const allowedAgents = await this.getContextGraphAgentGateAddresses(contextGraphId).catch(() => null);
    if (!allowedAgents || allowedAgents.length === 0) return null;
    const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (record.privateKey && allowedSet.has(record.agentAddress.toLowerCase())) {
        return { privateKey: record.privateKey };
      }
    }
    return null;
  }

  /**
   * Re-announce every CG in {@link beaconRegistry}. Driven by
   * {@link beaconReannounceTimer} on the
   * {@link BEACON_REANNOUNCE_INTERVAL_MS} cadence. Sequential to
   * keep memory bounded on agents with many CGs; the per-broadcast
   * cost is dominated by one keccak256 + one EIP-191 sign + one
   * gossip publish, all << 1ms on commodity hardware.
   */
  async reannounceAllBeacons(this: DKGAgent): Promise<void> {
    for (const localCgId of this.beaconRegistry.keys()) {
      await this.broadcastCgDiscoveryBeacon(localCgId);
    }
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — core-side: subscribe to the global
   * discovery topic. Wired from {@link start} once the agent has
   * a working gossip handle AND has confirmed `nodeRole === 'core'`
   * with host mode enabled. Idempotent — the gossip layer dedupes
   * subscribe/onMessage calls for the same topic.
   */
  subscribeCgDiscoveryTopic(this: DKGAgent): void {
    this.gossip.subscribe(DKG_CG_DISCOVERY_TOPIC);
    this.gossip.onMessage(DKG_CG_DISCOVERY_TOPIC, (_topic, data, from) => {
      this.handleIncomingCgDiscoveryBeacon(data, from).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(createOperationContext('share'), `Beacon handler error from ${from}: ${msg}`);
      });
    });
  }

  /**
   * Validate a received beacon and, on accept, register the
   * `wireId → curator EOA` mapping plus delegate to the host-mode
   * reconciler — which applies the sharding-table + role checks the
   * same way the chain-event auto-subscribe path does.
   *
   * Rejections are logged at DEBUG (one per failed beacon would
   * flood logs on a busy network); we surface only the first
   * rejection per curator per minute. Accepted beacons log at INFO.
   */
  async handleIncomingCgDiscoveryBeacon(this: DKGAgent, data: Uint8Array, fromPeer: string): Promise<void> {
    if (!this.swmHostModeStore) return;
    const ctx = createOperationContext('share');
    const beacon = decodeCgDiscoveryBeacon(data);
    if (!beacon) {
      this.log.debug(ctx, `Beacon from ${fromPeer} dropped: malformed wire bytes`);
      return;
    }
    const verdict = verifyCgDiscoveryBeacon(beacon, Math.floor(Date.now() / 1000));
    if (!verdict.ok) {
      this.log.debug(ctx, `Beacon from ${fromPeer} rejected: ${verdict.reason}`);
      return;
    }
    if (beacon.accessPolicy !== BEACON_ACCESS_POLICY_CURATED) {
      // Public CG beacons are a no-op for host mode — the curator
      // shouldn't have broadcast one; ignore quietly.
      return;
    }
    const wireId = beacon.nameHash;
    const curatorEoa = beacon.curatorEoa;

    const previousCurator = this.beaconCuratorByWireId.get(wireId);
    if (previousCurator && previousCurator !== curatorEoa) {
      // Two different wallets claiming the same wireId is a hash
      // collision OR a curator-rotation event. Reject the second
      // claim (first-claim-wins) so an attacker can't hijack the
      // budget bookkeeping for an already-trusted CG.
      this.log.warn(
        ctx,
        `Beacon from ${fromPeer} for wireId=${wireId.slice(0, 12)}… rejected: ` +
          `claimed curator ${curatorEoa.slice(0, 10)}… contradicts pinned ${previousCurator.slice(0, 10)}…`,
      );
      return;
    }
    this.beaconCuratorByWireId.set(wireId, curatorEoa);

    // Stage the synthetic subscription record + wire-id reverse mapping through
    // the canonical subscription mutator. The hash is the local id for cores
    // that did not create or join the CG.
    if (!this.subscribedContextGraphs.has(wireId)) {
      this.setContextGraphSubscription(wireId, {
        subscribed: false,
        synced: false,
        onChainHash: wireId,
        pendingMeta: true,
      }, { persist: false });
    } else {
      const existing = this.subscribedContextGraphs.get(wireId)!;
      this.setContextGraphSubscription(wireId, { ...existing, onChainHash: wireId }, { persist: false });
    }

    try {
      await this.reconcileSwmHostModeSubscription(wireId, SUBSCRIPTION_SOURCES.BEACON);
      this.log.info(
        ctx,
        `Beacon-driven auto-host engaged for wireId=${wireId.slice(0, 12)}… (curator=${curatorEoa.slice(0, 10)}…, from=${fromPeer})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Beacon-driven host-mode reconcile failed for ${wireId.slice(0, 12)}…: ${msg}`);
    }
  }

  /**
   * Receiver handler for `/dkg/10.0.1/swm-host-catchup`. Responds
   * with stored ciphertext envelopes for the requested CG, paged
   * by `sinceSeqno`. Always returns a structured response; denial
   * is communicated via the `denied` field rather than throwing
   * (which would make the messenger substrate classify the call as
   * a transport failure and retry).
   */
  async handleSwmHostCatchup(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    if (!this.swmHostModeStore) {
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: 'host-mode not enabled on this node',
        entries: [],
      });
    }
    // OT-RFC-49 WS-A — RETIRE the host-mode catch-up egress. With the
    // private-ciphertext strip ON (default), a stripped core serves nothing
    // private: this responder only ever returns private SWM ciphertext, so
    // we deny BEFORE decoding the request. Members backfill from the curator
    // (REPLACE-recovery), never from a core. Set `stripCiphertext:false` to
    // restore legacy serving (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.debug(
        ctx,
        `host-catchup served NOTHING from=${fromPeerId}: private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores serve zero private SWM ciphertext)`,
      );
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: 'private-ciphertext strip is on (OT-RFC-49 WS-A): host-mode custody retired',
        entries: [],
      });
    }
    let req;
    try {
      req = decodeSwmHostCatchupRequest(data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        nextSeqno: 0,
        truncated: false,
        denied: `malformed request: ${reason}`,
        entries: [],
      });
    }

    // OT-RFC-38 LU-6 B1: signature + freshness + replay-defence +
    // chain-anchored authorization. Pre-B1 the handler treated the
    // libp2p peer-id as an authority token, which leaked metadata
    // (existence/timing/volume of curated CGs) to any connected peer
    // that knew or guessed the wire id — see comment block below at
    // the authorization branch for the threat-model rationale.
    const authResult = await this.authorizeSwmHostCatchupRequest(req, fromPeerId, Date.now());
    if (!authResult.ok) {
      this.log.info(
        ctx,
        `host-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${req.requesterEoa}: ${authResult.reason}`,
      );
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: false,
        denied: authResult.reason,
        entries: [],
      });
    }

    const maxEntries = req.maxEntries ?? SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES;
    const maxBytes = req.maxBytes ?? SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES;
    let raw;
    try {
      raw = await this.swmHostModeStore.iterate(req.contextGraphId, req.sinceSeqno, maxEntries + 1);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `host-catchup iterate failed cg=${req.contextGraphId} from=${fromPeerId}: ${reason}`);
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: false,
        denied: `store error: ${reason}`,
        entries: [],
      });
    }
    const truncatedByEntries = raw.length > maxEntries;
    if (truncatedByEntries) raw = raw.slice(0, maxEntries);
    const entries: SwmHostCatchupResponseEntry[] = [];
    let runningBytes = 0;
    let truncatedByBytes = false;
    let skippedOversizeFirst = false;
    for (const entry of raw) {
      // Codex PR #610 round-2 #4: don't bypass the byte cap for the
      // first entry. Pre-fix, the `entries.length > 0` guard meant a
      // single oversize envelope (close to or above `maxBytes`) was
      // always returned even when it exceeded the caller's cap. The
      // base64 expansion (~33% overhead) plus protocol-router wrapper
      // pushed responses past the messenger's 10 MiB read limit and
      // made catchup fail for legitimate large shares. Treat an
      // oversize first entry as truncation instead — the caller
      // either bumps `maxBytes` and retries or skips past the
      // problematic seqno.
      const base64Size = Math.ceil(entry.envelopeBytes.length / 3) * 4;
      if (runningBytes + base64Size > maxBytes) {
        if (entries.length === 0) skippedOversizeFirst = true;
        truncatedByBytes = true;
        break;
      }
      entries.push({
        seqno: entry.seqno,
        timestampMs: entry.timestampMs,
        envelopeB64: Buffer.from(entry.envelopeBytes).toString('base64'),
      });
      runningBytes += base64Size;
    }
    if (skippedOversizeFirst) {
      const oversizeSeqno = raw[0]?.seqno ?? req.sinceSeqno;
      const oversizeBase64 = Math.ceil((raw[0]?.envelopeBytes.length ?? 0) / 3) * 4;
      this.log.warn(
        ctx,
        `host-catchup oversize entry at seqno=${oversizeSeqno} cg=${req.contextGraphId} from=${fromPeerId}: ` +
        `envelope alone exceeds maxBytes=${maxBytes} after base64 (~${oversizeBase64}B) — returning denied`,
      );
      // Surface as `denied` so the caller breaks out of its
      // pagination loop instead of spinning forever on a seqno that
      // can't fit in the response (would otherwise loop because
      // `nextSeqno` stays equal to `sinceSeqno` when entries=0).
      return encodeSwmHostCatchupResponse({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        nextSeqno: req.sinceSeqno,
        truncated: true,
        denied: `oversize-entry: seqno=${oversizeSeqno} envelope=${oversizeBase64}B > maxBytes=${maxBytes}`,
        entries: [],
      });
    }
    const nextSeqno = entries.length > 0 ? entries[entries.length - 1].seqno : req.sinceSeqno;
    this.log.info(
      ctx,
      `host-catchup served cg=${req.contextGraphId} from=${fromPeerId} sinceSeqno=${req.sinceSeqno} entries=${entries.length} bytes=${runningBytes} truncated=${truncatedByEntries || truncatedByBytes}`,
    );
    return encodeSwmHostCatchupResponse({
      version: SWM_HOST_CATCHUP_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      nextSeqno,
      truncated: truncatedByEntries || truncatedByBytes,
      entries,
    });
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — responder for the
   * `/dkg/10.0.2/get-ciphertext-chunk` sync verb. Loads one
   * `(cgId, batchId, chunkIndex)` ciphertext from the local
   * triple-store-backed chunk store and returns the base64 bytes
   * (or a typed denial: bad signature, unauthorized, missing
   * chunk). Authorization piggybacks on the existing LU-6
   * UNION-of-authorities gate: any source that recognises the
   * requester EOA accepts (on-chain participants, beacon curator,
   * local agent gate, libp2p peer allowlist). PR-B will refine
   * this to include a sharding-table-membership chain probe so
   * late-joining hosting cores (which won't be on the agent
   * allowlist) can backfill ciphertexts they need to participate
   * in RFC-39 random sampling.
   */
  async handleGetCiphertextChunk(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    // OT-RFC-49 WS-A — RETIRE the LU-11 ciphertext-chunk peer-serve. With the
    // private-ciphertext strip ON (default), a stripped core serves no private
    // ciphertext — INCLUDING via the OT-RFC-39 node-operator authority branch
    // below, which would otherwise admit any registered operator. We deny
    // BEFORE decoding so the strip is a hard, unconditional cutoff regardless
    // of requester authority. Set `stripCiphertext:false` to restore the
    // legacy chunk-serve (kill-switch / A/B baseline).
    if (this.swmHostModeStripCiphertext()) {
      this.log.debug(
        ctx,
        `LU-11 chunk-catchup served NOTHING from=${fromPeerId}: private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — cores serve zero private SWM ciphertext, incl. the RFC-39 node-operator branch)`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        batchIdHex: '',
        chunkIndex: -1,
        denied: 'private-ciphertext strip is on (OT-RFC-49 WS-A): host-mode custody retired',
      });
    }
    let req: CiphertextChunkCatchupRequest;
    try {
      req = decodeCiphertextChunkCatchupRequest(data);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: '',
        batchIdHex: '',
        chunkIndex: -1,
        denied: `malformed request: ${reason}`,
      });
    }
    const nowMs = Date.now();
    const verify = verifySignedCiphertextChunkCatchupRequest(req, nowMs);
    if (!verify.ok || !verify.recoveredSigner) {
      this.log.info(
        ctx,
        `LU-11 chunk-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${req.requesterEoa} chunkIndex=${req.chunkIndex}: ${verify.reason}`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: verify.reason ?? 'signature verification failed',
      });
    }
    const requesterEoa = verify.recoveredSigner;
    if (!this.ciphertextChunkCatchupReplayGuard.recordIfFresh(requesterEoa, req.nonce, req.issuedAtMs, nowMs)) {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'replayed chunk-catchup nonce',
      });
    }

    // Reuse the LU-6 host-catchup authorization shape via a thin
    // adapter — same UNION-of-authorities logic, but the chunk-catchup
    // request payload lacks `sinceSeqno`/`maxEntries`/`maxBytes` so
    // we pack the chunked-request fields into the shared verifier's
    // shape with zero-defaults for the unused slots. (The shared
    // authorization helper only reads `contextGraphId` and the EOA;
    // the other fields are signature-digest input, not authorization
    // input.)
    let authOk = false;
    let authReason: string = 'no authority source available for context graph';
    const requesterLower = requesterEoa.toLowerCase();
    let anyAuthorityFound = false;
    try {
      const chainParticipants = await this.resolveOnChainParticipantAgents(req.contextGraphId);
      if (chainParticipants !== null) {
        anyAuthorityFound = true;
        if (chainParticipants.some((a) => a.toLowerCase() === requesterLower)) authOk = true;
      }
    } catch { /* probe failure non-fatal */ }
    if (!authOk) {
      try {
        const beaconCurator = await this.resolveBeaconPinnedCuratorEoa(req.contextGraphId);
        if (beaconCurator) {
          anyAuthorityFound = true;
          if (beaconCurator.toLowerCase() === requesterLower) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    if (!authOk) {
      try {
        const agentGate = await this.getContextGraphAgentGateAddresses(req.contextGraphId);
        if (agentGate !== null) {
          anyAuthorityFound = true;
          if (agentGate.some((a) => a.toLowerCase() === requesterLower)) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    if (!authOk) {
      try {
        const allowedPeers = await this.getContextGraphAllowedPeers(req.contextGraphId);
        if (allowedPeers !== null) {
          anyAuthorityFound = true;
          if (allowedPeers.includes(fromPeerId)) authOk = true;
        }
      } catch { /* probe failure non-fatal */ }
    }
    // OT-RFC-39 fifth authority — registered node operator.
    //
    // The four authorities above are MEMBER- or CURATOR-shaped: they
    // gate "can this EOA decrypt / participate in" the CG. Curated
    // CGs almost never list every sharding-table core in
    // `allowedAgents` (curators only enrol agents that need to
    // decrypt), so the existing layers deny EVERY core-to-core
    // chunk fetch — exactly the late-join scenario OT-RFC-39 is
    // designed to fix. Closing that gap means admitting any peer
    // whose EOA is a registered node operator (identityId > 0n on
    // chain). Three reasons this is safe for the CIPHERTEXT path
    // (and not generalisable to plaintext catchup):
    //
    //  1. The bytes carried are AEAD-encrypted with the curator's
    //     sender key. A node operator without the sender key gets
    //     opaque ciphertext that is computationally indistinguishable
    //     from random, so no decryption power leaks.
    //
    //  2. The on-chain `(ciphertextChunksRoot, ciphertextChunkCount)`
    //     commitment is already public — anyone observing chain state
    //     learns "curated KC X has N chunks of size up to S each"
    //     without needing the wire fetch. The metadata our responder
    //     reveals is a strict subset of what the chain already
    //     reveals.
    //
    //  3. Registering an on-chain identity costs TRAC stake — it's
    //     a Sybil-resistant credential. Pairing the EOA recovery
    //     above (which proves the requester holds the operator key)
    //     with a non-zero identityId restricts ciphertext fetch to
    //     the same trust set the random-sampling picker draws from,
    //     which is the spec-intended population for hosting.
    //
    // Wire effect: the late-join sync verb now succeeds for any
    // sharding-table core requesting chunks for any curated CG. The
    // prover's auto-backfill can complete; the missed core proves
    // its hosting and earns rewards on the period it would otherwise
    // forfeit.
    if (!authOk && typeof this.chain.getIdentityIdForAddress === 'function') {
      try {
        const reqIdentityId = await this.chain.getIdentityIdForAddress(requesterEoa);
        if (reqIdentityId > 0n) {
          anyAuthorityFound = true;
          authOk = true;
          this.log.debug(
            ctx,
            `LU-11 chunk-catchup admitted via OT-RFC-39 node-operator authority cg=${req.contextGraphId} requesterEoa=${requesterEoa} identityId=${reqIdentityId.toString()}`,
          );
        }
      } catch (err) {
        this.log.debug(
          ctx,
          `LU-11 chunk-catchup node-operator probe failed cg=${req.contextGraphId} requesterEoa=${requesterEoa}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!authOk) {
      authReason = anyAuthorityFound
        ? 'requester EOA not in any of: on-chain participants, beacon curator, local agent-gate, allowedPeers, node-operator-registry'
        : 'no authority source available for context graph';
      this.log.info(
        ctx,
        `LU-11 chunk-catchup denied cg=${req.contextGraphId} from=${fromPeerId} requesterEoa=${requesterEoa} chunkIndex=${req.chunkIndex}: ${authReason}`,
      );
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: authReason,
      });
    }

    // Locate the chunk. Codex review (round 2) on PR #727: pin to the
    // per-CG named graph when we can safely canonicalize `req.contextGraphId`
    // (cleartext / bare-hex / locally-registered numeric on-chain id),
    // and fall back to the wildcard `GRAPH ?g` scan when we can't. The
    // previous PR #715 fix would have keccak'd a literal decimal string
    // like "42" and produced a hash that did NOT match the curator
    // nameHash → "chunk not found" for any requester that addressed
    // the CG by its numeric on-chain id, narrowing the public API in
    // a way that wasn't advertised. Scoped pinning still gives us the
    // multi-CG identical-KC isolation we wanted from PR #715 whenever
    // canonicalization succeeds; the wildcard fallback preserves the
    // historical responder contract for the catching-up / numeric-id
    // cases.
    const canonicalCgIdForChunks = this.canonicalChunkStoreCgIdOrNull(req.contextGraphId);
    const chunksGraphForLookup = canonicalCgIdForChunks
      ? ciphertextChunkStoreGraph(canonicalCgIdForChunks)
      : null;
    const graphClause = chunksGraphForLookup
      ? `GRAPH <${chunksGraphForLookup}>`
      : 'GRAPH ?g';
    const subject = ciphertextChunkStoreSubject(req.batchId, req.chunkIndex);
    const sparql = `SELECT ?o WHERE { ${graphClause} { <${subject}> <${CIPHERTEXT_CHUNK_PREDICATE}> ?o } } LIMIT 1`;
    let result;
    try {
      result = await this.store.query(sparql, { source: 'agent.ciphertextChunkCatchup' });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `LU-11 chunk-catchup store query failed cg=${req.contextGraphId} chunkIndex=${req.chunkIndex}: ${reason}`);
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: `store error: ${reason}`,
      });
    }
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'chunk not found',
      });
    }
    const literal = result.bindings[0]?.['o'];
    if (typeof literal !== 'string') {
      return encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: req.contextGraphId,
        batchIdHex: ethers.hexlify(req.batchId),
        chunkIndex: req.chunkIndex,
        denied: 'chunk stored value malformed',
      });
    }
    const ciphertextB64 = literal.startsWith('"') && literal.endsWith('"')
      ? literal.slice(1, -1)
      : literal;
    this.log.debug(
      ctx,
      `LU-11 chunk-catchup served cg=${req.contextGraphId} from=${fromPeerId} batchId=${ethers.hexlify(req.batchId).slice(0, 18)}... chunkIndex=${req.chunkIndex} bytes=${Buffer.from(ciphertextB64, 'base64').length}`,
    );
    return encodeCiphertextChunkCatchupResponse({
      version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
      contextGraphId: req.contextGraphId,
      batchIdHex: ethers.hexlify(req.batchId),
      chunkIndex: req.chunkIndex,
      ciphertextB64,
    });
  }

  /**
   * OT-RFC-38 LU-11 / OT-RFC-39 — requester for the
   * `/dkg/10.0.2/get-ciphertext-chunk` sync verb. Pulls one
   * `(cgId, batchId, chunkIndex)` ciphertext from a known host and
   * (when `persist === true`) writes it into the local per-chunk
   * store so the V2 ACK verifier sees it on the next pass. Returns
   * the raw decoded response so callers can inspect denial reasons
   * or feed bytes to a member-side verifier.
   *
   * Late-joining hosting cores call this in a loop to backfill the
   * `(cgId, batchId, 0..count-1)` set after seeing
   * `KnowledgeCollectionCiphertextCommitmentSet` on chain or
   * `MISSING_CIPHERTEXT_CHUNKS` from a V2 ACK request they
   * routed forward. Loop policy + peer selection are intentionally
   * caller-owned — this method is the single-pull primitive.
   */
  async fetchCiphertextChunkFromPeer(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    batchId: Uint8Array,
    chunkIndex: number,
    options?: {
      persist?: boolean;
      /**
       * @deprecated Reserved for a future alternate-signer plumb-through.
       *   No-op today: the closure below always uses
       *   `this.chain.signMessage`. Kept on the public signature so
       *   existing TypeScript callers continue to compile through the
       *   rc.12 line (Codex review round 2 on PR #727 flagged
       *   removing it as a breaking API change). Will be removed in a
       *   future intentional major-version break — either replaced by
       *   a real signer callback (`sign?: (digest) => Promise<string>`)
       *   or dropped entirely if no caller ever materialises.
       */
      signWithChainAdapter?: boolean;
    },
  ): Promise<CiphertextChunkCatchupResponse> {
    if (batchId.length !== 32) {
      throw new Error(`fetchCiphertextChunkFromPeer requires a 32-byte batchId; got ${batchId.length}`);
    }
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(`fetchCiphertextChunkFromPeer requires a non-negative chunkIndex; got ${chunkIndex}`);
    }
    const ctx = createOperationContext('share');
    // Codex review on PR #715 / #717 / #727: the option above is a
    // back-compat no-op. The implementation requires a chain adapter
    // with `signMessage`; there is no real alternate-signer path yet,
    // so callers must wire the chain. Honest error if absent.
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('fetchCiphertextChunkFromPeer: chain adapter does not expose signMessage; the LU-11 sync verb requires an operator-key signer');
    }
    const sign = async (digest: Uint8Array) => {
      // Match the host-catchup pattern: chain.signMessage returns
      // {r, vs}; re-serialise to the 65-byte EIP-191 hex shape.
      const { r, vs } = await this.chain.signMessage!(digest);
      const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
      return sig.serialized;
    };
    const signedReq = await mintSignedCiphertextChunkCatchupRequest({
      contextGraphId,
      batchId,
      chunkIndex,
      sign,
    });
    const reqBytes = encodeCiphertextChunkCatchupRequest(signedReq);
    const sendResult = await this.messenger.sendReliable(remotePeerId, PROTOCOL_GET_CIPHERTEXT_CHUNK, reqBytes);
    if (!sendResult.delivered) {
      throw new Error(`LU-11 chunk-catchup transport failed: ${sendResult.error}`);
    }
    const resp = decodeCiphertextChunkCatchupResponse(sendResult.response);
    if (options?.persist && resp.ciphertextB64) {
      const subject = ciphertextChunkStoreSubject(batchId, chunkIndex);
      const literal = `"${resp.ciphertextB64}"`;
      // Codex review on PR #715 (refined round 2 on PR #727): use the
      // central canonical helper so this persist site matches the
      // ingest persist site exactly, including the safe fallback when
      // canonicalization can't resolve. `contextGraphId` here is the
      // local CG id the prover-side backfill passed in (cleartext
      // resolved via `resolveLocalCgIdByOnChainId` in
      // `buildCiphertextChunkBackfill`), so the helper normally
      // returns a wire hash; the null path is theoretical defense.
      const persistCanonical = this.canonicalChunkStoreCgIdOrNull(contextGraphId);
      const chunksGraphForPersist = ciphertextChunkStoreGraph(persistCanonical ?? contextGraphId);
      try {
        await this.store.insert([{
          subject,
          predicate: CIPHERTEXT_CHUNK_PREDICATE,
          object: literal,
          graph: chunksGraphForPersist,
        }]);
        this.log.debug(
          ctx,
          `LU-11 chunk-catchup persisted cg=${contextGraphId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex} from=${remotePeerId}`,
        );
      } catch (err) {
        this.log.warn(
          ctx,
          `LU-11 chunk-catchup persistence failed cg=${contextGraphId} batchId=${ethers.hexlify(batchId).slice(0, 18)}... chunkIndex=${chunkIndex}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return resp;
  }

  /**
   * OT-RFC-39 — resolve a numeric on-chain CG id (the form the prover
   * sees from `createChallenge` / `getKAContextGraphId`) back to the
   * local cleartext id this agent registered the CG under. Scans
   * `subscribedContextGraphs` because the reverse map is keyed by the
   * wire-form `onChainHash`, not the numeric id. Returns null when
   * this node has never seen the CG (legitimate during the chain-event
   * replay race window after restart — caller falls back to passing
   * the numeric id as a string, which the responder's authorization
   * layer also resolves via on-chain participant lookup).
   */
  resolveLocalCgIdByOnChainId(this: DKGAgent, onChainId: bigint): string | null {
    const target = onChainId.toString();
    // Multiple local records can share one on-chain id: a synthetic
    // hash-keyed host record (`subscribed: false`, minted from
    // `ContextGraphCreated`) can coexist with the real subscribed cleartext
    // CG. Prefer the subscribed match so live KACG nudges + reconcile target
    // the CG a user actually reads; fall back to the first record otherwise
    // (the host-only / post-restart replay-window case callers tolerate).
    let fallback: string | null = null;
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId !== target) continue;
      if (sub.subscribed) return localId;
      if (fallback === null) fallback = localId;
    }
    return fallback;
  }

  bumpContextGraphBindingGeneration(this: DKGAgent, localCgId: string): number {
    return this.contextGraphBindingState.bump(localCgId);
  }

  captureContextGraphBindingGeneration(this: DKGAgent, localCgId: string): number {
    return this.contextGraphBindingState.capture(localCgId);
  }

  isContextGraphBindingGenerationCurrent(
    this: DKGAgent,
    localCgId: string,
    generation: number,
  ): boolean {
    return this.contextGraphBindingState.isGenerationCurrent(localCgId, generation);
  }

  /** Invalidate an untrusted reverse candidate and every VM cursor tied to it. */
  clearSubscriptionReverseNameHashBinding(
    this: DKGAgent,
    localCgId: string,
  ): boolean {
    if (!this.contextGraphBindingState.clear(localCgId)) return false;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
    return true;
  }

  /**
   * Bind (or rebind) a local CG to an on-chain CG id, resetting the
   * chain-driven reconcile watermark if the bound id actually CHANGES.
   *
   * The persisted `lastReconciledOrdinal` is the count of contiguous KAs
   * promoted for a *specific* on-chain graph. If the same local CG id is later
   * repaired/recreated under a different on-chain id, that watermark no longer
   * refers to the same chain graph — reusing it would make the sweep start at
   * the wrong ordinal and permanently skip earlier KAs. So when the id changes
   * we zero the watermark and drop the in-memory cursor; the reset is persisted
   * together with the new id, keeping it restart-safe.
   */
  bindSubscriptionOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    newOnChainId: string,
  ): void {
    const transition = this.contextGraphBindingState.bindAuthoritative(
      localCgId,
      sub,
      newOnChainId,
    );
    if (!transition.changed) return;
    if (!transition.onChainIdChanged) return;
    // The bound on-chain id actually CHANGED (repair / recreate / re-register).
    // Any prior reconcile progress refers to the OLD chain graph and must be
    // dropped, otherwise the sweep resumes at the wrong ordinal and skips
    // early KAs of the new graph. Progress can hide in two places: the
    // persisted `lastReconciledOrdinal` watermark AND an in-memory cursor that
    // still holds `ahead` ordinals while its watermark is 0 (e.g. ordinals
    // reconciled but waiting on confirmation depth). Reset BOTH on any id
    // change — not only when the persisted watermark happens to be positive.
    const hadProgress =
      (sub.lastReconciledOrdinal ?? 0) > 0 || this.reconcileCursors.has(localCgId);
    sub.lastReconciledOrdinal = 0;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
    if (hadProgress) {
      this.log.info(
        createOperationContext('system'),
        `VM reconcile: on-chain id for "${localCgId}" changed ` +
        `${transition.previous?.onChainId}->${newOnChainId}; reset reconcile watermark + cursor to 0`,
      );
    }
  }

  /**
   * Install a reverse-derived VM candidate without promoting it to the shared
   * authoritative `onChainId` field. The candidate is process-local and every
   * VM use revalidates it against the current complete name-hash inventory.
   */
  bindSubscriptionReverseNameHashOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    newOnChainId: string,
    nameHash: string,
  ): void {
    const transition = this.contextGraphBindingState.bindReverseCandidate(
      localCgId,
      sub,
      newOnChainId,
      nameHash,
    );
    if (!transition.changed) return;
    const hadProgress =
      (sub.lastReconciledOrdinal ?? 0) > 0 || this.reconcileCursors.has(localCgId);
    if (hadProgress) {
      sub.lastReconciledOrdinal = 0;
      this.forceClearVmReconcileStateForContextGraph(localCgId);
    }
    if (hadProgress) {
      this.log.info(
        createOperationContext('system'),
        `VM reconcile: reverse-derived on-chain id for "${localCgId}" changed ` +
        `${transition.previous?.onChainId ?? 'unbound'}->${newOnChainId}; ` +
        'reset reconcile watermark + cursor to 0',
      );
    }
  }

  async readCoreHostedPublicCgAccessPolicy(this: DKGAgent, onChainId: string): Promise<0 | 1 | null> {
    const numericId = BigInt(onChainId);
    const raceChainRead = async <T>(start: () => T | Promise<T>): Promise<T | typeof TIMEOUT_SENTINEL> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), CHAIN_POLICY_READ_TIMEOUT_MS);
        timer.unref?.();
      });
      let work: Promise<T>;
      try {
        work = Promise.resolve(start()).finally(() => { if (timer) clearTimeout(timer); });
      } catch (err) {
        if (timer) clearTimeout(timer);
        throw err;
      }
      return Promise.race([work, timeout]);
    };
    const readAccessPolicy = async (useCache: boolean): Promise<0 | 1 | null> => {
      const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
      if (typeof getAccessPolicy !== 'function') return null;
      const cached = this.onChainAccessPolicyCache.get(onChainId);
      if (useCache && (cached === 0 || cached === 1)) return cached;
      try {
        const policy = await raceChainRead(() => getAccessPolicy.call(this.chain, numericId));
        if (policy === TIMEOUT_SENTINEL) {
          this.log.warn(
            createOperationContext('system'),
            `recordCoreHostedPublicCg(${onChainId}): getContextGraphAccessPolicy timed out after ` +
            `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — treating hosted CG access policy as UNKNOWN`,
          );
          return null;
        }
        if (policy === 0 || policy === 1) {
          this.onChainAccessPolicyCache.set(onChainId, policy);
          return policy;
        }
        return null;
      } catch {
        return null;
      }
    };

    const isActive = this.chain.isContextGraphActiveOnChain;
    if (typeof isActive !== 'function') return readAccessPolicy(true);
    try {
      const live = await raceChainRead(() => isActive.call(this.chain, numericId));
      if (live === true) return readAccessPolicy(false);
      if (live !== TIMEOUT_SENTINEL) return null;
      this.log.warn(
        createOperationContext('system'),
        `recordCoreHostedPublicCg(${onChainId}): isContextGraphActiveOnChain timed out after ` +
        `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — falling back to ACK-backed access policy read`,
      );
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `recordCoreHostedPublicCg(${onChainId}): isContextGraphActiveOnChain failed: ` +
        `${err instanceof Error ? err.message : String(err)} — falling back to ACK-backed access policy read`,
      );
    }

    try {
      // StorageACK signing proves this specific registration was live enough
      // to host. If the optional liveness probe itself flakes, preserve the
      // host-tracking path and only fail closed when the policy read is unknown.
      return await readAccessPolicy(true);
    } catch {
      return null;
    }
  }

  /**
   * Phase D (Cores fill their own gaps) — invoked from the StorageACK
   * pre-sign hook. When this Core signs an ACK for a PUBLIC CG it becomes a
   * storage node for it; mark the CG `coreHosted` (persisted) so the
   * chain-driven VM reconciler runs for it across restarts even without a
   * member subscription. A Core that was offline during the *next* publish
   * then learns the missed KA from chain on restart and pulls it core-first.
   *
   * Public-only by design: curated CGs are hosted as opaque ciphertext, which
   * a Core cannot promote to plaintext VM — their coverage stays on the
   * host-mode reconciler + LU-11 chunk-backfill path. Best-effort + idempotent.
   */
  async recordCoreHostedPublicCg(this: DKGAgent, cgId: string, swmGraphId?: string): Promise<void> {
    if (this.coreHostRecordingsClosed) return;
    if (!this.vmReconcileEnabled()) return;
    const recordingGeneration = this.coreHostRecordingGeneration;
    let numeric: bigint;
    try {
      numeric = BigInt(cgId);
    } catch {
      return; // non-numeric id can't be reconciled against the chain ordinal list
    }
    if (numeric <= 0n) return;

    const numericStr = numeric.toString();
    // Existence-gated read when the adapter exposes liveness; otherwise use
    // the ACK-backed compatibility path because signing a StorageACK proves
    // this specific CG registration is live enough for host tracking.
    const policy = await this.readCoreHostedPublicCgAccessPolicy(numericStr);
    if (this.coreHostRecordingGeneration !== recordingGeneration) return;
    if (policy !== 0) return; // curated / unknown / not-live — not the public VM-promote path

    // Pick the local CG id to key the host-only record under. Prefer an
    // existing local mapping; otherwise use the publisher-supplied cleartext
    // `swmGraphId` (the local CG name for a public/cleartext publish). On the
    // FIRST ACK for a CG we only host (never subscribed to),
    // `resolveLocalCgIdByOnChainId()` is still empty — falling back to the
    // numeric id would persist the row under `did:dkg:context-graph:<numeric>`,
    // a namespace that doesn't hold the hosted SWM snapshot, so after restart
    // the reconciler + active-fetch would sync/promote against the wrong graph
    // and miss the KA this core already ACKed. The cleartext hint keeps the
    // row under the same id the reconciler uses.
    // Discard the hint ONLY when it's empty or literally the on-chain numeric
    // id (no information) — NOT merely because it's all-digits: a public CG's
    // local cleartext id can be numeric (e.g. "1" is a valid contextGraphId
    // elsewhere in the repo), and rejecting it would wrongly key the row under
    // the on-chain id and miss the hosted KA after restart.
    const cleartextHint = swmGraphId && swmGraphId !== numericStr
      ? swmGraphId
      : undefined;
    const localCgId = this.resolveLocalCgIdByOnChainId(numeric) ?? cleartextHint ?? numericStr;
    const existing = this.subscribedContextGraphs.get(localCgId);
    if (existing?.coreHosted && existing.onChainId === numericStr) return; // already recorded

    let next: ContextGraphSub;
    if (existing) {
      // Rebind through the helper so a CG re-created/rebound under the same
      // local id drops its stale reconcile watermark + in-memory cursor before
      // we persist the new on-chain id. A bare `onChainId` overwrite would keep
      // the old `lastReconciledOrdinal`, making the sweep resume at the prior
      // graph's ordinal and permanently skip the new graph's early KAs.
      this.bindSubscriptionOnChainId(localCgId, existing, numericStr);
      existing.coreHosted = true;
      next = existing;
    } else {
      next = {
        syncMode: 'always-on',
        subscribed: false,
        synced: false,
        onChainId: numericStr,
        coreHosted: true,
      };
    }
    this.setContextGraphSubscription(localCgId, next);
    this.log.info(
      createOperationContext('system'),
      `Phase D: marked public cg=${numericStr} as core-hosted (will chain-reconcile to VM across restarts)`,
    );
    // Nudge a reconcile now so the first hosted publish lands promptly; the
    // periodic sweep is the safety net.
    if (this.vmReconcileDispatcher) void this.vmReconcileDispatcher.triggerLive(localCgId);
  }

  trackCoreHostRecording(this: DKGAgent, start: () => Promise<void>): void {
    if (this.coreHostRecordingsClosed) return;
    let recording: Promise<void>;
    try {
      recording = start();
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `Phase D: recordCoreHostedPublicCg failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const tracked = recording.catch((err) => {
      this.log.warn(
        createOperationContext('system'),
        `Phase D: recordCoreHostedPublicCg failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }).finally(() => {
      this.coreHostRecordings.delete(tracked);
    });
    this.coreHostRecordings.add(tracked);
  }

  async drainCoreHostRecordings(this: DKGAgent): Promise<void> {
    const ctx = createOperationContext('system');
    while (this.coreHostRecordings.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), DKGAgentBase.CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        Promise.allSettled([...this.coreHostRecordings])
          .then(() => 'drained' as const)
          .finally(() => { if (timer) clearTimeout(timer); }),
        timeout,
      ]);
      if (outcome === 'timeout') {
        const pending = this.coreHostRecordings.size;
        this.log.warn(
          ctx,
          `Phase D: timed out draining ${pending} core-host recording(s) after ` +
          `${DKGAgentBase.CORE_HOST_RECORDING_DRAIN_TIMEOUT_MS}ms; continuing shutdown`,
        );
        this.coreHostRecordings.clear();
        this.coreHostRecordingGeneration += 1;
        return;
      }
    }
  }

  // ===== Phase B — chain-driven VM reconciliation (B.4 agent wiring) =========

  /**
   * Phase E/F — emit one reconciliation telemetry event. Logs a structured
   * `chain-promote` line (grep surface) and forwards to the optional ops-metrics
   * sink (Phase F). Best-effort: never throws, never awaits the sink.
   */
  emitReplication(this: DKGAgent, ev: Omit<ReplicationEvent, 'ts'>): void {
    const event: ReplicationEvent = { ts: Date.now(), ...ev };
    const parts = [
      `chain-promote action=${event.action}`,
      `cg=${event.contextGraphId}`,
      event.onChainCgId ? `onChainCg=${event.onChainCgId}` : '',
      event.ordinal !== undefined ? `ordinal=${event.ordinal}` : '',
      event.kaId ? `ka=${event.kaId}` : '',
      event.fromWatermark !== undefined && event.toWatermark !== undefined ? `cursor=${event.fromWatermark}->${event.toWatermark}` : '',
      event.head !== undefined ? `head=${event.head}` : '',
      event.reconciled !== undefined ? `reconciled=${event.reconciled}` : '',
      event.pending !== undefined ? `pending=${event.pending}` : '',
      event.ual ? `ual=${event.ual}` : '',
      // JSON-encode `detail` so embedded quotes/newlines can't break the
      // structured `key=value` log line or inject bogus key/value fragments.
      event.detail ? `detail=${JSON.stringify(event.detail)}` : '',
    ].filter(Boolean);
    this.log.info(createOperationContext('system'), parts.join(' '));
    const sink = this.config.onReplicationEvent;
    if (sink) {
      try {
        sink(event);
      } catch (err) {
        this.log.warn(createOperationContext('system'), `onReplicationEvent sink threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * True iff the chain adapter exposes the per-CG registration-ordinal reads
   * the reconciler needs. Gates the live nudge, the sweep timer, and the
   * coalescer so non-V10 / no-chain nodes pay nothing.
   */
  vmReconcileEnabled(this: DKGAgent): boolean {
    return (
      this.chain.chainId !== 'none' &&
      typeof this.chain.getContextGraphKCCount === 'function' &&
      typeof this.chain.getContextGraphKCAt === 'function' &&
      typeof this.chain.getLatestMerkleRoot === 'function'
    );
  }

  /**
   * Trigger a coalesced reconcile sweep for every subscribed CG that has an
   * on-chain id. Used by the periodic timer + the startup prime. Per-CG work is
   * single-flighted by {@link vmReconcileDispatcher} so overlapping ticks (or a
   * burst of live nudges) collapse into one sweep per CG.
   */
  async runVmReconcileSweep(this: DKGAgent): Promise<void> {
    if (this.started && !this.vmReconcileRuntimeReady) return;
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    const dispatcher = this.vmReconcileDispatcher;
    if (!isLifecycleCurrent() || !this.vmReconcileEnabled() || !dispatcher) return;
    if (this.vmReconcileSweepInFlight) return this.vmReconcileSweepInFlight;
    const running = (async () => {
      const eligible: string[] = [];
      for (const [localCgId, sub] of this.subscribedContextGraphs) {
        if (!isLifecycleCurrent()) return;
        // GH #1098 — self-prime onChainId for a pre-subscribed PUBLIC member CG
        // (subscribed BEFORE its first publish, so unbound) before the skip-gate
        // below would pass it over. Shared with the live KACG nudge.
        const hasVmBindingCandidate = this.contextGraphBindingState.hasBindingCandidate(
          localCgId,
          sub,
        );
        if (sub.subscribed && !hasVmBindingCandidate) {
          await this.selfPrimeSubscriptionOnChainId(
            localCgId,
            sub,
            undefined,
            isLifecycleCurrent,
            lifecycleSignal,
          );
          if (!isLifecycleCurrent()) return;
        }
        // Member subscriptions AND Phase D core-hosted public CGs get swept.
        if (
          (!sub.subscribed && !sub.coreHosted)
          || !this.contextGraphBindingState.hasBindingCandidate(localCgId, sub)
        ) continue;
        eligible.push(localCgId);
      }

      if (eligible.length === 0) {
        this.vmReconcileSweepCursor = 0;
        return;
      }

      // Per-CG coalescing alone still let a cold start enqueue one expensive
      // scan per subscription. Admit and await periodic work one CG at a time;
      // foreground live/manual work can still enter the unified dispatcher.
      const start = this.vmReconcileSweepCursor % eligible.length;
      for (let offset = 0; offset < eligible.length; offset += 1) {
        if (!isLifecycleCurrent()) return;
        const index = (start + offset) % eligible.length;
        await dispatcher.dispatch(eligible[index]!, 'periodic').catch(() => undefined);
      }
      if (!isLifecycleCurrent()) return;
      this.vmReconcileSweepCursor = (start + 1) % eligible.length;
    })();
    this.vmReconcileSweepInFlight = running;
    try {
      await running;
    } finally {
      if (this.vmReconcileSweepInFlight === running) this.vmReconcileSweepInFlight = null;
    }
  }

  /**
   * GH #1098 — bind `sub.onChainId` for a subscribed-but-unbound CG from the
   * locally-resolvable OnChainId quad (publisher ontology broadcast / durable
   * _meta sync), then persist. The chain `ContextGraphCreated` handler only
   * binds CURATED CGs and the ACK-signer hook only fires for cores in a
   * publish's storage-ACK set, so a pre-subscribed PUBLIC member would otherwise
   * stay unbound — stranded on the unreliable one-shot finalization gossip.
   * SHARED by the periodic sweep and the live KACG nudge so the bind / persist /
   * cursor-reset semantics (in {@link bindSubscriptionOnChainId}) live in ONE
   * place. `targetOnChainId`: when set (the nudge), bind only if the resolved id
   * matches THIS event; when omitted (the sweep), bind any non-null id —
   * `getContextGraphOnChainId` never falls back to `localCgId`, so a
   * `resolved === localCgId` match is legitimate for a direct CG. Best-effort:
   * a store/RPC hiccup yields null instead of throwing. Returns the bound id.
   */
  async selfPrimeSubscriptionOnChainId(
    this: DKGAgent,
    localCgId: string,
    sub: ContextGraphSub,
    targetOnChainId?: bigint,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const bindingGeneration = this.contextGraphBindingState.capture(localCgId);
    const isSubscriptionCurrent = () => isCurrent()
      && this.subscribedContextGraphs.get(localCgId) === sub
      && sub.subscribed
      && !this.contextGraphBindingState.hasBindingCandidate(localCgId, sub)
      && this.contextGraphBindingState.isGenerationCurrent(localCgId, bindingGeneration);
    if (!isSubscriptionCurrent()) return null;
    let resolved: (
      | { onChainId: string; provenance: 'authoritative' | 'ontology' }
      | { onChainId: string; provenance: 'reverse-name-hash'; nameHash: string }
    ) | null = null;
    try {
      resolved = await raceVmReconcileAbort(
        this.resolveContextGraphOnChainIdBinding(localCgId, {
          signal,
          source: 'agent.vmReconcile.resolveOnChainId',
        }),
        signal,
      );
    } catch {
      return null;
    }
    if (!isSubscriptionCurrent() || !resolved) return null;
    if (targetOnChainId !== undefined) {
      let resolvedNum: bigint | null = null;
      try { resolvedNum = BigInt(resolved.onChainId); } catch { return null; }
      if (resolvedNum !== targetOnChainId) return null;
    }
    if (!isSubscriptionCurrent()) return null;
    if (resolved.provenance !== 'reverse-name-hash') {
      try {
        await this.persistContextGraphSubscriptionStrict(
          localCgId,
          { ...sub, onChainId: resolved.onChainId },
          undefined,
          isSubscriptionCurrent,
        );
      } catch {
        return null;
      }
    }
    if (!isSubscriptionCurrent()) return null;
    if (resolved.provenance === 'reverse-name-hash') {
      this.bindSubscriptionReverseNameHashOnChainId(
        localCgId,
        sub,
        resolved.onChainId,
        resolved.nameHash,
      );
    } else {
      this.bindSubscriptionOnChainId(localCgId, sub, resolved.onChainId);
    }
    return resolved.onChainId;
  }

  /**
   * GH #1098 (Phase B) — body of the live `onKARegisteredToContextGraph` nudge,
   * extracted so the branch is directly testable. A
   * `KnowledgeAssetRegisteredToContextGraph` event carries only `{ kaId, cgId }`
   * (no ordinal), so this just triggers a coalesced reconcile for the matching
   * local CG. Two cases:
   *
   *  1. The on-chain id is already bound to a local CG → trigger its reconcile
   *     (when subscribed or core-hosted).
   *  2. The id is unbound but a pre-subscribed PUBLIC member CG resolves to it
   *     (subscribed BEFORE its first publish; only curated CGs bind on the
   *     ContextGraphCreated event and ACK-signers bind via the storage-ACK hook)
   *     → self-prime + bind ONLY the CG whose resolved id matches THIS event,
   *     then reconcile it. Unrelated subscribed-unbound CGs are left untouched.
   *
   * Best-effort and idempotent: a missed nudge heals on the periodic sweep.
   * Returns the local CG id that was reconciled, or null if none matched.
   */
  async handleKARegisteredNudge(
    this: DKGAgent,
    onChainId: string,
    kaId: bigint,
    ctx: OperationContext,
  ): Promise<string | null> {
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    if (!isLifecycleCurrent()) return null;
    let targetOnChain: bigint | null = null;
    try { targetOnChain = BigInt(onChainId); } catch { targetOnChain = null; }

    const localCgId = targetOnChain === null ? null : this.resolveLocalCgIdByOnChainId(targetOnChain);
    if (!localCgId) {
      // Find the subscribed-but-unbound CG whose locally-resolved on-chain id
      // matches THIS event and bind + reconcile only it — targeted, not a global
      // sweep, so an unrelated KA registration touches nothing. Uses the SAME
      // self-prime helper as the periodic sweep (single bind/persist/cursor-reset
      // path); the sweep remains the safety net for a CG whose quad hasn't arrived.
      if (targetOnChain !== null) {
        for (const [lcg, sub] of this.subscribedContextGraphs) {
          if (!isLifecycleCurrent()) return null;
          if (
            sub.subscribed
            && this.contextGraphBindingState.matchesReverseCandidate(
              lcg,
              sub,
              targetOnChain.toString(),
            )
          ) {
            // Candidate equality is only a scheduling hint. The dispatched VM
            // target resolver re-enumerates the name hash before any chain/store
            // use, so an appended duplicate still fails closed.
            this.log.info(
              ctx,
              `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> schedule reverse-candidate revalidation for "${lcg}"`,
            );
            if (this.vmReconcileDispatcher && isLifecycleCurrent()) {
              void this.vmReconcileDispatcher.triggerLive(lcg);
            }
            return lcg;
          }
          const bound = await this.selfPrimeSubscriptionOnChainId(
            lcg,
            sub,
            targetOnChain,
            isLifecycleCurrent,
            lifecycleSignal,
          );
          if (!isLifecycleCurrent()) return null;
          if (bound) {
            this.log.info(ctx, `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> bound + reconcile pre-subscribed "${lcg}"`);
            if (this.vmReconcileDispatcher && isLifecycleCurrent()) {
              void this.vmReconcileDispatcher.triggerLive(lcg);
            }
            return lcg;
          }
        }
      }
      return null; // chain replay hasn't resolved the cleartext CG yet; periodic sweep is the safety net
    }

    const sub = this.subscribedContextGraphs.get(localCgId);
    // Populate VM for CGs we member-subscribe to OR (Phase D) public CGs this
    // Core hosts — a hosted Core fills its own gaps too.
    if (!isLifecycleCurrent() || (!sub?.subscribed && !sub?.coreHosted)) return null;
    this.log.info(ctx, `Phase B: KACG nudge cg=${onChainId} ka=${kaId} -> reconcile "${localCgId}"`);
    if (this.vmReconcileDispatcher && isLifecycleCurrent()) {
      void this.vmReconcileDispatcher.triggerLive(localCgId);
    }
    return localCgId;
  }

  /**
   * Canonical evidence-gated VM reconciliation operation for one CG.
   *
   * All callers enter the same dispatcher; the admitted domain operation is
   * decomposed below into target resolution, repair, reconcile dependencies,
   * telemetry, and result adaptation.
   */
  async runVmReconcileForCg(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource = 'manual',
  ): Promise<ContextGraphReconcileResult> {
    if (this.started && !this.vmReconcileRuntimeReady) {
      throw new VmReconcileQueueClosedError();
    }
    return this.ensureVmReconcileDispatcher().dispatch(localCgId, source);
  }

  ensureVmReconcileDispatcher(
    this: DKGAgent,
  ): VmReconcileDispatcher<ContextGraphReconcileResult> {
    if (this.started && !this.vmReconcileRuntimeReady) {
      throw new VmReconcileQueueClosedError();
    }
    if (!this.vmReconcileDispatcher) {
      this.vmReconcileDispatcher = new VmReconcileDispatcher(
        (localCgId, source) => this.executeVmReconcileForCg(localCgId, source),
        (localCgId, err) => {
          this.log.warn(
            createOperationContext('system'),
            `VM reconcile for "${localCgId}" failed; retrying on the periodic sweep: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
        {
          concurrency: DKGAgentBase.VM_RECONCILE_CONCURRENCY,
          maxPending: DKGAgentBase.VM_RECONCILE_QUEUE_MAX_PENDING,
          maxForegroundBurst: DKGAgentBase.VM_RECONCILE_MAX_FOREGROUND_BURST,
        },
      );
    }
    return this.vmReconcileDispatcher;
  }

  async executeVmReconcileForCg(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource,
  ): Promise<ContextGraphReconcileResult> {
    const lifecycleGeneration = this.vmReconcileLifecycleGeneration;
    const lifecycleSignal = this.vmReconcileLifecycleController?.signal;
    const isLifecycleCurrent = () => !this.vmReconcileRotationClosed
      && !lifecycleSignal?.aborted
      && this.vmReconcileLifecycleGeneration === lifecycleGeneration;
    if (!isLifecycleCurrent()) throw new VmReconcileQueueClosedError();
    const physicalRun = (async (): Promise<ContextGraphReconcileResult> => {
      const target = await this.resolveVmReconcileTarget(
        localCgId,
        isLifecycleCurrent,
        lifecycleSignal,
      );
      const isTargetCurrent = () => isLifecycleCurrent()
        && this.subscribedContextGraphs.get(localCgId) === target.sub
        && this.contextGraphBindingState.targetStillCurrent(
          localCgId,
          target.sub,
          target,
        )
        && this.reconcileCursors.get(localCgId) === target.cursor;
      if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();

      // Reconcile on a private cursor snapshot. The caller-facing abort race may
      // finish before an adapter physically settles; a stale continuation must
      // never mutate the live cursor or persist a watermark into a new binding.
      const workingCursor: CursorState = {
        watermark: target.cursor.watermark,
        ahead: new Map(target.cursor.ahead),
        scanOrdinal: target.cursor.scanOrdinal,
      };
      let pendingWatermark: number | undefined;
      const result = await reconcileContextGraph(
        this.createVmReconcileDeps(
          localCgId,
          lifecycleGeneration,
          target,
          lifecycleSignal,
          {
            identityCursor: target.cursor,
            persistWatermark: (_lcg, watermark) => { pendingWatermark = watermark; },
          },
        ),
        workingCursor,
        localCgId,
        target.onChainCgId,
      );
      if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      if (result.reconciled > 0 || pendingWatermark !== undefined) {
        await this.store.flush?.({
          priority: 'background',
          source: 'agent.vmReconcile.materialization.flush',
        });
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      if (pendingWatermark !== undefined) {
        await this.persistVmReconcileWatermark(
          localCgId,
          pendingWatermark,
          target,
        );
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      target.cursor.watermark = workingCursor.watermark;
      target.cursor.ahead = new Map(workingCursor.ahead);
      target.cursor.scanOrdinal = workingCursor.scanOrdinal;
      const response = this.toContextGraphReconcileResult(localCgId, source, target, result);
      this.emitVmReconcileTelemetry(localCgId, target, result, response.status);
      // Queue one trailing slice while this key is still active. The dispatcher
      // places it behind already-waiting live CGs, so a large graph makes steady
      // progress without monopolising the only VM worker.
      const hasImmediateTrailingWork = result.hasMore || result.staleTarget;
      if (isLifecycleCurrent() && hasImmediateTrailingWork) {
        this.vmReconcileDispatcher?.triggerLive(localCgId);
      } else if (isTargetCurrent()) {
        // RS heal is bounded, best-effort maintenance. Run it only after the
        // useful VM slice completed and only when that slice has no urgent
        // continuation. Store pressure must defer maintenance, never erase the
        // main reconcile result or prevent foreground ordinal progress.
        try {
          await this.healStrandedScopedKCs(
            localCgId,
            target,
            isTargetCurrent,
            lifecycleSignal,
          );
        } catch (err) {
          // Defensive isolation at the dispatcher boundary: the heal method
          // reduces known pressure to a deferred result, but a future repair
          // regression must still never erase an already-computed VM result.
          this.log.warn(
            createOperationContext('system'),
            `RS heal after VM reconcile for "${localCgId}" was skipped: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
      }
      return response;
    })();
    this.vmReconcilePhysicalRuns.add(physicalRun);
    void physicalRun.finally(() => {
      this.vmReconcilePhysicalRuns.delete(physicalRun);
    }).catch(() => undefined);
    return raceVmReconcileAbort(physicalRun, lifecycleSignal);
  }

  async resolveVmReconcileTarget(
    this: DKGAgent,
    localCgId: string,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<VmReconcileTarget> {
    let sub = this.subscribedContextGraphs.get(localCgId);
    if (!sub?.subscribed && !sub?.coreHosted) {
      throw new ContextGraphNotFoundError(localCgId);
    }
    if (
      this.contextGraphBindingState.currentBindingFor(localCgId, sub) === undefined
      && sub.subscribed
    ) {
      await this.selfPrimeSubscriptionOnChainId(
        localCgId,
        sub,
        undefined,
        isCurrent,
        signal,
      );
      sub = this.subscribedContextGraphs.get(localCgId);
    }
    if (!sub) {
      throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    }
    let binding = this.contextGraphBindingState.currentBindingFor(localCgId, sub);
    if (!binding) throw new ContextGraphOnChainIdUnresolvedError(localCgId);
    if (binding.bindingKind === 'reverse-name-hash') {
      // This is the sole boundary that converts an untrusted process-local
      // reverse candidate into a VM target. Re-enumerate before every use; a
      // duplicate, changed commitment, or RPC failure rejects the target.
      const revalidated = await this.resolveCurrentNameHashContextGraphBinding(localCgId, {
        signal,
      });
      if (!isCurrent()) throw new VmReconcileQueueClosedError();
      sub = this.subscribedContextGraphs.get(localCgId);
      const current = sub
        ? this.contextGraphBindingState.currentBindingFor(localCgId, sub)
        : undefined;
      if (
        !sub
        || current?.bindingKind !== 'reverse-name-hash'
        || revalidated?.provenance !== 'reverse-name-hash'
        || revalidated.onChainId !== current.onChainId
        || revalidated.nameHash !== current.nameHash
      ) {
        throw new ContextGraphOnChainIdUnresolvedError(localCgId);
      }
      binding = current;
    }
    if (!this.vmReconcileEnabled()) {
      throw new VmReconcileUnavailableError();
    }

    let cursor = this.reconcileCursors.get(localCgId);
    if (!cursor) {
      cursor = createCursorState(
        binding.bindingKind === 'authoritative'
          ? sub.lastReconciledOrdinal ?? 0
          : 0,
      );
      this.reconcileCursors.set(localCgId, cursor);
    }
    return {
      sub,
      ...binding,
      onChainCgId: BigInt(binding.onChainId),
      cursor,
      bindingGeneration: this.contextGraphBindingState.capture(localCgId),
      watermarkBefore: cursor.watermark,
    };
  }

  createVmReconcileDeps(
    this: DKGAgent,
    localCgId: string,
    lifecycleGeneration: number,
    target: VmReconcileTarget,
    signal?: AbortSignal,
    execution?: VmReconcileExecution,
  ): ChainReconcilerDeps {
    const capturedSub = target.sub;
    const capturedCursor = execution?.identityCursor
      ?? target.cursor
      ?? this.reconcileCursors.get(localCgId);
    const isTargetCurrent = (): boolean => {
      const current = this.subscribedContextGraphs.get(localCgId);
      return !this.vmReconcileRotationClosed
        && this.vmReconcileLifecycleGeneration === lifecycleGeneration
        && current === capturedSub
        && this.contextGraphBindingState.targetStillCurrent(
          localCgId,
          current,
          target,
        )
        && this.reconcileCursors.get(localCgId) === capturedCursor;
    };
    return {
      getKCCount: async (cg) => {
        const head = Number(await this.chain.getContextGraphKCCount!(cg));
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
        if (!Number.isSafeInteger(head) || head < 0) {
          throw new Error(`Invalid on-chain KC count for context graph "${localCgId}": ${head}`);
        }
        return head;
      },
      getHeadBlock: async () => {
        // Capability-absent chains disable the reorg gate; transient RPC
        // failures still throw so the durable watermark cannot advance.
        if (typeof this.chain.getBlockNumber !== 'function') return undefined;
        const headBlock = await this.chain.getBlockNumber();
        if (!isTargetCurrent()) throw new VmReconcileQueueClosedError();
        return headBlock;
      },
      reconcileOrdinal: (lcg, ocg, ordinal, headBlock) =>
        this.reconcileChainOrdinal(lcg, ocg, ordinal, headBlock, {
          isTargetCurrent,
          deferActiveFetch: true,
        }),
      recoverPendingOrdinals: (lcg, ocg, targets, headBlock) =>
        this.recoverVmReconcileBatch(
          lcg,
          ocg,
          targets,
          headBlock,
          isTargetCurrent,
          signal,
        ),
      maxOrdinalsPerPass: DKGAgentBase.VM_RECONCILE_BATCH_SIZE,
      maxOrdinalConcurrency: DKGAgentBase.VM_RECONCILE_ORDINAL_CONCURRENCY,
      isTargetCurrent: () => isTargetCurrent(),
      persistWatermark: (lcg, watermark) => {
        if (!isTargetCurrent()) return;
        if (execution) execution.persistWatermark(lcg, watermark);
        else void this.persistVmReconcileWatermark(
          lcg,
          watermark,
          target,
        );
      },
      confirmationDepth: DKGAgentBase.VM_RECONCILE_CONFIRMATION_DEPTH,
      log: (msg) => this.log.info(createOperationContext('system'), msg),
    };
  }

  persistVmReconcileWatermark(
    this: DKGAgent,
    localCgId: string,
    watermark: number,
    target: VmReconcileTarget,
  ): Promise<void> {
    const sub = this.subscribedContextGraphs.get(localCgId);
    const isTargetCurrent = () => this.subscribedContextGraphs.get(localCgId) === sub
      && sub === target.sub
      && this.contextGraphBindingState.targetStillCurrent(
        localCgId,
        sub,
        target,
      )
      && this.reconcileCursors.get(localCgId) === target.cursor;
    if (!sub || !isTargetCurrent()) return Promise.resolve();
    const previous = target.cursor.watermark;
    if (target.bindingKind === 'reverse-name-hash') {
      // Reverse-derived progress is valid only for this process-local,
      // revalidated target. The live cursor advances after this returns; never
      // copy its watermark into the shared/durable subscription object.
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'cursor-advance',
        fromWatermark: previous,
        toWatermark: watermark,
      });
      return Promise.resolve();
    }
    return this.persistContextGraphSubscriptionStrict(
      localCgId,
      { ...sub, lastReconciledOrdinal: watermark },
      undefined,
      isTargetCurrent,
    ).then(() => {
      if (!isTargetCurrent()) return;
      sub.lastReconciledOrdinal = watermark;
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'cursor-advance',
        fromWatermark: previous,
        toWatermark: watermark,
      });
    });
  }

  toContextGraphReconcileResult(
    this: DKGAgent,
    localCgId: string,
    source: VmReconcileSource,
    target: VmReconcileTarget,
    result: VmReconcileEngineResult,
  ): ContextGraphReconcileResult {
    const status: ContextGraphReconcileResult['status'] = target.watermarkBefore > result.head
      ? 'watermark-ahead'
      : result.watermark >= result.head
        ? 'current'
        : result.reconciled > 0
          ? 'progress'
          : 'pending';
    return {
      contextGraphId: localCgId,
      onChainId: target.onChainId,
      source,
      status,
      attempted: target.watermarkBefore < result.head,
      headOrdinal: result.head,
      watermarkBefore: target.watermarkBefore,
      watermarkAfter: result.watermark,
      reconciledOrdinals: result.reconciled,
      unresolvedOrdinals: result.pending,
    };
  }

  emitVmReconcileTelemetry(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileTarget,
    result: VmReconcileEngineResult,
    status: ContextGraphReconcileResult['status'],
  ): void {
    if (status === 'watermark-ahead') {
      this.log.warn(
        createOperationContext('system'),
        `VM reconcile evidence mismatch for "${localCgId}": watermark=${target.watermarkBefore} head=${result.head}`,
      );
    }
    if (result.reconciled > 0 || result.pending > 0) {
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'sweep',
        head: result.head,
        toWatermark: result.watermark,
        reconciled: result.reconciled,
        pending: result.pending,
      });
    }
    if (result.reconciled > 0 && target.sub.coreHosted && !target.sub.subscribed) {
      this.emitReplication({
        contextGraphId: localCgId,
        onChainCgId: target.onChainId,
        action: 'core-fill',
        head: result.head,
        toWatermark: result.watermark,
        reconciled: result.reconciled,
      });
    }
  }

  /**
   * RELOCATE stranded legacy-label KCs into the SCOPED per-onChainId graphs
   * the Random Sampling prover reads.
   *
   * The bug: when a KC is finalized BEFORE its on-chain cgId is locally
   * resolvable, finalization falls back to writing it into the LEGACY label
   * graphs (`<cg>/_meta` + `<cg>` root data) instead of the scoped
   * `<cg>/context/<onChainId>/_meta` + `.../context/<onChainId>` graphs. The
   * RS prover (`extractV10KCFromStore`) only reads the scoped graphs, so such
   * a KC reports `kc-not-synced` forever even though the node holds it.
   *
   * This COPIES (never moves/deletes) the legacy KC into the scoped graphs so
   * the prover can find it, while leaving the label-graph view intact.
   *
   * CONTENT-BINDING RULE: the data/meta copies go through
   * `this.store.update(INSERT…WHERE)` so the terms NEVER leave the store. A
   * `query()`/CONSTRUCT → `insert(quads)` round-trip would double backslashes
   * in escape-bearing literals and change the leaf bytes the on-chain
   * `challengeRoot` was committed over, making the proof permanently
   * unprovable. The projection (root + `.well-known/genid/` descendants,
   * minus post-publish trustLevel stamps) mirrors `ka-extractor.ts` exactly.
   *
   * Idempotent + version-guarded so a re-run is a no-op and a later stale
   * writer cannot clobber. NEVER calls `isAlreadyConfirmed` — that read-both
   * guard is the permanence mechanism that made the legacy promotion stick.
   */
  async healStrandedScopedKCs(
    this: DKGAgent,
    localCgId: string,
    target: VmReconcileTarget,
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<RsHealPassResult> {
    try {
      const capturedOnChainId = target.onChainId;
      const canApply = () => isCurrent()
        && (!(this.subscribedContextGraphs instanceof Map)
          || this.subscribedContextGraphs.get(localCgId) === target.sub)
        && this.contextGraphBindingState.targetStillCurrent(
          localCgId,
          target.sub,
          target,
        );
      if (!canApply()) {
        return { status: 'skipped', reason: 'not-current' };
      }
      // Server-side byte-safe copy is the ONLY safe relocation mechanism; if the
      // backend can't do SPARQL UPDATE we bail rather than risk a lossy JS round-trip.
      if (typeof this.store.update !== 'function') {
        return { status: 'skipped', reason: 'unsupported-store' };
      }
      // #1549: every server-side INSERT in this RS-heal path has a statically-known
      // target graph, so `touchedGraphs` is REQUIRED — the index then maintains
      // itself incrementally (a bounded `hasGraph`) instead of marking the whole
      // index dirty and forcing a full store scan on the next enumeration. Requiring
      // it (not optional) closes the escape hatch: a future `update(sparql)` here that
      // forgot to declare its graph would silently fall back to dirtying the index.
      const update = async (sparql: string, touchedGraphs: readonly string[]): Promise<void> => {
        const updated = await tryUpdateWithTouchedGraphs(
          this.store,
          sparql,
          touchedGraphs,
          rsHealStoreOptions('materialize', signal),
        );
        if (!updated) throw new Error('RS heal requires server-side update() support');
      };

      const DKG = 'http://dkg.io/ontology/';
      const legacyMeta = contextGraphMetaUri(localCgId);
      const scopedMeta = contextGraphMetaUri(localCgId, capturedOnChainId);
      const rootData = contextGraphDataUri(localCgId);
      const scopedData = contextGraphDataUri(localCgId, capturedOnChainId);
      // The publisher's OWN one-shot publish() writes confirmed PUBLIC data to a
      // per-KA verifiable-memory (VM) graph — NOT the legacy root data graph (the
      // receiver/#1259 strand fills root data). So the data reads below look in
      // BOTH: legacy root data UNION the stranded KC's EXACT VM graph (derived
      // per-KC from its batchId inside the loop). Reading VM-only would regress
      // the receiver heal; prefix-scanning every VM graph could pull a DIFFERENT
      // KA's triples for a root IRI that recurs across per-KA VM graphs.

      // 2a ASK-guard: is there at least one incomplete scoped KC? Requiring the
      // batch id and materialization version together makes a legacy partial
      // write retryable instead of permanently hiding it from future sweeps.
      const askGuard = await this.store.query(
        `ASK {
           GRAPH <${legacyMeta}> { ?ual <${DKG}batchId> ?b }
           FILTER NOT EXISTS {
             GRAPH <${scopedMeta}> {
               ?ual <${DKG}batchId> ?b ; <${DKG}materializedVersion> ?version
             }
           }
         }`,
        rsHealStoreOptions('guard', signal),
      );
      if (!canApply()) return { status: 'skipped', reason: 'not-current' };
      if (askGuard.type !== 'boolean') return { status: 'skipped', reason: 'invalid-result' };
      if (!askGuard.value) return { status: 'skipped', reason: 'no-work' };

      // 2b: enumerate one bounded page. A per-CG lexical cursor means a
      // permanently incomplete KC cannot pin the first page forever; after the
      // final page the cursor wraps and the next sweep retries earlier gaps.
      const cursorKey = `${localCgId}\u0000${capturedOnChainId}`;
      const cursorMap = this.rsHealCursorByCg ?? new Map<string, string>();
      const cursor = cursorMap.get(cursorKey);
      const stranded = await readRsHealStrandedPage(
        this.store,
        legacyMeta,
        scopedMeta,
        DKG,
        cursor,
        DKGAgentBase.RS_HEAL_BATCH_SIZE,
        signal,
      );
      if (!canApply()) return { status: 'skipped', reason: 'not-current' };
      if (!stranded) return { status: 'skipped', reason: 'invalid-result' };
      if (stranded.bindings.length === 0) {
        advanceRsHealCursor(
          cursorMap,
          cursorKey,
          stranded.bindings,
          DKGAgentBase.RS_HEAL_BATCH_SIZE,
          DKGAgentBase.RS_HEAL_CG_STATE_MAX_ENTRIES,
        );
        return { status: 'skipped', reason: 'no-work' };
      }

      for (const row of stranded.bindings) {
        if (!canApply()) return { status: 'skipped', reason: 'not-current' };
        // Bindings come back stripped to bare values by the store adapters
        // (oxigraph/sparql-http both emit IRIs unwrapped); strip + validate
        // exactly as the extractor does for its `ual`.
        const ual = stripBindingQuotes(row['ual'] ?? '');
        if (!ual || !isSafeIri(ual)) continue;
        // Derive the stranded KC's EXACT per-KA VM graph from its batchId. The
        // chain adapter sets batchId === kaId for the createKnowledgeAssets
        // publish path (evm-adapter-publish.ts / evm-adapter-base.ts), so ?b is
        // the minted kaId; author/number unpack from it exactly as publish() does.
        // Binding the exact graph (vs scanning `_verifiable_memory/*`) prevents
        // copying another KA's triples for a root IRI that recurs across per-KA
        // VM graphs (e.g. an updated entity republished under a new kaId).
        const bMatch = /^"?(\d+)/.exec(String(row['b'] ?? ''));
        if (!bMatch) continue;
        const kaId = BigInt(bMatch[1]);
        const vmGraph = contextGraphLayerUri(
          localCgId,
          MemoryLayer.VerifiableMemory,
          '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
          kaId & ((1n << 96n) - 1n),
        );
        try {
          await withMaterializationLock(scopedMeta, ual, async () => {
            if (!canApply()) return;
            // A KC may carry no `dkg:materializedVersion` stamp in legacy meta:
            // the publisher's OWN one-shot publish writes the KC into the legacy
            // label `_meta` but never stamps a version (only the
            // receiver/finalization path calls writeMaterializedVersion). Such a
            // KC strands in legacy forever — chain-reconcile skips it
            // (`isAlreadyConfirmed` sees the legacy `status=confirmed`) and the
            // heal used to bail here on the null version. Relocate it anyway,
            // stamping the LOWEST version {0,0}: the GH#842 ordering guard then
            // lets any real update (block>0) win over this floor and never the
            // reverse, so it can never clobber a genuine update.
            const version = (await readMaterializedVersion(
              this.store,
              legacyMeta,
              ual,
              rsHealStoreOptions('version.readLegacy', signal),
            ))
              ?? { blockNumber: 0, txIndex: 0 };
            if (!canApply()) return;
            if (!(await shouldApplyMaterialization(
              this.store,
              scopedMeta,
              ual,
              version,
              undefined,
              rsHealStoreOptions('version.checkScoped', signal),
            ))) return; // idempotent
            if (!canApply()) return;

            assertSafeIri(ual);

            // Resolve roots from legacy meta with the extractor's read-both UNION.
            const rootsRes = await this.store.query(
              `SELECT ?root WHERE {
                 GRAPH <${legacyMeta}> {
                   { ?ka <${DKG}partOf> <${ual}> ; <${DKG}rootEntity> ?root . }
                   UNION
                   { <${ual}> <${DKG}rootEntity> ?root . }
                 }
               }`,
              rsHealStoreOptions('roots', signal),
            );
            if (!canApply() || rootsRes.type !== 'bindings') return;
            const roots: string[] = [];
            const seen = new Set<string>();
            for (const r of rootsRes.bindings) {
              const root = stripBindingQuotes(r['root'] ?? '');
              if (root && !seen.has(root) && isSafeIri(root)) {
                seen.add(root);
                roots.push(root);
              }
            }
            if (roots.length === 0) return;

            // CRASH-PARTIAL GUARD (all-or-nothing across roots): the extractor
            // roots a concatenation over EVERY root, so if ANY root's legacy
            // data is missing locally this is a Factor-B sync gap, not a
            // relocation. Write NOTHING — must NOT trade kc-not-synced for
            // KCDataMissingError. ASK each root first.
            for (const root of roots) {
              const present = await this.store.query(
                `ASK {
                   {
                     GRAPH <${rootData}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                     }
                   } UNION {
                     GRAPH <${vmGraph}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                     }
                   }
                 }`,
                rsHealStoreOptions('rootPresent', signal),
              );
              if (!canApply() || present.type !== 'boolean' || !present.value) return;
            }

            // DATA copy (per root) — MANDATORY server-side, byte-safe, read-both
            // (legacy root data UNION per-KA VM graph). Skip the post-publish
            // trustLevel stamps in BOTH branches so the recomputed leaf set stays
            // bit-identical with the on-chain merkleLeafCount.
            for (const root of roots) {
              if (!canApply()) return;
              await update(
                `INSERT { GRAPH <${scopedData}> { ?s ?p ?o } } WHERE {
                   {
                     GRAPH <${rootData}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                       FILTER(?p != <${TRUST_LEVEL_PREDICATE}> && ?p != <${LEGACY_TRUST_LEVEL_PREDICATE}>)
                     }
                   } UNION {
                     GRAPH <${vmGraph}> {
                       ?s ?p ?o .
                       FILTER(?s = <${root}> || STRSTARTS(STR(?s), "${root}/.well-known/genid/"))
                       FILTER(?p != <${TRUST_LEVEL_PREDICATE}> && ?p != <${LEGACY_TRUST_LEVEL_PREDICATE}>)
                     }
                   }
                 }`,
                [scopedData],
              );
              if (!canApply()) return;
            }

            // `update()` is not an atomic transaction on every supported HTTP
            // store. Remove the completion marker first, copy metadata without
            // that marker, and stamp completion only after the copy succeeds.
            // Any partial copy therefore remains visible to the next heal.
            if (!canApply()) return;
            await update(
              `DELETE WHERE {
                 GRAPH <${scopedMeta}> {
                   <${ual}> <${DKG}materializedVersion> ?oldVersion
                 }
               }`,
              [scopedMeta],
            );
            if (!canApply()) return;
            await update(
              `INSERT {
                 GRAPH <${scopedMeta}> { ?s ?p ?o }
               }
               WHERE {
                 GRAPH <${legacyMeta}> {
                   ?s ?p ?o .
                   FILTER(?s = <${ual}> || STRSTARTS(STR(?s), "${ual}/"))
                   FILTER(?p != <${DKG}materializedVersion>)
                 }
               }`,
              [scopedMeta],
            );
            if (!canApply()) return;
            await update(
              `INSERT DATA {
                 GRAPH <${scopedMeta}> {
                   <${ual}> <${DKG}materializedVersion> "${version.blockNumber}:${version.txIndex}"
                 }
               }`,
              [scopedMeta],
            );

            if (canApply()) {
              this.log.info(
                createOperationContext('system'),
                `RS heal: relocated stranded legacy KC ${ual} -> scoped cg=${capturedOnChainId} (${roots.length} root(s))`,
              );
            }
          }, { signal });
        } catch (err) {
          if (isStoreSchedulerBusyError(err)) throw err;
          if (signal?.aborted || !canApply()) {
            return { status: 'skipped', reason: 'not-current' };
          }
          this.log.warn(
            createOperationContext('system'),
            `RS heal: relocate failed for ${ual} (cg=${capturedOnChainId}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      advanceRsHealCursor(
        cursorMap,
        cursorKey,
        stranded.bindings,
        DKGAgentBase.RS_HEAL_BATCH_SIZE,
        DKGAgentBase.RS_HEAL_CG_STATE_MAX_ENTRIES,
      );
      return { status: 'completed', inspected: stranded.bindings.length };
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `RS heal sweep for "${localCgId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // A scheduler rejection means this maintenance sweep has lost admission.
      // Stop immediately; the periodic reconciler will retry on its next tick
      // instead of flooding the remaining backlog into the queue.
      if (isStoreSchedulerBusyError(err)) {
        return { status: 'deferred', reason: 'store-busy' };
      }
      return { status: 'skipped', reason: 'failed' };
    }
  }

  async collectVmReconcileSwmCandidateState(this: DKGAgent, localCgId: string): Promise<VmReconcileSwmCandidateState> {
    const candidateNamespaces = await this.collectVmReconcileSwmCandidateNamespacesBestEffort(localCgId);
    return {
      candidateNamespaces: candidateNamespaces.namespaces,
      swmGen: await this.readVmReconcileSwmGen(candidateNamespaces.namespaces),
      peerTopologyKey: await this.vmReconcilePeerTopologyKey(localCgId),
    };
  }

  vmReconcileRootSwmCandidateNamespaces(this: DKGAgent, localCgId: string): VmReconcileSwmNamespace[] {
    return [{
      metaGraph: contextGraphWorkspaceMetaGraphUri(localCgId),
      dataGraph: contextGraphWorkspaceGraphUri(localCgId),
    }];
  }

  async collectVmReconcileSwmCandidateNamespaces(this: DKGAgent, localCgId: string): Promise<VmReconcileSwmNamespace[]> {
    const graphManager = new GraphManager(this.store);
    const subGraphNamespaces = (await graphManager.listSubGraphs(localCgId))
      .map((sg) => ({
        metaGraph: graphManager.sharedMemoryMetaUri(localCgId, sg),
        dataGraph: graphManager.sharedMemoryUri(localCgId, sg),
      }))
      .sort((a, b) => `${a.metaGraph}\0${a.dataGraph}`.localeCompare(`${b.metaGraph}\0${b.dataGraph}`));
    return [
      ...this.vmReconcileRootSwmCandidateNamespaces(localCgId),
      ...subGraphNamespaces,
    ];
  }

  async collectVmReconcileSwmCandidateNamespacesBestEffort(this: DKGAgent, localCgId: string): Promise<VmReconcileSwmCandidateNamespaces> {
    try {
      return { namespaces: await this.collectVmReconcileSwmCandidateNamespaces(localCgId), complete: true };
    } catch {
      return { namespaces: this.vmReconcileRootSwmCandidateNamespaces(localCgId), complete: false };
    }
  }

  vmReconcileSwmNamespaceKey(this: DKGAgent, candidateNamespaces: VmReconcileSwmNamespace[]): string {
    return candidateNamespaces
      .map((namespace) => `${namespace.metaGraph}\0${namespace.dataGraph}`)
      .sort()
      .join('\n');
  }

  async vmReconcilePeerTopologyKey(this: DKGAgent, localCgId: string): Promise<string> {
    try {
      const preferredPeerId = await this.resolvePreferredSyncPeerId(localCgId);
      const isPrivateContextGraph = await this.isPrivateContextGraph(localCgId);
      const libp2p = (this.node as any)?.libp2p;
      const getConnections = libp2p?.getConnections;
      if (typeof getConnections !== 'function') return 'unreadable';
      const peerIds = [...new Map(
        (getConnections.call(libp2p) as Array<{ remotePeer?: { toString(): string } }>)
          .map((connection) => [connection.remotePeer?.toString(), connection.remotePeer] as const)
          .filter((entry): entry is readonly [string, { toString(): string }] =>
            typeof entry[0] === 'string' && entry[0].length > 0 && !!entry[1],
          ),
      ).keys()].sort();
      const orderedPeers = this.selectCatchupPeers(
        peerIds.map((peerId) => ({ toString: () => peerId })),
        preferredPeerId,
        isPrivateContextGraph,
      );
      return JSON.stringify({
        preferredPeerId: preferredPeerId ?? null,
        privateOnly: isPrivateContextGraph,
        peers: orderedPeers.map((peer, rank) => {
          const peerId = peer.toString();
          return {
            rank,
            peerId,
            preferred: peerId === preferredPeerId,
            core: this.knownCorePeerIds.has(peerId),
          };
        }),
      });
    } catch {
      return 'unreadable';
    }
  }

  async readVmReconcileSwmGen(this: DKGAgent, candidateNamespaces: VmReconcileSwmNamespace[]): Promise<string | null> {
    if (candidateNamespaces.length === 0) return 'empty:0';
    try {
      // The changelog cursor is a durable write generation: it survives daemon
      // restart, advances at the store mutation choke point, and is O(1) after
      // its one-time seed. It lets large (> fingerprint cap) stores reuse a
      // proven negative without reconstructing or sampling their SWM content.
      const changelog = asChangelogReader(this.store);
      if (changelog) {
        const head = await changelog.changelogHead({
          priority: 'background',
          source: 'agent.vmReconcile.negativeGeneration',
        });
        return `changelog:${head.era}:${head.seq}`;
      }
      const parts: string[] = [];
      const digestRows = (rows: string[]) =>
        createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
      const maxRows = DKGAgentBase.VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS;
      const isTooLarge = (rows: unknown[]) => rows.length > maxRows;
      for (const namespace of candidateNamespaces) {
        const metaGraph = assertSafeIri(namespace.metaGraph);
        const dataGraph = assertSafeIri(namespace.dataGraph);
        const operationRows = await this.store.query(
          `SELECT ?op ?root ?ts WHERE {
            GRAPH <${metaGraph}> {
              ?op <http://dkg.io/ontology/rootEntity> ?root .
              OPTIONAL { ?op <http://dkg.io/ontology/publishedAt> ?ts . }
            }
          } ORDER BY ?op ?root ?ts LIMIT ${maxRows + 1}`,
          { source: 'agent.vmReconcile.swmFingerprint.operations' },
        );
        if (operationRows.type !== 'bindings') return null;
        if (isTooLarge(operationRows.bindings)) return null;
        const operations = operationRows.bindings
          .map((row) => [
            String(row['op'] ?? ''),
            String(row['root'] ?? ''),
            String(row['ts'] ?? ''),
          ].join('\0'))
          .sort();

        const dataRows = await this.store.query(
          `SELECT ?s ?p ?o WHERE {
            GRAPH <${dataGraph}> { ?s ?p ?o . }
          } ORDER BY ?s ?p ?o LIMIT ${maxRows + 1}`,
          { source: 'agent.vmReconcile.swmFingerprint.data' },
        );
        if (dataRows.type !== 'bindings') return null;
        if (isTooLarge(dataRows.bindings)) return null;
        const dataTriples = dataRows.bindings
          .map((row) => [
            String(row['s'] ?? ''),
            String(row['p'] ?? ''),
            String(row['o'] ?? ''),
          ].join('\0'))
          .sort();

        const privateRootRows = await this.store.query(
          `SELECT ?privateEntity ?privateRoot WHERE {
            GRAPH <${metaGraph}> {
              ?privateEntity <http://dkg.io/ontology/privateMerkleRoot> ?privateRoot .
            }
          } ORDER BY ?privateEntity ?privateRoot LIMIT ${maxRows + 1}`,
          { source: 'agent.vmReconcile.swmFingerprint.privateRoots' },
        );
        if (privateRootRows.type !== 'bindings') return null;
        if (isTooLarge(privateRootRows.bindings)) return null;
        const privateRoots = privateRootRows.bindings
          .map((row) => [
            String(row['privateEntity'] ?? ''),
            String(row['privateRoot'] ?? ''),
          ].join('\0'))
          .sort();

        parts.push([
          `meta:${namespace.metaGraph}`,
          `data:${namespace.dataGraph}`,
          `ops:${operations.length}`,
          `opHash:${digestRows(operations)}`,
          `dataTriples:${dataTriples.length}`,
          `dataHash:${digestRows(dataTriples)}`,
          `privateRoots:${privateRoots.length}`,
          `privateRootHash:${digestRows(privateRoots)}`,
        ].join(';'));
      }
      // Catch writes into a newly-created/unregistered namespace that the
      // current namespace enumeration cannot yet name. This process-local term
      // complements (rather than replaces) the content fingerprint: after a
      // restart the fingerprint remains the correctness gate while the counter
      // restarts harmlessly.
      const rootDataGraph = candidateNamespaces[0]?.dataGraph ?? '';
      const swmSuffix = rootDataGraph.indexOf('/_shared_memory');
      const graphPrefix = swmSuffix >= 0 ? `${rootDataGraph.slice(0, swmSuffix)}/` : rootDataGraph;
      const writeGen = asGraphWriteGenSource(this.store)?.getWriteGen(graphPrefix);
      if (writeGen !== undefined) parts.push(`writeGen:${writeGen}`);
      return parts.join('|');
    } catch {
      // Probe failures are not a stable SWM generation. Callers must not cache
      // or preserve a negative-cache gate from this result.
    }
    return null;
  }

  vmReconcileSwmGenHasOperations(this: DKGAgent, swmGen: string): boolean {
    return swmGen.split('|').some((part) => {
      const match = /(?:^|;)ops:(\d+)(?:;|$)/.exec(part);
      return match ? Number(match[1]) > 0 : false;
    });
  }

  vmReconcileSwmGenSupportsDurableNegative(this: DKGAgent, swmGen: string): boolean {
    // A changelog cursor covers every descendant graph mutation. The fallback
    // fingerprint covers only the bare SWM bucket, so an operation whose data
    // later lands in a per-KA child graph must fail open after restart.
    return swmGen.startsWith('changelog:') || !this.vmReconcileSwmGenHasOperations(swmGen);
  }

  vmReconcileSwmGenContainsSnapshot(this: DKGAgent, cachedSwmGen: string, currentSwmGen: string): boolean {
    return cachedSwmGen === currentSwmGen || cachedSwmGen.split('|').includes(currentSwmGen);
  }

  vmReconcileWorkspaceOperationPattern(this: DKGAgent, candidateMetaGraphs: string[]): string {
    const branches: string[] = [];
    for (const graph of candidateMetaGraphs) {
      try {
        branches.push(`{ GRAPH <${assertSafeIri(graph)}> {
          ?op <http://dkg.io/ontology/rootEntity> ?root .
          OPTIONAL { ?op <http://dkg.io/ontology/publishedAt> ?ts . }
        } }`);
      } catch {
        // Skip unsafe graph names instead of building a malformed query.
      }
    }
    return branches.join(' UNION ');
  }

  deleteVmReconcileNegativeCacheEntry(this: DKGAgent, cacheKey: string): void {
    const existing = this.vmReconcileNegativeCache.get(cacheKey);
    this.markVmReconcileNegativeCacheHydrated(
      cacheKey,
      existing?.localCgId ?? cacheKey.slice(0, Math.max(0, cacheKey.indexOf('\0'))),
    );
    if (existing) {
      this.vmReconcileNegativeCache.delete(cacheKey);
      const keys = this.vmReconcileNegativeCacheKeysByCg.get(existing.localCgId);
      if (keys) {
        keys.delete(cacheKey);
        if (keys.size === 0) this.vmReconcileNegativeCacheKeysByCg.delete(existing.localCgId);
      }
    }
    void this.config.contextGraphSubscriptionStore?.deleteVmReconcileNegative?.(cacheKey).catch(() => {
      // The in-memory invalidation remains authoritative for this process.
    });
  }

  indexVmReconcileNegativeCacheEntry(this: DKGAgent, localCgId: string, cacheKey: string): void {
    let keys = this.vmReconcileNegativeCacheKeysByCg.get(localCgId);
    if (!keys) {
      keys = new Set<string>();
      this.vmReconcileNegativeCacheKeysByCg.set(localCgId, keys);
    }
    keys.add(cacheKey);
  }

  markVmReconcileNegativeCacheHydrated(this: DKGAgent, cacheKey: string, localCgId: string): void {
    // Access order keeps actively reused keys resident while old one-shot
    // misses fall out. Eviction is fail-open: it only permits another durable
    // lookup if the same key is encountered later.
    this.vmReconcileNegativeCacheHydrated.delete(cacheKey);
    this.vmReconcileNegativeCacheHydrated.set(cacheKey, localCgId);
    while (
      this.vmReconcileNegativeCacheHydrated.size
      > DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.vmReconcileNegativeCacheHydrated.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileNegativeCacheHydrated.delete(oldestKey);
    }
  }

  async shouldDeferVmReconcileByNegativeCache(this: DKGAgent,
    cacheKey: string,
    localCgId: string,
  ): Promise<boolean> {
    let cached = this.vmReconcileNegativeCache.get(cacheKey);
    const durableStateAlreadyConsulted = this.vmReconcileNegativeCacheHydrated.has(cacheKey);
    this.markVmReconcileNegativeCacheHydrated(cacheKey, localCgId);
    if (!cached && !durableStateAlreadyConsulted) {
      try {
        const durable = await this.config.contextGraphSubscriptionStore
          ?.loadVmReconcileNegative?.(cacheKey);
        if (
          durable &&
          durable.cacheKey === cacheKey &&
          durable.localCgId === localCgId &&
          Number.isInteger(durable.failures) && durable.failures > 0 &&
          Number.isFinite(durable.nextRetryAt) &&
          typeof durable.swmGen === 'string' &&
          Array.isArray(durable.candidateNamespaces) &&
          durable.candidateNamespaces.every((item) =>
            typeof item?.metaGraph === 'string' && typeof item?.dataGraph === 'string') &&
          typeof durable.peerTopologyKey === 'string'
        ) {
          if (!this.vmReconcileSwmGenSupportsDurableNegative(durable.swmGen)) {
            await this.config.contextGraphSubscriptionStore
              ?.deleteVmReconcileNegative?.(cacheKey);
          } else {
            cached = {
              localCgId: durable.localCgId,
              failures: durable.failures,
              nextRetryAt: durable.nextRetryAt,
              swmGen: durable.swmGen,
              candidateNamespaces: durable.candidateNamespaces,
              peerTopologyKey: durable.peerTopologyKey,
            };
            this.vmReconcileNegativeCache.set(cacheKey, cached);
            this.indexVmReconcileNegativeCacheEntry(localCgId, cacheKey);
          }
        }
      } catch {
        // Persistence is an accelerator only. Fail open to an authoritative scan.
      }
    }
    if (!cached) return false;
    if (Date.now() >= cached.nextRetryAt) return false;

    try {
      try {
        await this.primeCatchupConnections();
      } catch {
        // Best effort only; an unchanged connection view can still honor the
        // cached miss until the backoff expires.
      }
      if (await this.vmReconcilePeerTopologyKey(localCgId) !== cached.peerTopologyKey) {
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        this.vmReconcileFetchCooldownAt.delete(localCgId);
        return false;
      }
      const currentNamespaces = await this.collectVmReconcileSwmCandidateNamespacesBestEffort(localCgId);
      const currentNamespaceKey = this.vmReconcileSwmNamespaceKey(currentNamespaces.namespaces);
      const cachedNamespaceKey = this.vmReconcileSwmNamespaceKey(cached.candidateNamespaces);
      if (currentNamespaceKey !== cachedNamespaceKey) {
        if (!currentNamespaces.complete) {
          const currentSwmGen = await this.readVmReconcileSwmGen(currentNamespaces.namespaces);
          if (currentSwmGen === null) {
            this.deleteVmReconcileNegativeCacheEntry(cacheKey);
            return false;
          }
          if (!this.vmReconcileSwmGenContainsSnapshot(cached.swmGen, currentSwmGen)) {
            this.deleteVmReconcileNegativeCacheEntry(cacheKey);
            return false;
          }
          return true;
        }
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return false;
      }
      const pattern = this.vmReconcileWorkspaceOperationPattern(currentNamespaces.namespaces.map((namespace) => namespace.metaGraph));
      if (!pattern) return true;
      const currentSwmGen = await this.readVmReconcileSwmGen(currentNamespaces.namespaces);
      if (currentSwmGen === null) {
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return false;
      }
      if (currentSwmGen !== cached.swmGen) {
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return false;
      }
    } catch {
      // Unexpected validation failures leave the existing backoff in place;
      // expected generation probe failures return null and clear the gate above.
    }
    return true;
  }

  recordVmReconcileNegativeCache(this: DKGAgent,
    cacheKey: string,
    localCgId: string,
    state: VmReconcileSwmCandidateState,
  ): void {
    if (state.swmGen === null) {
      this.deleteVmReconcileNegativeCacheEntry(cacheKey);
      return;
    }
    this.pruneVmReconcileState();
    const previous = this.vmReconcileNegativeCache.get(cacheKey);
    const failures = (previous?.failures ?? 0) + 1;
    const exponentialBackoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    );
    const jitterSample = createHash('sha256')
      .update(`${this.node.peerId.toString()}\0${cacheKey}\0${failures}`)
      .digest()
      .readUInt32BE(0) / 0x1_0000_0000;
    const backoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      Math.max(1, Math.round(exponentialBackoff * (0.8 + jitterSample * 0.4))),
    );
    getMetrics().storeRetryAttemptsTotal.add(1, {
      scope: 'vm_reconcile',
      reason: 'no_swm',
      attempt: Math.min(failures, 16),
    });
    if (previous) {
      // Replace in place without racing an asynchronous durable DELETE against
      // the SAVE below. The record key/local CG are unchanged here.
      this.vmReconcileNegativeCache.delete(cacheKey);
      const keys = this.vmReconcileNegativeCacheKeysByCg.get(previous.localCgId);
      keys?.delete(cacheKey);
      if (keys?.size === 0) this.vmReconcileNegativeCacheKeysByCg.delete(previous.localCgId);
    }
    const record = {
      localCgId,
      failures,
      nextRetryAt: Date.now() + backoff,
      swmGen: state.swmGen,
      candidateNamespaces: state.candidateNamespaces,
      peerTopologyKey: state.peerTopologyKey,
    };
    this.vmReconcileNegativeCache.set(cacheKey, record);
    this.markVmReconcileNegativeCacheHydrated(cacheKey, localCgId);
    this.indexVmReconcileNegativeCacheEntry(localCgId, cacheKey);
    const durableStore = this.config.contextGraphSubscriptionStore;
    if (this.vmReconcileSwmGenSupportsDurableNegative(record.swmGen)) {
      void durableStore?.saveVmReconcileNegative?.({
        cacheKey,
        ...record,
      }).catch(() => {
        // Persistence is an accelerator only; the process-local gate still works.
      });
    } else {
      void durableStore?.deleteVmReconcileNegative?.(cacheKey).catch(() => {
        // Fail open after restart even if best-effort cleanup cannot complete.
      });
    }
    this.pruneVmReconcileState();
  }

  vmReconcileRotationNow(this: DKGAgent): number {
    return performance.now();
  }

  vmReconcileRotationSlotKey(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
  ): string {
    return `${target.localCgId}\0${target.onChainCgId}\0${target.ordinal}`;
  }

  clearVmReconcileRotationStateForSlot(
    this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
  ): void {
    this.vmReconcileRotationState.delete(`${localCgId}\0${onChainCgId.toString()}\0${ordinal}`);
  }

  vmReconcileRotationFingerprint(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
  ): string {
    return `${target.ual}\0${target.merkleRoot.toLowerCase()}`;
  }

  vmReconcileObservedCandidatePeerIds(
    this: DKGAgent,
    localCgId: string,
  ): string[] {
    const curatorOrder = this.vmReconcileCuratorPeersByCg.get(localCgId) ?? [];
    const libp2p = (this.node as any)?.libp2p;
    const getConnections = libp2p?.getConnections;
    if (typeof getConnections !== 'function') {
      return curatorOrder.slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    }
    const peersById = new Map<string, { toString(): string }>();
    for (const connection of getConnections.call(libp2p) as Array<{
      remotePeer?: { toString(): string };
    }>) {
      const peer = connection.remotePeer;
      const peerId = peer?.toString();
      if (!peer || !peerId || peerId === this.peerId || peersById.has(peerId)) continue;
      peersById.set(peerId, peer);
    }
    // `getConnections()` iteration order is transport state, not candidate
    // identity. Sort before tiering/capping so harmless connection reorder can
    // never replace one member of the bounded proof roster.
    const canonicalPeers = [...peersById.values()].sort((left, right) =>
      left.toString().localeCompare(right.toString()));
    const ordinaryOrder = this.selectCatchupPeers(
      canonicalPeers,
      this.preferredSyncPeers.get(localCgId),
      false,
    )
      .map((peer) => peer.toString());
    // Structural curators are authoritative and may contain the only holder.
    // Ordinary connected peers are opportunistic fallback only: cap that tier
    // separately so connection churn cannot stretch a negative cycle to 256
    // elevated prefix downloads.
    const boundedCurators = [...new Set(curatorOrder)]
      .slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    const curatorSet = new Set(boundedCurators);
    const ordinaryBudget = Math.min(
      DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
      Math.max(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX - boundedCurators.length),
    );
    const boundedOrdinary = ordinaryOrder
      .filter((peerId) => !curatorSet.has(peerId))
      .slice(0, ordinaryBudget);
    return [...boundedCurators, ...boundedOrdinary];
  }

  vmReconcilePeerMembershipMatches(
    this: DKGAgent,
    left: ReadonlySet<string>,
    right: readonly string[],
  ): boolean {
    return left.size === right.length && right.every((peerId) => left.has(peerId));
  }

  touchVmReconcileRotationRecord(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
  ): void {
    if (this.vmReconcileRotationState.get(slotKey) !== record) return;
    this.vmReconcileRotationState.delete(slotKey);
    this.vmReconcileRotationState.set(slotKey, record);
  }

  prepareVmReconcileRotationTarget(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    candidatePeerIds: readonly string[],
    now: number,
    curatorRosterConfirmed = true,
  ): {
    slotKey: string;
    record?: VmReconcileRotationRecord;
    suppressed: boolean;
  } {
    const slotKey = this.vmReconcileRotationSlotKey(target);
    if (this.vmReconcileRotationClosed) return { slotKey, suppressed: true };

    const fingerprint = this.vmReconcileRotationFingerprint(target);
    let record = this.vmReconcileRotationState.get(slotKey);
    if (record && record.fingerprint !== fingerprint) {
      this.vmReconcileRotationState.delete(slotKey);
      record = undefined;
    }
    if (
      record?.phase === 'backoff'
      && record.backoffKind === 'clean-absence'
      && (!record.curatorRosterConfirmed || !curatorRosterConfirmed)
    ) {
      // Absence gathered while curator discovery was unavailable must not
      // suppress the next lookup: that lookup may reveal the only holder.
      this.vmReconcileRotationState.delete(slotKey);
      record = undefined;
    }
    if (candidatePeerIds.length === 0) {
      // A transient empty socket view cannot invalidate a completed proof: doing
      // so would redial and refetch every sweep after ordinary disconnects.
      // Partial evidence is different and remains fail-open; drop it so the next
      // non-empty roster starts a genuinely fresh cycle.
      if (record?.phase === 'backoff' && now < record.nextRetryAt) {
        this.touchVmReconcileRotationRecord(slotKey, record);
        return { slotKey, record, suppressed: true };
      }
      this.vmReconcileRotationState.delete(slotKey);
      return { slotKey, suppressed: false };
    }

    if (!record) {
      const nextRecord: VmReconcileRotationRecord = {
        localCgId: target.localCgId,
        onChainCgId: target.onChainCgId,
        ordinal: target.ordinal,
        fingerprint,
        phase: 'collecting',
        candidatePeerIds: new Set(candidatePeerIds),
        attemptedPeerIds: new Set(),
        cleanAbsentPeerIds: new Set(),
        curatorRosterConfirmed,
        collectionDeadlineAt: now + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
        failures: 0,
        nextRetryAt: 0,
      };
      if (!this.installVmReconcileRotationRecord(slotKey, nextRecord)) {
        // Preserve the pressure bound at cap: an unowned target cannot retain
        // exponential retry state, so running elevated exact transport here
        // would replay it every sweep. Defer until an expired/resolved slot is
        // available; this is process-local scheduling, never absence evidence.
        return { slotKey, suppressed: true };
      }
      return {
        slotKey,
        record: nextRecord,
        suppressed: false,
      };
    }

    const membershipUnchanged = this.vmReconcilePeerMembershipMatches(
      record.candidatePeerIds,
      candidatePeerIds,
    );
    const rosterProofUpgraded = !record.curatorRosterConfirmed && curatorRosterConfirmed;
    if (!membershipUnchanged) {
      const previousCandidatePeerIds = record.candidatePeerIds;
      const nextCandidatePeerIds = new Set(candidatePeerIds);
      record.candidatePeerIds = new Set(candidatePeerIds);
      record.curatorRosterConfirmed = curatorRosterConfirmed;
      const removedPeer = [...previousCandidatePeerIds]
        .some((peerId) => !nextCandidatePeerIds.has(peerId));
      if (removedPeer) {
        // A proof roster is a set, not an accumulation of surviving credits.
        // Any removal/replacement invalidates the whole cycle so shrink can
        // never manufacture exhaustion or preserve an active suppression.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        record.attemptedPeerIds.clear();
        record.cleanAbsentPeerIds.clear();
        record.lastAttemptedPeerId = undefined;
        record.collectionDeadlineAt = now
          + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      } else if (!rosterProofUpgraded) {
        // Pure growth preserves valid credits for retained identities, but the
        // newly observed peer is uncredited and immediately breaks backoff.
        record.phase = 'collecting';
        record.backoffKind = undefined;
        record.nextRetryAt = 0;
        record.collectionDeadlineAt = now
          + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      }
    } else {
      record.curatorRosterConfirmed = curatorRosterConfirmed;
    }
    if (rosterProofUpgraded) {
      // A peer response gathered while curator discovery was unconfirmed is
      // useful transport evidence, not authoritative absence proof. Reprobe
      // the complete now-authoritative roster even when that roster also grew.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.nextRetryAt = 0;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.lastAttemptedPeerId = undefined;
      record.collectionDeadlineAt = now
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
    }
    if (record.phase === 'backoff') {
      if (now < record.nextRetryAt) {
        this.touchVmReconcileRotationRecord(slotKey, record);
        return { slotKey, record, suppressed: true };
      }
      // A deadline only opens a new collection cycle. It never earns another
      // failure/backoff without fresh clean-absence evidence from every peer.
      record.phase = 'collecting';
      record.backoffKind = undefined;
      record.attemptedPeerIds.clear();
      record.cleanAbsentPeerIds.clear();
      record.collectionDeadlineAt = now
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
      record.nextRetryAt = 0;
    } else if (now >= record.collectionDeadlineAt) {
      // Expired partial evidence fails open and releases its cache slot. Return
      // evidence-free for this pass so a repeatedly ineligible roster cannot
      // refresh all collecting entries just before capacity admission runs.
      this.vmReconcileRotationState.delete(slotKey);
      return { slotKey, suppressed: false };
    }

    this.touchVmReconcileRotationRecord(slotKey, record);
    return { slotKey, record, suppressed: false };
  }

  enterVmReconcileRotationBackoff(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
    kind: NonNullable<VmReconcileRotationRecord['backoffKind']> = 'clean-absence',
  ): void {
    record.failures += 1;
    const exponentialBackoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_BASE_MS
        * 2 ** Math.max(0, record.failures - 1),
    );
    const jitterSample = createHash('sha256')
      .update(`${this.peerId}\0${slotKey}\0${record.fingerprint}\0${record.failures}`)
      .digest()
      .readUInt32BE(0) / 0x1_0000_0000;
    const backoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      Math.max(1, Math.round(exponentialBackoff * (0.8 + jitterSample * 0.4))),
    );
    record.phase = 'backoff';
    record.backoffKind = kind;
    record.collectionDeadlineAt = 0;
    record.nextRetryAt = this.vmReconcileRotationNow() + backoff;
  }

  vmReconcileUncreditedCandidateOrder(
    this: DKGAgent,
    record: VmReconcileRotationRecord,
  ): string[] {
    const candidates = [...record.candidatePeerIds];
    if (candidates.length === 0) return candidates;
    const lastIndex = record.lastAttemptedPeerId === undefined
      ? -1
      : candidates.indexOf(record.lastAttemptedPeerId);
    const start = lastIndex < 0 ? 0 : (lastIndex + 1) % candidates.length;
    return [
      ...candidates.slice(start),
      ...candidates.slice(0, start),
    ].filter((peerId) => !record.attemptedPeerIds.has(peerId));
  }

  /**
   * Select one physical peer for an exact-VM target. A peer that returned an
   * exact hit in this slice is preferred for one bounded microbatch; all other
   * peers remain one-use-per-slice. The provider policy owns every mutable
   * transition so partial responses revoke affinity consistently. Unavailable
   * peers and the global considered-peer cap remain authoritative.
   */
  selectVmReconcileExactCandidate(
    this: DKGAgent,
    record: VmReconcileRotationRecord | undefined,
    fallbackCandidatePeerIds: readonly string[],
    policy: VmRecoveryProviderPolicy,
  ): string | undefined {
    const uncreditedCandidateOrder = record
      ? this.vmReconcileUncreditedCandidateOrder(record)
      : [...fallbackCandidatePeerIds];
    return policy.selectNextCandidate(
      uncreditedCandidateOrder,
      DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
    );
  }

  findVmReconcileRotationReplacement(
    this: DKGAgent,
    requestingCgId?: string,
  ): [string, VmReconcileRotationRecord] | undefined {
    if (this.vmReconcileRotationState.size < DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      return undefined;
    }
    const now = this.vmReconcileRotationNow();
    for (const entry of this.vmReconcileRotationState) {
      const [, record] = entry;
      if (
        (record.phase === 'backoff' && now < record.nextRetryAt)
        || (record.phase === 'collecting' && now < record.collectionDeadlineAt)
      ) continue;
      return entry;
    }
    if (!requestingCgId) return undefined;
    const countsByCg = new Map<string, number>();
    for (const record of this.vmReconcileRotationState.values()) {
      countsByCg.set(record.localCgId, (countsByCg.get(record.localCgId) ?? 0) + 1);
    }
    if ((countsByCg.get(requestingCgId) ?? 0) !== 0) return undefined;
    for (const entry of this.vmReconcileRotationState) {
      if ((countsByCg.get(entry[1].localCgId) ?? 0) > 1) return entry;
    }
    return undefined;
  }

  canInstallVmReconcileRotationRecord(this: DKGAgent, requestingCgId?: string): boolean {
    if (this.vmReconcileRotationState.size < DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      return true;
    }
    return this.findVmReconcileRotationReplacement(requestingCgId) !== undefined;
  }

  installVmReconcileRotationRecord(
    this: DKGAgent,
    slotKey: string,
    record: VmReconcileRotationRecord,
  ): boolean {
    if (this.vmReconcileRotationClosed || this.vmReconcileRotationState.has(slotKey)) {
      return false;
    }
    const replacement = this.findVmReconcileRotationReplacement(record.localCgId);
    if (!replacement) {
      if (this.vmReconcileRotationState.size >= DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
        return false;
      }
      this.vmReconcileRotationState.set(slotKey, record);
      return this.vmReconcileRotationState.get(slotKey) === record;
    }

    // Donation and requester installation are one synchronous state transition.
    // Restore the donor if installation exits or throws before ownership moves.
    const [replacementKey, replacementRecord] = replacement;
    let installed = false;
    this.vmReconcileRotationState.delete(replacementKey);
    try {
      if (this.vmReconcileRotationClosed || this.vmReconcileRotationState.has(slotKey)) {
        return false;
      }
      this.vmReconcileRotationState.set(slotKey, record);
      installed = this.vmReconcileRotationState.get(slotKey) === record;
      return installed;
    } finally {
      if (!installed && !this.vmReconcileRotationState.has(replacementKey)) {
        this.vmReconcileRotationState.set(replacementKey, replacementRecord);
      }
    }
  }

  clearVmReconcileRotationStateForContextGraph(
    this: DKGAgent,
    localCgId: string,
  ): void {
    const prefix = `${localCgId}\0`;
    for (const key of this.vmReconcileRotationState.keys()) {
      if (key.startsWith(prefix)) this.vmReconcileRotationState.delete(key);
    }
    this.vmReconcileRotationAdmissionCursorByCg.delete(localCgId);
  }

  closeVmReconcileRotationState(this: DKGAgent): void {
    this.vmReconcileLifecycleController?.abort();
    this.vmReconcileLifecycleGeneration = (this.vmReconcileLifecycleGeneration ?? 0) + 1;
    this.vmReconcileRotationClosed = true;
    // Some lifecycle tests intentionally construct a narrow partial agent
    // without running the base constructor. Shutdown must remain best-effort
    // for that supported test seam and never mask later teardown failures.
    this.vmReconcileRotationState?.clear();
    this.vmReconcileRotationAdmissionCursorByCg?.clear();
    this.vmReconcileCuratorPeersByCg?.clear();
    this.vmReconcileCuratorPageCursorByCg?.clear();
  }

  openVmReconcileRotationState(this: DKGAgent): void {
    if (!this.vmReconcileLifecycleController || this.vmReconcileLifecycleController.signal.aborted) {
      this.vmReconcileLifecycleController = new AbortController();
    }
    this.vmReconcileRotationClosed = false;
  }

  vmReconcileRecoveryTargetMatches(
    this: DKGAgent,
    expected: OrdinalRecoveryTarget,
    actual: OrdinalRecoveryTarget,
  ): boolean {
    return expected.localCgId === actual.localCgId
      && expected.onChainCgId === actual.onChainCgId
      && expected.ordinal === actual.ordinal
      && expected.ual === actual.ual
      && expected.merkleRoot.toLowerCase() === actual.merkleRoot.toLowerCase();
  }

  settleVmReconcileRotationAttempt(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    peerId: string | undefined,
    disposition: 'found' | 'clean-absent' | 'incomplete',
    expectedCandidatePeerIds: readonly string[],
    capturedRecord: VmReconcileRotationRecord,
    unavailablePeerIds: ReadonlySet<string> = new Set(),
  ): void {
    if (this.vmReconcileRotationClosed) return;
    const slotKey = this.vmReconcileRotationSlotKey(target);
    if (this.vmReconcileRotationState.get(slotKey) !== capturedRecord) return;
    if (!this.vmReconcilePeerMembershipMatches(
      capturedRecord.candidatePeerIds,
      expectedCandidatePeerIds,
    )) return;
    if (peerId !== undefined && !capturedRecord.candidatePeerIds.has(peerId)) return;

    if (peerId !== undefined) {
      capturedRecord.attemptedPeerIds.add(peerId);
      if (disposition === 'clean-absent') capturedRecord.cleanAbsentPeerIds.add(peerId);
      // Preserve fairly accumulated proof progress while other targets share
      // the bounded peer budget. A cycle expires only after this slot itself
      // stops making physical progress for the effective maximum.
      capturedRecord.collectionDeadlineAt = this.vmReconcileRotationNow()
        + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
    }
    const scheduledEveryPeer = [...capturedRecord.candidatePeerIds]
      .every((candidatePeerId) => capturedRecord.attemptedPeerIds.has(candidatePeerId)
        || unavailablePeerIds.has(candidatePeerId));
    const cleanAbsentFromEveryPeer = [...capturedRecord.candidatePeerIds]
      .every((candidatePeerId) => capturedRecord.cleanAbsentPeerIds.has(candidatePeerId));
    if (cleanAbsentFromEveryPeer && capturedRecord.curatorRosterConfirmed) {
      this.enterVmReconcileRotationBackoff(slotKey, capturedRecord, 'clean-absence');
    } else if (scheduledEveryPeer && capturedRecord.curatorRosterConfirmed) {
      // This is retry suppression only, never absence proof. It prevents a
      // legacy peer that ignores the exact filter from replaying the same
      // bounded prefix at elevated priority every sweep.
      this.enterVmReconcileRotationBackoff(slotKey, capturedRecord, 'incomplete-cycle');
    }
    this.touchVmReconcileRotationRecord(slotKey, capturedRecord);
  }

  creditVmReconcileCleanAbsence(
    this: DKGAgent,
    target: OrdinalRecoveryTarget,
    peerId: string,
    expectedCandidatePeerIds: readonly string[],
    capturedRecord: VmReconcileRotationRecord,
  ): void {
    this.settleVmReconcileRotationAttempt(
      target,
      peerId,
      'clean-absent',
      expectedCandidatePeerIds,
      capturedRecord,
    );
  }

  shouldRunVmReconcileActiveFetch(this: DKGAgent, localCgId: string): boolean {
    const now = Date.now();
    this.pruneVmReconcileState(now);
    const lastFetchAt = this.vmReconcileFetchCooldownAt.get(localCgId);
    if (lastFetchAt !== undefined && now - lastFetchAt < DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS) {
      return false;
    }
    if (lastFetchAt !== undefined) this.vmReconcileFetchCooldownAt.delete(localCgId);
    this.vmReconcileFetchCooldownAt.set(localCgId, now);
    return true;
  }

  vmReconcileActiveFetchHadUsableResponse(this: DKGAgent, result: {
    peersSucceeded?: number;
    sharedMemorySynced?: number;
    diagnostics?: { sharedMemory?: Partial<SharedMemorySyncDiagnostics> };
  }): boolean {
    if ((result.peersSucceeded ?? 0) > 0) return true;
    if ((result.sharedMemorySynced ?? 0) > 0) return true;
    const shared = result.diagnostics?.sharedMemory;
    if (!shared) return false;
    return (shared.insertedDataTriples ?? 0) > 0
      || (shared.insertedMetaTriples ?? 0) > 0
      || (shared.checkpointAdvances ?? 0) > 0
      || ((shared.completedPhases ?? 0) > 0 && (shared.resumedPhases ?? 0) > 0);
  }

  pruneVmReconcileState(this: DKGAgent, now = Date.now()): void {
    while (this.vmReconcileNegativeCache.size > DKGAgentBase.VM_RECONCILE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileNegativeCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.deleteVmReconcileNegativeCacheEntry(oldestKey);
    }

    for (const [localCgId, lastFetchAt] of this.vmReconcileFetchCooldownAt) {
      if (now - lastFetchAt >= DKGAgentBase.VM_RECONCILE_SWEEP_INTERVAL_MS) {
        this.vmReconcileFetchCooldownAt.delete(localCgId);
      }
    }
    while (this.vmReconcileFetchCooldownAt.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileFetchCooldownAt.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileFetchCooldownAt.delete(oldestKey);
    }

    while (this.vmReconcileCatchupPeerCursor.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCatchupPeerCursor.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCatchupPeerCursor.delete(oldestKey);
      this.vmReconcileCatchupPeerOrder.delete(oldestKey);
    }
    while (this.vmReconcileCatchupPeerOrder.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCatchupPeerOrder.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCatchupPeerOrder.delete(oldestKey);
      this.vmReconcileCatchupPeerCursor.delete(oldestKey);
    }
    while (this.vmReconcileCuratorPeersByCg.size > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES) {
      const oldestKey = this.vmReconcileCuratorPeersByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCuratorPeersByCg.delete(oldestKey);
    }
    while (
      this.vmReconcileCuratorPageCursorByCg.size
      > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES
    ) {
      const oldestKey = this.vmReconcileCuratorPageCursorByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileCuratorPageCursorByCg.delete(oldestKey);
    }
    while (
      this.vmReconcileRotationAdmissionCursorByCg.size
      > DKGAgentBase.VM_RECONCILE_CG_STATE_MAX_ENTRIES
    ) {
      const oldestKey = this.vmReconcileRotationAdmissionCursorByCg.keys().next().value;
      if (oldestKey === undefined) break;
      this.vmReconcileRotationAdmissionCursorByCg.delete(oldestKey);
    }
  }

  clearVmReconcileStateForContextGraph(this: DKGAgent, localCgId: string): void {
    const sub = this.subscribedContextGraphs.get(localCgId);
    if (sub?.subscribed || sub?.coreHosted) return;
    this.forceClearVmReconcileStateForContextGraph(localCgId);
  }

  forceClearVmReconcileStateForContextGraph(this: DKGAgent, localCgId: string): void {
    const negativeCacheKeys = this.vmReconcileNegativeCacheKeysByCg.get(localCgId);
    if (negativeCacheKeys) {
      for (const cacheKey of Array.from(negativeCacheKeys)) {
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
      }
    }
    for (const [cacheKey, hydratedLocalCgId] of this.vmReconcileNegativeCacheHydrated) {
      if (hydratedLocalCgId === localCgId) {
        this.vmReconcileNegativeCacheHydrated.delete(cacheKey);
      }
    }
    void this.config.contextGraphSubscriptionStore
      ?.deleteVmReconcileNegativesForContextGraph?.(localCgId)
      .catch(() => {
        // Best-effort durable cleanup; generation checks still reject stale rows.
      });
    this.reconcileCursors.delete(localCgId);
    this.clearVmReconcileRotationStateForContextGraph(localCgId);
    this.vmReconcileCuratorPeersByCg.delete(localCgId);
    this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
    this.vmReconcileFetchCooldownAt.delete(localCgId);
    this.vmReconcileCatchupPeerCursor.delete(localCgId);
    this.vmReconcileCatchupPeerOrder.delete(localCgId);
    this.clearRecentVmReconcileStateForContextGraph(localCgId);
  }

  clearRecentVmReconcileStateForContextGraph(this: DKGAgent, localCgId: string): void {
    this.recentReconciledUals.deleteByPrefix(`${localCgId}\0`);
  }

  vmReconcileCacheKey(this: DKGAgent, localCgId: string, ual: string, merkleRoot: Uint8Array): string {
    const rootHex = Array.from(merkleRoot, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${localCgId}\0${ual}#${rootHex}`;
  }

  vmReconcileCacheKeyPrefix(this: DKGAgent, cacheKey: string): string {
    const separator = cacheKey.lastIndexOf('#');
    return separator >= 0 ? cacheKey.slice(0, separator + 1) : `${cacheKey}#`;
  }

  pruneVmReconcileCacheKeySiblings(this: DKGAgent, cacheKey: string): void {
    const prefix = this.vmReconcileCacheKeyPrefix(cacheKey);
    for (const key of this.vmReconcileNegativeCache.keys()) {
      if (key !== cacheKey && key.startsWith(prefix)) {
        this.deleteVmReconcileNegativeCacheEntry(key);
      }
    }
    this.recentReconciledUals.deleteByPrefix(prefix, cacheKey);
  }

  vmReconcileConnectedPeerCount(this: DKGAgent): number {
    try {
      const libp2p = (this.node as any)?.libp2p;
      const getConnections = libp2p?.getConnections;
      if (typeof getConnections !== 'function') return 0;
      const uniquePeers = new Set<string>(
        (getConnections.call(libp2p) as Array<{ remotePeer?: { toString(): string } }>)
          .map((connection) => connection.remotePeer?.toString())
          .filter((peerId): peerId is string => typeof peerId === 'string' && peerId.length > 0),
      );
      return uniquePeers.size;
    } catch {
      return 0;
    }
  }

  /**
   * Drain one exact missing-KA batch. The initial ordinal scan has already
   * proven these UALs are not locally materialized, so no already-confirmed KA
   * enters the wire request. After every peer response we re-run local chain
   * verification and remove completed KAs before considering another peer.
   */
  async recoverVmReconcileBatch(this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly OrdinalRecoveryTarget[],
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<PendingOrdinalRecoveryResult> {
    const rotationGeneration = this.vmReconcileLifecycleGeneration;
    const isRecoveryCurrent = () => !this.vmReconcileRotationClosed
      && !signal?.aborted
      && this.vmReconcileLifecycleGeneration === rotationGeneration
      && isTargetCurrent();
    const ctx = createOperationContext('system');
    const noRecovery = (
      continuationOrdinal?: number,
      cooldownOnly = false,
    ): PendingOrdinalRecoveryResult => ({
      outcomes: new Map(),
      attemptedOrdinals: [],
      continuationOrdinal,
      hasImmediateRecoveryWork: false,
      cooldownOnly,
    });
    if (!isRecoveryCurrent() || targets.length === 0) return noRecovery();

    const expectedOnChainCgId = onChainCgId.toString();
    let currentTargets = targets.filter((target) =>
      target.localCgId === localCgId && target.onChainCgId === expectedOnChainCgId);
    if (currentTargets.length === 0) return noRecovery();
    const admissionCursor = (
      this.vmReconcileRotationAdmissionCursorByCg.get(localCgId) ?? 0
    ) % currentTargets.length;
    const admissionDistance = (index: number) => (
      index - admissionCursor + currentTargets.length
    ) % currentTargets.length;

    // Suppression consults only the already-observed, capped connection view.
    // This is intentionally before curator resolution, dialing, protocol waits,
    // and admission probes. Every target reached this method only after the
    // production ordinal/finalization check proved it still pending locally.
    const observedCandidatePeerIds = this.vmReconcileObservedCandidatePeerIds(localCgId);
    const now = this.vmReconcileRotationNow();
    const initiallyOwnedSlotKeys = new Set(currentTargets.flatMap((target) => {
      const slotKey = this.vmReconcileRotationSlotKey(target);
      const record = this.vmReconcileRotationState.get(slotKey);
      return record?.fingerprint === this.vmReconcileRotationFingerprint(target)
        ? [slotKey]
        : [];
    }));
    const hasUnownedTarget = currentTargets.some((target) =>
      !initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)));
    const reservedReplacementSlotKey = hasUnownedTarget
      ? this.findVmReconcileRotationReplacement(localCgId)?.[0]
      : undefined;
    const initialPreparations = currentTargets
      .map((target, index) => ({
        index,
        target,
        hasOwnedRecord: initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)),
      }))
      // Use the same fair admission order before network work. Besides handing
      // expired capacity to a waiter, this makes an all-live saturated cache
      // return below without paying curator-resolution cost for work that
      // cannot retain its retry state.
      .sort((left, right) => Number(left.hasOwnedRecord) - Number(right.hasOwnedRecord)
        || admissionDistance(left.index) - admissionDistance(right.index))
      .map(({ index, target }) => {
        const slotKey = this.vmReconcileRotationSlotKey(target);
        const existing = this.vmReconcileRotationState.get(slotKey);
        if (!existing || existing.fingerprint !== this.vmReconcileRotationFingerprint(target)) {
          // The pre-network pass only consults already-earned suppression. A new
          // cycle is installed after curator resolution so its first roster is
          // authoritative-first; a stale fingerprint is invalidated immediately.
          if (existing) this.vmReconcileRotationState.delete(slotKey);
          const capacityAvailable = this.canInstallVmReconcileRotationRecord(localCgId);
          return {
            index,
            target,
            prepared: {
              slotKey,
              record: undefined,
              suppressed: this.vmReconcileRotationClosed || !capacityAvailable,
            },
          };
        }
        if (slotKey === reservedReplacementSlotKey) {
          // Keep the donor intact, but do not renew it before the waiter reaches
          // post-resolution installation. An earlier lifecycle exit leaves the
          // original record untouched; a successful install replaces it atomically.
          return {
            index,
            target,
            prepared: { slotKey, record: existing, suppressed: true },
          };
        }
        return {
          index,
          target,
          prepared: this.prepareVmReconcileRotationTarget(
            target,
            observedCandidatePeerIds,
            now,
            existing.curatorRosterConfirmed,
          ),
        };
      })
      .sort((left, right) => left.index - right.index);
    const initiallyEligible = initialPreparations
      .filter(({ prepared }) => !prepared.suppressed)
      .map(({ target }) => target);
    if (initiallyEligible.length === 0) {
      const suppressedRecords = initialPreparations
        .map(({ prepared }) => prepared.record)
        .filter((record): record is VmReconcileRotationRecord => record !== undefined);
      const nextRetryInMs = suppressedRecords.length === 0
        ? 0
        : Math.max(0, Math.min(...suppressedRecords.map((record) => record.nextRetryAt)) - now);
      this.log.info(
        ctx,
        `VM exact fetch for "${localCgId}" skipped by exact-recovery backoff `
          + `(slots=${suppressedRecords.length} candidates=${observedCandidatePeerIds.length} `
          + `failures=${Math.max(0, ...suppressedRecords.map((record) => record.failures))} `
          + `retryInMs=${Math.round(nextRetryInMs)})`,
      );
      return noRecovery();
    }

    // Damping: the batched path deliberately skips the per-UAL negative cache
    // (consulting it primes connections to every discovered agent — the walk
    // this path exists to avoid), so the per-CG active-fetch cooldown is the
    // short-term damper between fresh rotation attempts. Completed clean-
    // absence rotations use the slot-specific exponential backoff above;
    // transient/incomplete attempts retain this sweep-interval cooldown.
    if (!this.shouldRunVmReconcileActiveFetch(localCgId)) {
      this.log.info(ctx, `VM exact fetch for "${localCgId}" skipped by per-CG cooldown`);
      return noRecovery(initiallyEligible[0]?.ordinal, true);
    }

    // Sizing is optional recovery work, so it belongs behind the same
    // per-CG admission decision as exact network fetches. Live-event nudges
    // received during cooldown must not turn into repeated liveness, policy,
    // or per-KA update-context RPCs when no transfer may run.
    const readVmRecoveryUpdateContext = this.chain.getKnowledgeAssetUpdateContext;
    currentTargets = await enrichVmRecoveryFootprints(
      currentTargets,
      onChainCgId,
      {
        authority: {
          kind: 'host-policy',
          resolveAccessPolicy: (contextGraphId) =>
            this.readLiveOnChainAccessPolicy(contextGraphId.toString(), ctx),
        },
        sizing: typeof readVmRecoveryUpdateContext === 'function'
          ? {
              readUpdateContext: (kaId, readOptions) =>
                readVmRecoveryUpdateContext.call(this.chain, kaId, readOptions),
            }
          : null,
      },
      {
        maxContextReads: MAX_EXACT_SYNC_ASSETS,
        signal,
        isCurrent: isRecoveryCurrent,
      },
    );
    if (!isRecoveryCurrent()) {
      this.vmReconcileFetchCooldownAt.delete(localCgId);
      return noRecovery();
    }

    // Capture the authenticated join-approval hint before consulting metadata:
    // older member snapshots can contain a legacy creator self-stamp that is
    // unrelated to a wallet-scoped CG's structural curator. The structural
    // registry resolver is authoritative for `0x…/slug` graphs and can return
    // every node registered to that curator wallet.
    const approvedCuratorPeerId = this.preferredSyncPeers.get(localCgId);
    const cachedCuratorPeerIds = [
      ...(this.vmReconcileCuratorPeersByCg.get(localCgId) ?? []),
    ];
    const curatorPageCursor = this.vmReconcileCuratorPageCursorByCg.get(localCgId);
    const curatorResolution = await this.resolveCuratorPeerIdsForCg(localCgId, {
      maxPeerIds: DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
      // Once overflow is proven, expose exactly one new ordered peer per pass.
      // One target can spend only one peer attempt, so advancing by more would
      // skip candidates when a CG has a single missing KA.
      pagePeerIds: 1,
      afterPeerId: curatorPageCursor,
      signal,
      isCurrent: isRecoveryCurrent,
    })
      .catch(() => ({
        peerIds: [] as string[],
        curatorIsLocal: false,
        legacyTripleResolved: false,
        lookupFailed: true,
        overflowed: false,
        nextPageAfterPeerId: undefined,
      }));
    if (!isRecoveryCurrent()) return noRecovery();
    const allResolvedCuratorPeerIds = [...new Set(curatorResolution.peerIds
      .filter((peerId) => peerId && peerId !== this.peerId))]
      .sort((left, right) => left.localeCompare(right));
    const curatorRosterOverflow = curatorResolution.overflowed === true
      || allResolvedCuratorPeerIds.length > DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX;
    if (curatorRosterOverflow) {
      this.log.warn(
        ctx,
        `VM exact fetch curator roster for "${localCgId}" exceeds bounded proof capacity `
          + `(ordered transport page=${allResolvedCuratorPeerIds.length}, `
          + `proofCap=${DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX}); `
          + 'walking the registry without negative-proof suppression',
      );
    }
    const resolutionSucceeded = curatorResolution.lookupFailed !== true
      && !curatorRosterOverflow;
    // Even an invalid oversized result remains useful for bounded fail-open
    // transport. Rotate a bounded window through it using the existing cache as
    // the cursor: a fixed prefix (or a formerly authoritative cached roster)
    // could otherwise hide a newly added holder forever. The window remains
    // explicitly unconfirmed below, so it can never support absence proof.
    const overflowTransportUniverse = [...new Set([
      ...allResolvedCuratorPeerIds,
      approvedCuratorPeerId,
    ].filter((peerId): peerId is string => Boolean(peerId && peerId !== this.peerId)))];
    const cachedOverflowStart = cachedCuratorPeerIds.length > 0
      ? overflowTransportUniverse.indexOf(cachedCuratorPeerIds[0]!)
      : -1;
    const overflowWindowStart = cachedOverflowStart < 0
      ? 0
      : (cachedOverflowStart + 1) % overflowTransportUniverse.length;
    const overflowTransportPeerIds = Array.from(
      { length: Math.min(
        DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
        overflowTransportUniverse.length,
      ) },
      (_, offset) => overflowTransportUniverse[
        (overflowWindowStart + offset) % overflowTransportUniverse.length
      ]!,
    );
    const resolvedCuratorPeerIds = curatorRosterOverflow
      ? curatorResolution.nextPageAfterPeerId
        ? allResolvedCuratorPeerIds
        : overflowTransportPeerIds
      : allResolvedCuratorPeerIds;
    let legacyPreferredPeerId: string | undefined;
    if (resolutionSucceeded && !curatorResolution.curatorIsLocal
      && resolvedCuratorPeerIds.length === 0) {
      legacyPreferredPeerId = await this.resolvePreferredSyncPeerId(localCgId);
    }
    if (!isRecoveryCurrent()) return noRecovery();
    const authoritativeCuratorPeerIds = resolutionSucceeded
      ? resolvedCuratorPeerIds
      : curatorRosterOverflow
        ? resolvedCuratorPeerIds
        : cachedCuratorPeerIds;
    const curatorPeerIds = [...new Set([
      ...authoritativeCuratorPeerIds,
      legacyPreferredPeerId,
      approvedCuratorPeerId,
    ].filter((peerId): peerId is string => Boolean(peerId && peerId !== this.peerId)))]
      .slice(0, DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX);
    // Persist the bounded full authoritative roster. Individual passes still
    // connect/probe at most VM_RECONCILE_EXACT_PEER_MAX peers, while each
    // target's rotation record carries progress across those windows.
    if (resolutionSucceeded) {
      this.vmReconcileCuratorPeersByCg.delete(localCgId);
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
    } else if (curatorResolution.nextPageAfterPeerId) {
      this.vmReconcileCuratorPageCursorByCg.delete(localCgId);
      this.vmReconcileCuratorPageCursorByCg.set(
        localCgId,
        curatorResolution.nextPageAfterPeerId,
      );
    }
    if (!curatorResolution.curatorIsLocal && curatorPeerIds.length > 0) {
      this.vmReconcileCuratorPeersByCg.delete(localCgId);
      this.vmReconcileCuratorPeersByCg.set(localCgId, curatorPeerIds);
    }
    this.pruneVmReconcileState();

    const connectedByPeerId = new Map(
      this.node.libp2p.getConnections()
        .map((connection) => [connection.remotePeer.toString(), connection.remotePeer]),
    );
    // Use the exact same memory-only canonicalizer as the suppression gate.
    // Curator resolution may connect a missing peer, but it must not substitute
    // a different ranking algorithm and invalidate an otherwise stable roster.
    const orderedPeerIds = this.vmReconcileObservedCandidatePeerIds(localCgId);

    // Curator preparation may have grown or shrunk the connected candidate
    // set. Re-evaluate every target against that observed change. Any roster
    // change breaks backoff and starts a fresh proof cycle.
    const preparedEntries = currentTargets
      .map((target, index) => ({
        index,
        target,
        hasOwnedRecord: initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)),
      }))
      // At a full cap, give deferred targets first claim on an expired slot.
      // Otherwise an expired owner encountered first would renew itself before
      // any waiter could enter, starving stable-order overflow indefinitely.
      .sort((left, right) => Number(left.hasOwnedRecord) - Number(right.hasOwnedRecord)
        || admissionDistance(left.index) - admissionDistance(right.index))
      .map(({ index, target }) => ({
        index,
        target,
        prepared: this.prepareVmReconcileRotationTarget(
          target,
          orderedPeerIds,
          this.vmReconcileRotationNow(),
          resolutionSucceeded,
        ),
      }))
      .sort((left, right) => left.index - right.index);
    const newlyAdmitted = preparedEntries
      .filter(({ target, prepared }) => prepared.record
        && !initiallyOwnedSlotKeys.has(this.vmReconcileRotationSlotKey(target)));
    if (newlyAdmitted.length > 0) {
      const lastAdmitted = newlyAdmitted.reduce((latest, entry) => (
        admissionDistance(entry.index) > admissionDistance(latest.index) ? entry : latest
      ));
      this.vmReconcileRotationAdmissionCursorByCg.delete(localCgId);
      this.vmReconcileRotationAdmissionCursorByCg.set(
        localCgId,
        (lastAdmitted.index + 1) % currentTargets.length,
      );
    }
    const eligible = preparedEntries
      .map((entry) => {
        const { record } = entry.prepared;
        if (
          record
          && this.vmReconcileRotationState.get(entry.prepared.slotKey) !== record
        ) {
          // A later slot may have replaced an expired record while the batch
          // was prepared. Defer the now-unowned target: elevated transport
          // without retained retry state would violate the pressure bound.
          return {
            ...entry,
            prepared: { slotKey: entry.prepared.slotKey, suppressed: true },
          };
        }
        return entry;
      })
      .filter((entry) => !entry.prepared.suppressed)
      // Installed collecting records get first use of the bounded peer set so
      // overflow cannot consume the one peer they still need to complete. The
      // original target order remains stable within each class.
      .sort((left, right) => {
        const leftInstalled = left.prepared.record
          && this.vmReconcileRotationState.get(left.prepared.slotKey) === left.prepared.record
          ? 1 : 0;
        const rightInstalled = right.prepared.record
          && this.vmReconcileRotationState.get(right.prepared.slotKey) === right.prepared.record
          ? 1 : 0;
        return rightInstalled - leftInstalled || left.index - right.index;
      });

    const outcomes = new Map<number, OrdinalOutcome>();
    const attemptedOrdinals = new Set<number>();
    // A clean exact hit proves only that this peer held the requested asset,
    // not the whole CG. It is nevertheless the best bounded candidate for one
    // byte/leaf-aware microbatch of untouched targets in this same slice. One
    // clean absence or incomplete response removes the hint immediately.
    const providerPolicy = new VmRecoveryProviderPolicy();
    const handledBatchOrdinals = new Set<number>();
    let recoveryWorkRan = false;

    for (let eligibleIndex = 0; eligibleIndex < eligible.length; eligibleIndex += 1) {
      if (!isRecoveryCurrent()) break;
      const entry = eligible[eligibleIndex]!;
      const { target } = entry;
      if (handledBatchOrdinals.has(target.ordinal)) continue;
      const record = entry.prepared.record;
      const installedRecord = record
        && this.vmReconcileRotationState.get(this.vmReconcileRotationSlotKey(target)) === record
        ? record
        : undefined;
      const candidatePeerIds = installedRecord
        ? [...installedRecord.candidatePeerIds]
        : orderedPeerIds;

      // Rotate every physical outcome, including incomplete responses, without
      // conflating the attempt cursor with clean-absence evidence. Try the
      // target's next available peer. Protocol/admission failures remain
      // uncredited, but consume this target's turn so another missing KA gets
      // the next physical peer slot in the same bounded pass.
      let peerId: string | undefined;
      const candidatePeerId = this.selectVmReconcileExactCandidate(
        installedRecord,
        orderedPeerIds,
        providerPolicy,
      );
      if (candidatePeerId) {
        attemptedOrdinals.add(target.ordinal);
        if (installedRecord) {
          installedRecord.lastAttemptedPeerId = candidatePeerId;
          installedRecord.attemptedPeerIds.add(candidatePeerId);
          installedRecord.collectionDeadlineAt = this.vmReconcileRotationNow()
            + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
          this.touchVmReconcileRotationRecord(
            this.vmReconcileRotationSlotKey(target),
            installedRecord,
          );
        }
        let connectedPeer = connectedByPeerId.get(candidatePeerId);
        if (!connectedPeer) {
          await this.ensurePeerConnected(candidatePeerId, { signal }).catch((error) => {
            this.log.info(
              ctx,
              `VM exact fetch could not connect candidate peer ${candidatePeerId.slice(-8)}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          if (!isRecoveryCurrent()) return noRecovery();
          const connection = this.node.libp2p.getConnections()
            .find((candidate) => candidate.remotePeer.toString() === candidatePeerId);
          connectedPeer = connection?.remotePeer;
          if (connectedPeer) connectedByPeerId.set(candidatePeerId, connectedPeer);
        }
        recoveryWorkRan = true;
        const protocolReady = connectedPeer
          ? await this.waitForSyncProtocol(connectedPeer, signal)
          : false;
        if (!isRecoveryCurrent()) return noRecovery();
        if (!connectedPeer || !protocolReady) {
          providerPolicy.markUnavailable(candidatePeerId);
        } else {
          // Network boundary: a merely-connected peer is not necessarily
          // admitted to this DKG network. Never send an authenticated exact
          // request to an unverified or rejected peer.
          const peerAdmitted = await this.ensurePeerAdmittedForRecovery(
            candidatePeerId,
            ctx,
            'VM exact fetch',
            signal,
          );
          if (!isRecoveryCurrent()) return noRecovery();
          if (!peerAdmitted) providerPolicy.markUnavailable(candidatePeerId);
          else peerId = candidatePeerId;
        }
      }
      if (!peerId) {
        if (installedRecord) {
          this.settleVmReconcileRotationAttempt(
            target,
            undefined,
            'incomplete',
            candidatePeerIds,
            installedRecord,
            providerPolicy.unavailablePeerIds(),
          );
        }
        continue;
      }
      const providerAttempt = providerPolicy.beginAttempt(peerId);
      if (!providerAttempt) continue;

      type EligibleEntry = (typeof eligible)[number];
      type BatchAttempt = {
        entry: EligibleEntry;
        installedRecord: VmReconcileRotationRecord | undefined;
        candidatePeerIds: string[];
      };
      let batchAttempts: BatchAttempt[] = [{
        entry,
        installedRecord,
        candidatePeerIds,
      }];

      // The first exact request to a peer remains a single-KA probe. Once that
      // probe has proved the peer is a holder, pack a stable compatible prefix
      // by authoritative size hints. Unknown footprints stay singleton; the
      // exact-sync protocol's ten-UAL cap remains the hard upper bound.
      if (providerAttempt.kind === 'proven-holder-reuse') {
        const compatible: BatchAttempt[] = [];
        for (let candidateIndex = eligibleIndex; candidateIndex < eligible.length; candidateIndex += 1) {
          const candidateEntry = eligible[candidateIndex]!;
          const candidateTarget = candidateEntry.target;
          if (handledBatchOrdinals.has(candidateTarget.ordinal)) continue;
          const candidateRecord = candidateEntry.prepared.record;
          const candidateInstalledRecord = candidateRecord
            && this.vmReconcileRotationState.get(
              this.vmReconcileRotationSlotKey(candidateTarget),
            ) === candidateRecord
            ? candidateRecord
            : undefined;
          // The current target was selected and marked attempted before the
          // connection/admission boundary. Later candidates must still prove
          // this peer remains uncredited in their independent rotation record.
          const peerEligible = candidateIndex === eligibleIndex
            || (candidateInstalledRecord
              ? this.vmReconcileUncreditedCandidateOrder(candidateInstalledRecord).includes(peerId)
              : orderedPeerIds.includes(peerId));
          if (!peerEligible) break;
          compatible.push({
            entry: candidateEntry,
            installedRecord: candidateInstalledRecord,
            candidatePeerIds: candidateInstalledRecord
              ? [...candidateInstalledRecord.candidatePeerIds]
              : orderedPeerIds,
          });
        }
        const plannableTargets = compatible.map((attempt) => ({
          attempt,
          recoveryFootprint: attempt.entry.target.recoveryFootprint
            ?? { kind: 'unknown' as const },
        } satisfies VmRecoveryTargetFootprint & { attempt: BatchAttempt }));
        const plan = planVmRecoveryMicrobatch(
          plannableTargets,
          VM_EXACT_MICROBATCH_LIMITS,
          (plannedTargets) => Buffer.byteLength(
            encodeExactAssetUals(plannedTargets.map(
              ({ attempt }) => attempt.entry.target.ual,
            )),
            'utf8',
          ),
        );
        if (plan.targets.length === 0) {
          this.log.warn(
            ctx,
            `VM exact recovery selector for "${localCgId}" exceeds the executor cap; `
              + `ordinal=${target.ordinal} selectorCap=${VM_EXACT_MICROBATCH_LIMITS.maxSelectorBytes}`,
          );
          if (installedRecord) {
            this.settleVmReconcileRotationAttempt(
              target,
              undefined,
              'incomplete',
              candidatePeerIds,
              installedRecord,
              providerPolicy.unavailablePeerIds(),
            );
          }
          providerPolicy.finishAttempt(
            providerAttempt,
            'incomplete',
            new Map<string, VmRecoveryUalDisposition>([[target.ual, 'incomplete']]),
          );
          continue;
        }
        batchAttempts = plan.targets.map(({ attempt }) => attempt);
        this.log.info(
          ctx,
          `VM exact recovery plan for "${localCgId}" from ${peerId.slice(-8)}: `
            + `assets=${batchAttempts.length} estimatedBytes=${plan.estimatedBytes} `
            + `estimatedLeaves=${plan.estimatedLeaves} `
            + `completeFootprints=${plan.completeFootprints}`,
        );
      }

      for (const attempt of batchAttempts) {
        const batchTarget = attempt.entry.target;
        handledBatchOrdinals.add(batchTarget.ordinal);
        attemptedOrdinals.add(batchTarget.ordinal);
        if (attempt.installedRecord) {
          attempt.installedRecord.lastAttemptedPeerId = peerId;
          attempt.installedRecord.attemptedPeerIds.add(peerId);
          attempt.installedRecord.collectionDeadlineAt = this.vmReconcileRotationNow()
            + DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS;
          this.touchVmReconcileRotationRecord(
            this.vmReconcileRotationSlotKey(batchTarget),
            attempt.installedRecord,
          );
        }
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          action: 'fetch',
          ordinal: batchTarget.ordinal,
          kaId: batchTarget.kaId,
          ual: batchTarget.ual,
          detail: batchAttempts.length > 1 ? 'exact-asset-batch' : 'exact-asset',
        });
      }

      // Every queue item still consumes at most one peer attempt per eligible
      // pass. A partial microbatch is revalidated per KA; unresolved members
      // retain rotation state and fail open to another provider on a later pass.
      if (!isRecoveryCurrent()) return noRecovery();

      let disposition: 'found' | 'clean-absent' | 'incomplete' = 'incomplete';
      try {
        const detailed = await this.syncExactKnowledgeAssetsFromPeerDetailed(
          peerId,
          localCgId,
          batchAttempts.map(({ entry: item }) => item.target.ual),
          { signal, isCurrent: isRecoveryCurrent },
        );
        const { result } = detailed;
        disposition = detailed.disposition;
        this.log.info(
          ctx,
          `VM exact fetch for "${localCgId}" from ${peerId.slice(-8)}: requested=${batchAttempts.length} fetched=${result.fetchedDataTriples + result.fetchedMetaTriples} inserted=${result.insertedTriples} failed=${result.failedPeers + result.failedPhases} deferred=${result.deferredBackpressure} disposition=${disposition}`,
        );
      } catch (error) {
        this.log.info(
          ctx,
          `VM exact fetch for "${localCgId}" from ${peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The exact request may have completed after unsubscribe, rebind, or
      // shutdown. Its authenticated materialization is already fail-closed,
      // but no process-local evidence or cooldown may outlive that lifecycle.
      if (!isRecoveryCurrent()) return noRecovery();
      const perUalDispositions = new Map<string, VmRecoveryUalDisposition>();
      for (const attempt of batchAttempts) {
        const batchTarget = attempt.entry.target;
        const outcome = await this.reconcileChainOrdinal(
          localCgId,
          onChainCgId,
          batchTarget.ordinal,
          headBlock,
          {
            isTargetCurrent: isRecoveryCurrent,
            deferActiveFetch: true,
            recoveryFootprint: batchTarget.recoveryFootprint ?? { kind: 'unknown' },
          },
        );
        if (!isRecoveryCurrent()) return noRecovery();
        outcomes.set(batchTarget.ordinal, outcome);
        const perTargetDisposition: VmRecoveryUalDisposition = (
          outcome.status === 'reconciled' || outcome.status === 'already'
        )
          ? 'found'
          : disposition === 'clean-absent'
            ? 'clean-absent'
            : 'incomplete';
        perUalDispositions.set(batchTarget.ual, perTargetDisposition);
        if (outcome.status === 'pending' && outcome.recovery) {
          const batchRecord = attempt.installedRecord;
          if (!batchRecord) continue;
          if (this.vmReconcileRotationClosed) continue;
          if (
            this.vmReconcileRotationState.get(this.vmReconcileRotationSlotKey(batchTarget))
            !== batchRecord
          ) continue;
          const candidateMembershipAfter = this.vmReconcileObservedCandidatePeerIds(
            localCgId,
          );
          if (!this.vmReconcilePeerMembershipMatches(
            batchRecord.candidatePeerIds,
            candidateMembershipAfter,
          )) {
            // Membership changed while the request was in flight. Invalidate the
            // cycle before considering its response, then fail open.
            this.prepareVmReconcileRotationTarget(
              outcome.recovery,
              candidateMembershipAfter,
              this.vmReconcileRotationNow(),
            );
          } else if (this.vmReconcileRecoveryTargetMatches(batchTarget, outcome.recovery)) {
            this.settleVmReconcileRotationAttempt(
              batchTarget,
              peerId,
              perTargetDisposition,
              attempt.candidatePeerIds,
              batchRecord,
              providerPolicy.unavailablePeerIds(),
            );
          }
        } else {
          this.vmReconcileRotationState.delete(this.vmReconcileRotationSlotKey(batchTarget));
        }
      }
      providerPolicy.finishAttempt(providerAttempt, disposition, perUalDispositions);
    }

    const eligibleOrdinals = new Set(eligible.map(({ target }) => target.ordinal));
    const unattemptedContinuationOrdinal = currentTargets.find((target) =>
      eligibleOrdinals.has(target.ordinal) && !attemptedOrdinals.has(target.ordinal))?.ordinal;
    const hasImmediateRecoveryWork = eligible.some(({ target }) => {
      const outcome = outcomes.get(target.ordinal);
      const record = this.vmReconcileRotationState.get(
        this.vmReconcileRotationSlotKey(target),
      );
      if (
        record?.phase !== 'collecting'
        || record.fingerprint !== this.vmReconcileRotationFingerprint(target)
        || this.vmReconcileUncreditedCandidateOrder(record).length === 0
      ) return false;
      // When revalidation ran, it must still describe the same pending target.
      // A protocol/admission failure can consume an attempt before producing
      // an outcome; the matching retained record is then sufficient proof that
      // another bounded provider attempt remains immediately runnable.
      return outcome === undefined
        ? attemptedOrdinals.has(target.ordinal)
        : outcome.status === 'pending'
          && outcome.recovery !== undefined
          && this.vmReconcileRecoveryTargetMatches(target, outcome.recovery);
    });
    const continuationOrdinal = unattemptedContinuationOrdinal;

    // Mirror the inline path's cooldown policy, but do not turn a bounded peer
    // slice into a one-minute stall while the retained rotation record proves
    // there is novel work left. Each trailing pass still obeys the hard peer,
    // ordinal and global-sync admission caps; it merely reaches the next target
    // or untried provider without waiting for the periodic safety-net sweep.
    // Once every retained provider cycle is exhausted, the ordinary cooldown /
    // negative backoff applies exactly as before.
    if (!isRecoveryCurrent()) return noRecovery();
    const recoveredAny = [...outcomes.values()]
      .some((outcome) => outcome.status === 'reconciled' || outcome.status === 'already');
    if (
      !recoveryWorkRan
      || recoveredAny
      || continuationOrdinal !== undefined
      || hasImmediateRecoveryWork
    ) {
      this.vmReconcileFetchCooldownAt.delete(localCgId);
    } else {
      this.vmReconcileFetchCooldownAt.delete(localCgId);
      this.vmReconcileFetchCooldownAt.set(localCgId, Date.now());
    }
    return {
      outcomes,
      attemptedOrdinals: [...attemptedOrdinals],
      // Continue only at work that this eligible pass did not attempt. Pending
      // attempts are rotated inside `remaining` to give untouched targets the
      // next peer, but once every submitted target has consumed one attempt
      // the outer fair scan must wrap from its watermark on the next cycle.
      continuationOrdinal,
      hasImmediateRecoveryWork,
      cooldownOnly: false,
    };
  }

  /**
   * Reconcile a single per-CG registration ordinal: resolve the kaId + its
   * latest on-chain merkle root + publisher, build the UAL, and ask the
   * finalization handler to promote the matching local SWM snapshot to VM
   * (verifying the CG binding from chain). When no local SWM matches, run an
   * active core-first catch-up fetch and retry once. `headBlock` is reused as
   * the materialization version AND echoed back as the cursor observation block
   * (reorg gate). See {@link OrdinalOutcome} for the status contract.
   */
  async reconcileChainOrdinal(this: DKGAgent,
    localCgId: string,
    onChainCgId: bigint,
    ordinal: number,
    headBlock: number | undefined,
    options: VmReconcileOrdinalOptions = {},
  ): Promise<OrdinalOutcome> {
    const ctx = createOperationContext('system');
    const versionBlock = headBlock ?? 0;
    this.pruneVmReconcileState();

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }

    let kaId: bigint;
    let merkleRoot: Uint8Array;
    let publisherAddress: string;
    let ual: string;
    let cacheKey = '';
    try {
      kaId = await this.chain.getContextGraphKCAt!(onChainCgId, BigInt(ordinal));
      const storageAddr = this.chain.getDKGKnowledgeAssetsAddress
        ? await this.chain.getDKGKnowledgeAssetsAddress()
        : undefined;
      if (!storageAddr) return { status: 'skip' };
      ual = buildReconciledKnowledgeAssetUal(this.chain.chainId, storageAddr, kaId);
      merkleRoot = await this.chain.getLatestMerkleRoot!(kaId);
      cacheKey = this.vmReconcileCacheKey(localCgId, ual, merkleRoot);

      // Recently reconciled (live-burst guard): treat as already-done so the
      // cursor advances without redoing chain reads + an SWM scan.
      if (this.recentReconciledUals.has(cacheKey)) {
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        return { status: 'already', blockNumber: versionBlock };
      }

      if (!options.deferActiveFetch && await this.shouldDeferVmReconcileByNegativeCache(cacheKey, localCgId)) {
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          action: 'defer',
          ordinal,
          kaId: kaId.toString(),
          ual,
          detail: 'negative-cache',
        });
        return { status: 'pending' };
      }

      publisherAddress = (this.chain.getLatestMerkleRootPublisher
        ? await this.chain.getLatestMerkleRootPublisher(kaId)
        : '') ?? '';
    } catch (err) {
      // RPC lag / unknown kaId — leave for the next sweep.
      this.log.info(ctx, `Phase B: ordinal ${ordinal} of cg ${onChainCgId} not resolvable yet: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'pending' };
    }

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }
    const fh = this.getOrCreateFinalizationHandler();
    const reconcileInput = {
      contextGraphId: localCgId,
      onChainCgId: onChainCgId.toString(),
      ual,
      merkleRoot,
      publisherAddress,
      kaId,
      versionBlock,
    };

    let swmState: VmReconcileSwmCandidateState | undefined;
    let activeFetchRan = false;
    let activeFetchHadUsableResponse = false;
    let outcome = await fh.handleChainReconciledKC(reconcileInput, ctx);
    if (outcome === 'no-swm' || outcome === 'verified-vm-metadata-pending') {
      if (options.deferActiveFetch) {
        const recoveryFootprint = options.recoveryFootprint ?? { kind: 'unknown' as const };
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: onChainCgId.toString(),
          action: 'defer',
          ordinal,
          kaId: kaId.toString(),
          ual,
          detail: outcome,
        });
        return {
          status: 'pending',
          recovery: {
            localCgId,
            onChainCgId: onChainCgId.toString(),
            ordinal,
            ual,
            merkleRoot: Array.from(
              merkleRoot,
              (byte) => byte.toString(16).padStart(2, '0'),
            ).join(''),
            kaId: kaId.toString(),
            reason: outcome,
            recoveryFootprint,
          },
        };
      }
      if (outcome === 'no-swm') {
        swmState = await this.collectVmReconcileSwmCandidateState(localCgId);
      }
      // Active fetch: pull the missing snapshot core-first (selectCatchupPeers
      // already prioritises known cores + the preferred sync peer), then retry.
      // Metadata-pending exact VM content needs the same recovery: a durable
      // sync can supply the missing provenance-bearing assertion metadata even
      // when no content triples need to move.
      const batchAllowsFetch = options.acquireActiveFetchPermit?.() ?? true;
      const cooldownAllowsFetch = batchAllowsFetch
        && this.shouldRunVmReconcileActiveFetch(localCgId);
      if (batchAllowsFetch && cooldownAllowsFetch) {
        activeFetchRan = true;
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'fetch', ordinal, kaId: kaId.toString(), ual,
        });
        let maxAttempts = 1;
        const fixedMaxAttempts = options.maxPeerAttempts === undefined
          ? undefined
          : Math.max(1, Math.floor(options.maxPeerAttempts));
        if (fixedMaxAttempts !== undefined) maxAttempts = fixedMaxAttempts;
        for (
          let attempt = 0;
          attempt < maxAttempts
            && (outcome === 'no-swm' || outcome === 'verified-vm-metadata-pending');
          attempt += 1
        ) {
          if (options.isTargetCurrent && !options.isTargetCurrent()) {
            break;
          }
          try {
            const fetchResult = await this.syncContextGraphFromConnectedPeers(localCgId, {
              includeSharedMemory: true,
              maxPeers: 1,
              peerRotationKey: localCgId,
              // This is recovery, not routine background catch-up. Without the
              // override it would enter through the default-background path and
              // be reported as `catchup-background`, merging repair traffic into
              // the background lane. Attribution only — mode, priority, peer
              // selection and the coalescing key are all unchanged.
              sourceOverride: 'vm-recovery',
            });
            if (fixedMaxAttempts === undefined) {
              maxAttempts = Math.max(
                maxAttempts,
                fetchResult.totalPeers ?? fetchResult.connectedPeers ?? 0,
                this.vmReconcileConnectedPeerCount(),
              );
            }
            if ((fetchResult.peersTried ?? 0) === 0 && (fetchResult.syncCapablePeers ?? 0) === 0) {
              continue;
            }
            if (!this.vmReconcileActiveFetchHadUsableResponse(fetchResult)) {
              continue;
            }
            activeFetchHadUsableResponse = true;
          } catch (err) {
            this.log.info(ctx, `Phase B: active fetch for "${localCgId}" (ordinal ${ordinal}) failed: ${err instanceof Error ? err.message : String(err)}`);
            if (fixedMaxAttempts === undefined) {
              maxAttempts = Math.max(maxAttempts, this.vmReconcileConnectedPeerCount());
            }
            continue;
          }
          if (options.isTargetCurrent && !options.isTargetCurrent()) {
            break;
          }
          outcome = await fh.handleChainReconciledKC(reconcileInput, ctx);
        }
        if (outcome === 'no-swm') {
          swmState = await this.collectVmReconcileSwmCandidateState(localCgId);
        }
      } else {
        const reason = batchAllowsFetch ? 'per-CG cooldown' : 'per-batch fetch budget';
        this.log.info(ctx, `Phase B: active fetch for "${localCgId}" (ordinal ${ordinal}) skipped by ${reason}`);
      }
    }

    if (options.isTargetCurrent && !options.isTargetCurrent()) {
      return { status: 'skip' };
    }

    switch (outcome) {
      case 'promoted':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'promote', ordinal, kaId: kaId.toString(), ual,
        });
        return { status: 'reconciled', blockNumber: versionBlock };
      case 'already-confirmed':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'already', ordinal, kaId: kaId.toString(), ual,
        });
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return { status: 'already', blockNumber: versionBlock };
      case 'stale-target':
        this.clearVmReconcileRotationStateForSlot(localCgId, onChainCgId, ordinal);
        // A newer root won; do not prune its cache/recent state.
        this.recentReconciledUals.add(cacheKey);
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'already', ordinal, kaId: kaId.toString(), ual,
        });
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return { status: 'already', blockNumber: versionBlock };
      case 'no-swm':
        if (activeFetchRan && !activeFetchHadUsableResponse) {
          this.vmReconcileFetchCooldownAt.delete(localCgId);
        } else {
          this.recordVmReconcileNegativeCache(
            cacheKey,
            localCgId,
            swmState ?? await this.collectVmReconcileSwmCandidateState(localCgId),
          );
        }
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'defer', ordinal, kaId: kaId.toString(), ual, detail: activeFetchRan && !activeFetchHadUsableResponse ? 'network-unavailable' : outcome,
        });
        return { status: 'pending' };
      case 'receipt-revalidation-pending':
      case 'unverified':
      default:
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'defer', ordinal, kaId: kaId.toString(), ual, detail: outcome,
        });
        return { status: 'pending' };
    }
  }

  /**
   * OT-RFC-39 — build the per-tick auto-backfill closure handed to the
   * Random Sampling prover via {@link bindRandomSampling}. The closure
   * is invoked when `extractCiphertextChunksFromStore` reports
   * `CiphertextChunksMissingError`; it pulls the missing chunks from
   * authorized peers and persists them so the prover's one-shot retry
   * can build the proof.
   *
   * Peer discovery uses the same source the publish path uses:
   * `gossip.getSubscribers(contextGraphWorkspaceTopic(wireId))`. Every
   * authorized hosting core subscribes to that topic to receive the
   * chunked-publish gossip, so the subscriber snapshot is the natural
   * "who can answer me right now" set. Falls back to "no peers" when
   * the local cleartext CG id is unknown (chain replay hasn't caught
   * up yet) — the prover then logs `kc-not-synced` and re-ticks in
   * 30s, by which time the chain handler has populated
   * `subscribedContextGraphs`.
   *
   * Authorization happens on the RESPONDER side
   * (`handleGetCiphertextChunk`): every peer the requester contacts
   * verifies the request's recovered EOA against the on-chain
   * participant set / beacon curator / agent-gate / allowedPeers.
   * Requesters that aren't in any authority set get a `denied` ACK
   * and we skip to the next peer.
   *
   * Cap policy: one fetch per missing chunk per peer; iterate peers
   * until a chunk lands or we exhaust the list. No retries inside the
   * hook — the prover's outer 30s loop is the natural retry boundary.
   */
  buildCiphertextChunkBackfill(this: DKGAgent,
    ctx: OperationContext,
  ): (req: { cgId: bigint; batchId: Uint8Array; missingIndexes: number[] }) => Promise<{ fetched: number; failures: number; reason?: string }> {
    return async ({ cgId, batchId, missingIndexes }) => {
      if (missingIndexes.length === 0) return { fetched: 0, failures: 0 };

      const localCgId = this.resolveLocalCgIdByOnChainId(cgId);
      if (!localCgId) {
        return {
          fetched: 0,
          failures: missingIndexes.length,
          reason: 'cg-not-locally-registered',
        };
      }

      const wireId = this.gossipWireIdFor(localCgId);
      const workspaceTopic = contextGraphWorkspaceTopic(wireId);
      let selfPeer: string | null = null;
      try { selfPeer = this.peerId; } catch { /* pre-start */ }
      const allSubscribers = this.gossip.getSubscribers(workspaceTopic);
      const candidatePeers = Array.from(new Set(
        allSubscribers.filter((p) => p && p !== selfPeer),
      ));

      if (candidatePeers.length === 0) {
        return {
          fetched: 0,
          failures: missingIndexes.length,
          reason: 'no-peers',
        };
      }

      const batchIdHex = ethers.hexlify(batchId).slice(0, 18);
      this.log.info(
        ctx,
        `LU-11 backfill start cg=${localCgId} batchId=${batchIdHex}... missing=${missingIndexes.length} peers=${candidatePeers.length}`,
      );

      let fetched = 0;
      let failures = 0;
      let lastDenied: string | undefined;
      for (const idx of missingIndexes) {
        let got = false;
        for (const peer of candidatePeers) {
          try {
            const resp = await this.fetchCiphertextChunkFromPeer(peer, localCgId, batchId, idx, {
              persist: true,
            });
            if (resp.denied) {
              lastDenied = resp.denied;
              continue;
            }
            if (resp.ciphertextB64) {
              got = true;
              break;
            }
          } catch (err) {
            this.log.debug(
              ctx,
              `LU-11 backfill peer=${peer} chunk=${idx} cg=${localCgId} error: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
            );
          }
        }
        if (got) fetched++;
        else failures++;
      }

      this.log.info(
        ctx,
        `LU-11 backfill done cg=${localCgId} batchId=${batchIdHex}... fetched=${fetched} failures=${failures}${lastDenied ? ` lastDenied=${lastDenied}` : ''}`,
      );
      return {
        fetched,
        failures,
        ...(failures > 0 && fetched === 0 && lastDenied ? { reason: `all-denied: ${lastDenied}` } : {}),
        ...(failures > 0 && fetched === 0 && !lastDenied ? { reason: 'no-responders' } : {}),
      };
    };
  }

  /**
   * OT-RFC-38 LU-6 B1 — authorize a signed `swm-host-catchup` request.
   *
   * Layered checks (deny-by-default):
   *   1. Signature recovery + freshness (issuedAtMs within window).
   *   2. Replay-nonce uniqueness (per-responder LRU).
   *   3. Chain-anchored: `requesterEoa ∈ participantAgents` for the CG.
   *      Definitive when chain context is available — the on-chain
   *      participant set IS the curated access policy.
   *   4. Pre-registration fallback: `requesterEoa == beaconCurator`.
   *      Curators can always catch up themselves before paying gas to
   *      register, mirroring `ingestSwmHostModeEnvelope`.
   *   5. Member-side allowlist fallback: when the local node has
   *      explicit peer-allowlist meta (member CG context, not host-only
   *      core), require `fromPeerId ∈ allowedPeers`. Defence in depth
   *      against a signed-but-out-of-band requester.
   *   6. Ciphertext-only fallback: registered node-operator EOAs may
   *      fetch opaque host-mode envelopes, matching LU-11 chunk catchup.
   *   7. Otherwise: DENY. The previous behaviour ("serve openly when
   *      no authority source available") was the metadata-leak vector
   *      Codex flagged on PR #610 round-2 #6.
   *
   * Returns `{ ok: true, recoveredSigner }` on accept or
   * `{ ok: false, reason }` with a wire-suitable string.
   */
  async authorizeSwmHostCatchupRequest(this: DKGAgent,
    req: ReturnType<typeof decodeSwmHostCatchupRequest>,
    fromPeerId: string,
    nowMs: number,
  ): Promise<{ ok: true; recoveredSigner: string } | { ok: false; reason: string }> {
    // 1. signature + freshness. `verifySignedCatchupRequest` re-runs
    //    `computeCatchupRequestDigest` over the same numerical fields
    //    the client signed; pass defined defaults for the optional
    //    `maxEntries`/`maxBytes` so the encoded uint256 layout matches.
    const verify = verifySignedCatchupRequest(
      {
        version: req.version,
        contextGraphId: req.contextGraphId,
        sinceSeqno: req.sinceSeqno,
        maxEntries: req.maxEntries ?? 0,
        maxBytes: req.maxBytes ?? 0,
        requesterEoa: req.requesterEoa,
        issuedAtMs: req.issuedAtMs,
        nonce: req.nonce,
        sig: req.sig,
      },
      nowMs,
    );
    if (!verify.ok || !verify.recoveredSigner) {
      return { ok: false, reason: verify.reason ?? 'signature verification failed' };
    }
    const requesterEoa = verify.recoveredSigner;

    // 2. replay-defence
    if (!this.catchupReplayGuard.recordIfFresh(requesterEoa, req.nonce, req.issuedAtMs, nowMs)) {
      return { ok: false, reason: 'replayed catchup nonce' };
    }

    // The authority sources below use UNION semantics: any source
    // that recognises the requester EOA (or, as transport-layer
    // fallback, the peer-id) is sufficient to accept. Codex PR #618
    // R2 caught a fail-closed bug in the prior implementation where
    // `chainParticipants` was treated as authoritative — if the
    // chain returned a set that didn't include a legitimate
    // delegatee or allowed-agent, we'd hard-deny without checking
    // the locally-persisted allowlist. The current logic accepts
    // on the first match across:
    //   3a. on-chain participant agents
    //   3b. beacon-pinned curator (pre-registration)
    //   3c. locally-persisted agent-gate set (allowedAgent UNION
    //       participantAgent from _meta + subscription cache)
    //   3d. transport-layer allowedPeers (libp2p peer-id allowlist)
    //   3e. registered node-operator EOA for ciphertext-only host catchup
    // Only if none accept do we deny.
    const requesterLower = requesterEoa.toLowerCase();
    let anyAuthoritySourceFound = false;

    try {
      const chainParticipants = await this.resolveOnChainParticipantAgents(req.contextGraphId);
      if (chainParticipants !== null) {
        anyAuthoritySourceFound = true;
        if (chainParticipants.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Adapter probe failure is non-fatal; fall through to other sources.
    }

    try {
      const beaconCurator = await this.resolveBeaconPinnedCuratorEoa(req.contextGraphId);
      if (beaconCurator) {
        anyAuthoritySourceFound = true;
        if (beaconCurator.toLowerCase() === requesterLower) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Beacon cache miss is non-fatal.
    }

    // Locally-persisted agent gate: `getContextGraphAgentGateAddresses`
    // unions `dkg:allowedAgent` + `dkg:participantAgent` from the CG's
    // `_meta` graph and the in-memory subscription cache. On a member-
    // side host this is the canonical allowlist + delegatee set;
    // chain-derived sets often miss recently-approved delegatees that
    // haven't been mirrored on chain yet.
    try {
      const agentGate = await this.getContextGraphAgentGateAddresses(req.contextGraphId);
      if (agentGate !== null) {
        anyAuthoritySourceFound = true;
        if (agentGate.some((a) => a.toLowerCase() === requesterLower)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // Local-meta probe failure is non-fatal.
    }

    // Transport-layer ACL (libp2p peer-id allowlist). Only meaningful
    // on nodes that have persisted the CG's `allowedPeers`; host-only
    // cores never see it.
    try {
      const allowedPeers = await this.getContextGraphAllowedPeers(req.contextGraphId);
      if (allowedPeers !== null) {
        anyAuthoritySourceFound = true;
        if (allowedPeers.includes(fromPeerId)) {
          return { ok: true, recoveredSigner: requesterEoa };
        }
      }
    } catch {
      // local-meta probe failure is non-fatal; the deny below still applies.
    }

    // Ciphertext host-catchup parity with LU-11 chunk-catchup: the responder
    // serves opaque SWM envelopes, not decrypted triples. A requester that can
    // prove control of a registered node-operator EOA is allowed to fetch these
    // bytes so host-only cores and member daemons whose operational wallet is
    // distinct from their DKG agent address can recover missed ciphertext.
    if (typeof this.chain.getIdentityIdForAddress === 'function') {
      try {
        const reqIdentityId = await this.chain.getIdentityIdForAddress(requesterEoa);
        if (reqIdentityId > 0n) {
          anyAuthoritySourceFound = true;
          this.log.debug(
            createOperationContext('share'),
            `host-catchup admitted via node-operator authority cg=${req.contextGraphId} requesterEoa=${requesterEoa} identityId=${reqIdentityId.toString()}`,
          );
          return { ok: true, recoveredSigner: requesterEoa };
        }
      } catch (err) {
        this.log.debug(
          createOperationContext('share'),
          `host-catchup node-operator probe failed cg=${req.contextGraphId} requesterEoa=${requesterEoa}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const reason = anyAuthoritySourceFound
      ? 'requester EOA not in any of: on-chain participants, beacon curator, local agent-gate, allowedPeers, node-operator-registry'
      : 'no authority source available for context graph';
    return { ok: false, reason };
  }

  /**
   * Member-side helper: fetches opaque ciphertext envelopes for
   * `contextGraphId` from a single remote peer (typically a core
   * that has been observed as a host) and re-feeds each through
   * the local `SharedMemoryHandler.handle()` so the existing
   * Sender-Key decrypt-and-apply path runs verbatim. Returns the
   * counters from the apply loop.
   *
   * Iterates pages internally — when the responder marks the
   * response `truncated`, the helper resends with `sinceSeqno`
   * updated to `nextSeqno` until either the response comes back
   * non-truncated or `maxRounds` is reached.
   */
  async catchupSwmFromHost(this: DKGAgent,
    remotePeerId: string,
    contextGraphId: string,
    options?: { sinceSeqno?: number; maxRounds?: number; maxEntriesPerRound?: number },
  ): Promise<{
    rounds: number;
    fetched: number;
    /**
     * Number of envelopes whose apply path returned `applied: true`.
     * NOT the same as triples — one envelope can carry many quads.
     * For triples-applied accounting, callers MUST sum
     * {@link appliedTriples}. Codex PR #610 R2 caught the previous
     * conflation where `memory.ts` aggregated this count into a
     * field named `totalInsertedTriples`.
     */
    applied: number;
    /**
     * Total triples (N-Quads) inserted by successful replays.
     * Summed from `SharedMemoryApplyOutcome.insertedTriples`.
     */
    appliedTriples: number;
    skipped: number;
    nextSeqno: number;
    denied?: string;
  }> {
    const ctx = createOperationContext('share');
    let sinceSeqno = options?.sinceSeqno ?? 0;
    const maxRounds = Math.max(1, options?.maxRounds ?? 8);
    const maxEntries = options?.maxEntriesPerRound ?? SWM_HOST_CATCHUP_DEFAULT_MAX_ENTRIES;
    const maxBytes = SWM_HOST_CATCHUP_DEFAULT_MAX_BYTES;
    // OT-RFC-38 LU-6 B1 — every catchup request is signed by the
    // requesting participant key so the host can authenticate via
    // on-chain / agent-gated membership without trusting the libp2p
    // peer-id.
    //
    // Codex PR #618 R2: we deliberately do NOT pre-compute the
    // requester EOA from `getRegistrationTxSignerAddress()`. The
    // chain adapter's tx-signer can differ from its message-signer
    // (per the helper's own doc-comment), and workspace-agent
    // deployments can sign with a local custodial agent key instead.
    // `mintSignedCatchupRequest` recovers the actual signer from
    // the signature itself and binds the digest to it — no caller-
    // side lookup needed.
    const workspaceCatchupSigner = await this.getWorkspaceCatchupSigner(contextGraphId);
    if (!workspaceCatchupSigner && typeof this.chain.signMessage !== 'function') {
      const reason = 'chain adapter does not implement signMessage — cannot mint signed catchup request';
      this.log.warn(ctx, `host-catchup ${reason} to=${remotePeerId} cg=${contextGraphId}`);
      return { rounds: 0, fetched: 0, applied: 0, appliedTriples: 0, skipped: 0, nextSeqno: sinceSeqno, denied: reason };
    }
    let rounds = 0;
    let fetched = 0;
    let applied = 0;
    let appliedTriples = 0;
    let skipped = 0;
    let lastDenied: string | undefined;
    while (rounds < maxRounds) {
      rounds += 1;
      const signedReq = await mintSignedCatchupRequest({
        contextGraphId,
        sinceSeqno,
        maxEntries,
        maxBytes,
        // requesterEoa intentionally omitted — the helper recovers
        // the signer from the signature itself, which is the only
        // way to guarantee the digest binds to the actual signing
        // key (the chain adapter's tx-signer and message-signer can
        // differ). See `MintSignedCatchupRequestInput.requesterEoa`
        // doc comment for the full rationale.
        sign: async (digest) => {
          if (workspaceCatchupSigner) {
            return new ethers.Wallet(workspaceCatchupSigner.privateKey).signMessage(digest);
          }
          const { r, vs } = await this.chain.signMessage!(digest);
          const sig = ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) });
          return sig.serialized;
        },
      });
      const reqBytes = encodeSwmHostCatchupRequest({
        version: SWM_HOST_CATCHUP_WIRE_VERSION,
        contextGraphId,
        sinceSeqno,
        maxEntries,
        maxBytes,
        requesterEoa: signedReq.requesterEoa,
        issuedAtMs: signedReq.issuedAtMs,
        nonce: signedReq.nonce,
        sig: signedReq.sig,
      });
      let sendResult;
      try {
        sendResult = await this.messenger.sendReliable(remotePeerId, PROTOCOL_SWM_HOST_CATCHUP, reqBytes);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `host-catchup call failed to=${remotePeerId} cg=${contextGraphId}: ${reason}`);
        break;
      }
      if (!sendResult.delivered) {
        // `queued: true` means the substrate is retrying in the
        // background; we don't get the response on this call. Treat
        // it as a transport failure for this round so the caller can
        // try another peer.
        const reason = 'error' in sendResult ? sendResult.error : 'undelivered';
        this.log.info(ctx, `host-catchup undelivered to=${remotePeerId} cg=${contextGraphId}: ${reason}`);
        break;
      }
      const resp = decodeSwmHostCatchupResponse(sendResult.response);
      // Codex PR #610 R3: cross-CG safety. The wire response
      // echoes the contextGraphId; a buggy or hostile host
      // could return valid envelopes for a DIFFERENT CG. We
      // hand the bytes to `SharedMemoryHandler.handle()` with
      // `trustedReplay: true`, which bypasses transport
      // identity checks — without this guard the inner
      // payload would apply to whichever CG the envelope was
      // bound to, NOT the CG we asked for. Reject the entire
      // response before replaying anything from it.
      if (resp.contextGraphId !== contextGraphId) {
        const reason = `cgId mismatch in host response: requested="${contextGraphId}" got="${resp.contextGraphId}"`;
        this.log.warn(ctx, `host-catchup ${reason} from=${remotePeerId}`);
        lastDenied = reason;
        break;
      }
      if (resp.denied) {
        lastDenied = resp.denied;
        this.log.info(ctx, `host-catchup denied by=${remotePeerId} cg=${contextGraphId}: ${resp.denied}`);
        break;
      }
      if (resp.entries.length === 0) {
        break;
      }
      const handler = this.getOrCreateSharedMemoryHandler();
      for (const entry of resp.entries) {
        fetched += 1;
        const envelope = Buffer.from(entry.envelopeB64, 'base64');
        try {
          const outcome = await handler.handle(
            new Uint8Array(envelope),
            remotePeerId,
            undefined,
            { trustedReplay: true },
          );
          if (outcome.applied) {
            applied += 1;
            // Triples per envelope is variable; track it separately
            // from the envelope count so callers reporting a
            // triples total don't undercount. Codex PR #610 R2.
            appliedTriples += outcome.insertedTriples ?? 0;
          } else {
            skipped += 1;
            const reason = 'reason' in outcome ? outcome.reason : 'unknown';
            this.log.debug(
              ctx,
              `host-catchup envelope skipped cg=${contextGraphId} seqno=${entry.seqno}: ${reason}`,
            );
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.log.warn(ctx, `host-catchup apply failed cg=${contextGraphId} seqno=${entry.seqno}: ${reason}`);
          skipped += 1;
        }
      }
      sinceSeqno = resp.nextSeqno;
      if (!resp.truncated) break;
    }
    return { rounds, fetched, applied, appliedTriples, skipped, nextSeqno: sinceSeqno, ...(lastDenied ? { denied: lastDenied } : {}) };
  }

  /**
   * Member-side helper: fans out `catchupSwmFromHost` across all
   * currently-connected peers. Used as a fallback when standard
   * catchup (sync from CG members) returns 0 — typical of the
   * scenario where every CG member is simultaneously offline and
   * only cores still hold the substrate. Returns the per-peer
   * outcomes.
   */
  async catchupSwmFromConnectedHosts(this: DKGAgent,
    contextGraphId: string,
    options?: { sinceSeqno?: number; maxRounds?: number; maxEntriesPerRound?: number; peers?: string[] },
  ): Promise<Array<{
    peerId: string;
    rounds: number;
    fetched: number;
    applied: number;
    appliedTriples: number;
    skipped: number;
    nextSeqno: number;
    denied?: string;
    error?: string;
  }>> {
    const ctx = createOperationContext('share');
    const explicitPeers = options?.peers;
    const rawCandidates: string[] = (() => {
      if (explicitPeers && explicitPeers.length > 0) return [...new Set(explicitPeers)];
      const connections = this.node.libp2p.getConnections();
      const seen = new Set<string>();
      for (const c of connections) {
        const id = c.remotePeer.toString();
        if (id !== this.peerId) seen.add(id);
      }
      return [...seen];
    })();
    // Contact reliable Core hosts first. This serial loop still reaches
    // every candidate, but Cores first means faster time-to-first-data
    // and a better resume-seqno baseline before any flaky edge is tried.
    const candidates = orderCatchupPeers(rawCandidates, undefined, false, this.knownCorePeerIds)
      .map((p) => p.toString());
    const coreCount = candidates.filter((id) => this.knownCorePeerIds.has(id)).length;
    this.log.info(
      ctx,
      `host-catchup peer order for "${contextGraphId}": cores=${coreCount} total=${candidates.length}`,
    );
    const results: Array<{
      peerId: string;
      rounds: number;
      fetched: number;
      applied: number;
      appliedTriples: number;
      skipped: number;
      nextSeqno: number;
      denied?: string;
      error?: string;
    }> = [];
    for (const peerId of candidates) {
      try {
        // Codex PR #610 round-2 #2: resume from the highest seqno we
        // previously consumed from this (cgId, peerId), not from 0.
        // Pre-fix, every fallback catchup re-downloaded the entire
        // host log even when the member was already up-to-date,
        // inflating `totalInsertedTriples` (counting redundant
        // applies) and burning bandwidth on a steady-state member
        // that just happened to ask. Explicit `options.sinceSeqno`
        // still wins so operators / callers can force a re-scan.
        const resumeSeqno =
          options?.sinceSeqno !== undefined
            ? options.sinceSeqno
            : this.lastHostCatchupSeqno.get(contextGraphId)?.get(peerId) ?? 0;
        const r = await this.catchupSwmFromHost(peerId, contextGraphId, {
          sinceSeqno: resumeSeqno,
          maxRounds: options?.maxRounds,
          maxEntriesPerRound: options?.maxEntriesPerRound,
        });
        if (r.nextSeqno > 0) {
          let perPeer = this.lastHostCatchupSeqno.get(contextGraphId);
          if (!perPeer) {
            perPeer = new Map();
            this.lastHostCatchupSeqno.set(contextGraphId, perPeer);
          }
          perPeer.set(peerId, r.nextSeqno);
        }
        results.push({ peerId, ...r });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `host-catchup peer=${peerId} cg=${contextGraphId} failed: ${reason}`);
        results.push({ peerId, rounds: 0, fetched: 0, applied: 0, appliedTriples: 0, skipped: 0, nextSeqno: options?.sinceSeqno ?? 0, error: reason });
      }
    }
    return results;
  }

  /** Diagnostics surface for the host-mode store (or `null` when not initialized). */
  async getSwmHostModeStats(this: DKGAgent): Promise<{
    enabled: boolean;
    cgCount: number;
    totalBytes: number;
    totalEntries: number;
    subscribedCgIds: string[];
  } | null> {
    if (!this.swmHostModeStore) {
      return { enabled: false, cgCount: 0, totalBytes: 0, totalEntries: 0, subscribedCgIds: [] };
    }
    const stats = await this.swmHostModeStore.stats();
    return { enabled: true, ...stats, subscribedCgIds: [...this.swmHostModeSubscribed.keys()] };
  }

  /**
   * PR5 — ACK-provenance lookup for the StorageACK handler. Returns
   * which of the four LU-6 Phase B discovery paths caused this node
   * to be hosting the CG identified by ANY of the passed candidate
   * ids at the time of the call. `'member'` when the CG is in
   * member-mode (decrypt+apply handler is authoritative), the
   * recorded host-mode source when it's in host-mode, or `undefined`
   * when neither — the latter means the core has no live subscription
   * for the CG, which should never happen on a successful ACK code
   * path but is plumbed through defensively so a future race doesn't
   * crash the ACK encoder.
   *
   * Takes multiple candidate ids because the two consulted maps are
   * keyed differently: `sharedMemoryGossipRegistered` (member-mode)
   * uses the CALLER-supplied cleartext id verbatim, while
   * `swmHostModeSubscribed` (host-mode) is canonical-keyed by the
   * wire-form hash via {@link canonicalSwmHostModeKey}. The
   * StorageACK handler has the numeric on-chain `cgId`, the
   * cleartext `swmGraphId`, and may have pre-computed the wire hash;
   * passing the full set lets us hit member-mode on any cleartext
   * shape AND host-mode on any candidate after canonicalisation. The
   * `seen` set dedupes both raw and canonical forms so the per-call
   * cost stays O(distinct shapes).
   *
   * Public so `StorageACKHandlerConfig.getSubscriptionSourceForCg`
   * can bind directly to it at agent wire-up time (in `lifecycle.ts`).
   */
  getSwmSubscriptionSource(this: DKGAgent, ...candidateIds: Array<string | undefined>): SubscriptionSource | undefined {
    const seen = new Set<string>();
    for (const id of candidateIds) {
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.sharedMemoryGossipRegistered.has(id)) {
        return SUBSCRIPTION_SOURCES.MEMBER;
      }
      // Host-mode bookkeeping is canonical-keyed (Codex PR #672
      // review `id=3302086589`); resolve every candidate through
      // `canonicalSwmHostModeKey` before lookup so any of the
      // numeric / cleartext / hash shapes hits the same entry.
      const canonical = this.canonicalSwmHostModeKey(id);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        const hostSource = this.swmHostModeSubscribed.get(canonical);
        if (hostSource) return hostSource;
      }
    }
    return undefined;
  }

  /**
   * OT-RFC-38 LU-6 — operator-driven host-mode subscribe.
   *
   * Forcibly enables host-mode subscription for `contextGraphId`
   * even when the local store has no CG metadata yet. Designed for
   * Phase A where sharding-table auto-discovery is approximated by
   * an explicit operator designation per core. Idempotent.
   *
   * Returns `{ subscribed, alreadySubscribed, hostingEnabled, memberMode }`:
   *  - `subscribed`: true if the call actually wired the topic listener
   *    on this invocation (false on re-entry when already subscribed).
   *  - `alreadySubscribed`: mirror of `subscribed === false`.
   *  - `hostingEnabled`: whether the host-mode store is initialized
   *    on this node (false on edges or when explicitly disabled).
   *  - `memberMode`: true if this CG is already in member-mode on
   *    this node — host-mode subscription is refused because the
   *    two would race / duplicate every apply (Codex PR #610 R4).
   */
  async enableSwmHostModeFor(this: DKGAgent, contextGraphId: string): Promise<{
    subscribed: boolean;
    alreadySubscribed: boolean;
    hostingEnabled: boolean;
    memberMode?: boolean;
  }> {
    if (!this.swmHostModeStore) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: false };
    }
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    // Codex PR #610 R4: refuse host-mode subscribe when the same
    // CG is already in member-mode on this node. Wiring both
    // handlers would cause every gossip message to be (a)
    // decrypted-and-applied via the member handler AND (b)
    // opaquely appended via the host handler. The reconciler
    // path already refuses this; the operator-driven entrypoint
    // must do the same to keep the invariant globally true.
    if (this.sharedMemoryGossipRegistered.has(contextGraphId)) {
      this.log.info(
        createOperationContext('system'),
        `SWM host-mode subscribe refused for "${contextGraphId}": local node is already a CG member (member-mode handler is authoritative)`,
      );
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true, memberMode: true };
    }
    const hostKey = this.canonicalSwmHostModeKey(contextGraphId);
    const curated = await this.isCuratedForHostMode(contextGraphId);
    if (this.swmHostModeSubscribed.has(hostKey)) {
      // Idempotent re-entry: even when the subscription is already
      // active, re-probe registration state. This handles the
      // legitimate "CG was unregistered when first subscribed,
      // operator later registered it on-chain, operator re-calls
      // /host-mode/subscribe" flow without forcing a daemon restart.
      //
      // The `has()` check goes through `canonicalSwmHostModeKey` so
      // a manual subscribe with the cleartext id finds an entry the
      // chain-event/beacon path wrote with the wire-hash form (and
      // vice versa). Codex PR #672 review `id=3302086589` — without
      // this canonicalisation the second subscribe would wire a
      // duplicate gossip handler on the same topic and double every
      // host-mode ingest/persistence.
      // Never downgrade a positive classification on a transient policy-read
      // failure. A false -> true transition closes both dispatch branches.
      this.swmHostModeCurated.set(
        hostKey,
        this.swmHostModeCurated.get(hostKey) === true || curated,
      );
      await this.maybeMarkRegisteredForHostMode(contextGraphId);
      return { subscribed: false, alreadySubscribed: true, hostingEnabled: true };
    }
    // OT-RFC-49 WS-A — CLOSE the operator hatch. With the private-ciphertext
    // strip ON (default), the operator override must NOT re-introduce private
    // custody for a CURATED CG: WS-A diverges from rung-1 (which deliberately
    // left this manual path open) precisely here — there is no supported way
    // back into private host-mode for a curated CG while the strip is on.
    // Scoped to curated CGs via the SAME three-source probe the auto-host
    // path uses ({@link isCuratedForHostMode}), NOT `isPrivateContextGraph`
    // alone — a host-only core has no local `_meta`, so an
    // `isPrivateContextGraph`-only check would return false and leave the
    // hatch open for exactly the case WS-A closes. PUBLIC / bare-uncurated CGs
    // are never affected (all three sources return not-curated → hatch stays
    // open).
    if (this.swmHostModeStripCiphertext() && curated) {
      this.log.info(
        createOperationContext('system'),
        `SWM host-mode subscribe REFUSED for "${contextGraphId}": private-ciphertext strip is ON ` +
        `(OT-RFC-49 WS-A — the operator override is closed for curated CGs; cores custody zero private SWM ciphertext)`,
      );
      return { subscribed: false, alreadySubscribed: false, hostingEnabled: true };
    }
    this.wireSwmHostModeHandler(contextGraphId, SUBSCRIPTION_SOURCES.MANUAL, curated);
    await this.awaitHostModePersistence(contextGraphId);
    // Codex PR #610 R1 comment 5: a core that only knows the CG by
    // topic id (the explicit /host-mode/subscribe entrypoint) must
    // still transition the store to the registered-CG limits as
    // soon as the on-chain record exists. Without this probe the
    // store would stay on the 6h/1MiB pre-registration defaults
    // forever and prune ciphertext from registered CGs much
    // earlier than intended.
    await this.maybeMarkRegisteredForHostMode(contextGraphId);
    this.log.info(
      createOperationContext('system'),
      `SWM host-mode subscription explicitly enabled for "${contextGraphId}" via API (role=${this.config.nodeRole ?? 'edge'})`,
    );
    return { subscribed: true, alreadySubscribed: false, hostingEnabled: true };
  }

  /**
   * Probe on-chain registration and flip the host-mode store's
   * per-CG cursor to the registered-CG limits when the CG is
   * already known to the contracts. Safe to call repeatedly and on
   * unregistered CGs — both branches early-return without touching
   * the store.
   */
  async maybeMarkRegisteredForHostMode(this: DKGAgent, contextGraphId: string): Promise<void> {
    if (!this.swmHostModeStore) return;
    try {
      // OT-RFC-38 / LU-6 Phase B — three-way registration probe.
      //
      //   1. Legacy: ask the chain adapter directly (if it exposes
      //      `getContextGraphOnChain(cleartextId)`). The default
      //      adapter doesn't, so this returns false on most setups.
      //
      //   2. Host-only-core path: the chain-event handler populated
      //      `subscribedContextGraphs.get(wireIdHash).onChainId` when
      //      it observed `ContextGraphCreated(nameHash, ...)`. If the
      //      cleartext hash hits an entry with `onChainId`, the CG IS
      //      registered.
      //
      //   3. Member-side path: a node that created the CG locally and
      //      then registered keeps `subscribedContextGraphs.get(cleartext)
      //      .onChainId` populated. This is the cleartext-keyed
      //      shortcut.
      //
      // Any positive probe flips the store flag so the registered
      // per-CG byte cap (64MB) replaces the pre-reg cap (1MB) and
      // the pre-reg rate-limit short-circuits in
      // `ingestSwmHostModeEnvelope` (registered CGs are gated by
      // chain economics, not the freemium-tier window).
      let registered = await this.isContextGraphRegisteredOnChain(contextGraphId);
      if (!registered) {
        const directSub = this.subscribedContextGraphs.get(contextGraphId);
        if (directSub?.onChainId) registered = true;
      }
      if (!registered) {
        try {
          const wireId = this.gossipWireIdFor(contextGraphId);
          const wireSub = this.subscribedContextGraphs.get(wireId);
          if (wireSub?.onChainId) registered = true;
        } catch { /* malformed cleartext — fall through */ }
      }
      if (registered) await this.swmHostModeStore.markRegistered(contextGraphId);
    } catch { /* best-effort; pre-registration defaults stay in place */ }
  }

}
