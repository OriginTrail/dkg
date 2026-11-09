// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve the node default agent's wallet/legacy-peer identity without choosing a read scope.
 * The consumer supplies its existing comparison normalization; returned aliases retain
 * their original spelling because they identify stored working-memory namespaces.
 */
export function resolveWorkingMemoryIdentityAliases(
  node: { readonly defaultAgentAddress?: string; readonly peerId?: string },
  address: string | undefined,
  normalizeAddress: (address: string) => string,
): { canonicalAddress: string | undefined; isDefaultAgentAddress: boolean; aliases: string[] | undefined } {
  if (!address) return { canonicalAddress: undefined, isDefaultAgentAddress: false, aliases: undefined };
  const normalized = normalizeAddress(address);
  const defaultAddress = node.defaultAgentAddress ? normalizeAddress(node.defaultAgentAddress) : undefined;
  const peerId = node.peerId ? normalizeAddress(node.peerId) : undefined;
  const isDefaultAgentAddress = !!defaultAddress && normalized === defaultAddress;
  const isLegacyPeer = !!defaultAddress && !!peerId && normalized === peerId;
  return {
    canonicalAddress: isLegacyPeer ? defaultAddress : normalized,
    isDefaultAgentAddress,
    aliases: defaultAddress && peerId && isDefaultAgentAddress
      ? [node.peerId!] : isLegacyPeer ? [node.defaultAgentAddress!] : undefined,
  };
}

/** Canonical draft policy shared by ordinary queries, inventory and statistics. */
export function resolveCallerDraftAccess(
  node: { readonly defaultAgentAddress?: string; readonly peerId?: string },
  callerAgentAddress?: string,
  excludeWorkingMemory = false,
): NonNullable<import('@origintrail-official/dkg-query').QueryOptions['draftAccess']> {
  const owner = callerAgentAddress ?? node.defaultAgentAddress ?? node.peerId;
  if (excludeWorkingMemory || !owner) return { kind: 'none' };
  const aliases = resolveWorkingMemoryIdentityAliases(node, owner, address => address.toLowerCase()).aliases ?? [];
  return { kind: 'owners', owners: [owner, ...aliases] };
}
