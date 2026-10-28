import { validateSubGraphName } from '@origintrail-official/dkg-core';
// SPDX-License-Identifier: Apache-2.0
import { contextGraphDataUri, contextGraphSharedMemoryMetaUri } from '@origintrail-official/dkg-core';
import { staticScopedRouteGraphs } from './static-scoped-route-graphs.js';
import { classifyScopedContentGraph, isExcludedContentGraphTail } from './scoped-content-partition.js';
import { resolveDraftAccessPolicy, isContentPartitionEligible } from './content-partition-policy.js';
import type { ContentPartition } from './content-partition-policy.js';
import type { QueryOptions } from './query-engine.js';
import type { ContextGraphPartitionRead } from './query-types.js';

/** Route selection owns admission labels, including static roots and metadata. */
export function createScopedContentGraphRoutePolicy(contextGraphId: string, options: QueryOptions = {}) {
  if (options.subGraphName !== undefined) {
    const validation = validateSubGraphName(options.subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name for query: ${validation.reason}`);
  }
  const route = staticScopedRouteGraphs(contextGraphId, options);
  const draftAccess = resolveDraftAccessPolicy(options);
  const includeSharedMemoryMeta = options.includeSharedMemoryMeta === true;
  return { ...route, contextGraphId, draftAccess, includeSharedMemoryMeta, rootGraph: contextGraphDataUri(contextGraphId),
    metadataGraphs: route.metaAllowList };
}
type RoutePolicy = ReturnType<typeof createScopedContentGraphRoutePolicy>;
/** Static roots and metadata are explicit exemptions from classified discovery. */
function isStaticScopedRoutePartition(policy: RoutePolicy, graph: string): boolean {
  return policy.staticContentGraphs.includes(graph) || policy.metaAllowList.includes(graph);
}
function isEligibleScopedPartition(policy: RoutePolicy, partition: ContentPartition): boolean {
  return policy.isSwmOnlyRoute ? partition.graph.startsWith(`${policy.sharedMemoryGraph}/`)
    : isContentPartitionEligible(partition, policy.draftAccess, policy.subGraphName, policy.includeSharedMemoryMeta);
}
function mergeRouteGraphs(policy: RoutePolicy, graphs: readonly string[]): string[] {
  return [...new Set([...policy.staticContentGraphs, ...policy.metaAllowList, ...graphs])];
}
/** Authorization discovery is narrower than combined execution for an explicit SWM suffix. */
export function scopedRouteContentPrefixes(route: ReturnType<typeof staticScopedRouteGraphs>) {
  const targets = route.execution.kind === 'combined' ? [route.execution.data, route.execution.sharedMemory] : [route.execution.target];
  return targets.filter(target => target.family !== 'data' || !route.isSwmOnlyRoute)
    .map(({ root, family }) => ({ root, prefix: `${root}/${family === 'data' ? '_verifiable_memory/' : ''}`, family }));
}
/** Ordinary routing needs graph identities only, using the same direct eligibility rule. */
export function selectScopedRouteGraphs(policy: RoutePolicy, partitions: readonly ContentPartition[]): string[] {
  return mergeRouteGraphs(policy, partitions.filter(partition => isEligibleScopedPartition(policy, partition)).map(partition => partition.graph));
}
/** Admission labels are constructed only at the typed inventory boundary. */
export function selectScopedRoutePartitions(policy: RoutePolicy, partitions: readonly ContentPartition[]): ContextGraphPartitionRead[] {
  const shared = new Set(partitions.filter(partition => partition.kind === 'shared' || partition.kind === 'shared-metadata').map(partition => partition.graph));
  shared.add(policy.sharedMemoryGraph);
  shared.add(contextGraphSharedMemoryMetaUri(policy.contextGraphId, policy.subGraphName));
  return selectScopedRouteGraphs(policy, partitions).map(graph => ({ graph, admission: shared.has(graph) ? 'shared-memory' : 'public' }));
}
/** Legacy explicit IRIs retain prefix authority without gaining classified draft expansion. */
export function selectLegacyScopedRouteGraphs(policy: RoutePolicy, partitions: ReadonlyMap<string, readonly string[]>): string[] {
  return mergeRouteGraphs(policy, scopedRouteContentPrefixes(policy).flatMap(({ root }) =>
    (partitions.get(root) ?? []).filter(graph => !isExcludedContentGraphTail(graph.slice(policy.rootGraph.length + 1)))));
}
export function isScopedRoutePartition(policy: RoutePolicy,
  graph: string, registeredSubGraphs: Set<string>, registeredAssertionGraphs: Set<string>, children: Set<string>): boolean {
  if (isStaticScopedRoutePartition(policy, graph)) return true;
  const partition = classifyScopedContentGraph(graph, policy.contextGraphId, registeredSubGraphs, registeredAssertionGraphs, children);
  return partition !== undefined && isEligibleScopedPartition(policy, partition);
}
