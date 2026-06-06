import { describe, it, expect } from 'vitest';
import { contextGraphSubGraphUri } from '@origintrail-official/dkg-core';
import { buildEndorsementQuads, DKG_ENDORSES, DKG_ENDORSED_AT } from '../src/endorse.js';
import { EndorseVerifyMethods } from '../src/dkg-agent-endorse.js';

describe('buildEndorsementQuads', () => {
  it('produces correct endorsement triples', () => {
    const quads = buildEndorsementQuads(
      '0xAbc123',
      'did:dkg:base:84532/0xDef.../42',
      'ml-research',
    );

    expect(quads).toHaveLength(2);

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
  });

  it('uses agent DID format for subject', () => {
    const quads = buildEndorsementQuads('0xDEF456', 'ual:test', 'cg-1');
    expect(quads[0].subject).toBe('did:dkg:agent:0xDEF456');
  });

  it('uses context graph data URI for graph', () => {
    const quads = buildEndorsementQuads('0x1', 'ual:1', 'my-project');
    expect(quads[0].graph).toBe('did:dkg:context-graph:my-project');
  });

  it('rejects unsafe RDF terms before building endorsement quads', () => {
    expect(() =>
      buildEndorsementQuads('0x1', 'did:dkg:asset:1> } INSERT DATA { ?s ?p ?o } #', 'my-project'),
    ).toThrow(/Unsafe or empty IRI value/);

    expect(() =>
      buildEndorsementQuads('0x1', 'did:dkg:asset:1', 'bad>graph'),
    ).toThrow(/Unsafe or empty IRI value/);
  });
});

describe('verified-memory sub-graph promotion guards', () => {
  it('rejects a subGraphName that aliases a known child context graph', async () => {
    const fakeAgent = {
      store: {
        query: async () => ({
          type: 'bindings',
          bindings: [{ marker: '"type"' }],
        }),
      },
    };

    await expect(
      EndorseVerifyMethods.prototype.assertSubGraphDoesNotCollideWithKnownChildContextGraph.call(
        fakeAgent as any,
        'research',
        'code',
      ),
    ).rejects.toThrow(/known child context graph/);
  });

  it('allows non-colliding subGraphName values', async () => {
    const queries: string[] = [];
    const fakeAgent = {
      store: {
        query: async (sparql: string) => {
          queries.push(sparql);
          return { type: 'bindings', bindings: [] };
        },
      },
    };

    await expect(
      EndorseVerifyMethods.prototype.assertSubGraphDoesNotCollideWithKnownChildContextGraph.call(
        fakeAgent as any,
        'research',
        'code',
      ),
    ).resolves.toBeUndefined();

    expect(queries[0]).toContain(contextGraphSubGraphUri('research', 'code'));
    expect(queries[0]).toContain('did:dkg:context-graph:research/code/_meta');
  });
});
