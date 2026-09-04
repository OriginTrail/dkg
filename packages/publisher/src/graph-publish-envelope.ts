// Shared predicates only: wire handlers retain their own scope checks, error
// messages, and validation order.
export function hasValidGraphPublishContent(
  publicTripleCount: number,
  privateTripleCount: number,
  privateMerkleRoot: Uint8Array | undefined,
): boolean {
  return Number.isSafeInteger(publicTripleCount)
    && publicTripleCount >= 0
    && Number.isSafeInteger(privateTripleCount)
    && privateTripleCount >= 0
    && (publicTripleCount !== 0 || privateTripleCount !== 0)
    && (privateTripleCount <= 0 || privateMerkleRoot?.length === 32)
    && (privateTripleCount !== 0 || privateMerkleRoot === undefined);
}

export function isGraphPublishAccessPolicy(value: string | undefined): value is 'public' | 'ownerOnly' | 'allowList' {
  return value === 'public' || value === 'ownerOnly' || value === 'allowList';
}

export function normalizeGraphPublishPeers(peers: readonly string[]): string[] {
  return [...new Set(peers.map(peer => peer.trim()).filter(Boolean))];
}

export function hasValidGraphPublishPeers(
  accessPolicy: 'public' | 'ownerOnly' | 'allowList',
  rawPeerCount: number,
  allowedPeers: readonly string[],
): boolean {
  return allowedPeers.length === rawPeerCount
    && (accessPolicy === 'allowList' ? allowedPeers.length > 0 : allowedPeers.length === 0);
}
