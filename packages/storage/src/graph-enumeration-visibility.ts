import {
  isReadGraphEligibleContextGraphId,
  parseReadGraphIri,
  READ_GRAPH_SEGMENT,
  readGraphStateGraphIri,
} from '@origintrail-official/dkg-core';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';
import type { TripleStore } from './triple-store.js';

/** Only known complete decorator chains may project raw query inventories. */
export function composeGraphEnumerationVisibility(inner: TripleStore, visible: (graph: string) => boolean) {
  const innerVisible = inner.graphEnumerationVisibility?.bind(inner);
  return innerVisible ? (graph: string) => innerVisible(graph) && visible(graph) : undefined;
}

const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const READ_GRAPH_PARTITION_MARK = `/${READ_GRAPH_SEGMENT}/`;

/**
 * The context graph whose read-graph partition holds a graph: one of its read
 * graphs, or the state graph that records them. Undefined for any other IRI
 * with a `_read` segment, such as a graph of an older context graph whose ID
 * has one: that names an ordinary graph.
 */
export function readGraphPartitionOwner(graph: string): string | undefined {
  // The substring test keeps whole-catalog filtering cheap; the exact tests decide.
  if (!graph.includes(READ_GRAPH_PARTITION_MARK)) return undefined;
  return parseReadGraphIri(graph)?.scope.contextGraphId ?? readGraphStateGraphOwner(graph);
}

/** Whether a graph is a read graph or a read-graph state graph. */
export function isReadGraphPartitionGraph(graph: string): boolean {
  return readGraphPartitionOwner(graph) !== undefined;
}

/** Whether a graph is the read-graph state graph of a context graph that can have read graphs. */
export function isReadGraphStateGraph(graph: string): boolean {
  return graph.includes(READ_GRAPH_PARTITION_MARK) && readGraphStateGraphOwner(graph) !== undefined;
}

function readGraphStateGraphOwner(graph: string): string | undefined {
  if (!graph.startsWith(CONTEXT_GRAPH_PREFIX)) return undefined;
  const contextGraphId = graph.slice(CONTEXT_GRAPH_PREFIX.length).split('/').slice(0, -2).join('/');
  return isReadGraphEligibleContextGraphId(contextGraphId) && readGraphStateGraphIri(contextGraphId) === graph
    ? contextGraphId
    : undefined;
}

/**
 * Graphs that storage keeps for itself and never lists: the staging graphs of
 * atomic writes, and the read graphs and state graph of every context graph.
 */
export function isStorageHiddenGraph(graph: string): boolean {
  return isAtomicGraphReplaceStagingGraph(graph) || isReadGraphPartitionGraph(graph);
}

/** The named-graph visibility policy that every adapter exposes. */
export const storeGraphEnumerationVisibility = (graph: string): boolean => Boolean(graph) && !isStorageHiddenGraph(graph);
