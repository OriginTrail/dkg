import { knowledgeAssetAgentAddressesEqual } from '@origintrail-official/dkg-core';

/** The only internal decision about which discovered drafts a read may include. */
export type DraftAccessPolicy = { readonly kind: 'all' | 'none' }
  | { readonly kind: 'owners'; readonly owners: readonly string[] };

/** Normalize the trusted-engine default; external adapters supply their caller policy. */
export function resolveDraftAccessPolicy(options?: {
  draftAccess?: DraftAccessPolicy;
}): DraftAccessPolicy {
  return options?.draftAccess ?? { kind: 'all' };
}

interface ContentPartitionScope {
  readonly graph: string;
  readonly subGraphName?: string;
  readonly broadScopeEligible: boolean;
}
export type ContentPartition = ContentPartitionScope & (
  // Null explicitly represents a registered historical draft without an owner segment.
  | { readonly kind: 'draft'; readonly draftOwner: string | null }
  | { readonly kind: 'content' | 'shared' | 'verified' | 'shared-metadata'; readonly draftOwner?: never }
);
/** Apply caller policy to classified discovery, before merging static route graphs. */
export function selectContentPartitions(partitions: readonly ContentPartition[],
  draftAccess: DraftAccessPolicy, subGraphName?: string, includeSharedMemoryMeta = false): string[] {
  return partitions.filter(partition => {
    if (partition.kind === 'shared-metadata' && !includeSharedMemoryMeta) return false;
    if (subGraphName ? partition.subGraphName !== subGraphName : !partition.broadScopeEligible) return false;
    if (partition.kind !== 'draft' || draftAccess.kind === 'all') return true;
    const owner = partition.draftOwner;
    return draftAccess.kind === 'owners' && owner !== null
      && draftAccess.owners.some(allowed => knowledgeAssetAgentAddressesEqual(allowed, owner));
  }).map(partition => partition.graph);
}
