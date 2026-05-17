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
  type ProtocolOutboxEntry,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';

/** Bytes payload the substrate uses to signal `RESPONSE_GONE` on the wire. */
const RESPONSE_GONE_BYTES = new TextEncoder().encode(RESPONSE_GONE_MARKER);

/** Compose the SLO bookkeeping key shared between firstAttemptAt + counters. */
function sloKey(protocolId: string, peerId: string, messageId: string): string {
  return `${protocolId}|${peerId}|${messageId}`;
}

/**
 * Pick the `q` percentile out of an unsorted samples array. Sorts a
 * copy each call — cheap at the 1k-sample window we use. Returns
 * null on empty input so the JSON shape preserves "no data yet" vs
 * "all samples were 0ms".
 */
function pct(samples: readonly number[], q: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentile. Adequate for operator-facing dashboards;
  // we don't need linear interpolation for SLO reporting.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
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
      /**
       * Wall-clock ms when the next retry attempt is scheduled. The
       * MCP `dkg_send_message` tool surfaces this to operators so
       * they can see "queued, retrying at HH:MM:SS" instead of an
       * opaque "queued" state. Equals `Date.now()` (i.e. "try
       * again immediately") when the queued return path is taken
       * because another in-flight attempter held the inflight slot
       * — no real outbox entry exists yet in that case.
       */
      nextAttemptAtMs: number;
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
/**
 * Per-protocol SLO snapshot. Latency stats cover the full
 * "sendReliable invoked → delivered:true" clock, including time
 * spent queued in the outbox + every backoff retry. p50/p95/p99
 * over the last `SLO_WINDOW_SAMPLES` observations; `samples` is the
 * cardinality of that window (capped at `SLO_WINDOW_SAMPLES`).
 *
 * `delivered` + `queued` counters are monotonic (lifetime totals) so
 * operators can see "delivered 9,830 / queued 12" and compute a
 * success ratio without needing the histogram.
 *
 * rc.9 PR-12.
 */
export interface SloProtocolStats {
  protocolId: string;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Lifetime total of successful deliveries (initial + late-retry). */
  delivered: number;
  /** Lifetime total of sendReliable calls that returned queued (not yet delivered when sendReliable returned). */
  queued: number;
}

/**
 * Sliding-window size for per-protocol latency observations. 1000
 * samples is enough to give a stable p99 for chat-rate (~1Hz peak)
 * traffic and small enough to keep memory bounded (8 protocols × 1k
 * samples × 8 bytes/number = ~64 KiB peak). Tunable per-instance
 * via `sloWindowSamples` in `MessengerDeps`.
 */
export const DEFAULT_SLO_WINDOW_SAMPLES = 1000;

export class Messenger {
  private readonly router: ProtocolRouter;
  private readonly idempotencyStore?: MessageIdempotencyStore;
  private readonly outbox?: ProtocolOutbox;
  private readonly clock: () => number;

  /**
   * Application handlers registered via `register`. Stored separately
   * from `router.handlers` so the envelope-decode + idempotency
   * wrapper can route through the substrate before invoking the
   * caller's handler.
   */
  private readonly handlers = new Map<string, ReliableHandler>();

  /**
   * Per-`(protocol, peer, messageId)` "first sendReliable invocation"
   * timestamp. Used to compute the SLO latency clock per the rc.9
   * plan: "sendReliable invoke → resolved {delivered:true} (includes
   * queue + retries)". Cleared on delivery + on outbox expiry; on
   * non-recoverable throw the entry leaks (acceptable — these are
   * exceptional cases that the plan's overnight soak surfaces).
   */
  private readonly firstAttemptAt = new Map<string, number>();

  /**
   * Per-protocol latency observations (ms) — sliding window of the
   * most recent `sloWindowSamples` samples. Rendered into p50/p95/p99
   * on demand by `getSloStats()`; cheap enough at the default 1k
   * window that on-demand sort beats keeping a sorted structure.
   */
  private readonly sloLatencies = new Map<string, number[]>();

  /**
   * Per-protocol monotonic counters: lifetime delivered + queued
   * totals. Operators read these via /api/slo to see the success
   * ratio without parsing the histogram.
   */
  private readonly sloCounters = new Map<string, { delivered: number; queued: number }>();

  /** Sliding-window cap from `MessengerDeps.sloWindowSamples`. */
  private readonly sloWindowSamples: number;

  constructor(deps: MessengerDeps & { sloWindowSamples?: number }) {
    this.router = deps.router;
    this.idempotencyStore = deps.idempotencyStore;
    if (deps.outboxStore) {
      this.outbox = new ProtocolOutbox(deps.outboxStore, {
        backoffs: deps.backoffs,
        maxAgeMs: deps.maxAgeMs,
      });
    }
    this.clock = deps.clock ?? (() => Date.now());
    this.sloWindowSamples = deps.sloWindowSamples ?? DEFAULT_SLO_WINDOW_SAMPLES;
  }

  /**
   * Snapshot of the SLO histogram + counters across every protocol
   * the Messenger has seen traffic for. Stable order (alphabetical
   * by protocolId) so operator dashboards rendering this don't have
   * rows reshuffling between requests. Empty `{}` when no traffic
   * has flowed yet (e.g. node just started).
   *
   * rc.9 PR-12.
   */
  getSloStats(): Record<string, SloProtocolStats> {
    const out: Record<string, SloProtocolStats> = {};
    const protocolIds = new Set<string>([
      ...this.sloLatencies.keys(),
      ...this.sloCounters.keys(),
    ]);
    for (const protocolId of [...protocolIds].sort()) {
      const samples = this.sloLatencies.get(protocolId) ?? [];
      const counters = this.sloCounters.get(protocolId) ?? { delivered: 0, queued: 0 };
      out[protocolId] = {
        protocolId,
        samples: samples.length,
        p50Ms: pct(samples, 0.50),
        p95Ms: pct(samples, 0.95),
        p99Ms: pct(samples, 0.99),
        delivered: counters.delivered,
        queued: counters.queued,
      };
    }
    return out;
  }

  /**
   * Record a successful delivery for the SLO histogram. Called from
   * `sendReliable` on synchronous success + from `retryOutboxEntry`
   * on background retry success. Idempotent on the (protocol, peer,
   * messageId) key — second call is a no-op because firstAttemptAt
   * was already cleared.
   */
  private noteDeliveredForSlo(protocolId: string, peerId: string, messageId: string): void {
    const k = sloKey(protocolId, peerId, messageId);
    const startedAt = this.firstAttemptAt.get(k);
    if (startedAt == null) {
      // Late retry after process restart, or an entry whose start was
      // already cleared. Count the real wire delivery but skip the
      // latency record because there is no reliable start timestamp.
      this.bumpCounter(protocolId, 'delivered');
      return;
    }
    this.firstAttemptAt.delete(k);
    const latency = this.clock() - startedAt;
    const samples = this.sloLatencies.get(protocolId) ?? [];
    samples.push(latency);
    if (samples.length > this.sloWindowSamples) {
      samples.splice(0, samples.length - this.sloWindowSamples);
    }
    this.sloLatencies.set(protocolId, samples);
    this.bumpCounter(protocolId, 'delivered');
  }

  /** Bump the queued counter without disturbing firstAttemptAt. */
  private noteQueuedForSlo(protocolId: string): void {
    this.bumpCounter(protocolId, 'queued');
  }

  private bumpCounter(protocolId: string, kind: 'delivered' | 'queued'): void {
    const c = this.sloCounters.get(protocolId) ?? { delivered: 0, queued: 0 };
    c[kind] += 1;
    this.sloCounters.set(protocolId, c);
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
      // No SLO sample to record here — sender-side dedup means we
      // didn't actually deliver this call; the original delivery
      // already counted.
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

    // rc.9 PR-12: SLO clock starts on the FIRST non-cache-hit
    // sendReliable invocation for a given (protocol, peer, messageId).
    // If a queued message is re-entered before delivery, preserve the
    // existing start so latency includes the full retry chain.
    const sloK = sloKey(protocolId, peerId, messageId);
    if (!this.firstAttemptAt.has(sloK)) {
      this.firstAttemptAt.set(sloK, this.clock());
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
        nextAttemptAtMs: this.clock(),
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
      // rc.9 PR-12: record the SLO sample for the full
      // sendReliable→delivered clock (this call only — late retries
      // record via retryOutboxEntry).
      this.noteDeliveredForSlo(protocolId, peerId, messageId);
      return { delivered: true, response, attempts: 1, messageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Non-recoverable: rethrow. The caller sees the real error;
      // the outbox stays out of it because retrying an encoding
      // bug / unhandled protocol won't help.
      if (!isRecoverableSendError(err)) {
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
      // rc.9 PR-12: queued counter bumps; firstAttemptAt is preserved
      // so the eventual retryOutboxEntry success can compute total
      // latency (queue + every backoff retry).
      this.noteQueuedForSlo(protocolId);
      return {
        delivered: false,
        queued: true,
        attempts: entry.attempts,
        messageId,
        error: errMsg,
        nextAttemptAtMs: entry.nextAttemptAt,
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
      // rc.9 PR-12: late delivery — record SLO sample for the full
      // queued+retry duration. firstAttemptAt was set by the initial
      // sendReliable call that returned queued.
      this.noteDeliveredForSlo(entry.protocol, entry.peer, entry.messageId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isRecoverableSendError(err)) {
        outbox.enqueueFailure(
          entry.peer,
          entry.protocol,
          entry.messageId,
          entry.payload,
          errMsg,
          this.clock(),
        );
      }
      // Non-recoverable: leave the entry alone. `dropExpired` will
      // age it out; an operator-facing diagnostic surface (PR-12)
      // will surface stuck entries so a human can intervene.
    } finally {
      outbox.endAttempt(entry.peer, entry.protocol, entry.messageId);
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
    // rc.9 PR-12: clean firstAttemptAt for expired entries so the
    // SLO bookkeeping map doesn't grow unbounded on permanently
    // unreachable peers.
    for (const e of dropped) {
      this.firstAttemptAt.delete(sloKey(e.protocol, e.peer, e.messageId));
    }
    return dropped.map(({ peer, protocol, messageId, attempts, lastError }) => ({
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

  /**
   * Snapshot of every entry currently in the outbox. Used by the
   * `/api/chat/outbox` route + the MCP `dkg_outbox_status` tool so
   * operators can see what's pending after a long recipient outage.
   * Empty array when no outbox is wired.
   */
  listOutbox(): ProtocolOutboxEntry[] {
    return this.outbox?.list() ?? [];
  }

  /**
   * Look up a specific entry. Used by `DKGAgent`'s diagnostics
   * surfaces to attribute per-message state across the substrate
   * outbox without exposing the store directly. Returns `undefined`
   * when no outbox is wired or no such entry exists.
   */
  getOutboxEntry(peerId: string, protocolId: string, messageId: string): ProtocolOutboxEntry | undefined {
    return this.outbox?.getEntry(peerId, protocolId, messageId);
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
