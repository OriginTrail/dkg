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
import { DEFAULT_PING_CLEANUP_TIMEOUT_MS, pingConnection } from './ping-transport.js';
import { PingProbeCoordinator } from './ping-probe-coordinator.js';

interface Components extends PingComponents {
  logger: ComponentLogger;
  metrics?: Metrics;
}

interface Options {
  intervalMs?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  onDiagnostic?: (diagnostic: PingDiagnostic) => void;
}

interface PingDiagnostic {
  peerId: string;
  connectionId: string;
  phase: 'open-stream' | 'echo' | 'cleanup';
  action: 'abort-connection' | 'reset-stream';
  pongReceived: boolean;
  timeoutMs: number;
  elapsedMs: number;
  error: string;
  message: string;
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
 * policies until the previous probe's FIN or reset releases the protocol slot.
 */
export function coordinatedPing(options: Options = {}): (components: Components) => CoordinatedPing {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_PING_CLEANUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new RangeError('Ping cleanup timeout must be a positive integer');
  }
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
      const lifecycle = AbortSignal.any([stop, closed.signal]);
      const signal = timeout.getTimeoutSignal({ signal: lifecycle });
      const startedAt = Date.now();
      let phase: PingDiagnostic['phase'] = 'open-stream';
      let phaseStartedAt = performance.now();
      let pongReceived = false;
      let measurementFinished = false;
      const finishMeasurement = () => {
        if (measurementFinished) return;
        measurementFinished = true;
        timeout.cleanUp(signal);
      };
      const diagnose = (error: Error, action: PingDiagnostic['action']) => {
        const diagnostic: PingDiagnostic = {
          peerId: connection.remotePeer.toString(), connectionId: connection.id,
          phase, action, pongReceived,
          timeoutMs: phase === 'cleanup' ? cleanupTimeoutMs : signal.timeout,
          elapsedMs: Math.round(performance.now() - phaseStartedAt),
          error: error.name.slice(0, 80), message: error.message.slice(0, 240),
        };
        log.error('ping phase=%s action=%s - %e', phase, action, error);
        try { options.onDiagnostic?.(diagnostic); } catch { /* Diagnostics cannot change connection liveness. */ }
      };
      try {
        if (connection.status !== 'open') throw new ConnectionClosedError();
        connection.rtt = await pingConnection(connection, {
          ...streamOptions, signal,
          onProgress: (event) => {
            if (event.type === 'connection:opened-stream') {
              phase = 'echo';
              phaseStartedAt = performance.now();
            }
            streamOptions.onProgress?.(event);
          },
        }, {
          signal: lifecycle, timeoutMs: cleanupTimeoutMs,
          onPong: () => {
            pongReceived = true;
            finishMeasurement();
            phase = 'cleanup';
            phaseStartedAt = performance.now();
          },
          onFailure: (error) => diagnose(error, 'reset-stream'),
        });
        return connection.rtt;
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (error.name === 'UnsupportedProtocolError') {
          // Protocol negotiation itself proves liveness, as in libp2p's monitor.
          connection.rtt = (Date.now() - startedAt) / 2;
          return connection.rtt;
        }
        // Refusing a caller-excluded relay is not a failed liveness probe.
        if (!pongReceived && error.name !== 'LimitedConnectionError' && !stop.aborted && connection.status === 'open') {
          diagnose(error, 'abort-connection');
          connection.abort(error);
        }
        throw error;
      } finally {
        connection.removeEventListener('close', onClose);
        finishMeasurement();
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
