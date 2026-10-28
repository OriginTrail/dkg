import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
  type QueryCatalogItem,
  type QueryCatalogReadResponse,
  type QueryCatalogWriteQuad,
} from '@origintrail-official/dkg-core/query-catalog';
import { registerQueryCatalogTools } from '../src/tools/query-catalog.js';
import { FakeClient, FakeServer, makeConfig } from './harness.js';

function savedQuery(overrides: Partial<QueryCatalogItem> = {}): QueryCatalogItem {
  return {
    queryIri: 'urn:dkg:profile:test-cg:query:configuration-commitments-1',
    catalogIri: 'urn:dkg:profile:test-cg:catalog:kamstrup-lifecycle',
    slug: 'configuration-commitments-1',
    name: 'Configuration commitments',
    description: 'Find customer commitments for an approved configuration.',
    sparql: 'SELECT ?commitment WHERE { ?commitment <urn:configurationId> {{configurationId}} }',
    resultColumn: 'commitment',
    rank: 1,
    catalogSlug: 'kamstrup-lifecycle',
    catalogName: 'Kamstrup lifecycle',
    catalogDescription: 'Lifecycle traceability queries.',
    catalogRank: 10,
    subGraph: 'digital-twin',
    scopeGraph: 'did:dkg:context-graph:test-cg/digital-twin',
    parameters: [{ name: 'configurationId', type: 'string' }],
    view: 'verifiable-memory',
    ...overrides,
  };
}

function catalogResponse(items: QueryCatalogItem[]): QueryCatalogReadResponse {
  return {
    schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
    capabilities: QUERY_CATALOG_READ_CAPABILITIES,
    contextGraphId: 'test-cg',
    graph: 'did:dkg:context-graph:test-cg/meta/query-catalog',
    items,
    result: { type: 'bindings', bindings: [] },
  };
}

describe('query-catalog MCP tools', () => {
  it('exposes the four tools through real MCP tools/list and tools/call', async () => {
    const item = savedQuery();
    const dkgClient = new FakeClient({
      readQueryCatalog: async () => catalogResponse([item]),
    });
    const server = new McpServer({ name: 'query-catalog-test', version: '0.0.1' });
    registerQueryCatalogTools(server, dkgClient.asDkgClient(), makeConfig());
    const client = new Client({ name: 'query-catalog-client', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const catalogTools = listed.tools.filter((tool) => tool.name.startsWith('dkg_query_catalog_'));
      expect(catalogTools.map((tool) => tool.name).sort()).toEqual([
        'dkg_query_catalog_context_graphs',
        'dkg_query_catalog_list',
        'dkg_query_catalog_run',
        'dkg_query_catalog_save',
      ]);
      expect(catalogTools.find((tool) => tool.name === 'dkg_query_catalog_run')?.annotations)
        .toMatchObject({ readOnlyHint: true });
      expect(catalogTools.find((tool) => tool.name === 'dkg_query_catalog_save')?.annotations)
        .toMatchObject({ readOnlyHint: false });

      const result = await client.callTool({ name: 'dkg_query_catalog_list', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        contextGraphId: 'test-cg',
        count: 1,
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('registers list/run as read-only and save as an explicit mutation', () => {
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), new FakeClient().asDkgClient(), makeConfig());

    expect(server.get('dkg_query_catalog_context_graphs').config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(server.get('dkg_query_catalog_list').config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(server.get('dkg_query_catalog_run').config.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(server.get('dkg_query_catalog_save').config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('discovers catalog-bearing Context Graphs from actual catalog reads', async () => {
    const item = savedQuery();
    const client = new FakeClient({
      listProjects: async () => [
        { id: 'described-only', name: 'Catalog in its description', description: 'Has a catalog', callerInvolved: true },
        { id: 'real-catalog', name: 'Real catalog', callerInvolved: true },
        { id: 'not-mine', name: 'Other', callerInvolved: false },
      ],
      readQueryCatalog: async (contextGraphId) => catalogResponse(
        contextGraphId === 'real-catalog' ? [item] : [],
      ),
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_context_graphs');

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('**real-catalog**');
    expect(result.content[0].text).not.toContain('**described-only**');
    expect(result.structuredContent).toMatchObject({
      scope: 'mine',
      accessibleCount: 2,
      inspectedCount: 2,
      matchingCount: 1,
      items: [{
        contextGraphId: 'real-catalog',
        count: 1,
        selectors: ['digital-twin/kamstrup-lifecycle/configuration-commitments-1'],
      }],
    });
  });

  it('lists stable selectors and parameter declarations from the canonical #2302 DTO', async () => {
    const item = savedQuery();
    const client = new FakeClient({
      readQueryCatalog: async () => catalogResponse([item]),
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_list');

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(
      '`digital-twin/kamstrup-lifecycle/configuration-commitments-1`',
    );
    expect(result.content[0].text).toContain('configurationId:string (required)');
    expect(result.structuredContent).toMatchObject({
      contextGraphId: 'test-cg',
      count: 1,
      items: [{ selector: 'digital-twin/kamstrup-lifecycle/configuration-commitments-1' }],
    });
  });

  it('renders declared parameters and executes the saved view/sub-graph contract', async () => {
    const item = savedQuery();
    const client = new FakeClient({
      readQueryCatalog: async () => catalogResponse([item]),
      query: async () => ({
        type: 'bindings' as const,
        bindings: [{ commitment: { type: 'uri' as const, value: 'urn:commitment:42' } }],
      }),
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_run', {
      selector: 'digital-twin/kamstrup-lifecycle/configuration-commitments-1',
      parameters: { configurationId: '748387' },
    });

    expect(result.isError).toBeFalsy();
    expect(client.queryCalls).toHaveLength(1);
    expect(client.queryCalls[0]).toMatchObject({
      contextGraphId: 'test-cg',
      subGraphName: 'digital-twin',
      view: 'verifiable-memory',
    });
    expect(client.queryCalls[0].sparql).toContain('"748387"');
    expect(result.content[0].text).toContain('urn:commitment:42');
  });

  it('supplies the daemon identity when a saved query targets Working Memory', async () => {
    const client = new FakeClient({
      readQueryCatalog: async () => catalogResponse([
        savedQuery({ view: 'working-memory' }),
      ]),
      query: async () => ({ type: 'bindings' as const, bindings: [] }),
    });
    client.agentIdentity = {
      peerId: 'peer-fallback',
      agentAddress: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
    };
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_run', {
      selector: 'digital-twin/kamstrup-lifecycle/configuration-commitments-1',
      parameters: { configurationId: '748387' },
    });

    expect(result.isError).toBeFalsy();
    expect(client.queryCalls[0]).toMatchObject({
      view: 'working-memory',
      agentAddress: '0x1111111111111111111111111111111111111111',
    });
  });

  it('applies result limits to authoritative structured bindings as well as rendered text', async () => {
    const client = new FakeClient({
      readQueryCatalog: async () => catalogResponse([savedQuery()]),
      query: async () => ({
        type: 'bindings' as const,
        bindings: [
          { commitment: { type: 'uri' as const, value: 'urn:commitment:1' } },
          { commitment: { type: 'uri' as const, value: 'urn:commitment:2' } },
        ],
      }),
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_run', {
      selector: 'digital-twin/kamstrup-lifecycle/configuration-commitments-1',
      parameters: { configurationId: '748387' },
      limit: 1,
    });

    expect(result.content[0].text).toContain('showing 1 of 2');
    expect(result.structuredContent).toMatchObject({
      result: { type: 'bindings', bindings: [{ commitment: { value: 'urn:commitment:1' } }] },
      resultMetadata: { totalCount: 2, returnedCount: 1, truncated: true },
    });
  });

  it('fails closed on an ambiguous unqualified selector', async () => {
    const client = new FakeClient({
      readQueryCatalog: async () => catalogResponse([
        savedQuery(),
        savedQuery({
          queryIri: 'urn:dkg:profile:test-cg:query:configuration-commitments-2',
          catalogIri: 'urn:dkg:profile:test-cg:catalog:other',
          catalogSlug: 'other',
        }),
      ]),
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_run', {
      selector: 'configuration-commitments-1',
      parameters: { configurationId: '748387' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('selector is ambiguous');
  });

  it('builds canonical RDF and delegates an immutable save to the daemon', async () => {
    let writeCall: {
      contextGraphId: string;
      quads: QueryCatalogWriteQuad[];
    } | undefined;
    const client = new FakeClient({
      writeQueryCatalog: async (args) => {
        writeCall = args;
        return {
          ok: true as const,
          contextGraphId: args.contextGraphId,
          graph: `did:dkg:context-graph:${args.contextGraphId}/meta`,
          subGraphName: 'meta' as const,
          assertionName: 'query-catalog-test',
          assertionUri: `did:dkg:context-graph:${args.contextGraphId}/assertion/default/query-catalog-test`,
          scopeGraphs: [`did:dkg:context-graph:${args.contextGraphId}/digital-twin`],
          scopeGraph: `did:dkg:context-graph:${args.contextGraphId}/digital-twin`,
          queryCount: 1,
          triplesWritten: args.quads.length,
          alreadyExists: false,
        };
      },
    });
    const server = new FakeServer();
    registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await server.call('dkg_query_catalog_save', {
      name: 'Configuration commitments',
      description: 'Find commitments.',
      sparql: 'SELECT ?commitment WHERE { ?commitment <urn:configurationId> {{configurationId}} }',
      subGraph: 'digital-twin',
      catalogSlug: 'kamstrup-lifecycle',
      catalogName: 'Kamstrup lifecycle',
      parameters: [{ name: 'configurationId', type: 'string', required: true }],
      view: 'verifiable-memory',
    });

    expect(result.isError).toBeFalsy();
    expect(writeCall).toMatchObject({ contextGraphId: 'test-cg' });
    expect(writeCall).not.toHaveProperty('mode');
    expect(writeCall!.quads.length).toBeGreaterThan(10);
    expect(writeCall!.quads.some((quad) =>
      quad.predicate === 'http://dkg.io/ontology/profile/queryParameters')).toBe(true);
    expect(result.content[0].text).toContain('digital-twin/kamstrup-lifecycle/');
    expect(result.content[0].text).toContain('assertion=query-catalog-test');
  });
});

describe('query-catalog boundary responses', () => {
  function harness(client: FakeClient, defaultProject: string | null = 'test-cg') {
    const server = new FakeServer();
    registerQueryCatalogTools(
      server.asMcpServer(),
      client.asDkgClient(),
      makeConfig({ defaultProject }),
    );
    return server;
  }
  const calls: Array<[string, Record<string, unknown>]> = [
    ['dkg_query_catalog_list', {}],
    ['dkg_query_catalog_run', { selector: 'missing' }],
    ['dkg_query_catalog_save', { name: 'All triples', sparql: 'SELECT * WHERE { ?s ?p ?o }' }],
  ];
  it.each(calls)('%s requires a project before invoking the daemon', async (name, input) => {
    let reads = 0;
    const client = new FakeClient({
      readQueryCatalog: async () => {
        reads++;
        throw new Error('unexpected read');
      },
      writeQueryCatalog: async () => {
        reads++;
        throw new Error('unexpected write');
      },
    });
    const result = await harness(client, null).call(name, input);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project specified');
    expect(reads).toBe(0);
  });
  it.each([
    ...calls,
    ['dkg_query_catalog_context_graphs', {}] as [string, Record<string, unknown>],
  ])('%s preserves a transport diagnostic', async (name, input) => {
    const fail = async (): Promise<never> => {
      throw 'daemon offline';
    };
    const result = await harness(
      new FakeClient({ listProjects: fail, readQueryCatalog: fail, writeQueryCatalog: fail }),
    ).call(name, input);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('daemon offline');
  });
  it('lists filtered results with accurate total counts and defaults', async () => {
    const client = new FakeClient({
      readQueryCatalog: async () =>
        catalogResponse([
          savedQuery({
            name: 'Default count',
            slug: 'first',
            parameters: [{ name: 'count', type: 'integer', defaultValue: 0 }],
            description: undefined,
            view: undefined,
          }),
          savedQuery({ name: 'No parameters', slug: 'second', parameters: [] }),
          savedQuery({ name: 'Other catalog', slug: 'third', catalogSlug: 'other' }),
          savedQuery({
            name: 'Other graph',
            slug: 'fourth',
            subGraph: 'other',
            scopeGraph: 'did:dkg:context-graph:test-cg/other',
          }),
        ]),
    });
    const server = harness(client);
    const result = await server.call('dkg_query_catalog_list', {
      catalogSlug: 'kamstrup-lifecycle',
      subGraph: 'digital-twin',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({ count: 2, items: [{ slug: 'first' }] });
    expect(result.content[0].text).toContain('showing 1 of 2');
    expect(result.content[0].text).toContain('default=0');
    expect(result.content[0].text).toContain('View: `default`');
    expect((await server.call('dkg_query_catalog_list', { limit: 4 })).content[0].text).toContain(
      'Parameters: none',
    );
    const empty = await server.call('dkg_query_catalog_list', { catalogSlug: 'missing' });
    expect(empty.isError).toBeFalsy();
    expect(empty.structuredContent).toMatchObject({ count: 0, items: [] });
  });
  it.each([0, 1])(
    'discovery reports partial inspection and caps selectors at %s',
    async (selectorLimit) => {
      const client = new FakeClient({
        listProjects: async () => [{ id: 'good' }, { id: 'bad' }, { id: 'uninspected' }],
        readQueryCatalog: async (id) => {
          if (id === 'bad') throw new Error('denied');
          return catalogResponse([savedQuery(), savedQuery({ slug: 'second' })]);
        },
      });
      const result = await harness(client).call('dkg_query_catalog_context_graphs', {
        scope: 'all',
        limit: 2,
        selectorLimit,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        accessibleCount: 3,
        inspectedCount: 2,
        matchingCount: 1,
        truncated: true,
        failures: [{ contextGraphId: 'bad', error: 'denied' }],
        items: [{ contextGraphId: 'good', count: 2, selectorsTruncated: true }],
      });
      const items = result.structuredContent!.items as Array<{ selectors: string[] }>;
      expect(items[0].selectors).toHaveLength(selectorLimit);
      expect(result.content[0].text).toContain('Only 2 of 3');
      expect(result.content[0].text).toContain('1 graph(s) could not be inspected');
      expect(result.content[0].text.includes('Selectors:')).toBe(selectorLimit > 0);
    },
  );
  it.each([true, false])(
    'does not conflate an empty discovery with failed inspection (failure=%s)',
    async (failure) => {
      const inspected: string[] = [];
      const client = new FakeClient({
        listProjects: async () => [{ id: 'first', role: ' Member ' }, { id: 'second' }],
        readQueryCatalog: async (id) => {
          inspected.push(id);
          if (failure) throw 'catalog inaccessible';
          return catalogResponse([]);
        },
      });
      const result = await harness(client).call('dkg_query_catalog_context_graphs', { limit: 1 });
      expect(inspected).toEqual(['first']);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        matchingCount: 0,
        truncated: true,
        items: [],
        failures: failure ? [{ contextGraphId: 'first', error: 'catalog inaccessible' }] : [],
      });
      expect(result.content[0].text).toContain('Inspection was limited to 1 of 2');
      expect(result.content[0].text.includes('could not be inspected')).toBe(failure);
    },
  );
  it('handles no accessible context graphs without reading any catalog', async () => {
    let reads = 0;
    const result = await harness(
      new FakeClient({
        listProjects: async () => [],
        readQueryCatalog: async () => {
          reads++;
          return catalogResponse([]);
        },
      }),
    ).call('dkg_query_catalog_context_graphs');
    expect(result.structuredContent).toMatchObject({
      inspectedCount: 0,
      matchingCount: 0,
      truncated: false,
      failures: [],
    });
    expect(reads).toBe(0);
  });
  it('reports an unknown selector without executing SPARQL', async () => {
    let queries = 0;
    const result = await harness(
      new FakeClient({
        readQueryCatalog: async () => catalogResponse([]),
        query: async () => {
          queries++;
          return { type: 'boolean', value: true };
        },
      }),
    ).call('dkg_query_catalog_run', { selector: 'absent' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Saved query not found: absent');
    expect(queries).toBe(0);
  });
  it.each([true, false])('preserves ASK %s with one boolean result', async (value) => {
    const client = new FakeClient({
      readQueryCatalog: async () =>
        catalogResponse([savedQuery({ parameters: [], sparql: 'ASK { ?s ?p ?o }' })]),
      query: async () => ({ type: 'boolean', value }),
    });
    const result = await harness(client).call('dkg_query_catalog_run', {
      selector: 'Configuration commitments',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(`\n\n${value}`);
    expect(result.structuredContent).toMatchObject({
      result: { type: 'boolean', value },
      resultMetadata: { totalCount: 1, returnedCount: 1, truncated: false },
    });
  });
  it.each([1, 2])(
    'caps CONSTRUCT results at %s without modifying the saved query',
    async (limit) => {
      const sparql = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
      const quads = [
        { subject: 'urn:first', predicate: 'urn:p', object: '"one"' },
        { subject: 'urn:second', predicate: 'urn:p', object: '"two"', graph: 'urn:graph' },
      ];
      const calls: unknown[] = [];
      const client = new FakeClient({
        readQueryCatalog: async () => catalogResponse([savedQuery({ parameters: [], sparql })]),
        query: async (args) => {
          calls.push(args);
          return { type: 'quads', quads };
        },
      });
      const result = await harness(client).call('dkg_query_catalog_run', {
        selector: 'configuration-commitments-1',
        limit,
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([expect.objectContaining({ sparql })]);
      expect(result.structuredContent).toMatchObject({
        result: { type: 'quads', quads: quads.slice(0, limit) },
        resultMetadata: { totalCount: 2, returnedCount: limit, truncated: limit === 1 },
      });
      expect(result.content[0].text.includes('showing')).toBe(limit === 1);
      expect(result.content[0].text.includes('urn:graph')).toBe(limit === 2);
    },
  );
  it.each([{ peerId: 'legacy-peer' }, { peerId: '' }])(
    'resolves strict WM identity before execution: %j',
    async (identity) => {
      let queries = 0;
      const client = new FakeClient({
        readQueryCatalog: async () =>
          catalogResponse([
            savedQuery({
              parameters: [],
              sparql: 'SELECT * WHERE { ?s ?p ?o }',
              view: 'working-memory',
            }),
          ]),
        getAgentIdentity: async () => identity,
        query: async (args) => {
          queries++;
          expect(args.agentAddress).toBe('legacy-peer');
          return { type: 'bindings', bindings: [] };
        },
      });
      const result = await harness(client).call('dkg_query_catalog_run', {
        selector: 'configuration-commitments-1',
      });
      expect(queries).toBe(identity.peerId ? 1 : 0);
      expect(Boolean(result.isError)).toBe(!identity.peerId);
      if (!identity.peerId)
        expect(result.content[0].text).toContain('resolvable daemon agent identity');
    },
  );
});

it('runs context-graph-wide saved queries without adding a subgraph or a memory view', async () => {
  const calls: unknown[] = [];
  const item = savedQuery({
    subGraph: '__context_graph',
    scopeGraph: 'did:dkg:context-graph:test-cg',
    view: undefined,
    parameters: [],
    sparql: 'SELECT * WHERE { ?s ?p ?o }',
  });
  const client = new FakeClient({
    readQueryCatalog: async () => catalogResponse([item]),
    query: async (args) => {
      calls.push(args);
      return { type: 'bindings', bindings: [] };
    },
  });
  const server = new FakeServer();
  registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  const result = await server.call('dkg_query_catalog_run', { selector: item.slug });
  expect(result.isError).toBeFalsy();
  expect(calls).toEqual([{ sparql: item.sparql, contextGraphId: 'test-cg' }]);
});

it('labels an idempotent catalog save as already existing', async () => {
  const client = new FakeClient({
    writeQueryCatalog: async (args) => ({
      ...(await new FakeClient().writeQueryCatalog(args)),
      alreadyExists: true,
      assertionName: 'catalog-entry',
      triplesWritten: 0,
    }),
  });
  const server = new FakeServer();
  registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  const result = await server.call('dkg_query_catalog_save', {
    name: 'All triples',
    sparql: 'SELECT * WHERE { ?s ?p ?o }',
  });
  expect(result.isError).toBeFalsy();
  expect(result.content[0].text).toContain('Query already exists');
  expect(result.structuredContent).toMatchObject({
    alreadyExists: true,
    triplesWritten: 0,
    assertionName: 'catalog-entry',
  });
});

it('excludes system context graphs from personal discovery even when marked as caller-owned', async () => {
  const reads: string[] = [];
  const client = new FakeClient({
    listProjects: async () => [
      { id: 'system', isSystem: true, callerInvolved: true },
      { id: 'mine', callerInvolved: true },
    ],
    readQueryCatalog: async (id) => {
      reads.push(id);
      return catalogResponse([]);
    },
  });
  const server = new FakeServer();
  registerQueryCatalogTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  expect((await server.call('dkg_query_catalog_context_graphs')).structuredContent).toMatchObject({
    accessibleCount: 1,
  });
  expect(reads).toEqual(['mine']);
});
