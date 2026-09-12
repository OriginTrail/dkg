import {
  isOversizedRdfLiteralError,
  isRecoverableSendError,
} from '@origintrail-official/dkg-core';
import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';

/** Concurrent failures retain their triggering cause and every admitted classification. */
export class SyncFailureGroup extends AggregateError {
  declare readonly syncDenied: boolean;

  constructor(primary: unknown, additional: readonly unknown[]) {
    super([primary, ...additional], primary instanceof Error
      ? `Concurrent sync failures: ${primary.message}`
      : 'Concurrent sync operations failed', { cause: primary });
    Object.freeze(this.errors);
    Object.defineProperty(this, 'syncDenied', {
      enumerable: true,
      configurable: true,
      get: () => syncFailureCauseView(this).anyLeafCause(readSyncDenied),
    });
  }
}

/** Preserve single-error identity, including frozen errors tagged through side channels. */
export function combineSyncFailures(primary: unknown, additional: readonly unknown[]): unknown {
  const unique = [...new Set([primary, ...additional])];
  return unique.length === 1 ? primary : new SyncFailureGroup(primary, unique.slice(1));
}

/** One traversal owns nested groups; classification selects its aggregation rule. */
function syncFailureCauseView(error: unknown) {
  const causes: unknown[] = [];
  const leaves: unknown[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const cause = pending.pop();
    if (seen.has(cause)) continue;
    seen.add(cause);
    causes.push(cause);
    if (cause instanceof SyncFailureGroup) {
      for (let index = cause.errors.length - 1; index >= 0; index--) pending.push(cause.errors[index]);
    } else {
      leaves.push(cause);
    }
  }
  return {
    anyCause: (predicate: (cause: unknown) => boolean) => causes.some(predicate),
    anyLeafCause: (predicate: (cause: unknown) => boolean) => leaves.some(predicate),
    everyCause: (predicate: (cause: unknown) => boolean) => leaves.length > 0 && leaves.every(predicate),
  };
}

function readSyncDenied(error: unknown): boolean {
  try { return Boolean(isTaggableThrowable(error) && (error as { syncDenied?: boolean }).syncDenied); }
  catch { return false; }
}

export function isSyncDeniedError(error: unknown): boolean {
  return syncFailureCauseView(error).anyCause(readSyncDenied);
}

type SyncErrorTag =
  | 'syncPeerResponded'
  | 'syncTransportFailure'
  | 'syncValidationRejected'
  | 'syncLocalRequestFailure';

type TaggedSyncThrowable = object;

const syncErrorTagSideChannels: Record<SyncErrorTag, WeakSet<object>> = {
  syncPeerResponded: new WeakSet(),
  syncTransportFailure: new WeakSet(),
  syncValidationRejected: new WeakSet(),
  syncLocalRequestFailure: new WeakSet(),
};

function isTaggableThrowable(error: unknown): error is object {
  return error !== null && (typeof error === 'object' || typeof error === 'function');
}

function toTaggedSyncError(error: unknown, tag: SyncErrorTag): TaggedSyncThrowable {
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

function hasOwnSyncErrorTag(error: unknown, tag: SyncErrorTag): boolean {
  if (!isTaggableThrowable(error)) return false;
  if (syncErrorTagSideChannels[tag].has(error)) return true;
  try {
    if ((error as Record<string, unknown>)[tag]) return true;
  } catch {
    // An unreadable own property must not hide classified concurrent causes.
  }
  return false;
}

function hasSyncErrorTag(error: unknown, tag: SyncErrorTag): boolean {
  return syncFailureCauseView(error).anyCause(cause => hasOwnSyncErrorTag(cause, tag));
}

export function toSyncPeerRespondedError<T extends object>(error: T): T;
export function toSyncPeerRespondedError(error: unknown): TaggedSyncThrowable;
export function toSyncPeerRespondedError(error: unknown): TaggedSyncThrowable {
  return toTaggedSyncError(error, 'syncPeerResponded');
}

export function toSyncTransportFailureError<T extends object>(error: T): T;
export function toSyncTransportFailureError(error: unknown): TaggedSyncThrowable;
export function toSyncTransportFailureError(error: unknown): TaggedSyncThrowable {
  return toTaggedSyncError(error, 'syncTransportFailure');
}

export function toSyncLocalRequestFailureError<T extends object>(error: T): T;
export function toSyncLocalRequestFailureError(error: unknown): TaggedSyncThrowable;
export function toSyncLocalRequestFailureError(error: unknown): TaggedSyncThrowable {
  return toTaggedSyncError(error, 'syncLocalRequestFailure');
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
export function toSyncValidationRejectionError<T extends object>(error: T): T;
export function toSyncValidationRejectionError(error: unknown): TaggedSyncThrowable;
export function toSyncValidationRejectionError(error: unknown): TaggedSyncThrowable {
  return toTaggedSyncError(error, 'syncValidationRejected');
}

export function isSyncValidationRejection(error: unknown): boolean {
  return hasSyncErrorTag(error, 'syncValidationRejected');
}

export function didSyncPeerRespond(error: unknown): boolean {
  if (hasSyncErrorTag(error, 'syncPeerResponded')) return true;
  return isSyncDeniedError(error);
}

export function isSyncTransportFailure(error: unknown): boolean {
  return hasSyncErrorTag(error, 'syncTransportFailure');
}

function syncErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.toLowerCase()
    : String(error).toLowerCase();
}

/**
 * A retryable interruption of the DKG peer transport itself.
 *
 * The explicit tag is authoritative. Untagged errors delegate to Core's
 * canonical recoverable-send classifier so Messenger, ProtocolRouter and sync
 * cannot drift onto separate libp2p/router message lists. Negative evidence
 * wins: a response-side rejection, chain RPC/local request construction
 * failure, or caller abort must never be reclassified by message.
 */
export function isKnownRetryableSyncTransportInterruption(error: unknown): boolean {
  const causes = syncFailureCauseView(error);
  if (causes.anyCause(cause =>
    hasOwnSyncErrorTag(cause, 'syncValidationRejected')
    || hasOwnSyncErrorTag(cause, 'syncPeerResponded')
    || readSyncDenied(cause)
    || isChainRpcTransportError(cause)
    || hasOwnSyncErrorTag(cause, 'syncLocalRequestFailure')
  )) return false;

  return causes.everyCause(isRetryableTransportLeaf);
}

function isRetryableTransportLeaf(error: unknown): boolean {
  // The transport boundary is authoritative even when its deadline surfaces
  // as AbortError. Caller/node cancellation is rejected separately by the
  // requester's live signal before this classifier is consulted.
  if (hasOwnSyncErrorTag(error, 'syncTransportFailure')) return true;

  // Never infer an untagged AbortError from message text: the same shape is
  // used for caller cancellation and transport deadlines.
  if (error instanceof Error && error.name === 'AbortError') return false;

  return isRecoverableSendError(error);
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
  return syncFailureCauseView(error).anyCause(isOversizedRdfLiteralError);
}

export function isSyncBackoffWorthyError(error: unknown): boolean {
  return syncFailureCauseView(error).anyCause(isBackoffWorthyLeaf);
}

function isBackoffWorthyLeaf(error: unknown): boolean {
  if (
    hasOwnSyncErrorTag(error, 'syncTransportFailure')
    || isChainRpcTransportError(error)
    || isRecoverableSendError(error)
  ) return true;

  const message = syncErrorMessage(error);

  return (
    message.includes('too many active durable data sync session snapshots') ||
    (message.includes('sync responder') && (
      message.includes('queue full') ||
      message.includes('queue wait exceeded') ||
      message.includes('snapshot limit exceeded') ||
      message.includes('busy')
    ))
  );
}
