import {
  contextGraphDataUri,
  isRfc64SemanticControlGraphV1,
} from '@origintrail-official/dkg-core';

export type LegacySyncLane = 'durable-data' | 'changelog';

/**
 * Static namespace eligibility for a legacy sync graph. Store-dependent
 * admission (assertion membership and child-CG rejection) remains a separate
 * responder boundary.
 */
export function isLegacySyncGraphCandidateV1(
  graph: string,
  contextGraphId: string,
  lane: LegacySyncLane,
): boolean {
  if (isRfc64SemanticControlGraphV1(graph, contextGraphId)) return false;

  const cg = contextGraphDataUri(contextGraphId);
  if (graph === cg) return true;
  if (graph === `${cg}/_meta`) return lane === 'changelog';
  if (!graph.startsWith(`${cg}/`)) return false;

  // Integrity-bearing assertion `/_meta` graphs remain payload. Only the
  // first-level `<cg>/<subgraph>/_meta` marker is protocol control metadata.
  const segments = graph.slice(cg.length + 1).split('/').filter(Boolean);
  if (segments.includes('_private')) return false;
  if (segments.includes('_working_memory')) return false;
  if (
    segments.includes('_shared_memory')
    || segments.includes('_shared_memory_meta')
  ) return false;
  return !(segments.length === 2 && segments[1] === '_meta');
}
