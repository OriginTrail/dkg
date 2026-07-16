/**
 * Compatibility helpers for libp2p internal shapes that the relay
 * metrics path depends on but that libp2p does NOT expose as part of
 * its public TypeScript types.
 *
 * Two specific reads:
 *
 *   1. `libp2pNode.services.relay.reservations` — the live reservations
 *      Map maintained by `circuitRelayServer({ reservations })`. We
 *      need its iteration surface and `size` to surface
 *      `RelayStats.reservationCount` + per-reservee detail.
 *
 *   2. `connection.streams` — the per-Connection list of multiplexed
 *      Streams. We need it to count "active circuits" (outbound STOP
 *      streams) on a relay-server node.
 *
 * Both used to be inlined as `(x as any).y` reads at the call sites in
 * `node.ts`. Codex review on PR #525 round 4 flagged that this ties
 * the metrics surface to private libp2p object shapes — a minor
 * libp2p upgrade can silently turn the counters into 0 / empty data
 * with no type error.
 *
 * This module concentrates the brittleness in one tested place. Each
 * helper validates the shape it expects (object, has the right
 * field, the field has the expected `forEach` / `Array.isArray`
 * surface) and returns `null` on mismatch — so a libp2p change makes
 * the metrics report `null` (visible) instead of silently stale
 * data, and the regression tests in `relay-internal-shapes.test.ts`
 * fail loudly the next time libp2p restructures these fields.
 */

/**
 * Minimum surface we need from libp2p's relay reservation Map. Real
 * libp2p uses `Map<PeerId, ServerReservation>` from
 * `@libp2p/circuit-relay-v2/dist/src/server/reservation-store.d.ts`.
 * We intentionally narrow to just what `getRelayStats()` actually
 * touches so that future libp2p restructures of the internal Map
 * value type don't force us to update.
 */
export interface RelayReservationsLike {
  /**
   * Iterate (peerId, reservation) pairs. Same call signature as
   * `Map.prototype.forEach`. The reservation value is `unknown`
   * because we read its fields defensively at the use site.
   */
  forEach(callback: (value: unknown, key: { toString(): string }) => void): void;
  /** Number of live reservations. Used as the cap utilization signal. */
  readonly size?: number;
}

/**
 * Read the live reservations Map from a libp2p relay service.
 * Returns `null` if the relay service isn't configured (e.g. edge
 * node) OR if its shape no longer matches the expected
 * `{ reservations: Map<...> }` contract — both treated as
 * "metrics not available right now" by `getRelayStats()`.
 */
export function readRelayReservations(libp2pNode: unknown): RelayReservationsLike | null {
  if (!libp2pNode || typeof libp2pNode !== 'object') return null;
  const services = (libp2pNode as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return null;
  const relay = (services as Record<string, unknown>).relay;
  if (!relay || typeof relay !== 'object') return null;
  const reservations = (relay as Record<string, unknown>).reservations;
  if (!reservations || typeof (reservations as { forEach?: unknown }).forEach !== 'function') {
    return null;
  }
  return reservations as RelayReservationsLike;
}

/**
 * Minimum surface we need from a libp2p Stream for the
 * activeCircuits computation. Real libp2p Stream is
 * `MessageStream` (from `@libp2p/interface`), but only the protocol
 * + direction fields matter for this counter and they are stable
 * public fields on the type.
 */
export interface LibP2PStreamShape {
  /** Negotiated protocol identifier (e.g. `/libp2p/circuit/relay/0.2.0/stop`). */
  protocol?: string;
  /** Stream direction relative to this node — `inbound` if the peer initiated, `outbound` if we did. */
  direction?: 'inbound' | 'outbound';
  /** Best-effort stream reset used by the relay watchdog's bounded reaper. */
  abort?: (reason: Error) => void;
}

/**
 * Read the per-connection Stream array from a libp2p Connection.
 * libp2p exposes `connection.streams` but doesn't include it in the
 * public `Connection` type (it's been on the implementing class
 * stably across all v0.x and v1.x releases though). Returns `null`
 * when the field is missing or not an array — caller treats `null`
 * as "no circuits visible on this connection".
 */
export function readConnectionStreams(conn: unknown): LibP2PStreamShape[] | null {
  if (!conn || typeof conn !== 'object') return null;
  const streams = (conn as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return null;
  return streams as LibP2PStreamShape[];
}
