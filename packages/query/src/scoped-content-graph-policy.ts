// SPDX-License-Identifier: Apache-2.0

import { contextGraphDataUri, isAssertionScopedChildGraph, validateSubGraphName } from '@origintrail-official/dkg-core';

export function isScopedContentGraph(
  graph: string,
  contextGraphId: string,
  registeredSubGraphs: Set<string>,
  registeredAssertionGraphs: Set<string>,
  knownChildContextGraphs: Set<string>,
  subGraphName?: string,
): boolean {
  const root = contextGraphDataUri(contextGraphId);
  if (graph === root) return !subGraphName;
  if (!graph.startsWith(`${root}/`)) return false;
  if (isKnownChildContextGraphPartition(graph, knownChildContextGraphs)) return false;

  const tail = graph.slice(root.length + 1);
  if (
    !tail ||
    isMetadataGraphTail(tail) ||
    isPrivateGraphTail(tail) ||
    isRulesGraphTail(tail) ||
    isStagingGraphTail(tail)
  ) {
    return false;
  }

  if (!subGraphName) {
    if (tail.startsWith('_shared_memory/')) return true;
    if (tail.startsWith('_verifiable_memory/')) return !isMetadataGraphTail(tail);
    if (tail.startsWith('_working_memory/')) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs);
  }

  const slash = tail.indexOf('/');
  const firstSegment = slash >= 0 ? tail.slice(0, slash) : tail;
  const remaining = slash >= 0 ? tail.slice(slash + 1) : '';
  if (subGraphName && firstSegment !== subGraphName) return false;
  if (!registeredSubGraphs.has(firstSegment) || !validateSubGraphName(firstSegment).valid) {
    return false;
  }

  if (!remaining) return true;
  if (remaining.startsWith('_shared_memory/')) return true;
  if (remaining.startsWith('_verifiable_memory/')) return !isMetadataGraphTail(remaining);
  if (remaining.startsWith('_working_memory/')) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs);
  return false;
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
  return tail.startsWith('_verifiable_memory/staging/') || tail.includes('/_verifiable_memory/staging/');
}

export function isExcludedContentGraphTail(tail: string): boolean {
  return isMetadataGraphTail(tail) || isPrivateGraphTail(tail) || isRulesGraphTail(tail) || isStagingGraphTail(tail);
}
