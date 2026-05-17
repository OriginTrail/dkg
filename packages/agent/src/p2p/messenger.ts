import { randomUUID } from 'node:crypto';
import {
  encodeReliableEnvelope,
  decodeReliableEnvelope,
  RELIABLE_ENVELOPE_VERSION,
  RESPONSE_GONE_MARKER,
  isRecoverableSendError,
  ProtocolOutbox,
  type MessageIdempotencyStore,
  type ProtocolOutboxStore,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';

/** Bytes payload the substrate uses to signal `RESPONSE_GONE` on the wire. */
const RESPONSE_GONE_BYTES = new TextEncoder().encode(RESPONSE_GONE_MARKER);

/**
 * Outbox-attempts threshold past which a stalled entry triggers a
 * DHT-walk via the optional `resolvePeer` hook (rc.9 PR-5). Five was
 * picked because the default backoff ladder (5s → 15s → 30s → 60s →
 * 5m → 30m → 2h) puts attempt 5 at the boundary between the fast
 * sub-minute retries (which should heal on transient relay blips)
 * and the multi-minute retries (which means relay reachability is
 * genuinely degraded, not just a transient — exactly when a DHT
 * walk earns its cost).
 */
export const OUTBOX_STALL_THRESHOLD = 5;

/**
 * Max time the Messenger spends inside the optional `resolvePeer`
 * hook before aborting via the `signal`. The hook is fire-and-
 * forget so this never blocks user-visible latency; the timeout
 * just bounds resource usage when the DHT walk would otherwise
 * spin (e.g. fully partitioned network).
 */
export const DHT_WALK_TIMEOUT_MS = 10_000;

/**
 * Minimum interval between consecutive DHT walks for the same peer.
 * Five minutes mirrors the 5m / 30m backoff layers on the outbox
 * ladder — running a DHT walk more often than the entry itself
 * retries would burn DHT bandwidth + amplify load with no upside
 * (the prior walk's result is still fresh in libp2p's k-buckets).
 */
export const DHT_WALK_RATE_LIMIT_MS = 5 * 60 * 1000;

/**
 * Hard cap for the per-peer DHT-walk rate-limit map. The map is also
 * time-pruned on every scheduling attempt, but this cap prevents a
 * malicious or broken caller from retaining unbounded peer IDs inside
 * one still-fresh rate-limit window.
 */
export const DHT_WALK_RATE_LIMIT_MAX_PEERS = 1024;

/**
 * Error-message substrings that indicate "the dialer couldn't find
 * an address for the peer" — exactly the failure class the DHT walk
 * is designed to heal. Match is case-insensitive `.includes` so we
 * catch both libp2p's "The dial request has no valid addresses for
 * peer" and the shorter "no valid addresses" + the relay-specific
 * "NO_RESERVATION" surfaces from the soak data.
 *
 * Other recoverable errors (stream reset, ECONNRESET, etc.) don't
 * trigger the walk because they don't mean address-resolution
 * failed — they mean a known address went bad mid-flight, which a
 * DHT walk doesn't help with.
 */
const DHT_WALK_TRIGGER_ERRORS = [
  'no valid addresses',
  'no_reservation',
  'no reservation',
];

function shouldTriggerDhtWalk(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return DHT_WALK_TRIGGER_ERRORS.some((needle) => lower.includes(needle));
}

function isRecoverableMessengerSendError(err: unknown, errMsg: string): boolean {
  return isRecoverableSendError(err) || shouldTriggerDhtWalk(errMsg);
}

export interface MessengerDeps {
  router: ProtocolRouter;
  /**
   * Substrate idempotency store. Optional in PR-2 so existing tests +
   * call sites that construct a bare-router Messenger keep working;
   * mandatory once a caller migrates to the `/dkg/10.0.1/*` prefix
   * (PR-3+). When omitted, `sendReliable` and `register` throw with a
   * clear "no idempotency store" error so misconfiguration is loud.
   */
  idempotencyStore?: MessageIdempotencyStore;
  /**
   * Substrate sender-side outbox store. Same optionality rules as
   * `idempotencyStore`. The Messenger wraps the store with a
   * `ProtocolOutbox` internally (which owns the backoff ladder +
   * inflight guard).
   */
  outboxStore?: ProtocolOutboxStore;
  /**
   * Override the default backoff ladder (5s → 2h, mirrors rc.8 chat
   * outbox). Caller can pass a tighter / looser ladder per Messenger
   * instance, but every protocol on the substrate shares the same
   * ladder.
   */
  backoffs?: readonly number[];
  /**
   * Optional address-resolver hook for the **DHT-walk-on-stall**
   * recovery primitive (rc.9 PR-5). When provided, the Messenger
   * fires `resolvePeer(peerId, { signal })` in the background after
   * an outbox entry hits `OUTBOX_STALL_THRESHOLD` attempts with an
   * address-resolution error (e.g. "no valid addresses for peer"),
   * giving libp2p's kad-DHT a chance to repopulate `peerStore` for
   * the next retry.
   *
   * Production wiring is `libp2p.peerRouting.findPeer(pid, { signal })`
   * — done in `cli/src/daemon/lifecycle.ts`. The Messenger never
   * imports libp2p itself; the hook keeps the substrate test-friendly
   * and lets the agent layer own the libp2p object.
   *
   * The Messenger time-bounds the call (`DHT_WALK_TIMEOUT_MS`, 10s)
   * and rate-limits per-peer (`DHT_WALK_RATE_LIMIT_MS`, 5 min) so
   * callers don't need to manage either. Failures are logged but
   * don't block backoff (the entry's `nextAttemptAt` is unaffected).
   */
  resolvePeer?: (peerId: string, opts: { signal: AbortSignal }) => Promise<void>;
  /** Optional structured logger callbacks for background DHT-walk diagnostics. */
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
  /**
   * Max age (ms) from `firstFailureAt` before an outbox entry is
   * dropped. Defaults to 24h. Caller-supplied for tests; production
   * keeps the default.
   */
  maxAgeMs?: number;
  /**
   * Injectable wall-clock. Tests can drive deterministic timestamps;
   * production uses the default `Date.now`.
   */
  clock?: () => number;
}

export interface SendOpts {
  timeoutMs?: number;
}

export interface SendReliableOpts {
  /**
   * Caller-supplied message id. Used by the receiver-side idempotency
   * cache to dedupe duplicate deliveries and by the sender-side
   * "did-I-already-deliver-this" cache. If omitted, the Messenger
   * generates a UUID v4 — but callers that have their own correlation
   * id (e.g. chat `messageId`, query `requestId`) should pass it so
   * retries replayed across daemon restarts stay keyed consistently.
   */
  messageId?: string;
  timeoutMs?: number;
  /**
   * Max age (ms) before an outbox entry for this `(peer, protocol,
   * messageId)` is considered stale and dropped. Defaults to the
   * Messenger's instance-level `maxAgeMs` (24h). Override for callers
   * that want shorter expiry (e.g. ephemeral chat) or longer
   * (e.g. join-approval).
   */
  maxAgeMs?: number;
}

/**
 * Result of `Messenger.sendReliable`. Three terminal shapes:
 *
 *   - `{ delivered: true, response, attempts, messageId }` — wire
 *     send + response read succeeded. `response` is the application
 *     bytes the receiver's handler returned (envelope-unwrapped).
 *
 *   - `{ delivered: false, queued: true, attempts, messageId, error }`
 *     — wire send failed with a recoverable error; the substrate has
 *     enqueued the envelope-wrapped bytes for background retry.
 *     `attempts` tracks the total retry count so far (starts at 1 for
 *     the first failure).
 *
 *   - Thrown — non-recoverable error (encoding bug, unhandleable
 *     protocol id, etc.) is rethrown to the caller. The substrate
 *     does NOT enqueue these because retrying won't help.
 *
 * Late delivery (background retry succeeds AFTER `sendReliable`
 * returned `{ queued: true }`) does not propagate back to the
 * original caller — the original promise has already resolved. For
 * chat that's fine (the UI notification path is independent). For
 * request/response callers like `/query-remote`, the caller will
 * need to poll or get notified through a separate channel; today
 * the floor is just "we tried and queued, here's the messageId for
 * follow-up".
 */
export type ReliableSendResult =
  | {
      delivered: true;
      response: Uint8Array;
      attempts: number;
      messageId: string;
    }
  | {
      delivered: false;
      queued: true;
      attempts: number;
      messageId: string;
      error: string;
    };

/** Handler signature for `Messenger.register`. */
export type ReliableHandler = (
  payload: Uint8Array,
  peerId: string,
) => Promise<Uint8Array>;

/**
 * The Universal Messenger substrate.
 *
 * Two surfaces:
 *
 *   1. **Legacy pass-through** (`sendToPeer`) — unchanged in PR-2 so
 *      every existing `/dkg/10.0.0/*` caller continues to work
 *      byte-identically. The substrate evolution does not break
 *      backwards compatibility at the API layer; the protocol prefix
 *      bump (PR-3+) is what opts a caller into the substrate path.
 *
 *   2. **Substrate** (`sendReliable` + `register` + retry tick) —
 *      adds envelope-wrapping, sender-side idempotency cache,
 *      durable outbox with backoff, receiver-side dedup. Used by any
 *      caller on the `/dkg/10.0.1/*` prefix (PR-3 migrates chat +
 *      skill first; subsequent PRs migrate the rest).
 *
 * Both surfaces share the same underlying `ProtocolRouter` — the
 * substrate is a wrapper, not a replacement.
 *
 * Construction:
 *
 *   - PR-2 makes `idempotencyStore` + `outboxStore` optional so
 *     existing test sites (`p2p-messenger.test.ts`) keep working
 *     without store fixtures. When a caller invokes `sendReliable`
 *     without stores wired, the method throws a typed
 *     `MessengerNotConfiguredError` so misconfiguration surfaces
 *     loudly rather than silently regressing reliability.
 *
 *   - PR-3 wires the SQLite-backed stores in `cli/src/daemon/
 *     lifecycle.ts` so every chat send picks them up.
 *
 * See `docs/messenger.md` for the architecture overview and per-
 * protocol coverage table.
 */
export class Messenger {
  private readonly router: ProtocolRouter;
  private readonly idempotencyStore?: MessageIdempotencyStore;
  private readonly outbox?: ProtocolOutbox;
  private readonly clock: () => number;
  private readonly resolvePeer?: (peerId: string, opts: { signal: AbortSignal }) => Promise<void>;
  private readonly logInfo: (message: string) => void;
  private readonly logWarn: (message: string) => void;

  /**
   * Application handlers registered via `register`. Stored separately
   * from `router.handlers` so the envelope-decode + idempotency
   * wrapper can route through the substrate before invoking the
   * caller's handler.
   */
  private readonly handlers = new Map<string, ReliableHandler>();

  /**
   * Per-peer wall-clock of the last DHT walk we kicked off via
   * `resolvePeer`. Used to enforce {@link DHT_WALK_RATE_LIMIT_MS} so
   * an outbox entry that keeps stalling doesn't fire findPeer once
   * per retry tick (which would amplify DHT load + waste each walk
   * on still-fresh peerStore data).
   */
  private readonly lastDhtWalkAt = new Map<string, number>();

  constructor(deps: MessengerDeps) {
    this.router = deps.router;
    this.idempotencyStore = deps.idempotencyStore;
    if (deps.outboxStore) {
      this.outbox = new ProtocolOutbox(deps.outboxStore, {
        backoffs: deps.backoffs,
        maxAgeMs: deps.maxAgeMs,
      });
    }
    this.clock = deps.clock ?? (() => Date.now());
    this.resolvePeer = deps.resolvePeer;
    this.logInfo = deps.logInfo ?? (() => undefined);
    this.logWarn = deps.logWarn ?? deps.logInfo ?? (() => undefined);
  }

  /**
   * Legacy pass-through send. Returns the response bytes directly,
   * matching the rc.8 API exactly so unmigrated callers keep
   * working. No envelope, no idempotency, no outbox — pure
   * `ProtocolRouter.send` delegation.
   *
   * PR-3+ migrates callers to `sendReliable` on a per-protocol
   * basis; this method remains the floor until every short-message
   * protocol has migrated.
   */
  async sendToPeer(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    opts: SendOpts = {},
  ): Promise<Uint8Array> {
    return this.router.send(peerId, protocolId, data, opts.timeoutMs);
  }

  /**
   * Substrate send. Wraps `payload` in a `ReliableEnvelope`,
   * consults the sender-side idempotency cache (so a retry of an
   * already-delivered message returns the cached response without
   * a wire round-trip), invokes `ProtocolRouter.send`, and on
   * recoverable failure enqueues the envelope bytes for background
   * retry.
   *
   * Returns a `ReliableSendResult` documenting the outcome — see
   * the type's JSDoc for the three shapes.
   *
   * Throws `MessengerNotConfiguredError` if `idempotencyStore` or
   * `outboxStore` was omitted at construction.
   */
  async sendReliable(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts: SendReliableOpts = {},
  ): Promise<ReliableSendResult> {
    this.requireSubstrate('sendReliable');

    const messageId = opts.messageId ?? randomUUID();
    const idem = this.idempotencyStore!;
    const outbox = this.outbox!;

    // Sender-side dedup: if we previously delivered this exact
    // `(peer, protocol, messageId)` (e.g. operator clicked send
    // twice; same caller-supplied id replayed across a daemon
    // restart with the in-flight outbox), return the cached
    // response without a wire round-trip.
    const sentBefore = idem.check(peerId, protocolId, messageId, 'out');
    if (sentBefore.seen) {
      return {
        delivered: true,
        // Mark-only original response surfaces as RESPONSE_GONE so
        // the caller can decide whether to re-issue with a fresh
        // messageId (chat: harmless; query: must re-issue).
        response: sentBefore.cachedResponse ?? RESPONSE_GONE_BYTES,
        attempts: 1,
        messageId,
      };
    }

    const envelope = encodeReliableEnvelope({
      messageId,
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: this.clock(),
      payload,
    });

    // Inflight guard (rc.9 #521 lesson lifted): two parallel
    // attempters on the same `(peer, protocol, messageId)` can race
    // when the periodic tick + an opportunistic-flush fire close
    // together. Second attempter exits without dialing.
    if (!outbox.tryBeginAttempt(peerId, protocolId, messageId)) {
      // Another attempt is in flight. Return queued; the in-flight
      // one will either deliver (writes to idempotency cache) or
      // re-enqueue (updates outbox).
      return {
        delivered: false,
        queued: true,
        attempts: 1,
        messageId,
        error: 'send already in flight for this messageId',
      };
    }

    try {
      const response = await this.router.send(
        peerId,
        protocolId,
        envelope,
        opts.timeoutMs,
      );
      idem.record(peerId, protocolId, messageId, 'out', response);
      outbox.markDelivered(peerId, protocolId, messageId);
      this.clearDhtWalkRateLimitIfDrained(peerId);
      return { delivered: true, response, attempts: 1, messageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Non-recoverable: rethrow. The caller sees the real error;
      // the outbox stays out of it because retrying an encoding
      // bug / unhandled protocol won't help.
      if (!isRecoverableMessengerSendError(err, errMsg)) {
        throw err;
      }
      const entry = outbox.enqueueFailure(
        peerId,
        protocolId,
        messageId,
        envelope,
        errMsg,
        this.clock(),
      );
      this.maybeScheduleDhtWalk(peerId, entry.attempts, errMsg);
      return {
        delivered: false,
        queued: true,
        attempts: entry.attempts,
        messageId,
        error: errMsg,
      };
    } finally {
      outbox.endAttempt(peerId, protocolId, messageId);
    }
  }

  /**
   * Substrate receive registration. Wraps the caller's handler with:
   *
   *   1. `ReliableEnvelope` decode — extracts the application
   *      payload bytes.
   *
   *   2. Receiver-side idempotency check — if we've already
   *      processed `(peer, protocol, messageId, 'in')`, return the
   *      cached response (or `RESPONSE_GONE` if the original was
   *      too big to cache) WITHOUT re-invoking the application
   *      handler. This absorbs both the multi-path race (PR-4) and
   *      the sender-side stale-snapshot retry storm.
   *
   *   3. Application handler invocation with envelope-unwrapped
   *      payload bytes.
   *
   *   4. Response record — the application's response bytes are
   *      cached (inline up to 256 KiB, mark-only beyond) so a
   *      duplicate receive returns the same bytes idempotently.
   *
   * The application handler signature `(payload, peerId) =>
   * Promise<Uint8Array>` exactly matches what callers wrote before;
   * the substrate is transparent to the inner handler logic.
   *
   * Throws `MessengerNotConfiguredError` if `idempotencyStore` was
   * omitted at construction.
   */
  register(protocolId: string, handler: ReliableHandler): void {
    this.requireSubstrate('register');
    const idem = this.idempotencyStore!;
    this.handlers.set(protocolId, handler);

    this.router.register(protocolId, async (data, peerIdObj) => {
      const peerKey = peerIdObj.toString();

      let envelope: { messageId: string; payload: Uint8Array };
      try {
        const decoded = decodeReliableEnvelope(data);
        envelope = { messageId: decoded.messageId, payload: decoded.payload };
      } catch (err) {
        // Bare bytes (no envelope) — this shouldn't happen on a
        // /dkg/10.0.1/* protocol if both sides ran the substrate.
        // Surface the bug rather than silently falling through to
        // the raw handler, because mixing wrapped + bare frames on
        // the same protocol prefix would corrupt the idempotency
        // table (a "bare bytes" handler call would store the
        // application response under a fabricated/missing messageId).
        // Hard cutover on the protocol-prefix bump is the rc.9
        // design decision — see docs/messenger.md.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[Messenger] failed to decode ReliableEnvelope on ${protocolId} from ${peerKey.slice(-8)}: ${msg}`,
        );
      }

      const seen = idem.check(peerKey, protocolId, envelope.messageId, 'in');
      if (seen.seen) {
        // Duplicate. Return the cached response if any, else the
        // RESPONSE_GONE sentinel so the sender's caller knows the
        // original response was too big to cache.
        return seen.cachedResponse ?? RESPONSE_GONE_BYTES;
      }

      const response = await handler(envelope.payload, peerKey);
      idem.record(peerKey, protocolId, envelope.messageId, 'in', response);
      return response;
    });
  }

  /**
   * Periodic-tick retry loop. The lifecycle.ts wiring (PR-3) calls
   * this every ~5s. For each outbox entry whose `nextAttemptAt`
   * passes `now`, attempts the wire send again using the
   * already-encoded envelope bytes stored in the outbox.
   *
   * Inflight guard + stale-snapshot guard (`hasEntry` after
   * `tryBeginAttempt`, rc.9 #538 lifted) protect against
   * concurrent-retry duplicates and against re-sending an entry a
   * sibling flush has already delivered.
   *
   * On non-recoverable error, the entry stays in the outbox until
   * `dropExpired(now)` evicts it on age — recovering an encoding
   * bug requires operator action (manual replay or shutdown).
   */
  async processOutboxTick(now: number): Promise<void> {
    if (!this.outbox) return;
    const due = this.outbox.due(now);
    for (const entry of due) {
      await this.retryOutboxEntry(entry);
    }
  }

  /**
   * Opportunistic-flush retry loop. The lifecycle.ts wiring (PR-3)
   * calls this from a libp2p `connection:open` event for `peerId`:
   * a reconnection is the signal we were waiting for, so attempt
   * every pending entry for `peer` NOW even if `nextAttemptAt` is
   * still in the future.
   *
   * Same guards as `processOutboxTick` — must check `hasEntry`
   * after `tryBeginAttempt` to defend against the rc.9 #538 race.
   */
  async processOutboxOnConnect(peerId: string): Promise<void> {
    if (!this.outbox) return;
    const pending = this.outbox.pendingFor(peerId);
    for (const entry of pending) {
      await this.retryOutboxEntry(entry);
    }
  }

  private async retryOutboxEntry(entry: {
    peer: string;
    protocol: string;
    messageId: string;
    payload: Uint8Array;
  }): Promise<void> {
    const outbox = this.outbox!;
    if (!outbox.tryBeginAttempt(entry.peer, entry.protocol, entry.messageId)) {
      return;
    }
    try {
      // Stale-snapshot guard — between the moment `due`/`pendingFor`
      // gave us the snapshot and the moment `tryBeginAttempt` won,
      // a sibling flush may have completed delivery and called
      // `markDelivered`. Re-check `hasEntry` and bail if gone.
      // rc.9 PR #538 lesson, generalised.
      if (!outbox.hasEntry(entry.peer, entry.protocol, entry.messageId)) {
        return;
      }
      const response = await this.router.send(
        entry.peer,
        entry.protocol,
        entry.payload,
      );
      this.idempotencyStore!.record(
        entry.peer,
        entry.protocol,
        entry.messageId,
        'out',
        response,
      );
      outbox.markDelivered(entry.peer, entry.protocol, entry.messageId);
      this.clearDhtWalkRateLimitIfDrained(entry.peer);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isRecoverableMessengerSendError(err, errMsg)) {
        const updated = outbox.enqueueFailure(
          entry.peer,
          entry.protocol,
          entry.messageId,
          entry.payload,
          errMsg,
          this.clock(),
        );
        this.maybeScheduleDhtWalk(entry.peer, updated.attempts, errMsg);
      }
      // Non-recoverable: leave the entry alone. `dropExpired` will
      // age it out; an operator-facing diagnostic surface (PR-12)
      // will surface stuck entries so a human can intervene.
    } finally {
      outbox.endAttempt(entry.peer, entry.protocol, entry.messageId);
    }
  }

  /**
   * DHT-walk-on-stall recovery primitive (rc.9 PR-5). Fire a
   * `resolvePeer` call in the background when an outbox entry hits
   * `OUTBOX_STALL_THRESHOLD` attempts on an address-resolution
   * error, subject to per-peer rate-limiting.
   *
   * Fire-and-forget: never blocks the caller. The DHT walk's
   * side-effect (populating `peerStore` for the peer) heals the
   * next opportunistic-flush or periodic-tick retry, not the
   * current one. This is intentional — the current retry has
   * already failed; the walk is for the next attempt.
   *
   * Guards:
   *   1. No-op when `resolvePeer` not wired.
   *   2. No-op below `OUTBOX_STALL_THRESHOLD` attempts (don't
   *      spend a DHT walk on a transient blip the backoff would
   *      have healed anyway).
   *   3. No-op for non-address-resolution errors (DHT walk
   *      doesn't fix stream resets); address/reservation misses
   *      such as "no valid addresses" and NO_RESERVATION do trigger.
   *   4. Per-peer rate limit (`DHT_WALK_RATE_LIMIT_MS`).
   *   5. Time-bounded (`DHT_WALK_TIMEOUT_MS`) — failures logged,
   *      never bubble.
   */
  private maybeScheduleDhtWalk(peerId: string, attempts: number, errMsg: string): void {
    if (!this.resolvePeer) return;
    if (attempts < OUTBOX_STALL_THRESHOLD) return;
    if (!shouldTriggerDhtWalk(errMsg)) return;
    const now = this.clock();
    this.pruneDhtWalkRateLimit(now);
    const last = this.lastDhtWalkAt.get(peerId);
    if (last !== undefined && now - last < DHT_WALK_RATE_LIMIT_MS) return;

    while (this.lastDhtWalkAt.size >= DHT_WALK_RATE_LIMIT_MAX_PEERS) {
      const oldest = this.lastDhtWalkAt.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.lastDhtWalkAt.delete(oldest);
    }
    this.lastDhtWalkAt.set(peerId, now);
    const signal = AbortSignal.timeout(DHT_WALK_TIMEOUT_MS);
    // Fire-and-forget; never await. Any error swallowed + logged.
    // The walk's value is its side-effect (peerStore population),
    // not its return value, so we don't even need the resolved
    // multiaddrs here.
    void this.resolvePeer(peerId, { signal })
      .then(() => {
        this.logInfo(
          `[Messenger] DHT walk completed for ${peerId.slice(-8)} after ${attempts} stalled outbox attempts — peerStore should now be primed`,
        );
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logWarn(
          `[Messenger] DHT walk for ${peerId.slice(-8)} failed (attempts=${attempts}): ${msg}`,
        );
      });
  }

  private pruneDhtWalkRateLimit(now: number): void {
    for (const [peer, ts] of this.lastDhtWalkAt) {
      if (now - ts >= DHT_WALK_RATE_LIMIT_MS) {
        this.lastDhtWalkAt.delete(peer);
      }
    }
  }

  private clearDhtWalkRateLimitIfDrained(peerId: string): void {
    if (!this.outbox || this.outbox.pendingFor(peerId).length === 0) {
      this.lastDhtWalkAt.delete(peerId);
    }
  }

  /**
   * Drop outbox entries past `maxAgeMs`. Returns the dropped
   * entries so the caller (lifecycle.ts periodic tick) can log
   * them. No-op if no outbox is wired.
   */
  dropExpiredOutbox(now: number): Array<{
    peer: string;
    protocol: string;
    messageId: string;
    attempts: number;
    lastError: string;
  }> {
    if (!this.outbox) return [];
    const dropped = this.outbox.dropExpired(now);
    const droppedPeers = new Set(dropped.map((entry) => entry.peer));
    for (const peer of droppedPeers) {
      this.clearDhtWalkRateLimitIfDrained(peer);
    }
    return dropped
      .map(({ peer, protocol, messageId, attempts, lastError }) => ({
        peer,
        protocol,
        messageId,
        attempts,
        lastError,
      }));
  }

  /** Outbox size, for diagnostics. Zero when no outbox is wired. */
  outboxSize(): number {
    return this.outbox?.size() ?? 0;
  }

  private requireSubstrate(method: string): void {
    if (!this.idempotencyStore || !this.outbox) {
      throw new MessengerNotConfiguredError(method);
    }
  }
}

/**
 * Thrown when a caller invokes `sendReliable` or `register` on a
 * Messenger constructed without `idempotencyStore` + `outboxStore`.
 * Loud-fail rather than silent-fallback because a misconfigured
 * substrate would silently regress every reliability property the
 * rc.9 plan is built around.
 */
export class MessengerNotConfiguredError extends Error {
  constructor(method: string) {
    super(
      `[Messenger] ${method} requires idempotencyStore + outboxStore, ` +
        `but the Messenger was constructed without them. Pass both at ` +
        `construction (lifecycle.ts wires Sqlite-backed stores from the ` +
        `DashboardDB; see docs/messenger.md).`,
    );
    this.name = 'MessengerNotConfiguredError';
  }
}
