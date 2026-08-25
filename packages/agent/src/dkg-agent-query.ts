// SPDX-License-Identifier: Apache-2.0

/**
 * Query / read-path subsystem extracted from dkg-agent.ts as a mixin holder:
 * local + remote SPARQL query execution, private-graph read authorization,
 * and entity/triple lookup helpers. 1:1 move; methods take `this: DKGAgent`
 * so cross-calls resolve against the composed class.
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

export class QueryMethods extends DKGAgentBase {
  async query(this: DKGAgent,
    sparql: string,
    options?: string | {
      contextGraphId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      /** @deprecated Use includeSharedMemory */
      includeWorkspace?: boolean;
      /**
       * Opt-in for dashboard/count queries that intentionally enumerate all
       * registered public content partitions in a scoped `GRAPH ?g` scan.
       */
      includeContextGraphPartitions?: boolean;
      /**
       * Opt-in: allow the scoped query to reference the context graph's own
       * `_private` partition (excluded from the scope guard's allow-set by
       * default). Used by the EPCIS events query, whose SPARQL always names
       * `<cg>/_private`. Does not widen access for other callers.
       */
      includePrivate?: boolean;
      /** Cancel the underlying store request when the outer caller disconnects. */
      signal?: AbortSignal;
      /** Store admission lane used by the query engine. */
      priority?: import('@origintrail-official/dkg-storage').StoreWorkPriority;
      /** Store diagnostics / slow-query attribution label. */
      source?: string;
      operationCtx?: OperationContext;
      view?: GetView;
      agentAddress?: string;
      verifiedGraph?: string;
      assertionName?: string;
      subGraphName?: string;
      /**
       * EVM address of the authenticated caller, as resolved by an
       * outer layer (typically the daemon's per-request auth token).
       * When set, the agent layer enforces that `view: 'working-memory'`
       * queries can only read this caller's own WM — cross-agent reads
       * via a foreign `agentAddress` are silently denied.
       *
       * Undefined = no caller authentication context (in-process call
       * from trusted code). Backwards-compatible with callers that
       * predate A-1 — they bypass the isolation check.
       *
       * Invariant: on a `view: 'working-memory'` read, the agent layer
       * rejects (silently, with an empty-per-kind result) any
       * `agentAddress` that differs from `callerAgentAddress`. If
       * `agentAddress` is omitted, it defaults to `callerAgentAddress`
       * so an authenticated caller cannot escape isolation by omission.
       * See spec §04 / RFC-29 for the policy source.
       */
      callerAgentAddress?: string;
      /**
       * Minimum trust level for the verifiable-memory view (spec §14).
       * Values above `SelfAttested` require explicit writer-side
       * `dkg:trustLevel` metadata. Ignored for other views.
       */
      minTrust?: TrustLevel;
      /**
       * @deprecated Use `minTrust`. Legacy underscore alias preserved for
       * V10-rc SDK consumers. When both are supplied, `minTrust` wins.
       * See QueryOptions._minTrust for the deprecation policy.
       */
      _minTrust?: TrustLevel;
    },
  ) {
    const rawOpts = typeof options === 'string' ? { contextGraphId: options } : options ?? {};
    const opts = {
      ...rawOpts,
      contextGraphId: rawOpts.contextGraphId,
      includeSharedMemory: rawOpts.includeSharedMemory ?? rawOpts.includeWorkspace,
    };
    const ctx = opts.operationCtx ?? createOperationContext('query');
    const sgLabel = opts.subGraphName ? `/${opts.subGraphName}` : '';
    const viewLabel = opts.view ? ` view=${opts.view}` : '';
    this.log.info(ctx, `Query on contextGraph="${opts.contextGraphId ?? 'all'}"${sgLabel}${viewLabel} sparql="${sparql.slice(0, 80)}"`);

    // Validate the SPARQL query is read-only BEFORE any access-denied
    // fast-path. `DKGQueryEngine.query` runs this guard too, but the
    // three early returns below (canReadContextGraph deny, WM
    // isolation deny, private-CG deny) short-circuit before reaching
    // it. Without this check, a caller can send `INSERT DATA { ... }`
    // through a cross-agent WM request and get a 200 empty result
    // instead of the 400 rejection that plain queries receive —
    // effectively silently swallowing a mutation attempt. Run it
    // once here so the deny path and the engine path share the same
    // input contract.
    const readOnlyGuard = validateReadOnlySparql(sparql);
    if (!readOnlyGuard.safe) {
      throw new Error(`SPARQL rejected: ${readOnlyGuard.reason}`);
    }

    const targetsSharedMemory =
      opts.graphSuffix === '_shared_memory'
      || opts.includeSharedMemory === true
      || opts.view === 'shared-working-memory';

    // A-1: Working-Memory isolation. When the caller is authenticated
    // (an outer layer like the daemon's `/api/query` route has resolved
    // the request to a specific agent and passed `callerAgentAddress`),
    // a WM query must not be allowed to read a different agent's
    // private memory. Cross-agent WM reads are silently denied (empty
    // bindings) rather than thrown — that matches the spec-safe
    // "deny without leaking existence" semantics used elsewhere in
    // this file for private context graphs.
    //
    // When `callerAgentAddress` is undefined we assume a trusted
    // in-process caller (e.g. ChatMemoryManager running inside the
    // daemon process) and leave the legacy behaviour intact. Those
    // call sites are tracked as follow-up A-1.2 for migration to an
    // authenticated scoped handle.
    // A-1 review: `/api/query` passes the raw JSON body through, so
    // `agentAddress` / `callerAgentAddress` can arrive as any JSON type
    // (number, array, object, null). Before this guard `.toLowerCase()`
    // would throw and the daemon turned a bad request into a 500.
    //
    // A-1 follow-up review: simply coercing non-strings to `undefined`
    // meant malformed input like `{ view: 'working-memory',
    // agentAddress: 123 }` silently fell through to the
    // `this.peerId` fallback below — so a caller could land in the
    // node-default WM namespace and get a 200 with real data.
    // Reject non-string `agentAddress` / `callerAgentAddress` up
    // front and let the daemon classify the resulting error as 400.
    if (opts.agentAddress !== undefined && typeof opts.agentAddress !== 'string') {
      throw new Error(
        `query: 'agentAddress' must be a string, got ${typeof opts.agentAddress}`,
      );
    }
    if (opts.callerAgentAddress !== undefined && typeof opts.callerAgentAddress !== 'string') {
      throw new Error(
        `query: 'callerAgentAddress' must be a string, got ${typeof opts.callerAgentAddress}`,
      );
    }
    const callerAgentAddressStr = opts.callerAgentAddress;

    if (
      opts.contextGraphId
      && targetsSharedMemory
      && !(await this.canUseSharedMemoryForContextGraph(opts.contextGraphId, {
        callerAgentAddress: callerAgentAddressStr,
      }))
    ) {
      this.log.info(ctx, `Shared memory query denied for unauthorized or unconfirmed context graph "${opts.contextGraphId}"`);
      return emptyQueryResultForKind(sparql);
    }

    if (opts.contextGraphId && !(await this.canReadContextGraph(opts.contextGraphId, {
      callerAgentAddress: callerAgentAddressStr,
    }))) {
      this.log.info(ctx, `Query denied for private context graph "${opts.contextGraphId}"`);
      // A-1 follow-up review: synthetic deny must match the SPARQL form
      // so ASK / CONSTRUCT / DESCRIBE clients get `false` / empty-quads
      // instead of a SELECT-shaped `{ bindings: [] }`.
      return emptyQueryResultForKind(sparql);
    }

    // A-1 canonicalization (Codex PR #242 iter-9 re-review): the
    // node's default agent has TWO identifiers that key the same WM
    // namespace — its EVM address (`this.defaultAgentAddress`) and
    // the legacy `this.peerId`. In-repo WM callers / docs still use
    // `peerId` as `agentAddress` (e.g. `ChatMemoryManager`,
    // `packages/cli/skills/dkg-node/SKILL.md`), and the engine
    // stores WM under
    // `did:dkg:context-graph:<cg>/assertion/<agentAddress>/`, so EVM
    // and peerId hash to DIFFERENT graphs. If the isolation check
    // compared raw strings, an agent-scoped token with
    // `callerAgentAddress=<defaultAgent.evm>` querying its own WM
    // with `agentAddress=<peerId>` (or the reverse) would get a
    // silent empty deny even though both sides are the same
    // identity. Canonicalize both sides: when the default agent is
    // known, fold its `peerId` alias onto its EVM address.
    const defaultEvmLc = this.defaultAgentAddress?.toLowerCase();
    const peerIdLc = this.peerId?.toLowerCase();
    const canonicaliseWmId = (addr: string | undefined): string | undefined => {
      if (!addr) return undefined;
      const lc = addr.toLowerCase();
      if (peerIdLc && lc === peerIdLc && defaultEvmLc) return defaultEvmLc;
      return lc;
    };

    // An authenticated (agent-bound) /api/query call could previously
    // OMIT `agentAddress` and fall through to the `this.peerId`
    // fallback at the engine call below, reading the node-default WM
    // namespace instead of the caller's own. Default an omitted
    // `agentAddress` to `callerAgentAddress` on working-memory reads
    // so an agent-bound caller cannot escape its own WM by just not
    // supplying the field.
    //
    // Legacy preservation (Codex iter-9 re-review): if the caller is
    // the node default agent, default to `this.peerId` instead of
    // the EVM address. Pre-existing WM data for the default agent
    // lives under the peerId-keyed namespace; defaulting to the EVM
    // form would strand that data. The isolation check below is
    // alias-aware (`canonicaliseWmId`), so both forms resolve to the
    // same canonical identity and still pass the caller===target
    // invariant.
    const callerIsDefaultAgent =
      !!callerAgentAddressStr
      && !!defaultEvmLc
      && callerAgentAddressStr.toLowerCase() === defaultEvmLc;
    const agentAddressStr =
      opts.agentAddress
      ?? (opts.view === 'working-memory' && callerAgentAddressStr
        ? (callerIsDefaultAgent && this.peerId ? this.peerId : callerAgentAddressStr)
        : undefined);
    if (
      opts.view === 'working-memory' &&
      callerAgentAddressStr &&
      agentAddressStr &&
      canonicaliseWmId(callerAgentAddressStr) !== canonicaliseWmId(agentAddressStr)
    ) {
      this.log.info(
        ctx,
        `WM query denied: caller=${callerAgentAddressStr} cannot read agentAddress=${agentAddressStr} — A-1 isolation`,
      );
      // A-1 follow-up review: preserve the SPARQL query-form shape on
      // denial so ASK clients see `{ bindings: [{ result: 'false' }] }`
      // and CONSTRUCT / DESCRIBE clients see `{ bindings: [], quads: [] }`.
      // Returning a SELECT-shaped `{ bindings: [] }` on every form leaks
      // the fact that access was denied (versus an empty match) via the
      // changed response shape.
      return emptyQueryResultForKind(sparql);
    }

    // When no context graph is specified, exclude private CGs the caller cannot
    // read to prevent data leakage via unscoped or FROM-less SPARQL.
    let excludeGraphPrefixes: string[] | undefined;
    if (!opts.contextGraphId) {
      excludeGraphPrefixes = await this.getDisallowedGraphPrefixes({
        callerAgentAddress: callerAgentAddressStr,
      });
      // Per spec Axiom 1 every shared query must be resolved within a CG.
      // Reject explicit GRAPH/FROM clauses that reference private CGs the
      // caller cannot read — post-filtering alone cannot prevent leaks via
      // aggregates (ASK, COUNT) or projections that omit graph/subject.
      if (excludeGraphPrefixes.length > 0 && this.sparqlReferencesPrivateGraphs(sparql, excludeGraphPrefixes)) {
        this.log.info(ctx, 'Query denied: SPARQL references private context graphs the caller cannot read');
        return emptyQueryResultForKind(sparql);
      }
      // Post-filtering cannot make arbitrary unscoped SPARQL safe: ASK,
      // aggregates, and projections that omit the GRAPH variable can disclose
      // private rows before bindings are filtered. Until the query engine owns
      // a dataset-level graph exclusion, fail closed when this caller lacks any
      // private CG on the node. Scoped public queries remain available.
      if (excludeGraphPrefixes.length > 0) {
        this.log.info(ctx, 'Unscoped query denied because the caller cannot read every private context graph');
        return emptyQueryResultForKind(sparql);
      }
    }

    // #1106 (3): an UNAUTHENTICATED / admin caller omitting `agentAddress`
    // on a working-memory read previously fell back to the bare peerId
    // namespace — but rc.17 WM data is keyed by the agent's EVM wallet, so
    // "query my node's WM" silently returned 0 rows. Default to the node's
    // primary agent wallet when configured; the peerId remains the fallback
    // for nodes without a default agent (it is also the documented legacy
    // namespace). The authenticated-caller default above is unchanged.
    const effectiveWmAddress =
      agentAddressStr ?? (opts.view === 'working-memory' ? (this.defaultAgentAddress ?? this.peerId) : undefined);
    // PR #1107 review (🟡): the wallet address and the peerId are TWO graph
    // namespaces for the SAME identity (the node default agent) — legacy
    // drafts live under peerId, rc.17+ drafts under the EVM wallet. Whenever
    // the target resolves to that identity, span both namespaces so neither
    // era of WM data is stranded. Aliases never cross identities: they are
    // only emitted when the target IS the default agent (per
    // `canonicaliseWmId`), so A-1 isolation is unaffected.
    let wmAddressAliases: string[] | undefined;
    if (
      opts.view === 'working-memory' &&
      effectiveWmAddress &&
      defaultEvmLc &&
      peerIdLc &&
      (effectiveWmAddress.toLowerCase() === defaultEvmLc || effectiveWmAddress.toLowerCase() === peerIdLc)
    ) {
      wmAddressAliases =
        effectiveWmAddress.toLowerCase() === defaultEvmLc ? [this.peerId!] : [this.defaultAgentAddress!];
    }

    const result = await this.queryEngine.query(sparql, {
      contextGraphId: opts.contextGraphId,
      excludeGraphPrefixes,
      graphSuffix: opts.graphSuffix,
      includeSharedMemory: opts.includeSharedMemory,
      includeContextGraphPartitions: opts.includeContextGraphPartitions,
      includePrivate: opts.includePrivate,
      signal: opts.signal,
      priority: opts.priority,
      source: opts.source,
      view: opts.view,
      agentAddress: effectiveWmAddress,
      agentAddressAliases: wmAddressAliases,
      verifiedGraph: opts.verifiedGraph,
      assertionName: opts.assertionName,
      subGraphName: opts.subGraphName,
      // PR #239 Codex iter-5: fall back to the deprecated underscore alias
      // here (and only here — we do not propagate both fields further) so
      // callers on the legacy shape still get the trust gate without
      // engines needing to know about both names.
      minTrust: opts.minTrust ?? opts._minTrust,
    });
    this.log.info(ctx, `Query returned ${result.bindings?.length ?? 0} bindings`);
    return result;
  }

  isAgentAddressAllowed(this: DKGAgent, agentAddress: string | undefined, agentGateAddresses: readonly string[]): boolean {
    if (!agentAddress) return false;
    const normalized = agentAddress.toLowerCase();
    return agentGateAddresses.some((agent) => agent.toLowerCase() === normalized);
  }

  public async canReadContextGraph(this: DKGAgent,
    contextGraphId: string,
    opts: {
      callerAgentAddress?: string;
      allowSubscriptionFallback?: boolean;
    } = {},
  ): Promise<boolean> {
    const rfc64Roster = this.resolveRfc64PrivateReadRosterV1(contextGraphId);
    if (rfc64Roster !== undefined) {
      if (rfc64Roster === null) return false;
      const effectiveCaller = opts.callerAgentAddress
        ?? this.config.rfc64CatalogAccessPolicyAuthority?.localAgentAddress
        ?? this.defaultAgentAddress;
      return this.isAgentAddressAllowed(effectiveCaller, rfc64Roster);
    }
    if (!(await this.isPrivateContextGraph(contextGraphId))) {
      return true;
    }

    const agentGateAddresses = await this.getContextGraphAgentGateAddresses(contextGraphId);
    const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);

    // Mixed legacy peer-id and V10 agent gates are conjunctive: a node must
    // be invited by peer id and also hold a local allowed agent identity.
    const agentGateAllowed = agentGateAddresses === null
      ? false
      : opts.callerAgentAddress
        ? this.isAgentAddressAllowed(opts.callerAgentAddress, agentGateAddresses)
        : this.hasLocalAgentInGate(agentGateAddresses);

    if (agentGateAddresses !== null && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId) && agentGateAllowed;
    }

    if (agentGateAddresses !== null) {
      return agentGateAllowed;
    }

    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);

    if ((!participants || participants.length === 0) && allowedPeers !== null) {
      return allowedPeers.includes(this.peerId);
    }

    // No participant or peer list at all. Durable CG reads preserve the legacy
    // subscribed-node fallback, but SWM must fail closed here because SWM
    // GossipSub carries plaintext bytes.
    if (!participants || participants.length === 0) {
      if (opts.allowSubscriptionFallback === false) {
        return false;
      }
      return this.subscribedContextGraphs.has(contextGraphId)
        || (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    }

    if (
      opts.callerAgentAddress
      && participants.some((p) => p.toLowerCase() === opts.callerAgentAddress!.toLowerCase())
    ) {
      return true;
    }

    // Check if any local agent address is in the participants list
    const myAgentAddress = this.defaultAgentAddress;
    if (myAgentAddress && participants.some((p) => p.toLowerCase() === myAgentAddress.toLowerCase())) {
      return true;
    }

    // Check if the local identity ID is in the participants list
    let myIdentityId = 0n;
    try {
      myIdentityId = await this.chain.getIdentityId();
      if (myIdentityId > 0n && participants.includes(String(myIdentityId))) {
        return true;
      }
    } catch { /* identity lookup failed — continue to deny */ }

    // Legacy peer-ID allowlist: `inviteToContextGraph` writes `DKG_ALLOWED_PEER`
    // quads. Honor them for local reads so a peer-ID-invited node can query
    // the data it just synced.
    if (allowedPeers?.includes(this.peerId)) {
      return true;
    }

    // Edge nodes without an on-chain identity (identityId 0n) fall back to
    // subscription-based access — the subscription itself is an authorization
    // (the node was invited or created this CG).
    if (myIdentityId === 0n && opts.allowSubscriptionFallback !== false) {
      return this.subscribedContextGraphs.has(contextGraphId);
    }

    return false;
  }

  /**
   * Resolve the current accepted RFC-64 roster for a selected private CG.
   * `undefined` means the CG is not owned by RFC-64 activation. `null` means
   * it is selected but current authority is unavailable, so reads must deny.
   */
  resolveRfc64PrivateReadRosterV1(
    this: DKGAgent,
    contextGraphId: string,
  ): readonly string[] | null | undefined {
    const configured = this.config.rfc64CatalogBootstrap?.acceptedPolicies.filter(
      ({ policyEnvelope }) => (
        policyEnvelope.payload.contextGraphId === contextGraphId
        && policyEnvelope.payload.accessPolicy === 1
      ),
    ) ?? [];
    if (configured.length === 0) return undefined;
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) return null;

    for (const { policyEnvelope } of configured) {
      const policy = policyEnvelope.payload;
      const current = service.acceptedPolicySnapshot(
        policy.networkId,
        policy.contextGraphId,
      );
      if (
        current !== null
        && current.policy.accessPolicy === 1
        && current.roster !== null
      ) {
        return Object.freeze(current.roster.members.map(({ agentAddress }) => agentAddress));
      }
    }
    return null;
  }

  /**
   * Returns graph URI prefixes for private CGs the caller cannot read.
   * Used to exclude them from unscoped queries.
   */
  async getDisallowedGraphPrefixes(this: DKGAgent, opts: { callerAgentAddress?: string } = {}): Promise<string[]> {
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const result = await this.store.query(
      `SELECT ?cg WHERE {
        GRAPH <${ontologyGraph}> {
          ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
        }
      }`,
      { source: 'agent.query.privateGraphAccessPolicy' },
    );
    const privateContextGraphIds = new Set<string>();
    if (result.type === 'bindings') {
      for (const row of result.bindings) {
        const cgUri = row['cg'];
        if (!cgUri) continue;
        const match = cgUri.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
        if (match?.[1]) privateContextGraphIds.add(match[1]);
      }
    }
    for (const { policyEnvelope } of this.config?.rfc64CatalogBootstrap?.acceptedPolicies ?? []) {
      if (policyEnvelope.payload.accessPolicy === 1) {
        privateContextGraphIds.add(policyEnvelope.payload.contextGraphId);
      }
    }
    const prefixes: string[] = [];
    for (const contextGraphId of privateContextGraphIds) {
      if (await this.canReadContextGraph(contextGraphId, {
        callerAgentAddress: opts.callerAgentAddress,
      })) continue;
      // Exclude all named graphs under this CG (data, _meta, _shared_memory, etc.)
      prefixes.push(`did:dkg:context-graph:${contextGraphId}`);
    }
    return prefixes;
  }

  sparqlReferencesPrivateGraphs(this: DKGAgent, sparql: string, disallowedPrefixes: string[]): boolean {
    if (disallowedPrefixes.length === 0) return false;
    const upper = sparql.toUpperCase();
    if (!upper.includes('GRAPH') && !upper.includes('FROM')) return false;
    return disallowedPrefixes.some(prefix => sparql.includes(prefix));
  }

  /**
   * Send a cross-agent query to a remote peer via the /dkg/query/2.0.0 protocol.
   */
  async queryRemote(this: DKGAgent,
    peerId: string,
    request: Omit<QueryRequest, 'operationId'>,
  ): Promise<QueryResponse> {
    const ctx = createOperationContext('query');
    const operationId = crypto.randomUUID();
    const fullRequest: QueryRequest = { ...request, operationId };

    this.log.info(ctx, `Remote query to ${peerId.slice(-8)} type=${request.lookupType}`);

    const payload = new TextEncoder().encode(JSON.stringify(fullRequest));
    // rc.9 PR-9: route through messenger.sendReliable so the query
    // gains sender-side idempotency + receiver-side dedup. SPARQL is
    // idempotent at the app layer so on RESPONSE_GONE (duplicate-
    // receive on a too-big-to-cache response) we transparently re-
    // issue with a fresh messageId — the substrate makes this safe.
    // queued returns are surfaced as a transport error: queryRemote
    // is synchronous-by-design (callers await results), not a fire-
    // and-forget enqueue.
    const responseBytes = await this.sendQueryReliable(peerId, payload);
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as QueryResponse;

    this.log.info(ctx, `Remote query response: status=${response.status} resultCount=${response.resultCount}`);
    return response;
  }

  /**
   * Send a query-remote payload via the Messenger substrate with
   * built-in RESPONSE_GONE retry. SPARQL queries are app-layer
   * idempotent — if the substrate replies with the RESPONSE_GONE
   * sentinel (the original response was too big to inline-cache and
   * we got a duplicate-receive), we re-issue with a fresh messageId
   * and try again. Capped at 2 attempts so a peer that always blows
   * the 256 KiB response cache surfaces as a hard error to the
   * caller instead of looping forever.
   *
   * rc.9 PR-9.
   */
  async sendQueryReliable(this: DKGAgent,
    peerId: string,
    payload: Uint8Array,
  ): Promise<Uint8Array> {
    const RESPONSE_GONE = 'RESPONSE_GONE';
    const MAX_ATTEMPTS = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const sendResult = await this.messenger.sendReliable(
        peerId,
        PROTOCOL_QUERY_REMOTE,
        payload,
      );
      if (!sendResult.delivered) {
        throw new Error(
          `query-remote send not synchronously deliverable (queued): ${sendResult.error}`,
        );
      }
      const respText = new TextDecoder().decode(sendResult.response);
      if (respText === RESPONSE_GONE) {
        // Original response was mark-only; re-issue with a fresh
        // messageId next loop iteration (sendReliable mints one
        // when opts.messageId is absent).
        lastErr = new Error('RESPONSE_GONE: original response too large to cache; retrying with fresh messageId');
        continue;
      }
      return sendResult.response;
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('query-remote exhausted RESPONSE_GONE retries');
  }

  /**
   * Look up a specific knowledge asset on a remote peer by UAL.
   */
  async lookupEntity(this: DKGAgent, peerId: string, ual: string): Promise<QueryResponse> {
    return this.queryRemote(peerId, { lookupType: 'ENTITY_BY_UAL', ual });
  }

  /**
   * Find entities of a given RDF type on a remote peer's context graph.
   */
  async findEntitiesByType(this: DKGAgent,
    peerId: string,
    contextGraphId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      contextGraphId: contextGraphId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's context graph.
   */
  async getEntityTriples(this: DKGAgent,
    peerId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      contextGraphId: contextGraphId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(this: DKGAgent,
    peerId: string,
    contextGraphId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      contextGraphId: contextGraphId,
      sparql,
      limit,
      timeout,
    });
  }

}
