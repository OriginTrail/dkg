/**
 * The circuit-relay client transport as a DKG node configures it, and the one
 * rule libp2p's options cannot express: a node with a relay allowlist never
 * reserves a slot on a relay outside it.
 *
 * Why the rule is needed. libp2p fills a free reservation slot from two
 * sources. Identify events go through the transport's `discoveryFilter`,
 * which the relay network policy sets to the allowlist. But whenever a slot
 * frees up (the connection to a reserved relay closed), libp2p first walks its
 * peer store and offers every peer that announced the relay protocol, and that
 * pass consults no filter. A node on a network with relay-capable peers outside
 * its allowlist could therefore move a slot to one of them when an allowed
 * relay restarted. The node then announced a circuit address that its own
 * gate and every same-network dialer refuse, libp2p had no slot left for the
 * allowed relay once it was back, and the watchdog closed and redialed that
 * relay's connection over and over to obtain a reservation libp2p would not
 * request.
 *
 * Every reservation request, whatever found the relay, goes through the
 * reservation store's `addRelay`. Refusing there keeps the slot free for an
 * allowed relay.
 *
 * A free slot keeps libp2p's relay search running: the peer-store pass, then
 * a walk over the DHT that dials the peers it finds. That is unchanged, and it
 * is what a node without other relay-capable peers around has always done
 * while short of relays. With the guard the search no longer ends on a relay
 * the node cannot use, so it lasts until an allowed relay takes the slot. The
 * allowed relay does not come from the search: the node re-establishes its
 * connection itself, and libp2p reserves when the relay identifies.
 */
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createBoundedDenialLogger } from './bounded-denial-logger.js';
import type { DerivedRelayCaps } from './relay-capacity-policy.js';
import { readRelayClientReservationStore } from './relay-internal-shapes.js';
import type { RelayNetworkPolicy } from './relay-network-policy.js';

type CircuitRelayTransportInit = NonNullable<Parameters<typeof circuitRelayTransport>[0]>;
type CircuitRelayTransportFactory = ReturnType<typeof circuitRelayTransport>;

const RESERVATION_REFUSAL_LOG_INTERVAL_MS = 10 * 60_000;
const RESERVATION_REFUSAL_LOG_CACHE_MAX = 128;

/** A reservation request for a relay the node's allowlist does not cover. */
export class RelayReservationNotAllowedError extends Error {
  constructor(relayPeerId: string) {
    super(`Relay ${relayPeerId} is outside this node's relay set; no reservation requested`);
    this.name = 'RelayReservationNotAllowedError';
  }
}

export interface RelayReservationGuardOptions {
  /** The relay allowlist; see `RelayNetworkPolicy.allowedRelayPeerIds`. */
  allowsRelay(peerId: string): boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: () => number;
}

export interface RelayClientTransportOptions {
  /**
   * Set on a node that runs a relay server. libp2p's default of 300 stop
   * streams is below what a server holding a thousand reservations implies,
   * so the transport-side caps follow the server capacity.
   */
  relayCaps: Pick<DerivedRelayCaps, 'maxInboundStopStreams' | 'maxOutboundStopStreams'> | null;
  /**
   * Reservations requested in parallel, set on an edge with usable relays.
   * libp2p's default of 1 would serialize the node's `/p2p-circuit` listen
   * slots and collapse several reservations back into one at a time.
   */
  reservationConcurrency?: number;
  /** Relay allowlist of the active network; absent without a network identity. */
  networkPolicy?: Pick<RelayNetworkPolicy, 'discoveryFilter' | 'allowedRelayPeerIds'>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Test seam; production builds libp2p's transport. */
  createTransport?: typeof circuitRelayTransport;
}

/**
 * Init for libp2p's transport. A node with neither a relay server nor usable
 * relays passes none, which keeps every libp2p default.
 */
export function relayClientTransportInit(
  options: Pick<RelayClientTransportOptions, 'relayCaps' | 'reservationConcurrency' | 'networkPolicy'>,
): CircuitRelayTransportInit | undefined {
  const { relayCaps, reservationConcurrency, networkPolicy } = options;
  if (!relayCaps && reservationConcurrency === undefined) return undefined;
  return {
    ...(relayCaps
      ? {
          maxInboundStopStreams: relayCaps.maxInboundStopStreams,
          maxOutboundStopStreams: relayCaps.maxOutboundStopStreams,
        }
      : {}),
    ...(networkPolicy
      ? { discoveryFilter: networkPolicy.discoveryFilter as CircuitRelayTransportInit['discoveryFilter'] }
      : {}),
    ...(reservationConcurrency !== undefined ? { reservationConcurrency } : {}),
  };
}

/**
 * Make `transport` refuse reservation requests for relays outside the
 * allowlist. Returns false, with a warning, when the transport does not carry
 * the reservation store this relies on: the node still runs, without the rule.
 */
export function restrictRelayReservations(
  transport: unknown,
  options: RelayReservationGuardOptions,
): boolean {
  const store = readRelayClientReservationStore(transport);
  if (!store) {
    options.warn?.(
      'Relay reservations are not restricted to the configured relays: ' +
      'the circuit-relay transport has no reservation store to guard',
    );
    return false;
  }
  // One peer is offered again on every pass over the peer store.
  const logRefusal = createBoundedDenialLogger({
    log: options.log ?? (() => {}),
    now: options.now ?? Date.now,
    intervalMs: RESERVATION_REFUSAL_LOG_INTERVAL_MS,
    cacheMax: RESERVATION_REFUSAL_LOG_CACHE_MAX,
  });
  const addRelay = store.addRelay;
  // An own property, so the store's internal `this.addRelay` calls (renewal,
  // start-up re-dial of tagged relays) are covered as well. Arguments after
  // the peer id are passed on untouched, whatever libp2p makes of them.
  store.addRelay = (peerId, ...rest) => {
    const relayPeerId = peerId.toString();
    if (options.allowsRelay(relayPeerId)) return addRelay.call(store, peerId, ...rest);
    logRefusal(relayPeerId, () =>
      `Relay reservation skipped: peer=${relayPeerId.slice(-8)} offers a relay ` +
      `but is not in this node's relay set`);
    return Promise.reject(new RelayReservationNotAllowedError(relayPeerId));
  };
  return true;
}

/**
 * libp2p transport factory for `createLibp2p({ transports })`. The guard is
 * installed on a node whose allowlist names at least one relay. A node that
 * lists none asks for no reservation, so there is nothing to keep on a list.
 */
export function buildRelayClientTransport(
  options: RelayClientTransportOptions,
): CircuitRelayTransportFactory {
  const createTransport = options.createTransport ?? circuitRelayTransport;
  const factory = createTransport(relayClientTransportInit(options));
  const allowed = options.networkPolicy?.allowedRelayPeerIds;
  if (!allowed || allowed.size === 0) return factory;
  return (components) => {
    const transport = factory(components);
    restrictRelayReservations(transport, {
      allowsRelay: (peerId) => allowed.has(peerId),
      log: options.log,
      warn: options.warn,
    });
    return transport;
  };
}
