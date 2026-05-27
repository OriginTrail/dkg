// SPDX-License-Identifier: Apache-2.0

/**
 * Tuning knobs, timeouts, and wire-level sentinels extracted from
 * `dkg-agent.ts` as part of a mechanical file-size reduction. These
 * are pure values with no `DKGAgent` instance dependency. Behaviour
 * is unchanged — this module is a 1:1 move.
 */

/** Anchor predicate stamped on every root entity that has a private partition. */
export const PRIVATE_DATA_ANCHOR = 'http://dkg.io/ontology/privateDataAnchor';

// ── Sync ──────────────────────────────────────────────────────────────
export const SYNC_PAGE_SIZE = 500;
export const SYNC_PAGE_RETRY_ATTEMPTS = 3;
export const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
export const SYNC_PAGE_TIMEOUT_MS = 45_000;
/** ProtocolRouter.send retries internally 3 times with the same timeout; cap so 3× fits in remaining budget. */
export const SYNC_ROUTER_ATTEMPTS = 3;
export const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
export const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
export const SYNC_AUTH_MAX_AGE_MS = 90_000;

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
 * queue's `due()` entries with exponential backoff. Opportunistic retries
 * also fire from `connection:open` when the invitee's peer reconnects,
 * which usually wins the race; the timer is the safety net for cases
 * where reconnect events are missed (e.g. relayed reconnects that don't
 * surface a fresh `connection:open` on the curator).
 */
export const JOIN_APPROVAL_RETRY_TICK_MS = 30_000;

/**
 * Tick interval for the chat outbox retry queue. Same 30s cadence as
 * the join-approval queue (`JOIN_APPROVAL_RETRY_TICK_MS`). The cadence
 * doesn't gate the FIRST retry — a backoff-due entry that's been
 * waiting since 5s after first failure may sit idle for up to 25s
 * before this tick picks it up — but the dominant retry trigger in
 * practice is the `connection:open` opportunistic flush
 * (`processMessageOutboxOnConnect`), which fires the moment the
 * recipient peer becomes reachable again. The tick is the safety net
 * for cases where reconnect events are missed (e.g. relayed reconnects
 * that don't surface a fresh `connection:open` on the sender) or
 * where the recipient was reachable all along but transport failures
 * are coming from somewhere upstream of libp2p.
 */
export const MESSAGE_OUTBOX_TICK_MS = 30_000;
