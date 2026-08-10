import { randomUUID } from 'node:crypto';
import { withRetry, withSpan, getMetrics } from '@origintrail-official/dkg-core';
import {
  markSyncLocalRequestFailure,
  markSyncTransportFailure,
  markSyncValidationRejection,
  isSyncValidationRejection,
} from '../sync/error-tags.js';
import {
  recordSyncAttempt,
  recordSyncAttemptRequestBytes,
  recordSyncAttemptResponseBytes,
  syncAttemptAttributes,
  type SyncAttemptOutcome,
  type SyncAttemptPhase,
  type SyncAttemptPlane,
} from '../sync/attempt-telemetry.js';
import type { Messenger } from './messenger.js';

/**
 * Per-attempt sync sender. Production instances must be created with
 * {@link createSingleUseSyncSender} so the router never reuses authenticated
 * envelope bytes before this transport can rebuild them for an outer retry.
 */
export type SingleUseSyncSender = (
  peerId: string,
  protocolId: string,
  data: Uint8Array,
  timeoutMs: number,
  messageId: string,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

/**
 * Own the sync payload-reuse invariant at the sync transport boundary.
 * `messageId` remains part of the callback contract for test/telemetry
 * stability, but raw sync delivery does not use the reliable-message frame.
 */
export function createSingleUseSyncSender(
  messenger: Pick<Messenger, 'sendToPeer'>,
): SingleUseSyncSender {
  return (peerId, protocolId, data, timeoutMs, _messageId, signal) =>
    messenger.sendToPeer(peerId, protocolId, data, {
      timeoutMs,
      payloadReuse: 'single-use',
      signal,
    });
}

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
   * Per-attempt single-use send hook. Receives a fresh `messageId` on every
   * attempt — see jsdoc on `sendSyncRequest` for the rationale. Production
   * callers construct it with `createSingleUseSyncSender`; this helper owns
   * rebuilding the authenticated request between outer retries.
   */
  send: SingleUseSyncSender;
  /**
   * Optional per-attempt response validator. Throwing here keeps the attempt
   * inside `withRetry`, which lets sync-level retry sentinels share the same
   * bounded backoff path as transport failures.
   */
  validateResponse?: (responseBytes: Uint8Array) => void | Promise<void>;
  protocolId: string;
  onRetry: (attempt: number, delay: number, err: unknown) => void;
  /**
   * W1 attempt labels. Both vary per call and are always locally known at the
   * page loop, so they are ordinary parameters — unlike the admission source,
   * which is a property of the enclosing operation and is read from the ambient
   * context (see `sync/attempt-telemetry.ts`). Never a Context Graph or peer id.
   */
  plane: SyncAttemptPlane;
  phase: SyncAttemptPhase;
}

export async function sendSyncRequest(params: SyncSendParams): Promise<Uint8Array> {
  return withSpan(
    'sync.request',
    async () => {
      try {
        const out = await withRetry(
    async () => {
      // Resolved once per attempt so all three W1 points describe the same
      // send, and so the ambient source is read once rather than three times.
      const attributes = syncAttemptAttributes({
        transport: 'legacy',
        plane: params.plane,
        phase: params.phase,
      });
      // `sendStarted` is what makes this an ATTEMPT counter rather than a
      // closure counter. A `finally` on the whole retry closure would fire on
      // five distinct states, three of which move zero bytes (abort before the
      // factory, a factory/signing throw, abort after the factory) — so a
      // signing failure would be reported as a network attempt.
      let sendStarted = false;
      let responded = false;
      let responseByteLength = 0;
      let outcome: SyncAttemptOutcome | undefined;
      try {
        throwIfAborted(params.signal);
        let requestBytes: Uint8Array;
        try {
          requestBytes = await params.requestFactory();
        } catch (error) {
          // A request factory may perform chain reads and signing. Preserve
          // that local boundary so a generic timeout message cannot later be
          // mistaken for an untagged libp2p/router interruption.
          markSyncLocalRequestFailure(error);
          throw error;
        }
        throwIfAborted(params.signal);
        const messageId = randomUUID();
        let responseBytes: Uint8Array;
        sendStarted = true;
        recordSyncAttemptRequestBytes(attributes, requestBytes.byteLength);
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
          // Classified by TERMINAL STATE, never by message text: a deadline
          // `TimeoutError` and a caller cancel reach here as the same
          // `AbortError` shape, and `PooledStreamResetError('request timeout')`
          // is the same class as 'pool closed'. The caller's own signal is the
          // only non-textual evidence of caller cancellation that exists.
          outcome = params.signal?.aborted === true ? 'cancelled' : 'transport_error';
          throw error;
        }
        responded = true;
        responseByteLength = responseBytes.byteLength;
        // Cancellation requested AFTER receipt is still a delivered response:
        // the bytes crossed the wire and cost exactly what a used page costs.
        throwIfAborted(params.signal);
        try {
          await params.validateResponse?.(responseBytes);
        } catch (error) {
          // Tag, never replace — the original error's message drives peer
          // backoff and `failedPhases` accounting downstream.
          markSyncValidationRejection(error);
          throw error;
        }
        throwIfAborted(params.signal);
        outcome = 'response';
        return responseBytes;
      } catch (error) {
        if (outcome === undefined && responded) {
          // The send resolved, so this is a post-receipt failure. Only the
          // validator's own rejection is `validation_rejected`; everything else
          // (a post-receipt abort, a caller-side throw) is still `response`.
          // No message fallback: an untagged error is never guessed from text.
          outcome = isSyncValidationRejection(error) ? 'validation_rejected' : 'response';
        }
        throw error;
      } finally {
        // I1 is finalized HERE, in the surrounding per-attempt `finally`, after
        // validation and cancellation classification. An outcome fixed at send
        // resolution could never later become `validation_rejected`.
        if (sendStarted) {
          const terminal = outcome ?? 'transport_error';
          recordSyncAttempt(attributes, terminal);
          // I3 exists only if the send RESOLVED — including a response the
          // validator rejected, whose bytes were still received and paid for.
          if (responded) {
            recordSyncAttemptResponseBytes(attributes, responseByteLength, terminal);
          }
        }
      }
    },
    {
      maxAttempts: params.retryAttempts,
      baseDelayMs: 1000,
      signal: params.signal,
      isRetryable: () => params.signal?.aborted !== true,
      onRetry: params.onRetry,
    },
        );
        getMetrics().syncRequestTotal.add(1, { outcome: 'ok', protocol_id: params.protocolId });
        return out;
      } catch (err) {
        getMetrics().syncRequestTotal.add(1, { outcome: 'error', protocol_id: params.protocolId });
        throw err;
      }
    },
    { attributes: { 'dkg.protocol_id': params.protocolId } },
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
