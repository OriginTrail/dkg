import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';

export function isSharedMemoryBucketDescendantDataGraph(graph: string, bucketGraph: string): boolean {
  if (!graph.startsWith(`${bucketGraph}/`)) return false;
  const tail = graph.slice(bucketGraph.length + 1);
  if (tail.startsWith('staging/')) return false;
  const parts = tail.split('/');
  return parts.length === 2 && parts[0].length > 0 && /^[0-9]+$/.test(parts[1]);
}

/**
 * True only for the aggregate or per-KA Shared Memory DATA graph of a valid
 * named subgraph. The Context Graph root bucket is deliberately excluded.
 *
 * RFC-64's 10.0.15 default catalog implementation owns only the root scope.
 * This predicate is the common boundary for the disjoint compatibility lane
 * that keeps existing named-subgraph SWM traffic live until catalog indexes,
 * checkpoints and replay support non-null `subGraphName` scopes.
 */
export function isNamedSubgraphSharedMemoryDataGraph(
  contextGraphId: string,
  graph: string,
): boolean {
  const rootGraph = contextGraphWorkspaceGraphUri(contextGraphId);
  if (graph === rootGraph || isSharedMemoryBucketDescendantDataGraph(graph, rootGraph)) {
    return false;
  }

  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory';
  if (!graph.startsWith(prefix)) return false;
  const remainder = graph.slice(prefix.length);
  const suffixAt = remainder.indexOf(suffix);
  if (suffixAt <= 0) return false;
  const subGraphName = remainder.slice(0, suffixAt);
  if (!validateSubGraphName(subGraphName).valid) return false;
  const bucketGraph = graph.slice(0, prefix.length + suffixAt + suffix.length);
  const tail = remainder.slice(suffixAt + suffix.length);
  return tail === '' || isSharedMemoryBucketDescendantDataGraph(graph, bucketGraph);
}

/** True only for the exact Shared Memory META graph of a valid named subgraph. */
export function isNamedSubgraphSharedMemoryMetaGraph(
  contextGraphId: string,
  graph: string,
): boolean {
  const rootMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
  if (graph === rootMetaGraph) return false;
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  if (!graph.startsWith(prefix) || !graph.endsWith(suffix)) return false;
  const subGraphName = graph.slice(prefix.length, graph.length - suffix.length);
  return validateSubGraphName(subGraphName).valid;
}
