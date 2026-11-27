/**
 * Settings for libp2p's connection monitor: the periodic ping on every
 * connection that aborts the connection when the ping fails.
 *
 * libp2p's defaults are a ping every 10 s with at least 5 s to answer. When
 * either end of a connection stalls its event loop for longer than that, the
 * ping in flight times out and the monitor aborts the connection, and a
 * relay that stalls for 13 to 15 s loses every connection at once, with the
 * reservations and relayed circuits they carry. A timeout longer than the
 * interval does not help on its own: a ping still in flight when the next
 * tick starts makes the monitor open a second ping stream, which exceeds the
 * ping protocol's limit of one outbound stream per connection, and the
 * monitor treats that refusal as a failed ping too.
 *
 * These options give a ping at least 20 s to answer and keep the longest
 * timeout below the interval, so the monitor never has two pings open on one
 * connection. A peer that stops answering is still aborted, within 55 s.
 *
 * The monitor also pings over a protocol of its own. The DHT checks its
 * routing-table contacts through the ping service, on `/ipfs/ping/1.0.0`; a
 * monitor tick that met such a check on the same connection would be refused
 * the protocol's one outbound stream and abort a healthy connection.
 * `connectionMonitorPingService` answers the monitor's protocol; a peer
 * without it (an older version) replies that the protocol is unsupported,
 * which the monitor counts as alive. All of this is plain `createLibp2p`
 * configuration, so it applies to whichever libp2p version an install
 * resolves.
 */
import { ping } from '@libp2p/ping';
import type { ConnectionMonitorInit } from 'libp2p';

export const CONNECTION_MONITOR_PING_INTERVAL_MS = 30_000;
export const CONNECTION_MONITOR_MIN_PING_TIMEOUT_MS = 20_000;
export const CONNECTION_MONITOR_MAX_PING_TIMEOUT_MS = 25_000;
/** The monitor's own ping protocol is `/dkg-liveness/ping/1.0.0`. */
export const CONNECTION_MONITOR_PROTOCOL_PREFIX = 'dkg-liveness';

/** The `connectionMonitor` option for `createLibp2p`. */
export function connectionMonitorOptions(): ConnectionMonitorInit {
  return {
    pingInterval: CONNECTION_MONITOR_PING_INTERVAL_MS,
    pingTimeout: {
      minTimeout: CONNECTION_MONITOR_MIN_PING_TIMEOUT_MS,
      maxTimeout: CONNECTION_MONITOR_MAX_PING_TIMEOUT_MS,
    },
    abortConnectionOnPingFailure: true,
    protocolPrefix: CONNECTION_MONITOR_PROTOCOL_PREFIX,
  };
}

/** The libp2p service that answers other nodes' monitor pings. */
export function connectionMonitorPingService(): ReturnType<typeof ping> {
  return ping({ protocolPrefix: CONNECTION_MONITOR_PROTOCOL_PREFIX });
}
