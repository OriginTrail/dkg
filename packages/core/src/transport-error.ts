/**
 * Typed classification of the errors a P2P send can fail with.
 *
 * The protocol router used to decide "is this failure worth retrying?" by
 * lower-casing the error message and testing substrings. That is fragile (it
 * breaks when libp2p rewords a message or a wrapper changes it) and it got one
 * important case wrong: `Protocol selection failed - could not negotiate ...`
 * is what a peer produces when it does NOT speak the protocol at all, yet it
 * sat in the "recoverable, retry with backoff" list, so the router burned its
 * retry budget re-negotiating a protocol the peer had already refused.
 *
 * {@link classifyTransportError} keys on the error's `name` first (libp2p's
 * typed errors and this package's own `PooledStreamResetError`), and keeps
 * message matching only as the last resort for errors that arrive as bare
 * strings or under a generic name (`Error`, `AggregateError`,
 * `InvalidMessageError`, ...). Matching is by `name`, never `instanceof`, so a
 * second copy of `@libp2p/interface` in the dependency tree cannot defeat it.
 *
 * There are three outcomes because the callers need three: a peer that
 * refused the protocol, a transport failure worth trying again, and anything
 * else. What to DO about each is decided in one place,
 * {@link TRANSPORT_ERROR_DISPOSITION}: an explicit `retryNow` / `retryLater`
 * pair per category, checked for exhaustiveness by the compiler. A category is
 * never retryable because of what it is not (not `Unknown`, not
 * `ProtocolUnsupported`), so a newly recognised category cannot start being
 * retried until someone decides that for it.
 *
 * This module deliberately imports nothing from `protocol-router.ts` or
 * `message-stream-pool.ts`, so both can depend on it.
 */

/**
 * What a failed send means for the caller's retry decision.
 *
 * - `ProtocolUnsupported`: the peer refused every offered protocol
 *   (multistream-select `na`). It does not speak the protocol on this wire.
 * - `Transient`: a transport failure the same request can plausibly survive: a
 *   stream, connection or muxer reset or close, the pooled wire tearing down a
 *   stream that carried the request, a transport timeout, an abort, no
 *   dialable address, a relay without a reservation, or the remote sync
 *   responder shedding load. Which of these it was is not something any caller
 *   acts on, so it is not recorded.
 * - `Unknown`: not a transport failure this module recognises.
 */
export type TransportErrorCategory = 'ProtocolUnsupported' | 'Transient' | 'Unknown';

/** What may be done about a failure of one {@link TransportErrorCategory}. */
export interface TransportRetryDisposition {
  /**
   * Re-send the same request on the same protocol right away, with the
   * router's backoff (the in-line retry loop of `ProtocolRouter.send`).
   */
  readonly retryNow: boolean;
  /**
   * Keep the failure retryable for a caller that can try again LATER because
   * it holds durable state: the substrate outbox and sync's peer backoff.
   * Every `retryNow` category is also `retryLater`.
   */
  readonly retryLater: boolean;
}

/**
 * The retry policy, category by category. `Readonly<Record<TransportErrorCategory,
 * ...>>` makes it exhaustive at compile time: adding a category to the union
 * without a row here (or a row for something that is not a category) does not
 * compile, so no category can inherit a retry verdict by default.
 *
 * - `ProtocolUnsupported` is `retryLater` only. Re-negotiating a protocol the
 *   peer just refused inside one `send()` only burns the retry budget and the
 *   deadline. But multistream answers `na` between `libp2p.start()` and the
 *   peer's handler registration, and a booting peer cannot be told apart from
 *   one that never will speak the protocol, so a durable queue keeps the
 *   message (and sync keeps the peer) instead of dropping it.
 * - `Unknown` is not retried by anyone.
 * - `Transient` is retried now and later.
 *
 * Exported for tests; production code goes through the predicates below.
 */
export const TRANSPORT_ERROR_DISPOSITION: Readonly<Record<TransportErrorCategory, TransportRetryDisposition>> = {
  ProtocolUnsupported: { retryNow: false, retryLater: true },
  Transient: { retryNow: true, retryLater: true },
  Unknown: { retryNow: false, retryLater: false },
};

/** `err.name` of the peer's "no such protocol" answer (`@libp2p/interface`). */
const UNSUPPORTED_PROTOCOL_ERROR_NAME = 'UnsupportedProtocolError';

/**
 * `err.name` of the pooled wire's stream-teardown error
 * (`PooledStreamResetError` in `message-stream-pool.ts`). It wraps whatever
 * error tore the stream down, so a refusal in its cause is still a refusal.
 */
const POOLED_STREAM_RESET_ERROR_NAME = 'PooledStreamResetError';

/** How many `cause` links {@link classifyTransportError} follows through pool wrappers. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Typed error names of a transient transport failure. Only names whose libp2p
 * default wording the previous substring list already treated as recoverable
 * are listed, so keying on the name changes no verdict: it only stops the
 * verdict depending on the wording. (`@libp2p/interface`: `StreamResetError`
 * "The stream has been reset", `ConnectionClosedError` "The connection is
 * closed", `MuxerClosedError` "The muxer is closed", `StreamAbortedError` "The
 * stream has been aborted"; `libp2p`: `NoValidAddressesError` "The dial request
 * has no valid addresses".) `PooledStreamResetError` is this package's own: the
 * pooled wire's stream-teardown error.
 *
 * Deliberately NOT listed, because the old list did not retry their default
 * wording and mapping them would widen what the router, the Messenger outbox and
 * sync treat as retryable: `TimeoutError` ("Timed out", tcp "Connection timeout
 * after ..."), `StreamStateError`, `ConnectionClosingError`,
 * `ConnectionFailedError`, `DialError`. `AbortError` is also left to the
 * message fallback: callers also use it for their own cancellation, which must
 * not become retryable by name.
 */
const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  POOLED_STREAM_RESET_ERROR_NAME,
  'StreamResetError',
  'ConnectionClosedError',
  'MuxerClosedError',
  'StreamAbortedError',
  'NoValidAddressesError',
]);

/**
 * Every value a send can fail with is untrusted: a thrown object may be a
 * Proxy, a revoked Proxy or carry accessors that throw. These classifiers run
 * inside the catch blocks of the router, the outbox and sync, so a read that
 * throws here would replace the send's real failure with the classifier's own
 * and bypass the handling the verdict was meant to select. All reads of the
 * error therefore go through the guarded helpers below: a property that cannot
 * be read counts as absent.
 */
function readProperty(value: unknown, key: 'name' | 'cause'): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `err.name`, or `''` when it is not a readable string. */
function errorName(err: unknown): string {
  const name = readProperty(err, 'name');
  return typeof name === 'string' ? name : '';
}

/**
 * `err.message` (or the string form of a non-Error), or `''` when it cannot be
 * read or is not a string (a getter can return anything).
 */
function errorMessage(err: unknown): string {
  try {
    const message: unknown = err instanceof Error ? err.message : String(err);
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

/**
 * Message shapes of a peer refusing a protocol. `@libp2p/multistream-select`
 * throws `UnsupportedProtocolError("Protocol selection failed - could not
 * negotiate <protocols>")`; the other two are the wording of older transports.
 * This is the same list `isProtocolUnsupportedError` has always matched, kept
 * for errors that carry no typed name (bare strings, wrappers that kept only
 * the text).
 */
function matchesUnsupportedProtocolMessage(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('protocol selection failed') ||
    lowerMessage.includes('could not negotiate') ||
    lowerMessage.includes('unsupported protocol') ||
    lowerMessage.includes('protocol mismatch')
  );
}

/**
 * Last-resort message matching for errors that carry no useful name: the
 * previous `isRecoverableSendError` substring list, minus the two negotiation
 * entries (those are `ProtocolUnsupported`, checked before this). A match means
 * `Transient`; whether that is worth retrying is
 * `TRANSPORT_ERROR_DISPOSITION`'s decision, not this list's. Needles are
 * lower-case: the caller lower-cases the message.
 *
 * `econnreset`, `stream returned in closed state` and `operation was aborted
 * due to timeout` are contained in `reset`, `closed` and `aborted`. They stay
 * so the list still spells out the wordings it was written for.
 */
const TRANSIENT_MESSAGE_NEEDLES: readonly string[] = [
  // Relay without a reservation for the destination.
  'no_reservation',
  'no reservation',
  // libp2p dial exhaustion: every known multiaddr for the peer failed in one
  // attempt (`transportManager.dial`, or `dialProtocol` after iterating every
  // relay/transport candidate).
  'all multiaddr dials failed',
  'no valid addresses',
  'econnrefused',
  // Transport timeouts.
  'etimedout',
  'send timeout',
  'operation timed out',
  'operation was aborted due to timeout',
  // Stream, connection or muxer closed or reset.
  'closed',
  'reset',
  'stream returned in closed state',
  'econnreset',
  'epipe',
  // Stream or operation aborted.
  'aborted',
];

function matchesTransientMessage(lowerMessage: string): boolean {
  return (
    TRANSIENT_MESSAGE_NEEDLES.some((needle) => lowerMessage.includes(needle)) ||
    // The remote sync responder shed load (queue full / wait exceeded); it
    // accepts the same request a moment later. Both words are required: its
    // other refusals (`snapshot limit exceeded`) are permanent.
    (lowerMessage.includes('sync responder') &&
      (lowerMessage.includes('queue full') || lowerMessage.includes('queue wait exceeded')))
  );
}

function classifyAtDepth(err: unknown, depth: number): TransportErrorCategory {
  const name = errorName(err);
  const lowerMessage = errorMessage(err).toLowerCase();

  // "The peer does not speak this protocol" wins over every other reading:
  // it is decided by the typed name, and by the message even under another
  // name, so a wrapper that kept only the text still matches (this is what the
  // in-line pooled -> one-shot wire-variant fallback and the publisher's
  // quorum accounting rely on).
  if (name === UNSUPPORTED_PROTOCOL_ERROR_NAME || matchesUnsupportedProtocolMessage(lowerMessage)) {
    return 'ProtocolUnsupported';
  }

  // The pooled wire wraps whatever tore a stream down, so the wrapped cause
  // may be a refusal the wrapper's own text does not show. Any other cause
  // leaves the wrapper what its name says: a transient reset. A cause that
  // cannot be read is an unspecified one, and the depth bound also ends a
  // cyclic or endless chain.
  if (name === POOLED_STREAM_RESET_ERROR_NAME && depth < MAX_CAUSE_DEPTH) {
    const cause = readProperty(err, 'cause');
    if (cause !== undefined && classifyAtDepth(cause, depth + 1) === 'ProtocolUnsupported') {
      return 'ProtocolUnsupported';
    }
  }

  if (TRANSIENT_ERROR_NAMES.has(name)) return 'Transient';

  return matchesTransientMessage(lowerMessage) ? 'Transient' : 'Unknown';
}

/**
 * Map a send failure to a {@link TransportErrorCategory}.
 *
 * Order: (1) `ProtocolUnsupported`, by typed name or message; (2) a
 * `PooledStreamResetError` is looked through to its `cause`, which can only
 * make it `ProtocolUnsupported`; (3) `Transient` typed names; (4) message
 * substrings, only for what the name did not settle.
 * Never throws, whatever it is given: `null`, `undefined` and other non-errors
 * are `Unknown` unless their string form matches, and a `name`, `message` or
 * pooled `cause` that cannot be read (throwing getter, Proxy trap, revoked
 * Proxy) counts as absent.
 */
export function classifyTransportError(err: unknown): TransportErrorCategory {
  return classifyAtDepth(err, 0);
}

/**
 * True when the peer refused the protocol (multistream-select `na`), so the
 * send should fall back to a different wire variant or fail — not be retried
 * on the same one. Matches through `PooledStreamResetError` wrappers.
 *
 * Exported for tests and consumed by the router's in-line pooled -> one-shot
 * wire-variant fallback, the publisher's quorum accounting and the agent's
 * Context Graph name-resolution logging.
 */
export function isProtocolUnsupportedError(err: unknown): boolean {
  return classifyTransportError(err) === 'ProtocolUnsupported';
}

/**
 * True when re-sending the SAME request on the SAME protocol right away can
 * plausibly succeed (retry with backoff): a reset, timeout, exhausted dial, no
 * relay reservation, pooled-stream teardown, abort or responder back-pressure.
 *
 * False for `ProtocolUnsupported`: a peer that refuses the protocol on the wire
 * variants the router tried will refuse it again, so the send fails fast
 * instead of spending the retry budget and the send deadline on it. (The
 * router's in-line pooled -> one-shot fallback has already run inside `send()`
 * before its retry loop consults this.) Also false for anything unrecognised.
 * The per-category answer is the `retryNow` column of
 * {@link TRANSPORT_ERROR_DISPOSITION}.
 */
export function isRecoverableSendError(err: unknown): boolean {
  return TRANSPORT_ERROR_DISPOSITION[classifyTransportError(err)].retryNow;
}

/**
 * True when a caller that can try again LATER (the substrate outbox, sync's
 * peer backoff) should keep the failure retryable: everything
 * {@link isRecoverableSendError} accepts, plus `ProtocolUnsupported` (the
 * `retryLater` column of {@link TRANSPORT_ERROR_DISPOSITION}).
 *
 * A peer that answers "no such protocol" may still be booting (multistream
 * answers `na` in the window between `libp2p.start()` and its handler
 * registration) or may be upgraded before the caller gives up, and a refusal
 * cannot be told apart from that by message. That is a reason for a durable
 * queue to keep the message; it is not a reason for the router to re-negotiate
 * inside a single `send()`.
 */
export function isRetryableLaterSendError(err: unknown): boolean {
  return TRANSPORT_ERROR_DISPOSITION[classifyTransportError(err)].retryLater;
}
