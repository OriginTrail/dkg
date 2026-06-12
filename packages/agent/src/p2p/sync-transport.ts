import { randomUUID } from 'node:crypto';
import { withRetry } from '@origintrail-official/dkg-core';
import { markSyncTransportFailure } from '../sync/error-tags.js';

/**
 * Sync-page transport. Wraps `withRetry` around a per-attempt
 * `requestFactory()` → `send()` chain, freshly minting both the
 * envelope bytes AND the substrate messageId on every attempt.
 *
 * ## Why fresh-per-attempt (rc.9 PR-E codex follow-up #8)
 *
 * Sync's authenticated envelope carries `issuedAtMs` + `requestId`
 * and the responder enforces a freshness TTL (`SYNC_AUTH_MAX_AGE_MS`
 * = 90s) plus per-`requestId` replay protection. Combined with the
 * substrate's 24h-default outbox-retry window, the only design that
 * is correct under all timing scenarios is "fresh envelope + fresh
 * messageId per attempt". The intermediate designs explored on this
 * PR (stable messageId, build-once payload) all had at least one
 * scenario where a stale envelope from one attempt got delivered
 * late, cached under the stable messageId at the receiver, and then
 * replayed onto a later attempt — silently corrupting the sync.
 *
 * Trade-off vs the original "stable messageId for dedup" codex
 * suggestion: we lose sender-side dedup of network-retry storms
 * within a single page-fetch call. In exchange the receiver may run
 * the same SPARQL page query up to `retryAttempts` times if all
 * attempts time out at the same receiver. Sync queries are
 * app-layer idempotent so this is purely a wasted-work concern, not
 * a correctness one — and it's bounded by `syncPageRetryAttempts`.
 *
 * The related concern of "orphaned outbox entries from failed
 * attempts hang around for 24h doing redundant work" is currently
 * unbounded for sync (codex follow-up #9). The `dkg-agent` send
 * adapter previously passed `maxAgeMs: SYNC_AUTH_MAX_AGE_MS -
 * 5_000` to `messenger.sendReliable`, but Codex correctly flagged
 * it as a no-op: `Messenger.sendReliable` does not currently read
 * `opts.maxAgeMs` on the enqueue-failure path, and the underlying
 * `ProtocolOutbox` carries only an instance-wide max-age. The
 * misleading option has since been dropped; the wasted-cycles
 * cost is bounded by `syncPageRetryAttempts` orphaned entries
 * per failed page and is tracked as an rc.10 follow-up to wire
 * per-call max-age end-to-end through the substrate (interface +
 * enqueue/dropExpired + SQLite schema migration). The correctness
 * story is unchanged: fresh-per-attempt messageIds prevent any
 * cached stale denial from replaying onto a later attempt.
 */
interface SyncSendParams {
  remotePeerId: string;
  timeoutMs: number;
  retryAttempts: number;
  signal?: AbortSignal;
  contextGraphId: string;
  offset: number;
  /**
   * Builds the envelope bytes for ONE attempt. Called once per
   * `withRetry` attempt so each attempt carries a fresh
   * `issuedAtMs`/`requestId` (private CGs) — the auth gate at the
   * responder enforces freshness, so re-sending the same envelope
   * past `SYNC_AUTH_MAX_AGE_MS` would be denied.
   */
  requestFactory: () => Promise<Uint8Array>;
  /**
   * Per-attempt send hook. Receives a fresh `messageId` on every
   * attempt — see jsdoc on `sendSyncRequest` for the rationale.
   */
  send: (
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs: number,
    messageId: string,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  /**
   * Optional per-attempt response validator. Throwing here keeps the attempt
   * inside `withRetry`, which lets sync-level retry sentinels share the same
   * bounded backoff path as transport failures.
   */
  validateResponse?: (responseBytes: Uint8Array) => void | Promise<void>;
  protocolId: string;
  onRetry: (attempt: number, delay: number, err: unknown) => void;
}

export async function sendSyncRequest(params: SyncSendParams): Promise<Uint8Array> {
  return withRetry(
    async () => {
      throwIfAborted(params.signal);
      const requestBytes = await params.requestFactory();
      throwIfAborted(params.signal);
      const messageId = randomUUID();
      let responseBytes: Uint8Array;
      try {
        responseBytes = await params.send(
          params.remotePeerId,
          params.protocolId,
          requestBytes,
          params.timeoutMs,
          messageId,
          params.signal,
        );
      } catch (error) {
        markSyncTransportFailure(error);
        throw error;
      }
      throwIfAborted(params.signal);
      await params.validateResponse?.(responseBytes);
      throwIfAborted(params.signal);
      return responseBytes;
    },
    {
      maxAttempts: params.retryAttempts,
      baseDelayMs: 1000,
      signal: params.signal,
      isRetryable: () => params.signal?.aborted !== true,
      onRetry: params.onRetry,
    },
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}
