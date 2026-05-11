import { describe, it, expect } from 'vitest';
import { buildEndorsementQuads, DKG_ENDORSES, DKG_ENDORSED_AT } from '../src/endorse.js';

describe('buildEndorsementQuads', () => {
  it('produces the canonical endorsement triple + spec-required PROV/digest evidence', () => {
    const quads = buildEndorsementQuads(
      '0xAbc123',
      'did:dkg:base:84532/0xDef.../42',
      'ml-research',
    );

    // V10 Axiom 3 + 4 evidence: ENDORSE emits the canonical
    // (endorser → endorses → UAL) triple, the timestamp, the digest
    // literal so peers can recover the signer when a signature is
    // present, and a prov:Activity event of type dkg:Endorsement so
    // the audit trail is queryable in the same shape as SHARE/REVOKE.
    const endorseQuad = quads.find(q => q.predicate === DKG_ENDORSES);
    expect(endorseQuad).toBeDefined();
    expect(endorseQuad!.subject).toBe('did:dkg:agent:0xAbc123');
    expect(endorseQuad!.object).toBe('did:dkg:base:84532/0xDef.../42');
    expect(endorseQuad!.graph).toBe('did:dkg:context-graph:ml-research');

    const timestampQuad = quads.find(q => q.predicate === DKG_ENDORSED_AT);
    expect(timestampQuad).toBeDefined();
    expect(timestampQuad!.subject).toBe('did:dkg:agent:0xAbc123');
    expect(timestampQuad!.object).toMatch(/^\"\d{4}-\d{2}-\d{2}T/);
    expect(timestampQuad!.graph).toBe('did:dkg:context-graph:ml-research');

    const provActivity = quads.find(
      q => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
        && q.object === 'http://dkg.io/ontology/Endorsement',
    );
    expect(provActivity, 'ENDORSE must emit a prov:Activity dkg:Endorsement event').toBeDefined();
  });

  it('uses agent DID format for subject', () => {
    const quads = buildEndorsementQuads('0xDEF456', 'ual:test', 'cg-1');
    expect(quads[0].subject).toBe('did:dkg:agent:0xDEF456');
  });

  it('uses context graph data URI for graph', () => {
    const quads = buildEndorsementQuads('0x1', 'ual:1', 'my-project');
    expect(quads[0].graph).toBe('did:dkg:context-graph:my-project');
  });
});
