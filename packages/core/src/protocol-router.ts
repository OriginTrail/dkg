import type { Stream } from '@libp2p/interface';
import type { StreamHandler as DKGStreamHandler } from './types.js';
import type { DKGNode } from './node.js';
import type { PeerResolver } from './network/peer-resolver.js';
import {
  MessageStreamPool,
  POOLED_MESSAGE_PROTOCOL,
  type MessageStreamPoolOptions,
} from './message-stream-pool.js';

/** Default max bytes readAll will buffer before aborting (10 MB). */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;

/** Default timeout for send() (ms). Sync over relay may need longer; callers can pass a higher value. */
export const DEFAULT_SEND_TIMEOUT_MS = 20_000;

/**
 * Returns true if the error is recoverable (retry with backoff).
 * Exported for tests.
 */
export function isRecoverableSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('closed') ||
    msg.includes('reset') ||
    msg.includes('stream returned in closed state') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('aborted') ||
    msg.includes('no valid addresses') ||
    msg.includes('no_reservation') ||
    msg.includes('no reservation') ||
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate')
  );
}

/**
 * Per-call options for {@link ProtocolRouter.send}. Replaces the prior
 * `timeoutMs: number` 4th-arg shape; the number form is still accepted
 * for backwards compat with the rc.8 call sites (rc.9 PR-4).
 */
export interface SendOptions {
  /** Overall send timeout (resolver + dial + write + read). Default {@link DEFAULT_SEND_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Race up to N parallel `newStream` attempts across the peer's live
   * connections (different relay paths where the natural connection
   * list provides them). First successful response wins; loser
   * streams are aborted as soon as the winner is settled.
   *
   * Defaults to **1** (existing single-path behaviour preserved).
   *
   * **SAFETY — this is a wire-version invariant, NOT a runtime check.**
   * `parallelPaths > 1` is only safe for protocols on the
   * `/dkg/10.0.1/*` prefix (or later substrate-managed prefixes)
   * where the receiver registers via `Messenger.register` and
   * dedupes duplicates server-side. Passing `parallelPaths > 1` for
   * a `/dkg/10.0.0/*` protocol can cause the receiver's handler to
   * run multiple times for the same logical request — every caller
   * MUST satisfy this prefix invariant before enabling > 1. The
   * sender cannot inspect the receiver's substrate version; the
   * protocol-prefix string IS the contract (see docs/messenger.md
   * "Versioning" and the rc.9 plan PR-4 invariant note).
   *
   * When fewer than 2 live connections exist for the peer, the
   * multi-path attempt is skipped and `send` falls through to the
   * existing single-path resolver + dialProtocol retry loop. So
   * passing a high `parallelPaths` on a cold peer is harmless —
   * there's just one path available, single-path runs.
   */
  parallelPaths?: number;
}

export interface ProtocolRouterOptions {
  maxReadBytes?: number;
  /**
   * RFC 07 §3.2 — when present, `send()` consults the resolver before
   * dialing so the libp2p peerStore is primed with whatever multiaddrs
   * the resolution order finds (live-conn → DHT → RFC 04 registry →
   * agents-CG). Required for any router that handles agent P2P
   * traffic in production; optional only for local/in-process tests
   * that exclusively talk over already-warmed connections.
   *
   * Codex review feedback on PR #497 round 5: keeping this optional
   * makes the cold-peer priming guarantee implicit. Two mitigations
   * are in place:
   *   1. CI grep gate (`scripts/audit-dial-protocol.mjs`, PR-4 of the
   *      RFC 07 rollout) bans raw `dialProtocol(peerId)` calls
   *      outside an allowlist, so any new outbound path is forced
   *      through `ProtocolRouter`.
   *   2. `send()` emits a one-time `console.warn` the first time it
   *      runs without a `peerResolver` configured (see implementation
   *      below), so a misconfiguration is loud at the first cold dial
   *      rather than silently regressing PR-448's class of failures.
   * Together these turn the "any future caller that omits the
   * resolver silently skips priming" risk into a build-time + first-
   * call-time surface.
   */
  peerResolver?: PeerResolver;
}

export class ProtocolRouter {
  private readonly node: DKGNode;
  private readonly peerResolver?: PeerResolver;
  private handlers = new Map<string, DKGStreamHandler>();
  /**
   * One-shot guard: we warn the first time `send()` runs without a
   * `peerResolver` so a misconfigured outbound router is loud, but
   * we don't spam the logs on every subsequent call. Codex PR #497
   * round 5 — see `ProtocolRouterOptions.peerResolver`.
   */
  private warnedMissingResolver = false;
  readonly maxReadBytes: number;
  /**
   * Per-logical-protocol pooled-transport overlay. When a caller
   * invokes `router.enablePooling(logicalProtocolId)`, the router
   * tries the pooled `/dkg/10.0.2/*` wire variant first via
   * `dialProtocol([pooledId, logicalId])`, and reuses a long-lived
   * stream per peer. Receivers that don't advertise the pooled wire
   * variant fall back to the one-shot path within the same `send()`
   * call (libp2p multistream-select picks the best mutual).
   *
   * Stored by LOGICAL protocol id (what the caller passes to
   * `send`/`register`); the value holds the wire variant + the pool
   * instance.
   */
  private readonly pooledByLogical = new Map<string, PooledOverlay>();
  /**
   * Reverse map from WIRE protocol id back to the logical id, so
   * the inbound handler the pool dispatches to can resolve the
   * application handler registered under the logical id.
   */
  private readonly logicalByWire = new Map<string, string>();
  /**
   * Per-peer wire-variant memo. Once a peer has been seen on a
   * specific wire variant for a given logical protocol, subsequent
   * sends skip the dial-with-protocol-list overhead by going
   * directly through the pool (if pooled) or the one-shot path
   * (otherwise). Cleared on stream reset for the pooled side; the
   * one-shot side has no memo to clear because every send re-dials
   * anyway.
   */
  private readonly peerWireVariant = new Map<string, Map<string, 'pooled' | 'one-shot'>>();

  constructor(node: DKGNode, options?: ProtocolRouterOptions) {
    this.node = node;
    this.peerResolver = options?.peerResolver;
    this.maxReadBytes = options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  /**
   * Opt a logical protocol into the pooled transport overlay. After
   * this call:
   *
   *   * `send(peer, logicalId, data)` first attempts the pooled wire
   *     variant `/dkg/10.0.2/message` (or the caller-supplied
   *     `pooledProtocolId`). On multistream-select fallback to the
   *     logical id, the one-shot path runs unchanged. The wire
   *     variant chosen per peer is memoized so subsequent sends
   *     skip the negotiation.
   *
   *   * `register(logicalId, handler)` ALSO registers `handler` on
   *     the pooled wire variant via the pool's inbound handler, so
   *     peers using the pooled wire reach the same application
   *     code.
   *
   * Calling this method is idempotent; second + later calls update
   * the per-pool options (handler is re-registered).
   *
   * `enablePooling` MUST be called BEFORE `register(logicalId,
   * handler)` for the pool's inbound handler to pick up the
   * registration. Re-ordering would silently leave the pooled wire
   * variant unhandled.
   */
  enablePooling(
    logicalProtocolId: string,
    options: Partial<MessageStreamPoolOptions> = {},
  ): void {
    const existing = this.pooledByLogical.get(logicalProtocolId);
    if (existing) {
      // Idempotent — caller might be re-enabling with different
      // options after a hot-reload; honor the latest config by
      // tearing down + reopening (no-op for tests that re-construct).
      // For now, just keep the existing pool and ignore subsequent
      // calls; callers are expected to enable once at startup.
      return;
    }
    const wireProtocolId = options.protocolId ?? POOLED_MESSAGE_PROTOCOL;
    // Wire-id collision guard. Codex PR #560 round-3 review caught
    // that every pool defaults to the same `/dkg/10.0.2/message`
    // wire id. If a SECOND logical protocol opts in without an
    // explicit `options.protocolId`, its `libp2p.handle()` would
    // overwrite the first pool's inbound handler — and inbound
    // traffic for the first logical protocol would silently
    // dispatch to the wrong application handler.
    //
    // We refuse to install a duplicate wire handler. The caller
    // must supply a distinct `options.protocolId` for the second
    // pool (no auto-derived suffix — wire ids are part of the
    // protocol contract, ad-hoc names would break peer interop).
    const claimedBy = this.logicalByWire.get(wireProtocolId);
    if (claimedBy && claimedBy !== logicalProtocolId) {
      throw new Error(
        `enablePooling: wire protocol ${wireProtocolId} is already claimed by ` +
          `logical protocol ${claimedBy}. Pass options.protocolId to use a ` +
          `distinct wire id for ${logicalProtocolId}.`,
      );
    }
    // Thread the router's `peerResolver` into the pool unless the
    // caller already supplied a `primePeer` hook. Without this, the
    // pool would skip resolver priming and regress first-contact
    // delivery to cold peers (Codex PR #560 review). The router's
    // own one-shot path already primes per RFC 07 §3.2; this just
    // keeps the pooled path on parity.
    const peerResolver = this.peerResolver;
    const primePeer =
      options.primePeer ??
      (peerResolver
        ? async (peerIdStr: string, opts: { signal?: AbortSignal }) => {
            await peerResolver
              .resolve(peerIdStr, { signal: opts.signal })
              .catch(() => undefined);
          }
        : undefined);
    const pool = new MessageStreamPool(
      // The node shape required by the pool overlaps with DKGNode but
      // is narrower; pass the node directly (DKGNode satisfies the
      // structural subset PoolNode requires).
      this.node as unknown as Parameters<typeof MessageStreamPool['prototype']['send']>[0] extends never
        ? never
        : ConstructorParameters<typeof MessageStreamPool>[0],
      {
        ...options,
        protocolId: wireProtocolId,
        maxFrameBytes: options.maxFrameBytes ?? this.maxReadBytes,
        primePeer,
      },
    );
    this.pooledByLogical.set(logicalProtocolId, {
      pool,
      wireProtocolId,
      logicalProtocolId,
    });
    this.logicalByWire.set(wireProtocolId, logicalProtocolId);
    // If a handler is already registered for the logical id, wire it
    // through the pool's inbound side right away.
    const handler = this.handlers.get(logicalProtocolId);
    if (handler) {
      this.installPoolInboundHandler(logicalProtocolId, pool);
    }
  }

  private installPoolInboundHandler(
    logicalProtocolId: string,
    pool: MessageStreamPool,
  ): void {
    pool.registerHandler(async (requestData, peerId) => {
      const handler = this.handlers.get(logicalProtocolId);
      if (!handler) {
        throw new Error(`no application handler for ${logicalProtocolId}`);
      }
      // Wrap into the exact same `{ toString, toBytes }` shape the
      // one-shot register() path passes to application handlers
      // (see `register()` ~30 lines below). The pool now threads
      // the REAL `connection.remotePeer` through, so on production
      // traffic this exposes `.toMultihash().bytes` just like
      // one-shot. Tests can pass minimal peer-like objects with
      // only `.toString()` and the wrap still works (toBytes()
      // surfaces a typed error rather than silently corrupting).
      // Codex PR #560 round-3.
      const remote = peerId as {
        toString: () => string;
        toMultihash?: () => { bytes: Uint8Array };
        toBytes?: () => Uint8Array;
      };
      const wrappedPeerId = {
        toString: () => remote.toString(),
        toBytes: () => {
          if (typeof remote.toMultihash === 'function') {
            return remote.toMultihash().bytes;
          }
          if (typeof remote.toBytes === 'function') {
            return remote.toBytes();
          }
          throw new Error('peerId.toBytes not available on pooled handler');
        },
      };
      return handler(requestData, wrappedPeerId);
    });
  }

  /**
   * Diagnostics: snapshot of every pooled overlay (logical id, wire
   * id, peers-with-live-streams). Empty when no protocols are
   * pooled.
   */
  pooledStatus(): Array<{
    logicalProtocolId: string;
    wireProtocolId: string;
    livePeers: number;
  }> {
    return [...this.pooledByLogical.values()].map((overlay) => ({
      logicalProtocolId: overlay.logicalProtocolId,
      wireProtocolId: overlay.wireProtocolId,
      livePeers: overlay.pool.size(),
    }));
  }

  /**
   * Tear down every pooled overlay. Idempotent. The router itself
   * remains usable for one-shot sends after this — pooling is opt-in
   * and reversible. Tests call this in `afterEach`; production
   * daemons call it during shutdown.
   */
  async closePooling(): Promise<void> {
    const overlays = [...this.pooledByLogical.values()];
    this.pooledByLogical.clear();
    this.logicalByWire.clear();
    this.peerWireVariant.clear();
    for (const overlay of overlays) {
      try {
        await overlay.pool.close();
      } catch {
        // ignore — best-effort shutdown
      }
    }
  }

  register(protocolId: string, handler: DKGStreamHandler): void {
    this.handlers.set(protocolId, handler);
    const libp2p = this.node.libp2p;

    const limit = this.maxReadBytes;
    libp2p.handle(protocolId, async (stream: Stream, connection) => {
      try {
        const requestData = await readAll(stream, limit);
        const peerId = {
          toString: () => connection.remotePeer.toString(),
          toBytes: () => connection.remotePeer.toMultihash().bytes,
        };
        const responseData = await handler(requestData, peerId);
        stream.send(responseData);
        await stream.close();
      } catch (err) {
        console.error(`[ProtocolRouter] handler error on ${protocolId} from ${connection.remotePeer.toString().slice(-8)}:`, err instanceof Error ? err.message : err);
        try {
          stream.abort(new Error('handler error'));
        } catch {
          // stream already closed
        }
      }
    }, { runOnLimitedConnection: true });

    // If pooling was enabled for this protocol BEFORE the handler
    // arrived, wire the pool's inbound handler now. (The
    // `enablePooling` path also calls this once when the handler
    // already exists — together they cover both orderings.)
    const overlay = this.pooledByLogical.get(protocolId);
    if (overlay) {
      this.installPoolInboundHandler(protocolId, overlay.pool);
    }
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
    this.node.libp2p.unhandle(protocolId);
    // If a pooled overlay is attached to this logical protocol, tear
    // it down too. Codex PR #560 round-2: leaving the overlay alive
    // means the `/dkg/10.0.2/...` wire handler stays advertised on
    // libp2p, and any peer that already memoized this side as
    // "pooled" will keep dialing the wire variant — but the inbound
    // handler is gone, so each dial answers "no application
    // handler" instead of cleanly falling back. The pool's
    // `close()` `unhandle`s its wire protocol AND rejects every
    // outstanding request with a recoverable error (substrate
    // outbox retries → next dial sees protocol-unsupported → memo
    // flips to one-shot → fallback path runs).
    //
    // Fire-and-forget the async close: `unregister` is sync by
    // contract, and the close is idempotent + safe even if the
    // pool tears down before its handlers detach from libp2p.
    // Errors are swallowed (a teardown failure here doesn't block
    // re-registration).
    const overlay = this.pooledByLogical.get(protocolId);
    if (overlay) {
      this.pooledByLogical.delete(protocolId);
      this.logicalByWire.delete(overlay.pool.pooledProtocolId);
      overlay.pool.close().catch(() => undefined);
    }
    // Clear any per-peer wire-variant memos for this logical
    // protocol. Codex PR #560 round-5 caught: without this, a peer
    // pinned to 'one-shot' for protocol X would stay pinned across
    // unregister + re-register + re-enable-pooling cycles, never
    // renegotiating the pooled wire variant until process restart.
    for (const [_peerId, inner] of this.peerWireVariant) {
      inner.delete(protocolId);
    }
  }

  async send(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMsOrOpts: number | SendOptions = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const opts: SendOptions =
      typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    const parallelPaths = Math.max(1, Math.floor(opts.parallelPaths ?? 1));

    // Pooled overlay short-circuit. When `enablePooling(protocolId)`
    // has been called for this logical protocol AND the peer hasn't
    // been pinned to the one-shot wire variant by a prior fallback,
    // route through the pool. The pool handles its own retry, dial,
    // keepalive, and idle-close semantics, so on success we return
    // directly. On failure that classifies as "peer doesn't speak
    // the pooled wire" (multistream-select negotiate / protocol
    // unsupported), we memoize the peer as one-shot and fall through
    // to the existing one-shot path below — same `send()` call, no
    // user-visible retry. Any OTHER pool error (transient transport,
    // recoverable reset) is bubbled directly to the caller so the
    // substrate outbox can retry; without bubbling we'd convert a
    // genuine transport failure into a phantom one-shot fallback and
    // mask the underlying issue.
    // Overall wall-clock budget guard. Codex PR #560 round-4 caught
    // that the pool branch and the one-shot fallback each got a
    // FRESH `timeoutMs` budget — a slow pool failure followed by a
    // slow one-shot retry could blow the API contract by ~2x. We
    // now stamp the start, share a single AbortSignal across both
    // branches, and compute a remaining-budget that the one-shot
    // fallback honors. The shared signal aborts BOTH the pool
    // attempt and any one-shot retry as soon as the overall budget
    // is exhausted.
    const overallStartedAt = Date.now();
    const overallDeadline = AbortSignal.timeout(timeoutMs);

    const overlay = this.pooledByLogical.get(protocolId);
    const memoizedVariant = this.peerWireVariantFor(peerIdStr, protocolId);
    if (overlay && memoizedVariant !== 'one-shot') {
      try {
        const remainingForPool = Math.max(0, timeoutMs - (Date.now() - overallStartedAt));
        const response = await overlay.pool.send(peerIdStr, data, {
          // Share the OVERALL deadline so a fall-through to one-shot
          // doesn't get a fresh budget. Codex PR #560 round 4.
          signal: overallDeadline,
          // Thread the remaining wall-clock into the pool's own
          // request timer so it lines up with the shared deadline.
          timeoutMs: remainingForPool,
        });
        this.memoizePeerWire(peerIdStr, protocolId, 'pooled');
        return response;
      } catch (err) {
        if (isProtocolUnsupportedError(err)) {
          // Definitive: peer doesn't advertise the pooled wire
          // variant. Pin to one-shot for future sends; fall through
          // to existing single-path / multi-path logic below.
          this.memoizePeerWire(peerIdStr, protocolId, 'one-shot');
        } else if (memoizedVariant === 'pooled') {
          // Peer is KNOWN to speak the pooled wire (we've delivered
          // on it before). This is a transient failure on the held
          // stream — the pool has already torn down state and will
          // reopen on the next call. Bubble the recoverable error
          // so the substrate's outbox retries on the pooled wire
          // rather than silently switching to one-shot (which would
          // pay a fresh dial cost when the next pooled retry would
          // succeed). Codex PR #560 round 1.
          throw err;
        } else {
          // First contact + non-protocol error (no valid addresses,
          // dial timeout, ECONNRESET, etc.). Without this fallback,
          // enabling pooling would regress first-contact delivery
          // versus the one-shot path: one-shot has the full
          // resolver-re-prime + 3x retry budget INTERNAL to a
          // single send, while the pool has just one dial attempt.
          // Codex PR #560 round 1 caught this.
          //
          // Fall through to one-shot WITHOUT memoizing — next send
          // retries the pool, and if it succeeds we transition to
          // pooled steady-state. We only memoize on a definitive
          // negotiation outcome (success → pooled, unsupported →
          // one-shot).
        }
      }
    }

    // One-shot path: reuse the OVERALL wall-clock budget rather
    // than starting a fresh timer. If the pool branch already
    // consumed most of `timeoutMs`, the one-shot retry inherits the
    // remainder — and `overallDeadline` aborts mid-attempt the
    // moment the total budget is exhausted. Codex PR #560 round 4.
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - overallStartedAt));
    if (remainingMs === 0) {
      throw new Error(
        `send timeout: pooled fallback exhausted the ${timeoutMs}ms budget before one-shot attempt`,
      );
    }
    const libp2p = this.node.libp2p;
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(peerIdStr);
    const startedAt = overallStartedAt;

    if (parallelPaths > 1) {
      // Reuse the overall budget rather than starting a fresh one
      // — see comment above. Codex PR #560 round 4.
      const multipathSignal = overallDeadline;
      // Multi-path pre-attempt — race up to N live connections.
      // Returns the response on a winning path, or null if there
      // weren't enough live candidates (or all candidates failed).
      // On null we fall through to the single-path retry loop below
      // so cold peers + total-multipath-failure both keep the rc.8
      // semantics intact.
      const multipathResult = await raceMultiPath({
        getConnections: () =>
          rawGetConnectionsFor(libp2p, peerId),
        protocolId,
        data,
        parallelPaths,
        signal: multipathSignal,
        maxReadBytes: this.maxReadBytes,
      });
      if (multipathResult !== null) {
        const totalDurationMs = Date.now() - startedAt;
        if (totalDurationMs > 100) {
          console.warn(
            `[ProtocolRouter] send ${protocolId} to ${peerIdStr} via multi-path (${multipathResult.attemptedPaths} paths): total=${totalDurationMs}ms`,
          );
        }
        return multipathResult.response;
      }
      // All multi-path candidates failed (or fewer than 2 existed) —
      // fall through to the single-path retry loop. The single-path
      // does resolver-prime + dialProtocol with the full 3x retry
      // budget, so we get cold-peer recovery for free.
    }

    if (!this.peerResolver && !this.warnedMissingResolver) {
      // Codex PR #497 round 5: structural enforcement (CI grep gate)
      // already prevents raw `dialProtocol(peerId)` calls outside an
      // allowlist, but a router constructed without a resolver still
      // silently skips priming. Surface it loudly the first time so a
      // misconfigured outbound path is caught at first cold dial
      // rather than reintroducing PR-448's relay-route failures.
      this.warnedMissingResolver = true;
      console.warn(
        '[ProtocolRouter] send() called without a peerResolver configured. ' +
          'Cold-peer dials will fall back to libp2p\'s identify-cached addresses ' +
          'and may fail to find relay routes (see RFC 07 §3.2 / PR #448). ' +
          'Pass `{ peerResolver }` to the ProtocolRouter constructor for any ' +
          'router that handles agent P2P traffic.',
      );
    }

    // libp2p internally upgrades relay connections to direct during
    // dialProtocol/newStream (peerStore.merge triggers the connection manager
    // to dial the peer directly, closing the relay and any in-flight streams).
    // We retry up to 3 times with back-off so the direct connection can
    // stabilise before the next attempt.
    //
    // Per-call exclude-set for the fast path: when an existing-connection
    // reuse hits a recoverable failure (stream came back live but
    // `send`/`close`/`readAll` blew up — the half-dead-connection case
    // Codex flagged in PR #538), we mark that connection as "tried this
    // round" so the next retry attempt picks a different live candidate
    // or falls through to `dialProtocol`. libp2p's connection table
    // doesn't always prune a torn-down connection between our 500 ms
    // backoff and the next attempt, so without this guard the loop
    // could spend all three retries on the same dead connection without
    // ever exercising the resolver + dialProtocol path that exists
    // specifically to recover from this case.
    const triedConnections = new WeakSet<ReusableConnection>();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        lastErr = new Error('send timeout elapsed');
        throw lastErr;
      }
      const attemptSignal = AbortSignal.timeout(remaining);
      // Track which connection (if any) the fast path picked this
      // attempt so the catch block can blacklist it on failure
      // without needing to inspect stream/connection internals from
      // the error.
      let pickedConnection: ReusableConnection | null = null;
      try {
        // RFC 07 §3.2: re-prime the libp2p peerStore on EVERY attempt.
        //
        // Was originally a single pre-loop call (PR #497) but that left
        // a real cold-dial gap surfaced during the two-laptop debug
        // session that produced PR #517 + the MessageOutbox PR: if the
        // first resolver call landed during a transient routing-table
        // miss (peer's K-bucket entry expired, no live gossip source,
        // DHT walk happened to time out), all 3 dialProtocol attempts
        // hit the same empty peerStore in the next ~1.5s and the loop
        // gave up with `'no valid addresses for peer'` before any DHT
        // advertisement / `connection:open` event from the recipient
        // could populate addresses for a later attempt.
        //
        // Re-running per-attempt is cheap on the warm path (the
        // resolver's step 1 is a sub-millisecond live-connection check
        // that short-circuits when we already have the peer connected
        // or its addresses cached in the peerStore) and only pays the
        // DHT-walk / registry-lookup cost on the cold path — which is
        // exactly the case we want to keep paying for, because that's
        // where address staleness actually hurts. The resolver itself
        // never throws (returns empty array on miss); the dial below
        // surfaces a real transport error if the peer is genuinely
        // unreachable.
        //
        // Codex review feedback on PR #497: pass the same AbortSignal +
        // remaining time budget to the resolver so a caller's
        // `timeoutMs` bounds the entire send (resolver + dial + read).
        // First try the existing-connection fast path: if we already
        // have at least one open connection to this peer (of ANY
        // direction, direct OR circuit-relay-limited), open the new
        // stream on that connection directly via `newStream` instead
        // of going through `dialProtocol`. This sidesteps the entire
        // address-resolution + peerStore lookup path that returns
        // "no valid addresses for peer" when libp2p's peerStore is
        // empty or stale for the peer — the "Window D" failure class
        // identified in the May 2026 Miles↔Lex 6h soak postmortem,
        // where 31 inbound circuit `connection:open` events from peer
        // P over 4 minutes failed to heal any of 20 opportunistic
        // outbound flushes because each one went through dialProtocol
        // and lost the peerStore race.
        //
        // Crucially: when peerStore is empty for P (the Window D
        // shape), the connection-manager-auto-dial side effect of
        // `peerStore.merge` documented at
        // docs/archive/UPSTREAM_ISSUE_DRAFT.md does NOT fire — there
        // are no direct addresses to upgrade to. So this fast path
        // does not introduce the mid-stream-negotiation race the doc
        // warns about; it benefits exactly the case where the doc's
        // race cannot apply.
        //
        // Failure here (connection died between `getConnections` and
        // `newStream`, peer dropped protocol support, etc.) falls
        // through to the dialProtocol path below WITHIN THE SAME
        // ATTEMPT, so we don't waste a retry slot on the fast-path
        // miss.
        // CRITICAL: feed the fast path from a RAW `getConnections()`
        // walk filtered by `remotePeer`, NOT from the peerId-keyed
        // `libp2p.getConnections(peerId)` lookup.
        //
        // The PR #533 diagnostic surface (`PeerDiagnostics`) is
        // explicitly built around the divergence
        // `rawConnectionCount > getConnectionsReturnsForPeer` as the
        // smoking-gun Window D signature: libp2p's peerId-keyed
        // lookup can return `[]` even when a raw walk over all
        // connections shows one or more open connections whose
        // `remotePeer` matches the target peerId. Using the keyed
        // lookup here would make the fast path miss the EXACT case
        // it was built to heal — `tryReuseExistingConnection` would
        // get an empty candidate list, fall through to the resolver
        // + dialProtocol path, and still fail with "no valid
        // addresses for peer". Walk raw, filter ourselves, and
        // accept that we pay the O(N) cost over the whole
        // connection table per send — N is the total open-conn
        // count of the node, typically <100, so the cost is a few
        // microseconds and the correctness win is large.
        const fastResult = await tryReuseExistingConnection(
          () => {
            try {
              const all = libp2p.getConnections() as ReadonlyArray<
                ReusableConnection & {
                  remotePeer?: { equals?: (other: unknown) => boolean };
                }
              >;
              return all.filter((c) => {
                try {
                  return c.remotePeer?.equals?.(peerId) === true;
                } catch {
                  return false;
                }
              });
            } catch {
              return [];
            }
          },
          protocolId,
          attemptSignal,
          {
            // Probe peerStore for non-circuit (direct) addresses; the
            // fast path uses this to gate whether reusing a LIMITED
            // (circuit-relay-v2) connection is safe or whether
            // libp2p's CM is about to auto-upgrade and prune it
            // mid-stream. See the JSDoc inside
            // `tryReuseExistingConnection` + the PR #537 CI
            // postmortem for the DCUtR upgrade race detail.
            peerHasDirectAddrs: async (): Promise<boolean> => {
              const peer = await libp2p.peerStore.get(peerId);
              const addrs = peer.addresses ?? [];
              for (const a of addrs) {
                const ma = a.multiaddr?.toString?.() ?? '';
                if (ma && !ma.includes('/p2p-circuit')) return true;
              }
              return false;
            },
            excludeConnections: triedConnections,
          },
        );
        const fastStream = fastResult?.stream ?? null;
        pickedConnection = fastResult?.connection ?? null;

        if (this.peerResolver && !fastStream) {
          await this.peerResolver
            .resolve(peerIdStr, { signal: attemptSignal, perStepTimeoutMs: remaining })
            .catch(() => undefined);
        }

        const dialStartedAt = Date.now();
        const stream =
          fastStream ??
          (await libp2p.dialProtocol(peerId, protocolId, {
            runOnLimitedConnection: true,
            signal: attemptSignal,
          }));
        const dialDurationMs = Date.now() - dialStartedAt;

        if (stream.writeStatus === 'closed' || stream.writeStatus === 'closing') {
          stream.abort(new Error('stream closed before send'));
          throw new Error('stream returned in closed state');
        }

        const sendStartedAt = Date.now();
        stream.send(data);
        await stream.close({ signal: attemptSignal });
        const sendDurationMs = Date.now() - sendStartedAt;

        const readStartedAt = Date.now();
        const response = await readAll(stream, this.maxReadBytes);
        const readDurationMs = Date.now() - readStartedAt;
        const totalDurationMs = Date.now() - startedAt;
        if (totalDurationMs > 100) {
          console.warn(`[ProtocolRouter] send ${protocolId} to ${peerIdStr}: dial=${dialDurationMs}ms send=${sendDurationMs}ms read=${readDurationMs}ms total=${totalDurationMs}ms`);
        }
        return response;
      } catch (err: unknown) {
        lastErr = err;
        // If this attempt opened the stream via the fast path, mark
        // the underlying connection as tried-and-failed so subsequent
        // attempts don't pick it again. The half-dead-connection case
        // (newStream succeeds, send/readAll blows up because the
        // transport is gone) leaves the connection in libp2p's table
        // for some non-zero time before libp2p's own teardown removes
        // it — without this we'd re-pick the same dead connection on
        // the next attempt and exhaust the retry budget without ever
        // reaching dialProtocol. Codex review of PR #538 / PR #537
        // fast path.
        if (pickedConnection) {
          triedConnections.add(pickedConnection);
        }
        if (!isRecoverableSendError(err) || attempt >= 2) throw err;
        const backoff = (attempt + 1) * 500;
        // Make the backoff abortable so the overall deadline is
        // honored. Codex PR #560 round-5 caught: if the pool burned
        // most of `timeoutMs`, the one-shot retry's fixed 500/1000ms
        // sleep would still push past the deadline before the next
        // attempt could fail loudly. Now: if `overallDeadline` fires
        // during the backoff, we throw immediately rather than
        // continuing into another attempt that's already over budget.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, backoff);
          const onAbort = (): void => {
            clearTimeout(t);
            reject(new Error(`send timeout: backoff aborted by overall deadline (${timeoutMs}ms)`));
          };
          if (overallDeadline.aborted) {
            onAbort();
            return;
          }
          overallDeadline.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
    throw lastErr;
  }
}

/**
 * "Window D" workaround — attempts to open `protocolId` on an EXISTING
 * open connection to `peerId` before paying the address-resolution +
 * `dialProtocol` cost. Returns the stream on success, `null` on any
 * failure (no live connection, `newStream` rejects, stream comes back
 * dead) so the caller can fall through to the dialProtocol path
 * within the same retry attempt.
 *
 * Why a free function and not a method on `ProtocolRouter`:
 *  - Stateless: every input comes from the call site.
 *  - Easier to unit-test in isolation (no `ProtocolRouter` mock setup).
 *  - Keeps the dial-reuse logic adjacent to the hot path in `send()`
 *    so a reader scrolling the file sees the bypass and the fallback
 *    in the same screen.
 *
 * Connection selection: we DELIBERATELY accept the first open
 * connection regardless of direction or transport (`direct` /
 * `relayed` / `limited`). Reasoning:
 *  - Direct connections are always the best choice.
 *  - Limited (circuit-relay-v2) connections are explicitly allowed
 *    via `runOnLimitedConnection: true` here — same flag the
 *    existing `dialProtocol` call uses below — so a limited
 *    connection is a valid stream-carrier for our protocols.
 *  - Filtering "best-first" would add bookkeeping for ~no benefit:
 *    libp2p's `getConnections(peerId)` already orders the returned
 *    list with the most-recently-opened connections first, which
 *    in practice IS the freshest path.
 */
interface ReusableConnection {
  status?: string;
  /**
   * Present (truthy) when libp2p marks this connection as limited
   * (circuit-relay-v2). Limited connections trigger the CM-auto-
   * upgrade race documented in
   * `docs/archive/UPSTREAM_ISSUE_DRAFT.md` if peerStore has direct
   * addresses for the peer; the fast path uses this hint plus the
   * `peerHasDirectAddrs` probe to skip them safely.
   */
  limits?: unknown;
  newStream: (
    protocols: string,
    options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
  ) => Promise<Stream>;
}

/**
 * Options for {@link tryReuseExistingConnection}.
 *
 * `peerHasDirectAddrs` is async + lazy because the fast path only
 * needs it when considering a limited (circuit-relay) candidate;
 * resolving it eagerly would charge a peerStore hop to every
 * fast-path attempt including the common warm-direct-connection
 * happy path. The implementation in `send()` does
 * `peerStore.get(pid).then(p => p.addresses.some(non-circuit))`,
 * defensively returning `false` on miss so the Window D shape
 * (cold-cache, single inbound circuit) still benefits.
 */
interface TryReuseExistingConnectionOptions {
  peerHasDirectAddrs: () => Promise<boolean>;
  /**
   * Connections to skip when iterating candidates.
   *
   * Lives across multiple `tryReuseExistingConnection` calls within
   * the same logical `send()` so a connection that already failed a
   * stream this round isn't picked again on the next retry attempt.
   * libp2p's connection table doesn't always prune a torn-down
   * connection between our recoverable-failure backoff and the next
   * fast-path retry — without this guard, all three retries of a
   * send can be consumed on the same dead connection, never giving
   * the resolver + dialProtocol path a chance to recover.
   *
   * Codex review feedback on PR #538: `fastStream` previously
   * latched a half-dead connection for the whole retry budget.
   */
  excludeConnections?: WeakSet<ReusableConnection>;
}

/**
 * Result of a successful fast-path pick: the freshly-opened stream
 * plus the connection it was opened on. The caller blacklists
 * `connection` via `excludeConnections` on failure so the next
 * retry skips it.
 */
export interface TryReuseExistingConnectionResult {
  stream: Stream;
  connection: ReusableConnection;
}

// Minimal shape we depend on from libp2p — the real `Libp2p` type
// is much richer but using a structural subset lets the unit test
// pass a fake without re-exporting full libp2p internals. Connection
// retrieval is wrapped behind a thunk so the structural type doesn't
// have to mirror libp2p's `getConnections(PeerId)` signature exactly
// (PeerId itself has dozens of methods we don't need).
export async function tryReuseExistingConnection(
  getConnections: () => ReadonlyArray<ReusableConnection>,
  protocolId: string,
  signal: AbortSignal,
  options: TryReuseExistingConnectionOptions,
): Promise<TryReuseExistingConnectionResult | null> {
  let candidates: ReadonlyArray<ReusableConnection> = [];
  try {
    candidates = getConnections();
  } catch {
    return null;
  }
  const exclude = options.excludeConnections;

  // Lazy + memoized peerStore-direct-addrs probe.
  //
  // We only need this when we're about to fast-path through a LIMITED
  // (circuit-relay-v2) connection — limited connections trigger
  // libp2p's connection-manager auto-upgrade race documented in
  // `docs/archive/UPSTREAM_ISSUE_DRAFT.md`: opening a stream on a
  // limited connection calls into the protocol negotiator which
  // calls `peerStore.merge` for the peer's protocols, which causes
  // CM to attempt a direct dial to any direct addresses already in
  // peerStore, which on success prunes the limited connection
  // mid-stream and kills our newly-opened stream. The receiver's
  // `Connection.onIncomingStream → stream.abort` then throws
  // `StreamStateError: Cannot write to a stream that is closing`
  // (surfaced as an unhandled rejection — PR #537 CI failure in
  // `e2e-agents.test.ts > agents exchange encrypted chat through
  // a relay (DCUtR upgrade)`).
  //
  // The Window D case this fast path was designed to heal
  // (May 2026 Miles↔Lex soak postmortem) has an EMPTY peerStore
  // for the peer by definition — the failure signature is
  // dialProtocol returning "no valid addresses for peer". CM
  // cannot auto-upgrade when there's nothing to upgrade to. So
  // the right guard is: skip limited candidates only when
  // peerStore would tell CM to upgrade.
  //
  // For non-limited candidates (direct connections), no upgrade
  // race exists — use them directly without consulting peerStore.
  // For limited candidates, defer the peerStore.get until needed
  // and memoize so we pay at most one async hop per fast-path
  // attempt regardless of how many limited candidates exist.
  let peerStoreHasDirectAddrsMemo: boolean | null = null;
  const peerStoreHasDirectAddrs = async (): Promise<boolean> => {
    if (peerStoreHasDirectAddrsMemo !== null) return peerStoreHasDirectAddrsMemo;
    try {
      const result = await options.peerHasDirectAddrs();
      peerStoreHasDirectAddrsMemo = result;
    } catch {
      // peerStore.get throws on cold-cache miss — Window D shape.
      // Treat as "no direct addrs" so the fast path proceeds.
      peerStoreHasDirectAddrsMemo = false;
    }
    return peerStoreHasDirectAddrsMemo;
  };

  for (const conn of candidates) {
    if (conn.status && conn.status !== 'open') continue;
    if (exclude?.has(conn)) continue;
    if ((conn as unknown as { limits?: unknown }).limits) {
      if (await peerStoreHasDirectAddrs()) {
        continue;
      }
    }
    try {
      const s = await conn.newStream(protocolId, {
        runOnLimitedConnection: true,
        signal,
      });
      if (s.writeStatus === 'closed' || s.writeStatus === 'closing') {
        // The known mid-stream-negotiation race
        // (docs/archive/UPSTREAM_ISSUE_DRAFT.md): newStream came
        // back already-dead because peerStore.merge triggered the
        // connection manager to prune our connection. Abort the
        // dead stream and try the NEXT candidate connection
        // instead of giving up on the fast path entirely — Codex
        // review of PR #537 flagged the original `return null` as
        // disabling the fast path whenever the first candidate
        // happened to be the stale one, which is exactly the
        // Window D shape this PR is meant to heal (libp2p sometimes
        // hands back a torn-down connection alongside a healthy
        // one in the same `getConnections` result). Falling through
        // to `dialProtocol` after the abort can still fail with
        // "no valid addresses" even when another live connection
        // exists in the candidate list. Try the next one first.
        try {
          s.abort(new Error('reused stream returned in closed state'));
        } catch {
          // abort itself can throw on a stream that's racing
          // teardown (StreamStateError). Swallow — the stream is
          // already dead, the only loss is a yamux frame.
        }
        continue;
      }
      return { stream: s, connection: conn };
    } catch {
      // Try the next candidate connection (if any), then fall
      // through to dialProtocol on overall miss. Swallowing here is
      // safe — every error class that's actually fatal to the send
      // (transport down, peer gone) will surface again on
      // dialProtocol, which has the full address-resolution +
      // backoff path to handle it correctly.
      continue;
    }
  }
  return null;
}

/**
 * Internal helper: walk libp2p's raw connection table and return the
 * subset whose `remotePeer` matches `peerId`. Used by both the
 * single-path fast-reuse (`tryReuseExistingConnection`) and the
 * multi-path racer (`raceMultiPath`). Matches the Window D fix's
 * "raw walk not peerId-keyed lookup" rationale documented above.
 */
function rawGetConnectionsFor(
  libp2p: { getConnections: () => ReadonlyArray<unknown> },
  peerId: unknown,
): ReadonlyArray<ReusableConnection> {
  try {
    const all = libp2p.getConnections() as ReadonlyArray<
      ReusableConnection & {
        remotePeer?: { equals?: (other: unknown) => boolean };
      }
    >;
    return all.filter((c) => {
      try {
        return c.remotePeer?.equals?.(peerId) === true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Multi-path send result returned by {@link raceMultiPath}. `null`
 * when the racer didn't run (fewer than 2 live candidates) or every
 * candidate failed — caller falls through to single-path.
 */
export interface MultiPathResult {
  response: Uint8Array;
  /** How many paths were started before the winner settled. Surfaced for diagnostics. */
  attemptedPaths: number;
}

/**
 * Race up to `parallelPaths` parallel `newStream` attempts across the
 * peer's live connections (one stream per connection). First success
 * wins; loser streams are aborted as soon as the winner is settled.
 *
 * Diversity strategy (rc.9 PR-4 v1): take up to N connections from
 * the natural connection list, no relay-grouping yet. In practice
 * multi-reservation gives us one connection per relay, so the
 * natural list already provides path diversity. Relay-grouped
 * selection is a follow-up if Gate B shows duplicate-relay
 * amplification matters.
 *
 * Returns `null` (not `throw`) on every failure mode so the caller
 * can fall through to single-path within the same logical `send()`
 * call. Throwing here would short-circuit the cold-peer recovery
 * path that the single-path resolver + retry loop is built for.
 *
 * SAFETY: caller is responsible for the `/dkg/10.0.1/*` prefix
 * invariant (see {@link SendOptions.parallelPaths}). The receiver
 * MUST run `Messenger.register` to dedupe duplicates; without that,
 * losing-path bytes reaching the receiver cause double-handler
 * invocation. This function does not (and cannot) check.
 */
export async function raceMultiPath(args: {
  getConnections: () => ReadonlyArray<ReusableConnection>;
  protocolId: string;
  data: Uint8Array;
  parallelPaths: number;
  signal: AbortSignal;
  maxReadBytes: number;
}): Promise<MultiPathResult | null> {
  const { protocolId, data, parallelPaths, signal, maxReadBytes } = args;
  const candidates = args.getConnections().filter((c) => !c.status || c.status === 'open');
  if (candidates.length < 2) {
    // Single (or zero) live candidates — multi-path adds no value;
    // the single-path code already handles "one live connection" via
    // its fast-reuse logic. Fall through.
    return null;
  }

  const picked = candidates.slice(0, parallelPaths);
  const streams: Array<{ stream: import('@libp2p/interface').Stream; aborted: boolean } | null> =
    picked.map(() => null);
  let winnerIdx = -1;

  const abortPath = (idx: number, reason: Error): void => {
    const s = streams[idx];
    if (!s || s.aborted) return;
    s.aborted = true;
    try {
      s.stream.abort(reason);
    } catch {
      /* already torn down */
    }
  };

  const abortLosers = (winningIdx: number): void => {
    for (let i = 0; i < streams.length; i++) {
      if (i !== winningIdx) {
        abortPath(i, new Error('multipath: loser path'));
      }
    }
  };

  const attempts = picked.map(async (conn, idx): Promise<Uint8Array> => {
    const stream = await conn.newStream(protocolId, {
      runOnLimitedConnection: true,
      signal,
    });
    streams[idx] = { stream, aborted: false };
    if (winnerIdx !== -1 && winnerIdx !== idx) {
      abortPath(idx, new Error('multipath: late loser path'));
      throw new Error('multipath: loser path');
    }
    if (stream.writeStatus === 'closed' || stream.writeStatus === 'closing') {
      try {
        stream.abort(new Error('multipath: stream returned in closed state'));
      } catch {
        // already torn down
      }
      throw new Error('multipath: stream returned in closed state');
    }
    stream.send(data);
    await stream.close({ signal });
    return await readAll(stream, maxReadBytes);
  });

  let winnerResponse: Uint8Array | null = null;
  try {
    // Promise.any-equivalent that also gives us the winning index.
    winnerResponse = await new Promise<Uint8Array>((resolve, reject) => {
      let rejected = 0;
      const errs: unknown[] = [];
      attempts.forEach((p, i) => {
        p.then((res) => {
          if (winnerIdx === -1) {
            winnerIdx = i;
            abortLosers(i);
            resolve(res);
          } else if (winnerIdx !== i) {
            abortPath(i, new Error('multipath: loser path'));
          }
        }).catch((err) => {
          errs.push(err);
          rejected += 1;
          if (rejected === attempts.length) {
            reject(new AggregateError(errs, 'multipath: all paths failed'));
          }
        });
      });
    });
  } catch {
    // All N attempts failed — return null so caller falls through
    // to single-path. At this point every attempt rejected, so any
    // streams that opened can be aborted synchronously.
    for (const s of streams) {
      if (s && !s.aborted) {
        s.aborted = true;
        try {
          s.stream.abort(new Error('multipath: all paths failed'));
        } catch {
          /* already torn down */
        }
      }
    }
    return null;
  }

  return { response: winnerResponse, attemptedPaths: picked.length };
}

async function readAll(
  stream: Stream | AsyncIterable<Uint8Array>,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.subarray());
    total += buf.length;
    if (total > maxBytes) {
      if ('abort' in stream && typeof (stream as Stream).abort === 'function') {
        (stream as Stream).abort(new Error('read limit exceeded'));
      }
      throw new Error(`Read limit exceeded (${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return concat(chunks);
}

/**
 * Per-(peer, logical-protocol) wire variant memo. Persists across
 * sends to skip redundant negotiation on subsequent calls.
 */
interface PooledOverlay {
  pool: MessageStreamPool;
  wireProtocolId: string;
  logicalProtocolId: string;
}

/**
 * Returns true if `err` looks like a multistream-select / protocol-
 * negotiation failure that justifies falling back to a different
 * wire variant. Conservative — only fall back on errors that
 * specifically mean "the peer doesn't speak this protocol", not on
 * transient transport errors that should retry on the same wire.
 *
 * Exported for tests.
 */
export function isProtocolUnsupportedError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // PooledStreamResetError wraps the underlying message verbatim
  // ("pooled stream reset: <inner>"), so the substrings below
  // match through the wrapper.
  return (
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate') ||
    msg.includes('unsupported protocol') ||
    msg.includes('protocol mismatch')
  );
}

// Helpers attached to ProtocolRouter via prototype assignment after
// the class. Implemented this way to keep the class body readable
// (avoids interleaving the helpers with the long `send` method).
declare module './protocol-router.js' {
  interface ProtocolRouter {
    peerWireVariantFor(peerIdStr: string, logicalProtocolId: string): 'pooled' | 'one-shot' | undefined;
    memoizePeerWire(peerIdStr: string, logicalProtocolId: string, variant: 'pooled' | 'one-shot'): void;
  }
}

ProtocolRouter.prototype.peerWireVariantFor = function (
  this: ProtocolRouter,
  peerIdStr: string,
  logicalProtocolId: string,
): 'pooled' | 'one-shot' | undefined {
  const map = (this as unknown as { peerWireVariant: Map<string, Map<string, 'pooled' | 'one-shot'>> })
    .peerWireVariant;
  return map.get(peerIdStr)?.get(logicalProtocolId);
};

ProtocolRouter.prototype.memoizePeerWire = function (
  this: ProtocolRouter,
  peerIdStr: string,
  logicalProtocolId: string,
  variant: 'pooled' | 'one-shot',
): void {
  const map = (this as unknown as { peerWireVariant: Map<string, Map<string, 'pooled' | 'one-shot'>> })
    .peerWireVariant;
  let inner = map.get(peerIdStr);
  if (!inner) {
    inner = new Map();
    map.set(peerIdStr, inner);
  }
  inner.set(logicalProtocolId, variant);
};

function concat(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
