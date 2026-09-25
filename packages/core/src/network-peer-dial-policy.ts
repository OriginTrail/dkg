import { createBoundedDenialLogger, type BoundedDenialLogger } from './bounded-denial-logger.js';
import { tryCanonicalPeerIdString } from './network/peer-id.js';
import { parseCircuitRelayPeerIds } from './relay-path.js';

/**
 * Default window for which a peer that failed the network-identity proof is
 * refused, in both directions, when the caller passes none.
 *
 * The agent passes the admission quarantine it just applied, so the two
 * windows share one source and cannot drift. The refusal must last at least
 * the quarantine: while it lasts, admission short-circuits the peer as
 * rejected without probing or closing, so a connection in either direction
 * would only sit open (and circuit-relay discovery could reuse an inbound one
 * as a reservation). Once it lapses, the next dial re-runs the proof: a peer
 * whose operator fixed its network config is admitted, and a still-foreign one
 * is refused again.
 *
 * Refusing for exactly the quarantine, not longer, is a deliberate choice for
 * every rejected peer, not only configured relays (#2740 kept outbound refused
 * for 30 min). The window is the re-admission latency of any peer whose
 * operator fixed its network config: while it lasts the peer can be neither
 * dialed nor stored, so a longer window would keep a node off a fixed curator,
 * catch-up peer or its own relay long after admission would re-probe it.
 *
 * The accepted cost, per still-foreign peer and window: once the window lapses
 * the peer's addresses are storable again, so discovery can re-learn them (and
 * this node's DHT view can hand them out), and the next dial or inbound
 * connection costs one connection and one identity probe. That probe rejects
 * the peer again, which closes its connections, deletes it from the peer store
 * and re-arms both the refusal and the address filter for another window. The
 * other bundled networks' relays are on the static list, refused permanently,
 * and never pay it; remembered peers are capped at
 * {@link NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS}.
 */
export const NETWORK_MISMATCH_DENY_DEFAULT_MS = 5 * 60_000;

/** Upper bound on remembered identity-rejected peers; the oldest is evicted first. */
export const NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS = 1_024;

const PEER_DENIAL_LOG_INTERVAL_MS = 10 * 60_000;
const PEER_DENIAL_LOG_CACHE_MAX = 256;

export type NetworkPeerDenialReason = 'other-network-relay' | 'network-identity-mismatch';

interface Stringish {
  toString(): string;
}

/**
 * libp2p connection-gater hooks enforcing {@link NetworkPeerDialPolicy}. Every
 * hook is an own arrow-function property: libp2p hands `filterMultiaddrForPeer`
 * to the peer store as a bare function reference, so the hooks must not depend
 * on `this`.
 */
export interface NetworkPeerConnectionGater {
  denyDialPeer(peerId: Stringish): boolean;
  denyDialMultiaddr(multiaddr: Stringish): boolean;
  denyInboundEncryptedConnection(peerId: Stringish): boolean;
  denyOutboundEncryptedConnection(peerId: Stringish): boolean;
  filterMultiaddrForPeer(peerId: Stringish, multiaddr: Stringish): boolean;
}

export interface NetworkPeerDialPolicyOptions {
  /** This node's own peer id. Its own addresses are always storable. */
  selfPeerId?: string;
  /**
   * Relays this node is configured to use: the network config's relays,
   * `config.relay` and operator-preferred relays. They are never on the static
   * other-network list, even when another bundled network config also lists
   * them. A configured relay that FAILS the identity proof is denied like any
   * other peer, with a warning naming it: the proof, not the config, decides
   * which network a relay belongs to.
   */
  configuredRelayPeerIds?: Iterable<string>;
  /**
   * Relay peer ids declared by the OTHER DKG networks bundled with this build.
   * Unparseable ids (e.g. placeholder relays of a not-yet-deployed network)
   * are ignored.
   */
  otherNetworkRelayPeerIds?: Iterable<string>;
  /**
   * Window used when {@link NetworkPeerDialPolicy.denyAfterNetworkMismatch}
   * gets none. Defaults to {@link NETWORK_MISMATCH_DENY_DEFAULT_MS}.
   */
  defaultMismatchDenyMs?: number;
  /** Defaults to {@link NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS}. */
  maxMismatchDeniedPeers?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Operator-actionable problems (a configured relay failed the proof). Defaults to `log`. */
  warn?: (message: string) => void;
}

/**
 * Canonical peer id named by the terminal `/p2p/` component of a relay
 * multiaddr, or by a bare peer id. Returns `undefined` for anything
 * unparseable, including the `PEER_ID_*` placeholders of pre-deployment
 * network configs.
 */
export function peerIdFromRelayAddress(address: string): string | undefined {
  const trimmed = address.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('/')) return tryCanonicalPeerIdString(trimmed) ?? undefined;
  const parts = trimmed.split('/');
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'p2p') return tryCanonicalPeerIdString(parts[i + 1] ?? '') ?? undefined;
  }
  return undefined;
}

function canonicalPeerIdSet(peerIds: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const peerId of peerIds ?? []) {
    const canonical = tryCanonicalPeerIdString(peerId);
    if (canonical) out.add(canonical);
  }
  return out;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Transport-level half of DKG network isolation: which peers this node must
 * not dial because they belong to a different DKG network.
 *
 * The admission coordinator's network-identity proof is the authority on
 * membership, but it can only run over an already-open connection. On its own
 * that let libp2p's network-agnostic machinery — kad-dht closer-peer queries
 * and ping-verified routing-table contacts, circuit-relay discovery, and the
 * keep-alive reconnect queue — keep re-dialing other-network peers directly
 * (2026-09-23 Base mainnet edge: testnet relays re-dialed within ~0.2s of every
 * rejection). The pre-existing relay-path gate only covers `/p2p-circuit`
 * paths, never a direct dial.
 *
 * Two sources of "belongs to another network":
 *   - static: relays declared by the other bundled network configs. Their
 *     addresses are never stored, and they are refused in both directions —
 *     inbound too, because circuit-relay discovery reuses an existing
 *     connection when it picks a reservation candidate, so an inbound
 *     connection from a foreign relay could otherwise become a reservation.
 *   - dynamic: peers that failed the network-identity proof, refused in both
 *     directions for the admission quarantine and cleared as soon as they
 *     later pass it. This includes a configured relay: one that proves it
 *     belongs to another network (a `network` changed without its `relay`)
 *     would otherwise be redialed indefinitely.
 *
 * The node itself is always exempt, and its configured relays are never on the
 * static list.
 */
export class NetworkPeerDialPolicy {
  readonly connectionGater: NetworkPeerConnectionGater;

  private readonly selfPeerId: string | undefined;
  private readonly configuredRelayPeerIds: ReadonlySet<string>;
  private readonly otherNetworkRelayPeerIds: ReadonlySet<string>;
  /** Canonical peer id -> denial expiry (ms). Insertion order = oldest first. */
  private readonly mismatchDenials = new Map<string, number>();
  private readonly defaultMismatchDenyMs: number;
  private readonly maxMismatchDeniedPeers: number;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly logDenial: BoundedDenialLogger;

  constructor(options: NetworkPeerDialPolicyOptions = {}) {
    this.selfPeerId = options.selfPeerId
      ? tryCanonicalPeerIdString(options.selfPeerId) ?? undefined
      : undefined;
    this.configuredRelayPeerIds = canonicalPeerIdSet(options.configuredRelayPeerIds);
    const otherNetworkRelayPeerIds = canonicalPeerIdSet(options.otherNetworkRelayPeerIds);
    for (const exempt of this.configuredRelayPeerIds) otherNetworkRelayPeerIds.delete(exempt);
    if (this.selfPeerId) otherNetworkRelayPeerIds.delete(this.selfPeerId);
    this.otherNetworkRelayPeerIds = otherNetworkRelayPeerIds;
    this.defaultMismatchDenyMs = positiveIntegerOr(options.defaultMismatchDenyMs, NETWORK_MISMATCH_DENY_DEFAULT_MS);
    this.maxMismatchDeniedPeers = positiveIntegerOr(
      options.maxMismatchDeniedPeers,
      NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS,
    );
    this.now = options.now ?? Date.now;
    const log = options.log ?? (() => {});
    this.warn = options.warn ?? log;
    // kad-dht offers the same foreign closer peer on many queries, and each
    // offer is a refused dial: one line per direction and peer per interval.
    this.logDenial = createBoundedDenialLogger({
      log,
      now: this.now,
      intervalMs: PEER_DENIAL_LOG_INTERVAL_MS,
      cacheMax: PEER_DENIAL_LOG_CACHE_MAX,
    });
    this.connectionGater = this.buildConnectionGater();
  }

  /** Number of other-network relay peer ids this policy refuses. */
  get otherNetworkRelayCount(): number {
    return this.otherNetworkRelayPeerIds.size;
  }

  /** Why connections with `peerId` are refused (either direction), or `undefined` if allowed. */
  dialDenialReason(peerId: string): NetworkPeerDenialReason | undefined {
    if (peerId === this.selfPeerId) return undefined;
    if (this.otherNetworkRelayPeerIds.has(peerId)) return 'other-network-relay';
    if (this.hasActiveMismatchDenial(peerId)) return 'network-identity-mismatch';
    return undefined;
  }

  /**
   * Refuse connections with a peer that failed the network-identity proof, in
   * both directions, and stop storing its addresses, for `durationMs`: the
   * admission quarantine the caller just applied (default
   * {@link NETWORK_MISMATCH_DENY_DEFAULT_MS}). A repeated rejection refreshes
   * the window. Returns `false` (and records nothing) for an unparseable id or
   * the node itself.
   */
  denyAfterNetworkMismatch(peerId: string, durationMs?: number): boolean {
    const canonical = tryCanonicalPeerIdString(peerId);
    if (!canonical || canonical === this.selfPeerId) return false;
    const windowMs = positiveIntegerOr(durationMs, this.defaultMismatchDenyMs);
    this.mismatchDenials.delete(canonical);
    this.mismatchDenials.set(canonical, this.now() + windowMs);
    while (this.mismatchDenials.size > this.maxMismatchDeniedPeers) {
      const oldest = this.mismatchDenials.keys().next();
      if (oldest.done) break;
      this.mismatchDenials.delete(oldest.value);
    }
    if (this.configuredRelayPeerIds.has(canonical)) {
      this.warn(
        `Network isolation: configured relay peer=${canonical.slice(-8)} failed the network identity proof; ` +
        `refusing it for ${Math.ceil(windowMs / 1000)}s. Check that config.relay and preferredRelays ` +
        'belong to the active network.',
      );
    }
    return true;
  }

  /** Lift a mismatch denial once the peer proved it belongs to the active network. */
  clearNetworkMismatchDenial(peerId: string): void {
    const canonical = tryCanonicalPeerIdString(peerId);
    if (canonical) this.mismatchDenials.delete(canonical);
  }

  private hasActiveMismatchDenial(peerId: string): boolean {
    const until = this.mismatchDenials.get(peerId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.mismatchDenials.delete(peerId);
    return false;
  }

  private deny(direction: 'outbound' | 'inbound', peerId: string, detail = ''): boolean {
    const reason = this.dialDenialReason(peerId);
    if (!reason) return false;
    this.logDenial(
      `${direction}:${peerId}`,
      () => `Network isolation: refusing ${direction} connection peer=${peerId.slice(-8)} reason=${reason}${detail}`,
    );
    return true;
  }

  private buildConnectionGater(): NetworkPeerConnectionGater {
    return {
      denyDialPeer: (peerId) => this.deny('outbound', peerId.toString()),
      denyDialMultiaddr: (multiaddr) => {
        const addr = multiaddr.toString();
        const circuit = parseCircuitRelayPeerIds(addr);
        if (!circuit) {
          const target = peerIdFromRelayAddress(addr);
          return target !== undefined && this.deny('outbound', target);
        }
        // Refuse the whole path before the circuit transport opens a direct
        // connection to the relay hop.
        return this.deny('outbound', circuit.relayPeerId, ` hop=relay addr=${addr}`)
          || (circuit.remotePeerId !== undefined && this.deny('outbound', circuit.remotePeerId));
      },
      denyInboundEncryptedConnection: (peerId) => this.deny('inbound', peerId.toString()),
      denyOutboundEncryptedConnection: (peerId) => this.deny('outbound', peerId.toString()),
      filterMultiaddrForPeer: (peerId, multiaddr) => {
        const id = peerId.toString();
        if (id === this.selfPeerId) return true;
        if (this.dialDenialReason(id) !== undefined) return false;
        // A circuit through another network's relay is undialable here (the
        // relay-path gate refuses it). Storing it only re-feeds discovery and
        // log noise, and would be re-advertised to peers from our DHT view.
        const circuit = parseCircuitRelayPeerIds(multiaddr.toString());
        return !circuit || this.dialDenialReason(circuit.relayPeerId) === undefined;
      },
    };
  }
}
