import { describe, expect, it } from 'vitest';
import { buildTripleRowsWithProvenance, deriveGraphTriples, stripSparqlComments } from '../src/ui/sparql-utils.js';

describe('SPARQL utility behavior', () => {
  it('keeps # fragments inside IRIs while removing real comments', () => {
    const query = `SELECT ?o WHERE {
  <http://www.w3.org/2000/01/rdf-schema#label> ?p ?o . # trailing comment
}`;
    const stripped = stripSparqlComments(query);
    expect(stripped).toContain('rdf-schema#label');
    expect(stripped).not.toContain('# trailing comment');
  });

  it('does not treat < comparison operators as IRI starts', () => {
    const query = `SELECT ?s WHERE {
  ?s <http://schema.org/value> ?n .
  FILTER(?n < 10) # drop this comment
}`;
    const stripped = stripSparqlComments(query);
    expect(stripped).toContain('FILTER(?n < 10)');
    expect(stripped).not.toContain('# drop this comment');
  });

  it('handles no-space comparison operators in filters', () => {
    const query = `SELECT ?s WHERE {
  ?s <http://schema.org/value> ?n .
  FILTER(?n<10) # remove this
}`;
    const stripped = stripSparqlComments(query);
    expect(stripped).toContain('FILTER(?n<10)');
    expect(stripped).not.toContain('# remove this');
  });

  it('keeps # inside relative IRI refs like <#me>', () => {
    const query = `SELECT ?s WHERE {
  <#me> <http://schema.org/name> "alice" .
  # comment
}`;
    const stripped = stripSparqlComments(query);
    expect(stripped).toContain('<#me>');
    expect(stripped).not.toContain('# comment');
  });

  it('derives triples using pattern constants and variable bindings', () => {
    const query = `SELECT ?o WHERE {
  <did:dkg:network:v9-testnet> <http://www.w3.org/2000/01/rdf-schema#label> ?o
}`;
    const result = [{ o: { value: 'OriginTrail' } }];
    expect(deriveGraphTriples(result, query)).toEqual([
      {
        s: 'did:dkg:network:v9-testnet',
        p: 'http://www.w3.org/2000/01/rdf-schema#label',
        o: 'OriginTrail',
      },
    ]);
  });

  it('expands PREFIX-based CURIE constants to full IRIs', () => {
    const query = `PREFIX schema: <http://schema.org/>
SELECT ?s WHERE {
  ?s schema:name "Alice"
}`;
    const result = [{ s: { value: 'did:dkg:agent:12D3KooWExample' } }];
    expect(deriveGraphTriples(result, query)).toEqual([
      {
        s: 'did:dkg:agent:12D3KooWExample',
        p: 'http://schema.org/name',
        o: '"Alice"',
      },
    ]);
  });

  it('supports default PREFIX for :curie tokens and datatypes', () => {
    const query = `PREFIX : <http://schema.org/>
SELECT ?s WHERE {
  ?s :name "1"^^:Integer
}`;
    const row = [{ s: { value: 'did:dkg:agent:12D3KooWDefaultPrefix' } }];
    expect(deriveGraphTriples(row, query)).toEqual([
      {
        s: 'did:dkg:agent:12D3KooWDefaultPrefix',
        p: 'http://schema.org/name',
        o: '"1"^^<http://schema.org/Integer>',
      },
    ]);
  });

  it('preserves language-tagged and CURIE-typed literal constants', () => {
    const queryWithLang = `SELECT ?s WHERE {
  ?s <http://schema.org/name> "chat"@en
}`;
    const queryWithTyped = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?s WHERE {
  ?s <http://schema.org/dateCreated> "2026-03-11T00:00:00Z"^^xsd:dateTime
}`;
    const row = [{ s: { value: 'did:dkg:agent:12D3KooWExample' } }];

    expect(deriveGraphTriples(row, queryWithLang)).toEqual([
      {
        s: 'did:dkg:agent:12D3KooWExample',
        p: 'http://schema.org/name',
        o: '"chat"@en',
      },
    ]);
    expect(deriveGraphTriples(row, queryWithTyped)).toEqual([
      {
        s: 'did:dkg:agent:12D3KooWExample',
        p: 'http://schema.org/dateCreated',
        o: '"2026-03-11T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      },
    ]);
  });

  it('returns one display row per graph for the same triple', () => {
    const triples = [{ s: 's1', p: 'p1', o: 'o1' }];
    const rows = [
      {
        s: 's1',
        p: 'p1',
        o: 'o1',
        g: 'did:dkg:paranet:agents/workspace',
        graphType: 'workspace',
        paranet: 'agents',
        source: '12D3abc',
        ual: 'did:dkg:kc:1',
        txHash: '0x1',
        timestamp: '2026-03-11T00:00:00Z',
      },
      {
        s: 's1',
        p: 'p1',
        o: 'o1',
        g: 'did:dkg:paranet:agents/data',
        graphType: 'data',
        paranet: 'agents',
        source: '12D3abc',
        ual: 'did:dkg:kc:1',
        txHash: '0x2',
        timestamp: '2026-03-11T00:00:01Z',
      },
    ];
    const expanded = buildTripleRowsWithProvenance(triples, rows);
    expect(expanded).toHaveLength(2);
    expect(expanded.map((row) => row.g).sort()).toEqual([
      'did:dkg:paranet:agents/data',
      'did:dkg:paranet:agents/workspace',
    ]);
  });

  it('keeps base triples visible when no provenance rows are found', () => {
    const triples = [{ s: 's1', p: 'p1', o: 'o1' }];
    const expanded = buildTripleRowsWithProvenance(triples, []);
    expect(expanded).toEqual([
      {
        s: 's1',
        p: 'p1',
        o: 'o1',
        g: '',
        graphType: '',
        paranet: '',
        source: '',
        ual: '',
        txHash: '',
        timestamp: '',
      },
    ]);
  });
});
