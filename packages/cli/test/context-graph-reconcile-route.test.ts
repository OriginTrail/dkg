import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ContextGraphNotFoundError } from '@origintrail-official/dkg-agent';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';

describe('context graph targeted reconcile route', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  async function request(
    reconcile: (contextGraphId: string, source: string) => Promise<unknown>,
    body: Record<string, unknown> | string,
  ): Promise<{ status: number; body: any }> {
    const agent = {
      reconcileContextGraphIfBehind: reconcile,
      resolveAgentByToken: () => undefined,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req,
        res,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: { auth: { enabled: false } },
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
        fileStore: {},
        extractionStatus: new Map(),
        assertionImportLocks: new Map(),
        vectorStore: {},
        embeddingProvider: null,
        validTokens: new Set(),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken: undefined,
        requestAgentAddress: undefined,
      } as any);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/context-graph/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('runs a manual one-CG reconcile and returns its chain evidence', async () => {
    const calls: Array<[string, string]> = [];
    const result = await request(async (contextGraphId, source) => {
      calls.push([contextGraphId, source]);
      return {
        contextGraphId,
        onChainId: '42',
        source,
        status: 'current',
        attempted: false,
        headOrdinal: 5,
        watermarkBefore: 5,
        watermarkAfter: 5,
        reconciledOrdinals: 0,
        unresolvedOrdinals: 0,
      };
    }, { contextGraphId: 'target-cg' });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      contextGraphId: 'target-cg',
      source: 'manual',
      status: 'current',
      attempted: false,
      headOrdinal: 5,
    });
    expect(calls).toEqual([['target-cg', 'manual']]);
  });

  it('returns 404 for a graph this node neither subscribes to nor hosts', async () => {
    const result = await request(async (contextGraphId) => {
      throw new ContextGraphNotFoundError(contextGraphId);
    }, { id: 'unknown-cg' });

    expect(result.status).toBe(404);
    expect(result.body.error).toContain('unknown-cg');
  });

  it('requires a context graph id', async () => {
    const result = await request(async () => undefined, {});
    expect(result.status).toBe(400);
  });

  it('rejects invalid JSON without starting reconciliation', async () => {
    let called = false;
    const result = await request(async () => {
      called = true;
    }, '{');

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Invalid JSON body');
    expect(called).toBe(false);
  });
});
