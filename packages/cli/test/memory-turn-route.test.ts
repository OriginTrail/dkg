import { describe, expect, it, vi } from 'vitest';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

function fakeRes() {
  const res: any = { statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false };
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  };
  res.setHeader = (key: string, value: string) => {
    res.headers[key] = value;
  };
  res.end = (body: string) => {
    res.body = body;
    res.writableEnded = true;
  };
  return res;
}

function fakeReq(body: unknown) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer agent-token' },
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)),
  } as any;
}

function buildTurnCtx(body: unknown, agent: Record<string, any>, requestAgentAddress: string) {
  const res = fakeRes();
  const url = new URL('http://127.0.0.1/api/memory/turn');
  const ctx = {
    req: fakeReq(body),
    res,
    agent,
    publisherControl: {},
    config: {},
    startedAt: Date.now(),
    dashDb: {},
    opWallets: {},
    network: {},
    tracker: {},
    memoryManager: {},
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
    extractionRegistry: {},
    fileStore: {
      put: vi.fn(async () => ({ keccak256: 'abc123' })),
    },
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: { insert: vi.fn() },
    embeddingProvider: null,
    validTokens: new Set(['agent-token']),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: 'agent-token',
    requestAgentAddress,
    emitMemoryGraphChanged: vi.fn(),
    emitNotification: vi.fn(),
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('/api/memory/turn route', () => {
  it('writes lifecycle-backed turns in the authenticated agent lane', async () => {
    const requestAgentAddress = '0x00000000000000000000000000000000000000aa';
    const create = vi.fn(async (
      _contextGraphId: string,
      _name: string,
      opts?: { agentAddress?: string; subGraphName?: string },
    ) => `graph:${opts?.agentAddress ?? 'default'}:${opts?.subGraphName ?? 'root'}`);
    const write = vi.fn(async () => undefined);
    const agent = {
      peerId: 'default-peer',
      resolveAgentByToken: vi.fn((token: string | undefined) =>
        token === 'agent-token' ? requestAgentAddress : undefined),
      async listContextGraphs() {
        return [{ id: 'cg', name: 'cg', subscribed: true, synced: true }];
      },
      async contextGraphExists(contextGraphId: string) {
        return contextGraphId === 'cg';
      },
      assertion: { create, write },
    };
    const { ctx, res } = buildTurnCtx({
      contextGraphId: 'cg',
      markdown: '# Agent lane turn',
      subGraphName: 'team-memory',
      turnId: 'turn-1',
    }, agent, requestAgentAddress);

    await handleMemoryRoutes(ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.graph).toBe(`graph:${requestAgentAddress}:team-memory`);
    expect(create).toHaveBeenCalledWith(
      'cg',
      expect.stringMatching(/^turn-[0-9a-f]{32}$/),
      { subGraphName: 'team-memory', agentAddress: requestAgentAddress },
    );
    expect(write).toHaveBeenCalledWith(
      'cg',
      body.assertionName,
      expect.arrayContaining([
        expect.objectContaining({
          subject: body.turnUri,
          predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        }),
      ]),
      { subGraphName: 'team-memory', agentAddress: requestAgentAddress },
    );
  });
});
