import { tryCanonicalPeerIdString } from './network/peer-id.js';
import { parseCircuitRelayPeerIds } from './relay-path.js';

/**
 * How long outbound dials to a peer stay refused after it failed the
 * network-identity proof.
 *
 * MUST stay >= the admission quarantine cooldown (`NetworkAdmissionService`,
 * 5 min). A shorter window lets libp2p redial the peer while admission still
 * short-circuits it as rejected — without re-probing and without closing the
 * connection — so the redial leaves a useless socket open until the connection
 * manager happens to prune it.
 */
export const NETWORK_MISMATCH_DIAL_DENY_TTL_MS = 30 * 60_000;

/**
 * How long INBOUND connections from an identity-rejected peer are refused.
 * Matches the admission quarantine (5 min): while it lasts, admission cannot
 * re-verify the peer anyway — it short-circuits without probing or closing —
 * so an accepted inbound connection would only sit open, and circuit-relay
 * discovery could even reuse it as a reservation. Afterwards the peer may dial
 * in again and re-run the proof, e.g. once its operator fixed its config.
 */
export const NETWORK_MISMATCH_INBOUND_REFUSAL_MS = 5 * 60_000;

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
   * `config.relay` and operator-preferred relays. They are never denied, even
   * when another bundled network config also lists them or the identity probe
   * rejects them — an operator-chosen relay is not second-guessed here.
   */
  configuredRelayPeerIds?: Iterable<string>;
  /**
   * Relay peer ids declared by the OTHER DKG networks bundled with this build.
   * Unparseable ids (e.g. placeholder relays of a not-yet-deployed network)
   * are ignored.
   */
  otherNetworkRelayPeerIds?: Iterable<string>;
  /** Defaults to {@link NETWORK_MISMATCH_DIAL_DENY_TTL_MS}. */
  mismatchDenyTtlMs?: number;
  /** Defaults to {@link NETWORK_MISMATCH_INBOUND_REFUSAL_MS}; never longer than the TTL. */
  mismatchInboundRefusalMs?: number;
  /** Defaults to {@link NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS}. */
  maxMismatchDeniedPeers?: number;
  now?: () => number;
  log?: (message: string) => void;
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

/** Terminal `/p2p/<id>` of a non-circuit multiaddr string, uncanonicalized. */
function terminalPeerId(addr: string): string | undefined {
  const parts = addr.split('/');
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'p2p') return parts[i + 1] || undefined;
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
 *   - dynamic: peers that failed the network-identity proof, remembered in a
 *     bounded set and cleared as soon as they later pass it. Outbound is
 *     refused for the TTL; inbound only for the admission quarantine, after
 *     which a peer whose operator fixed its network config can dial back in
 *     and re-verify.
 *
 * The node's configured relays and the node itself are always exempt.
 */
export class NetworkPeerDialPolicy {
  readonly connectionGater: NetworkPeerConnectionGater;

  private readonly selfPeerId: string | undefined;
  private readonly configuredRelayPeerIds: ReadonlySet<string>;
  private readonly otherNetworkRelayPeerIds: ReadonlySet<string>;
  /** Canonical peer id -> denial expiries (ms). Insertion order = oldest first. */
  private readonly mismatchDenials = new Map<string, { outboundUntil: number; inboundUntil: number }>();
  private readonly mismatchDenyTtlMs: number;
  private readonly mismatchInboundRefusalMs: number;
  private readonly maxMismatchDeniedPeers: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly denialLogs = new Map<string, { lastLoggedAt: number; suppressed: number }>();

  constructor(options: NetworkPeerDialPolicyOptions = {}) {
    this.selfPeerId = options.selfPeerId
      ? tryCanonicalPeerIdString(options.selfPeerId) ?? undefined
      : undefined;
    this.configuredRelayPeerIds = canonicalPeerIdSet(options.configuredRelayPeerIds);
    const otherNetworkRelayPeerIds = canonicalPeerIdSet(options.otherNetworkRelayPeerIds);
    for (const exempt of this.configuredRelayPeerIds) otherNetworkRelayPeerIds.delete(exempt);
    if (this.selfPeerId) otherNetworkRelayPeerIds.delete(this.selfPeerId);
    this.otherNetworkRelayPeerIds = otherNetworkRelayPeerIds;
    this.mismatchDenyTtlMs = positiveIntegerOr(options.mismatchDenyTtlMs, NETWORK_MISMATCH_DIAL_DENY_TTL_MS);
    this.mismatchInboundRefusalMs = Math.min(
      positiveIntegerOr(options.mismatchInboundRefusalMs, NETWORK_MISMATCH_INBOUND_REFUSAL_MS),
      this.mismatchDenyTtlMs,
    );
    this.maxMismatchDeniedPeers = positiveIntegerOr(
      options.maxMismatchDeniedPeers,
      NETWORK_MISMATCH_DIAL_DENY_MAX_PEERS,
    );
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.connectionGater = this.buildConnectionGater();
  }

  /** Number of other-network relay peer ids this policy refuses. */
  get otherNetworkRelayCount(): number {
    return this.otherNetworkRelayPeerIds.size;
  }

  /** Why outbound connections to `peerId` are refused, or `undefined` if allowed. */
  dialDenialReason(peerId: string): NetworkPeerDenialReason | undefined {
    if (this.isExempt(peerId)) return undefined;
    if (this.otherNetworkRelayPeerIds.has(peerId)) return 'other-network-relay';
    if (this.hasActiveMismatchDenial(peerId)) return 'network-identity-mismatch';
    return undefined;
  }

  /**
   * Refuse outbound connections to a peer that failed the network-identity
   * proof for the mismatch TTL, and inbound ones for the (shorter) quarantine
   * window. Returns `false` (and records nothing) for an unparseable id or an
   * exempt peer.
   */
  denyAfterNetworkMismatch(peerId: string): boolean {
    const canonical = tryCanonicalPeerIdString(peerId);
    if (!canonical || this.isExempt(canonical)) return false;
    const now = this.now();
    this.mismatchDenials.delete(canonical);
    this.mismatchDenials.set(canonical, {
      outboundUntil: now + this.mismatchDenyTtlMs,
      inboundUntil: now + this.mismatchInboundRefusalMs,
    });
    while (this.mismatchDenials.size > this.maxMismatchDeniedPeers) {
      const oldest = this.mismatchDenials.keys().next();
      if (oldest.done) break;
      this.mismatchDenials.delete(oldest.value);
    }
    return true;
  }

  /** Lift a mismatch denial once the peer proved it belongs to the active network. */
  clearNetworkMismatchDenial(peerId: string): void {
    const canonical = tryCanonicalPeerIdString(peerId);
    if (canonical) this.mismatchDenials.delete(canonical);
  }

  private isExempt(peerId: string): boolean {
    return peerId === this.selfPeerId || this.configuredRelayPeerIds.has(peerId);
  }

  private hasActiveMismatchDenial(peerId: string): boolean {
    const denial = this.mismatchDenials.get(peerId);
    if (denial === undefined) return false;
    if (denial.outboundUntil > this.now()) return true;
    this.mismatchDenials.delete(peerId);
    return false;
  }

  /** Why inbound connections from `peerId` are refused, or `undefined` if allowed. */
  private inboundDenialReason(peerId: string): NetworkPeerDenialReason | undefined {
    if (this.isExempt(peerId)) return undefined;
    if (this.otherNetworkRelayPeerIds.has(peerId)) return 'other-network-relay';
    if (!this.hasActiveMismatchDenial(peerId)) return undefined;
    const denial = this.mismatchDenials.get(peerId);
    return denial !== undefined && denial.inboundUntil > this.now()
      ? 'network-identity-mismatch'
      : undefined;
  }

  /**
   * At most one line per direction and peer per interval: kad-dht offers the
   * same foreign closer peer on many queries, and each offer is a refused dial.
   * The bounded cache keeps attacker-chosen peer ids from growing it.
   */
  private logDenial(
    direction: 'outbound' | 'inbound',
    peerId: string,
    reason: NetworkPeerDenialReason,
    detail = '',
  ): void {
    const key = `${direction}:${peerId}`;
    const timestamp = this.now();
    const previous = this.denialLogs.get(key);
    if (previous && timestamp - previous.lastLoggedAt < PEER_DENIAL_LOG_INTERVAL_MS) {
      previous.suppressed += 1;
      return;
    }
    if (!previous && this.denialLogs.size >= PEER_DENIAL_LOG_CACHE_MAX) {
      const oldest = this.denialLogs.keys().next();
      if (!oldest.done) this.denialLogs.delete(oldest.value);
    }
    const suppressed = previous?.suppressed ?? 0;
    this.denialLogs.delete(key);
    this.denialLogs.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
    this.log(
      `Network isolation: refusing ${direction} connection peer=${peerId.slice(-8)} reason=${reason}` +
      `${detail}${suppressed > 0 ? ` suppressedSinceLast=${suppressed}` : ''}`,
    );
  }

  private denyOutbound(peerId: string, detail?: string): boolean {
    const reason = this.dialDenialReason(peerId);
    if (!reason) return false;
    this.logDenial('outbound', peerId, reason, detail);
    return true;
  }

  private buildConnectionGater(): NetworkPeerConnectionGater {
    return {
      denyDialPeer: (peerId) => this.denyOutbound(peerId.toString()),
      denyDialMultiaddr: (multiaddr) => {
        const addr = multiaddr.toString();
        const circuit = parseCircuitRelayPeerIds(addr);
        if (!circuit) {
          const target = terminalPeerId(addr);
          return target !== undefined && this.denyOutbound(target);
        }
        // Refuse the whole path before the circuit transport opens a direct
        // connection to the relay hop.
        return this.denyOutbound(circuit.relayPeerId, ` hop=relay addr=${addr}`)
          || (circuit.remotePeerId !== undefined && this.denyOutbound(circuit.remotePeerId));
      },
      denyInboundEncryptedConnection: (peerId) => {
        const id = peerId.toString();
        const reason = this.inboundDenialReason(id);
        if (!reason) return false;
        this.logDenial('inbound', id, reason);
        return true;
      },
      denyOutboundEncryptedConnection: (peerId) => this.denyOutbound(peerId.toString()),
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
