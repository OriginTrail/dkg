export type VmReconcilePeerTopologyPeer = {
  peerId: string;
  preferred: boolean;
  core: boolean;
};

export type VmReconcilePeerTopology =
  | { kind: 'unreadable' }
  | {
    kind: 'readable';
    preferredPeerId: string | null;
    privateOnly: boolean;
    peers: VmReconcilePeerTopologyPeer[];
  };

export const UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY: VmReconcilePeerTopology = {
  kind: 'unreadable',
};
const VM_RECONCILE_PEER_TOPOLOGY_VERSION = 1;

/** Serialize the typed process-local topology only when crossing the durable-store boundary. */
export function encodeVmReconcilePeerTopology(topology: VmReconcilePeerTopology): string {
  if (topology.kind === 'unreadable') return 'unreadable';
  return JSON.stringify({
    version: VM_RECONCILE_PEER_TOPOLOGY_VERSION,
    preferredPeerId: topology.preferredPeerId,
    privateOnly: topology.privateOnly,
    peers: topology.peers.map((peer, rank) => ({ rank, ...peer })),
  });
}

/**
 * Decode and validate the legacy string persistence contract. The explicit unreadable
 * sentinel preserves exact-match behavior; malformed or unknown versions fail open.
 */
export function decodeVmReconcilePeerTopology(encoded: string): VmReconcilePeerTopology | null {
  if (encoded === 'unreadable') return UNREADABLE_VM_RECONCILE_PEER_TOPOLOGY;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      record.version !== VM_RECONCILE_PEER_TOPOLOGY_VERSION
      || !(record.preferredPeerId === null || typeof record.preferredPeerId === 'string')
      || typeof record.privateOnly !== 'boolean'
      || !Array.isArray(record.peers)
    ) {
      return null;
    }

    const peers: VmReconcilePeerTopologyPeer[] = [];
    const seenPeerIds = new Set<string>();
    for (const [rank, candidate] of record.peers.entries()) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return null;
      }
      const peer = candidate as Record<string, unknown>;
      if (
        peer.rank !== rank
        || typeof peer.peerId !== 'string'
        || peer.peerId.length === 0
        || typeof peer.preferred !== 'boolean'
        || typeof peer.core !== 'boolean'
        || peer.preferred !== (peer.peerId === record.preferredPeerId)
        || seenPeerIds.has(peer.peerId)
      ) {
        return null;
      }
      seenPeerIds.add(peer.peerId);
      peers.push({
        peerId: peer.peerId,
        preferred: peer.preferred,
        core: peer.core,
      });
    }

    return {
      kind: 'readable',
      preferredPeerId: record.preferredPeerId,
      privateOnly: record.privateOnly,
      peers,
    };
  } catch {
    return null;
  }
}

/**
 * A missing provider cannot make a prior clean miss fetchable. Reuse is therefore safe only
 * when the current ranked providers are a capability-preserving subsequence of those checked.
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
      || cachedPeer.preferred !== peer.preferred
      || cachedPeer.core !== peer.core
    ) {
      return false;
    }
    cachedIndex += 1;
  }
  return true;
}
