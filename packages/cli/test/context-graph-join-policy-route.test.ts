import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';

const CONTEXT_GRAPH_ID = '0x1234567890123456789012345678901234567890/private-graph';
const OWNER_ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';

const ACCEPT_WRITE_PREFLIGHT = {
  storeAvailable: true,
  exists: true,
  hasLocalContent: true,
  declarationFound: true,
  accessPolicy: 'private',
  callerAuthorized: true,
};

describe('GET/PUT /api/context-graph/{id}/join-policy', () => {
  const servers = new Set<Server>();

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([...servers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
    servers.clear();
  });

  async function requestJoinPolicy(opts: {
    method: 'GET' | 'PUT';
    token?: string;
    body?: unknown;
    rawBody?: string;
    agentOverrides?: Record<string, unknown>;
  }): Promise<{ status: number; body: any; agent: Record<string, any> }> {
    const getContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'manual',
      source: 'default',
      ownerDid: `did:dkg:agent:${OWNER_ADDRESS}`,
      ownerAgentAddress: OWNER_ADDRESS,
      memberCount: 1,
    });
    const setContextGraphJoinPolicy = vi.fn().mockImplementation(
      async (contextGraphId: string, update: Record<string, unknown>) => ({
        contextGraphId,
        ...update,
        source: 'persisted',
        ownerDid: `did:dkg:agent:${OWNER_ADDRESS}`,
        ownerAgentAddress: OWNER_ADDRESS,
        memberCount: 1,
      }),
    );
    const resolveAgentByToken = (token?: string) => {
      if (token === 'owner-token') return OWNER_ADDRESS;
      if (token === 'other-token') return OTHER_ADDRESS;
      return undefined;
    };
    const agent: Record<string, any> = {
      resolveAgentByToken,
      resolveAgentAddress: (token?: string) => resolveAgentByToken(token) ?? OWNER_ADDRESS,
      probeContextGraphWritePreflight: vi.fn().mockResolvedValue(ACCEPT_WRITE_PREFLIGHT),
      listContextGraphs: vi.fn().mockRejectedValue(new Error('write preflight should fast-accept')),
      getContextGraphJoinPolicy,
      setContextGraphJoinPolicy,
      ...opts.agentOverrides,
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authorization = req.headers.authorization;
      const requestToken = typeof authorization === 'string'
        ? authorization.replace(/^Bearer\s+/i, '')
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
        validTokens: new Set(['owner-token', 'other-token', 'node-token']),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken,
        requestAgentAddress: agent.resolveAgentAddress(requestToken),
        requestPrincipal: agent.resolveAgentByToken(requestToken)
          ? { kind: 'agent', agentAddress: agent.resolveAgentByToken(requestToken)! }
          : { kind: 'nodeOperator' },
        requestAuthorization: { nodeOperator: !agent.resolveAgentByToken(requestToken) },
      } as any);
      if (!res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('route test server did not bind');

    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined || opts.rawBody !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/context-graph/${encodeURIComponent(CONTEXT_GRAPH_ID)}/join-policy`,
      {
        method: opts.method,
        headers,
        ...(opts.body !== undefined
          ? { body: JSON.stringify(opts.body) }
          : opts.rawBody !== undefined
            ? { body: opts.rawBody }
            : {}),
      },
    );
    return { status: response.status, body: await response.json(), agent };
  }

  it('returns policy status for the decoded CG id and exact owner-scoped token', async () => {
    const getContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'open',
      source: 'persisted',
      ownerDid: `did:dkg:agent:${OWNER_ADDRESS}`,
      ownerAgentAddress: OWNER_ADDRESS,
      memberCount: 7,
      maxMembers: 25,
      maxApprovalsPerHour: 4,
      updatedAt: 1_700_000_000_000,
    });
    const result = await requestJoinPolicy({
      method: 'GET',
      token: 'owner-token',
      agentOverrides: { getContextGraphJoinPolicy },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 4,
      memberCount: 7,
    }));
    expect(getContextGraphJoinPolicy).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, OWNER_ADDRESS);
  });

  it('enables bounded open enrollment and forwards the exact owner to preflight and policy update', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 4,
    });
    const probeContextGraphWritePreflight = vi.fn().mockResolvedValue(ACCEPT_WRITE_PREFLIGHT);
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      body: {
        mode: 'open',
        maxMembers: 25,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      },
      agentOverrides: { setContextGraphJoinPolicy, probeContextGraphWritePreflight },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(expect.objectContaining({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 4,
    }));
    expect(probeContextGraphWritePreflight).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, {
      callerAgentAddress: OWNER_ADDRESS,
    });
    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      {
        mode: 'open',
        maxMembers: 25,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      },
      OWNER_ADDRESS,
    );
  });

  it('uses the default owner for node-admin preflight without listing every context graph', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 4,
    });
    const probeContextGraphWritePreflight = vi.fn().mockResolvedValue(ACCEPT_WRITE_PREFLIGHT);
    const listContextGraphs = vi.fn().mockRejectedValue(
      new Error('global context graph listing must not run'),
    );
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'node-token',
      body: {
        mode: 'open',
        maxMembers: 25,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      },
      agentOverrides: {
        setContextGraphJoinPolicy,
        probeContextGraphWritePreflight,
        listContextGraphs,
      },
    });

    expect(result.status).toBe(200);
    expect(probeContextGraphWritePreflight).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, {
      callerAgentAddress: OWNER_ADDRESS,
    });
    expect(listContextGraphs).not.toHaveBeenCalled();
    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      {
        mode: 'open',
        maxMembers: 25,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      },
      OWNER_ADDRESS,
    );
  });

  it('switches to manual mode without forwarding ignored open-enrollment fields', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: CONTEXT_GRAPH_ID,
      mode: 'manual',
    });
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      body: {
        mode: 'manual',
        maxMembers: 999,
        maxApprovalsPerHour: 999,
        acknowledgeOpenEnrollment: true,
      },
      agentOverrides: { setContextGraphJoinPolicy },
    });

    expect(result.status).toBe(200);
    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      { mode: 'manual' },
      OWNER_ADDRESS,
    );
  });

  it('rejects an unsupported mode before calling the policy store', async () => {
    const setContextGraphJoinPolicy = vi.fn();
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      body: { mode: 'invite-only' },
      agentOverrides: { setContextGraphJoinPolicy },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('mode must be "manual" or "open"');
    expect(setContextGraphJoinPolicy).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON without calling the policy store', async () => {
    const setContextGraphJoinPolicy = vi.fn();
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      rawBody: '{"mode":"open"',
      agentOverrides: { setContextGraphJoinPolicy },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/JSON|Unexpected/i);
    expect(setContextGraphJoinPolicy).not.toHaveBeenCalled();
  });

  it('maps cap validation failures to 400 with the agent error intact', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockRejectedValue(
      new Error('maxMembers must be an integer between 1 and 10000.'),
    );
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      body: {
        mode: 'open',
        maxMembers: 0,
        maxApprovalsPerHour: 4,
        acknowledgeOpenEnrollment: true,
      },
      agentOverrides: { setContextGraphJoinPolicy },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('maxMembers must be an integer between 1 and 10000.');
    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      expect.objectContaining({ mode: 'open', maxMembers: 0 }),
      OWNER_ADDRESS,
    );
  });

  it('maps owner authorization failures to 403 on status and update routes', async () => {
    const ownerError = new Error(
      `Only the context graph curator can manage join policy for "${CONTEXT_GRAPH_ID}". ` +
      `Owner=did:dkg:agent:${OWNER_ADDRESS}, caller=did:dkg:agent:${OTHER_ADDRESS}.`,
    );
    const getContextGraphJoinPolicy = vi.fn().mockRejectedValue(ownerError);
    const getResult = await requestJoinPolicy({
      method: 'GET',
      token: 'other-token',
      agentOverrides: { getContextGraphJoinPolicy },
    });
    expect(getResult.status).toBe(403);
    expect(getResult.body.error).toMatch(/Only the context graph curator/);
    expect(getContextGraphJoinPolicy).toHaveBeenCalledWith(CONTEXT_GRAPH_ID, OTHER_ADDRESS);

    const setContextGraphJoinPolicy = vi.fn().mockRejectedValue(ownerError);
    const putResult = await requestJoinPolicy({
      method: 'PUT',
      token: 'other-token',
      body: { mode: 'manual' },
      agentOverrides: { setContextGraphJoinPolicy },
    });
    expect(putResult.status).toBe(403);
    expect(putResult.body.error).toMatch(/Only the context graph curator/);
    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      { mode: 'manual' },
      OTHER_ADDRESS,
    );
  });

  it('maps non-authorization persistence failures to 400', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockRejectedValue(
      new Error('Durable context graph join-policy storage is not configured.'),
    );
    const result = await requestJoinPolicy({
      method: 'PUT',
      token: 'owner-token',
      body: { mode: 'manual' },
      agentOverrides: { setContextGraphJoinPolicy },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/storage is not configured/);
  });
});
