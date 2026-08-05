import { isOversizedRdfLiteralError } from '@origintrail-official/dkg-core';
import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';

type SyncErrorTag = 'syncPeerResponded' | 'syncTransportFailure' | 'syncValidationRejected';

function markSyncError(error: unknown, tag: SyncErrorTag): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    Object.defineProperty(error, tag, {
      configurable: true,
      enumerable: false,
      value: true,
    });
  } catch {
    try {
      (error as Record<string, unknown>)[tag] = true;
    } catch {
      // Best-effort tagging only; never replace the original sync failure.
    }
  }
}

export function markSyncPeerResponded(error: unknown): void {
  markSyncError(error, 'syncPeerResponded');
}

export function markSyncTransportFailure(error: unknown): void {
  markSyncError(error, 'syncTransportFailure');
}

/**
 * The peer's response ARRIVED and the in-transport validator then rejected it
 * (W1 attempt outcome `validation_rejected`, whose received bytes still count).
 *
 * Tagging, never replacing: `makeLegacySyncBusyError`'s message is matched by
 * {@link isSyncBackoffWorthyError}, so minting a substitute error would silently
 * change peer backoff, the durable-data verifiable-prefix return and
 * `failedPhases` accounting — a behaviour change dressed as telemetry. The tag
 * is non-enumerable and best-effort, exactly like the two above.
 *
 * There is no message fallback for this marker. A rejection that reaches the
 * record site untagged is classified by its terminal state, never guessed from
 * text: the deadline/cancel/reset surfaces are indistinguishable by message.
 */
export function markSyncValidationRejection(error: unknown): void {
  markSyncError(error, 'syncValidationRejected');
}

export function isSyncValidationRejection(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { syncValidationRejected?: boolean }).syncValidationRejected);
}

export function didSyncPeerRespond(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { syncPeerResponded?: boolean }).syncPeerResponded ||
    (error as { syncDenied?: boolean }).syncDenied
  ));
}

export function isSyncTransportFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { syncTransportFailure?: boolean }).syncTransportFailure);
}

/**
 * PERMANENT ingest rejection (OT-RFC-56): retrying can never succeed — the
 * content itself violates a protocol invariant (today: the RDF-literal size
 * limit; `OversizedRdfLiteralError` from the store adapters). The sync
 * seams' oversize guard (sync/oversize-filter.ts) should make this
 * unreachable on the ingest paths; when a runner's catch still sees one, a
 * seam was missed — log loudly, never count it toward peer backoff, and
 * expect the same page to fail identically on every retry until the seam is
 * fixed.
 */
export function isSyncPermanentRejection(error: unknown): boolean {
  return isOversizedRdfLiteralError(error);
}

export function isSyncBackoffWorthyError(error: unknown): boolean {
  if (isSyncTransportFailure(error) || isChainRpcTransportError(error)) return true;

  const message = error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();

  return (
    message.includes('too many active durable data sync session snapshots') ||
    (message.includes('sync responder') && (
      message.includes('queue full') ||
      message.includes('queue wait exceeded') ||
      message.includes('snapshot limit exceeded') ||
      message.includes('busy')
    )) ||
    // These libp2p/router surfaces are transport interruptions too, but an
    // outer retry/span boundary can occasionally recreate the Error and lose
    // our non-enumerable syncTransportFailure tag. Keep the message fallback
    // aligned with Messenger's recoverable dial classifier so a successfully
    // received durable prefix is not discarded merely because the final page
    // lost its relay stream.
    message.includes('peer-closed-stream') ||
    message.includes('all multiaddr dials failed') ||
    message.includes('stream reset') ||
    message.includes('connection reset') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('send timeout') ||
    message.includes('operation timed out') ||
    message.includes('operation was aborted due to timeout')
  );
}
