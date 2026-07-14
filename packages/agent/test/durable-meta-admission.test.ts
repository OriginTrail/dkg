import { describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  durableMetaDelegationSubjectAdmissionExpression,
} from '../src/sync/responder/durable-meta-admission.js';

describe('durable-meta delegation admission', () => {
  it('uses one store predicate to admit allowed and exclude orphaned or revoked delegations', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'durable-meta-admission';
    const cgEntity = contextGraphDataGraphUri(contextGraphId);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const active = `did:dkg:agent-delegation:${contextGraphId}:0xactive`;
    const orphaned = `did:dkg:agent-delegation:${contextGraphId}:0xorphaned`;
    const revoked = `did:dkg:agent-delegation:${contextGraphId}:0xrevoked`;
    const unrelated = 'did:dkg:agent-delegation:another-cg:0xactive';
    const delegation = (subject: string, agent: string): Quad[] => [{
      graph: metaGraph,
      subject,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
      object: `"${agent}"`,
    }, {
      graph: metaGraph,
      subject,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
      object: `"peer-${agent}"`,
    }];

    await store.insert([
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: '"0xAcTiVe"',
      },
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: '"0xrevoked"',
      },
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
        object: '"0xReVoKeD"',
      },
      ...delegation(active, '0xactive'),
      ...delegation(orphaned, '0xorphaned'),
      ...delegation(revoked, '0xrevoked'),
      ...delegation(unrelated, '0xactive'),
    ]);

    // Exercise the canonical predicate used inside the single-snapshot normal
    // and paged durable-meta queries.
    const result = await store.query(`
      SELECT DISTINCT ?s WHERE {
        VALUES ?g { <${metaGraph}> }
        GRAPH ?g { ?s ?p ?o }
        FILTER(${durableMetaDelegationSubjectAdmissionExpression(contextGraphId)})
      }
    `);
    expect(result.type).toBe('bindings');
    const embedded = result.type === 'bindings'
      ? new Set(result.bindings.map((row) => row['s']).filter(Boolean))
      : new Set<string>();

    expect(embedded).toEqual(new Set([active]));
  });
});
