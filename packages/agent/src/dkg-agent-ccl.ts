// SPDX-License-Identifier: Apache-2.0

/**
 * CCL (composable consent layer) policy subsystem extracted from dkg-agent.ts
 * as a mixin holder: policy publish/approve/revoke, policy + binding listing,
 * policy/fact resolution and policy evaluation (incl. evaluate-and-publish).
 * 1:1 move; methods take `this: DKGAgent` so cross-calls resolve against the
 * composed class.
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

export class CclPolicyMethods extends DKGAgentBase {
  async publishCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.contextGraphId))) {
      throw new Error(`Context Graph "${opts.contextGraphId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ contextGraphId: opts.contextGraphId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.contextGraphId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for contextGraph "${opts.contextGraphId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) throw new Error(`CCL policy not found: ${opts.policyUri}`);
    if (record.contextGraphId !== opts.contextGraphId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to contextGraph "${record.contextGraphId}", not "${opts.contextGraphId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    // Emit the public `dkg:creator` peer DID as the binding owner: it's the
    // handle remote peers resolve via ONTOLOGY gossip, so gossip-publish-handler
    // will accept the approval. `_meta`-only `dkg:curator` (wallet DID) is
    // used for local authorization via `assertContextGraphOwner` above.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      policyName: record.name,
      creator: ownerDid,
      graph: ontologyGraph,
      approvedAt,
      contextType: effectiveContextType,
    });

    quads.push(
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('approved'), graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: ownerDid, graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(approvedAt), graph: ontologyGraph },
    );

    await this.store.insert(quads);
    await this.publishOntologyQuads(bindingUri, quads);
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for contextGraph "${opts.contextGraphId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertContextGraphPolicyOwner(opts.contextGraphId, opts.callerAgentAddress);

    const target = await this.getActiveCclPolicyBinding({
      contextGraphId: opts.contextGraphId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new Error(`No active CCL policy binding found for ${opts.policyUri} in contextGraph "${opts.contextGraphId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`);
    }

    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    // See note in approveCclPolicy — use `dkg:creator` (peer DID) for the
    // public binding metadata so it round-trips through ONTOLOGY gossip.
    const ownerDid = await this.getContextGraphCreator(opts.contextGraphId)
      ?? `did:dkg:agent:${this.peerId}`;
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: ownerDid,
      graph: ontologyGraph,
      revokedAt,
      contextGraphUri: `did:dkg:context-graph:${opts.contextGraphId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for contextGraph "${opts.contextGraphId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(this: DKGAgent, opts: {
    contextGraphId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?contextGraph ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                  <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                  <${DKG_ONTOLOGY.DKG_POLICY_VERSION}> ?version ;
                  <${DKG_ONTOLOGY.DKG_POLICY_HASH}> ?hash ;
                  <${DKG_ONTOLOGY.DKG_POLICY_LANGUAGE}> ?language ;
                  <${DKG_ONTOLOGY.DKG_POLICY_FORMAT}> ?format ;
                  <${DKG_ONTOLOGY.DKG_POLICY_STATUS}> ?status .
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${bodyClause}
          ${filterBlock}
        }
      }
      ORDER BY ?name ?version
    `);

    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const contextGraphUri = row['contextGraph'];
        const contextGraphId = contextGraphUri.startsWith('did:dkg:context-graph:') ? contextGraphUri.slice('did:dkg:context-graph:'.length) : contextGraphUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${contextGraphId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.contextGraphId === contextGraphId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          contextGraphId,
          name,
          version: stripLiteral(row['version']),
          hash: stripLiteral(row['hash']),
          language: stripLiteral(row['language']),
          format: stripLiteral(row['format']),
          status: this.deriveCclPolicyStatus(row['policy'], stripLiteral(row['status']), bindings, latestByScope),
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          approvedBy: row['approvedBy'],
          approvedAt: row['approvedAt'] ? stripLiteral(row['approvedAt']) : undefined,
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          body: row['body'] ? stripLiteral(row['body']) : undefined,
          isActiveDefault: defaultActive?.policyUri === row['policy'],
          activeContexts,
        };

        const current = records.get(row['policy']);
        if (!current || (current.status !== 'approved' && nextRecord.status === 'approved')) {
          records.set(row['policy'], nextRecord);
        }
      }
    }

    return Array.from(records.values())
      .filter(record => !opts.status || record.status === opts.status)
      .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }

  async resolveCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(this: DKGAgent, opts: {
    contextGraphId: string;
    snapshotId?: string;
    view?: string;
    scopeUal?: string;
    policyName?: string;
    contextType?: string;
  }): Promise<{
    facts: CclFactTuple[];
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'snapshot-resolved';
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      contextGraphId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: CclFactResolutionMode;
    result: CclEvaluationResult;
  }> {
    const policy = await this.resolveCclPolicy({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy?.body) {
      throw new Error(`No approved policy found for ${opts.contextGraphId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          contextGraphId: opts.contextGraphId,
          snapshotId: opts.snapshotId,
          view: opts.view,
          scopeUal: opts.scopeUal,
          policyName: policy.name,
          contextType: opts.contextType ?? policy.contextType,
        });
    const evaluator = new CclEvaluator(parsed, factInput.facts);
    const result = evaluator.run();

    return {
      policy: {
        policyUri: policy.policyUri,
        contextGraphId: policy.contextGraphId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        contextGraphId: opts.contextGraphId,
        contextType: opts.contextType,
        view: opts.view,
        snapshotId: opts.snapshotId,
        scopeUal: opts.scopeUal,
      },
      factSetHash: factInput.factSetHash,
      factQueryHash: factInput.factQueryHash,
      factResolverVersion: factInput.factResolverVersion,
      factResolutionMode: factInput.factResolutionMode,
      result,
    };
  }

  async evaluateAndPublishCclPolicy(this: DKGAgent, opts: {
    contextGraphId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    evaluationUri: string;
    publish: PublishResult;
    evaluation: {
      policy: Pick<CclPolicyRecord, 'policyUri' | 'contextGraphId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        contextGraphId: string;
        contextType?: string;
        view?: string;
        snapshotId?: string;
        scopeUal?: string;
      };
      factSetHash: string;
      factQueryHash: string;
      factResolverVersion: string;
      factResolutionMode: CclFactResolutionMode;
      result: CclEvaluationResult;
    };
  }> {
    const evaluation = await this.evaluateCclPolicy(opts);
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      contextGraphId: opts.contextGraphId,
      policyUri: evaluation.policy.policyUri,
      factSetHash: evaluation.factSetHash,
      factQueryHash: evaluation.factQueryHash,
      factResolverVersion: evaluation.factResolverVersion,
      factResolutionMode: evaluation.factResolutionMode,
      result: evaluation.result,
      evaluatedAt: new Date().toISOString(),
      view: evaluation.context.view,
      snapshotId: evaluation.context.snapshotId,
      scopeUal: evaluation.context.scopeUal,
      contextType: evaluation.context.contextType,
    }, graph);
    const publish = await this.publish(opts.contextGraphId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = contextGraphDataGraphUri(opts.contextGraphId);
    const filters: string[] = [];
    if (opts.policyUri) filters.push(`?policy = <${opts.policyUri}>`);
    if (opts.snapshotId) filters.push(`?snapshotId = ${sparqlString(opts.snapshotId)}`);
    if (opts.view) filters.push(`?view = ${sparqlString(opts.view)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    if (opts.resultKind) filters.push(`?kind = ${sparqlString(opts.resultKind)}`);
    if (opts.resultName) filters.push(`?resultName = ${sparqlString(opts.resultName)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';

    const result = await this.store.query(`
      SELECT ?evaluation ?policy ?factSetHash ?factQueryHash ?factResolverVersion ?factResolutionMode ?createdAt ?view ?snapshotId ?scopeUal ?contextType ?entry ?kind ?resultName ?arg ?argIndex ?argValue WHERE {
        GRAPH <${graph}> {
          ?evaluation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_EVALUATION}> ;
                      <${DKG_ONTOLOGY.DKG_EVALUATED_POLICY}> ?policy ;
                      <${DKG_ONTOLOGY.DKG_FACT_SET_HASH}> ?factSetHash .
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_QUERY_HASH}> ?factQueryHash }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION}> ?factResolverVersion }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE}> ?factResolutionMode }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?createdAt }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          OPTIONAL {
            ?evaluation <${DKG_ONTOLOGY.DKG_HAS_RESULT}> ?entry .
            ?entry <${DKG_ONTOLOGY.DKG_RESULT_KIND}> ?kind ;
                   <${DKG_ONTOLOGY.DKG_RESULT_NAME}> ?resultName .
            OPTIONAL {
              ?entry <${DKG_ONTOLOGY.DKG_HAS_RESULT_ARG}> ?arg .
              ?arg <${DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX}> ?argIndex ;
                   <${DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE}> ?argValue .
            }
          }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?createdAt) ?evaluation ?kind ?resultName ?argIndex
    `);

    if (result.type !== 'bindings') return [];
    const records = new Map<string, CclPublishedEvaluationRecord>();
    const entryArgs = new Map<string, Map<number, unknown>>();
    for (const row of result.bindings as Record<string, string>[]) {
      const evaluationUri = row['evaluation'];
      let record = records.get(evaluationUri);
      if (!record) {
        record = {
          evaluationUri,
          policyUri: row['policy'],
          factSetHash: stripLiteral(row['factSetHash']),
          factQueryHash: row['factQueryHash'] ? stripLiteral(row['factQueryHash']) : undefined,
          factResolverVersion: row['factResolverVersion'] ? stripLiteral(row['factResolverVersion']) : undefined,
          factResolutionMode: row['factResolutionMode'] ? stripLiteral(row['factResolutionMode']) as CclFactResolutionMode : undefined,
          createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
          view: row['view'] ? stripLiteral(row['view']) : undefined,
          snapshotId: row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined,
          scopeUal: row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          results: [],
        };
        records.set(evaluationUri, record);
      }

      if (row['entry']) {
        const entryUri = row['entry'];
        let existing = record.results.find(resultEntry => resultEntry.entryUri === entryUri);
        if (!existing) {
          existing = {
            entryUri,
            kind: stripLiteral(row['kind']) as 'derived' | 'decision',
            name: stripLiteral(row['resultName']),
            tuple: [],
          };
          record.results.push(existing);
        }

        if (row['arg'] && row['argIndex'] && row['argValue']) {
          let args = entryArgs.get(entryUri);
          if (!args) {
            args = new Map<number, unknown>();
            entryArgs.set(entryUri, args);
          }
          args.set(Number(stripLiteral(row['argIndex'])), JSON.parse(stripLiteral(row['argValue'])));
        }
      }
    }

    for (const record of records.values()) {
      for (const resultEntry of record.results) {
        const args = entryArgs.get(resultEntry.entryUri);
        if (args && args.size > 0) {
          resultEntry.tuple = [...args.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
        }
      }
    }

    return Array.from(records.values());
  }

}
