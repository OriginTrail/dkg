import { parseCircuitRelayPeerIds, type RelayedConnectionGater } from './relay-path.js';

export type RelayPathDirection = 'inbound' | 'outbound';

export interface RelayPathGateInput {
  direction: RelayPathDirection;
  relayPeerId: string;
  remotePeerId?: string;
  addr?: string;
}

export type RelayPathGate = (input: RelayPathGateInput) => boolean;

export interface RelayDiscoveryFilter {
  has(peerId: { toString(): string }): boolean;
  add(peerId: { toString(): string }): void;
  remove(peerId: { toString(): string }): void;
}

export interface RelayNetworkPolicy {
  discoveryFilter: RelayDiscoveryFilter;
  relayPathGate: RelayPathGate;
  connectionGater: RelayedConnectionGater;
}

const RELAY_DENIAL_LOG_INTERVAL_MS = 60_000;
const RELAY_DENIAL_LOG_CACHE_MAX = 128;

export function buildActiveRelayNetworkPolicy(
  activeRelayPeerIds: ReadonlySet<string> | undefined,
  log: (message: string) => void = () => {},
): RelayNetworkPolicy | undefined {
  if (activeRelayPeerIds == null) return undefined;
  return {
    discoveryFilter: buildActiveRelayDiscoveryFilter(activeRelayPeerIds),
    relayPathGate: buildActiveRelayPathGate(activeRelayPeerIds, log),
    connectionGater: buildActiveRelayConnectionGater(activeRelayPeerIds, log),
  };
}

export function buildActiveRelayDiscoveryFilter(
  activeRelayPeerIds: ReadonlySet<string>,
): RelayDiscoveryFilter {
  const seen = new Set<string>();
  return {
    has(peerId) {
      const id = peerId.toString();
      return !activeRelayPeerIds.has(id) || seen.has(id);
    },
    add(peerId) {
      const id = peerId.toString();
      if (activeRelayPeerIds.has(id)) seen.add(id);
    },
    remove(peerId) {
      seen.delete(peerId.toString());
    },
  };
}

export function buildActiveRelayPathGate(
  activeRelayPeerIds: ReadonlySet<string>,
  log: (message: string) => void = () => {},
  now: () => number = Date.now,
): RelayPathGate {
  const short = (id: string): string => id.slice(-8);
  const denialLogs = new Map<string, { lastLoggedAt: number; suppressed: number }>();
  return ({ direction, relayPeerId, remotePeerId, addr }) => {
    if (activeRelayPeerIds.has(relayPeerId)) return false;

    // Connection gating is a hot path: one foreign relay can surface a large
    // set of remote circuit addresses in a single discovery wave. Keep the
    // denial itself synchronous and unchanged, but emit at most one diagnostic
    // per direction/relay/minute. The bounded cache prevents attacker-selected
    // relay ids from becoming an unbounded in-memory log-suppression table.
    const key = `${direction}:${relayPeerId}`;
    const timestamp = now();
    const previous = denialLogs.get(key);
    if (previous && timestamp - previous.lastLoggedAt < RELAY_DENIAL_LOG_INTERVAL_MS) {
      previous.suppressed += 1;
      return true;
    }
    if (!previous && denialLogs.size >= RELAY_DENIAL_LOG_CACHE_MAX) {
      const oldestKey = denialLogs.keys().next().value as string | undefined;
      if (oldestKey !== undefined) denialLogs.delete(oldestKey);
    }
    const suppressed = previous?.suppressed ?? 0;
    denialLogs.delete(key);
    denialLogs.set(key, { lastLoggedAt: timestamp, suppressed: 0 });
    log(
      `Network isolation: denying ${direction} relayed connection ` +
      `relay=${short(relayPeerId)}${remotePeerId ? ` remote=${short(remotePeerId)}` : ''}` +
      `${addr ? ` addr=${addr}` : ''}` +
      `${suppressed > 0 ? ` suppressedSinceLast=${suppressed}` : ''}`,
    );
    return true;
  };
}

export function buildActiveRelayConnectionGater(
  activeRelayPeerIds: ReadonlySet<string>,
  log: (message: string) => void = () => {},
  now: () => number = Date.now,
): RelayedConnectionGater {
  const relayPathGate = buildActiveRelayPathGate(activeRelayPeerIds, log, now);
  return {
    denyInboundRelayedConnection: (relay, remotePeer) =>
      relayPathGate({
        direction: 'inbound',
        relayPeerId: relay.toString(),
        remotePeerId: remotePeer.toString(),
      }),
    denyDialMultiaddr: (multiaddr) => {
      const addr = multiaddr.toString();
      const parsed = parseCircuitRelayPeerIds(addr);
      if (!parsed) return false;
      return relayPathGate({
        direction: 'outbound',
        relayPeerId: parsed.relayPeerId,
        remotePeerId: parsed.remotePeerId,
        addr,
      });
    },
  };
}
