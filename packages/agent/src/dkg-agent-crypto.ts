// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace-encryption / sender-key subsystem extracted from dkg-agent.ts as
 * a mixin holder: recipient/gate resolution, on-chain access-policy reads,
 * SWM sender-key epoch creation + distribution, pending-package queueing,
 * encrypt/decrypt of workspace payloads, and sender-key state persistence.
 * 1:1 move; methods take `this: DKGAgent` so cross-calls resolve against the
 * composed class.
 */


import { collectProjectedDelegatees } from './internal/workspace-projected-delegatees.js';
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
  logKaLifecycleEvent,
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
  tryCanonicalPeerIdString,
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, createRpcTimeoutError, enrichEvmError, withRpcRequestContext, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  resolveWorkspaceAgentRecipients,
  resolveWorkspaceAgentRecipientKeys,
  isWorkspaceAgentEncryptionKeyMissingError,
  WorkspaceAgentEncryptionKeyMissingError,
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
import {
  resolveActivePublicContextGraphChainProof as resolveStrictActivePublicChainProof,
  type ActivePublicContextGraphChainProof,
} from './active-public-context-graph-chain-proof.js';
import {
  resolveContextGraphAgentGateAuthorityDecision,
} from './internal/context-graph-authority/context-graph-agent-gate-authority.js';
import {
  resolveLiveOnChainAccessPolicyState as resolveLiveAccessPolicyState,
  type LiveOnChainAccessPolicyState,
} from './internal/context-graph-authority/context-graph-access-policy.js';
import {
  createContextGraphAuthorityError,
  createRecipientAuthorityChangedError,
  isContextGraphAuthorityUnavailableMarker,
  isRetryableContextGraphAuthorityUnavailableReason,
  type ContextGraphAgentGateAuthority,
} from './internal/context-graph-authority/context-graph-authority.js';
import type { RegisteredContextGraphAuthority } from './registered-context-graph-authority.js';
import {
  resolveSwmMemberRecoveryAuthorityDecision,
  resolveSwmRegisteredAuthorityDecision,
  resolveSwmTransportAuthorityDecision,
  type SwmRegisteredAuthorityReadOptions,
  type SwmTransportAuthority,
} from './internal/context-graph-authority/swm-transport-authority.js';
import { noRosterFrom } from './internal/context-graph-authority/unanswered-authority-read.js';

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
import { SyncTargetSupersededError } from './sync/error-tags.js';
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope, type SyncPhase } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { registerSyncHandler } from './sync/responder/sync-handler.js';
import { runSyncOnConnect } from './sync/on-connect/sync-on-connect.js';
import { resolveAssetUalFromKaIdentity } from './ka-identity.js';

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
import { FinalizationHandler } from './finalization-handler.js';
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
  SWM_RECIPIENT_KEY_FETCH_WAIT_MS,
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
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import { raceWithBootTimeout, isTransientBootChainError } from './dkg-agent-boot.js';
import {
  isBoundedOperationTimeoutError,
  runBoundedOperation,
} from './bounded-operation.js';
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
  computeSwmSenderKeyRecipientRouteHash,
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

import {
  isCanonicalPositiveContextGraphId,
  localContextGraphIdMatchesCommittedNameHash,
} from './context-graph-binding-state.js';
import {
  CONTEXT_GRAPH_AUTHORITY_RPC_SITES as CG_AUTH_RPC_SITES,
  withRpcUsageSite,
} from '@origintrail-official/dkg-chain';

const KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS = 50;
const SWM_RECIPIENT_AUTHORITY_STABILITY_ATTEMPTS = 3;

/** One completed collect, with the check that nothing it depends on moved since it started. */
interface RecipientSnapshot {
  readonly resolution: WorkspaceAgentRecipientResolution;
  readonly stayedCurrent: () => boolean;
}

type ContextGraphSlotBindingOutcome =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  | { kind: 'unprovable' }
  | { kind: 'transportFailure'; error: unknown };

export type ContextGraphSlotBindingMode =
  | 'legacy-policy'
  | 'chain-attested-repair'
  | 'retryable-durable';

type PublicPolicySlotBindingMode = Exclude<
  ContextGraphSlotBindingMode,
  'retryable-durable'
>;

function mapContextGraphSlotBindingOutcome(
  outcome: ContextGraphSlotBindingOutcome,
  mode: ContextGraphSlotBindingMode,
): boolean {
  if (outcome.kind === 'match') return true;
  if (outcome.kind === 'unprovable') return mode === 'legacy-policy';
  if (outcome.kind === 'transportFailure' && mode !== 'legacy-policy') {
    throw outcome.error;
  }
  return false;
}

function evaluateContextGraphSlotBindingCommitment(
  contextGraphId: string,
  onChainId: string,
  onChainHash: string | null,
  allowNumericSelfAddress: boolean,
  isWireIdKeyedSubscription: (localId: string) => boolean,
  warn: (message: string) => void,
): ContextGraphSlotBindingOutcome {
  let numericId: bigint;
  try {
    numericId = BigInt(onChainId);
  } catch {
    return { kind: 'unprovable' };
  }
  if (numericId <= 0n) return { kind: 'unprovable' };

  const trimmed = contextGraphId.trim();
  if (
    allowNumericSelfAddress
    && /^\d+$/.test(trimmed)
    && trimmed === numericId.toString()
  ) {
    return { kind: 'match' };
  }
  if (!onChainHash || !/^0x[0-9a-fA-F]{64}$/.test(onChainHash)) {
    warn(
      `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} has NO `
      + 'valid committed name-hash — cannot affirmatively bind identity (slot reused on a fresh chain?). '
      + 'Treating CG as NOT public (fail-closed).',
    );
    return { kind: 'mismatch' };
  }
  if (localContextGraphIdMatchesCommittedNameHash(
    trimmed,
    onChainHash,
    isWireIdKeyedSubscription,
  )) return { kind: 'match' };

  warn(
    `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} commits `
    + `name-hash ${onChainHash.toLowerCase()} that does not match this CG's local identity — `
    + 'local mapping is STALE (slot reused on a fresh chain?). Treating CG as NOT public (fail-closed).',
  );
  return { kind: 'mismatch' };
}

async function evaluateContextGraphSlotBinding(
  chain: ChainAdapter,
  contextGraphId: string,
  onChainId: string,
  opCtx: OperationContext | undefined,
  signal: AbortSignal | undefined,
  allowNumericSelfAddress: boolean,
  isWireIdKeyedSubscription: (localId: string) => boolean,
  warn: (ctx: OperationContext, message: string) => void,
  raceRead: <T>(
    start: () => Promise<T>,
    label: string,
    readSignal?: AbortSignal,
  ) => Promise<T | typeof TIMEOUT_SENTINEL>,
  /** The deadline `raceRead` applies; quoted in the fail-closed diagnostic. */
  readTimeoutMs: number = CHAIN_POLICY_READ_TIMEOUT_MS,
): Promise<ContextGraphSlotBindingOutcome> {
  let numericId: bigint;
  try {
    numericId = BigInt(onChainId);
  } catch {
    return { kind: 'unprovable' };
  }
  if (numericId <= 0n) return { kind: 'unprovable' };

  const trimmed = contextGraphId.trim();
  if (
    allowNumericSelfAddress
    && /^\d+$/.test(trimmed)
    && trimmed === numericId.toString()
  ) {
    return { kind: 'match' };
  }
  const getNameHash = chain.getContextGraphNameHash;
  if (typeof getNameHash !== 'function') return { kind: 'unprovable' };

  let onChainHash: string | null | typeof TIMEOUT_SENTINEL;
  try {
    onChainHash = await raceRead(
      () => signal
        ? getNameHash.call(chain, numericId, { signal })
        : getNameHash.call(chain, numericId),
      `getContextGraphNameHash(${onChainId})`,
      signal,
    );
  } catch (error) {
    warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) failed — `
      + 'cannot verify local-mapping identity, treating CG as NOT public (fail-closed): '
      + `${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'transportFailure', error };
  }
  if (onChainHash === TIMEOUT_SENTINEL) {
    warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) timed out after `
      + `${readTimeoutMs}ms — cannot verify local-mapping identity, `
      + 'treating CG as NOT public (fail-closed)',
    );
    return {
      kind: 'transportFailure',
      error: createRpcTimeoutError(
        `getContextGraphNameHash(${onChainId}) timed out after ${readTimeoutMs}ms`,
      ),
    };
  }
  return evaluateContextGraphSlotBindingCommitment(
    contextGraphId,
    onChainId,
    onChainHash,
    allowNumericSelfAddress,
    isWireIdKeyedSubscription,
    (message) => warn(opCtx ?? createOperationContext('share'), message),
  );
}

const LIVE_AUTHORITY_FALLBACK_WARN_INTERVAL_MS = 60_000;

/**
 * Bind an optional chain point read. Options are passed ONLY when a signal is
 * present, so the call keeps the arity callers and spies have always observed.
 */
function bindOptionalChainRead<T>(
  chain: unknown,
  read: ((numericId: bigint, options?: { signal?: AbortSignal }) => Promise<T>) | undefined,
): ((numericId: bigint, signal?: AbortSignal) => Promise<T>) | undefined {
  if (typeof read !== 'function') return undefined;
  return (numericId, signal) => signal
    ? read.call(chain, numericId, { signal })
    : read.call(chain, numericId);
}

/**
 * Bind the one-read authority WITH the caller's freshness choice.
 *
 * Separate from {@link bindOptionalChainRead} because only this read honours
 * `freshness`; the point reads it falls back to are always live. That is the
 * safe direction — a node whose adapter cannot serve the single tuple simply
 * keeps today's behaviour rather than inheriting a bounded answer from a path
 * that never offered one.
 */
function bindLiveAuthorityRead<T>(
  chain: unknown,
  read: ((
    numericId: bigint,
    options?: { signal?: AbortSignal; freshness?: 'live' | 'bounded' },
  ) => Promise<T>) | undefined,
  freshness: 'live' | 'bounded',
): ((numericId: bigint, signal?: AbortSignal) => Promise<T>) | undefined {
  if (typeof read !== 'function') return undefined;
  return (numericId, signal) => read.call(chain, numericId, {
    ...(signal ? { signal } : {}),
    freshness,
  });
}

/**
 * The recipient-key failure a sender reports once fetching cannot help: why
 * the keys are unknown and what gets them here (#2849).
 */
function withMemberKeyHint(
  error: WorkspaceAgentEncryptionKeyMissingError,
): WorkspaceAgentEncryptionKeyMissingError {
  const { agentAddresses } = error;
  const one = agentAddresses.length === 1;
  return new WorkspaceAgentEncryptionKeyMissingError(
    agentAddresses,
    `${new WorkspaceAgentEncryptionKeyMissingError(agentAddresses).message}: this node has neither `
      + (one ? 'a join request from the agent nor its profile. Have the member' : 'join requests from these agents nor their profiles. Have each member')
      + ' join through an invite, or retry once '
      + (one ? 'its profile has' : 'their profiles have')
      + ' reached this node (profiles are re-published about every 20 minutes).',
  );
}

function hasExactRecipientAgentRoster(
  resolution: Extract<WorkspaceAgentRecipientResolution, { readonly requiresEncryption: true }>,
  participantAgents: readonly string[],
): boolean {
  try {
    const resolvedAgents = new Set(
      resolution.recipients.map(({ agentAddress }) => ethers.getAddress(agentAddress).toLowerCase()),
    );
    const currentAgents = new Set(
      participantAgents.map((address) => ethers.getAddress(address).toLowerCase()),
    );
    return currentAgents.size === resolvedAgents.size
      && [...currentAgents].every((address) => resolvedAgents.has(address));
  } catch {
    return false;
  }
}

function hasExactWorkspaceRecipientSet(
  left: Extract<WorkspaceAgentRecipientResolution, { readonly requiresEncryption: true }>,
  right: Extract<WorkspaceAgentRecipientResolution, { readonly requiresEncryption: true }>,
): boolean {
  const canonical = (recipient: WorkspaceAgentRecipient): string => [
    ethers.getAddress(recipient.agentAddress).toLowerCase(),
    recipient.recipientKeyId,
    recipient.peerId ?? '',
  ].join('\u0000');
  try {
    const leftRecipients = left.recipients.map(canonical).sort();
    const rightRecipients = right.recipients.map(canonical).sort();
    return leftRecipients.length === rightRecipients.length
      && leftRecipients.every((recipient, index) => recipient === rightRecipients[index]);
  } catch {
    return false;
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

type PendingSenderKeyDrainAuthority = {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  /** Connection-open authority covers every subgraph of one resolved CG. */
  readonly allSubgraphs?: boolean;
  readonly recipientAgentAddress: string;
  readonly recipientKeyId: string;
  readonly recipientPeerId: string;
  /** Foreground publish additionally fences the exact local sender epoch. */
  readonly senderAgentAddress?: string;
  readonly epochId?: string;
};

function pendingSenderKeyEntryMatchesDrainAuthority(
  entry: PendingSenderKeyEntry,
  authority: PendingSenderKeyDrainAuthority,
): boolean {
  return entry.contextGraphId === authority.contextGraphId
    && (
      authority.allSubgraphs === true
      || (entry.subGraphName ?? undefined) === (authority.subGraphName ?? undefined)
    )
    && entry.recipientAgentAddress === authority.recipientAgentAddress
    && entry.recipientKeyId === authority.recipientKeyId
    && entry.recipientPeerId === authority.recipientPeerId
    && (
      authority.senderAgentAddress === undefined
      || entry.senderAgentAddress === authority.senderAgentAddress
    )
    && (authority.epochId === undefined || entry.epochId === authority.epochId);
}

export class WorkspaceCryptoMethods extends DKGAgentBase {
  getWorkspaceGossipSigningAgent(this: DKGAgent): (AgentKeyRecord & { privateKey: string }) | null {
    const defaultAddress = this.defaultAgentAddress?.toLowerCase();
    let fallback: (AgentKeyRecord & { privateKey: string }) | null = null;
    for (const record of this.localAgents.values()) {
      if (!record.privateKey) continue;
      // GH #787 — a node-level key record can carry a privateKey but no (or an
      // invalid) agentAddress (an operational identity, not an agent). Such a
      // record is NOT a usable gossip signer: encodeWorkspaceGossipMessage emits
      // `agentAddress` into the envelope and the downstream host-mode authority
      // check rejects a missing/invalid one. Skip it entirely — that both avoids
      // the original `toLowerCase()`-of-undefined crash (HTTP 500 on SWM write)
      // AND prevents it becoming a fallback that emits an unverifiable envelope.
      if (!record.agentAddress || !ethers.isAddress(record.agentAddress)) continue;
      const signingRecord = { ...record, privateKey: record.privateKey };
      if (defaultAddress && record.agentAddress.toLowerCase() === defaultAddress) {
        return signingRecord;
      }
      fallback ??= signingRecord;
    }
    return fallback;
  }

  /**
   * Codex review on PR #916 (`a15f25d` round 3) — return the local
   * agent record that matches `targetAddress`, or null if none of
   * `localAgents` is registered for that address (or has no
   * private key). Distinct from {@link getWorkspaceGossipSigningAgent}
   * which always picks the default/first available agent.
   *
   * Used by the beacon-registration path to honour
   * `createContextGraph(opts.callerAgentAddress)` on multi-agent
   * nodes: if the caller specified the curator address explicitly,
   * the beacon must be signed by THAT agent so the wireId-pinned
   * curator EOA matches whatever signer the host-catchup path
   * later recovers (which uses the same lookup tied to the
   * `beaconRegistry` entry for this CG).
   */
  getWorkspaceSigningAgentForAddress(this: DKGAgent,
    targetAddress: string | undefined,
  ): (AgentKeyRecord & { privateKey: string }) | null {
    if (!targetAddress) return null;
    const target = targetAddress.toLowerCase();
    for (const record of this.localAgents.values()) {
      if (!record.privateKey) continue;
      if (record.agentAddress.toLowerCase() === target) {
        return { ...record, privateKey: record.privateKey };
      }
    }
    return null;
  }

  protected async resolveContextGraphAgentGateAuthority(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphAgentGateAuthority> {
    return withRpcUsageSite(CG_AUTH_RPC_SITES.gate, () => resolveContextGraphAgentGateAuthorityDecision({
      contextGraphId,
      getTransportAuthority: () => this.resolveSwmTransportAuthority(
        contextGraphId,
        { signal: options.signal },
      ),
      readRosterRevision: () => this.contextGraphMetaProjection.peerGateRevision.read(contextGraphId),
      getLegacyMeta: () => this.getCgMeta(contextGraphId, { signal: options.signal }),
      getSubscriptionAgents: () => (
        this.subscribedContextGraphs.get(contextGraphId)?.participantAgents ?? []
      ),
    }));
  }

  /** Compatibility projection for admission callers that only need fail-closed gate values. */
  async getContextGraphAgentGateAddresses(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const authority = await this.resolveContextGraphAgentGateAuthority(contextGraphId, options);
    if (authority.kind === 'ungated') return null;
    if (authority.kind === 'available') return authority.agentAddresses;
    return [];
  }

  /**
   * R9 (SECURITY) — authoritative member-recovery gate.
   *
   * Registered and active accepted-private graphs use their exact authority
   * roster. Only a legacy unregistered graph (including accepted public, whose
   * local gate controls recovery rather than reads) resolves the effective
   * store-backed metadata projection of
   * `allowedAgents ∪ participantAgents` minus `revokedAgents` from the CG
   * metadata. The network-influenced `subscribedContextGraphs`
   * subscription cache is DELIBERATELY OMITTED — that cache is poisonable, and
   * folding it in is exactly what `member-recovery-auth.ts` forbids.
   *
   * Unlike {@link getContextGraphAgentGateAddresses} (which also feeds normal
   * sync admission and may fold in the subscription cache only for graphs that
   * are not registered on-chain), this read is used ONLY for `request.recovery`
   * and is passed straight to
   * `isMemberRecoveryAuthorized`, which hard-denies on null/empty. Returns
   * `null` when the CG has no projected agent gate at all (⇒ hard-deny).
   */
  async getMemberRecoveryGate(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const recoveryAuthority = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.recoveryGate,
      () => resolveSwmMemberRecoveryAuthorityDecision(
        this,
        contextGraphId,
        { signal: options.signal },
      ),
    );
    if (recoveryAuthority.kind === 'private-roster') {
      return [...recoveryAuthority.participantAgents];
    }
    if (recoveryAuthority.kind !== 'legacy-unregistered') return null;

    const metadataRevision = this.contextGraphMetaProjection
      .readContextGraphAuthorityFactsRevision(contextGraphId);
    const metadataGate = await this.getLocalMetadataMemberRecoveryGate(contextGraphId, options);

    // Metadata is another async boundary. Re-resolve the authoritative state
    // before returning it so a private policy activation/rotation or a chain
    // registration that commits during the store read takes precedence over
    // the now-stale local projection.
    const currentRecoveryAuthority = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.recoveryGate,
      () => resolveSwmMemberRecoveryAuthorityDecision(
        this,
        contextGraphId,
        { signal: options.signal },
      ),
    );
    if (currentRecoveryAuthority.kind === 'private-roster') {
      return [...currentRecoveryAuthority.participantAgents];
    }
    if (currentRecoveryAuthority.kind !== 'legacy-unregistered') return null;
    // A revocation or other authority-fact mutation during the metadata read
    // invalidates the captured roster even if registration remained absent.
    // Recovery is retryable, so fail closed instead of serving that snapshot.
    return this.contextGraphMetaProjection
      .readContextGraphAuthorityFactsRevision(contextGraphId) === metadataRevision
      ? metadataGate
      : null;
  }

  /**
   * Authority source used while constructing or mutating a private roster.
   * Registered private graphs retain their finalized chain participant set;
   * unregistered graphs use the effective store-backed metadata projection.
   * This deliberately ignores an accepted-private overlay roster so rotation
   * does not ask the roster it is replacing to define its own successor.
   */
  async getMemberRecoveryRosterSource(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const registered = await this.resolveSwmRegisteredAuthority(
      contextGraphId,
      { signal: options.signal },
    );
    if (registered.kind === 'private') return [...registered.participantAgents];
    if (registered.kind !== 'unregistered') return noRosterFrom(contextGraphId, registered);
    const metadataRevision = this.contextGraphMetaProjection
      .readContextGraphAuthorityFactsRevision(contextGraphId);
    const metadataGate = await this.getLocalMetadataMemberRecoveryGate(contextGraphId, options);
    const currentRegistered = await this.resolveSwmRegisteredAuthority(
      contextGraphId,
      { signal: options.signal },
    );
    if (currentRegistered.kind === 'private') {
      return [...currentRegistered.participantAgents];
    }
    if (currentRegistered.kind !== 'unregistered') return noRosterFrom(contextGraphId, currentRegistered);
    return this.contextGraphMetaProjection
      .readContextGraphAuthorityFactsRevision(contextGraphId) === metadataRevision
      ? metadataGate
      : null;
  }

  /**
   * Fresh effective store-backed metadata member set. This deliberately stays
   * separate from the transport-authoritative recovery decision.
   */
  async getLocalMetadataMemberRecoveryGate(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {

    const seen = new Set<string>();
    const agents: string[] = [];
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    if (meta.allowedAgents.length === 0 && meta.participantAgents.length === 0) {
      return null; // no projected agent gate ⇒ hard-deny at the recovery gate
    }
    const revoked = new Set(meta.revokedAgents.map((addr) => addr.toLowerCase()));
    const add = (value: string | undefined) => {
      if (!value || !ethers.isAddress(value)) return;
      const checksum = ethers.getAddress(value);
      const key = checksum.toLowerCase();
      if (revoked.has(key)) return;
      if (seen.has(key)) return;
      seen.add(key);
      agents.push(checksum);
    };
    for (const agent of meta.allowedAgents) add(agent);
    for (const agent of meta.participantAgents) add(agent);
    return agents;
  }

  /**
   * Read libp2p peer-ids that approved agents have authorised, via
   * signed delegations, to act on their behalf for sync against this
   * CG. Used by the sync auth path so a sync request signed by the
   * joiner's NODE (operational) key passes auth — the agent itself
   * doesn't co-sign every wire message.
   *
   * Returns a Map keyed by the lowercased agent address (the
   * delegating principal) → list of peer-ids that agent delegated.
   * Auth code looks up only the agent the inbound envelope claims to
   * act on behalf of (`requesterAgentAddress`), so a delegation
   * granted to agent A's node doesn't accidentally let traffic
   * "on behalf of agent B" through that same node.
   */
  async getContextGraphAllowedDelegateePeers(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, string[]>> {
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    return collectProjectedDelegatees(meta, 'allowedPeers', (value) => value);
  }

  /**
   * Same as `getContextGraphAllowedDelegateePeers` but for ethereum
   * operational-key addresses authorised via a signed delegation.
   * Returns Map<agentLower, opKeyLower[]>. Both keys and values are
   * lowercased so callers can compare against `recoveredAddress.toLowerCase()`.
   * Expired rows are filtered out — see the peer-lookup helper for the
   * rationale (PR #448 review round 4).
   */
  async getContextGraphAllowedDelegateeKeys(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Map<string, string[]>> {
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
    return collectProjectedDelegatees(meta, 'allowedKeys', (value) => value.toLowerCase());
  }

  hasLocalAgentInGate(this: DKGAgent, agentGateAddresses: readonly string[]): boolean {
    const allowedSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (allowedSet.has(record.agentAddress.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Materialise every workspace recipient private key this node holds
   * across all local agents.
   *
   * `activeOnly` selects between two distinct call-site contracts:
   *
   *   - `activeOnly: false` (default) — include retired/revoked keys.
   *     This is the HISTORICAL-DECRYPTION shape: the envelope sitting
   *     in the SWM gossip queue may have been wrapped to a key we
   *     have since rotated away from, and we still want to read it.
   *     Wired into `SharedMemoryHandler` via the
   *     `workspaceRecipientPrivateKeys` getter.
   *
   *   - `activeOnly: true` — drop entries with `revokedAt` set. This
   *     is the FRESH-TRAFFIC bootstrap shape (e.g.
   *     `acceptSwmSenderKeyPackage`): once a key is revoked, no peer
   *     may set up a new sender-key epoch against it, otherwise a
   *     stale or malicious sender could pin all future traffic on a
   *     retired key indefinitely. Codex review of PR #540 / commit
   *     24aa4855.
   */
  getLocalWorkspaceRecipientPrivateKeys(this: DKGAgent,
    opts: { activeOnly?: boolean } = {},
  ): WorkspaceRecipientEncryptionKey[] {
    const activeOnly = opts.activeOnly === true;
    const keys: WorkspaceRecipientEncryptionKey[] = [];
    for (const record of this.localAgents.values()) {
      for (const entry of record.workspaceEncryptionKeys) {
        if (
          entry.encryptionKeyAlgorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519 ||
          !entry.publicEncryptionKey ||
          !entry.privateEncryptionKey
        ) {
          continue;
        }
        if (activeOnly && entry.revokedAt) {
          continue;
        }
        const publicKeyBytes = decodeWorkspaceEncryptionKey(entry.publicEncryptionKey);
        const privateKeyBytes = decodeWorkspaceEncryptionKey(entry.privateEncryptionKey);
        const recipientId = `did:dkg:agent:${ethers.getAddress(record.agentAddress)}`;
        keys.push({
          purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
          recipientId,
          recipientKeyId: entry.encryptionKeyId,
          encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
          publicKeyBytes,
          privateKeyBytes,
        });
      }
    }
    return keys;
  }

  /**
   * #884 review — bound a single chain policy/liveness read on the hot path.
   * Mirrors the `withTimeout` race in {@link getContextGraphOnChainPolicy}:
   * resolves to {@link TIMEOUT_SENTINEL} if the underlying RPC HANGS past the
   * request-scoped authority deadline (`chainAuthorityReadBudgets`, default
   * {@link CHAIN_POLICY_READ_TIMEOUT_MS}), so callers fail closed instead of
   * blocking forever. The timer is `unref`'d so a dead RPC never keeps the
   * process alive.
   *
   * `start` receives the bounded signal so the deadline reaches the read
   * itself: a hung RPC is cancelled rather than merely abandoned, and a
   * timed-out caller leaves any flight it was sharing.
   */
  private async raceChainPolicyRead<T>(
    start: (signal: AbortSignal) => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<T | typeof TIMEOUT_SENTINEL> {
    try {
      // This remains inside the caller's ordinary RATE budget, but it must
      // not wait behind a harness-sized queue longer than its 2.5s fail-closed
      // deadline. Background callers retain their background class and its
      // budget; there the governor admits the read ahead of ordinary
      // background work and does not hold it for the start-up delay.
      return await withRpcRequestContext({ admissionPriority: 'authority' }, () => (
        runBoundedOperation(start, {
          label,
          timeoutMs: chainAuthorityReadBudgetsOf(this).requestTimeoutMs,
          signal,
        })
      ));
    } catch (error) {
      if (isBoundedOperationTimeoutError(error)) return TIMEOUT_SENTINEL;
      throw error;
    }
  }

  /**
   * #884 review — LIVE-gated on-chain access-policy read for a CANDIDATE
   * numeric on-chain id. The single trust anchor shared by every "downgrade
   * to a less-protected path" decision (SWM-plaintext gate + publish-inline
   * curated probe), so both branches can never diverge.
   *
   * Returns an available access-policy enum (`0` = public, `1` =
   * private/curated) ONLY after
   * {@link ChainAdapter.isContextGraphActiveOnChain} proves the slot is
   * actually live on-chain; otherwise preserves a typed unavailable reason.
   * This is essential because `getContextGraphAccessPolicy` returns
   * Solidity's default `0` (= public) for UNKNOWN ids, and the local
   * access-policy cache can be seeded by best-effort probes of arbitrary ids —
   * so neither is trustworthy without a liveness proof. Both the liveness and
   * the policy reads are bounded by {@link raceChainPolicyRead} so a hung RPC
   * fails closed instead of blocking the hot path. A genuine RPC
   * rejection propagates to the caller (which logs + fails closed in its own
   * idiom). The canonical reason distinguishes retryable bounded timeouts
   * from terminal unknown policy; diagnostics retain the timed-out read name.
   */
  protected async resolveLiveOnChainAccessPolicyState(this: DKGAgent,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal; freshness?: 'live' | 'bounded' } = {},
  ): Promise<LiveOnChainAccessPolicyState> {
    const readLiveness = this.chain.isContextGraphActiveOnChain;
    const readAccessPolicy = this.chain.getContextGraphAccessPolicy;
    const readLiveAuthority = this.chain.getContextGraphLiveAuthority;
    return resolveLiveAccessPolicyState(
      {
        readTimeoutMs: chainAuthorityReadBudgetsOf(this).requestTimeoutMs,
        // Defaults to live. Only a caller that has said its decision can wait
        // for the next read is allowed to ask the index.
        readLiveAuthority: bindLiveAuthorityRead(
          this.chain, readLiveAuthority, options.freshness ?? 'live',
        ),
        isContextGraphActiveOnChain: bindOptionalChainRead(this.chain, readLiveness),
        getContextGraphAccessPolicy: bindOptionalChainRead(this.chain, readAccessPolicy),
        runBoundedRead: async (start, label, signal) => {
          const value = await this.raceChainPolicyRead(start, label, signal);
          return value === TIMEOUT_SENTINEL
            ? { kind: 'timeout' }
            : { kind: 'value', value };
        },
        claimMissingLivenessWarning: () => {
          if (this.warnedMissingCgLivenessProbe) return false;
          this.warnedMissingCgLivenessProbe = true;
          return true;
        },
        // Unlike the static condition above this one comes and goes (a node
        // throttling at the JSON-RPC level reaches it too), so it is limited
        // by time rather than to once per process.
        claimLiveAuthorityFallbackWarning: () => {
          const now = Date.now();
          if (now - this.lastLiveAuthorityFallbackWarnAt < LIVE_AUTHORITY_FALLBACK_WARN_INTERVAL_MS) return false;
          this.lastLiveAuthorityFallbackWarnAt = now;
          return true;
        },
        warn: (ctx, message) => this.log.warn(ctx, message),
        cacheAccessPolicy: (id, policy) => this.onChainAccessPolicyCache.set(id, policy),
      },
      onChainId,
      opCtx,
      options,
    );
  }

  /** Compatibility projection for fail-closed policy consumers. */
  async readLiveOnChainAccessPolicy(this: DKGAgent,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal; freshness?: 'live' | 'bounded' } = {},
  ): Promise<0 | 1 | null> {
    const state = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.livePolicy,
      () => this.resolveLiveOnChainAccessPolicyState(onChainId, opCtx, options),
    );
    return state.kind === 'available' ? state.accessPolicy : null;
  }

  async resolveActivePublicContextGraphChainProof(
    this: DKGAgent,
    contextGraphId: string,
    operationContext: OperationContext,
    signal?: AbortSignal,
  ): Promise<ActivePublicContextGraphChainProof> {
    return resolveStrictActivePublicChainProof(
      (id, resolverOperationContext) => this.resolveFinalizedOnChainAccessPolicyState(
        id,
        resolverOperationContext,
        signal,
      ),
      contextGraphId,
      operationContext,
    );
  }

  /**
   * Metadata-bootstrap authority proof. Indexed adapters resolve identity,
   * liveness, and policy from one finalized snapshot; legacy adapters retain
   * the strict current-state repair path explicitly at this boundary.
   */
  async resolveFinalizedOnChainAccessPolicyState(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
    /**
     * Caller deadline. Once it aborts, no further chain read starts, and the
     * finalized-index read this call queued on the shared authority
     * coordinator is dropped from the queue, or cancelled if already running.
     */
    signal?: AbortSignal,
  ): Promise<0 | 1 | 'unregistered' | 'unknown'> {
    signal?.throwIfAborted();
    // Retired name-hash id: answer for the graph it names (see supersedingContextGraphIdFor).
    const supersedingId = this.supersedingContextGraphIdFor?.(contextGraphId);
    if (supersedingId) {
      return this.resolveFinalizedOnChainAccessPolicyState(supersedingId, opCtx, signal);
    }
    const trimmed = contextGraphId.trim();
    let onChainId: string | null = null;
    let resolvedFromLocalCg = false;
    if (
      this.chain?.contextGraphAuthorityIndexRevisionReader !== undefined
      && typeof this.resolveContextGraphRegistrationBinding === 'function'
      && !isCanonicalPositiveContextGraphId(trimmed)
    ) {
      // An indexed adapter takes the identity from the finalized registration
      // binding too, never from a live registry range scan (#2827 follow-up).
      // Finalized absence is `unregistered`, as a scan's miss was; any other
      // unanswered read is `unknown`.
      const binding = await this.resolveContextGraphRegistrationBinding(contextGraphId, { signal });
      if (binding.kind === 'registered') {
        onChainId = binding.onChainId.toString();
        resolvedFromLocalCg = true;
      } else if (
        binding.kind === 'unavailable'
        && binding.reason !== 'finalized-name-absence-unaccepted'
      ) {
        return 'unknown';
      }
    } else if (typeof this.getContextGraphOnChainId === 'function') {
      onChainId = await this.getContextGraphOnChainId(contextGraphId, { signal });
      if (onChainId) resolvedFromLocalCg = true;
    }
    if (!onChainId && /^\d+$/.test(trimmed)) {
      if (typeof this.contextGraphExists === 'function') {
        try {
          if (!(await this.contextGraphExists(trimmed))) onChainId = trimmed;
        } catch {
          return 'unknown';
        }
      } else {
        onChainId = trimmed;
      }
    }
    if (!onChainId) return 'unregistered';

    try {
      const parsed = BigInt(onChainId);
      if (
        parsed <= 0n
        || parsed > ethers.MaxUint256
        || parsed.toString(10) !== onChainId
      ) return 'unknown';
    } catch {
      return 'unknown';
    }

    // The id lookup above may itself have waited on the chain.
    signal?.throwIfAborted();
    const indexedSnapshot = await this.readRfc64BatchedFinalizedAuthoritySnapshotV1(
      onChainId,
      signal,
    );
    if (indexedSnapshot === undefined) {
      // Preserve the exact address resolution above when a legacy adapter has
      // no finalized-index capability. Re-resolving through the generic
      // policy helper can reinterpret a numeric local CG as a raw slot after
      // a stateful resolver changes, bypassing its required name-hash proof.
      if (resolvedFromLocalCg && !(await this.localCgMatchesOnChainSlot(
        contextGraphId,
        onChainId,
        opCtx,
        { bindingMode: 'chain-attested-repair', signal },
      ))) return 'unknown';
      const policy = await this.readLiveOnChainAccessPolicy(onChainId, opCtx, { signal });
      return policy === 0 || policy === 1 ? policy : 'unknown';
    }
    if (
      indexedSnapshot === null
      || indexedSnapshot.contextGraphId !== onChainId
      || indexedSnapshot.active !== true
    ) return 'unknown';

    if (resolvedFromLocalCg) {
      const bindingOutcome = evaluateContextGraphSlotBindingCommitment(
        contextGraphId,
        onChainId,
        indexedSnapshot.nameHash,
        false,
        (localId) => this.isWireIdKeyedSubscription(localId),
        (message) => this.log.warn(
          opCtx ?? createOperationContext('share'),
          message,
        ),
      );
      if (!mapContextGraphSlotBindingOutcome(
        bindingOutcome,
        'chain-attested-repair',
      )) return 'unknown';
    }

    const accessPolicy = indexedSnapshot.accessPolicy;
    if (accessPolicy !== 0 && accessPolicy !== 1) return 'unknown';
    this.onChainAccessPolicyCache.set(onChainId, accessPolicy);
    return accessPolicy;
  }

  /**
   * Registered-chain authority for the SWM consumers that need the raw roster,
   * the agent gate and member recovery (#2827). The policy, and why the
   * finalized authority index is the only registration evidence, live in
   * {@link resolveSwmRegisteredAuthorityDecision}.
   */
  resolveSwmRegisteredAuthority(this: DKGAgent,
    contextGraphId: string,
    options: SwmRegisteredAuthorityReadOptions = {},
  ): Promise<RegisteredContextGraphAuthority> {
    return resolveSwmRegisteredAuthorityDecision(this, contextGraphId, options);
  }

  /**
   * How SWM on this graph may travel, for both ends of the wire
   * ({@link resolveSwmTransportAuthorityDecision}).
   */
  resolveSwmTransportAuthority(this: DKGAgent,
    contextGraphId: string,
    options: SwmRegisteredAuthorityReadOptions = {},
  ): Promise<SwmTransportAuthority> {
    return resolveSwmTransportAuthorityDecision(this, contextGraphId, options);
  }

  /**
   * Resolve the transport peer gate that applies to inbound SWM traffic.
   *
   * Ordinary graphs retain the legacy merged metadata projection. A graph
   * carrying a durable local join approval must instead use the peer roster
   * from the same source-qualified proof that authorized its private replica;
   * falling back to the merged projection there would let an unrelated
   * AGENTS/ONTOLOGY row widen the inbound gate. Registration (or a proven
   * public policy) supersedes that participant proof and keeps the established
   * registered/public behaviour.
   */
  async resolveApprovedPrivateReplicaSwmAllowedPeersOverride(this: DKGAgent,
    contextGraphId: string,
  ): Promise<string[] | undefined> {
    if (!this.localApprovedAgentByCG.has(contextGraphId)) {
      return undefined;
    }

    const transport = await this.resolveSwmTransportAuthority(contextGraphId, {
      authorityReadMode: 'finalized-index-or-live',
    });
    switch (transport.kind) {
      case 'approved-private-replica':
        // An empty proved list is an authoritative open peer gate. Keep it
        // distinct from `undefined` (this override does not apply) so the
        // SharedMemoryHandler projection wrapper never falls back to a merged
        // secondary-source row.
        return [...new Set(transport.allowedPeers)];
      case 'plaintext':
      case 'private-roster':
        return undefined;
      case 'unavailable':
        throw createContextGraphAuthorityError(
          `Context graph "${contextGraphId}" SWM peer gate authority is unavailable (${transport.reason})`,
          transport,
        );
      case 'legacy-unregistered':
        // The approval may have been removed while the authority read was in
        // flight. Only that transition restores ordinary legacy behaviour.
        if (!this.localApprovedAgentByCG.has(contextGraphId)) {
          return undefined;
        }
        throw createContextGraphAuthorityError(
          `Context graph "${contextGraphId}" still has a local join approval but no approved private replica authority`,
          {
            reason: 'finalized-name-absence-unaccepted',
            detail: 'approved private replica authority did not survive current SWM authority resolution',
          },
        );
    }
  }

  /** List/null adapter for SWM consumers that do not consume meta records. */
  async resolveSwmAllowedPeersForCurrentAuthority(this: DKGAgent,
    contextGraphId: string,
  ): Promise<string[] | null> {
    const approvedReplicaOverride =
      await this.resolveApprovedPrivateReplicaSwmAllowedPeersOverride(contextGraphId);
    if (approvedReplicaOverride === undefined) {
      return this.getContextGraphAllowedPeers(contextGraphId);
    }
    return approvedReplicaOverride.length > 0 ? approvedReplicaOverride : null;
  }

  /**
   * Whether SWM on this graph is public-readable, so plaintext may be both
   * sent and accepted. One predicate for both ends of the wire: the sender's
   * recipient resolver and the receiver's plaintext oracle.
   *
   * Without an active accepted owner-signed public policy it is exactly the
   * live on-chain probe (isContextGraphPublicOnChain). With one, it is the
   * `plaintext` transport authority of {@link resolveSwmTransportAuthority},
   * the same answer the sender's recipient selection uses.
   */
  async isContextGraphSwmPublic(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
  ): Promise<boolean> {
    if (!this.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId)) {
      return this.isContextGraphPublicOnChain(contextGraphId, opCtx);
    }
    try {
      const transport = await withRpcUsageSite(
        CG_AUTH_RPC_SITES.publicProbe,
        () => this.resolveSwmTransportAuthority(
          contextGraphId,
          { authorityReadMode: 'finalized-index-or-live' },
        ),
      );
      return transport.kind === 'plaintext';
    } catch (err) {
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphSwmPublic(${contextGraphId}) could not resolve registered authority — `
        + `treating the graph as NOT public (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * True iff `contextGraphId` is DEFINITIVELY public per its on-chain
   * access policy (policy enum `0`). Gates SWM encryption: an on-chain
   * public CG is public-readable, so its shared memory must be plaintext
   * even when it carries a `DKG_ALLOWED_AGENT` list — on a public CG that
   * list governs *publish authority* (`publishPolicy`), not *read access*.
   *
   * Encrypting a public CG's SWM would (a) bootstrap a sender-key
   * handshake that non-gated recipients correctly reject ("not DKG-agent
   * gated"), blocking promote/publish, and (b) diverge from the
   * publisher's plaintext-inline path. `isPrivateContextGraph` cannot
   * make this call on its own because its allowlist-implies-private
   * heuristic (for invite-only CGs that carry no `accessPolicy` triple)
   * also fires for public-with-publish-allowlist CGs — only the on-chain
   * policy distinguishes the two.
   *
   * A "public ⇒ plaintext" decision is gated on a LIVE on-chain proof
   * (`isContextGraphActiveOnChain`), never on local state alone: the chain
   * returns access-policy `0` (= public) for UNKNOWN ids, and every local
   * signal (the access-policy cache — also seeded by best-effort probes of
   * arbitrary ids, a rehydrated subscription `onChainId`, a persisted
   * `...OnChainId` triple, or a local `accessPolicy` literal) can be stale or
   * probe-poisoned after a devnet reset / partial registration.
   *
   * When the candidate id is resolved from a LOCAL mapping
   * (`getContextGraphOnChainId`), the live slot is additionally IDENTITY-BOUND
   * to this CG via its on-chain committed name-hash (#884 review): the mapping
   * is persisted local state that survives a devnet reset, so it can point at
   * a numeric slot now occupied by an UNRELATED CG on a fresh chain — and a
   * liveness probe alone only proves *some* CG is live there. The on-chain
   * name-hash is `keccak256(cleartextId)` (deterministic, write-once at
   * registration), so a reused slot commits a DIFFERENT name; an affirmative
   * mismatch fails closed. (When no name-hash is committed on either side we
   * can't disprove identity, so we don't add a new failure there.)
   *
   * Fail-closed: returns `false` for private (`1`), unknown/unregistered/
   * non-live, an identity mismatch, a missing chain getter, an RPC
   * stall/timeout, or any lookup error, so curated / invite-only /
   * pre-registration CGs keep their encrypted SWM. The optional `opCtx` tags
   * the fail-closed diagnostic with the caller's subsystem (share vs publish).
   */
  async isContextGraphPublicOnChain(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
    options: { slotBindingMode?: PublicPolicySlotBindingMode } = {},
  ): Promise<boolean> {
    try {
      // DEFINITIVELY public iff the live-proven on-chain policy is `0`. Every
      // other tri-state value — `1` (private), `'unregistered'` (no resolvable
      // slot), `'unknown'` (resolvable but not live / stale mapping / missing
      // probe / timeout) — is NOT a proof of public, so it fails closed here
      // (the SWM-gossip caller then keeps the encrypted path). The shared
      // resolver collapses unknown↔not-public ONLY for this boolean predicate;
      // the publish-inline probe consumes the tri-state directly so it can
      // REFUSE (rather than choose plaintext) on a genuine UNKNOWN.
      return (await withRpcUsageSite(
        CG_AUTH_RPC_SITES.publicProbe,
        () => this.resolveOnChainAccessPolicyState(contextGraphId, opCtx, options),
      )) === 0;
    } catch (err) {
      // Fail closed (curated/encrypted) on any lookup failure, but not
      // silently — surface WHY the public override was skipped so operators
      // get a diagnostic instead of a silent regression. Tag with the CALLER's
      // operation context (share/promote vs publish-inline probe).
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphPublicOnChain(${contextGraphId}) lookup failed — treating CG as NOT public ` +
        `(fail-closed: SWM stays encrypted): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * #884 review (🔴 GZh-c) — the SINGLE tri-state on-chain access-policy
   * resolver shared by the SWM-plaintext gate ({@link isContextGraphPublicOnChain})
   * and the publish-inline curated probe (`probeIsCurated`). Distinguishing
   * "definitively not public" from "could not prove" is security-relevant:
   * the boolean gate treats both as fail-closed (encrypt), but the publish
   * path must REFUSE on a genuine UNKNOWN instead of silently defaulting a
   * possibly-private CG onto the plaintext-inline path. Returning a tri-state
   * (rather than a boolean) is what lets the publish caller fail closed by
   * THROWING while still letting a genuinely pure-local CG keep its plaintext
   * default.
   *
   * Resolution mirrors the addressing rules: a local id maps through
   * {@link getContextGraphOnChainId} (authoritative for a registered CG whose
   * user-chosen id is itself numeric), else a bare decimal is treated as a raw
   * on-chain slot the caller addressed directly. A locally-mapped candidate is
   * IDENTITY-BOUND to its on-chain committed name-hash before trust (a persisted
   * mapping survives a devnet reset and can point at a reused slot); an
   * affirmative mismatch downgrades to `'unknown'` (fail closed), never to a
   * clean `'unregistered'`.
   *
   * Returns:
   *   - `0` / `1`        — live-proven public / private on-chain policy.
   *   - `'unregistered'` — no resolvable on-chain slot (a pure-local CG); the
   *                        publish path keeps its plaintext-inline default.
   *   - `'unknown'`      — resolvable but UNPROVABLE (slot not live, stale local
   *                        mapping, no liveness probe, or a bounded-read
   *                        timeout) → callers fail closed.
   * A genuine RPC REJECTION propagates (NOT swallowed) so each caller applies
   * its own fail-closed idiom (the boolean gate logs+returns `false`; the
   * publish probe logs+returns `null` → "access-policy is unknown" throw).
   */
  async resolveOnChainAccessPolicyState(this: DKGAgent,
    contextGraphId: string,
    opCtx?: OperationContext,
    options: {
      slotBindingMode?: PublicPolicySlotBindingMode;
    } = {},
  ): Promise<0 | 1 | 'unregistered' | 'unknown'> {
    // Retired name-hash id: answer for the graph it names (see supersedingContextGraphIdFor).
    const supersedingId = this.supersedingContextGraphIdFor?.(contextGraphId);
    if (supersedingId) return this.resolveOnChainAccessPolicyState(supersedingId, opCtx, options);
    const trimmed = contextGraphId.trim();

    // Resolve a CANDIDATE on-chain id. Local-id resolution is authoritative
    // for ADDRESSING: getContextGraphOnChainId maps any locally-known
    // context-graph id — including a registered CG whose user-chosen id is
    // numeric (a CG "named 42") — to THAT graph's persisted on-chain id.
    let onChainId: string | null = null;
    let resolvedFromLocalCg = false;
    if (typeof this.getContextGraphOnChainId === 'function') {
      onChainId = await this.getContextGraphOnChainId(contextGraphId);
      if (onChainId) resolvedFromLocalCg = true;
    }
    if (!onChainId && /^\d+$/.test(trimmed)) {
      // A bare decimal that did NOT resolve to a local mapping is AMBIGUOUS
      // (#884 review 🔴 GZumY). It is a raw on-chain slot the caller addressed
      // directly (`share('42')`) ONLY when there is no local context graph by
      // that id. A local CG whose canonical id is itself numeric (e.g.
      // `createContextGraph({ id: '42' })`) that simply isn't registered
      // on-chain yet must stay 'unregistered' (→ plaintext-inline default), not
      // be misclassified as a raw slot. Only a SUCCESSFUL negative existence
      // check enables the raw-slot branch.
      if (typeof this.contextGraphExists === 'function') {
        let localCgExists: boolean;
        try {
          localCgExists = await this.contextGraphExists(trimmed);
        } catch {
          // #884 review (🔴 GZ8L5): a flaked existence check is NOT a license
          // to treat "42" as a raw on-chain slot — slot 42 could be a live
          // public CG on the current chain and we'd force the WRONG graph onto
          // plaintext. Fail closed (UNKNOWN) instead of guessing.
          return 'unknown';
        }
        if (!localCgExists) onChainId = trimmed;
        // else: a local CG named "42" exists but has no on-chain mapping → it
        // is a pure-local (unregistered) CG; fall through to 'unregistered'.
      } else {
        // No local-existence oracle available (minimal adapters / harnesses):
        // preserve the bare-numeric raw-slot addressing behavior.
        onChainId = trimmed;
      }
    }
    // No resolvable on-chain slot at all — a pure-local CG (including a
    // numeric-named local CG not yet registered). This is NOT "unknown": there
    // is nothing on-chain to fail closed against, so the publish path keeps its
    // long-standing plaintext-inline default for local-only workspaces (and the
    // boolean gate reads it as not-public).
    if (!onChainId) return 'unregistered';

    // IDENTITY BINDING (#884 review GZEqF). A candidate resolved from the
    // LOCAL mapping must be proven to still BE this CG on the current chain
    // before we trust its policy — `getContextGraphOnChainId` is persisted
    // local state that survives a devnet reset, so it can point at a slot now
    // occupied by an unrelated CG. (The bare-numeric path is the caller
    // explicitly addressing a raw on-chain slot, so there is no local identity
    // to re-bind.) An affirmative name-hash mismatch is a STALE mapping → treat
    // as 'unknown' (fail closed), not 'unregistered' (which would re-enable the
    // plaintext default for a graph we just proved we can't trust).
    if (resolvedFromLocalCg && !(await this.localCgMatchesOnChainSlot(
      contextGraphId,
      onChainId,
      opCtx,
      { bindingMode: options.slotBindingMode },
    ))) {
      return 'unknown';
    }

    // LIVE-ON-CHAIN PROOF GATE (#884 review). A trust decision must be backed
    // by the chain, never by local state alone — see readLiveOnChainAccessPolicy
    // for the full rationale (default-zero access policy for unknown ids,
    // probe-poisoned cache, stale rehydrated subscriptions / persisted
    // mappings). It returns the policy ONLY once the slot is proven live, else
    // null (UNKNOWN). A genuine RPC rejection propagates to the caller.
    const policy = await this.readLiveOnChainAccessPolicy(onChainId, opCtx);
    return policy === 0 || policy === 1 ? policy : 'unknown';
  }

  /**
   * #884 review (GZEqF) — additive identity check binding a LOCALLY-resolved
   * on-chain id back to `contextGraphId` before a security downgrade.
   *
   * `getContextGraphOnChainId` reads persisted local state that survives a
   * devnet reset, so the mapping `localId → onChainId` can point at a numeric
   * slot now occupied by an UNRELATED CG on a fresh chain;
   * `isContextGraphActiveOnChain` only proves *some* CG is live at that slot.
   * The on-chain committed name-hash is the reset-proof identity anchor,
   * deterministic and write-once at registration. A locally-resolved id maps to
   * it two legitimate ways (#884 review 🔴 GZumc + 🔴 GaJf_), so an
   * AFFIRMATIVE match against EITHER clears the gate:
   *   - a curator-created CG stores its CLEARTEXT id (even one shaped like a
   *     0x+64-hex string) and registration commits `keccak256(utf8(cleartextId))`;
   *   - a host-only/core subscription is keyed by the WIRE id itself (cleartext
   *     never left the curator), so the local id already IS the committed hash —
   *     but the verbatim form is accepted ONLY when local metadata AFFIRMATIVELY
   *     proves the subscription is wire-id keyed (#884 review 🔴 GaZky), so a
   *     hash-shaped cleartext id can't borrow a reused slot's commitment.
   * A genuinely reused slot commits a DIFFERENT name that matches neither.
   *
   * The explicit binding mode owns both numeric self-address handling and
   * outcome mapping. `legacy-policy` preserves compatibility,
   * `chain-attested-repair` requires a committed mapping proof.
   * `retryable-durable` preserves the established raw numeric self-address
   * while propagating transport failures for every other identity read so
   * bounded durable verification can retry a fresh read.
   */
  async localCgMatchesOnChainSlot(this: DKGAgent,
    contextGraphId: string,
    onChainId: string,
    opCtx?: OperationContext,
    options: {
      bindingMode?: ContextGraphSlotBindingMode;
      /** @deprecated Use `bindingMode: 'chain-attested-repair'`. */
      requireCommittedNameHash?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<boolean> {
    const compatibilityBindingMode = options.requireCommittedNameHash === undefined
      ? undefined
      : options.requireCommittedNameHash
        ? 'chain-attested-repair'
        : 'legacy-policy';
    if (
      compatibilityBindingMode !== undefined
      && options.bindingMode !== undefined
      && options.bindingMode !== compatibilityBindingMode
    ) {
      throw new TypeError(
        'requireCommittedNameHash contradicts the explicit Context Graph binding mode',
      );
    }
    const bindingMode = options.bindingMode ?? compatibilityBindingMode ?? 'legacy-policy';
    const outcome = await evaluateContextGraphSlotBinding(
      this.chain,
      contextGraphId,
      onChainId,
      opCtx,
      options.signal,
      // The deprecated strict option accepted a direct numeric self-address;
      // preserve that exact compatibility while the new repair mode remains
      // stricter for callers that opt into it directly.
      options.requireCommittedNameHash === true
        || bindingMode !== 'chain-attested-repair',
      (localId) => this.isWireIdKeyedSubscription(localId),
      (ctx, message) => this.log.warn(ctx, message),
      (start, label, signal) => this.raceChainPolicyRead(start, label, signal),
      chainAuthorityReadBudgetsOf(this).requestTimeoutMs,
    );
    return mapContextGraphSlotBindingOutcome(outcome, bindingMode);
  }

  /**
   * Strict durable-sync identity proof. Unlike the legacy policy probe, this
   * rejects malformed or unprovable mappings and propagates chain transport
   * failures so authentication can retry a fresh read.
   */
  async requireLocalCgMatchesOnChainSlot(this: DKGAgent,
    contextGraphId: string,
    onChainId: string,
    opCtx?: OperationContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    // Retired name-hash id: stand down, never write (see supersedingContextGraphIdFor).
    const supersedingId = this.supersedingContextGraphIdFor?.(contextGraphId);
    if (supersedingId) throw new SyncTargetSupersededError(contextGraphId, supersedingId);
    return this.localCgMatchesOnChainSlot(
      contextGraphId,
      onChainId,
      opCtx,
      { bindingMode: 'retryable-durable', signal: options.signal },
    );
  }

  /**
   * #884 review (🔴 GaZky) — AFFIRMATIVE proof that a 0x+64-hex local CG id is a
   * host-only/core subscription keyed by the WIRE id (the committed name-hash)
   * rather than a user-chosen cleartext id that merely looks hash-shaped.
   *
   * Host-only auto-subscribe paths (chain-event + discovery-beacon) stage the
   * wire id AS the local id and explicitly record `onChainHash === id`. Only
   * that self-referential subscription commitment licenses
   * {@link localCgMatchesOnChainSlot} to accept the verbatim id against the
   * on-chain name-hash. The general reverse index is deliberately insufficient:
   * every subscription is indexed there, including hash-shaped cleartext ids.
   */
  isWireIdKeyedSubscription(this: DKGAgent, localId: string): boolean {
    if (!/^0x[0-9a-fA-F]{64}$/.test(localId)) return false;
    const lower = localId.toLowerCase();
    const sub =
      this.subscribedContextGraphs?.get(localId) ?? this.subscribedContextGraphs?.get(lower);
    return !!sub?.onChainHash && sub.onChainHash.toLowerCase() === lower;
  }

  /**
   * Resolve SWM gossip recipients, gating on the CG's on-chain READ access
   * policy. The store-only resolver (`resolveWorkspaceAgentRecipients`)
   * flags ANY allowlisted CG as requiring encryption, but a CG that is
   * PUBLIC on-chain has public-readable SWM — its allowedAgent list
   * governs publish authority, not read access. Encrypting such a CG
   * bootstraps a sender-key handshake that non-gated recipients reject
   * ("not DKG-agent gated"), which surfaced as an HTTP 500 on WM→SWM
   * promote.
   *
   * Resolve the canonical registered authority BEFORE delegating to the store
   * resolver: a public CG takes the plaintext path without resolving recipient
   * keys at all. This also
   * avoids the resolver's "Missing public encryption key" throw for an
   * allowlisted agent whose key isn't locally available — irrelevant for
   * a public CG that never encrypts. Private graphs resolve recipients from
   * the live roster; unavailable registered authority fails closed. An
   * unregistered graph whose accepted owner-signed policy is public is
   * treated like an on-chain public one. An approved private replica retains
   * the full effective metadata roster, while any explicit graph peer
   * allowlist restricts the recipient keys available to every roster member.
   */
  async resolveWorkspaceRecipientsGated(this: DKGAgent,
    input: WorkspaceAgentRecipientResolverInput,
  ): Promise<WorkspaceAgentRecipientResolution> {
    // Hydrate durable sender-key state before resolving recipients. The
    // publisher invokes the encryptor synchronously after this resolver, so
    // this keeps state I/O out of the authority-fenced interval between the
    // final recipient recheck and sender-key epoch selection/creation.
    await this.loadSwmSenderKeyState();
    return this.resolveWorkspaceAgentRecipientsForCurrentAuthority(input);
  }

  /**
   * Resolve encryption recipients from registered-chain authority. The
   * local store remains the source of authenticated encryption keys and peer
   * routing, but only the chain roster selects which agents are resolved. When
   * the graph also has a peer allowlist, recipient routing must satisfy that
   * second, conjunctive authority gate. Every chain-authorized agent must have
   * at least one usable recipient key on an allowed peer before publishing can
   * proceed, otherwise either an unauthorized peer receives the sender key or
   * an authorized member cannot read the resulting write.
   *
   * "Whether the author may share plaintext" follows from the immutable
   * on-chain access policy alone (the contract has no access-policy update),
   * so a finalized, name-bound PUBLIC snapshot answers it without a live RPC.
   * The PRIVATE roster is an encryption-key decision and is always read from
   * current chain state (`requireLiveRosterForPrivate`), never from the index.
   */
  async resolveWorkspaceAgentRecipientsForCurrentAuthority(this: DKGAgent,
    input: WorkspaceAgentRecipientResolverInput,
  ): Promise<WorkspaceAgentRecipientResolution> {
    // The receiver decides plaintext from this same transport authority
    // (isContextGraphSwmPublic), so the two ends cannot disagree (#2827).
    const transport = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.recipients,
      () => this.resolveSwmTransportAuthority(input.contextGraphId, {
        authorityReadMode: 'finalized-index-or-live',
        requireLiveRosterForPrivate: true,
      }),
    );
    if (transport.kind === 'plaintext') {
      return { requiresEncryption: false, recipients: [] };
    }
    const projection = this.contextGraphMetaProjection;
    // Legacy and approved graphs read more than keys and routes, so the
    // node-wide revision still fences them. A private roster does not use it.
    const nodeWideSnapshot = (
      resolution: WorkspaceAgentRecipientResolution,
      revision: number,
    ): RecipientSnapshot => ({
      resolution,
      stayedCurrent: () => revision === projection.readAuthorityFactsRevision,
    });
    let resolveKeys: () => Promise<RecipientSnapshot>;
    if (transport.kind === 'legacy-unregistered') {
      resolveKeys = async () => {
        const attemptRevision = projection.readAuthorityFactsRevision;
        return nodeWideSnapshot(await resolveWorkspaceAgentRecipients(this.store, input), attemptRevision);
      };
    } else if (transport.kind === 'approved-private-replica') {
      // Resolve the complete effective metadata roster first. Participant
      // approval authorizes this receiver; it is not a replacement roster.
      // The peer gate comes from the same source-qualified, revision-fenced
      // proof as the transport classification, never the merged projection.
      resolveKeys = async () => {
        const attemptRevision = projection.readAuthorityFactsRevision;
        const resolution = await resolveWorkspaceAgentRecipients(this.store, input);
        if (!resolution.requiresEncryption) {
          throw new Error(
            `Approved private replica "${input.contextGraphId}" resolved a plaintext SWM roster`,
          );
        }
        if (transport.allowedPeers.length === 0) return nodeWideSnapshot(resolution, attemptRevision);

        const allowedPeerSet = new Set(transport.allowedPeers);
        const effectiveAgentAddresses = new Set(
          resolution.recipients.map(({ agentAddress }) => agentAddress.toLowerCase()),
        );
        const authorizedRecipients = resolution.recipients.filter((recipient) => (
          recipient.peerId !== undefined && allowedPeerSet.has(recipient.peerId)
        ));
        const authorizedAgentAddresses = new Set(
          authorizedRecipients.map(({ agentAddress }) => agentAddress.toLowerCase()),
        );
        for (const agentAddress of effectiveAgentAddresses) {
          if (!authorizedAgentAddresses.has(agentAddress)) {
            throw new Error(
              `Approved private replica "${input.contextGraphId}" requires encrypted SWM gossip but `
              + `effective DKG agent ${ethers.getAddress(agentAddress)} has no recipient key `
              + 'advertised by a peer in the context graph allowlist',
            );
          }
        }
        const [firstRecipient, ...remainingRecipients] = authorizedRecipients;
        if (!firstRecipient) {
          throw new Error(
            `Approved private replica "${input.contextGraphId}" requires encrypted SWM gossip but has no allowed DKG agent recipients`,
          );
        }
        const authorizedResolution = {
          requiresEncryption: true,
          recipients: [firstRecipient, ...remainingRecipients],
        } as const;
        return nodeWideSnapshot(authorizedResolution, attemptRevision);
      };
    } else {
      if (transport.kind === 'unavailable') {
        const message =
          `Registered context graph "${input.contextGraphId}" authority is unavailable (${transport.reason})`;
        throw createContextGraphAuthorityError(message, { ...transport, site: 'transport-unavailable' });
      }
      const participantAgents = transport.participantAgents;
      if (participantAgents.length === 0) {
        throw new Error(
          `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but its authoritative chain roster is empty or unavailable`,
        );
      }

      // Resolve only the live chain-authorized addresses. Filtering a completed
      // local resolution afterward is too late: stale removed members can have
      // malformed/missing key metadata that makes the local resolver throw
      // before the chain intersection is reached, blocking every post-revoke
      // write until the local cleanup retry succeeds.
      resolveKeys = async () => {
        // The registered/accepted private roster, local peer gate, and verified
        // recipient-key routes are conjunctive authorities, each fenced by what
        // it changes with: the roster by the transport re-read, the peer gate and
        // the keys and routes by their own revisions, which are checked
        // synchronously right after that re-read. Capture them before every
        // attempt so a phonebook-hydration retry owns a new snapshot.
        await projection.recipientKeyRouteFence.ensureReady();
        const attemptRevision = projection.recipientKeyRouteFence.revision;
        const attemptGate = projection.peerGateRevision.read(input.contextGraphId);
        const allowedPeers = await this.getContextGraphAllowedPeers(input.contextGraphId);
        const allowedPeerSet = allowedPeers === null ? null : new Set(allowedPeers);
        const recipients: WorkspaceAgentRecipient[] = [];
        // Every member without a key is named at once, so one phonebook fetch
        // can cover them all (#2849). Any other key failure still stops here.
        const missingKeys: string[] = [];
        for (const agentAddress of participantAgents) {
          let agentRecipients: WorkspaceAgentRecipient[];
          try {
            agentRecipients = await resolveWorkspaceAgentRecipientKeys(this.store, agentAddress);
          } catch (error) {
            if (!isWorkspaceAgentEncryptionKeyMissingError(error)) throw error;
            missingKeys.push(...error.agentAddresses);
            continue;
          }
          const authorizedRecipients = allowedPeerSet === null
            ? agentRecipients
            : agentRecipients.filter((recipient) => (
              recipient.peerId !== undefined && allowedPeerSet.has(recipient.peerId)
            ));
          if (authorizedRecipients.length === 0) {
            throw new Error(
              `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but `
              + `chain-authorized DKG agent ${ethers.getAddress(agentAddress)} has no recipient key `
              + 'advertised by a peer in the context graph allowlist',
            );
          }
          recipients.push(...authorizedRecipients);
        }
        if (missingKeys.length > 0) throw new WorkspaceAgentEncryptionKeyMissingError(missingKeys);
        const [firstRecipient, ...remainingRecipients] = recipients;
        if (!firstRecipient) {
          throw new Error(
            `Registered context graph "${input.contextGraphId}" requires encrypted SWM gossip but has no chain-authorized DKG agent recipients`,
          );
        }
        return {
          resolution: { requiresEncryption: true, recipients: [firstRecipient, ...remainingRecipients] },
          stayedCurrent: () => attemptRevision === projection.recipientKeyRouteFence.revision
            && attemptGate === projection.peerGateRevision.read(input.contextGraphId),
        };
      };
    }
    // A member added by address before it joined is known here only by its
    // profile, which an Edge fetches on demand (#2849). One fetch asks for
    // every member whose key is missing, then the keys are resolved once more.
    // Every member still needs a key, so a share that cannot get one stays
    // closed.
    const resolveWithPhonebookHydration = async (): Promise<RecipientSnapshot> => {
      try {
        return await resolveKeys();
      } catch (error) {
        if (!isWorkspaceAgentEncryptionKeyMissingError(error)) throw error;
        if (typeof this.ensureAgentsInOnDemandPhonebook !== 'function') {
          throw withMemberKeyHint(error);
        }
        await this.ensureAgentsInOnDemandPhonebook(
          error.agentAddresses.map((address) => address.toLowerCase()),
          AbortSignal.timeout(SWM_RECIPIENT_KEY_FETCH_WAIT_MS),
        );
      }
      try {
        return await resolveKeys();
      } catch (error) {
        throw isWorkspaceAgentEncryptionKeyMissingError(error) ? withMemberKeyHint(error) : error;
      }
    };
    let snapshot = await resolveWithPhonebookHydration();

    if (
      transport.kind === 'private-roster'
      || transport.kind === 'approved-private-replica'
      || transport.kind === 'legacy-unregistered'
    ) {
      // Key and phonebook lookup are asynchronous. Re-read the paired
      // transport decision after them so an accepted-private (or registered)
      // roster rotation cannot return keys for a member removed meanwhile.
      // Each snapshot checks what it depends on, so a window whose snapshot
      // moved collects again and is accepted when the exact (agent,key,peer) set
      // and the transport authority are stable. The last window never accepts a
      // snapshot whose check failed (GH#3067).
      for (
        let attempt = 0;
        attempt < SWM_RECIPIENT_AUTHORITY_STABILITY_ATTEMPTS;
        attempt += 1
      ) {
        const currentTransport = await withRpcUsageSite(
          CG_AUTH_RPC_SITES.recipients,
          () => this.resolveSwmTransportAuthority(input.contextGraphId, {
            authorityReadMode: 'finalized-index-or-live',
            requireLiveRosterForPrivate: true,
          }),
        );
        if (currentTransport.kind === 'unavailable') {
          throw createContextGraphAuthorityError(
            `Context graph "${input.contextGraphId}" recipient authority is unavailable (${currentTransport.reason})`,
            { ...currentTransport, site: 'transport-unavailable' },
          );
        }
        const transportStayedCurrent = transport.kind === 'private-roster'
          ? currentTransport.kind === 'private-roster'
            && snapshot.resolution.requiresEncryption
            && hasExactRecipientAgentRoster(snapshot.resolution, currentTransport.participantAgents)
          : transport.kind === 'approved-private-replica'
            ? currentTransport.kind === 'approved-private-replica'
              && sameStringSet(transport.allowedPeers, currentTransport.allowedPeers)
            : currentTransport.kind === 'legacy-unregistered';
        if (transportStayedCurrent && snapshot.stayedCurrent()) break;

        if (!transportStayedCurrent) {
          throw createRecipientAuthorityChangedError(input.contextGraphId, 'transport-changed');
        }
        if (attempt + 1 >= SWM_RECIPIENT_AUTHORITY_STABILITY_ATTEMPTS) {
          throw createRecipientAuthorityChangedError(input.contextGraphId, 'revision-moved');
        }

        const retried = await resolveWithPhonebookHydration();
        const recipientSnapshotStayedCurrent = snapshot.resolution.requiresEncryption
          ? retried.resolution.requiresEncryption
            && hasExactWorkspaceRecipientSet(snapshot.resolution, retried.resolution)
          : !retried.resolution.requiresEncryption;
        if (!recipientSnapshotStayedCurrent) {
          throw createRecipientAuthorityChangedError(input.contextGraphId, 'recipient-set-changed');
        }
        snapshot = retried;
      }
    }
    return snapshot.resolution;
  }

  async encryptWorkspacePayloadWithSenderKey(this: DKGAgent,
    input: WorkspaceSenderKeyEncryptInput,
  ): Promise<Uint8Array> {
    let resolution = input.resolution;
    if (!this.swmSenderKeyStateLoaded) {
      await this.loadSwmSenderKeyState();
      // Recipient authority may have changed while durable state was loading.
      // Resolve once against the now-hydrated state and proceed only when the
      // exact agent/key/peer snapshot is unchanged. The production publisher
      // avoids this compatibility reread by hydrating in
      // resolveWorkspaceRecipientsGated above.
      const currentResolution = await this.resolveWorkspaceAgentRecipientsForCurrentAuthority({
        contextGraphId: input.contextGraphId,
      });
      if (
        !currentResolution.requiresEncryption
        || !hasExactWorkspaceRecipientSet(resolution, currentResolution)
      ) {
        throw createContextGraphAuthorityError(
          `Context graph "${input.contextGraphId}" authority changed while sender-key state was loading`,
          {
            reason: 'chain-participant-authority-unavailable',
            detail: 'retry recipient resolution before creating or reusing a sender-key epoch',
          },
        );
      }
      resolution = currentResolution;
    }
    const ctx = createOperationContext('share', input.operationId);
    const sender = this.getLocalSigningAgentForAddress(input.senderAgentAddress);
    if (!sender) {
      throw new Error(`Cannot create SWM Sender Key epoch: no local custodial signing key for agent ${input.senderAgentAddress}`);
    }

    const senderAddress = ethers.getAddress(sender.agentAddress);
    const recipientSet = new Set(resolution.recipients.map((recipient) => recipient.agentAddress.toLowerCase()));
    if (!recipientSet.has(senderAddress.toLowerCase())) {
      throw new Error(`Sender agent ${senderAddress} is not a DKG agent recipient for context graph "${input.contextGraphId}"`);
    }

    this.logSwmSenderKeyDebugPlainPayload(ctx, 'plain-before-encrypt', input.plaintext, {
      senderAgentAddress: senderAddress,
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
    });
    const membershipHash = computeSwmSenderKeyMembershipHash({
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      members: resolution.recipients.map((recipient) => ({
        agentAddress: recipient.agentAddress,
        recipientKeyId: recipient.recipientKeyId,
      })),
    });
    const recipientRouteHash = computeSwmSenderKeyRecipientRouteHash({
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      recipients: resolution.recipients,
    });
    const stateKey = swmSenderStateKey(input.contextGraphId, input.subGraphName, senderAddress);
    let state = this.swmSenderKeySendStates.get(stateKey);
    if (
      !state
      || state.membershipHash !== membershipHash
      || state.recipientRouteHash !== recipientRouteHash
    ) {
      const pruned = this.prunePendingSenderKeysForEpochRotation({
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        senderAgentAddress: senderAddress,
      });
      if (pruned > 0) {
        this.log.warn(
          ctx,
          `SWM sender-key epoch rotation pruned ${pruned} stale pending setup package(s) ` +
          `for context graph "${input.contextGraphId}${input.subGraphName ? `/${input.subGraphName}` : ''}" sender ${senderAddress}`,
        );
        await this.saveSwmSenderKeyState();
      }
      state = await this.createAndDistributeSwmSenderKeyEpoch({
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        sender,
        recipients: resolution.recipients,
        membershipHash,
        ctx,
      });
      this.swmSenderKeySendStates.set(stateKey, state);
      await this.saveSwmSenderKeyState();
    } else {
      await this.drainPendingSenderKeyForRecipients(resolution.recipients, ctx, {
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        senderAgentAddress: state.senderAgentAddress,
        epochId: state.epochId,
      });
    }

    const encrypted = await encryptSwmSenderKeyMessage({
      chainKey: state.chainKey,
      plaintext: input.plaintext,
      senderSigningSecretKey: state.senderSigningSecretKey,
      contextGraphId: state.contextGraphId,
      subGraphName: state.subGraphName,
      senderAgentAddress: state.senderAgentAddress,
      epochId: state.epochId,
      membershipHash: state.membershipHash,
      messageIndex: state.nextMessageIndex,
    });
    state.chainKey = encrypted.nextChainKey;
    state.nextMessageIndex += 1;
    await this.saveSwmSenderKeyState();
    this.logSwmSenderKeyDebugEncryptedPayload(ctx, encrypted.message);

    this.log.info(
      ctx,
      `SWM sender-key broadcast send: senderAgent=${senderAddress} contextGraph=${state.contextGraphId}` +
      `${state.subGraphName ? `/${state.subGraphName}` : ''} epoch=${state.epochId} ` +
      `messageIndex=${uint64ForProto(encrypted.message.messageIndex)} membershipHash=${state.membershipHash} ` +
      `ciphertextBytes=${encrypted.message.ciphertext.length}`,
    );
    return encodeSwmSenderKeyMessage(encrypted.message);
  }

  async createAndDistributeSwmSenderKeyEpoch(this: DKGAgent, input: {
    contextGraphId: string;
    subGraphName?: string;
    sender: AgentKeyRecord & { privateKey: string };
    recipients: readonly WorkspaceAgentRecipient[];
    membershipHash: string;
    ctx: OperationContext;
  }): Promise<LocalSwmSenderKeySendState> {
    const senderAgentAddress = ethers.getAddress(input.sender.agentAddress);
    const createdAtMs = Date.now();
    const epochId = generateSwmSenderEpochId();
    const chainKey = generateSwmSenderChainKey();
    const senderSigningKeypair = await generateEd25519Keypair();
    const state: LocalSwmSenderKeySendState = {
      contextGraphId: input.contextGraphId,
      subGraphName: input.subGraphName,
      senderAgentAddress,
      epochId,
      membershipHash: input.membershipHash,
      recipientRouteHash: computeSwmSenderKeyRecipientRouteHash({
        contextGraphId: input.contextGraphId,
        subGraphName: input.subGraphName,
        recipients: input.recipients,
      }),
      chainKey,
      nextMessageIndex: 0,
      senderSigningSecretKey: senderSigningKeypair.secretKey,
      senderSigningPublicKey: senderSigningKeypair.publicKey,
      createdAtMs,
    };

    // A recipient agent may hold multiple registered keys. We try each one; if
    // a remote daemon owns the private half of one of them, that handshake
    // succeeds and we count the agent as delivered. The other keys will fail
    // (the recipient daemon has no matching local privkey for them) — that's
    // expected, not a hard error. We only abort when EVERY key for a given
    // agent failed.
    //
    // Fanout runs in parallel via Promise.allSettled. The pre-rc.12 loop
    // awaited each `messenger.sendReliable` sequentially, so foreground
    // publish latency scaled as `O(n_recipients × n_keys × send_timeout)` —
    // a single offline member paid the full per-send timeout before the
    // loop advanced. Concurrent fanout keeps the wall-clock cost bounded
    // by the slowest individual send (~`DEFAULT_SEND_TIMEOUT_MS`).
    //
    // Concurrent mutation is moot: each per-recipient async closure runs
    // on the single JS event loop and yields only at `await` points; the
    // aggregation maps are appended to ONLY in the post-settle pass below.
    type PerRecipientOutcome =
      | { kind: 'success'; agentAddress: string }
      | { kind: 'failure'; agentAddress: string; keyId: string; error: Error };

    let pendingSenderKeyQueued = false;
    const settled = await Promise.allSettled(
      input.recipients.map(async (recipient): Promise<PerRecipientOutcome> => {
        const recipientAgentAddress = ethers.getAddress(recipient.agentAddress);
        const pkg = await this.createSignedSwmSenderKeyPackage({
          state,
          recipient,
          senderPrivateKey: input.sender.privateKey,
        });
        const packageBytes = encodeSwmSenderKeyPackage(pkg);

        const recipientIsLocal = this.hasLocalAgent(recipientAgentAddress);
        let targetsLocalPeer = recipient.peerId === undefined;
        if (recipientIsLocal && recipient.peerId !== undefined) {
          const localPeerId = this.node.peerId.toString();
          const canonicalRecipientPeerId = tryCanonicalPeerIdString(recipient.peerId);
          const canonicalLocalPeerId = tryCanonicalPeerIdString(localPeerId);
          targetsLocalPeer = recipient.peerId === localPeerId
            || (
              canonicalRecipientPeerId !== null
              && canonicalLocalPeerId !== null
              && canonicalRecipientPeerId === canonicalLocalPeerId
            );
        }
        if (recipientIsLocal && targetsLocalPeer) {
          try {
            await this.acceptSwmSenderKeyPackage(pkg, this.node.peerId.toString(), input.ctx);
            return { kind: 'success', agentAddress: recipientAgentAddress };
          } catch (err) {
            return {
              kind: 'failure',
              agentAddress: recipientAgentAddress,
              keyId: recipient.recipientKeyId,
              error: err instanceof Error ? err : new Error(String(err)),
            };
          }
        }

        if (!recipient.peerId) {
          // PR-2 (SWM-fanout plan): the recipient agent has no advertised
          // `dkg:peerId` triple in our local store (typically because we
          // haven't synced their profile yet, or they really were never
          // online). Pre-PR-2 this was a HARD failure for that key, and
          // if every key for the agent landed here the whole publish
          // threw — turning "one never-seen member" into "publish blocked
          // for everyone". We now match the messenger.sendReliable
          // soft-success contract: durably remember the package and
          // attempt delivery once the agent shows up (via the
          // connection:open drain below).
          this.enqueuePendingSenderKey({
            senderAgentAddress: senderAgentAddress.toLowerCase(),
            recipientAgentAddress: recipientAgentAddress.toLowerCase(),
            recipientKeyId: recipient.recipientKeyId,
            epochId: state.epochId,
            contextGraphId: state.contextGraphId,
            subGraphName: state.subGraphName,
            packageBytes,
            createdAtMs: Date.now(),
          });
          pendingSenderKeyQueued = true;
          this.log.warn(
            input.ctx,
            `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
            `queued (no advertised peerId) — will deliver after a verified peer route is learned`,
          );
          return { kind: 'success', agentAddress: recipientAgentAddress };
        }

        this.log.info(
          input.ctx,
          `SWM sender-key setup send: senderAgent=${senderAgentAddress} recipientAgent=${recipientAgentAddress} ` +
          `peerId=${recipient.peerId} contextGraph=${state.contextGraphId}${state.subGraphName ? `/${state.subGraphName}` : ''} ` +
          `epoch=${state.epochId} membershipHash=${state.membershipHash} recipientKeyId=${recipient.recipientKeyId}`,
        );
        try {
          // rc.9 PR-8: route through messenger.sendReliable so
          // sender-side idempotency + durable outbox + retry-with-
          // backoff cover this protocol the same way they cover chat.
          //
          // Delivery semantics (C2 integration-pass relaxation):
          //   • `delivered=true && ack.accepted=true` → success.
          //   • `delivered=true && ack.accepted=false` with no reason code,
          //     or with a known terminal reason (`stale-target`,
          //     `active-private-key-missing`, `revoked-key`,
          //     `bad-signature`, `unknown`, ACL/config failures)
          //     → HARD failure: retrying the same package cannot help.
          //   • `delivered=true && ack.accepted=false` with an explicitly
          //     retryable reason → SOFT success: keep it queued so a later
          //     reconnect/publish can retry after remote view convergence.
          //   • `delivered=false` → SOFT success.
          //     The setup-package landed in the messenger's durable
          //     outbox, but the agent also keeps a local pending row
          //     under the same messageId so future retries still decode
          //     the Sender Key ACK and can rotate after delivered
          //     malformed/retryable responses. Treating this as a hard
          //     failure used to block any open-publish-CG write whenever
          //     the curator was offline mid-batch, breaking the "members
          //     keep publishing under intermittent curator availability"
          //     contract C2 exercises. The recipient still gets the
          //     epoch + chain key eventually; the only cost is that
          //     they can't decrypt the broadcast that immediately
          //     follows until the queued setup catches up.
          const messageId = this.swmSenderKeyPackageMessageId(packageBytes);
          const sendResult = await this.messenger.sendReliable(
            recipient.peerId,
            PROTOCOL_SWM_SENDER_KEY,
            packageBytes,
            { messageId },
          );
          if (!sendResult.delivered) {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              recipientPeerId: recipient.peerId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId,
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              `queued (not synchronously deliverable): ${sendResult.error} — recipient will receive on next reconnect`,
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          let ack: ReturnType<typeof decodeSwmSenderKeyPackageAck>;
          try {
            ack = decodeSwmSenderKeyPackageAck(sendResult.response);
          } catch {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              recipientPeerId: recipient.peerId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              'queued after malformed Sender Key setup ACK',
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          if (
            ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
            ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE
          ) {
            this.enqueuePendingSenderKey({
              senderAgentAddress: senderAgentAddress.toLowerCase(),
              recipientAgentAddress: recipientAgentAddress.toLowerCase(),
              recipientKeyId: recipient.recipientKeyId,
              recipientPeerId: recipient.peerId,
              epochId: state.epochId,
              contextGraphId: state.contextGraphId,
              subGraphName: state.subGraphName,
              packageBytes,
              messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
              createdAtMs: Date.now(),
            });
            pendingSenderKeyQueued = true;
            this.log.warn(
              input.ctx,
              `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
              `queued after incompatible Sender Key setup ACK version/type (${ack.version}/${ack.type})`,
            );
            return { kind: 'success', agentAddress: recipientAgentAddress };
          }
          if (!ack.accepted) {
            const reason = ack.reason ?? 'unknown reason';
            if (this.isRetryableSwmSenderKeySetupAckReason(ack.reasonCode)) {
              this.enqueuePendingSenderKey({
                senderAgentAddress: senderAgentAddress.toLowerCase(),
                recipientAgentAddress: recipientAgentAddress.toLowerCase(),
                recipientKeyId: recipient.recipientKeyId,
                recipientPeerId: recipient.peerId,
                epochId: state.epochId,
                contextGraphId: state.contextGraphId,
                subGraphName: state.subGraphName,
                packageBytes,
                messageId: this.nextSwmSenderKeyPackageMessageId(packageBytes),
                createdAtMs: Date.now(),
              });
              pendingSenderKeyQueued = true;
              this.log.warn(
                input.ctx,
                `SWM sender-key setup for ${recipientAgentAddress} keyId=${recipient.recipientKeyId} ` +
                `queued after retryable rejection (${ack.reasonCode ?? 'legacy-unknown'}): ${reason}`,
              );
              return { kind: 'success', agentAddress: recipientAgentAddress };
            }
            return {
              kind: 'failure',
              agentAddress: recipientAgentAddress,
              keyId: recipient.recipientKeyId,
              error: new Error(`${ack.reasonCode ? `${ack.reasonCode}: ` : ''}${reason}`),
            };
          }
          return { kind: 'success', agentAddress: recipientAgentAddress };
        } catch (err) {
          return {
            kind: 'failure',
            agentAddress: recipientAgentAddress,
            keyId: recipient.recipientKeyId,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );

    const failuresByAgent = new Map<string, string[]>();
    const successByAgent = new Set<string>();
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'rejected') {
        // The per-recipient closure catches all throw paths and returns a
        // failure outcome, so a rejection here means the closure itself
        // crashed (programmer error). Record it against the recipient so
        // the surrounding logic doesn't lose track of the slot.
        const recipient = input.recipients[i];
        const agent = ethers.getAddress(recipient.agentAddress).toLowerCase();
        const list = failuresByAgent.get(agent) ?? [];
        list.push(`${recipient.recipientKeyId}: ${String(r.reason)}`);
        failuresByAgent.set(agent, list);
        continue;
      }
      const outcome = r.value;
      if (outcome.kind === 'success') {
        successByAgent.add(outcome.agentAddress.toLowerCase());
      } else {
        const agent = outcome.agentAddress.toLowerCase();
        const list = failuresByAgent.get(agent) ?? [];
        list.push(`${outcome.keyId}: ${outcome.error.message}`);
        failuresByAgent.set(agent, list);
      }
    }

    // Surface only agents for whom ALL keys failed. Mixed-success failures get
    // a per-key warning so operators can see the noise but SWM still progresses.
    const fatalAgents: string[] = [];
    for (const [agentAddress, reasons] of failuresByAgent.entries()) {
      if (successByAgent.has(agentAddress)) {
        this.log.warn(
          input.ctx,
          `SWM sender-key setup partial delivery for agent ${agentAddress} (epoch ${state.epochId}): ${reasons.join('; ')} — expected when recipient holds only a subset of registered keys`,
        );
      } else {
        fatalAgents.push(`${agentAddress}: ${reasons.join('; ')}`);
      }
    }
    if (fatalAgents.length > 0) {
      if (pendingSenderKeyQueued) {
        await this.saveSwmSenderKeyState();
      }
      throw new Error(
        `SWM Sender Key setup rejected by ${fatalAgents.length} agent(s): ${fatalAgents.join(' | ')}`,
      );
    }

    return state;
  }

  swmSenderKeySetupAckReasonCode(this: DKGAgent, err: unknown): SwmSenderKeyPackageAckReasonCode {
    if (err instanceof StaleSenderKeyTargetError) {
      return 'stale-target';
    }
    if (err instanceof SwmSenderKeySetupRejectionError) {
      return err.reasonCode;
    }
    return 'unknown';
  }

  isRetryableSwmSenderKeySetupAckReason(this: DKGAgent,
    reasonCode: SwmSenderKeyPackageAckReasonCode | undefined,
  ): boolean {
    if (!reasonCode) return false;
    return (SWM_SENDER_KEY_PACKAGE_ACK_RETRYABLE_REASON_CODES as readonly string[]).includes(reasonCode);
  }

  swmSenderKeyPackageMessageId(this: DKGAgent, packageBytes: Uint8Array): string {
    return `swm-sender-key:${createHash('sha256').update(packageBytes).digest('hex')}`;
  }

  nextSwmSenderKeyPackageMessageId(this: DKGAgent, packageBytes: Uint8Array): string {
    return `${this.swmSenderKeyPackageMessageId(packageBytes)}:${randomUUID()}`;
  }

  swmSenderKeyPendingMessageId(this: DKGAgent, entry: PendingSenderKeyEntry): string {
    return entry.messageId ?? this.swmSenderKeyPackageMessageId(entry.packageBytes);
  }

  rotateSwmSenderKeyPendingMessageId(this: DKGAgent, entry: PendingSenderKeyEntry): PendingSenderKeyEntry {
    return {
      ...entry,
      messageId: this.nextSwmSenderKeyPackageMessageId(entry.packageBytes),
    };
  }

  /**
   * PR-2 (SWM-fanout plan): enqueue a sender-key package whose recipient
   * has no advertised `dkg:peerId` (so we can't even ask the messenger
   * to queue it). Older epochs for the same `(sender, recipient, context
   * graph, subgraph)` scope are evicted — a newer epoch supersedes them by
   * definition. Other graph/subgraph obligations remain independent.
   *
   * Per-route dedup: `(senderAgentAddress, recipientKeyId,
   * recipientPeerId, epochId)` matches an existing row, we replace it
   * (idempotent re-enqueue). Distinct peers advertising the same key retain
   * independent delivery obligations.
   */
  enqueuePendingSenderKey(this: DKGAgent, entry: PendingSenderKeyEntry): void {
    const recipientKey = entry.recipientAgentAddress.toLowerCase();
    const existing = this.pendingSenderKeyByAgent.get(recipientKey) ?? [];
    // Drop older epochs only within the same sender + graph/subgraph scope;
    // the newer epoch's membership hash supersedes those rows. The map key
    // already scopes recipient agent. Keep every other scope unchanged.
    const filtered = existing.filter((e) => {
      if (e.senderAgentAddress !== entry.senderAgentAddress) return true;
      if (
        e.contextGraphId !== entry.contextGraphId
        || (e.subGraphName ?? undefined) !== (entry.subGraphName ?? undefined)
      ) {
        return true;
      }
      if (e.epochId === entry.epochId) {
        // Same epoch: dedupe only the exact key + peer route. A successful
        // ACK from one peer must never overwrite a retry owed to another peer
        // that advertises the same agent/key pair.
        return e.recipientKeyId !== entry.recipientKeyId
          || e.recipientPeerId !== entry.recipientPeerId;
      }
      return false;
    });
    filtered.push(entry);
    this.pendingSenderKeyByAgent.set(recipientKey, filtered);
  }

  prunePendingSenderKeysForEpochRotation(this: DKGAgent, input: {
    contextGraphId: string;
    subGraphName?: string;
    senderAgentAddress: string;
  }): number {
    const senderAgentAddress = ethers.getAddress(input.senderAgentAddress).toLowerCase();
    let removed = 0;
    for (const [recipientKey, queue] of this.pendingSenderKeyByAgent.entries()) {
      const kept = queue.filter((entry) => {
        const matches =
          entry.senderAgentAddress === senderAgentAddress &&
          entry.contextGraphId === input.contextGraphId &&
          (entry.subGraphName ?? undefined) === (input.subGraphName ?? undefined);
        if (matches) removed += 1;
        return !matches;
      });
      if (kept.length === 0) {
        this.pendingSenderKeyByAgent.delete(recipientKey);
      } else {
        this.pendingSenderKeyByAgent.set(recipientKey, kept);
      }
    }
    return removed;
  }

  async drainPendingSenderKeyQueueForPeer(this: DKGAgent, input: {
    authority: PendingSenderKeyDrainAuthority;
    ctx?: OperationContext;
  }): Promise<number> {
    const authority: PendingSenderKeyDrainAuthority = {
      ...input.authority,
      recipientAgentAddress: input.authority.recipientAgentAddress.toLowerCase(),
      senderAgentAddress: input.authority.senderAgentAddress?.toLowerCase(),
    };
    const recipientAgentAddress = authority.recipientAgentAddress;
    const existingDrain = this.pendingSenderKeyDrainByAgent.get(recipientAgentAddress);
    if (existingDrain) {
      await existingDrain;
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) return 0;
      return this.drainPendingSenderKeyQueueForPeer({ authority, ctx: input.ctx });
    }
    const drain = this.drainPendingSenderKeyQueueForPeerLocked({
      authority,
      ctx: input.ctx,
    }).finally(() => {
      if (this.pendingSenderKeyDrainByAgent.get(recipientAgentAddress) === drain) {
        this.pendingSenderKeyDrainByAgent.delete(recipientAgentAddress);
      }
    });
    this.pendingSenderKeyDrainByAgent.set(recipientAgentAddress, drain);
    return drain;
  }

  async drainPendingSenderKeyQueueForPeerLocked(this: DKGAgent, input: {
    authority: PendingSenderKeyDrainAuthority;
    ctx?: OperationContext;
  }): Promise<number> {
    const { authority } = input;
    const recipientAgentAddress = authority.recipientAgentAddress;
    const queue = this.pendingSenderKeyByAgent.get(recipientAgentAddress);
    if (!queue || queue.length === 0) return 0;

    let drained = 0;
    // `sendReliable` yields. Enqueue/epoch rotation can replace the live array
    // while this drain is in flight, so record outcomes against the exact
    // snapshot objects instead of later overwriting the whole map entry. At
    // commit, only original objects still present in the live queue are
    // transformed; concurrently inserted replacements/new scopes survive and
    // originals concurrently superseded by a new epoch are not resurrected.
    const outcomes = new Map<PendingSenderKeyEntry, PendingSenderKeyEntry | null>();
    const commitOutcomes = () => {
      const live = this.pendingSenderKeyByAgent.get(recipientAgentAddress) ?? [];
      const reconciled: PendingSenderKeyEntry[] = [];
      for (const liveEntry of live) {
        if (!outcomes.has(liveEntry)) {
          reconciled.push(liveEntry);
          continue;
        }
        const replacement = outcomes.get(liveEntry);
        if (replacement) reconciled.push(replacement);
      }
      if (reconciled.length === 0) {
        this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
      } else {
        this.pendingSenderKeyByAgent.set(recipientAgentAddress, reconciled);
      }
    };
    for (let i = 0; i < queue.length; i += 1) {
      const entry = queue[i];
      // A row may only be consumed by the caller's exact current-authority
      // route and graph scope. Legacy/no-peer rows are expanded into explicit
      // peer-bound obligations before reaching this drain. Foreground callers
      // additionally bind the current sender + epoch; connection-open callers
      // explicitly authorize every subgraph for one resolved CG.
      if (!pendingSenderKeyEntryMatchesDrainAuthority(entry, authority)) {
        outcomes.set(entry, entry);
        continue;
      }
      // Authority can change while this route waits for the per-agent drain
      // lock, or while a preceding row is in flight. Re-resolve immediately
      // before every send so a stale caller snapshot can never consume a row.
      let routeStillCurrent = false;
      try {
        const resolution = await this.resolveWorkspaceAgentRecipientsForCurrentAuthority({
          contextGraphId: entry.contextGraphId,
        });
        routeStillCurrent = resolution.requiresEncryption
          && resolution.recipients.some((recipient) => (
            recipient.agentAddress.toLowerCase() === entry.recipientAgentAddress
            && recipient.recipientKeyId === entry.recipientKeyId
            && recipient.peerId === entry.recipientPeerId
          ));
      } catch {
        // Fail closed. The queued obligation remains available for a later
        // current-authority retry.
      }
      if (!routeStillCurrent) {
        outcomes.set(entry, entry);
        continue;
      }
      try {
        const sendResult = await this.messenger.sendReliable(
          authority.recipientPeerId,
          PROTOCOL_SWM_SENDER_KEY,
          entry.packageBytes,
          { messageId: this.swmSenderKeyPendingMessageId(entry) },
        );
        if (!sendResult.delivered) {
          if (sendResult.queued || ('inFlight' in sendResult && sendResult.inFlight)) {
            outcomes.set(entry, entry);
            continue;
          }
          throw new Error(`Unexpected undelivered Sender Key retry result: ${sendResult.error}`);
        }
        let ack: ReturnType<typeof decodeSwmSenderKeyPackageAck>;
        try {
          ack = decodeSwmSenderKeyPackageAck(sendResult.response);
        } catch {
          // Malformed/legacy ACK: no positive acceptance yet. Keep the
          // row queued so a mixed-version rollout cannot strand the recipient.
          outcomes.set(entry, this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (
          ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
          ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE
        ) {
          // Malformed/legacy ACK: no positive acceptance yet. Keep the
          // row queued so a mixed-version rollout cannot strand the recipient.
          outcomes.set(entry, this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (ack.accepted) {
          drained += 1;
          outcomes.set(entry, null);
        } else if (this.isRetryableSwmSenderKeySetupAckReason(ack.reasonCode)) {
          outcomes.set(entry, this.rotateSwmSenderKeyPendingMessageId(entry));
        } else {
          const reason = ack.reason ?? 'unknown reason';
          const reasonCode = ack.reasonCode ?? 'legacy-unknown';
          this.log.warn(
            input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
            `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
            `peerId=${authority.recipientPeerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
            `dropped after terminal rejection (${reasonCode}): ${reason}`,
          );
          // Terminal rejection: keep it out of the queue, but do not
          // report it as a successful drain.
          outcomes.set(entry, null);
        }
      } catch (err) {
        outcomes.set(entry, entry);
        for (const unprocessed of queue.slice(i + 1)) {
          outcomes.set(unprocessed, unprocessed);
        }
        commitOutcomes();
        await this.saveSwmSenderKeyState();
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
          `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
          `peerId=${authority.recipientPeerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
          `failed before the Messenger substrate queued a retry: ${message}`,
        );
        throw err;
      }
    }

    commitOutcomes();
    await this.saveSwmSenderKeyState();
    return drained;
  }

  /**
   * Upgrade legacy/no-peer pending rows into one durable obligation per exact
   * `(agent, key, peer)` route in a current authority-fenced recipient
   * snapshot. The replacement is synchronous so drains can never observe a
   * partially expanded multi-peer obligation.
   */
  expandUnboundPendingSenderKeyRoutes(this: DKGAgent, input: {
    recipients: readonly WorkspaceAgentRecipient[];
    contextGraphId: string;
    subGraphName?: string;
    allSubgraphs?: boolean;
    senderAgentAddress?: string;
    epochId?: string;
  }): number {
    const peersByAgentAndKey = new Map<string, Set<string>>();
    for (const recipient of input.recipients) {
      if (!recipient.peerId) continue;
      const routeKey = `${recipient.agentAddress.toLowerCase()}\0${recipient.recipientKeyId}`;
      const peers = peersByAgentAndKey.get(routeKey) ?? new Set<string>();
      peers.add(recipient.peerId);
      peersByAgentAndKey.set(routeKey, peers);
    }
    if (peersByAgentAndKey.size === 0) return 0;

    const boundRouteIdentity = (entry: PendingSenderKeyEntry, peerId: string) => JSON.stringify([
      entry.senderAgentAddress,
      entry.recipientKeyId,
      peerId,
      entry.epochId,
      entry.contextGraphId,
      entry.subGraphName ?? null,
    ]);
    const senderAgentAddress = input.senderAgentAddress?.toLowerCase();
    let expanded = 0;
    for (const [recipientAgentAddress, queue] of this.pendingSenderKeyByAgent.entries()) {
      const existingBoundRoutes = new Set(
        queue
          .flatMap((entry) => entry.recipientPeerId === undefined
            ? []
            : [boundRouteIdentity(entry, entry.recipientPeerId)]),
      );
      let changed = false;
      const replacement: PendingSenderKeyEntry[] = [];
      for (const entry of queue) {
        const matchesScope = entry.contextGraphId === input.contextGraphId
          && (input.allSubgraphs
            || (entry.subGraphName ?? undefined) === (input.subGraphName ?? undefined))
          && (senderAgentAddress === undefined || entry.senderAgentAddress === senderAgentAddress)
          && (input.epochId === undefined || entry.epochId === input.epochId);
        if (entry.recipientPeerId !== undefined || !matchesScope) {
          replacement.push(entry);
          continue;
        }

        const peers = peersByAgentAndKey.get(
          `${entry.recipientAgentAddress}\0${entry.recipientKeyId}`,
        );
        if (!peers || peers.size === 0) {
          replacement.push(entry);
          continue;
        }

        changed = true;
        expanded += 1;
        for (const peerId of peers) {
          const identity = boundRouteIdentity(entry, peerId);
          if (existingBoundRoutes.has(identity)) continue;
          replacement.push({ ...entry, recipientPeerId: peerId });
          existingBoundRoutes.add(identity);
        }
      }
      if (changed) {
        if (replacement.length === 0) {
          this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
        } else {
          this.pendingSenderKeyByAgent.set(recipientAgentAddress, replacement);
        }
      }
    }
    return expanded;
  }

  /**
   * Drain queued sender-key packages whose exact current recipient route is
   * the newly connected `peerId`. Returns the number of rows successfully
   * delivered (acked) and removed.
   *
   * Fired from the `connection:open` listener — see line 2382 — so the
   * cost lives on the cold path of "we just connected to a new peer",
   * not on every share. Every context graph represented by either a bound or
   * legacy row is resolved first; bound rows never bypass that authority read.
   * Legacy/no-peer rows are expanded only from that graph's current,
   * authority-fenced recipient snapshot. Each successful `sendReliable` with
   * `delivered=true && ack.accepted=true` deletes the row and counts as
   * drained; soft (`delivered=false`) and explicitly retryable delivered
   * rejections leave it queued for the next attempt; terminal delivered
   * rejections are logged and deleted without counting as drained.
   */
  public async drainPendingSenderKeyForPeer(this: DKGAgent, peerId: string, ctx?: OperationContext): Promise<number> {
    await this.loadSwmSenderKeyState();
    if (this.pendingSenderKeyByAgent.size === 0) return 0;
    let drained = 0;
    const pendingContextGraphIds = new Set(
      [...this.pendingSenderKeyByAgent.values()]
        .flatMap((queue) => queue
          .filter((entry) => entry.recipientPeerId === undefined || entry.recipientPeerId === peerId)
          .map((entry) => entry.contextGraphId)),
    );
    let expandedRows = 0;

    for (const contextGraphId of pendingContextGraphIds) {
      let resolution: WorkspaceAgentRecipientResolution;
      try {
        resolution = await this.resolveWorkspaceAgentRecipientsForCurrentAuthority({
          contextGraphId,
        });
      } catch {
        // Authority/key resolution failure is benign on connection-open. No
        // row for this CG — including already bound rows — may bypass it.
        continue;
      }
      if (!resolution.requiresEncryption) continue;

      expandedRows += this.expandUnboundPendingSenderKeyRoutes({
        recipients: resolution.recipients,
        contextGraphId,
        allSubgraphs: true,
      });

      const routes = new Map<string, PendingSenderKeyDrainAuthority>();
      for (const recipient of resolution.recipients) {
        if (recipient.peerId !== peerId) continue;
        const recipientAgentAddress = recipient.agentAddress.toLowerCase();
        const authority: PendingSenderKeyDrainAuthority = {
          contextGraphId,
          allSubgraphs: true,
          recipientAgentAddress,
          recipientKeyId: recipient.recipientKeyId,
          recipientPeerId: peerId,
        };
        const queue = this.pendingSenderKeyByAgent.get(recipientAgentAddress);
        if (!queue?.some((entry) => (
          pendingSenderKeyEntryMatchesDrainAuthority(entry, authority)
        ))) continue;
        routes.set(
          `${recipientAgentAddress}\0${recipient.recipientKeyId}\0${peerId}`,
          authority,
        );
      }
      for (const authority of routes.values()) {
        drained += await this.drainPendingSenderKeyQueueForPeer({ authority, ctx });
      }
    }
    if (expandedRows > 0) {
      // A connection can teach us routes for another peer. Persist that legacy
      // migration even when this peer had no exact authorized row to drain.
      await this.saveSwmSenderKeyState();
    }
    return drained;
  }

  /**
   * A delivered Sender Key setup can receive a retryable authority denial.
   * That leaves a durable pending row but does not create a Messenger outbox
   * retry, and an already-connected recipient may never produce another
   * connection:open event. Retry only peer-bound rows on the ordinary outbox
   * cadence. The drain below re-resolves current graph authority and the exact
   * recipient key/peer route before sending any package.
   */
  public async drainPendingSenderKeysForConnectedPeers(this: DKGAgent): Promise<number> {
    await this.loadSwmSenderKeyState();
    if (this.pendingSenderKeyByAgent.size === 0 || !this.node.isStarted) return 0;

    const pendingPeers = new Set(
      [...this.pendingSenderKeyByAgent.values()]
        .flatMap((queue) => queue.flatMap((entry) =>
          entry.recipientPeerId === undefined ? [] : [entry.recipientPeerId])),
    );
    if (pendingPeers.size === 0) return 0;

    let drained = 0;
    for (const peer of this.node.libp2p.getPeers()) {
      const peerId = peer.toString();
      if (!pendingPeers.has(peerId)) continue;
      drained += await this.drainPendingSenderKeyForPeer(peerId);
    }
    return drained;
  }

  /**
   * Retry queued sender-key setup for recipients that are reachable in the
   * current workspace recipient snapshot. This covers already-established
   * connections where no fresh connection:open event will fire after the
   * remote membership/key view converges.
   */
  async drainPendingSenderKeyForRecipients(this: DKGAgent,
    recipients: readonly WorkspaceAgentRecipient[],
    ctx: OperationContext | undefined,
    scope: {
      contextGraphId: string;
      subGraphName?: string;
      senderAgentAddress: string;
      epochId: string;
    },
  ): Promise<number> {
    if (this.pendingSenderKeyByAgent.size === 0) return 0;

    const senderAgentAddress = scope.senderAgentAddress.toLowerCase();
    this.expandUnboundPendingSenderKeyRoutes({
      recipients,
      contextGraphId: scope.contextGraphId,
      subGraphName: scope.subGraphName,
      senderAgentAddress,
      epochId: scope.epochId,
    });

    const routes = new Map<string, PendingSenderKeyDrainAuthority>();
    for (const recipient of recipients) {
      if (!recipient.peerId) continue;
      const recipientAgentAddress = recipient.agentAddress.toLowerCase();
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) continue;
      const authority: PendingSenderKeyDrainAuthority = {
        contextGraphId: scope.contextGraphId,
        subGraphName: scope.subGraphName,
        senderAgentAddress,
        epochId: scope.epochId,
        recipientAgentAddress,
        recipientKeyId: recipient.recipientKeyId,
        recipientPeerId: recipient.peerId,
      };
      const routeKey = `${recipientAgentAddress}\0${recipient.recipientKeyId}\0${recipient.peerId}`;
      routes.set(routeKey, authority);
    }
    if (routes.size === 0) return 0;

    let drained = 0;
    for (const authority of routes.values()) {
      drained += await this.drainPendingSenderKeyQueueForPeer({ authority, ctx });
    }
    if (drained > 0 && ctx) {
      this.log.info(ctx, `SWM sender-key pending retry drained ${drained} queued package(s) during publish`);
    }
    return drained;
  }

  async createSignedSwmSenderKeyPackage(this: DKGAgent, input: {
    state: LocalSwmSenderKeySendState;
    recipient: WorkspaceAgentRecipient;
    senderPrivateKey: string;
  }): Promise<SwmSenderKeyPackageMsg> {
    if (!input.recipient.publicKeyBytes) {
      throw new Error(`Missing public encryption key bytes for DKG agent ${input.recipient.agentAddress}`);
    }
    const pkg = await encryptSwmSenderKeyPackage({
      contextGraphId: input.state.contextGraphId,
      subGraphName: input.state.subGraphName,
      senderAgentAddress: input.state.senderAgentAddress,
      epochId: input.state.epochId,
      membershipHash: input.state.membershipHash,
      recipientAgentAddress: ethers.getAddress(input.recipient.agentAddress),
      recipientKeyId: input.recipient.recipientKeyId,
      createdAtMs: input.state.createdAtMs,
      initialMessageIndex: 0,
      chainKey: input.state.chainKey,
      senderSigningPublicKey: input.state.senderSigningPublicKey,
      recipientPublicKey: input.recipient.publicKeyBytes,
    });
    const signature = await new ethers.Wallet(input.senderPrivateKey)
      .signMessage(computeSwmSenderKeyPackageAAD(pkg));
    return { ...pkg, signature: ethers.getBytes(signature) };
  }

  /**
   * `PROTOCOL_SWM_UPDATE` substrate receiver. Routes substrate-
   * delivered SWM share bytes through `SharedMemoryHandler.handle()`
   * (the same in-process apply path the gossip subscription
   * drives) and maps the {@link SharedMemoryApplyOutcome} to a
   * substrate response:
   *
   *   - `applied: true`                          → empty Uint8Array
   *      (ACK; sender records `delivered`).
   *   - `applied: false, retryable: true`        → THROW so
   *      `messenger.sendReliable` reports a stream error,
   *      `isRecoverableSendError` classifies it as recoverable
   *      (the libp2p stream-reset signature contains "closed" /
   *      "reset"), and the substrate outbox keeps the share
   *      queued for retry. Dominant case: sender key package
   *      for the current epoch hasn't arrived yet — once it
   *      does, the SAME wire bytes apply cleanly on retry.
   *   - `applied: false, retryable: false`       → return
   *      {@link FANOUT_RESPONSE_REJECTED} (1-byte sentinel
   *      `0x01`). The sender's `classifySendResult` recognises
   *      the sentinel and records the outcome as `rejected`,
   *      NOT `delivered` (codex R6 on PR #576). The share is
   *      dropped — retrying the same wire bytes would produce
   *      the same permanent rejection (bad signature, peer not
   *      in allowlist, validation failed, malformed protobuf).
   *
   * Extracted into a named method so the receiver contract can
   * be unit-tested in isolation without spinning up a real
   * Messenger registration.
   */
  public async handleSwmUpdate(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const wh = this.getOrCreateSharedMemoryHandler();
    const outcome = await wh.handle(data, fromPeerId);
    if (outcome.applied) {
      if (outcome.assetUal) {
        logKaLifecycleEvent(this.log, createOperationContext('share'), {
          assetUal: outcome.assetUal,
          stage: 'swm_share',
          event: 'swm_update_applied',
          role: 'receiver',
          localPeerId: this.peerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: fromPeerId,
          metadata: {
            contextGraphId: outcome.cgId,
            shareOperationId: outcome.shareOperationId,
            insertedCount: outcome.insertedTriples,
          },
        });
      }
      // PR-H bug 2: emit SwmShareAck on substrate-applied shares
      // too (not just gossip-applied). Pre-PR-H the sender only
      // counted substrate-`delivered` peers via the in-process
      // bookkeeper, which silently dropped any peer that started
      // as `queued`/`inFlight` and was delivered LATER by the
      // outbox — the outbox-completion callback isn't wired to
      // the quorum, so a successful eventual delivery never
      // called `onAck`. Those peers stayed pending until the
      // watchdog fired a top-up they didn't need.
      //
      // The fix is symmetric: the receiver emits an ack on
      // apply regardless of which transport delivered the
      // share. The publisher's `SwmAckQuorum.onAck` is
      // idempotent (no-op when the peer is already in the
      // `acked` set), so a fast substrate-bookkeeper ack
      // followed by a redundant SwmShareAck is harmless.
      // Late deliveries now reach quorum the same way fast
      // ones do.
      this.maybeEmitSwmShareAck(outcome).catch(() => { /* swallowed; logged inside */ });
      return new Uint8Array();
    }
    if (outcome.retryable) {
      if (outcome.assetUal) {
        logKaLifecycleEvent(this.log, createOperationContext('share'), {
          assetUal: outcome.assetUal,
          stage: 'swm_share',
          event: 'swm_update_rejected',
          role: 'receiver',
          localPeerId: this.peerId,
          localNodeIdentityId: this.identityId.toString(),
          peer: fromPeerId,
          level: 'warn',
          metadata: {
            contextGraphId: outcome.cgId,
            shareOperationId: outcome.shareOperationId,
            outcome: 'retryable',
            retryable: true,
            reason: outcome.reason,
          },
        });
      }
      // rc.9 PR-D (codex follow-up from PR-G #G1): return the
      // 0x02 sentinel instead of throwing. Pre-PR-D this branch
      // threw, hoping libp2p would surface the handler abort as
      // a recoverable stream-reset so `isRecoverableSendError`
      // would re-queue into the outbox. That hope was fragile:
      // the non-pooled ProtocolRouter aborts with the literal
      // string "handler error", which doesn't match
      // reset/closed/timeout — the share got DROPPED instead of
      // queued. The sentinel sidesteps the abort path entirely:
      // wire layer succeeds, sender's `classifySendResult`
      // re-buckets 0x02 into the `retryable` outcome, the peer
      // is NOT added to the pre-acked set, and SwmAckQuorum's
      // watchdog fires substrate top-up at watchdogMs — giving
      // upstream state time to converge before the retry.
      this.log.info(
        createOperationContext('share'),
        `SWM substrate receiver transient rejection from ${fromPeerId} (PR-D watchdog will retry): ${outcome.reason}`,
      );
      return FANOUT_RESPONSE_RETRYABLE;
    }
    if (outcome.assetUal) {
      logKaLifecycleEvent(this.log, createOperationContext('share'), {
        assetUal: outcome.assetUal,
        stage: 'swm_share',
        event: 'swm_update_rejected',
        role: 'receiver',
        localPeerId: this.peerId,
        localNodeIdentityId: this.identityId.toString(),
        peer: fromPeerId,
        level: 'warn',
        metadata: {
          contextGraphId: outcome.cgId,
          shareOperationId: outcome.shareOperationId,
          outcome: 'rejected',
          retryable: false,
          reason: outcome.reason,
        },
      });
    }
    // Permanent rejection: signal via the 1-byte sentinel so the
    // sender records `rejected` (not `delivered`) and stops here.
    this.log.warn(
      createOperationContext('share'),
      `SWM substrate receiver dropping share from ${fromPeerId} (permanent rejection): ${outcome.reason}`,
    );
    return FANOUT_RESPONSE_REJECTED;
  }

  public async handleSwmSenderKeyPackage(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    let pkg: SwmSenderKeyPackageMsg | undefined;
    try {
      pkg = decodeSwmSenderKeyPackage(data);
      await this.acceptSwmSenderKeyPackage(pkg, fromPeerId, ctx);
      return encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: true,
        contextGraphId: pkg.contextGraphId,
        subGraphName: pkg.subGraphName,
        senderAgentAddress: pkg.senderAgentAddress,
        epochId: pkg.epochId,
        membershipHash: pkg.membershipHash,
        recipientAgentAddress: pkg.recipientAgentAddress,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const reasonCode = this.swmSenderKeySetupAckReasonCode(err);
      if (pkg) {
        // A sender-key setup may legitimately be fanned out across every
        // cached snapshot of our agent's public encryption keys. Each
        // bootstrap that targets a fingerprint we don't host as an
        // active local key throws `StaleSenderKeyTargetError` and is
        // not actionable for the operator — the matching bootstrap that
        // hits our active key is logged at INFO via
        // `SWM sender-key setup receive accepted`. Logging every stale
        // attempt at WARN swamps `daemon.log` (5 WARNs per peer per
        // session was routine on testnet edge nodes) without surfacing
        // anything operators need to act on, so this branch is demoted
        // to DEBUG. WARN is reserved for failure modes that DO require
        // intervention: signature mismatch, agent-gate violation,
        // recipient not local, and revoked-key targeting (the
        // last of which throws a generic `Error` with the explicit
        // `was revoked at` message above and therefore stays at WARN).
        const message =
          `SWM sender-key setup receive rejected: senderAgent=${pkg.senderAgentAddress} recipientAgent=${pkg.recipientAgentAddress} ` +
          `fromPeer=${fromPeerId} contextGraph=${pkg.contextGraphId}${pkg.subGraphName ? `/${pkg.subGraphName}` : ''} ` +
          `epoch=${pkg.epochId} membershipHash=${pkg.membershipHash} reason=${reason}`;
        if (err instanceof StaleSenderKeyTargetError) {
          this.log.debug(ctx, message);
        } else {
          this.log.warn(ctx, message);
        }
      }
      return encodeSwmSenderKeyPackageAck({
        version: SWM_SENDER_KEY_PACKAGE_VERSION,
        type: SWM_SENDER_KEY_PACKAGE_ACK_TYPE,
        accepted: false,
        reason,
        reasonCode,
        contextGraphId: pkg?.contextGraphId,
        subGraphName: pkg?.subGraphName,
        senderAgentAddress: pkg?.senderAgentAddress,
        epochId: pkg?.epochId,
        membershipHash: pkg?.membershipHash,
        recipientAgentAddress: pkg?.recipientAgentAddress,
      });
    }
  }

  async acceptSwmSenderKeyPackage(this: DKGAgent,
    pkg: SwmSenderKeyPackageMsg,
    fromPeerId: string,
    ctx: OperationContext,
  ): Promise<void> {
    const senderAgentAddress = ethers.getAddress(pkg.senderAgentAddress);
    const recipientAgentAddress = ethers.getAddress(pkg.recipientAgentAddress);
    const recovered = ethers.verifyMessage(
      computeSwmSenderKeyPackageAAD(pkg),
      ethers.hexlify(pkg.signature),
    );
    if (recovered.toLowerCase() !== senderAgentAddress.toLowerCase()) {
      throw new SwmSenderKeySetupRejectionError(
        'bad-signature',
        `Sender Key setup signature recovered ${recovered}, expected ${senderAgentAddress}`,
      );
    }

    const agentGateAuthority = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.senderKeyAccept,
      () => this.resolveContextGraphAgentGateAuthority(pkg.contextGraphId),
    );
    if (agentGateAuthority.kind === 'unavailable') {
      // Not knowing the gate is not evidence that either endpoint is outside
      // it. Answering `sender-not-allowed` here made an authority failure look
      // like a membership decision (#2827). A transient failure asks the
      // sender to retain and retry the package; one that needs a software or
      // configuration change is terminal, classified exactly as the promote
      // retry is (isRetryableContextGraphAuthorityUnavailableReason).
      throw new SwmSenderKeySetupRejectionError(
        isRetryableContextGraphAuthorityUnavailableReason(agentGateAuthority.reason)
          ? 'agent-gate-pending'
          : 'agent-gate-unavailable',
        `Context graph "${pkg.contextGraphId}" agent gate authority is unavailable (${agentGateAuthority.reason})`,
      );
    }
    const agentGateAddresses = agentGateAuthority.kind === 'available'
      ? agentGateAuthority.agentAddresses
      : null;
    if (!agentGateAddresses) {
      // A cold private member can receive Sender Key setup after the finalized
      // chain binding but before its accepted RFC-64 roster or legacy `_meta`
      // projection is materialized. The chain policy is affirmative authority
      // that this graph is private, but it does not authorize either endpoint;
      // ask the sender to retain and retry the exact package until the local
      // gate arrives. Unknown/public policy remains a terminal fail-closed
      // rejection so an arbitrary ungated graph cannot create retry state.
      const policy = await this.getContextGraphOnChainPolicy(pkg.contextGraphId);
      if (policy.accessPolicy === 1) {
        throw new SwmSenderKeySetupRejectionError(
          'agent-gate-pending',
          `Context graph "${pkg.contextGraphId}" private agent gate is not materialized yet`,
        );
      }
      throw new SwmSenderKeySetupRejectionError(
        'not-agent-gated',
        `Context graph "${pkg.contextGraphId}" is not DKG-agent gated`,
      );
    }
    const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    if (!agentGateSet.has(senderAgentAddress.toLowerCase())) {
      throw new SwmSenderKeySetupRejectionError(
        'sender-not-allowed',
        `Sender agent ${senderAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (!agentGateSet.has(recipientAgentAddress.toLowerCase())) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-allowed',
        `Recipient agent ${recipientAgentAddress} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    let allowedPeers: string[] | null;
    try {
      allowedPeers = await this.resolveSwmAllowedPeersForCurrentAuthority(pkg.contextGraphId);
    } catch (error) {
      if (!isContextGraphAuthorityUnavailableMarker(error)) throw error;
      throw new SwmSenderKeySetupRejectionError(
        isRetryableContextGraphAuthorityUnavailableReason(error.reason)
          ? 'agent-gate-pending'
          : 'agent-gate-unavailable',
        `Context graph "${pkg.contextGraphId}" SWM peer gate authority is unavailable (${error.reason})`,
      );
    }
    if (allowedPeers !== null && !allowedPeers.includes(fromPeerId)) {
      throw new SwmSenderKeySetupRejectionError(
        'sender-not-allowed',
        `Sender peer ${fromPeerId} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (allowedPeers !== null && !allowedPeers.includes(this.peerId)) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-allowed',
        `Recipient peer ${this.peerId} is not allowed for context graph "${pkg.contextGraphId}"`,
      );
    }
    if (!this.hasLocalAgent(recipientAgentAddress)) {
      throw new SwmSenderKeySetupRejectionError(
        'recipient-not-local',
        `Recipient agent ${recipientAgentAddress} is not local to this node`,
      );
    }

    // `activeOnly: true` is the security gate added in Codex review of
    // PR #540 / commit 24aa4855: a sender bootstrapping a NEW sender-key
    // epoch may only target a non-revoked recipient key. Without this,
    // a stale or malicious sender could keep pinning traffic on a key
    // we have already retired, defeating the point of revocation. The
    // historical decryption path (used by `SharedMemoryHandler`) still
    // sees retired keys via the default `activeOnly: false`.
    const localKey = this.getLocalWorkspaceRecipientPrivateKeys({ activeOnly: true }).find((key) => (
      key.recipientId.toLowerCase() === `did:dkg:agent:${recipientAgentAddress}`.toLowerCase() &&
      key.recipientKeyId === pkg.recipientKeyId
    ));
    if (!localKey) {
      // Distinguish "no such local key" from "key exists locally but is
      // revoked" — operators chasing a sudden setup failure after a
      // revoke flow want to see the latter explicitly. Use the same
      // localAgents map the active-only filter does so the diagnostic
      // matches the gate exactly.
      //
      // Codex round 2 on PR #654: a `Map.get(checksum)` here can miss
      // a record that's stored under a differently-cased Map key than
      // its own `record.agentAddress` field (legacy persisted state,
      // older fixtures, or any path that lowercased on persist while
      // keeping the EIP-55 form on the record itself). The miss falls
      // through to `StaleSenderKeyTargetError`, which demotes a real
      // revoked-or-known-key failure to DEBUG and silences operator
      // visibility. Mirror the case-insensitive scan already used by
      // `hasLocalAgent` (just above) and `getLocalWorkspaceRecipient
      // PrivateKeys` so this branch sees the record whenever the
      // existence-gate above did.
      let record: AgentKeyRecord | undefined;
      for (const candidate of this.localAgents.values()) {
        if (candidate.agentAddress.toLowerCase() === recipientAgentAddress.toLowerCase()) {
          record = candidate;
          break;
        }
      }
      const activeEntry = record?.workspaceEncryptionKeys.find(
        (entry) => entry.encryptionKeyId === pkg.recipientKeyId && !entry.revokedAt,
      );
      if (activeEntry) {
        throw new SwmSenderKeySetupRejectionError(
          'active-private-key-missing',
          `No local X25519 private key for DKG agent ${recipientAgentAddress} key ${pkg.recipientKeyId}`,
        );
      }
      const revokedEntry = record?.workspaceEncryptionKeys.find(
        (entry) => entry.encryptionKeyId === pkg.recipientKeyId && entry.revokedAt,
      );
      if (revokedEntry) {
        throw new SwmSenderKeySetupRejectionError(
          'revoked-key',
          `Recipient key ${pkg.recipientKeyId} for DKG agent ${recipientAgentAddress} ` +
          `was revoked at ${revokedEntry.revokedAt}; refusing to bootstrap a new sender-key ` +
          'epoch against a retired key. The sender must resolve the agent profile and retry ' +
          'against an active key.',
        );
      }
      throw new StaleSenderKeyTargetError(recipientAgentAddress, pkg.recipientKeyId);
    }

    const secret = await decryptSwmSenderKeyPackage({ package: pkg, recipientKey: localKey });
    const state: LocalSwmSenderKeyReceiveState = {
      contextGraphId: secret.contextGraphId,
      subGraphName: secret.subGraphName,
      senderAgentAddress: ethers.getAddress(secret.senderAgentAddress),
      epochId: secret.epochId,
      membershipHash: secret.membershipHash,
      chainKey: secret.chainKey,
      nextMessageIndex: uint64ForProto(secret.initialMessageIndex),
      senderSigningPublicKey: secret.senderSigningPublicKey,
      createdAtMs: uint64ForProto(secret.createdAtMs),
      skippedChainKeys: new Map(),
    };
    this.swmSenderKeyReceiveStates.set(
      swmReceiverStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress, state.epochId),
      state,
    );
    await this.saveSwmSenderKeyState();

    this.log.info(
      ctx,
      `SWM sender-key setup receive accepted: senderAgent=${senderAgentAddress} recipientAgent=${recipientAgentAddress} ` +
      `fromPeer=${fromPeerId} contextGraph=${state.contextGraphId}${state.subGraphName ? `/${state.subGraphName}` : ''} ` +
      `epoch=${state.epochId} membershipHash=${state.membershipHash}`,
    );
  }

  async decryptWorkspacePayloadWithSenderKey(this: DKGAgent,
    message: SwmSenderKeyMessageMsg,
    contextGraphId: string,
    ctx: OperationContext,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    const messageIndex = uint64ForProto(message.messageIndex);
    let senderAgentAddress = message.senderAgentAddress;
    if (message.contextGraphId !== contextGraphId) {
      const reason = `Sender Key message contextGraphId "${message.contextGraphId}" does not match envelope "${contextGraphId}"`;
      throw new Error(reason);
    }
    senderAgentAddress = ethers.getAddress(message.senderAgentAddress);
    const state = this.swmSenderKeyReceiveStates.get(
      swmReceiverStateKey(contextGraphId, message.subGraphName, senderAgentAddress, message.epochId),
    );
    if (!state) {
      const reason = `No local Sender Key state for ${senderAgentAddress} epoch ${message.epochId}`;
      this.log.warn(
        ctx,
        `SWM sender-key broadcast receive denied: reason=no-state senderAgent=${senderAgentAddress} ` +
        `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
        `epoch=${message.epochId} messageIndex=${messageIndex} membershipHash=${message.membershipHash}`,
      );
      throw new Error(reason);
    }
    if (state.membershipHash !== message.membershipHash) {
      const reason = `Sender Key membership hash mismatch for ${senderAgentAddress} epoch ${message.epochId}`;
      throw new Error(reason);
    }

    let chainKey = state.skippedChainKeys.get(messageIndex);
    let usedSkippedKey = false;
    if (chainKey) {
      usedSkippedKey = true;
      state.skippedChainKeys.delete(messageIndex);
    } else {
      if (messageIndex < state.nextMessageIndex) {
        const reason = `Sender Key replay rejected for index ${messageIndex}`;
        throw new Error(reason);
      }
      const gap = messageIndex - state.nextMessageIndex;
      if (gap > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
        const reason = `Sender Key message gap ${gap} exceeds skipped-message cache limit`;
        throw new Error(reason);
      }
      chainKey = state.chainKey;
      for (let index = state.nextMessageIndex; index < messageIndex; index++) {
        state.skippedChainKeys.set(index, chainKey);
        chainKey = ratchetSwmSenderChainKey(chainKey);
      }
    }

    let decrypted: Awaited<ReturnType<typeof decryptSwmSenderKeyMessage>>;
    try {
      decrypted = await decryptSwmSenderKeyMessage({
        chainKey,
        message,
        senderSigningPublicKey: state.senderSigningPublicKey,
      });
    } catch (err) {
      throw err;
    }

    if (!usedSkippedKey) {
      state.chainKey = decrypted.nextChainKey;
      state.nextMessageIndex = messageIndex + 1;
    }
    while (state.skippedChainKeys.size > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
      const oldest = [...state.skippedChainKeys.keys()].sort((a, b) => a - b)[0];
      state.skippedChainKeys.delete(oldest);
    }
    await this.saveSwmSenderKeyState();

    const assetUal = await this.resolveKaLifecycleAssetUalFromWorkspacePlaintext(decrypted.plaintext, ctx);
    if (assetUal) {
      logKaLifecycleEvent(this.log, ctx, {
        assetUal,
        stage: 'sender_key',
        event: 'sender_key_payload_decrypted',
        role: 'receiver',
        localPeerId: this.peerId,
        localNodeIdentityId: this.identityId.toString(),
        metadata: {
          contextGraphId,
          subGraphName: message.subGraphName,
          senderAgentAddress,
          epochId: message.epochId,
          messageIndex,
          membershipHash: message.membershipHash,
        },
      });
    }

    this.log.info(
      ctx,
      `SWM sender-key broadcast receive success: senderAgent=${senderAgentAddress} ` +
      `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
      `epoch=${message.epochId} messageIndex=${messageIndex} membershipHash=${message.membershipHash}`,
    );
    this.logSwmSenderKeyDebugPlainPayload(ctx, 'plain-after-decrypt', decrypted.plaintext, {
      senderAgentAddress,
      contextGraphId,
      subGraphName: message.subGraphName,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex,
    });
    return decrypted.plaintext;
  }

  async resolveKaLifecycleAssetUalFromWorkspacePlaintext(this: DKGAgent, plaintext: Uint8Array, ctx?: OperationContext): Promise<string | undefined> {
    try {
      const request = decodeWorkspacePublishRequest(plaintext);
      return this.resolveKaLifecycleAssetUalFromIdentity(request.agentAddress, request.kaNumber, ctx);
    } catch {
      return undefined;
    }
  }

  async resolveKaLifecycleAssetUalFromIdentity(this: DKGAgent, agentAddress?: string, kaNumber?: string, ctx?: OperationContext): Promise<string | undefined> {
    if (!agentAddress || !kaNumber) return undefined;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([
        resolveAssetUalFromKaIdentity(this.chain, { agentAddress, kaNumber })
          .finally(() => { if (timer) clearTimeout(timer); }),
        timeout,
      ]);
      if (result === TIMEOUT_SENTINEL) {
        this.log.warn(
          ctx ?? createOperationContext('share'),
          `KA lifecycle assetUal derivation exceeded ${KA_LIFECYCLE_ASSET_UAL_RESOLVE_TIMEOUT_MS}ms; continuing without lifecycle assetUal`,
        );
        return undefined;
      }
      return result;
    } catch {
      return undefined;
    }
  }

  isSwmSenderKeyPayloadDebugLoggingEnabled(this: DKGAgent): boolean {
    const raw = process.env.DKG_SWM_SENDER_KEY_DEBUG_PAYLOADS;
    return raw === '1' || raw?.toLowerCase() === 'true';
  }

  logSwmSenderKeyDebugPlainPayload(this: DKGAgent,
    ctx: OperationContext,
    phase: 'plain-before-encrypt' | 'plain-after-decrypt',
    payload: Uint8Array,
    extra: Record<string, unknown>,
  ): void {
    if (!this.isSwmSenderKeyPayloadDebugLoggingEnabled()) return;
    try {
      const request = decodeWorkspacePublishRequest(payload);
      const nquads = new TextDecoder().decode(request.nquads);
      this.log.warn(ctx, `SWM sender-key DEBUG ${phase}: ${JSON.stringify({
        warning: 'private SWM plaintext debug logging is enabled',
        ...extra,
        shareOperationId: request.shareOperationId,
        operationId: request.operationId,
        requestContextGraphId: request.contextGraphId,
        requestSubGraphName: request.subGraphName,
        nquads,
      })}`);
    } catch (err) {
      this.log.warn(
        ctx,
        `SWM sender-key DEBUG ${phase}: failed to decode plaintext WorkspacePublishRequest: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logSwmSenderKeyDebugEncryptedPayload(this: DKGAgent,
    ctx: OperationContext,
    message: SwmSenderKeyMessageMsg,
  ): void {
    if (!this.isSwmSenderKeyPayloadDebugLoggingEnabled()) return;
    this.log.warn(ctx, `SWM sender-key DEBUG encrypted-before-broadcast: ${JSON.stringify({
      warning: 'private SWM encrypted payload debug logging is enabled',
      senderAgentAddress: message.senderAgentAddress,
      contextGraphId: message.contextGraphId,
      subGraphName: message.subGraphName,
      epochId: message.epochId,
      membershipHash: message.membershipHash,
      messageIndex: uint64ForProto(message.messageIndex),
      cipherAlgorithm: message.cipherAlgorithm,
      nonceBytes: message.nonce.length,
      ciphertextBytes: message.ciphertext.length,
      ciphertextBase64: Buffer.from(message.ciphertext).toString('base64'),
    })}`);
  }

  hasLocalAgent(this: DKGAgent, agentAddress: string): boolean {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  getLocalSigningAgentForAddress(this: DKGAgent, agentAddress: string): (AgentKeyRecord & { privateKey: string }) | null {
    const checksum = ethers.getAddress(agentAddress);
    for (const record of this.localAgents.values()) {
      if (record.agentAddress.toLowerCase() === checksum.toLowerCase() && record.privateKey) {
        return { ...record, privateKey: record.privateKey };
      }
    }
    return null;
  }

  swmSenderKeyStatePath(this: DKGAgent): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/swm-sender-keys.json`;
  }

  async loadSwmSenderKeyState(this: DKGAgent): Promise<void> {
    if (this.swmSenderKeyStateLoaded) return;
    this.swmSenderKeyStateLoaded = true;
    const path = this.swmSenderKeyStatePath();
    if (!path) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as {
        send?: Array<Record<string, unknown>>;
        receive?: Array<Record<string, unknown>>;
        pending?: Array<Record<string, unknown>>;
      };
      for (const entry of parsed.send ?? []) {
        const state = deserializeSwmSenderSendState(entry);
        this.swmSenderKeySendStates.set(
          swmSenderStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress),
          state,
        );
      }
      for (const entry of parsed.receive ?? []) {
        const state = deserializeSwmSenderReceiveState(entry);
        this.swmSenderKeyReceiveStates.set(
          swmReceiverStateKey(state.contextGraphId, state.subGraphName, state.senderAgentAddress, state.epochId),
          state,
        );
      }
      const pendingByAgent = new Map<string, PendingSenderKeyEntry[]>();
      let skippedPendingRows = 0;
      for (const entry of parsed.pending ?? []) {
        let pending: PendingSenderKeyEntry;
        try {
          pending = deserializePendingSenderKeyEntry(entry);
        } catch (err) {
          skippedPendingRows += 1;
          const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
          const sender = typeof raw.senderAgentAddress === 'string' ? raw.senderAgentAddress : 'unknown-sender';
          const recipient = typeof raw.recipientAgentAddress === 'string' ? raw.recipientAgentAddress : 'unknown-recipient';
          const contextGraph = typeof raw.contextGraphId === 'string' ? raw.contextGraphId : 'unknown-context-graph';
          const subGraph = typeof raw.subGraphName === 'string' ? `/${raw.subGraphName}` : '';
          this.log.warn(
            createOperationContext('share'),
            `Skipped malformed SWM sender-key pending row #${skippedPendingRows} ` +
            `(sender=${sender}, recipient=${recipient}, contextGraph=${contextGraph}${subGraph}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const recipientKey = pending.recipientAgentAddress.toLowerCase();
        const queue = pendingByAgent.get(recipientKey) ?? [];
        queue.push(pending);
        pendingByAgent.set(recipientKey, queue);
      }
      this.pendingSenderKeyByAgent.clear();
      for (const [recipientKey, queue] of pendingByAgent.entries()) {
        this.pendingSenderKeyByAgent.set(recipientKey, queue);
      }
    } catch {
      // No durable state yet, or a corrupt file that should not unblock startup.
      this.swmSenderKeySendStates.clear();
      this.swmSenderKeyReceiveStates.clear();
      this.pendingSenderKeyByAgent.clear();
    }
  }

  async saveSwmSenderKeyState(this: DKGAgent): Promise<void> {
    const path = this.swmSenderKeyStatePath();
    if (!path) return;
    const save = this.swmSenderKeyStateSaveQueue.then(async () => {
      const { mkdir, writeFile, chmod } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });
      // Capture inside the serialized section. A caller queued behind an
      // in-flight write must persist the state current when its turn begins,
      // not a stale snapshot captured while the older write was outstanding.
      const payload = {
        version: 1,
        send: [...this.swmSenderKeySendStates.values()].map(serializeSwmSenderSendState),
        receive: [...this.swmSenderKeyReceiveStates.values()].map(serializeSwmSenderReceiveState),
        pending: [...this.pendingSenderKeyByAgent.values()]
          .flatMap((queue) => queue.map(serializePendingSenderKeyEntry)),
      };
      await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
      try {
        await chmod(path, 0o600);
      } catch {
        // Best-effort on platforms/filesystems that do not support chmod.
      }
    });
    // A failed save is still reported to its caller, but must not poison the
    // queue and suppress every later persistence attempt.
    this.swmSenderKeyStateSaveQueue = save.catch(() => undefined);
    await save;
  }

  async resolveWorkspaceGossipSigningAgent(this: DKGAgent,
    contextGraphId: string,
  ): Promise<(AgentKeyRecord & { privateKey: string }) | null> {
    const authority = await withRpcUsageSite(
      CG_AUTH_RPC_SITES.signer,
      () => this.resolveContextGraphAgentGateAuthority(contextGraphId),
    );
    if (authority.kind === 'ungated') {
      return this.getWorkspaceGossipSigningAgent();
    }
    if (authority.kind === 'unavailable') {
      const message =
        `Cannot gossip SWM write for context graph "${contextGraphId}": signing authority is unavailable (${authority.reason})`;
      throw createContextGraphAuthorityError(message, authority);
    }

    const allowedAgents = authority.agentAddresses;

    // An available-but-empty gate is authoritative (for example an empty
    // chain roster or a fully revoked legacy gate), so retrying cannot help.
    if (allowedAgents.length === 0) {
      throw new Error(
        `Cannot gossip SWM write for context graph "${contextGraphId}": authoritative signing roster is empty`,
      );
    }

    const allowedSet = new Set(allowedAgents.map((agent) => agent.toLowerCase()));
    for (const record of this.localAgents.values()) {
      if (record.privateKey && allowedSet.has(record.agentAddress.toLowerCase())) {
        return { ...record, privateKey: record.privateKey };
      }
    }

    throw new Error(`Cannot gossip SWM write for agent-gated context graph "${contextGraphId}": no local allowed signing agent key`);
  }

  async encodeWorkspaceGossipMessage(this: DKGAgent,
    contextGraphId: string,
    message: Uint8Array,
    resolvedSigner?: (AgentKeyRecord & { privateKey: string }) | null,
  ): Promise<Uint8Array> {
    const signer = resolvedSigner === undefined
      ? await this.resolveWorkspaceGossipSigningAgent(contextGraphId)
      : resolvedSigner;
    if (!signer) {
      return message;
    }

    const timestamp = new Date().toISOString();
    const payload = new Uint8Array(message);
    const signingPayload = computeGossipSigningPayload(
      GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId,
      timestamp,
      payload,
    );
    const signature = await new ethers.Wallet(signer.privateKey).signMessage(signingPayload);
    return encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId,
      agentAddress: signer.agentAddress,
      timestamp,
      signature: ethers.getBytes(signature),
      payload,
    });
  }

}
