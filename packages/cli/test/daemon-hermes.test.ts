import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import {
  buildHermesChannelHeaders,
  buildStableHermesTurnId,
  getHermesChannelTargets,
  normalizeHermesPersistTurnPayload,
  probeHermesChannelHealth,
} from '../src/daemon/hermes.js';
import {
  connectLocalAgentIntegrationFromUi,
  getLocalAgentIntegration,
  refreshLocalAgentIntegrationFromUi,
} from '../src/daemon/local-agents.js';
import { handleHermesRoutes } from '../src/daemon/routes/hermes.js';

function makeConfig(overrides: Partial<DkgConfig> = {}): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    ...overrides,
  };
}

function makeJsonRequest(method: string, path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.write = (chunk: string | Buffer) => {
    res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

function makeHermesRouteContext(payload: unknown, memoryManager: any, configOverrides: Partial<DkgConfig> = {}) {
  const req = makeJsonRequest('POST', '/api/hermes-channel/persist-turn', payload);
  const res = makeJsonResponse();
  return {
    ctx: {
      req,
      res,
      agent: { store: {} },
      config: makeConfig({
        localAgentIntegrations: {
          hermes: {
            enabled: true,
            capabilities: { localChat: true },
            transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' },
          },
        },
        ...configOverrides,
      }),
      memoryManager,
      bridgeAuthToken: 'bridge-token',
      extractionStatus: new Map(),
      path: '/api/hermes-channel/persist-turn',
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as any,
    res,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Hermes channel helpers', () => {
  it('defaults to the local Hermes bridge when no transport is configured', () => {
    expect(getHermesChannelTargets(makeConfig())).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9202/send',
        streamUrl: 'http://127.0.0.1:9202/stream',
        healthUrl: 'http://127.0.0.1:9202/health',
      },
    ]);
  });

  it('returns no Hermes channel targets when the integration is disabled', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: { enabled: false },
      },
    }))).toEqual([]);
  });

  it('uses Hermes gateway routes when a gateway URL is configured', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            gatewayUrl: 'http://gateway.local:9300',
          },
        },
      },
    }))).toEqual([
      {
        name: 'gateway',
        inboundUrl: 'http://gateway.local:9300/api/hermes-channel/send',
        streamUrl: 'http://gateway.local:9300/api/hermes-channel/stream',
        healthUrl: 'http://gateway.local:9300/api/hermes-channel/health',
      },
    ]);
  });

  it('ignores non-loopback bridge URLs and requires gatewayUrl for remote transports', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'https://hermes.example.com:9202',
          },
        },
      },
    }))).toEqual([]);

    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'https://hermes.example.com:9202',
            gatewayUrl: 'https://hermes.example.com',
          },
        },
      },
    }))).toEqual([
      {
        name: 'gateway',
        inboundUrl: 'https://hermes.example.com/api/hermes-channel/send',
        streamUrl: 'https://hermes.example.com/api/hermes-channel/stream',
        healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
      },
    ]);
  });

  it('adds the route-scoped bridge token header only for standalone bridge targets', () => {
    expect(buildHermesChannelHeaders(
      { name: 'bridge', inboundUrl: 'http://127.0.0.1:9202/send' },
      'secret-token',
      { 'Content-Type': 'application/json' },
    )).toEqual({
      'Content-Type': 'application/json',
      'x-dkg-bridge-token': 'secret-token',
    });

    expect(buildHermesChannelHeaders(
      { name: 'gateway', inboundUrl: 'http://gateway.local/api/hermes-channel/send' },
      'secret-token',
      { 'Content-Type': 'application/json' },
    )).toEqual({ 'Content-Type': 'application/json' });

    expect(buildHermesChannelHeaders(
      { name: 'bridge', inboundUrl: 'https://hermes.example.com/send' },
      'secret-token',
      { 'Content-Type': 'application/json' },
    )).toEqual({ 'Content-Type': 'application/json' });
  });

  it('normalizes persist-turn payloads and builds stable generated turn ids', () => {
    const payload = {
      sessionId: ' hermes:default ',
      userMessage: 'hello',
      assistantReply: 'hi',
      profile: 'default',
    };
    const first = normalizeHermesPersistTurnPayload(payload);
    const second = normalizeHermesPersistTurnPayload(payload);
    expect('error' in first).toBe(false);
    expect('error' in second).toBe(false);
    if ('error' in first || 'error' in second) throw new Error('unexpected normalization error');
    expect(first.turnId).toBe(second.turnId);
    expect(first.turnId).toBe(buildStableHermesTurnId({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      profile: 'default',
    }));
  });
});

describe('Hermes local-agent registry lifecycle', () => {
  it('marks Hermes ready when UI connect can reach bridge health', async () => {
    const config = makeConfig();
    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: true, target: 'bridge' }),
      },
    );

    expect(result.integration.id).toBe('hermes');
    expect(result.integration.runtime.status).toBe('ready');
    expect(result.integration.runtime.ready).toBe(true);
    expect(result.integration.transport.kind).toBe('hermes-channel');
    expect(result.integration.capabilities.localChat).toBe(true);
    expect(result.integration.capabilities.chatAttachments).toBe(true);
  });

  it('marks Hermes degraded when UI connect cannot reach bridge health', async () => {
    const config = makeConfig();
    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
      },
    );

    expect(result.integration.runtime.status).toBe('degraded');
    expect(result.integration.runtime.ready).toBe(false);
    expect(result.integration.runtime.lastError).toBe('offline');
  });

  it('refresh probes Hermes health and promotes an existing integration to ready', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9444' },
          runtime: { status: 'degraded', ready: false },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');

    expect(integration.runtime.status).toBe('ready');
    expect(integration.runtime.ready).toBe(true);
    expect(integration.transport.bridgeUrl).toBe('http://127.0.0.1:9444');
  });

  it('Hermes definition includes manifest, transport, and local chat capabilities', () => {
    const integration = getLocalAgentIntegration(makeConfig(), 'hermes');
    expect(integration?.transport.kind).toBe('hermes-channel');
    expect(integration?.manifest?.packageName).toBe('@origintrail-official/dkg-adapter-hermes');
    expect(integration?.capabilities.localChat).toBe(true);
    expect(integration?.capabilities.chatAttachments).toBe(true);
  });
});

describe('Hermes daemon routes', () => {
  it('fails closed when Hermes local-agent chat is not enabled', async () => {
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
    }, {
      getSession: vi.fn(async () => null),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: { enabled: false },
      },
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'INTEGRATION_DISABLED',
    });
  });

  it('persists a Hermes turn through ChatMemoryManager with a normalized stable turn id', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const memoryManager = {
      getSession: vi.fn(async () => null),
      storeChatExchange,
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
    }, memoryManager);

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.turnId).toMatch(/^hermes-/);
    expect(storeChatExchange).toHaveBeenCalledWith(
      'hermes:default',
      'hello',
      'hi',
      undefined,
      expect.objectContaining({
        turnId: body.turnId,
        persistenceState: 'stored',
      }),
    );
  });

  it('treats a repeated Hermes turn id as an idempotent duplicate', async () => {
    const memoryManager = {
      getSession: vi.fn(async () => ({
        session: 'hermes:default',
        messages: [{ turnId: 'turn-1', author: 'user', text: 'hello', ts: new Date().toISOString(), uri: 'urn:test' }],
      })),
      storeChatExchange: vi.fn(async () => {}),
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-1',
    }, memoryManager);

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
  });

  it('probes Hermes bridge health with the bridge token header', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'x-dkg-bridge-token': 'bridge-token' });
      return new Response(JSON.stringify({ ok: true, channel: 'hermes' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await probeHermesChannelHealth(makeConfig(), 'bridge-token');

    expect(report.ok).toBe(true);
    expect(report.target).toBe('bridge');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9202/health',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-dkg-bridge-token': 'bridge-token' }) }),
    );
  });
});
