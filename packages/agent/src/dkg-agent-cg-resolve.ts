// SPDX-License-Identifier: Apache-2.0

/**
 * Context-graph resolution subsystem extracted from dkg-agent.ts as a mixin
 * holder: existence/curation checks, sync-request envelope parse/build/auth,
 * on-chain participant + curator resolution, wire-id <-> local-id mapping,
 * access-policy resolution, private-CG participant listing, and the
 * listContextGraphs enumeration. 1:1 move; methods take `this: DKGAgent` so
 * cross-calls resolve against the composed class.
 */

import { createHash } from 'node:crypto';
import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  LibP2PNetwork, PeerResolver, StubNetworkStateRegistry,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_GET_CIPHERTEXT_CHUNK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  PROTOCOL_SWM_SENDER_KEY, PROTOCOL_SWM_UPDATE, PROTOCOL_SWM_SHARE_ACK, PROTOCOL_SWM_HOST_CATCHUP, PROTOCOL_MESSAGE,
  contextGraphPublishTopic, contextGraphWorkspaceTopic, contextGraphAppTopic, contextGraphUpdateTopic, contextGraphFinalizationTopic,
  contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri, contextGraphVerifiableMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri, contextGraphCatalogUri,
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
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral,
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
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import {
  normalizeExactAssetUals,
  requireExactAssetUals,
} from './sync/exact-assets.js';
import {
  decodePipeSyncRequestTail,
  normalizeByteBudgetPageHint,
} from './sync/auth/pipe-request-tail.js';
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
type ListContextGraphsRow = {
  id: string;
  uri: string;
  name: string;
  description?: string;
  creator?: string;
  curator?: string;
  accessPolicy?: string;
  createdAt?: string;
  isSystem: boolean;
  subscribed: boolean;
  synced: boolean;
  onChainId?: string;
  callerInvolved?: boolean;
};
type ListContextGraphsUncachedResult = {
  rows: ListContextGraphsRow[];
  cacheable: boolean;
};
type ListContextGraphsPrivacy = 'public' | 'private' | 'unknown';
class ListContextGraphsBudgetExceeded extends Error {
  constructor(label: string) {
    super(`${label} exceeded listContextGraphs budget`);
    this.name = 'ListContextGraphsBudgetExceeded';
  }
}
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
  type ContextGraphWritePreflightProbe,
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
import type { ContextGraphMetaRecord } from './context-graph-meta-projection.js';
import type { DKGAgent } from './dkg-agent.js';
import { mapWithConcurrency } from './map-with-concurrency.js';
import {
  runCuratorMetaRefresh,
  type CuratorMetaRefreshOptions,
} from './curator-meta-refresh.js';

function syncAuthAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfSyncAuthAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw syncAuthAbortError(signal.reason);
}

type InternalContextGraphListRow = ListContextGraphsRow & {
  policyKnown?: boolean;
};

function mapContextGraphListRows<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return mapWithConcurrency(
    items,
    DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_CONCURRENCY,
    fn,
  );
}

async function mapContextGraphListRowsSettled<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapContextGraphListRows(items, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await fn(item, index) } as const;
    } catch (reason) {
      return { status: 'rejected', reason } as const;
    }
  });
}

function listContextGraphsProjectionEnabled(): boolean {
  // Before enabling this default-on: thread the caller signal into getCgMeta
  // and wrap per-row reads in withBudget (per A1's LIST_CONTEXT_GRAPHS_*_BUDGET_MS);
  // this projection path currently lacks the per-read budgets/abort-signal the
  // legacy path has. (Track C security review.)
  const raw = process.env.DKG_LIST_CONTEXT_GRAPHS_PROJECTION?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function contextGraphListRowPrivacy(accessPolicy?: string): ListContextGraphsPrivacy {
  if (!accessPolicy?.trim()) return 'unknown';
  const t = accessPolicy.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (t === 'private' || t === 'public') return t;
  return 'unknown';
}

function isPrivateContextGraphListRow(accessPolicy?: string): boolean {
  return contextGraphListRowPrivacy(accessPolicy) === 'private';
}

async function applyContextGraphListPrivacy(
  agent: DKGAgent,
  rows: InternalContextGraphListRow[],
  opts?: { callerAgentAddress?: string | null },
): Promise<ListContextGraphsRow[]> {
  const scopedList = opts !== undefined;
  const visibleRows = scopedList ? rows.filter((r) => r.policyKnown !== false) : rows;
  let checksum: string | null = null;
  const rawCaller = opts?.callerAgentAddress?.trim();
  if (rawCaller && ethers.isAddress(rawCaller)) {
    try {
      checksum = ethers.getAddress(rawCaller);
    } catch {
      checksum = null;
    }
  }

  if (!checksum) {
    return visibleRows
      .filter((r) => {
        const privacy = contextGraphListRowPrivacy(r.accessPolicy);
        if (privacy === 'private') return false;
        if (privacy === 'unknown') return !scopedList;
        return true;
      })
      .map(({ policyKnown: _policyKnown, ...row }) => row);
  }

  const annotated = await mapContextGraphListRows(visibleRows, async (r) => {
    const curatorMatch = agent.curatorDidMatchesChecksumAgent(r.curator, checksum);
    const allowlisted = await agent.callerIsAllowlistedAgentParticipant(r.id, checksum);
    return { ...r, callerInvolved: curatorMatch || allowlisted };
  });

  return annotated
    .filter((r) => {
      if (r.callerInvolved === true) return true;
      return contextGraphListRowPrivacy(r.accessPolicy) === 'public';
    })
    .map(({ policyKnown: _policyKnown, ...row }) => row);
}

/** Where a resolved catch-up sync peer came from; see {@link resolveCuratorSyncPeer}. */
export interface SyncPeerResolution {
  peerId?: string;
  /**
   * Only `'metadata'` is AUTHORITATIVE — see {@link authoritativeSyncPeerId}.
   * Everything else ranks the walk and may never end it.
   *
   * - `'metadata'`   — the Context Graph's OWN `<cg>/_meta` declares the
   *                    curator→peer binding, and that binding is internally
   *                    consistent.
   * - `'projection'` — the binding came from the merged metadata projection,
   *                    which unions `_meta` with AGENTS / `_catalog` / ONTOLOGY
   *                    and discards which graph supplied each fact. Good enough
   *                    to rank; not a statement the graph made about itself.
   * - `'registry'`   — a wallet-address curator resolved through the agent
   *                    registry, which is queried STRICTLY LOCALLY, so even a
   *                    single local match is not proof of a network-wide binding.
   * - `'bootstrap-hint'` — the authenticated join-approval hint; can be stale.
   * - `'none'`       — no peer at all.
   */
  provenance: 'metadata' | 'projection' | 'registry' | 'bootstrap-hint' | 'none';
}

/**
 * The peer allowed to let one answer stand for a whole Context Graph — a
 * metadata-resolved curator and nothing else. A single definition so the walk's
 * early-stop rule cannot be restated slightly differently at another call site.
 */
export function authoritativeSyncPeerId(resolution: SyncPeerResolution): string | undefined {
  return resolution.provenance === 'metadata' ? resolution.peerId : undefined;
}

/**
 * Does this DID identify a peer directly, or does it need resolving through a
 * registry? Wallet-address curators (V10) are the indirect case; a bare libp2p
 * peer id (legacy) is already the answer.
 */
function curatorDidNeedsRegistryResolution(curatorIdentifier: string): boolean {
  return curatorIdentifier.startsWith('0x');
}

/**
 * Resolve the curator peer for a Context Graph together with WHERE it came from.
 *
 * Two routes produce a peer id here and they are NOT interchangeable:
 *
 * - `'metadata'` — `<cg>/_meta` names a curator DID and it resolved to a peer.
 *   Authoritative: that peer speaks for the whole graph.
 * - `'projection'` / `'registry'` — a peer was resolved, but not from a source that
 *   can speak for the graph. `getCgMeta()` is a MERGED projection: it unions
 *   `<cg>/_meta` with the AGENTS, `_catalog` and ONTOLOGY graphs under first-wins
 *   precedence and discards which graph supplied each fact, so a creator
 *   contributed by an AGENTS-only declaration is indistinguishable from one the
 *   graph declared about itself. The agent registry is queried strictly locally,
 *   so even a unique local match is not evidence of a network-wide binding.
 *   Both rank the walk and neither may end it.
 * - `'bootstrap-hint'` — the authenticated join-approval hint recorded in
 *   `preferredSyncPeers`, used while `_meta` has not arrived yet (and restored
 *   from the durable join-approved membership row after restart). It is a fine
 *   ranking signal but can be stale: peer ids are cryptographic identities, so
 *   a curator that rotated its libp2p key leaves an ordinary member sitting on
 *   the id the hint still names.
 *
 * Provenance is returned rather than inferred by a caller because the two
 * routes routinely produce the SAME id — the join approval normally comes from
 * the curator — so comparing the result against the hint cannot tell
 * "metadata confirmed the curator" from "metadata found nothing and the hint
 * was echoed back". Only the resolver knows which branch it took.
 */

export async function resolveCuratorSyncPeer(
  agent: DKGAgent,
  /**
   * The agent's `preferredSyncPeers`, passed explicitly because it is both read
   * and evicted here — and because that makes the resolver directly drivable in
   * a test without standing up an agent.
   */
  bootstrapHints: Map<string, string>,
  contextGraphId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SyncPeerResolution> {
  const approvedCuratorPeerId = bootstrapHints.get(contextGraphId);
  const fromHint = (): SyncPeerResolution => (approvedCuratorPeerId
    ? { peerId: approvedCuratorPeerId, provenance: 'bootstrap-hint' }
    : { provenance: 'none' });

  const meta = await agent.getCgMeta(contextGraphId, { signal: options.signal });
  const curatorDid = meta.curator ?? meta.curators[0] ?? '';
  // Once `_meta` identifies a curator, that authoritative route must win over
  // the bootstrap hint.
  if (!curatorDid) return fromHint();
  const didPrefix = 'did:dkg:agent:';
  if (!curatorDid.startsWith(didPrefix)) return fromHint();
  const curatorIdentifier = curatorDid.slice(didPrefix.length);

  // Resolve curator identifier to a peer ID. The DID value is either a
  // libp2p peer ID (legacy) or an Ethereum wallet address (V10). For
  // wallet addresses, prefer the deterministic DKG_CREATOR triple (which
  // stores the libp2p peer ID) over the agent registry (which may return
  // an arbitrary match when multiple agents register the same wallet).
  let curatorPeerId = curatorIdentifier;
  // Assume the weaker classification and EARN `'metadata'` below. The previous
  // comment here claimed the projected `DKG_CREATOR` route came "straight out of
  // `<cg>/_meta`"; it does not — `getCgMeta()` merges four graphs.
  let provenance: SyncPeerResolution['provenance'] = 'projection';
  if (curatorDidNeedsRegistryResolution(curatorIdentifier)) {
    let resolved = false;

    // Preferred: use the same projected metadata resolution as privacy and
    // listing reads. AGENTS-only declarations can mark a graph private, so
    // the refresh path must be able to discover their creator route too.
    const creatorCandidates = [
      meta.creator,
      ...meta.creators,
    ].filter((value): value is string => Boolean(value));
    for (const creatorDid of creatorCandidates) {
      if (creatorDid.startsWith(didPrefix)) {
        const creatorId = creatorDid.slice(didPrefix.length);
        if (!creatorId.startsWith('0x')) {
          curatorPeerId = creatorId;
          resolved = true;
          break;
        }
      }
    }

    // Fallback: agent registry lookup (non-deterministic if multiple agents
    // share the same wallet address, but better than failing outright)
    if (!resolved) {
      try {
        throwIfSyncAuthAborted(options.signal);
        const agents = await agent.discovery.findAgents();
        throwIfSyncAuthAborted(options.signal);
        const matches = agents.filter(
          (a) => a.agentAddress?.toLowerCase() === curatorIdentifier.toLowerCase(),
        );
        const match = matches[0];
        if (match) {
          curatorPeerId = match.peerId;
          resolved = true;
          // NEVER authoritative, however many matches came back. `findAgents()`
          // queries the LOCAL Agent Registry only, so "one match" means one match
          // on this node — not that the wallet has a single registration on the
          // network. Local cardinality cannot prove a binding.
          provenance = 'registry';
        }
      } catch {
        throwIfSyncAuthAborted(options.signal);
        /* registry unavailable */
      }
    }

    if (!resolved) return fromHint();
  }

  // No route here earns `'metadata'`, so nothing this resolver returns may end a
  // catch-up walk. That is deliberate, and it is a scope decision rather than an
  // oversight — see #2006 and the follow-up issue.
  //
  // Earlier revisions re-derived the binding from the Context Graph's OWN
  // `<cg>/_meta` graph, on the theory that reading one graph instead of the
  // merged projection made the fact attributable to the graph itself. It does
  // not. Source-qualifying by GRAPH establishes which graph holds the rows, not
  // which WRITER supplied them: ordinary durable-meta catch-up admits
  // IRI-subject descriptive metadata for the Context Graph's entity subject
  // (`selectAdmittedMetadataIndexes` falls through for any predicate outside the
  // control set) and inserts it verbatim into that exact `_meta` graph. A
  // contacted peer can therefore supply the very rows the check reads —
  // `rdf:type`, `accessPolicy`, `curator` — and manufacture its own authority.
  // Tightening the SHAPE of the record (completeness, uniqueness) does not help:
  // it only raises the number of rows the peer must send.
  //
  // Authority needs a binding from a source a peer cannot write: a
  // curator-signed snapshot, an on-chain curator→peer edge, or the locally
  // persisted join-approval record. None is available today — join approvals
  // carry no curator signature, no chain record maps a wallet to a libp2p peer,
  // and both metadata "proofs" are structural checks with no signature. Until
  // one exists, every resolution ranks the walk and none ends it.
  void curatorDid;

  bootstrapHints.delete(contextGraphId);
  return { peerId: curatorPeerId, provenance };
}

export class ContextGraphResolveMethods extends DKGAgentBase {
  async getCgMeta(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphMetaRecord> {
    return this.contextGraphMetaProjection.get(contextGraphId, { signal: options.signal });
  }

  /**
   * Facts from the Context Graph's OWN `<cg>/_meta` graph only — the
   * source-qualified counterpart of {@link getCgMeta}, which merges four
   * graphs and discards which one supplied each fact. Used where a fact has to be attributable to
   * the graph itself; see `resolveCuratorSyncPeer`.
   */
  async getOwnCgMetaFacts(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphMetaRecord> {
    return this.contextGraphMetaProjection.getOwnMetaFacts(contextGraphId, {
      signal: options.signal,
    });
  }

  async listContextGraphsFromProjection(this: DKGAgent, opts?: { callerAgentAddress?: string | null }): Promise<ListContextGraphsRow[]> {
    // Before enabling this default-on: thread the caller signal into getCgMeta
    // and wrap per-row reads in withBudget (per A1's LIST_CONTEXT_GRAPHS_*_BUDGET_MS);
    // this projection path currently lacks the per-read budgets/abort-signal the
    // legacy path has. (Track C security review.)
    const candidateIds = new Set(await this.contextGraphMetaProjection.listDeclaredContextGraphIds());
    for (const [id] of this.subscribedContextGraphs) {
      candidateIds.add(id);
    }

    const graphManager = new GraphManager(this.store);
    for (const id of await graphManager.listContextGraphs()) {
      candidateIds.add(id);
    }

    const rows = await mapContextGraphListRows([...candidateIds].sort(), async (id): Promise<InternalContextGraphListRow | null> => {
      if (!id) return null;
      const sub = this.subscribedContextGraphs.get(id);
      const meta = await this.getCgMeta(id);
      const hasProjectionGate = meta.hasAgentGate || meta.hasPeerGate || meta.hasLegacyParticipantGate;
      const projectedAccessPolicy = meta.accessPolicy ?? (hasProjectionGate ? 'private' : undefined);
      const policyKnown = meta.declared || projectedAccessPolicy !== undefined;

      if (!meta.declared && !sub?.onChainId && !sub?.pendingMeta) {
        if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) return null;
        const hasContent = await this.contextGraphHasLocalContent(id);
        if (!hasContent) return null;
      }

      return {
        id,
        uri: meta.uri || contextGraphDataUri(id),
        name: meta.name ?? sub?.name ?? id,
        description: meta.description,
        creator: meta.creator,
        curator: meta.curator,
        accessPolicy: projectedAccessPolicy,
        createdAt: meta.createdAt,
        isSystem: meta.isSystem,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        onChainId: sub?.onChainId ?? meta.onChainId,
        policyKnown,
      };
    });

    return applyContextGraphListPrivacy(
      this,
      rows.filter((row): row is InternalContextGraphListRow => row !== null),
      opts,
    );
  }

  /**
   * Check whether a context graph exists in local storage. Definition triples in
   * ONTOLOGY/_meta count, and storage-backed graph presence also counts so local
   * shared-memory-only survivors are not treated as nonexistent.
   */
  async contextGraphExists(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> }
      } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) {
      return true;
    }

    // Track B perf (write-preflight resilience): this fallback used to be
    // `graphManager.listContextGraphs()` — a store-WIDE named-graph
    // enumeration on every declaration miss, exactly the kind of scan that
    // blows the write-preflight budget on a large or slow store. The
    // membership test it fed (`storedIds.includes(contextGraphId)`) can only
    // ever be satisfied by one of this CG's five well-known graph names (the
    // root data graph or its `_meta` / `_private` / `_shared_memory` /
    // `_shared_memory_meta` bookkeeping graphs — anything deeper re-gains a
    // "/" after suffix-stripping and is dropped by the scan), so probe those
    // directly with bounded `hasGraph` point lookups. Curated ids
    // (`<curator>/<slug>`) were never collected by the legacy scan (it drops
    // ids containing "/"), so answer those without touching the store at all.
    if (contextGraphId.includes('/')) return false;
    const graphManager = new GraphManager(this.store);
    const survivorGraphUris = [
      graphManager.dataGraphUri(contextGraphId),
      graphManager.metaGraphUri(contextGraphId),
      graphManager.privateGraphUri(contextGraphId),
      graphManager.sharedMemoryUri(contextGraphId),
      graphManager.sharedMemoryMetaUri(contextGraphId),
    ];
    for (const graphUri of survivorGraphUris) {
      if (await this.store.hasGraph(graphUri)) return true;
    }
    return false;
  }

  /**
   * Check whether the context graph has any actual content locally. A
   * contextGraph declaration triple in the ontology graph (from auto-discovery
   * via chain registry or ontology sync) does NOT count as content; it
   * only indicates the contextGraph was announced, not that we have access to
   * its data. This predicate is used to distinguish "genuinely synced /
   * has access" from "declaration only / probably denied".
   *
   * Looks for at least one triple in ANY graph under the context-graph
   * prefix (`did:dkg:context-graph:<cg>`, `…/<sg>`, `…/assertion/…`,
   * `…/_shared_memory`, …) except the `_meta` bookkeeping graphs. Tier-4l
   * Codex feedback: the previous check only inspected the root data
   * graph, so a project whose content was synced into sub-graphs
   * (`/tasks`, `/chat`, assertion graphs, SWM) looked like "no local
   * content" and the denial-cleanup path would unsubscribe it. Sub-graph
   * content is the normal state for any non-trivial project so the root
   * data graph is routinely empty.
   */
  async contextGraphHasLocalContent(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const prefix = `did:dkg:context-graph:${contextGraphId}`;
    // A3 (O(store) relief): the old `ASK { GRAPH ?g {?s ?p ?o} FILTER(STRSTARTS(?g,…)) }`
    // was a full-store scan — its worst case (no content) iterated every quad to
    // prove absence, exactly the case this probe hits most. The named-graph
    // index only tracks graphs that hold ≥1 quad, so "has local content"
    // reduces to "is there a non-bookkeeping graph under this CG's prefix",
    // answerable from the fast index (O(#graphs)) with no store scan. Excludes
    // `_meta` / `_shared_memory_meta` bookkeeping, written even for
    // declaration-only discoveries. Advisory + fail-safe: callers
    // (`probeContextGraphWritePreflight`) treat a failure as UNKNOWN, never a
    // hard deny.
    const cgGraphs = this.store.listGraphsByPrefix
      ? await this.store.listGraphsByPrefix(prefix, { signal: options.signal })
      : (await this.store.listGraphs({ signal: options.signal })).filter((g) => g.startsWith(prefix));
    return cgGraphs.some(
      (g) => !g.endsWith('/_meta') && !g.endsWith('/_shared_memory_meta'),
    );
  }

  async probeContextGraphWritePreflight(
    this: DKGAgent,
    contextGraphId: string,
    opts?: { callerAgentAddress?: string | null },
  ): Promise<ContextGraphWritePreflightProbe> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const metaSubjectUri = contextGraphDataGraphUri(contextGraphId);
    const subscriptionStore = this.config.contextGraphSubscriptionStore;

    const persistedSubscriptionPromise = subscriptionStore?.load
      ? subscriptionStore.load(contextGraphId)
      : Promise.resolve(null);
    const declarationPromise = this.store.query(`
      SELECT ?access ?curator WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${metaSubjectUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${metaSubjectUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${metaSubjectUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
          }
        }
      }
    `);

    // Track B (write-preflight resilience): these four reads were previously
    // combined with `Promise.all`, so a single failing store read (slow-store
    // abort timeout, "the store is closed" after an Oxigraph worker crash)
    // threw the WHOLE probe away — including the in-memory subscription
    // snapshot below, which needs zero store I/O. The daemon's write
    // preflight was then left with no evidence at all and 503'd every write
    // until the store recovered. Settle each read individually instead:
    // store-derived fields degrade to `undefined` (UNKNOWN — never a
    // definitive deny) and `storeUnavailable` carries the first failure
    // message for diagnostics, while the in-memory registry state always
    // survives.
    const [existsRead, hasLocalContentRead, persistedSubscriptionRead, declarationRead] =
      await Promise.allSettled([
        this.contextGraphExists(contextGraphId),
        this.contextGraphHasLocalContent(contextGraphId),
        persistedSubscriptionPromise,
        declarationPromise,
      ]);

    let storeUnavailable = false;
    let storeErrorMessage: string | undefined;
    const noteStoreFailure = (reason: unknown): undefined => {
      storeUnavailable = true;
      if (storeErrorMessage === undefined) {
        storeErrorMessage = reason instanceof Error ? reason.message : String(reason);
      }
      return undefined;
    };
    const exists = existsRead.status === 'fulfilled'
      ? existsRead.value
      : noteStoreFailure(existsRead.reason);
    const hasLocalContent = hasLocalContentRead.status === 'fulfilled'
      ? hasLocalContentRead.value
      : noteStoreFailure(hasLocalContentRead.reason);
    const persistedSubscription = persistedSubscriptionRead.status === 'fulfilled'
      ? persistedSubscriptionRead.value
      : noteStoreFailure(persistedSubscriptionRead.reason);
    const declarationResult = declarationRead.status === 'fulfilled'
      ? declarationRead.value
      : noteStoreFailure(declarationRead.reason);

    let accessPolicy: 'public' | 'private' | undefined;
    // Tri-state: stays `undefined` (unknown) when the declaration read
    // failed, so a store outage can never masquerade as "no declaration".
    let declarationFound: boolean | undefined = declarationResult === undefined ? undefined : false;
    const curators: string[] = [];
    if (declarationResult && declarationResult.type === 'bindings') {
      declarationFound = declarationResult.bindings.length > 0;
      let sawPublic = false;
      let sawPrivate = false;
      for (const row of declarationResult.bindings as Record<string, string>[]) {
        const access = row['access'];
        if (typeof access === 'string') {
          const normalized = stripLiteral(access).trim().toLowerCase();
          if (normalized === 'private') sawPrivate = true;
          if (normalized === 'public') sawPublic = true;
        }
        const curator = row['curator'];
        if (typeof curator === 'string' && curator.trim()) curators.push(curator);
      }
      if (sawPrivate) accessPolicy = 'private';
      else if (sawPublic) accessPolicy = 'public';
    }

    let checksum: string | null = null;
    const rawCaller = opts?.callerAgentAddress?.trim();
    if (rawCaller) {
      const didPrefix = 'did:dkg:agent:';
      const rawAddress = rawCaller.startsWith(didPrefix) ? rawCaller.slice(didPrefix.length) : rawCaller;
      if (ethers.isAddress(rawAddress)) checksum = ethers.getAddress(rawAddress);
    }

    let callerAuthorized: boolean | undefined;
    if (checksum && declarationFound) {
      if (accessPolicy === 'public') {
        callerAuthorized = true;
      } else if (accessPolicy === 'private') {
        const curatorMatch = curators.some((curator) =>
          this.curatorDidMatchesChecksumAgent(curator, checksum),
        );
        if (curatorMatch) {
          callerAuthorized = true;
        } else {
          // The allowlist lookup is a store read too — the store can die
          // between the settled reads above and here. Leave authorization
          // UNKNOWN (never a deny) and flag the store instead of throwing
          // the whole probe away.
          try {
            callerAuthorized = await this.callerIsAllowlistedAgentParticipant(contextGraphId, checksum);
          } catch (err) {
            noteStoreFailure(err);
          }
        }
      }
    }

    const inMemorySubscription = this.subscribedContextGraphs.get(contextGraphId);
    return {
      // Required typed boundary: `storeAvailable` is the inverse of
      // `storeUnavailable`, emitted unconditionally so consumers cannot read
      // any store-derived fact below without first establishing the store was
      // up. The optional `storeUnavailable`/`storeErrorMessage` pair is kept
      // for the 503-diagnostics path (unchanged wire behaviour).
      storeAvailable: !storeUnavailable,
      ...(exists !== undefined ? { exists } : {}),
      ...(hasLocalContent !== undefined ? { hasLocalContent } : {}),
      ...(inMemorySubscription
        ? { inMemorySubscription: {
            subscribed: inMemorySubscription.subscribed,
            synced: inMemorySubscription.synced,
          } }
        : {}),
      ...(persistedSubscription
        ? { persistedSubscription: {
            subscribed: persistedSubscription.subscribed,
            synced: persistedSubscription.synced,
          } }
        : {}),
      ...(declarationFound !== undefined ? { declarationFound } : {}),
      ...(accessPolicy ? { accessPolicy } : {}),
      ...(curators[0] ? { curator: curators[0] } : {}),
      ...(callerAuthorized !== undefined ? { callerAuthorized } : {}),
      ...(storeUnavailable
        ? {
            storeUnavailable: true,
            ...(storeErrorMessage !== undefined ? { storeErrorMessage } : {}),
          }
        : {}),
    };
  }

  /**
   * Track B (write-preflight resilience) — authoritative store-free proof that
   * a candidate is an ACTIVE, PUBLIC context graph on-chain, for the daemon's
   * last-resort write-preflight rescue that runs precisely when the local store
   * is DOWN. The candidate's numeric on-chain id is resolved from the IN-MEMORY
   * subscription registry only (zero store I/O — deliberately NOT
   * `getContextGraphOnChainId`, whose fallback reads the ontology graph), then
   * verified against the chain: `isContextGraphActiveOnChain` AND
   * `getContextGraphAccessPolicy === 0` (public).
   *
   * Why PUBLIC is mandatory (security): with the store down the daemon cannot
   * evaluate a private CG's per-caller authorization — that verdict is derived
   * from the local `_meta` allowlist, which is exactly what's unavailable. The
   * healthy write-preflight denies an authenticated-but-unauthorized caller of
   * a PRIVATE CG (`exactProbeIsAuthoritativeBearerDeny`, which fires only for
   * accessPolicy `private`). Admitting a private id here would silently convert
   * that DENY into an accept. A PUBLIC CG has no such per-caller preflight deny
   * (anyone may target it; publish-policy/curation is enforced downstream at the
   * ACK/oracle layer, unaffected by this rescue), so admitting a proven-public
   * id can never convert an existing deny — which is why this is the only
   * store-free evidence we trust.
   *
   * Fail-closed by construction: resolves `true` ONLY on positive on-chain
   * proof (active AND public) of an id the registry ALREADY tracks. No registry
   * entry, no `onChainId`, an unparseable/zero id, an adapter missing either
   * read, not-active, or non-public all resolve `false`; RPC errors propagate so
   * the caller keeps its validation-unavailable response. A raw unknown
   * candidate can never be accepted through here (shadow-CG fail-closed design).
   */
  async contextGraphActivePublicOnChainFromRegistry(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (!onChainId) return false;
    let numericId: bigint;
    try {
      numericId = BigInt(onChainId);
    } catch {
      return false;
    }
    if (numericId <= 0n) return false;
    const isActive = this.chain?.isContextGraphActiveOnChain;
    const getAccessPolicy = this.chain?.getContextGraphAccessPolicy;
    if (typeof isActive !== 'function' || typeof getAccessPolicy !== 'function') return false;
    // Sequential + short-circuit: don't pay the policy read if it isn't active.
    if ((await isActive.call(this.chain, numericId)) !== true) return false;
    return (await getAccessPolicy.call(this.chain, numericId)) === 0;
  }

  /**
   * Track B (write-preflight resilience) — HIGH-LEVEL rescue decision the
   * daemon calls when BOTH write-preflight legs failed (store down). This is
   * the one method the HTTP utility layer invokes: it OWNS the chain-policy
   * semantics (registry onChainId → `isContextGraphActiveOnChain` → public
   * `getContextGraphAccessPolicy`) so the daemon never has to assemble on-chain
   * access-policy meaning locally. Returns `true` ONLY on positive proof the
   * candidate is an ACTIVE, PUBLIC context graph the registry ALREADY tracks;
   * everything else — no registry entry, not-active, non-public, missing
   * adapter — resolves `false` and the daemon keeps its fail-closed 503.
   *
   * Why PUBLIC is mandatory (security): with the store down the daemon cannot
   * evaluate a private CG's per-caller authorization (that verdict comes from
   * the local `_meta` allowlist, exactly what's unavailable). The healthy
   * write-preflight denies an authenticated-but-unauthorized caller of a
   * PRIVATE CG; admitting a private id here would silently convert that DENY
   * into an accept. A PUBLIC CG has no such per-caller preflight deny, so a
   * proven-public id can never convert an existing deny.
   *
   * The bounded eth_call timeout is enforced by the caller (the daemon wraps
   * this in a `Promise.race`), so a hung RPC stack cannot stall a degraded
   * write route. RPC errors propagate (the caller treats a throw as "no
   * rescue" and keeps its validation-unavailable response).
   */
  async validateWriteTargetDuringStoreOutage(this: DKGAgent, candidateId: string): Promise<boolean> {
    return this.contextGraphActivePublicOnChainFromRegistry(candidateId);
  }

  /**
   * Check whether a context graph is declared as curated (private/allowlist)
   * locally. Reads the DKG accessPolicy predicate from either the ontology
   * graph (public CGs) or the CG's _meta graph (curated CGs). Returns false
   * when no declaration is present locally (caller should treat that as
   * "unknown, assume public" — this predicate is only used to gate
   * optimistic denial inference, not access control decisions).
   */
  async contextGraphIsCurated(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    try {
      return (await this.getExplicitAccessPolicy(contextGraphId)) === 'private';
    } catch {
      return false;
    }
  }

  public parseSyncRequest(this: DKGAgent, data: Uint8Array): SyncRequestEnvelope {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      let parsed: SyncRequestEnvelope;
      try {
        parsed = JSON.parse(text) as SyncRequestEnvelope;
      } catch {
        // Malformed JSON — fall through to pipe-delimited parsing
        return this.parsePipeDelimitedSyncRequest(text);
      }
      return {
        contextGraphId: parsed.contextGraphId,
        offset: parsed.offset ?? 0,
        limit: Math.min(parsed.limit ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
        includeSharedMemory: parsed.includeSharedMemory ?? false,
        phase: normalizeSyncPhase(parsed.phase),
        snapshotRef: typeof parsed.snapshotRef === 'string' ? parsed.snapshotRef : undefined,
        authPurpose: typeof parsed.authPurpose === 'string' ? parsed.authPurpose : undefined,
        authSelector: typeof parsed.authSelector === 'string' ? parsed.authSelector : undefined,
        ...normalizeByteBudgetPageHint(parsed.pageMode, parsed.pageRowsHint),
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
        syncSessionId: typeof parsed.syncSessionId === 'string' ? parsed.syncSessionId : undefined,
        // Phase C: unsigned delta hint. Validated/normalised in the responder.
        sinceBatchId: typeof parsed.sinceBatchId === 'string' ? parsed.sinceBatchId : undefined,
        // Exact-asset filter is narrowing-only. Present-but-invalid must remain
        // an empty filter so the responder serves nothing instead of silently
        // expanding the request into a full Context Graph scan.
        assetUals: normalizeExactAssetUals(parsed.assetUals),
        // R9 (SECURITY): the unsigned member-recovery marker. This is a STRICT
        // FIELD ALLOWLIST — anything not copied here is dropped. If `recovery`
        // were omitted, the responder would never see it, silently fall through
        // to the fail-open participant/peer path, and the members-only gate
        // would be dead code. Coerce to a real boolean so a truthy non-bool
        // can't smuggle through.
        recovery: parsed.recovery === true ? true : undefined,
      };
    }

    return this.parsePipeDelimitedSyncRequest(text);
  }

  parsePipeDelimitedSyncRequest(this: DKGAgent, text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const phase = normalizeSyncPhase(parts[3]);
    const tail = decodePipeSyncRequestTail(parts);
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase,
      snapshotRef: phase === 'snapshot' ? parts[4] : undefined,
      ...tail,
    };
  }

  /**
   * Pick which local agent should sign sync requests for this CG.
   *
   * On a multi-agent node, hard-coding `defaultAgentAddress` for every
   * sync envelope is wrong: if agent B is allowlisted on the CG but
   * agent A happens to be the process default, the responder's
   * per-agent delegation lookup will only see A's claim and miss B's
   * stored delegation, silently failing sync auth for the actually
   * approved agent.
   *
   * Resolution order:
   *  1. If the process default is in the curator's allowlist (mirrored
   *     into our local `_meta` after first sync), keep using it. This
   *     preserves historical behavior for single-agent nodes.
   *  2. Otherwise pick the first local agent the curator allowlisted.
   *  3. If neither (no `_meta` yet, e.g. the very first catch-up after
   *     `join-approved` arrives), fall back to the locally-known
   *     join-request / join-approved hint in `localApprovedAgentByCG`.
   *     This is the codex round-4 fix — without it, the first
   *     post-approval sync on multi-agent nodes would bind to
   *     `defaultAgentAddress` and the responder would deny.
   *  4. If even the hint is unset (we're the curator handling our own
   *     CG, or restarted after approval), fall back to
   *     `defaultAgentAddress`.
   *
   * PR #448 review (rounds 4 and 5) — Codex flagged the multi-agent
   * silent-sync-failure bug, then the still-broken first-catch-up
   * case after the round-4 fix landed.
   */
  async findLocalAgentForContextGraph(this: DKGAgent, contextGraphId: string): Promise<string | undefined> {
    if (this.localAgents.size === 0) return this.defaultAgentAddress;

    // Hint first: if we have a definitive locally-known choice (just
    // signed, or just received a join-approved for this CG), prefer it
    // — but only if it still maps to a local agent we can sign with.
    const hintAddr = this.localApprovedAgentByCG.get(contextGraphId);
    const hintLocal = hintAddr
      ? [...this.localAgents.keys()].find((a) => a.toLowerCase() === hintAddr)
      : undefined;

    let allowedAgents: string[] = [];
    try {
      allowedAgents = await this.getContextGraphAllowedAgents(contextGraphId);
    } catch {
      return hintLocal ?? this.defaultAgentAddress;
    }
    if (allowedAgents.length === 0) {
      // No `_meta` yet — the hint is the most authoritative answer we
      // have for the post-approval bootstrap window.
      return hintLocal ?? this.defaultAgentAddress;
    }
    const allowedLower = new Set(allowedAgents.map((a) => a.toLowerCase()));
    // Hint wins if it's also on the allowlist — covers the "approved
    // agent ≠ process default, _meta has caught up" case.
    if (hintLocal && allowedLower.has(hintLocal.toLowerCase())) return hintLocal;
    const defaultLower = this.defaultAgentAddress?.toLowerCase();
    if (defaultLower && allowedLower.has(defaultLower)) return this.defaultAgentAddress;
    for (const localAddr of this.localAgents.keys()) {
      if (allowedLower.has(localAddr.toLowerCase())) return localAddr;
    }
    return hintLocal ?? this.defaultAgentAddress;
  }

  public async buildSyncRequest(this: DKGAgent,
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    responderPeerId: string,
    phase: SyncPhase = 'data',
    snapshotRef?: string,
    sinceBatchId?: string,
    syncSessionId?: string,
    recovery?: boolean,
    assetUals?: string[],
  ): Promise<Uint8Array> {
    // Policy-read uncertainty must not abort bootstrap or downgrade it to the
    // public pipe encoding. Treat an unreadable policy as private; catalog is
    // explicitly exempt below and stays public.
    const isPrivate = await this.isPrivateContextGraph(contextGraphId).catch(() => true);

    // Until `_meta` is authoritative locally, the access policy is UNKNOWN.
    // A stale/incorrect `synced=true` must not downgrade the request to the
    // public pipe format: that is exactly the poisoned-subscription state an
    // unrelated peer can create by returning a clean empty response before
    // the curator is reachable. Keep every non-catalog phase authenticated
    // until a confirmed meta sync explicitly sets `metaSynced=true`.
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    const hasLocalData = sub?.synced === true;
    // The persisted flag is necessary but not sufficient: older startup code
    // could set `metaSynced=true` after creating only a local
    // registrationStatus="unregistered" shadow. Re-check the store so that
    // restart poison cannot suppress authentication either.
    const authoritativeMetaConfirmed = sub?.metaSynced === true &&
      sub.pendingMeta !== true &&
      // Store/RPC uncertainty must keep the request on the authenticated
      // path. A transient proof read failure is not a reason to abort sync or
      // downgrade it to the public encoding.
      await this.hasConfirmedMetaState(contextGraphId).catch(() => false);
    const authoritativeMetaUnconfirmed = !authoritativeMetaConfirmed;
    // the catalog facet is public and served without the
    // allowlist gate, so an outsider (no CG identity) requests it unauthenticated.
    // R9: recovery serves plaintext member-to-member and is gated by the strict
    // members-only authorizer — it MUST be an authenticated (signed) envelope.
    const needsAuth = recovery || (
      phase !== 'catalog' &&
      (isPrivate || !hasLocalData || authoritativeMetaUnconfirmed)
    );
    const claimedAgentAddress = await this.findLocalAgentForContextGraph(contextGraphId);
    const claimedAgent = claimedAgentAddress ? this.localAgents.get(claimedAgentAddress) : undefined;
    const exactAssetUals = assetUals === undefined ? undefined : requireExactAssetUals(assetUals);
    return buildSyncRequestEnvelope({
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      targetPeerId: responderPeerId,
      requesterPeerId: this.peerId,
      phase,
      snapshotRef,
      // Phase C: only forwarded for the durable DATA phase — SWM has no
      // `dkg:batchId` (pre-chain) and meta must never be narrowed. The hint
      // is gap-safe only when it comes from a CONTIGUOUS watermark, so it is
      // supplied explicitly by callers, never auto-derived from local MAX().
      sinceBatchId: phase === 'data' && !includeSharedMemory ? sinceBatchId : undefined,
      assetUals: !includeSharedMemory && phase !== 'catalog' ? exactAssetUals : undefined,
      syncSessionId: phase === 'snapshot' ? undefined : syncSessionId,
      needsAuth,
      // R9: forces the EDGE (member-agent-key) signing path so the responder
      // recovers the member agent address and matches it against the gate.
      recovery,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      getIdentityId: () => this.chain.getIdentityId(),
      signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
      claimedAgentAddress: claimedAgentAddress,
      claimedAgentPrivateKey: claimedAgent?.privateKey,
    });
  }

  /**
   * fetch a (private) CG's PUBLIC catalog entry from a peer
   * WITHOUT membership. The responder serves the bounded `_catalog` facet
   * openly (no allowlist gate); the fetched DCAT dataset record is written to
   * the local store's `_catalog` graph. Returns the catalog quads received.
   * The peer serves ONLY `_catalog` — gated content is never returned.
   */
  public async fetchPublicCatalog(this: DKGAgent,
    contextGraphId: string,
    responderPeerId: string,
    deadlineMs = 30_000,
  ): Promise<Quad[]> {
    const ctx = createOperationContext('sync');
    const catalogGraph = contextGraphCatalogUri(contextGraphId);
    const result = await this.fetchSyncPages(
      ctx, responderPeerId, contextGraphId, false, 'catalog', catalogGraph, Date.now() + deadlineMs,
    );
    // SECURITY: this is the UNAUTHENTICATED catalog path — there is no
    // membership/allowlist gate on what we persist. The generic requester
    // filter (parseAndFilterNQuads) admits ANY graph under
    // `did:dkg:context-graph:<cg>/…`, not just `_catalog`, so a malicious
    // peer could ride the open catalog fetch to inject `_meta`/`_private`/VM
    // quads into the local store. Re-filter to ONLY the `<cg>/_catalog` graph
    // before insert and drop everything else.
    const catalogQuads = result.quads.filter((q) => q.graph === catalogGraph);
    // Treat partial fetches as NOT done: fetchSyncPages returns
    // `completed: false` (timed out) with a possibly-truncated page. Inserting
    // that would corrupt the local `_catalog`, and deleting the checkpoint
    // would lose the resume cursor. Only persist + delete-checkpoint when the
    // fetch ran to completion; on partial, keep the checkpoint and persist
    // nothing.
    if (result.completed) {
      // Persist the fetched DCAT dataset record into the local `<cg>/_catalog`
      // graph and invalidate the meta projection so getCgMeta() /
      // listContextGraphs() can see the remotely discovered private CG after
      // this call. The projection read side is disclosure-floor only (rdf:type
      // / dct:accessRights — CATALOG_META_PREDICATES), so persisting
      // peer-fetched catalog quads cannot poison the authz-bearing
      // creator/curator/allowlist fields. Mirrors refreshMetaFromCurator's
      // persist+invalidate path.
      if (catalogQuads.length > 0) {
        await this.store.insert(catalogQuads);
        this.contextGraphMetaProjection.markDirtyFromQuads(catalogQuads);
      }
      this.syncCheckpoints.delete(result.checkpointKey);
    }
    return catalogQuads;
  }

  computeSyncDigest(this: DKGAgent,
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string | undefined,
    requestId: string | undefined,
    issuedAtMs: number | undefined,
    requesterAgentAddress: string | undefined,
    authPurpose?: string,
    authSelector?: string,
  ): Uint8Array {
    // `requesterAgentAddress` participates in the digest so the
    // "on behalf of" claim is signed, not free-form envelope data.
    // Without it, the responder's delegation lookup can be steered by
    // tampering with `requesterAgentAddress` after the signature was
    // produced — which would be a way to bypass the per-agent
    // delegation binding in `request-authorize`.
    const baseTypes = ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256', 'string'];
    const baseValues = [
      contextGraphId,
      BigInt(offset),
      BigInt(limit),
      includeSharedMemory,
      targetPeerId,
      requesterPeerId ?? '',
      requestId ?? '',
      BigInt(issuedAtMs ?? 0),
      (requesterAgentAddress ?? '').toLowerCase(),
    ];
    if (authPurpose || authSelector) {
      baseTypes.push('string', 'string');
      baseValues.push(authPurpose ?? '', authSelector ?? '');
    }
    return ethers.getBytes(ethers.solidityPackedKeccak256(baseTypes, baseValues));
  }

  public async authorizeSyncRequest(
    this: DKGAgent,
    request: SyncRequestEnvelope,
    remotePeerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    throwIfSyncAuthAborted(options.signal);
    const isPrivate = await this.isPrivateContextGraph(request.contextGraphId, { signal: options.signal });
    throwIfSyncAuthAborted(options.signal);
    if (!isPrivate) {
      return true;
    }
    const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
    return authorizePrivateSyncRequest({
      ctx: createOperationContext('sync'),
      request,
      remotePeerId,
      localPeerId: this.peerId,
      syncAuthMaxAgeMs: SYNC_AUTH_MAX_AGE_MS,
      seenRequestIds: this.seenPrivateSyncRequestIds,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      verifyIdentity: typeof verifyIdentity === 'function'
        ? async (recoveredAddress, claimedIdentityId, lookupOptions) => {
            // Chain/RPC verifiers are not actually abortable in ethers. Do not
            // race them against request aborts: that would free responder
            // capacity while the RPC keeps running in the background.
            throwIfSyncAuthAborted(lookupOptions?.signal);
            const valid = await verifyIdentity.call(this.chain, recoveredAddress, claimedIdentityId);
            throwIfSyncAuthAborted(lookupOptions?.signal);
            return valid;
          }
        : undefined,
      getParticipants: (contextGraphId, lookupOptions) => this.getPrivateContextGraphParticipants(contextGraphId, lookupOptions),
      getAllowedPeers: (contextGraphId, lookupOptions) => this.getContextGraphAllowedPeers(contextGraphId, lookupOptions),
      getAgentGateAddresses: (contextGraphId, lookupOptions) => this.getContextGraphAgentGateAddresses(contextGraphId, lookupOptions),
      getAllowedDelegateePeers: (contextGraphId, lookupOptions) => this.getContextGraphAllowedDelegateePeers(contextGraphId, lookupOptions),
      getAllowedDelegateeKeys: (contextGraphId, lookupOptions) => this.getContextGraphAllowedDelegateeKeys(contextGraphId, lookupOptions),
      // R9: FRESH `_meta`-only members-only gate for the recovery branch (no
      // subscription cache). Consulted only when `request.recovery` is set.
      getMemberRecoveryGate: (contextGraphId, lookupOptions) => this.getMemberRecoveryGate(contextGraphId, lookupOptions),
      refreshMetaFromCurator: (contextGraphId, lookupOptions) => this.refreshMetaFromCurator(contextGraphId, lookupOptions),
      signal: options.signal,
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    });
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-backed participant-agent oracle
   * for {@link SharedMemoryHandler#chainAgentGateOracle}.
   *
   * Maps a CG identifier (cleartext or numeric form) to the on-chain
   * `ContextGraphStorage.getParticipantAgents` result, with in-memory
   * caching keyed by the numeric id (so cleartext and numeric callers
   * share cache entries). Used to authenticate gossip envelopes on
   * cores that host curated CGs they are not members of — the local
   * meta-graph has no allowlist triples for such CGs, so without the
   * chain fallback every envelope would be rejected at
   * `verifyHostModeEnvelopeAuthority` and the LU-6 substrate would
   * never collect ciphertext for them.
   *
   * Cleartext → numeric resolution probes (in order):
   *   1. `subscribedContextGraphs[cgId].onChainId` (set by the
   *      curator on create and by chain-event auto-discovery).
   *   2. `BigInt(cgId)` parse (covers the publishes that address the
   *      CG by its numeric on-chain id directly — see PublishIntent
   *      shape and the matching `isCgCurated` resolver above).
   *
   * Returns `null` when no resolution path yields a positive-id
   * numeric (the caller treats `null` as "no allowlist → reject
   * defensively"); empty `[]` from the chain is cached and returned
   * as-is so a brand-new id doesn't keep paying RPC per envelope.
   */
  async resolveOnChainParticipantAgents(this: DKGAgent, contextGraphId: string): Promise<string[] | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    let numericId: bigint | null = null;
    // OT-RFC-38 / LU-6 Phase B — input may be cleartext (member-side
    // call), hash form (envelope from the wire), or already-numeric
    // (legacy publish path). Probe in cheapest-first order; we cache
    // by stringified numeric id below so an early hit reuses the
    // result regardless of which form the input took.
    //
    //   1. Direct hit on `subscribedContextGraphs` — covers cleartext
    //      (member local id) and hash form when the local node is a
    //      host-only core whose subscription key IS the hash.
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (sub?.onChainId) {
      try { numericId = BigInt(sub.onChainId); } catch { /* fall through */ }
    }
    //   2. Hash-form input where the local node is a MEMBER (the
    //      subscription is keyed by cleartext, not hash). Translate
    //      via the reverse index and re-probe.
    if (numericId === null && /^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      const localId = this.wireIdToLocalCgId.get(contextGraphId.toLowerCase());
      if (localId) {
        const memberSub = this.subscribedContextGraphs.get(localId);
        if (memberSub?.onChainId) {
          try { numericId = BigInt(memberSub.onChainId); } catch { /* fall through */ }
        }
      }
    }
    //   3. Cleartext-form input on a host-only core. Cores subscribed
    //      via the chain-event path keep their `subscribedContextGraphs`
    //      keyed by HASH (the curator-committed wire id), not cleartext.
    //      When a member's envelope arrives with cleartext in
    //      `contextGraphId` (the publish path keeps cleartext in the
    //      envelope for inner-consistency reasons — see
    //      `publishWorkspaceGossip`), the cleartext direct lookup at
    //      step 1 misses on the core. Hash the cleartext on-the-fly
    //      and re-probe before falling through to numeric parse.
    if (numericId === null && !/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      try {
        const computedHash = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
        const hostSub = this.subscribedContextGraphs.get(computedHash);
        if (hostSub?.onChainId) {
          try { numericId = BigInt(hostSub.onChainId); } catch { /* fall through */ }
        }
      } catch { /* malformed cleartext — fall through */ }
    }
    //   4. Numeric form input — accept it directly, but only AFTER the
    //      hash-form branch above. Otherwise a 32-byte hex hash would
    //      `BigInt(...)` cleanly and we'd treat its raw integer value
    //      as an on-chain id (it isn't — the on-chain id is sequential).
    if (numericId === null && !/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      try { numericId = BigInt(contextGraphId); } catch { /* not a numeric form */ }
    }
    if (numericId === null || numericId <= 0n) return null;

    const cacheKey = numericId.toString();
    const cached = this.onChainParticipantAgentsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached.length === 0 ? null : cached;
    }
    if (typeof this.chain.getContextGraphParticipantAgents !== 'function') {
      return null;
    }
    try {
      const agents = await this.chain.getContextGraphParticipantAgents(numericId);
      const normalised = Array.isArray(agents) ? agents : [];
      this.onChainParticipantAgentsCache.set(cacheKey, normalised);
      return normalised.length === 0 ? null : normalised;
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `resolveOnChainParticipantAgents: chain.getContextGraphParticipantAgents(${cacheKey}) failed — treating as UNKNOWN: ` +
        (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — chain-race / pre-reg fallback for the
   * authority check on host-only cores. Returns the curator EOA the
   * local node pinned for `contextGraphId` from a previously-
   * received & verified discovery beacon (`beaconCuratorByWireId`,
   * keyed by wire-id hash).
   *
   * Wired into {@link SharedMemoryHandler#beaconCuratorOracle} as the
   * tertiary fallback after the local meta-graph and the chain
   * oracle. Input may be cleartext (envelope payload) or hash form
   * (host-only-core subscription key); we hash on the fly when the
   * input doesn't already match the wire-id regex.
   *
   * Returning a single address (the curator) is intentional: during
   * the race window we want to admit ONLY the curator's writes, not
   * the eventual member set. Once the chain event lands the
   * `chainAgentGateOracle` returns the full participant list and
   * this fallback drops out naturally.
   */
  async resolveBeaconPinnedCuratorEoa(this: DKGAgent, contextGraphId: string): Promise<string | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    let wireId: string;
    if (/^0x[0-9a-fA-F]{64}$/.test(contextGraphId)) {
      wireId = contextGraphId.toLowerCase();
    } else {
      try {
        wireId = ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
      } catch {
        return null;
      }
    }
    const curatorEoa = this.beaconCuratorByWireId.get(wireId);
    if (!curatorEoa || !ethers.isAddress(curatorEoa)) return null;
    return ethers.getAddress(curatorEoa);
  }

  // ── OT-RFC-38 / LU-6 Phase B — wire-id translation surface ────────
  //
  // All SWM wire forms (gossip topic, envelope `contextGraphId`,
  // signing payload, LU-7 catchup, host-mode store keys) are keyed by
  // `onChainHash` — `keccak256(bytes(cleartextId))` lowercase 0x-
  // prefixed hex. The wire id is the same for every node so cores can
  // derive it directly from the `ContextGraphCreated.nameHash` event
  // topic without ever learning the cleartext.
  //
  // Local form, by contrast, is whatever the node knows: cleartext for
  // CG members (who learned it via create / curator invite) and the
  // hash itself for cores that only host (never were members). The
  // helpers below are the SINGLE translation surface — every place
  // that crosses the local↔wire boundary MUST go through them. Direct
  // string concatenation against the topic format string is a recipe
  // for the curator/host topic-fragmentation bug.
  //
  // For backwards compatibility with CGs created before Phase B (the
  // `onChainHash` mapping is empty), the helpers fall back to the
  // cleartext local id as the wire id. Those CGs never went through
  // the chain-anchored discovery path so this preserves their behavior
  // — they'll keep working with curator-driven explicit subscribes.

  /**
   * Resolve the gossip wire id (hash form) for a local CG id.
   *
   * Lookup order:
   *   1. `subscribedContextGraphs[localId].onChainHash` — populated by
   *      the register-on-chain success path, the chain-event auto-
   *      discovery handler, the join-approved payload handler, and
   *      the discovery-beacon listener.
   *   2. If `localId` already looks like a wire id (32-byte hex), use
   *      it directly — handles the "core hosting a CG it never joined"
   *      case where `localId === wireId === onChainHash`.
   *   3. Compute on-the-fly via `keccak256(bytes(localId))` for CGs
   *      we created locally but haven't yet registered (allows
   *      pre-registration discovery-beacon broadcast to use a
   *      stable wire id).
   *
   * Returns lowercase 0x-prefixed hex.
   */
  gossipWireIdFor(this: DKGAgent, localId: string): string {
    const sub = this.subscribedContextGraphs.get(localId);
    if (sub?.onChainHash) return this.contextGraphWireId(sub.onChainHash);
    return this.contextGraphWireId(localId);
  }

  /** Canonical cleartext-or-hash Context Graph identity used by every index path. */
  contextGraphWireId(this: DKGAgent, contextGraphId: string): string {
    if (/^0x[0-9a-f]{64}$/i.test(contextGraphId)) return contextGraphId.toLowerCase();
    return ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
  }

  /**
   * Derive the curator commitment for a LOCAL cleartext identifier.
   *
   * This deliberately hashes every string, including values that happen to
   * look like a 32-byte wire id. A hash-shaped user-chosen CG name is still
   * cleartext and its on-chain commitment is keccak256(utf8(name)). Host-only
   * subscriptions carry an explicit `onChainHash`, so callers never need to
   * guess which interpretation applies from the string shape alone.
   */
  contextGraphNameCommitment(this: DKGAgent, localId: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(localId)).toLowerCase();
  }

  /**
   * OT-RFC-39 Codex review (round 2) on PR #727:
   * `gossipWireIdFor(rawId)` would happily keccak a literal numeric
   * string ("42") as if it were cleartext, producing a hash that does
   * NOT equal the curator-committed `nameHash`. That's fine in any
   * context where the input is guaranteed to be either cleartext or
   * bare hex (gossip-topic construction, host-mode bookkeeping). The
   * LU-11 ciphertext-chunk-store named graph is more sensitive: a
   * remote requester / ACK PublishIntent may legitimately carry the
   * numeric on-chain id, and pinning a SPARQL `GRAPH` to the wrong
   * hash means the lookup misses every persisted chunk and declines
   * a valid publish (Bug #4) or returns `chunk not found` (Bug #5).
   *
   * This helper resolves the canonical wire form for chunk-store
   * routing OR returns null to signal "use wildcard `GRAPH ?g`
   * fallback" — caller's responsibility. Numeric ids that can't be
   * resolved through the local subscription map (chain replay hasn't
   * caught up; CG isn't locally registered) return null rather than
   * silently producing the wrong hash.
   *
   * Routing rules (first match wins):
   *   1. `0x[64-hex]`             → lowercase, already wire form
   *   2. Tracked in `subscribedContextGraphs` → `gossipWireIdFor` (returns the onChainHash)
   *   3. Pure decimal → `resolveLocalCgIdByOnChainId` then wire-form; null if unknown
   *   4. Everything else (cleartext) → `gossipWireIdFor` (keccak of the cleartext bytes)
   *
   * Rule 3 NEVER falls through to a raw keccak of the decimal string —
   * that would reproduce the exact bug Codex called out. The caller
   * MUST handle the null return by widening to a wildcard scan.
   */
  canonicalChunkStoreCgIdOrNull(this: DKGAgent, rawId: string): string | null {
    if (typeof rawId !== 'string' || rawId.length === 0) return null;
    if (/^0x[0-9a-fA-F]{64}$/.test(rawId)) return rawId.toLowerCase();
    if (this.subscribedContextGraphs.has(rawId)) return this.gossipWireIdFor(rawId);
    if (/^\d+$/.test(rawId)) {
      try {
        const local = this.resolveLocalCgIdByOnChainId(BigInt(rawId));
        if (local === null) return null;
        return this.gossipWireIdFor(local);
      } catch {
        return null;
      }
    }
    return this.gossipWireIdFor(rawId);
  }

  /**
   * Canonical key for the host-mode subscription bookkeeping maps
   * (`swmHostModeSubscribed`, `swmHostModeHandlers`).
   *
   * Codex PR #672 review `id=3302086589`: the four LU-6 Phase B
   * discovery paths (chain-event, beacon, reconciler, manual)
   * deliver the same CG to host-mode wiring in different shapes —
   * the chain-event and beacon paths already carry the curator-
   * committed wire hash, while the reconciler and manual paths
   * typically carry the cleartext local id (or whatever string the
   * operator POSTed). Without a single canonical key, a later
   * subscribe under a different shape misses `has()` and wires a
   * second handler on the same topic, doubling ingest and
   * persistence.
   *
   * We standardise on the WIRE FORM (curator-committed `nameHash`,
   * lowercase 0x-prefixed 32-byte hex) because it's the one shape
   * every path can reach without external lookups:
   * {@link gossipWireIdFor} already implements the reverse
   * cleartext→hash mapping (cache hit → on-chain hash; bare hex →
   * lowercased; otherwise `keccak256(utf8(cleartext))`, which IS the
   * curator-committed nameHash by definition).
   *
   * Thin alias today; kept as a separate method so the canonicalisation
   * intent is callsite-obvious and any future divergence between the
   * gossip topic key and the bookkeeping key can land in one place.
   */
  canonicalSwmHostModeKey(this: DKGAgent, rawCgId: string): string {
    return this.gossipWireIdFor(rawCgId);
  }

  /**
   * Resolve the local CG id from a wire id. Used by the receive path
   * to map an envelope's `contextGraphId` (hash) back to the local id
   * used as storage/SPARQL key.
   *
   * Returns:
   *   - cleartext id if the local node is a member of the CG
   *   - the hash itself if the local node hosts but isn't a member
   *     (cores' canonical local id IS the hash — this is the
   *     "I never knew the cleartext" path)
   *   - the input as-is for non-hash inputs (pre-Phase-B fallback,
   *     plus a safety net for callers that already passed cleartext
   *     by mistake)
   *
   * Never throws. Read-only.
   */
  localCgIdForWireId(this: DKGAgent, wireId: string): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(wireId)) return wireId;
    const lower = wireId.toLowerCase();
    const localId = this.wireIdToLocalCgId.get(lower);
    if (localId) return localId;
    // Not a known member CG — return the hash as the local id. This
    // is the canonical "host-only core" path: the core's
    // subscribedContextGraphs is keyed by the hash and there's no
    // cleartext to recover.
    return lower;
  }

  /** Bind a name-hash event to its indexed cleartext or hash-only subscription. */
  bindOnChainContextGraphIdFromNameHash(
    this: DKGAgent,
    nameHash: string,
    onChainContextGraphId: string,
    options?: { persist?: boolean },
  ): string | null {
    const wireId = this.contextGraphWireId(nameHash);
    // Chain events may only enrich a subscription that explicitly indexed this
    // commitment. Falling back to `localId === wireId` is ambiguous: a user may
    // legitimately choose a cleartext id that itself looks like a 32-byte hash.
    // Host-only records are indexed under their explicit `onChainHash`, so the
    // reverse map covers both safe cases without a shape-based fallback.
    const localId = this.wireIdToLocalCgId.get(wireId);
    if (localId === undefined) return null;
    const current = this.subscribedContextGraphs.get(localId);
    if (current === undefined) return null;
    const next = { ...current };
    this.bindSubscriptionOnChainId(localId, next, onChainContextGraphId);
    next.onChainHash = wireId;
    this.setContextGraphSubscription(localId, next, options);
    return localId;
  }

  /**
   * Compatibility adapter for callers that only enrich an existing
   * subscription's wire id. The canonical subscription mutator owns both the
   * forward record and reverse index update.
   *
   * Pass `null` to clear the curator commitment and restore the canonical
   * local-id-derived reverse mapping.
   */
  recordCgWireId(this: DKGAgent, localId: string, wireId: string | null): void {
    const sub = this.subscribedContextGraphs.get(localId);
    if (sub === undefined) return;
    this.setContextGraphSubscription(localId, {
      ...sub,
      onChainHash: wireId ? this.contextGraphWireId(wireId) : undefined,
    }, { persist: false });
  }

  /**
   * Issue #865 — single source of truth for "what does this CG's
   * explicit accessPolicy say". Returns `'public'` / `'private'` if
   * an `accessPolicy` triple is present in either the ONTOLOGY graph
   * or this CG's `_meta` graph, otherwise `null` (no explicit
   * policy written — fall through to callers' legacy heuristics).
   *
   * Extracted so `isPrivateContextGraph` (read-path routing) and
   * `warnIfAllowlistWriteOnPublicCg` (write-path observability) can
   * never drift on the policy-resolution rules. If we ever add a new
   * policy value, the parsing fix lands in one place.
   */
  async getExplicitAccessPolicy(this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<'public' | 'private' | null> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return null;
    }
    const policyValue = (await this.getCgMeta(contextGraphId, { signal: options.signal })).accessPolicy?.trim().toLowerCase();
    if (policyValue === 'public') return 'public';
    if (policyValue === 'private') return 'private';
    // Defensive: any unknown literal (e.g. a future policy value the
    // older agent code doesn't recognize) is reported as `null` so
    // callers fall through to the legacy heuristic instead of
    // mis-routing on an opaque string.
    return null;
  }

  /**
   * Issue #865 — observability hook for the invite write paths. Emits a
   * warn log when the caller writes an allowlist quad on a CG that
   * carries an explicit `accessPolicy="public"` triple. We don't
   * throw here:
   *
   *   1. `publishPolicy=curated` on a public-discoverable CG is a
   *      legitimate combo (allowlist gates publishers, subscribers
   *      stay public). Rejecting would break it.
   *   2. The primary `isPrivateContextGraph` fix already prevents the
   *      original bug (silent re-route to the curated publish path).
   *   3. Pre-existing tests and adapter flows create CGs with no
   *      explicit accessPolicy and then invite — those should keep
   *      working.
   *
   * The warn line is the documentation: it tells the operator
   * "your allowlist write landed but read access stays open per the
   * explicit accessPolicy=public" so the next publisher confusion
   * has an obvious breadcrumb. Read-only, single SELECT (delegated
   * to `getExplicitAccessPolicy`) — does not mutate state.
   *
   * Codex review rounds 1, 4, and 5 on #873 — callers MUST defer
   * this until AFTER `store.insert(quadsToInsert)` succeeds. Two
   * constraints converge on the post-insert call site:
   *
   *   - Round 1 / round 4 (idempotency): logging when no quad
   *     would be inserted (no-op re-invite) misleads operators
   *     about which writes hit the store.
   *   - Round 5 (state truthfulness): logging BEFORE the insert
   *     resolves leaves a phantom breadcrumb if the insert throws.
   *
   * The current call sites in `inviteToContextGraph` /
   * `inviteAgentToContextGraph` fire this AFTER the awaited insert
   * (gated on `!alreadyAllowed` for the agent path's
   * delegation-only refresh case), so the warn is a faithful
   * record of persisted state and the wording is past-tense.
   */
  async warnIfAllowlistWriteOnPublicCg(this: DKGAgent,
    contextGraphId: string,
    ctx: OperationContext,
    operation: string,
  ): Promise<void> {
    const policy = await this.getExplicitAccessPolicy(contextGraphId);
    if (policy !== 'public') return;
    this.log.warn(
      ctx,
      `${operation}: wrote allowlist quad on context graph "${contextGraphId}" which has explicit accessPolicy="public". ` +
        `The persisted quad does NOT enforce read access — anyone can still subscribe. ` +
        `Issue #865: as of this commit, the publisher no longer auto-flips public CGs to the curated publish path ` +
        `just because an allowlist exists. If you intended to make this CG invite-only, recreate it with accessPolicy=1.`,
    );
  }

  async isPrivateContextGraph(this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return false;
    }

    // Issue #865 — explicit `accessPolicy` ALWAYS wins over the allowlist
    // heuristic below. The previous behavior fell through to the ASK
    // check whenever `policy` was anything other than `"private"`, which
    // silently flipped a CG the curator explicitly created with
    // `accessPolicy="public"` into "private" the moment ANY invite landed
    // (`DKG_ALLOWED_AGENT` / `DKG_ALLOWED_PEER` write in `_meta`). The
    // publisher then took the LU-5 / LU-11 curated path, the publish
    // hung waiting for V2 ACKs from invitees, and the user had no
    // recovery path short of recreating the CG.
    //
    // Semantics post-#865: an allowlist on a public CG is INFORMATIONAL
    // (matches on-chain `accessPolicy=0` which the contract does not
    // enforce). Curator can still see "who I would have invited" in the
    // member list, but the publisher stays on the plaintext / public
    // path so cores can verify against SWM and the on-chain tx
    // actually submits.
    //
    // Codex review on #873 — policy lookup now delegated to the
    // shared `getExplicitAccessPolicy()` helper so this routing
    // function and the invite-path warning helper can never drift.
    const policy = await this.getExplicitAccessPolicy(contextGraphId, { signal: options.signal });
    if (policy === 'private') return true;
    if (policy === 'public') return false;
    // policy === null falls through to the legacy heuristic below.

    // Legacy / discovered-CG fallback: when no explicit `accessPolicy`
    // triple exists (e.g. an old CG materialized before the predicate
    // was added, or a peer-only CG discovered via gossip without
    // ontology bootstrap), treat the presence of an allowlist
    // predicate as the curated signal. Both the V10 agent model AND
    // the legacy peer-ID model need to be recognized here so the
    // store-discovery path doesn't misclassify a freshly-invited CG
    // as "open / discoverable only" and skip the same-connect catchup.
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    return meta.hasAgentGate || meta.hasPeerGate;
  }

  async getPrivateContextGraphParticipants(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    // the participant set is read from the in-memory meta projection
    // (getCgMeta), NOT a direct store query — the projection is the only place
    // that applies revokedAgents filtering, so a store-only read (main's A2
    // form) would silently re-authorize revoked agents. `options.signal` is
    // accepted for caller parity with the abort-hardened siblings but the
    // projection read is in-memory and has no I/O to cancel.
    void options;
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value);
    };
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    const revoked = new Set(meta.revokedAgents.map((agent) => agent.toLowerCase()));
    const addAgent = (value: string | undefined) => {
      if (!value || revoked.has(value.toLowerCase())) return;
      add(value);
    };

    const localAgentParticipants = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents;
    if (localAgentParticipants) {
      for (const p of localAgentParticipants) addAgent(p);
    }

    for (const agent of meta.allowedAgents) addAgent(agent);
    for (const agent of meta.participantAgents) addAgent(agent);
    for (const identityId of meta.participantIdentityIds) add(identityId);

    if (merged.length > 0) return merged;

    // LU-2: on-chain CGs no longer expose `getContextGraphParticipants`.
    // Locally-stored allowedAgents/participantAgents/participantIdentityIds
    // (`merged` above) are the only authoritative source.
    return null;
  }

  /**
   * Re-sync the meta graph for a private CG from the curator to pick up
   * newly added participants. Rate-limited to avoid abuse.
   * Returns true if meta was refreshed, false if skipped or failed.
   */
  public async resolveCuratorPeerId(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    return (await resolveCuratorSyncPeer(
      this,
      this.preferredSyncPeers,
      contextGraphId,
      options,
    )).peerId;
  }

  async refreshMetaFromCurator(
    this: DKGAgent,
    contextGraphId: string,
    options: CuratorMetaRefreshOptions = {},
  ): Promise<boolean> {
    return runCuratorMetaRefresh(this, contextGraphId, options);
  }

  /**
   * List all known context graphs by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   *
   * Rows are backfilled from `_meta` with `DKG_CURATOR` when missing — open CGs only publish
   * curator triples locally in `_meta` while definitions sync on ONTOLOGY.
   *
   * With a valid `callerAgentAddress` option, each row includes `callerInvolved`.
   * With no usable caller wallet, omit that field entirely so callers can infer membership from `curator`.
   */
  async listContextGraphs(this: DKGAgent, opts?: { callerAgentAddress?: string | null }): Promise<ListContextGraphsRow[]> {
    if (listContextGraphsProjectionEnabled()) {
      return this.listContextGraphsFromProjection(opts);
    }

    const scopedListing = opts !== undefined;
    let checksum: string | null = null;
    const rawCaller = opts?.callerAgentAddress?.trim();
    if (rawCaller && ethers.isAddress(rawCaller)) {
      try {
        checksum = ethers.getAddress(rawCaller);
      } catch {
        checksum = null;
      }
    }

    const cloneRows = (rows: ListContextGraphsRow[]): ListContextGraphsRow[] => rows.map((row) => ({ ...row }));
    const cacheKey = checksum
      ? `wallet:${checksum.toLowerCase()}`
      : scopedListing ? 'no-wallet' : 'owner-unscoped';
    const cacheEnabled = this.listContextGraphsCacheAllowed()
      && DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS > 0;
    const cacheTtlMs = cacheEnabled ? DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_TTL_MS : 0;
    if (cacheEnabled) {
      const cached = this.listContextGraphsCache.get(cacheKey);
      if (cached) {
        if (cached.expiresAt > this.listContextGraphsCacheNow()) {
          this.listContextGraphsCache.delete(cacheKey);
          this.listContextGraphsCache.set(cacheKey, cached);
          return cloneRows(cached.rows as ListContextGraphsRow[]);
        }
        this.listContextGraphsCache.delete(cacheKey);
      }
    }

    if (cacheEnabled) {
      const inFlight = this.listContextGraphsInFlight.get(cacheKey);
      if (inFlight) {
        return cloneRows((await inFlight) as ListContextGraphsRow[]);
      }
    }

    const generation = this.listContextGraphsCacheGeneration;
    const task = (async () => {
      const result = await this.listContextGraphsUncached(checksum, scopedListing);
      const rows = result.rows;
      if (cacheEnabled && result.cacheable && this.listContextGraphsCacheGeneration === generation) {
        this.listContextGraphsCache.set(cacheKey, {
          expiresAt: this.listContextGraphsCacheNow() + cacheTtlMs,
          rows: cloneRows(rows) as Array<Record<string, unknown>>,
        });
        while (this.listContextGraphsCache.size > DKGAgentBase.LIST_CONTEXT_GRAPHS_CACHE_MAX) {
          const oldest = this.listContextGraphsCache.keys().next().value;
          if (!oldest) break;
          this.listContextGraphsCache.delete(oldest);
        }
      }
      return rows;
    })();

    if (cacheEnabled) {
      this.listContextGraphsInFlight.set(cacheKey, task as Promise<Array<Record<string, unknown>>>);
    }
    try {
      return cloneRows(await task);
    } finally {
      if (cacheEnabled && this.listContextGraphsInFlight.get(cacheKey) === task) {
        this.listContextGraphsInFlight.delete(cacheKey);
      }
    }
  }

  protected async listContextGraphsUncached(this: DKGAgent, checksum: string | null, scopedListing: boolean): Promise<ListContextGraphsUncachedResult> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const rowBudgetMs = Math.max(1, DKGAgentBase.LIST_CONTEXT_GRAPHS_ROW_BUDGET_MS);
    const scanBudgetMs = Math.max(rowBudgetMs, DKGAgentBase.LIST_CONTEXT_GRAPHS_SCAN_BUDGET_MS);
    const authBudgetMs = Math.max(rowBudgetMs, DKGAgentBase.LIST_CONTEXT_GRAPHS_AUTH_BUDGET_MS);
    let cacheable = true;

    const withBudget = async <T>(
      work: (signal: AbortSignal) => Promise<T>,
      label: string,
      budgetMs = rowBudgetMs,
    ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controller = new AbortController();
      const timeoutError = new ListContextGraphsBudgetExceeded(label);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            // For pre-dispatch stores this signal cannot interrupt an in-flight
            // synchronous native query, but it still bounds async work wrapped in
            // the same lookup, such as chain/RPC membership checks.
            controller.abort(timeoutError);
            reject(timeoutError);
          },
          budgetMs,
        );
      });
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => work(controller.signal)),
          timeout,
        ]);
        return { ok: true, value };
      } catch (error) {
        if (!(error instanceof ListContextGraphsBudgetExceeded)) {
          throw error;
        }
        return { ok: false, error };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const optional = async <T>(work: (signal: AbortSignal) => Promise<T>, label: string): Promise<T | undefined> => {
      const result = await withBudget(work, label);
      if (result.ok) return result.value;
      cacheable = false;
      return undefined;
    };

    const initialRead = await withBudget(
      (signal) => this.store.query(`
      SELECT ?ctxGraph ?name ?desc ?creator ?created ?curator ?access ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_CONTEXT_GRAPH}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `, { signal }),
      'ontology/agents definition scan',
      scanBudgetMs,
    );
    if (!initialRead.ok) {
      throw initialRead.error instanceof Error
        ? initialRead.error
        : new Error(`listContextGraphs primary definition scan failed: ${String(initialRead.error)}`);
    }
    const result = initialRead.value;

    const prefix = 'did:dkg:context-graph:';
    const seen = new Map<string, ListContextGraphsRow>();
    const privacyByUri = new Map<string, ListContextGraphsPrivacy>();
    const policyPrivacy = (value: unknown): ListContextGraphsPrivacy => {
      if (typeof value !== 'string') return 'unknown';
      const normalized = stripLiteral(value).trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (normalized === 'public' || normalized === 'private') return normalized;
      return 'unknown';
    };
    const rememberRow = (row: ListContextGraphsRow, privacy: ListContextGraphsPrivacy): void => {
      if (seen.has(row.uri)) return;
      seen.set(row.uri, row);
      privacyByUri.set(row.uri, privacy);
    };

    if (result?.type === 'bindings') {
      const byUri = new Map<string, Record<string, string>>();
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['ctxGraph'] ?? '';
        if (!uri || byUri.has(uri)) continue;
        byUri.set(uri, row);
      }
      // Bounded parallel lookups avoid multiplying latency without flooding
      // the store scheduler when the registry contains hundreds of rows.
      const definitionSettled = await mapContextGraphListRowsSettled([...byUri.values()], async (row) => {
        const uri = row['ctxGraph'] ?? '';
        if (seen.has(uri)) return;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedContextGraphs.get(id);
        const onChainId = sub?.onChainId ?? (await optional(
          (signal) => this.getContextGraphOnChainId(id, { signal }),
          `on-chain id lookup for ${id}`,
        )) ?? undefined;
        const accessPolicy = row['access'] ? stripLiteral(row['access']) : undefined;
        rememberRow({
          id,
          uri,
          name: stripLiteral(row['name'] ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(accessPolicy ? { accessPolicy } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: !!row['isSystem'],
          subscribed: sub?.subscribed ?? false,
          // `synced` now means "we've actually pulled CG data from a peer
          // and stored it locally" — not "we've seen the definition
          // triple gossip across ONTOLOGY/AGENTS." The earlier behaviour
          // hard-coded `true` here, which made every gossip-discovered
          // CG look fully synced and let stale public CGs (curators
          // long gone) persist in the Oracle browse catalogue
          // indefinitely. Now `synced` mirrors the daemon's authoritative
          // subscription state set by the catchup runner (see
          // `markContextGraphSubscriptionState` at routes/context-graph.ts:1301).
          synced: sub?.synced ?? false,
          ...(onChainId ? { onChainId } : {}),
        }, policyPrivacy(row['access']));
      });
      for (const entry of definitionSettled) {
        if (entry.status === 'rejected') throw entry.reason;
      }
    }

    // Curated CGs store their definition in their own _meta graph, not in
    // ONTOLOGY. Check _meta for any subscribed CGs not yet found above.
    for (const [id, sub] of this.subscribedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const metaGraph = contextGraphMetaGraphUri(id);
      const pUri = contextGraphDataGraphUri(id);
      const metaRead = await withBudget(
        (signal) => this.store.query(`
        SELECT ?name ?desc ?creator ?created ?curator ?access WHERE {
          GRAPH <${metaGraph}> {
            <${pUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?access }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          }
        } LIMIT 1
      `, { signal }),
        `meta declaration lookup for ${id}`,
      );
      if (!metaRead.ok) cacheable = false;
      const metaResult = metaRead.ok ? metaRead.value : undefined;

      if (metaResult?.type === 'bindings' && metaResult.bindings.length > 0) {
        const row = metaResult.bindings[0] as Record<string, string>;
        const onChainId = sub.onChainId ?? (await optional(
          (signal) => this.getContextGraphOnChainId(id, { signal }),
          `on-chain id lookup for ${id}`,
        )) ?? undefined;
        const accessPolicy = row['access'] ? stripLiteral(row['access']) : undefined;
        rememberRow({
          id,
          uri,
          name: stripLiteral(row['name'] ?? sub.name ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          ...(row['curator'] ? { curator: row['curator'] } : {}),
          ...(accessPolicy ? { accessPolicy } : {}),
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: false,
          subscribed: sub.subscribed,
          synced: sub.synced,
          ...(onChainId ? { onChainId } : {}),
        }, policyPrivacy(row['access']));
        continue;
      }

      // No declaration in ontology, agents, or _meta graphs. Three cases:
      //
      //  1. Chain-attested but not-yet-synced (sub.onChainId set):
      //     auto-discovery from the on-chain registry found this CG and
      //     subscribed us. Surface it as subscribed+synced=false so the
      //     UI can show a legitimate "waiting for sync" state. Any
      //     genuinely inaccessible curated CG will be removed from
      //     `subscribedContextGraphs` by the daemon's authoritative
      //     denial path (accessDeniedPeers > 0) before we get here.
      //
      //  2. Curator-approved but not-yet-meta-synced (sub.pendingMeta
      //     set): the join-approved handler subscribed us seconds ago
      //     and the first meta sync hasn't completed yet. Same UX
      //     treatment as case 1 — surface as "waiting for sync" so the
      //     project entry shows up in the sidebar immediately on
      //     approval, instead of disappearing for ~107s until the
      //     periodic catchup reconciler eventually pulls _meta. Cleared
      //     in `refreshMetaSyncedFlags` once meta arrives, at which
      //     point this entry instead surfaces via the `_meta` branch
      //     above.
      //
      //  3. Not chain-attested, not pending-meta, AND no local content:
      //     a truly phantom entry (pre-discovery subscribe that never
      //     resolved). Hide it to avoid polluting the UI. If the user
      //     legitimately subscribes later, the next catch-up writes
      //     _meta or data and the entry will appear on the next
      //     refresh.
      if (!sub.onChainId && !sub.pendingMeta) {
        // Delegate to `contextGraphHasLocalContent()` so the check
        // covers sub-graphs, assertion graphs and SWM — not just the
        // root data graph. For any non-trivial project the root data
        // graph is routinely empty (content lives in `/tasks`,
        // `/chat`, `/assertion/...`, `_shared_memory`), and checking
        // only the root caused legitimate synced projects to be
        // hidden as phantoms here (Codex tier-4m follow-up to N29,
        // same issue in a separate call site).
        const contentRead = await withBudget(
          (signal) => this.contextGraphHasLocalContent(id, { signal }),
          `local content probe for ${id}`,
        );
        if (!contentRead.ok) cacheable = false;
        if (contentRead.ok && !contentRead.value) continue;
      }

      rememberRow({
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
        ...(sub.onChainId ? { onChainId: sub.onChainId } : {}),
      }, 'unknown');
    }

    const storedRead = await withBudget(
      async (signal) => {
        const graphs = this.store.listGraphsByPrefix
          ? await this.store.listGraphsByPrefix(prefix, { signal })
          : (await this.store.listGraphs({ signal })).filter((graph) => graph.startsWith(prefix));
        const contextGraphs = new Set<string>();
        for (const graph of graphs) {
          const rest = graph.slice(prefix.length);
          const id = rest.endsWith('/_meta')
            ? rest.slice(0, -6)
            : rest.endsWith('/_private')
              ? rest.slice(0, -9)
              : rest.endsWith('/_shared_memory_meta')
                ? rest.slice(0, -20)
                : rest.endsWith('/_shared_memory')
                  ? rest.slice(0, -15)
                  : rest;
          if (!id.includes('/')) contextGraphs.add(id);
        }
        return [...contextGraphs];
      },
      'storage context graph scan',
      scanBudgetMs,
    );
    if (!storedRead.ok) {
      throw storedRead.error instanceof Error
        ? storedRead.error
        : new Error(`listContextGraphs storage graph scan failed: ${String(storedRead.error)}`);
    }
    const storedContextGraphs = storedRead.value;
    for (const id of storedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;

      const contentRead = await withBudget(
        (signal) => this.contextGraphHasLocalContent(id, { signal }),
        `storage content probe for ${id}`,
      );
      if (!contentRead.ok) cacheable = false;
      if (contentRead.ok && !contentRead.value) continue;

      const sub = this.subscribedContextGraphs.get(id);
      const onChainId = sub?.onChainId ?? (await optional(
        (signal) => this.getContextGraphOnChainId(id, { signal }),
        `on-chain id lookup for ${id}`,
      )) ?? undefined;
      const policyRead = await withBudget(
        (signal) => this.getExplicitAccessPolicy(id, { signal }),
        `access policy lookup for storage row ${id}`,
      );
      if (!policyRead.ok) cacheable = false;
      const accessPolicy = policyRead.ok && policyRead.value ? policyRead.value : undefined;
      rememberRow({
        id,
        uri,
        name: sub?.name ?? id,
        isSystem: false,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        ...(accessPolicy ? { accessPolicy } : {}),
        ...(onChainId ? { onChainId } : {}),
      }, accessPolicy ?? 'unknown');
    }

    let rows = Array.from(seen.values());

    /**
     * Normalize metadata through the keyed projection before privacy filtering.
     * Raw discovery can see stale ONTOLOGY and authoritative AGENTS/_meta rows
     * for the same CG; projection resolves policy with _meta-first source
     * precedence, then AGENTS, then ONTOLOGY.
     */
    const projectedRows = await mapContextGraphListRowsSettled(rows, async (r) => {
      const metaRead = await withBudget(
        (signal) => this.getCgMeta(r.id, { signal }),
        `projection lookup for ${r.id}`,
      );
      if (!metaRead.ok) {
        cacheable = false;
        // Projection is the authoritative privacy source. The pre-projection
        // seed in `privacyByUri` can come from possibly-stale ONTOLOGY discovery
        // and may be stale-public for a CG that is authoritatively private
        // (_meta/AGENTS). If projection times out, drop only stale-public seeds
        // so resolveRowPrivacy() routes through the scoped legacy authoritative
        // lookup / fail-closed path instead of serving it as explicit-public.
        // Preserve existing private seeds as a conservative fail-closed signal.
        if (privacyByUri.get(r.uri) === 'public') privacyByUri.delete(r.uri);
        return r;
      }
      const meta = metaRead.value;
      const accessPolicy = meta.accessPolicy ?? r.accessPolicy;
      const privacy = policyPrivacy(accessPolicy);
      if (privacy !== 'unknown') privacyByUri.set(r.uri, privacy);
      return {
        ...r,
        name: meta.name ?? r.name,
        description: meta.description ?? r.description,
        creator: meta.creator ?? r.creator,
        curator: meta.curator ?? r.curator,
        ...(accessPolicy ? { accessPolicy } : {}),
        createdAt: meta.createdAt ?? r.createdAt,
        isSystem: meta.isSystem || r.isSystem,
        onChainId: meta.onChainId ?? r.onChainId,
      };
    });
    rows = projectedRows.map((entry) => {
      if (entry.status === 'fulfilled') return entry.value;
      throw entry.reason;
    });

    const curatorBackfills = await mapContextGraphListRowsSettled(rows, async (r) => {
      if (r.curator?.trim()) return r;
      const c = await optional(
        (signal) => this.getContextGraphCurator(r.id, { signal }),
        `curator lookup for ${r.id}`,
      );
      return c ? { ...r, curator: c } : r;
    });
    rows = curatorBackfills.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      throw entry.reason;
    });

    const resolveRowPrivacy = async (row: ListContextGraphsRow): Promise<ListContextGraphsPrivacy> => {
      const explicitPrivacy = privacyByUri.get(row.uri) ?? 'unknown';
      if (explicitPrivacy !== 'unknown') return explicitPrivacy;
      if (!scopedListing) return 'unknown';
      const legacyRead = await withBudget(
        (signal) => this.isPrivateContextGraph(row.id, { signal }),
        `legacy privacy lookup for ${row.id}`,
      );
      if (!legacyRead.ok) {
        cacheable = false;
        return 'unknown';
      }
      return legacyRead.value ? 'private' : 'public';
    };
    const privacySettled = await mapContextGraphListRowsSettled(rows, async (row) => ({
      uri: row.uri,
      privacy: await resolveRowPrivacy(row),
    }));
    const resolvedPrivacyByUri = new Map<string, ListContextGraphsPrivacy>();
    for (const entry of privacySettled) {
      if (entry.status === 'fulfilled') {
        resolvedPrivacyByUri.set(entry.value.uri, entry.value.privacy);
      } else {
        throw entry.reason;
      }
    }
    const rowPrivacy = (row: ListContextGraphsRow): ListContextGraphsPrivacy =>
      resolvedPrivacyByUri.get(row.uri) ?? 'unknown';

    if (!checksum) {
      // Without a caller wallet we still leave `callerInvolved` unset so the UI can use the
      // curator-vs-identity fallback for OPEN graphs.
      return {
        rows: rows.filter((r) => {
          const privacy = rowPrivacy(r);
          if (privacy === 'private') return false;
          if (privacy === 'unknown') return !scopedListing;
          return true;
        }),
        cacheable,
      };
    }

    const annotatedSettled = await mapContextGraphListRowsSettled(rows, async (r): Promise<{
      row: ListContextGraphsRow;
      privacy: ListContextGraphsPrivacy;
    }> => {
      const privacy = rowPrivacy(r);
      const curatorMatch = this.curatorDidMatchesChecksumAgent(r.curator, checksum);
      if (curatorMatch) {
        return { row: { ...r, callerInvolved: true }, privacy };
      }
      let usedLiveChainAuth = false;
      const allowlistRead = await withBudget(
        (signal) => this.callerIsAllowlistedAgentParticipant(r.id, checksum, {
          onChainLookup: () => { usedLiveChainAuth = true; },
          signal,
        }),
        `allowlist lookup for ${r.id}`,
        authBudgetMs,
      );
      if (usedLiveChainAuth) cacheable = false;
      if (!allowlistRead.ok) cacheable = false;
      // `callerInvolved` must reflect ONLY the provided caller wallet.
      // Using local node identity (`creatorIsSelf`) leaks curated rows to unrelated callers.
      if (!allowlistRead.ok) return { row: r, privacy };
      return { row: { ...r, callerInvolved: allowlistRead.value }, privacy };
    });
    const annotated = annotatedSettled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      throw entry.reason;
    });

    return {
      rows: annotated
        .filter(({ row, privacy }) => {
          if (row.callerInvolved === true) return true;
          if (privacy === 'unknown') return false;
          if (privacy === 'private') return false;
          return true;
        })
        .map(({ row }) => row),
      cacheable,
    };
  }

}
