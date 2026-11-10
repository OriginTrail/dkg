import { isReadGraphEligibleContextGraphId, READ_GRAPH_SEGMENT, readGraphStateGraphIri } from '@origintrail-official/dkg-core';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';
import type { TripleStore } from './triple-store.js';

/** Only known complete decorator chains may project raw query inventories. */
export function composeGraphEnumerationVisibility(inner: TripleStore, visible: (graph: string) => boolean) {
  const innerVisible = inner.graphEnumerationVisibility?.bind(inner);
  return innerVisible ? (graph: string) => innerVisible(graph) && visible(graph) : undefined;
}

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const READ_GRAPH_PARTITION_MARK = `/${READ_GRAPH_SEGMENT}`;

/**
 * The context graph whose read-graph partition (`{cg}/_~read` and every graph
 * below it) holds a graph, or undefined for a graph outside every partition.
 * No context-graph ID can contain the partition segment and no sub-graph name
 * can start with `_`, so its first occurrence ends the context-graph ID.
 */
export function readGraphPartitionOwner(graph: string): string | undefined {
  // The substring test keeps whole-catalog filtering cheap; the segment test decides.
  if (!graph.includes(READ_GRAPH_PARTITION_MARK) || !graph.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const segments = graph.slice(CONTEXT_GRAPH_PREFIX.length).split('/');
  const partition = segments.indexOf(READ_GRAPH_SEGMENT, 1);
  return partition === -1 ? undefined : segments.slice(0, partition).join('/');
}

/** Whether a graph is in some context graph's read-graph partition. */
export function isReadGraphPartitionGraph(graph: string): boolean {
  return readGraphPartitionOwner(graph) !== undefined;
}

/** Whether a graph is the read-graph state graph of a context graph that can have read graphs. */
export function isReadGraphStateGraph(graph: string): boolean {
  const owner = readGraphPartitionOwner(graph);
  return owner !== undefined && isReadGraphEligibleContextGraphId(owner) && readGraphStateGraphIri(owner) === graph;
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
