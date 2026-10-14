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

export interface ContentPartition {
  readonly graph: string;
  readonly kind: 'content' | 'draft' | 'shared' | 'verified';
  readonly subGraphName?: string;
  readonly draftOwner?: string;
}
/** Apply caller policy to classified discovery, before merging static route graphs. */
export function selectContentPartitions(partitions: readonly ContentPartition[],
  draftAccess: DraftAccessPolicy, subGraphName?: string): string[] {
  return partitions.filter(partition => (!subGraphName || partition.subGraphName === subGraphName)
    && (partition.kind !== 'draft' || draftAccess.kind === 'all'
      || (draftAccess.kind === 'owners' && partition.draftOwner !== undefined
        && draftAccess.owners.some(owner => knowledgeAssetAgentAddressesEqual(owner, partition.draftOwner!)))))
    .map(partition => partition.graph);
}
