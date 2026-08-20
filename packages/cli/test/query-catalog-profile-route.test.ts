import { describe, expect, it, vi } from 'vitest';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { createTripleStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

function fakeResponse() {
  const response: any = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writableEnded: false,
  };
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
  const request: any = {
    method: 'POST',
    __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: 'kamstrup-testnet' })),
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

function queryCatalogWriteContext(
  store: TripleStore,
  payload: { contextGraphId: string; mode?: string; quads: Quad[] },
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
  it('returns explicit and legacy execution-view bindings for generic saved queries', async () => {
    const bindings = [{
      q: { value: 'urn:dkg:profile:kamstrup-testnet:query:trace' },
      subGraph: { value: '__context_graph' },
      sparql: { value: 'SELECT ?record WHERE { ?record ?p ?o }' },
      queryParameters: { value: '[{"name":"configurationId","type":"string"}]' },
      executionView: { value: 'verifiable-memory' },
      view: { value: 'working-memory' },
    }];
    const query = vi.fn(async (sparql: string) => {
      expect(sparql).toContain('?queryParameters ?executionView ?view');
      expect(sparql).toContain('OPTIONAL { ?q prof:queryParameters ?queryParameters }');
      expect(sparql).toContain('OPTIONAL { ?q prof:executionView ?executionView }');
      expect(sparql).toContain('OPTIONAL { ?q prof:view ?view }');
      return { type: 'bindings' as const, bindings };
    });
    const { context, response } = queryCatalogReadContext({ store: { query } });

    await handleMemoryRoutes(context);

    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body)).toMatchObject({
      contextGraphId: 'kamstrup-testnet',
      result: {
        type: 'bindings',
        bindings,
      },
    });
  });
});

describe('/api/profile/query-catalog/write', () => {
  it('upserts incoming catalog/query subjects and preserves unrelated saved queries', async () => {
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
        mode: 'upsert',
        quads: [
          { subject: catalog, predicate: label, object: '"Old catalog"', graph: '' },
          { subject: query, predicate: sparql, object: '"SELECT \\"old\\" WHERE {}"', graph: '' },
          { subject: unrelated, predicate: sparql, object: '"SELECT \\"keep\\" WHERE {}"', graph: '' },
        ],
      });
      await handleMemoryRoutes(first.context);
      expect(first.response.statusCode).toBe(200);
      expect(JSON.parse(first.response.body)).toMatchObject({
        mode: 'upsert',
        subjectsUpserted: 3,
        triplesWritten: 3,
      });

      const second = queryCatalogWriteContext(store, {
        contextGraphId,
        mode: 'upsert',
        quads: [
          { subject: catalog, predicate: label, object: '"Current catalog"', graph: '' },
          { subject: query, predicate: sparql, object: '"SELECT \\"current\\" WHERE {}"', graph: '' },
        ],
      });
      await handleMemoryRoutes(second.context);
      expect(second.response.statusCode).toBe(200);
      expect(JSON.parse(second.response.body)).toMatchObject({
        mode: 'upsert',
        subjectsUpserted: 2,
        triplesWritten: 2,
      });

      expect(await ask(store, graph, catalog, label, 'Old catalog')).toBe(false);
      expect(await ask(store, graph, catalog, label, 'Current catalog')).toBe(true);
      expect(await ask(store, graph, query, sparql, 'SELECT "old" WHERE {}')).toBe(false);
      expect(await ask(store, graph, query, sparql, 'SELECT "current" WHERE {}')).toBe(true);
      expect(await ask(store, graph, unrelated, sparql, 'SELECT "keep" WHERE {}')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('rejects an upsert subject outside the selected context graph profile namespace', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    try {
      const write = queryCatalogWriteContext(store, {
        contextGraphId: 'kamstrup-testnet',
        mode: 'upsert',
        quads: [{
          subject: 'urn:dkg:profile:other-context:query:trace',
          predicate: 'http://dkg.io/ontology/profile/sparqlQuery',
          object: '"SELECT * WHERE {}"',
          graph: '',
        }],
      });
      await handleMemoryRoutes(write.context);
      expect(write.response.statusCode).toBe(400);
      expect(JSON.parse(write.response.body).error).toContain('must belong to context graph');
    } finally {
      await store.close();
    }
  });
});
