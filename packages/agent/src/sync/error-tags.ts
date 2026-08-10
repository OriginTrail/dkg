import { isOversizedRdfLiteralError } from '@origintrail-official/dkg-core';
import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';

type SyncErrorTag =
  | 'syncPeerResponded'
  | 'syncTransportFailure'
  | 'syncValidationRejected'
  | 'syncLocalRequestFailure';

const syncErrorTagSideChannels: Record<SyncErrorTag, WeakSet<object>> = {
  syncPeerResponded: new WeakSet(),
  syncTransportFailure: new WeakSet(),
  syncValidationRejected: new WeakSet(),
  syncLocalRequestFailure: new WeakSet(),
};

function isTaggableThrowable(error: unknown): error is object {
  return error !== null && (typeof error === 'object' || typeof error === 'function');
}

function markSyncError(error: unknown, tag: SyncErrorTag): unknown {
  // JavaScript permits throwing primitives. Normalize only those values so a
  // catch-and-rethrow boundary can carry authoritative classification without
  // changing the identity, class or stack of ordinary Error/object throwables.
  const taggedError = isTaggableThrowable(error)
    ? error
    : new Error(String(error), { cause: error });
  syncErrorTagSideChannels[tag].add(taggedError);
  try {
    Object.defineProperty(taggedError, tag, {
      configurable: true,
      enumerable: false,
      value: true,
    });
  } catch {
    try {
      (taggedError as Record<string, unknown>)[tag] = true;
    } catch {
      // Frozen/non-extensible values remain tagged by the WeakSet side-channel.
    }
  }
  return taggedError;
}

function hasSyncErrorTag(error: unknown, tag: SyncErrorTag): boolean {
  if (!isTaggableThrowable(error)) return false;
  if (syncErrorTagSideChannels[tag].has(error)) return true;
  try {
    return Boolean((error as Record<string, unknown>)[tag]);
  } catch {
    return false;
  }
}

export function markSyncPeerResponded(error: unknown): unknown {
  return markSyncError(error, 'syncPeerResponded');
}

export function markSyncTransportFailure(error: unknown): unknown {
  return markSyncError(error, 'syncTransportFailure');
}

export function markSyncLocalRequestFailure(error: unknown): unknown {
  return markSyncError(error, 'syncLocalRequestFailure');
}

/**
 * The peer's response ARRIVED and the in-transport validator then rejected it
 * (W1 attempt outcome `validation_rejected`, whose received bytes still count).
 *
 * Object throwables are tagged without replacement: `makeLegacySyncBusyError`'s
 * message is matched by {@link isSyncBackoffWorthyError}, so minting a substitute
 * error would silently change peer backoff, the durable-data verifiable-prefix
 * return and `failedPhases` accounting — a behaviour change dressed as
 * telemetry. Primitive throwables are normalized once at the catch/rethrow
 * boundary because they cannot carry either a property or WeakSet identity.
 *
 * There is no message fallback for this marker. A rejection that reaches the
 * record site untagged is classified by its terminal state, never guessed from
 * text: the deadline/cancel/reset surfaces are indistinguishable by message.
 */
export function markSyncValidationRejection(error: unknown): unknown {
  return markSyncError(error, 'syncValidationRejected');
}

export function isSyncValidationRejection(error: unknown): boolean {
  return hasSyncErrorTag(error, 'syncValidationRejected');
}

export function didSyncPeerRespond(error: unknown): boolean {
  if (hasSyncErrorTag(error, 'syncPeerResponded')) return true;
  try {
    return Boolean(isTaggableThrowable(error) && (error as { syncDenied?: boolean }).syncDenied);
  } catch {
    return false;
  }
}

export function isSyncTransportFailure(error: unknown): boolean {
  return hasSyncErrorTag(error, 'syncTransportFailure');
}

function isSyncLocalRequestFailure(error: unknown): boolean {
  return hasSyncErrorTag(error, 'syncLocalRequestFailure');
}

function syncErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
}

function hasKnownRetryableSyncTransportMessage(error: unknown): boolean {
  const message = syncErrorMessage(error);
  return (
    message.includes('peer-closed-stream') ||
    message.includes('all multiaddr dials failed') ||
    message.includes('stream reset') ||
    message.includes('stream has been reset') ||
    message.includes('remote closed connection during opening') ||
    message.includes('connection reset') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('send timeout') ||
    message.includes('operation timed out') ||
    message.includes('operation was aborted due to timeout')
  );
}

/**
 * A retryable interruption of the DKG peer transport itself.
 *
 * The explicit tag is authoritative while the message fallback covers the
 * small set of libp2p/router errors whose Error can be recreated across a
 * retry/span boundary. Negative evidence wins: a response-side rejection,
 * chain RPC/local request construction failure, or caller abort must never be
 * reclassified merely because its message also contains "timed out".
 */
export function isKnownRetryableSyncTransportInterruption(error: unknown): boolean {
  if (
    isSyncValidationRejection(error)
    || didSyncPeerRespond(error)
    || isChainRpcTransportError(error)
    || isSyncLocalRequestFailure(error)
  ) return false;

  // The transport boundary is authoritative even when its deadline surfaces
  // as AbortError. Caller/node cancellation is rejected separately by the
  // requester's live signal before this classifier is consulted.
  if (isSyncTransportFailure(error)) return true;

  // Never infer an untagged AbortError from message text: the same shape is
  // used for caller cancellation and transport deadlines.
  if (error instanceof Error && error.name === 'AbortError') return false;

  return hasKnownRetryableSyncTransportMessage(error);
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

  const message = syncErrorMessage(error);

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
    hasKnownRetryableSyncTransportMessage(error)
  );
}
