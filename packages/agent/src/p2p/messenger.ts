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
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

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
  // libp2p surfaces "All multiaddr dials failed" when every
  // candidate address for the peer fails in a single dial attempt
  // (instantaneous routing-table miss — typically peerStore briefly
  // empty after restart, or every cached relay addr dead). This
  // means the peer's addresses are stale on OUR side; a DHT walk is
  // exactly the right recovery (re-resolve against the routing
  // layer + identify cache + agent registry), not just a passive
  // outbox backoff that would keep retrying the same dead address
  // until TTL. Codex PR #567 review caught this — adding it to the
  // classifier (PR #567 main change) made it recoverable, but
  // without this list entry the retry path back-off-but-doesn't-
  // re-resolve.
  'all multiaddr dials failed',
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
 *   - `{ delivered: false, queued: false, inFlight: true, ... }` —
 *     another sender already owns the in-process attempt for this
 *     `(peer, protocol, messageId)`. No durable outbox row necessarily
 *     exists yet, so callers must not treat this as queued.
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
       * opaque "queued" state.
       */
      nextAttemptAtMs: number;
    }
  | {
      // Another sender already owns the in-process attempt for this
      // (peer, protocol, messageId). No durable outbox row necessarily
      // exists yet, so callers must NOT treat this as queued.
      delivered: false;
      queued: false;
      inFlight: true;
      attempts: 0;
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
  private readonly resolvePeer?: (peerId: string, opts: { signal: AbortSignal }) => Promise<void>;

  /**
   * Application handlers registered via `register`. Stored separately
   * from `router.handlers` so the envelope-decode + idempotency
   * wrapper can route through the substrate before invoking the
   * caller's handler.
   */
  private readonly handlers = new Map<string, ReliableHandler>();
  private readonly inboundInFlight = new Map<string, Promise<Uint8Array>>();

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

  /**
   * Per-peer wall-clock of the last DHT walk we kicked off via
   * `resolvePeer`. Used to enforce {@link DHT_WALK_RATE_LIMIT_MS} so
   * an outbox entry that keeps stalling doesn't fire findPeer once
   * per retry tick (which would amplify DHT load + waste each walk
   * on still-fresh peerStore data).
   */
  private readonly lastDhtWalkAt = new Map<string, number>();

  /**
   * Per-protocol classifier that decides whether a successful wire
   * response should count as `delivered` in the protocol-level SLO
   * counters/histogram. Returning `false` skips the delivered bump
   * (and the latency sample) for THAT response — the caller still
   * sees the response bytes verbatim and the outbox still removes
   * the entry; only the metric is adjusted.
   *
   * Added in rc.9 PR-C codex R7: SWM's substrate receiver
   * (`handleSwmUpdate`) signals permanent application-level
   * rejections (peer not in allowlist, bad signature, validation
   * failure) with a 1-byte `FANOUT_RESPONSE_REJECTED` sentinel
   * response. Without this hook, `protocols['/dkg/10.0.1/swm-update']`
   * would record those rejections as `delivered`, overstating
   * apply success at the protocol layer. Other protocols don't
   * register a classifier — every response counts as delivered
   * (backward-compatible default).
   *
   * The classifier is called once per response (success path,
   * background retry success, sender-side dedup hit) — it must
   * be pure (no side effects) and cheap (microseconds).
   */
  private readonly deliveredResponseClassifiers = new Map<string, (response: Uint8Array) => boolean>();

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
    this.resolvePeer = deps.resolvePeer;
  }

  /**
   * Register a per-protocol filter that decides whether a wire
   * response should count toward the protocol-level `delivered`
   * SLO counter. See {@link deliveredResponseClassifiers} for the
   * full design rationale. Calling this with `protocolId` that
   * already has a classifier overwrites it — last-write-wins.
   *
   * Typical use: PR-C SWM substrate fan-out registers
   *   `setResponseDeliveredClassifier(PROTOCOL_SWM_UPDATE, (resp) =>
   *      !(resp.byteLength === 1 && resp[0] === 0x01))`
   * so the 1-byte rejection sentinel is excluded from `delivered`.
   */
  setResponseDeliveredClassifier(
    protocolId: string,
    classifier: (response: Uint8Array) => boolean,
  ): void {
    this.deliveredResponseClassifiers.set(protocolId, classifier);
  }

  private shouldCountResponseAsDelivered(protocolId: string, response: Uint8Array): boolean {
    const classifier = this.deliveredResponseClassifiers.get(protocolId);
    if (classifier === undefined) return true;
    try {
      return classifier(response);
    } catch {
      // Classifier bug — fail open (count as delivered) so a
      // classifier crash doesn't make every send look like a
      // rejection. The SWM-specific bucket will record the truth
      // even if the protocol-level metric is slightly off.
      return true;
    }
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
   * Record a wire-level response for the SLO histogram. Called from
   * `sendReliable` on synchronous success + from `retryOutboxEntry`
   * on background retry success. Idempotent on the (protocol, peer,
   * messageId) key — second call is a no-op because firstAttemptAt
   * was already cleared.
   *
   * PR-C codex R7: consults the per-protocol
   * `deliveredResponseClassifiers` to decide whether the response
   * counts as an application-level delivery. Non-applied responses
   * (e.g. SWM's `FANOUT_RESPONSE_REJECTED` sentinel) clean up
   * `firstAttemptAt` (no leak) but skip the `delivered` counter
   * AND the latency histogram sample — operators reading the
   * protocol-level metric see apply-level truth.
   */
  private noteDeliveredForSlo(
    protocolId: string,
    peerId: string,
    messageId: string,
    response: Uint8Array,
  ): void {
    const k = sloKey(protocolId, peerId, messageId);
    if (!this.shouldCountResponseAsDelivered(protocolId, response)) {
      // App-level rejection (e.g. SWM rejection sentinel).
      // Bookkeeping cleanup only; SLO bucket stays accurate to
      // its "apply-level delivered" meaning.
      this.firstAttemptAt.delete(k);
      return;
    }
    const startedAt = this.firstAttemptAt.get(k);
    if (startedAt == null) {
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

    // rc.9 PR-12: SLO clock starts on the FIRST sendReliable
    // invocation for a given (protocol, peer, messageId). If we get
    // re-entered with the same messageId (e.g. operator clicked send
    // twice), the existing firstAttemptAt is preserved so the
    // latency includes the full retry chain.
    const sloK = sloKey(protocolId, peerId, messageId);
    if (!this.firstAttemptAt.has(sloK)) {
      this.firstAttemptAt.set(sloK, this.clock());
    }

    // Sender-side dedup: if we previously delivered this exact
    // `(peer, protocol, messageId)` (e.g. operator clicked send
    // twice; same caller-supplied id replayed across a daemon
    // restart with the in-flight outbox), return the cached
    // response without a wire round-trip.
    const sentBefore = idem.check(peerId, protocolId, messageId, 'out');
    if (sentBefore.seen) {
      // No SLO sample to record here — sender-side dedup means we
      // didn't actually deliver this call; the original delivery
      // already counted. Still bump the delivered counter so
      // operators see traffic.
      //
      // PR-C codex R7: but only if the per-protocol classifier
      // says the cached response counts as delivered. If the
      // cached response is e.g. SWM's rejection sentinel, we
      // shouldn't bump delivered on a dedup re-hit either — the
      // protocol-level metric stays accurate to "applied".
      const cached = sentBefore.cachedResponse ?? RESPONSE_GONE_BYTES;
      if (this.shouldCountResponseAsDelivered(protocolId, cached)) {
        this.bumpCounter(protocolId, 'delivered');
      }
      this.firstAttemptAt.delete(sloK);
      return {
        delivered: true,
        // Mark-only original response surfaces as RESPONSE_GONE so
        // the caller can decide whether to re-issue with a fresh
        // messageId (chat: harmless; query: must re-issue).
        response: cached,
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
      // Another attempt is in flight. This is not the same thing as
      // durable queued: the winning attempt may still be on its first
      // wire send and no outbox row may exist yet.
      return {
        delivered: false,
        queued: false,
        inFlight: true,
        attempts: 0,
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
      this.noteDeliveredForSlo(protocolId, peerId, messageId, response);
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
      this.noteQueuedForSlo(protocolId);
      this.maybeScheduleDhtWalk(peerId, entry.attempts, errMsg);
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

      const inFlightKey = this.idempotencyKey(peerKey, protocolId, envelope.messageId, 'in');
      const inFlight = this.inboundInFlight.get(inFlightKey);
      if (inFlight) {
        return inFlight;
      }

      const handled = (async () => {
        const response = await handler(envelope.payload, peerKey);
        idem.record(peerKey, protocolId, envelope.messageId, 'in', response);
        return response;
      })();
      this.inboundInFlight.set(inFlightKey, handled);
      try {
        return await handled;
      } finally {
        this.inboundInFlight.delete(inFlightKey);
      }
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
      this.noteDeliveredForSlo(entry.protocol, entry.peer, entry.messageId, response);
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
   *      doesn't fix stream resets or NO_RESERVATION-after-handshake).
   *   4. Per-peer rate limit (`DHT_WALK_RATE_LIMIT_MS`).
   *   5. Time-bounded (`DHT_WALK_TIMEOUT_MS`) — failures logged,
   *      never bubble.
   */
  private maybeScheduleDhtWalk(peerId: string, attempts: number, errMsg: string): void {
    if (!this.resolvePeer) return;
    if (attempts < OUTBOX_STALL_THRESHOLD) return;
    if (!shouldTriggerDhtWalk(errMsg)) return;
    const last = this.lastDhtWalkAt.get(peerId);
    const now = this.clock();
    if (last !== undefined && now - last < DHT_WALK_RATE_LIMIT_MS) return;

    this.lastDhtWalkAt.set(peerId, now);
    const signal = AbortSignal.timeout(DHT_WALK_TIMEOUT_MS);
    // Fire-and-forget; never await. Any error swallowed + logged.
    // The walk's value is its side-effect (peerStore population),
    // not its return value, so we don't even need the resolved
    // multiaddrs here.
    void this.resolvePeer(peerId, { signal })
      .then(() => {
        console.warn(
          `[Messenger] DHT walk completed for ${peerId.slice(-8)} after ${attempts} stalled outbox attempts — peerStore should now be primed`,
        );
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[Messenger] DHT walk for ${peerId.slice(-8)} failed (attempts=${attempts}): ${msg}`,
        );
      });
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
    // rc.9 PR-12: clean firstAttemptAt for expired entries so the
    // SLO bookkeeping map doesn't grow unbounded on permanently
    // unreachable peers.
    for (const e of dropped) {
      this.firstAttemptAt.delete(sloKey(e.protocol, e.peer, e.messageId));
    }
    const droppedPeers = new Set(dropped.map((entry) => entry.peer));
    for (const peer of droppedPeers) {
      this.clearDhtWalkRateLimitIfDrained(peer);
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

  private idempotencyKey(
    peer: string,
    protocol: string,
    messageId: string,
    direction: 'in' | 'out',
  ): string {
    return `${peer}\x00${protocol}\x00${messageId}\x00${direction}`;
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
