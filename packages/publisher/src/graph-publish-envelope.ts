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

export function resolveGraphPublishAccess(
  accessPolicy: string | undefined,
  rawAllowedPeers: readonly string[],
): { accessPolicy: 'public' | 'ownerOnly' | 'allowList'; allowedPeers: string[] } | undefined {
  const allowedPeers = [...new Set(rawAllowedPeers.map(peer => peer.trim()).filter(Boolean))];
  if (
    !isGraphPublishAccessPolicy(accessPolicy)
    || allowedPeers.length !== rawAllowedPeers.length
    || (accessPolicy === 'allowList' ? allowedPeers.length === 0 : allowedPeers.length !== 0)
  ) return undefined;
  return { accessPolicy, allowedPeers };
}
