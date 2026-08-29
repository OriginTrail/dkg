import { describe, expect, it } from 'vitest';
import {
  isLegacySyncGraphAdmittedV1,
} from '../src/sync/legacy-sync-graph-admission.js';

describe('legacy sync graph admission', () => {
  const contextGraphId = 'admission-policy';
  const cg = `did:dkg:context-graph:${contextGraphId}`;

  it('rejects RFC-64 control records from every legacy lane', () => {
    const control = `${cg}/_sync/applied-cg/peer-a`;
    expect(isLegacySyncGraphAdmittedV1(control, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphAdmittedV1(control, contextGraphId, 'changelog')).toBe(false);
  });

  it('admits public payload and keeps top meta changelog-only', () => {
    expect(isLegacySyncGraphAdmittedV1(cg, contextGraphId, 'durable-data')).toBe(true);
    expect(isLegacySyncGraphAdmittedV1(`${cg}/assertion/1`, contextGraphId, 'durable-data')).toBe(true);
    expect(isLegacySyncGraphAdmittedV1(`${cg}/_meta`, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphAdmittedV1(`${cg}/_meta`, contextGraphId, 'changelog')).toBe(true);
  });

  it.each([
    `${cg}/child/_meta`,
    `${cg}/child/_working_memory`,
    `${cg}/child/_shared_memory`,
    `${cg}/_private/draft`,
    'did:dkg:context-graph:someone-else/assertion/1',
  ])('rejects reserved or foreign graph %s', (graph) => {
    expect(isLegacySyncGraphAdmittedV1(graph, contextGraphId, 'durable-data')).toBe(false);
    expect(isLegacySyncGraphAdmittedV1(graph, contextGraphId, 'changelog')).toBe(false);
  });
});
