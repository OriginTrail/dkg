import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  paranetPublishTopic, paranetWorkspaceTopic, paranetAppTopic, paranetUpdateTopic, paranetFinalizationTopic,
  paranetDataGraphUri, paranetMetaGraphUri, paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri, contextGraphVerifiedMemoryMetaUri,
  contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  MemoryLayer,
  computeACKDigest,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  getGenesisQuads, computeNetworkId, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext, sparqlString, escapeSparqlLiteral,
  TrustLevel,
  type DKGNodeConfig, type OperationContext, type GetView, type AssertionDescriptor, type AssertionEvent, type AssertionState,
} from '@origintrail-official/dkg-core';
import { GraphManager, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, autoPartition,
  type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  type CollectedACK,
} from '@origintrail-official/dkg-publisher';
import { randomBytes } from 'node:crypto';
import { join as pathJoin } from 'node:path';
import { ethers } from 'ethers';
import {
  DKGQueryEngine, QueryHandler,
  detectSparqlQueryForm, emptyResultForForm,
  validateReadOnlySparql,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
  type SparqlQueryForm,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
import {
  buildSignedGossipEnvelope,
  tryUnwrapSignedEnvelope,
  classifyGossipBytes,
  buildPublishRequestSig,
} from './signed-gossip.js';
import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, canonicalAgentDidSubject, type AgentProfileConfig } from './profile.js';
import { SyncVerifyWorker } from './sync-verify-worker.js';
import { connectToMultiaddr, ensurePeerConnected as ensurePeerConnectedAtom, primeCatchupConnections as primeCatchupConnectionsAtom } from './p2p/peer-connect.js';
import { waitForPeerProtocol } from './p2p/protocol-readiness.js';
import { orderCatchupPeers } from './p2p/peer-selection.js';
import { fetchSyncPages, type SyncPageResult } from './sync/requester/page-fetch.js';
import { getSyncCheckpointKey } from './sync/checkpoint/state.js';
import { runDurableSync } from './sync/requester/durable-sync.js';
import { runSharedMemorySync } from './sync/requester/shared-memory-sync.js';
import { buildSyncRequestEnvelope } from './sync/auth/request-build.js';
import { authorizePrivateSyncRequest } from './sync/auth/request-authorize.js';
import { registerSyncHandler } from './sync/responder/sync-handler.js';
import { runSyncOnConnect } from './sync/on-connect/sync-on-connect.js';
import {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  hashAgentToken,
  type AgentKeyRecord,
} from './agent-keystore.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler } from './finalization-handler.js';
import { multiaddr } from '@multiformats/multiaddr';
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';
import {
  strip, stripLiteral, jsonLdToQuads,
  type JsonLdContent,
} from './dkg-agent-utils.js';

export interface CclPublishedResultEntry {
  entryUri: string;
  kind: 'derived' | 'decision';
  name: string;
  tuple: unknown[];
}

export interface CclPublishedEvaluationRecord {
  evaluationUri: string;
  policyUri: string;
  factSetHash: string;
   factQueryHash?: string;
   factResolverVersion?: string;
   factResolutionMode?: CclFactResolutionMode;
  createdAt?: string;
  view?: string;
  snapshotId?: string;
  scopeUal?: string;
  contextType?: string;
  results: CclPublishedResultEntry[];
}

interface PublishOpts {
  onPhase?: PhaseCallback;
  operationCtx?: OperationContext;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
  subGraphName?: string;
}

const SYNC_PAGE_SIZE = 500;
const SYNC_PAGE_RETRY_ATTEMPTS = 3;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
const SYNC_PAGE_TIMEOUT_MS = 45_000;
/** ProtocolRouter.send retries internally 3 times with the same timeout; cap so 3× fits in remaining budget. */
const SYNC_ROUTER_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
const SYNC_AUTH_MAX_AGE_MS = 90_000;

/**
 * Wire-level sentinel returned by the sync responder when ACL authorization
 * fails for a request. Distinguishes an explicit denial from an empty page
 * (peer is up but has no data) and a transport error (peer unreachable).
 * Chosen to never collide with nquads output (nquads lines always contain
 * `<…>` tokens and end with `.`; this is a `#`-comment string).
 */
const SYNC_ACCESS_DENIED_MARKER = '#DKG-SYNC-ACCESS-DENIED';

const LOCAL_ACCESS_OPEN = 0;
const LOCAL_ACCESS_CURATED = 1;
const EVM_PUBLISH_CURATED = 0;
const EVM_PUBLISH_OPEN = 1;
const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

/**
 * Thrown by `fetchSyncPages` when the remote responder returned
 * SYNC_ACCESS_DENIED_MARKER. Caught by `syncFromPeer` and surfaced as a
 * per-CG denial observation to the caller via its `onAccessDenied` hook,
 * so higher-level flows (catch-up job) can distinguish ACL denial from
 * transport errors without heuristics.
 */
class SyncAccessDeniedError extends Error {
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(`Sync access denied for context graph "${contextGraphId}"`);
    this.name = 'SyncAccessDeniedError';
    this.contextGraphId = contextGraphId;
  }
}

/**
 * Thrown by `signedGossipPublish` when we cannot produce a signed
 * `GossipEnvelope` — either the default publisher wallet is absent (and
 * the operator has not opted into the legacy `DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS=1`
 * escape hatch) or envelope construction fails outright.
 *
 * PR #229 bot review (r22-6, dkg-agent.ts:7411): every call site of
 * `signedGossipPublish()` was previously wrapped with a blanket
 * `catch { log.warn('No peers subscribed to …') }`. On observer /
 * self-sovereign nodes that silently turned a real correctness
 * failure — "this node cannot sign; strict peers (r14-1 default) will
 * DROP the gossip" — into a fake "no peers subscribed" warning, so
 * publishes looked successful while never reaching the mesh.
 *
 * Exporting a dedicated error type lets every call site distinguish
 * "we could not sign" from "libp2p had no subscribers" and react
 * appropriately (log loud, propagate, or re-raise) instead of
 * swallowing silently.
 */
export class SignedGossipSigningError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = 'SignedGossipSigningError';
  }
}

/**
 * Classify an error thrown from `signedGossipPublish`. Used by the
 * call-site catches that intentionally degrade gracefully on "no
 * subscribers yet" (a routine libp2p condition during startup /
 * partitioned networks) but MUST surface signing/envelope failures
 * (a correctness bug that would otherwise be hidden).
 */
function isSignedGossipSigningError(err: unknown): err is SignedGossipSigningError {
  return (
    err instanceof SignedGossipSigningError
    || (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'SignedGossipSigningError')
  );
}

/**
 * Central handler for a broadcast failure at a `signedGossipPublish`
 * call site. The distinction PR #229 r22-6 demands is a VISIBILITY
 * one, not a control-flow one:
 *
 *   - `SignedGossipSigningError` → a correctness-class failure
 *     (missing/broken wallet, envelope construction refused) that
 *     strict peers (r14-1 default) will drop. Log as **ERROR** with
 *     a distinctive message that names the signing problem so
 *     operators can see it in `dkg logs` / monitoring. The underlying
 *     operation (local publish / share / promote) is already
 *     committed; throwing here would regress the existing "tentative
 *     publish still succeeds without a wallet" contract that is
 *     explicitly pinned by `v10-ack-provider.test.ts` (observer-node
 *     ergonomics).
 *
 *   - Everything else → the benign "libp2p has no subscribers yet"
 *     path (routine during startup / partitioned meshes). Log as
 *     WARN so node logs aren't flooded but the state is still
 *     visible on request.
 *
 * Pre-r22-6, BOTH cases collapsed into a single
 * `log.warn('No peers subscribed to …')` message, so a wallet-less
 * observer node silently reported "everything is fine" while every
 * strict peer dropped its gossip.
 */
function logSignedGossipFailure(
  log: Logger,
  ctx: OperationContext,
  topic: string,
  err: unknown,
): void {
  if (isSignedGossipSigningError(err)) {
    log.error(
      ctx,
      `[signed-gossip] Cannot broadcast to ${topic} — signing/envelope ` +
        `failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `The local operation is committed but strict peers (r14-1 default) ` +
        `will DROP this message. Provision a publisher wallet (the standard ` +
        `path on DKGAgent.init) or set DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS=1 ` +
        `for local-cluster / lenient-peer deployments. This is NOT a ` +
        `transient "no peers subscribed" condition — it is a correctness ` +
        `configuration issue on this node.`,
    );
    return;
  }
  log.warn(ctx, `No peers subscribed to ${topic} yet`);
}
const META_REFRESH_COOLDOWN_MS = 30_000;
const SYNC_MIN_GRAPH_BUDGET_MS = 10_000;
const DEBUG_SYNC_PROGRESS = process.env.DKG_DEBUG_SYNC_PROGRESS === '1';
const DEFAULT_SWM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SWM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run cleanup every 15 minutes
const SYNC_DENIED_RESPONSE = '__DKG_SYNC_DENIED__';
/**
 * How long to wait between reconnect-on-gossip dial attempts for the same peer.
 * A CG with chatty gossip could otherwise produce a dial per message; this
 * throttles us to at most one attempted dial per peer per window.
 */
const GOSSIP_DIAL_COOLDOWN_MS = 30_000;
/** Per-dial-attempt timeout for reconnect-on-gossip so a stuck dial can't starve the gossip handler path. */
const GOSSIP_DIAL_TIMEOUT_MS = 10_000;
/**
 * Cooldown for catchup-on-connection:open: suppresses duplicate catchup kicks
 * when the same peer briefly has overlapping direct + relayed connections
 * (each of which fires its own connection:open).
 */
const CATCHUP_ON_CONNECT_COOLDOWN_MS = 60_000;

interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  phase?: 'data' | 'meta';
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
}

/** Health status of a peer from the last ping round. */
export interface PeerHealth {
  peerId: string;
  alive: boolean;
  latencyMs: number | null;
  lastSeen: number | null;
  lastChecked: number;
}

/** Tracks the subscription and sync state of a context graph. */
export interface ContextGraphSub {
  name?: string;
  /** GossipSub topics are active for this context graph. */
  subscribed: boolean;
  /** Definition triples exist in the local triple store. */
  synced: boolean;
  /**
   * Whether the `_meta` graph (allowlist, registration status) has been
   * fetched via authenticated sync or is known from local creation.
   * When false, the gossip handler denies writes to prevent unauthorized
   * access during the window before _meta arrives.
   */
  metaSynced?: boolean;
  /** On-chain context graph ID (keccak256 hash), if known. */
  onChainId?: string;
  /** Local participant identities used for private SWM authorization before anchoring. */
  participantIdentityIds?: bigint[];
  /** Participant agent addresses (V10 agent identity model). */
  participantAgents?: string[];
}

/** @deprecated Use ContextGraphSub */
export type ParanetSub = ContextGraphSub;

export interface DurableSyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
}

export interface SharedMemorySyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
}

export interface CatchupSyncDiagnostics {
  noProtocolPeers: number;
  durable: DurableSyncDiagnostics;
  sharedMemory: SharedMemorySyncDiagnostics;
}

interface DurableSyncResult extends DurableSyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

interface SharedMemorySyncResult extends SharedMemorySyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

export interface DKGAgentConfig {
  name: string;
  framework?: string;
  description?: string;
  listenPort?: number;
  /** IP address to listen on. Default: '0.0.0.0' (all interfaces). Use '127.0.0.1' for tests. */
  listenHost?: string;
  bootstrapPeers?: string[];
  /** Multiaddrs of relay nodes for NAT traversal. */
  relayPeers?: string[];
  /** Multiaddrs to announce to the network (for VPS/cloud nodes with a public IP not on the interface). */
  announceAddresses?: string[];
  skills?: Array<{
    skillType: string;
    pricePerCall?: number;
    currency?: string;
    handler: SkillHandler;
  }>;
  dataDir?: string;
  store?: TripleStore;
  /** Triple store backend configuration (e.g. oxigraph-worker, blazegraph). If omitted, defaults to oxigraph-worker when dataDir is set. */
  storeConfig?: TripleStoreConfig;
  /** Node deployment tier: 'core' (cloud, relay) or 'edge' (personal, behind NAT). Default: 'edge'. */
  nodeRole?: 'core' | 'edge';
  /** Pre-built chain adapter (for testing). If provided, chainConfig is ignored. */
  chainAdapter?: ChainAdapter;
  /** Private key for the V10 ACK signer. When omitted, falls back to chainConfig.operationalKeys[0]. */
  ackSignerKey?: string;
  /**
   * EVM chain configuration. If omitted, publishing won't have on-chain finality.
   * `operationalKeys` are the private keys for operational wallets.
   * The first key is the primary signer (identity, staking); all are used
   * round-robin for publish TXs to avoid nonce collisions on parallel publishes.
   */
  chainConfig?: {
    rpcUrl: string;
    hubAddress: string;
    operationalKeys: string[];
    chainId?: string;
  };
  /** Cross-agent query access configuration. */
  queryAccess?: QueryAccessConfig;
  /** Additional context graph IDs to sync on peer connect (beyond system context graphs). */
  syncContextGraphs?: string[];
  /** TTL for shared memory data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  sharedMemoryTtlMs?: number;
  /**
   * Controls RFC-29 multi-agent working-memory isolation. When a node
   * hosts >1 local agent, explicit `agentAddress` `working-memory`
   * queries MUST include a valid `agentAuthSignature`.
   *
   * **Default (undefined) is STRICT / fail-closed** (PR #229 bot review
   * round 12): missing or invalid signatures return `[]` so a caller
   * that merely knows another agent's address cannot read that agent's
   * WM. Operators still on a rolling upgrade where some HTTP/CLI/UI
   * surfaces have not yet plumbed `agentAuthSignature` can temporarily
   * opt out via `strictWmCrossAgentAuth: false` or
   * `DKG_STRICT_WM_AUTH=0`, but doing so accepts that any in-process
   * caller of a multi-agent node can read any local agent's WM.
   */
  strictWmCrossAgentAuth?: boolean;
  /**
   * When true (the default), ingress gossip on context-graph topics MUST
   * arrive wrapped in a signed `GossipEnvelope` whose (a) signature
   * recovers, (b) type matches the subscription label, and (c)
   * `contextGraphId` matches the subscription's context graph. Raw
   * (un-enveloped) bytes are dropped.
   *
   * PR #229 bot review round 14 (r14-1): previously the default was
   * `false` (lenient-with-warn) to ease rolling upgrades. That made
   * the new signing layer opt-in rather than protective — an attacker
   * could simply omit the envelope and their payload would be treated
   * as legacy gossip and dispatched anyway. The fix: strict mode is
   * now the fail-closed default, matching the same flip we made for
   * `strictWmCrossAgentAuth` in round 12 (r12-1).
   *
   * Operators still on a partially-upgraded mesh can opt OUT via
   * `strictGossipEnvelope: false` or `DKG_STRICT_GOSSIP_ENVELOPE=0`
   * (temporarily, with a loud warning). Forged / tampered envelopes
   * are always rejected regardless of this flag.
   *
   * Precedence (mirrors r12-1):
   *   1. Explicit env var `DKG_STRICT_GOSSIP_ENVELOPE=1` → strict.
   *   2. Explicit env var `DKG_STRICT_GOSSIP_ENVELOPE=0` → lenient.
   *   3. Config `strictGossipEnvelope === false` → lenient.
   *   4. Otherwise → strict (the new safe default).
   */
  strictGossipEnvelope?: boolean;
}

/**
 * Resolve whether ingress gossip MUST be a signed `GossipEnvelope`.
 *
 * Exported for unit tests (PR #229 bot review round 14 — r14-1) so the
 * precedence can be exercised without instantiating a real DKGAgent.
 *
 * Precedence (highest to lowest):
 *   1. Env var `DKG_STRICT_GOSSIP_ENVELOPE` explicitly ON (`1` / `true` /
 *      `yes`) → strict mode even if the config opts out.
 *   2. Env var explicitly OFF (`0` / `false` / `no`) → lenient mode even
 *      if the config says strict.
 *   3. Config value `false` → lenient mode (explicit opt-out).
 *   4. Otherwise (config is `true` or missing) → strict mode.
 *
 * The fail-closed default closes the r14-1 bypass: before this change,
 * `false` was the default and a malicious peer could strip the envelope
 * entirely, fall into the `raw` bucket, and have their payload
 * dispatched. Now the `raw` bucket is rejected unless an operator
 * explicitly opts out (typically during a rolling upgrade).
 */
export function resolveStrictGossipEnvelopeMode(input: {
  configValue?: boolean;
  envValue?: string;
}): boolean {
  const envV = (input.envValue ?? '').toLowerCase();
  const envExplicitOn = envV === '1' || envV === 'true' || envV === 'yes';
  const envExplicitOff = envV === '0' || envV === 'false' || envV === 'no';
  if (envExplicitOn) return true;
  if (envExplicitOff) return false;
  return input.configValue !== false;
}

/**
 * High-level facade that ties together all DKG agent capabilities:
 * identity, networking, publishing, querying, discovery, and messaging.
 *
 * Usage:
 *   const agent = await DKGAgent.create({ name: 'MyBot', skills: [...] });
 *   await agent.start();
 *   const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
 *   const response = await agent.invokeSkill(offerings[0], inputData);
 *   await agent.stop();
 */
export class DKGAgent {
  readonly wallet: AgentWallet;
  readonly node: DKGNode;
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly queryEngine: DKGQueryEngine;
  readonly discovery: DiscoveryClient;
  readonly profileManager: ProfileManager;
  gossip!: GossipSubManager;
  router!: ProtocolRouter;
  readonly eventBus: TypedEventBus;
  private readonly chain: ChainAdapter;
  /** Shared memory-owned root entities per context graph: entity → creatorPeerId. Used by publisher and shared memory handler. */
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  /** Shared write locks so gossip writes serialize against local CAS writes. */
  private readonly writeLocks: Map<string, Promise<void>>;
  private sharedMemoryHandler?: InstanceType<typeof SharedMemoryHandler>;
  private gossipPublishHandler?: GossipPublishHandler;
  private finalizationHandler?: FinalizationHandler;
  private readonly log = new Logger('DKGAgent');

  private messageHandler: MessageHandler | null = null;
  private chainPoller: ChainEventPoller | null = null;
  private swmCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: DKGAgentConfig;
  private started = false;
  private readonly subscribedContextGraphs = new Map<string, ContextGraphSub>();
  private readonly gossipRegistered = new Set<string>();
  private readonly seenOnChainIds = new Set<string>();
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly knownCorePeerIds = new Set<string>();
  private readonly syncingPeers = new Set<string>();
  private readonly seenPrivateSyncRequestIds = new Map<string, number>();
  private readonly metaRefreshTimestamps = new Map<string, number>();
  private readonly preferredSyncPeers = new Map<string, string>();
  /**
   * Remembers the libp2p peer ID that delivered each pending join request
   * to this curator. Keyed by `${contextGraphId}::${agentAddress_lower}`.
   *
   * This is the authoritative source when we later need to notify that
   * requester about approval/rejection — the agent registry can be stale
   * (a requester may P2P-reach us before their agent profile has indexed
   * locally), so without this map we'd drop notifications and leave the
   * invitee stuck on "Join request sent, awaiting approval". See
   * `notifyJoinApproval` / `notifyJoinRejection`.
   *
   * In-memory only: survives for the curator's process lifetime, which
   * matches the approval window in practice. On restart we fall back to
   * the agent registry.
   */
  private readonly joinRequestOriginPeers = new Map<string, string>();
  /**
   * Per-peer timestamp of the last reconnect-on-gossip dial we attempted.
   * Prevents a noisy topic from generating a dial storm against a peer we
   * already tried recently. See DOC: p2p-resilience.md.
   */
  private readonly gossipDialAttemptedAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the last catchup-on-connect we queued, to dedupe
   * connection:open events when the same peer briefly churns between
   * direct + relayed connections within a short window.
   */
  private readonly catchupOnConnectAt = new Map<string, number>();
  /**
   * v10-rc sync-refactor: per-(peer+CG) checkpoint offsets so the paged
   * sync requester in `sync/requester/page-fetch.ts` can resume where it
   * left off, and the worker-hosted verify path (`sync-verify-worker.ts`)
   * can run CPU-bound hash checks off the main thread. Both introduced
   * by PR #237 (sync-refactor-rebased).
   */
  private readonly syncCheckpoints = new Map<string, number>();
  private syncVerifyWorker?: SyncVerifyWorker;

  /** Registered agents on this node: agentAddress → AgentKeyRecord */
  private readonly localAgents = new Map<string, AgentKeyRecord>();
  /** Agent token → agentAddress lookup for Bearer-based agent resolution */
  private readonly agentTokenIndex = new Map<string, string>();
  /** The default "owner" agent address (first operational wallet, auto-registered on boot) */
  private defaultAgentAddress: string | undefined;

  private constructor(
    config: DKGAgentConfig,
    wallet: DKGAgentWallet,
    node: DKGNode,
    store: TripleStore,
    publisher: DKGPublisher,
    queryEngine: DKGQueryEngine,
    eventBus: TypedEventBus,
    chain: ChainAdapter,
    workspaceOwnedEntities: Map<string, Map<string, string>>,
    writeLocks: Map<string, Promise<void>>,
  ) {
    this.config = config;
    this.wallet = wallet;
    this.node = node;
    this.store = store;
    this.publisher = publisher;
    this.queryEngine = queryEngine;
    this.workspaceOwnedEntities = workspaceOwnedEntities;
    this.writeLocks = writeLocks;
    this.eventBus = eventBus;
    this.chain = chain;
    this.discovery = new DiscoveryClient(queryEngine);
    this.profileManager = new ProfileManager(publisher, store);
  }

  static async create(config: DKGAgentConfig): Promise<DKGAgent> {
    let wallet: DKGAgentWallet;
    if (config.dataDir) {
      try {
        wallet = await DKGAgentWallet.load(config.dataDir);
      } catch {
        wallet = await DKGAgentWallet.generate();
        await wallet.save(config.dataDir);
      }
    } else {
      wallet = await DKGAgentWallet.generate();
    }
    const log = new Logger('DKGAgent');
    const ctx = createOperationContext('system');
    let store: TripleStore;
    if (config.store) {
      store = config.store;
    } else if (config.storeConfig) {
      store = await createTripleStore(config.storeConfig);
      log.info(ctx, `Triple store backend: ${config.storeConfig.backend}`);
    } else if (config.dataDir) {
      const { join } = await import('node:path');
      const persistPath = join(config.dataDir, 'store.nq');
      store = await createTripleStore({ backend: 'oxigraph-worker', options: { path: persistPath } });
      log.info(ctx, `Persistent triple store (worker thread): ${persistPath}`);
    } else {
      store = await createTripleStore({ backend: 'oxigraph' });
      log.warn(ctx, `No dataDir — triple store is in-memory (data will be lost on restart)`);
    }

    let chain: ChainAdapter;
    let opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
      if (!opKeys?.length && typeof (chain as any).getOperationalPrivateKey === 'function') {
        opKeys = [(chain as any).getOperationalPrivateKey()];
      }
    } else if (config.chainConfig && opKeys?.length) {
      chain = new EVMChainAdapter({
        rpcUrl: config.chainConfig.rpcUrl,
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        chainId: config.chainConfig.chainId,
      });
    } else {
      chain = new NoChainAdapter();
    }

    const eventBus = new TypedEventBus();
    const keypair = wallet.keypair;

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store);

    const port = config.listenPort ?? 0;
    const host = config.listenHost ?? '0.0.0.0';
    const nodeRole = config.nodeRole ?? 'edge';
    const nodeConfig: DKGNodeConfig = {
      listenAddresses: [`/ip4/${host}/tcp/${port}`],
      announceAddresses: config.announceAddresses,
      bootstrapPeers: config.bootstrapPeers,
      relayPeers: config.relayPeers,
      enableMdns: !config.bootstrapPeers?.length && !config.relayPeers?.length,
      privateKey: keypair.secretKey,
      nodeRole,
    };

    const node = new DKGNode(nodeConfig);
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: opKeys?.[0],
      sharedMemoryOwnedEntities: workspaceOwnedEntities,
      writeLocks,
      // PR #229 bot review round 26 (r26-3, dkg-agent.ts). Thread a
      // persistent WAL path through from `config.dataDir` so the
      // pre-broadcast journal is actually durable across restarts.
      // Without this, the write-ahead-log recovery added for
      // BUGS_FOUND.md P-1 was dead code in production — every agent
      // crash between the sign step and the chain confirmation
      // left the tentative KC unrecoverable, and the ChainEvent-
      // Poller's WAL-drain path (r24-4 / r25-1) had nothing to
      // match against. When `dataDir` is unset (pure in-memory
      // agents, integration fixtures) we leave it `undefined` and
      // fall back to the in-memory journal as before.
      publishWalFilePath: config.dataDir ? pathJoin(config.dataDir, 'publish-wal', 'agent.jsonl') : undefined,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} shared memory ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct shared memory ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    await this.node.start();
    this.started = true;
    this.log.info(ctx, `Node started, peer ID: ${this.node.peerId.toString()}`);

    // Load registered agents from triple store; auto-register default if none exist.
    // loadAgentsFromStore restores defaultAgentAddress from the persisted
    // isDefaultAgent marker, avoiding reliance on SPARQL result ordering.
    await this.loadAgentsFromStore();
    if (this.localAgents.size === 0) {
      await this.autoRegisterDefaultAgent();
    }
    if (!this.defaultAgentAddress && this.localAgents.size > 0) {
      // Fallback: no persisted marker — pick first and persist for next boot
      const first = this.localAgents.values().next().value!;
      this.defaultAgentAddress = first.agentAddress;
      await this.markDefaultAgent(first.agentAddress).catch(() => {});
    }

    this.router = new ProtocolRouter(this.node);
    this.gossip = new GossipSubManager(this.node, this.eventBus);

    // Register protocol handlers
    const accessHandler = new AccessHandler(this.store, this.eventBus);
    this.router.register(PROTOCOL_ACCESS, accessHandler.handler);

    const journal = this.config.dataDir ? new PublishJournal(this.config.dataDir) : undefined;
    const publishHandler = new PublishHandler(this.store, this.eventBus, { journal });
    this.router.register(PROTOCOL_PUBLISH, publishHandler.handler);
    if (journal) {
      try {
        await publishHandler.restorePendingPublishes();
      } catch (err) {
        this.log.warn(ctx, `Journal restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cross-agent query handler (deny-by-default for security)
    const queryAccessConfig: QueryAccessConfig = this.config.queryAccess ?? {
      defaultPolicy: 'deny',
    };
    if (this.config.queryAccess?.defaultPolicy === 'public') {
      this.log.warn(ctx, 'Query access policy is "public" — all remote queries will be accepted. Set queryAccess.defaultPolicy to "deny" for stricter security.');
    }
    const queryRemoteHandler = new QueryHandler(this.queryEngine, queryAccessConfig);
    this.router.register(PROTOCOL_QUERY_REMOTE, queryRemoteHandler.handler);

    const effectiveRole = this.config.nodeRole ?? 'edge';

    // Auto-detect or register on-chain identity.
    // Edge nodes skip profile creation — they operate with agent identity only.
    if (this.chain.chainId !== 'none') {
      let identityId = 0n;
      try {
        identityId = await this.chain.getIdentityId();
        if (identityId === 0n && effectiveRole === 'core') {
          this.log.info(ctx, `No on-chain identity found, creating profile and staking...`);
          identityId = await this.chain.ensureProfile({
            nodeName: this.config.name,
          });
          this.log.info(ctx, `On-chain profile created, identityId=${identityId}`);
        } else if (identityId === 0n) {
          this.log.info(ctx, `Edge node — skipping on-chain profile creation (agent identity only)`);
        } else {
          this.log.info(ctx, `On-chain identity found: identityId=${identityId}`);
        }
      } catch (err) {
        this.log.warn(ctx, `ensureProfile error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          identityId = await this.chain.getIdentityId();
          if (identityId > 0n) {
            this.log.info(ctx, `Recovered identityId=${identityId} after partial failure`);
          }
        } catch { /* ignore */ }
      }
      if (identityId > 0n) {
        this.publisher.setIdentityId(identityId);
        this.log.info(ctx, `Publisher using identityId=${identityId}`);
      } else if (effectiveRole === 'core') {
        this.log.warn(ctx, `No valid on-chain identity — on-chain publishes will be skipped`);
      }
    }

    // Register V10 StorageACK handler AFTER ensureProfile so identity is resolved.
    // Only core nodes register the StorageACK handler — edge nodes cannot
    // sign ACKs (the handler would reject immediately) and advertising the
    // protocol confuses peer-role detection based on protocol support.
    if (effectiveRole === 'core') {
      const ackSignerKeyStr = this.config.ackSignerKey
        ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined);
      if (ackSignerKeyStr) {
        try {
          const ackSignerWallet = new ethers.Wallet(ackSignerKeyStr);
          const identityId = await this.chain.getIdentityId();
          if (identityId > 0n) {
            // The V10 ACK digest includes a (chainid, kav10Address) H5 prefix
            // per KnowledgeAssetsV10.sol:362-373. Resolve both from the chain
            // adapter BEFORE constructing the handler so the handler can sign
            // digests that actually verify on-chain. The handler itself has
            // no provider-backed dependency, so both values are passed in at
            // construction.
            const chainIdForHandler = typeof this.chain.getEvmChainId === 'function'
              ? await this.chain.getEvmChainId()
              : undefined;
            const kav10AddressForHandler = typeof this.chain.getKnowledgeAssetsV10Address === 'function'
              ? await this.chain.getKnowledgeAssetsV10Address()
              : undefined;
            if (chainIdForHandler === undefined || kav10AddressForHandler === undefined) {
              this.log.warn(
                ctx,
                `Skipping V10 StorageACK handler: chain adapter does not expose ` +
                `getEvmChainId() + getKnowledgeAssetsV10Address(); handler cannot build the ` +
                `H5-prefixed ACK digest that KnowledgeAssetsV10 verifies on-chain`,
              );
            } else {
              const ackHandler = new StorageACKHandler(this.store, {
                nodeRole: effectiveRole,
                nodeIdentityId: typeof identityId === 'bigint' ? identityId : BigInt(identityId),
                signerWallet: ackSignerWallet,
                contextGraphSharedMemoryUri,
                chainId: chainIdForHandler,
                kav10Address: kav10AddressForHandler,
              }, this.eventBus);
              this.router.register(PROTOCOL_STORAGE_ACK, ackHandler.handler);
              this.log.info(ctx, `Registered V10 StorageACK handler (identity=${identityId})`);
            }
          } else {
            this.log.warn(ctx, `Skipping V10 StorageACK handler registration — identity not yet provisioned`);
          }
        } catch (err) {
          this.log.warn(ctx, `Skipping V10 StorageACK handler: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (typeof this.chain.signACKDigest === 'function') {
        this.log.info(ctx, `V10 StorageACK: adapter has signACKDigest but no extractable key — handler registration deferred until callback signing is supported`);
      }
    } else {
      this.log.info(ctx, `Node role is '${effectiveRole}' — skipping StorageACK handler registration (core-only)`);
    }

    // Register VERIFY proposal handler — responds to incoming M-of-N proposals.
    // Agents on the allowList sign the verify digest when they agree with the data.
    // Uses the ACK signer key (core nodes) or first operational key (edge nodes).
    const verifySignerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (verifySignerKey) {
      const verifyWallet = new ethers.Wallet(verifySignerKey);
      const verifyHandler = new VerifyProposalHandler({
        store: this.store,
        agentPrivateKey: verifySignerKey,
        agentAddress: verifyWallet.address,
        getBatchMerkleRoot: async (cgId: string, batchId: bigint) => {
          const metaGraph = paranetMetaGraphUri(cgId);
          // Try typed literal first, fallback to untyped for backward compat
          for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
            const result = await this.store.query(
              `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
            );
            if (result.type === 'bindings' && result.bindings.length > 0) {
              const hex = (result.bindings[0] as Record<string, string>)['root'];
              if (!hex) return null;
              return ethers.getBytes(hex.startsWith('"') ? hex.slice(1, -1) : hex);
            }
          }
          return null;
        },
        getContextGraphIdOnChain: async (cgId: string) => {
          const sub = this.subscribedContextGraphs.get(cgId);
          return sub?.onChainId ? BigInt(sub.onChainId) : null;
        },
      });
      this.router.register(PROTOCOL_VERIFY_PROPOSAL, verifyHandler.handler);
      this.log.info(ctx, 'Registered VERIFY proposal handler');
    }

    // Start chain event poller for trustless confirmation of tentative publishes
    // and discovery of on-chain context graphs. Only with a real chain adapter.
    if (this.chain.chainId !== 'none') {
      this.chainPoller = new ChainEventPoller({
        chain: this.chain,
        publishHandler,
        // r21-5 (PR #229 bot review, post-v10-rc-merge): wire the
        // publisher's WAL reconciler so chain confirmations that
        // arrive after a process restart actually drain the
        // pre-broadcast journal. Without this, `recoverFromWalByMerkleRoot`
        // had no runtime caller and surviving WAL entries
        // accumulated forever (the original P-1 finding).
        onUnmatchedBatchCreated: async ({ merkleRoot, publisherAddress, startKAId, endKAId }) => {
          const merkleRootHex = ethers.hexlify(merkleRoot);
          const recovered = await this.publisher.recoverFromWalByMerkleRoot(
            merkleRootHex,
            { publisherAddress, startKAId, endKAId },
            ctx,
          );
          return recovered !== undefined;
        },
        // PR #229 bot review (r3148... — chain-event-poller.ts:271).
        // The agent installs `onUnmatchedBatchCreated` for every
        // node, but a brand-new node has nothing in its journal and
        // should NOT scan from genesis on first boot. Expose the
        // live journal length as the WAL-presence signal so the
        // poller's seed-near-tip decision tracks reality, not
        // callback installation.
        hasRecoverableWal: () => this.publisher.preBroadcastJournal.length > 0,
        onContextGraphCreated: async ({ contextGraphId, creator, accessPolicy, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain context graph ${contextGraphId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy})`);

          // Track the hash for dedup but don't pollute subscribedContextGraphs.
          // Gossip topics are keyed by cleartext name, not the on-chain hash.
          // The context graph will be fully subscribed once ontology sync or
          // discoverContextGraphsFromChain resolves the cleartext name.
          const alreadyKnown = this.seenOnChainIds.has(contextGraphId)
            || [...this.subscribedContextGraphs.values()].some(s => s.onChainId === contextGraphId);
          if (!alreadyKnown) {
            this.seenOnChainIds.add(contextGraphId);
            this.log.info(ctx, `Noted on-chain context graph ${contextGraphId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
          }
        },
      });
      this.chainPoller.start();
      this.log.info(ctx, `Chain event poller started`);
    }

    // Set up messaging
    const x25519Priv = ed25519ToX25519Private(this.wallet.keypair.secretKey);
    this.messageHandler = new MessageHandler(
      this.router,
      this.wallet.keypair,
      x25519Priv,
      this.node.peerId,
      this.eventBus,
    );

    // Wire up pending chat handler
    if (this._pendingChatHandler) {
      this.messageHandler.onChat(this._pendingChatHandler);
      this._pendingChatHandler = null;
    }

    // Register skill handlers
    if (this.config.skills) {
      for (const skill of this.config.skills) {
        const uri = `https://dkg.origintrail.io/skill#${skill.skillType}`;
        this.messageHandler.registerSkill(uri, skill.handler);
      }
    }

    registerSyncHandler({
      router: this.router,
      protocolSync: PROTOCOL_SYNC,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      syncPageSize: SYNC_PAGE_SIZE,
      sharedMemoryTtlMs: this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS,
      store: this.store,
      peerId: this.peerId,
      parseSyncRequest: this.parseSyncRequest.bind(this),
      authorizeSyncRequest: this.authorizeSyncRequest.bind(this),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logDebug: (ctx, message) => this.log.debug(ctx, message),
    });

    // Join-request protocol: receives signed join requests forwarded by peers.
    // Stores them locally if this node is the curator; ACKs with "ok" or "error".
    this.router.register(PROTOCOL_JOIN_REQUEST, async (data, peerId) => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(data));

        // Handle "join-approved" notifications from curator → requester.
        // Only process if this node owns the target agentAddress.
        if (payload.type === 'join-approved') {
          const { contextGraphId, agentAddress: approvedAddr } = payload;
          if (contextGraphId) {
            const isLocalAgent = approvedAddr && [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === approvedAddr.toLowerCase(),
            );
            if (approvedAddr && !isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            this.preferredSyncPeers.set(contextGraphId, peerId.toString());
            this.log.info(createOperationContext('system'), `Join request approved for "${contextGraphId}" — auto-subscribing`);
            this.subscribeToContextGraph(contextGraphId);
            this.syncContextGraphFromConnectedPeers(contextGraphId, { includeSharedMemory: true }).catch(() => {});
            this.eventBus.emit(DKGEvent.JOIN_APPROVED, {
              contextGraphId,
              agentAddress: approvedAddr,
            });
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        // Handle "join-rejected" notifications from curator → requester.
        // Symmetric to join-approved: filter by localAgents and emit an
        // event so the UI can surface a notification instead of leaving
        // the invitee's Join modal stuck on "Join request sent…" forever.
        //
        // We deliberately do NOT mutate local subscription/ACL state —
        // cleanup of phantom auto-discovery is left to the daemon's
        // catch-up denial path, which is gated on the curator's actual
        // ACL response.
        if (payload.type === 'join-rejected') {
          const { contextGraphId, agentAddress: rejectedAddr } = payload;
          if (!contextGraphId || !rejectedAddr) {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          // The rejection target must be one of our local agents (Codex
          // tier-4h N14). This alone isn't enough though: a malicious
          // peer that knows a target's agent address can still forge a
          // rejection for any CG, driving our UI into a false "denied"
          // state. So also require the SENDER to be the CG's curator
          // — Codex tier-4k N27. The sender's peer ID is passed in by
          // the router; we match it against the CG's recorded curator
          // DID (direct peer-ID DID for legacy CGs) or, for
          // wallet-scoped curators, the current peer ID published by
          // the curator agent in the registry. Anything else is
          // dropped with a short `skipped` ACK.
          const isLocalAgent = [...this.localAgents.keys()].some(
            (addr) => addr.toLowerCase() === rejectedAddr.toLowerCase(),
          );
          if (!isLocalAgent) {
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          const senderIsCurator = await this.senderIsContextGraphCurator(contextGraphId, peerId.toString());
          if (!senderIsCurator) {
            this.log.warn(
              createOperationContext('system'),
              `Dropping join-rejected for "${contextGraphId}" from ${peerId.toString()} — sender is not the CG curator`,
            );
            return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
          }
          this.log.info(createOperationContext('system'), `Join request rejected for "${contextGraphId}"`);
          this.eventBus.emit(DKGEvent.JOIN_REJECTED, {
            contextGraphId,
            agentAddress: rejectedAddr,
          });
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        const { contextGraphId, agentAddress, signature, timestamp, agentName } = payload;
        if (!contextGraphId || !agentAddress || !signature || !timestamp) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
        // Only store if this node is the curator (creator) of the CG
        const owner = await this.getContextGraphOwner(contextGraphId);
        if (!owner) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'unknown CG' }));
        }
        const selfDid = `did:dkg:agent:${this.peerId}`;
        const selfAgentDid = this.defaultAgentAddress ? `did:dkg:agent:${this.defaultAgentAddress}` : null;
        const isCurator = owner === selfDid ||
          (selfAgentDid && owner === selfAgentDid) ||
          [...this.localAgents.keys()].some((addr) => owner === `did:dkg:agent:${addr}`);
        if (!isCurator) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'not curator' }));
        }
        this.verifyJoinRequest(contextGraphId, agentAddress, timestamp, signature);
        await this.storePendingJoinRequest(contextGraphId, agentAddress, signature, timestamp, agentName);
        // Remember which peer actually delivered this request so we can
        // send approval/rejection back to the same peer later, even if
        // the agent registry hasn't indexed them yet.
        this.joinRequestOriginPeers.set(
          `${contextGraphId}::${agentAddress.toLowerCase()}`,
          peerId.toString(),
        );
        this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
          contextGraphId,
          agentAddress,
          agentName,
        });
        return new TextEncoder().encode(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new TextEncoder().encode(JSON.stringify({ ok: false, error: msg }));
      }
    });

    // Subscribe to both system context graph GossipSub topics
    for (const systemContextGraph of [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY]) {
      this.subscribeToContextGraph(systemContextGraph);
    }

    // Connect to bootstrap peers
    if (this.config.bootstrapPeers) {
      for (const addr of this.config.bootstrapPeers) {
        try {
          await this.node.libp2p.dial(multiaddr(addr));
        } catch {
          // Bootstrap peer may be unreachable
        }
      }
    }

    // On new peer connection, request sync of system context graphs so we discover
    // agents that published their profiles before we came online.
    // Wait for protocol identification to complete, then only sync with
    // peers that actually support the sync protocol (skips raw relay nodes).
    const handleSyncError = (remotePeer: string, err: unknown): void => {
      const shortPeer = remotePeer.slice(-8);
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Sync-on-connect failed for ${shortPeer}: ${message}`);
    };

    // Single source of truth for "new or reconnecting peer → trigger
    // catch-up sync": the `connection:open` listener below. It fires
    // both on the first connection to a new peer AND on every
    // subsequent reconnect for that same peer, so it fully subsumes
    // `peer:connect`. Registering both produced a double-queued
    // `trySyncFromPeer` for every new peer (one from each handler),
    // doubling initial catch-up traffic and racing the sync/store
    // path on first-contact peers. Codex tier-4g finding on this line.
    this.node.libp2p.addEventListener('connection:open', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const now = Date.now();
      const last = this.catchupOnConnectAt.get(remotePeer) ?? 0;
      if (now - last < CATCHUP_ON_CONNECT_COOLDOWN_MS) return;
      this.catchupOnConnectAt.set(remotePeer, now);
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    });

    // Clear the per-peer cooldown timestamp when the last live connection
    // to a peer is torn down. The cooldown's job is to dedupe overlapping
    // `connection:open` bursts (libp2p can fire more than one when
    // multiple transports come up for the same peer within a few hundred
    // ms). Without this close handler, a peer that dropped and
    // reconnected 10–20s later — exactly the flaky-relay case this
    // catch-up hook is meant to repair — would be silently skipped for
    // up to a minute, so catch-up would stall until some other trigger
    // fires. `connection:close` fires per connection, so we only forget
    // the timestamp once no live connection to the peer remains. Codex
    // tier-4i finding at packages/agent/src/dkg-agent.ts:1105.
    this.node.libp2p.addEventListener('connection:close', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const stillConnected = this.node.libp2p
        .getPeers()
        .some((p) => p.toString() === remotePeer);
      if (stillConnected) return;
      this.catchupOnConnectAt.delete(remotePeer);
    });

    // Reconnect-on-gossip: when a gossip message arrives from a peer we're
    // not currently connected to, best-effort dial them. This catches the
    // case where two NAT'd edge nodes briefly lose their direct path but
    // gossipsub still routes their messages to each other via the mesh —
    // the arriving message is both proof-of-life *and* a cheap trigger to
    // rebuild the direct link so subsequent sync requests have a path.
    this.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (data) => {
      const from = (data as { from?: string })?.from;
      if (!from || from === 'unknown') return;
      this.maybeDialGossipSender(from).catch(() => {
        // Swallow: reconnect-on-gossip is best-effort; failures are already
        // logged inside the method and we don't want to disrupt gossip
        // delivery if a single peer happens to be unreachable.
      });
    });

    // Sync from peers already connected (e.g. relay dialed during node.start())
    const alreadyConnected = this.node.libp2p.getPeers();
    for (const pid of alreadyConnected) {
      const remotePeer = pid.toString();
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    }

    // Start periodic shared memory cleanup
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl > 0) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    }
  }

  /**
   * Pull all triples for the given context graphs from a remote peer and merge
   * them into our local store. Used on peer:connect for initial catch-up,
   * with a per-peer guard to avoid overlapping sync storms.
   */
  private async trySyncFromPeer(remotePeer: string): Promise<void> {
    if (!this.started) {
      return;
    }
    return runSyncOnConnect({
      remotePeer,
      syncingPeers: this.syncingPeers,
      getPeerProtocols: (peerId) => this.getPeerProtocols(peerId),
      knownCorePeerIds: this.knownCorePeerIds,
      getSyncContextGraphs: () => this.config.syncContextGraphs ?? [],
      syncFromPeer: (peerId, contextGraphIds) => this.syncFromPeer(peerId, contextGraphIds),
      refreshMetaSyncedFlags: (contextGraphIds) => this.refreshMetaSyncedFlags(contextGraphIds),
      discoverContextGraphsFromStore: () => this.discoverContextGraphsFromStore(),
      syncSharedMemoryFromPeer: (peerId, contextGraphIds) => this.syncSharedMemoryFromPeer(peerId, contextGraphIds),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    });
  }

  /**
   * Reconnect-on-gossip: ensure we have a live libp2p path to the sender of
   * a gossip message we just received. GossipSub delivers messages signed by
   * their original publisher, so `from` is the author regardless of how many
   * mesh hops the message took to reach us — making it a reliable signal
   * that the author is online *right now*.
   *
   * Why: two edge nodes behind NAT can briefly lose their direct circuit
   * without either side noticing until the next publish fails. By reacting
   * to incoming gossip with an opportunistic dial, we restore the path long
   * before the application-layer sync protocol is invoked.
   *
   * Best-effort only: we try peerStore-known multiaddrs first, then fall
   * back to constructing `/p2p-circuit` multiaddrs through each configured
   * relay. Failures are logged but never surface to the caller.
   */
  private async maybeDialGossipSender(peerIdStr: string): Promise<void> {
    const selfPeerId = this.node.libp2p.peerId.toString();
    if (peerIdStr === selfPeerId) return;

    // Already connected → nothing to do.
    const connected = this.node.libp2p.getPeers().some(p => p.toString() === peerIdStr);
    if (connected) return;

    // Cooldown: a single chatty CG can produce many gossip messages/second.
    // One dial-attempt per peer per GOSSIP_DIAL_COOLDOWN_MS is enough.
    const now = Date.now();
    const last = this.gossipDialAttemptedAt.get(peerIdStr) ?? 0;
    if (now - last < GOSSIP_DIAL_COOLDOWN_MS) return;
    this.gossipDialAttemptedAt.set(peerIdStr, now);

    const ctx = createOperationContext('connect');
    const shortPeer = peerIdStr.slice(-8);

    const { peerIdFromString } = await import('@libp2p/peer-id');
    let peerId: ReturnType<typeof peerIdFromString>;
    try {
      peerId = peerIdFromString(peerIdStr);
    } catch (err) {
      this.log.warn(ctx, `Skipping gossip redial for invalid peer id ${shortPeer}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // First pass: let libp2p try whatever addresses it already knows about
    // for this peer (direct multiaddrs from identify, previous relay
    // addresses from peerStore, etc.).
    try {
      await this.node.libp2p.dial(peerId, { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) });
      this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via peerStore`);
      return;
    } catch (err) {
      this.log.info(ctx, `Reconnect-on-gossip: peerStore dial to ${shortPeer} failed (${err instanceof Error ? err.message : String(err)}); trying relay fallbacks`);
    }

    // Relay fallback: for each configured relay, construct an explicit
    // circuit-relay multiaddr and dial. The first relay with a valid
    // reservation for the sender wins.
    const relays = this.config.relayPeers ?? [];
    for (const relayAddr of relays) {
      const circuitAddr = `${relayAddr}/p2p-circuit/p2p/${peerIdStr}`;
      try {
        await this.node.libp2p.dial(
          multiaddr(circuitAddr),
          { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) },
        );
        this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via ${relayAddr.slice(-16)}`);
        return;
      } catch {
        // Try next relay. We don't log per-relay failures at INFO to avoid
        // log spam when a peer simply has no reservation anywhere right now.
      }
    }

    this.log.info(ctx, `Reconnect-on-gossip: no path to ${shortPeer} via peerStore or ${relays.length} relay(s); will retry after cooldown`);
  }

  /**
   * Pull triples for the given context graphs from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   *
   * Meta and data are fetched in separate pagination loops so that neither
   * response can exceed the 10 MB stream read limit.
   */
  async syncFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<number> {
    const result = await this.syncFromPeerDetailed(remotePeerId, contextGraphIds, onPhase, onAccessDenied);
    return result.insertedTriples;
  }

  private async syncFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<DurableSyncResult> {
    const ctx = createOperationContext('sync');
    return runDurableSync({
      ctx,
      remotePeerId,
      contextGraphIds,
      onPhase,
      onAccessDenied,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
      fetchSyncPages: this.fetchSyncPages.bind(this),
      processDurableBatchInWorker: this.processDurableBatchInWorker.bind(this),
      storeInsert: (quads) => this.store.insert(quads),
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  /**
   * Paginate through sync pages for a single graph (data or meta).
   * Uses buildSyncRequest to produce authenticated requests for private CGs.
   */
  private async fetchSyncPages(
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
  ): Promise<SyncPageResult> {
    return fetchSyncPages({
      ctx,
      remotePeerId,
      contextGraphId,
      includeSharedMemory,
      phase,
      graphUri,
      deadline,
      syncPageTimeoutMs: SYNC_PAGE_TIMEOUT_MS,
      syncRouterAttempts: SYNC_ROUTER_ATTEMPTS,
      syncPageRetryAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
      syncPageSize: SYNC_PAGE_SIZE,
      syncDeniedResponse: SYNC_DENIED_RESPONSE,
      // Legacy sentinel that older (pre-v10-rc) responders still emit on ACL
      // denial. Recognising it in the requester is what keeps mixed-version
      // catch-up correct: without the second sentinel, a curated-CG denial
      // from a legacy peer would be parsed as N-quads, yield 0 triples, and
      // silently get misclassified as "nothing to sync" instead of flipping
      // `deniedPhases`. See also dkg-agent.ts's dual-sentinel response path
      // and the `_extraDeniedResponses` option on `fetchSyncPages` (tier-4 G1).
      extraDeniedResponses: [SYNC_ACCESS_DENIED_MARKER],
      debugSyncProgress: DEBUG_SYNC_PROGRESS,
      protocolSync: PROTOCOL_SYNC,
      checkpointStore: this.syncCheckpoints,
      buildSyncRequest: this.buildSyncRequest.bind(this),
      parseAndFilter: (nquadsText, targetGraphUri, targetContextGraphId) => this.getOrCreateSyncVerifyWorker().parseAndFilter(nquadsText, targetGraphUri, targetContextGraphId),
      send: (peerId, protocolId, data, sendTimeoutMs) => this.router.send(peerId, protocolId, data, sendTimeoutMs),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  /**
   * Pull shared memory triples for the given context graphs from a remote peer.
   * SWM data is not merkle-verified (no chain finality) — it is
   * accepted as-is and merged into the local shared memory + SWM meta graphs.
   * The workspaceOwnedEntities set is updated so Rule 4 stays consistent.
   */
  async syncSharedMemoryFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [...(this.config.syncContextGraphs ?? [])],
  ): Promise<number> {
    const result = await this.syncSharedMemoryFromPeerDetailed(remotePeerId, contextGraphIds);
    return result.insertedTriples;
  }

  private async syncSharedMemoryFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
  ): Promise<SharedMemorySyncResult> {
    const ctx = createOperationContext('sync');
    return runSharedMemorySync({
      ctx,
      remotePeerId,
      contextGraphIds,
      createContextGraphSyncDeadline: this.createContextGraphSyncDeadline.bind(this),
      fetchSyncPages: this.fetchSyncPages.bind(this),
      processSharedMemoryBatch: (wsDataQuads, wsMetaQuads) => this.getOrCreateSyncVerifyWorker().processSharedMemoryBatch(wsDataQuads, wsMetaQuads),
      ensureParanet: async (contextGraphId) => {
        const graphManager = new GraphManager(this.store);
        await graphManager.ensureParanet(contextGraphId);
      },
      storeInsert: (quads) => this.store.insert(quads),
      deleteCheckpoint: (key) => this.syncCheckpoints.delete(key),
      setCheckpoint: (key, offset) => this.syncCheckpoints.set(key, offset),
      ensureOwnedMap: (contextGraphId) => {
        if (!this.workspaceOwnedEntities.has(contextGraphId)) {
          this.workspaceOwnedEntities.set(contextGraphId, new Map());
        }
        return this.workspaceOwnedEntities.get(contextGraphId)!;
      },
      logInfo: (opCtx, message) => this.log.info(opCtx, message),
      logWarn: (opCtx, message) => this.log.warn(opCtx, message),
      logDebug: (opCtx, message) => this.log.debug(opCtx, message),
    });
  }

  private createContextGraphSyncDeadline(remainingContextGraphs: number): number {
    const divisor = Math.max(1, remainingContextGraphs);
    const budgetMs = Math.max(SYNC_MIN_GRAPH_BUDGET_MS, Math.floor(SYNC_TOTAL_TIMEOUT_MS / divisor));
    return Date.now() + budgetMs;
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(
    contextGraphId: string,
    options?: { includeSharedMemory?: boolean },
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    dataSynced: number;
    sharedMemorySynced: number;
    /**
     * `true` iff at least one peer in this run explicitly denied the sync
     * by emitting a denial sentinel (`syncDenied` marker raised from
     * `sync/requester/page-fetch.ts`, rolled up via `deniedPhases`). Kept
     * as a boolean instead of v10-rc-style `accessDeniedPeers: number`
     * because the daemon catchup-status endpoint only ever cared about
     * "any peer denied us?"; see `cli/src/daemon.ts` subscribe job.
     * Replaces the pre-refactor per-peer `accessDeniedPeers` counter.
     */
    denied: boolean;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    const includeSharedMemory = options?.includeSharedMemory ?? false;
    const isPrivateContextGraph = await this.isPrivateContextGraph(contextGraphId);

    this.trackSyncContextGraph(contextGraphId);

    const preferredPeerId = await this.resolvePreferredSyncPeerId(contextGraphId);
    if (preferredPeerId) {
      await this.ensurePeerConnected(preferredPeerId);
    }

    await this.primeCatchupConnections();

    const peers = this.selectCatchupPeers(
      [...new Map(
        this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
      ).values()],
      preferredPeerId,
      isPrivateContextGraph,
    );
    return this.runCatchupOverPeers(contextGraphId, includeSharedMemory, peers);
  }

  private async runCatchupOverPeers(
    contextGraphId: string,
    includeSharedMemory: boolean,
    peers: Array<{ toString(): string }>,
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    dataSynced: number;
    sharedMemorySynced: number;
    denied: boolean;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    let syncCapablePeers = 0;
    let peersTried = 0;
    let dataSynced = 0;
    let sharedMemorySynced = 0;
    let noProtocolPeers = 0;
    const diagnostics: CatchupSyncDiagnostics = {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      },
    };

    if (DEBUG_SYNC_PROGRESS) {
      this.log.info(
        ctx,
        `Catch-up peer set for "${contextGraphId}": ${peers.map((peer) => peer.toString()).join(', ') || 'none'}`,
      );
    }

    // Phase 1: probe all peers for PROTOCOL_SYNC support serially. This is
    // cheap (peerStore lookup / waitForPeerProtocol), but we keep it a
    // separate pass so Phase 2's Promise.all only kicks off peers we know
    // can serve us — parallel-probing would multiply connection churn for
    // no gain. See the "Run per-peer syncs in parallel" comment below.
    const syncCapable: string[] = [];
    for (const pid of peers) {
      if (DEBUG_SYNC_PROGRESS) {
        this.log.info(ctx, `Checking sync protocol for peer ${pid.toString()} in catch-up for "${contextGraphId}"`);
      }
      const hasSync = await this.waitForSyncProtocol(pid);
      if (!hasSync) {
        noProtocolPeers++;
        if (DEBUG_SYNC_PROGRESS) {
          this.log.warn(ctx, `Peer ${pid.toString()} is connected but not sync-capable for "${contextGraphId}"`);
        }
        continue;
      }
      syncCapable.push(pid.toString());
    }
    syncCapablePeers = syncCapable.length;
    peersTried = syncCapable.length;

    // Run per-peer syncs in parallel. Without parallelism a curated CG
    // denial walks the whole peer set sequentially with 30s+ timeouts
    // each, causing the /api/subscribe catchup job to take minutes to
    // report denial and the UI to give up. We feed per-peer results into
    // v10-rc's new diagnostics shape (bytesReceived / resumedPhases /
    // deniedPhases, from `runDurableSync`), then translate `deniedPhases`
    // into HEAD's `accessDeniedPeers` counter so the existing daemon
    // catchup-status endpoint and UI keep working — see
    // `cli/src/daemon.ts` subscribe job and `catchup-runner.ts`.
    const emptyDurable = (): DurableSyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 1,
      deniedPhases: 0,
    });
    const emptyShared = (): SharedMemorySyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 1,
      deniedPhases: 0,
    });
    const results = await Promise.all(syncCapable.map(async (remotePeerId) => {
      const durable = await this.syncFromPeerDetailed(
        remotePeerId,
        [contextGraphId],
      ).catch(emptyDurable);
      const shared = includeSharedMemory
        ? await this.syncSharedMemoryFromPeerDetailed(remotePeerId, [contextGraphId]).catch(emptyShared)
        : null;
      return { durable, shared };
    }));
    let accessDeniedPeers = 0;
    for (const r of results) {
      dataSynced += r.durable.insertedTriples;
      diagnostics.durable.fetchedMetaTriples += r.durable.fetchedMetaTriples;
      diagnostics.durable.fetchedDataTriples += r.durable.fetchedDataTriples;
      diagnostics.durable.insertedMetaTriples += r.durable.insertedMetaTriples;
      diagnostics.durable.insertedDataTriples += r.durable.insertedDataTriples;
      diagnostics.durable.bytesReceived += r.durable.bytesReceived;
      diagnostics.durable.resumedPhases += r.durable.resumedPhases;
      diagnostics.durable.emptyResponses += r.durable.emptyResponses;
      diagnostics.durable.metaOnlyResponses += r.durable.metaOnlyResponses;
      diagnostics.durable.dataRejectedMissingMeta += r.durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += r.durable.rejectedKcs;
      diagnostics.durable.failedPeers += r.durable.failedPeers;
      let peerDenied = r.durable.deniedPhases > 0;
      if (r.shared) {
        sharedMemorySynced += r.shared.insertedTriples;
        diagnostics.sharedMemory.fetchedMetaTriples += r.shared.fetchedMetaTriples;
        diagnostics.sharedMemory.fetchedDataTriples += r.shared.fetchedDataTriples;
        diagnostics.sharedMemory.insertedMetaTriples += r.shared.insertedMetaTriples;
        diagnostics.sharedMemory.insertedDataTriples += r.shared.insertedDataTriples;
        diagnostics.sharedMemory.bytesReceived += r.shared.bytesReceived;
        diagnostics.sharedMemory.resumedPhases += r.shared.resumedPhases;
        diagnostics.sharedMemory.emptyResponses += r.shared.emptyResponses;
        diagnostics.sharedMemory.droppedDataTriples += r.shared.droppedDataTriples;
        diagnostics.sharedMemory.failedPeers += r.shared.failedPeers;
        peerDenied = peerDenied || r.shared.deniedPhases > 0;
      }
      if (peerDenied) accessDeniedPeers++;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers}`,
    );

    await this.refreshMetaSyncedFlags([contextGraphId]);

    if (dataSynced > 0 || sharedMemorySynced > 0) {
      this.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        dataSynced,
        sharedMemorySynced,
      });
    }

    return {
      connectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      dataSynced,
      sharedMemorySynced,
      denied: accessDeniedPeers > 0,
      diagnostics,
    };
  }

  private async primeCatchupConnections(): Promise<void> {
    await primeCatchupConnectionsAtom(this.node.libp2p as any, this.discovery, this.peerId);
  }

  private selectCatchupPeers(
    peers: Array<{ toString(): string }>,
    preferredPeerId?: string,
    privateOnly = false,
  ): Array<{ toString(): string }> {
    return orderCatchupPeers(peers, preferredPeerId, privateOnly);
  }

  private async resolvePreferredSyncPeerId(contextGraphId: string): Promise<string | undefined> {
    const preferredPeerId = this.preferredSyncPeers.get(contextGraphId);
    if (preferredPeerId) return preferredPeerId;

    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (curatorPeerId) {
      this.preferredSyncPeers.set(contextGraphId, curatorPeerId);
    }
    return curatorPeerId;
  }

  private async ensurePeerConnected(peerId: string): Promise<void> {
    await ensurePeerConnectedAtom(this.node.libp2p as any, this.discovery, peerId);
  }

  private async waitForSyncProtocol(pid: { toString(): string }): Promise<boolean> {
    return waitForPeerProtocol(
      this.node.libp2p.peerStore as any,
      pid,
      PROTOCOL_SYNC,
      SYNC_PROTOCOL_CHECK_ATTEMPTS,
      SYNC_PROTOCOL_CHECK_DELAY_MS,
    );
  }

  private async refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void> {
    for (const contextGraphId of contextGraphIds) {
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      if (!sub || sub.metaSynced === true) continue;
      if (await this.hasConfirmedMetaState(contextGraphId)) {
        sub.metaSynced = true;
      }
    }
  }

  private async hasConfirmedMetaState(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_PARANETS) as string[]).includes(contextGraphId)) {
      return true;
    }

    const metaGraph = paranetMetaGraphUri(contextGraphId);
    const metaResult = await this.store.query(
      `ASK WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (metaResult.type === 'boolean' && metaResult.value === true) {
      return true;
    }

    // Ontology-only fallback: a CG declared `rdf:type dkg:Paranet` can be
    // treated as confirmably-public for the gossip race-opener ONLY when
    // no local evidence of a restriction exists. Raw paranet declaration
    // is not enough on its own — `inviteToContextGraph` writes
    // `dkg:allowedPeer` straight to `_meta` without updating ontology, so
    // a CG that was announced publicly and later allowlisted would look
    // "just a paranet" here even though the curator expects the allowlist
    // to gate gossip. Require `isPrivateContextGraph()` (now also reads
    // `DKG_ALLOWED_PEER`) to explicitly return false before honoring the
    // bypass.
    if (await this.isPrivateContextGraph(contextGraphId)) {
      return false;
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const contextGraphUri = paranetDataGraphUri(contextGraphId);
    const ontologyResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
        }
      }`,
    );
    return ontologyResult.type === 'boolean' && ontologyResult.value === true;
  }

  private async verifySyncedDataInWorker(
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
  ): Promise<{ data: Quad[]; meta: Quad[]; rejected: number }> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.verify(dataQuads, metaQuads, acceptUnverified);
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return { data: result.data, meta: result.meta, rejected: result.rejected };
  }

  private async processDurableBatchInWorker(
    dataQuads: Quad[],
    metaQuads: Quad[],
    ctx: OperationContext,
    acceptUnverified = false,
  ): Promise<import('./sync-verify-worker.js').DurableBatchProcessResult> {
    const worker = this.getOrCreateSyncVerifyWorker();
    const result = await worker.processDurableBatch(dataQuads, metaQuads, acceptUnverified);
    for (const entry of result.logs) {
      if (entry.level === 'warn') this.log.warn(ctx, entry.message);
      else this.log.debug(ctx, entry.message);
    }
    return result;
  }

  private getOrCreateSyncVerifyWorker(): SyncVerifyWorker {
    if (!this.syncVerifyWorker) {
      this.syncVerifyWorker = new SyncVerifyWorker();
    }
    return this.syncVerifyWorker;
  }

  /**
   * Update the shared memory TTL at runtime. Takes effect immediately for queries
   * and the next cleanup cycle without requiring a restart.
   */
  setSharedMemoryTtlMs(ttlMs: number): void {
    const oldTtl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    (this.config as any).sharedMemoryTtlMs = ttlMs;

    if (oldTtl <= 0 && ttlMs > 0 && !this.swmCleanupTimer) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    } else if (ttlMs <= 0 && this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
  }

  /**
   * Remove expired shared memory operations and their data.
   * Queries SWM meta for operations with publishedAt older than the TTL,
   * deletes the corresponding triples from shared memory and SWM meta,
   * and removes the root entities from workspaceOwnedEntities.
   */
  async cleanupExpiredSharedMemory(): Promise<number> {
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl <= 0) return 0;

    const ctx = createOperationContext('share');
    const cutoff = new Date(Date.now() - ttl).toISOString();
    let totalDeleted = 0;

    try {
      const graphManager = new GraphManager(this.store);
      const contextGraphs = await graphManager.listParanets();

      for (const pid of contextGraphs) {
        const wsGraph = paranetWorkspaceGraphUri(pid);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);
        let graphDeleted = 0;

        const expiredOps = await this.store.query(
          `SELECT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          }`,
        );

        if (expiredOps.type !== 'bindings' || expiredOps.bindings.length === 0) continue;

        for (const row of expiredOps.bindings) {
          const opUri = row['op'];
          if (!opUri) continue;

          const rootEntitiesResult = await this.store.query(
            `SELECT ?re WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/rootEntity> ?re .
              }
            }`,
          );

          const rootEntities: string[] = [];
          if (rootEntitiesResult.type === 'bindings') {
            for (const r of rootEntitiesResult.bindings) {
              if (r['re']) rootEntities.push(r['re']);
            }
          }

          for (const re of rootEntities) {
            // Exact root only; then skolemized descendants only (prefix would over-delete e.g. urn:foo vs urn:foobar)
            const exactDeleted = await this.store.deleteByPattern({ graph: wsGraph, subject: re });
            graphDeleted += exactDeleted;
            const childPrefix = `${re}/.well-known/genid/`;
            const childDeleted = await this.store.deleteBySubjectPrefix(wsGraph, childPrefix);
            graphDeleted += childDeleted;
          }

          // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
          const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
          graphDeleted += metaDeleted;

          for (const re of rootEntities) {
            const ownerDeleted = await this.store.deleteByPattern({
              graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
            graphDeleted += ownerDeleted;
          }

          const ownedSet = this.workspaceOwnedEntities.get(pid);
          if (ownedSet) {
            for (const re of rootEntities) {
              ownedSet.delete(re);
            }
          }
        }

        totalDeleted += graphDeleted;
        if (expiredOps.bindings.length > 0) {
          this.log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOps.bindings.length} expired operation(s), ${graphDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return totalDeleted;
  }

  async publishProfile(): Promise<PublishResult> {
    const pubKeyBase64 = Buffer.from(this.wallet.keypair.publicKey).toString('base64');
    const relayAddrs = this.config.relayPeers;

    const profileConfig: AgentProfileConfig = {
      peerId: this.node.peerId,
      name: this.config.name,
      description: this.config.description,
      framework: this.config.framework,
      nodeRole: this.config.nodeRole ?? 'edge',
      publicKey: pubKeyBase64,
      relayAddress: relayAddrs?.[0],
      agentAddress: this.defaultAgentAddress,
      skills: (this.config.skills ?? []).map(s => ({
        skillType: s.skillType,
        pricePerCall: s.pricePerCall,
        currency: s.currency ?? 'TRAC',
        pricingModel: s.pricePerCall ? 'PerInvocation' as const : 'Free' as const,
      })),
    };

    const profileCtx = createOperationContext('publish');
    this.log.info(profileCtx, `Publishing agent profile`);
    const result = await this.profileManager.publishProfile(profileConfig);
    await this.broadcastPublish(AGENT_REGISTRY_CONTEXT_GRAPH, result, profileCtx);

    return result;
  }

  async findAgents(options?: { framework?: string }): Promise<DiscoveredAgent[]> {
    return this.discovery.findAgents(options);
  }

  async findSkills(options?: SkillSearchOptions): Promise<DiscoveredOffering[]> {
    return this.discovery.findSkillOfferings(options);
  }

  async findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> {
    return this.discovery.findAgentByPeerId(peerId);
  }

  // ---------------------------------------------------------------------------
  // Agent Registry — multi-agent identity management
  // ---------------------------------------------------------------------------

  private static readonly AGENT_SYSTEM_GRAPH = 'did:dkg:system/agents';

  /**
   * Register a new agent on this node.
   * - Custodial (publicKey omitted): node generates secp256k1 keypair
   * - Self-sovereign (publicKey provided): agent holds its own key
   */
  async registerAgent(
    name: string,
    opts?: { publicKey?: string; framework?: string },
  ): Promise<AgentKeyRecord> {
    for (const existing of this.localAgents.values()) {
      if (existing.name === name) {
        throw new Error(`Agent name "${name}" already registered on this node`);
      }
    }

    const record = opts?.publicKey
      ? registerSelfSovereignAgent(name, opts.publicKey, opts.framework)
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
  listLocalAgents(): Array<Omit<AgentKeyRecord, 'privateKey'>> {
    return [...this.localAgents.values()].map(({ privateKey: _, ...rest }) => rest);
  }

  /**
   * Resolve an agent address from a Bearer token.
   * Returns undefined if the token is not an agent token (could be a node-level token).
   */
  resolveAgentByToken(token: string): string | undefined {
    return this.agentTokenIndex.get(token);
  }

  /**
   * Get the default agent address for this node.
   * Used when requests come in with a node-level token.
   */
  getDefaultAgentAddress(): string | undefined {
    return this.defaultAgentAddress;
  }

  /**
   * Challenge-message prefix used to authenticate a working-memory
   * query. Spec §04 / RFC-29.
   *
   * Bot review PR #229 (post-round-5): the v1 challenge was the fixed
   * string `dkg-wm-auth:<addr>` which the caller signed once — making
   * the resulting signature a permanent bearer credential for that
   * address. Anyone who ever observed the signature (HTTP logs,
   * browser devtools, co-hosted process, backup) could replay it
   * forever to read that agent's working memory on any multi-agent
   * node. The challenge is now bound to a millisecond timestamp and a
   * per-request nonce, and the wire format carries both explicitly so
   * the verifier can freshness-check and replay-check before recovering
   * the signer. The legacy (prefix-only) signature format is rejected.
   */
  static readonly WM_AUTH_CHALLENGE_PREFIX = 'dkg-wm-auth:v2:';

  /**
   * Freshness window for a signed WM-auth challenge. ±60 s balances
   * clock drift against the replay window an attacker can practically
   * exploit.
   */
  static readonly WM_AUTH_MAX_AGE_MS = 60_000;

  /**
   * Per-node in-memory replay cache for WM-auth nonces. Entry value is
   * the expiry timestamp (ms) after which the nonce record can be
   * pruned. Scoped to an instance so tests can spawn independent nodes
   * without cross-contamination.
   */
  private readonly _wmAuthSeenNonces = new Map<string, number>();
  private _wmAuthLastPrune = 0;

  private pruneWmAuthNonces(now: number): void {
    // Cheap periodic prune (every ~5 s). Fine-grained per-call pruning
    // is unnecessary — nonce records are tiny and expire inside
    // WM_AUTH_MAX_AGE_MS anyway.
    if (now - this._wmAuthLastPrune < 5_000) return;
    this._wmAuthLastPrune = now;
    for (const [k, expiry] of this._wmAuthSeenNonces) {
      if (expiry <= now) this._wmAuthSeenNonces.delete(k);
    }
  }

  /**
   * Canonical WM-auth message bound to an address, a millisecond
   * timestamp, and a caller-provided nonce. Both the client and the
   * verifier derive the exact same string from the fields carried in
   * the signature token, which closes the replay vector that the fixed
   * v1 challenge had.
   */
  static wmAuthChallenge(
    agentAddress: string,
    timestampMs: number,
    nonce: string,
  ): string {
    return `${DKGAgent.WM_AUTH_CHALLENGE_PREFIX}${agentAddress.toLowerCase()}:${timestampMs}:${nonce}`;
  }

  /**
   * Sign a fresh WM-auth challenge for a locally-registered agent.
   * Returns a single opaque token of the form
   * `<timestampMs>.<nonceHex>.<sigHex>` so callers never have to
   * construct the challenge message themselves. Returns undefined if
   * the agent is not registered locally (callers outside the node have
   * to sign with their own private key).
   *
   * The returned token is single-use: the verifier records the nonce on
   * success and rejects any subsequent token carrying the same nonce.
   */
  signWmAuthChallenge(agentAddress: string): string | undefined {
    const want = agentAddress.toLowerCase();
    let rec: AgentKeyRecord | undefined;
    for (const r of this.localAgents.values()) {
      if (r.agentAddress.toLowerCase() === want) {
        rec = r;
        break;
      }
    }
    if (!rec || !rec.privateKey) return undefined;
    try {
      const wallet = new ethers.Wallet(rec.privateKey);
      const timestampMs = Date.now();
      const nonce = randomBytes(16).toString('hex');
      const sig = wallet.signMessageSync(
        DKGAgent.wmAuthChallenge(agentAddress, timestampMs, nonce),
      );
      return `${timestampMs}.${nonce}.${sig}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Verify a WM-auth token of the form `<timestampMs>.<nonceHex>.<sigHex>`.
   *
   * The verifier:
   *   1. Parses the three segments; rejects malformed / legacy tokens.
   *   2. Freshness-checks the timestamp against
   *      {@link WM_AUTH_MAX_AGE_MS}.
   *   3. Rejects any nonce that was already used for this address
   *      (replay defence).
   *   4. Recovers the signer from `wmAuthChallenge(addr, ts, nonce)`
   *      and compares it against `agentAddress`.
   *   5. On success, records the nonce so the token cannot be reused.
   */
  private verifyWmAuthSignature(
    agentAddress: string,
    token: string | undefined,
  ): boolean {
    if (!token || typeof token !== 'string') return false;
    // Exactly two dots — segments are always non-empty because a valid
    // timestamp, nonce, and signature each contain no dots.
    const firstDot = token.indexOf('.');
    const lastDot = token.lastIndexOf('.');
    if (firstDot < 0 || lastDot <= firstDot) return false;
    const tsStr = token.slice(0, firstDot);
    const nonceStr = token.slice(firstDot + 1, lastDot);
    const sig = token.slice(lastDot + 1);
    if (tsStr.length === 0 || nonceStr.length === 0 || sig.length === 0) {
      return false;
    }
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) return false;
    const now = Date.now();
    if (Math.abs(now - ts) > DKGAgent.WM_AUTH_MAX_AGE_MS) return false;
    // Nonce format: caller-provided hex string of reasonable length so
    // an attacker can't flood the replay cache with trivial collisions.
    if (!/^[0-9a-fA-F]{16,128}$/.test(nonceStr)) return false;

    this.pruneWmAuthNonces(now);
    const cacheKey = `${agentAddress.toLowerCase()}:${nonceStr}`;
    if (this._wmAuthSeenNonces.has(cacheKey)) return false;

    try {
      const recovered = ethers.verifyMessage(
        DKGAgent.wmAuthChallenge(agentAddress, ts, nonceStr),
        sig,
      );
      if (recovered.toLowerCase() !== agentAddress.toLowerCase()) return false;
      // Record the nonce so the exact same token cannot be reused
      // within the freshness window.
      this._wmAuthSeenNonces.set(cacheKey, now + DKGAgent.WM_AUTH_MAX_AGE_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return an `ethers.Wallet` for the default agent if its private key is
   * available locally. Used to sign GossipEnvelopes (BUGS_FOUND.md A-15)
   * and `PublishRequestMsg` bodies. Returns undefined for self-sovereign
   * agents whose key material is held by the user.
   */
  getDefaultPublisherWallet(): ethers.Wallet | undefined {
    const addr = this.defaultAgentAddress;
    if (!addr) return undefined;
    return this.getLocalAgentWallet(addr);
  }

  /**
   * Return an `ethers.Wallet` for the registered local agent whose
   * `agentAddress` matches `addr` (case-insensitive), or `undefined` if
   * no such agent is registered or its private key is not held locally
   * (self-sovereign agents). Used by endorse() and any other signing
   * path that MUST sign with the exact key that matches the address
   * embedded in the payload — otherwise recovery yields a different
   * address than the one peers see in the quad (bot review PR #229 D1
   * follow-up).
   */
  getLocalAgentWallet(addr: string): ethers.Wallet | undefined {
    if (!addr) return undefined;
    const want = addr.toLowerCase();
    for (const r of this.localAgents.values()) {
      if (r.agentAddress.toLowerCase() === want && r.privateKey) {
        try {
          return new ethers.Wallet(r.privateKey);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * Wrap `payload` in a signed `GossipEnvelope` (spec §08_PROTOCOL_WIRE)
   * and publish to `topic`.
   *
   * PR #229 bot review round 16 (r16-1): previously we "fell back to
   * raw publish" when no wallet was available (pre-bootstrap /
   * self-sovereign / observer nodes). After the r14-1 ingress flip
   * that made `strictGossipEnvelope` fail-closed by default, any peer
   * on a newer build drops those raw bytes — so a wallet-less agent
   * would SILENTLY stop propagating publish / share / finalization
   * messages to most of the mesh while thinking its publishes were
   * succeeding. That's a correctness footgun: the UX is "my node is
   * online and sending traffic, but nobody replicates my KAs".
   *
   * New contract: egress REQUIRES a signing wallet. When one is
   * absent we throw a clear error at the call site instead of
   * pushing bytes every strict receiver will discard. Operators have
   * two escape hatches:
   *
   *   1. Provision a publisher wallet (the standard path — one is
   *      generated automatically on `DKGAgent.init()` unless the
   *      deployment explicitly runs in observer/no-sign mode).
   *   2. Set `DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS=1` to opt back into
   *      the legacy raw-bytes path AT YOUR OWN RISK. Strict peers
   *      will still drop these, but for pure local-cluster tests /
   *      single-node demos where every subscriber runs lenient
   *      mode, this unblocks propagation. We log a WARN per call so
   *      the degradation is visible in node logs.
   *
   * Rolling upgrades that need to ship with no wallet temporarily
   * should flip the env var, then remove it once every node has a
   * wallet — mirrors the `strictGossipEnvelope` opt-out on the
   * ingress side (r14-1) so both sides of the upgrade have a
   * matching escape hatch.
   */
  async signedGossipPublish(
    topic: string,
    type: string,
    contextGraphId: string,
    payload: Uint8Array,
  ): Promise<void> {
    const wallet = this.getDefaultPublisherWallet();
    if (!wallet) {
      const allowUnsigned = (process.env.DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS ?? '').toLowerCase();
      if (allowUnsigned === '1' || allowUnsigned === 'true' || allowUnsigned === 'yes') {
        const ctx = createOperationContext('system');
        this.log.warn(
          ctx,
          `[signedGossipPublish] WARNING: publishing RAW (unsigned) gossip on ` +
            `topic=${topic} type=${type} cg=${contextGraphId} — no signing ` +
            `wallet available and DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS is set. ` +
            `Strict peers (r14-1 default) will DROP this message; only ` +
            `lenient peers will receive it.`,
        );
        await this.gossip.publish(topic, payload);
        return;
      }
      throw new SignedGossipSigningError(
        `[signedGossipPublish] No signing wallet available for topic=${topic} ` +
          `type=${type} cg=${contextGraphId}. Cannot publish signed gossip ` +
          `envelope. Provision a publisher wallet (the standard path on ` +
          `DKGAgent.init) or — ONLY for local-cluster / single-node ` +
          `deployments where every subscriber runs lenient mode — set ` +
          `DKG_GOSSIP_ALLOW_UNSIGNED_EGRESS=1 to opt into legacy raw ` +
          `bytes. Refusing to fall back silently because strict peers ` +
          `(r14-1 default) would drop the message and propagation would ` +
          `stop without any visible error.`,
      );
    }
    let wire: Uint8Array;
    try {
      wire = buildSignedGossipEnvelope({
        type,
        contextGraphId,
        payload,
        signerWallet: wallet,
      });
    } catch (err) {
      // Bot review (PR #229 r22-6): envelope-building failures (e.g.
      // wallet that can't sign, malformed payload encoding) are
      // correctness bugs, NOT "no peers subscribed" situations. Tag
      // them so call-site catches can distinguish and surface them
      // loudly instead of masking them as transport blips.
      throw new SignedGossipSigningError(
        `[signedGossipPublish] Failed to build signed envelope for ` +
          `topic=${topic} type=${type} cg=${contextGraphId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }
    await this.gossip.publish(topic, wire);
  }

  /**
   * Resolve the agent address for a request: first try agent token, then fall
   * back to the default agent (for node-level tokens / backward compatibility).
   */
  resolveAgentAddress(token: string | undefined): string {
    if (token) {
      const addr = this.agentTokenIndex.get(token);
      if (addr) return addr;
    }
    if (this.defaultAgentAddress) return this.defaultAgentAddress;
    return this.peerId;
  }

  private async persistAgentToStore(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
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
    if (record.framework) {
      quads.push({ subject: agentUri, predicate: 'https://dkg.origintrail.io/skill#framework', object: `"${record.framework}"`, graph });
    }

    await this.store.insert(quads);
  }

  /**
   * Load previously registered agents from the triple store on startup.
   */
  private async loadAgentsFromStore(): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';

    // Load raw tokens and custodial keys from the on-disk keystore
    const keystore = await this.loadKeystore();

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
      const result = await this.store.query(sparql);
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
  private async autoRegisterDefaultAgent(): Promise<void> {
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

  private keystorePath(): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/agent-keystore.json`;
  }

  private async loadKeystore(): Promise<Record<string, { authToken?: string; privateKey?: string }>> {
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

  private async saveToKeystore(record: AgentKeyRecord): Promise<void> {
    const ksPath = this.keystorePath();
    if (!ksPath) return;
    try {
      const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      let existing: Record<string, { authToken?: string; privateKey?: string }> = {};
      try {
        const raw = await readFile(ksPath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* first write */ }
      existing[record.agentAddress.toLowerCase()] = {
        authToken: record.authToken,
        ...(record.privateKey ? { privateKey: record.privateKey } : {}),
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
  private async migrateTokenToHash(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
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
  private async markDefaultAgent(agentAddress: string): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
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
  async isCuratorOf(contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (owner === selfDid) return true;
    for (const addr of this.localAgents.keys()) {
      if (owner === `did:dkg:agent:${addr}`) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  async sendChat(recipientPeerId: string, text: string): Promise<{ delivered: boolean; error?: string }> {
    if (!this.messageHandler) throw new Error('Agent not started');
    await this.ensureCircuitRelayAddress(recipientPeerId);
    return this.messageHandler.sendChat(recipientPeerId, text);
  }

  onChat(handler: ChatHandler): void {
    if (!this.messageHandler) {
      this._pendingChatHandler = handler;
      return;
    }
    this.messageHandler.onChat(handler);
  }

  private _pendingChatHandler: ChatHandler | null = null;

  async invokeSkill(
    recipientPeerId: string,
    skillUri: string,
    inputData: Uint8Array,
  ): Promise<SkillResponse> {
    if (!this.messageHandler) throw new Error('Agent not started');
    await this.ensureCircuitRelayAddress(recipientPeerId);

    return this.messageHandler.sendSkillRequest(recipientPeerId, {
      skillUri,
      inputData,
      callback: 'inline',
    });
  }

  async connectTo(multiaddress: string): Promise<void> {
    const ctx = createOperationContext('connect');
    await connectToMultiaddr(
      this.node.libp2p as any,
      multiaddress,
      (message) => this.log.info(ctx, message),
    );
  }

  /**
   * Ensure libp2p knows how to reach a peer via circuit relay. If the peer
   * isn't directly connected and their profile advertises a relay address, we
   * add a /p2p-circuit multiaddr to the peer store so dialProtocol can route
   * through the relay.
   */
  private async ensureCircuitRelayAddress(peerIdStr: string): Promise<void> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerId = peerIdFromString(peerIdStr);

      const conns = this.node.libp2p.getConnections(peerId);
      if (conns.length > 0) return;

      const agent = await this.discovery.findAgentByPeerId(peerIdStr);
      if (!agent?.relayAddress) return;

      const circuitAddr = multiaddr(
        `${agent.relayAddress}/p2p-circuit/p2p/${peerIdStr}`,
      );
      await this.node.libp2p.peerStore.merge(peerId, {
        multiaddrs: [circuitAddr],
      });
    } catch {
      // Best-effort: if peer ID is invalid or lookup fails, let the
      // caller proceed — it will get a proper error from dialProtocol.
    }
  }

  // Overload: raw quads
  async publish(contextGraphId: string, quads: Quad[], privateQuads?: Quad[], opts?: PublishOpts): Promise<PublishResult>;
  // Overload: JSON-LD (bare doc = private, or { public?, private? } envelope)
  async publish(contextGraphId: string, content: JsonLdContent, opts?: PublishOpts): Promise<PublishResult>;
  async publish(
    contextGraphId: string,
    input: Quad[] | JsonLdContent,
    thirdArg?: Quad[] | PublishOpts,
    fourthArg?: PublishOpts,
  ): Promise<PublishResult> {
    // JSON-LD: convert to quads, then publish
    if (!Array.isArray(input)) {
      const { publicQuads, privateQuads } = await jsonLdToQuads(input);
      return this._publish(contextGraphId, publicQuads, privateQuads, thirdArg as PublishOpts);
    }
    // Quad[]: pass through directly
    if (Array.isArray(thirdArg)) {
      return this._publish(contextGraphId, input as Quad[], thirdArg, fourthArg);
    }
    return this._publish(contextGraphId, input as Quad[], undefined, thirdArg ?? fourthArg);
  }

  private async _publish(
    contextGraphId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: PublishOpts,
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to context graph "${contextGraphId}" with ${quads.length} triples`);

    const isSystem = contextGraphId === SYSTEM_PARANETS.AGENTS || contextGraphId === SYSTEM_PARANETS.ONTOLOGY;
    if (!isSystem) {
      const exists = await this.contextGraphExists(contextGraphId);
      if (!exists) {
        throw new Error(
          `Context graph "${contextGraphId}" does not exist. Create it first with createContextGraph().`,
        );
      }
    }
    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    const onChainId = await this.getContextGraphOnChainId(contextGraphId);

    // PR #229 bot review round 26 (r26-1, dkg-agent.ts:_publish). The
    // per-CG quorum resolution below mirrors `publishFromSharedMemory()`
    // (spec §06 / A-5): direct `agent.publish()` on an on-chain CG
    // MUST wait for the CG's M-of-N signatures, not the global
    // ParametersStorage minimum. Before r26-1 the direct path skipped
    // this resolution entirely, so `DKGPublisher.publish()` saw
    // `perCgRequiredSignatures === undefined` and fell back to the
    // global default — a CG that required 3 core-node ACKs could
    // confirm on-chain with just 1 via the self-sign fallback.
    // PR #229 bot review (r31-4 — dkg-agent.ts:2701).
    // The previous catch-all swallowed BOTH the `BigInt(onChainId)` parse
    // case (legitimate mock-only graph) AND any real chain-RPC failure
    // raised by `getContextGraphRequiredSignatures()`. With the catch
    // around both, a transient RPC error or contract revert silently
    // dropped `perCgRequiredSignatures` to `undefined`, so the publish
    // path fell back to the global ParametersStorage minimum and could
    // confirm an M-of-N context graph with too few ACKs (the exact
    // regression r26-1 was supposed to prevent).
    //
    // Split the two failure modes:
    //   (a) BigInt parse failure → mock-only on-chain id, skip the gate;
    //   (b) RPC / contract failure → propagate so the publish fails
    //       loudly instead of silently downgrading the quorum.
    let perCgRequiredSignatures: number | undefined;
    if (onChainId && typeof this.chain.getContextGraphRequiredSignatures === 'function') {
      let parsedId: bigint | null = null;
      try {
        const candidate = BigInt(onChainId);
        if (candidate > 0n) parsedId = candidate;
      } catch {
        // Non-numeric on-chain id (mock-only graph) → skip per-CG gate.
        parsedId = null;
      }
      if (parsedId !== null) {
        // RPC / contract errors are NOT swallowed here — they bubble out
        // so the caller surfaces the failure rather than silently
        // downgrading to the global minimum.
        const n = await this.chain.getContextGraphRequiredSignatures(parsedId);
        if (Number.isFinite(n) && n > 0) perCgRequiredSignatures = n;
      }
    }

    const result = await this.publisher.publish({
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      subGraphName: opts?.subGraphName,
      operationCtx: ctx,
      onPhase,
      v10ACKProvider,
      publishContextGraphId: onChainId ?? undefined,
      perCgRequiredSignatures,
    });

    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(contextGraphId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kcId=${result.kcId}`);
    return result;
  }

  async update(
    kcId: bigint, contextGraphId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: { onPhase?: PhaseCallback; operationCtx?: OperationContext },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kcId=${kcId} in context graph "${contextGraphId}" with ${quads.length} triples`);
    const result = await this.publisher.update(kcId, {
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      onPhase,
    });
    this.log.info(ctx, `Update complete — status=${result.status}`);

    onPhase?.('broadcast', 'start');
    if (result.onChainResult && result.publicQuads) {
      const topic = paranetUpdateTopic(contextGraphId);
      try {
        const dataGraph = `did:dkg:context-graph:${contextGraphId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          paranetId: contextGraphId,
          batchId: kcId,
          nquads: nquadsBytes,
          manifest: result.kaManifest.map((m) => ({
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
        });
        // Signed-envelope wrap (PR #229 bot review round 6): update messages
        // must carry a recoverable signer so subscribers can reject envelopes
        // whose recovered signer does not match the KC's publisher.
        await this.signedGossipPublish(topic, 'KA_UPDATE', contextGraphId, message);
        this.log.info(ctx, `Broadcast KA update for batchId=${kcId} on ${topic}`);
      } catch (err) {
        // r22-6: signing vs transport classification — signing errors
        // log as ERROR with a distinctive message so operators see
        // the correctness issue; transport blips stay as a routine
        // "Failed to broadcast" WARN.
        if (isSignedGossipSigningError(err)) {
          logSignedGossipFailure(this.log, ctx, topic, err);
        } else {
          this.log.warn(ctx, `Failed to broadcast KA update: ${err instanceof Error ? err.message : String(err)}`);
        }
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
  async share(contextGraphId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string }): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `Sharing ${quads.length} quads to SWM for context graph ${contextGraphId}${sgLabel}${opts?.localOnly ? ' (local-only)' : ''}`);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      subGraphName: opts?.subGraphName,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(contextGraphId);
      try {
        await this.signedGossipPublish(topic, 'SHARE', contextGraphId, message);
      } catch (err) {
        // Bot review (PR #229 r22-6): distinguish signing/envelope
        // correctness bugs from benign "no subscribers" transport
        // blips. Both previously collapsed into a single `log.warn`
        // that made observer / wallet-less nodes falsely report
        // "SHARE delivered" while strict peers (r14-1 default)
        // dropped the gossip. `logSignedGossipFailure` emits an ERROR
        // with a distinctive message for the former so operators
        // see it; the local SWM write is already committed so we
        // keep the tentative-success contract observer nodes rely
        // on (pinned by `v10-ack-provider.test.ts`).
        logSignedGossipFailure(this.log, ctx, topic, err);
      }
    }
    return { shareOperationId };
  }

  /**
   * Compare-and-swap shared memory write. Verifies each condition against the
   * current shared memory graph before applying the write atomically.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(
    contextGraphId: string,
    quads: Quad[],
    conditions: CASCondition[],
    opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string },
  ): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${contextGraphId}${sgLabel}`);
    const { shareOperationId, message } = await this.publisher.writeConditionalToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
      subGraphName: opts?.subGraphName,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(contextGraphId);
      try {
        await this.signedGossipPublish(topic, 'SHARE_CAS', contextGraphId, message);
      } catch (err) {
        // r22-6: see SHARE catch above for rationale.
        logSignedGossipFailure(this.log, ctx, topic, err);
      }
    }
    return { shareOperationId };
  }

  /**
   * Publish shared memory content: read from SWM graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * SWM state can promote it to canonical without re-downloading the full payload.
   */
  async publishFromSharedMemory(
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
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const effectiveSubCG = options?.subContextGraphId ?? options?.contextGraphId;
    const ctxGraphIdStr = effectiveSubCG != null ? String(effectiveSubCG) : undefined;

    const onChainId = ctxGraphIdStr ?? (await this.getContextGraphOnChainId(contextGraphId)) ?? undefined;

    // Resolve per-CG quorum (spec §06_PUBLISH / BUGS_FOUND.md A-5). When the
    // adapter exposes the lookup AND the CG has an on-chain id, plumb the
    // per-CG `requiredSignatures` through to the publisher so the on-chain
    // tx is gated on collected ACK count even when the global
    // ParametersStorage minimum is 1.
    // PR #229 bot review (r31-4 — dkg-agent.ts:2701).
    // See the comment block above the matching block in `_publish()` for
    // the full rationale: previous catch-all swallowed real chain-RPC
    // failures and silently downgraded the per-CG quorum to the global
    // minimum, defeating the r26-1 fix. Split into:
    //   (a) BigInt parse failure → mock-only on-chain id, skip the gate;
    //   (b) RPC / contract failure → propagate so publishFromSharedMemory
    //       fails loudly instead of confirming an M-of-N CG with too few
    //       ACKs.
    let perCgRequiredSignatures: number | undefined;
    if (onChainId && typeof this.chain.getContextGraphRequiredSignatures === 'function') {
      let parsedId: bigint | null = null;
      try {
        const candidate = BigInt(onChainId);
        if (candidate > 0n) parsedId = candidate;
      } catch {
        parsedId = null;
      }
      if (parsedId !== null) {
        const n = await this.chain.getContextGraphRequiredSignatures(parsedId);
        if (Number.isFinite(n) && n > 0) perCgRequiredSignatures = n;
      }
    }

    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);
    const result = await this.publisher.publishFromSharedMemory(contextGraphId, selection, {
      operationCtx: ctx,
      clearSharedMemoryAfter: options?.clearSharedMemoryAfter,
      onPhase: options?.onPhase,
      publishContextGraphId: ctxGraphIdStr,
      onChainContextGraphId: onChainId,
      contextGraphSignatures: options?.contextGraphSignatures,
      v10ACKProvider,
      subGraphName: options?.subGraphName,
      perCgRequiredSignatures,
    });

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities = result.kaManifest.map(ka => ka.rootEntity);

      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        paranetId: contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities,
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        contextGraphId: result.contextGraphError ? undefined : ctxGraphIdStr,
        subGraphName: options?.subGraphName,
      };

      const topic = paranetFinalizationTopic(contextGraphId);
      try {
        // Sign the FinalizationMessage envelope so subscribers can verify
        // the signer is the expected publisher and reject forged/replayed
        // envelopes. Pre-r6 this was published raw, which made the new
        // ingress-side `classifyGossipBytes()` path fall through as 'raw'
        // and bypass the envelope-signing hardening entirely
        // (PR #229 bot review round 6 — signed-gossip envelope bypass).
        await this.signedGossipPublish(topic, 'FINALIZATION', contextGraphId, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast finalization for ${result.ual} to ${topic}${ctxGraphIdStr ? ` (contextGraph=${ctxGraphIdStr})` : ''}${result.contextGraphError ? ' (ctx-graph registration failed, omitting contextGraphId)' : ''}`);
      } catch (err) {
        // r22-6: signing failures logged as ERROR (distinct from
        // "no peers"); finalization itself is already confirmed
        // on-chain so the local state is authoritative.
        logSignedGossipFailure(this.log, ctx, topic, err);
      }
    }

    return result;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(
    ...args: Parameters<DKGAgent['publishFromSharedMemory']>
  ): ReturnType<DKGAgent['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
  }

  /**
   * Register a new M/N signature-gated context graph on-chain.
   */
  async registerContextGraphOnChain(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.createOnChainContextGraph !== 'function') {
      throw new Error('createOnChainContextGraph not available on chain adapter');
    }
    const result = await this.chain.createOnChainContextGraph(params);
    this.log.info(ctx, `Created on-chain context graph ${result.contextGraphId} (M=${params.requiredSignatures}, N=${params.participantIdentityIds.length})`);
    return result;
  }

  /**
   * Link an already-published KC batch to a context graph.
   * Collects participant signatures and calls addBatchToContextGraph on-chain.
   */
  async addBatchToContextGraph(params: {
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
   * (Re-)attempt on-chain identity registration. Safe to call multiple times.
   * Returns the identityId (>0n on success, 0n if chain is not configured).
   */
  async ensureIdentity(): Promise<bigint> {
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

  async query(
    sparql: string,
    options?: string | {
      contextGraphId?: string;
      /** @deprecated Use contextGraphId */
      paranetId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      /** @deprecated Use includeSharedMemory */
      includeWorkspace?: boolean;
      operationCtx?: OperationContext;
      view?: GetView;
      agentAddress?: string;
      /**
       * Proof that the caller controls the private key matching `agentAddress`.
       *
       * Wire format (PR #229 bot review round 17, r17-3):
       *
       *   `<timestampMs>.<nonce>.<eip191HexSignature>`
       *
       * where the signed payload is exactly:
       *
       *   `${DKGAgent.WM_AUTH_CHALLENGE_PREFIX}${agentAddress.toLowerCase()}:${timestampMs}:${nonce}`
       *
       * (currently `dkg-wm-auth:v2:<addr-lower>:<ts>:<nonce>`).
       *
       * Produce the token with one of:
       *   - `DKGAgent.wmAuthChallenge(agentAddress, timestampMs, nonce)`
       *     to build the payload, sign it via EIP-191
       *     (`eth_signMessage` / `wallet.signMessage`), and join as
       *     `${ts}.${nonce}.${hexSig}`; or
       *   - `dkgAgent.signWmAuthChallenge(agentAddress)` which
       *     returns a ready-to-use token string using a wallet this
       *     agent already holds (and `undefined` when it doesn't).
       *
       * Pre-r17-3 this field's docstring described the legacy v1
       * payload `dkg-wm-auth:<agentAddress>`; that format is no
       * longer accepted by `verifyWmAuthSignature()` — every signer
       * that follows the old doc emits a token that always fails.
       *
       * REQUIRED for `view: 'working-memory'` queries on multi-agent
       * nodes to prevent cross-agent WM impersonation (BUGS_FOUND.md
       * A-1). The gate is fail-closed by default; see
       * `strictWmCrossAgentAuth` / `DKG_STRICT_WM_AUTH` for the
       * escape hatches.
       */
      agentAuthSignature?: string;
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
       * Set by an outer authorisation layer (currently the daemon's
       * `/api/query`) to indicate that the request was authenticated
       * with a node-level **admin** credential — i.e. a token that
       * does not bind to any specific agent identity. When `true`,
       * the multi-agent WM signed-proof gate is bypassed because the
       * admin credential is itself the authorisation anchor.
       *
       * Cross-agent isolation (`callerAgentAddress` invariant) still
       * applies when an admin-authenticated request also asserts a
       * `callerAgentAddress`. Defaults to `false`. Pre-existing
       * callers that don't set this remain in the strict default
       * (signed-proof required for foreign-WM reads on multi-agent
       * nodes).
       */
      adminAuthenticated?: boolean;
      /**
       * Minimum trust level for the verified-memory view (spec §14, P-13).
       * When set to `TrustLevel.Endorsed`, the root content graph is
       * excluded from resolution so only quorum-verified sub-graphs survive.
       * Values above `Endorsed` (`PartiallyVerified`, `ConsensusVerified`)
       * are currently rejected — see `QueryOptions.minTrust` in
       * `packages/query/src/query-engine.ts` for the full rationale and
       * the Q-1 gap tracking per-graph trust tagging.
       * Ignored for views other than `verified-memory`.
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
      contextGraphId: rawOpts.contextGraphId ?? rawOpts.paranetId,
      includeSharedMemory: rawOpts.includeSharedMemory ?? rawOpts.includeWorkspace,
    };
    const ctx = opts.operationCtx ?? createOperationContext('query');
    const sgLabel = opts.subGraphName ? `/${opts.subGraphName}` : '';
    const viewLabel = opts.view ? ` view=${opts.view}` : '';
    this.log.info(ctx, `Query on contextGraph="${opts.contextGraphId ?? 'all'}"${sgLabel}${viewLabel} sparql="${sparql.slice(0, 80)}"`);

    // Validate the SPARQL query is read-only BEFORE any access-denied
    // fast-path. `DKGQueryEngine.query` runs this guard too, but the
    // early returns below (canReadContextGraph deny, WM isolation deny,
    // private-CG deny) short-circuit before reaching it. Without this
    // check, a caller can send `INSERT DATA { ... }` through a
    // cross-agent WM request and get a 200 empty result instead of
    // the 400 rejection that plain queries receive — effectively
    // silently swallowing a mutation attempt. Run it once here so
    // the deny path and the engine path share the same input
    // contract.
    const readOnlyGuard = validateReadOnlySparql(sparql);
    if (!readOnlyGuard.safe) {
      throw new Error(`SPARQL rejected: ${readOnlyGuard.reason}`);
    }

    // PR #229 bot review round 17 (r17-2) + A-1 follow-up + r30-3
    // consolidation: fail-closed denials MUST preserve the `QueryResult`
    // shape for the SPARQL form the caller issued — otherwise a
    // `CONSTRUCT`/`DESCRIBE` caller branching on
    // `result.quads !== undefined` misinterprets an auth denial as an
    // empty-bindings SELECT success, and an ASK caller sees
    // `bindings: []` instead of the expected `[{ result: 'false' }]`.
    //
    // `detectSparqlQueryForm` + `emptyResultForForm` is the SINGLE
    // canonical empty-shape pair (see `sparql-guard.ts`). Detect once
    // at the top so every fail-closed return below can reuse the form
    // without re-parsing the query string. `emptyResultForForm`
    // returns a fresh, shape-matched object on every call so deny
    // branches never share a mutable reference.
    const sparqlForm: SparqlQueryForm = detectSparqlQueryForm(sparql);

    if (opts.contextGraphId && !(await this.canReadContextGraph(opts.contextGraphId))) {
      this.log.info(ctx, `Query denied for private context graph "${opts.contextGraphId}"`);
      return emptyResultForForm(sparqlForm);
    }

    // A-1 review: `/api/query` passes the raw JSON body through, so
    // `agentAddress` / `callerAgentAddress` can arrive as any JSON type
    // (number, array, object, null). Before this guard `.toLowerCase()`
    // would throw and the daemon turned a bad request into a 500.
    //
    // A-1 follow-up review: simply coercing non-strings to `undefined`
    // meant malformed input like `{ view: 'working-memory',
    // agentAddress: 123 }` silently fell through to the `this.peerId`
    // fallback below — so a caller could land in the node-default WM
    // namespace and get a 200 with real data. Reject non-string
    // `agentAddress` / `callerAgentAddress` up front and let the daemon
    // classify the resulting error as 400.
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

    // A-1 canonicalization (Codex PR #242 iter-9 re-review): the node's
    // default agent has TWO identifiers that key the same WM namespace
    // — its EVM address (`this.defaultAgentAddress`) and the legacy
    // `this.peerId`. In-repo WM callers / docs still use `peerId` as
    // `agentAddress` (e.g. `ChatMemoryManager`,
    // `packages/cli/skills/dkg-node/SKILL.md`), and the engine stores
    // WM under `did:dkg:context-graph:<cg>/assertion/<agentAddress>/`,
    // so EVM and peerId hash to DIFFERENT graphs. If the isolation
    // check compared raw strings, an agent-scoped token with
    // `callerAgentAddress=<defaultAgent.evm>` querying its own WM with
    // `agentAddress=<peerId>` (or the reverse) would get a silent empty
    // deny even though both sides are the same identity. Canonicalize
    // both sides: when the default agent is known, fold its `peerId`
    // alias onto its EVM address.
    const defaultEvmLc = this.defaultAgentAddress?.toLowerCase();
    // Guard against "DKGNode not started": the `peerId` getter throws when
    // the underlying node has not been started yet (e.g. unit tests that
    // exercise the SPARQL guard without booting the network stack). Fall
    // back to `undefined` in that case so the query path can still operate.
    let peerIdLc: string | undefined;
    try {
      peerIdLc = this.peerId?.toLowerCase();
    } catch {
      peerIdLc = undefined;
    }
    const canonicaliseWmId = (addr: string | undefined): string | undefined => {
      if (!addr) return undefined;
      const lc = addr.toLowerCase();
      if (peerIdLc && lc === peerIdLc && defaultEvmLc) return defaultEvmLc;
      return lc;
    };

    // Spec §04 / RFC-29 — multi-agent WM isolation via signed proof.
    // When more than one agent is registered on this node, an explicit
    // `agentAddress` for a `working-memory` view requires a signature
    // proving the caller owns the private key. Otherwise any
    // in-process caller could read another co-hosted agent's WM by
    // knowing/guessing the address. See BUGS_FOUND.md A-1.
    //
    // PR #229 bot review round 12: the gate is now **fail-closed by
    // default**. Any call that lacks a valid `agentAuthSignature`
    // returns an empty form-shaped result. Operators still on a
    // rolling upgrade where some HTTP/CLI/UI/adapter surfaces have
    // not yet plumbed `agentAuthSignature` can opt out via
    // `strictWmCrossAgentAuth: false` (or `DKG_STRICT_WM_AUTH=0`), but
    // doing so explicitly accepts the RFC-29 isolation hole — so the
    // knob is loud about what it trades off. When the gate IS disabled
    // we still validate any signature the caller happened to supply
    // (so a signed request is never downgraded), and a missing
    // signature degrades to a warn-log instead of an error.
    //
    // This signed-proof gate is complementary to the
    // `callerAgentAddress` isolation check below: the signed-proof
    // gate handles in-process callers that have no `callerAgentAddress`
    // authentication context (e.g. legacy SDK calls), while the
    // `callerAgentAddress` check handles HTTP/token-authenticated
    // callers that the daemon has already resolved to an identity.
    //
    // A-1 iter-9 re-review: skip the signed-proof gate entirely when an
    // authenticated `callerAgentAddress` is present AND canonicalizes to
    // the requested `agentAddress` (same identity, possibly via peerId
    // alias). The daemon already authenticated the caller upstream, and
    // the alias-aware `canonicaliseWmId` check below enforces the
    // same-identity invariant — requiring a second signed proof for
    // caller-reads-self would break legitimate HTTP/token callers that
    // don't carry a private key.
    const callerSelfReadsOwnWm =
      callerAgentAddressStr
      && opts.agentAddress
      && canonicaliseWmId(callerAgentAddressStr) === canonicaliseWmId(opts.agentAddress);
    if (
      opts.view === 'working-memory'
      && opts.agentAddress
      && this.localAgents.size > 1
      && !callerSelfReadsOwnWm
      && !opts.adminAuthenticated
    ) {
      const strictEnv = (process.env.DKG_STRICT_WM_AUTH ?? '').toLowerCase();
      const envExplicitOff =
        strictEnv === '0' || strictEnv === 'false' || strictEnv === 'no';
      const envExplicitOn =
        strictEnv === '1' || strictEnv === 'true' || strictEnv === 'yes';
      const strict = envExplicitOn
        ? true
        : envExplicitOff
          ? false
          : this.config.strictWmCrossAgentAuth !== false;
      const sigProvided = typeof opts.agentAuthSignature === 'string' && opts.agentAuthSignature.length > 0;
      if (strict || sigProvided) {
        const ok = this.verifyWmAuthSignature(opts.agentAddress, opts.agentAuthSignature);
        if (!ok) {
          this.log.info(
            ctx,
            `WM cross-agent query denied: missing/invalid agentAuthSignature for ${opts.agentAddress}`,
          );
          return emptyResultForForm(sparqlForm);
        }
      } else {
        this.log.warn(
          ctx,
          `WM cross-agent query for ${opts.agentAddress} has no agentAuthSignature; ` +
          `allowing because strictWmCrossAgentAuth has been explicitly disabled. ` +
          `This opens an RFC-29 isolation hole — re-enable once every caller plumbs the signature.`,
        );
      }
    }

    // An authenticated (agent-bound) /api/query call could previously
    // OMIT `agentAddress` and fall through to the `this.peerId`
    // fallback at the engine call below, reading the node-default WM
    // namespace instead of the caller's own. Default an omitted
    // `agentAddress` to `callerAgentAddress` on working-memory reads
    // so an agent-bound caller cannot escape its own WM by just not
    // supplying the field.
    //
    // Legacy preservation (Codex iter-9 re-review): if the caller is
    // the node default agent, default to `this.peerId` instead of the
    // EVM address. Pre-existing WM data for the default agent lives
    // under the peerId-keyed namespace; defaulting to the EVM form
    // would strand that data. The isolation check below is
    // alias-aware (`canonicaliseWmId`), so both forms resolve to the
    // same canonical identity and still pass the caller===target
    // invariant.
    const callerIsDefaultAgent =
      !!callerAgentAddressStr
      && !!defaultEvmLc
      && callerAgentAddressStr.toLowerCase() === defaultEvmLc;
    let safePeerId: string | undefined;
    try {
      safePeerId = this.peerId;
    } catch {
      safePeerId = undefined;
    }
    const agentAddressStr =
      opts.agentAddress
      ?? (opts.view === 'working-memory' && callerAgentAddressStr
        ? (callerIsDefaultAgent && safePeerId ? safePeerId : callerAgentAddressStr)
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
      return emptyResultForForm(sparqlForm);
    }

    // When no context graph is specified, exclude private CGs the caller cannot
    // read to prevent data leakage via unscoped or FROM-less SPARQL.
    let excludeGraphPrefixes: string[] | undefined;
    if (!opts.contextGraphId) {
      excludeGraphPrefixes = await this.getDisallowedGraphPrefixes();
      // Per spec Axiom 1 every shared query must be resolved within a CG.
      // Reject explicit GRAPH/FROM clauses that reference private CGs the
      // caller cannot read — post-filtering alone cannot prevent leaks via
      // aggregates (ASK, COUNT) or projections that omit graph/subject.
      if (excludeGraphPrefixes.length > 0 && this.sparqlReferencesPrivateGraphs(sparql, excludeGraphPrefixes)) {
        this.log.info(ctx, 'Query denied: SPARQL references private context graphs the caller cannot read');
        return emptyResultForForm(sparqlForm);
      }
    }

    const result = await this.queryEngine.query(sparql, {
      paranetId: opts.contextGraphId,
      excludeGraphPrefixes,
      graphSuffix: opts.graphSuffix,
      includeSharedMemory: opts.includeSharedMemory,
      view: opts.view,
      agentAddress: agentAddressStr ?? (opts.view === 'working-memory' ? safePeerId : undefined),
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

  private async canReadContextGraph(contextGraphId: string): Promise<boolean> {
    if (!(await this.isPrivateContextGraph(contextGraphId))) {
      return true;
    }

    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);

    // No participant list at all → allow creator / locally-subscribed nodes
    if (!participants || participants.length === 0) {
      return this.subscribedContextGraphs.has(contextGraphId)
        || (this.config.syncContextGraphs ?? []).includes(contextGraphId);
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
    const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);
    if (allowedPeers?.includes(this.peerId)) {
      return true;
    }

    // Edge nodes without an on-chain identity (identityId 0n) fall back to
    // subscription-based access — the subscription itself is an authorization
    // (the node was invited or created this CG).
    if (myIdentityId === 0n) {
      return this.subscribedContextGraphs.has(contextGraphId);
    }

    return false;
  }

  /**
   * Returns graph URI prefixes for private CGs the caller cannot read.
   * Used to exclude them from unscoped queries.
   */
  private async getDisallowedGraphPrefixes(): Promise<string[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const result = await this.store.query(
      `SELECT ?cg WHERE {
        GRAPH <${ontologyGraph}> {
          ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];

    const prefixes: string[] = [];
    for (const row of result.bindings) {
      const cgUri = row['cg'];
      if (!cgUri) continue;
      // cgUri is like "did:dkg:context-graph:some-id" — extract the ID
      const match = cgUri.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
      if (!match) continue;
      const contextGraphId = match[1];
      if (await this.canReadContextGraph(contextGraphId)) continue;
      // Exclude all named graphs under this CG (data, _meta, _shared_memory, etc.)
      prefixes.push(`did:dkg:context-graph:${contextGraphId}`);
    }
    return prefixes;
  }

  private sparqlReferencesPrivateGraphs(sparql: string, disallowedPrefixes: string[]): boolean {
    if (disallowedPrefixes.length === 0) return false;
    const upper = sparql.toUpperCase();
    if (!upper.includes('GRAPH') && !upper.includes('FROM')) return false;
    return disallowedPrefixes.some(prefix => sparql.includes(prefix));
  }

  /**
   * Send a cross-agent query to a remote peer via the /dkg/query/2.0.0 protocol.
   */
  async queryRemote(
    peerId: string,
    request: Omit<QueryRequest, 'operationId'>,
  ): Promise<QueryResponse> {
    const ctx = createOperationContext('query');
    const operationId = crypto.randomUUID();
    const fullRequest: QueryRequest = { ...request, operationId };

    this.log.info(ctx, `Remote query to ${peerId.slice(-8)} type=${request.lookupType}`);

    const payload = new TextEncoder().encode(JSON.stringify(fullRequest));
    const responseBytes = await this.router.send(peerId, PROTOCOL_QUERY_REMOTE, payload);
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as QueryResponse;

    this.log.info(ctx, `Remote query response: status=${response.status} resultCount=${response.resultCount}`);
    return response;
  }

  /**
   * Look up a specific knowledge asset on a remote peer by UAL.
   */
  async lookupEntity(peerId: string, ual: string): Promise<QueryResponse> {
    return this.queryRemote(peerId, { lookupType: 'ENTITY_BY_UAL', ual });
  }

  /**
   * Find entities of a given RDF type on a remote peer's context graph.
   */
  async findEntitiesByType(
    peerId: string,
    contextGraphId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      paranetId: contextGraphId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's context graph.
   */
  async getEntityTriples(
    peerId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      paranetId: contextGraphId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(
    peerId: string,
    contextGraphId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      paranetId: contextGraphId,
      sparql,
      limit,
      timeout,
    });
  }

  subscribeToContextGraph(contextGraphId: string, options?: { trackSyncScope?: boolean }): void {
    if (options?.trackSyncScope !== false) {
      this.trackSyncContextGraph(contextGraphId);
    }

    // Idempotent: skip if gossip handlers already installed for this context graph.
    if (this.gossipRegistered.has(contextGraphId)) {
      const existing = this.subscribedContextGraphs.get(contextGraphId);
      if (!existing?.subscribed) {
        this.subscribedContextGraphs.set(contextGraphId, { ...existing, subscribed: true, synced: existing?.synced ?? false });
      }
      return;
    }
    this.gossipRegistered.add(contextGraphId);

    const publishTopic = paranetPublishTopic(contextGraphId);
    const swmTopic = paranetWorkspaceTopic(contextGraphId);
    const appTopic = paranetAppTopic(contextGraphId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(swmTopic);
    this.gossip.subscribe(appTopic);

    const existing = this.subscribedContextGraphs.get(contextGraphId);
    this.subscribedContextGraphs.set(contextGraphId, { ...existing, subscribed: true, synced: existing?.synced ?? false });

    // Ingress-side envelope enforcement (bot review C1/E1). Bytes fall into
    // one of three classes:
    //   - 'verified' → envelope parsed, signature recovered, and recovered
    //                  signer equals `envelope.agentAddress`. Safe to
    //                  dispatch `envelope.payload` AND attach the recovered
    //                  signer for membership/authorisation checks downstream.
    //   - 'raw'      → not an envelope at all (legacy non-envelope gossip).
    //                  Fall back to raw bytes for backward-compat.
    //   - 'forged'   → envelope parsed but signature failed to recover or
    //                  did not match claimed agentAddress. MUST be dropped;
    //                  letting this fall through to the raw path would make
    //                  the new signing layer strictly weaker than no
    //                  envelope (a tampered envelope would still be
    //                  processed as legacy gossip).
    // Map subscription label → set of envelope `type` values accepted on
    // that topic. Keeps subscribers from accidentally processing an
    // envelope whose declared type belongs to a different topic
    // (PR #229 bot review round 6 — subscription/type mismatch).
    const ACCEPTED_ENVELOPE_TYPES: Record<string, ReadonlySet<string>> = {
      publish: new Set(['PUBLISH_REQUEST']),
      swm: new Set(['SHARE', 'SHARE_CAS', 'ASSERTION_PROMOTE']),
      update: new Set(['KA_UPDATE']),
      finalization: new Set(['FINALIZATION']),
    };

    // PR #229 bot review round 14 (r14-1): resolve strict mode via the
    // exported `resolveStrictGossipEnvelopeMode` helper so the precedence
    // is testable without spinning up a full DKGAgent. See the helper's
    // docstring for the exact rules — mirrors the r12-1 flip for
    // `strictWmCrossAgentAuth`: fail-closed by default, explicit opt-out
    // via env/config for rolling upgrades.
    const strictEnvelope = resolveStrictGossipEnvelopeMode({
      configValue: this.config.strictGossipEnvelope,
      envValue: process.env.DKG_STRICT_GOSSIP_ENVELOPE,
    });
    if (!strictEnvelope) {
      const ctx = createOperationContext('system');
      this.log.warn(
        ctx,
        `strictGossipEnvelope=false: raw un-enveloped gossip will be accepted on cg=${contextGraphId}. ` +
          `This is a temporary rolling-upgrade opt-out; forged envelopes are still rejected, but a ` +
          `peer that omits the envelope entirely will bypass the signing layer. Re-enable strict mode ` +
          `(DKG_STRICT_GOSSIP_ENVELOPE=1 or strictGossipEnvelope: true) once every peer has upgraded.`,
      );
    }

    const dispatchIngress = (label: string, data: Uint8Array): {
      payload: Uint8Array;
      recoveredSigner: string | undefined;
    } | undefined => {
      const kind = classifyGossipBytes(data);
      if (kind === 'forged') {
        const ctx = createOperationContext('system');
        this.log.warn(ctx, `rejected forged ${label} envelope on cg=${contextGraphId}`);
        return undefined;
      }
      if (kind === 'verified') {
        const env = tryUnwrapSignedEnvelope(data)!;
        // Defence-in-depth: the signature only authenticates the
        // (type, contextGraphId, timestamp, payload) tuple the publisher
        // signed. A malicious peer could still take a legitimately signed
        // envelope from one topic (e.g. FINALIZATION on cg=A) and
        // re-broadcast it on a different topic (e.g. SHARE on cg=A, or
        // FINALIZATION on cg=B) — the signature stays valid but the
        // dispatcher would treat it as a different message class. Reject
        // when either dimension disagrees with the subscription context.
        const accepted = ACCEPTED_ENVELOPE_TYPES[label];
        if (accepted && !accepted.has(env.envelope.type)) {
          const ctx = createOperationContext('system');
          this.log.warn(
            ctx,
            `rejected ${label} envelope with mismatched type=${env.envelope.type} on cg=${contextGraphId}`,
          );
          return undefined;
        }
        if (env.envelope.contextGraphId && env.envelope.contextGraphId !== contextGraphId) {
          const ctx = createOperationContext('system');
          this.log.warn(
            ctx,
            `rejected ${label} envelope for cg=${env.envelope.contextGraphId} delivered on cg=${contextGraphId}`,
          );
          return undefined;
        }
        return { payload: env.envelope.payload, recoveredSigner: env.recoveredSigner };
      }
      // `kind === 'raw'`: bytes were not an envelope at all (legacy
      // pre-r6 gossip). When the mesh has been fully upgraded, enable
      // `strictGossipEnvelope` (or `DKG_STRICT_GOSSIP_ENVELOPE=1`) to
      // drop raw gossip entirely. During rolling upgrade we still accept
      // raw so legacy peers don't fall off the mesh, but we log each one
      // so operators can see who still needs upgrading.
      if (strictEnvelope) {
        const ctx = createOperationContext('system');
        this.log.warn(ctx, `rejected raw ${label} gossip on cg=${contextGraphId} (strictGossipEnvelope)`);
        return undefined;
      }
      return { payload: data, recoveredSigner: undefined };
    };

    this.gossip.onMessage(publishTopic, async (_topic, data, from) => {
      const ing = dispatchIngress('publish', data);
      if (!ing) return;
      const gph = this.getOrCreateGossipPublishHandler();
      // r23-4: pass the envelope's recovered signer so
      // GossipPublishHandler can enforce the cryptographic link
      // between the envelope signature and the inner PublishRequest's
      // claimed publisher address.
      await gph.handlePublishMessage(
        ing.payload, contextGraphId, undefined, from, ing.recoveredSigner,
      );
    });

    this.gossip.onMessage(swmTopic, async (_topic, data, from) => {
      const ing = dispatchIngress('swm', data);
      if (!ing) return;
      const wh = this.getOrCreateSharedMemoryHandler();
      await wh.handle(ing.payload, from);
    });

    const updateTopic = paranetUpdateTopic(contextGraphId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const ing = dispatchIngress('update', data);
      if (!ing) return;
      const uh = this.getOrCreateUpdateHandler();
      // r23-4: thread envelope signer so UpdateHandler can enforce the
      // publisher-attribution link before hitting chain RPC.
      await uh.handle(ing.payload, from, ing.recoveredSigner);
    });

    const finalizationTopic = paranetFinalizationTopic(contextGraphId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data) => {
      const ing = dispatchIngress('finalization', data);
      if (!ing) return;
      const fh = this.getOrCreateFinalizationHandler();
      // r23-4: thread envelope signer so FinalizationHandler can
      // enforce attribution before chain RPC.
      await fh.handleFinalizationMessage(ing.payload, contextGraphId, ing.recoveredSigner);
    });
  }

  /**
   * Add a context graph to runtime sync scope so sync-on-connect includes it.
   * System context graphs are already included by default and are skipped here.
   */
  private trackSyncContextGraph(contextGraphId: string): void {
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_PARANETS) as string[]);
    if (systemContextGraphs.has(contextGraphId)) return;

    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.has(contextGraphId)) return;
    syncSet.add(contextGraphId);
    this.config.syncContextGraphs = [...syncSet];
  }

  private getOrCreateGossipPublishHandler(): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedContextGraphs,
        {
          contextGraphExists: (id) => this.contextGraphExists(id),
          // Gossip validation compares `approvedBy`/`revokedBy` against the
          // paranet owner. Those triples are emitted with `dkg:creator` (peer
          // DID) so peers validate against the same creator-scoped DID.
          // `dkg:curator` (wallet DID) is for local authorization only.
          getContextGraphOwner: (id) => this.getContextGraphCreator(id),
          subscribeToContextGraph: (id, options) => this.subscribeToContextGraph(id, options),
          hasConfirmedMetaState: (id) => this.hasConfirmedMetaState(id),
        },
      );
    }
    return this.gossipPublishHandler;
  }

  private getOrCreateSharedMemoryHandler(): InstanceType<typeof SharedMemoryHandler> {
    if (!this.sharedMemoryHandler) {
      this.sharedMemoryHandler = new SharedMemoryHandler(this.store, this.eventBus, {
        sharedMemoryOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
      });
    }
    return this.sharedMemoryHandler;
  }

  private updateHandler?: UpdateHandler;

  private getOrCreateUpdateHandler(): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchContextGraphs: this.publisher.knownBatchContextGraphs,
      });
    }
    return this.updateHandler;
  }

  private getOrCreateFinalizationHandler(): FinalizationHandler {
    if (!this.finalizationHandler) {
      this.finalizationHandler = new FinalizationHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
      );
    }
    return this.finalizationHandler;
  }

  /**
   * Create a context graph. All CGs start as free, P2P collaborative spaces.
   * No blockchain transaction is required. On-chain registration is a separate
   * explicit step via {@link registerContextGraph}.
   *
   * The `private` flag still works for truly local-only CGs (no gossip, no sync).
   * For curated CGs, provide `allowedPeers` to restrict gossip writes to listed peers.
   */
  async createContextGraph(opts: {
    id: string;
    name: string;
    description?: string;
    replicationPolicy?: string;
    accessPolicy?: number;
    /** @deprecated Use allowedAgents. Peer allowlist for curated CGs. */
    allowedPeers?: string[];
    /** Agent address allowlist for curated CGs. Omit for open CGs. */
    allowedAgents?: string[];
    /** Identity IDs for private CG access control (chain-based). */
    participantIdentityIds?: bigint[];
    /** Required signatures threshold for participant-based CGs. */
    requiredSignatures?: number;
    /** Participant agent addresses for on-chain context graphs. */
    participantAgents?: string[];
    /** When true, skips gossip subscription and broadcast. Data stays local-only. */
    private?: boolean;
    /** Caller's agent address (resolved from token). Used for curator/creator triples. */
    callerAgentAddress?: string;
  }): Promise<void> {
    const ctx = createOperationContext('system');
    const gm = new GraphManager(this.store);
    const paranetUri = `did:dkg:context-graph:${opts.id}`;
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      throw new Error(`Context graph "${opts.id}" already exists`);
    }

    const hasLocalAccessControl = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || opts.private === true
      || !!opts.allowedAgents?.length
      || !!opts.allowedPeers?.length;
    if (opts.participantAgents && opts.participantAgents.length > 0 && !hasLocalAccessControl) {
      throw new Error(
        'participantAgents are on-chain registration metadata for curated context graphs. ' +
        'Set accessPolicy: 1 (or private: true) and use allowedAgents for local access control.',
      );
    }

    const isCurated = opts.accessPolicy === LOCAL_ACCESS_CURATED
      || (opts.allowedAgents && opts.allowedAgents.length > 0)
      || (opts.allowedPeers && opts.allowedPeers.length > 0);

    if (opts.private) {
      this.log.info(ctx, `Creating private context graph "${opts.id}" (local-only, no gossip)`);
    } else if (isCurated) {
      this.log.info(ctx, `Creating curated context graph "${opts.id}" (invite-only, definition hidden from ONTOLOGY)`);
    } else {
      this.log.info(ctx, `Creating context graph "${opts.id}" (P2P, no chain)`);
    }

    // Curated CGs store definition triples in their own _meta graph so they
    // are NOT discoverable via ONTOLOGY sync. Only invited/subscribed nodes
    // will see them. Open CGs go to ONTOLOGY for network-wide discovery.
    const defGraph = isCurated ? cgMetaGraph : ontologyGraph;

    // DKG_CREATOR records the libp2p peer ID of the hosting node — this is
    // the deterministic handle used by `resolveCuratorPeerId()` to dial the
    // curator for meta refreshes. It must NOT be replaced with a wallet DID.
    //
    // DKG_CURATOR records the caller's wallet identity and is what ownership
    // checks consult (via `getContextGraphOwner`). When a non-default local
    // agent creates a CG, its wallet DID ends up here so later authorization
    // — threaded through daemon routes as `callerAgentAddress` — can match.
    //
    // On-chain operations (registerContextGraph, verify) still bind to the
    // node wallet; per-agent chain signers are a known future enhancement.
    const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
    const curatorDid = `did:dkg:agent:${opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`;
    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"${opts.replicationPolicy ?? 'full'}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${isCurated || opts.private ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // Store registration status and curator in _meta
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
    );

    // Store peer allowlist for curated CGs (with validation)
    if (opts.allowedPeers && opts.allowedPeers.length > 0) {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      for (const peer of opts.allowedPeers) {
        try { peerIdFromString(peer); } catch {
          throw new Error(`Invalid peer ID in allowedPeers: "${peer}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
        }
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
          object: `"${escapeSparqlLiteral(peer)}"`,
          graph: cgMetaGraph,
        });
      }
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${this.peerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Store agent allowlist (V10 agent identity model)
    if (opts.allowedAgents && opts.allowedAgents.length > 0) {
      const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
      for (const addr of opts.allowedAgents) {
        if (!ethAddrRe.test(addr)) {
          throw new Error(`Invalid Ethereum address in allowedAgents: "${addr}".`);
        }
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${addr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store explicit on-chain participant agents separately from the local
    // curated allowlist. These addresses are forwarded to
    // ContextGraphs.createContextGraph participantAgents on registration.
    if (opts.participantAgents && opts.participantAgents.length > 0) {
      if (opts.participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
        throw new Error(`participantAgents cannot exceed ${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses.`);
      }
      const seenParticipantAgents = new Set<string>();
      for (const addr of opts.participantAgents) {
        if (!ethers.isAddress(addr)) {
          throw new Error(`Invalid Ethereum address in participantAgents: "${addr}".`);
        }
        const checksumAddress = ethers.getAddress(addr);
        if (checksumAddress === ethers.ZeroAddress) {
          throw new Error('Invalid Ethereum address in participantAgents: zero address is not allowed.');
        }
        const key = checksumAddress.toLowerCase();
        if (seenParticipantAgents.has(key)) {
          throw new Error(`Duplicate Ethereum address in participantAgents: "${checksumAddress}".`);
        }
        seenParticipantAgents.add(key);
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
          object: `"${checksumAddress}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Auto-include creator in allowlist for curated/private CGs
    if (isCurated || opts.private) {
      const creatorAddr = opts.callerAgentAddress ?? this.defaultAgentAddress;
      if (creatorAddr) {
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${creatorAddr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store participant identity IDs for private CG access control (chain-based, legacy)
    const creatorIdentityId = await this.chain.getIdentityId();
    const participantIdentityIds = new Set<bigint>(opts.participantIdentityIds ?? []);
    if (creatorIdentityId > 0n) {
      participantIdentityIds.add(creatorIdentityId);
    }
    for (const participantIdentityId of participantIdentityIds) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID,
        object: `"${participantIdentityId.toString()}"`,
        graph: cgMetaGraph,
      });
    }
    if (participantIdentityIds.size > 0 && typeof opts.requiredSignatures === 'number' && opts.requiredSignatures > 0) {
      const reqSig = Math.floor(opts.requiredSignatures);
      if (reqSig < 1) {
        throw new Error(`requiredSignatures must be >= 1, got ${opts.requiredSignatures}`);
      }
      if (reqSig > participantIdentityIds.size) {
        throw new Error(`requiredSignatures (${reqSig}) exceeds participant count (${participantIdentityIds.size})`);
      }
      quads.push({
        subject: paranetUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}RequiredSignatures`,
        object: `"${reqSig}"`,
        graph: cgMetaGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    // Provenance activity
    const activityUri = `did:dkg:activity:create-context-graph:${opts.id}:${Date.now()}`;
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.PROV_GENERATED_BY, object: activityUri, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.PROV_ACTIVITY, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ASSOCIATED_WITH, object: `did:dkg:agent:${this.peerId}`, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ENDED_AT_TIME, object: `"${now}"`, graph: defGraph },
    );

    await this.store.insert(quads);
    await gm.ensureParanet(opts.id);

    this.subscribedContextGraphs.set(opts.id, {
      name: opts.name,
      subscribed: !opts.private,
      synced: true,
      metaSynced: true,
    });

    // On-chain registration is intentionally NOT done here — per v10 spec
    // §2.2 / §2.3 Context Graphs are a local-first primitive. A CG exists
    // the moment its definition triples land in the store; it can be
    // shared with peers over gossip (SWM writes/reads work across the
    // subscriber set), joined, sub-graphed, and queried without ever
    // touching chain state. Verified Memory is the value-add layer that
    // requires chain registration, and earlier revisions silently minted
    // a `ContextGraphs.createContextGraph` tx from inside this method
    // whenever the adapter supported it. That broke the "free CG"
    // contract the API advertises (HTTP caller opts in via
    // `register: true` on `/api/context-graph/create`), caused surprise
    // TRAC spend, and made test §27e's "VM publish on unregistered CG
    // should fail" impossible to satisfy — the CG was always already
    // registered by the time the test ran.
    //
    // Callers that want on-chain registration MUST now take the
    // explicit path: either `POST /api/context-graph/create` with
    // `register: true` (daemon chains a `registerContextGraph` call
    // after this method returns) or `POST /api/context-graph/register`
    // on an existing local CG. Both paths go through
    // {@link registerContextGraph}, which preserves the creator /
    // curator checks and writes the V10 `onChainId` + flips
    // `dkg:registrationStatus` to `"registered"`. Until then the CG
    // carries the `unregistered` marker inserted above, and
    // `dkg-publisher`'s `publishFromSharedMemory` guard
    // (`packages/publisher/src/dkg-publisher.ts:569-594`) throws
    // `Context graph "<id>" is not registered on-chain` on any VM
    // publish attempt.

    if (!opts.private) {
      this.subscribeToContextGraph(opts.id);

      // Curated CGs: definition lives in _meta, NOT in ONTOLOGY. Do not
      // broadcast to the network — only invited nodes will discover it via
      // the explicit subscribe→sync flow.
      if (!isCurated) {
        const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
        const broadcastQuads = quads.filter(q => q.graph === ontologyGraph);
        const nquads = broadcastQuads.map(q => {
          const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
          return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
        }).join('\n');

        const ualCG = `did:dkg:context-graph:${opts.id}`;
        const nquadsBufCG = new TextEncoder().encode(nquads);
        const sigWalletCG = this.getDefaultPublisherWallet();
        const sigCG = buildPublishRequestSig(sigWalletCG, ualCG, nquadsBufCG);
        const msg = encodePublishRequest({
          ual: ualCG,
          nquads: nquadsBufCG,
          paranetId: SYSTEM_PARANETS.ONTOLOGY,
          kas: [],
          publisherIdentity: this.wallet.keypair.publicKey,
          publisherAddress: sigWalletCG?.address ?? '',
          startKAId: 0,
          endKAId: 0,
          chainId: '',
          publisherSignatureR: sigCG.publisherSignatureR,
          publisherSignatureVs: sigCG.publisherSignatureVs,
        });

        try {
          await this.signedGossipPublish(ontologyTopic, 'PUBLISH_REQUEST', SYSTEM_PARANETS.ONTOLOGY, msg);
        } catch (err) {
          // r22-6: surface signing failures with a distinctive ERROR
          // so operators can see them; transport "no subscribers" is
          // expected during local-only / pre-bootstrap flows.
          logSignedGossipFailure(this.log, ctx, ontologyTopic, err);
        }
      }
    }
  }

  /**
   * Register an existing context graph on-chain. This is the explicit upgrade
   * step that unlocks Verified Memory, chain-based discovery, and economic
   * participation. Requires a funded wallet with TRAC.
   */
  async registerContextGraph(id: string, opts?: {
    /** @deprecated V10 ContextGraphs registration ignores metadata reveal. */
    revealOnChain?: boolean;
    accessPolicy?: number;
    callerAgentAddress?: string;
  }): Promise<{ onChainId: string; txHash?: string }> {
    const ctx = createOperationContext('system');

    if (opts?.revealOnChain === true) {
      this.log.warn(
        ctx,
        'revealOnChain is deprecated and ignored by V10 ContextGraphs registration; metadata reveal uses the legacy name registry path.',
      );
    }

    const exists = await this.contextGraphExists(id);
    if (!exists) {
      throw new Error(`Context graph "${id}" does not exist locally. Create it first.`);
    }

    if (this.chain.chainId === 'none') {
      throw new Error('On-chain registration requires a configured chain adapter');
    }

    // Only the address-scoped curator can register a CG on-chain.
    // Peer IDs are transport contact handles for sync/meta refresh, not EVM
    // authority identifiers. For legacy local CGs that only have a creator
    // peer DID, the local creator node may lazily stamp its address curator
    // before registering; foreign peer-only CGs must first sync a curator.
    //
    // If no owner triple exists yet (bootstrap CGs created via
    // `ensureContextGraphLocal` deliberately do not stamp ownership), the
    // calling node lazily becomes both creator/contact and curator here.
    // This keeps the stamp single-writer (no race over `LIMIT 1`).
    const selfPeerDid = `did:dkg:agent:${this.peerId}`;
    const stampAddressCurator = async (): Promise<string> => {
      const curatorAddress = opts?.callerAgentAddress ?? this.defaultAgentAddress;
      if (!curatorAddress || !ethers.isAddress(curatorAddress)) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an address-scoped curator. ` +
          'Use an authenticated agent wallet or configure a default agent address.',
        );
      }

      const cgMetaGraph = contextGraphMetaUri(id);
      const ontologyGraph = contextGraphDataUri(SYSTEM_PARANETS.ONTOLOGY);
      const paranetUri = `did:dkg:context-graph:${id}`;
      const accessPolicyResult = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      const apValue = accessPolicyResult.type === 'bindings'
        ? accessPolicyResult.bindings[0]?.['ap']?.replace(/^"|"$/g, '')
        : undefined;
      const isCurated = apValue === 'private';
      const defGraph = isCurated ? cgMetaGraph : ontologyGraph;
      const creatorPeerDid = `did:dkg:agent:${this.peerId}`;
      const curatorDid = `did:dkg:agent:${curatorAddress}`;
      // Defensive: replace any stray creator/curator triples (e.g. from
      // a previous build that backfilled per node) so this register call
      // becomes the single source of truth.
      await this.store.deleteByPattern({ graph: defGraph, subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await this.store.deleteByPattern({ graph: cgMetaGraph, subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR });
      await this.store.deleteByPattern({ graph: cgMetaGraph, subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CURATOR });
      await this.store.insert([
        { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creatorPeerDid, graph: defGraph },
        { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curatorDid, graph: cgMetaGraph },
      ]);
      this.log.info(ctx, `Stamped local node as creator contact and address curator for "${id}" (registration-time lazy stamp)`);
      return curatorDid;
    };

    let owner = await this.getContextGraphCurator(id);
    if (!owner) {
      const existingCreator = await this.getContextGraphCreator(id);
      if (existingCreator && !this.isCallerOrNodeOwner(existingCreator, opts?.callerAgentAddress)) {
        throw new Error(
          `Context graph "${id}" has no address-scoped curator and was created by ${existingCreator}. ` +
          'Sync curator metadata or ask the curator to register it on-chain.',
        );
      }
      owner = await stampAddressCurator();
    } else {
      const ownerTail = owner.replace(/^did:dkg:agent:/, '');
      if (!ethers.isAddress(ownerTail)) {
        if (owner === selfPeerDid) {
          owner = await stampAddressCurator();
        } else {
          throw new Error(
            `Context graph "${id}" has a peer-scoped curator (${owner}) and cannot be registered on-chain by this node. ` +
            'Sync address-scoped curator metadata or ask the curator to register it on-chain.',
          );
        }
      }
    }
    if (!this.isCallerOrNodeAddressOwner(owner, opts?.callerAgentAddress)) {
      throw new Error(
        `Only the context graph curator can register it on-chain. ` +
        `Curator=${owner}, caller=${`did:dkg:agent:${opts?.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`,
      );
    }
    const ownerAddress = ethers.getAddress(owner.replace(/^did:dkg:agent:/, ''));
    // Check if already registered
    const cgMetaGraph = contextGraphMetaUri(id);
    const paranetUri = `did:dkg:context-graph:${id}`;
    const statusResult = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    if (statusResult.type === 'bindings' && statusResult.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered') {
      const existingOnChainId = this.subscribedContextGraphs.get(id)?.onChainId;
      throw new Error(`Context graph "${id}" is already registered on-chain${existingOnChainId ? ` (${existingOnChainId})` : ''}`);
    }

    // Read existing description and access policy. Curated CGs store
    // definition in _meta rather than ONTOLOGY, so check both locations.
    const ontologyGraph = contextGraphDataUri(SYSTEM_PARANETS.ONTOLOGY);
    const descResult = await this.store.query(
      `SELECT ?desc WHERE {
        { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
        UNION
        { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
      } LIMIT 1`,
    );
    const description = descResult.type === 'bindings' ? descResult.bindings[0]?.['desc']?.replace(/^"|"$/g, '') : undefined;

    let resolvedLocalAccessPolicy = opts?.accessPolicy;
    if (resolvedLocalAccessPolicy !== undefined && resolvedLocalAccessPolicy !== LOCAL_ACCESS_OPEN && resolvedLocalAccessPolicy !== LOCAL_ACCESS_CURATED) {
      throw new Error('accessPolicy must be 0 (open) or 1 (private/curated)');
    }
    if (resolvedLocalAccessPolicy === undefined) {
      resolvedLocalAccessPolicy = await this.isPrivateContextGraph(id)
        ? LOCAL_ACCESS_CURATED
        : LOCAL_ACCESS_OPEN;
    }
    const publishPolicy = resolvedLocalAccessPolicy === LOCAL_ACCESS_CURATED
      ? EVM_PUBLISH_CURATED
      : EVM_PUBLISH_OPEN;

    const participantsResult = await this.store.query(
      `SELECT ?identityId WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId } }`,
    );
    const participantIdentityIds = participantsResult.type === 'bindings'
      ? participantsResult.bindings
          .map((binding) => binding['identityId']?.replace(/^"|"$/g, ''))
          .filter((value): value is string => !!value)
          .map((value) => BigInt(value))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .filter((value, index, arr) => index === 0 || value !== arr[index - 1])
      : [];

    const requiredSignaturesResult = await this.store.query(
      `SELECT ?required WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}RequiredSignatures> ?required } } LIMIT 1`,
    );
    const storedRequiredSignatures = requiredSignaturesResult.type === 'bindings'
      ? Number(requiredSignaturesResult.bindings[0]?.['required']?.replace(/^"|"$/g, ''))
      : NaN;

    // Check if already registered on-chain (prevents duplicate minting)
    const existingOnChainId = await this.getContextGraphOnChainId(id);
    if (existingOnChainId) {
      this.log.info(ctx, `Context graph "${id}" already has on-chain ID ${existingOnChainId} — skipping chain call`);
      await this.store.deleteByPattern({
        graph: cgMetaGraph,
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
      });
      await this.store.insert([
        { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      ]);
      return { onChainId: existingOnChainId, txHash: undefined };
    }

    let effectiveParticipantIdentityIds = participantIdentityIds;
    if (effectiveParticipantIdentityIds.length === 0) {
      const selfIdentityId = await this.ensureIdentity();
      if (selfIdentityId === 0n) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an on-chain identity. ` +
          'Create/ensure the curator identity first.',
        );
      }
      effectiveParticipantIdentityIds = [selfIdentityId];
    }

    const effectiveRequiredSignatures = Number.isInteger(storedRequiredSignatures) && storedRequiredSignatures > 0
      ? storedRequiredSignatures
      : 1;
    const participantAgents = await this.getContextGraphParticipantAgentAddresses(id);
    if (participantAgents.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
      throw new Error(
        `Context graph "${id}" cannot be registered on-chain: participantAgents cannot exceed ` +
        `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after merging local allowedAgents.`,
      );
    }
    const publishAuthority = publishPolicy === EVM_PUBLISH_CURATED
      ? this.getChainPublishAuthorityAddress()
      : undefined;
    if (
      publishPolicy === EVM_PUBLISH_CURATED
      && publishAuthority
      && ownerAddress.toLowerCase() !== publishAuthority.toLowerCase()
    ) {
      throw new Error(
        `Context graph "${id}" cannot be registered as curated by local curator ${ownerAddress} ` +
        `because the configured chain signer is ${publishAuthority}. Per-agent chain signers are not supported yet.`,
      );
    }
    if (
      publishPolicy === EVM_PUBLISH_CURATED
      && !publishAuthority
      && opts?.callerAgentAddress
      && this.defaultAgentAddress
      && opts.callerAgentAddress.toLowerCase() !== this.defaultAgentAddress.toLowerCase()
    ) {
      throw new Error(
        `Context graph "${id}" cannot be registered as curated by non-default local curator ` +
        `${opts.callerAgentAddress} without chain signer introspection. Per-agent chain signers are not supported yet.`,
      );
    }

    const result = await this.registerContextGraphOnChain({
      participantIdentityIds: effectiveParticipantIdentityIds,
      requiredSignatures: effectiveRequiredSignatures,
      publishPolicy,
      ...(publishAuthority ? { publishAuthority } : {}),
      participantAgents,
    });
    const onChainId = result.contextGraphId.toString();

    this.log.info(ctx, `Context graph "${id}" registered on-chain: ${onChainId}`);

    // Update _meta with registered status and on-chain ID
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
    });
    await this.store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      { subject: paranetUri, predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`, object: `"${onChainId}"`, graph: ontologyGraph },
    ]);

    // Update in-memory subscription record and ensure we're subscribed
    const sub = this.subscribedContextGraphs.get(id);
    if (sub) {
      sub.onChainId = onChainId;
      if (!sub.subscribed) {
        sub.subscribed = true;
        this.subscribeToContextGraph(id, { trackSyncScope: true });
        this.log.info(ctx, `Subscribed to newly registered context graph "${id}"`);
      }
    }

    // Registration status is in _meta — it propagates to peers via sync, not
    // gossip, so that only the authenticated sync path can update it.
    // Broadcast the ontology-graph OnChainId quad so peers see the link.
    const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
    try {
      const onChainNquad = `<${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}OnChainId> "${onChainId}" <${ontologyGraph}> .`;
      const ualReg = `did:dkg:context-graph:${id}`;
      const nquadsBufReg = new TextEncoder().encode(onChainNquad);
      const sigWalletReg = this.getDefaultPublisherWallet();
      const sigReg = buildPublishRequestSig(sigWalletReg, ualReg, nquadsBufReg);
      const regMsg = encodePublishRequest({
        ual: ualReg,
        nquads: nquadsBufReg,
        paranetId: SYSTEM_PARANETS.ONTOLOGY,
        kas: [],
        publisherIdentity: this.wallet.keypair.publicKey,
        publisherAddress: sigWalletReg?.address ?? '',
        startKAId: 0,
        endKAId: 0,
        chainId: '',
        publisherSignatureR: sigReg.publisherSignatureR,
        publisherSignatureVs: sigReg.publisherSignatureVs,
      });
      await this.signedGossipPublish(ontologyTopic, 'PUBLISH_REQUEST', SYSTEM_PARANETS.ONTOLOGY, regMsg);
    } catch (err) {
      // r22-6: signing failures surfaced as ERROR (distinct from
      // the quiet-network debug case). `logSignedGossipFailure`
      // uses WARN for the non-signing branch; preserve the original
      // debug-only behaviour for the no-subscribers case here by
      // dispatching manually instead.
      if (isSignedGossipSigningError(err)) {
        logSignedGossipFailure(this.log, ctx, ontologyTopic, err);
      } else {
        this.log.debug(ctx, `Registration gossip broadcast failed (peers may not be subscribed yet): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { onChainId };
  }

  /**
   * Invite a peer to join an existing context graph.
   * Adds the peer to the local allowlist in `_meta`.
   */
  async inviteToContextGraph(contextGraphId: string, peerId: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');

    // Validate peer ID format (libp2p Ed25519 base58btc, e.g. 12D3KooW…)
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      peerIdFromString(peerId);
    } catch {
      throw new Error(`Invalid peer ID format: "${peerId}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    // Only the curator/creator can manage the allowlist
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage peer invitations');

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const escapedPeerId = escapeSparqlLiteral(peerId);

    const existingAllowlist = await this.getContextGraphAllowedPeers(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If this is the first allowlist entry (CG was open), also add our own
    // peer ID so the curator doesn't lock themselves out.
    if (existingAllowlist === null || existingAllowlist.length === 0) {
      const curatorPeerId = escapeSparqlLiteral(this.peerId);
      quadsToInsert.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${curatorPeerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Skip if already in the allowlist (idempotent)
    if (existingAllowlist?.includes(peerId)) {
      this.log.info(ctx, `Peer ${peerId} already in allowlist for "${contextGraphId}" — skipping`);
      return;
    }

    quadsToInsert.push({
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${escapedPeerId}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);

    // Allowlist updates are in _meta and propagate to peers via the
    // authenticated sync protocol, not unauthenticated gossip.

    this.log.info(ctx, `Invited peer ${peerId} to context graph "${contextGraphId}"`);
  }

  /**
   * Invite an agent (by Ethereum address) to join an existing context graph.
   * Adds the agent to the local allowlist in `_meta`.
   */
  async inviteAgentToContextGraph(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage invitations');

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If first allowlist entry, also add our own agent so the curator doesn't lock themselves out
    const existingParticipants = await this.getPrivateContextGraphParticipants(contextGraphId);
    if ((!existingParticipants || existingParticipants.length === 0) && this.defaultAgentAddress) {
      quadsToInsert.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${this.defaultAgentAddress}"`,
        graph: cgMetaGraph,
      });
    }

    quadsToInsert.push({
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);

    this.log.info(ctx, `Invited agent ${agentAddress} to context graph "${contextGraphId}"`);
  }

  /**
   * Remove an agent from a context graph's allowlist.
   */
  async removeAgentFromContextGraph(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage participants');

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
    });

    this.log.info(ctx, `Removed agent ${agentAddress} from context graph "${contextGraphId}"`);
  }

  /**
   * Rename a context graph (updates its `schema:name` display label).
   *
   * Writes into BOTH the ONTOLOGY graph (primary source for
   * `listContextGraphs()` on open CGs) and the CG's `_meta` graph
   * (used as the private/curated CG definition index) so the rename is
   * durable regardless of which graph type the CG was originally created
   * in. Previous display-name triples are wiped from both graphs first
   * to guarantee idempotent rename (no "two names in the store").
   *
   * Authorization: same as other CG mutations — only the creator can
   * rename. Enforced via `assertCallerIsOwner`.
   */
  async renameContextGraph(
    contextGraphId: string,
    name: string,
    callerAgentAddress?: string,
  ): Promise<void> {
    const ctx = createOperationContext('system');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      throw new Error('Context graph name must be a non-empty string.');
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'rename context graph');

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const schemaName = DKG_ONTOLOGY.SCHEMA_NAME;

    await this.store.deleteByPattern({
      subject: paranetUri,
      predicate: schemaName,
      graph: ontologyGraph,
    });
    await this.store.deleteByPattern({
      subject: paranetUri,
      predicate: schemaName,
      graph: cgMetaGraph,
    });

    const escaped = `"${escapeSparqlLiteral(trimmed)}"`;
    await this.store.insert([
      { subject: paranetUri, predicate: schemaName, object: escaped, graph: ontologyGraph },
      { subject: paranetUri, predicate: schemaName, object: escaped, graph: cgMetaGraph },
    ]);

    this.log.info(ctx, `Renamed context graph "${contextGraphId}" to "${trimmed}"`);
  }

  /**
   * List allowed agents for a context graph.
   */
  async getContextGraphAllowedAgents(contextGraphId: string): Promise<string[]> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${paranetUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings
      .map((row) => (row as Record<string, string>)['agent'])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^"|"$/g, ''));
  }

  // ---------------------------------------------------------------------------
  // Join Request — signed request / approval flow for curated CGs
  // ---------------------------------------------------------------------------

  /**
   * Create a signed join request for a curated context graph.
   * The requesting agent signs `keccak256(contextGraphId ‖ agentAddress ‖ timestamp)`
   * with its custodial wallet, producing a verifiable proof of identity.
   */
  async signJoinRequest(
    contextGraphId: string,
    agentAddress?: string,
  ): Promise<{ contextGraphId: string; agentAddress: string; timestamp: number; signature: string }> {
    const addr = agentAddress ?? this.defaultAgentAddress;
    if (!addr) throw new Error('No agent address available');

    const agent = this.localAgents.get(addr);
    if (!agent?.privateKey) {
      throw new Error(`No private key for agent ${addr} — self-sovereign agents must sign externally`);
    }

    const timestamp = Date.now();
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, addr.toLowerCase(), timestamp],
    );
    const wallet = new ethers.Wallet(agent.privateKey);
    const signature = await wallet.signMessage(ethers.getBytes(digest));
    return { contextGraphId, agentAddress: addr, timestamp, signature };
  }

  /**
   * Verify a signed join request by recovering the signer address.
   * Returns the recovered Ethereum address if valid, throws on failure.
   */
  verifyJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    timestamp: number,
    signature: string,
  ): string {
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
    if (Date.now() - timestamp > MAX_AGE_MS) {
      throw new Error('Join request expired');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, agentAddress.toLowerCase(), timestamp],
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), signature);
    if (recovered.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error(`Signature mismatch: expected ${agentAddress}, recovered ${recovered}`);
    }
    return recovered;
  }

  /**
   * Store a pending join request in the CG's _meta graph.
   * The curator can later approve or reject it.
   */
  async storePendingJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    signature: string,
    timestamp: number,
    agentName?: string,
  ): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    // Remove any prior pending request from this agent
    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: requestUri });

    const quads: Quad[] = [
      { subject: requestUri, predicate: RDF_TYPE, object: `${DKG}JoinRequest`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}agentAddress`, object: `"${agentAddress}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}contextGraphId`, object: `"${contextGraphId}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}signature`, object: `"${signature}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestTimestamp`, object: `"${timestamp}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestStatus`, object: `"pending"`, graph: cgMetaGraph },
    ];
    if (agentName) {
      quads.push({ subject: requestUri, predicate: SCHEMA_NAME, object: `"${agentName}"`, graph: cgMetaGraph });
    }
    await this.store.insert(quads);
    const ctx = createOperationContext('system');
    this.log.info(ctx, `Stored pending join request from ${agentAddress} for "${contextGraphId}"`);
  }

  /**
   * List pending join requests for a context graph.
   */
  async listPendingJoinRequests(
    contextGraphId: string,
  ): Promise<Array<{ agentAddress: string; name?: string; signature: string; timestamp: number; status: string }>> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?addr ?name ?sig ?ts ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}agentAddress> ?addr ;
               <${DKG}signature> ?sig ;
               <${DKG}requestTimestamp> ?ts ;
               <${DKG}requestStatus> ?status .
          OPTIONAL { ?req <https://schema.org/name> ?name }
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    return result.bindings.map((row) => ({
      agentAddress: strip(row['addr']),
      name: row['name'] ? strip(row['name']) : undefined,
      signature: strip(row['sig']),
      timestamp: parseInt(strip(row['ts']), 10) || 0,
      status: strip(row['status']),
    })).filter((r) => r.status === 'pending');
  }

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    // Fetch the stored request to verify the signature
    const result = await this.store.query(
      `SELECT ?sig ?ts WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}signature> ?sig ;
                          <${DKG}requestTimestamp> ?ts ;
                          <${DKG}requestStatus> "pending" .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      throw new Error(`No pending join request found from ${agentAddress}`);
    }
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    const signature = strip(result.bindings[0]['sig']);
    const timestamp = parseInt(strip(result.bindings[0]['ts']), 10) || 0;

    // Verify the signature (30-minute expiry is relaxed for approvals — curator may take time)
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, agentAddress.toLowerCase(), timestamp],
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), signature);
    if (recovered.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error(`Signature verification failed: expected ${agentAddress}, recovered ${recovered}`);
    }

    // Add agent to allowlist
    await this.inviteAgentToContextGraph(contextGraphId, agentAddress, callerAgentAddress);

    // Mark request as approved
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"approved"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the approved agent so their node
   * automatically retries the subscription.
   *
   * Delivers the message ONLY to the requester's peer, resolved via the
   * local agent registry. The earlier implementation broadcast to every
   * connected peer and relied on each recipient's handler to filter by
   * `agentAddress`. That leaked membership information for curated
   * context graphs: every peer on the P2P network learned that
   * `agentAddress` had just been invited to `contextGraphId`, which is
   * exactly the metadata a curated CG is supposed to hide.
   *
   * If the requester isn't in the local registry we fall back to a
   * best-effort dial through their relay address when available. We do
   * NOT broadcast in any case — the invitee will re-learn on their next
   * subscribe attempt if the direct notification fails.
   */
  private async notifyJoinApproval(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    return this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-approval');
  }

  /**
   * Reject a pending join request.
   */
  async rejectJoinRequest(contextGraphId: string, agentAddress: string): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"rejected"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Rejected join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so their UI can flip from the stale
    // "Join request sent, awaiting approval" state to a clear denied
    // state. Non-fatal: if the invitee is unreachable they'll just
    // re-learn on their next subscribe attempt.
    this.notifyJoinRejection(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of rejection: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the rejected agent. Same privacy model
   * as `notifyJoinApproval` — delivered only to the rejectee's peer,
   * never broadcast. See that method's doc comment for rationale.
   */
  private async notifyJoinRejection(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-rejected',
      contextGraphId,
      agentAddress,
    });
    return this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-rejection');
  }

  /**
   * Resolve the target agent's peer ID and send the payload only to that
   * peer. Never broadcasts — leaking a curated CG's membership to every
   * peer on the network is a real privacy violation, and dropping the
   * notification is a far milder failure (the invitee relearns on next
   * subscribe).
   *
   * Two resolution sources, in order:
   *
   *   1. `joinRequestOriginPeers` — the peer that actually delivered the
   *      original join request over P2P. Set by the handler at register
   *      time and persists for the curator's process lifetime. This
   *      avoids a regression from the old broadcast implementation: the
   *      requester may reach us via P2P before their agent profile is
   *      indexed locally, so relying on `findAgents()` alone would drop
   *      every approval/rejection until registry replication catches up.
   *   2. `discovery.findAgents()` fallback for the case where the
   *      curator restarted between receiving the request and acting on
   *      it (and thus lost the in-memory peer mapping).
   *
   * @returns void (logged success/failure; callers treat this as
   *          fire-and-forget)
   */
  private async deliverPrivateJoinNotification(
    contextGraphId: string,
    agentAddress: string,
    payload: string,
    label: 'join-approval' | 'join-rejection',
  ): Promise<void> {
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const addrLower = agentAddress.toLowerCase();

    let targetPeerId: string | null = null;
    let targetRelayAddress: string | undefined;

    // Preferred source: the peer that actually delivered the join
    // request. This is always correct for the common flow and doesn't
    // depend on registry replication timing.
    const originKey = `${contextGraphId}::${addrLower}`;
    const rememberedPeerId = this.joinRequestOriginPeers.get(originKey);
    if (rememberedPeerId) {
      targetPeerId = rememberedPeerId;
    }

    // Always consult the registry when we either had no remembered peer
    // OR we have one but no live connection to it right now. This fixes
    // two related regressions:
    //
    //   * If the requester disconnected between submitting the request
    //     and the curator acting on it, with only the remembered-peer
    //     path we'd have no relay address to redial and the
    //     notification would be silently dropped even though the
    //     registry knows exactly how to reach them.
    //   * If the requester reconnected with a brand-new peer ID (e.g.
    //     ephemeral peer IDs, node restart on a volatile host), the
    //     remembered ID is now stale. Sending to a dead peer ID just
    //     times out; the registry's current peer ID is authoritative.
    //
    // So when the remembered peer isn't connected, we REPLACE it with
    // the registry's current peer ID (not just supplement it with a
    // relay hint), which is what Codex N25 asks for. Registry lookup is
    // cheap (local graph query).
    const rememberedIsConnected = rememberedPeerId
      ? this.node.libp2p
          .getConnections()
          .some((c) => c.remotePeer.toString() === rememberedPeerId)
      : false;
    if (!targetPeerId || !rememberedIsConnected) {
      try {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === addrLower);
        if (match) {
          // Take the registry's peer ID whenever we don't have a live
          // connection to the remembered one — it may be fresher.
          targetPeerId = match.peerId;
          targetRelayAddress = match.relayAddress;
        }
      } catch {
        // Registry unavailable — we'll just skip delivery below if we
        // also have no live connection to the remembered peer.
      }
    }

    if (!targetPeerId) {
      this.log.warn(
        ctx,
        `Cannot deliver ${label} for "${contextGraphId}" to ${agentAddress} — no origin peer remembered and agent not in local registry. ` +
          `Dropping notification (invitee will re-learn on next subscribe).`,
      );
      return;
    }

    if (targetPeerId === this.peerId) {
      this.log.info(ctx, `Skipping ${label} to ${agentAddress}: target is this node`);
      return;
    }

    // Ensure we actually have a path to the target before attempting to
    // send. If we're not connected and we have a relay hint from the
    // registry, try a circuit dial once.
    const hasConnection = this.node.libp2p
      .getConnections()
      .some((c) => c.remotePeer.toString() === targetPeerId);
    if (!hasConnection && targetRelayAddress) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const { multiaddr } = await import('@multiformats/multiaddr');
        const circuitAddr = multiaddr(`${targetRelayAddress}/p2p-circuit/p2p/${targetPeerId}`);
        const pid = peerIdFromString(targetPeerId);
        await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
        await this.node.libp2p.dial(pid);
      } catch (dialErr) {
        this.log.warn(
          ctx,
          `Could not dial ${targetPeerId} via relay for ${label} notification: ` +
            (dialErr instanceof Error ? dialErr.message : String(dialErr)),
        );
      }
    }

    try {
      await this.router.send(targetPeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, 5000);
      this.log.info(ctx, `Delivered ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId})`);
      // The join request is finalised now — forget the origin peer so
      // the map doesn't grow unbounded over the curator's lifetime.
      this.joinRequestOriginPeers.delete(originKey);
    } catch (err) {
      this.log.warn(
        ctx,
        `Could not deliver ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Forward a signed join request to all connected peers via P2P.
   * Used by the requesting node to deliver the request to the curator.
   * Returns the number of peers that accepted the request.
   */
  async forwardJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    signature: string,
    timestamp: number,
    agentName?: string,
  ): Promise<{ delivered: number; errors: string[] }> {
    const payload = JSON.stringify({ contextGraphId, agentAddress, signature, timestamp, agentName });
    const payloadBytes = new TextEncoder().encode(payload);
    const peers = this.node.libp2p.getPeers();
    let delivered = 0;
    const errors: string[] = [];

    for (const pid of peers) {
      const remotePeerId = pid.toString();
      if (remotePeerId === this.peerId) continue;
      try {
        const responseBytes = await this.router.send(remotePeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, 5000);
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        if (response.ok) {
          delivered++;
        } else if (response.error !== 'unknown CG') {
          errors.push(`${remotePeerId.slice(-8)}: ${response.error}`);
        }
      } catch {
        // Peer doesn't support protocol or timeout — skip
      }
    }

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Forwarded join request for "${contextGraphId}" from ${agentAddress}: ${delivered} curator(s) received`);
    return { delivered, errors };
  }

  /**
   * Check whether a context graph has been registered on-chain.
   */
  async isContextGraphRegistered(contextGraphId: string): Promise<boolean> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered';
  }

  async getContextGraphOnChainId(contextGraphId: string): Promise<string | null> {
    const subscribed = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (subscribed) return subscribed;

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}OnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const value = result.bindings[0]?.['id'];
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  }

  /**
   * Get the peer allowlist for a context graph (if curated).
   * Returns null if no allowlist is set (open CG).
   */
  async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.replace(/^"|"$/g, ''));
  }

  // ── Sub-Graph Management ───────────────────────────────────────────────

  /**
   * Create a named sub-graph within a context graph.
   * Registers it in the CG's `_meta` graph and creates the named graph in storage.
   * Sub-graphs use convention-based URI partitioning — no on-chain enforcement in V10.0.
   *
   * V10.0 replication behavior:
   * - Registration triples are stored locally by the admin. Peers also auto-register
   *   sub-graphs on gossip publish, SWM write, and finalization replay paths:
   *   `gossip-publish-handler.ts`, `workspace-handler.ts`, and
   *   `finalization-handler.ts` call `ensureSubGraph()` and backfill the full
   *   `_meta` registration when it is missing.
   * - Because `subGraphName` is carried on the wire (in the workspace publish request
   *   and the N-Quads' named-graph field), replicated data is routed into the correct
   *   sub-graph named graph on receiving nodes — not into the root data graph.
   * - On-chain contracts are unaware of sub-graphs; enforcement remains convention-based.
   */
  async createSubGraph(contextGraphId: string, subGraphName: string, opts?: {
    description?: string;
    authorizedWriters?: string[];
  }): Promise<{ uri: string }> {
    const { validateSubGraphName, contextGraphSubGraphUri: sgUri } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) throw new Error(`Context graph "${contextGraphId}" does not exist`);

    const gm = new GraphManager(this.store);
    const uri = sgUri(contextGraphId, subGraphName);

    // Idempotency: check if already registered before inserting
    const existing = await this.listSubGraphs(contextGraphId);
    if (existing.some(sg => sg.name === subGraphName)) {
      this.log.info(
        createOperationContext('system'),
        `Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" → ${uri}`,
      );
      return { uri };
    }

    const { generateSubGraphRegistration } = await import('@origintrail-official/dkg-publisher');
    const registrationQuads = generateSubGraphRegistration({
      contextGraphId,
      subGraphName,
      createdBy: this.peerId,
      authorizedWriters: opts?.authorizedWriters,
      description: opts?.description,
      timestamp: new Date(),
    });

    await gm.ensureSubGraph(contextGraphId, subGraphName);
    await this.store.insert(registrationQuads);

    this.log.info(
      createOperationContext('system'),
      `Created sub-graph "${subGraphName}" in context graph "${contextGraphId}" → ${uri}`,
    );
    return { uri };
  }

  /**
   * List registered sub-graphs for a context graph.
   * Queries the CG's `_meta` graph for `dkg:SubGraph` registrations.
   */
  async listSubGraphs(contextGraphId: string): Promise<Array<{
    uri: string;
    name: string;
    createdBy: string;
    createdAt?: string;
    description?: string;
  }>> {
    const { subGraphDiscoverySparql } = await import('@origintrail-official/dkg-publisher');
    const sparql = subGraphDiscoverySparql(contextGraphId);
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];
    return result.bindings.map(row => ({
      uri: row['subGraph'] ?? '',
      name: stripLiteral(row['name'] ?? ''),
      createdBy: row['createdBy'] ?? '',
      createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
      description: row['description'] ? stripLiteral(row['description']) : undefined,
    }));
  }

  /**
   * Remove a sub-graph registration from `_meta` and drop its named graphs.
   * Does NOT delete on-chain data — this is a local bookkeeping operation.
   */
  async removeSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    const { validateSubGraphName } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const gm = new GraphManager(this.store);

    const { subGraphDeregistrationSparql } = await import('@origintrail-official/dkg-publisher');
    try {
      await this.store.query(subGraphDeregistrationSparql(contextGraphId, subGraphName));
    } catch {
      // SPARQL DELETE WHERE may not be supported — delete quads manually
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
      await this.store.deleteByPattern({ graph: metaGraph, subject: subGraphUri });
    }

    const dataUri = gm.subGraphUri(contextGraphId, subGraphName);
    const metaUri = gm.subGraphMetaUri(contextGraphId, subGraphName);
    const privateUri = gm.subGraphPrivateUri(contextGraphId, subGraphName);
    const swmUri = gm.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaUri = gm.sharedMemoryMetaUri(contextGraphId, subGraphName);
    for (const uri of [dataUri, metaUri, privateUri, swmUri, swmMetaUri]) {
      try { await this.store.dropGraph(uri); } catch { /* graph may not exist */ }
    }

    // Drop assertion graphs under the sub-graph prefix
    const sgPrefix = `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`;
    const allGraphs = await this.store.listGraphs();
    for (const g of allGraphs) {
      if (g.startsWith(sgPrefix)) {
        try { await this.store.dropGraph(g); } catch { /* graph may not exist */ }
      }
    }

    // Clear SWM ownership cache for this sub-graph
    const ownershipKey = `${contextGraphId}\0${subGraphName}`;
    this.publisher.clearSubGraphOwnership(ownershipKey);

    this.log.info(
      createOperationContext('system'),
      `Removed sub-graph "${subGraphName}" from context graph "${contextGraphId}"`,
    );
  }

  /**
   * Idempotent "ensure" variant of createContextGraph for boot-time defaults.
   * If the context graph already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples. No on-chain registration
   * — use {@link registerContextGraph} for that.
   *
   * For curated CGs (detected by access policy in existing triples, or by the
   * caller passing `curated: true`), definition triples are written to the CG's
   * own `_meta` graph — never to ONTOLOGY — so they don't leak to the network.
   */
  async ensureContextGraphLocal(opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      // Bootstrap is a subscriber path: do NOT mint or backfill ownership
      // here. Creator/curator are stamped by `createContextGraph` (explicit
      // create) and `registerContextGraph` (explicit on-chain mint). When
      // every node backfilled itself on boot the `_meta` graph accumulated
      // one curator triple per node and `getContextGraphOwner`'s
      // `LIMIT 1` made ownership nondeterministic — any subscriber could
      // win the unordered query and look like the curator.
      this.subscribeToContextGraph(opts.id);
      this.subscribedContextGraphs.set(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        metaSynced: true,
        onChainId: this.subscribedContextGraphs.get(opts.id)?.onChainId,
      });
      return;
    }

    const gm = new GraphManager(this.store);
    const paranetUri = paranetDataGraphUri(opts.id);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    // Curated CGs write definition triples to _meta so they stay invisible
    // to other nodes that sync ONTOLOGY. Open CGs go to ONTOLOGY for
    // network-wide discovery.
    const defGraph = opts.curated ? cgMetaGraph : ontologyGraph;

    // No creator/curator triples here — bootstrap is a subscriber-style
    // path. Ownership is established only when a node explicitly calls
    // `createContextGraph` (UI flow) or `registerContextGraph` (on-chain
    // mint), which both stamp the calling node. Stamping every booting
    // node would let `getContextGraphOwner` ("LIMIT 1" over `dkg:curator`)
    // resolve to an arbitrary subscriber and create a registration race
    // where node B mints a second V10 CG before node A's `onChainId`
    // propagates.
    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${opts.curated ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // _meta triples: only registration status. `dkg:curator` is written
    // by `registerContextGraph` (or `createContextGraph` for the UI
    // create path) so exactly one node owns the graph locally.
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
    );

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    await this.store.insert(quads);
    await gm.ensureParanet(opts.id);

    this.subscribeToContextGraph(opts.id);
    this.subscribedContextGraphs.set(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    this.log.info(ctx, `Ensured context graph "${opts.id}" locally (${opts.curated ? 'curated' : 'open'})`);
  }

  // ── ENDORSE ─���────────────────────────────────────────────────────────

  /**
   * Endorse a published Knowledge Asset. Publishes a `dkg:endorses` triple
   * to the Context Graph's data graph. Endorsements ride regular PUBLISH
   * batches — no separate chain transaction required.
   */
  async endorse(opts: {
    contextGraphId: string;
    knowledgeAssetUal: string;
    agentAddress?: string;
  }): Promise<PublishResult> {
    // Bot review D1: use the ASYNC endorsement builder and pass the local
    // agent wallet as the signer whenever one is available, so the resulting
    // `endorsementSignature` quad carries a real EIP-191 signature that
    // verifiers can recover the endorsing address from. When no wallet is
    // available (pre-bootstrap / read-only nodes) we fall back to the
    // unsigned digest hex — the quad still binds (agent, ual, cg, ts, nonce)
    // for tamper detection, but peers that require non-repudiation will
    // reject it. The previous sync `buildEndorsementQuads` path silently
    // ignored any `signer` option and always emitted the unsigned digest.
    const { buildEndorsementQuadsAsync } = await import('./endorse.js');
    // Bot review D1 (2nd follow-up, PR #229): the signer MUST match the
    // `agentAddress` we embed in the endorsement quad, otherwise peers
    // recover a different address from the EIP-191 signature than the
    // one they see in the payload and reject the endorsement (or worse,
    // accept it as coming from the wrong identity on a multi-agent node).
    // Two concrete bugs the previous revision hit:
    //   1. Multi-agent nodes: `getDefaultPublisherWallet()` always
    //      returned the *default* local agent's wallet. Endorsing with
    //      `agentAddress=A` on a node whose default agent is B signed
    //      A's endorsement with B's key — recovery yields B, mismatch.
    //   2. Omitted `agentAddress` fell back to `this.peerId`, which is
    //      a libp2p peer id (base58 CID). No ethers.Wallet can ever
    //      recover to a libp2p peer id via EIP-191, so the signature
    //      was structurally unverifiable even when it was present.
    // The fix: pick a concrete EVM address (caller-supplied OR the
    // default agent address, never `peerId`), look up the Wallet whose
    // stored private key matches THAT address, and refuse to emit an
    // unsigned-digest-only endorsement for a locally-registered agent
    // whose key we DO hold — that would be a silent downgrade.
    //
    // A-12 (v10-rc merge): spec §03 / §22 require the endorser DID to
    // be the Ethereum-address form. Normalise the address casing
    // through `canonicalAgentDidSubject` so the endorsement DID
    // converges with the profile DID for the same wallet (checksum vs
    // lowercase inputs previously produced two distinct RDF subjects).
    const agentAddressRaw = opts.agentAddress ?? this.defaultAgentAddress;
    if (!agentAddressRaw) {
      throw new Error(
        'endorse: no agentAddress provided and no default agent registered. ' +
        'Register a local agent with registerAgent() or pass opts.agentAddress explicitly.',
      );
    }
    const agentAddress = canonicalAgentDidSubject(agentAddressRaw);
    const walletForEndorsement = this.getLocalAgentWallet(agentAddress);
    if (!walletForEndorsement) {
      // PR #229 bot review (r3147347... — dkg-agent.ts:5424).
      // Pre-fix the "no local wallet" branch fell through to
      // `buildEndorsementQuadsAsync(..., {})` and emitted an
      // endorsement carrying ONLY the unsigned digest. Verifiers
      // (`resolveEndorsementFacts` in `ccl-fact-resolution.ts`)
      // currently count any quad pair
      //   ?endorsement dkg:endorses   <ual> .
      //   ?endorsement dkg:endorsedBy <agent> .
      // without recovering / verifying the EIP-191 signature on
      // `dkg:endorsementSignature`. That meant a caller on this
      // node could publish endorsements claiming arbitrary
      // EXTERNAL agent identities and inflate
      // endorsement-based provenance / CCL counts for any UAL.
      //
      // Two flavours are distinguishable here:
      //   (a) self-sovereign LOCAL agent — registered in
      //       `localAgents` but without a private key. This
      //       branch can only be unblocked by the caller
      //       supplying a real off-line signature; today the API
      //       has no slot for that, so we still throw.
      //   (b) genuinely EXTERNAL agent — no local record at all.
      //       Until `endorse()` is extended to accept a
      //       caller-supplied EIP-191 signature recoverable to
      //       `agentAddress`, refuse the call instead of
      //       publishing an unsigned forgeable endorsement.
      const localRecord = [...this.localAgents.values()].find(
        (r) => r.agentAddress.toLowerCase() === agentAddress.toLowerCase(),
      );
      if (localRecord && !localRecord.privateKey) {
        throw new Error(
          `endorse: local agent ${agentAddress} is self-sovereign (no private key held). ` +
          `Pre-sign the endorsement digest externally or register the wallet's private key.`,
        );
      }
      throw new Error(
        `endorse: refusing to publish endorsement on behalf of external agent ${agentAddress} ` +
        `without a recoverable EIP-191 signature. ${
          this.defaultAgentAddress
            ? `Either omit opts.agentAddress to endorse as the default local agent ` +
              `(${this.defaultAgentAddress}), or register a wallet for ${agentAddress} ` +
              `via registerAgent() before calling endorse().`
            : `Register a local agent via registerAgent() before calling endorse(), or pass ` +
              `opts.agentAddress matching a registered local wallet.`
        }`,
      );
    }
    const signer = (digest: Uint8Array) => walletForEndorsement.signMessage(digest);
    const quads = await buildEndorsementQuadsAsync(
      agentAddress,
      opts.knowledgeAssetUal,
      opts.contextGraphId,
      { signer },
    );
    return this.publish(opts.contextGraphId, quads);
  }

  // ── VERIFY ────────────────────────────────────────────────────────

  /**
   * Propose verification for a published batch: collect M-of-N approvals,
   * anchor on-chain, and promote triples to Verified Memory.
   */
  async verify(opts: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: bigint;
    requiredSignatures?: number;
    timeoutMs?: number;
  }): Promise<{
    txHash: string;
    blockNumber: number;
    verifiedMemoryId: string;
    signers: string[];
  }> {
    const ctx = createOperationContext('verify');

    // 1. Look up batch merkle root from local metadata (use typed literal for batchId)
    const metaGraph = paranetMetaGraphUri(opts.contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    let batchBindings: Record<string, string>[] | null = null;
    for (const literal of [`"${opts.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${opts.batchId}"`]) {
      const r = await this.store.query(
        `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
      );
      if (r.type === 'bindings' && r.bindings.length > 0) {
        batchBindings = r.bindings as Record<string, string>[];
        break;
      }
    }
    if (!batchBindings) {
      throw new Error(`Batch ${opts.batchId} not found in context graph ${opts.contextGraphId}`);
    }
    const rootHex = batchBindings[0]['root'];
    const merkleRoot = ethers.getBytes(rootHex.startsWith('"') ? rootHex.slice(1, -1) : rootHex);

    // 2. Look up context graph on-chain config
    const sub = this.subscribedContextGraphs.get(opts.contextGraphId);
    const contextGraphIdOnChain = sub?.onChainId ? BigInt(sub.onChainId) : null;
    if (!contextGraphIdOnChain) {
      throw new Error(`Context graph ${opts.contextGraphId} not found on-chain`);
    }

    // 3. Get required signatures from chain config or opts
    let requiredSignatures = opts.requiredSignatures ?? 0;
    if (requiredSignatures === 0 && typeof (this.chain as any).getContextGraphConfig === 'function') {
      try {
        const cgConfig = await (this.chain as any).getContextGraphConfig(contextGraphIdOnChain);
        const raw = cgConfig?.requiredSignatures;
        const parsed = raw != null ? Number(raw) : 0;
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`getContextGraphConfig returned invalid requiredSignatures: ${raw} (must be a positive integer)`);
        }
        requiredSignatures = parsed;
      } catch (err: any) {
        throw new Error(
          `Cannot determine requiredSignatures for context graph ${contextGraphIdOnChain}: ${err?.message ?? err}. ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter connection.`,
        );
      }
    }
    if (requiredSignatures === 0) {
      requiredSignatures = 1;
      this.log.warn(ctx, `requiredSignatures defaults to 1 — adapter does not implement getContextGraphConfig. ` +
        `For M-of-N context graphs, pass --required-signatures via CLI or requiredSignatures in the API body.`);
    }

    // 4. Sign the verify digest as proposer
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (!signerKey) throw new Error('No signer key available for verify');

    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(signerKey);
    const proposerSig = signingKey.sign(prefixedHash);
    const proposerAddress = ethers.computeAddress(signingKey.publicKey);

    // 5. Collect M-of-N approvals
    const collector = new VerifyCollector({
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => this.router.send(peerId, protocol, data),
      getParticipantPeers: (cgId?: string) => {
        const allPeers = this.node.libp2p.getPeers().map(p => p.toString()).filter(id => id !== this.peerId);
        // TODO: Filter by on-chain participant set once getContextGraphParticipants() is available.
        // Currently relies on signature recovery + identityId resolution to reject non-participants.
        return allPeers;
      },
      log: (msg: string) => this.log.info(ctx, msg),
    });

    const entities = await this.getRootEntities(opts.contextGraphId, opts.batchId);

    const result = await collector.collect({
      contextGraphId: opts.contextGraphId,
      contextGraphIdOnChain,
      verifiedMemoryId: (() => {
        try { return BigInt(opts.verifiedMemoryId); }
        catch { throw new Error(`verifiedMemoryId must be a numeric string, got: "${opts.verifiedMemoryId}"`); }
      })(),
      batchId: opts.batchId,
      merkleRoot,
      entities,
      proposerSignature: { r: ethers.getBytes(proposerSig.r), vs: ethers.getBytes(proposerSig.yParityAndS) },
      requiredSignatures,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min default
    });

    // 6. Submit on-chain
    if (typeof this.chain.verify !== 'function') {
      throw new Error('Chain adapter does not support verify');
    }

    // 6. Resolve identity IDs for each approver before on-chain submission.
    const resolvedSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [
      {
        identityId: this.identityId,
        r: ethers.getBytes(proposerSig.r),
        vs: ethers.getBytes(proposerSig.yParityAndS),
      },
    ];
    const resolvedSignerAddresses: string[] = [proposerAddress];
    for (const a of result.approvals) {
      let id = a.identityId;
      if ((!id || id === 0n) && typeof (this.chain as any).getIdentityIdForAddress === 'function') {
        try { id = await (this.chain as any).getIdentityIdForAddress(a.approverAddress); } catch { /* use 0n */ }
      }
      if (!id || id === 0n) continue;
      resolvedSignatures.push({ identityId: id, r: a.signatureR, vs: a.signatureVS });
      resolvedSignerAddresses.push(a.approverAddress);
    }
    if (resolvedSignatures.length < requiredSignatures) {
      throw new Error(`verify_identity_resolution: only ${resolvedSignatures.length}/${requiredSignatures} signers have resolvable identities (including proposer)`);
    }

    const txResult = await this.chain.verify({
      contextGraphId: contextGraphIdOnChain,
      batchId: opts.batchId,
      merkleRoot,
      signerSignatures: resolvedSignatures,
    });

    // 7. Promote triples to Verified Memory (only include signers actually sent on-chain)
    await this.promoteToVerifiedMemory(
      opts.contextGraphId,
      opts.verifiedMemoryId,
      opts.batchId,
      txResult.hash,
      txResult.blockNumber,
      resolvedSignerAddresses,
    );

    this.log.info(ctx, `Verified batch ${opts.batchId} → _verified_memory/${opts.verifiedMemoryId} (tx=${txResult.hash.slice(0, 16)}...)`);

    return {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber,
      verifiedMemoryId: opts.verifiedMemoryId,
      signers: resolvedSignerAddresses,
    };
  }

  private async promoteToVerifiedMemory(
    contextGraphId: string,
    verifiedMemoryId: string,
    batchId: bigint,
    txHash: string,
    blockNumber: number,
    signers: string[],
  ): Promise<void> {
    // Query only the triples belonging to this batch via root entities in _meta
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    if (rootEntities.length === 0) {
      this.log.warn(createOperationContext('verify'), `No root entities found for batch ${batchId} — skipping VM promotion`);
      return;
    }
    const dataGraph = paranetDataGraphUri(contextGraphId);
    // Query root entities AND their skolemized children (subjects starting
    // with the root entity URI, e.g. <root>/.well-known/genid/...).
    // We use FILTER with STRSTARTS to capture the full closure instead of
    // an exact VALUES match, which would miss child/blank-node subjects.
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${JSON.stringify(e)} || STRSTARTS(STR(?s), ${JSON.stringify(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    if (result.type !== 'bindings') return;

    const vmGraph = contextGraphVerifiedMemoryUri(contextGraphId, verifiedMemoryId);
    const vmQuads: Quad[] = (result.bindings as Record<string, string>[]).map(row => ({
      subject: row['s'],
      predicate: row['p'],
      object: row['o'],
      graph: vmGraph,
    }));
    if (vmQuads.length > 0) {
      await this.store.insert(vmQuads);
    }

    // Write verification metadata
    const vmMetaGraph = contextGraphVerifiedMemoryMetaUri(contextGraphId, verifiedMemoryId);
    const metaQuads = buildVerificationMetadata({
      contextGraphId,
      verifiedMemoryId,
      batchId,
      txHash,
      blockNumber,
      signers,
      verifiedAt: new Date(),
      graph: vmMetaGraph,
    });
    await this.store.insert(metaQuads);
  }

  private async getRootEntities(contextGraphId: string, batchId: bigint): Promise<string[]> {
    const metaGraph = paranetMetaGraphUri(contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
      const result = await this.store.query(
        `SELECT ?entity WHERE { GRAPH <${metaGraph}> { ?ka <https://dkg.network/ontology#rootEntity> ?entity . ?ka <https://dkg.network/ontology#batchId> ${literal} } }`,
      );
      if (result.type === 'bindings' && result.bindings.length > 0) {
        return (result.bindings as Record<string, string>[]).map(r => r['entity']).filter(Boolean);
      }
    }
    return [];
  }

  // ── CCL ──────────────────────────────────────────────────────────────

  async publishCclPolicy(opts: {
    paranetId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.paranetId))) {
      throw new Error(`Context Graph "${opts.paranetId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ paranetId: opts.paranetId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.paranetId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for paranet "${opts.paranetId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertParanetOwner(opts.paranetId, opts.callerAgentAddress);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) throw new Error(`CCL policy not found: ${opts.policyUri}`);
    if (record.paranetId !== opts.paranetId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to paranet "${record.paranetId}", not "${opts.paranetId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    // Emit the public `dkg:creator` peer DID as the binding owner: it's the
    // handle remote peers resolve via ONTOLOGY gossip, so gossip-publish-handler
    // will accept the approval. `_meta`-only `dkg:curator` (wallet DID) is
    // used for local authorization via `assertParanetOwner` above.
    const ownerDid = await this.getContextGraphCreator(opts.paranetId)
      ?? `did:dkg:agent:${this.peerId}`;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      paranetId: opts.paranetId,
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
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for paranet "${opts.paranetId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
    callerAgentAddress?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertParanetOwner(opts.paranetId, opts.callerAgentAddress);

    const target = await this.getActiveCclPolicyBinding({
      paranetId: opts.paranetId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new Error(`No active CCL policy binding found for ${opts.policyUri} in paranet "${opts.paranetId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`);
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    // See note in approveCclPolicy — use `dkg:creator` (peer DID) for the
    // public binding metadata so it round-trips through ONTOLOGY gossip.
    const ownerDid = await this.getContextGraphCreator(opts.paranetId)
      ?? `did:dkg:agent:${this.peerId}`;
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: ownerDid,
      graph: ontologyGraph,
      revokedAt,
      paranetUri: `did:dkg:context-graph:${opts.paranetId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for paranet "${opts.paranetId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(opts: {
    paranetId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.paranetId) filters.push(`?paranet = <did:dkg:context-graph:${opts.paranetId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?paranet ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_PARANET}> ?paranet ;
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

    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const paranetUri = row['paranet'];
        const paranetId = paranetUri.startsWith('did:dkg:context-graph:') ? paranetUri.slice('did:dkg:context-graph:'.length) : paranetUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${paranetId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.paranetId === paranetId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          paranetId,
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

  async resolveCclPolicy(opts: {
    paranetId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.paranetId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(opts: {
    paranetId: string;
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
      paranetId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(opts: {
    paranetId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'paranetId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      paranetId: string;
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
      paranetId: opts.paranetId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy?.body) {
      throw new Error(`No approved policy found for ${opts.paranetId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          paranetId: opts.paranetId,
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
        paranetId: policy.paranetId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        paranetId: opts.paranetId,
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

  async evaluateAndPublishCclPolicy(opts: {
    paranetId: string;
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
      policy: Pick<CclPolicyRecord, 'policyUri' | 'paranetId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        paranetId: string;
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
    const graph = paranetDataGraphUri(opts.paranetId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      paranetId: opts.paranetId,
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
    const publish = await this.publish(opts.paranetId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(opts: {
    paranetId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = paranetDataGraphUri(opts.paranetId);
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

  /**
   * Check whether a context graph exists in local storage. Definition triples in
   * ONTOLOGY/_meta count, and storage-backed graph presence also counts so local
   * shared-memory-only survivors are not treated as nonexistent.
   */
  async contextGraphExists(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> }
      } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) {
      return true;
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    return storedContextGraphs.includes(contextGraphId);
  }

  /**
   * Check whether the context graph has any actual content locally. A
   * paranet declaration triple in the ontology graph (from auto-discovery
   * via chain registry or ontology sync) does NOT count as content; it
   * only indicates the paranet was announced, not that we have access to
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
  async contextGraphHasLocalContent(contextGraphId: string): Promise<boolean> {
    const prefix = `did:dkg:context-graph:${contextGraphId}`;
    // ASK is cheap on Oxigraph; the FILTER keeps us inside this CG's
    // namespace and excludes `_meta` / `_shared_memory_meta` bookkeeping
    // which is written even for declaration-only discoveries.
    const sparql = `ASK WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STRSTARTS(STR(?g), "${prefix}"))
      FILTER(!STRENDS(STR(?g), "/_meta"))
      FILTER(!STRENDS(STR(?g), "/_shared_memory_meta"))
    }`;
    const result = await this.store.query(sparql);
    if (result.type === 'boolean') return result.value;
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * Check whether a context graph is declared as curated (private/allowlist)
   * locally. Reads the DKG accessPolicy predicate from either the ontology
   * graph (public CGs) or the CG's _meta graph (curated CGs). Returns false
   * when no declaration is present locally (caller should treat that as
   * "unknown, assume public" — this predicate is only used to gate
   * optimistic denial inference, not access control decisions).
   */
  async contextGraphIsCurated(contextGraphId: string): Promise<boolean> {
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    try {
      const res = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      if (res.type !== 'bindings' || res.bindings.length === 0) return false;
      const ap = res.bindings[0]?.['ap']?.replace(/^"|"$/g, '');
      return ap === 'private';
    } catch {
      return false;
    }
  }

  private parseSyncRequest(data: Uint8Array): SyncRequestEnvelope {
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
        phase: parsed.phase === 'meta' ? 'meta' : 'data',
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
      };
    }

    return this.parsePipeDelimitedSyncRequest(text);
  }

  private parsePipeDelimitedSyncRequest(text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_PARANETS.AGENTS);
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase: parts[3] === 'meta' ? 'meta' : 'data',
    };
  }

  private async buildSyncRequest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    responderPeerId: string,
    phase: 'data' | 'meta' = 'data',
  ): Promise<Uint8Array> {
    const isPrivate = await this.isPrivateContextGraph(contextGraphId);

    // If we don't have any local data for this CG yet (e.g. just subscribed
    // via invite), we can't determine the access policy. Send an
    // authenticated request so the remote peer can verify our identity
    // against its allowlist.
    const hasLocalData = this.subscribedContextGraphs.get(contextGraphId)?.synced === true;
    const needsAuth = isPrivate || !hasLocalData;
    const defaultAgent = this.defaultAgentAddress ? this.localAgents.get(this.defaultAgentAddress) : undefined;
    return buildSyncRequestEnvelope({
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      targetPeerId: responderPeerId,
      requesterPeerId: this.peerId,
      phase,
      needsAuth,
      computeSyncDigest: this.computeSyncDigest.bind(this),
      getIdentityId: () => this.chain.getIdentityId(),
      signMessage: typeof this.chain.signMessage === 'function' ? this.chain.signMessage.bind(this.chain) : undefined,
      defaultAgentAddress: this.defaultAgentAddress,
      defaultAgentPrivateKey: defaultAgent?.privateKey,
    });
  }

  private computeSyncDigest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string | undefined,
    requestId: string | undefined,
    issuedAtMs: number | undefined,
  ): Uint8Array {
    return ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256'],
        [
          contextGraphId,
          BigInt(offset),
          BigInt(limit),
          includeSharedMemory,
          targetPeerId,
          requesterPeerId ?? '',
          requestId ?? '',
          BigInt(issuedAtMs ?? 0),
        ],
      ),
    );
  }

  private async authorizeSyncRequest(request: SyncRequestEnvelope, remotePeerId: string): Promise<boolean> {
    const isPrivate = await this.isPrivateContextGraph(request.contextGraphId);
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
      verifyIdentity: typeof verifyIdentity === 'function' ? verifyIdentity.bind(this.chain) : undefined,
      getParticipants: (contextGraphId) => this.getPrivateContextGraphParticipants(contextGraphId),
      getAllowedPeers: (contextGraphId) => this.getContextGraphAllowedPeers(contextGraphId),
      refreshMetaFromCurator: (contextGraphId) => this.refreshMetaFromCurator(contextGraphId),
      logWarn: (ctx, message) => this.log.warn(ctx, message),
      logInfo: (ctx, message) => this.log.info(ctx, message),
    });
  }

  private async isPrivateContextGraph(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_PARANETS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      } LIMIT 1`,
    );

    if (result.type === 'bindings' && result.bindings[0]?.['policy'] === '"private"') {
      return true;
    }

    // Also treat CGs with any allowlist predicate as private, even when no
    // explicit `accessPolicy` triple exists (e.g. `inviteToContextGraph`
    // writes `DKG_ALLOWED_PEER` straight into `_meta` without touching the
    // ontology's access_policy; `inviteAgentToContextGraph` does the same
    // with `DKG_ALLOWED_AGENT`). Both the V10 agent model AND the legacy
    // peer-ID model need to be recognized here, otherwise the store-
    // discovery path would misclassify a freshly-invited CG as "open /
    // discoverable only" and skip the same-connect catchup.
    const allowlistResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?participantAgent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer }
        }
      }`,
    );
    if (allowlistResult.type === 'boolean' && allowlistResult.value === true) {
      return true;
    }

    return false;
  }

  private async getPrivateContextGraphParticipants(contextGraphId: string): Promise<string[] | null> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value);
    };

    const localAgentParticipants = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents;
    if (localAgentParticipants) {
      for (const p of localAgentParticipants) add(p);
    }

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);

    // V10 agent model: local allowedAgent entries plus explicit on-chain
    // participantAgent entries both grant local curated access.
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
          UNION
          { <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        const raw = row['agent'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    // Legacy identity model: participantIdentityIds (numeric IDs as strings)
    const metaResult = await this.store.query(
      `SELECT ?identityId WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId
        }
      }`,
    );
    if (metaResult.type === 'bindings') {
      for (const row of metaResult.bindings) {
        const raw = row['identityId'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    if (merged.length > 0) return merged;

    // Fall back to on-chain participants (identity IDs as strings)
    const onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (!onChainId || typeof this.chain.getContextGraphParticipants !== 'function') {
      return null;
    }
    const onChainParticipants = await this.chain.getContextGraphParticipants(BigInt(onChainId));
    if (!onChainParticipants) return null;
    return onChainParticipants.map((id) => String(id));
  }

  /**
   * Re-sync the meta graph for a private CG from the curator to pick up
   * newly added participants. Rate-limited to avoid abuse.
   * Returns true if meta was refreshed, false if skipped or failed.
   */
  private async resolveCuratorPeerId(contextGraphId: string): Promise<string | undefined> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const contextGraphUri = paranetDataGraphUri(contextGraphId);

    const curatorResult = await this.store.query(
      `SELECT ?curator WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator
        }
      } LIMIT 1`,
    );
    if (curatorResult.type !== 'bindings' || curatorResult.bindings.length === 0) {
      return undefined;
    }
    const curatorDid = (curatorResult.bindings[0] as Record<string, string>)['curator'] ?? '';
    const didPrefix = 'did:dkg:agent:';
    if (!curatorDid.startsWith(didPrefix)) {
      return undefined;
    }
    const curatorIdentifier = curatorDid.slice(didPrefix.length);

    // Resolve curator identifier to a peer ID. The DID value is either a
    // libp2p peer ID (legacy) or an Ethereum wallet address (V10). For
    // wallet addresses, prefer the deterministic DKG_CREATOR triple (which
    // stores the libp2p peer ID) over the agent registry (which may return
    // an arbitrary match when multiple agents register the same wallet).
    let curatorPeerId = curatorIdentifier;
    if (curatorIdentifier.startsWith('0x')) {
      let resolved = false;

      // Preferred: look up the creator peer ID from the ontology definition
      // graph or the _meta graph. The dkg:creator triple uses the libp2p
      // peer ID while dkg:curator uses the wallet address.
      const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
      const creatorResult = await this.store.query(
        `SELECT ?creator WHERE {
          {
            GRAPH <${ontologyGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          } UNION {
            GRAPH <${cgMetaGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          }
        } LIMIT 1`,
      );
      if (creatorResult.type === 'bindings' && creatorResult.bindings.length > 0) {
        const creatorDid = (creatorResult.bindings[0] as Record<string, string>)['creator'] ?? '';
        if (creatorDid.startsWith(didPrefix)) {
          const creatorId = creatorDid.slice(didPrefix.length);
          if (!creatorId.startsWith('0x')) {
            curatorPeerId = creatorId;
            resolved = true;
          }
        }
      }

      // Fallback: agent registry lookup (non-deterministic if multiple agents
      // share the same wallet address, but better than failing outright)
      if (!resolved) {
        try {
          const agents = await this.discovery.findAgents();
          const match = agents.find(
            (a) => a.agentAddress?.toLowerCase() === curatorIdentifier.toLowerCase(),
          );
          if (match) {
            curatorPeerId = match.peerId;
            resolved = true;
          }
        } catch { /* registry unavailable */ }
      }

      if (!resolved) return undefined;
    }

    return curatorPeerId;
  }

  private async refreshMetaFromCurator(contextGraphId: string): Promise<boolean> {
    const now = Date.now();
    const lastRefresh = this.metaRefreshTimestamps.get(contextGraphId) ?? 0;
    if (now - lastRefresh < META_REFRESH_COOLDOWN_MS) {
      return false;
    }

    const ctx = createOperationContext('sync');
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!curatorPeerId) {
      return false;
    }

    if (curatorPeerId === this.peerId) {
      return false;
    }

    let connections = this.node.libp2p.getConnections();
    let isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);

    // If not directly connected, try dialing — first a regular dial (the peer
    // store may already have direct multiaddrs), then via relay as fallback.
    if (!isConnected) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const pid = peerIdFromString(curatorPeerId);

        try {
          await this.node.libp2p.dial(pid);
          connections = this.node.libp2p.getConnections();
          isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
        } catch { /* direct dial failed, try relay */ }

        if (!isConnected) {
          const agent = await this.discovery.findAgentByPeerId(curatorPeerId);
          if (agent?.relayAddress) {
            const { multiaddr } = await import('@multiformats/multiaddr');
            const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`);
            await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
            await this.node.libp2p.dial(pid);
            connections = this.node.libp2p.getConnections();
            isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
          }
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!isConnected) {
      return false;
    }

    try {
      const deadline = Date.now() + 10_000;
      const metaResult = await this.fetchSyncPages(ctx, curatorPeerId, contextGraphId, false, 'meta', cgMetaGraph, deadline);
      if (metaResult.quads.length > 0) {
        await this.store.insert(metaResult.quads);
        this.syncCheckpoints.delete(metaResult.checkpointKey);
        this.log.info(ctx, `Meta refresh for "${contextGraphId}": ${metaResult.quads.length} triples from curator ${curatorPeerId.slice(-8)}`);
        return true;
      }
      this.syncCheckpoints.delete(metaResult.checkpointKey);
      return false;
    } catch (err) {
      this.log.warn(ctx, `Meta refresh for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.metaRefreshTimestamps.set(contextGraphId, now);
    }
  }

  /**
   * List all known context graphs by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   */
  async listContextGraphs(): Promise<Array<{
    id: string;
    uri: string;
    name: string;
    description?: string;
    creator?: string;
    createdAt?: string;
    isSystem: boolean;
    subscribed: boolean;
    synced: boolean;
    onChainId?: string;
  }>> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const agentsGraph = paranetDataGraphUri(SYSTEM_PARANETS.AGENTS);
    const result = await this.store.query(`
      SELECT ?ctxGraph ?name ?desc ?creator ?created ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `);

    const prefix = 'did:dkg:context-graph:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; createdAt?: string; isSystem: boolean;
      subscribed: boolean; synced: boolean; onChainId?: string;
    }>();

    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['ctxGraph'] ?? '';
        if (seen.has(uri)) continue;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedContextGraphs.get(id);
        const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: !!row['isSystem'],
          subscribed: sub?.subscribed ?? false,
          synced: true,
          ...(onChainId ? { onChainId } : {}),
        });
      }
    }

    // Curated CGs store their definition in their own _meta graph, not in
    // ONTOLOGY. Check _meta for any subscribed CGs not yet found above.
    for (const [id, sub] of this.subscribedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

      const metaGraph = paranetMetaGraphUri(id);
      const pUri = paranetDataGraphUri(id);
      const metaResult = await this.store.query(`
        SELECT ?name ?desc ?creator ?created WHERE {
          GRAPH <${metaGraph}> {
            <${pUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          }
        } LIMIT 1
      `);

      if (metaResult.type === 'bindings' && metaResult.bindings.length > 0) {
        const row = metaResult.bindings[0] as Record<string, string>;
        const onChainId = sub.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? sub.name ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: false,
          subscribed: sub.subscribed,
          synced: sub.synced,
          ...(onChainId ? { onChainId } : {}),
        });
        continue;
      }

      // No declaration in ontology, agents, or _meta graphs. Two cases:
      //
      //  1. Chain-attested but not-yet-synced (sub.onChainId set):
      //     auto-discovery from the on-chain registry found this CG and
      //     subscribed us. Surface it as subscribed+synced=false so the
      //     UI can show a legitimate "waiting for sync" state. Any
      //     genuinely inaccessible curated CG will be removed from
      //     `subscribedContextGraphs` by the daemon's authoritative
      //     denial path (accessDeniedPeers > 0) before we get here.
      //
      //  2. Not chain-attested AND no local content: a truly phantom
      //     entry (pre-discovery subscribe that never resolved). Hide
      //     it to avoid polluting the UI. If the user legitimately
      //     subscribes later, the next catch-up writes _meta or data
      //     and the entry will appear on the next refresh.
      if (!sub.onChainId) {
        // Delegate to `contextGraphHasLocalContent()` so the check
        // covers sub-graphs, assertion graphs and SWM — not just the
        // root data graph. For any non-trivial project the root data
        // graph is routinely empty (content lives in `/tasks`,
        // `/chat`, `/assertion/...`, `_shared_memory`), and checking
        // only the root caused legitimate synced projects to be
        // hidden as phantoms here (Codex tier-4m follow-up to N29,
        // same issue in a separate call site).
        const hasContent = await this.contextGraphHasLocalContent(id);
        if (!hasContent) continue;
      }

      seen.set(uri, {
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
        ...(sub.onChainId ? { onChainId: sub.onChainId } : {}),
      });
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listParanets();
    for (const id of storedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

      const sub = this.subscribedContextGraphs.get(id);
      const onChainId = sub?.onChainId ?? (await this.getContextGraphOnChainId(id)) ?? undefined;
      seen.set(uri, {
        id,
        uri,
        name: sub?.name ?? id,
        isSystem: false,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
        ...(onChainId ? { onChainId } : {}),
      });
    }

    return Array.from(seen.values());
  }

  async networkId(): Promise<string> {
    return computeNetworkId();
  }

  get peerId(): string {
    return this.node.peerId;
  }

  get nodeName(): string {
    return this.config.name;
  }

  get nodeFramework(): string | undefined {
    return this.config.framework;
  }

  private async getCclPolicyByUri(policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
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
  private assertCallerIsOwner(owner: string, callerAgentAddress: string | undefined, action: string): void {
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

  private async assertParanetOwner(paranetId: string, callerAgentAddress?: string): Promise<void> {
    const owner = await this.getContextGraphOwner(paranetId);
    if (!owner) {
      throw new Error(`Paranet "${paranetId}" has no registered owner; cannot manage policies.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      throw new Error(`Only the paranet owner can manage policies for "${paranetId}". Owner=${owner}, caller=${`did:dkg:agent:${callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`}`);
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
  async assertContextGraphOwner(paranetId: string, callerAgentAddress: string | undefined, action: string): Promise<void> {
    const owner = await this.getContextGraphOwner(paranetId);
    if (!owner) {
      throw new Error(`Context graph "${paranetId}" has no registered owner; cannot ${action}.`);
    }
    if (!this.isCallerOrNodeOwner(owner, callerAgentAddress)) {
      const caller = callerAgentAddress
        ? `did:dkg:agent:${callerAgentAddress}`
        : `did:dkg:agent:${this.defaultAgentAddress ?? this.peerId}`;
      throw new Error(
        `Only the context graph curator can ${action} for "${paranetId}". ` +
        `Owner=${owner}, caller=${caller}.`,
      );
    }
  }

  /**
   * Check if the given owner DID matches the caller or the node's own identity.
   * When `callerAgentAddress` is provided, only that exact address is accepted
   * (plus legacy peerId compat only for the default agent).
   * Without a caller (node-level token), falls back to defaultAgentAddress and peerId.
   */
  private isCallerOrNodeOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const peerDid = `did:dkg:agent:${this.peerId}`;
    if (callerAgentAddress) {
      if (ownerDid === `did:dkg:agent:${callerAgentAddress}`) return true;
      if (callerAgentAddress === this.defaultAgentAddress && ownerDid === peerDid) return true;
      return false;
    }
    // No explicit caller (SDK / node-level token): accept only the node's
    // own identities (peerId + defaultAgentAddress). On multi-agent nodes,
    // callers must supply callerAgentAddress to operate on non-default CGs.
    if (ownerDid === peerDid) return true;
    if (this.defaultAgentAddress && ownerDid === `did:dkg:agent:${this.defaultAgentAddress}`) return true;
    return false;
  }

  /**
   * Chain registration must be authorized by an EVM-address principal. A
   * libp2p peer ID proves transport identity, not on-chain authority.
   */
  private isCallerOrNodeAddressOwner(ownerDid: string, callerAgentAddress?: string): boolean {
    const ownerAddress = ownerDid.replace(/^did:dkg:agent:/, '');
    if (!ethers.isAddress(ownerAddress)) return false;
    if (callerAgentAddress) {
      return ethers.isAddress(callerAgentAddress) && ownerAddress.toLowerCase() === callerAgentAddress.toLowerCase();
    }
    return !!this.defaultAgentAddress
      && ethers.isAddress(this.defaultAgentAddress)
      && ownerAddress.toLowerCase() === this.defaultAgentAddress.toLowerCase();
  }

  private getChainPublishAuthorityAddress(): string | undefined {
    const chainWithSigner = this.chain as unknown as {
      getSignerAddress?: () => string;
      signerAddress?: string;
    };
    const rawAddress = chainWithSigner.getSignerAddress?.() ?? chainWithSigner.signerAddress;
    if (rawAddress && ethers.isAddress(rawAddress)) {
      return ethers.getAddress(rawAddress);
    }
    return undefined;
  }

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
  private async senderIsContextGraphCurator(contextGraphId: string, senderPeerId: string): Promise<boolean> {
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

  private async getContextGraphOwner(paranetId: string): Promise<string | null> {
    const cgMetaGraph = paranetMetaGraphUri(paranetId);
    const paranetUri = `did:dkg:context-graph:${paranetId}`;
    // Prefer the curator (wallet-scoped owner) so per-agent authorization
    // works on multi-agent nodes. Fall back to the creator (libp2p peer ID)
    // for legacy CGs created before the curator triple existed.
    const curatorResult = await this.store.query(`
      SELECT ?owner WHERE {
        GRAPH <${cgMetaGraph}> {
          <${paranetUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?owner .
        }
      }
      LIMIT 1
    `);
    if (curatorResult.type === 'bindings' && curatorResult.bindings.length > 0) {
      const owner = (curatorResult.bindings[0] as Record<string, string>)['owner'];
      if (owner) return owner;
    }
    return this.getContextGraphCreator(paranetId);
  }

  private async getContextGraphCurator(contextGraphId: string): Promise<string | null> {
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const curatorResult = await this.store.query(`
      SELECT ?owner WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?owner .
        }
      }
      LIMIT 1
    `);
    if (curatorResult.type === 'bindings' && curatorResult.bindings.length > 0) {
      const owner = (curatorResult.bindings[0] as Record<string, string>)['owner'];
      if (owner) return owner;
    }
    return null;
  }

  private async getContextGraphParticipantAgentAddresses(contextGraphId: string): Promise<string[]> {
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

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = contextGraphMetaUri(contextGraphId);
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        add(row['agent']);
      }
    }
    return merged;
  }

  /**
   * Read `dkg:creator` (peer-ID DID) for a paranet. This is the publicly
   * discoverable owner handle used in gossip validation — it propagates
   * through ONTOLOGY sync for open CGs, while `dkg:curator` stays in `_meta`.
   * Emitted approve/revoke binding metadata must use this value so remote
   * peers validating via `gossip-publish-handler` see a matching owner.
   */
  private async getContextGraphCreator(paranetId: string): Promise<string | null> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(paranetId);
    const paranetUri = `did:dkg:context-graph:${paranetId}`;
    const result = await this.store.query(`
      SELECT ?owner WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${paranetUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${paranetUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        }
      }
      LIMIT 1
    `);
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    return (result.bindings[0] as Record<string, string>)['owner'] ?? null;
  }

  private async listCclPolicyBindings(opts: {
    paranetId?: string;
    name?: string;
  } = {}): Promise<PolicyApprovalBinding[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.paranetId) filters.push(`?paranet = <did:dkg:context-graph:${opts.paranetId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const result = await this.store.query(`
      SELECT ?binding ?policy ?paranet ?name ?contextType ?bindingStatus ?approvedAt ?approvedBy ?revokedAt ?revokedBy WHERE {
        GRAPH <${ontologyGraph}> {
          ?binding <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_POLICY_BINDING}> ;
                   <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_PARANET}> ?paranet ;
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
        paranetId: row['paranet'].startsWith('did:dkg:context-graph:') ? row['paranet'].slice('did:dkg:context-graph:'.length) : row['paranet'],
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
      const key = `${b.paranetId}|${b.name}|${b.contextType ?? ''}`;
      if (!latestByScope.has(key)) {
        latestByScope.set(key, b.bindingUri);
      } else if (b.bindingUri !== latestByScope.get(key)) {
        b.status = 'superseded';
      }
    }
    return allBindings;
  }

  private selectLatestNonRevokedBindings(bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
    const latestByScope = new Map<string, PolicyApprovalBinding>();
    for (const binding of bindings) {
      if (binding.status === 'revoked' || binding.status === 'superseded') continue;
      const key = `${binding.paranetId}|${binding.name}|${binding.contextType ?? ''}`;
      const current = latestByScope.get(key);
      if (!current || binding.approvedAt > current.approvedAt) {
        latestByScope.set(key, binding);
      }
    }
    return latestByScope;
  }

  private resolveCclPolicyBinding(
    latestByScope: Map<string, PolicyApprovalBinding>,
    paranetId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${paranetId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${paranetId}|${name}|`)
      ?? null;
  }

  private async getActiveCclPolicyBinding(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<PolicyApprovalBinding | null> {
    const record = await this.getCclPolicyByUri(opts.policyUri);
    if (!record) return null;
    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: record.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const active = this.resolveCclPolicyBinding(latestByScope, opts.paranetId, record.name, opts.contextType);
    if (!active || active.policyUri !== opts.policyUri) return null;
    return active;
  }

  private deriveCclPolicyStatus(
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

  private async publishOntologyQuads(ual: string, quads: Quad[]): Promise<void> {
    const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const nquadsBufOnt = new TextEncoder().encode(nquads);
    const sigWalletOnt = this.getDefaultPublisherWallet();
    const sigOnt = buildPublishRequestSig(sigWalletOnt, ual, nquadsBufOnt);
    const msg = encodePublishRequest({
      ual,
      nquads: nquadsBufOnt,
      paranetId: SYSTEM_PARANETS.ONTOLOGY,
      kas: [],
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: sigWalletOnt?.address ?? '',
      startKAId: 0,
      endKAId: 0,
      chainId: '',
      publisherSignatureR: sigOnt.publisherSignatureR,
      publisherSignatureVs: sigOnt.publisherSignatureVs,
    });

    const ctx = createOperationContext('publish');
    try {
      await this.signedGossipPublish(ontologyTopic, 'PUBLISH_REQUEST', SYSTEM_PARANETS.ONTOLOGY, msg);
    } catch (err) {
      // r22-6: signing/envelope failures surface as ERROR; "no
      // subscribers" remains benign for local-only operation.
      logSignedGossipFailure(this.log, ctx, ontologyTopic, err);
    }
  }

  get identityId(): bigint {
    return this.publisher.getIdentityId();
  }

  /**
   * Sign the context graph participant digest: keccak256(contextGraphId, merkleRoot).
   * Returns the caller's identity ID and compact ECDSA (r, vs) values that the
   * ContextGraphs contract can verify via ecrecover.
   */
  async signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> {
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('Chain adapter does not support signMessage');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, ethers.hexlify(merkleRoot)],
    );
    const sig = await this.chain.signMessage(ethers.getBytes(digest));
    return { identityId: this.identityId, ...sig };
  }

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  /** Returns a snapshot of the context graph subscription registry. */
  getSubscribedContextGraphs(): ReadonlyMap<string, ContextGraphSub> {
    return this.subscribedContextGraphs;
  }

  /** Returns the latest health snapshot for all known peers. */
  getPeerHealth(): ReadonlyMap<string, PeerHealth> {
    return this.peerHealth;
  }

  async getPeerProtocols(peerId: string): Promise<string[]> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const pid = peerIdFromString(peerId);
      const peer = await this.node.libp2p.peerStore.get(pid);
      return [...(peer.protocols ?? [])];
    } catch {
      return [];
    }
  }

  /**
   * Ping all known peers to check liveness. Updates the peerHealth map with
   * latency and last-seen timestamps. Returns the number of peers that responded.
   */
  async pingPeers(): Promise<number> {
    const ctx = createOperationContext('system');
    const peers = this.node.libp2p.getPeers();
    if (peers.length === 0) return 0;

    const PING_TIMEOUT_MS = 10_000;
    let alive = 0;
    const now = Date.now();

    const results = await Promise.allSettled(
      peers.map(async (peerId) => {
        const id = peerId.toString();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
        try {
          const latency = await this.node.libp2p.services.ping.ping(peerId, { signal: ac.signal });
          clearTimeout(timer);
          this.peerHealth.set(id, {
            peerId: id,
            alive: true,
            latencyMs: latency,
            lastSeen: now,
            lastChecked: now,
          });
          return true;
        } catch {
          clearTimeout(timer);
          const prev = this.peerHealth.get(id);
          this.peerHealth.set(id, {
            peerId: id,
            alive: false,
            latencyMs: null,
            lastSeen: prev?.lastSeen ?? null,
            lastChecked: now,
          });
          return false;
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) alive++;
    }

    this.log.info(ctx, `Peer health ping: ${alive}/${peers.length} peers alive`);
    return alive;
  }

  /**
   * Scan the local ONTOLOGY graph and curated/private _meta graphs for context
   * graph definitions and auto-subscribe to any that aren't yet in the
   * subscription registry. Called after syncFromPeer to catch context graphs
   * discovered via ONTOLOGY sync or authenticated _meta sync.
   */
  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, { id: string; name: string; source: 'ontology' | 'meta' }>();

    const collectEntries = (
      rows: Record<string, string>[],
      source: 'ontology' | 'meta',
    ) => {
      for (const row of rows) {
        const uri = row['ctxGraph'] ?? '';
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!id) continue;
        if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

        const existing = discoveredEntries.get(id);
        const name = row['name'] ? stripLiteral(row['name']) : existing?.name ?? id;

        if (!existing || (existing.source === 'meta' && source === 'ontology')) {
          discoveredEntries.set(id, { id, name, source });
        }
      }
    };

    const ontologyResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (ontologyResult.type === 'bindings') {
      collectEntries(ontologyResult.bindings as Record<string, string>[], 'ontology');
    }

    const metaResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH ?metaGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
          FILTER(STRENDS(STR(?metaGraph), "/_meta"))
        }
      }
    `);
    if (metaResult.type === 'bindings') {
      collectEntries(metaResult.bindings as Record<string, string>[], 'meta');
    }

    for (const { id, name, source } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) continue;

      // Two kinds of discovered CG, two different opt-in semantics:
      //
      // - Open / public CG (no curated _meta graph locally): Viktor's
      //   v10-rc hardening (commit b9a73e7e "better sync") says do
      //   NOT auto-subscribe — a node shouldn't auto-ingest every
      //   public CG a peer happens to know about. Explicit subscribe
      //   (UI "Join" / `subscribeToContextGraph`) is the opt-in.
      //
      // - Curated / private CG (access policy "private" or has an
      //   allowlist): auto-subscribe so `trySyncFromPeer`'s
      //   "newly discovered CGs" catchup pass (see dkg-agent.ts
      //   ~#1009) actually fetches the KC data on the same connect
      //   cycle. Without this, a freshly invited node would see
      //   the CG registered locally but never pull any KCs —
      //   regressed the e2e-privacy "B discovers and syncs a
      //   private CG in a single connect cycle via trySyncFromPeer"
      //   test. `authorizeSyncRequest` still enforces the allowlist
      //   on the responder side, so auto-subscribing here cannot
      //   leak private data to non-participants; it only means
      //   "attempt the catchup now instead of deferring it".
      //   NOTE: we use `isPrivateContextGraph` (which reads the
      //   ontology OR the _meta graph for `dkg:accessPolicy
      //   "private"`, and also treats any CG with a `DKG_ALLOWED_
      //   AGENT` allowlist as private) rather than
      //   `source === 'meta'`, because the ontology-vs-meta
      //   collision resolver above lets an ontology row shadow a
      //   meta row when both exist for the same id.
      const isCurated = await this.isPrivateContextGraph(id);

      if (isCurated) {
        // Seed the subscription entry BEFORE calling subscribeToContextGraph
        // so the `...existing` spread in `subscribeToContextGraph` preserves
        // the discovered human-readable `name` (otherwise the UI/listing
        // APIs fall back to the raw CG id).
        //
        // Intentionally leave `metaSynced` FALSE here. The gossip handler's
        // "deny until _meta is synced" guard must stay armed until the
        // authenticated allowlist (`_meta` graph) has actually arrived —
        // discovery alone can land with just the ontology/access-policy
        // triples while `allowedPeers` is still null. The follow-up
        // `refreshMetaSyncedFlags(newlyDiscovered)` call from
        // `trySyncFromPeer` (see ~#1012) will flip the flag once the
        // allowlist has been fetched via the authenticated sync path.
        this.subscribedContextGraphs.set(id, {
          name,
          subscribed: false,
          synced: true,
          metaSynced: false,
          onChainId: undefined,
        });
        this.subscribeToContextGraph(id);
        this.log.info(ctx, `Discovered invited context graph "${name}" (${id}) — auto-subscribed (private/allowlisted)`);
      } else {
        this.subscribedContextGraphs.set(id, {
          name,
          subscribed: false,
          synced: true,
          metaSynced: source === 'meta',
          onChainId: undefined,
        });
        this.log.info(ctx, `Discovered context graph "${name}" (${id}) from ${source} store — added as discoverable only`);
      }
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store`);
    }
    return discovered;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }

    let onChainContextGraphs;
    try {
      onChainContextGraphs = await this.chain.listContextGraphsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain context graph scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainContextGraphs) {
      if (knownOnChainIds.has(p.contextGraphId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.contextGraphId);
        continue;
      }

      this.subscribedContextGraphs.set(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        metaSynced: false,
        onChainId: p.contextGraphId,
      });
      this.subscribeToContextGraph(p.name, { trackSyncScope: false });

      // Persist the on-chain ID to the ontology graph so the publisher's
      // VM registration guard can find it via RDF (it has no access to
      // the in-memory subscribedContextGraphs map).
      const cgUri = paranetDataGraphUri(p.name);
      const ontoGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
      await this.store.insert([{
        subject: cgUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`,
        object: `"${p.contextGraphId}"`,
        graph: ontoGraph,
      }]);

      this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    return discovered;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
    await this.node.stop();
    if (this.syncVerifyWorker) {
      await this.syncVerifyWorker.close();
      this.syncVerifyWorker = undefined;
    }
    this.started = false;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureParanet(SYSTEM_PARANETS.AGENTS);
    await gm.ensureParanet(SYSTEM_PARANETS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) return;

    // Insert genesis quads
    const genesisQuads = getGenesisQuads();
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
  }

  /**
   * Create a V10 ACK provider callback for the publisher.
   * Uses ACKCollector to broadcast PublishIntent and collect StorageACKs
   * via direct P2P from connected core nodes. The required number of ACKs
   * is read from chain ParametersStorage.minimumRequiredSignatures().
   */
  private createV10ACKProvider(contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    // `isV10Ready()` is the authoritative V10 capability gate. Using it
    // (instead of probing for `createKnowledgeAssetsV10`) keeps
    // `NoChainAdapter` — whose stub methods throw — out of the V10 path.
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    // Require on-chain identity verification to prevent accepting unverified ACKs
    // that would fail on-chain and waste gas. Fall back to legacy path if unavailable.
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    // The H5 prefix requires a numeric chain id AND the deployed KAV10
    // address. Without BOTH, the collector cannot build a digest that
    // matches what core-node ACK handlers sign, so refuse to hand back a
    // provider at all rather than crash on the first publish with
    // `chain.getEvmChainId is not a function`. Mirrors the guard at
    // `packages/cli/src/publisher-runner.ts:createV10ACKProviderForPublisher`.
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsV10Address !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        return this.router.send(peerId, protocol, data);
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        // Prefer peers confirmed as core nodes (advertise StorageACK protocol).
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        // Fallback: return all connected peers during early startup before
        // protocol discovery completes. Since only core nodes register the
        // StorageACK handler, requests to edge nodes fail at protocol
        // negotiation (fast, no error logs on the remote side).
        return connected;
      },
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('publish');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (
      merkleRoot: Uint8Array,
      contextGraphId: string,
      kaCount: number,
      rootEntities: string[],
      publicByteSize: bigint,
      stagingQuads?: Uint8Array,
      epochs?: number,
      tokenAmount?: bigint,
      swmGraphId?: string,
      subGraphName?: string,
    ) => {
      // Fail loud on non-numeric or non-positive CG ids: V10 publish requires
      // a real on-chain context graph and the contract rejects `cgId == 0`
      // with `ZeroContextGraphId`. Reject `<= 0n` (not `=== 0n`) because
      // `BigInt("-1")` returns `-1n` without throwing — a naive zero check
      // would let negative ids through to the evm-adapter pre-tx guard,
      // where ethers' uint256 encoder would throw a cryptic low-level
      // error. Matches the same guard in dkg-publisher, storage-ack-handler,
      // and async publisher-runner so ACK signers, ACK verifiers, and the
      // chain submitter all agree on the legal domain. `contextGraphId`
      // here is the TARGET on-chain id — `swmGraphId` (optional) is the
      // source SWM graph name and is NOT required to be numeric.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }

      // Per-CG quorum (spec §06_PUBLISH / BUGS_FOUND.md A-5) supersedes the
      // global ParametersStorage minimum, which is only the network-wide
      // floor. Read both, use whichever is HIGHER so neither gate is bypassed.
      const globalMin = typeof chain.getMinimumRequiredSignatures === 'function'
        ? await chain.getMinimumRequiredSignatures()
        : undefined;
      const perCgMin = typeof chain.getContextGraphRequiredSignatures === 'function'
        ? await chain.getContextGraphRequiredSignatures(cgIdBigInt).catch(() => 0)
        : 0;
      const requiredACKs = (globalMin === undefined && (!perCgMin || perCgMin <= 0))
        ? undefined
        : Math.max(globalMin ?? 0, perCgMin ?? 0);

      // H5 prefix inputs — both come from the chain adapter so that
      // publisher-side digest construction matches what core-node handlers
      // produced on their side. These are required for any V10 path; the
      // adapter must implement them.
      const chainIdBig = await chain.getEvmChainId();
      const kav10Address = await chain.getKnowledgeAssetsV10Address();

      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize,
        isPrivate: false,
        kaCount,
        rootEntities,
        chainId: chainIdBig,
        kav10Address,
        requiredACKs,
        stagingQuads,
        epochs,
        tokenAmount,
        swmGraphId,
        subGraphName,
      });
      return result.acks;
    };
  }

  private async broadcastPublish(contextGraphId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const onChain = result.onChainResult;
    const ntriplesBuf = new TextEncoder().encode(ntriples);
    const sigWalletBP = this.getDefaultPublisherWallet();
    const sigBP = buildPublishRequestSig(sigWalletBP, result.ual, ntriplesBuf);
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: ntriplesBuf,
      paranetId: contextGraphId,
      kas: result.kaManifest.map(ka => ({
        tokenId: Number(ka.tokenId),
        rootEntity: ka.rootEntity,
        privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
        privateTripleCount: ka.privateTripleCount ?? 0,
      })),
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: onChain?.publisherAddress ?? sigWalletBP?.address ?? '',
      startKAId: Number(onChain?.startKAId ?? 0),
      endKAId: Number(onChain?.endKAId ?? 0),
      chainId: this.chain.chainId,
      publisherSignatureR: sigBP.publisherSignatureR,
      publisherSignatureVs: sigBP.publisherSignatureVs,
      txHash: onChain?.txHash ?? '',
      blockNumber: onChain?.blockNumber ?? 0,
      operationId: ctx.operationId,
      subGraphName: result.subGraphName,
    });

    const topic = paranetPublishTopic(contextGraphId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.signedGossipPublish(topic, 'PUBLISH_REQUEST', contextGraphId, msg);
    } catch (err) {
      // Bot review (PR #229 r22-6, dkg-agent.ts:7411): observer /
      // wallet-less nodes previously saw `signedGossipPublish`
      // throwing a SignedGossipSigningError and the blanket
      // `catch { log.warn("no subscribers") }` reported a successful
      // publish — while strict peers dropped the raw gossip.
      // `logSignedGossipFailure` logs signing errors as ERROR with a
      // distinctive message (visible to operators) while keeping
      // the "no subscribers" transport blip as a WARN. The local
      // publish has already been committed to the WAL / local store
      // so we deliberately do not rethrow — otherwise tentative
      // publishes on observer / wallet-less nodes would regress
      // (pinned by `v10-ack-provider.test.ts`). Visibility is the
      // fix the bot comment demands, not hard-failing the op.
      logSignedGossipFailure(this.log, ctx, topic, err);
    }
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  get assertion() {
    const agent = this;
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    return {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        return agent.publisher.assertionCreate(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * Write triples to a WM assertion. Accepts:
       * - `Quad[]` — standard quad array (same as publish/share)
       * - `JsonLdContent` — JSON-LD document, auto-converted to quads
       * - `Array<{ subject, predicate, object }>` — simple triple array
       */
      async write(
        contextGraphId: string,
        name: string,
        input: import('@origintrail-official/dkg-storage').Quad[] | JsonLdContent | Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string },
      ): Promise<void> {
        let quads: import('@origintrail-official/dkg-storage').Quad[];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          quads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          const { publicQuads, privateQuads } = await jsonLdToQuads(input as JsonLdContent);
          quads = [...publicQuads, ...privateQuads];
        } else {
          quads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        return agent.publisher.assertionWrite(contextGraphId, name, agentAddress, quads, opts?.subGraphName);
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        return agent.publisher.assertionQuery(contextGraphId, name, agentAddress, opts?.subGraphName);
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string }): Promise<{ promotedCount: number }> {
        const { promotedCount, gossipMessage } = await agent.publisher.assertionPromote(
          contextGraphId, name, agentAddress,
          { ...opts, publisherPeerId: agent.node.peerId.toString() },
        );
        if (gossipMessage) {
          const topic = paranetWorkspaceTopic(contextGraphId);
          try {
            // Wrap in signed envelope so subscribers can verify the
            // promote broadcast's signer matches an allowed CG member
            // (PR #229 bot review round 6 — signed-gossip envelope bypass).
            await agent.signedGossipPublish(topic, 'ASSERTION_PROMOTE', contextGraphId, gossipMessage);
          } catch (err: any) {
            // r22-6: local SWM mutation already succeeded. Signing
            // failures mean the promote WILL NOT be propagated to
            // any strict peer — surface this loudly as ERROR via
            // `logSignedGossipFailure` (distinct from the routine
            // "no subscribers" transport warning) while keeping
            // the local mutation intact (callers can observe the
            // error log and decide whether to retry / alert).
            const promoteCtx = createOperationContext('share');
            if (isSignedGossipSigningError(err)) {
              logSignedGossipFailure(agent.log, promoteCtx, topic, err);
            } else {
              agent.log.warn(promoteCtx, `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
            }
          }
        }
        return { promotedCount };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        return agent.publisher.assertionDiscard(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const lifecycleUri = assertionLifecycleUri(contextGraphId, addr, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Query assertion entity (current state + layer)
        const entityResult = await agent.store.query(
          `SELECT ?state ?memoryLayer ?assertionGraph WHERE {
            GRAPH <${metaGraph}> {
              <${lifecycleUri}> <${DKG_NS}state> ?state .
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
            }
          } LIMIT 1`,
        );
        if (entityResult.type !== 'bindings' || entityResult.bindings.length === 0) return null;

        const row = entityResult.bindings[0];
        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const graphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?kcUal ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              ?event <${DKG_NS}fromLayer> ?fromLayer .
              ?event <${DKG_NS}toLayer> ?toLayer .
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}kcUal> ?kcUal }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? '',
                toLayer: strip(b['toLayer']) ?? '',
                shareOperationId: strip(b['shareOpId']),
                kcUal: strip(b['kcUal']),
                rootEntities: b['rootEntity'] ? [b['rootEntity']] : undefined,
              });
            } else if (b['rootEntity']) {
              const existing = eventMap.get(eventUri)!;
              if (!existing.rootEntities) existing.rootEntities = [];
              if (!existing.rootEntities.includes(b['rootEntity'])) {
                existing.rootEntities.push(b['rootEntity']);
              }
            }
          }
        }

        return {
          contextGraphId,
          agentAddress: addr,
          name,
          state: stateStr,
          memoryLayer: (layerStr as MemoryLayer) ?? null,
          assertionGraph: graphUri,
          events: [...eventMap.values()],
        };
      },
    };
  }

}

