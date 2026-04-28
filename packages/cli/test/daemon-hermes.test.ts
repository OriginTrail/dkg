import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import {
  buildHermesChannelHeaders,
  buildStableHermesTurnId,
  ensureHermesBridgeAvailable,
  getHermesChannelTargets,
  normalizeHermesChatPayload,
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function makeHermesRouteContext(
  payload: unknown,
  memoryManager: any,
  configOverrides: Partial<DkgConfig> = {},
  path = '/api/hermes-channel/persist-turn',
) {
  const req = makeJsonRequest('POST', path, payload);
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
      path,
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

  it('prefers a stored Hermes transport healthUrl over derived health endpoints', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9202',
            healthUrl: 'http://127.0.0.1:9300/custom-health',
          },
        },
      },
    }))).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9202/send',
        streamUrl: 'http://127.0.0.1:9202/stream',
        healthUrl: 'http://127.0.0.1:9300/custom-health',
      },
    ]);

    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            gatewayUrl: 'https://hermes.example.com',
            healthUrl: 'https://hermes.example.com/custom-health',
          },
        },
      },
    }))[0]?.healthUrl).toBe('https://hermes.example.com/custom-health');
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

    expect(buildHermesChannelHeaders(
      { name: 'bridge', inboundUrl: 'http://127.0.0.1:9202/send', healthUrl: 'https://hermes.example.com/health' },
      'secret-token',
      { Accept: 'application/json' },
      'https://hermes.example.com/health',
    )).toEqual({ Accept: 'application/json' });
  });

  it('normalizes profileName aliases for send and persist payloads', () => {
    const send = normalizeHermesChatPayload({
      text: 'hello',
      correlationId: 'corr-1',
      profileName: ' default ',
    });
    const persist = normalizeHermesPersistTurnPayload({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      profileName: ' default ',
      idempotencyKey: 'idem-1',
    });

    expect('error' in send).toBe(false);
    expect('error' in persist).toBe(false);
    if ('error' in send || 'error' in persist) throw new Error('unexpected normalization error');
    expect(send.profile).toBe('default');
    expect(persist.profile).toBe('default');
  });

  it('prefers profile over profileName when both aliases are present', () => {
    const send = normalizeHermesChatPayload({
      text: 'hello',
      correlationId: 'corr-1',
      profile: ' explicit ',
      profileName: 'alias',
    });

    expect('error' in send).toBe(false);
    if ('error' in send) throw new Error('unexpected normalization error');
    expect(send.profile).toBe('explicit');
  });

  it('normalizes persist-turn payloads with idempotency-key turn ids', () => {
    const payload = {
      sessionId: ' hermes:default ',
      userMessage: 'hello',
      assistantReply: 'hi',
      profile: 'default',
      idempotencyKey: ' idem-1 ',
    };
    const first = normalizeHermesPersistTurnPayload(payload);
    const second = normalizeHermesPersistTurnPayload(payload);
    expect('error' in first).toBe(false);
    expect('error' in second).toBe(false);
    if ('error' in first || 'error' in second) throw new Error('unexpected normalization error');
    expect(first.turnId).toBe(second.turnId);
    expect(first.turnId).toBe(buildStableHermesTurnId({
      sessionId: 'hermes:default',
      idempotencyKey: 'idem-1',
      profile: 'default',
    }));
  });

  it('does not collapse identical persist-turn payloads without an idempotency key', () => {
    const payload = {
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      profile: 'default',
    };
    const first = normalizeHermesPersistTurnPayload(payload);
    const second = normalizeHermesPersistTurnPayload(payload);
    expect('error' in first).toBe(false);
    expect('error' in second).toBe(false);
    if ('error' in first || 'error' in second) throw new Error('unexpected normalization error');
    expect(first.turnId).toMatch(/^hermes-/);
    expect(second.turnId).toMatch(/^hermes-/);
    expect(first.turnId).not.toBe(second.turnId);
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

  it('refresh preserves sibling Hermes transport endpoints when one target is healthy', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
          },
          runtime: { status: 'degraded', ready: false },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      if (requestUrl.startsWith('http://127.0.0.1:9444')) {
        return new Response(JSON.stringify({ ok: false, error: 'bridge offline' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');

    expect(integration.runtime.status).toBe('ready');
    expect(integration.transport.bridgeUrl).toBe('http://127.0.0.1:9444');
    expect(integration.transport.gatewayUrl).toBe('https://hermes.example.com');
  });

  it('refresh keeps Hermes degraded when health returns ok false with HTTP 200', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9444' },
          runtime: { status: 'ready', ready: true },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'warming up',
    }), { status: 200 })));

    const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');

    expect(integration.runtime.status).toBe('degraded');
    expect(integration.runtime.ready).toBe(false);
    expect(integration.runtime.lastError).toBe('warming up');
  });

  it('Hermes definition includes manifest, transport, and local chat capabilities', () => {
    const integration = getLocalAgentIntegration(makeConfig(), 'hermes');
    expect(integration?.transport.kind).toBe('hermes-channel');
    expect(integration?.manifest?.packageName).toBe('@origintrail-official/dkg-adapter-hermes');
    expect(integration?.manifest?.setupEntry).toBe('./setup-entry.mjs');
    expect(integration?.capabilities.localChat).toBe(true);
    expect(integration?.capabilities.chatAttachments).toBe(true);
  });
});

describe('Hermes daemon routes', () => {
  it('fails closed for chat send when Hermes local-agent chat is not enabled', async () => {
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: { enabled: false },
      },
    }, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'INTEGRATION_DISABLED',
    });
  });

  it('forwards the documented contextGraphId and legacy uiContextGraphId to Hermes send', async () => {
    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'hi', correlationId: 'corr-1' }), { status: 200 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
      contextGraphId: 'project-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      contextGraphId: 'project-1',
      uiContextGraphId: 'project-1',
    });
  });

  it('forwards the documented contextGraphId and legacy uiContextGraphId to Hermes stream', async () => {
    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'hi', correlationId: 'corr-1' }), { status: 200 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
      contextGraphId: 'project-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/stream');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      contextGraphId: 'project-1',
      uiContextGraphId: 'project-1',
    });
  });

  it('accepts authenticated persist-turn even when UI chat is not enabled', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    }, {
      localAgentIntegrations: {
        hermes: { enabled: false },
      },
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(storeChatExchange).toHaveBeenCalled();
  });

  it('persists a Hermes turn through ChatMemoryManager with a normalized generated turn id', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
    }, memoryManager);
    ctx.agent.importMemories = importMemories;

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
    expect(importMemories).toHaveBeenCalledWith('hi', `hermes-session:hermes:default:turn:${body.turnId}`);
  });

  it('treats a repeated Hermes turn id as an idempotent duplicate', async () => {
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      hasChatTurn: vi.fn(async () => true),
      storeChatExchange: vi.fn(async () => {}),
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-1',
    }, memoryManager);
    ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(memoryManager.hasChatTurn).toHaveBeenCalledWith('hermes:default', 'turn-1');
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    expect(importMemories).not.toHaveBeenCalled();
  });

  it('serializes concurrent persist-turn retries for the same turn id', async () => {
    let stored = false;
    const storeStarted = deferred();
    const releaseStore = deferred();
    const storeChatExchange = vi.fn(async () => {
      storeStarted.resolve();
      await releaseStore.promise;
      stored = true;
    });
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      hasChatTurn: vi.fn(async () => stored),
      storeChatExchange,
    };
    const payload = {
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-1',
    };
    const first = makeHermesRouteContext(payload, memoryManager);
    const second = makeHermesRouteContext(payload, memoryManager);
    first.ctx.agent.importMemories = importMemories;
    second.ctx.agent.importMemories = importMemories;

    const firstRun = handleHermesRoutes(first.ctx);
    await storeStarted.promise;
    const secondRun = handleHermesRoutes(second.ctx);
    await Promise.resolve();
    expect(storeChatExchange).toHaveBeenCalledTimes(1);

    releaseStore.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(storeChatExchange).toHaveBeenCalledTimes(1);
    expect(importMemories).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.res.body)).toEqual({ ok: true, turnId: 'turn-1' });
    expect(JSON.parse(second.res.body)).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
  });

  it('keeps persist-turn successful when Hermes extraction import fails', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const importMemories = vi.fn(async () => {
      throw new Error('extract offline');
    });
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    });
    ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, turnId: 'turn-1' });
    expect(storeChatExchange).toHaveBeenCalled();
    expect(importMemories).toHaveBeenCalledWith('hi', 'hermes-session:hermes:default:turn:turn-1');
  });

  it('fails without storing when duplicate detection cannot query the turn id', async () => {
    const memoryManager = {
      hasChatTurn: vi.fn(async () => {
        throw new Error('query offline');
      }),
      storeChatExchange: vi.fn(async () => {}),
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn-1',
    }, memoryManager);

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'query offline' });
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

  it('does not mark Hermes ready when health JSON reports ok false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'warming up',
    }), { status: 200 })));

    const report = await probeHermesChannelHealth(makeConfig(), 'bridge-token');

    expect(report.ok).toBe(false);
    expect(report.bridge?.ok).toBe(false);
    expect(report.error).toBe('warming up');
  });

  it('treats a bridge health ok:false body as unavailable before send', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'profile conflict',
    }), { status: 200 })));

    const availability = await ensureHermesBridgeAvailable({
      name: 'bridge',
      inboundUrl: 'http://127.0.0.1:9202/send',
      healthUrl: 'http://127.0.0.1:9202/health',
    }, 'bridge-token');

    expect(availability).toMatchObject({
      ok: false,
      details: 'profile conflict',
      offline: true,
    });
  });
});
