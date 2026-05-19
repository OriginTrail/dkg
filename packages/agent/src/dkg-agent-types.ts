// SPDX-License-Identifier: Apache-2.0

/**
 * Type and error-class surface for `DKGAgent` extracted from
 * `dkg-agent.ts` as part of a mechanical file-size reduction. Behaviour
 * and runtime semantics are unchanged — this module is a 1:1 move of
 * the public interface, public error classes, and the file-local
 * structural types that `DKGAgent` consumes.
 *
 * `dkg-agent.ts` re-exports the public symbols (`DKGAgent`,
 * `ContextGraphNotFoundError`, `InvalidContentError`, every `type …`
 * previously declared there) from this module so external imports of
 * `./dkg-agent.js` keep working. `packages/agent/src/index.ts`
 * additionally re-exports the public surface for the workspace.
 */

import type { ethers } from 'ethers';
import type {
  Quad,
  TripleStore,
  TripleStoreConfig,
  LargeLiteralStorageConfig,
} from '@origintrail-official/dkg-storage';
import type {
  OperationContext,
  AuthorAttestationTypedData,
  MessageIdempotencyStore,
  ProtocolOutboxStore,
} from '@origintrail-official/dkg-core';
import type {
  PhaseCallback,
  LiftTransitionType,
  LiftAuthorityProof,
  SharedMemoryPublicSnapshotStorageConfig,
} from '@origintrail-official/dkg-publisher';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { QueryAccessConfig } from '@origintrail-official/dkg-query';
import type { SkillHandler } from './messaging.js';
import type { CclFactResolutionMode } from './ccl-fact-resolution.js';
import type { JsonLdContent } from './dkg-agent-utils.js';
import type { SyncPhase } from './sync/auth/request-build.js';

// ── File-local structural types ─────────────────────────────────────

/**
 * Pre-signed AuthorAttestation payload supplied at finalize-time by
 * self-sovereign agents whose private key isn't held by the daemon.
 * Compact ECDSA `(r, vs)` over the EIP-712 typed data
 * `buildAuthorAttestationTypedData({ chainId, kav10Address,
 * contextGraphId, merkleRoot, authorAddress: address })`. The agent
 * verifies the recovered signer matches `address` before stamping the
 * seal.
 *
 * Lives at the agent layer (rather than as a publisher
 * `PublishOptions` field) since RFC-001 §9.x — Phase C — the
 * publisher only accepts already-sealed `precomputedAttestation`
 * payloads. Pre-signed signing is a finalize-time concern.
 */
export type PreSignedAuthorAttestation = {
  address: string;
  signature: { r: Uint8Array; vs: Uint8Array };
};

export type LocalSwmSenderKeySendState = {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  chainKey: Uint8Array;
  nextMessageIndex: number;
  senderSigningSecretKey: Uint8Array;
  senderSigningPublicKey: Uint8Array;
  createdAtMs: number;
};

export type LocalSwmSenderKeyReceiveState = {
  contextGraphId: string;
  subGraphName?: string;
  senderAgentAddress: string;
  epochId: string;
  membershipHash: string;
  chainKey: Uint8Array;
  nextMessageIndex: number;
  senderSigningPublicKey: Uint8Array;
  createdAtMs: number;
  skippedChainKeys: Map<number, Uint8Array>;
};

export type RandomSamplingStartResult = 'started' | 'retryable' | 'disabled';

export type ACKSignerResolution = {
  wallet: ethers.Wallet | null;
  retryable: boolean;
};

export interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  phase?: SyncPhase;
  snapshotRef?: string;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
}

// ── Public error classes ────────────────────────────────────────────

export class ContextGraphNotFoundError extends Error {
  readonly code = 'ContextGraphNotFound';

  constructor(contextGraphId: string) {
    super(`Context graph "${contextGraphId}" does not exist or is not subscribed locally`);
    this.name = 'ContextGraphNotFound';
  }
}

export class InvalidContentError extends Error {
  readonly code = 'InvalidContent';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidContent';
  }
}

/**
 * Thrown by `fetchSyncPages` when the remote responder returned
 * `SYNC_ACCESS_DENIED_MARKER`. Caught by `syncFromPeer` and surfaced as
 * a per-CG denial observation to the caller via its `onAccessDenied`
 * hook, so higher-level flows (catch-up job) can distinguish ACL
 * denial from transport errors without heuristics.
 */
export class SyncAccessDeniedError extends Error {
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(`Sync access denied for context graph "${contextGraphId}"`);
    this.name = 'SyncAccessDeniedError';
    this.contextGraphId = contextGraphId;
  }
}

// ── Publish surface ─────────────────────────────────────────────────

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

export interface PublishOpts {
  onPhase?: PhaseCallback;
  operationCtx?: OperationContext;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
  subGraphName?: string;
}

export interface PublishAsyncOpts extends PublishOpts {
  namespace?: string;
  scope?: string;
  transitionType?: LiftTransitionType;
  authority?: LiftAuthorityProof;
  /** Prior KC reference; required for MUTATE/REVOKE. */
  priorVersion?: string;
  /** V10 selective-disclosure: per-entity kaRoot instead of flat-hash KC. */
  entityProofs?: boolean;
  /** RFC-001 §4 per-publish attribution override; `0n` = mode d. */
  publisherNodeIdentityIdOverride?: bigint;
  localOnly?: boolean;
  /** Registered local agent whose key signs the seal. Mirrors sync `assertionFinalize`. */
  authorAgentAddress?: string;
  /** Externally pre-signed seal. Mutually exclusive with `authorAgentAddress` / `authorSignTypedData`. */
  preSignedAuthorAttestation?: {
    expectedMerkleRoot: Uint8Array;
    authorAddress: string;
    signature: { r: Uint8Array; vs: Uint8Array };
    schemeVersion: number;
  };
  /** Caller signs typed-data built by the daemon. Requires `authorAgentAddress`. */
  authorSignTypedData?: (typedData: AuthorAttestationTypedData) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
}

export interface PublishAsyncQuadEnvelope {
  publicQuads?: Quad[];
  privateQuads?: Quad[];
}

export type PublishAsyncContent = JsonLdContent | PublishAsyncQuadEnvelope;

// ── Peer + diagnostics surface ──────────────────────────────────────

/** Health status of a peer from the last ping round. */
export interface PeerHealth {
  peerId: string;
  alive: boolean;
  latencyMs: number | null;
  lastSeen: number | null;
  lastChecked: number;
}

/** Per-connection snapshot for diagnostics. */
export interface PeerConnectionSnapshot {
  direction: 'inbound' | 'outbound';
  /** `'relayed'` when the remote multiaddr includes `/p2p-circuit`, else `'direct'`. */
  transport: 'direct' | 'relayed';
  /**
   * The connection's remote multiaddr as a string, or `null` when
   * libp2p didn't expose one. Preserving the `null` (rather than
   * defaulting to `''`) keeps the legacy `/api/peer-info`
   * `remoteAddrs` contract intact for callers that distinguish
   * "address unavailable" from a real multiaddr — Codex review of
   * PR #533 flagged the prior empty-string default as a silent
   * response-shape change.
   */
  remoteAddr: string | null;
  /**
   * `true` when libp2p marks the connection as limited (circuit-relay v2
   * data-limit + duration-limit semantics). Limited connections can be
   * dialed via {@link CONNECTION_REUSE_PROTOCOLS} but are subject to the
   * relay's per-connection caps; the Window D postmortem traced the
   * "outbound failed while inbound from same peer was open" class to
   * limited connections not being reused by `dialProtocol`.
   */
  limited: boolean;
  /** Active stream count (multiplexer-level). */
  streams: number;
  /** UNIX-ms when the connection was opened, or `null` if libp2p didn't expose it. */
  openedAt: number | null;
}

/**
 * Per-peer diagnostic snapshot. Surfaces the libp2p observability state
 * we need to triage the Window D class of asymmetric reachability bugs
 * documented in the Miles↔Lex 6h soak postmortem (May 16 2026), where an
 * inbound circuit-relay connection from peer P was open but
 * `dialProtocol(P, ...)` kept failing with "no valid addresses for peer"
 * for several minutes. The key field is `getConnectionsReturnsForPeer`,
 * which lets an operator (or a downstream test) detect at a glance when
 * libp2p's peerId-keyed lookup disagrees with a raw walk over all open
 * connections — the smoking gun for the "limited connection not
 * surfaced for outbound stream-open" behaviour.
 *
 * All fields are best-effort: any libp2p internal that throws or
 * returns an unexpected shape degrades to `null`/`[]` rather than
 * surfacing as a route 500. This route is most useful WHEN the network
 * is broken; it must not itself break.
 */
export interface PeerDiagnostics {
  peerId: string;
  /** `true` when at least one open connection to this peer exists. */
  connected: boolean;
  /**
   * Number of connections returned by walking every open libp2p
   * connection and filtering by `remotePeer === peerId`. This is the
   * legacy path used by `/api/peer-info` before this PR.
   */
  rawConnectionCount: number;
  /**
   * Number of connections returned by the peerId-keyed lookup
   * `libp2p.getConnections(peerId)`. This is the path `PeerResolver`
   * (see `packages/core/src/network/peer-resolver.ts`) uses to decide
   * whether to short-circuit address resolution.
   *
   * When this value is LESS than `rawConnectionCount` for an otherwise
   * open peer, libp2p's peerId-keyed lookup is filtering out connections
   * the raw walk can see — the exact Window D signature. The operator
   * can then file an upstream issue against js-libp2p with this number
   * as repro evidence, and the local workaround in PR 5
   * (`dialProtocol`-reuses-inbound-circuit) becomes the right next step.
   */
  getConnectionsReturnsForPeer: number;
  connections: PeerConnectionSnapshot[];
  /**
   * Snapshot of what libp2p's local peerStore knows about this peer.
   * `null` when the peer has no peerStore entry at all (cold cache) —
   * a common precondition for the "no valid addresses for peer" dial
   * failure that the soak postmortem identified.
   */
  peerStore: {
    knownMultiaddrCount: number;
    multiaddrs: string[];
    protocols: string[];
  } | null;
  /**
   * Pending substrate-outbox entries for this peer.
   *
   * Top-level fields (`pendingCount`, `oldestFirstFailureAt`,
   * `attempts`) keep the rc.8 chat-only contract that
   * `/api/peer-info` + MCP `dkg_peer_info` consumers depend on.
   *
   * `byProtocol` (rc.9 PR-E codex follow-up #10) breaks out queued
   * entries per libp2p protocol id so post-substrate-migration
   * traffic (sync, SWM, future protocols) is visible to operator
   * diagnostics — without it, a peer stuck on sync catch-up reports
   * `pendingCount=0` and looks healthy.
   */
  outbox: {
    /** Pending count for the chat protocol specifically (rc.8 contract). */
    pendingCount: number;
    /** Oldest `firstFailureAt` among chat-protocol pending entries. */
    oldestFirstFailureAt: number | null;
    /** Per-entry attempt counts among chat-protocol pending entries. */
    attempts: number[];
    /**
     * Per-protocol pending breakdown for this peer (rc.9 PR-E codex
     * follow-up #10). Each key is the libp2p protocol id; value
     * mirrors the chat-only summary shape so operator tooling can
     * render per-protocol with no extra plumbing.
     */
    byProtocol: Record<
      string,
      {
        pendingCount: number;
        oldestFirstFailureAt: number | null;
        attempts: number[];
      }
    >;
  };
  /** Latest ping-round health snapshot (`null` if never pinged). */
  health: PeerHealth | null;
  /** Protocols this peer's identify-handshake advertised. */
  protocols: string[];
  /** Convenience flag — peer speaks `/dkg/10.0.0/sync`. */
  syncCapable: boolean;
}

/**
 * Caller-visible result of `DKGAgent.sendChat`. Backwards-compatible
 * extension of the original `{ delivered, error }` shape: existing
 * callers that only check `delivered` keep working, callers that want
 * to surface "queued for retry" (e.g. the MCP `dkg_send_message` tool)
 * can read `queued + attempts + nextAttemptAtMs`.
 */
export interface ChatSendResult {
  /** Whether the FIRST attempt's wire send + handler reply succeeded. */
  delivered: boolean;
  /** True iff `delivered=false` and the message was added to the outbox for retry. */
  queued?: boolean;
  /**
   * Outbox key fragment for this send. Stable across retries so a
   * caller can correlate the queued state with later delivery
   * notifications. Currently a uuidv4 unless the caller passed
   * `options.messageId`.
   */
  messageId?: string;
  /** Number of failed attempts so far (1 on first failure). Only set when `queued=true`. */
  attempts?: number;
  /** Epoch-ms when the next retry is due. Only set when `queued=true`. */
  nextAttemptAtMs?: number;
  /** Last error string from the wire send. Set on `delivered=false`. */
  error?: string;
}

// ── Context-graph surface ───────────────────────────────────────────

/** Tracks the subscription and sync state of a context graph. */
export interface ContextGraphSub {
  name?: string;
  /** GossipSub topics are active for this context graph. */
  subscribed: boolean;
  /** Definition triples exist in the local triple store. */
  synced: boolean;
  /** Shared-memory catch-up has completed at least once for this subscription. */
  sharedMemorySynced?: boolean;
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
  /**
   * Set to true between receiving a curator `join-approved` notification
   * and the first successful meta sync for this CG. Lets `listContextGraphs`
   * surface freshly-joined curated CGs in the UI's "waiting for sync" state
   * before `_meta` triples arrive — without this flag, a curated CG with
   * no `onChainId` and no local content yet is filtered out as a "phantom"
   * subscription and the project entry doesn't appear in the sidebar until
   * the periodic catchup reconciler eventually pulls meta (~2 min worst
   * case). In-memory only; not persisted because the periodic reconciler
   * always recovers post-restart by populating `metaSynced` directly.
   */
  pendingMeta?: boolean;
}

export interface ContextGraphSubscriptionRecord {
  id: string;
  name?: string;
  subscribed: boolean;
  synced: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  onChainId?: string;
  syncScoped: boolean;
}

export interface ContextGraphSubscriptionStore {
  loadAll(): Promise<ContextGraphSubscriptionRecord[]>;
  save(record: ContextGraphSubscriptionRecord): Promise<void>;
  delete(contextGraphId: string): Promise<void>;
}

export type ContextGraphMemberPrincipalType = 'node' | 'agent' | 'identity';
export type ContextGraphMemberStatus = 'active' | 'removed' | 'pending';

export interface ContextGraphMembershipRecord {
  contextGraphId: string;
  principalType: ContextGraphMemberPrincipalType;
  principalId: string;
  role?: string;
  status: ContextGraphMemberStatus;
  source?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextGraphMembershipStore {
  upsert(record: ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }): Promise<void>;
  delete(contextGraphId: string, principalType: ContextGraphMemberPrincipalType, principalId: string): Promise<void>;
}

// ── Sync diagnostics ────────────────────────────────────────────────

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

export interface DurableSyncResult extends DurableSyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

export interface SharedMemorySyncResult extends SharedMemorySyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

// ── DKGAgent configuration ──────────────────────────────────────────

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
  /** Out-of-line storage for large public SWM RDF literal object terms. Defaults on for local Oxigraph-backed dataDir stores. */
  largeLiteralStorage?: LargeLiteralStorageConfig;
  /** Out-of-Oxigraph immutable public SWM operation snapshots. Defaults on when dataDir is set. */
  sharedMemoryPublicSnapshotStorage?: SharedMemoryPublicSnapshotStorageConfig;
  /** When false, peer-connect sync skips SWM catch-up and relies on gossip for new SWM writes. */
  syncSharedMemoryOnConnect?: boolean;
  /** Node deployment tier: 'core' (cloud, relay) or 'edge' (personal, behind NAT). Default: 'edge'. */
  nodeRole?: 'core' | 'edge';
  /**
   * Core Node relay-server capacity tuning. Forwarded straight into
   * `DKGNodeConfig.relayServerCapacity` — sets the maximum number of
   * simultaneous circuit-relay v2 reservations this node will hold.
   * HOP/STOP stream caps and `connectionManager.maxConnections` are
   * derived at a 1:2 ratio. Default 1024 when omitted on a Core Node;
   * ignored on edge nodes (with a startup warning). Invalid values
   * fall back to the default. See `packages/core/src/types.ts` for
   * the full rationale + ulimit -n requirements.
   */
  relayServerCapacity?: number;
  /**
   * Number of relay reservations to hold in parallel when behind NAT.
   * Forwarded straight into `DKGNodeConfig.relayReservationCount`.
   * Default 3 when relayPeers are configured (N-2 tolerance to relay
   * blackouts). Capped at 16. Ignored (with a warning when set
   * explicitly) when no relayPeers are configured or when the node
   * itself runs a relay server — relay servers don't multi-reserve
   * through other relays. Invalid values fall back to the default
   * with a warning. See `packages/core/src/types.ts` for the full
   * rationale.
   */
  relayReservationCount?: number;
  /**
   * Path to the V10 Random Sampling prover write-ahead log. Core
   * nodes only; ignored on edge. When omitted, an in-memory WAL is
   * used (loses crash-recovery context on restart). Production
   * deployments SHOULD set this to a persistent path under `dataDir`.
   */
  randomSamplingWalPath?: string;
  /**
   * If true (default on core), run the V10 Merkle proof build on a
   * `worker_threads` worker so a 100k-leaf KC does not block the
   * agent's event loop. Set false to keep the build on the main
   * thread (test ergonomics, deterministic profiling).
   */
  randomSamplingUseWorkerThread?: boolean;
  /**
   * Tick cadence for the prover loop (ms). Default 30s. The
   * orchestrator is idempotent under double-ticks; a tighter cadence
   * is safe but yields more chain reads.
   */
  randomSamplingTickIntervalMs?: number;
  /** Pre-built chain adapter (for testing). If provided, chainConfig is ignored. */
  chainAdapter?: ChainAdapter;
  /** Private key for the V10 ACK signer. When omitted, falls back to chainConfig.operationalKeys[0]. */
  ackSignerKey?: string;
  /**
   * Publisher EVM address used when publish signing is delegated to the
   * ChainAdapter instead of an in-process publisherPrivateKey.
   */
  publisherAddress?: string;
  /**
   * EVM chain configuration. If omitted, publishing won't have on-chain finality.
   * `adminPrivateKey` is the private key for the profile admin wallet used
   * only for profile/key-management transactions. Nodes may omit it when they
   * already have an on-chain identity and do not need profile creation/key-repair
   * privileges; profile mutation paths will fail fast if admin authority is
   * required but unavailable.
   * `operationalKeys` are the private keys for operational wallets.
   * The first key is the primary signer (identity, staking); all are used
   * round-robin for publish TXs to avoid nonce collisions on parallel publishes.
   */
  chainConfig?: {
    rpcUrl: string;
    hubAddress: string;
    adminPrivateKey?: string;
    operationalKeys: string[];
    chainId?: string;
  };
  /** Cross-agent query access configuration. */
  queryAccess?: QueryAccessConfig;
  /** Additional context graph IDs to sync on peer connect (beyond system context graphs). */
  syncContextGraphs?: string[];
  /** TTL for shared memory data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  sharedMemoryTtlMs?: number;
  /** Durable local store for subscribed context-graph runtime state. */
  contextGraphSubscriptionStore?: ContextGraphSubscriptionStore;
  /** Durable local cache for nodes/agents known to be members of a context graph. */
  contextGraphMembershipStore?: ContextGraphMembershipStore;
  /**
   * Universal Messenger substrate stores (rc.9 plan PR-2). When
   * supplied, the `Messenger` instance gets durable receiver-side
   * idempotency + sender-side outbox semantics for every caller that
   * switches to `messenger.sendReliable` (the migration starts in
   * PR-3 with chat + skill). When omitted, the Messenger runs in
   * legacy pass-through mode — backwards-compatible for callers
   * still on `/dkg/10.0.0/*`.
   *
   * Production: `cli/src/daemon/lifecycle.ts` wires
   * `SqliteMessageIdempotencyStore` + `SqliteProtocolOutboxStore`
   * against the shared `DashboardDB`.
   *
   * Tests: pass `InMemoryMessageIdempotencyStore` +
   * `InMemoryProtocolOutboxStore` from `@origintrail-official/dkg-core`.
   */
  messengerStores?: {
    idempotencyStore: MessageIdempotencyStore;
    outboxStore: ProtocolOutboxStore;
  };
}
