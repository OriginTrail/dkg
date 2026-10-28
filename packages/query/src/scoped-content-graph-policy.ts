// SPDX-License-Identifier: Apache-2.0
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';
import { classifyScopedContentGraph } from './scoped-content-partition.js';
import { resolveDraftAccessPolicy, selectContentPartitions } from './content-partition-policy.js';
import type { ContentPartition, DraftAccessPolicy } from './content-partition-policy.js';
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
/** Inventory and exact admission differ only in how they obtain classified candidates. */
export function selectScopedRoutePartitions(policy: ReturnType<typeof createScopedContentGraphRoutePolicy>,
  partitions: readonly ContentPartition[]): string[] {
  const dynamic = policy.isSwmOnlyRoute
    ? partitions.filter(partition => partition.graph.startsWith(`${policy.sharedMemoryGraph}/`)).map(partition => partition.graph)
    : selectContentPartitions(partitions, policy.draftAccess, policy.subGraphName, policy.includeSharedMemoryMeta);
  return [...new Set([...policy.staticContentGraphs, ...policy.metaAllowList, ...dynamic])];
}
export function isScopedRoutePartition(policy: ReturnType<typeof createScopedContentGraphRoutePolicy>,
  graph: string, registeredSubGraphs: Set<string>, registeredAssertionGraphs: Set<string>, children: Set<string>): boolean {
  const partition = classifyScopedContentGraph(graph, policy.contextGraphId, registeredSubGraphs, registeredAssertionGraphs, children);
  return selectScopedRoutePartitions(policy, partition ? [partition] : []).includes(graph);
}
