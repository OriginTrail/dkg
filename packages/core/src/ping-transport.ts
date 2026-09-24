import { randomBytes } from '@libp2p/crypto';
import { ConnectionClosedError, ProtocolError, type Connection, type NewStreamOptions, type Stream } from '@libp2p/interface';
import { PING_PROTOCOL } from '@libp2p/ping';
import { byteStream } from '@libp2p/utils';

/** The outbound protocol slot remains occupied until the remote FIN arrives. */
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
 * release a shared one-stream slot safely. This primitive additionally waits
 * for that FIN. It owns no monitor, connection-abort, or timeout policy.
 *
 * Keep conformance against the stock responder and the delayed-FIN regression
 * when upgrading libp2p. Every applicable newStream option is forwarded.
 */
export async function pingConnection(
  connection: Connection,
  options: NewStreamOptions & { signal: AbortSignal },
): Promise<number> {
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
    const closed = waitForClose(stream, options.signal);
    await Promise.all([stream.close({ signal: options.signal }), closed]);
    return rtt;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    stream?.abort(error);
    throw error;
  }
}
