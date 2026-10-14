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
): ContentPartition | undefined {
  const root = contextGraphDataUri(contextGraphId);
  const admit = (kind: Exclude<ContentPartition['kind'], 'draft'>, subGraphName?: string): ContentPartition =>
    Object.freeze({ graph, kind, ...(subGraphName ? { subGraphName } : {}) });
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

  // Normalize the optional registered subgraph coordinate once. Partition
  // semantics and draft ownership are identical below root and subgraphs.
  let partition = tail;
  let subGraphName: string | undefined;
  const first = tail.split('/', 1)[0];
  if (!first.startsWith('_') && first !== 'assertion') {
    if (!registeredSubGraphs.has(first) || !validateSubGraphName(first).valid) return undefined;
    subGraphName = first;
    partition = tail.length === first.length ? '' : tail.slice(first.length + 1);
  }
  if (!partition) return admit('content', subGraphName);
  if (partition.startsWith('_shared_memory/')) return admit('shared', subGraphName);
  if (partition.startsWith('_verifiable_memory/')) return admit('verified', subGraphName);
  if (isDraft(partition) && isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs)) {
    return Object.freeze({ graph, kind: 'draft', draftOwner: partition.split('/')[1] ?? null,
      ...(subGraphName ? { subGraphName } : {}) });
  }
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

