import {
  ConnectionClosedError,
  NotStartedError,
  serviceCapabilities,
  type ComponentLogger,
  type Connection,
  type DialProtocolOptions,
  type DialTarget,
  type Metrics,
  type Startable,
  type NewStreamOptions,
} from '@libp2p/interface';
import { ping, type Ping, type PingComponents } from '@libp2p/ping';
import { AdaptiveTimeout } from '@libp2p/utils';
import { setMaxListeners } from 'node:events';
import { pingConnection } from './ping-transport.js';
import { PingProbeCoordinator } from './ping-probe-coordinator.js';

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

/**
 * One owner for both periodic connection liveness and explicit health pings.
 *
 * libp2p's built-in monitor bypasses the ping service and opens the same protocol
 * independently. With its one-outbound-stream limit, overlapping probes can
 * abort a healthy connection. Install this service with connectionMonitor.enabled
 * false: it replaces that monitor with the same interval and adaptive deadlines,
 * while sharing compatible health probes and serializing different stream
 * policies until the previous probe's remote FIN releases the protocol slot.
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
    let coordinator: PingProbeCoordinator | undefined;
    let shutdown: AbortController | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;

    const measure = async (
      connection: Connection, stop: AbortSignal, streamOptions: Omit<NewStreamOptions, 'signal'>,
    ): Promise<number> => {
      stop.throwIfAborted();
      const closed = new AbortController();
      const onClose = () => closed.abort(new ConnectionClosedError('Connection closed during ping'));
      connection.addEventListener('close', onClose, { once: true });
      const signal = timeout.getTimeoutSignal({ signal: AbortSignal.any([stop, closed.signal]) });
      const startedAt = Date.now();
      try {
        if (connection.status !== 'open') throw new ConnectionClosedError();
        connection.rtt = await pingConnection(connection, { ...streamOptions, signal });
        return connection.rtt;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (error.name === 'UnsupportedProtocolError') {
          // Protocol negotiation itself proves liveness, as in libp2p's monitor.
          connection.rtt = (Date.now() - startedAt) / 2;
          return connection.rtt;
        }
        // Refusing a caller-excluded relay is not a failed liveness probe.
        if (error.name !== 'LimitedConnectionError' && !stop.aborted && connection.status === 'open') {
          log.error('aborting connection after failed shared ping - %e', error);
          connection.abort(error);
        }
        throw error;
      } finally {
        connection.removeEventListener('close', onClose);
        timeout.cleanUp(signal);
      }
    };

    return {
      [serviceCapabilities]: ['@libp2p/ping', '@libp2p/connection-monitor'],
      async start() {
        if (shutdown && !shutdown.signal.aborted) return;
        await responder.start();
        shutdown = new AbortController();
        const stop = shutdown.signal;
        coordinator = new PingProbeCoordinator((connection, streamOptions) => measure(connection, stop, streamOptions));
        const probes = coordinator;
        setMaxListeners(0, stop);
        timer = setInterval(() => {
          for (const connection of components.connectionManager.getConnections()) {
            // Probe owns failure logging and teardown; joining must not duplicate it.
            void probes.monitor(connection).catch(() => {});
          }
        }, options.intervalMs ?? 10_000);
        timer.unref?.();
      },
      async stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
        shutdown?.abort(new DOMException('Ping monitor stopped', 'AbortError'));
        await coordinator?.drain();
        await responder.stop();
      },
      async ping(peer: DialTarget, options: DialProtocolOptions = {}) {
        const probes = coordinator;
        const stop = shutdown?.signal;
        if (probes === undefined || stop === undefined || stop.aborted) throw new NotStartedError();
        options.signal?.throwIfAborted();
        const connection = await components.connectionManager.openConnection(peer, options);
        options.signal?.throwIfAborted();
        if (stop.aborted) throw new NotStartedError();
        return probes.ping(connection, options);
      },
    };
  };
}
