// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-registry / node-API subsystem extracted from dkg-agent.ts as a mixin
 * holder: profile publishing, agent registration + keystore persistence,
 * workspace-key rotation/revocation, publishing-conviction NFT operations,
 * and peer messaging/chat/skill-invocation/connection helpers. 1:1 move;
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
} from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad, type LargeLiteralStorageConfig } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, buildKnowledgeAssetUal, PcaUnavailableError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult, type TxResult, type V10PublishingConvictionAccountInfo, type NodePublishingConvictionAccount, type PcaAccountRelation, type ShardingTableNode, type PcaContracts, type PcaRpcMethod } from '@origintrail-official/dkg-chain';
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
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler, type ChatAclCheck, type SkillAclCheck } from './messaging.js';
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

/**
 * #1346 — advisory result of confirming a just-mined PCA agent registration.
 * The mined receipt is already authoritative for `registered:true`; these two
 * DECOUPLED signals only refine the ADVISORY picture (QA #1346 acceptance
 * contract). Modeled as a DISCRIMINATED UNION so the invariant "no probe
 * surface ⟹ no outcome" is enforced by the compiler, not prose — the
 * `{adapterSupported:false, verified:false|true}` combos are unrepresentable:
 *   - `{ adapterSupported: false; verified: null }` — no on-chain probe surface
 *     (the typed facade's `null`): a genuine capability gap, so no outcome.
 *   - `{ adapterSupported: true; verified: boolean | null }` — the surface
 *     exists; `verified` is the OUTCOME: `true` (confirmed on-chain) | `false`
 *     (a read observed it as not-yet-registered — follower-RPC lag) | `null`
 *     (every read threw — inconclusive).
 */
export type PcaAgentConfirmation =
  | { adapterSupported: false; verified: null }
  | { adapterSupported: true; verified: boolean | null };

// #1346 — production confirmation policy: a bounded post-mine probe. These are
// fixed domain constants, NOT caller-tunable knobs (implementation detail of
// the advisory read, never a public facade option).
const PCA_CONFIRM_ATTEMPTS = 3;
const PCA_CONFIRM_BACKOFF_MS = 300;

/**
 * Advisory-confirmation state machine, kept as a MODULE-PRIVATE helper (NOT
 * exported — the only public surface is the facade method
 * `confirmPublishingConvictionAgentRegistration`) so the bounded-probe retry
 * policy is a fixed internal constant, never a deep-importable tuning knob.
 * `probe` yields the typed registration read: `true` (registered) | `false`
 * (not yet — follower-RPC lag → retry) | `null` (no probe surface →
 * unsupported, short-circuit). `null` is a per-adapter-STABLE capability signal
 * (the facade returns it iff the chain method is absent), so it legitimately
 * halts regardless of earlier reads — a `false`-then-`null` sequence is
 * unreachable from a real adapter.
 *
 * A definitive `false` read is NEVER erased by a later throw: once the surface
 * has reported not-yet-registered, an RPC blip on a subsequent attempt leaves
 * the advisory outcome `false` (not `null`) — only a later `true` upgrades it.
 * The full retry matrix is exercised through the facade in pca-v10-facade.test.ts.
 */
async function confirmPcaAgentRegistration(
  probe: () => Promise<boolean | null>,
): Promise<PcaAgentConfirmation> {
  let surfaceExists = false;
  let verified: boolean | null = null; // advisory outcome once the surface is known
  for (let i = 0; i < PCA_CONFIRM_ATTEMPTS; i++) {
    try {
      const result = await probe();
      if (result === null) return { adapterSupported: false, verified: null };
      surfaceExists = true; // a boolean return proves the read surface exists
      if (result === true) return { adapterSupported: true, verified: true };
      verified = false; // observed not-yet-registered (lag) — a definitive read
    } catch {
      // The read surface exists; a throw is an RPC read failure, not a gap.
      // Deliberately does NOT touch `verified`: a prior definitive `false`
      // survives a later blip (only a `true` upgrades it).
      surfaceExists = true;
    }
    if (i < PCA_CONFIRM_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, PCA_CONFIRM_BACKOFF_MS));
  }
  // Unreachable while PCA_CONFIRM_ATTEMPTS >= 1 (every attempt sets surfaceExists);
  // the branch keeps the return a provable union member without a cast.
  return surfaceExists
    ? { adapterSupported: true, verified }
    : { adapterSupported: false, verified: null };
}

export class AgentRegistryMethods extends DKGAgentBase {
  async publishProfile(this: DKGAgent): Promise<PublishResult> {
    // Tail-chain serialization: every caller waits for the prior
    // `publishProfile()` to settle (success or failure) before
    // running its own publish. Prevents the startup / heartbeat /
    // key-rotation / revocation paths from racing each other on
    // `ProfileManager.currentKcId` and the registry triples.
    // Codex review of PR #700 round 2.
    const run = this.publishProfileTail
      .catch(() => {
        // swallow prior errors so a transient publish failure does
        // not poison every subsequent publish for the lifetime of
        // the agent
      })
      .then(() => this.publishProfileImpl());
    this.publishProfileTail = run;
    return run;
  }

  async publishProfileImpl(this: DKGAgent): Promise<PublishResult> {
    const pubKeyBase64 = Buffer.from(this.wallet.keypair.publicKey).toString('base64');
    const relayAddrs = this.config.relayPeers;
    const defaultAgent = this.defaultAgentAddress ? this.localAgents.get(this.defaultAgentAddress) : undefined;

    // Populate `contextGraphsServed` so peers can discover which CGs this
    // node hosts via the public agent profile, but ONLY include CGs whose
    // accessPolicy is open AND we are actively serving (subscribed=true).
    //
    // `isPrivateContextGraph` is the same predicate the responder consults
    // to gate sync requests, so the discovery layer and the data-plane
    // access control stay consistent.
    //
    // The `subscribed === true` filter is what Codex review on PR #431
    // (round 3) flagged. `discoverContextGraphsFromStore()` seeds entries
    // for OPEN CGs we merely learned about with `subscribed: false` (we
    // don't auto-subscribe public CGs — explicit user opt-in only). Without
    // this filter, those discovery-only entries would be advertised in
    // `contextGraphsServed`, so other peers would route join attempts to a
    // node that doesn't actually host the CG. The curated/private discovery
    // path immediately calls `subscribeToContextGraph()` (which flips
    // `subscribed: true`) before adding to the gossip mesh, so this filter
    // does not regress invited-curated discovery.
    //
    // System CGs (`agents`, `ontology`) are excluded — they are universal
    // and don't need to be re-advertised in every profile.
    const publicServed: string[] = [];
    for (const [id, sub] of this.subscribedContextGraphs) {
      if (id === SYSTEM_CONTEXT_GRAPHS.AGENTS || id === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) continue;
      if (!sub.subscribed) continue;
      if (await this.isPrivateContextGraph(id)) continue;
      publicServed.push(id);
    }

    const profileConfig: AgentProfileConfig = {
      peerId: this.node.peerId,
      name: this.config.name,
      description: this.config.description,
      framework: this.config.framework,
      nodeRole: this.config.nodeRole ?? 'edge',
      publicKey: pubKeyBase64,
      relayAddress: relayAddrs?.[0],
      agentAddress: this.defaultAgentAddress,
      multiaddrs: collectPublishableMultiaddrs(this.node.multiaddrs),
      lastSeen: new Date().toISOString(),
      encryptionKeys: defaultAgent?.workspaceEncryptionKeys.map((k) => ({
        encryptionKeyAlgorithm: k.encryptionKeyAlgorithm,
        publicEncryptionKey: k.publicEncryptionKey,
        encryptionKeyProof: k.encryptionKeyProof,
        encryptionKeyId: k.encryptionKeyId,
        revokedAt: k.revokedAt,
        revocationProof: k.revocationProof,
      })),
      skills: (this.config.skills ?? []).map(s => ({
        skillType: s.skillType,
        pricePerCall: s.pricePerCall,
        currency: s.currency ?? 'TRAC',
        pricingModel: s.pricePerCall ? 'PerInvocation' as const : 'Free' as const,
      })),
      ...(publicServed.length > 0 ? { contextGraphsServed: publicServed } : {}),
    };

    const profileCtx = createOperationContext('publish');
    this.log.info(profileCtx, `Publishing agent profile`);
    const result = await this.profileManager.publishProfile(profileConfig);
    await this.broadcastPublish(AGENT_REGISTRY_CONTEXT_GRAPH, result, profileCtx);

    return result;
  }

  /**
   * Sync this node's intended `relayCapable` flag onto chain (RFC 04 v0.3
   * / Issue #461 — Network State Registry).
   *
   * Called once at startup. Best-effort: missing chain config, no on-chain
   * profile, or adapters that pre-date the relay-registry surface
   * (`setRelayCapable` undefined) = silent skip. Chain RPC errors are
   * logged but never thrown so the daemon stays up.
   *
   * Idempotent: compares against the current on-chain value and skips the
   * tx when they match. Safe to call on every restart.
   *
   * Multiaddrs are NOT published here — they will be published per-RS-round
   * inside the attestation KC body when `submitProofV2` lands (RFC 04
   * Phase 2). This entry point only manages the on-chain hint flag.
   *
   * Three-way semantics for `opts.relayCapable` (Codex PR #506 fix):
   *   - `true`      → ensure on-chain flag is true (flip if currently false)
   *   - `false`     → ensure on-chain flag is false (flip if currently true)
   *   - `undefined` → leave on-chain alone (operator hasn't expressed an
   *                   opinion in config; respects manual `dkg admin
   *                   set-relay-capable` flips)
   *
   * The previous version treated false-or-absent as a no-op, making the
   * on-chain flag sticky: a node that once ran with `relayCapable: true`
   * would keep advertising relay capability forever even after the
   * operator removed it from config. Now `false` actively clears.
   */
  async publishRelayRegistry(this: DKGAgent, opts?: { relayCapable?: boolean }): Promise<void> {
    const ctx = createOperationContext('publish');
    if (!('setRelayCapable' in this.chain) || typeof this.chain.setRelayCapable !== 'function') {
      this.log.info(ctx, 'publishRelayRegistry: chain adapter does not support relay registry — skipping');
      return;
    }

    let identityId: bigint;
    try {
      identityId = await this.chain.getIdentityId();
    } catch (err) {
      this.log.warn(
        ctx,
        `publishRelayRegistry: getIdentityId failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (identityId === 0n) {
      this.log.info(ctx, 'publishRelayRegistry: node has no on-chain profile yet — skipping');
      return;
    }

    // Only act on explicit booleans. Anything else (undefined, non-boolean
    // misconfigurations) is treated as "no opinion" so we don't clobber
    // operator-managed state.
    if (opts?.relayCapable !== true && opts?.relayCapable !== false) {
      return;
    }
    const desired = opts.relayCapable;
    try {
      const current = this.chain.getRelayCapable
        ? await this.chain.getRelayCapable(identityId)
        : false;
      if (current !== desired) {
        await this.chain.setRelayCapable(desired);
        this.log.info(ctx, `publishRelayRegistry: flipped relayCapable=${desired} on chain (was ${current})`);
      }
    } catch (err) {
      this.log.warn(
        ctx,
        `publishRelayRegistry: setRelayCapable failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async findAgents(this: DKGAgent, options?: { framework?: string }): Promise<DiscoveredAgent[]> {
    return this.discovery.findAgents(options);
  }

  async findSkills(this: DKGAgent, options?: SkillSearchOptions): Promise<DiscoveredOffering[]> {
    return this.discovery.findSkillOfferings(options);
  }

  async findAgentByPeerId(this: DKGAgent, peerId: string): Promise<DiscoveredAgent | null> {
    return this.discovery.findAgentByPeerId(peerId);
  }

  // ---------------------------------------------------------------------------
  // Agent Registry — multi-agent identity management
  // ---------------------------------------------------------------------------

  /**
   * Register a new agent on this node.
   * - Custodial (publicKey omitted): node generates secp256k1 keypair
   * - Self-sovereign (publicKey provided): agent holds its own key
   */
  async registerAgent(this: DKGAgent,
    name: string,
    opts?: {
      publicKey?: string;
      framework?: string;
      encryptionKeyAlgorithm?: typeof WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519;
      publicEncryptionKey?: string;
      encryptionKeyProof?: string;
    },
  ): Promise<AgentKeyRecord> {
    for (const existing of this.localAgents.values()) {
      if (existing.name === name) {
        throw new Error(`Agent name "${name}" already registered on this node`);
      }
    }
    if (opts?.publicKey && (opts.publicEncryptionKey || opts.encryptionKeyProof) && !(opts.publicEncryptionKey && opts.encryptionKeyProof)) {
      throw new Error('Self-sovereign agents must provide both publicEncryptionKey and encryptionKeyProof');
    }

    const record = opts?.publicKey
      ? registerSelfSovereignAgent(
        name,
        opts.publicKey,
        opts.framework,
        opts.publicEncryptionKey && opts.encryptionKeyProof
          ? {
            encryptionKeyAlgorithm: opts.encryptionKeyAlgorithm ?? WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicEncryptionKey: opts.publicEncryptionKey,
            encryptionKeyProof: opts.encryptionKeyProof,
          }
          : undefined,
      )
      : generateCustodialAgent(name, opts?.framework);

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    await this.persistAgentToStore(record);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Registered agent "${name}" (${record.mode}) → ${record.agentAddress}`);
    return record;
  }

  /**
   * List all agents registered on this node.
   * Private keys are NOT included in the response.
   */
  listLocalAgents(this: DKGAgent): Array<Omit<AgentKeyRecord, 'privateKey'>> {
    return [...this.localAgents.values()].map(({ privateKey: _, ...rest }) => rest);
  }

  /**
   * Mint a fresh workspace encryption keypair for a local custodial agent,
   * sign it with the agent's wallet, append it to the keystore, and publish
   * an updated agent profile so peers learn the new key.
   *
   * - The new key starts in the **active** set immediately — encryption-only
   *   senders (the resolver) will start including it the next time they
   *   query, so peers can begin encrypting SWM gossip to it as soon as the
   *   updated profile gossips reach them.
   * - The previous default key stays active by default; SWM gossip already
   *   encrypted to it remains decryptable, and senders that haven't seen the
   *   new profile yet keep working. Pass `retireOld: true` to also emit a
   *   wallet-signed revocation for the prior default in the same operation
   *   (use only after you're confident the new key has propagated, or for
   *   urgent rotations that prioritise blast-radius reduction over
   *   compatibility).
   * - Self-sovereign agents must rotate via their own tooling (the daemon
   *   never has their wallet); this method throws for them.
   */
  async rotateWorkspaceEncryptionKey(this: DKGAgent,
    agentAddress: string,
    opts: { retireOld?: boolean } = {},
  ): Promise<{
    newKeyId: string;
    retiredKeyId?: string;
    profilePublished: boolean;
    profilePublishError?: string;
  }> {
    const record = this.localAgents.get(this.resolveLocalAgentAddress(agentAddress));
    if (!record) {
      throw new Error(`Unknown local agent ${agentAddress}`);
    }
    if (record.mode !== 'custodial' || !record.privateKey) {
      throw new Error(
        `Cannot rotate encryption key for non-custodial agent ${record.agentAddress}: ` +
        'self-sovereign agents must sign rotations off-node and submit them via the revoke endpoint',
      );
    }

    const priorActive = activeWorkspaceEncryptionKeys(record);
    const priorDefaultId = priorActive[0]?.encryptionKeyId;
    const newEntry = appendCustodialWorkspaceEncryptionKey(record);
    let retiredKeyId: string | undefined;
    if (opts.retireOld && priorDefaultId && priorDefaultId !== newEntry.encryptionKeyId) {
      revokeCustodialWorkspaceEncryptionKey(record, priorDefaultId);
      retiredKeyId = priorDefaultId;
    }

    await this.persistAgentToStore(record);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(
      ctx,
      `Rotated workspace encryption key for agent ${record.agentAddress}: ` +
      `new=${newEntry.encryptionKeyId}${retiredKeyId ? ` retired=${retiredKeyId}` : ''}`,
    );

    const publishOutcome = await this.publishProfileAfterKeyChange(record, {
      action: retiredKeyId ? 'rotation (with --retire-old)' : 'rotation',
      criticalForOtherPeers: !!retiredKeyId,
    });

    return {
      newKeyId: newEntry.encryptionKeyId,
      retiredKeyId,
      profilePublished: publishOutcome.published,
      profilePublishError: publishOutcome.error,
    };
  }

  /**
   * Revoke a specific workspace encryption key for a local custodial agent.
   *
   * Refuses to revoke the agent's last active key — that would brick SWM
   * access. Callers should `rotateWorkspaceEncryptionKey` first, let
   * propagation settle, then revoke. The revocation is wallet-signed using
   * the agent's secp256k1 private key (which is why this endpoint is custodial-
   * only); see {@link computeWorkspaceAgentEncryptionKeyRevocationPayload}.
   */
  async revokeWorkspaceEncryptionKey(this: DKGAgent,
    agentAddress: string,
    keyId: string,
  ): Promise<{
    revokedKeyId: string;
    revokedAt: string;
    profilePublished: boolean;
    profilePublishError?: string;
  }> {
    const record = this.localAgents.get(this.resolveLocalAgentAddress(agentAddress));
    if (!record) {
      throw new Error(`Unknown local agent ${agentAddress}`);
    }
    if (record.mode !== 'custodial' || !record.privateKey) {
      throw new Error(
        `Cannot revoke encryption key on non-custodial agent ${record.agentAddress}: ` +
        'submit a pre-signed revocation via attachRevocationToWorkspaceEncryptionKey for self-sovereign agents',
      );
    }
    const target = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === keyId);
    if (!target) {
      throw new Error(`Encryption key ${keyId} not found for agent ${record.agentAddress}`);
    }
    if (!target.revokedAt) {
      const remainingActive = activeWorkspaceEncryptionKeys(record).filter((k) => k.encryptionKeyId !== keyId);
      if (remainingActive.length === 0) {
        throw new Error(
          `Refusing to revoke the only active encryption key for agent ${record.agentAddress}: ` +
          'call rotateWorkspaceEncryptionKey first to mint a replacement',
        );
      }
    }
    const entry = revokeCustodialWorkspaceEncryptionKey(record, keyId);
    await this.persistAgentToStore(record);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Revoked encryption key ${keyId} for agent ${record.agentAddress}`);

    const publishOutcome = await this.publishProfileAfterKeyChange(record, {
      action: 'revocation',
      // Revocation always matters for other peers: without the updated profile
      // they'll keep encrypting to the supposedly retired key.
      criticalForOtherPeers: true,
    });

    return {
      revokedKeyId: keyId,
      revokedAt: entry.revokedAt!,
      profilePublished: publishOutcome.published,
      profilePublishError: publishOutcome.error,
    };
  }

  /**
   * Re-publish the daemon's agent profile after an encryption-key rotation
   * or revocation, and return a structured outcome so callers can surface
   * the failure to the operator instead of silently swallowing it.
   *
   * - `published: true` means peers will (eventually) see the new key set.
   * - `published: false` with no `error` means we deliberately skipped the
   *   publish: the affected agent is not the daemon's default, so the
   *   single-profile `publishProfile()` flow doesn't cover it. Operators
   *   must republish that agent's profile through whichever channel they
   *   normally use (e.g., a separate node hosting it).
   * - `published: false` with `error` means we tried and failed; the local
   *   keystore + RDF are already updated, but peers may keep encrypting to
   *   the supposedly-retired key until the next successful publish. The
   *   caller MUST treat this as a partial failure for revocation paths.
   */
  async publishProfileAfterKeyChange(this: DKGAgent,
    record: AgentKeyRecord,
    opts: { action: string; criticalForOtherPeers: boolean },
  ): Promise<{ published: boolean; error?: string }> {
    if (record.agentAddress !== this.defaultAgentAddress) {
      return { published: false };
    }
    const ctx = createOperationContext('system');
    try {
      await this.publishProfile();
      return { published: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = `Profile re-publish after ${opts.action} FAILED for agent ${record.agentAddress}: ${msg}` +
        (opts.criticalForOtherPeers
          ? ' — peers will keep encrypting to the retired key until republish succeeds; retry via /api/agent/publish-profile or restart'
          : ' — the new key is persisted locally but peers will discover it on their next agent-registry sync');
      if (opts.criticalForOtherPeers) {
        this.log.error(ctx, detail);
      } else {
        this.log.warn(ctx, detail);
      }
      return { published: false, error: msg };
    }
  }

  resolveLocalAgentAddress(this: DKGAgent, addressOrLowercase: string): string {
    if (this.localAgents.has(addressOrLowercase)) return addressOrLowercase;
    try {
      const checksum = ethers.getAddress(addressOrLowercase);
      if (this.localAgents.has(checksum)) return checksum;
    } catch { /* fall through */ }
    return addressOrLowercase;
  }

  /**
   * Resolve an agent address from a Bearer token.
   * Returns undefined if the token is not an agent token (could be a node-level token).
   */
  resolveAgentByToken(this: DKGAgent, token: string): string | undefined {
    return this.agentTokenIndex.get(token);
  }

  /**
   * Look up the custodial private key for a registered agent.
   *
   * Returns the hex-encoded private key for `mode === 'custodial'` agents
   * (the daemon generated and persisted the keypair at registration). Returns
   * `undefined` if the agent is unknown to this node, is `'self-sovereign'`
   * (the node never had the key), or does not have a `privateKey` field set
   * for any reason.
   *
   * Used by `publishFromSharedMemory` to resolve a per-publish author signer
   * without exposing the entire `AgentKeyRecord` (which would leak the auth
   * token hash and other off-axis material). Phase 4 / RFC-001 §4(b).
   *
   * @param address Ethereum address of the registered agent.
   */
  getCustodialAgentPrivateKey(this: DKGAgent, address: string): string | undefined {
    const record = this.localAgents.get(address);
    if (!record || record.mode !== 'custodial') return undefined;
    return record.privateKey;
  }

  /**
   * Look up the registration mode for a known local agent.
   * Returns undefined if the agent is unknown to this node.
   */
  getLocalAgentMode(this: DKGAgent, address: string): 'custodial' | 'self-sovereign' | undefined {
    return this.localAgents.get(address)?.mode;
  }

  /**
   * Get the default agent address for this node.
   * Used when requests come in with a node-level token.
   */
  getDefaultAgentAddress(this: DKGAgent): string | undefined {
    return this.defaultAgentAddress;
  }

  /**
   * Resolve the agent address for a request: first try agent token, then fall
   * back to the default agent (for node-level tokens / backward compatibility).
   */
  resolveAgentAddress(this: DKGAgent, token: string | undefined): string {
    if (token) {
      const addr = this.agentTokenIndex.get(token);
      if (addr) return addr;
    }
    if (this.defaultAgentAddress) return this.defaultAgentAddress;
    return this.peerId;
  }

  /**
   * Load every (publicEncryptionKey, algorithm, proof) triple-set we've
   * previously persisted, grouped by agent address, alongside any
   * wallet-signed revocations we've published on those key URIs.
   *
   * Used by `loadAgentsFromStore` to recover the public side of an agent's
   * encryption keys when the keystore has been lost or partially overwritten.
   * Returns a map of `agentAddress.toLowerCase() -> entries[]`.
   *
   * The on-the-wire schema currently attaches publicEncryptionKey /
   * encryptionKeyAlgorithm / encryptionKeyProof directly to the agent URI
   * (rather than reifying each key as its own subject), so a multi-key agent
   * produces a small cartesian product across (key, alg, proof). We pair
   * them up by recomputing `workspaceAgentEncryptionKeyId(agent, publicBytes)`
   * for each row and filtering by EIP-191 proof validity — mismatched
   * combinations from the cartesian fail verification and are dropped.
   */
  async loadEncryptionKeyTriplesByAgent(this: DKGAgent): Promise<Map<string, WorkspaceEncryptionKeyEntry[]>> {
    const graph = DKGAgentBase.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    const byAgent = new Map<string, WorkspaceEncryptionKeyEntry[]>();
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';

    type KeyRow = { keyB64: string; algorithm: string; proof: string };
    const rowsByAgent = new Map<string, KeyRow[]>();
    try {
      const keysResult = await this.store.query(`
        SELECT ?address ?key ?algorithm ?proof WHERE {
          GRAPH <${graph}> {
            ?agent a <${DKG}Agent> ;
                   <${DKG}agentAddress> ?address ;
                   <${DKG}publicEncryptionKey> ?key .
            OPTIONAL { ?agent <${DKG}encryptionKeyAlgorithm> ?algorithm }
            OPTIONAL { ?agent <${DKG}encryptionKeyProof> ?proof }
          }
        }
      `);
      if (keysResult.type !== 'bindings') return byAgent;
      for (const row of keysResult.bindings) {
        const addr = strip(row['address']);
        const keyB64 = strip(row['key']);
        if (!addr || !keyB64) continue;
        const lower = addr.toLowerCase();
        if (!rowsByAgent.has(lower)) rowsByAgent.set(lower, []);
        rowsByAgent.get(lower)!.push({
          keyB64,
          algorithm: strip(row['algorithm']) || WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
          proof: strip(row['proof']),
        });
      }
    } catch {
      return byAgent;
    }

    if (rowsByAgent.size === 0) return byAgent;

    // Revocations are keyed by the encryption-key URI (subject =
    // workspaceAgentEncryptionKeyId), not by agent URI. Fetch them all in
    // one pass so we can attach them while walking the cartesian above.
    const revocations = new Map<string, { revokedAt: string; revocationProof: string }>();
    try {
      const revResult = await this.store.query(`
        SELECT ?keyId ?revokedAt ?proof WHERE {
          GRAPH <${graph}> {
            ?keyId <${DKG}revokedAt> ?revokedAt ;
                   <${DKG}encryptionKeyRevocationProof> ?proof .
          }
        }
      `);
      if (revResult.type === 'bindings') {
        for (const row of revResult.bindings) {
          const keyId = strip(row['keyId']);
          const revokedAt = strip(row['revokedAt']);
          const proof = strip(row['proof']);
          if (keyId && revokedAt && proof) {
            revocations.set(keyId, { revokedAt, revocationProof: proof });
          }
        }
      }
    } catch {
      // Revocations are advisory metadata for recovered keys — proceeding
      // without them just means recovered keys come back active. The
      // resolver enforces revocation independently from this loader.
    }

    for (const [lowerAddr, rows] of rowsByAgent) {
      let checksumAddr: string;
      try {
        checksumAddr = ethers.getAddress(lowerAddr);
      } catch {
        continue;
      }
      const seen = new Set<string>();
      const entries: WorkspaceEncryptionKeyEntry[] = [];
      for (const row of rows) {
        if (row.algorithm !== WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519) continue;
        if (!row.proof) continue;
        let publicKeyBytes: Uint8Array;
        try {
          publicKeyBytes = decodeWorkspaceEncryptionKey(row.keyB64);
        } catch {
          continue;
        }
        // EIP-191 verify so we drop cartesian-product mismatches (a key
        // paired with another key's proof) without trusting input order.
        let recovered: string;
        try {
          const payload = computeWorkspaceAgentEncryptionKeyProofPayload({
            agentAddress: checksumAddr,
            encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicKeyBytes,
          });
          recovered = ethers.verifyMessage(payload, row.proof);
        } catch {
          continue;
        }
        if (recovered.toLowerCase() !== lowerAddr) continue;
        const encryptionKeyId = workspaceAgentEncryptionKeyId(checksumAddr, publicKeyBytes);
        if (seen.has(encryptionKeyId)) continue;
        seen.add(encryptionKeyId);
        const entry: WorkspaceEncryptionKeyEntry = {
          encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
          encryptionKeyId,
          publicEncryptionKey: row.keyB64,
          encryptionKeyProof: row.proof,
          createdAt: new Date(0).toISOString(),
        };
        const rev = revocations.get(encryptionKeyId);
        if (rev) {
          // Verify the revocation proof BEFORE adopting it. Without
          // this guard, anyone who can write into this node's agents
          // RDF graph could forge `revokedAt` + `revocationProof`
          // triples on a key URI, and the daemon would treat its own
          // public key as retired on the next boot — silently
          // bricking propagation for an attacker-chosen key. The
          // resolver already verifies the same proof before honouring
          // cross-agent revocations; mirror that here so the same
          // forged triples can't poison local startup state either.
          // Codex review of PR #540 / commit 60ead6be.
          let recoveredRev: string;
          try {
            const revPayload = computeWorkspaceAgentEncryptionKeyRevocationPayload({
              agentAddress: checksumAddr,
              encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
              publicKeyBytes,
              revokedAt: rev.revokedAt,
            });
            recoveredRev = ethers.verifyMessage(revPayload, rev.revocationProof);
          } catch {
            recoveredRev = '';
          }
          if (recoveredRev && recoveredRev.toLowerCase() === lowerAddr) {
            entry.revokedAt = rev.revokedAt;
            entry.revocationProof = rev.revocationProof;
          }
        }
        entries.push(entry);
      }
      if (entries.length > 0) byAgent.set(lowerAddr, entries);
    }

    return byAgent;
  }

  async persistAgentToStore(this: DKGAgent, record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgentBase.AGENT_SYSTEM_GRAPH;
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    const quads: Quad[] = [
      { subject: agentUri, predicate: RDF_TYPE, object: `${DKG}Agent`, graph },
      { subject: agentUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(record.name)}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAddress`, object: `"${record.agentAddress}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentMode`, object: `"${record.mode}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAuthTokenHash`, object: `"${hashAgentToken(record.authToken)}"`, graph },
      { subject: agentUri, predicate: `${DKG}createdAt`, object: `"${record.createdAt}"`, graph },
    ];
    if (record.publicKey) {
      quads.push({ subject: agentUri, predicate: `${DKG}publicKey`, object: `"${record.publicKey}"`, graph });
    }
    // Emit one (publicEncryptionKey, algorithm, proof) tuple per registered key
    // — the resolver collects every authenticated key into the recipient set, so
    // multi-key agents need all entries present in RDF. For revoked keys we
    // additionally publish wallet-signed revocation triples on the key URI; the
    // resolver honours them and skips the key. Self-sovereign agents whose
    // entries lack a private half are still authenticatable via their proof
    // (private bytes never leave the originating node anyway).
    for (const entry of record.workspaceEncryptionKeys) {
      quads.push(
        { subject: agentUri, predicate: `${DKG}publicEncryptionKey`, object: `"${entry.publicEncryptionKey}"`, graph },
        { subject: agentUri, predicate: `${DKG}encryptionKeyAlgorithm`, object: `"${entry.encryptionKeyAlgorithm}"`, graph },
        { subject: agentUri, predicate: `${DKG}encryptionKeyProof`, object: `"${entry.encryptionKeyProof}"`, graph },
      );
      if (entry.revokedAt && entry.revocationProof) {
        quads.push(
          { subject: entry.encryptionKeyId, predicate: `${DKG}revokedAt`, object: `"${entry.revokedAt}"`, graph },
          { subject: entry.encryptionKeyId, predicate: `${DKG}revokedBy`, object: agentUri, graph },
          { subject: entry.encryptionKeyId, predicate: `${DKG}encryptionKeyRevocationProof`, object: `"${entry.revocationProof}"`, graph },
        );
      }
    }
    if (record.framework) {
      quads.push({ subject: agentUri, predicate: 'https://dkg.origintrail.io/skill#framework', object: `"${record.framework}"`, graph });
    }

    await this.store.insert(quads);
  }

  /**
   * Load previously registered agents from the triple store on startup.
   */
  public async loadAgentsFromStore(this: DKGAgent): Promise<void> {
    const graph = DKGAgentBase.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';

    // Load raw tokens and custodial keys from the on-disk keystore
    const keystore = await this.loadKeystore();

    // Encryption keys live in BOTH the keystore (private halves; authoritative
    // for keys we own) and RDF (public halves + proofs + revocations; what we
    // previously told the network). On boot we merge both sources so that:
    //   - a stale/missing keystore can be re-hydrated with the public-side
    //     metadata for keys we've already published (otherwise peers keep
    //     encrypting to a key the registry says we have but we don't load),
    //   - keys we minted but haven't republished yet survive (keystore-only
    //     entries get carried into the in-memory record and emitted on the
    //     next persistAgentToStore() pass).
    // Keystore is authoritative for the private half AND the revocation
    // status of keys it covers — we never trust an RDF-side revocation that
    // contradicts our own keystore record, because anyone with insert access
    // could otherwise brick our own keys.
    const rdfEncryptionKeysByAgent = await this.loadEncryptionKeyTriplesByAgent();
    const sparql = `
      SELECT ?agent ?name ?address ?mode ?tokenHash ?legacyToken ?publicKey ?framework ?createdAt ?isDefault WHERE {
        GRAPH <${graph}> {
          ?agent a <${DKG}Agent> ;
                 <https://schema.org/name> ?name ;
                 <${DKG}agentAddress> ?address ;
                 <${DKG}agentMode> ?mode .
          OPTIONAL { ?agent <${DKG}agentAuthTokenHash> ?tokenHash }
          OPTIONAL { ?agent <${DKG}agentAuthToken> ?legacyToken }
          OPTIONAL { ?agent <${DKG}publicKey> ?publicKey }
          OPTIONAL { ?agent <https://dkg.origintrail.io/skill#framework> ?framework }
          OPTIONAL { ?agent <${DKG}createdAt> ?createdAt }
          OPTIONAL { ?agent <${DKG}isDefaultAgent> ?isDefault }
        }
      }
    `;
    let markedDefaultAddr: string | undefined;
    const needsMigration: AgentKeyRecord[] = [];
    try {
      const result = await this.store.query(sparql, { source: 'agent.agentKeyMigration' });
      if (result.type !== 'bindings') return;
      const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
      for (const row of result.bindings) {
        const addr = strip(row['address']);
        const ksEntry = keystore[addr.toLowerCase()];
        const legacyToken = strip(row['legacyToken']);

        // Token resolution: prefer keystore file → legacy plaintext → empty
        let authToken = ksEntry?.authToken ?? '';
        if (!authToken && legacyToken) {
          authToken = legacyToken;
        }

        const record: AgentKeyRecord = {
          agentAddress: addr,
          publicKey: strip(row['publicKey']) || '',
          workspaceEncryptionKeys: [],
          name: strip(row['name']),
          framework: strip(row['framework']) || undefined,
          mode: strip(row['mode']) as 'custodial' | 'self-sovereign',
          authToken,
          createdAt: strip(row['createdAt']) || '',
        };

        // Restore private key: prefer keystore file, fall back to operational keys
        if (record.mode === 'custodial' && !record.privateKey) {
          if (ksEntry?.privateKey) {
            record.privateKey = ksEntry.privateKey;
          } else {
            const opKeys = this.config.chainConfig?.operationalKeys;
            if (opKeys?.length) {
              for (const key of opKeys) {
                try {
                  const w = new ethers.Wallet(key);
                  if (w.address.toLowerCase() === record.agentAddress.toLowerCase()) {
                    record.privateKey = key;
                    break;
                  }
                } catch { /* skip invalid keys */ }
              }
            }
          }
        }

        // Hydrate workspaceEncryptionKeys[] from the keystore. v2 keystores have
        // the array directly; v1 keystores only carry the singular fields, so
        // we copy them onto the record and let the migration helper backfill.
        if (ksEntry?.workspaceEncryptionKeys?.length) {
          record.workspaceEncryptionKeys = ksEntry.workspaceEncryptionKeys.map((k) => ({ ...k }));
        } else if (ksEntry?.publicEncryptionKey || ksEntry?.privateEncryptionKey || ksEntry?.encryptionKeyProof) {
          record.publicEncryptionKey = ksEntry.publicEncryptionKey;
          record.privateEncryptionKey = ksEntry.privateEncryptionKey;
          record.encryptionKeyAlgorithm = ksEntry.encryptionKeyAlgorithm;
          record.encryptionKeyProof = ksEntry.encryptionKeyProof;
          migrateLegacyWorkspaceEncryptionFields(record);
        }

        // Merge in any encryption-key entries that exist in RDF but not in the
        // keystore. This is the recovery path: if the keystore was lost or
        // never written for this agent, the public-side material we already
        // published to peers is preserved here so callers see the same key
        // set as the rest of the network — and the resolver still routes
        // gossip to the same wrapped slots. Public-only entries cannot
        // decrypt incoming gossip (no private half), but they keep the
        // agent's registry-visible identity stable; the operator decides
        // whether to rotate.
        const rdfKeysForAgent = rdfEncryptionKeysByAgent.get(record.agentAddress.toLowerCase()) ?? [];
        let publicOnlyAdoptedFromRdf = 0;
        let revocationsAdoptedFromRdf = 0;
        for (const rdfEntry of rdfKeysForAgent) {
          const existing = record.workspaceEncryptionKeys.find((k) => k.encryptionKeyId === rdfEntry.encryptionKeyId);
          if (existing) {
            // Keystore wins for the key material itself (we keep our local
            // private half). BUT: if the RDF entry carries a revocation
            // the keystore hasn't picked up yet, honor it.
            //
            // This is the self-sovereign / off-node revoke flow: the
            // operator wallet-signs a revocation from a different device,
            // submits it via `attachRevocationToWorkspaceEncryptionKey`,
            // and it lands in the agents RDF graph. The keystore on this
            // node may not yet have been mutated. Without the merge below,
            // a restart resurrects the stale key as active and the daemon
            // keeps advertising + accepting traffic on it. Codex review
            // of PR #540 / commit 24aa4855.
            //
            // SAFE because `loadEncryptionKeyTriplesByAgent` has already
            // EIP-191-verified `revocationProof` against `record.agentAddress`
            // (the round-2 fix). A forged revocation triple would have been
            // dropped there and never reach this merge step, so attaching
            // it here cannot brick our own key — only a wallet-signed
            // revocation makes it through.
            if (rdfEntry.revokedAt && rdfEntry.revocationProof && !existing.revokedAt) {
              existing.revokedAt = rdfEntry.revokedAt;
              existing.revocationProof = rdfEntry.revocationProof;
              revocationsAdoptedFromRdf++;
            }
            continue;
          }
          record.workspaceEncryptionKeys.push({ ...rdfEntry });
          publicOnlyAdoptedFromRdf++;
        }
        if (revocationsAdoptedFromRdf > 0) {
          const ctx = createOperationContext('system');
          this.log.warn(
            ctx,
            `Adopted ${revocationsAdoptedFromRdf} verified revocation(s) from RDF onto keystore-tracked ` +
            `keys for agent ${record.agentAddress}. Likely an off-node revoke flow (operator wallet-signed ` +
            'a revocation from a different device); the local keystore is now reconciled. The daemon will ' +
            're-emit these revocations on the next profile publish.',
          );
        }
        if (publicOnlyAdoptedFromRdf > 0) {
          const ctx = createOperationContext('system');
          this.log.warn(
            ctx,
            `Recovered ${publicOnlyAdoptedFromRdf} workspace encryption key(s) for agent ${record.agentAddress} ` +
            'from RDF that are missing from the keystore. The agent will be visible to peers under these keys ' +
            'but cannot decrypt gossip wrapped to them (private halves are gone). Run ' +
            '`dkg agent rotate-encryption-key --retire-old` to replace and revoke them.',
          );
        }

        refreshDefaultEncryptionKeyView(record);
        const generatedEncryptionKey = ensureWorkspaceEncryptionKey(record);

        this.localAgents.set(record.agentAddress, record);
        if (record.authToken) {
          this.agentTokenIndex.set(record.authToken, record.agentAddress);
        }

        if (strip(row['isDefault']) === 'true') {
          markedDefaultAddr = record.agentAddress;
        }

        // Schedule migration: plaintext token in RDF but no keystore entry yet
        if (legacyToken && !ksEntry?.authToken) {
          needsMigration.push(record);
        }
        // Migrate keystore to v2 shape when we minted a fresh key, or when the
        // keystore lacks the array but has legacy singular fields we've folded
        // into it above.
        if (generatedEncryptionKey || (!ksEntry?.workspaceEncryptionKeys?.length && record.workspaceEncryptionKeys.length > 0)) {
          needsMigration.push(record);
        }
      }
      if (markedDefaultAddr) {
        this.defaultAgentAddress = markedDefaultAddr;
      }
      if (this.localAgents.size > 0) {
        const ctx = createOperationContext('system');
        this.log.info(ctx, `Loaded ${this.localAgents.size} registered agent(s) from store`);
      }
      // Migrate legacy plaintext tokens: save to keystore, replace RDF with hash
      for (const rec of needsMigration) {
        await this.saveToKeystore(rec);
        await this.persistAgentToStore(rec);
        await this.migrateTokenToHash(rec);
      }
    } catch {
      // Graph may not exist yet on first boot
    }
  }

  /**
   * Auto-register the default "owner" agent from the first operational wallet.
   * Called on boot when no agents have been previously registered.
   */
  public async autoRegisterDefaultAgent(this: DKGAgent): Promise<void> {
    let opKey = this.config.chainConfig?.operationalKeys?.[0];
    if (!opKey && typeof (this.chain as any).getOperationalPrivateKey === 'function') {
      try {
        opKey = (this.chain as any).getOperationalPrivateKey();
      } catch { /* adapter without key — skip */ }
    }
    if (!opKey) return;

    const record = agentFromPrivateKey(
      opKey,
      this.config.name ?? 'owner',
      this.config.framework,
    );

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    this.defaultAgentAddress = record.agentAddress;
    await this.persistAgentToStore(record);
    await this.markDefaultAgent(record.agentAddress);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Auto-registered default agent "${record.name}" → ${record.agentAddress}`);
  }

  // ---------------------------------------------------------------------------
  // Agent keystore — secrets kept out of queryable RDF
  // ---------------------------------------------------------------------------

  keystorePath(this: DKGAgent): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/agent-keystore.json`;
  }

  async loadKeystore(this: DKGAgent): Promise<Record<string, KeystoreEntry>> {
    const ksPath = this.keystorePath();
    if (!ksPath) return {};
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(ksPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /**
   * Persist an agent record to disk. We always write the multi-key array
   * (`workspaceEncryptionKeys`) and also refresh the legacy singular fields to
   * mirror the default active key — that keeps an older daemon binary that
   * was downgraded after a rotation able to read its primary key without
   * crashing, while the v2 daemon reads the array verbatim.
   */
  async saveToKeystore(this: DKGAgent, record: AgentKeyRecord): Promise<void> {
    const ksPath = this.keystorePath();
    if (!ksPath) return;
    try {
      const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      let existing: Record<string, KeystoreEntry> = {};
      try {
        const raw = await readFile(ksPath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* first write */ }
      const defaultActive = activeWorkspaceEncryptionKeys(record)[0];
      existing[record.agentAddress.toLowerCase()] = {
        authToken: record.authToken,
        ...(record.privateKey ? { privateKey: record.privateKey } : {}),
        ...(record.workspaceEncryptionKeys.length
          ? { workspaceEncryptionKeys: record.workspaceEncryptionKeys.map((k) => ({ ...k })) }
          : {}),
        ...(defaultActive?.encryptionKeyAlgorithm ? { encryptionKeyAlgorithm: defaultActive.encryptionKeyAlgorithm } : {}),
        ...(defaultActive?.publicEncryptionKey ? { publicEncryptionKey: defaultActive.publicEncryptionKey } : {}),
        ...(defaultActive?.privateEncryptionKey ? { privateEncryptionKey: defaultActive.privateEncryptionKey } : {}),
        ...(defaultActive?.encryptionKeyProof ? { encryptionKeyProof: defaultActive.encryptionKeyProof } : {}),
      };
      await mkdir(dirname(ksPath), { recursive: true });
      await writeFile(ksPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
      await chmod(ksPath, 0o600);
    } catch {
      // Non-fatal — agent still works, just won't survive restart
    }
  }

  /**
   * One-time migration: replace a legacy plaintext agentAuthToken triple
   * with an agentAuthTokenHash triple so future SPARQL queries never
   * reveal the raw token.
   */
  async migrateTokenToHash(this: DKGAgent, record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgentBase.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    try {
      await this.store.delete([{
        subject: agentUri,
        predicate: `${DKG}agentAuthToken`,
        object: `"${record.authToken}"`,
        graph,
      }]);
      await this.store.insert([{
        subject: agentUri,
        predicate: `${DKG}agentAuthTokenHash`,
        object: `"${hashAgentToken(record.authToken)}"`,
        graph,
      }]);
      const ctx = createOperationContext('system');
      this.log.info(ctx, `Migrated plaintext auth token to hash for agent ${record.agentAddress}`);
    } catch {
      // Non-fatal — old token remains readable until next migration attempt
    }
  }

  /**
   * Persist an explicit default-agent marker in the triple store so the
   * default agent is deterministic across restarts (independent of SPARQL
   * result ordering).
   */
  public async markDefaultAgent(this: DKGAgent, agentAddress: string): Promise<void> {
    const graph = DKGAgentBase.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    // Clear any existing default marker
    try {
      const existing = await this.store.query(
        `SELECT ?agent WHERE { GRAPH <${graph}> { ?agent <${DKG}isDefaultAgent> "true" } }`,
      );
      if (existing.type === 'bindings') {
        for (const row of existing.bindings) {
          const agentUri = row['agent'];
          if (agentUri) {
            await this.store.delete([{
              subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
            }]);
          }
        }
      }
    } catch { /* ignore */ }
    const agentUri = `did:dkg:agent:${agentAddress}`;
    await this.store.insert([{
      subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
    }]);
  }

  /**
   * Check whether any locally registered agent is the curator/creator
   * of the given context graph.
   */
  async isCuratorOf(this: DKGAgent, contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    // Mirror the comparison in PROTOCOL_JOIN_REQUEST. `normalizeAgentDid`
    // collapses EVM-address case drift but preserves peer-ID case.
    const ownerNorm = normalizeAgentDid(owner);
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (ownerNorm === selfDid) return true;
    for (const addr of this.localAgents.keys()) {
      if (ownerNorm === normalizeAgentDid(`did:dkg:agent:${addr}`)) return true;
    }
    return false;
  }

  /**
   * Chain-confirmed verified author identity for a knowledge collection's
   * latest merkle-root entry. Reads
   * `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kaId)` via the
   * configured chain adapter.
   *
   * Returns:
   *   - the address recovered from the EIP-712 author attestation (EOA
   *     publish path), or
   *   - the smart-contract author address verified via EIP-1271 for
   *     contract-based author identities, or
   *   - `address(0)` for legacy V8 / V9 publishes and current V10.1
   *     update-path mutations (which don't sign).
   *
   * Returns `null` when the chain adapter doesn't expose the view (no-chain
   * mode or pre-V10.1 evm-adapter copies). Callers that need to distinguish
   * "no attestation on file" from "feature unavailable" should use this
   * `null` signal — `address(0)` always means the former.
   */
  async getKnowledgeCollectionAuthor(this: DKGAgent, kaId: bigint): Promise<string | null> {
    if (typeof this.chain.getLatestMerkleRootAuthor !== 'function') return null;
    return this.chain.getLatestMerkleRootAuthor(kaId);
  }

  /** V10 Publishing Conviction NFT facade — thin chain-adapter wrappers.
   *  Owner revert not swallowed (→ 403); `null` = no surface (→ 503). */

  /** True when the chain adapter exposes the V10 Publishing Conviction NFT surface. */
  get supportsPublishingConvictionNft(): boolean {
    return typeof this.chain.getPublishingConvictionAccountInfo === 'function';
  }

  /** True when the adapter can serve the daemon's PCA browser-read RPC bridge. */
  get supportsPublishingConvictionRpc(): boolean {
    return typeof this.chain.requestPublishingConvictionRpc === 'function';
  }

  // OT-RFC-51: `primaryNode` (the node identityId this PCA's committed TRAC
  // funds via the publishing factor) is REQUIRED — no silent `0n` default. A
  // PCA created with node 0 seeds no allocation to anyone, and the SDK exposes
  // no `setPrimaryNode`, so a defaulted-0 PCA would be silently inert. Forcing
  // the caller to pass a node makes that outcome impossible by accident.
  async createPublishingConvictionAccount(this: DKGAgent,
    committedTRAC: bigint,
    primaryNode: bigint,
  ): Promise<({ accountId: bigint } & TxResult) | null> {
    if (typeof this.chain.createPublishingConvictionAccount !== 'function') return null;
    return this.chain.createPublishingConvictionAccount(committedTRAC, primaryNode);
  }

  async topUpPublishingConvictionAccount(this: DKGAgent, accountId: bigint, amount: bigint): Promise<TxResult | null> {
    if (typeof this.chain.topUpPublishingConvictionAccount !== 'function') return null;
    return this.chain.topUpPublishingConvictionAccount(accountId, amount);
  }

  async registerPublishingConvictionAgent(this: DKGAgent, accountId: bigint, agent: string): Promise<TxResult | null> {
    if (typeof this.chain.registerPublishingConvictionAgent !== 'function') return null;
    return this.chain.registerPublishingConvictionAgent(accountId, agent);
  }

  async deregisterPublishingConvictionAgent(this: DKGAgent, accountId: bigint, agent: string): Promise<TxResult | null> {
    if (typeof this.chain.deregisterPublishingConvictionAgent !== 'function') return null;
    return this.chain.deregisterPublishingConvictionAgent(accountId, agent);
  }

  async isPublishingConvictionAgent(this: DKGAgent, accountId: bigint, agent: string): Promise<boolean | null> {
    if (typeof this.chain.isPublishingConvictionAgent !== 'function') return null;
    return this.chain.isPublishingConvictionAgent(accountId, agent);
  }

  // #1346 — Best-effort on-chain confirmation of a just-mined agent
  // registration. The tx receipt is already authoritative for
  // `registered:true`; this only refines the ADVISORY `{ verified,
  // adapterSupported }` signals (see `confirmPcaAgentRegistration` for the
  // decoupled-signal contract + bounded-probe state machine). A lagging or
  // throwing read stays advisory and NEVER flips the authoritative
  // registration. The retry policy is a private production constant —
  // deliberately NOT a caller-tunable option on the public facade — so this
  // method exposes only the domain operation: confirm this mined registration.
  async confirmPublishingConvictionAgentRegistration(this: DKGAgent,
    accountId: bigint,
    agent: string,
  ): Promise<PcaAgentConfirmation> {
    return confirmPcaAgentRegistration(() => this.isPublishingConvictionAgent(accountId, agent));
  }

  async settlePublishingConvictionAccount(this: DKGAgent, accountId: bigint): Promise<TxResult | null> {
    if (typeof this.chain.settlePublishingConvictionAccount !== 'function') return null;
    return this.chain.settlePublishingConvictionAccount(accountId);
  }

  async getPublishingConvictionAccountInfo(this: DKGAgent,
    accountId: bigint,
    opts?: { extended?: boolean },
  ): Promise<V10PublishingConvictionAccountInfo | null> {
    if (typeof this.chain.getPublishingConvictionAccountInfo !== 'function') return null;
    return this.chain.getPublishingConvictionAccountInfo(accountId, opts);
  }

  /** OT-RFC-51 designated primary node for a PCA; `null` = no chain surface, `0n` = unset. */
  async getConvictionPrimaryNode(this: DKGAgent, accountId: bigint): Promise<bigint | null> {
    if (typeof this.chain.getConvictionPrimaryNode !== 'function') return null;
    return this.chain.getConvictionPrimaryNode(accountId);
  }

  /** Addresses + chainId for the browser wallet-connect path; `null` = no chain surface. */
  async getPcaContractContext(this: DKGAgent): Promise<{ chainId: number; hubAddress: string; nftAddress: string; tokenAddress: string } | null> {
    if (typeof this.chain.getPcaContractContext !== 'function') return null;
    return this.chain.getPcaContractContext();
  }

  /** Enumerate PCAs owned by the bound wallet, annotated with their node association. */
  async listNodePublishingConvictionAccounts(this: DKGAgent): Promise<NodePublishingConvictionAccount[] | null> {
    if (typeof this.chain.listNodePublishingConvictionAccounts !== 'function') return null;
    return this.chain.listNodePublishingConvictionAccounts();
  }

  /** OT-RFC-51 owner-gated re-designation of a PCA's primary node. */
  async setPublishingConvictionPrimaryNode(this: DKGAgent, accountId: bigint, primaryNode: bigint): Promise<TxResult | null> {
    if (typeof this.chain.setPublishingConvictionPrimaryNode !== 'function') return null;
    return this.chain.setPublishingConvictionPrimaryNode(accountId, primaryNode);
  }

  // ----- Node operational-wallet (Identity key) management -----
  // Admin-signed on-chain key txs. `null` = no chain surface (→ 503); the
  // adapter throws on missing admin key / not-an-admin / no-profile (→ 409).

  /** The bound node's on-chain identityId (`0n` when no profile is registered). */
  async getNodeIdentityId(this: DKGAgent): Promise<bigint> {
    return this.chain.getIdentityId();
  }

  /** Whether `address` is a registered OPERATIONAL_KEY for `identityId`; `null` = no chain surface. */
  async isOperationalWalletRegistered(this: DKGAgent, identityId: bigint, address: string): Promise<boolean | null> {
    if (typeof this.chain.isOperationalWalletRegistered !== 'function') return null;
    return this.chain.isOperationalWalletRegistered(identityId, address);
  }

  /** Add an operational wallet to the node identity (admin-signed). `null` = no chain surface. */
  async addOperationalWallet(this: DKGAgent, address: string, options?: { identityId?: bigint }): Promise<TxResult | null> {
    if (typeof this.chain.addOperationalWallet !== 'function') return null;
    return this.chain.addOperationalWallet(address, options);
  }

  /** Remove an operational wallet from the node identity (admin-signed). `null` = no chain surface. */
  async removeOperationalWallet(this: DKGAgent, address: string, options?: { identityId?: bigint }): Promise<TxResult | null> {
    if (typeof this.chain.removeOperationalWallet !== 'function') return null;
    return this.chain.removeOperationalWallet(address, options);
  }

  /** Enumerate registered publishing agents (operational wallets) for a PCA.
   *  `null` when the adapter lacks the surface (daemon maps null → 503). */
  async getPublishingConvictionAgents(this: DKGAgent,
    accountId: bigint,
  ): Promise<string[] | null> {
    if (typeof this.chain.getPublishingConvictionAgents !== 'function') return null;
    return this.chain.getPublishingConvictionAgents(accountId);
  }

  /** Reverse-resolve which PCA a wallet is a registered publishing agent of,
   *  via the on-chain `agentToAccountId` map. `0n` = not registered on any
   *  account; `null` = adapter lacks the surface (daemon maps null → 503).
   *  Chain-scoped DISCOVERY (may surface an account the node does not track);
   *  callers route the id through coverage classification, never treating
   *  "registered" as "covered". */
  async getConvictionAgentAccountId(
    this: DKGAgent,
    agent: string,
    opts?: { strict?: boolean },
  ): Promise<bigint | null> {
    if (typeof this.chain.getConvictionAgentAccountId !== 'function') return null;
    return this.chain.getConvictionAgentAccountId(agent, opts);
  }

  /** GAP-1 — enumerate every PCA the given wallets relate to (owned + agent-on).
   *  `null` when the adapter lacks the surface (daemon maps null → 503). */
  async listPublishingConvictionAccountsForWallets(
    this: DKGAgent,
    wallets: string[],
  ): Promise<PcaAccountRelation[] | null> {
    if (typeof this.chain.listPublishingConvictionAccountsForWallets !== 'function') return null;
    return this.chain.listPublishingConvictionAccountsForWallets(wallets);
  }

  /** B-staked-nodes — the sharding table of designatable PCA primary nodes.
   *  `opts.fresh` bypasses the adapter's TTL cache. `null` when the adapter
   *  lacks the surface (daemon maps null → 503). */
  async listDesignatableNodes(this: DKGAgent, opts?: { fresh?: boolean }): Promise<ShardingTableNode[] | null> {
    if (typeof this.chain.listDesignatableNodes !== 'function') return null;
    return this.chain.listDesignatableNodes(opts);
  }

  /** Browser-bootstrap contract addresses + chain params for the HW signing
   *  layer (sub-PR #2). `null` when the adapter lacks the surface (daemon → 503). */
  async getPublishingConvictionContracts(this: DKGAgent): Promise<PcaContracts | null> {
    if (typeof this.chain.getPublishingConvictionContracts !== 'function') return null;
    return this.chain.getPublishingConvictionContracts();
  }

  /** Daemon-internal JSON-RPC read bridge for PCA browser reads. The daemon
   *  route owns the method allowlist and response shaping; the adapter owns the
   *  provider/failover execution. */
  async requestPublishingConvictionRpc(
    this: DKGAgent,
    method: PcaRpcMethod,
    params?: unknown[],
  ): Promise<unknown> {
    if (typeof this.chain.requestPublishingConvictionRpc !== 'function') throw new PcaUnavailableError();
    return this.chain.requestPublishingConvictionRpc(method, params);
  }

  // ---------------------------------------------------------------------------

  /**
   * Public send-bytes-to-peer primitive. Thin pass-through to `Messenger`,
   * which handles relay-prime + transport-level retry. All P2P call sites
   * SHOULD go through this rather than `this.router.send` directly.
   */
  async sendToPeer(this: DKGAgent,
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    return this.messenger.sendToPeer(peerId, protocolId, data, opts);
  }

  /**
   * Send a chat message via the Universal Messenger substrate
   * (rc.9 PR-3). `MessageHandler.sendChat` already wraps the
   * encrypted AgentMessage in a ReliableEnvelope and routes
   * through `messenger.sendReliable`, which:
   *
   *   * dedups sender-side on `(peer, protocol, messageId)`,
   *   * encodes the envelope onto the wire,
   *   * on recoverable failure enqueues to the SQLite outbox and
   *     surfaces `{ queued: true, attempts, nextAttemptAtMs }`
   *     so the MCP tool can show "queued, retrying" instead of an
   *     opaque transport error,
   *   * on success returns the response bytes.
   *
   * The chat-specific `MessageOutbox` from rc.8 has been deleted —
   * the substrate's outbox is the single source of truth (durable
   * across restarts, generic across protocols). Existing return
   * shape is preserved so the MCP `dkg_send_message` tool and the
   * `/api/chat` HTTP route continue to work unchanged.
   */
  async sendChat(this: DKGAgent,
    recipientPeerId: string,
    text: string,
    options: { contextGraphId?: string; messageId?: string } = {},
  ): Promise<ChatSendResult> {
    if (!this.messageHandler) throw new Error('Agent not started');
    const messageId = options.messageId ?? crypto.randomUUID();
    const result = await this.messageHandler.sendChat(recipientPeerId, text, {
      ...options,
      messageId,
    });

    if (result.delivered) {
      return { delivered: true, messageId };
    }

    if (result.queued) {
      const ctx = createOperationContext('system');
      this.log.warn(
        ctx,
        `Substrate-outbox queued chat retry #${result.attempts} for ${recipientPeerId.slice(-8)} ` +
          `(messageId=${messageId.slice(0, 8)}, ` +
          `next attempt at ${new Date(result.nextAttemptAtMs ?? Date.now()).toISOString()}, ` +
          `lastError=${result.error ?? 'unknown'}). ` +
          `Will retry on the periodic tick (every ${MESSAGE_OUTBOX_TICK_MS / 1000}s) ` +
          `or opportunistically on the next direct re-connect from the recipient's peer.`,
      );
      return {
        delivered: false,
        queued: true,
        messageId,
        attempts: result.attempts ?? 1,
        nextAttemptAtMs: result.nextAttemptAtMs ?? Date.now(),
        error: result.error,
      };
    }

    return {
      delivered: false,
      messageId,
      error: result.error,
    };
  }

  /**
   * Snapshot of the substrate outbox for diagnostics. Used by the
   * `GET /api/chat/outbox` route + the MCP `dkg_outbox_status` tool
   * so operators can see what's pending after a long recipient
   * outage. Returns the generic `ProtocolOutboxEntry` shape from
   * the substrate (rc.9 PR-3) rather than the chat-specific
   * `ChatOutboxRetryEntry` that rc.8 used — same fields are
   * exposed (`peer`, `messageId`, `attempts`, `firstFailureAt`,
   * `nextAttemptAt`, `lastError`), but filtered to the chat
   * protocol so the existing operator surface still talks about
   * "the chat outbox".
   */
  listMessageOutbox(this: DKGAgent): ProtocolOutboxEntry[] {
    return this.messenger
      .listOutbox()
      .filter((entry) => entry.protocol === PROTOCOL_MESSAGE);
  }

  onChat(this: DKGAgent, handler: ChatHandler): void {
    if (!this.messageHandler) {
      this._pendingChatHandler = handler;
      return;
    }
    this.messageHandler.onChat(handler);
  }

  /**
   * Install / clear the inbound-chat ACL. Pass `null` to disable (legacy
   * "accept all authenticated peers" behaviour). The daemon constructs the
   * concrete callback from `chat.acl` config — see lifecycle.ts.
   */
  setChatAcl(this: DKGAgent, check: ChatAclCheck | null): void {
    if (!this.messageHandler) {
      this._pendingChatAcl = check;
      return;
    }
    this.messageHandler.setChatAcl(check);
  }

  /**
   * GH #462 — install / clear the inbound skill-invocation ACL. Pass `null` to
   * disable (legacy open skills). The daemon constructs a default-deny policy
   * from `messaging` config — see lifecycle.ts / buildSkillAcl.
   */
  setSkillAcl(this: DKGAgent, check: SkillAclCheck | null): void {
    if (!this.messageHandler) {
      this._pendingSkillAcl = check;
      return;
    }
    this.messageHandler.setSkillAcl(check);
  }

  async invokeSkill(this: DKGAgent,
    recipientPeerId: string,
    skillUri: string,
    inputData: Uint8Array,
  ): Promise<SkillResponse> {
    if (!this.messageHandler) throw new Error('Agent not started');
    return this.messageHandler.sendSkillRequest(recipientPeerId, {
      skillUri,
      inputData,
      callback: 'inline',
    });
  }

  async connectTo(this: DKGAgent, multiaddress: string): Promise<void> {
    const ctx = createOperationContext('connect');
    await connectToMultiaddr(
      this.node.libp2p as any,
      multiaddress,
      (message) => this.log.info(ctx, message),
    );
  }

  /**
   * Resolve a peer's current multiaddrs via the {@link PeerResolver} and
   * dial them. Used by the V10 invite flow where invites carry only a peer
   * id — the daemon discovers up-to-date addresses at join time so the
   * invite stays valid across relay rotations and IP changes (which broke
   * the legacy multiaddr-in-invite design).
   *
   * After RFC 07 PR-4 the inline DHT walk is gone; resolution is delegated
   * to the resolver, which runs the full RFC 07 §3.1 order: live conn →
   * DHT → RFC 04 registry (stub) → agents-CG fallback. The resolver primes
   * the libp2p peerStore as a side effect, so a plain `libp2p.dial(peerId)`
   * here finds a route. The agents-CG fallback in particular is a new
   * capability — the legacy inline path had no way to reach a peer whose
   * DHT record was stale but whose relay was still advertised in the
   * agent registry.
   *
   * (PR #496 originally included a step-5 "bootstrap seeds" fallback in
   * the resolver itself; that was removed after Codex review pointed out
   * that bootstrap seeds are addresses for SEED peers, not for the
   * requested target. Bootstrap stays a libp2p-startup concern via
   * `bootstrap({ list })` peerDiscovery in node.ts.)
   *
   * Errors:
   *   - `INVALID_PEER_ID` — client-side parse failure (HTTP 400).
   *   - `SELF_DIAL` — caller asked us to dial our own peer id (HTTP 400).
   *   - `CONNECT_TIMEOUT` — caller's `timeoutMs` elapsed mid-resolution
   *     (the shared AbortSignal fired). Retriable → HTTP 504.
   *   - `PEER_NOT_FOUND` — resolver completed without aborting and
   *     returned no addresses (DHT miss AND no agents-CG record).
   *     Genuine negative lookup → HTTP 404.
   *     Retrying is unlikely to help until the remote node republishes.
   *   - `DIAL_FAILED` — resolver returned addresses but every dial attempt
   *     failed. Retriable transport-level → HTTP 502.
   *
   * Note (regression vs PR #431): the previous implementation distinguished
   * `DHT_TIMEOUT` (504) and `DHT_UNAVAILABLE` (503) from `PEER_NOT_FOUND`
   * because the inline walk surfaced the underlying per-step failure shape.
   * The resolver is best-effort and swallows per-step errors (returns `[]`
   * on miss). Codex review feedback on PR #499 round 5: at minimum the
   * timeout/aborted case must NOT collapse into 404, since `/api/connect`
   * upstream maps 404 to a terminal "wrong peer id" outcome and 504 to
   * retriable infrastructure errors. We split out aborted-signal → 504
   * here; the more granular 503 (DHT specifically unavailable but other
   * steps not exhausted) still requires a `resolveWithDiagnostics` API
   * on PeerResolver and is left as a follow-up — see RFC 07 §3.3.
   */
  async connectToPeerId(this: DKGAgent, peerIdStr: string, options?: { timeoutMs?: number }): Promise<void> {
    const ctx = createOperationContext('connect');
    const timeoutMs = options?.timeoutMs ?? 15_000;
    const { peerIdFromString } = await import('@libp2p/peer-id');

    let peerId;
    try {
      peerId = peerIdFromString(peerIdStr);
    } catch (err: any) {
      const error = new Error(`Invalid peer id: ${err?.message ?? String(err)}`);
      (error as any).code = 'INVALID_PEER_ID';
      throw error;
    }

    if (peerId.toString() === this.node.peerId) {
      const error = new Error('Cannot dial self');
      (error as any).code = 'SELF_DIAL';
      throw error;
    }

    // Fast-path: already connected (e.g. via gossipsub mesh / mDNS / a
    // prior invite). Resolver step 1 would also short-circuit on this,
    // but the early return preserves the existing log message and skips
    // the rest of the resolution machinery entirely.
    const existing = this.node.libp2p.getConnections(peerId);
    if (existing.length > 0) {
      this.log.info(ctx, `Already connected to ${peerIdStr}`);
      return;
    }

    // Codex review feedback on PR #499: a single AbortSignal bounds the
    // entire connect (resolution + dial). Previously `timeoutMs` was
    // passed as a per-step budget to the resolver AND reused for the
    // final dial, so a slow DHT walk plus a slow dial could exceed the
    // caller's deadline by a wide margin. Using one signal threads the
    // remaining budget through both phases.
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);

    this.log.info(ctx, `Resolving ${peerIdStr} via PeerResolver...`);
    const addrs = await this.peerResolver.resolve(peerIdStr, {
      signal,
      perStepTimeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
    });
    if (addrs.length === 0) {
      // Codex PR #499 round 5: distinguish "abort/timeout swallowed by
      // best-effort resolver" from "genuine negative lookup". Without
      // this, transient routing failures (DHT timeout, network blip)
      // surface as 404 PEER_NOT_FOUND in /api/connect — which the UI
      // treats as terminal. Mapping aborted-signal → CONNECT_TIMEOUT
      // (504) preserves the retriable-vs-terminal distinction that
      // PR #431's inline walk had.
      if (signal.aborted) {
        const error = new Error(
          `CONNECT_TIMEOUT: PeerResolver did not return addresses for ${peerIdStr} ` +
            `within ${timeoutMs}ms (caller signal aborted; transient routing failure)`,
        );
        (error as any).code = 'CONNECT_TIMEOUT';
        throw error;
      }
      const error = new Error(
        `PEER_NOT_FOUND: PeerResolver returned no addresses for ${peerIdStr}`,
      );
      (error as any).code = 'PEER_NOT_FOUND';
      throw error;
    }
    this.log.info(ctx, `Resolved ${peerIdStr} → ${addrs.length} addr(s); dialling...`);

    // peerStore is already primed by the resolver. dial(peerId) finds
    // the addresses there and goes — same AbortSignal so the overall
    // budget is honoured end-to-end.
    try {
      await this.node.libp2p.dial(peerId, { signal });
      this.log.info(ctx, `Connected to ${peerIdStr}`);
    } catch (err: any) {
      // Codex PR #499 round 5 (dkg-agent.ts:4096): the shared signal
      // covers BOTH resolution and dial. If most of the budget went
      // into resolve() and dial() then aborts on the same signal, we
      // must classify that as CONNECT_TIMEOUT (504, retriable), not
      // DIAL_FAILED (502, transport failure). Without this split, a
      // peer that resolves right before the deadline gets misclassified
      // and the UI's retry logic stops working.
      //
      // signal.aborted is the definitive check — it's our signal, so
      // an abort means the timeout fired. Also accept AbortError-named
      // errors (libp2p's transport layer surfaces those via DOMException
      // when the dial is cancelled).
      const isAbort =
        signal.aborted ||
        err?.name === 'AbortError' ||
        err?.code === 'ABORT_ERR';
      if (isAbort) {
        const error = new Error(
          `CONNECT_TIMEOUT: dial to ${peerIdStr} aborted after ` +
            `${Date.now() - startedAt}ms of ${timeoutMs}ms budget ` +
            `(resolution succeeded, dial timed out)`,
        );
        (error as any).code = 'CONNECT_TIMEOUT';
        throw error;
      }
      const error = new Error(`DIAL_FAILED: ${err?.message ?? String(err)}`);
      (error as any).code = 'DIAL_FAILED';
      throw error;
    }
  }

}
