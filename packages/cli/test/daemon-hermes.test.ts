import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { DkgConfig } from '../src/config.js';
import {
  buildHermesChannelHeaders,
  buildStableHermesTurnId,
  ensureHermesBridgeAvailable,
  getHermesChannelTargets,
  isHermesLoopbackUrl,
  normalizeHermesChatPayload,
  normalizeHermesPersistTurnPayload,
  probeHermesChannelHealth,
} from '../src/daemon/hermes.js';
import {
  connectLocalAgentIntegrationFromUi,
  getLocalAgentIntegration,
  mergeLocalAgentIntegrationConfig,
  refreshLocalAgentIntegrationFromUi,
  reverseHermesSetupForUi,
} from '../src/daemon/local-agents.js';
import { handleHermesRoutes } from '../src/daemon/routes/hermes.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';

const disconnectHermesProfileMock = vi.hoisted(() => vi.fn());
const resolveHermesProfileMock = vi.hoisted(() => vi.fn(() => ({
  profileName: undefined,
  hermesHome: 'C:\\Hermes\\default',
  memoryMode: 'provider',
})));
vi.mock('@origintrail-official/dkg-adapter-hermes', () => ({
  disconnectHermesProfile: disconnectHermesProfileMock,
  resolveHermesProfile: resolveHermesProfileMock,
}));

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
  disconnectHermesProfileMock.mockReset();
  resolveHermesProfileMock.mockReset();
  resolveHermesProfileMock.mockReturnValue({
    profileName: undefined,
    hermesHome: 'C:\\Hermes\\default',
    memoryMode: 'provider',
  });
});

describe('Hermes channel helpers', () => {
  it('defaults to the local Hermes OpenAI-compatible API server when no transport is configured', () => {
    expect(getHermesChannelTargets(makeConfig())).toEqual([
      {
        name: 'gateway',
        protocol: 'hermes-openai',
        inboundUrl: 'http://127.0.0.1:8642/v1/chat/completions',
        streamUrl: 'http://127.0.0.1:8642/v1/chat/completions',
        healthUrl: 'http://127.0.0.1:8642/health',
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
        protocol: 'hermes-channel',
        inboundUrl: 'http://gateway.local:9300/api/hermes-channel/send',
        streamUrl: 'http://gateway.local:9300/api/hermes-channel/stream',
        healthUrl: 'http://gateway.local:9300/api/hermes-channel/health',
      },
    ]);
  });

  it('prefers a stored bridge healthUrl over derived bridge health endpoints', () => {
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
  });

  it('uses Hermes OpenAI-compatible API server routes when configured', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-openai',
            gatewayUrl: 'http://127.0.0.1:8642',
          },
        },
      },
    }))).toEqual([
      {
        name: 'gateway',
        protocol: 'hermes-openai',
        inboundUrl: 'http://127.0.0.1:8642/v1/chat/completions',
        streamUrl: 'http://127.0.0.1:8642/v1/chat/completions',
        healthUrl: 'http://127.0.0.1:8642/health',
      },
    ]);
  });

  it('rejects gateway healthUrl overrides outside the Hermes gateway API base', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            gatewayUrl: 'https://hermes.example.com',
            healthUrl: 'https://hermes.example.com/healthz',
          },
        },
      },
    }))).toEqual([{
      name: 'gateway',
      protocol: 'hermes-channel',
      inboundUrl: 'https://hermes.example.com/api/hermes-channel/send',
      streamUrl: 'https://hermes.example.com/api/hermes-channel/stream',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    }]);

    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            gatewayUrl: 'https://hermes.example.com',
            healthUrl: 'https://hermes.example.com/api/hermes-channel/custom-health',
          },
        },
      },
    }))[0]?.healthUrl).toBe('https://hermes.example.com/api/hermes-channel/custom-health');
  });

  it('does not apply a gateway healthUrl override to the bridge target', async () => {
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
            healthUrl: 'https://hermes.example.com/api/hermes-channel/custom-health',
          },
        },
      },
    });
    const targets = getHermesChannelTargets(config);
    expect(targets).toEqual([
      {
        name: 'bridge',
        inboundUrl: 'http://127.0.0.1:9444/send',
        streamUrl: 'http://127.0.0.1:9444/stream',
        healthUrl: 'http://127.0.0.1:9444/health',
      },
      {
        name: 'gateway',
        protocol: 'hermes-channel',
        inboundUrl: 'https://hermes.example.com/api/hermes-channel/send',
        streamUrl: 'https://hermes.example.com/api/hermes-channel/stream',
        healthUrl: 'https://hermes.example.com/api/hermes-channel/custom-health',
      },
    ]);

    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === 'http://127.0.0.1:9444/health') {
        return new Response(JSON.stringify({ ok: false, error: 'bridge offline' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const report = await probeHermesChannelHealth(config, 'bridge-token');

    expect(report).toMatchObject({ ok: true, target: 'gateway' });
    expect(urls).toEqual([
      'http://127.0.0.1:9444/health',
      'https://hermes.example.com/api/hermes-channel/custom-health',
    ]);
  });

  it('does not fall back to the default local bridge when bridgeUrl is non-loopback', () => {
    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'https://hermes.example.com:9202',
            healthUrl: 'https://hermes.example.com:9202/health',
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
            bridgeUrl: 'http://127.example.com:9202',
            healthUrl: 'http://127.example.com:9202/health',
          },
        },
      },
    }))).toEqual([]);
  });

  it('uses gatewayUrl rather than the local bridge when a remote Hermes transport is configured', () => {
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
        protocol: 'hermes-channel',
        inboundUrl: 'https://hermes.example.com/api/hermes-channel/send',
        streamUrl: 'https://hermes.example.com/api/hermes-channel/stream',
        healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
      },
    ]);

    expect(getHermesChannelTargets(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'https://hermes.example.com/api/hermes-channel',
          },
        },
      },
    }))).toEqual([
      {
        name: 'gateway',
        protocol: 'hermes-channel',
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
    expect(isHermesLoopbackUrl('http://127.0.0.1:9202/send')).toBe(true);
    expect(isHermesLoopbackUrl('http://127.255.255.255:9202/send')).toBe(true);
    expect(isHermesLoopbackUrl('http://localhost:9202/send')).toBe(true);
    expect(isHermesLoopbackUrl('http://[::1]:9202/send')).toBe(true);
    expect(isHermesLoopbackUrl('http://127.example.com:9202/send')).toBe(false);
    expect(buildHermesChannelHeaders(
      { name: 'bridge', inboundUrl: 'http://127.example.com:9202/send' },
      'secret-token',
      { 'Content-Type': 'application/json' },
    )).toEqual({ 'Content-Type': 'application/json' });

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

  it('normalizes profile for send and persist payloads', () => {
    const send = normalizeHermesChatPayload({
      text: 'hello',
      correlationId: 'corr-1',
      profile: ' default ',
    });
    const persist = normalizeHermesPersistTurnPayload({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      profile: ' default ',
      idempotencyKey: 'idem-1',
    });

    expect('error' in send).toBe(false);
    expect('error' in persist).toBe(false);
    if ('error' in send || 'error' in persist) throw new Error('unexpected normalization error');
    expect(send.profile).toBe('default');
    expect(persist.profile).toBe('default');
  });

  it('does not accept profileName as a Hermes channel payload alias', () => {
    const send = normalizeHermesChatPayload({
      text: 'hello',
      correlationId: 'corr-1',
      profileName: 'alias',
    });
    const persist = normalizeHermesPersistTurnPayload({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      profileName: 'alias',
    });

    expect('error' in send).toBe(false);
    expect('error' in persist).toBe(false);
    if ('error' in send || 'error' in persist) throw new Error('unexpected normalization error');
    expect(send.profile).toBeUndefined();
    expect(persist.profile).toBeUndefined();
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

  it('rejects unsafe Hermes persist-turn identifiers before chat URI persistence', () => {
    expect(normalizeHermesPersistTurnPayload({
      sessionId: 'hermes default',
      userMessage: 'hello',
      assistantReply: 'hi',
    })).toEqual({ error: 'sessionId must contain only letters, numbers, dots, underscores, colons, and hyphens' });

    expect(normalizeHermesPersistTurnPayload({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      turnId: 'turn>1',
    })).toEqual({ error: 'turnId must contain only letters, numbers, dots, underscores, colons, and hyphens' });
  });

  it('rejects unknown Hermes persist-turn states', () => {
    expect(normalizeHermesPersistTurnPayload({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'hi',
      persistenceState: 'complete',
    })).toEqual({ error: 'Invalid "persistenceState"' });
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
        probeHermesHealth: async () => ({ ok: true, target: 'gateway' }),
      },
    );

    expect(result.integration.id).toBe('hermes');
    expect(result.integration.runtime.status).toBe('ready');
    expect(result.integration.runtime.ready).toBe(true);
    expect(result.integration.transport.kind).toBe('hermes-openai');
    expect(result.integration.capabilities.localChat).toBe(true);
    expect(result.integration.capabilities.chatAttachments).toBe(true);
    expect(result.integration.metadata.hermesHome).toBe('C:\\Hermes\\default');
    expect(result.integration.metadata.memoryMode).toBe('provider');
  });

  it('preserves explicit Hermes profile metadata from UI connect requests', async () => {
    const config = makeConfig();
    const result = await connectLocalAgentIntegrationFromUi(
      config,
      {
        id: 'hermes',
        metadata: {
          source: 'node-ui',
          profileName: 'research',
          hermesHome: 'C:\\Hermes\\research',
        },
      },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: true, target: 'gateway' }),
      },
    );

    expect(resolveHermesProfileMock).not.toHaveBeenCalled();
    expect(result.integration.metadata).toMatchObject({
      source: 'node-ui',
      profileName: 'research',
      hermesHome: 'C:\\Hermes\\research',
    });
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
    expect(integration.transport.healthUrl).toBeUndefined();
  });

  it('refresh drops same-origin gateway healthUrl values outside the Hermes gateway API base', async () => {
    const urls: string[] = [];
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            gatewayUrl: 'https://hermes.example.com',
            healthUrl: 'https://hermes.example.com/healthz',
          },
          runtime: { status: 'degraded', ready: false },
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const integration = await refreshLocalAgentIntegrationFromUi(config, 'hermes', 'bridge-token');

    expect(urls).toEqual(['https://hermes.example.com/api/hermes-channel/health']);
    expect(integration.runtime.status).toBe('ready');
    expect(integration.transport.gatewayUrl).toBe('https://hermes.example.com');
    expect(integration.transport.healthUrl).toBeUndefined();
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

  it('runs Hermes reverse setup from UI disconnect with stored profile metadata', async () => {
    const calls: Array<{ profileName?: string; hermesHome?: string }> = [];
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {
            profileName: 'research',
            hermesHome: 'C:\\Hermes\\research',
          },
        },
      },
    });

    await reverseHermesSetupForUi(config, {
      disconnectHermesProfile: (options) => {
        calls.push(options);
      },
    });

    expect(calls).toEqual([{
      profileName: 'research',
      hermesHome: 'C:\\Hermes\\research',
    }]);
  });

  it('fails closed instead of disconnecting the default Hermes profile without metadata', async () => {
    const disconnectHermesProfile = vi.fn();
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {},
        },
      },
    });

    await expect(reverseHermesSetupForUi(config, {
      disconnectHermesProfile,
    })).rejects.toThrow('Hermes profile metadata is missing');

    expect(disconnectHermesProfile).not.toHaveBeenCalled();
  });

  it('runs Hermes reverse setup before marking UI disconnect disconnected', async () => {
    const previousDkgHome = process.env.DKG_HOME;
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    process.env.DKG_HOME = dkgHome;
    disconnectHermesProfileMock.mockImplementation(() => undefined);
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {
            profileName: 'research',
            hermesHome: 'C:\\Hermes\\research',
          },
          runtime: { status: 'ready', ready: true },
        },
      },
    });
    const req = makeJsonRequest('PUT', '/api/local-agent-integrations/hermes', {
      enabled: false,
      runtime: { status: 'disconnected' },
    });
    const res = makeJsonResponse();

    try {
      await handleLocalAgentsRoutes({
        req,
        res,
        config,
        path: '/api/local-agent-integrations/hermes',
      } as any);
    } finally {
      if (previousDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = previousDkgHome;
      rmSync(dkgHome, { recursive: true, force: true });
    }

    expect(disconnectHermesProfileMock).toHaveBeenCalledWith({
      profileName: 'research',
      hermesHome: 'C:\\Hermes\\research',
    });
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.integration.enabled).toBe(false);
    expect(body.integration.runtime.status).toBe('disconnected');
    expect(config.localAgentIntegrations?.hermes?.enabled).toBe(false);
  });

  it('keeps Hermes chat attached and records an error when UI reverse setup fails', async () => {
    const previousDkgHome = process.env.DKG_HOME;
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    process.env.DKG_HOME = dkgHome;
    disconnectHermesProfileMock.mockImplementation(() => {
      throw new Error('profile locked');
    });
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {
            profileName: 'research',
            hermesHome: 'C:\\Hermes\\research',
          },
          runtime: { status: 'ready', ready: true },
        },
      },
    });
    const req = makeJsonRequest('PUT', '/api/local-agent-integrations/hermes', {
      enabled: false,
      runtime: { status: 'disconnected' },
    });
    const res = makeJsonResponse();

    try {
      await handleLocalAgentsRoutes({
        req,
        res,
        config,
        path: '/api/local-agent-integrations/hermes',
      } as any);
    } finally {
      if (previousDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = previousDkgHome;
      rmSync(dkgHome, { recursive: true, force: true });
    }

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.integration.enabled).toBe(true);
    expect(body.integration.runtime.status).toBe('error');
    expect(body.integration.runtime.ready).toBe(false);
    expect(body.integration.runtime.lastError).toContain('Hermes disconnect failed: profile locked');
    expect(body.integration.metadata.userDisabled).toBeUndefined();
    expect(config.localAgentIntegrations?.hermes?.enabled).toBe(true);
    expect(getHermesChannelTargets(config)).not.toEqual([]);
  });

  it('keeps Hermes chat attached when UI reverse setup cannot infer a profile', async () => {
    const previousDkgHome = process.env.DKG_HOME;
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    process.env.DKG_HOME = dkgHome;
    disconnectHermesProfileMock.mockImplementation(() => undefined);
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: {},
          runtime: { status: 'ready', ready: true },
        },
      },
    });
    const req = makeJsonRequest('PUT', '/api/local-agent-integrations/hermes', {
      enabled: false,
      runtime: { status: 'disconnected' },
    });
    const res = makeJsonResponse();

    try {
      await handleLocalAgentsRoutes({
        req,
        res,
        config,
        path: '/api/local-agent-integrations/hermes',
      } as any);
    } finally {
      if (previousDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = previousDkgHome;
      rmSync(dkgHome, { recursive: true, force: true });
    }

    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(disconnectHermesProfileMock).not.toHaveBeenCalled();
    expect(body.integration.enabled).toBe(true);
    expect(body.integration.runtime.status).toBe('error');
    expect(body.integration.runtime.ready).toBe(false);
    expect(body.integration.runtime.lastError).toContain('Hermes profile metadata is missing');
    expect(body.integration.metadata.userDisabled).toBeUndefined();
    expect(config.localAgentIntegrations?.hermes?.enabled).toBe(true);
    expect(getHermesChannelTargets(config)).not.toEqual([]);
  });

  it('Hermes definition includes manifest, transport, and local chat capabilities', () => {
    const integration = getLocalAgentIntegration(makeConfig(), 'hermes');
    expect(integration?.transport.kind).toBe('hermes-openai');
    expect(integration?.manifest?.packageName).toBe('@origintrail-official/dkg-adapter-hermes');
    expect(integration?.manifest?.setupEntry).toBe('./setup-entry.mjs');
    expect(integration?.capabilities.localChat).toBe(true);
    expect(integration?.capabilities.chatAttachments).toBe(true);
  });

  it('merges partial Hermes transport patches without dropping sibling endpoints', () => {
    const merged = mergeLocalAgentIntegrationConfig({
      enabled: true,
      transport: {
        kind: 'hermes-channel',
        bridgeUrl: 'http://127.0.0.1:9444',
        gatewayUrl: 'https://hermes.example.com',
      },
    } as any, {
      transport: {
        healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
      },
    } as any, { mergeTransport: true });

    expect(merged.transport).toEqual({
      kind: 'hermes-channel',
      bridgeUrl: 'http://127.0.0.1:9444',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
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

  it('forwards the documented contextGraphId to Hermes send', async () => {
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
    });
  });

  it('forwards the documented contextGraphId to Hermes stream', async () => {
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
    });
  });

  it('adapts Node UI send requests to the Hermes OpenAI-compatible API server', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const storeChatExchange = vi.fn(async () => {});
    const uiSessionId = 'hermes:dkg-ui:profile-default';
    const expectedTurnId = buildStableHermesTurnId({
      sessionId: uiSessionId,
      correlationId: 'corr-openai',
      profile: 'default',
      contextGraphId: 'project-1',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hermes API reply' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-hermes-session-id': 'api-session-1' },
      });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-openai',
      sessionId: uiSessionId,
      contextGraphId: 'project-1',
      profile: 'default',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-openai',
            gatewayUrl: 'http://127.0.0.1:8642',
          },
        },
      },
    }, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      text: 'Hermes API reply',
      correlationId: 'corr-openai',
      sessionId: uiSessionId,
      turnId: expectedTurnId,
    });
    expect(storeChatExchange).toHaveBeenCalledWith(
      uiSessionId,
      'hello',
      'Hermes API reply',
      undefined,
      expect.objectContaining({
        turnId: expectedTurnId,
        persistenceState: 'stored',
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8642/v1/chat/completions');
    expect(calls[0].body).toMatchObject({
      model: 'hermes-agent',
      stream: false,
      messages: [
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Current DKG context graph id: project-1'),
        }),
        { role: 'user', content: 'hello' },
      ],
    });
  });

  it('converts Hermes OpenAI-compatible SSE chunks for Node UI streaming', async () => {
    const encoder = new TextEncoder();
    const storeChatExchange = vi.fn(async () => {});
    const uiSessionId = 'hermes:dkg-ui:profile-default';
    const expectedTurnId = buildStableHermesTurnId({
      sessionId: uiSessionId,
      correlationId: 'corr-stream',
      contextGraphId: 'project-1',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8642/v1/chat/completions');
      expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n'));
          controller.enqueue(encoder.encode('event: hermes.tool.progress\r\ndata: {"name":"dkg_status"}\r\n\r\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-hermes-session-id': 'api-session-2' },
      });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-stream',
      sessionId: uiSessionId,
      contextGraphId: 'project-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-openai',
            gatewayUrl: 'http://127.0.0.1:8642',
          },
        },
      },
    }, '/api/hermes-channel/stream');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(res.body).toContain('"type":"delta","text":"Hel"');
    expect(res.body).toContain('"type":"delta","text":"lo"');
    expect(res.body).toContain('"type":"final","text":"Hello"');
    expect(res.body).toContain(`"sessionId":"${uiSessionId}"`);
    expect(res.body).toContain(`"turnId":"${expectedTurnId}"`);
    expect(storeChatExchange).toHaveBeenCalledWith(
      uiSessionId,
      'hello',
      'Hello',
      undefined,
      expect.objectContaining({
        turnId: expectedTurnId,
        persistenceState: 'stored',
      }),
    );
  });

  it('falls back to the gateway when bridge send returns retryable 5xx', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === 'http://127.0.0.1:9444/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9444/send') {
        return new Response('bridge failed', { status: 500 });
      }
      if (requestUrl === 'https://hermes.example.com/api/hermes-channel/send') {
        return new Response(JSON.stringify({ text: 'gateway reply', correlationId: 'corr-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected target', { status: 418 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
          },
        },
      },
    }, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ text: 'gateway reply', correlationId: 'corr-1' });
    expect(urls).toEqual([
      'http://127.0.0.1:9444/health',
      'http://127.0.0.1:9444/send',
      'https://hermes.example.com/api/hermes-channel/send',
    ]);
  });

  it('falls back to the gateway when bridge send times out', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === 'http://127.0.0.1:9444/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9444/send') {
        const err = new Error('timed out');
        (err as any).name = 'TimeoutError';
        throw err;
      }
      if (requestUrl === 'https://hermes.example.com/api/hermes-channel/send') {
        return new Response(JSON.stringify({ text: 'gateway reply', correlationId: 'corr-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected target', { status: 418 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
          },
        },
      },
    }, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ text: 'gateway reply', correlationId: 'corr-1' });
    expect(urls).toEqual([
      'http://127.0.0.1:9444/health',
      'http://127.0.0.1:9444/send',
      'https://hermes.example.com/api/hermes-channel/send',
    ]);
  });

  it('falls back to the gateway when bridge stream returns retryable 5xx', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === 'http://127.0.0.1:9444/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9444/stream') {
        return new Response('bridge failed', { status: 502 });
      }
      if (requestUrl === 'https://hermes.example.com/api/hermes-channel/stream') {
        return new Response(JSON.stringify({
          text: 'gateway stream',
          correlationId: 'corr-1',
          sessionId: 'bridge-session',
          turnId: 'bridge-turn',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected target', { status: 418 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
          },
        },
      },
    }, '/api/hermes-channel/stream');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(res.body).toContain('"text":"gateway stream"');
    expect(res.body).toContain('"sessionId":"bridge-session"');
    expect(res.body).toContain('"turnId":"bridge-turn"');
    expect(urls).toEqual([
      'http://127.0.0.1:9444/health',
      'http://127.0.0.1:9444/stream',
      'https://hermes.example.com/api/hermes-channel/stream',
    ]);
  });

  it('falls back to the gateway when bridge stream times out', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      if (requestUrl === 'http://127.0.0.1:9444/health') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (requestUrl === 'http://127.0.0.1:9444/stream') {
        const err = new Error('timed out');
        (err as any).name = 'TimeoutError';
        throw err;
      }
      if (requestUrl === 'https://hermes.example.com/api/hermes-channel/stream') {
        return new Response(JSON.stringify({
          text: 'gateway stream',
          correlationId: 'corr-1',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected target', { status: 418 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      correlationId: 'corr-1',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-channel',
            bridgeUrl: 'http://127.0.0.1:9444',
            gatewayUrl: 'https://hermes.example.com',
          },
        },
      },
    }, '/api/hermes-channel/stream');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(res.body).toContain('"text":"gateway stream"');
    expect(urls).toEqual([
      'http://127.0.0.1:9444/health',
      'http://127.0.0.1:9444/stream',
      'https://hermes.example.com/api/hermes-channel/stream',
    ]);
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

  it('deduplicates Hermes persist-turn retries by correlation id when turn id is omitted', async () => {
    let stored = false;
    const storeChatExchange = vi.fn(async () => {
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
      correlationId: 'corr-1',
    };
    const first = makeHermesRouteContext(payload, memoryManager);
    const second = makeHermesRouteContext(payload, memoryManager);
    first.ctx.agent.importMemories = importMemories;
    second.ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(first.ctx);
    await handleHermesRoutes(second.ctx);

    const expectedTurnId = buildStableHermesTurnId({
      sessionId: 'hermes:default',
      correlationId: 'corr-1',
    });
    expect(storeChatExchange).toHaveBeenCalledTimes(1);
    expect(importMemories).toHaveBeenCalledTimes(1);
    expect(JSON.parse(first.res.body)).toEqual({ ok: true, turnId: expectedTurnId });
    expect(JSON.parse(second.res.body)).toEqual({ ok: true, duplicate: true, turnId: expectedTurnId });
  });

  it('does not import Hermes assistant replies until the turn is durably stored', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const importMemories = vi.fn(async () => {});
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'partial reply',
      turnId: 'turn-1',
      persistenceState: 'pending',
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange,
    });
    ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, turnId: 'turn-1' });
    expect(storeChatExchange).toHaveBeenCalledWith(
      'hermes:default',
      'hello',
      'partial reply',
      undefined,
      expect.objectContaining({
        turnId: 'turn-1',
        persistenceState: 'pending',
      }),
    );
    expect(importMemories).not.toHaveBeenCalled();
  });

  it('treats a repeated Hermes turn id as an idempotent duplicate', async () => {
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      hasChatTurn: vi.fn(async () => true),
      getChatTurnPersistenceState: vi.fn(async () => 'stored'),
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
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledWith('hermes:default', 'turn-1');
    expect(memoryManager.hasChatTurn).not.toHaveBeenCalled();
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    expect(importMemories).not.toHaveBeenCalled();
  });

  it('allows stored Hermes retries to replace provisional turn state', async () => {
    const storeChatExchange = vi.fn(async () => {});
    const recordChatTurnPersistenceTransition = vi.fn(async () => {});
    const importMemories = vi.fn(async () => {});
    const attachmentRef = {
      id: 'att-1',
      fileName: 'notes.md',
      contextGraphId: 'project-1',
      assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
      fileHash: 'keccak256:abc123',
      extractionStatus: 'completed',
      tripleCount: 12,
    };
    const memoryManager = {
      hasChatTurn: vi.fn(async () => true),
      getChatTurnPersistenceState: vi.fn(async () => 'pending'),
      recordChatTurnPersistenceTransition,
      storeChatExchange,
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'final reply',
      turnId: 'turn-1',
      persistenceState: 'stored',
      toolCalls: [{ name: 'lookup', args: { query: 'hello' }, result: { ok: true } }],
      attachmentRefs: [attachmentRef],
    }, memoryManager);
    ctx.extractionStatus.set(attachmentRef.assertionUri, {
      status: 'completed',
      fileName: attachmentRef.fileName,
      fileHash: attachmentRef.fileHash,
      tripleCount: attachmentRef.tripleCount,
    });
    ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledWith('hermes:default', 'turn-1');
    expect(recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
      'hermes:default',
      'turn-1',
      'stored',
      expect.objectContaining({
        failureReason: null,
        assistantReply: 'final reply',
        toolCalls: [{ name: 'lookup', args: { query: 'hello' }, result: { ok: true } }],
        attachmentRefs: expect.arrayContaining([
          expect.objectContaining({
            assertionUri: attachmentRef.assertionUri,
            contextGraphId: attachmentRef.contextGraphId,
            fileName: attachmentRef.fileName,
            fileHash: attachmentRef.fileHash,
            tripleCount: attachmentRef.tripleCount,
          }),
        ]),
      }),
    );
    expect(storeChatExchange).not.toHaveBeenCalled();
    expect(importMemories).toHaveBeenCalledWith('final reply', 'hermes-session:hermes:default:turn:turn-1');
  });

  it('does not replay provisional Hermes retries through full chat persistence', async () => {
    const memoryManager = {
      hasChatTurn: vi.fn(async () => true),
      getChatTurnPersistenceState: vi.fn(async () => 'pending'),
      recordChatTurnPersistenceTransition: vi.fn(async () => {}),
      storeChatExchange: vi.fn(async () => {}),
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'still pending',
      turnId: 'turn-1',
      persistenceState: 'pending',
    }, memoryManager);

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
  });

  it('transitions failed Hermes retries to stored without appending chat messages', async () => {
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      hasChatTurn: vi.fn(async () => true),
      getChatTurnPersistenceState: vi.fn(async () => 'failed'),
      recordChatTurnPersistenceTransition: vi.fn(async () => {}),
      storeChatExchange: vi.fn(async () => {}),
    };
    const { ctx, res } = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'final reply',
      turnId: 'turn-1',
      persistenceState: 'stored',
    }, memoryManager);
    ctx.agent.importMemories = importMemories;

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
    expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
      'hermes:default',
      'turn-1',
      'stored',
      expect.objectContaining({
        failureReason: null,
        assistantReply: 'final reply',
      }),
    );
    expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    expect(importMemories).toHaveBeenCalledTimes(1);
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

  it('applies a concurrent stored retry after an in-flight provisional persist completes', async () => {
    let state: 'pending' | 'stored' | null = null;
    const storeStarted = deferred();
    const releaseStore = deferred();
    const storeChatExchange = vi.fn(async (_sessionId: string, _userMessage: string, _assistantReply: string, _toolCalls: unknown, opts: any) => {
      storeStarted.resolve();
      await releaseStore.promise;
      state = opts.persistenceState;
    });
    const recordChatTurnPersistenceTransition = vi.fn(async () => {
      state = 'stored';
    });
    const importMemories = vi.fn(async () => {});
    const memoryManager = {
      getChatTurnPersistenceState: vi.fn(async () => state),
      hasChatTurn: vi.fn(async () => state != null),
      recordChatTurnPersistenceTransition,
      storeChatExchange,
    };
    const first = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: '',
      turnId: 'turn-1',
      persistenceState: 'pending',
    }, memoryManager);
    const second = makeHermesRouteContext({
      sessionId: 'hermes:default',
      userMessage: 'hello',
      assistantReply: 'final reply',
      turnId: 'turn-1',
      persistenceState: 'stored',
    }, memoryManager);
    first.ctx.agent.importMemories = importMemories;
    second.ctx.agent.importMemories = importMemories;

    const firstRun = handleHermesRoutes(first.ctx);
    await storeStarted.promise;
    const secondRun = handleHermesRoutes(second.ctx);
    await Promise.resolve();
    expect(recordChatTurnPersistenceTransition).not.toHaveBeenCalled();

    releaseStore.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(storeChatExchange).toHaveBeenCalledTimes(1);
    expect(recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
      'hermes:default',
      'turn-1',
      'stored',
      expect.objectContaining({ assistantReply: 'final reply' }),
    );
    expect(importMemories).toHaveBeenCalledWith('final reply', 'hermes-session:hermes:default:turn:turn-1');
    expect(JSON.parse(first.res.body)).toEqual({ ok: true, turnId: 'turn-1' });
    expect(JSON.parse(second.res.body)).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
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

  it('persists when duplicate detection cannot query the turn id', async () => {
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

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'hermes:default',
      'hello',
      'hi',
      undefined,
      expect.objectContaining({ turnId: 'turn-1' }),
    );
  });

  it('probes Hermes bridge health with the bridge token header', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'x-dkg-bridge-token': 'bridge-token' });
      return new Response(JSON.stringify({ ok: true, channel: 'hermes' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await probeHermesChannelHealth(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' },
        },
      },
    }), 'bridge-token');

    expect(report.ok).toBe(true);
    expect(report.target).toBe('bridge');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9202/health',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-dkg-bridge-token': 'bridge-token' }) }),
    );
  });

  it('probes Hermes OpenAI-compatible API server health without bridge auth', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).not.toMatchObject({ 'x-dkg-bridge-token': 'bridge-token' });
      return new Response(JSON.stringify({ status: 'ok', platform: 'hermes-agent' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const report = await probeHermesChannelHealth(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: {
            kind: 'hermes-openai',
            gatewayUrl: 'http://127.0.0.1:8642',
          },
        },
      },
    }), 'bridge-token');

    expect(report.ok).toBe(true);
    expect(report.target).toBe('gateway');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8642/health',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('does not mark Hermes ready when health JSON reports ok false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'warming up',
    }), { status: 200 })));

    const report = await probeHermesChannelHealth(makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-channel', bridgeUrl: 'http://127.0.0.1:9202' },
        },
      },
    }), 'bridge-token');

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
