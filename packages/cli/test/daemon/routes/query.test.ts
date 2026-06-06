import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from '../../../src/daemon/routes/context.js';
import { handleQueryRoutes } from '../../../src/daemon/routes/query.js';

interface FakeRes {
  writableEnded: boolean;
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
  writeHead: (status: number, headers?: Record<string, string | number | string[]>) => FakeRes;
  end: (chunk?: string) => void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    headersSent: false,
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      res.headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') res.body += chunk;
      res.headersSent = true;
      res.writableEnded = true;
    },
  };
  return res;
}

function makeReq(body: Record<string, unknown>): IncomingMessage {
  return {
    method: 'POST',
    headers: {},
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as unknown as IncomingMessage;
}

function makeTracker() {
  return {
    start: vi.fn(),
    startPhase: vi.fn(),
    completePhase: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  };
}

function makeCtx(
  agent: Record<string, unknown>,
  body: Record<string, unknown>,
  res = makeRes(),
  opts: {
    requestToken?: string;
    requestAgentAddress?: string;
    validTokens?: string[];
  } = {},
): {
  ctx: RequestContext;
  res: FakeRes;
} {
  const ctx = {
    req: makeReq(body),
    res: res as unknown as ServerResponse,
    agent,
    tracker: makeTracker(),
    validTokens: new Set<string>(opts.validTokens ?? []),
    path: '/api/query',
    url: new URL('http://127.0.0.1/api/query'),
    requestToken: opts.requestToken,
    requestAgentAddress: opts.requestAgentAddress,
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('handleQueryRoutes /api/query', () => {
  it('maps scoped-query violations from the query engine to HTTP 400', async () => {
    const error = new Error(
      'Scoped query violation: GRAPH <did:dkg:context-graph:other> is outside the allowed graph set',
    );
    const agent = {
      resolveAgentByToken: vi.fn(),
      query: vi.fn().mockRejectedValue(error),
    };
    const { ctx, res } = makeCtx(agent, {
      sparql: 'SELECT ?s WHERE { GRAPH <did:dkg:context-graph:other> { ?s ?p ?o } }',
      contextGraphId: 'agent-registry',
    });

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(error.message);
  });

  it('maps oxigraph SPARQL syntax errors ("error at L:C: ...") to HTTP 400, not 500 (#889)', async () => {
    // Reproduces the rc.12 finding: a malformed query (missing closing
    // brace / incomplete triple) makes oxigraph throw
    // `error at <line>:<col>: expected one of ...`. Before the fix this
    // fell through to the top-level 500 handler; it must be a 400.
    const error = new Error(
      'error at 1:27: expected one of ",", ".", ";", "{", "}", ...',
    );
    const agent = {
      resolveAgentByToken: vi.fn(),
      query: vi.fn().mockRejectedValue(error),
    };
    const { ctx, res } = makeCtx(agent, {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o',
      contextGraphId: 'all',
    });

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe(error.message);
  });

  it('still surfaces genuine server-side errors as 500 (not misclassified as 400)', async () => {
    // Guard: the #889 widening must not swallow real server faults whose
    // message happens to differ from the parser-error shape.
    const error = new Error('Database connection lost');
    const agent = {
      resolveAgentByToken: vi.fn(),
      query: vi.fn().mockRejectedValue(error),
    };
    const { ctx, res } = makeCtx(agent, {
      sparql: 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1',
      contextGraphId: 'all',
    });

    await expect(handleQueryRoutes(ctx)).rejects.toThrow('Database connection lost');
    expect(res.statusCode).not.toBe(400);
  });

  it('infers omitted working-memory agentAddress from the authenticated caller', async () => {
    const caller = '0x1111111111111111111111111111111111111111';
    const agent = {
      resolveAgentByToken: vi.fn().mockReturnValue(caller),
      query: vi.fn().mockResolvedValue({ bindings: [] }),
      getDefaultAgentAddress: vi.fn().mockReturnValue(caller),
      peerId: '12D3KooWself',
    };
    const { ctx, res } = makeCtx(
      agent,
      {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: 'research',
        view: 'working-memory',
      },
      makeRes(),
      {
        requestToken: 'agent-token',
        requestAgentAddress: caller,
        validTokens: ['agent-token'],
      },
    );

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(agent.query.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'research',
      view: 'working-memory',
      agentAddress: caller,
      callerAgentAddress: caller,
    });
  });

  it('does not infer omitted working-memory agentAddress for unauthenticated callers', async () => {
    const defaultAgent = '0x1111111111111111111111111111111111111111';
    const agent = {
      resolveAgentByToken: vi.fn(),
      query: vi.fn().mockRejectedValue(new Error('agentAddress is required for working-memory view')),
      getDefaultAgentAddress: vi.fn().mockReturnValue(defaultAgent),
      peerId: '12D3KooWself',
    };
    const { ctx, res } = makeCtx(
      agent,
      {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: 'research',
        view: 'working-memory',
      },
      makeRes(),
      {
        requestAgentAddress: defaultAgent,
      },
    );

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/agentAddress is required/);
    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(agent.query.mock.calls[0][1]).toHaveProperty('agentAddress', undefined);
    expect(agent.query.mock.calls[0][1]).toHaveProperty('callerAgentAddress', undefined);
  });

  it('infers omitted working-memory agentAddress for node-admin callers', async () => {
    const defaultAgent = '0x1111111111111111111111111111111111111111';
    const agent = {
      resolveAgentByToken: vi.fn().mockReturnValue(undefined),
      query: vi.fn().mockResolvedValue({ bindings: [] }),
      getDefaultAgentAddress: vi.fn().mockReturnValue(defaultAgent),
      peerId: '12D3KooWself',
    };
    const { ctx, res } = makeCtx(
      agent,
      {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: 'research',
        view: 'working-memory',
      },
      makeRes(),
      {
        requestToken: 'admin-token',
        requestAgentAddress: defaultAgent,
        validTokens: ['admin-token'],
      },
    );

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(agent.query.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'research',
      view: 'working-memory',
      agentAddress: defaultAgent,
    });
    expect(agent.query.mock.calls[0][1]).toHaveProperty('callerAgentAddress', undefined);
  });

  it('rejects present non-string agentAddress instead of inferring it', async () => {
    const caller = '0x1111111111111111111111111111111111111111';
    const agent = {
      resolveAgentByToken: vi.fn().mockReturnValue(caller),
      query: vi.fn().mockResolvedValue({ bindings: [] }),
      getDefaultAgentAddress: vi.fn().mockReturnValue(caller),
      peerId: '12D3KooWself',
    };
    const { ctx, res } = makeCtx(
      agent,
      {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: 'research',
        view: 'working-memory',
        agentAddress: null,
      },
      makeRes(),
      {
        requestToken: 'agent-token',
        requestAgentAddress: caller,
        validTokens: ['agent-token'],
      },
    );

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/agentAddress/);
    expect(agent.query).not.toHaveBeenCalled();
  });

  it('forwards view, subGraphName, and assertionName to the agent query route', async () => {
    const caller = '0x2222222222222222222222222222222222222222';
    const agent = {
      resolveAgentByToken: vi.fn().mockReturnValue(caller),
      query: vi.fn().mockResolvedValue({ bindings: [] }),
      getDefaultAgentAddress: vi.fn().mockReturnValue(caller),
      peerId: '12D3KooWself',
    };
    const { ctx, res } = makeCtx(
      agent,
      {
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: 'research',
        view: 'working-memory',
        agentAddress: caller,
        subGraphName: 'code',
        assertionName: 'probe',
      },
      makeRes(),
      {
        requestToken: 'agent-token',
        requestAgentAddress: caller,
        validTokens: ['agent-token'],
      },
    );

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(agent.query.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'research',
      view: 'working-memory',
      agentAddress: caller,
      subGraphName: 'code',
      assertionName: 'probe',
      callerAgentAddress: caller,
    });
  });
});
