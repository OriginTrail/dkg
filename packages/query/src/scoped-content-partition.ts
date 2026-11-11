import { ASSERTION_NAMED_GRAPH_PREFIX, READ_GRAPH_SEGMENT, contextGraphDataUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { isReadGraphPartitionGraph } from '@origintrail-official/dkg-storage';
import type { ContentPartition } from './content-partition-policy.js';

function isDraft(tail: string): boolean {
  const first = tail.split('/', 1)[0];
  return first === '_working_memory' || first === 'assertion';
}

export type ScopedContentGraphDescriptor = Readonly<{ subGraphName?: string }> & (
  | Readonly<{ kind: 'draft'; draftOwner: string | null }>
  | Readonly<{ kind: Exclude<ContentPartition['kind'], 'draft'> | 'shared-root'; draftOwner?: never }>
);
/** Pure storage-layout identity; authority dependencies are planned by the caller. */
export function describeScopedContentGraph(graph: string, contextGraphId: string): ScopedContentGraphDescriptor | undefined {
  const root = contextGraphDataUri(contextGraphId);
  if (graph === root) return { kind: 'content' };
  if (!graph.startsWith(`${root}/`)) return undefined;
  const tail = graph.slice(root.length + 1);
  if (!tail) return undefined;
  let partition = tail, subGraphName: string | undefined;
  const first = tail.split('/', 1)[0];
  if (!first.startsWith('_') && first !== 'assertion') {
    if (!validateSubGraphName(first).valid) return undefined;
    subGraphName = first;
    partition = tail.length === first.length ? '' : tail.slice(first.length + 1);
  }
  const base = { subGraphName };
  if (partition === '_shared_memory_meta') return { ...base, kind: 'shared-metadata' };
  if (isExcludedContentGraph(graph, root)) return undefined;
  if (!partition) return { ...base, kind: 'content' };
  if (partition === '_shared_memory') return { ...base, kind: 'shared-root' };
  if (partition.startsWith('_shared_memory/')) return { ...base, kind: 'shared' };
  if (partition.startsWith('_verifiable_memory/')) return { ...base, kind: 'verified' };
  if (!isDraft(partition)) return undefined;
  return { ...base, kind: 'draft', draftOwner: partition.split('/')[1] ?? null };
}

/** Draft registration can authorize an assertion graph and its named descendants. */
export function* assertionRegistrationCandidates(graph: string): Generator<string> {
  yield graph;
  let offset = graph.indexOf(ASSERTION_NAMED_GRAPH_PREFIX);
  while (offset >= 0) {
    yield graph.slice(0, offset);
    offset = graph.indexOf(ASSERTION_NAMED_GRAPH_PREFIX, offset + ASSERTION_NAMED_GRAPH_PREFIX.length);
  }
}
function hasRegisteredAssertionAncestor(graph: string, registered: Set<string>): boolean {
  for (const parent of assertionRegistrationCandidates(graph)) if (registered.has(parent)) return true;
  return false;
}

export function classifyScopedContentGraph(graph: string, contextGraphId: string,
  registeredSubGraphs: Set<string>, registeredAssertionGraphs: Set<string>,
  knownChildContextGraphs: Set<string>): ContentPartition | undefined {
  const description = describeScopedContentGraph(graph, contextGraphId);
  if (!description || description.kind === 'shared-root' || isKnownChildContextGraphPartition(graph, knownChildContextGraphs)) return undefined;
  const { subGraphName, kind } = description;
  if (kind === 'shared-metadata' && subGraphName !== undefined && !registeredSubGraphs.has(subGraphName)) return undefined;
  const scope = { graph, broadScopeEligible: subGraphName === undefined || registeredSubGraphs.has(subGraphName),
    ...(subGraphName ? { subGraphName } : {}) };
  if (kind === 'draft') {
    if (!hasRegisteredAssertionAncestor(graph, registeredAssertionGraphs)) return undefined;
    return Object.freeze({ ...scope, kind, draftOwner: description.draftOwner });
  }
  return Object.freeze({ ...scope, kind });
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
  return /^(?:[^/]+\/)?_(?:shared|verifiable)_memory\/staging(?:\/|$)/.test(tail);
}


function isExcludedContentGraphTail(tail: string): boolean {
  return isMetadataGraphTail(tail) || isPrivateGraphTail(tail) || isRulesGraphTail(tail) || isStagingGraphTail(tail);
}

/** A graph under a context graph's root that is never content. Read graphs and their state are node-local derived data. */
export function isExcludedContentGraph(graph: string, rootGraph: string): boolean {
  return isExcludedContentGraphTail(graph.slice(rootGraph.length + 1)) || isReadGraphPartitionGraph(graph);
}

/** The query options that a route turns into graph names: a context graph, a sub-graph, an agent or an assertion. */
const GRAPH_NAMING_QUERY_OPTIONS = ['contextGraphId', 'subGraphName', 'graphSuffix', 'agentAddress', 'agentAddressAliases',
  'assertionName', 'verifiedGraph'] as const;

/**
 * The first query option that names a read-graph partition: one that holds the
 * reserved segment as a path segment, so a graph built from it could fall in a
 * partition. Read graphs and their state are node-local derived data that no
 * caller query reads.
 */
export function queryOptionNamingReadGraphPartition(options: object | undefined): string | undefined {
  if (options === undefined) return undefined;
  const record = options as Readonly<Record<string, unknown>>;
  for (const name of GRAPH_NAMING_QUERY_OPTIONS) {
    const value = record[name];
    const values = Array.isArray(value) ? value : [value];
    if (values.some(entry => typeof entry === 'string' && entry.split('/').includes(READ_GRAPH_SEGMENT))) return name;
  }
  return undefined;
}
