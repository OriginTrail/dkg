import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

describe('context graph subscription diagnostics route', () => {
  let server: Server | undefined;
  let baseUrl = '';
  const rehydration = {
    persistedTotal: 70,
    systemExcluded: 2,
    hostedActivated: 2,
    hostedActivatedIds: ['cg-hosted', 'cg-host-only'],
    activated: 64,
    dormant: 6,
    activationCap: 64,
    capDisabled: false,
    dormantIds: ['cg-064', 'cg-065', 'cg-066', 'cg-067', 'cg-068', 'cg-069'],
    completedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  let rehydrationStatus: typeof rehydration | null = null;
  let subscriptions: Map<string, any>;

  beforeEach(async () => {
    rehydrationStatus = rehydration;
    subscriptions = new Map<string, any>([
      ['cg-000', { subscribed: true, synced: true, coreHosted: false }],
      ['cg-hosted', { subscribed: true, synced: false, coreHosted: true }],
      ['cg-host-only', { subscribed: false, synced: false, coreHosted: true }],
      ['cg-discoverable', { subscribed: false, synced: false, coreHosted: false }],
      [SYSTEM_CONTEXT_GRAPHS.AGENTS, { subscribed: true, synced: true, coreHosted: false }],
    ]);
    const agent = {
      getSubscribedContextGraphs: () => subscriptions,
      getContextGraphSubscriptionRehydrationStatus: () => rehydrationStatus,
      clearContextGraphSubscriptions: async () => {
        rehydrationStatus = rehydrationStatus
          ? {
              ...rehydrationStatus,
              persistedTotal: 2,
              activated: 2,
              dormant: 0,
              dormantIds: [],
              updatedAt: 1_700_000_000_001,
            }
          : null;
        subscriptions.delete('cg-000');
        subscriptions.delete('cg-discoverable');
        return 6;
      },
      resolveAgentByToken: (token?: string) => token === 'agent-token'
        ? '0x1111111111111111111111111111111111111111'
        : undefined,
    };
    const validTokens = new Set(['admin-token', 'agent-token']);

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers.authorization;
      const requestToken = typeof auth === 'string'
        ? auth.replace(/^Bearer\s+/i, '')
        : undefined;
      await handleContextGraphRoutes({
        req,
        res,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: { auth: { enabled: true } },
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
        validTokens,
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestAgentAddress: agent.resolveAgentByToken(requestToken),
        authentication: agent.resolveAgentByToken(requestToken)
          ? requestAuthentication({ kind: 'agent', agentAddress: agent.resolveAgentByToken(requestToken)!, token: requestToken })
          : requestAuthentication({ kind: 'nodeOperator', token: requestToken }),
      } as any);
      if (!res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (typeof address === 'object' && address) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  it('returns active user subscriptions with rehydration diagnostics to node admins', async () => {
    const response = await fetch(`${baseUrl}/api/context-graph/subscriptions`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.subscriptions).toEqual([
      { contextGraphId: 'cg-000', subscribed: true, synced: true, coreHosted: false },
      { contextGraphId: 'cg-hosted', subscribed: true, synced: false, coreHosted: true },
    ]);
    expect(body.rehydration).toEqual(rehydration);
  });

  it('rejects agent-scoped tokens for node-wide subscription diagnostics', async () => {
    const response = await fetch(`${baseUrl}/api/context-graph/subscriptions`, {
      headers: { authorization: 'Bearer agent-token' },
    });
    const body = await response.json() as any;

    expect(response.status).toBe(403);
    expect(body.error).toContain('node-level admin token');
  });

  it('returns updated rehydration diagnostics after the admin clears the backlog', async () => {
    const deleteResponse = await fetch(`${baseUrl}/api/context-graph/subscriptions`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ cleared: 6 });

    const response = await fetch(`${baseUrl}/api/context-graph/subscriptions`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.subscriptions).toEqual([
      { contextGraphId: 'cg-hosted', subscribed: true, synced: false, coreHosted: true },
    ]);
    expect(body.rehydration).toEqual({
      ...rehydration,
      persistedTotal: 2,
      activated: 2,
      dormant: 0,
      dormantIds: [],
      completedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
    });
  });
});
