import {
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';

export interface SharedMemoryGraphDescriptor {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly dataGraph: string;
  readonly metaGraph: string;
  readonly ownershipKey: string;
}

/** Construct the canonical addressing and ownership tuple for one SWM scope. */
export function describeSharedMemoryGraphs(
  contextGraphId: string,
  subGraphName?: string,
): SharedMemoryGraphDescriptor | undefined {
  if (subGraphName !== undefined && !validateSubGraphName(subGraphName).valid) return undefined;
  return {
    contextGraphId,
    ...(subGraphName === undefined ? {} : { subGraphName }),
    dataGraph: contextGraphSharedMemoryUri(contextGraphId, subGraphName),
    metaGraph: contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName),
    ownershipKey: subGraphName === undefined ? contextGraphId : `${contextGraphId}\0${subGraphName}`,
  };
}

export function isSharedMemoryBucketDescendantDataGraph(graph: string, bucketGraph: string): boolean {
  if (!graph.startsWith(`${bucketGraph}/`)) return false;
  const tail = graph.slice(bucketGraph.length + 1);
  if (tail.startsWith('staging/')) return false;
  const parts = tail.split('/');
  return parts.length === 2 && parts[0].length > 0 && /^[0-9]+$/.test(parts[1]);
}

/** Parse an exact root/named metadata graph into its canonical SWM scope. */
export function parseSharedMemoryMetaGraph(
  contextGraphId: string,
  graph: string,
): SharedMemoryGraphDescriptor | undefined {
  const root = describeSharedMemoryGraphs(contextGraphId)!;
  if (graph === root.metaGraph) return root;
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  if (!graph.startsWith(prefix) || !graph.endsWith(suffix)) return undefined;
  const subGraphName = graph.slice(prefix.length, -suffix.length);
  const descriptor = describeSharedMemoryGraphs(contextGraphId, subGraphName);
  return descriptor?.metaGraph === graph ? descriptor : undefined;
}

/** Parse an aggregate or per-KA data graph into its canonical SWM scope. */
export function parseSharedMemoryDataGraph(
  contextGraphId: string,
  graph: string,
): SharedMemoryGraphDescriptor | undefined {
  const root = describeSharedMemoryGraphs(contextGraphId)!;
  if (graph === root.dataGraph || isSharedMemoryBucketDescendantDataGraph(graph, root.dataGraph)) {
    return root;
  }
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const marker = '/_shared_memory';
  if (!graph.startsWith(prefix)) return undefined;
  const markerAt = graph.indexOf(marker, prefix.length);
  if (markerAt <= prefix.length) return undefined;
  const subGraphName = graph.slice(prefix.length, markerAt);
  const descriptor = describeSharedMemoryGraphs(contextGraphId, subGraphName);
  if (!descriptor) return undefined;
  return graph === descriptor.dataGraph
    || isSharedMemoryBucketDescendantDataGraph(graph, descriptor.dataGraph)
    ? descriptor
    : undefined;
}

/**
 * True only for the aggregate or per-KA Shared Memory DATA graph of a valid
 * named subgraph. The Context Graph root bucket is deliberately excluded.
 *
 * RFC-64's 10.0.16 default catalog implementation owns only the root scope.
 * This predicate is the common boundary for the disjoint compatibility lane
 * that keeps existing named-subgraph SWM traffic live until catalog indexes,
 * checkpoints and replay support non-null `subGraphName` scopes.
 */
export function isNamedSubgraphSharedMemoryDataGraph(
  contextGraphId: string,
  graph: string,
): boolean {
  return parseSharedMemoryDataGraph(contextGraphId, graph)?.subGraphName !== undefined;
}

/** True only for the exact Shared Memory META graph of a valid named subgraph. */
export function isNamedSubgraphSharedMemoryMetaGraph(
  contextGraphId: string,
  graph: string,
): boolean {
  return parseSharedMemoryMetaGraph(contextGraphId, graph)?.subGraphName !== undefined;
}

/** Resolve the in-memory ownership partition for a Shared Memory data graph. */
export function sharedMemoryOwnershipKeyFromGraph(
  contextGraphId: string,
  dataGraph: string,
): string | undefined {
  return parseSharedMemoryDataGraph(contextGraphId, dataGraph)?.ownershipKey;
}
