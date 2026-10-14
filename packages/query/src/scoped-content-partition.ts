import { contextGraphDataUri, isAssertionScopedChildGraph, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { ContentPartition } from './content-partition-policy.js';

function isDraft(tail: string): boolean {
  const first = tail.split('/', 1)[0];
  return first === '_working_memory' || first === 'assertion';
}

export function classifyScopedContentGraph(
  graph: string,
  contextGraphId: string,
  registeredSubGraphs: Set<string>,
  registeredAssertionGraphs: Set<string>,
  knownChildContextGraphs: Set<string>,
  options: { includeUnregisteredSubGraphs?: boolean } = {},
): ContentPartition | undefined {
  const root = contextGraphDataUri(contextGraphId);
  const admit = (kind: ContentPartition['kind'], subGraphName?: string, draftTail?: string): ContentPartition =>
    Object.freeze({ graph, kind, ...(subGraphName ? { subGraphName, subGraphRegistered: registeredSubGraphs.has(subGraphName) } : {}),
      ...(draftTail ? { draftOwner: draftTail.split('/')[1] } : {}) });
  if (graph === root) return admit('content');
  if (!graph.startsWith(`${root}/`)) return undefined;
  if (isKnownChildContextGraphPartition(graph, knownChildContextGraphs)) return undefined;

  const tail = graph.slice(root.length + 1);
  if (
    !tail ||
    isMetadataGraphTail(tail) ||
    isPrivateGraphTail(tail) ||
    isRulesGraphTail(tail) ||
    isStagingGraphTail(tail)
  ) {
    return undefined;
  }

  if (tail.startsWith('_shared_memory/')) return admit('shared');
  if (tail.startsWith('_verifiable_memory/')) return admit('verified');
  if (isDraft(tail)) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs) ? admit('draft', undefined, tail) : undefined;

  const slash = tail.indexOf('/');
  const firstSegment = slash >= 0 ? tail.slice(0, slash) : tail;
  const remaining = slash >= 0 ? tail.slice(slash + 1) : '';
  if ((!registeredSubGraphs.has(firstSegment) && !options.includeUnregisteredSubGraphs) || !validateSubGraphName(firstSegment).valid) {
    return undefined;
  }

  if (!remaining) return admit('content', firstSegment);
  if (remaining.startsWith('_shared_memory/')) return admit('shared', firstSegment);
  if (remaining.startsWith('_verifiable_memory/')) return admit('verified', firstSegment);
  if (isDraft(remaining)) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs) ? admit('draft', firstSegment, remaining) : undefined;
  return undefined;
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

export function isKnownChildContextGraphPartition(graph: string, knownChildContextGraphs: Set<string>): boolean {
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

