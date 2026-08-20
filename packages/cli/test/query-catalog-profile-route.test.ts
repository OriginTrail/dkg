import { describe, expect, it, vi } from 'vitest';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

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

describe('/api/profile/query-catalog/read', () => {
  it('returns explicit and legacy execution-view bindings for generic saved queries', async () => {
    const bindings = [{
      q: { value: 'urn:dkg:profile:kamstrup-testnet:query:trace' },
      subGraph: { value: '__context_graph' },
      sparql: { value: 'SELECT ?record WHERE { ?record ?p ?o }' },
      executionView: { value: 'verifiable-memory' },
      view: { value: 'working-memory' },
    }];
    const query = vi.fn(async (sparql: string) => {
      expect(sparql).toContain('?executionView ?view');
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
