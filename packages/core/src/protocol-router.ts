import type { Stream } from '@libp2p/interface';
import type { StreamHandler as DKGStreamHandler } from './types.js';
import type { DKGNode } from './node.js';
import type { PeerResolver } from './network/peer-resolver.js';

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
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate')
  );
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

  constructor(node: DKGNode, options?: ProtocolRouterOptions) {
    this.node = node;
    this.peerResolver = options?.peerResolver;
    this.maxReadBytes = options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
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
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
    this.node.libp2p.unhandle(protocolId);
  }

  async send(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const libp2p = this.node.libp2p;
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(peerIdStr);
    const signal = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();

    // RFC 07 §3.2: ensure the libp2p peerStore has fresh multiaddrs
    // before dialing. The resolver's step 1 is a sub-millisecond
    // live-connection check, so this is effectively a no-op when we
    // already have an open connection to the peer; the cost only
    // shows up on cold dials, where it replaces the failure mode of
    // "dialProtocol falls back to stale identify-cached addresses".
    // Best-effort — the resolver itself never throws (it returns an
    // empty array on miss); the caller's dial loop below will surface
    // a real transport error if the peer is genuinely unreachable.
    //
    // Codex review feedback on PR #497: pass the same AbortSignal +
    // remaining time budget to the resolver so a caller's `timeoutMs`
    // bounds the entire send (resolver + dial + read), not just the
    // dial loop. Without this a `timeoutMs: 1000` could block 5s+ on
    // the resolver's default per-step DHT timeout before the dial
    // even starts.
    if (this.peerResolver) {
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
      await this.peerResolver
        .resolve(peerIdStr, { signal, perStepTimeoutMs: remaining })
        .catch(() => undefined);
    } else if (!this.warnedMissingResolver) {
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
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const dialStartedAt = Date.now();
        const stream = await libp2p.dialProtocol(peerId, protocolId, {
          runOnLimitedConnection: true,
          signal,
        });
        const dialDurationMs = Date.now() - dialStartedAt;

        if (stream.writeStatus === 'closed' || stream.writeStatus === 'closing') {
          stream.abort(new Error('stream closed before send'));
          throw new Error('stream returned in closed state');
        }

        const sendStartedAt = Date.now();
        stream.send(data);
        await stream.close({ signal });
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
        if (!isRecoverableSendError(err) || attempt >= 2) throw err;
        const backoff = (attempt + 1) * 500;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
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
