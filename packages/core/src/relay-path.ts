export interface RelayPathPeerIds {
  relayPeerId: string;
  remotePeerId?: string;
}

export interface RelayedConnectionGater {
  denyInboundRelayedConnection(relay: { toString(): string }, remotePeer: { toString(): string }): boolean;
  denyDialMultiaddr(multiaddr: { toString(): string }): boolean;
}

export function parseCircuitRelayPeerIds(addr: string): RelayPathPeerIds | null {
  const parts = addr.split('/').filter(Boolean);
  const circuitIndex = parts.indexOf('p2p-circuit');
  if (circuitIndex === -1) return null;

  let relayPeerId: string | undefined;
  for (let i = circuitIndex - 1; i >= 0; i--) {
    if (parts[i] === 'p2p' && i + 1 < circuitIndex) {
      relayPeerId = parts[i + 1];
      break;
    }
  }
  if (!relayPeerId) return null;

  let remotePeerId: string | undefined;
  for (let i = circuitIndex + 1; i < parts.length - 1; i++) {
    if (parts[i] === 'p2p') {
      remotePeerId = parts[i + 1];
      break;
    }
  }

  return { relayPeerId, remotePeerId };
}
