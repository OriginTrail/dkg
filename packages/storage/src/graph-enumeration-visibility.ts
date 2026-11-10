import { isReadGraphPartitionIri, READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';
import type { TripleStore } from './triple-store.js';

/** Only known complete decorator chains may project raw query inventories. */
export function composeGraphEnumerationVisibility(inner: TripleStore, visible: (graph: string) => boolean) {
  const innerVisible = inner.graphEnumerationVisibility?.bind(inner);
  return innerVisible ? (graph: string) => innerVisible(graph) && visible(graph) : undefined;
}

const READ_GRAPH_PARTITION_MARK = `/${READ_GRAPH_SEGMENT}`;

/** A graph in some context graph's reserved read-graph partition (`{cg}/_read` and below). */
export function isReadGraphPartitionGraph(graph: string): boolean {
  // The substring test keeps whole-catalog filtering cheap; the exact test decides.
  return graph.includes(READ_GRAPH_PARTITION_MARK) && isReadGraphPartitionIri(graph);
}

/**
 * Graphs that storage keeps for itself and never lists: the staging graphs of
 * atomic writes, and every context graph's read-graph partition.
 */
export function isStorageHiddenGraph(graph: string): boolean {
  return isAtomicGraphReplaceStagingGraph(graph) || isReadGraphPartitionGraph(graph);
}

/** The named-graph visibility policy that every adapter exposes. */
export const storeGraphEnumerationVisibility = (graph: string): boolean => Boolean(graph) && !isStorageHiddenGraph(graph);
