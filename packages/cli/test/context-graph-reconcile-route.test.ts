import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  ContextGraphNotFoundError,
  ContextGraphOnChainIdUnresolvedError,
  VmReconcileQueueClosedError,
  VmReconcileQueueFullError,
  VmReconcileUnavailableError,
} from '@origintrail-official/dkg-agent';
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
    options: {
      authEnabled?: boolean;
      requestToken?: string;
      agentAddress?: string;
    } = {},
  ): Promise<{ status: number; body: any }> {
    const agent = {
      runVmReconcileForCg: reconcile,
      resolveAgentByToken: (token: string) =>
        token === options.requestToken ? options.agentAddress : undefined,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req,
        res,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: { auth: { enabled: options.authEnabled ?? false } },
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
        validTokens: new Set(options.requestToken ? [options.requestToken] : []),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken: options.requestToken,
        requestAgentAddress: options.agentAddress,
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
    }, { contextGraphId: 'target-cg' }, {
      authEnabled: true,
      requestToken: 'node-admin-token',
    });

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

  it('returns 409 for a subscribed graph with no resolved on-chain id', async () => {
    const result = await request(async (contextGraphId) => {
      throw new ContextGraphOnChainIdUnresolvedError(contextGraphId);
    }, { contextGraphId: 'unbound-cg' });

    expect(result.status).toBe(409);
    expect(result.body.error).toContain('unbound-cg');
  });

  it('returns 503 when chain-driven reconciliation is unavailable', async () => {
    const result = await request(async () => {
      throw new VmReconcileUnavailableError();
    }, { contextGraphId: 'target-cg' });

    expect(result.status).toBe(503);
    expect(result.body.error).toContain('unavailable');
  });

  it('returns 429 when the bounded reconcile dispatcher is full', async () => {
    const result = await request(async () => {
      throw new VmReconcileQueueFullError(256);
    }, { contextGraphId: 'target-cg' });

    expect(result.status).toBe(429);
    expect(result.body.error).toContain('queue is full');
  });

  it('returns 503 once reconcile admission closes for shutdown', async () => {
    const result = await request(async () => {
      throw new VmReconcileQueueClosedError();
    }, { contextGraphId: 'target-cg' });

    expect(result.status).toBe(503);
    expect(result.body.error).toContain('closed');
  });

  it('rejects an agent-scoped token before exposing or enqueueing node-wide graph work', async () => {
    let called = false;
    const result = await request(async () => {
      called = true;
    }, { contextGraphId: 'another-agent-private-cg' }, {
      authEnabled: true,
      requestToken: 'dkg_at_alice',
      agentAddress: '0x00000000000000000000000000000000000000a1',
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toContain('node-level admin token');
    expect(called).toBe(false);
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
