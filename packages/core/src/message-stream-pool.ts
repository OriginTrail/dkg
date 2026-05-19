/**
 * Long-lived per-peer stream pool for the `/dkg/10.0.2/message`
 * substrate transport.
 *
 * Problem this fixes
 * ------------------
 *
 * The `/dkg/10.0.1/message` transport opens a fresh request-response
 * stream per send: dial → multistream-select → write → half-close →
 * read response → close. On circuit-relay-v2 connections (which are
 * the majority of our edge↔edge traffic because all edges are NAT-
 * behind), the underlying connection itself is one-shot: it closes
 * shortly after the single stream tears down. The next send pays the
 * full circuit-relay + multistream-select handshake again.
 *
 * The May 2026 multi-node soak data (LEX→{MILES,ARX,HERMES} 24h, 4
 * peers, /dkg/10.0.1/message via circuit-relay-v2) showed:
 *
 *   * p50 send-latency: ~900 ms
 *   * p95: ~8.5 s
 *   * p99: ~9.6 s
 *
 * Daemon-log inspection during the soak showed circuit-relay
 * connections opening for 200–365 ms and closing immediately after
 * each send. PR #537's `getConnections` reuse walk worked correctly
 * but rarely found anything to reuse — the connection was already
 * torn down by the time the next send fired.
 *
 * What this changes
 * -----------------
 *
 * Each `(localNode, peerId)` pair holds at most ONE outbound stream
 * for `/dkg/10.0.2/message`. The stream stays open across many
 * request/response cycles via:
 *
 *   * **Framed multiplexing.** Every send writes a REQUEST frame
 *     ({@link FrameType}); the response arrives as a RESPONSE or
 *     ERROR frame. Requests serialise per stream (one in-flight at
 *     a time) — additional sends queue behind the current one.
 *     Pipelining is a future addition; chat-rate traffic (~1
 *     msg/15s) doesn't need it.
 *
 *   * **Keepalive pings.** A periodic PING frame (default 10s)
 *     keeps both the stream AND the underlying circuit-relay
 *     connection alive between application messages. The receiver
 *     echoes PONG; the relay forwards bytes either way, which keeps
 *     the relay's reservation alive too.
 *
 *   * **Idle close.** If a stream sees no activity (no app sends,
 *     no inbound frames) for `idleTimeoutMs`, the pool closes it
 *     gracefully. The next send re-opens. This bounds the cost of
 *     a peer the local node hasn't talked to in a while.
 *
 *   * **Reset recovery.** On stream error (transport reset, peer
 *     closed, abort) the pool rejects every in-flight + queued
 *     request for that peer with a recoverable error code so the
 *     substrate's `MessageOutbox` re-enqueues them. The next send
 *     opens a fresh stream.
 *
 * Wire format: see {@link FrameType} and {@link encodeFrame} in
 * `message-frame.ts`.
 *
 * Compatibility
 * -------------
 *
 * Peers without the pool registered will fail multistream-select on
 * `/dkg/10.0.2/message` and the dialer falls back to
 * `/dkg/10.0.1/message` (one-shot). The pool advertises only
 * `/dkg/10.0.2/message` on the wire; cross-version negotiation lives
 * at the {@link ProtocolRouter} layer, which can be configured to
 * try the pooled wire protocol first and fall through to one-shot.
 */

import type { Stream } from '@libp2p/interface';
import {
  DEFAULT_MAX_FRAME_BYTES,
  FrameType,
  decodeFrames,
  encodeFrame,
  type DecodedFrame,
} from './message-frame.js';
import type { DKGNode } from './node.js';

/** Protocol id for the pooled, framed transport. */
export const POOLED_MESSAGE_PROTOCOL = '/dkg/10.0.2/message';

/** Default keepalive ping interval — 10 s. */
export const DEFAULT_KEEPALIVE_MS = 10_000;

/** Default idle timeout — 5 min of no activity. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Default per-request response timeout — matches one-shot path. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Subset of {@link DKGNode} we depend on. Defined structurally so
 * tests can pass a stub without re-implementing the full DKGNode
 * surface.
 */
export interface PoolNode {
  libp2p: {
    dialProtocol: (
      peerId: unknown,
      protocols: string | string[],
      options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
    ) => Promise<Stream>;
    handle: (
      protocolId: string,
      handler: (stream: Stream, connection: { remotePeer: { toString: () => string } }) => void,
      opts?: { runOnLimitedConnection?: boolean },
    ) => void;
    unhandle: (protocolId: string) => void;
  };
}

/**
 * Application-level handler signature for inbound pooled traffic.
 * `peerId` is whatever libp2p hands us as `connection.remotePeer`
 * — in production this is a full `PeerId` with `toMultihash()`,
 * `toBytes()`, `equals()`, etc.; in tests it can be any object
 * with at least `toString()`. The router wraps this into the same
 * shape the one-shot path provides before passing to application
 * handlers, so calling `peerId.toBytes()` from a handler works on
 * both wire variants (Codex PR #560 round-3).
 */
export type PooledStreamHandler = (
  requestData: Uint8Array,
  peerId: unknown,
) => Promise<Uint8Array>;

export interface MessageStreamPoolOptions {
  /** Wire protocol id. Default {@link POOLED_MESSAGE_PROTOCOL}. */
  protocolId?: string;
  /** Per-request timeout. Default {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Keepalive ping interval. Default {@link DEFAULT_KEEPALIVE_MS}. Set 0 to disable. */
  keepaliveIntervalMs?: number;
  /** Idle close threshold. Default {@link DEFAULT_IDLE_TIMEOUT_MS}. Set 0 to disable. */
  idleTimeoutMs?: number;
  /** Max bytes per frame. Default {@link DEFAULT_MAX_FRAME_BYTES}. */
  maxFrameBytes?: number;
  /**
   * Injectable wall-clock + timers for tests. Production uses
   * `Date.now` + `setTimeout`/`setInterval`.
   */
  clock?: () => number;
  /**
   * Inject `peerIdFromString`. Default lazy-imports `@libp2p/peer-id`.
   * Tests pass a stub so the pool stays decoupled from libp2p
   * internals.
   */
  peerIdFromString?: (s: string) => unknown;
  /**
   * Address-resolution hook called BEFORE `dialProtocol` on the
   * first stream open per peer. Critical for cold-peer first
   * contact: libp2p's peerStore may be empty/stale for a peer we
   * haven't recently talked to, and `dialProtocol` returns
   * "no valid addresses for peer" without ever consulting the DHT
   * / agent registry / RFC 04 routing.
   *
   * The wrapping `ProtocolRouter` always primes via `peerResolver`
   * on the one-shot path (RFC 07 §3.2 — see `protocol-router.ts`
   * for the rationale + grep gate). Threading the same hook here
   * keeps the pooled path on parity: the pool's first dial pays
   * the same priming cost as the one-shot first dial, no more, no
   * less.
   *
   * Codex PR #560 review: without this, enabling pooling
   * regressed first-contact delivery to cold peers — the failure
   * mode the soak postmortem was built around.
   *
   * Failure-tolerant by contract: any throw from `primePeer` is
   * swallowed (the dial itself surfaces a real transport error if
   * the peer is genuinely unreachable). Per-step timeout is owned
   * by the caller — pass an `AbortSignal` tied to the overall
   * send budget.
   */
  primePeer?: (peerIdStr: string, opts: { signal?: AbortSignal }) => Promise<void>;
}

interface PendingRequest {
  payload: Uint8Array;
  resolve: (response: Uint8Array) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  enqueuedAt: number;
  abortListener?: () => void;
  /**
   * Per-call response timeout in ms, or `undefined` to use the
   * pool-wide default. Threaded from `send()`'s `opts.timeoutMs` so
   * callers asking for a larger budget than the pool default aren't
   * silently capped at 20s (Codex PR #560 round-2 review).
   */
  perRequestTimeoutMs?: number;
}

interface PerPeerState {
  peerIdStr: string;
  stream: Stream;
  /** The currently-in-flight request (writer wrote, awaiting response frame). */
  inFlight: PendingRequest | null;
  /** Sends queued behind the in-flight request, FIFO order. */
  queue: PendingRequest[];
  /** Reader loop promise — resolves when the stream's frame source ends. */
  readerDone: Promise<void>;
  /** Wall-clock of the most recent inbound or outbound frame. */
  lastActivityAt: number;
  /** Keepalive timer; null if disabled. */
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  /** Idle close watchdog timer; null if disabled. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** True after `closePeer` has run; reject any further sends. */
  closed: boolean;
  /** Diagnostics. */
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
}

/** Stats per peer, returned by {@link MessageStreamPool.stats}. */
export interface PerPeerStats {
  peerIdStr: string;
  inFlight: boolean;
  queueDepth: number;
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  ageMs: number;
  lastActivityAgoMs: number;
}

/**
 * Error returned to callers whose request was rejected by stream
 * teardown / pool close. The message intentionally matches one of
 * the substrings in `isRecoverableSendError` so the substrate
 * outbox treats it as retryable.
 */
export class PooledStreamResetError extends Error {
  constructor(detail: string) {
    super(`pooled stream reset: ${detail}`);
    this.name = 'PooledStreamResetError';
  }
}

/**
 * Per-peer long-lived stream pool. Construct one per local node;
 * call {@link send} for outbound requests, {@link registerHandler}
 * to wire the inbound side.
 */
export class MessageStreamPool {
  private readonly node: PoolNode;
  private readonly protocolId: string;
  private readonly requestTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly clock: () => number;
  private readonly peerIdFromStringOverride?: (s: string) => unknown;
  private peerIdFromString?: (s: string) => unknown;
  private readonly primePeer?: (peerIdStr: string, opts: { signal?: AbortSignal }) => Promise<void>;
  private inboundHandler: PooledStreamHandler | null = null;
  private inboundRegistered = false;
  private closed = false;
  private readonly peers = new Map<string, PerPeerState>();
  /**
   * Records the wall-clock when each per-peer state was created, so
   * `stats()` can report stream age separately from last-activity.
   */
  private readonly peerOpenedAt = new Map<string, number>();
  /**
   * Lazy lock so multiple concurrent sends for the same peer don't
   * race to open a stream. First send-without-state grabs the lock,
   * others await it.
   */
  private readonly openLocks = new Map<string, Promise<PerPeerState>>();
  /**
   * Every pending request — both queued and in-flight, across all
   * peers, plus requests whose dial is still in progress. `close()`
   * rejects every entry in this set so a caller's promise never
   * hangs through a pool shutdown.
   */
  private readonly outstanding = new Set<PendingRequest>();

  constructor(node: PoolNode, options: MessageStreamPoolOptions = {}) {
    this.node = node;
    this.protocolId = options.protocolId ?? POOLED_MESSAGE_PROTOCOL;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.clock = options.clock ?? (() => Date.now());
    this.peerIdFromStringOverride = options.peerIdFromString;
    this.primePeer = options.primePeer;
  }

  /** Protocol id this pool advertises on the wire. */
  get pooledProtocolId(): string {
    return this.protocolId;
  }

  /**
   * Send `payload` to `peerIdStr` over the pooled stream, returning
   * the application response bytes. Lazily opens the stream on first
   * call per peer; subsequent calls reuse the held stream.
   *
   * Serialised per peer — multiple concurrent calls for the same
   * peer are dispatched in arrival order, one in-flight at a time.
   * Throws {@link PooledStreamResetError} when stream teardown
   * affected this request (recoverable; substrate outbox will retry).
   */
  send(
    peerIdStr: string,
    payload: Uint8Array,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(new PooledStreamResetError('pool closed'));
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const req: PendingRequest = {
        payload,
        resolve,
        reject,
        signal: opts.signal,
        enqueuedAt: this.clock(),
        // If the caller supplied a per-call timeout, honor it
        // regardless of the pool-wide default. Otherwise fall back
        // to the pool's `requestTimeoutMs` at schedule time. Codex
        // PR #560 round-2 caught: previously `router.send(...,
        // { timeoutMs: 60_000 })` was silently capped at 20s.
        perRequestTimeoutMs:
          typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
            ? opts.timeoutMs
            : undefined,
      };
      // Track every outstanding request so `close()` can reject any
      // that haven't reached an installed state yet (dial still in
      // flight). Without this, a close() racing a first-contact dial
      // would leave the caller's promise hung forever.
      this.outstanding.add(req);

      void this.dispatchSend(peerIdStr, req);
    });
  }

  /**
   * Walk the dial → enqueue → pump path for a single request. Any
   * error short-circuits to `req.reject`; success leaves the request
   * pending until the reader resolves it. Always removes the request
   * from `outstanding` on the first terminal action (resolved or
   * rejected) — see {@link wrapTerminal}.
   */
  private async dispatchSend(peerIdStr: string, req: PendingRequest): Promise<void> {
    // Wrap resolve/reject so the outstanding-set is cleaned up
    // exactly once regardless of which path resolves the request.
    this.wrapTerminal(req);

    // Pre-dial abort fast-path. Codex PR #560 round-2 review caught
    // this: if the caller's signal is already aborted by the time
    // dispatchSend runs, we MUST reject before doing any work — not
    // attempt the dial, not queue the request, not write on the
    // wire. Otherwise the request silently outlives the caller's
    // cancel budget.
    if (req.signal?.aborted) {
      req.reject(new Error('request aborted'));
      return;
    }

    // Race the shared open against this caller's signal. Codex PR
    // #560 round 4: `getOrOpenPeer` is shared infrastructure that
    // doesn't observe per-caller cancellation (otherwise one caller's
    // timeout would abort the dial for everyone). To let an aborting
    // caller reject IMMEDIATELY without waiting for the dial to
    // complete, we race the open against an abort-signal-driven
    // promise. The dial itself continues for the other waiters.
    let state: PerPeerState;
    try {
      const openPromise = this.getOrOpenPeer(peerIdStr, req.signal);
      if (req.signal) {
        const abortPromise = new Promise<never>((_, rej) => {
          if (req.signal!.aborted) {
            rej(new Error('request aborted'));
            return;
          }
          const onAbort = (): void => rej(new Error('request aborted'));
          req.signal!.addEventListener('abort', onAbort, { once: true });
        });
        state = await Promise.race([openPromise, abortPromise]);
      } else {
        state = await openPromise;
      }
    } catch (err) {
      // Caller-abort surfaces here as 'request aborted'; pass through
      // verbatim. Dial / prime failures surface as the underlying
      // error wrapped in a PooledStreamResetError.
      if (err instanceof Error && err.message === 'request aborted') {
        req.reject(err);
      } else {
        req.reject(this.toResetError(err, 'open failed'));
      }
      return;
    }

    // Belt-and-suspenders: re-check after the await — covers the
    // race where the signal aborts between `Promise.race` resolving
    // (with the open) and this line running.
    if (req.signal?.aborted) {
      req.reject(new Error('request aborted'));
      return;
    }

    if (this.closed || state.closed) {
      req.reject(new PooledStreamResetError('pool closed'));
      return;
    }

    if (req.signal) {
      const onAbort = (): void => {
        // Caller cancelled. Three cases:
        //
        //   1. Request still queued — splice out, reject the caller's
        //      promise. The stream and other peers are unaffected.
        //
        //   2. Request in-flight — we cannot let `state.inFlight` stay
        //      pointed at the cancelled request: the remote will
        //      eventually send a response frame for THIS request, and
        //      since the pool serialises (one in-flight at a time)
        //      every later send queues behind it, waiting forever for
        //      a response that's already been delivered to nobody.
        //      Codex PR #560 round-1 review caught this — one cancel
        //      poisons every subsequent send to the same peer.
        //
        //      Fix: treat in-flight cancel as a stream reset. Reject
        //      every pending request with a recoverable error so the
        //      substrate outbox retries them on a fresh stream, then
        //      tear down state via the standard reader-end path.
        //      The next send opens a clean stream.
        //
        //   3. Request neither queued nor in-flight (dispatchSend not
        //      yet awaited / already settled). No-op — `wrapTerminal`
        //      ensures resolve/reject is idempotent.
        if (state.inFlight === req) {
          req.reject(new Error('request aborted'));
          this.handleReaderEnd(
            state,
            new PooledStreamResetError('in-flight request aborted'),
          ).catch(() => undefined);
          return;
        }
        const idx = state.queue.indexOf(req);
        if (idx !== -1) {
          state.queue.splice(idx, 1);
          req.reject(new Error('request aborted'));
        }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      req.abortListener = onAbort;
    }

    state.queue.push(req);
    try {
      await this.maybePumpNext(state);
    } catch (err) {
      // maybePumpNext routes write failures through req.reject; this
      // catch is defensive against unexpected throws (shouldn't fire).
      req.reject(this.toResetError(err, 'pump failed'));
    }
  }

  /**
   * Replace `req.resolve` / `req.reject` with shims that also remove
   * the request from {@link outstanding} on first terminal action.
   * Idempotent — only the first call to resolve OR reject does the
   * cleanup; subsequent calls are no-ops.
   */
  private wrapTerminal(req: PendingRequest): void {
    const origResolve = req.resolve;
    const origReject = req.reject;
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      this.outstanding.delete(req);
    };
    req.resolve = (v) => {
      cleanup();
      origResolve(v);
    };
    req.reject = (e) => {
      cleanup();
      origReject(e);
    };
  }

  /**
   * Register the inbound handler for pooled streams. Called once at
   * daemon setup; idempotent re-registration overwrites the handler
   * but does NOT re-register the libp2p handle (which is also
   * idempotent on the libp2p side — `handle()` overwrites).
   */
  registerHandler(handler: PooledStreamHandler): void {
    this.inboundHandler = handler;
    if (this.inboundRegistered) return;
    this.inboundRegistered = true;
    this.node.libp2p.handle(
      this.protocolId,
      (stream, connection) => {
        // Pass the WHOLE `remotePeer` object through (not just its
        // string form) so application handlers can call methods
        // like `.toBytes()` / `.toMultihash()` exactly as they do
        // on the one-shot path. Codex PR #560 round-3 caught this:
        // previously only `.toString()` was threaded, which meant
        // pooled traffic broke handlers that worked on one-shot.
        this.handleInboundStream(stream, connection.remotePeer).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[MessageStreamPool] inbound stream error on ${this.protocolId}:`,
            err instanceof Error ? err.message : err,
          );
        });
      },
      { runOnLimitedConnection: true },
    );
  }

  /** Diagnostics: number of peers with an active stream. */
  size(): number {
    return this.peers.size;
  }

  /** Diagnostics: per-peer state snapshot. */
  stats(peerIdStr: string): PerPeerStats | undefined {
    const state = this.peers.get(peerIdStr);
    if (!state) return undefined;
    const now = this.clock();
    const openedAt = this.peerOpenedAt.get(peerIdStr) ?? now;
    return {
      peerIdStr,
      inFlight: state.inFlight !== null,
      queueDepth: state.queue.length,
      framesSent: state.framesSent,
      framesReceived: state.framesReceived,
      bytesSent: state.bytesSent,
      bytesReceived: state.bytesReceived,
      ageMs: now - openedAt,
      lastActivityAgoMs: now - state.lastActivityAt,
    };
  }

  /**
   * Close every pooled stream and reject all pending requests.
   * Safe to call multiple times. After close, further `send()` calls
   * throw {@link PooledStreamResetError}.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.inboundRegistered) {
      try {
        this.node.libp2p.unhandle(this.protocolId);
      } catch {
        // libp2p may already have torn down; ignore.
      }
      this.inboundRegistered = false;
    }
    const peers = [...this.peers.values()];
    for (const state of peers) {
      await this.closePeer(state, 'pool closed');
    }
    // Reject any remaining outstanding requests — covers the
    // "dial still in flight when close fires" race + any request
    // that wasn't installed in a peer state yet.
    const stragglers = [...this.outstanding];
    this.outstanding.clear();
    for (const req of stragglers) {
      try {
        req.reject(new PooledStreamResetError('pool closed'));
      } catch {
        // already settled
      }
    }
    this.peers.clear();
    this.peerOpenedAt.clear();
    this.openLocks.clear();
  }

  // ---------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------

  private async getOrOpenPeer(
    peerIdStr: string,
    _signal?: AbortSignal,
  ): Promise<PerPeerState> {
    // NOTE: `_signal` is intentionally NOT propagated into the
    // dial. Codex PR #560 round-4 caught that openLocks shares one
    // in-flight open across every concurrent caller — and the FIRST
    // caller's signal was the one driving cancellation. If caller A
    // timed out while caller B was still willing to wait, B's dial
    // inherited A's abort and failed even though B's budget was
    // intact.
    //
    // Each caller's individual signal is honored by `dispatchSend`'s
    // post-open abort listener — see round-2 fix. The shared open
    // itself runs to completion regardless of any one caller, with
    // the dial's natural transport timeout providing the upper
    // bound. Callers whose signal aborts while waiting on the
    // shared open are rejected in `dispatchSend`'s post-await
    // abort checkpoint.
    const existing = this.peers.get(peerIdStr);
    if (existing && !existing.closed) return existing;
    const pending = this.openLocks.get(peerIdStr);
    if (pending) return pending;

    const opening = (async (): Promise<PerPeerState> => {
      // Cold-peer priming. The pool dials the wire variant directly
      // via `dialProtocol`, which consults libp2p's peerStore for
      // addresses. If peerStore is empty / stale (the soak-
      // postmortem Window D shape — first contact after a node
      // restart, or after a long quiet), the dial returns
      // "no valid addresses for peer" and the pool fails the open
      // without ever asking the DHT / agent registry / RFC 04
      // routing surface where the peer might be findable.
      //
      // The wrapping `ProtocolRouter` always primes via
      // `peerResolver.resolve` before its one-shot dial — see RFC
      // 07 §3.2. Without the same priming here, enabling pooling
      // would regress first-contact delivery to cold peers.
      //
      // Best-effort: any throw is swallowed (the dial below
      // surfaces a real transport error if the peer is genuinely
      // unreachable; the prime hook's only job is to populate
      // peerStore so the dial CAN reach a routable address).
      if (this.primePeer) {
        try {
          // No caller-bound signal — the shared open is infra,
          // not per-caller. See top-of-method comment.
          await this.primePeer(peerIdStr, {});
        } catch {
          // primePeer never gates the dial — the existing
          // identify-cache path may still resolve.
        }
      }
      const peerId = await this.resolvePeerId(peerIdStr);
      const stream = await this.node.libp2p.dialProtocol(peerId, this.protocolId, {
        runOnLimitedConnection: true,
      });
      // Race-with-close guard. Codex PR #560 round-4 caught: while
      // `dialProtocol` was awaiting, `pool.close()` may have run.
      // `installState` after close would re-create per-peer state
      // (with timers) AFTER shutdown, leaving a stream alive past
      // `closePooling()`. Close the just-opened stream instead.
      if (this.closed) {
        try {
          // Use abort here — close() during shutdown is an error
          // path for the would-be caller, not a graceful peer
          // teardown.
          stream.abort(new Error('pool closed during dial'));
        } catch {
          // already torn down
        }
        throw new PooledStreamResetError('pool closed');
      }
      return this.installState(peerIdStr, stream);
    })();

    this.openLocks.set(peerIdStr, opening);
    try {
      const state = await opening;
      return state;
    } finally {
      // Only delete if we're still the registered open — close()
      // already cleared the map and a new caller might have
      // registered a fresh open in the interim. Idempotent delete
      // is safe regardless.
      if (this.openLocks.get(peerIdStr) === opening) {
        this.openLocks.delete(peerIdStr);
      }
    }
  }

  private async resolvePeerId(peerIdStr: string): Promise<unknown> {
    if (this.peerIdFromStringOverride) return this.peerIdFromStringOverride(peerIdStr);
    if (!this.peerIdFromString) {
      const mod = await import('@libp2p/peer-id');
      this.peerIdFromString = mod.peerIdFromString;
    }
    return this.peerIdFromString(peerIdStr);
  }

  private installState(peerIdStr: string, stream: Stream): PerPeerState {
    const now = this.clock();
    const state: PerPeerState = {
      peerIdStr,
      stream,
      inFlight: null,
      queue: [],
      readerDone: Promise.resolve(),
      lastActivityAt: now,
      keepaliveTimer: null,
      idleTimer: null,
      closed: false,
      framesSent: 0,
      framesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
    };
    this.peers.set(peerIdStr, state);
    this.peerOpenedAt.set(peerIdStr, now);

    state.readerDone = (async () => {
      try {
        await this.runReader(state);
        // Clean EOF: peer closed its write side. Treat as a recoverable
        // reset so any in-flight/queued request rejects via the outbox
        // retry path rather than hanging forever waiting for a
        // response that will never arrive.
        if (!state.closed) {
          await this.handleReaderEnd(state, new PooledStreamResetError('peer closed stream'));
        }
      } catch (err) {
        if (!state.closed) {
          await this.handleReaderEnd(
            state,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    })();

    if (this.keepaliveIntervalMs > 0) {
      state.keepaliveTimer = setInterval(() => {
        this.sendControlFrame(state, FrameType.PING).catch(() => undefined);
      }, this.keepaliveIntervalMs);
      // Allow process to exit even when keepalive is running.
      if (typeof (state.keepaliveTimer as unknown as { unref?: () => void }).unref === 'function') {
        (state.keepaliveTimer as unknown as { unref: () => void }).unref();
      }
    }
    this.armIdleTimer(state);

    return state;
  }

  private armIdleTimer(state: PerPeerState): void {
    if (this.idleTimeoutMs <= 0) return;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (state.closed) return;
      if (state.inFlight !== null || state.queue.length > 0) {
        // Still active — re-arm.
        this.armIdleTimer(state);
        return;
      }
      this.closePeer(state, 'idle timeout').catch(() => undefined);
    }, this.idleTimeoutMs);
    if (typeof (state.idleTimer as unknown as { unref?: () => void }).unref === 'function') {
      (state.idleTimer as unknown as { unref: () => void }).unref();
    }
  }

  private async maybePumpNext(state: PerPeerState): Promise<void> {
    if (state.closed) return;
    if (state.inFlight !== null) return;
    const next = state.queue.shift();
    if (!next) return;
    state.inFlight = next;
    const frame = encodeFrame(FrameType.REQUEST, next.payload);
    try {
      state.stream.send(frame);
      state.framesSent += 1;
      state.bytesSent += frame.length;
      state.lastActivityAt = this.clock();
      this.armIdleTimer(state);
      this.scheduleRequestTimeout(state, next);
    } catch (err) {
      // Failed to write — tear down stream, reject this request +
      // every queued one.
      state.inFlight = null;
      next.reject(this.toResetError(err, 'write failed'));
      await this.handleReaderEnd(state, this.toResetError(err, 'write failed'));
    }
  }

  private scheduleRequestTimeout(state: PerPeerState, req: PendingRequest): void {
    // Per-call timeout takes precedence over the pool-wide default;
    // both 0 and negative disable the timer. Codex PR #560 round-2:
    // previously the per-call value was silently capped at the
    // pool's `requestTimeoutMs` (default 20s).
    const effective = req.perRequestTimeoutMs ?? this.requestTimeoutMs;
    if (effective <= 0) return;
    const t = setTimeout(() => {
      if (state.inFlight !== req) return;
      // Treat as recoverable so the substrate outbox retries.
      const err = new PooledStreamResetError('request timeout');
      state.inFlight = null;
      req.reject(err);
      // Trigger a teardown — a stalled stream is unlikely to recover.
      this.handleReaderEnd(state, err).catch(() => undefined);
    }, effective);
    if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
      (t as unknown as { unref: () => void }).unref();
    }
  }

  private async sendControlFrame(state: PerPeerState, type: FrameType): Promise<void> {
    if (state.closed) return;
    try {
      const frame = encodeFrame(type);
      state.stream.send(frame);
      state.framesSent += 1;
      state.bytesSent += frame.length;
      state.lastActivityAt = this.clock();
    } catch (err) {
      await this.handleReaderEnd(state, this.toResetError(err, 'control frame write failed'));
    }
  }

  private async runReader(state: PerPeerState): Promise<void> {
    for await (const frame of decodeFrames(
      state.stream as unknown as AsyncIterable<Uint8Array>,
      this.maxFrameBytes,
    )) {
      state.framesReceived += 1;
      state.bytesReceived += frame.payload.length + 2; // approximate; framing overhead
      state.lastActivityAt = this.clock();
      this.armIdleTimer(state);
      await this.dispatchInboundFrame(state, frame);
    }
  }

  private async dispatchInboundFrame(state: PerPeerState, frame: DecodedFrame): Promise<void> {
    switch (frame.type) {
      case FrameType.RESPONSE: {
        const req = state.inFlight;
        if (!req) {
          // Spurious response (no matching request). Likely indicates
          // a peer bug; log and ignore — alternative would be tear
          // down which is more disruptive.
          // eslint-disable-next-line no-console
          console.warn(`[MessageStreamPool] orphan RESPONSE from ${state.peerIdStr.slice(-8)}`);
          return;
        }
        state.inFlight = null;
        if (req.abortListener && req.signal) {
          req.signal.removeEventListener('abort', req.abortListener);
        }
        req.resolve(frame.payload);
        // Pump next queued request, if any.
        await this.maybePumpNext(state);
        return;
      }
      case FrameType.ERROR: {
        const req = state.inFlight;
        const msg = new TextDecoder().decode(frame.payload);
        if (!req) {
          // eslint-disable-next-line no-console
          console.warn(`[MessageStreamPool] orphan ERROR from ${state.peerIdStr.slice(-8)}: ${msg}`);
          return;
        }
        state.inFlight = null;
        if (req.abortListener && req.signal) {
          req.signal.removeEventListener('abort', req.abortListener);
        }
        // App errors are NOT pool-level resets; surface as a plain
        // Error so the caller can decide whether to retry / surface.
        req.reject(new Error(msg || 'remote handler error'));
        await this.maybePumpNext(state);
        return;
      }
      case FrameType.PING:
        await this.sendControlFrame(state, FrameType.PONG);
        return;
      case FrameType.PONG:
        // Keepalive ack — nothing to do.
        return;
      case FrameType.REQUEST: {
        // The sender side of a pool receives REQUEST frames only via
        // the inbound stream installed by `registerHandler`. If we
        // see a REQUEST on an outbound stream, the peer is misusing
        // the wire — tear down.
        // eslint-disable-next-line no-console
        console.warn(
          `[MessageStreamPool] unexpected REQUEST on outbound stream from ${state.peerIdStr.slice(-8)}`,
        );
        await this.handleReaderEnd(
          state,
          new PooledStreamResetError('peer sent REQUEST on outbound stream'),
        );
        return;
      }
      default:
        // Unknown frame type — log and continue. Future wire
        // additions should pass through cleanly.
        // eslint-disable-next-line no-console
        console.warn(
          `[MessageStreamPool] unknown frame type ${frame.type} from ${state.peerIdStr.slice(-8)}`,
        );
    }
  }

  private async handleInboundStream(stream: Stream, remotePeer: unknown): Promise<void> {
    const handler = this.inboundHandler;
    if (!handler) {
      // No application handler registered yet — reject the stream
      // cleanly so the dialer surfaces a typed error.
      try {
        stream.abort(new Error('pooled handler not registered'));
      } catch {
        // already torn down
      }
      return;
    }

    // Track whether we exited via clean EOF or an error path so the
    // finally block knows which teardown to use. Codex PR #560
    // round-5: previously the `for await` loop simply returned on
    // remote-side EOF and we never closed our local half. That
    // leaked half-open substream state until the underlying
    // connection died (and circuit-relay reservations along with
    // it). The finally now guarantees the local side is released
    // on every exit path.
    let cleanEof = true;
    try {
      for await (const frame of decodeFrames(
        stream as unknown as AsyncIterable<Uint8Array>,
        this.maxFrameBytes,
      )) {
        if (frame.type === FrameType.PING) {
          try {
            stream.send(encodeFrame(FrameType.PONG));
          } catch {
            return;
          }
          continue;
        }
        if (frame.type === FrameType.PONG) {
          continue;
        }
        if (frame.type !== FrameType.REQUEST) {
          // Unexpected on the inbound side; ignore non-request frame
          // types but keep the stream alive (forward-compat).
          continue;
        }
        // Invoke the application handler. ANY error becomes an ERROR
        // frame back to the caller; we don't propagate handler
        // exceptions to the stream level (which would tear the
        // whole pooled stream down and affect other in-flight
        // requests on this same peer).
        let response: Uint8Array;
        try {
          response = await handler(frame.payload, remotePeer);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            stream.send(encodeFrame(FrameType.ERROR, new TextEncoder().encode(msg)));
          } catch {
            // Stream gone; bail.
            return;
          }
          continue;
        }
        try {
          stream.send(encodeFrame(FrameType.RESPONSE, response));
        } catch {
          // Stream torn down; reader loop will exit on next iter.
          return;
        }
      }
    } catch (err) {
      cleanEof = false;
      // Reader-side decode error or transport error — abort and let
      // the dialer reconnect.
      try {
        stream.abort(err instanceof Error ? err : new Error('reader error'));
      } catch {
        // already torn down
      }
    } finally {
      // Clean EOF: remote half-closed gracefully. Close our local
      // write side too so the substream releases cleanly. Without
      // this, the local half stays open until the underlying
      // connection dies, leaking inbound stream slots and (on
      // circuit-relay-v2) relay reservations.
      if (cleanEof) {
        try {
          await stream.close();
        } catch {
          // already torn down
        }
      }
    }
  }

  /**
   * Tear down per-peer state. `graceful` controls how we signal the
   * tear-down to the remote:
   *
   *   * `graceful: true` (idle expiry / pool close / unregister) —
   *     use `stream.close()` to send a FIN. The remote reader sees
   *     EOF (clean half-close), not RST_STREAM. This matters during
   *     intentional shutdown: a RST surfaces on the remote as a
   *     stream reset, which the remote messenger's substrate (or
   *     ours, on a peer-initiated graceful close) may interpret as
   *     a transport failure worth re-enqueuing — even though the
   *     last delivery was complete. Codex PR #560 round-3 caught
   *     this.
   *
   *   * `graceful: false` (transport error, reader threw, write
   *     failure) — use `stream.abort()` to send RST_STREAM. The
   *     remote sees the error and acts on it (retry / dial fresh).
   *
   * Pending requests are rejected with `PooledStreamResetError`
   * in BOTH cases. The receiver-side dedup-by-messageId from PR
   * #534 catches any duplicate retries the substrate generates on
   * graceful shutdown.
   */
  private async handleReaderEnd(
    state: PerPeerState,
    err: Error,
    opts: { graceful?: boolean } = {},
  ): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.keepaliveTimer = null;
    state.idleTimer = null;

    const wrapped =
      err instanceof PooledStreamResetError ? err : this.toResetError(err, 'stream ended');

    const pending: PendingRequest[] = [];
    if (state.inFlight) pending.push(state.inFlight);
    pending.push(...state.queue);
    state.inFlight = null;
    state.queue = [];
    for (const req of pending) {
      if (req.abortListener && req.signal) {
        req.signal.removeEventListener('abort', req.abortListener);
      }
      req.reject(wrapped);
    }

    try {
      if (opts.graceful) {
        // Best-effort FIN — close() is async, errors during teardown
        // don't matter (the stream is going away regardless).
        await state.stream.close();
      } else {
        state.stream.abort(wrapped);
      }
    } catch {
      // already torn down
    }

    if (this.peers.get(state.peerIdStr) === state) {
      this.peers.delete(state.peerIdStr);
      this.peerOpenedAt.delete(state.peerIdStr);
    }
  }

  private async closePeer(state: PerPeerState, reason: string): Promise<void> {
    if (state.closed) return;
    // Graceful — caller invoked this intentionally (idle expiry,
    // pool close, unregister). Codex PR #560 round-3 fix.
    await this.handleReaderEnd(state, new PooledStreamResetError(reason), { graceful: true });
  }

  private toResetError(err: unknown, fallback: string): PooledStreamResetError {
    if (err instanceof PooledStreamResetError) return err;
    if (err instanceof Error) return new PooledStreamResetError(err.message);
    return new PooledStreamResetError(fallback);
  }
}
