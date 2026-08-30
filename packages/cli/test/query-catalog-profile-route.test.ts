import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildQueryCatalogWrite,
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
} from '@origintrail-official/dkg-core/query-catalog';
import { StoreSchedulerBusyError, type Quad } from '@origintrail-official/dkg-storage';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const CONTEXT_GRAPH_ID = 'kamstrup-testnet';
const PROFILE_NS = 'http://dkg.io/ontology/profile/';

function fakeResponse() {
  const response: any = Object.assign(new EventEmitter(), {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writableEnded: false,
    destroyed: false,
  });
  response.writeHead = (status: number, headers?: Record<string, string>) => {
    response.statusCode = status;
    if (headers) Object.assign(response.headers, headers);
    return response;
  };
  response.setHeader = (key: string, value: string) => {
    response.headers[key] = value;
  };
  response.end = (body?: string) => {
    response.body = body ?? '';
    response.writableEnded = true;
  };
  return response;
}

interface FakeCatalogAgentOptions {
  registered?: string[];
  layerBindings?: Partial<Record<string, Array<Record<string, unknown>>>>;
  legacyBindings?: Array<Record<string, unknown>>;
  layerError?: Error;
  legacyError?: Error;
}

function fakeCatalogAgent(options: FakeCatalogAgentOptions = {}) {
  const registered = new Set(options.registered ?? ['meta', 'orders']);
  const assertions = new Map<string, Quad[]>();
  const assertionGraphs = new Map<string, string>();
  const query = vi.fn(async (_sparql: string, queryOptions?: Record<string, unknown>) => {
    if (options.layerError) throw options.layerError;
    return {
      bindings: options.layerBindings?.[String(queryOptions?.view)] ?? [],
    };
  });
  const storeQuery = vi.fn(async () => {
    if (options.legacyError) throw options.legacyError;
    return { type: 'bindings' as const, bindings: options.legacyBindings ?? [] };
  });
  const createSubGraph = vi.fn(async (_contextGraphId: string, name: string) => {
    registered.add(name);
  });
  const history = vi.fn(async (_contextGraphId: string, name: string) => {
    if (!assertions.has(name)) return null;
    return {
      state: 'created',
      status: 'draft',
      assertionGraph: assertionGraphs.get(name),
    };
  });
  const assertionQuery = vi.fn(async (_contextGraphId: string, name: string) =>
    [...(assertions.get(name) ?? [])]);
  const create = vi.fn(async (contextGraphId: string, name: string) => {
    const graph = `did:dkg:context-graph:${contextGraphId}/meta/assertion/test/${name}`;
    assertions.set(name, []);
    assertionGraphs.set(name, graph);
    return graph;
  });
  const write = vi.fn(async (_contextGraphId: string, name: string, quads: Quad[]) => {
    assertions.set(name, [...(assertions.get(name) ?? []), ...quads]);
  });

  return {
    query,
    store: { query: storeQuery, insert: vi.fn() },
    listSubGraphs: vi.fn(async () => [...registered].map((name) => ({ name }))),
    createSubGraph,
    assertion: { history, query: assertionQuery, create, write },
    listContextGraphs: vi.fn(async () => []),
    probeContextGraphWritePreflight: vi.fn(async () => ({
      storeAvailable: true,
      exists: true,
      hasLocalContent: true,
      declarationFound: true,
      accessPolicy: 'private' as const,
    })),
    resolveAgentByToken: vi.fn(() => undefined),
    canReadContextGraph: vi.fn(async () => true),
    _test: { assertions, assertionGraphs, registered },
  };
}

function requestContext(
  path: '/api/profile/query-catalog/read' | '/api/profile/query-catalog/write',
  payload: Record<string, unknown>,
  agent: ReturnType<typeof fakeCatalogAgent>,
): { context: RequestContext; response: ReturnType<typeof fakeResponse> } {
  const response = fakeResponse();
  const url = new URL(`http://127.0.0.1${path}`);
  const request: any = Object.assign(new EventEmitter(), {
    method: 'POST',
    aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(payload)),
  });
  return {
    context: {
      req: request,
      res: response,
      agent,
      url,
      path: url.pathname,
      requestToken: undefined,
      requestAgentAddress: '',
      requestPrincipal: { kind: 'nodeOperator' },
      validTokens: new Set<string>(),
    } as unknown as RequestContext,
    response,
  };
}

function readContext(agent = fakeCatalogAgent()) {
  return requestContext(
    '/api/profile/query-catalog/read',
    { contextGraphId: CONTEXT_GRAPH_ID },
    agent,
  );
}

function catalogWrite(subGraph = 'orders') {
  return buildQueryCatalogWrite({
    contextGraphId: CONTEXT_GRAPH_ID,
    name: 'Configuration trace',
    sparql: 'SELECT ?record WHERE { ?record ?p ?o }',
    subGraph,
    catalogSlug: 'kamstrup',
    catalogName: 'Kamstrup',
    rank: 1,
    catalogRank: 1,
    parameters: [],
    view: 'working-memory',
  });
}

function legacyCatalogBatchQuads() {
  const first = buildQueryCatalogWrite({
    contextGraphId: CONTEXT_GRAPH_ID,
    name: 'KAM configuration trace',
    sparql: 'SELECT ?record WHERE { ?record ?p ?o }',
    subGraph: '__context_graph',
    catalogSlug: 'kamstrup',
    catalogName: 'Kamstrup',
    rank: 1,
    catalogRank: 1,
  });
  const second = buildQueryCatalogWrite({
    contextGraphId: CONTEXT_GRAPH_ID,
    name: 'KAM shipment trace',
    sparql: 'SELECT ?shipment WHERE { ?shipment ?p ?o }',
    subGraph: '__context_graph',
    catalogSlug: 'kamstrup',
    catalogName: 'Kamstrup',
    rank: 2,
    catalogRank: 1,
  });
  // Model the current Kamstrup injector during the transition: it still sends
  // forSubGraph literals, while the daemon must persist canonical scope IRIs.
  return [...first.quads, ...second.quads].filter(
    (quad) => quad.predicate !== `${PROFILE_NS}scopeGraph`,
  );
}

function writeContext(
  agent: ReturnType<typeof fakeCatalogAgent>,
  payload: Record<string, unknown> = {
    contextGraphId: CONTEXT_GRAPH_ID,
    quads: catalogWrite().quads,
  },
) {
  return requestContext('/api/profile/query-catalog/write', payload, agent);
}

describe('/api/profile/query-catalog/read', () => {
  it('denies an agent-scoped private catalog read before querying any graph', async () => {
    const agent = fakeCatalogAgent();
    agent.resolveAgentByToken.mockReturnValue('0x1111111111111111111111111111111111111111');
    agent.canReadContextGraph.mockResolvedValue(false);
    const { context, response } = readContext(agent);
    context.requestToken = 'agent-token';
    context.requestAgentAddress = '0x1111111111111111111111111111111111111111';
    context.requestPrincipal = {
      kind: 'agent',
      agentAddress: '0x1111111111111111111111111111111111111111',
    };
    context.validTokens = new Set(['agent-token']);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(403);
    expect(agent.canReadContextGraph).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, {
      callerAgentAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(agent.query).not.toHaveBeenCalled();
    expect(agent.store.query).not.toHaveBeenCalled();
  });

  it('reads the registered meta subgraph through all Context Graph layers', async () => {
    const agent = fakeCatalogAgent();
    agent.canReadContextGraph.mockResolvedValue(false);
    const { context, response } = readContext(agent);
    context.requestToken = 'node-admin-token';
    context.requestPrincipal = { kind: 'nodeOperator' };
    context.validTokens = new Set(['node-admin-token']);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(agent.canReadContextGraph).not.toHaveBeenCalled();
    expect(agent.query).toHaveBeenCalledTimes(3);
    for (const view of ['working-memory', 'shared-working-memory', 'verifiable-memory']) {
      expect(agent.query).toHaveBeenCalledWith(
        expect.stringContaining('GRAPH ?g'),
        expect.objectContaining({
          contextGraphId: CONTEXT_GRAPH_ID,
          subGraphName: 'meta',
          view,
        }),
      );
    }
    expect(agent.store.query).toHaveBeenCalledOnce();
    expect(agent.store.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `GRAPH <did:dkg:context-graph:${CONTEXT_GRAPH_ID}/meta/query-catalog>`,
      ),
      expect.objectContaining({ source: 'api.profile.query_catalog.read.legacy' }),
    );
  });

  it('returns canonical graph scope and execution metadata', async () => {
    const scopeGraph = `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/orders`;
    const bindings = [{
      q: { value: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:trace` },
      catalog: { value: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:catalog:kamstrup` },
      scopeGraph: { value: scopeGraph },
      subGraph: { value: 'orders' },
      sparql: { value: 'SELECT ?record WHERE { ?record ?p ?o }' },
      queryParameters: { value: '[{"name":"configurationId","type":"string"}]' },
      executionView: { value: 'verifiable-memory' },
    }];
    const agent = fakeCatalogAgent({
      layerBindings: { 'working-memory': bindings },
    });
    const { context, response } = readContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      contextGraphId: CONTEXT_GRAPH_ID,
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: QUERY_CATALOG_READ_CAPABILITIES,
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/meta`,
      items: [expect.objectContaining({
        slug: 'trace',
        subGraph: 'orders',
        scopeGraph,
        parameters: [{ name: 'configurationId', type: 'string' }],
        view: 'verifiable-memory',
      })],
    });
    expect(agent.query.mock.calls[0]?.[0]).toContain('?scopeGraph ?subGraph');
  });

  it('retains the old direct graph only as a read-only migration source', async () => {
    const rawRow = {
      q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:trace`,
      subGraph: '"__context_graph"',
      name: '"Trace"',
      sparql: '"SELECT * WHERE {}"',
      rank: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    };
    const legacyBindings = [rawRow, { ...rawRow }];
    const agent = fakeCatalogAgent({ legacyBindings });
    const { context, response } = readContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.result).toEqual({ type: 'bindings', bindings: legacyBindings });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      slug: 'trace',
      name: 'Trace',
      rank: 1,
      subGraph: '__context_graph',
      scopeGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
    });
  });

  it('rejects stored graph-scope mismatches', async () => {
    const agent = fakeCatalogAgent({
      layerBindings: {
        'working-memory': [{
          q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:trace`,
          sparql: 'SELECT * WHERE {}',
          scopeGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/orders`,
          subGraph: 'archive',
        }],
      },
    });
    const { context, response } = readContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'QUERY_CATALOG_INVALID_DATA' });
  });

  it('does not infer execution views from legacy query identifiers', async () => {
    const bindings = [{
      q: 'urn:consumer:query:open-records',
      catalog: 'urn:consumer:catalog:operations',
      sparql: 'SELECT ?record WHERE { ?record ?p ?o }',
      subGraph: 'orders',
    }];
    const agent = fakeCatalogAgent({ legacyBindings: bindings });
    const { context, response } = readContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.result).toEqual({ type: 'bindings', bindings });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).not.toHaveProperty('view');
  });

  it('maps store admission pressure to a retryable 503', async () => {
    const agent = fakeCatalogAgent({
      layerError: new StoreSchedulerBusyError(
        'queue_wait_timeout',
        'background',
        'api.profile.query_catalog.read',
      ),
    });
    const { context, response } = readContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(503);
    expect(response.headers['Retry-After']).toBe('1');
    expect(JSON.parse(response.body)).toMatchObject({ retryable: true, outcome: 'not_started' });
  });

  it('cancels all Context Graph layer reads when the caller disconnects', async () => {
    const agent = fakeCatalogAgent();
    agent.query.mockImplementation(async (_sparql: string, options?: Record<string, unknown>) =>
      new Promise((_resolve, reject) => {
        const signal = options?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    const { context, response } = readContext(agent);

    const running = handleMemoryRoutes(context);
    await vi.waitFor(() => expect(agent.query).toHaveBeenCalledTimes(3));
    (context.req as unknown as EventEmitter).emit('aborted');
    await running;

    expect(response.statusCode).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it('enforces result row, conflict, and serialized byte limits', async () => {
    const overLimit = Array.from({ length: 5001 }, (_, index) => ({
      q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:${index}`,
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
    }));
    const rowLimit = readContext(fakeCatalogAgent({
      layerBindings: { 'working-memory': overLimit },
    }));
    await handleMemoryRoutes(rowLimit.context);
    expect(rowLimit.response.statusCode).toBe(413);
    expect(JSON.parse(rowLimit.response.body)).toMatchObject({ limitRows: 5000 });

    const conflictRows = [{
      q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:trace`,
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
    }, {
      q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:trace`,
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      subGraph: '__context_graph',
    }];
    const conflict = readContext(fakeCatalogAgent({ legacyBindings: conflictRows }));
    await handleMemoryRoutes(conflict.context);
    expect(conflict.response.statusCode).toBe(422);

    const large = readContext(fakeCatalogAgent({
      legacyBindings: [{
        q: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:large`,
        sparql: `SELECT * WHERE {} # ${'x'.repeat(1024 * 1024)}`,
        subGraph: '__context_graph',
      }],
    }));
    await handleMemoryRoutes(large.context);
    expect(large.response.statusCode).toBe(413);
    expect(JSON.parse(large.response.body)).toMatchObject({ limitBytes: 1024 * 1024 });
  });
});

describe('/api/profile/query-catalog/write', () => {
  it('persists a complete multi-query catalog batch and enriches legacy graph scopes', async () => {
    const agent = fakeCatalogAgent({ registered: ['meta'] });
    const { context, response } = writeContext(agent, {
      contextGraphId: CONTEXT_GRAPH_ID,
      quads: legacyCatalogBatchQuads(),
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload).toMatchObject({
      queryCount: 2,
      scopeGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      scopeGraphs: [`did:dkg:context-graph:${CONTEXT_GRAPH_ID}`],
    });
    const stored = agent._test.assertions.get(payload.assertionName)!;
    expect(stored.filter((quad) => quad.predicate === `${PROFILE_NS}scopeGraph`)).toHaveLength(3);
    expect(stored).toHaveLength(payload.triplesWritten);
  });

  it('creates one immutable assertion in the registered meta subgraph', async () => {
    const agent = fakeCatalogAgent({ registered: ['orders'] });
    const { context, response } = writeContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(agent.createSubGraph).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, 'meta');
    expect(agent.assertion.create).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      expect.stringMatching(/^query-catalog-[0-9a-f]{32}$/),
      { subGraphName: 'meta' },
    );
    expect(agent.assertion.write).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      expect.stringMatching(/^query-catalog-[0-9a-f]{32}$/),
      expect.arrayContaining([
        expect.objectContaining({
          predicate: `${PROFILE_NS}scopeGraph`,
          object: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/orders`,
        }),
      ]),
      { subGraphName: 'meta' },
    );
    expect(agent.store.insert).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toMatchObject({
      ok: true,
      graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/meta`,
      subGraphName: 'meta',
      scopeGraph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/orders`,
      scopeGraphs: [`did:dkg:context-graph:${CONTEXT_GRAPH_ID}/orders`],
      queryCount: 1,
      triplesWritten: catalogWrite().quads.length,
      alreadyExists: false,
    });
  });

  it('makes an exact retry idempotent and repairs a partial append', async () => {
    const agent = fakeCatalogAgent();
    const first = writeContext(agent);
    await handleMemoryRoutes(first.context);
    const firstPayload = JSON.parse(first.response.body);

    const retry = writeContext(agent);
    await handleMemoryRoutes(retry.context);
    expect(retry.response.statusCode).toBe(200);
    expect(JSON.parse(retry.response.body)).toMatchObject({
      assertionName: firstPayload.assertionName,
      triplesWritten: 0,
      alreadyExists: true,
    });
    expect(agent.assertion.write).toHaveBeenCalledTimes(1);

    const stored = agent._test.assertions.get(firstPayload.assertionName)!;
    agent._test.assertions.set(firstPayload.assertionName, stored.slice(0, -2));
    const repair = writeContext(agent);
    await handleMemoryRoutes(repair.context);
    expect(repair.response.statusCode).toBe(200);
    expect(JSON.parse(repair.response.body)).toMatchObject({ triplesWritten: 2 });
    expect(agent._test.assertions.get(firstPayload.assertionName)).toHaveLength(
      catalogWrite().quads.length,
    );
  });

  it('canonicalizes typed literals before content-addressing an idempotent retry', async () => {
    const agent = fakeCatalogAgent();
    const write = catalogWrite();
    const xsdIntQuads = write.quads.map((quad) =>
      quad.predicate === `${PROFILE_NS}rank`
        ? {
            ...quad,
            object: quad.object.replace(
              'http://www.w3.org/2001/XMLSchema#integer',
              'http://www.w3.org/2001/XMLSchema#int',
            ),
          }
        : quad);
    const payload = { contextGraphId: CONTEXT_GRAPH_ID, quads: xsdIntQuads };

    const first = writeContext(agent, payload);
    await handleMemoryRoutes(first.context);
    expect(first.response.statusCode).toBe(200);
    const firstPayload = JSON.parse(first.response.body);
    expect(agent._test.assertions.get(firstPayload.assertionName))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          predicate: `${PROFILE_NS}rank`,
          object: expect.stringContaining('XMLSchema#integer'),
        }),
      ]));

    const retry = writeContext(agent, payload);
    await handleMemoryRoutes(retry.context);
    expect(retry.response.statusCode).toBe(200);
    expect(JSON.parse(retry.response.body)).toMatchObject({
      assertionName: firstPayload.assertionName,
      triplesWritten: 0,
      alreadyExists: true,
    });
  });

  it('serializes concurrent retries of the same immutable payload', async () => {
    const agent = fakeCatalogAgent();
    const first = writeContext(agent);
    const second = writeContext(agent);

    await Promise.all([
      handleMemoryRoutes(first.context),
      handleMemoryRoutes(second.context),
    ]);

    expect(first.response.statusCode).toBe(200);
    expect(second.response.statusCode).toBe(200);
    expect(agent.assertion.create).toHaveBeenCalledTimes(1);
    expect(agent.assertion.write).toHaveBeenCalledTimes(1);
    expect([...agent._test.assertions.values()][0]).toHaveLength(catalogWrite().quads.length);
    expect([
      JSON.parse(first.response.body).alreadyExists,
      JSON.parse(second.response.body).alreadyExists,
    ].sort()).toEqual([false, true]);
  });

  it('serializes different concurrent payloads for the same logical query', async () => {
    const agent = fakeCatalogAgent();
    const canonical = catalogWrite();
    agent.query.mockImplementation(async (_sparql: string, options?: Record<string, unknown>) => ({
      bindings: options?.view === 'working-memory' && agent._test.assertions.size > 0
        ? [{
            q: canonical.savedQuery.queryIri,
            catalog: canonical.savedQuery.catalogIri,
            scopeGraph: canonical.savedQuery.scopeGraph,
            subGraph: canonical.savedQuery.subGraph,
            sparql: canonical.savedQuery.sparql,
          }]
        : [],
    }));
    const changed = {
      ...canonical,
      quads: canonical.quads.map((quad) =>
        quad.predicate === `${PROFILE_NS}sparqlQuery`
          ? { ...quad, object: '"SELECT ?changed WHERE { ?changed ?p ?o }"' }
          : quad),
    };
    const first = writeContext(agent);
    const second = writeContext(agent, {
      contextGraphId: CONTEXT_GRAPH_ID,
      quads: changed.quads,
    });

    await Promise.all([
      handleMemoryRoutes(first.context),
      handleMemoryRoutes(second.context),
    ]);

    expect([first.response.statusCode, second.response.statusCode].sort()).toEqual([200, 409]);
    expect(agent.assertion.create).toHaveBeenCalledTimes(1);
    expect(agent._test.assertions).toHaveProperty('size', 1);
  });

  it('rejects update modes, mutation SPARQL, and unregistered target graphs', async () => {
    const modeAgent = fakeCatalogAgent();
    const mode = writeContext(modeAgent, {
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'upsert',
      quads: catalogWrite().quads,
    });
    await handleMemoryRoutes(mode.context);
    expect(mode.response.statusCode).toBe(400);
    expect(JSON.parse(mode.response.body)).toMatchObject({
      code: 'QUERY_CATALOG_MUTATION_MODE_UNSUPPORTED',
    });
    expect(modeAgent.assertion.create).not.toHaveBeenCalled();

    const mutationQuads = catalogWrite().quads.map((quad) =>
      quad.predicate === `${PROFILE_NS}sparqlQuery`
        ? { ...quad, object: '"DELETE WHERE { ?s ?p ?o }"' }
        : quad);
    const mutation = writeContext(fakeCatalogAgent(), {
      contextGraphId: CONTEXT_GRAPH_ID,
      quads: mutationQuads,
    });
    await handleMemoryRoutes(mutation.context);
    expect(mutation.response.statusCode).toBe(400);
    expect(JSON.parse(mutation.response.body).error).toMatch(/read-only/);

    const unregistered = writeContext(fakeCatalogAgent({ registered: ['meta'] }));
    await handleMemoryRoutes(unregistered.context);
    expect(unregistered.response.statusCode).toBe(400);
    expect(JSON.parse(unregistered.response.body).error).toMatch(/not registered/);
  });

  it('rejects graph scope outside the target Context Graph', async () => {
    const quads = catalogWrite().quads.map((quad) =>
      quad.predicate === `${PROFILE_NS}scopeGraph`
        ? { ...quad, object: 'did:dkg:context-graph:other/orders' }
        : quad);
    const { context, response } = writeContext(fakeCatalogAgent(), {
      contextGraphId: CONTEXT_GRAPH_ID,
      quads,
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toMatch(/outside context graph/);
  });

  it('fails closed if an existing content-addressed assertion has extra data', async () => {
    const agent = fakeCatalogAgent();
    const first = writeContext(agent);
    await handleMemoryRoutes(first.context);
    const assertionName = JSON.parse(first.response.body).assertionName;
    agent._test.assertions.get(assertionName)!.push({
      subject: `urn:dkg:profile:${CONTEXT_GRAPH_ID}:query:configuration-trace-1`,
      predicate: `${PROFILE_NS}displayName`,
      object: '"unexpected"',
      graph: '',
    });

    const retry = writeContext(agent);
    await handleMemoryRoutes(retry.context);

    expect(retry.response.statusCode).toBe(409);
    expect(JSON.parse(retry.response.body)).toMatchObject({
      code: 'QUERY_CATALOG_WRITE_CONFLICT',
    });
  });

  it('rejects a different immutable revision with the same logical query subject', async () => {
    const write = catalogWrite();
    const agent = fakeCatalogAgent({
      layerBindings: {
        'working-memory': [{
          q: write.savedQuery.queryIri,
          catalog: write.savedQuery.catalogIri,
          scopeGraph: write.savedQuery.scopeGraph,
          subGraph: write.savedQuery.subGraph,
          sparql: 'SELECT ?old WHERE { ?old ?p ?o }',
        }],
      },
    });
    const { context, response } = writeContext(agent);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'QUERY_CATALOG_WRITE_CONFLICT',
    });
    expect(agent.assertion.create).not.toHaveBeenCalled();
  });
});
