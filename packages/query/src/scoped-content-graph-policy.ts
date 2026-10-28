// SPDX-License-Identifier: Apache-2.0
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';
import { classifyScopedContentGraph, isExcludedContentGraphTail } from './scoped-content-partition.js';
import { resolveDraftAccessPolicy, selectContentPartitions } from './content-partition-policy.js';
import type { DraftAccessPolicy } from './content-partition-policy.js';
import type { QueryOptions } from './query-engine.js';

/** Exact admission consumes the same route and partition policy as ordinary reads. */
export function createScopedContentGraphRoutePolicy(contextGraphId: string, options: QueryOptions = {}) {
  const route = staticScopedRouteGraphs(contextGraphId, options);
  return scopedPartitionPolicyFromRoute(contextGraphId, route, resolveDraftAccessPolicy(options), options.includeSharedMemoryMeta === true);
}
export function scopedPartitionPolicyFromRoute(contextGraphId: string, route: ReturnType<typeof staticScopedRouteGraphs>,
  draftAccess: DraftAccessPolicy, includeSharedMemoryMeta: boolean) {
  return { ...route, contextGraphId, draftAccess, includeSharedMemoryMeta, rootGraph: contextGraphDataUri(contextGraphId),
    metadataGraphs: route.metaAllowList };
}
export function isScopedRoutePartition(policy: ReturnType<typeof createScopedContentGraphRoutePolicy>,
  graph: string, registeredSubGraphs: Set<string>, registeredAssertionGraphs: Set<string>, children: Set<string>): boolean {
  if (policy.metaAllowList.includes(graph)) return true;
  if (graph !== policy.rootGraph && (!graph.startsWith(`${policy.rootGraph}/`) || isExcludedContentGraphTail(graph.slice(policy.rootGraph.length + 1)))) return false;
  if (policy.staticContentGraphs.includes(graph)) return true;
  if (policy.isSwmOnlyRoute) return graph.startsWith(`${policy.sharedMemoryGraph}/`);
  const partition = classifyScopedContentGraph(graph, policy.contextGraphId, registeredSubGraphs, registeredAssertionGraphs, children);
  return !!partition && selectContentPartitions([partition], policy.draftAccess,
    policy.subGraphName, policy.includeSharedMemoryMeta).includes(graph);
}
