// SPDX-License-Identifier: Apache-2.0
import { contextGraphDataUri, contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';
import { classifyScopedContentGraph, isExcludedContentGraphTail } from './scoped-content-partition.js';
import { resolveDraftAccessPolicy, selectContentPartitions } from './content-partition-policy.js';
import type { ContentPartition } from './content-partition-policy.js';
import type { QueryOptions } from './query-engine.js';
import type { ContextGraphPartitionRead } from './query-types.js';

/** Route selection owns admission labels, including static roots and metadata. */
export function createScopedContentGraphRoutePolicy(contextGraphId: string, options: QueryOptions = {}) {
  const route = staticScopedRouteGraphs(contextGraphId, options);
  const draftAccess = resolveDraftAccessPolicy(options);
  const includeSharedMemoryMeta = options.includeSharedMemoryMeta === true;
  return { ...route, contextGraphId, draftAccess, includeSharedMemoryMeta, rootGraph: contextGraphDataUri(contextGraphId),
    metadataGraphs: route.metaAllowList };
}
type RoutePolicy = ReturnType<typeof createScopedContentGraphRoutePolicy>;
function read(graph: string, shared: boolean): ContextGraphPartitionRead {
  return { graph, admission: shared ? 'shared-memory' : 'public' };
}
function sharedKind(kind: ContentPartition['kind'] | 'shared-root'): boolean {
  return kind === 'shared' || kind === 'shared-root' || kind === 'shared-metadata';
}
/** Static and discovered selections merge here for ordinary, inventory and exact routes. */
export function mergeScopedRouteReads(policy: RoutePolicy, dynamic: readonly ContextGraphPartitionRead[]): ContextGraphPartitionRead[] {
  const staticReads = [
    ...policy.staticContentGraphs.map(graph => read(graph, graph === policy.sharedMemoryGraph)),
    ...policy.metaAllowList.map(graph => read(graph, graph === contextGraphSharedMemoryMetaUri(policy.contextGraphId, policy.subGraphName))),
  ];
  return [...new Map([...staticReads, ...dynamic].map(partition => [partition.graph, partition])).values()];
}
/** Authorization discovery is narrower than combined execution for an explicit SWM suffix. */
export function scopedRouteContentPrefixes(route: ReturnType<typeof staticScopedRouteGraphs>) {
  const targets = route.execution.kind === 'combined' ? [route.execution.data, route.execution.sharedMemory] : [route.execution.target];
  return targets.filter(target => target.family !== 'data' || !route.isSwmOnlyRoute)
    .map(({ root, family }) => ({ root, prefix: `${root}/${family === 'data' ? '_verifiable_memory/' : ''}`, family }));
}
/** Inventory and exact admission differ only in how they obtain classified candidates. */
export function selectScopedRoutePartitions(policy: RoutePolicy, partitions: readonly ContentPartition[]): ContextGraphPartitionRead[] {
  const selected = policy.isSwmOnlyRoute
    ? new Set(partitions.filter(partition => partition.graph.startsWith(`${policy.sharedMemoryGraph}/`)).map(partition => partition.graph))
    : new Set(selectContentPartitions(partitions, policy.draftAccess, policy.subGraphName, policy.includeSharedMemoryMeta));
  return mergeScopedRouteReads(policy, partitions.filter(partition => selected.has(partition.graph))
    .map(partition => read(partition.graph, sharedKind(partition.kind))));
}
/** Legacy explicit IRIs retain prefix authority without gaining classified draft expansion. */
export function selectLegacyScopedRoutePartitions(policy: RoutePolicy, partitions: ReadonlyMap<string, readonly string[]>): ContextGraphPartitionRead[] {
  return mergeScopedRouteReads(policy, scopedRouteContentPrefixes(policy).flatMap(({ root, family }) =>
    (partitions.get(root) ?? []).filter(graph => !isExcludedContentGraphTail(graph.slice(policy.rootGraph.length + 1)))
      .map(graph => read(graph, family === 'shared-memory'))));
}
export function isScopedRoutePartition(policy: RoutePolicy,
  graph: string, registeredSubGraphs: Set<string>, registeredAssertionGraphs: Set<string>, children: Set<string>): boolean {
  const partition = classifyScopedContentGraph(graph, policy.contextGraphId, registeredSubGraphs, registeredAssertionGraphs, children);
  return selectScopedRoutePartitions(policy, partition ? [partition] : []).some(candidate => candidate.graph === graph);
}
