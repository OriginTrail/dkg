type PeerIdView = { toString(): string };

/** A live peer may appear in either libp2p view during inbound identify. */
export function connectedPeerIds(transport: {
  getPeers(): readonly PeerIdView[];
  getConnections(): readonly { remotePeer: PeerIdView }[];
}): Set<string> {
  const ids = new Set<string>();
  for (const peer of transport.getPeers()) ids.add(peer.toString());
  for (const connection of transport.getConnections()) ids.add(connection.remotePeer.toString());
  return ids;
}
