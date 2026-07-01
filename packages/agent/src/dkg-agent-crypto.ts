// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace-encryption / sender-key subsystem extracted from dkg-agent.ts as
 * a mixin holder: recipient/gate resolution, on-chain access-policy reads,
 * SWM sender-key epoch creation + distribution, pending-package queueing,
 * encrypt/decrypt of workspace payloads, and sender-key state persistence.
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
  POLICY_STATE_RETRY_ATTEMPTS,
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
 * #1404 — bounded retry-on-transient-UNKNOWN for a SINGLE access-policy-state
 * read. A small PURE module-level helper (NOT on the DKGAgent surface): the
 * underlying on-chain reads fail closed to 'unknown' when one read exceeds
 * {@link CHAIN_POLICY_READ_TIMEOUT_MS} (2.5s) — a slow chain RPC (observed on
 * Base) blows that easily and would refuse an otherwise-live CG. Retrying a
 * transient 'unknown'/throw lets a slow RPC land a CONFIRMED 0/1 before we fail
 * closed; a confirmed 0/1/'unregistered' returns IMMEDIATELY (no extra reads).
 * Genuine unavailability still ends 'unknown', or re-throws on the final attempt,
 * so the caller fails closed (never a plaintext downgrade on a guess). `backoffMs`
 * is injectable so tests collapse the delay; `onRetryUnknown` keeps this
 * logging-agnostic. Its ONLY consumer is
 * {@link WorkspaceCryptoMethods.resolvePublishAccessPolicyState}, so retry
 * semantics live inside that one canonical policy operation and can't be forgotten
 * or bypassed by a caller composing its own read. Exported for direct unit test.
 */
export async function retryTransientPolicyState(
  read: () => Promise<0 | 1 | 'unregistered' | 'unknown'>,
  opts?: {
    attempts?: number;
    backoffMs?: (attempt: number) => number;
    onRetryUnknown?: (attempt: number, attempts: number) => void;
  },
): Promise<0 | 1 | 'unregistered' | 'unknown'> {
  const attempts = Math.max(1, opts?.attempts ?? POLICY_STATE_RETRY_ATTEMPTS);
  const backoffMs = opts?.backoffMs ?? ((attempt: number) => 300 * attempt);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let state: 0 | 1 | 'unregistered' | 'unknown' = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      state = await read();
    } catch (err) {
      if (attempt >= attempts) throw err; // caller's try/catch fails closed
      await sleep(backoffMs(attempt));
      continue;
    }
    if (state !== 'unknown') return state; // confirmed 0 / 1 / 'unregistered'
    if (attempt < attempts) {
      opts?.onRetryUnknown?.(attempt, attempts);
      await sleep(backoffMs(attempt));
    }
  }
  return state;
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

  async getContextGraphAgentGateAddresses(
    this: DKGAgent,
    contextGraphId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const seen = new Set<string>();
    const agents: string[] = [];
    let sawAgentGate = false;
    const meta = await this.getCgMeta(contextGraphId, { signal: options.signal });
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

    const subscriptionAgents = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents ?? [];
    if (subscriptionAgents.length > 0) sawAgentGate = true;
    for (const agentAddress of subscriptionAgents) {
      add(agentAddress);
    }

    if (meta.allowedAgents.length > 0 || meta.participantAgents.length > 0) sawAgentGate = true;
    for (const agent of meta.allowedAgents) add(agent);
    for (const agent of meta.participantAgents) add(agent);

    return sawAgentGate ? agents : null;
  }

  /**
   * R9 (SECURITY) — FRESH, `_meta`-only member-recovery gate.
   *
   * Resolves `allowedAgents ∪ participantAgents` minus `revokedAgents` from the
   * CG `_meta` projection (store-backed, write-invalidated), with the
   * network-influenced `subscribedContextGraphs` subscription cache
   * DELIBERATELY OMITTED — that cache is poisonable, and folding it in is
   * exactly what `member-recovery-auth.ts` forbids.
   *
   * Unlike {@link getContextGraphAgentGateAddresses} (which feeds the normal
   * fail-open sync path and DOES fold in the subscription cache), this read is
   * used ONLY for `request.recovery` and is passed straight to
   * `isMemberRecoveryAuthorized`, which hard-denies on null/empty. Returns
   * `null` when the CG has no `_meta` agent gate at all (⇒ hard-deny).
   */
  async getMemberRecoveryGate(
    this: DKGAgent,
    contextGraphId: string,
    _options: { signal?: AbortSignal } = {},
  ): Promise<string[] | null> {
    const seen = new Set<string>();
    const agents: string[] = [];
    const meta = await this.getCgMeta(contextGraphId);
    if (meta.allowedAgents.length === 0 && meta.participantAgents.length === 0) {
      return null; // no _meta agent gate ⇒ hard-deny at the recovery gate
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
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    // SELECT also returns `expiresAtMs` so we can filter expired rows in
    // JS — pushing the FILTER into SPARQL would force a string→long
    // cast that not every store backend handles uniformly.
    // PR #448 review (round 4): without this, an approved delegation
    // remained authorised forever even after `expiresAtMs` had passed.
    // `approveJoinRequest()` re-validates expiry only at approval time;
    // sync auth never checked it again, turning `expiresAtMs` into a
    // one-time admission gate instead of an ongoing constraint.
    const result = await this.store.query(
      `SELECT ?agent ?peer ?expiresAt WHERE {
        GRAPH <${cgMetaGraph}> {
          ?d <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?agent ;
             <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}> ?peer .
          OPTIONAL { ?d <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expiresAt }
        }
      }`,
      { signal: options.signal },
    );
    const out = new Map<string, string[]>();
    if (result.type !== 'bindings') return out;
    const strip = (raw: unknown): string => {
      if (typeof raw !== 'string') return '';
      return raw.replace(/^"/, '').replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
    };
    const nowMs = Date.now();
    for (const row of result.bindings) {
      const agent = strip(row['agent']).toLowerCase();
      const peer = strip(row['peer']);
      if (!agent || !peer) continue;
      const expiresStr = strip(row['expiresAt']);
      if (expiresStr) {
        const expiresAt = Number(expiresStr);
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowMs) continue;
      }
      const list = out.get(agent) ?? [];
      if (!list.includes(peer)) list.push(peer);
      out.set(agent, list);
    }
    return out;
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
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent ?key ?expiresAt WHERE {
        GRAPH <${cgMetaGraph}> {
          ?d <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?agent ;
             <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}> ?key .
          OPTIONAL { ?d <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?expiresAt }
        }
      }`,
      { signal: options.signal },
    );
    const out = new Map<string, string[]>();
    if (result.type !== 'bindings') return out;
    const strip = (raw: unknown): string => {
      if (typeof raw !== 'string') return '';
      return raw.replace(/^"/, '').replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
    };
    const nowMs = Date.now();
    for (const row of result.bindings) {
      const agent = strip(row['agent']).toLowerCase();
      const key = strip(row['key']).toLowerCase();
      if (!agent || !key) continue;
      const expiresStr = strip(row['expiresAt']);
      if (expiresStr) {
        const expiresAt = Number(expiresStr);
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowMs) continue;
      }
      const list = out.get(agent) ?? [];
      if (!list.includes(key)) list.push(key);
      out.set(agent, list);
    }
    return out;
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
   * resolves to {@link TIMEOUT_SENTINEL} if the underlying RPC HANGS past
   * {@link CHAIN_POLICY_READ_TIMEOUT_MS}, so callers fail closed instead of
   * blocking forever. The timer is `unref`'d so a dead RPC never keeps the
   * process alive.
   */
  private raceChainPolicyRead<T>(p: Promise<T>): Promise<T | typeof TIMEOUT_SENTINEL> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), CHAIN_POLICY_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    return Promise.race([
      p.finally(() => { if (timer) clearTimeout(timer); }),
      timeout,
    ]);
  }

  /**
   * #1404 — THE canonical publish access-policy-state operation. Publish (and any
   * future caller) asks ONE question — "what is the on-chain access policy for
   * this CG?" — and this owns the WHOLE answer: it selects the correct read (the
   * raw on-chain slot for a numeric id when `rawOnChainSlot` is set, otherwise the
   * shared tri-state resolver) AND applies the bounded transient-UNKNOWN retry
   * ({@link retryTransientPolicyState}). Callers therefore can neither diverge on
   * which read to use nor forget the retry — there is no public higher-order retry
   * primitive to compose (or skip). Fail-closed is preserved end to end: a
   * confirmed 0/1/'unregistered' returns immediately; genuine unavailability stays
   * 'unknown' or re-throws on the final attempt, so the caller's try/catch fails
   * closed (never a plaintext downgrade on a guess). `backoffMs`/`attempts` are
   * injectable so tests collapse the delay.
   */
  async resolvePublishAccessPolicyState(this: DKGAgent,
    cgId: string,
    opCtx?: OperationContext,
    opts?: {
      rawOnChainSlot?: boolean;
      logLabel?: string;
      attempts?: number;
      backoffMs?: (attempt: number) => number;
    },
  ): Promise<0 | 1 | 'unregistered' | 'unknown'> {
    const read = async (): Promise<0 | 1 | 'unregistered' | 'unknown'> => {
      if (opts?.rawOnChainSlot && /^\d+$/.test(cgId.trim())) {
        const policy = await this.readLiveOnChainAccessPolicy(cgId.trim(), opCtx);
        return policy === 0 || policy === 1 ? policy : 'unknown';
      }
      return this.resolveOnChainAccessPolicyState(cgId, opCtx);
    };
    const label = opts?.logLabel ?? 'chain access-policy';
    return retryTransientPolicyState(read, {
      attempts: opts?.attempts,
      backoffMs: opts?.backoffMs,
      onRetryUnknown: opCtx
        ? (attempt, total) =>
            this.log.warn(
              opCtx,
              `${label} came back UNKNOWN (attempt ${attempt}/${total}) — retrying the on-chain read before failing closed`,
            )
        : undefined,
    });
  }

  /**
   * #884 review — LIVE-gated on-chain access-policy read for a CANDIDATE
   * numeric on-chain id. The single trust anchor shared by every "downgrade
   * to a less-protected path" decision (SWM-plaintext gate + publish-inline
   * curated probe), so both branches can never diverge.
   *
   * Returns the access-policy enum (`0` = public, `1` = private/curated) ONLY
   * after {@link ChainAdapter.isContextGraphActiveOnChain} proves the slot is
   * actually live on-chain; otherwise returns `null` (= UNKNOWN, caller fails
   * closed). This is essential because `getContextGraphAccessPolicy` returns
   * Solidity's default `0` (= public) for UNKNOWN ids, and the local
   * access-policy cache can be seeded by best-effort probes of arbitrary ids —
   * so neither is trustworthy without a liveness proof. Both the liveness and
   * the policy reads are bounded by {@link raceChainPolicyRead} so a hung RPC
   * fails closed (`null`) instead of blocking the hot path. A genuine RPC
   * rejection propagates to the caller (which logs + fails closed in its own
   * idiom). `null` is returned when: the id is non-numeric/≤0, no liveness
   * probe is implemented, the slot is not live, a read times out, or the
   * policy getter is missing / returns an out-of-range value.
   */
  async readLiveOnChainAccessPolicy(this: DKGAgent,
    onChainId: string,
    opCtx?: OperationContext,
  ): Promise<0 | 1 | null> {
    let numericId: bigint;
    try {
      numericId = BigInt(onChainId);
    } catch {
      return null;
    }
    if (numericId <= 0n) return null;

    if (typeof this.chain.isContextGraphActiveOnChain !== 'function') {
      // #884 review (🔴 GZEqN): don't strand public CGs SILENTLY. An adapter
      // that exposes getContextGraphAccessPolicy but NOT the liveness probe
      // can't prove a slot live, so we fail closed (encrypted) — but emit a
      // one-shot loud diagnostic so operators/integrators get a runtime signal
      // that on-chain-public detection is disabled for this adapter, instead
      // of silently keeping every public CG on the encrypted path. (The
      // interface documents this fail-closed-on-absence contract; we can't
      // make the probe a hard type-level requirement without breaking the many
      // minimal publish-only ChainAdapter implementations.)
      if (typeof this.chain.getContextGraphAccessPolicy === 'function' && !this.warnedMissingCgLivenessProbe) {
        this.warnedMissingCgLivenessProbe = true;
        this.log.warn(
          opCtx ?? createOperationContext('share'),
          `Chain adapter implements getContextGraphAccessPolicy but not isContextGraphActiveOnChain — ` +
          `cannot PROVE on-chain context-graph liveness, so public-on-chain CGs will be kept on the ` +
          `ENCRYPTED SWM path (fail-closed). Implement isContextGraphActiveOnChain to enable ` +
          `public-CG plaintext detection.`,
        );
      }
      return null;
    }
    const live = await this.raceChainPolicyRead(
      this.chain.isContextGraphActiveOnChain(numericId),
    );
    if (live === TIMEOUT_SENTINEL) {
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `readLiveOnChainAccessPolicy(${onChainId}): isContextGraphActiveOnChain timed out after ` +
        `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — treating on-chain access policy as UNKNOWN (fail-closed)`,
      );
      return null;
    }
    if (live !== true) return null;

    // #884 review (🔴 GZEqI): the slot is LIVE, but DO NOT trust the
    // onChainAccessPolicyCache for this security-downgrade decision. The cache
    // is keyed by numeric on-chain id with no chain/deployment epoch, so after
    // a devnet reset or numeric-id reuse a value cached as public (`0`) on the
    // OLD chain would survive and force a NEW, possibly-private CG that now
    // occupies the same slot onto the plaintext path. Always read the access
    // policy FRESH from chain here (one bounded eth_call — correctness over a
    // saved RPC). The cache is still WRITTEN below (a fresh, live-verified
    // value is strictly an improvement for the other, decrypt-gated readers).
    const getAccessPolicy = this.chain.getContextGraphAccessPolicy;
    if (typeof getAccessPolicy !== 'function') return null;
    const policy = await this.raceChainPolicyRead(
      getAccessPolicy.call(this.chain, numericId),
    );
    if (policy === TIMEOUT_SENTINEL) {
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `readLiveOnChainAccessPolicy(${onChainId}): getContextGraphAccessPolicy timed out after ` +
        `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — treating on-chain access policy as UNKNOWN (fail-closed)`,
      );
      return null;
    }
    if (policy === 0 || policy === 1) {
      this.onChainAccessPolicyCache.set(onChainId, policy);
      return policy;
    }
    return null;
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
      return (await this.resolveOnChainAccessPolicyState(contextGraphId, opCtx)) === 0;
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
  ): Promise<0 | 1 | 'unregistered' | 'unknown'> {
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
    if (resolvedFromLocalCg && !(await this.localCgMatchesOnChainSlot(contextGraphId, onChainId, opCtx))) {
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
   * Returns `false` (→ caller fails closed) on an AFFIRMATIVE mismatch (the
   * committed hash matches neither derivation); whenever the hash cannot be
   * verified once the adapter EXPOSES `getContextGraphNameHash` (RPC rejection or
   * read timeout — #884 review 🔴 GZ8L_); AND when the slot has NO committed
   * name-hash at all (`null` / empty — #884 review 🔴 GaZk2). A missing
   * commitment is NOT an identity proof: a devnet-reset slot reused by a
   * different no-commitment public CG would otherwise disable encryption for the
   * wrong local graph, so a downgrade decision requires an affirmative binding.
   * Returns `true` (proceed to the liveness/policy gate) where the adapter
   * cannot supply the anchor at all (no `getContextGraphNameHash` getter), AND
   * for a DIRECT NUMERIC SELF-ADDRESS — a local id that IS its own numeric
   * on-chain slot (`onChainId === id`, e.g. a CG mirroring a raw slot created
   * via the low-level `createOnChainContextGraph` path). The latter is the
   * caller naming the slot directly, not a cleartext→numeric remapping, so it is
   * treated like the bare-numeric raw-slot path (not identity-bound) and gated
   * by liveness + fresh policy alone.
   */
  async localCgMatchesOnChainSlot(this: DKGAgent,
    contextGraphId: string,
    onChainId: string,
    opCtx?: OperationContext,
  ): Promise<boolean> {
    const getNameHash = this.chain.getContextGraphNameHash;
    if (typeof getNameHash !== 'function') return true;
    let numericId: bigint;
    try {
      numericId = BigInt(onChainId);
    } catch {
      return true;
    }
    if (numericId <= 0n) return true;

    const trimmed = contextGraphId.trim();
    // DIRECT NUMERIC SELF-ADDRESS: a local CG whose own id IS its numeric
    // on-chain slot (`getContextGraphOnChainId('42') === '42'` — e.g. a CG
    // created to mirror a raw slot via the low-level createOnChainContextGraph
    // path, whose local id is the numeric id itself) is NOT a cleartext→numeric
    // indirection. It is the caller naming the slot directly, identical to the
    // bare-numeric raw-slot path which is intentionally NOT identity-bound
    // (#884 review GZEqF test). There is no separate committed cleartext name to
    // bind against here (any curator name-hash is unrelated to the numeric id),
    // so name-hash binding is inapplicable — defer to the liveness + fresh-policy
    // gate. The stale-mapping risk the name-hash defends against (#884 review
    // 🔴 GaZk2) only exists for a cleartext id that REMAPS to a different slot.
    if (/^\d+$/.test(trimmed) && trimmed === onChainId.trim()) return true;
    // A locally-resolved (cleartext) id can be committed two ways, and both are
    // legitimate (#884 review 🔴 GZumc + 🔴 GaJf_), so accept a match against EITHER:
    //   - CLEARTEXT (always): a curator-created CG stores its cleartext id (even
    //     one that happens to look like a 0x+64-hex string), and registration
    //     commits keccak256(utf8(cleartextId)). → keccak(utf8(trimmed)).
    //   - WIRE-FORM (conditional): a host-only/core subscription is keyed by the
    //     wire id ITSELF (cleartext never left the curator), so the local id
    //     already IS the committed nameHash. → trimmed verbatim.
    // The WIRE-FORM branch is only added when LOCAL metadata AFFIRMATIVELY proves
    // this subscription is wire-id keyed (#884 review 🔴 GaZky). Accepting the
    // verbatim value for EVERY 0x+64-hex id would make the gate ambiguous between
    // a real host-mode wire id and a user-chosen cleartext id that merely looks
    // hash-shaped — a reused/unrelated slot whose committed nameHash equalled
    // that raw string would then falsely pass. A genuinely reused slot commits a
    // DIFFERENT name that matches NEITHER accepted form, so this still fails
    // closed on a true stale mapping while never forcing a wire-keyed host CG
    // down the fail-closed path forever.
    const acceptable = new Set<string>();
    try {
      acceptable.add(ethers.keccak256(ethers.toUtf8Bytes(trimmed)).toLowerCase());
    } catch {
      return true;
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(trimmed) && this.isWireIdKeyedSubscription(trimmed)) {
      acceptable.add(trimmed.toLowerCase());
    }

    let onChainHash: string | null | typeof TIMEOUT_SENTINEL;
    try {
      onChainHash = await this.raceChainPolicyRead(getNameHash.call(this.chain, numericId));
    } catch (err) {
      // #884 review (🔴 GZ8L_): the adapter EXPOSES the name-hash getter (we
      // passed the typeof check above), so an RPC REJECTION means we cannot
      // VERIFY that the persisted local mapping still points at THIS CG. Fail
      // closed — a transient flake must not re-enable the plaintext downgrade
      // for a possibly devnet-reset / reused slot. (Fail-open is reserved for
      // the explicit opt-out `null` below, where there is no commitment to
      // check.)
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) failed — ` +
        `cannot verify local-mapping identity, treating CG as NOT public (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    if (onChainHash === TIMEOUT_SENTINEL) {
      // Same as a rejection: the getter exists but the hash couldn't be read in
      // time, so the mapping identity is UNVERIFIED → fail closed.
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphPublicOnChain(${contextGraphId}): getContextGraphNameHash(${onChainId}) timed out after ` +
        `${CHAIN_POLICY_READ_TIMEOUT_MS}ms — cannot verify local-mapping identity, treating CG as NOT public (fail-closed)`,
      );
      return false;
    }
    // MISSING commitment (`null` / empty): the slot has NO on-chain name-hash.
    // This is NOT an affirmative identity proof and must NOT re-enable the
    // plaintext downgrade (#884 review 🔴 GaZk2). After a devnet reset the
    // persisted `localId → onChainId` mapping can point at a DIFFERENT public CG
    // that ALSO never committed a name-hash; trusting `null` would then disable
    // SWM encryption for the WRONG local graph. A downgrade (encrypt→plaintext)
    // decision requires an AFFIRMATIVE binding, so a missing commitment fails
    // closed. (Fail-open is reserved for the no-getter case above, where the
    // adapter cannot supply the anchor at all — distinct from a present getter
    // returning "no commitment".)
    if (!onChainHash) {
      this.log.warn(
        opCtx ?? createOperationContext('share'),
        `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} has NO ` +
        `committed name-hash — cannot affirmatively bind identity (slot reused on a fresh chain?). ` +
        `Treating CG as NOT public (fail-closed).`,
      );
      return false;
    }
    if (acceptable.has(onChainHash.toLowerCase())) return true;

    this.log.warn(
      opCtx ?? createOperationContext('share'),
      `isContextGraphPublicOnChain(${contextGraphId}): locally-mapped on-chain id ${onChainId} commits ` +
      `name-hash ${onChainHash.toLowerCase()} ≠ this CG's expected wire id(s) ${[...acceptable].join(' | ')} — ` +
      `local mapping is STALE (slot reused on a fresh chain?). Treating CG as NOT public (fail-closed).`,
    );
    return false;
  }

  /**
   * #884 review (🔴 GaZky) — AFFIRMATIVE proof that a 0x+64-hex local CG id is a
   * host-only/core subscription keyed by the WIRE id (the committed name-hash)
   * rather than a user-chosen cleartext id that merely looks hash-shaped.
   *
   * Host-only auto-subscribe paths (chain-event + discovery-beacon) stage the
   * wire id AS the local id and record `onChainHash === id` (and the reverse
   * index `wireIdToLocalCgId[id] === id`). Only that self-referential local
   * commitment licenses {@link localCgMatchesOnChainSlot} to accept the verbatim
   * id against the on-chain name-hash; without it the id is treated as cleartext
   * and must match `keccak256(utf8(id))`, so a reused slot cannot impersonate a
   * wire-keyed CG just by sharing a hash-shaped string.
   */
  isWireIdKeyedSubscription(this: DKGAgent, localId: string): boolean {
    if (!/^0x[0-9a-fA-F]{64}$/.test(localId)) return false;
    const lower = localId.toLowerCase();
    const sub =
      this.subscribedContextGraphs?.get(localId) ?? this.subscribedContextGraphs?.get(lower);
    if (sub?.onChainHash && sub.onChainHash.toLowerCase() === lower) return true;
    const reverse = this.wireIdToLocalCgId?.get(lower);
    return !!reverse && reverse.toLowerCase() === lower;
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
   * Gate BEFORE delegating to the store resolver: a public CG takes the
   * plaintext path without resolving recipient keys at all. This also
   * avoids the resolver's "Missing public encryption key" throw for an
   * allowlisted agent whose key isn't locally available — irrelevant for
   * a public CG that never encrypts. Curated / invite-only / unknown CGs
   * fall through to the normal (encrypted) recipient resolution.
   */
  async resolveWorkspaceRecipientsGated(this: DKGAgent,
    input: WorkspaceAgentRecipientResolverInput,
  ): Promise<WorkspaceAgentRecipientResolution> {
    if (await this.isContextGraphPublicOnChain(input.contextGraphId, createOperationContext('share'))) {
      return { requiresEncryption: false, recipients: [] };
    }
    // #884 review (🔴): do NOT add a local-metadata fallback here (e.g.
    // honoring a local `accessPolicy="public"` triple). A local policy literal
    // is intent, not authoritative on-chain state — a pre-registration graph
    // or a stale local graph after a devnet reset would then bypass SWM
    // encryption purely from local metadata and leak allowlisted traffic in
    // plaintext. When the on-chain probe above cannot establish that the CG is
    // a LIVE public slot (unknown / not live / RPC flake), fail closed: keep
    // the encrypted path. A genuinely-public CG resolves correctly through
    // isContextGraphPublicOnChain's live proof; a transient RPC flake yields a
    // transient encrypted-path retry, never a plaintext leak.
    return resolveWorkspaceAgentRecipients(this.store, input);
  }

  async encryptWorkspacePayloadWithSenderKey(this: DKGAgent,
    input: WorkspaceSenderKeyEncryptInput,
  ): Promise<Uint8Array> {
    await this.loadSwmSenderKeyState();
    const ctx = createOperationContext('share', input.operationId);
    const sender = this.getLocalSigningAgentForAddress(input.senderAgentAddress);
    if (!sender) {
      throw new Error(`Cannot create SWM Sender Key epoch: no local custodial signing key for agent ${input.senderAgentAddress}`);
    }

    const resolution = await resolveWorkspaceAgentRecipients(this.store, { contextGraphId: input.contextGraphId });
    if (!resolution.requiresEncryption) {
      return input.plaintext;
    }
    if (resolution.recipients.length === 0) {
      throw new Error(`Context graph "${input.contextGraphId}" requires Sender Key SWM but has no DKG agent recipients`);
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
    const stateKey = swmSenderStateKey(input.contextGraphId, input.subGraphName, senderAddress);
    let state = this.swmSenderKeySendStates.get(stateKey);
    if (!state || state.membershipHash !== membershipHash) {
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
      await this.drainPendingSenderKeyForRecipients(resolution.recipients, ctx);
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

        if (this.hasLocalAgent(recipientAgentAddress)) {
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
            `queued (no advertised peerId) — will deliver when recipient connects`,
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
   * to queue it). Older epochs for the same `(sender, recipient)` pair
   * are evicted — a newer epoch supersedes them by definition.
   *
   * Per-key dedup: `(senderAgentAddress, recipientKeyId, epochId)`
   * matches an existing row, we replace it (idempotent re-enqueue).
   */
  enqueuePendingSenderKey(this: DKGAgent, entry: PendingSenderKeyEntry): void {
    const recipientKey = entry.recipientAgentAddress.toLowerCase();
    const existing = this.pendingSenderKeyByAgent.get(recipientKey) ?? [];
    // Drop older epochs for the same (sender, recipient) pair; the newer
    // epoch's membership-hash supersedes them. Keep entries for OTHER
    // senders / recipients unchanged.
    const filtered = existing.filter((e) => {
      if (e.senderAgentAddress !== entry.senderAgentAddress) return true;
      if (e.epochId === entry.epochId) {
        // Same epoch: dedupe by recipientKeyId — caller may re-enqueue
        // on retry. Replace by dropping the old slot; the new one is
        // appended below.
        return e.recipientKeyId !== entry.recipientKeyId;
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
    peerId: string;
    recipientAgentAddress: string;
    ctx?: OperationContext;
  }): Promise<number> {
    const recipientAgentAddress = input.recipientAgentAddress.toLowerCase();
    const existingDrain = this.pendingSenderKeyDrainByAgent.get(recipientAgentAddress);
    if (existingDrain) {
      await existingDrain;
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) return 0;
      return this.drainPendingSenderKeyQueueForPeer(input);
    }
    const drain = this.drainPendingSenderKeyQueueForPeerLocked({
      peerId: input.peerId,
      recipientAgentAddress,
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
    peerId: string;
    recipientAgentAddress: string;
    ctx?: OperationContext;
  }): Promise<number> {
    const recipientAgentAddress = input.recipientAgentAddress;
    const queue = this.pendingSenderKeyByAgent.get(recipientAgentAddress);
    if (!queue || queue.length === 0) return 0;

    let drained = 0;
    const remaining: PendingSenderKeyEntry[] = [];
    for (let i = 0; i < queue.length; i += 1) {
      const entry = queue[i];
      try {
        const sendResult = await this.messenger.sendReliable(
          input.peerId,
          PROTOCOL_SWM_SENDER_KEY,
          entry.packageBytes,
          { messageId: this.swmSenderKeyPendingMessageId(entry) },
        );
        if (!sendResult.delivered) {
          if (sendResult.queued || ('inFlight' in sendResult && sendResult.inFlight)) {
            remaining.push(entry);
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
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (
          ack.version !== SWM_SENDER_KEY_PACKAGE_VERSION ||
          ack.type !== SWM_SENDER_KEY_PACKAGE_ACK_TYPE
        ) {
          // Malformed/legacy ACK: no positive acceptance yet. Keep the
          // row queued so a mixed-version rollout cannot strand the recipient.
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
          continue;
        }
        if (ack.accepted) {
          drained += 1;
        } else if (this.isRetryableSwmSenderKeySetupAckReason(ack.reasonCode)) {
          remaining.push(this.rotateSwmSenderKeyPendingMessageId(entry));
        } else {
          const reason = ack.reason ?? 'unknown reason';
          const reasonCode = ack.reasonCode ?? 'legacy-unknown';
          this.log.warn(
            input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
            `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
            `peerId=${input.peerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
            `dropped after terminal rejection (${reasonCode}): ${reason}`,
          );
          // Terminal rejection: keep it out of the queue, but do not
          // report it as a successful drain.
        }
      } catch (err) {
        remaining.push(...queue.slice(i));
        if (remaining.length === 0) {
          this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
        } else {
          this.pendingSenderKeyByAgent.set(recipientAgentAddress, remaining);
        }
        await this.saveSwmSenderKeyState();
        const message = err instanceof Error ? err.message : String(err);
        this.log.warn(
          input.ctx ?? SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX,
          `SWM sender-key pending retry for ${entry.recipientAgentAddress} keyId=${entry.recipientKeyId} ` +
          `peerId=${input.peerId} contextGraph=${entry.contextGraphId}${entry.subGraphName ? `/${entry.subGraphName}` : ''} ` +
          `failed before the Messenger substrate queued a retry: ${message}`,
        );
        throw err;
      }
    }

    if (remaining.length === 0) {
      this.pendingSenderKeyByAgent.delete(recipientAgentAddress);
    } else {
      this.pendingSenderKeyByAgent.set(recipientAgentAddress, remaining);
    }
    await this.saveSwmSenderKeyState();
    return drained;
  }

  /**
   * Drain queued sender-key packages whose recipient agent is one of
   * the agent addresses advertised by `peerId`. Returns the number of
   * rows successfully delivered (acked) and removed.
   *
   * Fired from the `connection:open` listener — see line 2382 — so the
   * cost lives on the cold path of "we just connected to a new peer",
   * not on every share. Each successful `sendReliable` with
   * `delivered=true && ack.accepted=true` deletes the row and counts as
   * drained; soft (`delivered=false`) and explicitly retryable delivered
   * rejections leave it queued for the next attempt; terminal delivered
   * rejections are logged and deleted without counting as drained.
   */
  public async drainPendingSenderKeyForPeer(this: DKGAgent, peerId: string, ctx?: OperationContext): Promise<number> {
    await this.loadSwmSenderKeyState();
    if (this.pendingSenderKeyByAgent.size === 0) return 0;
    let drained = 0;
    let agentAddresses: string[] = [];
    try {
      const profile = await this.discovery.findAgentByPeerId(peerId);
      if (profile?.agentAddress) {
        agentAddresses = [profile.agentAddress.toLowerCase()];
      }
    } catch {
      // Resolution failure is benign — we'll try again on the next
      // connection:open burst. Don't propagate.
    }
    if (agentAddresses.length === 0) return 0;

    for (const recipientAgentAddress of agentAddresses) {
      drained += await this.drainPendingSenderKeyQueueForPeer({ peerId, recipientAgentAddress, ctx });
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
    ctx?: OperationContext,
  ): Promise<number> {
    if (this.pendingSenderKeyByAgent.size === 0) return 0;

    const peerByAgent = new Map<string, string>();
    for (const recipient of recipients) {
      if (!recipient.peerId) continue;
      const recipientAgentAddress = recipient.agentAddress.toLowerCase();
      if (!this.pendingSenderKeyByAgent.has(recipientAgentAddress)) continue;
      if (!peerByAgent.has(recipientAgentAddress)) {
        peerByAgent.set(recipientAgentAddress, recipient.peerId);
      }
    }
    if (peerByAgent.size === 0) return 0;

    let drained = 0;
    for (const [recipientAgentAddress, peerId] of peerByAgent.entries()) {
      drained += await this.drainPendingSenderKeyQueueForPeer({ peerId, recipientAgentAddress, ctx });
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
        reasonCode: this.swmSenderKeySetupAckReasonCode(err),
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

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(pkg.contextGraphId);
    if (!agentGateAddresses) {
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
    if (message.contextGraphId !== contextGraphId) {
      throw new Error(`Sender Key message contextGraphId "${message.contextGraphId}" does not match envelope "${contextGraphId}"`);
    }
    const senderAgentAddress = ethers.getAddress(message.senderAgentAddress);
    const state = this.swmSenderKeyReceiveStates.get(
      swmReceiverStateKey(contextGraphId, message.subGraphName, senderAgentAddress, message.epochId),
    );
    if (!state) {
      this.log.warn(
        ctx,
        `SWM sender-key broadcast receive denied: reason=no-state senderAgent=${senderAgentAddress} ` +
        `contextGraph=${contextGraphId}${message.subGraphName ? `/${message.subGraphName}` : ''} ` +
        `epoch=${message.epochId} messageIndex=${uint64ForProto(message.messageIndex)} membershipHash=${message.membershipHash}`,
      );
      throw new Error(`No local Sender Key state for ${senderAgentAddress} epoch ${message.epochId}`);
    }
    if (state.membershipHash !== message.membershipHash) {
      throw new Error(`Sender Key membership hash mismatch for ${senderAgentAddress} epoch ${message.epochId}`);
    }

    const messageIndex = uint64ForProto(message.messageIndex);
    let chainKey = state.skippedChainKeys.get(messageIndex);
    let usedSkippedKey = false;
    if (chainKey) {
      usedSkippedKey = true;
      state.skippedChainKeys.delete(messageIndex);
    } else {
      if (messageIndex < state.nextMessageIndex) {
        throw new Error(`Sender Key replay rejected for index ${messageIndex}`);
      }
      const gap = messageIndex - state.nextMessageIndex;
      if (gap > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
        throw new Error(`Sender Key message gap ${gap} exceeds skipped-message cache limit`);
      }
      chainKey = state.chainKey;
      for (let index = state.nextMessageIndex; index < messageIndex; index++) {
        state.skippedChainKeys.set(index, chainKey);
        chainKey = ratchetSwmSenderChainKey(chainKey);
      }
    }

    const decrypted = await decryptSwmSenderKeyMessage({
      chainKey,
      message,
      senderSigningPublicKey: state.senderSigningPublicKey,
    });

    if (!usedSkippedKey) {
      state.chainKey = decrypted.nextChainKey;
      state.nextMessageIndex = messageIndex + 1;
    }
    while (state.skippedChainKeys.size > SWM_SENDER_KEY_SKIPPED_MESSAGE_CACHE_LIMIT) {
      const oldest = [...state.skippedChainKeys.keys()].sort((a, b) => a - b)[0];
      state.skippedChainKeys.delete(oldest);
    }
    await this.saveSwmSenderKeyState();

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
    const { mkdir, writeFile, chmod } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
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
  }

  async resolveWorkspaceGossipSigningAgent(this: DKGAgent,
    contextGraphId: string,
  ): Promise<(AgentKeyRecord & { privateKey: string }) | null> {
    const allowedAgents = await this.getContextGraphAgentGateAddresses(contextGraphId);
    if (!allowedAgents) {
      return this.getWorkspaceGossipSigningAgent();
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
