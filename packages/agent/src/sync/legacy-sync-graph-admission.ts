import { contextGraphDataUri } from '@origintrail-official/dkg-core';

export type LegacySyncGraphKind =
  | 'foreign'
  | 'public-payload'
  | 'top-meta'
  | 'subgraph-control-meta'
  | 'working-memory'
  | 'shared-memory'
  | 'private'
  | 'rfc64-control';

export type LegacySyncLane = 'durable-data' | 'changelog';

/**
 * Classify a graph at the shared admission boundary for legacy durable sync.
 * The classifier is deliberately structural: integrity-bearing assertion
 * `/_meta` graphs remain payload, while only the first-level subgraph marker
 * `<cg>/<subgraph>/_meta` is protocol control metadata.
 */
export function classifyLegacySyncGraphV1(
  graph: string,
  contextGraphId: string,
): LegacySyncGraphKind {
  const cg = contextGraphDataUri(contextGraphId);
  if (graph === cg) return 'public-payload';
  if (graph === `${cg}/_meta`) return 'top-meta';
  if (!graph.startsWith(`${cg}/`)) return 'foreign';

  const segments = graph.slice(cg.length + 1).split('/').filter(Boolean);
  if (segments[0] === '_sync') return 'rfc64-control';
  if (segments.includes('_private')) return 'private';
  if (segments.includes('_working_memory')) return 'working-memory';
  if (
    segments.includes('_shared_memory')
    || segments.includes('_shared_memory_meta')
  ) return 'shared-memory';
  if (segments.length === 2 && segments[1] === '_meta') {
    return 'subgraph-control-meta';
  }
  return 'public-payload';
}

/** The changelog additionally carries the top-level durable meta graph. */
export function isLegacySyncGraphAdmittedV1(
  graph: string,
  contextGraphId: string,
  lane: LegacySyncLane,
): boolean {
  const kind = classifyLegacySyncGraphV1(graph, contextGraphId);
  return kind === 'public-payload' || (lane === 'changelog' && kind === 'top-meta');
}
