import { describe, expect, it } from 'vitest';
import { READ_GRAPH_SEGMENT } from '@origintrail-official/dkg-core';
import {
  isLegacySyncGraphCandidateV1,
} from '../src/sync/legacy-sync-graph-candidate.js';

describe('legacy sync graph namespace eligibility', () => {
  const contextGraphId = 'admission-policy';
  const cg = `did:dkg:context-graph:${contextGraphId}`;

  it('rejects RFC-64 control records from every legacy lane', () => {
    const control = `${cg}/_sync/applied-cg/peer-a`;
    expect(isLegacySyncGraphCandidateV1(control, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphCandidateV1(control, contextGraphId, 'changelog')).toBe(false);
  });

  it('admits public payload and keeps top meta changelog-only', () => {
    expect(isLegacySyncGraphCandidateV1(cg, contextGraphId, 'durable-data')).toBe(true);
    expect(isLegacySyncGraphCandidateV1(`${cg}/assertion/1`, contextGraphId, 'durable-data')).toBe(true);
    // A `_read` segment is not the read-graph partition.
    expect(isLegacySyncGraphCandidateV1(`${cg}/_read/cg/_verifiable_memory`, contextGraphId, 'durable-data')).toBe(true);
    expect(isLegacySyncGraphCandidateV1(`${cg}/_meta`, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphCandidateV1(`${cg}/_meta`, contextGraphId, 'changelog')).toBe(true);
  });

  it.each([
    `${cg}/child/_meta`,
    `${cg}/child/_working_memory`,
    `${cg}/child/_shared_memory`,
    `${cg}/_private/draft`,
    `${cg}/${READ_GRAPH_SEGMENT}/cg/_verifiable_memory`,
    `${cg}/${READ_GRAPH_SEGMENT}/state`,
    `${cg}/${READ_GRAPH_SEGMENT}/stray`,
    `${cg}/code/${READ_GRAPH_SEGMENT}/sub/code/_shared_memory`,
    'did:dkg:context-graph:someone-else/assertion/1',
  ])('rejects reserved or foreign graph %s', (graph) => {
    expect(isLegacySyncGraphCandidateV1(graph, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphCandidateV1(graph, contextGraphId, 'changelog')).toBe(false);
  });

  it('preserves raw path depth when classifying first-level metadata', () => {
    expect(isLegacySyncGraphCandidateV1(
      `${cg}/child//_meta`,
      contextGraphId,
      'durable-data',
    )).toBe(true);
    expect(isLegacySyncGraphCandidateV1(
      `${cg}//_meta`,
      contextGraphId,
      'durable-data',
    )).toBe(false);
    expect(isLegacySyncGraphCandidateV1(
      `${cg}//_meta`,
      contextGraphId,
      'changelog',
    )).toBe(false);
  });
});
