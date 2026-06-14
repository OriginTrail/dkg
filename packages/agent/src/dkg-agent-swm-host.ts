// SPDX-License-Identifier: Apache-2.0

/**
 * SWM host-mode subsystem extracted from dkg-agent.ts as a mixin holder:
 * host-mode store init/reconcile/wire, envelope + ciphertext-chunk ingest,
 * host-catchup + get-chunk request handlers, chain-ordinal VM reconcile, and
 * the catchup/enable/stats entrypoints. Bodies are a 1:1 move; methods take
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
  Logger, createOperationContext, sparqlString, isSafeIri, assertSafeIri,
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
            this.wireSwmHostModeHandler(cgId);
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
    if (this.swmHostModeSubscribed.has(this.canonicalSwmHostModeKey(contextGraphId))) {
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
    // three return "not curated", we bail (same as before).
    let curated = false;
    const sub = this.subscribedContextGraphs.get(contextGraphId);
    if (sub?.onChainHash) {
      curated = true;
    } else if (sub?.onChainId && this.onChainAccessPolicyCache.get(sub.onChainId) === 1) {
      curated = true;
    } else {
      try {
        curated = await this.isPrivateContextGraph(contextGraphId);
      } catch {
        return;
      }
    }
    if (!curated) return;

    this.wireSwmHostModeHandler(contextGraphId, source);
    await this.awaitHostModePersistence(contextGraphId);

    await this.maybeMarkRegisteredForHostMode(contextGraphId);

    this.log.info(
      createOperationContext('system'),
      `SWM host-mode subscription enabled for "${contextGraphId}" (role=core)`,
    );
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
    this.gossip.subscribe(swmTopic);
    const handler = (_topic: string, data: Uint8Array, from: string) => {
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
   * every locally-known CG and ensures host-mode subscription is
   * in sync. Cheap to call repeatedly because the per-CG
   * reconciler is idempotent.
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
        const knownCgs = await graphManager.listContextGraphs();
        for (const cgId of knownCgs) {
          await this.reconcileSwmHostModeSubscription(cgId);
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
      this.recordCgWireId(storageCgId, subscriptionWireId);
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
    if (!isCiphertext) return;

    // Authority check: verify the envelope signature against the
    // curated CG's agent allowlist. Without this, a topic-reachable
    // peer can fill per-CG storage with valid-looking ciphertext
    // and evict legitimate history.
    //
    // Use `storageCgId` (cleartext from the envelope) so the
    // member-side meta-graph + chain-fallback resolvers in
    // `verifyHostModeEnvelopeAuthority` work on the canonical id
    // shape. The hash subscription key is internal bookkeeping;
    // never crosses an external authorization boundary.
    const handler = this.getOrCreateSharedMemoryHandler();
    const verdict = await handler.verifyHostModeEnvelopeAuthority(data, storageCgId, fromPeerId);
    if (!verdict.accepted) {
      // "no agent allowlist" is the expected outcome during the brief
      // chain-event race window (cores see the beacon, auto-engage
      // host-mode, then receive ciphertext BEFORE the
      // `ContextGraphCreated` event lands AND before the curator
      // beacon arrived). The beaconCuratorOracle fallback closes
      // most of that window; the remaining race (envelope arrives
      // before the beacon is received & verified) is recoverable
      // via member catchup and should not spam WARN logs in steady-
      // state operation. Other rejection reasons (sig mismatch, peer
      // not in allowlist, decode failure) remain WARN — those are
      // real authority failures that operators need to see.
      const isTransientRace = verdict.reason === 'no agent allowlist on context graph';
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

    // Stage the synthetic subscription record + wire-id reverse
    // mapping — same as the chain-event auto-subscribe path. The
    // hash IS the local id for cores that didn't create or join
    // the CG, so `recordCgWireId(wireId, wireId)` is the right
    // identity-translation entry.
    if (!this.subscribedContextGraphs.has(wireId)) {
      this.subscribedContextGraphs.set(wireId, {
        subscribed: false,
        synced: false,
        onChainHash: wireId,
        pendingMeta: true,
      });
    } else {
      const existing = this.subscribedContextGraphs.get(wireId)!;
      existing.onChainHash = wireId;
    }
    this.recordCgWireId(wireId, wireId);

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
      result = await this.store.query(sparql);
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
  bindSubscriptionOnChainId(this: DKGAgent, localCgId: string, sub: ContextGraphSub, newOnChainId: string): void {
    const prev = sub.onChainId;
    sub.onChainId = newOnChainId;
    if (!prev || prev === newOnChainId) return;
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
        `VM reconcile: on-chain id for "${localCgId}" changed ${prev}->${newOnChainId}; reset reconcile watermark + cursor to 0`,
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
      return await readAccessPolicy(false);
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
    if (!this.vmReconcileEnabled()) return;
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
      next = { subscribed: false, synced: false, onChainId: numericStr, coreHosted: true };
    }
    this.setContextGraphSubscription(localCgId, next);
    this.log.info(
      createOperationContext('system'),
      `Phase D: marked public cg=${numericStr} as core-hosted (will chain-reconcile to VM across restarts)`,
    );
    // Nudge a reconcile now so the first hosted publish lands promptly; the
    // periodic sweep is the safety net.
    if (this.reconcileCoalescer) void this.reconcileCoalescer.trigger(localCgId);
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
   * single-flighted by {@link reconcileCoalescer} so overlapping ticks (or a
   * burst of live nudges) collapse into one sweep per CG.
   */
  async runVmReconcileSweep(this: DKGAgent): Promise<void> {
    if (!this.vmReconcileEnabled() || !this.reconcileCoalescer) return;
    for (const [localCgId, sub] of this.subscribedContextGraphs) {
      // Member subscriptions AND Phase D core-hosted public CGs get swept.
      if ((!sub.subscribed && !sub.coreHosted) || !sub.onChainId) continue;
      void this.reconcileCoalescer.trigger(localCgId);
    }
  }

  /**
   * One reconcile pass for a single CG: build the injected deps and hand off to
   * the pure {@link reconcileContextGraph} orchestrator (which owns the cursor
   * math + watermark persistence gate). The cursor is created lazily from the
   * persisted `lastReconciledOrdinal` and lives in {@link reconcileCursors}.
   */
  async runVmReconcileForCg(this: DKGAgent, localCgId: string): Promise<void> {
    const sub = this.subscribedContextGraphs.get(localCgId);
    if ((!sub?.subscribed && !sub?.coreHosted) || !sub.onChainId || !this.vmReconcileEnabled()) return;
    const onChainCgId = BigInt(sub.onChainId);

    let cursor = this.reconcileCursors.get(localCgId);
    if (!cursor) {
      cursor = createCursorState(sub.lastReconciledOrdinal ?? 0);
      this.reconcileCursors.set(localCgId, cursor);
    }

    const deps: ChainReconcilerDeps = {
      getKCCount: async (cg) => Number(await this.chain.getContextGraphKCCount!(cg)),
      getHeadBlock: async () => {
        // Capability-absent chains return undefined and disable the reorg gate;
        // transient RPC failures must throw so the reconciler holds the
        // watermark instead of advancing on an unobserved head.
        if (typeof this.chain.getBlockNumber !== 'function') return undefined;
        return await this.chain.getBlockNumber();
      },
      reconcileOrdinal: (lcg, ocg, ordinal, headBlock) =>
        this.reconcileChainOrdinal(lcg, ocg, ordinal, headBlock),
      persistWatermark: (lcg, watermark) => {
        const s = this.subscribedContextGraphs.get(lcg);
        if (!s) return;
        const previous = s.lastReconciledOrdinal ?? 0;
        s.lastReconciledOrdinal = watermark;
        this.persistContextGraphSubscription(lcg);
        this.emitReplication({
          contextGraphId: lcg,
          onChainCgId: s.onChainId,
          action: 'cursor-advance',
          fromWatermark: previous,
          toWatermark: watermark,
        });
      },
      confirmationDepth: DKGAgentBase.VM_RECONCILE_CONFIRMATION_DEPTH,
      log: (msg) => this.log.info(createOperationContext('system'), msg),
    };

    try {
      const result = await reconcileContextGraph(deps, cursor, localCgId, onChainCgId);
      if (result.reconciled > 0 || result.pending > 0) {
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: sub.onChainId,
          action: 'sweep',
          head: result.head,
          toWatermark: result.watermark,
          reconciled: result.reconciled,
          pending: result.pending,
        });
      }
      // Phase D — a host-only (non-member) reconcile that actually promoted KAs
      // is a Core filling its own gap. Distinct telemetry so operators can see
      // the Core-to-Core fill path working (success-criteria metric).
      if (result.reconciled > 0 && sub.coreHosted && !sub.subscribed) {
        this.emitReplication({
          contextGraphId: localCgId,
          onChainCgId: sub.onChainId,
          action: 'core-fill',
          head: result.head,
          toWatermark: result.watermark,
          reconciled: result.reconciled,
        });
      }
    } catch (err) {
      this.log.warn(
        createOperationContext('system'),
        `VM reconcile for "${localCgId}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
      const parts: string[] = [];
      const digestRows = (rows: string[]) =>
        createHash('sha256').update(rows.join('\n'), 'utf8').digest('hex');
      const maxRows = DKGAgentBase.VM_RECONCILE_SWM_GEN_FINGERPRINT_MAX_ROWS;
      const isTooLarge = (rows: unknown[]) => rows.length > maxRows;
      for (const namespace of candidateNamespaces) {
        const metaGraph = assertSafeIri(namespace.metaGraph);
        const dataGraph = assertSafeIri(namespace.dataGraph);
        const operationRows = await this.store.query(`SELECT ?op ?root ?ts WHERE {
          GRAPH <${metaGraph}> {
            ?op <http://dkg.io/ontology/rootEntity> ?root .
            OPTIONAL { ?op <http://dkg.io/ontology/publishedAt> ?ts . }
          }
        } ORDER BY ?op ?root ?ts LIMIT ${maxRows + 1}`);
        if (operationRows.type !== 'bindings') return null;
        if (isTooLarge(operationRows.bindings)) return null;
        const operations = operationRows.bindings
          .map((row) => [
            String(row['op'] ?? ''),
            String(row['root'] ?? ''),
            String(row['ts'] ?? ''),
          ].join('\0'))
          .sort();

        const dataRows = await this.store.query(`SELECT ?s ?p ?o WHERE {
          GRAPH <${dataGraph}> { ?s ?p ?o . }
        } ORDER BY ?s ?p ?o LIMIT ${maxRows + 1}`);
        if (dataRows.type !== 'bindings') return null;
        if (isTooLarge(dataRows.bindings)) return null;
        const dataTriples = dataRows.bindings
          .map((row) => [
            String(row['s'] ?? ''),
            String(row['p'] ?? ''),
            String(row['o'] ?? ''),
          ].join('\0'))
          .sort();

        const privateRootRows = await this.store.query(`SELECT ?privateEntity ?privateRoot WHERE {
          GRAPH <${metaGraph}> { ?privateEntity <http://dkg.io/ontology/privateMerkleRoot> ?privateRoot . }
        } ORDER BY ?privateEntity ?privateRoot LIMIT ${maxRows + 1}`);
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
    if (!existing) return;
    this.vmReconcileNegativeCache.delete(cacheKey);
    const keys = this.vmReconcileNegativeCacheKeysByCg.get(existing.localCgId);
    if (!keys) return;
    keys.delete(cacheKey);
    if (keys.size === 0) this.vmReconcileNegativeCacheKeysByCg.delete(existing.localCgId);
  }

  indexVmReconcileNegativeCacheEntry(this: DKGAgent, localCgId: string, cacheKey: string): void {
    let keys = this.vmReconcileNegativeCacheKeysByCg.get(localCgId);
    if (!keys) {
      keys = new Set<string>();
      this.vmReconcileNegativeCacheKeysByCg.set(localCgId, keys);
    }
    keys.add(cacheKey);
  }

  async shouldDeferVmReconcileByNegativeCache(this: DKGAgent,
    cacheKey: string,
    localCgId: string,
  ): Promise<boolean> {
    const cached = this.vmReconcileNegativeCache.get(cacheKey);
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
        if (!currentNamespaces.complete) return true;
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
    // Existing SWM operations can be missing payload/private-root pieces; keep
    // that retry path uncached instead of probing full data graphs here.
    if (this.vmReconcileSwmGenHasOperations(state.swmGen)) {
      return;
    }
    this.pruneVmReconcileState();
    const previous = this.vmReconcileNegativeCache.get(cacheKey);
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = Math.min(
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_MAX_MS,
      DKGAgentBase.VM_RECONCILE_NEGATIVE_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    );
    if (previous) this.deleteVmReconcileNegativeCacheEntry(cacheKey);
    this.vmReconcileNegativeCache.set(cacheKey, {
      localCgId,
      failures,
      nextRetryAt: Date.now() + backoff,
      swmGen: state.swmGen,
      candidateNamespaces: state.candidateNamespaces,
      peerTopologyKey: state.peerTopologyKey,
    });
    this.indexVmReconcileNegativeCacheEntry(localCgId, cacheKey);
    this.pruneVmReconcileState();
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
    this.reconcileCursors.delete(localCgId);
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
  ): Promise<OrdinalOutcome> {
    const ctx = createOperationContext('system');
    const versionBlock = headBlock ?? 0;
    this.pruneVmReconcileState();

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
      ual = buildKnowledgeAssetUal(this.chain.chainId, storageAddr, kaId);
      merkleRoot = await this.chain.getLatestMerkleRoot!(kaId);
      cacheKey = this.vmReconcileCacheKey(localCgId, ual, merkleRoot);

      // Recently reconciled (live-burst guard): treat as already-done so the
      // cursor advances without redoing chain reads + an SWM scan.
      if (this.recentReconciledUals.has(cacheKey)) return { status: 'already', blockNumber: versionBlock };

      if (await this.shouldDeferVmReconcileByNegativeCache(cacheKey, localCgId)) {
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
    if (outcome === 'no-swm') {
      swmState = await this.collectVmReconcileSwmCandidateState(localCgId);
      // Active fetch: pull the missing snapshot core-first (selectCatchupPeers
      // already prioritises known cores + the preferred sync peer), then retry.
      if (this.shouldRunVmReconcileActiveFetch(localCgId)) {
        activeFetchRan = true;
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'fetch', ordinal, kaId: kaId.toString(), ual,
        });
        let maxAttempts = 1;
        for (let attempt = 0; attempt < maxAttempts && outcome === 'no-swm'; attempt += 1) {
          try {
            const fetchResult = await this.syncContextGraphFromConnectedPeers(localCgId, {
              includeSharedMemory: true,
              maxPeers: 1,
              peerRotationKey: localCgId,
            });
            maxAttempts = Math.max(maxAttempts, fetchResult.connectedPeers ?? 0, this.vmReconcileConnectedPeerCount());
            if ((fetchResult.peersTried ?? 0) === 0 && (fetchResult.syncCapablePeers ?? 0) === 0) {
              continue;
            }
            if (!this.vmReconcileActiveFetchHadUsableResponse(fetchResult)) {
              continue;
            }
            activeFetchHadUsableResponse = true;
          } catch (err) {
            this.log.info(ctx, `Phase B: active fetch for "${localCgId}" (ordinal ${ordinal}) failed: ${err instanceof Error ? err.message : String(err)}`);
            maxAttempts = Math.max(maxAttempts, this.vmReconcileConnectedPeerCount());
            continue;
          }
          outcome = await fh.handleChainReconciledKC(reconcileInput, ctx);
        }
        if (outcome === 'no-swm') {
          swmState = await this.collectVmReconcileSwmCandidateState(localCgId);
        }
      } else {
        this.log.info(ctx, `Phase B: active fetch for "${localCgId}" (ordinal ${ordinal}) skipped by per-CG cooldown`);
      }
    }

    switch (outcome) {
      case 'promoted':
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'promote', ordinal, kaId: kaId.toString(), ual,
        });
        return { status: 'reconciled', blockNumber: versionBlock };
      case 'already-confirmed':
        this.pruneVmReconcileCacheKeySiblings(cacheKey);
        this.recentReconciledUals.add(cacheKey);
        this.emitReplication({
          contextGraphId: localCgId, onChainCgId: onChainCgId.toString(),
          action: 'already', ordinal, kaId: kaId.toString(), ual,
        });
        this.deleteVmReconcileNegativeCacheEntry(cacheKey);
        return { status: 'already', blockNumber: versionBlock };
      case 'stale-target':
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
    if (this.swmHostModeSubscribed.has(this.canonicalSwmHostModeKey(contextGraphId))) {
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
      await this.maybeMarkRegisteredForHostMode(contextGraphId);
      return { subscribed: false, alreadySubscribed: true, hostingEnabled: true };
    }
    this.wireSwmHostModeHandler(contextGraphId, SUBSCRIPTION_SOURCES.MANUAL);
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
