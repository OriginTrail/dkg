// SPDX-License-Identifier: Apache-2.0

import {
  assertSafeIri, contextGraphDataUri, contextGraphMetaUri,
  contextGraphSharedMemoryMetaUri, contextGraphSharedMemoryUri,
  contextGraphSubGraphMetaUri, contextGraphSubGraphUri,
  isAssertionScopedChildGraph, validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { QueryOptions } from './query-engine.js';

export interface ScopedContentGraphRoutePolicy {
  contextGraphId: string;
  subGraphName?: string;
  rootGraph: string;
  dataGraph: string;
  sharedMemoryGraph: string;
  isSwmOnlyRoute: boolean;
  sharedMemoryRouted: boolean;
  contentGraphs: string[];
  metadataGraphs: string[];
}

/** Static route membership shared by ordinary reads, exact batches and inventory. */
export function createScopedContentGraphRoutePolicy(
  contextGraphId: string,
  options: QueryOptions = {},
): ScopedContentGraphRoutePolicy {
  const subGraphName = options.subGraphName;
  if (subGraphName) {
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name for query: ${validation.reason}`);
  }
  const rootGraph = assertSafeIri(contextGraphDataUri(contextGraphId));
  const dataGraph = subGraphName ? contextGraphSubGraphUri(contextGraphId, subGraphName) : rootGraph;
  const sharedMemoryGraph = contextGraphSharedMemoryUri(contextGraphId, subGraphName);
  const isSwmOnlyRoute = options.graphSuffix === '_shared_memory';
  const sharedMemoryRouted = isSwmOnlyRoute || !!(options.includeSharedMemory ?? options.includeWorkspace);
  return {
    contextGraphId, subGraphName, rootGraph, dataGraph, sharedMemoryGraph,
    isSwmOnlyRoute, sharedMemoryRouted,
    contentGraphs: [...(!isSwmOnlyRoute ? [dataGraph] : []), ...(sharedMemoryRouted ? [sharedMemoryGraph] : [])],
    // Subgraph provenance is also written to root _meta; SWM-only routes exclude both.
    metadataGraphs: [
      ...(!isSwmOnlyRoute ? [contextGraphMetaUri(contextGraphId), ...(subGraphName ? [contextGraphSubGraphMetaUri(contextGraphId, subGraphName)] : [])] : []),
      contextGraphSharedMemoryMetaUri(contextGraphId, subGraphName),
    ],
  };
}

/** Facts may be exhaustive or candidate-bounded; their loading remains separate. */
export function isScopedRoutePartition(
  policy: ScopedContentGraphRoutePolicy,
  graph: string,
  registeredSubGraphs: Set<string>,
  registeredAssertionGraphs: Set<string>,
  knownChildContextGraphs: Set<string>,
): boolean {
  if (policy.metadataGraphs.includes(graph)) return true;
  const root = policy.rootGraph;
  if (graph !== root && !graph.startsWith(`${root}/`)) return false;
  const tail = graph === root ? '' : graph.slice(root.length + 1);
  if (isKnownChildContextGraphPartition(graph, knownChildContextGraphs)
    || isExcludedContentGraphTail(tail)) return false;
  if (policy.contentGraphs.includes(graph)) return true;
  if (policy.isSwmOnlyRoute) return graph.startsWith(`${policy.sharedMemoryGraph}/`);
  if (graph === root) return !policy.subGraphName;

  // Root and registered-subgraph partitions share one content-family policy.
  let contentTail = tail;
  const rootFamily = ['_shared_memory/', '_verifiable_memory/', '_working_memory/']
    .some(prefix => tail.startsWith(prefix));
  if (rootFamily) {
    if (policy.subGraphName) return false;
  } else {
    const slash = tail.indexOf('/');
    const name = slash >= 0 ? tail.slice(0, slash) : tail;
    if ((policy.subGraphName && name !== policy.subGraphName)
      || !registeredSubGraphs.has(name) || !validateSubGraphName(name).valid) return false;
    contentTail = slash >= 0 ? tail.slice(slash + 1) : '';
    if (!contentTail) return true;
  }
  if (contentTail.startsWith('_shared_memory/')
    || contentTail.startsWith('_verifiable_memory/')) return true;
  return contentTail.startsWith('_working_memory/')
    && isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs);
}

function isRegisteredAssertionGraphOrScopedChild(
  graph: string,
  registeredAssertionGraphs: Set<string>,
): boolean {
  if (registeredAssertionGraphs.has(graph)) return true;
  for (const registeredGraph of registeredAssertionGraphs) {
    if (isAssertionScopedChildGraph(graph, registeredGraph)) {
      return true;
    }
  }
  return false;
}

function isMetadataGraphTail(tail: string): boolean {
  return (
    tail === '_meta' ||
    tail === '_shared_memory_meta' ||
    tail.endsWith('/_meta') ||
    tail.endsWith('/_shared_memory_meta') ||
    tail.includes('/_meta/') ||
    tail.includes('/_shared_memory_meta/')
  );
}

function isPrivateGraphTail(tail: string): boolean {
  return tail === '_private' || tail.startsWith('_private/') || tail.endsWith('/_private') || tail.includes('/_private/');
}

function isRulesGraphTail(tail: string): boolean {
  return tail === '_rules' || tail.startsWith('_rules/') || tail.endsWith('/_rules') || tail.includes('/_rules/');
}

function isKnownChildContextGraphPartition(graph: string, knownChildContextGraphs: Set<string>): boolean {
  for (const childContextGraph of knownChildContextGraphs) {
    if (graph === childContextGraph || graph.startsWith(`${childContextGraph}/`)) {
      return true;
    }
  }
  return false;
}

function isStagingGraphTail(tail: string): boolean {
  return tail.includes('/staging/');
}

export function isExcludedContentGraphTail(tail: string): boolean {
  return isMetadataGraphTail(tail) || isPrivateGraphTail(tail) || isRulesGraphTail(tail) || isStagingGraphTail(tail);
}
