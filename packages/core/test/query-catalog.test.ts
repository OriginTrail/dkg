import { describe, expect, it } from 'vitest';
import {
  buildQueryCatalogWrite,
  decodeQueryCatalogBindings,
  decodeQueryCatalogReadResponse,
  encodeQueryCatalogBindings,
  groupQueryCatalogItems,
  prepareQueryCatalogExecution,
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
  queryCatalogScopeGraphUri,
  queryCatalogSubGraphFromScopeGraph,
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
    }], { contextGraphId: 'test' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      slug: 'trace',
      catalogSlug: 'operations',
      subGraph: 'incidents',
      view: 'working-memory',
      rank: 2,
      catalogRank: 3,
      scopeGraph: 'did:dkg:context-graph:test/incidents',
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

  it('does not infer an execution view from query or catalog identifiers', () => {
    const row = {
      q: 'urn:consumer:query:open-records',
      catalog: 'urn:consumer:catalog:operations',
      sparql: 'SELECT * WHERE {}',
      subGraph: 'records',
    };
    expect(decodeQueryCatalogBindings([row])[0]?.view).toBeUndefined();
  });

  it('rejects invalid and conflicting persisted execution views', () => {
    const row = {
      q: 'urn:dkg:profile:test:query:trace',
      catalog: 'urn:dkg:profile:test:catalog:operations',
      sparql: 'SELECT * WHERE {}',
      subGraph: 'incidents',
    };
    expect(() => decodeQueryCatalogBindings([
      { ...row, executionView: 'verifiable-memroy' },
    ])).toThrow(/unsupported executionView value/);
    expect(() => decodeQueryCatalogBindings([{
      ...row,
      executionView: 'working-memory',
      view: 'verifiable-memory',
    }])).toThrow(/conflicting executionView and view values/);
  });

  it('round-trips canonical items as one deterministic legacy binding row', () => {
    const decoded = decodeQueryCatalogBindings([{
      q: 'urn:dkg:profile:test:query:trace',
      catalog: 'urn:dkg:profile:test:catalog:operations',
      name: 'Trace',
      sparql: 'SELECT * WHERE { BIND({{id}} AS ?id) }',
      subGraph: 'incidents',
      queryParameters: '[{"name":"id","type":"string"}]',
      executionView: 'working-memory',
      rank: '2',
      catalogName: 'Operations',
      catalogRank: '3',
    }]);
    const encoded = encodeQueryCatalogBindings(decoded);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toMatchObject({
      executionView: 'working-memory',
      queryParameters: '[{"name":"id","type":"string"}]',
    });
    expect(decodeQueryCatalogBindings(encoded)).toEqual(decoded);
  });

  it('preserves zero query and catalog ranks across a codec round trip', () => {
    const decoded = decodeQueryCatalogBindings([{
      q: 'urn:dkg:profile:test:query:first',
      catalog: 'urn:dkg:profile:test:catalog:first',
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
      rank: '0',
      catalogRank: '0',
    }]);
    expect(decoded[0]).toMatchObject({ rank: 0, catalogRank: 0 });
    expect(decodeQueryCatalogBindings(encodeQueryCatalogBindings(decoded))).toEqual(decoded);
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
      scopeGraph: 'did:dkg:context-graph:test/incidents',
      view: 'working-memory',
      parameters: [{ name: 'id', type: 'string' }],
    });
    expect(write.quads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: write.savedQuery.queryUri,
        predicate: 'http://dkg.io/ontology/profile/scopeGraph',
        object: 'did:dkg:context-graph:test/incidents',
      }),
      expect.objectContaining({ predicate: 'http://dkg.io/ontology/profile/executionView', object: '"working-memory"' }),
      expect.objectContaining({ predicate: 'http://dkg.io/ontology/profile/queryParameters' }),
    ]));
  });

  it('maps execution scopes to canonical Context Graph IRIs', () => {
    expect(queryCatalogScopeGraphUri('test', '__context_graph')).toBe(
      'did:dkg:context-graph:test',
    );
    expect(queryCatalogScopeGraphUri('test', 'incidents')).toBe(
      'did:dkg:context-graph:test/incidents',
    );
    expect(queryCatalogSubGraphFromScopeGraph(
      'test',
      'did:dkg:context-graph:test/incidents',
    )).toBe('incidents');
    expect(() => queryCatalogSubGraphFromScopeGraph(
      'test',
      'did:dkg:context-graph:other/incidents',
    )).toThrow(/outside context graph/);
    expect(() => queryCatalogSubGraphFromScopeGraph(
      'test',
      'did:dkg:context-graph:test/incidents/nested',
    )).toThrow(/Invalid query-catalog scope graph/);
  });

  it('requires canonical and legacy execution scopes to agree', () => {
    const row = {
      q: 'urn:dkg:profile:test:query:trace',
      catalog: 'urn:dkg:profile:test:catalog:operations',
      sparql: 'SELECT * WHERE {}',
      scopeGraph: 'did:dkg:context-graph:test/incidents',
      subGraph: 'incidents',
    };
    expect(decodeQueryCatalogBindings([row], { contextGraphId: 'test' })[0]).toMatchObject({
      scopeGraph: 'did:dkg:context-graph:test/incidents',
      subGraph: 'incidents',
    });
    expect(() => decodeQueryCatalogBindings([
      { ...row, subGraph: 'archive' },
    ], { contextGraphId: 'test' })).toThrow(/conflicting scopeGraph and forSubGraph/);
  });

  it('prepares one rendered request with exact view and subgraph scope', () => {
    expect(prepareQueryCatalogExecution({
      sparql: 'SELECT * WHERE { BIND({{id}} AS ?id) }',
      parameters: [{ name: 'id', type: 'string' }],
      view: 'working-memory',
      subGraph: 'incidents',
    }, { id: 'a" } UNION { ?s ?p ?o' })).toEqual({
      sparql: 'SELECT * WHERE { BIND("a\\" } UNION { ?s ?p ?o" AS ?id) }',
      view: 'working-memory',
      subGraphName: 'incidents',
    });
  });

  it('requires the versioned capability contract before head clients consume canonical items', () => {
    const item = decodeQueryCatalogBindings([{
      q: 'urn:dkg:profile:test:query:trace',
      catalog: 'urn:dkg:profile:test:catalog:operations',
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
    }], { contextGraphId: 'test' })[0]!;
    expect(decodeQueryCatalogReadResponse({
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: QUERY_CATALOG_READ_CAPABILITIES,
      contextGraphId: 'test',
      items: [item],
    })).toEqual([item]);

    expect(() => decodeQueryCatalogReadResponse({
      result: { type: 'bindings', bindings: [] },
    })).toThrow(/Incompatible query-catalog daemon contract/);
    expect(() => decodeQueryCatalogReadResponse({
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: { ...QUERY_CATALOG_READ_CAPABILITIES, executionView: false },
      contextGraphId: 'test',
      items: [item],
    })).toThrow(/Incompatible query-catalog daemon contract/);
    expect(() => decodeQueryCatalogReadResponse({
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: { ...QUERY_CATALOG_READ_CAPABILITIES, graphScopeIri: false },
      contextGraphId: 'test',
      items: [item],
    })).toThrow(/Incompatible query-catalog daemon contract/);
    expect(() => decodeQueryCatalogReadResponse({
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: QUERY_CATALOG_READ_CAPABILITIES,
      contextGraphId: 'test',
      items: [{ ...item, scopeGraph: 'did:dkg:context-graph:other' }],
    })).toThrow(/Invalid query-catalog item 0/);
  });
});
