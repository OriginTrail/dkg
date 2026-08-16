// SPDX-License-Identifier: Apache-2.0

/**
 * Tuning knobs, timeouts, and wire-level sentinels extracted from
 * `dkg-agent.ts` as part of a mechanical file-size reduction. These
 * are pure values with no `DKGAgent` instance dependency. Behaviour
 * is unchanged — this module is a 1:1 move.
 */

import {
  DEFAULT_MAX_READ_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
  type OperationContext,
} from '@origintrail-official/dkg-core';

/** Anchor predicate stamped on every root entity that has a private partition. */
export const PRIVATE_DATA_ANCHOR = 'http://dkg.io/ontology/privateDataAnchor';

// ── Sync ──────────────────────────────────────────────────────────────
/** Legacy signed responder-side maximum accepted row limit. Keep at 500 so a
 * new responder remains compatible with requesters from an older rolling node. */
export const SYNC_PAGE_SIZE = 500;
/**
 * Requester page size derived from the wire frame cap, not only row count.
 *
 * A legal RDF literal may occupy JAVA_WRITE_UTF_MAX_BYTES. At the historical
 * 500-row request size, 32 KiB literals already produced ~16 MiB responses and
 * tripped ProtocolRouter's 10 MiB read limit before page parsing. Reserve six
 * MiB for subjects, predicates, graph IRIs, N-Quads syntax, and framing; the
 * remaining four MiB admits 64 maximum-sized literal rows. That value remains
 * the retry floor for pathological payloads.
 *
 * Upgraded durable-sync peers negotiate a byte-budgeted page through additive
 * hints. Authenticated JSON requests keep the signed `limit` capped at the
 * legacy 500,
 * so an old responder authenticates the request and simply returns 500 rows;
 * a new responder may return up to the row hint but serializes only a bounded
 * response body. EOF-only pagination makes both responses unambiguous. A
 * transport failure retries at the conservative 64-row floor.
 */
export const SYNC_RESPONSE_FRAME_HEADROOM_BYTES = 6 * 1024 * 1024;
export const SYNC_REQUEST_SAFE_PAGE_SIZE = Math.max(
  1,
  Math.floor(
    (DEFAULT_MAX_READ_BYTES - SYNC_RESPONSE_FRAME_HEADROOM_BYTES) /
    JAVA_WRITE_UTF_MAX_BYTES,
  ),
);
/** Additive wire capability understood by upgraded durable-sync responders. */
export const SYNC_BYTE_BUDGET_PAGE_MODE = 'byte-budget-v1' as const;
/** Maximum rows a responder may materialize for one byte-budgeted durable page. */
export const SYNC_BYTE_BUDGET_MAX_ROWS = 8_192;
/**
 * Conservative first request for a previously unseen peer/path.
 *
 * The 8,192-row byte-budget ceiling remains available after the requester has
 * observed sustained success, but opening at that ceiling amplifies cold
 * relay and responder-queue churn: one reset throws away a much larger page
 * and occupies a scarce durable lane while the transport retries. 512 stays
 * above the legacy 500-row cap (so byte-budget EOF semantics remain active)
 * while bounding the first response.
 */
export const SYNC_REQUEST_INITIAL_PAGE_SIZE = 512;
/**
 * Maximum store rows loaded by one negotiated exact-VM page.
 *
 * Exact reads stay page-only, so this is also their responder working-set
 * bound. 512 worst-case 64 KiB literal rows are about 32 MiB before normal
 * JS/store overhead; the responder's existing global concurrency of three
 * keeps that bounded while the 4 MiB serializer cap still owns wire bytes.
 * Matching the requester's cold-path hint lets an ordinary 100-750 triple KA
 * cross in one or two streams while remaining far below the 8,192-row retained-
 * snapshot lane.
 */
export const SYNC_EXACT_PAGE_READ_MAX_ROWS = 512;
/** Target serialized body. Six MiB of the 10 MiB router cap remains as headroom. */
export const SYNC_BYTE_BUDGET_RESPONSE_BYTES = DEFAULT_MAX_READ_BYTES - SYNC_RESPONSE_FRAME_HEADROOM_BYTES;
/** Maximum throughput-oriented row hint; the signed legacy limit remains 500. */
export const SYNC_REQUEST_PAGE_SIZE = SYNC_BYTE_BUDGET_MAX_ROWS;
/** Successful pages required before the requester doubles its learned size. */
export const SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD = 8;
export const SYNC_PAGE_RETRY_ATTEMPTS = 3;
export const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
export const SYNC_PAGE_TIMEOUT_MS = 45_000;
/** Fresh signed request attempts; each envelope is marked single-use at the ProtocolRouter boundary. */
export const SYNC_ROUTER_ATTEMPTS = 3;
export const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
export const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
export const SYNC_AUTH_MAX_AGE_MS = 90_000;

// ── Warm core connections (A.4-lite+) ─────────────────────────────────
/**
 * Opt-in: when set, the agent keeps a small set of Core nodes warm
 * (connection pinned + auto-redialed by libp2p) so catch-up / chain-driven
 * reconciliation never pays a cold circuit-relay dial to reach a Core.
 * Conservative default (off) — flip to '1' to enable.
 */
export const WARM_CORE_CONNECTIONS_ENABLED = process.env.DKG_WARM_CORE_CONNECTIONS === '1';
/** How often to refresh the warm-core set from the phonebook + redial drops. */
export const WARM_CORE_RECONCILE_INTERVAL_MS = 90_000;
/** Upper bound on simultaneously pinned Cores (slot-exhaustion guard). */
export const WARM_CORE_MAX = 8;
/** keep-alive peerStore tag for warm Cores (mirrors the relay keep-alive tag). */
export const WARM_CORE_KEEPALIVE_TAG = 'keep-alive-dkg-core';
/** Per-dial budget when warming a Core. */
export const WARM_CORE_DIAL_TIMEOUT_MS = 20_000;

// ── Join ──────────────────────────────────────────────────────────────
/**
 * How long an agent's join-request delegation is valid for. The same
 * delegation authorises the joiner's node to sync this CG on behalf of
 * the agent for the lifetime of the membership; we default to 1 year so
 * that approved joiners don't silently lose access after a short window.
 * The agent can re-issue at any time by signing a fresh delegation.
 */
export const JOIN_DELEGATION_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Send timeout for `/dkg/.../join-request` deliveries between joiner ↔ curator.
 *
 * Why 20s and not the previous 5s: `ProtocolRouter.send` shares a single
 * `AbortSignal.timeout(timeoutMs)` across its 3 retry attempts (see
 * `protocol-router.ts:82-97`), so this value is the budget for the *entire*
 * dial-retry loop, not per attempt. A fresh circuit-relay dial against a
 * NAT'd peer routinely takes 1-3s to establish; 5s leaves no headroom for
 * the back-off-and-retry path the loop is designed for, so the very first
 * approval-notification after a curator's `approve-join` would routinely
 * abort before libp2p got a chance to upgrade the relay connection. Two
 * laptops on home internet (PR #448) reproduced this consistently.
 *
 * 20s matches `DEFAULT_SEND_TIMEOUT_MS` and gives ProtocolRouter's loop room
 * for ~3 attempts of ~3-5s each before declaring the peer unreachable.
 *
 * The proper fix is per-attempt timeouts in ProtocolRouter (the shared signal
 * is a latent design issue) — tracked separately, not in scope here.
 */
export const JOIN_REQUEST_SEND_TIMEOUT_MS = 20_000;

// ── Sync access control ───────────────────────────────────────────────
/**
 * Wire-level sentinel returned by the sync responder when ACL authorization
 * fails for a request. Distinguishes an explicit denial from an empty page
 * (peer is up but has no data) and a transport error (peer unreachable).
 * Chosen to never collide with nquads output (nquads lines always contain
 * `<…>` tokens and end with `.`; this is a `#`-comment string).
 */
export const SYNC_ACCESS_DENIED_MARKER = '#DKG-SYNC-ACCESS-DENIED';

export const LOCAL_ACCESS_OPEN = 0;
export const LOCAL_ACCESS_CURATED = 1;
export const EVM_PUBLISH_CURATED = 0;
export const EVM_PUBLISH_OPEN = 1;
export const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

// ── Refresh / SWM lifecycle ───────────────────────────────────────────
export const META_REFRESH_COOLDOWN_MS = 30_000;
export const SYNC_MIN_GRAPH_BUDGET_MS = 10_000;
export const DEBUG_SYNC_PROGRESS = process.env.DKG_DEBUG_SYNC_PROGRESS === '1';
export const DEFAULT_SWM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SWM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run cleanup every 15 minutes
export const SYNC_DENIED_RESPONSE = '__DKG_SYNC_DENIED__';

// ── Gossip reconnect ──────────────────────────────────────────────────
/**
 * How long to wait between reconnect-on-gossip dial attempts for the same peer.
 * A CG with chatty gossip could otherwise produce a dial per message; this
 * throttles us to at most one attempted dial per peer per window.
 */
export const GOSSIP_DIAL_COOLDOWN_MS = 30_000;
/** Per-dial-attempt timeout for reconnect-on-gossip so a stuck dial can't starve the gossip handler path. */
export const GOSSIP_DIAL_TIMEOUT_MS = 10_000;
/**
 * Cooldown for catchup-on-connection:open: suppresses duplicate catchup kicks
 * when the same peer briefly has overlapping direct + relayed connections
 * (each of which fires its own connection:open).
 */
export const CATCHUP_ON_CONNECT_COOLDOWN_MS = 60_000;
/**
 * A full libp2p disconnect shorter than this is treated as relay/direct
 * transport churn, not a meaningful offline gap. Without this grace window,
 * short circuit-relay flaps reset the catch-up cooldown and every reconnect
 * can fan out a full sync round.
 */
export const SYNC_RECONNECT_FLAP_GRACE_MS = 15_000;

// ── Reconciler / staleness ────────────────────────────────────────────
/**
 * Period of the sync reconciler tick. The reconciler is the safety net
 * for the event-driven `peer:update` retry path: if libp2p drops a
 * `peer:update` event (in-process race, version bug, listener thrown),
 * or if a peer's protocol list changes via a transport we don't get
 * notified about, the reconciler eventually re-probes and re-syncs.
 *
 * Worst-case sync staleness for a connected peer is ~ this interval.
 * 5 minutes balances "catch missed events quickly enough that RS
 * proofs don't drift" against "don't pin the event loop with chatty
 * sync probes". See the dkg-agent design notes around
 * `startSyncReconciler` for the trade-off.
 */
export const SYNC_RECONCILER_INTERVAL_MS = 5 * 60_000;
/**
 * A peer is considered "stale" — eligible for a reconciler-driven sync
 * retry — if no successful sync has completed for it within this window.
 * Set higher than `SYNC_RECONCILER_INTERVAL_MS` so a single missed
 * tick doesn't immediately retry every connected peer; that gives
 * the event-driven path time to win the race in the common case.
 */
export const SYNC_STALENESS_THRESHOLD_MS = 10 * 60_000;
/**
 * Per-peer exponential backoff for the sync reconciler. Without it, a
 * peer that can never be synced (dead, NAT-stuck, or persistently
 * stream-resetting) is retried on EVERY reconciler tick forever:
 * `lastSuccessfulSyncAt` never gets stamped, so the peer reads as
 * perpetually stale and is dialed every `SYNC_RECONCILER_INTERVAL_MS`.
 * The backoff grows the per-peer retry gap as
 * `SYNC_BACKOFF_BASE_MS * 2^(failures-1)` (capped at
 * `SYNC_BACKOFF_MAX_MS`, ±`SYNC_BACKOFF_JITTER` to de-correlate peers)
 * and resets the instant a sync succeeds. Only the periodic reconciler
 * is gated — connection:open and peer:update still trigger an immediate
 * attempt, so new information is never delayed.
 */
export const SYNC_BACKOFF_BASE_MS = 5 * 60_000;
export const SYNC_BACKOFF_MAX_MS = 60 * 60_000;
export const SYNC_BACKOFF_JITTER = 0.25;
export const RANDOM_SAMPLING_BIND_RETRY_MS = 30_000;
export const STORAGE_ACK_REGISTRATION_RETRY_MS = 30_000;

// ── Outbox / retry ticks ──────────────────────────────────────────────
/**
 * Period of the join-approval retry tick. The retry queue (see
 * `packages/agent/src/join-approval-retry-queue.ts`) holds entries for
 * `join-approved` notifications that the curator wrote locally but couldn't
 * deliver over libp2p — usually because of a transient transport reset
 * (`Remote closed connection during opening`, NAT mapping flap, the
 * invitee's daemon restarting). Without retry the invitee gets stuck:
 * the local curator state is correct but the invitee never learns to
 * sync, and their own retries can't help because they don't yet hold the
 * delegation that would let private-sync auth succeed. The tick walks the
 * queue's `due()` entries with exponential backoff. This separate join queue
 * retains its own peer lifecycle policy; Universal Messenger rows below are
 * scheduled-only.
 */
export const JOIN_APPROVAL_RETRY_TICK_MS = 30_000;

/**
 * Tick interval for the chat outbox retry queue. Same 30s cadence as
 * the join-approval queue (`JOIN_APPROVAL_RETRY_TICK_MS`). The cadence
 * is the sole automatic trigger: reconnect churn must not bypass a row's
 * persisted `nextAttemptAt`. A due entry may sit for up to one tick interval
 * before the scheduler picks it up.
 */
export const MESSAGE_OUTBOX_TICK_MS = 30_000;

/**
 * Cadence at which a daemon re-publishes its own agent profile to
 * the `agents` Context Graph (PR feat/chain-agents-cg-phonebook).
 *
 * Each heartbeat refreshes the profile's `dkg:multiaddr` triples
 * (current dialable addrs) and `dkg:lastSeen` timestamp. This is a
 * FALLBACK source only: live peer addresses come primarily from
 * libp2p `peerRouting.findPeer` (signed peer records), and the
 * agents-CG dial fallback already tolerates entries up to
 * `AGENT_PROFILE_STALE_THRESHOLD_MS` (24h) old. The cadence therefore
 * does not need to track the `beaconReannounceTimer` (5 min): at
 * 20 min we still re-announce at least once per ~30-min relay-
 * reservation epoch while cutting profile publish + gossip churn ~4x
 * (the previous 5-min cadence was ~288x more frequent than the 24h
 * freshness budget it feeds). Complements the agents/_meta growth fix.
 *
 * Tuning: lower for chatty small networks (more responsive but more
 * gossip volume), higher for large meshes (less volume; slower
 * propagation of stale entries). Operators override via
 * `config.network.agentProfileHeartbeatMs`. Set to `0` to disable
 * (the one-shot startup publish still fires).
 */
export const AGENT_PROFILE_HEARTBEAT_MS = 20 * 60 * 1000;

/**
 * Staleness threshold for an agents-CG profile read during dial
 * fallback. If `dkg:lastSeen` is older than this, the profile's
 * `dkg:multiaddr` triples are ignored (the relay address is still
 * tried — it's the safer minimum). 24h matches the existing peer-
 * inactivity assumption built into the soak data.
 */
export const AGENT_PROFILE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// ── Ciphertext chunking (OT-RFC-38 LU-11) ─────────────────────────────
/**
 * OT-RFC-38 LU-11. Target ciphertext-chunk size on the SWM gossip
 * wire. 32 KiB stays well under libp2p's per-message ceiling (the
 * mesh defaults to 1 MiB) so chunks rarely fragment at the transport
 * layer, and produces a tree shallow enough that on-chain proof
 * verification per RFC-39 sampling tick stays cheap. The last chunk
 * is whatever fraction remains.
 */
export const CIPHERTEXT_CHUNK_SIZE_BYTES = 32 * 1024;

// ── Boot-time chain identity ──────────────────────────────────────────
/**
 * Upper bound on the boot-time on-chain identity resolution
 * (`getIdentityId` / `ensureProfile`) inside `start()`. Daemon HTTP
 * readiness MUST NOT depend on chain-RPC reachability: `start()` is awaited
 * before the daemon binds its HTTP listener (cli lifecycle.ts), so an
 * unreachable or rate-limited (HTTP 429) RPC — which the multi-RPC failover
 * loop retries across endpoints — would otherwise block boot past the CLI's
 * 45s readiness ceiling (#894). When this bound trips, identity stays
 * unresolved (0n): the node boots, HTTP serves, and on-chain writes (e.g.
 * context-graph register) surface their own RPC error (503) at call time
 * rather than hanging the whole daemon. Generous enough not to false-trip a
 * healthy-but-slow chain, far below the 45s readiness window.
 */
export const BOOT_CHAIN_IDENTITY_TIMEOUT_MS = 20_000;

/**
 * Floor for the (public, config-settable) StorageACK registration retry
 * interval. Guards against a 0 / negative value collapsing the retry into a
 * tight loop that hammers the RPC and floods the log (Codex PR #901 round-4
 * :2106). 1s is well below the 30s production default yet leaves ample spacing.
 */
export const MIN_STORAGE_ACK_REGISTRATION_RETRY_MS = 1_000;

// ── On-chain access-policy reads (share/publish hot path) ─────────────
/**
 * Sentinel returned by the chain-RPC-fallback timeout race inside
 * `DKGAgent.getContextGraphOnChainPolicy`. Distinct from `undefined`
 * so the caller can tell a timed-out probe apart from an RPC that
 * legitimately resolved to "no policy". Module-scoped so the inner
 * `withTimeout` helper can reuse the same identity.
 */
export const TIMEOUT_SENTINEL = Symbol('chain-rpc-fallback-timeout');

/**
 * Codex review on #872 — TTL for the eagerly-seeded `publishPolicy`
 * cache. `publishPolicy` is mutable on-chain (`PublishPolicyUpdated`
 * is emitted by `ContextGraphStorage.updatePublishPolicy`), but the
 * cache is only populated by `ContextGraphCreated`, so a curator
 * flipping a CG from open → curated would otherwise leave a stale
 * `1` in this node's cache until restart and keep relaxing the
 * import-artifact owner guard. The TTL bounds staleness to one
 * window without wiring a full `PublishPolicyUpdated` event watcher
 * through the chain-event poller. 60s is conservative because the
 * cached value gates an authorization decision — one extra eth_call
 * per minute per active CG is cheap.
 */
export const ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS = 60_000;

/**
 * #884 review — bound the on-chain liveness / access-policy reads on the
 * share/promote/publish hot path (`isContextGraphPublicOnChain`). Mirrors
 * `CHAIN_RPC_FALLBACK_TIMEOUT_MS` in `DKGAgent.getContextGraphOnChainPolicy`:
 * if the RPC layer HANGS (rather than rejecting), the helper must still
 * resolve so the caller fails closed to "not public / not known" instead of
 * blocking the request indefinitely. 2.5s stays well under the daemon-ready
 * budget while allowing a single slow eth_call hop under normal load.
 */
export const CHAIN_POLICY_READ_TIMEOUT_MS = 2_500;

// ── SWM sender-key ────────────────────────────────────────────────────
/** Shared operation context for pending sender-key drain logging. */
export const SWM_SENDER_KEY_PENDING_DRAIN_LOG_CTX: OperationContext = {
  operationId: 'swm-sender-key-pending-drain',
  operationName: 'share',
};
