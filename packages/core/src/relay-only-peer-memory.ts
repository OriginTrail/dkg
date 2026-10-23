import { BoundedLruCache } from './bounded-lru-cache.js';
import { RELAY_DEFAULT_DURATION_LIMIT_MS } from './relay-capacity-policy.js';
import { isTransportTimeoutError } from './request-abort-lifecycle.js';

/**
 * Which peers a normal dial currently reaches only through a relay.
 *
 * The protocol router does not open a stream on a limited (relayed)
 * connection while the peer store lists a direct address for the peer: if
 * that address works, an upgrade to a direct connection closes the relayed
 * one under the new stream. It dials instead.
 *
 * Edges often list LAN or VPN addresses that other nodes cannot reach.
 * libp2p puts a circuit address through a public relay before a private
 * address, reuses no limited connection, and so dials a second circuit
 * through the same relay; when the new circuit has the remote address of the
 * open one, it aborts the new circuit and hands back the open one. Every
 * request then costs the relay and both ends a circuit that lives a few
 * milliseconds, and the stream still runs on the circuit that was open.
 *
 * So the router records the outcome of a normal dial. When the dial left the
 * peer with limited connections only (it failed, or it ended on a relay), the
 * peer's direct addresses gave no direct connection, and for a bounded time
 * the router opens streams on the open circuit without dialing. The record
 * holds for that exact set of direct addresses: a changed set, a dial that
 * reaches the peer directly, or the end of the time bound puts the guard back.
 */

/** How long a dial that reached the peer only through a relay is remembered. */
export const RELAY_ONLY_PEER_MEMORY_TTL_MS = 5 * 60_000;
/** Peers remembered at most; the least recently used record is dropped first. */
export const RELAY_ONLY_PEER_MEMORY_MAX_PEERS = 4_096;
/**
 * Bytes a circuit must have left to be used without a dial. The same floor as
 * agent share delivery over a relayed connection; above the default 10 MiB a
 * single response may carry.
 */
export const RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES = 16n * 1024n * 1024n;

const ADDRESS_SEPARATOR = '\n';

export interface RelayOnlyPeerMemoryOptions {
  ttlMs?: number;
  maxPeers?: number;
  now?: () => number;
}

/** The parts of a libp2p connection the record reads. */
export interface RelayOnlyPeerConnection {
  status?: string;
  limits?: unknown;
  timeline?: unknown;
}

interface PeerStoreAddresses {
  addresses?: ReadonlyArray<{ multiaddr?: { toString?: () => string } }>;
}

export class RelayOnlyPeerMemory {
  private readonly records: BoundedLruCache<string, { addresses: string; expiresAt: number }>;
  private readonly ttlMs: number;
  readonly now: () => number;

  constructor(options: RelayOnlyPeerMemoryOptions = {}) {
    this.records = new BoundedLruCache(options.maxPeers ?? RELAY_ONLY_PEER_MEMORY_MAX_PEERS);
    this.ttlMs = options.ttlMs ?? RELAY_ONLY_PEER_MEMORY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** True while a dial with exactly these direct addresses reached the peer only through a relay. */
  holds(peerId: string, addresses: string): boolean {
    const record = this.records.get(peerId);
    if (record === undefined) return false;
    if (record.expiresAt <= this.now()) {
      this.records.delete(peerId);
      return false;
    }
    return record.addresses === addresses;
  }

  remember(peerId: string, addresses: string): void {
    this.records.set(peerId, { addresses, expiresAt: this.now() + this.ttlMs });
  }

  forget(peerId: string): void {
    this.records.delete(peerId);
  }

  /** One stream open's view: the peer-store read, the reuse check and the dial outcome. */
  routeFor(peerId: string, readPeer: () => Promise<PeerStoreAddresses>): RelayOnlyPeerRoute {
    return new RelayOnlyPeerRoute(this, peerId, readPeer);
  }
}

export class RelayOnlyPeerRoute {
  private addresses: string | undefined;

  constructor(
    private readonly memory: RelayOnlyPeerMemory,
    private readonly peerId: string,
    private readonly readPeer: () => Promise<PeerStoreAddresses>,
  ) {}

  /**
   * Whether the peer store lists a non-circuit address for the peer. Throws
   * when the peer store has no entry, as the peer-store read does.
   */
  readonly peerHasDirectAddrs = async (): Promise<boolean> => {
    const peer = await this.readPeer();
    const direct = new Set<string>();
    for (const { multiaddr } of peer.addresses ?? []) {
      const address = multiaddr?.toString?.() ?? '';
      if (address && !address.includes('/p2p-circuit')) direct.add(address);
    }
    this.addresses = direct.size > 0 ? [...direct].sort().join(ADDRESS_SEPARATOR) : undefined;
    return direct.size > 0;
  };

  /**
   * Whether `connection`, a limited connection, may carry a stream although
   * the peer store lists direct addresses: a recent dial with those addresses
   * reached the peer only through a relay, and the circuit can carry an
   * operation that may last `operationMs`.
   */
  reuseLimited(connection: RelayOnlyPeerConnection, operationMs: number): boolean {
    if (this.addresses === undefined || !this.memory.holds(this.peerId, this.addresses)) return false;
    return circuitCarriesOperation(connection, operationMs, this.memory.now());
  }

  /**
   * Record what a normal dial left behind. A dial that the caller or a stop
   * cancelled shows nothing about the direct addresses and is not recorded. A
   * dial that the request's deadline cut short is: while a circuit stayed
   * open, the direct addresses gave no connection within a request's time, so
   * the next request uses the circuit instead of spending its own time again.
   */
  afterNormalDial(connections: ReadonlyArray<RelayOnlyPeerConnection>, signal?: AbortSignal): void {
    if (signal?.aborted && !isTransportTimeoutError(signal.reason)) return;
    const open = connections.filter((connection) => !connection.status || connection.status === 'open');
    if (open.some((connection) => !connection.limits)) this.memory.forget(this.peerId);
    else if (open.length > 0 && this.addresses !== undefined) this.memory.remember(this.peerId, this.addresses);
  }
}

/**
 * Whether a circuit has data and time left for one more operation. `limits`
 * holds what remains of the relay's allowance. The seconds are read but not
 * trusted alone: the libp2p relay server sends its duration in milliseconds
 * and the client reads seconds, so they come out 1,000 times too large. The
 * circuit's age against the duration this node's relays apply fills that gap.
 * A value of the wrong type is not relied on.
 */
export function circuitCarriesOperation(connection: RelayOnlyPeerConnection, operationMs: number, now: number): boolean {
  const { limits, timeline } = connection;
  if (limits === null || typeof limits !== 'object') return false;
  const { bytes, seconds } = limits as { bytes?: unknown; seconds?: unknown };
  if (bytes !== undefined && bytes !== null) {
    if (typeof bytes === 'bigint' ? bytes < RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES
      : !(typeof bytes === 'number' && bytes >= Number(RELAY_ONLY_PEER_MIN_CIRCUIT_BYTES))) return false;
  }
  if (seconds !== undefined && seconds !== null) {
    if (!(typeof seconds === 'number' && seconds * 1_000 > operationMs)) return false;
  }
  if (timeline === undefined || timeline === null) return true;
  const openedAt = (timeline as { open?: unknown }).open;
  return typeof openedAt === 'number' && RELAY_DEFAULT_DURATION_LIMIT_MS - (now - openedAt) > operationMs;
}
