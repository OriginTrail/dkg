import type {
  VmReconcilePeerTopology,
  VmReconcilePeerTopologyPeer,
} from './dkg-agent-types.js';

export const UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY: VmReconcilePeerTopology = {
  kind: 'unreadable',
};
export function createVmReconcilePeerTopology(input: {
  preferredPeerId: string | null;
  privateOnly: boolean;
  peers: readonly VmReconcilePeerTopologyPeer[];
  cleanMissPeerIds?: readonly string[];
}): VmReconcilePeerTopology {
  const seenPeerIds = new Set<string>();
  const peers = input.peers.filter((peer) => {
    if (!peer.peerId || seenPeerIds.has(peer.peerId)) return false;
    seenPeerIds.add(peer.peerId);
    return true;
  }).map((peer) => ({ peerId: peer.peerId, core: peer.core }));
  const cleanMissPeerIds = [...new Set(input.cleanMissPeerIds ?? [])]
    .filter((peerId) => seenPeerIds.has(peerId));
  return {
    kind: 'readable',
    preferredPeerId: input.preferredPeerId,
    privateOnly: input.privateOnly,
    peers,
    cleanMissPeerIds,
  };
}

/** Defensive guard for custom ContextGraphSubscriptionStore implementations. */
export function isVmReconcilePeerTopology(value: unknown): value is VmReconcilePeerTopology {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const topology = value as Record<string, unknown>;
  if (topology.kind === 'unreadable') return true;
  if (
    topology.kind !== 'readable'
    || !(topology.preferredPeerId === null || typeof topology.preferredPeerId === 'string')
    || typeof topology.privateOnly !== 'boolean'
    || !Array.isArray(topology.peers)
    || !Array.isArray(topology.cleanMissPeerIds)
  ) return false;
  const peerIds = new Set<string>();
  for (const candidate of topology.peers) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const peer = candidate as Record<string, unknown>;
    if (
      typeof peer.peerId !== 'string'
      || peer.peerId.length === 0
      || typeof peer.core !== 'boolean'
      || peerIds.has(peer.peerId)
    ) return false;
    peerIds.add(peer.peerId);
  }
  const cleanMisses = new Set<string>();
  for (const peerId of topology.cleanMissPeerIds) {
    if (
      typeof peerId !== 'string'
      || !peerIds.has(peerId)
      || cleanMisses.has(peerId)
    ) return false;
    cleanMisses.add(peerId);
  }
  return true;
}

/**
 * Exact topology preserves the existing local-generation backoff. A smaller
 * topology is reusable only when every remaining peer produced a clean SWM
 * completion while the miss was recorded; a connected-but-skipped peer is not
 * absence evidence.
 */
export function canReuseVmReconcilePeerTopology(
  cached: VmReconcilePeerTopology,
  current: VmReconcilePeerTopology,
): boolean {
  if (cached.kind === 'unreadable' || current.kind === 'unreadable') {
    return cached.kind === current.kind;
  }
  if (
    cached.preferredPeerId !== current.preferredPeerId
    || cached.privateOnly !== current.privateOnly
  ) {
    return false;
  }

  const peersMatch = (
    left: VmReconcilePeerTopologyPeer,
    right: VmReconcilePeerTopologyPeer,
  ): boolean => left.peerId === right.peerId && left.core === right.core;
  if (
    cached.peers.length === current.peers.length
    && current.peers.every((peer, index) => peersMatch(cached.peers[index]!, peer))
  ) {
    return true;
  }

  let cachedIndex = 0;
  for (const peer of current.peers) {
    while (
      cachedIndex < cached.peers.length
      && cached.peers[cachedIndex]?.peerId !== peer.peerId
    ) {
      cachedIndex += 1;
    }
    const cachedPeer = cached.peers[cachedIndex];
    if (
      !cachedPeer
      || !peersMatch(cachedPeer, peer)
    ) {
      return false;
    }
    cachedIndex += 1;
  }
  const provenCleanMisses = new Set(cached.cleanMissPeerIds);
  return current.peers.every((peer) => provenCleanMisses.has(peer.peerId));
}
