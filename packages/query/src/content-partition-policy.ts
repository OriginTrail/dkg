export type ContentPartitionSelection = 'all-content' | 'published-content';
export interface ContentPartition {
  readonly graph: string;
  readonly kind: 'content' | 'draft' | 'shared' | 'verified';
  readonly subGraphName?: string;
}
/** Apply caller policy to classified discovery, before merging static route graphs. */
export function selectContentPartitions(partitions: readonly ContentPartition[],
  selection: ContentPartitionSelection, subGraphName?: string): string[] {
  return partitions.filter(partition => (!subGraphName || partition.subGraphName === subGraphName)
    && (selection === 'all-content' || partition.kind !== 'draft')).map(partition => partition.graph);
}
