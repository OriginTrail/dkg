import type {
  VmReconcilePeerTopology,
  VmReconcilePeerTopologyEvidence,
  VmReconcilePeerTopologyPeer,
} from './dkg-agent-types.js';

export const UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY: VmReconcilePeerTopology = {
  kind: 'unreadable',
};
export function createVmReconcilePeerTopology(input: {
  preferredPeerId: string | null;
  privateOnly: boolean;
  peers: readonly VmReconcilePeerTopologyPeer[];
}): VmReconcilePeerTopology {
  const seenPeerIds = new Set<string>();
  const peers = input.peers.filter((peer) => {
    if (!peer.peerId || seenPeerIds.has(peer.peerId)) return false;
    seenPeerIds.add(peer.peerId);
    return true;
  }).map((peer) => ({ peerId: peer.peerId, core: peer.core }));
  return {
    kind: 'readable',
    preferredPeerId: input.preferredPeerId,
    privateOnly: input.privateOnly,
    peers,
  };
}

/** One agent-owned parser for live and persistence-adapter topology input. */
export function parseVmReconcilePeerTopology(value: unknown): VmReconcilePeerTopology | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const topology = value as Record<string, unknown>;
  if (topology.kind === 'unreadable') return UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY;
  if (
    topology.kind !== 'readable'
    || !(topology.preferredPeerId === null || typeof topology.preferredPeerId === 'string')
    || typeof topology.privateOnly !== 'boolean'
    || !Array.isArray(topology.peers)
  ) return null;
  const peerIds = new Set<string>();
  for (const candidate of topology.peers) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const peer = candidate as Record<string, unknown>;
    if (
      typeof peer.peerId !== 'string'
      || peer.peerId.length === 0
      || typeof peer.core !== 'boolean'
      || peerIds.has(peer.peerId)
    ) return null;
    peerIds.add(peer.peerId);
  }
  return createVmReconcilePeerTopology({
    preferredPeerId: topology.preferredPeerId,
    privateOnly: topology.privateOnly,
    peers: topology.peers as VmReconcilePeerTopologyPeer[],
  });
}

/** Defensive guard for custom ContextGraphSubscriptionStore implementations. */
export function isVmReconcilePeerTopology(value: unknown): value is VmReconcilePeerTopology {
  return parseVmReconcilePeerTopology(value) !== null;
}

export function parseVmReconcileCleanMissPeerIds(
  value: unknown,
  topology: VmReconcilePeerTopology,
): string[] | null {
  if (!Array.isArray(value)) return null;
  const peers = topology.kind === 'readable'
    ? new Set(topology.peers.map((peer) => peer.peerId))
    : new Set<string>();
  const seen = new Set<string>();
  const cleanMissPeerIds: string[] = [];
  for (const peerId of value) {
    if (typeof peerId !== 'string' || !peers.has(peerId) || seen.has(peerId)) return null;
    seen.add(peerId);
    cleanMissPeerIds.push(peerId);
  }
  return cleanMissPeerIds;
}

export function createVmReconcileCleanMissPeerIds(
  topology: VmReconcilePeerTopology,
  peerIds: readonly string[],
): string[] {
  if (topology.kind === 'unreadable') return [];
  const topologyPeers = new Set(topology.peers.map((peer) => peer.peerId));
  return [...new Set(peerIds)].filter((peerId) => topologyPeers.has(peerId));
}

/**
 * Exact topology preserves the existing local-generation backoff. A smaller
 * topology is reusable only when every remaining peer produced a clean SWM
 * completion while the miss was recorded; a connected-but-skipped peer is not
 * absence evidence.
 */
export function canReuseVmReconcilePeerTopology(
  cached: VmReconcilePeerTopologyEvidence,
  current: VmReconcilePeerTopology,
): boolean {
  const cachedTopology = cached.topology;
  if (cachedTopology.kind === 'unreadable' || current.kind === 'unreadable') {
    return cachedTopology.kind === current.kind;
  }
  if (
    cachedTopology.preferredPeerId !== current.preferredPeerId
    || cachedTopology.privateOnly !== current.privateOnly
  ) {
    return false;
  }

  const peersMatch = (
    left: VmReconcilePeerTopologyPeer,
    right: VmReconcilePeerTopologyPeer,
  ): boolean => left.peerId === right.peerId && left.core === right.core;
  if (
    cachedTopology.peers.length === current.peers.length
    && current.peers.every((peer, index) => peersMatch(cachedTopology.peers[index]!, peer))
  ) {
    return true;
  }

  let cachedIndex = 0;
  for (const peer of current.peers) {
    while (
      cachedIndex < cachedTopology.peers.length
      && cachedTopology.peers[cachedIndex]?.peerId !== peer.peerId
    ) {
      cachedIndex += 1;
    }
    const cachedPeer = cachedTopology.peers[cachedIndex];
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
