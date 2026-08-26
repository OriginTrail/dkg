import { describe, expect, it } from 'vitest';
import {
  buildQueryCatalogWrite,
  decodeQueryCatalogBindings,
  groupQueryCatalogItems,
} from '../src/query-catalog.js';

const binding = (value: string) => ({ type: 'literal', value });

describe('query catalog codec', () => {
  it('decodes RDFJS bindings once and preserves execution metadata', () => {
    const items = decodeQueryCatalogBindings([{
      q: { type: 'uri', value: 'urn:dkg:profile:test:query:trace' },
      catalog: { type: 'uri', value: 'urn:dkg:profile:test:catalog:operations' },
      name: binding('Trace'),
      catalogName: binding('Operations'),
      sparql: binding('SELECT * WHERE { BIND({{id}} AS ?id) }'),
      subGraph: binding('incidents'),
      queryParameters: binding('[{"name":"id","type":"string"}]'),
      executionView: binding('working-memory'),
      rank: binding('2'),
      catalogRank: binding('3'),
    }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      slug: 'trace',
      catalogSlug: 'operations',
      subGraph: 'incidents',
      view: 'working-memory',
      rank: 2,
      catalogRank: 3,
      parameters: [{ name: 'id', type: 'string' }],
    });
    expect(groupQueryCatalogItems(items)[0]?.queries).toHaveLength(1);
  });

  it('deduplicates join multiplication but rejects conflicting legacy values', () => {
    const row = {
      q: 'urn:dkg:profile:test:query:trace',
      catalog: 'urn:dkg:profile:test:catalog:operations',
      sparql: 'SELECT * WHERE {}',
      subGraph: 'incidents',
    };
    expect(decodeQueryCatalogBindings([row, { ...row }])).toHaveLength(1);
    expect(() => decodeQueryCatalogBindings([
      row,
      { ...row, sparql: 'SELECT ?s WHERE { ?s ?p ?o }' },
    ])).toThrow(/conflicting sparql values/);
  });

  it('builds the same typed item and RDF write contract', () => {
    const write = buildQueryCatalogWrite({
      contextGraphId: 'test',
      name: 'Trace configuration',
      sparql: 'SELECT * WHERE { BIND({{id}} AS ?id) }',
      subGraph: 'incidents',
      catalogSlug: 'operations',
      catalogName: 'Operations',
      rank: 10,
      catalogRank: 20,
      parameters: [{ name: 'id', type: 'string' }],
      view: 'working-memory',
    });
    expect(write.savedQuery).toMatchObject({
      subGraph: 'incidents',
      view: 'working-memory',
      parameters: [{ name: 'id', type: 'string' }],
    });
    expect(write.quads).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: 'http://dkg.io/ontology/profile/executionView', object: '"working-memory"' }),
      expect.objectContaining({ predicate: 'http://dkg.io/ontology/profile/queryParameters' }),
    ]));
  });
});
