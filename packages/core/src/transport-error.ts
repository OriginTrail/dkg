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
 * This module deliberately imports nothing from `protocol-router.ts` or
 * `message-stream-pool.ts`, so both can depend on it.
 */

/**
 * What a failed send most plausibly means.
 *
 * - `ProtocolUnsupported`: the peer refused every offered protocol
 *   (multistream-select `na`). It does not speak the protocol on this wire.
 * - `ConnectionReset`: the stream, connection or muxer was closed or reset.
 * - `PooledStreamReset`: the pooled wire tore down a stream that carried this
 *   request (`PooledStreamResetError` with no more specific cause).
 * - `Timeout`: a transport-level timeout.
 * - `Aborted`: the stream or operation was aborted.
 * - `DialExhausted`: no address for the peer could be dialled (`no valid
 *   addresses`, `All multiaddr dials failed`, `ECONNREFUSED`).
 * - `NoReservation`: a relay had no reservation for the destination.
 * - `ResponderBusy`: the remote sync responder shed load (queue full / wait
 *   exceeded); it accepts the same request a moment later.
 * - `Unknown`: not a transport failure this module recognises.
 */
export type TransportErrorCategory =
  | 'ProtocolUnsupported'
  | 'ConnectionReset'
  | 'PooledStreamReset'
  | 'Timeout'
  | 'Aborted'
  | 'DialExhausted'
  | 'NoReservation'
  | 'ResponderBusy'
  | 'Unknown';

/** `err.name` of the peer's "no such protocol" answer (`@libp2p/interface`). */
const UNSUPPORTED_PROTOCOL_ERROR_NAME = 'UnsupportedProtocolError';

/**
 * `err.name` of the pooled wire's stream-teardown error
 * (`PooledStreamResetError` in `message-stream-pool.ts`). It wraps whatever
 * error tore the stream down, so it is classified by that cause when present.
 */
const POOLED_STREAM_RESET_ERROR_NAME = 'PooledStreamResetError';

/** How many `cause` links {@link classifyTransportError} follows through pool wrappers. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Typed error names -> category. Only names whose libp2p default wording the
 * previous substring list already treated as recoverable are listed, so keying
 * on the name changes no verdict: it only stops the verdict depending on the
 * wording. (`@libp2p/interface`: `StreamResetError` "The stream has been
 * reset", `ConnectionClosedError` "The connection is closed", `MuxerClosedError`
 * "The muxer is closed", `StreamAbortedError` "The stream has been aborted";
 * `libp2p`: `NoValidAddressesError` "The dial request has no valid addresses".)
 *
 * Deliberately NOT listed, because the old list did not retry their default
 * wording and mapping them would widen what the router, the Messenger outbox and
 * sync treat as retryable: `TimeoutError` ("Timed out", tcp "Connection timeout
 * after ..."), `StreamStateError`, `ConnectionClosingError`,
 * `ConnectionFailedError`, `DialError`. `AbortError` is also left to the
 * message fallback: callers also use it for their own cancellation, which must
 * not become retryable by name.
 */
const TRANSPORT_ERROR_NAME_CATEGORY: ReadonlyMap<string, TransportErrorCategory> = new Map([
  [UNSUPPORTED_PROTOCOL_ERROR_NAME, 'ProtocolUnsupported'],
  [POOLED_STREAM_RESET_ERROR_NAME, 'PooledStreamReset'],
  ['StreamResetError', 'ConnectionReset'],
  ['ConnectionClosedError', 'ConnectionReset'],
  ['MuxerClosedError', 'ConnectionReset'],
  ['StreamAbortedError', 'Aborted'],
  ['NoValidAddressesError', 'DialExhausted'],
]);

function errorName(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
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
 * Last-resort message matching for errors that carry no useful name. This is
 * the previous `isRecoverableSendError` substring list, minus the two
 * negotiation entries (now `ProtocolUnsupported`), with each entry mapped to
 * the category it stands for. Order only decides which category a message that
 * matches several gets; every category returned here is transient.
 */
function classifyTransportMessage(lowerMessage: string): TransportErrorCategory {
  const msg = lowerMessage;
  if (msg.includes('no_reservation') || msg.includes('no reservation')) return 'NoReservation';
  if (
    // libp2p dial exhaustion — every known multiaddr for the peer failed in
    // one attempt (`transportManager.dial`, or `dialProtocol` after iterating
    // every relay/transport candidate).
    msg.includes('all multiaddr dials failed') ||
    msg.includes('no valid addresses') ||
    msg.includes('econnrefused')
  ) {
    return 'DialExhausted';
  }
  if (
    msg.includes('etimedout') ||
    msg.includes('send timeout') ||
    msg.includes('operation timed out') ||
    msg.includes('operation was aborted due to timeout')
  ) {
    return 'Timeout';
  }
  if (
    msg.includes('closed') ||
    msg.includes('reset') ||
    msg.includes('stream returned in closed state') ||
    msg.includes('econnreset') ||
    msg.includes('epipe')
  ) {
    return 'ConnectionReset';
  }
  if (msg.includes('aborted')) return 'Aborted';
  if (
    msg.includes('sync responder') &&
    (msg.includes('queue full') || msg.includes('queue wait exceeded'))
  ) {
    return 'ResponderBusy';
  }
  return 'Unknown';
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

  // The pooled wire wraps whatever tore a stream down. Classify by the wrapped
  // cause when it says something specific, otherwise it is a plain pooled reset.
  if (name === POOLED_STREAM_RESET_ERROR_NAME) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      const inner = classifyAtDepth(cause, depth + 1);
      if (inner !== 'Unknown') return inner;
    }
    return 'PooledStreamReset';
  }

  const byName = TRANSPORT_ERROR_NAME_CATEGORY.get(name);
  if (byName !== undefined) return byName;

  return classifyTransportMessage(lowerMessage);
}

/**
 * Map a send failure to a {@link TransportErrorCategory}.
 *
 * Order: (1) `ProtocolUnsupported`, by typed name or message; (2) a
 * `PooledStreamResetError` is classified by its `cause`; (3) other typed
 * names; (4) message substrings, only for what the name did not settle.
 * Never throws; `null`, `undefined` and other non-errors are `Unknown` unless
 * their string form matches.
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
 *
 * Exported for tests.
 */
export function isRecoverableSendError(err: unknown): boolean {
  const category = classifyTransportError(err);
  return category !== 'Unknown' && category !== 'ProtocolUnsupported';
}

/**
 * True when a caller that can try again LATER (the substrate outbox, sync's
 * peer backoff) should keep the failure retryable: everything
 * {@link isRecoverableSendError} accepts, plus `ProtocolUnsupported`.
 *
 * A peer that answers "no such protocol" may still be booting (multistream
 * answers `na` in the window between `libp2p.start()` and its handler
 * registration) or may be upgraded before the caller gives up, and a refusal
 * cannot be told apart from that by message. That is a reason for a durable
 * queue to keep the message; it is not a reason for the router to re-negotiate
 * inside a single `send()`.
 */
export function isRetryableLaterSendError(err: unknown): boolean {
  return classifyTransportError(err) !== 'Unknown';
}
