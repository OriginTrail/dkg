import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { durableMetaDelegations } from './_helpers/durable-meta-delegations.js';
import { durableMetaDelegationSubjectAdmissionExpression } from '../src/sync/responder/durable-meta-admission.js';

describe('durable-meta delegation admission', () => {
  it('admits allowed or participant members and excludes orphaned, revoked or foreign delegations', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'durable-meta-admission';
    const fixture = durableMetaDelegations(contextGraphId);
    try {
      await store.insert(fixture.quads);
      const result = await store.query(`
        SELECT DISTINCT ?s WHERE {
          VALUES ?g { <${fixture.metaGraph}> }
          GRAPH ?g { ?s ?p ?o }
          FILTER(${durableMetaDelegationSubjectAdmissionExpression(contextGraphId)})
        }
      `);
      expect(result.type).toBe('bindings');
      expect(result.type === 'bindings' ? new Set(result.bindings.map((row) => row['s'])) : null)
        .toEqual(fixture.admittedSubjects);
    } finally {
      await store.close();
    }
  });
});
