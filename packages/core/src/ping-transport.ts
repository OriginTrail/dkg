import { randomBytes } from '@libp2p/crypto';
import { ConnectionClosedError, ProtocolError, type Connection, type NewStreamOptions, type Stream } from '@libp2p/interface';
import { PING_PROTOCOL } from '@libp2p/ping';
import { byteStream } from '@libp2p/utils';
import { pingAbortScope } from './ping-abort-scope.js';

export const DEFAULT_PING_CLEANUP_TIMEOUT_MS = 5_000;

interface PingCleanup {
  /** Service/connection cancellation, independent of the echo deadline. */
  signal?: AbortSignal;
  timeoutMs?: number;
  onPong?: () => void;
  onFailure?: (error: Error) => void;
}

/** The outbound protocol slot remains occupied until FIN or a stream reset. */
function waitForClose(stream: Stream, signal: AbortSignal): Promise<void> {
  if (stream.status === 'closed') return Promise.resolve();
  if (stream.status === 'aborted' || stream.status === 'reset') {
    return Promise.reject(new ConnectionClosedError(`Ping stream ${stream.status}`));
  }
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const cleanUp = () => {
      stream.removeEventListener('close', close);
      signal.removeEventListener('abort', abort);
    };
    const close = (event: { error?: Error }) => {
      cleanUp();
      if (event.error) reject(event.error);
      else resolve();
    };
    const abort = () => {
      cleanUp();
      reject(signal.reason);
    };
    stream.addEventListener('close', close, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Minimal transport fork of @libp2p/ping 3.1.5: negotiate its protocol, send
 * 32 random bytes, verify the echo, and report round-trip latency. The stock
 * outbound API does not expose its stream or await remote FIN, so it cannot
 * release a shared one-stream slot safely. After a valid echo, this primitive
 * waits for FIN under a separate cleanup deadline, resetting only the stream
 * if cleanup fails. The caller retains the slot until this function settles.
 *
 * Keep conformance against the stock responder and the delayed-FIN regression
 * when upgrading libp2p. Every applicable newStream option is forwarded.
 */
export async function pingConnection(
  connection: Connection,
  options: NewStreamOptions & { signal: AbortSignal },
  cleanup: PingCleanup = {},
): Promise<number> {
  const cleanupTimeoutMs = cleanup.timeoutMs ?? DEFAULT_PING_CLEANUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new RangeError('Ping cleanup timeout must be a positive integer');
  }
  let stream: Stream | undefined;
  try {
    stream = await connection.newStream(PING_PROTOCOL, options);
    const bytes = byteStream(stream);
    const challenge = randomBytes(32);
    const startedAt = Date.now();
    const [, response] = await Promise.all([
      bytes.write(challenge, { signal: options.signal }),
      bytes.read({ bytes: challenge.length, signal: options.signal }),
    ]);
    if (!challenge.every((value, index) => response.get(index) === value)) {
      throw new ProtocolError('Received incorrect ping response');
    }
    const rtt = Date.now() - startedAt;
    bytes.unwrap();
    // A verified pong completes liveness measurement. In particular, the
    // adaptive probe timer must stop observing this flight before cleanup.
    cleanup.onPong?.();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('Ping stream cleanup timed out', 'TimeoutError')), cleanupTimeoutMs);
    timer.unref?.();
    const scope = pingAbortScope(cleanup.signal, deadline.signal);
    const signal = scope.signal;
    try {
      const closed = waitForClose(stream, signal);
      await Promise.all([stream.close({ signal }), closed]);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Stream.abort releases the muxer's protocol slot synchronously. A
      // missing FIN after a correct echo is not a dead connection verdict.
      stream.abort(error);
      if (!cleanup.signal?.aborted) cleanup.onFailure?.(error);
    } finally {
      clearTimeout(timer);
      scope.dispose();
    }
    // Do not report success if the service stopped or the connection closed
    // during cleanup; neither event should be misreported as a failed pong.
    cleanup.signal?.throwIfAborted();
    return rtt;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    stream?.abort(error);
    throw error;
  }
}
