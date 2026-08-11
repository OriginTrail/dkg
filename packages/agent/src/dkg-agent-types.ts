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
import type { CatchupPassDecisionReason } from './sync/catchup-pass-policy.js';
import type {
  Quad,
  TripleStore,
  TripleStoreConfig,
  LargeLiteralStorageConfig,
} from '@origintrail-official/dkg-storage';
import type {
  OperationContext,
  AuthorAttestationTypedData,
  DkgNetworkIdentity,
  CompatibleProtocolOutboxStore,
  MessageIdempotencyStore,
  SwmSenderKeyPackageAckReasonCode,
  ContextGraphJoinPolicyMode as CoreContextGraphJoinPolicyMode,
  ContextGraphJoinPolicyRecord as CoreContextGraphJoinPolicyRecord,
  CatalogSealDeploymentProfileV1,
  ContextGraphIdV1,
  ContextGraphPolicyV1,
  DecimalU64V1,
  Digest32V1,
  EvmAddressV1,
  NetworkIdV1,
  SubGraphNameV1,
  TimestampMsV1,
  UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type {
  PhaseCallback,
  SharedMemoryPublicSnapshotStorageConfig,
  StorageAckTiming,
  WorkspacePublicSnapshotStore,
  CursorPersistence as ChainEventCursorPersistence,
} from '@origintrail-official/dkg-publisher';
import type { ApprovalPolicy, ChainAdapter, ContextGraphRegistryScanCursorStore } from '@origintrail-official/dkg-chain';
import type { QueryAccessConfig } from '@origintrail-official/dkg-query';
import type { SkillHandler } from './messaging.js';
import type { CclFactResolutionMode } from './ccl-fact-resolution.js';
import type { SyncCheckpointStore, ChangelogCursorStore } from './sync/checkpoint/state.js';
import type { JsonLdContent } from './dkg-agent-utils.js';
import type { SwmHostModeStoreLimits } from './swm/host-mode-store.js';
import type { KaNumberAllocator } from './allocator.js';
import type { SyncPhase } from './sync/auth/request-build.js';
import type {
  Rfc64PublicCatalogActivationInputV1,
  ResolvedRfc64PublicCatalogAutoPublishPolicyV1,
} from './rfc64/public-catalog-activation-config-v1.js';
import type {
  SyncContextGraphPriorityConfig,
  SyncResponderSnapshotLimitsConfig,
} from './sync/policy.js';

// ── File-local structural types ─────────────────────────────────────

/**
 * Pre-signed AuthorAttestation payload supplied at finalize-time by
 * self-sovereign agents whose private key isn't held by the daemon.
 * Compact ECDSA `(r, vs)` over the EIP-712 typed data
 * `buildAuthorAttestationTypedData({ chainId, kav10Address,
 * merkleRoot, authorAddress: address, reservedKaId })` (#1116: the
 * attestation no longer binds `contextGraphId`). The agent verifies the
 * recovered signer matches `address` before stamping the seal.
 *
 * Lives at the agent layer (rather than as a publisher
 * `PublishOptions` field) since RFC-001 §9.x — Phase C — the
 * publisher only accepts already-sealed `precomputedAttestation`
 * payloads. Pre-signed signing is a finalize-time concern.
 */
export type PreSignedAuthorAttestation = {
  address: string;
  /** Optional caller commitment checked against the canonicalized KA before sealing. */
  expectedMerkleRoot?: Uint8Array;
  /**
   * OT-RFC-43 §F2 — the packed reservedKaId the self-sovereign author signed the
   * AuthorAttestation over `(uint160(address)<<96)|uint96(number)`. Required: the
   * digest now binds it, so the daemon must honour the author's reserved slot
   * rather than re-allocating, or the recovered signer won't match.
   */
  reservedKaId: bigint;
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

/**
 * A SWM sender-key package that landed in the "no advertised peerId"
 * branch of `createAndDistributeSwmSenderKeyEpoch` and is held for
 * delivery once we learn a peerId for the recipient agent (via
 * connection:open or a subsequent publish that re-resolves the
 * recipient set).
 *
 * Keyed in-memory by lowercased `recipientAgentAddress`. The triple
 * `(senderAgentAddress, recipientKeyId, epochId)` dedupes within an
 * agent's queue; newer epochs supersede older ones for the same
 * `(senderAgentAddress, recipientAgentAddress)` pair.
 */
export type PendingSenderKeyEntry = {
  /** Lower-cased EIP-55 sender agent address. */
  senderAgentAddress: string;
  /** Lower-cased EIP-55 recipient agent address (matches the map key). */
  recipientAgentAddress: string;
  recipientKeyId: string;
  epochId: string;
  contextGraphId: string;
  subGraphName?: string;
  /**
   * Canonical encoded `SwmSenderKeyPackageMsg` wire bytes — exactly
   * what gets passed to `messenger.sendReliable(peerId, PROTOCOL_SWM_
   * SENDER_KEY, ...)` when the recipient becomes reachable.
   */
  packageBytes: Uint8Array;
  /** Stable Messenger id for the current explicit retry chain. Rotated after delivered non-acceptance. */
  messageId?: string;
  /** Wall-clock when the row was enqueued; used for diagnostics + future TTL. */
  createdAtMs: number;
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
  authPurpose?: string;
  authSelector?: string;
  /**
   * Additive unsigned response-shaping capability. The authenticated legacy
   * `limit` remains capped at 500; upgraded responders may honor this hint only
   * under their own hard row/byte caps. Kept in lockstep with request-build.ts.
   */
  pageMode?: 'byte-budget-v1';
  pageRowsHint?: number;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  syncSessionId?: string;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
  /**
   * Phase C — optional, UNSIGNED delta-sync hint (decimal `uint256` string).
   * When set, the responder returns only KAs whose KC `dkg:batchId` is
   * strictly greater than this. Outside `computeSyncDigest` (narrowing-only,
   * like `phase`/`snapshotRef`), so it's additive and backward-compatible.
   */
  sinceBatchId?: string;
  /** Additive exact-KA response filter; present-but-invalid parses fail closed. */
  assetUals?: string[];
  /**
   * R9 (SECURITY) — UNSIGNED member-recovery marker. When set, the responder
   * authorizes via the strict members-only `isMemberRecoveryAuthorized`
   * hard-deny gate (a FRESH `_meta` agent-gate read) and MUST NOT fall through
   * to the weaker participant/peer fallback. Unsigned because it only ever
   * ESCALATES strictness (an attacker setting it faces the harder gate;
   * stripping it reverts to the normal path the member already passes), and the
   * responder decides on the cryptographically RECOVERED signer — never on this
   * flag or the (forgeable) `requesterAgentAddress` claim. Kept in lockstep with
   * the duplicate `SyncRequestEnvelope` in `sync/auth/request-build.ts`.
   */
  recovery?: boolean;
}

export type AssertionArtifactKind = 'source' | 'markdown' | 'original';

export interface ImportedArtifactByteStore {
  stat(hash: string): Promise<{ size: number } | null>;
  readRange(hash: string, offset: number, length: number): Promise<Uint8Array | Buffer | null>;
  has?(hash: string): Promise<boolean>;
  get?(hash: string): Promise<Uint8Array | Buffer | null>;
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

/**
 * Thrown by `acceptSwmSenderKeyPackage` when an inbound sender-key
 * setup package is targeted at a `recipientKeyId` we don't host as an
 * active local X25519 private key. This is the routine, benign outcome
 * when a sender fans the bootstrap out across every cached snapshot of
 * our agent's public encryption keys (e.g. registry observations from
 * before a rotation): one bootstrap per stale fingerprint lands here,
 * only the bootstrap that targets the currently active key passes.
 *
 * Distinct from a generic `Error` so the receive handler can route this
 * outcome to DEBUG (silenced from `daemon.log`) while leaving genuine
 * security/protocol failures (signature mismatch, gate violation,
 * non-local recipient, revoked-key targeting) at WARN. See PR
 * `chore/swm-sender-key-stale-noise` for the operator-noise context.
 *
 * The thrown message is preserved verbatim from the original WARN so
 * any external log scrapers that grepped for the legacy string keep
 * matching: `No local X25519 private key for DKG agent <addr> key <id>`.
 */
export class StaleSenderKeyTargetError extends Error {
  readonly code = 'StaleSenderKeyTarget';
  readonly recipientAgentAddress: string;
  readonly recipientKeyId: string;
  constructor(recipientAgentAddress: string, recipientKeyId: string) {
    super(`No local X25519 private key for DKG agent ${recipientAgentAddress} key ${recipientKeyId}`);
    this.name = 'StaleSenderKeyTargetError';
    this.recipientAgentAddress = recipientAgentAddress;
    this.recipientKeyId = recipientKeyId;
  }
}

/**
 * Thrown internally while setting up / distributing an SWM sender-key
 * epoch when a recipient rejects the package. Carries the wire-level
 * `reasonCode` so the caller can decide whether the rejection is
 * retryable.
 */
export class SwmSenderKeySetupRejectionError extends Error {
  readonly reasonCode: SwmSenderKeyPackageAckReasonCode;

  constructor(reasonCode: SwmSenderKeyPackageAckReasonCode, message: string) {
    super(message);
    this.name = 'SwmSenderKeySetupRejectionError';
    this.reasonCode = reasonCode;
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
  /** Optional on-chain publish lifetime override in epochs. */
  publishEpochs?: number;
  /** Optional known numeric on-chain context graph id for direct publish callers. */
  onChainContextGraphId?: string;
  /** RFC-001 §4 per-publish attribution override; `0n` = mode d. */
  publisherNodeIdentityIdOverride?: bigint;
}

export interface PublishAsyncOpts extends PublishOpts {
  /** @deprecated Raw-root lifts were removed; async publish always creates one KA. */
  namespace?: never;
  /** @deprecated Raw-root lifts were removed; async publish always creates one KA. */
  scope?: never;
  /** @deprecated Use the named KA mutation API for updates or revocation. */
  transitionType?: never;
  /** @deprecated Authorship is carried by the canonical KA seal. */
  authority?: never;
  /** @deprecated Use the named KA mutation API for updates. */
  priorVersion?: never;
  /** V10 selective-disclosure: per-entity kaRoot instead of flat-hash KC. */
  entityProofs?: boolean;
  localOnly?: boolean;
  /** Registered local agent whose key signs the seal. Mirrors sync `assertionFinalize`. */
  authorAgentAddress?: string;
  /** Externally pre-signed seal. Mutually exclusive with `authorAgentAddress` / `authorSignTypedData`. */
  preSignedAuthorAttestation?: {
    expectedMerkleRoot: Uint8Array;
    authorAddress: string;
    signature: { r: Uint8Array; vs: Uint8Array };
    schemeVersion: number;
    /**
     * OT-RFC-43 §F2 — the packed reservedKaId `(uint160(author) << 96) | number`
     * the caller signed into the AuthorAttestation digest. Bound into the async
     * lift seal so the deferred-broadcast mint reuses the exact attested id (the
     * digest commits to it, so it cannot be re-derived server-side).
     */
    reservedKaId: bigint;
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
    /**
     * DKG node-release string the remote peer advertised via libp2p's
     * `identify`. DKG nodes from rc.11+ set this to `dkg/<semver>` —
     * see `DKGNodeConfig.nodeVersion`. Pre-rc.11 peers fall through to
     * libp2p's default (`js-libp2p/<version>`), which is itself a
     * useful "peer hasn't adopted the version-advertisement convention
     * yet" signal. `null` when identify hasn't completed (cold cache,
     * never dialed).
     *
     * Sourced from libp2p's `Peer.metadata.AgentVersion` (their wire
     * name); renamed here because in the DKG context "agent" already
     * means `DKGAgent`.
     */
    nodeVersion: string | null;
    /**
     * libp2p protocol-version string from `identify` (`ProtocolVersion`
     * on the wire). Default `ipfs/0.1.0`. Unrelated to DKG protocol
     * versions — kept under its libp2p name because that's what it is.
     * `null` when identify hasn't completed.
     */
    protocolVersion: string | null;
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
   * substrate traffic (SWM, access, future protocols) is visible to
   * operator diagnostics. Raw sync catch-up state lives in
   * `syncStatus` because sync is no longer on the substrate.
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
  /** Convenience flag — peer speaks `PROTOCOL_SYNC`. */
  syncCapable: boolean;
  /**
   * Raw sync catch-up health. Sync no longer lives on the messenger
   * substrate, so stuck catch-up is exposed here instead of in
   * `outbox.byProtocol`.
   */
  syncStatus: {
    capable: boolean;
    capability: 'supported' | 'unsupported' | 'unknown';
    lastSuccessfulSyncAt: number | null;
    stale: boolean;
    backoff: {
      failures: number;
      nextRetryAt: number;
      retryInMs: number;
    } | null;
  };
}

/**
 * Per-peer sync-reconciler backoff state. `failures` is the count of
 * consecutive reconciler attempts that did NOT produce a successful sync;
 * `nextRetryAt` is the epoch-ms before which the reconciler skips this peer.
 * Reset on a successful sync (`onPeerSynced`) and on `connection:close`.
 * See `SYNC_BACKOFF_BASE_MS`.
 */
export type SyncReconcilerBackoff = {
  failures: number;
  nextRetryAt: number;
  protocolsKey?: string | null;
  connectionKey?: string | null;
};

/**
 * Snapshot of a peer's reachability signals (advertised protocols +
 * connection identity) used to decide whether a backed-off peer is worth
 * re-probing before `nextRetryAt`.
 */
export type SyncReconcilerProbe = {
  protocolsKey: string | null;
  connectionKey: string | null;
};

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

/**
 * Lifetime of an edge node's active Context Graph synchronization intent.
 *
 * `on-demand` remains active only for the current process. `always-on` is
 * restart-durable through the configured subscription store. Persisted rows
 * written before this distinction existed are therefore implicitly
 * `always-on` for backward compatibility.
 */
export type ContextGraphSyncMode = 'on-demand' | 'always-on';

/** Tracks the subscription and sync state of a context graph. */
export interface ContextGraphSub {
  name?: string;
  /** Requested synchronization lifetime, normalized before entering live state. */
  syncMode: ContextGraphSyncMode;
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
  /**
   * OT-RFC-38 / LU-6 Phase B — curator-committed wire identifier.
   * `keccak256(bytes(cleartextId))` lowercase hex (0x-prefixed). Used as
   * the SWM gossip topic key, envelope `contextGraphId`, signing-payload
   * id, and host-mode store key — privacy-preserving (cleartext never
   * leaves the local node) and chain-derivable (cores hosting CGs they
   * didn't create or join read it from the `ContextGraphCreated.nameHash`
   * event topic).
   *
   * For CGs the local node CREATED, this is set at create-time before
   * the chain call (the agent commits to the hash and passes it as the
   * `nameHash` param so the create transaction emits a consistent value
   * — failure to do this opens a curator/host topic mismatch where
   * members publish on topic-A and cores host on topic-B).
   *
   * For CGs the local node JOINED via curator invite, this is populated
   * when the join-approved payload arrives. For CGs the local node
   * HOSTS (core, not a member), this is set by the chain-event handler
   * and IS the local id (the cleartext is never known).
   *
   * Undefined for pre-Phase-B CGs (legacy path; cleartext is still the
   * wire form for those — they pre-date the contract change).
   */
  onChainHash?: string;
  /**
   * Phase B (chain-driven VM reconciliation) — the per-CG
   * registration-ordinal watermark: the count of KAs registered to this CG
   * on-chain that the node has promoted to VM *contiguously* (no gaps). The
   * reconcile sweep resumes from this ordinal and walks up to the on-chain
   * `getContextGraphKCCount(cgId)`. Persisted (survives restarts); `undefined`
   * means "never reconciled" and the sweep starts at 0. Advanced only behind
   * the confirmation-depth gate so a reorg can't strand the watermark ahead
   * of canonical chain state.
   */
  lastReconciledOrdinal?: number;
  /**
   * Phase D (Cores fill their own gaps) — set on a Core when it signs a
   * StorageACK for a *public* CG, marking the CG as one this node hosts. The
   * chain-driven VM reconciler (sweep + KACG nudge) runs for hosted CGs even
   * without a member subscription, so a Core that was offline during a publish
   * learns about the missed KA from chain on restart and pulls it from another
   * Core. Persisted (survives restart — the whole point). Only ever set for
   * public CGs: curated/ciphertext host-mode coverage stays on the host-mode
   * reconciler + chunk-backfill path (Cores can't promote plaintext to VM).
   */
  coreHosted?: boolean;
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

/**
 * Mutation input normalized at the one live-subscription state boundary.
 *
 * Callers that predate explicit lifetimes remain compatible; live state never
 * observes the optional form because the mutation boundary inherits the
 * previous mode or applies the restart-durable legacy default.
 */
export type ContextGraphSubInput = Omit<ContextGraphSub, 'syncMode'> & {
  syncMode?: ContextGraphSyncMode;
};

/**
 * Metadata that passive discovery is allowed to contribute to the local
 * Context Graph catalogue.
 *
 * Discovery deliberately cannot choose membership, sync, hosting, or VM
 * reconciliation state. Those transitions belong to explicit edge intent or
 * to the temporary core compatibility activation performed by DKGAgent after
 * recording a newly discovered graph (remove with host-mode separation #1611).
 */
export interface ContextGraphDiscoveryMetadata {
  name?: string;
  onChainId?: string;
  onChainHash?: string;
  participantAgents?: string[];
}

export interface ContextGraphDiscoveryOptions {
  /**
   * Whether a newly discovered core subscription joins the ordinary catch-up
   * scope. Chain registry discovery historically installed gossip handlers
   * without joining that scope, so its caller passes false.
   */
  trackSyncScope?: boolean;
}

export interface ContextGraphSubscriptionRecord {
  id: string;
  name?: string;
  subscribed: boolean;
  synced: boolean;
  sharedMemorySynced?: boolean;
  metaSynced?: boolean;
  onChainId?: string;
  /**
   * OT-RFC-38 / LU-6 Phase B — persisted wire-id commitment. Persisted
   * so cores recovering from a restart can resume host-mode subscription
   * on the correct topic without needing a new chain-event read.
   */
  onChainHash?: string;
  /** Phase B — persisted per-CG registration-ordinal VM watermark (see ContextGraphSub). */
  lastReconciledOrdinal?: number;
  /** Phase D — persisted "this Core hosts a public CG" flag (see ContextGraphSub). */
  coreHosted?: boolean;
  syncScoped: boolean;
}

export interface ContextGraphSubscriptionStore {
  loadAll(): Promise<ContextGraphSubscriptionRecord[]>;
  load?(contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null>;
  save(record: ContextGraphSubscriptionRecord): Promise<void>;
  delete(contextGraphId: string): Promise<void>;
  loadVmReconcileNegative?(cacheKey: string): Promise<VmReconcileNegativeRecord | null>;
  saveVmReconcileNegative?(record: VmReconcileNegativeRecord): Promise<void>;
  deleteVmReconcileNegative?(cacheKey: string): Promise<void>;
  deleteVmReconcileNegativesForContextGraph?(contextGraphId: string): Promise<void>;
}

/** Restart-durable, generation-gated record of one authoritative no-match scan. */
export interface VmReconcileNegativeRecord {
  cacheKey: string;
  localCgId: string;
  failures: number;
  nextRetryAt: number;
  swmGen: string;
  candidateNamespaces: Array<{ metaGraph: string; dataGraph: string }>;
  peerTopologyKey: string;
}

/** Process-local evidence for one chain-ordinal exact-recovery rotation. */
export interface VmReconcileRotationRecord {
  localCgId: string;
  onChainCgId: string;
  ordinal: number;
  fingerprint: string;
  phase: 'collecting' | 'backoff';
  /** Retry suppression is distinct from authenticated clean-absence proof. */
  backoffKind?: 'clean-absence' | 'incomplete-cycle';
  candidatePeerIds: Set<string>;
  /** Peers physically attempted during the current proof cycle. */
  attemptedPeerIds: Set<string>;
  cleanAbsentPeerIds: Set<string>;
  /**
   * A process-local curator lookup completed (or its bounded cached roster was
   * reused). This is not cryptographic or network-wide completeness evidence;
   * observed roster changes invalidate the cycle and backoff is time-bounded.
   */
  curatorRosterConfirmed: boolean;
  /** Monotonic bound after which a partial clean-absence proof restarts. */
  collectionDeadlineAt: number;
  /** Cursor only; every physical attempt advances it, regardless of outcome. */
  lastAttemptedPeerId?: string;
  failures: number;
  nextRetryAt: number;
}

export interface ContextGraphSubscriptionRehydrationStatus {
  /** Non-system persisted rows governed by the rehydration cap. */
  persistedTotal: number;
  /** Persisted system rows seen during rehydration; excluded from cap math. */
  systemExcluded: number;
  hostedActivated: number;
  hostedActivatedIds: string[];
  activated: number;
  dormant: number;
  activationCap: number;
  capDisabled: boolean;
  dormantIds: string[];
  /** Startup rehydration completion timestamp; remains stable after boot. */
  completedAt: number;
  /** Most recent timestamp for post-boot diagnostic count/id updates. */
  updatedAt: number;
}

export interface ContextGraphWritePreflightProbe {
  /**
   * Explicit, REQUIRED store-availability discriminant. `true` when every
   * store-backed read the probe issued answered, `false` when at least one
   * failed (slow-store abort timeout, "the store is closed" after an Oxigraph
   * worker crash, …). This is the typed boundary consumers MUST check before
   * trusting any store-derived fact below: with `storeAvailable === false`,
   * `exists` / `hasLocalContent` / `declarationFound` / `accessPolicy` /
   * `callerAuthorized` are NOT definitive — a failed read leaves them
   * `undefined` (UNKNOWN), which must never be misread as a "does not exist"
   * deny. Making this required (not just the optional `storeUnavailable`
   * flag) means the type stops a consumer from reading `exists` as a plain
   * boolean without first establishing the store was up. Logical inverse of
   * `storeUnavailable` — kept alongside it so the 503-diagnostics path (which
   * greps `storeUnavailable === true` + `storeErrorMessage`) is unchanged.
   */
  storeAvailable: boolean;
  /**
   * Store-derived facts are tri-state: `true`/`false` when the local store
   * answered (`storeAvailable === true`), `undefined` when the backing read
   * failed. Only trust these when `storeAvailable` is `true`.
   */
  exists?: boolean;
  hasLocalContent?: boolean;
  inMemorySubscription?: Pick<ContextGraphSub, 'subscribed' | 'synced'>;
  persistedSubscription?: Pick<ContextGraphSubscriptionRecord, 'subscribed' | 'synced'>;
  declarationFound?: boolean;
  accessPolicy?: 'public' | 'private';
  curator?: string;
  callerAuthorized?: boolean;
  /**
   * True when at least one local-store read failed (slow-store abort
   * timeout, "the store is closed" after an Oxigraph worker crash, …) —
   * the inverse of `storeAvailable`. The probe still carries the zero-I/O
   * in-memory subscription snapshot above, so the daemon's write preflight
   * can rescue an id it ALREADY tracks instead of 503ing every write until
   * the store recovers. The store-derived fields whose reads failed are left
   * `undefined`. Retained for the 503-diagnostics grep alongside
   * `storeErrorMessage`.
   */
  storeUnavailable?: boolean;
  /** First store-read failure message, retained for 503 diagnostics. */
  storeErrorMessage?: string;
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
  /**
   * Load persisted membership facts for restart recovery. Optional so custom
   * stores written before membership rehydration remain source-compatible.
   */
  loadAll?(): Promise<Array<ContextGraphMembershipRecord & {
    firstSeenAt?: number;
    updatedAt: number;
  }>>;
  upsert(record: ContextGraphMembershipRecord & { firstSeenAt?: number; updatedAt: number }): Promise<void>;
  delete(contextGraphId: string, principalType: ContextGraphMemberPrincipalType, principalId: string): Promise<void>;
}

/**
 * Curator-controlled admission policy for a single private context graph.
 *
 * `manual` is the fail-closed default. `open` means that a valid incoming
 * join request may be admitted without a human click, subject to the owner,
 * privacy, revocation, encryption-key, capacity, and rate checks enforced by
 * the agent at decision time.
 */
export type ContextGraphJoinPolicyMode = CoreContextGraphJoinPolicyMode;
export type ContextGraphJoinPolicyRecord = CoreContextGraphJoinPolicyRecord;

export type ContextGraphJoinPolicyAuditEventType =
  | 'join_policy_changed'
  | 'join_auto_reservation'
  | 'join_auto_decision'
  | 'join_admission_committed'
  | 'join_admission_throttled'
  | 'join_admission_failed';

export interface ContextGraphJoinPolicyAuditEvent {
  timestamp: number;
  contextGraphId: string;
  eventType: ContextGraphJoinPolicyAuditEventType;
  actor?: string;
  agentAddress?: string;
  outcome: string;
  reason?: string;
  /** SHA-256 digest of the signed request; the raw signature is never logged. */
  requestDigest?: string;
  policyVersion?: number;
  details?: Record<string, unknown>;
}

export interface ContextGraphJoinPolicyRateReservation {
  allowed: boolean;
  contextGraphApprovalsLastHour: number;
  nodeApprovalsLastHour: number;
  reason?: 'context-graph-rate-limit' | 'node-rate-limit';
}

/**
 * Durable policy + audit adapter. Production backs this with node-ui.db.
 * The rate reservation must atomically count and, when allowed, append the
 * reservation row so concurrent admissions cannot overrun either ceiling.
 */
export interface ContextGraphJoinPolicyStore {
  load(contextGraphId: string): Promise<ContextGraphJoinPolicyRecord | null>;
  save(record: ContextGraphJoinPolicyRecord): Promise<void>;
  appendAudit(event: ContextGraphJoinPolicyAuditEvent): Promise<void>;
  /** Atomically persist a policy transition and its security audit event. */
  saveWithAudit(
    record: ContextGraphJoinPolicyRecord,
    event: ContextGraphJoinPolicyAuditEvent,
  ): Promise<void>;
  getAutomaticApprovalUsage(
    contextGraphId: string,
    timestamp: number,
  ): Promise<{
    contextGraphApprovalsLastHour: number;
    nodeApprovalsLastHour: number;
  }>;
  reserveAutomaticApproval(input: {
    contextGraphId: string;
    timestamp: number;
    contextGraphLimit: number;
    nodeLimit: number;
    actor: string;
    agentAddress: string;
    requestDigest: string;
    policyVersion: number;
    /** Monotonic generation of the exact policy that authorized this request. */
    policyEpoch: number;
  }): Promise<ContextGraphJoinPolicyRateReservation>;
  /**
   * Durably mark the exact reservation before crossing the membership
   * mutation boundary. This distinguishes an admission repair from an unused
   * or abandoned rate-limit reservation after a daemon restart.
   */
  markAutomaticApprovalRepairPending(input: {
    contextGraphId: string;
    requestDigest: string;
    policyEpoch: number;
  }): Promise<boolean>;
  /** Load an unfinished post-mutation repair without relying on delegation validity. */
  getAutomaticApprovalRepair(
    contextGraphId: string,
    requestDigest: string,
  ): Promise<{
    policyEpoch: number;
    actor: string;
    agentAddress: string;
  } | null>;
  /**
   * Idempotently record the durable admission authorized by the exact policy
   * snapshot that reserved it. Returns false when no matching reservation
   * exists; callers must never infer recency from wall-clock timestamps.
   */
  commitAutomaticApproval(input: {
    contextGraphId: string;
    timestamp: number;
    actor: string;
    agentAddress: string;
    requestDigest: string;
    policyEpoch: number;
    details?: Record<string, unknown>;
  }): Promise<boolean>;
}

// ── Sync diagnostics ────────────────────────────────────────────────

export interface DurableSyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  /** Cryptographically verified V2 responses whose public graph is intentionally empty. */
  verifiedPrivateOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures?: number;
  /** Context Graph admissions deferred by local scheduler pressure. */
  deferredBackpressure?: number;
}

/**
 * ONE peer's public-SWM snapshot coverage for ONE round, and the ONLY shape in
 * which that coverage travels.
 *
 * **Reduced whole or not at all.** Numerator and denominator are never reduced
 * independently: an independent `max` over ready and total combines peers
 * reporting `178/250` and `200/200` into `200/250` — a state no peer reported,
 * attributed to a peer that never said it, alongside a missing sample drawn
 * from a third inventory. Every reducer therefore picks one record and keeps it
 * intact; `selectSwmSnapshotCoverage` in `sync/requester/shared-memory-sync.ts`
 * is that reducer, and it is the only one.
 */
export interface SwmSnapshotCoverage {
  /**
   * The Context Graph this coverage describes. Required, because the reduction
   * runs INSIDE the `contextGraphIds` loop: on a multi-CG call exactly one
   * graph's record survives, and without this field no consumer can tell which
   * graph the surviving counts belong to.
   */
  contextGraphId: string;
  /** Last 8 chars of the peer id this whole record came from. */
  peerIdSuffix: string;
  /**
   * Snapshot refs whose Knowledge Assets are MATERIALIZED — written and locally
   * visible — either already present before this round or made visible by it.
   *
   * Not "fetched". A ref sitting valid in the blob cache whose write failed does
   * NOT count here, and that is deliberate: the capability gate reads this field
   * to decide whether a peer still owes us anything, and a round that cached
   * every ref while writing none would otherwise report `N/N`, drop the peer as
   * satisfied, and disable the retry loop in exactly the failure class it exists
   * for.
   */
  snapshotsResolved: number;
  /** Snapshot refs declared by this peer's verified SWM metadata. */
  snapshotsTotal: number;
  /**
   * The peer's SWM metadata phase paged to completion, so `snapshotsTotal` is
   * its full manifest rather than a truncated prefix. False means the
   * denominator is a lower bound.
   */
  manifestComplete: boolean;
  /**
   * Refs NOT materialized: `snapshotsTotal - snapshotsResolved`, by
   * construction, so `resolved + missing === total` always holds.
   *
   * Covers both causes at once — never fetched, and fetched-but-unwritten. It is
   * NOT a retrieval-only count, and it must never be added to
   * `materializationFailures`; every unwritten ref is already in here.
   */
  missingCount: number;
  /**
   * Bounded identifiers for the shortfall — a public peer controls manifest
   * size, so this is a sample, never the full inventory. Always drawn from the
   * same round as the counts above, and deduplicated, so it can never exceed
   * `missingCount`.
   */
  missingSample: string[];
  /**
   * Descriptor writes that FAILED after their snapshot fetched and
   * digest-verified — a store error inside the KA write lock, the failure class
   * the G7 repair exists for, likeliest under the same store pressure that
   * produces incomplete rounds.
   *
   * A CAUSE indicator for `missingCount`, not a second disjoint count. Those
   * refs are already counted as missing; this field says the shortfall is a
   * store problem rather than a network one, which is what sends an operator to
   * the right place.
   *
   * Note the unit: this counts failing DESCRIPTORS while `missingCount` counts
   * REFS, and one ref can carry several descriptors. Neither is a subset count
   * of the other, so never render them as "N of which K".
   *
   * `materializationFailures > 0` with `missingCount === 0` is unrepresentable:
   * a ref with a failing descriptor is excluded from the materialized set, which
   * forces `resolved < total`. A fixture asserting that pair is testing a state
   * the producer cannot emit.
   */
  materializationFailures: number;
  /**
   * This round came from the metadata-resolved curator. Set only by the
   * catch-up walk, which knows peer roles; the agent-side sync does not.
   */
  fromAuthority?: boolean;
}

export interface SharedMemorySyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  bytesReceived: number;
  resumedPhases: number;
  timedOutPhases: number;
  completedPhases: number;
  checkpointAdvances: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
  failedPhases: number;
  backoffWorthyFailures?: number;
  /** Context Graph admissions deferred by local scheduler pressure. */
  deferredBackpressure?: number;
  /** Coverage for the graph this round touched; see {@link SwmSnapshotCoverage}. */
  swmCoverage?: SwmSnapshotCoverage;
  /**
   * Snapshot phases that stopped on the local clock with unfetched refs
   * remaining — a VOLUNTARY yield, not a peer fault. Deliberately distinct from
   * `timedOutPhases`, which marks the round backoff-worthy
   * (`durable-progress.ts` `backoffWorthyFailure`) and would put a healthy peer
   * into backoff for our own budget decision.
   */
  snapshotPlaneIncomplete?: number;
  /** Extra catch-up passes spent over the peer set beyond the first. */
  continuationPasses?: number;
  /**
   * Why the bounded repeat stopped. Typed as the policy's own closed union
   * rather than `string`, so a new stop reason cannot reach the terminal message
   * unnoticed — the terminal text renders this, and an unhandled reason there
   * would read as a missing explanation rather than as a new state.
   */
  continuationStopReason?: CatchupPassDecisionReason;
  /**
   * The REPLAY half of `bytesReceived`: the metadata and aggregate-data phases,
   * which a repeated pass re-fetches in full. Named for the plan's single
   * "metadata/aggregate replay" bucket — it spans BOTH phases, not just meta.
   *
   * Split out because `bytesReceived` merges replay and useful bytes into one
   * scalar, which makes the accepted cost of repeating the peer walk
   * unmeasurable in bytes — exactly the quantity the efficiency gate exists to
   * bound. `replayPhaseBytesReceived + snapshotPhaseBytesReceived === bytesReceived`.
   */
  replayPhaseBytesReceived?: number;
  /** The USEFUL half of `bytesReceived`: immutable snapshot content. */
  snapshotPhaseBytesReceived?: number;
}

export interface CatchupSyncDiagnostics {
  noProtocolPeers: number;
  durable: DurableSyncDiagnostics;
  sharedMemory: SharedMemorySyncDiagnostics;
}

export interface DurableSyncResult extends DurableSyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
  /**
   * True only when every requested Context Graph reached a verified terminal
   * state in this invocation. Committed prefixes remain observable through the
   * counters while this stays false, so callers never have to infer whole-run
   * completeness from per-phase progress.
   */
  complete: boolean;
}

export interface SharedMemorySyncResult extends SharedMemorySyncDiagnostics {
  insertedTriples: number;
  deniedPhases: number;
}

// ── DKGAgent configuration ──────────────────────────────────────────

/**
 * Phase E/F — a single chain-driven VM reconciliation telemetry event. Emitted
 * by the agent at reconcile decision points; consumed by the structured logger
 * (Phase E) and the ops metrics recorder (Phase F).
 */
export interface ReplicationEvent {
  /** Epoch millis the event was emitted. */
  ts: number;
  /** Local CG id (topic/name), the key used everywhere in the agent. */
  contextGraphId: string;
  /** On-chain numeric CG id (stringified), when known. */
  onChainCgId?: string;
  /**
   * Decision point:
   *  - `sweep`          — one reconcile pass summary for a CG.
   *  - `fetch`          — active core-first catch-up fetch kicked off (no local SWM).
   *  - `promote`        — a KC was promoted to VM this pass.
   *  - `already`        — a KC was already in VM (idempotent).
   *  - `defer`          — an ordinal couldn't be reconciled yet (retry next sweep).
   *  - `cursor-advance` — the persisted watermark moved.
   *  - `core-fill`      — (Phase D) a Core ingested a hosted batch from another Core.
   */
  action: 'sweep' | 'fetch' | 'promote' | 'already' | 'defer' | 'cursor-advance' | 'core-fill';
  ual?: string;
  ordinal?: number;
  kaId?: string;
  /** Watermark before/after, for `cursor-advance`. */
  fromWatermark?: number;
  toWatermark?: number;
  /** Chain-head ordinal at the time of the event. */
  head?: number;
  /** Reconciled / pending counts, for `sweep`. */
  reconciled?: number;
  pending?: number;
  /** Free-form detail (error message, peer order summary, …). */
  detail?: string;
}

export type ReplicationEventSink = (event: ReplicationEvent) => void;

export interface Rfc64CatalogAccessPolicyAuthorityConfigV1 {
  readonly localAgentAddress: EvmAddressV1;
  /** Exact authenticated libp2p-peer to agent-wallet binding. */
  readonly resolveRemoteAgentAddress: (
    remotePeerId: string,
  ) => Promise<EvmAddressV1 | null>;
}

/**
 * Opt-in RFC-64 author-catalog production for ordinary confirmed public KA
 * publishes. Peer fan-out is an availability hint; the durable applied-head
 * pointer remains the correctness source for pull discovery.
 */
export interface Rfc64PublicCatalogAutoPublishConfigV1 {
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt?: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

export interface Rfc64PublicCatalogBootstrapScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
}

export interface Rfc64PublicCatalogBootstrapTargetV1 {
  readonly authorAddress: EvmAddressV1;
  /** Ordered provider failover candidates for this exact author catalog. */
  readonly providers: readonly string[];
}

export interface Rfc64PublicCatalogBootstrapPolicyV1 {
  /** Exact verified control object; its digest is recomputed during snapshotting. */
  readonly policyEnvelope: UnsignedContextGraphPolicyEnvelopeV1;
  /** Author catalogs under the policy graph/era. */
  readonly targets: readonly Rfc64PublicCatalogBootstrapTargetV1[];
}

/**
 * Explicit V1 cold-start manifest. Policies are operator-pinned outputs of an
 * independent finality/administrative verifier; the catalog lane only consumes
 * them. A zero retry interval performs one startup pass, which is useful for
 * deterministic harnesses. Omission defaults to a 30-second refresh pass.
 */
export interface Rfc64PublicCatalogBootstrapConfigV1 {
  readonly acceptedPublicPolicies: readonly Rfc64PublicCatalogBootstrapPolicyV1[];
  readonly retryIntervalMs?: number;
}

export interface DKGAgentConfig {
  name: string;
  /** Selected genesis document. Defaults to the compatibility Base testnet genesis. */
  genesisId?: string;
  /** Active network identity used to isolate libp2p and app workflow boundaries. */
  networkIdentity?: DkgNetworkIdentity;
  /**
   * Locally trusted RFC-64 catalog-seal deployment tuple. This deterministic
   * override is intended for chain-free devnets; production nodes normally
   * derive the same tuple from their configured chain adapter. It is snapshotted
   * and validated during `DKGAgent.create()` and is never accepted from catalog
   * announcement wire data.
   */
  rfc64CatalogDeploymentProfile?: CatalogSealDeploymentProfileV1;
  /**
   * Explicit agent-identity authority required before accepting a private
   * RFC-64 catalog policy. Omission preserves the legacy open-only lane.
   */
  rfc64CatalogAccessPolicyAuthority?: Rfc64CatalogAccessPolicyAuthorityConfigV1;
  /**
   * Canonical selected-public activation resolved through the versioned,
   * side-effect-free activation surface. Mutually exclusive with the legacy
   * deployment, auto-publish, and bootstrap controls; the accepted manifest
   * is its only CG set.
   */
  rfc64PublicCatalogActivation?: Rfc64PublicCatalogActivationInputV1;
  /**
   * Legacy all-accepted-public-CG producer configuration. Omission preserves
   * existing publication behavior. New daemons should use the unified
   * selected-public activation above.
   */
  rfc64PublicCatalogAutoPublish?: Rfc64PublicCatalogAutoPublishConfigV1;
  /** Omission preserves manual RFC-64 current-head discovery. */
  rfc64PublicCatalogBootstrap?: Rfc64PublicCatalogBootstrapConfigV1;
  /**
   * public-projection enable flag. When set, a private CG's confirmed VM
   * publishes emit/refresh a verifiable public projection (the floor: existence,
   * UAL, access class, committed root) into the SOURCE CG's OWN `_catalog` graph
   * (`<source-cg>/_catalog`) — the exact named graph open-serve reads — binding
   * the private CG into the public discovery surface without disclosing its
   * contents. NB despite the name the projection is NOT written into the named
   * target CG: the configured value acts only as (a) an on/off switch and (b) a
   * self-projection guard (a publish whose own CG id equals this value is
   * skipped). See `emitPublicProjectionAfterPublish` (B7/B8). Unset → off.
   */
  publicProjectionContextGraphId?: string;
  /**
   * STRICT curator-ack gate (OT-RFC-49 curator-leader), default OFF. When true,
   * a non-`localOnly` write to a PRIVATE context graph must be applied+ack'd by
   * the CG's curator (the authoritative replica) BEFORE it is committed locally;
   * if the curator does not confirm, the write is rejected (`CuratorUnconfirmedError`
   * → HTTP 503) and nothing is persisted — closing the silent same-root-update
   * loss that otherwise hides until the next reconnect REPLACE. Public CGs,
   * `localOnly` writes, and a node that IS the curator are unaffected. Phase-1
   * default-off lets the gate soak before it becomes the default. Per-call
   * `share({ awaitCuratorAck })` overrides this.
   */
  swmAwaitCuratorAck?: boolean;
  framework?: string;
  description?: string;
  listenPort?: number;
  /** IP address to listen on. Default: '0.0.0.0' (all interfaces). Use '127.0.0.1' for tests. */
  listenHost?: string;
  bootstrapPeers?: string[];
  /** Multiaddrs of relay nodes for NAT traversal. */
  relayPeers?: string[];
  /** Legacy ACK candidate allowlist. When set, unlisted connected peers are not dialed for ACKs. */
  ackCandidatePeerIds?: string[];
  /**
   * Peer IDs to rank first among ACK candidates without shrinking the pool
   * (typically the network-config relays supplied by the bundled daemon).
   *
   * The authoritative signer check is chain truth, enforced per collected ACK
   * (operational-key purpose + active sharding-table membership) and
   * re-verified on-chain by the publish tx. Hard-gating candidacy on the static
   * relay list capped the pool at the 4-6 bundled relays and made ACK quorum
   * arithmetically unreachable when those specific relays were degraded or
   * mid-upgrade (2026-07-07 Base/Gnosis mainnet incident).
   */
  preferredACKPeerIds?: string[];
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
  /** Optional caller-owned snapshot store, used by the daemon to inject durable page indexing. */
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /**
   * Max automatic-retry budget stamped onto async VM-publish jobs admitted
   * through this agent's `publishAsync` (EPCIS / Kafka plugin paths). Mirrors
   * the daemon's `publisher.maxRetries`. Nullish → the publisher's built-in
   * default; `0` disables auto-retry. (#1836)
   */
  publisherMaxRetries?: number;
  importedArtifactByteStore?: ImportedArtifactByteStore;
  /** When false, peer-connect sync skips SWM catch-up and relies on gossip for new SWM writes. */
  syncSharedMemoryOnConnect?: boolean;
  /** Emergency switch for the periodic sync reconciler. Env DKG_SYNC_RECONCILER_ENABLED wins. */
  syncReconcilerEnabled?: boolean;
  /** Emergency switch for all peer-connect sync triggers. Env DKG_SYNC_ON_CONNECT_ENABLED wins. */
  syncOnConnectEnabled?: boolean;
  /**
   * Include `agents` and `ontology` in automatic peer-connect/reconciler
   * durable sync. Defaults true on Core and false on Edge. Explicit catch-up
   * remains available. Env DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT wins.
   */
  syncSystemContextGraphsOnConnect?: boolean;
  /** Emergency switch for durable/SWM sync execution. Env DKG_DURABLE_SYNC_ENABLED wins. */
  durableSyncEnabled?: boolean;
  /**
   * #2052 Stack D system-record lane controls (plan :1436). Independent and
   * DEFAULT-OFF — note the opposite polarity to the emergency switches above,
   * which default ON. Resolve them through
   * `system-records/config-controls-v1.ts`, never by reading the raw field, so
   * the default and the env override stay in one place.
   * Env DKG_SYSTEM_RECORD_PRODUCER_TRACKING_ENABLED wins.
   */
  systemRecordProducerTrackingEnabled?: boolean;
  /** Advertise the system-record provider protocol. Default OFF. Env DKG_SYSTEM_RECORD_PROVIDER_ADVERTISEMENT_ENABLED wins. */
  systemRecordProviderAdvertisementEnabled?: boolean;
  /** Run the system-record requester lane. Default OFF. Env DKG_SYSTEM_RECORD_REQUESTER_LANE_ENABLED wins. */
  systemRecordRequesterLaneEnabled?: boolean;
  /** Let legacy sync prefer system-record-capable peers. Default OFF. Env DKG_SYSTEM_RECORD_LEGACY_CAPABLE_PEER_SELECTION_ENABLED wins. */
  systemRecordLegacyCapablePeerSelectionEnabled?: boolean;
  /**
   * Global cap for concurrent sync jobs. Defaults to 2; set 0 to disable.
   * Env DKG_SYNC_GLOBAL_MAX_INFLIGHT wins.
   */
  syncGlobalMaxInflight?: number;
  /** Backwards-compatible alias for syncGlobalMaxInflight. Env DKG_SYNC_GLOBAL_LIMIT wins. */
  syncGlobalLimit?: number;
  /** Max sync jobs waiting behind the global cap. Defaults to 2x the inflight cap. */
  syncGlobalQueueLimit?: number;
  /** Daemon-local retained responder snapshot row/estimated-byte policy. */
  syncResponderSnapshotLimits?: SyncResponderSnapshotLimitsConfig;
  /**
   * Local requester/responder priority by Context Graph ID. Higher runs first.
   * System Context Graphs default to a deprioritized priority so they run
   * last; an explicit entry here (including 0) overrides that default.
   */
  syncContextGraphPriorities?: SyncContextGraphPriorityConfig;
  /** StorageACK handler deadline override in milliseconds. Env DKG_STORAGE_ACK_HANDLER_DEADLINE_MS wins. */
  storageAckHandlerDeadlineMs?: number;
  /**
   * When false, durable sync skips the large system `agents/_meta` graph while
   * still syncing `agents` data as the phonebook. Defaults to false on every
   * node role (cores included); set true (or `DKG_SYNC_AGENTS_META=1`) to fetch
   * the full system KA/KC lifecycle metadata for the agents graph.
   */
  syncAgentsMeta?: boolean;
  /** Node deployment tier: 'core' (cloud, relay) or 'edge' (personal, behind NAT). Default: 'edge'. */
  nodeRole?: 'core' | 'edge';
  /** Local daemon logging controls forwarded from config.json. */
  logging?: {
    /** Emit detailed KA publish lifecycle logs. Default: false. */
    kaPublishLifecycleDebug?: boolean;
  };
  /**
   * OT-RFC-43 Option 1 — durable per-author KA-number allocator. When provided,
   * the publisher mints deterministic packed reservedKaIds (and reconciles the
   * per-author floor against the chain). Constructed in the daemon lifecycle on
   * the shared dashboard DB; omit for in-process tests / pre-Option-1 flows.
   */
  kaNumberAllocator?: KaNumberAllocator;
  /**
   * RFC ka-metadata-trim Phase 3 (P3.3) — daemon `metadata.provenanceEvents`
   * config, forwarded into `DKGPublisherConfig.provenanceEvents`. Default
   * `true`. When `false` ("lite mode"), the assertion-lifecycle writers skip
   * the per-transition PROV event nodes (NOT the seal/state rows); the
   * history API returns `events: []` gracefully.
   */
  metadataProvenanceEvents?: boolean;
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
   * DKG node-release identifier the underlying libp2p node advertises
   * to peers via the `identify` protocol. Forwarded straight into
   * `DKGNodeConfig.nodeVersion`. Convention `dkg/<semver>` (set by
   * `packages/cli/src/daemon/lifecycle.ts`). Surfaced back to operators
   * via `peerStore.nodeVersion` on the `PeerDiagnostics` object
   * returned by `/api/peer-info` and MCP `dkg_peer_info`. When omitted,
   * libp2p's default (`js-libp2p/<version>`) is broadcast.
   *
   * Naming note: on the wire libp2p calls this field `AgentVersion`,
   * but inside DKG that name collides with `DKGAgent`. We carry it as
   * `nodeVersion` everywhere we control, and only touch the libp2p
   * name (`Peer.metadata.AgentVersion`) at the read boundary in
   * `getPeerDiagnostics()`.
   */
  nodeVersion?: string;
  /**
   * libp2p networking tunables for small / sparse networks. All three
   * fields are optional and forwarded straight into the matching
   * `DKGNodeConfig` slots. Omitting any field preserves the upstream
   * default. See `packages/core/src/types.ts` for per-field semantics
   * and the operator-facing surface in `packages/cli/src/config.ts`
   * (`network` block).
   */
  peerStoreMaxAddressAgeMs?: number;
  peerStoreMaxPeerAgeMs?: number;
  dhtQuerySelfIntervalMs?: number;
  /**
   * Cadence at which the daemon re-publishes its own agent profile
   * (PR feat/chain-agents-cg-phonebook). Forwarded straight from
   * `DkgConfig.network.agentProfileHeartbeatMs`. Defaults to
   * `AGENT_PROFILE_HEARTBEAT_MS` (20 min) when omitted; `0` disables
   * the timer (the one-shot startup publish still fires).
   */
  agentProfileHeartbeatMs?: number;
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
  /**
   * Interval between V10 StorageACK handler registration retries when the
   * on-chain identity isn't yet resolved (e.g. a transient boot-time RPC
   * outage). Defaults to `STORAGE_ACK_REGISTRATION_RETRY_MS` (30s). Lowered in
   * tests to drive the background re-resolution path deterministically.
   */
  storageAckRegistrationRetryMs?: number;
  /**
   * Resolved StorageACK timing policy. Prefer this single object over the
   * legacy loose aliases below so the handler deadline and publisher send
   * timeout are treated as one invariant.
   */
  storageAckTiming?: StorageAckTiming;
  /**
   * @deprecated Use `storageAckTiming.handlerDeadlineMs`. Kept as a
   * compatibility alias and normalized by `DKGAgent.create`.
   */
  ackHandlerDeadlineMs?: number;
  /**
   * @deprecated Use `storageAckTiming.sendTimeoutMs`. Kept as a compatibility
   * alias and normalized by `DKGAgent.create`.
   */
  ackSendTimeoutMs?: number;
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
    rpcUrls?: string[];
    /** Public RPC URLs safe for wallet_addEthereumChain. Never use private operator RPC URLs here. */
    walletRpcUrls?: string[];
    hubAddress: string;
    /** Optional TRAC token contract override. When omitted, the adapter resolves Hub.Token. */
    tokenAddress?: string;
    adminPrivateKey?: string;
    operationalKeys: string[];
    chainId?: string;
    /** Overall submitted-transaction receipt deadline (default 10 minutes). */
    receiptTimeoutMs?: number;
    /**
     * Optional V10 allowance-sizing policy. Threaded straight through to
     * the `EVMChainAdapter`; see `ApprovalPolicy` in
     * `@origintrail-official/dkg-chain`. Omit to inherit the default
     * (`'per-publish'`, bounded-per-publish with on-chain 1n floor).
     */
    approvalPolicy?: ApprovalPolicy;
    /** Optional ContextGraphNameRegistry `eth_getLogs` block-window tuning. */
    cgRegistryScanPageSize?: number;
    /**
     * Funding floors (wei) for funding-aware operational-wallet selection,
     * threaded straight to `EVMAdapterConfig.minPublisher*Wei`. Both default to
     * `0n` (only strictly-empty wallets are skipped); a wallet below the floor is
     * deprioritized, not excluded (best-funded fallback still sends).
     */
    minPublisherNativeWei?: bigint;
    minPublisherTracWei?: bigint;
  };
  /** Cross-agent query access configuration. */
  queryAccess?: QueryAccessConfig;
  /** User-selected context graph IDs to sync automatically on peer connect. */
  syncContextGraphs?: string[];
  /** TTL for shared memory data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  sharedMemoryTtlMs?: number;
  /**
   * OT-RFC-38 LU-6 — settings for the core-side host-mode SWM store.
   * Only honoured when `nodeRole === 'core'`. Omit on edges (the
   * store is never initialized there).
   *
   * Fields:
   *  - `enabled`: when `false`, cores skip host-mode entirely and behave like edges. Default `true` for cores.
   *  - `unregistered`: TTL/byte-cap for CGs the core knows about but that aren't on-chain registered yet.
   *  - `registered`: TTL/byte-cap for on-chain registered CGs (typically larger).
   *  - `pruneIntervalMs`: how often the TTL/cap sweep runs.
   *  - `reconcileIntervalMs`: how often the host-mode subscription reconciler ensures cores are subscribed to all known curated CGs.
   *  - `reconcileBatchSize`: max known CGs reconciled per tick. Default 32.
   *  - `reconcileJitterRatio`: startup interval jitter ratio in [0, 1]. Default 0.15.
   */
  swmHostMode?: {
    enabled?: boolean;
    unregistered?: SwmHostModeStoreLimits;
    registered?: SwmHostModeStoreLimits;
    pruneIntervalMs?: number;
    reconcileIntervalMs?: number;
    reconcileBatchSize?: number;
    reconcileJitterRatio?: number;
    /**
     * OT-RFC-38 / LU-6 Phase B — discovery-beacon rate limits for
     * pre-registration (freemium-tier) ciphertext writes. All three
     * fields are optional; omit any to use the default from
     * {@link DiscoveryRateLimit}.
     *  - `perCuratorBytesPerMinute` — SPEC §1.2.4 default 1 MiB.
     *  - `perCuratorBytesPerHour`   — SPEC §1.2.4 default 50 MiB.
     *  - `coreAggregateBytes`       — across-all-wallets cap; default 4 GiB.
     */
    discoveryRateLimit?: {
      perCuratorBytesPerMinute?: number;
      perCuratorBytesPerHour?: number;
      coreAggregateBytes?: number;
    };
    /**
     * OT-RFC-49 WS-A — the irreversible private-ciphertext strip. When `true`
     * (DEFAULT — `undefined` is treated as on), a core declines ALL
     * private-ciphertext host-mode custody for CURATED context graphs:
     * "hosting follows access". Concretely, for a curated CG the core
     *
     *   - DECLINES the auto-host subscribe (reconcile/beacon/chain-event +
     *     the restart-restore path), starving both the `.meta` ingest and
     *     the LU-11 chunk ingest at the single subscribe choke point;
     *   - REFUSES the operator override (`enableSwmHostModeFor`) — unlike the
     *     narrower rung-1 `stripNonParticipants`, WS-A CLOSES the operator
     *     hatch, so there is no manual path back into private custody;
     *   - RETIRES the private serve responders (`handleSwmHostCatchup`,
     *     `handleGetCiphertextChunk`) so a stripped core serves nothing
     *     private back over the wire.
     *
     * Random sampling now proves the PUBLIC `_catalog` subgraph, so cores no
     * longer need the ciphertext; private data lives member-side and members
     * backfill from the curator (REPLACE-recovery), not from cores. PUBLIC CGs
     * are NEVER affected — the gate sits after the curated check on every path.
     * Set `false` to restore legacy host-mode custody (the rolling-upgrade
     * kill-switch / A/B baseline; backcompat is waived for V10 testnet).
     */
    stripCiphertext?: boolean;
  };
  /** Durable local store for subscribed context-graph runtime state. */
  contextGraphSubscriptionStore?: ContextGraphSubscriptionStore;
  /** Durable local store for paged sync checkpoints. Defaults to in-memory. */
  syncCheckpointStore?: SyncCheckpointStore;
  /** OT-RFC-59 durable per-(peer,CG) changelog cursor store. Defaults to in-memory. */
  changelogCursorStore?: ChangelogCursorStore;
  /** Durable lane cursor store for the chain event poller. Defaults to in-memory. */
  chainEventCursorStore?: ChainEventCursorPersistence;
  /** Durable ContextGraphNameRegistry discovery cursor store. Defaults to in-memory adapter state. */
  contextGraphRegistryScanCursorStore?: ContextGraphRegistryScanCursorStore;
  /**
   * Intentional cap on how many persisted context-graph subscriptions are
   * *activated* (gossip-subscribed + sync-tracked) when rehydrating at startup.
   * A large backlog of stale subscriptions otherwise fans out store-touching
   * gossip/sync work that starves authenticated store-backed routes (issue
   * #997). Rows beyond the cap stay persisted but inactive, are reported via
   * subscription diagnostics, and can be pruned via
   * `DELETE /api/context-graph/subscriptions`. Default
   * `DEFAULT_MAX_REHYDRATED_SUBSCRIPTIONS`. `0` disables the cap.
   */
  maxRehydratedContextGraphSubscriptions?: number;
  /** Durable local cache for nodes/agents known to be members of a context graph. */
  contextGraphMembershipStore?: ContextGraphMembershipStore;
  /** Durable, fail-closed per-CG curator join policy and admission audit store. */
  contextGraphJoinPolicyStore?: ContextGraphJoinPolicyStore;
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
  /**
   * Phase E/F — optional sink for chain-driven VM reconciliation telemetry.
   * The agent emits a {@link ReplicationEvent} at each reconcile decision
   * point (sweep summary, active fetch, promote, cursor advance). Production
   * wires this to the ops metrics DB (Phase F `replication_events` table) so
   * the `/ui/observability` Replication tab can aggregate; omit it and the
   * structured `chain-promote` log line is still emitted (Phase E grep path).
   * Best-effort: the agent never awaits or throws on the sink.
   */
  onReplicationEvent?: ReplicationEventSink;
  messengerStores?: {
    idempotencyStore: MessageIdempotencyStore;
    outboxStore: CompatibleProtocolOutboxStore;
  };
}

export interface DKGAgentACKTransportOptions {
  sendTimeoutMs?: number;
  log?: (message: string) => void;
}

export type ResolvedDKGAgentConfig =
  Omit<
    DKGAgentConfig,
    | 'storageAckTiming'
    | 'ackHandlerDeadlineMs'
    | 'ackSendTimeoutMs'
    | 'rfc64PublicCatalogActivation'
    | 'rfc64PublicCatalogAutoPublish'
    | 'rfc64PublicCatalogBootstrap'
    | 'rfc64CatalogDeploymentProfile'
  > & {
    storageAckTiming: StorageAckTiming;
    rfc64CatalogDeploymentProfile?: Readonly<CatalogSealDeploymentProfileV1>;
    rfc64PublicCatalogAutoPublishPolicy?: ResolvedRfc64PublicCatalogAutoPublishPolicyV1;
    rfc64PublicCatalogBootstrap?: Readonly<Rfc64PublicCatalogBootstrapConfigV1>;
  };
