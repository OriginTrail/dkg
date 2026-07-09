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
): RelayPathGate {
  const short = (id: string): string => id.slice(-8);
  return ({ direction, relayPeerId, remotePeerId, addr }) => {
    if (activeRelayPeerIds.has(relayPeerId)) return false;
    log(
      `Network isolation: denying ${direction} relayed connection ` +
      `relay=${short(relayPeerId)}${remotePeerId ? ` remote=${short(remotePeerId)}` : ''}` +
      `${addr ? ` addr=${addr}` : ''}`,
    );
    return true;
  };
}

export function buildActiveRelayConnectionGater(
  activeRelayPeerIds: ReadonlySet<string>,
  log: (message: string) => void = () => {},
): RelayedConnectionGater {
  const relayPathGate = buildActiveRelayPathGate(activeRelayPeerIds, log);
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
