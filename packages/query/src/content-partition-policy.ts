export type ContentPartitionSelection = 'all-content' | 'published-content';
export interface ContentPartition {
  readonly graph: string;
  readonly kind: 'content' | 'draft' | 'shared' | 'verified';
  readonly subGraphName?: string;
  readonly draftOwner?: string;
  readonly subGraphRegistered?: boolean;
}
/** Apply caller policy to classified discovery, before merging static route graphs. */
export function selectContentPartitions(partitions: readonly ContentPartition[],
  selection: ContentPartitionSelection, subGraphName?: string, authorizedWorkingMemoryOwners: readonly string[] = []): string[] {
  return partitions.filter(partition => (subGraphName ? partition.subGraphName === subGraphName : partition.subGraphRegistered !== false)
    && (selection === 'all-content' || partition.kind !== 'draft'
      || (partition.draftOwner !== undefined && authorizedWorkingMemoryOwners.includes(partition.draftOwner))))
    .map(partition => partition.graph);
}
