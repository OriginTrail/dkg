import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';

describe('POST /api/context-graph/{id}/request-join', () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it('lets the repair-aware curator admission path handle an expired retry', async () => {
    const contextGraphId = 'private-expired-repair';
    const peerId = '12D3KooWExpiredRepairCurator';
    const delegation = {
      agentAddress: '0x2222222222222222222222222222222222222222',
      scope: `join:test:${contextGraphId}`,
      issuedAtMs: Date.now() - 2_000,
      expiresAtMs: Date.now() - 1_000,
      delegateePeerId: peerId,
      signature: `0x${'11'.repeat(65)}`,
    };
    const verifyJoinRequest = vi.fn(() => {
      throw new Error('verifyAgentDelegation: delegation expired');
    });
    const processIncomingJoinRequest = vi.fn().mockResolvedValue({
      status: 'approved',
      autoApproved: true,
      alreadyMember: true,
    });
    const agent = {
      peerId,
      verifyJoinRequest,
      isCuratorOf: vi.fn().mockResolvedValue(true),
      processIncomingJoinRequest,
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
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route test server did not bind');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/context-graph/${encodeURIComponent(contextGraphId)}/request-join`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegation, agentName: 'expired-repair-joiner' }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'already-member',
      alreadyMember: true,
      autoApproved: true,
    });
    expect(verifyJoinRequest).not.toHaveBeenCalled();
    expect(processIncomingJoinRequest).toHaveBeenCalledWith(
      contextGraphId,
      delegation,
      'expired-repair-joiner',
      peerId,
    );
  });
});
