import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import {
  createTripleStore,
  StoreSchedulerBusyError,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

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

function queryCatalogReadContext(agent: Record<string, unknown>): {
  context: RequestContext;
  response: ReturnType<typeof fakeResponse>;
} {
  const response = fakeResponse();
  const url = new URL('http://127.0.0.1/api/profile/query-catalog/read');
  const request: any = Object.assign(new EventEmitter(), {
    method: 'POST',
    aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: 'kamstrup-testnet' })),
  });
  return {
    context: {
      req: request,
      res: response,
      agent: {
        resolveAgentByToken: vi.fn(() => undefined),
        canReadContextGraph: vi.fn(async () => true),
        ...agent,
      },
      url,
      path: url.pathname,
      requestToken: undefined,
      requestAgentAddress: '',
      validTokens: new Set<string>(),
    } as unknown as RequestContext,
    response,
  };
}

function queryCatalogWriteContext(
  store: TripleStore,
  payload: { contextGraphId: string; quads: Quad[] },
): {
  context: RequestContext;
  response: ReturnType<typeof fakeResponse>;
} {
  const response = fakeResponse();
  const url = new URL('http://127.0.0.1/api/profile/query-catalog/write');
  const request: any = {
    method: 'POST',
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(payload)),
  };
  const agent = {
    store,
    listContextGraphs: vi.fn(async () => []),
    probeContextGraphWritePreflight: vi.fn(async () => ({
      storeAvailable: true,
      exists: true,
      hasLocalContent: true,
      declarationFound: true,
      accessPolicy: 'private' as const,
    })),
  };
  return {
    context: {
      req: request,
      res: response,
      agent,
      url,
      path: url.pathname,
      requestToken: undefined,
    } as unknown as RequestContext,
    response,
  };
}

async function ask(store: TripleStore, graph: string, subject: string, predicate: string, object: string) {
  const result = await store.query(
    `ASK { GRAPH <${graph}> { <${subject}> <${predicate}> ${JSON.stringify(object)} } }`,
  );
  return result.type === 'boolean' && result.value;
}

describe('/api/profile/query-catalog/read', () => {
  it('denies an agent-scoped private catalog read before querying the store', async () => {
    const query = vi.fn();
    const resolveAgentByToken = vi.fn(() => '0x1111111111111111111111111111111111111111');
    const canReadContextGraph = vi.fn(async () => false);
    const { context, response } = queryCatalogReadContext({
      store: { query },
      resolveAgentByToken,
      canReadContextGraph,
    });
    context.requestToken = 'agent-token';
    context.requestAgentAddress = '0x1111111111111111111111111111111111111111';
    context.validTokens = new Set(['agent-token']);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(403);
    expect(canReadContextGraph).toHaveBeenCalledWith('kamstrup-testnet', {
      callerAgentAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves node-admin catalog reads', async () => {
    const query = vi.fn(async () => ({ type: 'bindings' as const, bindings: [] }));
    const canReadContextGraph = vi.fn(async () => false);
    const { context, response } = queryCatalogReadContext({
      store: { query },
      resolveAgentByToken: vi.fn(() => undefined),
      canReadContextGraph,
    });
    context.requestToken = 'node-admin-token';
    context.validTokens = new Set(['node-admin-token']);

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(canReadContextGraph).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns explicit and legacy execution-view bindings for generic saved queries', async () => {
    const bindings = [{
      q: { value: 'urn:dkg:profile:kamstrup-testnet:query:trace' },
      subGraph: { value: '__context_graph' },
      sparql: { value: 'SELECT ?record WHERE { ?record ?p ?o }' },
      queryParameters: { value: '[{"name":"configurationId","type":"string"}]' },
      executionView: { value: 'verifiable-memory' },
      view: { value: 'verifiable-memory' },
    }];
    const query = vi.fn(async (sparql: string, options?: Record<string, unknown>) => {
      expect(sparql).toContain('?queryParameters ?executionView ?view');
      expect(sparql).toContain('OPTIONAL { ?q prof:queryParameters ?queryParameters }');
      expect(sparql).toContain('OPTIONAL { ?q prof:executionView ?executionView }');
      expect(sparql).toContain('OPTIONAL { ?q prof:view ?view }');
      expect(sparql).toContain('ORDER BY ?q');
      expect(sparql).toContain('LIMIT 5001');
      expect(options).toMatchObject({
        priority: 'background',
        source: 'api.profile.query_catalog.read',
        maxResponseBytes: 1024 * 1024,
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return { type: 'bindings' as const, bindings };
    });
    const { context, response } = queryCatalogReadContext({ store: { query } });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body)).toMatchObject({
      contextGraphId: 'kamstrup-testnet',
      schemaVersion: 1,
      capabilities: {
        canonicalItems: true,
        queryParameters: true,
        executionView: true,
      },
      items: [expect.objectContaining({
        slug: 'trace',
        parameters: [{ name: 'configurationId', type: 'string' }],
        view: 'verifiable-memory',
      })],
      result: {
        type: 'bindings',
        bindings: [expect.objectContaining({
          q: { value: 'urn:dkg:profile:kamstrup-testnet:query:trace' },
          queryParameters: { value: '[{"name":"configurationId","type":"string"}]' },
          executionView: { value: 'verifiable-memory' },
        })],
      },
    });
  });

  it('preserves quoted, typed, and duplicate raw rows in the legacy bindings field', async () => {
    const rawRow = {
      q: 'urn:dkg:profile:test:query:trace',
      subGraph: '"__context_graph"',
      name: '"Trace"',
      sparql: '"SELECT * WHERE {}"',
      rank: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    };
    const rawBindings = [rawRow, { ...rawRow }];
    const { context, response } = queryCatalogReadContext({
      store: {
        query: vi.fn(async () => ({ type: 'bindings' as const, bindings: rawBindings })),
      },
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body);
    expect(payload.result).toEqual({ type: 'bindings', bindings: rawBindings });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ slug: 'trace', name: 'Trace', rank: 1 });
  });

  it('returns 422 for invalid or conflicting stored execution views', async () => {
    for (const binding of [
      {
        q: 'urn:dkg:profile:test:query:invalid-view',
        sparql: 'SELECT * WHERE {}',
        subGraph: '__context_graph',
        executionView: 'verifiable-memroy',
      },
      {
        q: 'urn:dkg:profile:test:query:conflicting-view',
        sparql: 'SELECT * WHERE {}',
        subGraph: '__context_graph',
        executionView: 'working-memory',
        view: 'verifiable-memory',
      },
    ]) {
      const { context, response } = queryCatalogReadContext({
        store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [binding] })) },
      });
      await handleMemoryRoutes(context);
      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body)).toMatchObject({ code: 'QUERY_CATALOG_INVALID_DATA' });
    }
  });

  it('normalizes legacy ListenerBoi entries only in canonical items', async () => {
    const bindings = [{
      q: 'urn:listenerboi:query:open-incidents',
      catalog: 'urn:listenerboi:catalog:investigations',
      sparql: 'SELECT ?incident WHERE { ?incident ?p ?o }',
      subGraph: 'incidents',
    }];
    const { context, response } = queryCatalogReadContext({
      store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings })) },
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      items: [expect.objectContaining({ view: 'working-memory' })],
      result: {
        bindings,
      },
    });
  });

  it('maps store admission pressure to a retryable 503', async () => {
    const query = vi.fn(async () => {
      throw new StoreSchedulerBusyError(
        'queue_wait_timeout',
        'background',
        'api.profile.query_catalog.read',
      );
    });
    const { context, response } = queryCatalogReadContext({ store: { query } });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(503);
    expect(response.headers['Retry-After']).toBe('1');
    expect(JSON.parse(response.body)).toMatchObject({ retryable: true, outcome: 'not_started' });
  });

  it('cancels catalog store work when the caller disconnects', async () => {
    const query = vi.fn(async (_sparql: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }));
    const { context, response } = queryCatalogReadContext({ store: { query } });

    const running = handleMemoryRoutes(context);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    (context.req as unknown as EventEmitter).emit('aborted');
    await running;

    expect(response.statusCode).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it('rejects catalog result cardinality above the endpoint limit', async () => {
    const bindings = Array.from({ length: 5001 }, (_, index) => ({
      q: `urn:dkg:profile:test:query:${index}`,
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
    }));
    const { context, response } = queryCatalogReadContext({
      store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings })) },
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'QUERY_CATALOG_RESULT_TOO_LARGE',
      limitRows: 5000,
    });
  });

  it('rejects conflicting legacy values instead of selecting an arbitrary row', async () => {
    const bindings = [{
      q: 'urn:dkg:profile:test:query:trace',
      sparql: 'SELECT * WHERE {}',
      subGraph: '__context_graph',
    }, {
      q: 'urn:dkg:profile:test:query:trace',
      sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
      subGraph: '__context_graph',
    }];
    const { context, response } = queryCatalogReadContext({
      store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings })) },
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'QUERY_CATALOG_INVALID_DATA' });
  });

  it('rejects a serialized catalog response above the byte budget', async () => {
    const bindings = [{
      q: 'urn:dkg:profile:test:query:large',
      sparql: `SELECT * WHERE {} # ${'x'.repeat(1024 * 1024)}`,
      subGraph: '__context_graph',
    }];
    const { context, response } = queryCatalogReadContext({
      store: { query: vi.fn(async () => ({ type: 'bindings' as const, bindings })) },
    });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'QUERY_CATALOG_RESULT_TOO_LARGE',
      limitBytes: 1024 * 1024,
    });
  });
});

describe('/api/profile/query-catalog/write', () => {
  it('appends repeated subject values without deleting existing catalog data', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const contextGraphId = 'kamstrup-testnet';
    const graph = `did:dkg:context-graph:${contextGraphId}/meta/query-catalog`;
    const catalog = `urn:dkg:profile:${contextGraphId}:catalog:kamstrup`;
    const query = `urn:dkg:profile:${contextGraphId}:query:configuration-trace`;
    const unrelated = `urn:dkg:profile:${contextGraphId}:query:user-saved`;
    const label = 'http://dkg.io/ontology/profile/displayName';
    const sparql = 'http://dkg.io/ontology/profile/sparqlQuery';

    try {
      const first = queryCatalogWriteContext(store, {
        contextGraphId,
        quads: [
          { subject: catalog, predicate: label, object: '"Old catalog"', graph: '' },
          { subject: query, predicate: sparql, object: '"SELECT \\"old\\" WHERE {}"', graph: '' },
          { subject: unrelated, predicate: sparql, object: '"SELECT \\"keep\\" WHERE {}"', graph: '' },
        ],
      });
      await handleMemoryRoutes(first.context);
      expect(first.response.statusCode).toBe(200);
      expect(JSON.parse(first.response.body)).toMatchObject({
        triplesWritten: 3,
      });

      const second = queryCatalogWriteContext(store, {
        contextGraphId,
        quads: [
          { subject: catalog, predicate: label, object: '"Current catalog"', graph: '' },
          { subject: query, predicate: sparql, object: '"SELECT \\"current\\" WHERE {}"', graph: '' },
        ],
      });
      await handleMemoryRoutes(second.context);
      expect(second.response.statusCode).toBe(200);
      expect(JSON.parse(second.response.body)).toMatchObject({
        triplesWritten: 2,
      });

      expect(await ask(store, graph, catalog, label, 'Old catalog')).toBe(true);
      expect(await ask(store, graph, catalog, label, 'Current catalog')).toBe(true);
      expect(await ask(store, graph, query, sparql, 'SELECT "old" WHERE {}')).toBe(true);
      expect(await ask(store, graph, query, sparql, 'SELECT "current" WHERE {}')).toBe(true);
      expect(await ask(store, graph, unrelated, sparql, 'SELECT "keep" WHERE {}')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('keeps both concurrent append-only saves', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const contextGraphId = 'kamstrup-testnet';
    const graph = `did:dkg:context-graph:${contextGraphId}/meta/query-catalog`;
    const catalog = `urn:dkg:profile:${contextGraphId}:catalog:kamstrup`;
    const query = `urn:dkg:profile:${contextGraphId}:query:configuration-trace`;
    const label = 'http://dkg.io/ontology/profile/displayName';
    const sparql = 'http://dkg.io/ontology/profile/sparqlQuery';
    const payload = (version: 'A' | 'B') => queryCatalogWriteContext(store, {
      contextGraphId,
      quads: [
        { subject: catalog, predicate: label, object: `"Catalog ${version}"`, graph: '' },
        { subject: query, predicate: sparql, object: `"SELECT \\"${version}\\" WHERE {}"`, graph: '' },
      ],
    });
    const saveA = payload('A');
    const saveB = payload('B');

    try {
      await Promise.all([
        handleMemoryRoutes(saveA.context),
        handleMemoryRoutes(saveB.context),
      ]);

      expect(saveA.response.statusCode).toBe(200);
      expect(saveB.response.statusCode).toBe(200);
      const hasA = await ask(store, graph, catalog, label, 'Catalog A');
      const hasB = await ask(store, graph, catalog, label, 'Catalog B');
      expect(hasA).toBe(true);
      expect(hasB).toBe(true);
      expect(await ask(store, graph, query, sparql, 'SELECT "A" WHERE {}')).toBe(true);
      expect(await ask(store, graph, query, sparql, 'SELECT "B" WHERE {}')).toBe(true);
    } finally {
      await store.close();
    }
  });
});
