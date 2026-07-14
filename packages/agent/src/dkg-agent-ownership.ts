// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership / curator / authority subsystem extracted from dkg-agent.ts as a
 * mixin holder: owner & policy-owner assertions, node-owner checks,
 * registration/publish authority resolution, curator + creator + participant
 * resolution, trusted join-decision sender checks, and CCL policy-binding
 * resolution helpers. 1:1 move; methods take `this: DKGAgent` so cross-calls
 * resolve against the composed class.
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

export class OwnershipMethods extends DKGAgentBase {
  public async getCclPolicyByUri(this: DKGAgent, policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
    const records = await this.listCclPolicies({ includeBody: opts.includeBody });
    return records.find(record => record.policyUri === policyUri) ?? null;
  }

  /**
   * Verify that the caller is the owner of a context graph. When an explicit
   * callerAgentAddress is provided (agent-level token), only that identity is
   * checked — no fallback to node-level identities. This prevents non-owner
   * agents on the same node from piggybacking on the node's default agent.
   *
   * Legacy fallback (peerId / defaultAgentAddress) only applies when no
   * explicit caller is known (node-level token / backward compat).
   */
  assertCallerIsOwner(this: DKGAgent, owner: string, callerAgentAddress: string | undefined, action: string): void {
    const callerDid = callerAgentAddress ? `did:dkg:agent:${callerAgentAddress}` : null;
    const selfDid = `did:dkg:agent:${this.peerId}`;

    let authorized: boolean;
    if (callerDid) {
      // Explicit caller: check only their DID.
      // Also allow through if the caller is the default agent and the owner
      // is stored under the legacy peerId-based DID (pre-agent-model CGs).
      authorized = owner === callerDid ||
        (callerAgentAddress === this.defaultAgentAddress && owner === selfDid);
    } else {
      // No explicit caller (node-level token): allow peerId and default agent only
      const defaultDid = this.defaultAgentAddress ? `did:dkg:agent:${this.defaultAgentAddress}` : null;
      authorized = owner === selfDid || (defaultDid != null && owner === defaultDid);
    }

    if (!authorized) {
      throw new Error(
        `Only the context graph creator can ${action}. ` +
        `Creator=${owner}, caller=${callerDid ?? selfDid}`,
      );
    }
  }

  public async assertContextGraphPolicyOwner(this: DKGAgent, contextGraphId: string, callerAgentAddress?: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`ContextGraph "${contextGraphId}" has no registered owner; cannot manage policies.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      throw new Error(`Only the contextGraph owner can manage policies for "${contextGraphId}". Owner=${owner}, caller=${`did:dkg:agent:${callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`);
    }
  }

  /**
   * Public owner-check used by HTTP routes that need to gate curator-only
   * actions (manifest publish, SWM template rewrites, etc.). Throws a
   * caller-friendly "Only the …" error when the caller isn't the CG's
   * registered owner/curator; returns silently when they are.
   *
   * The `action` string is interpolated into the error message so the
   * 403 response can tell the user exactly what they tried to do
   * ("publish a project manifest", "overwrite onboarding templates", …).
   */
  async assertContextGraphOwner(this: DKGAgent, contextGraphId: string, callerAgentAddress: string | undefined, action: string): Promise<void> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(`Context graph "${contextGraphId}" has no registered owner; cannot ${action}.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      const caller = callerAgentAddress
        ? `did:dkg:agent:${callerAgentAddress}`
        : `did:dkg:agent:${this.defaultAgentAddress ?? this.peerId}`;
      throw new Error(
        `Only the context graph curator can ${action} for "${contextGraphId}". ` +
        `Owner=${owner}, caller=${caller}.`,
      );
    }
  }

  /**
   * Check if the given owner DID matches the caller or the node's own identity.
   * When `callerAgentAddress` is provided, only that address is accepted
   * (plus legacy peerId compat only for the default agent).
   * Without a caller (node-level token), falls back to defaultAgentAddress and peerId.
   *
   * EVM addresses compare case-insensitively: EIP-55 checksums are display-only,
   * owner DIDs are stored as written (often checksummed), and HTTP callers may
   * pass lowercased addresses (e.g. the notifications route). Peer IDs (base58)
   * stay exact-match.
   */
  isCallerOrNodeOwner(this: DKGAgent, ownerDid: string, callerAgentAddress?: string): boolean {
    const peerDid = `did:dkg:agent:${this.peerId}`;
    const didMatchesAddress = (did: string, address: string): boolean => {
      const ownerPart = did.replace(/^did:dkg:agent:/, '');
      if (ethers.isAddress(ownerPart) && ethers.isAddress(address)) {
        return ownerPart.toLowerCase() === address.toLowerCase();
      }
      return did === `did:dkg:agent:${address}`;
    };
    const isDefaultAgent = (address: string): boolean =>
      !!this.defaultAgentAddress &&
      (address === this.defaultAgentAddress ||
        (ethers.isAddress(address) && ethers.isAddress(this.defaultAgentAddress) &&
          address.toLowerCase() === this.defaultAgentAddress.toLowerCase()));
    if (callerAgentAddress) {
      if (didMatchesAddress(ownerDid, callerAgentAddress)) return true;
      if (isDefaultAgent(callerAgentAddress) && ownerDid === peerDid) return true;
      return false;
    }
    // No explicit caller (SDK / node-level token): accept only the node's
    // own identities (peerId + defaultAgentAddress). On multi-agent nodes,
    // callers must supply callerAgentAddress to operate on non-default CGs.
    if (ownerDid === peerDid) return true;
    if (this.defaultAgentAddress && didMatchesAddress(ownerDid, this.defaultAgentAddress)) return true;
    return false;
  }

  /**
   * Chain registration must be authorized by an EVM-address principal. A
   * libp2p peer ID proves transport identity, not on-chain authority.
   */
  isCallerOrNodeAddressOwner(this: DKGAgent, ownerDid: string, callerAgentAddress?: string): boolean {
    const ownerAddress = ownerDid.replace(/^did:dkg:agent:/, '');
    if (!ethers.isAddress(ownerAddress)) return false;
    if (callerAgentAddress) {
      return ethers.isAddress(callerAgentAddress) && ownerAddress.toLowerCase() === callerAgentAddress.toLowerCase();
    }
    return !!this.defaultAgentAddress
      && ethers.isAddress(this.defaultAgentAddress)
      && ownerAddress.toLowerCase() === this.defaultAgentAddress.toLowerCase();
  }

  /**
   * Address that will SIGN on-chain CG-state-changing txs (the wallet
   * the adapter binds to `contracts.contextGraphs` and invokes
   * `createContextGraph`/`updatePublishPolicy`/etc with).
   *
   * Codex PR #502 round-8/round-9: this MUST be the actual tx signer,
   * NOT the publishing principal. We deliberately skip:
   *   - `config.publisherAddress` — the configured KA publisher
   *     address, which can be a publishing delegate that does NOT
   *     sign chain txs.
   *   - `getAuthorizedPublisherAddress(contextGraphId)` — per-CG
   *     publish-time delegate registered on chain.
   *   - The generic `signMessage` probe — returns the adapter's
   *     signing principal for arbitrary messages, not its tx-signing
   *     wallet specifically.
   *
   * We only probe signer-specific adapter surfaces:
   *   1. `getSignerAddress()` (modern method — used by the EVM
   *      adapter).
   *   2. `getSignerAddresses()` (multi-signer pool; we take the
   *      first valid address).
   *   3. `signerAddress` property (mock adapter and parity tests).
   *   4. `getOperationalPrivateKey()` (legacy adapters).
   *
   * Returning `undefined` triggers the round-5 "fail closed" branch
   * in `registerContextGraph`: PCA registration is rejected because
   * the invariant cannot be verified.
   */
  async getRegistrationTxSignerAddress(this: DKGAgent): Promise<string | undefined> {
    const chain = this.chain;

    const signerAddressGetter = (chain as unknown as { getSignerAddress?: () => unknown }).getSignerAddress;
    if (typeof signerAddressGetter === 'function') {
      try {
        const address = normalizeAdapterPublisherAddress(await Promise.resolve(signerAddressGetter.call(chain)));
        if (address) return address;
      } catch {
        // Best-effort probe; fall through to broader signer surfaces.
      }
    }

    const signerAddressesGetter = (chain as unknown as { getSignerAddresses?: () => unknown }).getSignerAddresses;
    if (typeof signerAddressesGetter === 'function') {
      try {
        const advertised = await Promise.resolve(signerAddressesGetter.call(chain));
        if (Array.isArray(advertised)) {
          for (const value of advertised) {
            const address = normalizeAdapterPublisherAddress(value);
            if (address) return address;
          }
        }
      } catch {
        // Best-effort probe.
      }
    }

    const signerAddress = normalizeAdapterPublisherAddress(
      (chain as unknown as { signerAddress?: unknown }).signerAddress,
    );
    if (signerAddress) return signerAddress;

    const adapterOperationalAddress = adapterOperationalPrivateKeyAddress(chain);
    if (adapterOperationalAddress) return adapterOperationalAddress;

    return undefined;
  }

  async getChainPublishAuthorityAddress(this: DKGAgent, contextGraphId?: string): Promise<string | undefined> {
    const configuredPublisherAddress = normalizeAdapterPublisherAddress(this.config.publisherAddress);
    if (configuredPublisherAddress) return configuredPublisherAddress;

    const legacyAdapterOperationalKey = this.config.chainConfig?.operationalKeys?.[0];
    const legacyAdapterOperationalAddress = privateKeyAddress(legacyAdapterOperationalKey);
    if (
      this.config.chainAdapter &&
      legacyAdapterOperationalAddress &&
      !(await adapterAdvertisesPublisherSigner(this.chain))
    ) {
      return legacyAdapterOperationalAddress;
    }

    let publisherContextGraphId: bigint | undefined;
    try {
      const parsed = BigInt(contextGraphId ?? '');
      if (parsed > 0n) publisherContextGraphId = parsed;
    } catch {
      // Local descriptive CG ids cannot be used as adapter context hints.
    }
    // This mirrors the publisher resolver, including the adapter-only
    // `getOperationalPrivateKey()` fallback used by custom ChainAdapters.
    return inferAdapterPublisherAddress(this.chain, publisherContextGraphId, {
      includeReservingPublisherProbe: false,
      includeGenericSignMessageProbe: false,
    });
  }

  // NOTE: `getContextGraphPublishAuthorityAccountId` and
  // `setContextGraphPublishAuthorityAccountId` helpers were removed in
  // Codex PR #502 round-6. With `registerContextGraph` no longer
  // falling back to stored values and `createContextGraph` no longer
  // persisting them, nothing on this code path reads or writes the
  // `DKG_PUBLISH_AUTHORITY_ACCOUNT_ID` triple anymore — pcaAccountId
  // lives strictly in the explicit `publishAuthorityAccountId` opt on
  // `registerContextGraph`.

  /**
   * Return true when `senderPeerId` is currently acting as the curator
   * of `contextGraphId`. Used as a minimal anti-spoof gate on join
   * lifecycle notifications (approve/reject) — those arrive unsigned
   * over p2p, so without this check any peer that knows a local
   * agent's address could forge a rejection and drive our UI into a
   * false "denied" state (Codex tier-4k N27).
   *
   * Resolution order:
   *  1. If the CG's recorded curator is a peer-ID DID
   *     (`did:dkg:agent:<libp2p-peer-id>`, legacy/creator path), match
   *     directly against `senderPeerId`.
   *  2. Otherwise the CG was registered with a wallet-scoped curator
   *     (`did:dkg:agent:0x…`). Consult the agent registry and accept
   *     the sender iff the curator agent's currently advertised peer
   *     ID matches. Registry lookup is cheap (local graph query).
   *
   * A missing curator / registry failure is treated as "not curator"
   * — we'd rather drop a real rejection than surface a forged one.
   */
  /**
   * Authorise the sender of a join-approved/rejected notification for
   * `(contextGraphId, agentAddress)`. Tries two sources, in order:
   *
   *   1. `joinRequestAcceptedBy` — peers that returned `{ok: true}`
   *      to our broadcast in `forwardJoinRequest`. This is the only
   *      check that works for the freshly-rejected case (no _meta
   *      access yet).
   *   2. `senderIsContextGraphCurator` — meta-graph curator lookup
   *      with registry fallback. This catches the case where we
   *      restarted between submit and decision (in-memory map lost),
   *      or where we're an already-approved member receiving a later
   *      decision (we have meta access from the prior approval).
   */
  public async isTrustedJoinDecisionSender(this: DKGAgent,
    contextGraphId: string,
    agentAddress: string,
    senderPeerId: string,
  ): Promise<boolean> {
    const acceptedKey = `${contextGraphId}::${agentAddress.toLowerCase()}`;
    const accepted = this.joinRequestAcceptedBy.get(acceptedKey);
    if (accepted?.has(senderPeerId)) return true;
    return this.senderIsContextGraphCurator(contextGraphId, senderPeerId);
  }

  async senderIsContextGraphCurator(this: DKGAgent, contextGraphId: string, senderPeerId: string): Promise<boolean> {
    try {
      const owner = await this.getContextGraphOwner(contextGraphId);
      if (!owner) return false;
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (ownerTail === senderPeerId) return true;
      // Wallet-scoped curator: resolve via registry. The curator's
      // peer ID is whatever they currently advertise — `findAgents()`
      // returns the freshest mapping we know about.
      if (/^0x[0-9a-fA-F]{40}$/.test(ownerTail)) {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === ownerTail.toLowerCase());
        if (match && match.peerId === senderPeerId) return true;
      }
    } catch {
      // Any lookup failure → err on the side of "not curator" and drop.
    }
    return false;
  }

  async getContextGraphOwner(this: DKGAgent, contextGraphId: string): Promise<string | null> {
    // Prefer the curator (wallet-scoped owner) so per-agent authorization
    // works on multi-agent nodes. Fall back to the creator (libp2p peer ID)
    // for legacy CGs created before the curator triple existed.
    //
    // Delegates to `getContextGraphCurator`, which already handles the
    // "multiple `dkg:curator` triples on the same local store" hazard
    // (peer sync replicates foreign curator triples) by preferring a
    // LOCAL agent's DID before falling back to the first row. Without
    // that preference, the LIMIT-1 lookup here would non-deterministically
    // pick a foreign curator and lock the real local curator out of
    // manage-participants / rename / policy operations.
    const curatorOwner = await this.getContextGraphCurator(contextGraphId);
    if (curatorOwner) return curatorOwner;
    const fromCreator = await this.getContextGraphCreator(contextGraphId);
    if (fromCreator) return fromCreator;
    // Final fallback: V10 wallet-scoped cgId convention (`0x.../<name>`)
    // encodes the curator structurally, which lets us answer for CGs
    // whose RDF `_meta` triples were never written locally — most
    // commonly because on-chain registration didn't complete (no
    // identity, RPC down, mid-flight crash). Without this fallback, the
    // PROTOCOL_JOIN_REQUEST handler silently rejects every join attempt
    // for these CGs and the joiner sees only a generic "no reachable
    // curator". See `deriveCuratorDidFromCgId` for the full rationale.
    //
    // Gate: only return the structurally-derived curator when the CG
    // actually exists locally. Without this gate, a node would accept
    // PROTOCOL_JOIN_REQUEST for any wallet-prefixed CG id starting
    // with one of its agent addresses (`0x<my-addr>/<anything>`) and
    // create stray `_meta` rows for graphs that were never created
    // here. The fallback is meant to rescue real-but-half-registered
    // graphs, not impersonate ownership of unknown ones.
    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) return null;
    return deriveCuratorDidFromCgId(contextGraphId);
  }

  async getContextGraphCurator(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string | null> {
    // Multi-curator scenario: peer-to-peer sync of CG `_meta` triples
    // can replicate FOREIGN `dkg:curator` triples onto a node's local
    // store. The original behaviour (`LIMIT 1`) made ownership lookup
    // non-deterministic — any subscribing node could win the unordered
    // query, locking the real curator out of their own CG-management
    // operations (revoke, rename, policy edits). Comment at
    // `ensureContextGraphLocal` (~13754) already documents this hazard
    // for the bootstrap path; the same fix applies at lookup time so
    // we're robust to any future re-introduction of foreign-curator
    // syncing.
    //
    // Resolution: enumerate ALL curator triples and prefer one that
    // matches a LOCAL agent (the node's own peer-id DID, any of its
    // wallet-scoped agents, or the default-agent DID). Falls back to
    // the first curator triple when no local match exists, preserving
    // the legacy "subscriber sees foreign owner" semantics for
    // membership/UI queries against CGs this node did not curate.
    const owners = (await this.getCgMeta(contextGraphId, { signal: options.signal })).curators;
    if (owners.length === 0) return null;
    if (owners.length === 1) return owners[0];
    const selfDid = `did:dkg:agent:${this.peerId}`;
    const localAgentDids = new Set<string>();
    localAgentDids.add(selfDid);
    if (this.defaultAgentAddress) {
      localAgentDids.add(`did:dkg:agent:${this.defaultAgentAddress}`);
    }
    for (const addr of this.localAgents.keys()) {
      localAgentDids.add(`did:dkg:agent:${addr}`);
    }
    const localOwner = owners.find((o) => localAgentDids.has(o));
    return localOwner ?? owners[0];
  }

  /**
   * Curator DID (`did:dkg:agent:0x…`) matches the caller's checksummed wallet address.
   */
  public curatorDidMatchesChecksumAgent(this: DKGAgent, curatorRaw: string | undefined, checksumAddress: string): boolean {
    if (!curatorRaw?.trim()) return false;
    let t = curatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${checksumAddress.toLowerCase()}`;
    return t.toLowerCase() === expected;
  }

  /**
   * Creator DID (`did:dkg:agent:<peerId>`) matches THIS node's libp2p peer id.
   * Membership signal for CGs created via this node before wallet-based curator metadata
   * was the convention — without this, a node admin (bearer-authed) loses sight of CGs
   * their own node created. Peer ids are case-sensitive base58, so we match exactly after
   * stripping IRI/quote framing.
   */
  creatorDidMatchesSelfPeer(this: DKGAgent, creatorRaw: string | undefined): boolean {
    if (!creatorRaw?.trim()) return false;
    let t = creatorRaw.trim().replace(/^["']|["']$/g, '');
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    const expected = `did:dkg:agent:${this.node.peerId}`;
    return t === expected;
  }

  /**
   * Whether the wallet is on the CG allowlist (participant / allowed-agent) or tied to a
   * listed on-chain identity ID. Does not consult curator — compose with curator checks separately.
   */
  public async callerIsAllowlistedAgentParticipant(
    this: DKGAgent,
    contextGraphId: string,
    checksumAddress: string,
    options: { onChainLookup?: () => void; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const participants = await this.getPrivateContextGraphParticipants(contextGraphId, { signal: options.signal });
    if (!participants?.length) return false;

    for (const raw of participants) {
      const p = String(raw).replace(/^["']|["']$/g, '');
      if (ethers.isAddress(p)) {
        if (ethers.getAddress(p).toLowerCase() === checksumAddress.toLowerCase()) return true;
        continue;
      }
      if (/^\d+$/.test(p) && this.chain.isOperationalWalletRegistered) {
        try {
          options.onChainLookup?.();
          if (await this.chain.isOperationalWalletRegistered(BigInt(p), checksumAddress)) return true;
        } catch {
          // ignore chain read errors — treat as non-participant
        }
      }
    }
    return false;
  }

  async getContextGraphParticipantAgentAddresses(this: DKGAgent, contextGraphId: string): Promise<string[]> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const normalized = value.replace(/^"|"$/g, '');
      if (!ethers.isAddress(normalized)) return;
      const checksumAddress = ethers.getAddress(normalized);
      if (checksumAddress === ethers.ZeroAddress) {
        throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(checksumAddress);
    };

    // OT-RFC-38 / LU-6 Phase B — the on-chain participant-agent list
    // is now the authoritative source for the host-mode envelope
    // authority check on cores (see `resolveOnChainParticipantAgents`
    // + `chainAgentGateOracle` in the publisher). For cores hosting
    // CGs they didn't create or join, the local `_meta` allowlist is
    // unreachable, so the chain list MUST contain every wallet that
    // will sign envelopes — otherwise valid ciphertext gets rejected
    // and pre-registration auto-host can't bootstrap.
    //
    // Pre-Phase-B, `DKG_PARTICIPANT_AGENT` and `DKG_ALLOWED_AGENT`
    // were semantically distinct: PARTICIPANT was the chain-side
    // allowlist (for KA publish + attestation signing), ALLOWED was
    // the local-side allowlist (for SWM decrypt). Cores never needed
    // ALLOWED because they didn't subscribe to curated SWM. With
    // Phase B they do, so the chain list MUST be a SUPERSET of the
    // local list. We merge `DKG_ALLOWED_AGENT` into the result here.
    //
    // Backward-compat: callers that explicitly passed
    // `participantAgents` on `createContextGraph` keep their values
    // (those are persisted as PARTICIPANT triples). The merge below
    // is a UNION so any per-CG explicit list survives and just gets
    // augmented with whatever local allowlist exists.
    const meta = await this.getCgMeta(contextGraphId);
    const revoked = new Set(meta.revokedAgents.map((agent) => agent.toLowerCase()));
    for (const agent of meta.participantAgents) {
      if (!revoked.has(agent.toLowerCase())) add(agent);
    }
    for (const agent of meta.allowedAgents) {
      if (!revoked.has(agent.toLowerCase())) add(agent);
    }
    return merged;
  }

  /**
   * Read `dkg:creator` (peer-ID DID) for a contextGraph. This is the publicly
   * discoverable owner handle used in gossip validation — it propagates
   * through ONTOLOGY sync for open CGs, while `dkg:curator` stays in `_meta`.
   * Emitted approve/revoke binding metadata must use this value so remote
   * peers validating via `gossip-publish-handler` see a matching owner.
   */
  async getContextGraphCreator(this: DKGAgent, contextGraphId: string): Promise<string | null> {
    return (await this.getCgMeta(contextGraphId)).creator ?? null;
  }

  public async listCclPolicyBindings(this: DKGAgent, opts: {
    contextGraphId?: string;
    name?: string;
  } = {}): Promise<PolicyApprovalBinding[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.contextGraphId) filters.push(`?contextGraph = <did:dkg:context-graph:${opts.contextGraphId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const result = await this.store.query(`
      SELECT ?binding ?policy ?contextGraph ?name ?contextType ?bindingStatus ?approvedAt ?approvedBy ?revokedAt ?revokedBy WHERE {
        GRAPH <${ontologyGraph}> {
          ?binding <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_POLICY_BINDING}> ;
                   <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH}> ?contextGraph ;
                   <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                   <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy ;
                   <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt .
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS}> ?bindingStatus }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_AT}> ?revokedAt }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_BY}> ?revokedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?approvedAt)
    `);

    if (result.type !== 'bindings') return [];
    const byBinding = new Map<string, PolicyApprovalBinding>();
    for (const row of result.bindings as Record<string, string>[]) {
      const bindingUri = row['binding'];
      const revokedAt = row['revokedAt'] ? stripLiteral(row['revokedAt']) : undefined;
      const next: PolicyApprovalBinding = {
        bindingUri,
        policyUri: row['policy'],
        contextGraphId: row['contextGraph'].startsWith('did:dkg:context-graph:') ? row['contextGraph'].slice('did:dkg:context-graph:'.length) : row['contextGraph'],
        name: stripLiteral(row['name']),
        contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
        status: revokedAt || (row['bindingStatus'] && stripLiteral(row['bindingStatus']) === 'revoked') ? 'revoked' : 'approved',
        approvedAt: stripLiteral(row['approvedAt']),
        approvedBy: row['approvedBy'],
        revokedAt,
        revokedBy: row['revokedBy'],
      };
      const current = byBinding.get(bindingUri);
      if (!current) {
        byBinding.set(bindingUri, next);
        continue;
      }
      byBinding.set(bindingUri, {
        ...current,
        status: (current.revokedAt || next.revokedAt) ? 'revoked'
          : (current.status === 'superseded' || next.status === 'superseded') ? 'superseded'
          : 'approved',
        revokedAt: current.revokedAt ?? next.revokedAt,
        revokedBy: current.revokedBy ?? next.revokedBy,
        approvedBy: current.approvedBy ?? next.approvedBy,
      });
    }
    const allBindings = Array.from(byBinding.values()).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

    // Mark non-revoked, non-latest bindings as "superseded" per scope
    const latestByScope = new Map<string, string>();
    for (const b of allBindings) {
      if (b.status === 'revoked') continue;
      const key = `${b.contextGraphId}|${b.name}|${b.contextType ?? ''}`;
      if (!latestByScope.has(key)) {
        latestByScope.set(key, b.bindingUri);
      } else if (b.bindingUri !== latestByScope.get(key)) {
        b.status = 'superseded';
      }
    }
    return allBindings;
  }

  public selectLatestNonRevokedBindings(this: DKGAgent, bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
    const latestByScope = new Map<string, PolicyApprovalBinding>();
    for (const binding of bindings) {
      if (binding.status === 'revoked' || binding.status === 'superseded') continue;
      const key = `${binding.contextGraphId}|${binding.name}|${binding.contextType ?? ''}`;
      const current = latestByScope.get(key);
      if (!current || binding.approvedAt > current.approvedAt) {
        latestByScope.set(key, binding);
      }
    }
    return latestByScope;
  }

  public resolveCclPolicyBinding(this: DKGAgent,
    latestByScope: Map<string, PolicyApprovalBinding>,
    contextGraphId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${contextGraphId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${contextGraphId}|${name}|`)
      ?? null;
  }

  public async getActiveCclPolicyBinding(this: DKGAgent, opts: {
    contextGraphId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<PolicyApprovalBinding | null> {
    const record = await this.getCclPolicyByUri(opts.policyUri);
    if (!record) return null;
    const bindings = await this.listCclPolicyBindings({ contextGraphId: opts.contextGraphId, name: record.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const active = this.resolveCclPolicyBinding(latestByScope, opts.contextGraphId, record.name, opts.contextType);
    if (!active || active.policyUri !== opts.policyUri) return null;
    return active;
  }

  public deriveCclPolicyStatus(this: DKGAgent,
    policyUri: string,
    storedStatus: string,
    bindings: PolicyApprovalBinding[],
    latestByScope: Map<string, PolicyApprovalBinding>,
  ): string {
    if (Array.from(latestByScope.values()).some(binding => binding.policyUri === policyUri)) {
      return 'approved';
    }
    if (bindings.some(binding => binding.policyUri === policyUri)) {
      return 'revoked';
    }
    return storedStatus;
  }

  public async publishOntologyQuads(this: DKGAgent, ual: string, quads: Quad[]): Promise<void> {
    const ontologyTopic = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const msg = encodePublishRequest({
      ual,
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
      // No peers subscribed — ok for local-only operation
    }
  }

}
