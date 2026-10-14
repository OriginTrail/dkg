import { contextGraphDataUri } from '@origintrail-official/dkg-core';

export type ContentPartitionSelection = 'all-content' | 'published-content';
/** Classify only a memory-layer segment immediately under a CG or sub-graph root. */
export function contentPartitionLayer(tail: string): 'draft' | 'shared' | 'verified' | undefined {
  const first = tail.split('/', 1)[0];
  if (first === '_working_memory' || first === 'assertion') return 'draft';
  if (first === '_shared_memory') return 'shared';
  if (first === '_verifiable_memory') return 'verified';
  return undefined;
}
/** Apply caller policy after discovery; its memo retains the complete authorized inventory. */
export function selectContentPartitions(graphs: readonly string[], contextGraphId: string,
  selection: ContentPartitionSelection): string[] {
  if (selection === 'all-content') return [...graphs];
  const prefix = `${contextGraphDataUri(contextGraphId)}/`;
  return graphs.filter(graph => {
    if (!graph.startsWith(prefix)) return true;
    const tail = graph.slice(prefix.length), slash = tail.indexOf('/');
    const layer = contentPartitionLayer(tail)
      ?? (slash < 0 ? undefined : contentPartitionLayer(tail.slice(slash + 1)));
    return layer !== 'draft';
  });
}
