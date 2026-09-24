import { randomBytes } from '@libp2p/crypto';
import {
  ConnectionClosedError,
  NotStartedError,
  ProtocolError,
  serviceCapabilities,
  type ComponentLogger,
  type Connection,
  type DialProtocolOptions,
  type DialTarget,
  type Metrics,
  type Startable,
  type Stream,
} from '@libp2p/interface';
import { ping, PING_PROTOCOL, type Ping, type PingComponents } from '@libp2p/ping';
import { AdaptiveTimeout, byteStream } from '@libp2p/utils';
import { setMaxListeners } from 'node:events';

interface Components extends PingComponents {
  logger: ComponentLogger;
  metrics?: Metrics;
}

interface Options {
  intervalMs?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
}

interface CoordinatedPing extends Ping, Startable {
  [serviceCapabilities]: string[];
}

/** Cancel one observer without cancelling a probe shared with the monitor. */
function observe<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

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
 * One owner for both periodic connection liveness and explicit health pings.
 *
 * libp2p's built-in monitor bypasses the ping service and opens the same protocol
 * independently. With its one-outbound-stream limit, overlapping probes can
 * abort a healthy connection. Install this service with connectionMonitor.enabled
 * false: it replaces that monitor with the same interval and adaptive deadlines,
 * while sharing one physical probe per connection with every health caller.
 */
export function coordinatedPing(options: Options = {}): (components: Components) => CoordinatedPing {
  return (components) => {
    const responder = ping()(components) as Ping & Startable;
    const log = components.logger.forComponent('dkg:connection-monitor');
    const timeout = new AdaptiveTimeout({
      ...(options.minTimeoutMs === undefined ? {} : { minTimeout: options.minTimeoutMs }),
      ...(options.maxTimeoutMs === undefined ? {} : { maxTimeout: options.maxTimeoutMs }),
      metrics: components.metrics,
      metricName: 'libp2p_connection_monitor_ping_time_milliseconds',
    });
    const pending = new Map<Connection, Promise<number>>();
    let shutdown: AbortController | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const measure = async (connection: Connection, stop: AbortSignal): Promise<number> => {
      const closed = new AbortController();
      const onClose = () => closed.abort(new ConnectionClosedError('Connection closed during ping'));
      connection.addEventListener('close', onClose, { once: true });
      const signal = timeout.getTimeoutSignal({ signal: AbortSignal.any([stop, closed.signal]) });
      let stream: Stream | undefined;
      let startedAt = Date.now();
      try {
        if (connection.status !== 'open') throw new ConnectionClosedError();
        stream = await connection.newStream(PING_PROTOCOL, { signal, runOnLimitedConnection: true });
        const bytes = byteStream(stream);
        const challenge = randomBytes(32);
        startedAt = Date.now();
        const [, response] = await Promise.all([
          bytes.write(challenge, { signal }),
          bytes.read({ bytes: challenge.length, signal }),
        ]);
        if (!challenge.every((value, index) => response.get(index) === value)) {
          throw new ProtocolError('Received incorrect ping response');
        }
        connection.rtt = Date.now() - startedAt;
        bytes.unwrap();
        const closed = waitForClose(stream, signal);
        await Promise.all([stream.close({ signal }), closed]);
        return connection.rtt;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        stream?.abort(error);
        if (error.name === 'UnsupportedProtocolError') {
          // Protocol negotiation itself proves liveness, as in libp2p's monitor.
          connection.rtt = (Date.now() - startedAt) / 2;
          return connection.rtt;
        }
        if (!stop.aborted && connection.status === 'open') {
          log.error('aborting connection after failed shared ping - %e', error);
          connection.abort(error);
        }
        throw error;
      } finally {
        connection.removeEventListener('close', onClose);
        timeout.cleanUp(signal);
      }
    };

    const probe = (connection: Connection): Promise<number> => {
      const existing = pending.get(connection);
      if (existing) return existing;
      if (!shutdown || shutdown.signal.aborted) return Promise.reject(new NotStartedError());
      const stop = shutdown.signal;
      // Publish the promise before opening a stream, including synchronous fakes.
      const work = Promise.resolve().then(() => measure(connection, stop));
      pending.set(connection, work);
      const clear = () => { if (pending.get(connection) === work) pending.delete(connection); };
      work.then(clear, clear);
      return work;
    };

    return {
      [serviceCapabilities]: ['@libp2p/ping', '@libp2p/connection-monitor'],
      async start() {
        if (shutdown && !shutdown.signal.aborted) return;
        await responder.start();
        shutdown = new AbortController();
        setMaxListeners(0, shutdown.signal);
        timer = setInterval(() => {
          for (const connection of components.connectionManager.getConnections()) {
            // Probe owns failure logging and teardown; joining must not duplicate it.
            void probe(connection).catch(() => {});
          }
        }, options.intervalMs ?? 10_000);
        timer.unref?.();
      },
      async stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
        shutdown?.abort(new DOMException('Ping monitor stopped', 'AbortError'));
        await Promise.allSettled(pending.values());
        await responder.stop();
      },
      async ping(peer: DialTarget, options: DialProtocolOptions = {}) {
        if (!shutdown || shutdown.signal.aborted) throw new NotStartedError();
        options.signal?.throwIfAborted();
        const connection = await components.connectionManager.openConnection(peer, options);
        options.signal?.throwIfAborted();
        return observe(probe(connection), options.signal);
      },
    };
  };
}
