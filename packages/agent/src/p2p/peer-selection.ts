export function orderCatchupPeers(
  peers: Array<{ toString(): string }>,
  preferredPeerId?: string,
  privateOnly = false,
): Array<{ toString(): string }> {
  if (!preferredPeerId) return peers;

  if (privateOnly) {
    const preferredPeer = peers.find((peer) => peer.toString() === preferredPeerId);
    if (preferredPeer) {
      return [preferredPeer, ...peers.filter((peer) => peer.toString() !== preferredPeerId)];
    }
  }

  return [...peers].sort((a, b) => {
    if (a.toString() === preferredPeerId) return -1;
    if (b.toString() === preferredPeerId) return 1;
    return 0;
  });
}
