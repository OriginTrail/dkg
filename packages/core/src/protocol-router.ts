import type { Stream } from '@libp2p/interface';
import type { StreamHandler as DKGStreamHandler } from './types.js';
import type { DKGNode } from './node.js';
import type { PeerResolver } from './network/peer-resolver.js';
import {
  MessageStreamPool,
  POOLED_MESSAGE_PROTOCOL,
  type MessageStreamPoolOptions,
} from './message-stream-pool.js';
import { withSpan, getMetrics } from './telemetry-api.js';

type AbortableByteStream = Stream | (AsyncIterable<Uint8Array> & { abort(reason?: unknown): void });

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
    msg.includes('send timeout') ||
    msg.includes('operation timed out') ||
    msg.includes('operation was aborted due to timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('aborted') ||
    msg.includes('no valid addresses') ||
    (msg.includes('sync responder') &&
      (msg.includes('queue full') ||
        msg.includes('queue wait exceeded'))) ||
    // libp2p dial exhaustion — every known multiaddr for the peer
    // failed in one attempt. Surfaced by `transportManager.dial` and
    // by `dialProtocol` after iterating every relay/transport
    // candidate. Classifying as recoverable lets the substrate
    // outbox queue + retry via PR-5's DHT-walk-on-stall, which
    // re-resolves the peer's addresses against the routing layer.
    //
    // Without this, an instantaneous routing-table miss (peer's
    // addresses momentarily absent from local libp2p peerStore)
    // becomes a terminal application-level loss. The May 2026
    // multi-node soak surfaced 50/57 of all sender-side hard fails
    // in this class — making this single string the highest-impact
    // gap-closer toward the 99.9% delivery SLO.
    msg.includes('all multiaddr dials failed') ||
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
   * Whether these exact payload bytes may be reused by router-level delivery
   * optimizations. Defaults to `reusable`.
   *
   * `single-use` forces the one-shot transport, disables internal retries, and
   * rejects multi-path fan-out. Use it for authenticated envelopes containing
   * a single-use nonce; any retry must happen above `ProtocolRouter` after the
   * caller rebuilds the payload.
   */
  payloadReuse?: 'reusable' | 'single-use';
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
  /** Optional caller cancellation signal composed with timeout and node stop. */
  signal?: AbortSignal;
}

export interface AdmissionCheckOptions {
  /** Shared operation cancellation signal; admission must not outlive the caller. */
  signal?: AbortSignal;
  /** Remaining operation timeout for admission probes that need their own timer. */
  timeoutMs?: number;
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
  /**
   * Optional app-protocol admission gate. When present, every DKG
   * request/response protocol is checked before outbound dial/reuse and
   * before inbound application handler dispatch, including pooled handlers.
   *
   * Use `admissionExemptProtocols` for narrow pre-admission protocols such as
   * a network-identity probe. The hook may be async: production admission can
   * distinguish an unknown peer from a rejected peer by running an exempt proof
   * before the app protocol is failed.
   */
  isPeerAccepted?: (
    peerId: string,
    protocolId: string,
    direction: 'inbound' | 'outbound',
    options?: AdmissionCheckOptions,
  ) => boolean | Promise<boolean>;
  admissionExemptProtocols?: Iterable<string>;
}

/** Per-protocol overrides applied to an inbound registration. */
export interface ProtocolRegistrationOptions {
  /**
   * Maximum request bytes buffered before the inbound stream is aborted.
   * Defaults to the router-wide {@link ProtocolRouter.maxReadBytes} value.
   */
  maxReadBytes?: number;
}

export class QuietRetryableHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuietRetryableHandlerError';
  }
}

export class ProtocolRouter {
  private readonly node: DKGNode;
  private readonly peerResolver?: PeerResolver;
  private readonly isPeerAccepted?: ProtocolRouterOptions['isPeerAccepted'];
  private readonly admissionExemptProtocols: ReadonlySet<string>;
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
  /**
   * Relay circuits are reliable for bounded one-shot requests, but opening two
   * authenticated sync streams to the same relay-only peer concurrently makes
   * libp2p race the circuit's stream negotiation. The losing request commonly
   * fails with `Remote closed connection during opening`, then rebuilds and
   * retries the whole authenticated page.
   *
   * Keep one FIFO tail per peer for SINGLE-USE payloads only. Direct peers and
   * reusable payloads retain their existing parallelism, and different relay
   * peers never block one another.
   */
  private readonly relaySingleUseTails = new Map<string, Promise<void>>();

  constructor(node: DKGNode, options?: ProtocolRouterOptions) {
    this.node = node;
    this.peerResolver = options?.peerResolver;
    this.isPeerAccepted = options?.isPeerAccepted;
    this.admissionExemptProtocols = new Set(options?.admissionExemptProtocols ?? []);
    this.maxReadBytes = options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  private async requirePeerAccepted(
    peerId: string,
    protocolId: string,
    direction: 'inbound' | 'outbound',
    options?: AdmissionCheckOptions,
  ): Promise<void> {
    if (!this.isPeerAccepted || this.admissionExemptProtocols.has(protocolId)) return;
    const accepted = await this.isPeerAccepted(peerId, protocolId, direction, options);
    if (accepted) return;
    throw new Error(
      `peer ${peerId.slice(-8)} is not admitted for ${direction} protocol ${protocolId}`,
    );
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
    pool.registerHandler(async (requestData, peerId, options) => {
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
      const handlerSignalScope = composeAbortSignalsScoped(options?.signal, this.node.stopSignal);
      const handlerSignal = handlerSignalScope.signal;
      try {
        if (handlerSignal?.aborted) throw asAbortError(handlerSignal.reason);
        await this.requirePeerAccepted(remote.toString(), logicalProtocolId, 'inbound', {
          signal: handlerSignal,
        });
        const responseData = await handler(requestData, wrappedPeerId, { signal: handlerSignal });
        if (handlerSignal?.aborted) throw asAbortError(handlerSignal.reason);
        return responseData;
      } finally {
        handlerSignalScope.dispose();
      }
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

  register(
    protocolId: string,
    handler: DKGStreamHandler,
    options?: ProtocolRegistrationOptions,
  ): void {
    this.handlers.set(protocolId, handler);
    const libp2p = this.node.libp2p;

    const limit = options?.maxReadBytes ?? this.maxReadBytes;
    libp2p.handle(protocolId, async (stream: Stream, connection) => {
      // Codex (#669#discussion_r3302188320): cache the stopSignal once at
      // handler entry and reuse it for every step of the inbound lifecycle.
      // The previous code re-read `this.node.stopSignal` three times — at
      // the initial read, in the catch-path abort check, and (implicitly)
      // for `stream.close()` (which didn't pass it at all). If `DKGNode.stop()`
      // fires AFTER the request has been read but before the response path
      // finishes, the controller is cleared in `finally`, so the catch-path
      // can see `undefined` and misclassify the shutdown as a real handler
      // error. By caching once we make the whole handler consistently
      // abortable, and `stream.close({ signal })` participates in shutdown.
      const stopSignal = this.node.stopSignal;
      const streamController = new AbortController();
      const onStreamClose = () => {
        if (!streamController.signal.aborted) {
          streamController.abort(new Error('stream closed by peer'));
        }
      };
      stream.addEventListener('close', onStreamClose as EventListener, { once: true });
      const handlerSignalScope = composeAbortSignalsScoped(streamController.signal, stopSignal);
      const handlerSignal = handlerSignalScope.signal;
      try {
        const remotePeer = connection.remotePeer.toString();
        const requestData = await readAllWithSignal(stream, limit, handlerSignal);
        await this.requirePeerAccepted(remotePeer, protocolId, 'inbound', {
          signal: handlerSignal,
        });
        const peerId = {
          toString: () => remotePeer,
          toBytes: () => connection.remotePeer.toMultihash().bytes,
        };
        if (handlerSignal?.aborted) throw asAbortError(handlerSignal.reason);
        const responseData = await handler(requestData, peerId, { signal: handlerSignal });
        if (handlerSignal?.aborted) throw asAbortError(handlerSignal.reason);
        stream.removeEventListener('close', onStreamClose as EventListener);
        stream.send(responseData);
        await stream.close(stopSignal ? { signal: stopSignal } : undefined);
      } catch (err) {
        if ((stopSignal?.aborted || handlerSignal?.aborted) && isAbortRelatedError(err, handlerSignal, stopSignal)) {
          try {
            const abortReason = stopSignal?.aborted ? stopSignal.reason : handlerSignal?.reason;
            stream.abort(asAbortError(abortReason));
          } catch {
            // stream already closed
          }
          return;
        }
        // F3: peer closed/reset the stream before the response was written —
        // routine churn, not a fault. Downgrade to a quiet warn (no "error"
        // token) so it doesn't spam the node log as a red error line.
        if (err instanceof QuietRetryableHandlerError) {
          try {
            stream.abort(err);
          } catch {
            // stream already closed
          }
          return;
        }
        if (isBenignStreamClosure(err)) {
          console.warn(`[ProtocolRouter] stream closed by peer before response on ${protocolId} from ${connection.remotePeer.toString().slice(-8)}`);
        } else {
          console.error(`[ProtocolRouter] handler error on ${protocolId} from ${connection.remotePeer.toString().slice(-8)}:`, err instanceof Error ? err.message : err);
        }
        try {
          stream.abort(new Error('handler error'));
        } catch {
          // stream already closed
        }
      } finally {
        handlerSignalScope.dispose();
        stream.removeEventListener('close', onStreamClose as EventListener);
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

  // Outbound P2P send — wrapped with a `protocol_router.send` span + the P2P
  // send-duration metric. No-op when telemetry is disabled. The heavy
  // pooled/one-shot logic lives in sendInner; this wrapper only measures.
  async send(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMsOrOpts: number | SendOptions = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const startedAt = Date.now();
    const m = getMetrics();
    try {
      const res = await withSpan(
        'protocol_router.send',
        () => this.sendWithRelaySingleUseAdmission(
          peerIdStr,
          protocolId,
          data,
          timeoutMsOrOpts,
        ),
        { attributes: { 'dkg.protocol_id': protocolId, 'dkg.peer': peerIdStr.slice(0, 8) } },
      );
      m.protocolSendTotal.add(1, { protocol_id: protocolId, outcome: 'ok' });
      return res;
    } catch (err) {
      m.protocolSendTotal.add(1, { protocol_id: protocolId, outcome: 'error' });
      throw err;
    } finally {
      m.protocolSendDuration.record(Date.now() - startedAt, { protocol_id: protocolId });
    }
  }

  private async sendWithRelaySingleUseAdmission(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMsOrOpts: number | SendOptions,
  ): Promise<Uint8Array> {
    const opts: SendOptions = typeof timeoutMsOrOpts === 'number'
      ? { timeoutMs: timeoutMsOrOpts }
      : timeoutMsOrOpts;
    if (
      opts.payloadReuse !== 'single-use'
      || !this.peerHasOnlyRelayedConnections(peerIdStr)
    ) {
      return this.sendInner(peerIdStr, protocolId, data, timeoutMsOrOpts);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    const startedAt = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const callerBudget = composeAbortSignalsScoped(deadline, opts.signal);
    const queueBudget = composeAbortSignalsScoped(callerBudget.signal, this.node.stopSignal);
    let release: (() => void) | undefined;
    try {
      release = await this.acquireRelaySingleUseTurn(
        peerIdStr,
        queueBudget.signal ?? deadline,
      );
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
      if (remainingMs === 0 || deadline.aborted) {
        throw new Error(
          `send timeout: relay single-use queue exhausted the ${timeoutMs}ms budget`,
        );
      }
      return await this.sendInner(peerIdStr, protocolId, data, {
        ...opts,
        timeoutMs: remainingMs,
      });
    } finally {
      release?.();
      queueBudget.dispose();
      callerBudget.dispose();
    }
  }

  private async sendInner(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMsOrOpts: number | SendOptions = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const opts: SendOptions =
      typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    const singleUsePayload = opts.payloadReuse === 'single-use';
    const maxAttempts = singleUsePayload ? 1 : 3;
    const parallelPaths = Math.max(1, Math.floor(opts.parallelPaths ?? 1));
    if (singleUsePayload && parallelPaths > 1) {
      throw new Error('single-use payloads cannot use parallelPaths > 1');
    }
    const overallStartedAt = Date.now();
    const overallDeadline = AbortSignal.timeout(timeoutMs);
    const stopSignal = this.node.stopSignal;
    const budgetSignal = composeAbortSignals(overallDeadline, opts.signal) ?? overallDeadline;
    const overallSignal = composeAbortSignals(budgetSignal, stopSignal) ?? budgetSignal;
    if (overallSignal.aborted) throw asAbortError(overallSignal.reason);
    await this.requirePeerAccepted(peerIdStr, protocolId, 'outbound', {
      signal: overallSignal,
      timeoutMs,
    });

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
    const overlay = this.pooledByLogical.get(protocolId);
    const memoizedVariant = this.peerWireVariantFor(peerIdStr, protocolId);
    // Relay-only gate for the pooled wire. The pooled variant
    // multiplexes every request for a peer onto ONE long-lived
    // substream; over a circuit-relay connection that substream's
    // life is bounded by the relay's reservation churn (~300 s), and
    // one request timeout aborts the shared stream — rejecting every
    // in-flight and queued request at once. Observed on a 10.0.12
    // Base-mainnet edge node (2026-08-06): sync to a NAT-only peer
    // reachable exclusively via circuit relays died 4/4 with "pooled
    // stream reset: request aborted/timeout" while one-shot streams
    // to the same peer succeeded immediately. So: use the pool only
    // when the peer has at least one DIRECT connection. Re-evaluated
    // per send — a later direct connection (e.g. DCUtR upgrade)
    // re-enables the pool with no memo to clear, and a pool stream
    // already held for a now-relay-only peer is retired once
    // quiescent instead of being reused. Cold peers (no connections
    // at all) keep the pooled path: there is no relayed connection
    // to observe yet and the pool's own dial may come up direct.
    // Requester-side selection only — responders that don't
    // advertise the pooled wire already fall back via
    // multistream-select.
    let usePooledWire = overlay !== undefined && memoizedVariant !== 'one-shot';
    if (usePooledWire && overlay && this.peerHasOnlyRelayedConnections(peerIdStr)) {
      usePooledWire = false;
      // Fire-and-forget: retiring the held stream must not delay or
      // fail this send; if the stream is still busy the retire is a
      // no-op and a later send's pass lands it once drained.
      overlay.pool
        .closePeerIfIdle(peerIdStr, 'relay-only peer: pooled wire bypassed')
        .catch(() => undefined);
    }
    if (overlay && usePooledWire) {
      try {
        const remainingForPool = Math.max(0, timeoutMs - (Date.now() - overallStartedAt));
        const response = await overlay.pool.send(peerIdStr, data, {
          // Share the OVERALL deadline so a fall-through to one-shot
          // doesn't get a fresh budget. Codex PR #560 round 4.
          signal: overallSignal,
          // Thread the remaining wall-clock into the pool's own
          // request timer so it lines up with the shared deadline.
          timeoutMs: remainingForPool,
        });
        this.memoizePeerWire(peerIdStr, protocolId, 'pooled');
        return response;
      } catch (err) {
        if (
          overallSignal.aborted ||
          overallDeadline.aborted ||
          stopSignal?.aborted
        ) {
          throw err;
        }
        if (isProtocolUnsupportedError(err)) {
          // Definitive: peer doesn't advertise the pooled wire
          // variant. Pin to one-shot for future sends; fall through
          // to existing single-path / multi-path logic below.
          this.memoizePeerWire(peerIdStr, protocolId, 'one-shot');
        } else if (singleUsePayload) {
          // The authenticated sync envelope is single-use. A pooled request is
          // itself one wire attempt, but after any ambiguous transport failure
          // we MUST NOT fall through and replay those bytes on a one-shot
          // stream. Bubble to sync's outer retry, which rebuilds a fresh signed
          // envelope before trying again. Protocol-unsupported is the one safe
          // fallback above: multistream negotiation fails before payload bytes
          // are written.
          throw err;
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
      const multipathSignalWithStop = overallSignal;
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
        signal: multipathSignalWithStop,
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
    // By default we retry up to 3 times with back-off so the direct connection
    // can stabilise before the next attempt. A single-use payload gets exactly
    // one one-shot attempt and must be rebuilt by its caller before retrying.
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
    // A peer can retain stale direct addresses in peerStore while its only
    // usable path is an already-open inbound relay connection. Preserve the
    // DCUtR safety guard on the first attempt, but once a normal dial has
    // actually failed, allow the next attempt to reuse that live relay.
    // Otherwise all retries repeat the same dead direct-address dials and
    // ignore the one transport path we already know is open.
    let normalDialFailed = false;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        lastErr = new Error('send timeout elapsed');
        throw lastErr;
      }
      const attemptDeadline = AbortSignal.timeout(remaining);
      const attemptSignal = composeAbortSignals(attemptDeadline, overallSignal) ?? attemptDeadline;
      if (attemptSignal.aborted) throw asAbortError(attemptSignal.reason);
      // Track which connection (if any) the fast path picked this
      // attempt so the catch block can blacklist it on failure
      // without needing to inspect stream/connection internals from
      // the error.
      let pickedConnection: ReusableConnection | null = null;
      let attemptedNormalDial = false;
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
            allowLimitedWithDirectAddrs: normalDialFailed,
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
        let stream: Stream;
        if (fastStream) {
          stream = fastStream;
        } else {
          attemptedNormalDial = true;
          stream = await libp2p.dialProtocol(peerId, protocolId, {
            runOnLimitedConnection: true,
            signal: attemptSignal,
          });
        }
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
        // PR-6: attemptSignal composes the per-attempt deadline with
        // node.stopSignal, so shutdown aborts the resolver, dial,
        // stream close, and final read consistently.
        const readResponse = await readAllWithSignal(stream, this.maxReadBytes, attemptSignal);
        const response = readResponse;
        const readDurationMs = Date.now() - readStartedAt;
        const totalDurationMs = Date.now() - startedAt;
        if (totalDurationMs > 100) {
          console.warn(`[ProtocolRouter] send ${protocolId} to ${peerIdStr}: dial=${dialDurationMs}ms send=${sendDurationMs}ms read=${readDurationMs}ms total=${totalDurationMs}ms`);
        }
        return response;
      } catch (err: unknown) {
        lastErr = err;
        if (attemptedNormalDial) {
          normalDialFailed = true;
        }
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
        if (attemptSignal.aborted || overallSignal.aborted) throw err;
        if (!isRecoverableSendError(err) || attempt >= maxAttempts - 1) throw err;
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
            if (stopSignal?.aborted) {
              reject(asAbortError(stopSignal.reason));
              return;
            }
            if (!overallDeadline.aborted) {
              reject(asAbortError(overallSignal.reason));
              return;
            }
            reject(new Error(`send timeout: backoff aborted by overall deadline (${timeoutMs}ms)`));
          };
          if (overallSignal.aborted) {
            onAbort();
            return;
          }
          overallSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
    }
    throw lastErr;
  }

  /**
   * Acquire one abortable FIFO turn for a single-use send to a relay-only peer.
   * The caller's already-running overall deadline includes queue wait, so a
   * stalled predecessor cannot silently extend the public send timeout.
   */
  private async acquireRelaySingleUseTurn(
    peerIdStr: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    const predecessor = (this.relaySingleUseTails.get(peerIdStr) ?? Promise.resolve())
      .catch(() => undefined);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = predecessor.then(() => gate);
    this.relaySingleUseTails.set(peerIdStr, tail);

    // Keep the composed tail installed until every predecessor ahead of this
    // turn has settled. A caller may abandon its queued turn before the
    // predecessor finishes; deleting the map entry at that point would let a
    // later send bypass the still-active predecessor and reopen the relay
    // stream collision this admission queue is meant to prevent.
    void tail.then(() => {
      if (this.relaySingleUseTails.get(peerIdStr) === tail) {
        this.relaySingleUseTails.delete(peerIdStr);
      }
    });

    const release = (): void => {
      releaseGate();
    };

    try {
      await waitForPromiseOrAbort(predecessor, signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * True when the peer currently has at least one OPEN connection and
   * every one of them rides a circuit relay. Three shapes:
   *
   *   * a direct connection is present → false (pooling is safe);
   *   * open connections exist, all relayed → true;
   *   * no open connections at all → false — nothing observed yet, so
   *     the caller keeps its existing behavior rather than penalizing
   *     a cold peer for connections it doesn't have.
   *
   * Walks the RAW connection table and filters by `remotePeer`
   * ourselves — same Window D rationale as the one-shot fast path
   * (libp2p's peerId-keyed lookup can return `[]` while the raw walk
   * shows live matching connections). Matching is by peerId string:
   * the router, the pool, and libp2p's `PeerId.toString()` all use
   * the same canonical text form as the peer key.
   */
  private peerHasOnlyRelayedConnections(peerIdStr: string): boolean {
    let all: ReadonlyArray<ObservedConnection>;
    try {
      all = this.node.libp2p.getConnections() as ReadonlyArray<ObservedConnection>;
    } catch {
      return false;
    }
    let sawOpenRelayed = false;
    for (const conn of all) {
      let matches = false;
      try {
        matches = conn.remotePeer?.toString() === peerIdStr;
      } catch {
        matches = false;
      }
      if (!matches) continue;
      if (conn.status && conn.status !== 'open') continue;
      if (!isRelayedConnection(conn)) return false;
      sawOpenRelayed = true;
    }
    return sawOpenRelayed;
  }
}

/**
 * Structural subset of a libp2p `Connection` used for transport-path
 * classification. Kept minimal (and every access defensive) for the
 * same reason as {@link ReusableConnection}: unit tests pass fakes
 * without re-exporting libp2p internals.
 */
interface ObservedConnection {
  status?: string;
  limits?: unknown;
  remotePeer?: { toString: () => string };
  remoteAddr?: { toString: () => string };
}

/**
 * True when the connection reaches the peer via a circuit relay.
 * `remoteAddr` containing the `/p2p-circuit` component is the
 * authoritative signal — a direct connection's remote address never
 * carries it. Fall back to libp2p's limited-connection marker when
 * the address is unavailable (limited ⇒ circuit-relay-v2 in our
 * transport set); absent both signals, classify as direct so the
 * caller defaults to the status quo.
 */
function isRelayedConnection(conn: ObservedConnection): boolean {
  try {
    const addr = conn.remoteAddr?.toString();
    if (typeof addr === 'string' && addr.length > 0) {
      return addr.includes('/p2p-circuit');
    }
  } catch {
    // fall through to the limits marker
  }
  return Boolean(conn.limits);
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
   * Reuse an open limited connection even when peerStore still contains
   * direct addresses. The caller enables this only after a normal dial has
   * failed, proving that the cached direct route is not currently usable.
   */
  allowLimitedWithDirectAddrs?: boolean;
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

  // libp2p does not guarantee that a direct connection precedes a limited
  // relay connection in the raw connection walk. Always prefer direct while
  // preserving the original order within each class.
  const orderedCandidates = [...candidates].sort(
    (a, b) => Number(Boolean(a.limits)) - Number(Boolean(b.limits)),
  );

  for (const conn of orderedCandidates) {
    if (conn.status && conn.status !== 'open') continue;
    if (exclude?.has(conn)) continue;
    if ((conn as unknown as { limits?: unknown }).limits) {
      if (!options.allowLimitedWithDirectAddrs && await peerStoreHasDirectAddrs()) {
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
 * Returns `null` (not `throw`) on path failures so the caller can fall
 * through to single-path within the same logical `send()` call. AbortSignal
 * cancellation is different: shutdown/deadline aborts propagate so the caller
 * does not start a fresh fallback attempt after stop has begun.
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
  if (signal.aborted) throw asAbortError(signal.reason);
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
    return await readAllWithSignal(stream, maxReadBytes, signal);
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
    // to single-path, unless the shared signal was aborted. At that point the
    // caller is stopping or out of budget, so starting a fresh fallback attempt
    // would violate the abort contract.
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
    if (signal.aborted) throw asAbortError(signal.reason);
    return null;
  }

  return { response: winnerResponse, attemptedPaths: picked.length };
}

/**
 * PR-6: AbortSignal-aware exported wrapper. Tests + future call sites
 * use this signature; the internal `readAll` keeps the original
 * (no-signal) shape for callers that don't have a signal handy yet.
 *
 * When `signal` is provided and fires while the for-await is parked
 * waiting for the next chunk, this function aborts the underlying
 * stream and throws an `AbortError`. Without this, a silent peer (e.g.
 * a relay that died mid-transfer) wedges the read forever — which is
 * the root cause of the beacon-01 shutdown deadlock that PR-1 (#655)
 * papers over with a hard timeout.
 *
 * Implementation note: we can't pass `signal` to the for-await
 * directly — JavaScript's async iteration protocol has no abort hook.
 * Instead we race the for-await against an abort-listener promise that
 * rejects on signal; on rejection, we call `stream.abort()` which
 * causes the iterator to throw on its next `.next()` call, which
 * propagates the abort error out of the for-await loop naturally.
 */
export async function readAllWithSignal(
  stream: AbortableByteStream,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!signal) return readAll(stream, maxBytes);
  if (signal.aborted) {
    abortStream(stream, signal.reason);
    throw asAbortError(signal.reason);
  }
  let abortListener: (() => void) | undefined;
  const onAbortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      abortStream(stream, signal.reason);
      reject(asAbortError(signal.reason));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([readAll(stream, maxBytes), onAbortPromise]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/**
 * Compose two `AbortSignal`s into a single derived signal that aborts
 * when EITHER input aborts. Used by PR-6 to compose per-attempt
 * deadlines with the node-wide stopSignal so callers don't have to
 * pick which one wins.
 *
 * Uses Node's `AbortSignal.any` when available (Node 20.3+, current
 * production target). Falls back to a manual composer for older Node
 * — keeps tests / older sandboxes working.
 */
export function composeAbortSignals(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const AnyImpl = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (AnyImpl) return AnyImpl([primary, secondary]);
  const combined = new AbortController();
  let settled = false;
  const cleanup = () => {
    primary.removeEventListener('abort', forwardPrimary);
    secondary.removeEventListener('abort', forwardSecondary);
  };
  const forwardPrimary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(primary.reason);
  };
  const forwardSecondary = () => {
    if (settled) return;
    settled = true;
    cleanup();
    combined.abort(secondary.reason);
  };
  if (primary.aborted) combined.abort(primary.reason);
  else if (secondary.aborted) combined.abort(secondary.reason);
  else {
    primary.addEventListener('abort', forwardPrimary, { once: true });
    secondary.addEventListener('abort', forwardSecondary, { once: true });
  }
  return combined.signal;
}

function composeAbortSignalsScoped(
  primary: AbortSignal | undefined,
  secondary: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!primary || !secondary || primary === secondary) {
    return { signal: primary ?? secondary, dispose: () => undefined };
  }
  const combined = new AbortController();
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    primary.removeEventListener('abort', forwardPrimary);
    secondary.removeEventListener('abort', forwardSecondary);
  };
  const forwardPrimary = () => {
    if (!combined.signal.aborted) combined.abort(primary.reason);
    cleanup();
  };
  const forwardSecondary = () => {
    if (!combined.signal.aborted) combined.abort(secondary.reason);
    cleanup();
  };
  if (primary.aborted) {
    combined.abort(primary.reason);
  } else if (secondary.aborted) {
    combined.abort(secondary.reason);
  } else {
    primary.addEventListener('abort', forwardPrimary, { once: true });
    secondary.addEventListener('abort', forwardSecondary, { once: true });
  }
  return { signal: combined.signal, dispose: cleanup };
}

function waitForPromiseOrAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(asAbortError(signal.reason));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(asAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function abortStream(stream: AbortableByteStream, reason: unknown): void {
  if ('abort' in stream && typeof stream.abort === 'function') {
    try {
      stream.abort(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
    } catch {
      /* stream may already be torn down */
    }
  }
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    (err as Error & { name: string }).name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  (err as Error & { name: string }).name = 'AbortError';
  return err;
}

function isAbortRelatedError(
  err: unknown,
  handlerSignal: AbortSignal | undefined,
  stopSignal: AbortSignal | undefined,
): boolean {
  if (err === handlerSignal?.reason || err === stopSignal?.reason) return true;
  const error = err instanceof Error ? err : undefined;
  if (error?.name === 'AbortError') return true;
  const msg = (error?.message ?? String(err)).toLowerCase();
  return msg.includes('aborted') || msg.includes('aborterror');
}

// F3: a peer that closes/resets its side of a stream before we finish
// writing the response surfaces in the inbound handler as a stream-write
// lifecycle error (e.g. "Cannot write to a stream that is closed"), not a
// real handler fault. These are routine during peer churn and shouldn't be
// logged as red errors. Recognise the benign cases so the handler can
// downgrade them.
//
// Match ONLY stream-write / stream-lifecycle signals. We deliberately do
// NOT match broad connection- or muxer-level text ("connection closed",
// "muxer is closed"): a genuine handler bug can throw an error that merely
// mentions a closed connection, and swallowing those would hide real faults
// (Codex). Keep the matcher to the narrow set of phrases that specifically
// denote writing to / reacting on an already-closed or reset stream.
function isBenignStreamClosure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('stream that is closed') ||
    msg.includes('stream is closed') ||
    msg.includes('stream closed') ||
    msg.includes('stream reset') ||
    msg.includes('stream ended') ||
    msg.includes('stream aborted') ||
    msg.includes('writable end') ||
    msg.includes('write after end')
  );
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
