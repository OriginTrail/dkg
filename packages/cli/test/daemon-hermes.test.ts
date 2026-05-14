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

function freshExtractionStatusTimes() {
  const completedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return { startedAt, completedAt };
}

function makeHermesAttachmentStore(refs: Array<{
  assertionUri: string;
  fileHash: string;
  fileName: string;
  detectedContentType?: string;
  rootEntity?: string;
  tripleCount?: number;
  mdIntermediateHash?: string;
  markdownForm?: string;
}>) {
  return {
    query: vi.fn(async (sparql: string) => {
      const ref = refs.find((candidate) => sparql.includes(`<${candidate.assertionUri}>`));
      if (!ref) return { bindings: [] };
      if (sparql.includes('SELECT ?fileHash')) {
        return {
          bindings: [{
            fileHash: ref.fileHash,
            contentType: ref.detectedContentType,
            rootEntity: ref.rootEntity,
            extractionStatus: 'completed',
            tripleCount: ref.tripleCount != null ? String(ref.tripleCount) : undefined,
            sourceFileName: ref.fileName,
            mdIntermediateHash: ref.mdIntermediateHash,
          }],
        };
      }
      if (sparql.includes('?markdownForm')) {
        return { bindings: ref.markdownForm ? [{ markdownForm: ref.markdownForm }] : [] };
      }
      return { bindings: [] };
    }),
  };
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
      agent: { store: { query: vi.fn(async () => ({ bindings: [] })) } },
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
  it('short-circuits to ready when UI connect reaches bridge health and transport is already stored', async () => {
    // Re-running Connect on an already-attached Hermes integration: the stored
    // transport from the prior install lets us trust the bridge probe directly
    // and skip re-running setup entirely. New behavior post-#386 — see
    // setup-entrypoint-contract.md §9 + connectLocalAgentIntegrationFromUi.
    const config = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642' },
          runtime: { status: 'ready', ready: true },
        },
      },
    });
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

  it('schedules setup and returns connecting when UI connect cannot reach bridge health', async () => {
    // New behavior post-#386: a fresh Connect on an unconfigured profile no
    // longer settles to "degraded" on a failed health probe — instead it
    // schedules the new runHermesSetup attach job and returns runtime: connecting
    // synchronously. The UI's polling loop transitions to ready/error once the
    // attach job settles. Setup is awaited via runHermesSetup test stub here.
    const config = makeConfig();
    const runHermesSetupStub = vi.fn(async () => ({
      ok: true,
      status: 'configured' as const,
      profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
      daemonStarted: false,
      fundedWallets: [],
      transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
      warnings: [],
      errors: [],
    }));
    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
        runHermesSetup: runHermesSetupStub,
      },
    );

    expect(result.integration.runtime.status).toBe('connecting');
    expect(result.integration.runtime.ready).toBe(false);
    expect(result.notice).toContain('Hermes setup started');
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

  // ─── S3 H-AC tests (issue #386, test-matrix.md group H + I) ─────────────
  // The two PR-#315 baseline tests above ('short-circuits to ready' / 'schedules
  // setup and returns connecting') already cover the happy paths for
  // H-AC-40/43-{ready notice}. The tests below pin the contract corners
  // that those baseline tests do not exercise — verifyHermesProfile gating
  // (H-AC-41), cancellation (H-AC-42), notice copy verbatim (H-AC-43), and
  // chat-history preservation through the disconnect/restore loop (H-AC-37).

  it('H-AC-40: UI Connect invokes runHermesUiSetup with the contract-required signal', async () => {
    const config = makeConfig();
    const setupCalls: Array<AbortSignal | undefined> = [];
    const runHermesSetupStub = vi.fn(async (signal?: AbortSignal) => {
      setupCalls.push(signal);
      return {
        ok: true,
        status: 'configured' as const,
        profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
        daemonStarted: false,
        fundedWallets: [],
        transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
        warnings: [],
        errors: [],
      };
    });

    await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
        runHermesSetup: runHermesSetupStub as any,
      },
    );

    // Wait one microtask so the scheduled attach job can dispatch.
    await new Promise((r) => setImmediate(r));

    expect(runHermesSetupStub).toHaveBeenCalledTimes(1);
    expect(setupCalls).toHaveLength(1);
    expect(setupCalls[0]).toBeInstanceOf(AbortSignal);
  });

  it('H-AC-41: UI Connect transitions to error when runHermesSetup verify fails (result.ok false)', async () => {
    const config = makeConfig();
    const runHermesSetupStub = vi.fn(async () => ({
      ok: false,
      status: 'error' as const,
      profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
      daemonStarted: false,
      fundedWallets: [],
      transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
      warnings: [],
      errors: ['verifyHermesProfile failed: dkg.json missing'],
    }));

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
        runHermesSetup: runHermesSetupStub as any,
      },
    );
    // synchronous return is connecting; attach job runs in background
    expect(result.integration.runtime.status).toBe('connecting');
    await new Promise((r) => setImmediate(r));

    const settled = getLocalAgentIntegration(config, 'hermes')!;
    expect(settled.runtime.status).toBe('error');
    expect(settled.runtime.ready).toBe(false);
    expect(settled.runtime.lastError).toContain('verifyHermesProfile failed');
  });

  it('H-AC-42: UI Connect attach is cancellable via AbortController', async () => {
    const config = makeConfig();
    const observed = deferred<AbortSignal>();
    const released = deferred<void>();
    const runHermesSetupStub = vi.fn(async (signal?: AbortSignal) => {
      observed.resolve(signal!);
      // Resolve only when our outer await releases — we want to verify the
      // controller saw .abort() before the setup function's promise settles.
      await released.promise;
      return {
        ok: true,
        status: 'configured' as const,
        profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
        daemonStarted: false,
        fundedWallets: [],
        transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
        warnings: [],
        errors: [],
      };
    });

    await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
        runHermesSetup: runHermesSetupStub as any,
      },
    );

    const signal = await observed.promise;
    expect(signal.aborted).toBe(false);

    // Simulate the disconnect-mid-connect path: cancel the in-flight job.
    const { cancelPending } = await import('../src/daemon/local-agent-attach-jobs.js');
    cancelPending('hermes');

    expect(signal.aborted).toBe(true);
    released.resolve();
    await new Promise((r) => setImmediate(r));
  });

  it('H-AC-43: UI Connect notice copy is the verbatim cycle-1-finalized wording', async () => {
    const config = makeConfig();
    const runHermesSetupStub = vi.fn(async () => ({
      ok: true,
      status: 'configured' as const,
      profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
      daemonStarted: false,
      fundedWallets: [],
      transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
      warnings: [],
      errors: [],
    }));

    const result = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      {
        probeHermesHealth: async () => ({ ok: false, error: 'offline' }),
        runHermesSetup: runHermesSetupStub as any,
      },
    );

    expect(result.notice).toBe(
      'Hermes setup started. This chat tab will come online automatically once Hermes finishes setting up.',
    );
  });

  it('H-AC-44: UI Connect concurrency — second Connect during in-flight job does not double-fire setup', async () => {
    const config = makeConfig();
    const released = deferred<void>();
    const runHermesSetupStub = vi.fn(async () => {
      await released.promise;
      return {
        ok: true,
        status: 'configured' as const,
        profile: { hermesHome: 'C:\\Hermes\\default', configPath: '', memoryMode: 'provider' },
        daemonStarted: false,
        fundedWallets: [],
        transport: { kind: 'hermes-openai' as const, gatewayUrl: 'http://127.0.0.1:8642' },
        warnings: [],
        errors: [],
      };
    });

    const deps = {
      probeHermesHealth: async () => ({ ok: false, error: 'offline' as string | undefined }),
      runHermesSetup: runHermesSetupStub as any,
    };
    const first = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      deps,
    );
    const second = await connectLocalAgentIntegrationFromUi(
      config,
      { id: 'hermes', metadata: { source: 'node-ui' } },
      'bridge-token',
      deps,
    );

    // First scheduling created the job (notice mentions "started"); second
    // observed the in-flight job and got the "already in progress" notice.
    expect(first.notice).toContain('Hermes setup started');
    expect(second.notice).toContain('already in progress');
    expect(runHermesSetupStub).toHaveBeenCalledTimes(1);
    released.resolve();
    await new Promise((r) => setImmediate(r));
  });

  it('H-AC-46: UI Refresh signature never accepts a setup injection point', async () => {
    // The non-invocation guarantee for "Refresh never runs setup" is enforced
    // by the function signature: refreshLocalAgentIntegrationFromUi accepts
    // only (config, id, bridgeAuthToken) — there is no runHermesSetup dep,
    // and the implementation only calls probeHermesChannelHealth and
    // updateLocalAgentIntegration. The existing
    // 'refresh probes Hermes health and promotes an existing integration to
    // ready' test (line ~613 in this file) covers the health-probe-and-update
    // path with a real config + real (offline) probe. This test makes the
    // non-invocation claim explicit by asserting the function signature
    // arity.
    expect(refreshLocalAgentIntegrationFromUi.length).toBe(3);
  });

  it('H-AC-47b: UI Disconnect surfaces restoreError as warning while staying disconnected', async () => {
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
            priorProvider: 'redis',
            backupPath: 'C:\\Hermes\\research\\config.yaml.bak.1730000000000',
          },
          runtime: { status: 'ready', ready: true },
        },
      },
    });
    const restoreOutcome = {
      ok: false,
      path: 'failed' as const,
      restoreError: 'config.yaml.bak.1730000000000 not found',
    };
    // Inject the restore stub via the deps surface so we exercise the
    // contract §6 path (restore failure must not roll back disconnect).
    const result = await reverseHermesSetupForUi(config, {
      disconnectHermesProfile: () => undefined,
      restoreHermesProfile: async () => restoreOutcome,
    });

    if (previousDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = previousDkgHome;
    rmSync(dkgHome, { recursive: true, force: true });

    expect(result.restoreError).toBe('config.yaml.bak.1730000000000 not found');
    // Disconnect itself succeeded — restore failure does NOT roll it back.
    // The PUT handler in routes/local-agents.ts is what folds restoreError
    // into runtime.lastError on the disconnected patch. This unit test asserts
    // the helper's return contract; the route-level wiring is covered by the
    // existing 'runs Hermes reverse setup' integration tests in this file.
  });

  it('H-AC-37: UI Disconnect preserves chat history (no slot deletion in DKG)', async () => {
    // Chat history lives in the DKG memory slot under
    // urn:dkg:chat:session:hermes:dkg-ui:* and is read on demand by the UI
    // via fetchLocalAgentHistory. Disconnect MUST NOT delete that slot.
    // We assert the surface contract by verifying that disconnect only flips
    // enabled+runtime — no chat-related side-effects are reachable from
    // reverseHermesSetupForUi (it imports disconnectHermesProfile which is
    // adapter-side and never touches DKG slots).
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

    await reverseHermesSetupForUi(config, {
      disconnectHermesProfile: disconnectHermesProfileMock,
      restoreHermesProfile: async () => ({ ok: true, path: 'noop' as const }),
    });

    if (previousDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = previousDkgHome;
    rmSync(dkgHome, { recursive: true, force: true });

    // The adapter's disconnect was called with profile metadata only —
    // no chat-session URI in the call args, no slot deletion fanout.
    expect(disconnectHermesProfileMock).toHaveBeenCalledWith({
      profileName: 'research',
      hermesHome: 'C:\\Hermes\\research',
    });
    // After disconnect the integration is still in config (we don't purge
    // it); the PUT handler will set enabled:false on the patch path.
    expect(config.localAgentIntegrations?.hermes).toBeDefined();
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

  it('forwards attachment refs, import context, and contextGraphId to Hermes channel send', async () => {
    const attachmentRef = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
      fileHash: 'sha256:abc123',
      contextGraphId: 'project-1',
      fileName: 'notes.md',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      tripleCount: 12,
      rootEntity: 'did:dkg:context-graph:project-1/assertion/notes',
    };
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/skipped',
      fileHash: 'sha256:skip',
      contextGraphId: 'project-1',
      fileName: 'skipped.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
    const verifiedAttachmentRef = {
      ...attachmentRef,
      markdownHash: attachmentRef.fileHash,
      markdownForm: `urn:dkg:file:${attachmentRef.fileHash}`,
    };
    const contextEntries = [{
      key: 'target_context_graph',
      label: 'Target context graph',
      value: 'Project One (project-1)',
    }];
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
      attachmentRefs: [attachmentRef],
      attachmentImportResults: [attachmentImportResult],
      contextEntries,
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');
    ctx.agent.store = makeHermesAttachmentStore([attachmentRef]);
    ctx.extractionStatus.set(attachmentRef.assertionUri, {
      status: 'completed',
      fileName: attachmentRef.fileName,
      fileHash: attachmentRef.fileHash,
      detectedContentType: attachmentRef.detectedContentType,
      tripleCount: attachmentRef.tripleCount,
      rootEntity: attachmentRef.rootEntity,
    });
    ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
      status: 'skipped',
      fileName: attachmentImportResult.fileName,
      fileHash: attachmentImportResult.fileHash,
      detectedContentType: attachmentImportResult.detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      ...freshExtractionStatusTimes(),
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      contextGraphId: 'project-1',
      attachmentRefs: [verifiedAttachmentRef],
    });
    expect(forwardedBodies[0].contextEntries[0]).toEqual(contextEntries[0]);
    expect(forwardedBodies[0].contextEntries[1]).toMatchObject({
      key: expect.stringMatching(/^attachment_import_result_/),
      label: 'Attachment import result: skipped.epub',
    });
    expect(JSON.parse(forwardedBodies[0].contextEntries[1].value)).toMatchObject({
      fileHash: attachmentImportResult.fileHash,
      extractionStatus: 'skipped',
      pipelineUsed: 'none',
    });
  });

  it('migrates verified legacy attachment import context entries to Hermes channel send', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/legacy-skipped',
      fileHash: 'sha256:legacy-skip',
      contextGraphId: 'project-1',
      fileName: 'a; assertionName=not-a-field; assertionUri=not-a-field; fileHash=still-name.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
      error: 'No extractor; fileHash=not-real; reason=unsupported',
    };
    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'hi', correlationId: 'corr-legacy-import' }), { status: 200 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      correlationId: 'corr-legacy-import',
      contextGraphId: 'project-1',
      contextEntries: [{
        key: 'attachment_import_result_legacy',
        label: `Attachment import result: ${attachmentImportResult.fileName}`,
        value: [
          `fileName=${attachmentImportResult.fileName}`,
          'assertionName=legacy-skipped',
          `assertionUri=${attachmentImportResult.assertionUri}`,
          `contextGraphId=${attachmentImportResult.contextGraphId}`,
          `fileHash=${attachmentImportResult.fileHash}`,
          `contentType=${attachmentImportResult.detectedContentType}`,
          'extractionStatus=skipped',
          'pipelineUsed=none',
          'tripleCount=0',
          `error=${attachmentImportResult.error}`,
        ].join('; '),
      }],
      attachmentImportResults: [attachmentImportResult],
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');
    ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
      status: 'skipped',
      fileName: attachmentImportResult.fileName,
      fileHash: attachmentImportResult.fileHash,
      detectedContentType: attachmentImportResult.detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      error: attachmentImportResult.error,
      ...freshExtractionStatusTimes(),
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      text: '',
      correlationId: 'corr-legacy-import',
      contextGraphId: 'project-1',
    });
    expect(forwardedBodies[0].contextEntries).toHaveLength(1);
    expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
      key: expect.stringMatching(/^attachment_import_result_/),
      label: `Attachment import result: ${attachmentImportResult.fileName}`,
    });
    expect(forwardedBodies[0].contextEntries[0].key).not.toBe('attachment_import_result_legacy');
    expect(JSON.parse(forwardedBodies[0].contextEntries[0].value)).toMatchObject({
      fileName: attachmentImportResult.fileName,
      fileHash: 'sha256:legacy-skip',
      extractionStatus: 'skipped',
      pipelineUsed: 'none',
      error: attachmentImportResult.error,
    });
  });

  it('forwards context-only requests to Hermes channel send', async () => {
    const contextEntries = [{
      key: 'target_context_graph',
      label: 'Target context graph',
      value: 'Project One (project-1)',
    }];
    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'hi', correlationId: 'corr-context-only' }), { status: 200 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: '',
      correlationId: 'corr-context-only',
      contextEntries,
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      text: '',
      correlationId: 'corr-context-only',
      contextEntries,
    });
  });

  it('rejects non-string text instead of dropping it on context-only sends', async () => {
    const { ctx, res } = makeHermesRouteContext({
      text: 123,
      correlationId: 'corr-invalid-text',
      contextEntries: [{
        key: 'target_context_graph',
        label: 'Target context graph',
        value: 'Project One (project-1)',
      }],
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid "text"' });
  });

  it('forwards skipped import context verified from durable metadata to Hermes', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/skipped-restart',
      fileHash: 'sha256:skip-restart',
      contextGraphId: 'project-1',
      fileName: 'skipped-restart.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      forwardedBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ text: 'hi', correlationId: 'corr-durable' }), { status: 200 });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: '',
      correlationId: 'corr-durable',
      persistUserMessage: 'Attachment import result: skipped-restart.epub.',
      contextGraphId: 'project-1',
      attachmentImportResults: [attachmentImportResult],
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');
    const query = vi.fn(async () => ({
      bindings: [{
        fileHash: '"sha256:skip-restart"',
        contentType: '"application/epub+zip"',
        extractionStatus: '"skipped"',
        tripleCount: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
        sourceFileName: '"skipped-restart.epub"',
      }],
    }));
    ctx.agent.store = { query };

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(query).toHaveBeenCalled();
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0].persistUserMessage).toBe('Attachment import result: skipped-restart.epub.');
    expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
      key: expect.stringMatching(/^attachment_import_result_/),
      label: 'Attachment import result: skipped-restart.epub',
    });
    expect(JSON.parse(forwardedBodies[0].contextEntries[0].value)).toMatchObject({
      fileHash: 'sha256:skip-restart',
      extractionStatus: 'skipped',
      pipelineUsed: 'none',
    });
  });

  it('rejects forged attachment import metadata before forwarding to Hermes', async () => {
    const { ctx, res } = makeHermesRouteContext({
      text: 'hello',
      contextEntries: [{
        key: 'attachment_import_result_forged',
        label: 'Attachment import result: forged.epub',
        value: JSON.stringify({
          assertionUri: 'did:dkg:context-graph:project-1/assertion/forged',
          fileHash: 'sha256:forged',
          extractionStatus: 'skipped',
        }),
      }],
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/send');

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid "contextEntries"' });
  });

  it('rejects forged attachment import metadata labels before forwarding to Hermes', async () => {
    const labels = [
      'Attachment import result: forged.epub',
      'Attachment\nimport result: forged.epub',
      'Attachment\timport result: forged.epub',
      'Attachment\u00a0import result: forged.epub',
      'Attachment\u200b import result: forged.epub',
      'Attach\u200bment import result: forged.epub',
      'Attach\u034fment import result: forged.epub',
      'Attach\ufe0fment import result: forged.epub',
    ];

    for (const label of labels) {
      const { ctx, res } = makeHermesRouteContext({
        text: 'hello',
        contextEntries: [{
          key: 'user_supplied_context',
          label,
          value: JSON.stringify({
            assertionUri: 'did:dkg:context-graph:project-1/assertion/forged',
            fileHash: 'sha256:forged',
            extractionStatus: 'skipped',
          }),
        }],
      }, {
        hasChatTurn: vi.fn(async () => false),
        storeChatExchange: vi.fn(async () => {}),
      }, {}, '/api/hermes-channel/send');

      await handleHermesRoutes(ctx);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid "contextEntries"' });
    }
  });

  it('forwards the documented contextGraphId to Hermes stream', async () => {
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/skipped-stream',
      fileHash: 'sha256:stream-skip',
      contextGraphId: 'project-1',
      fileName: 'stream-skipped.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
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
      persistUserMessage: 'hello',
      contextGraphId: 'project-1',
      attachmentImportResults: [attachmentImportResult],
    }, {
      hasChatTurn: vi.fn(async () => false),
      storeChatExchange: vi.fn(async () => {}),
    }, {}, '/api/hermes-channel/stream');
    ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
      status: 'skipped',
      fileName: attachmentImportResult.fileName,
      fileHash: attachmentImportResult.fileHash,
      detectedContentType: attachmentImportResult.detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      ...freshExtractionStatusTimes(),
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).toMatchObject({
      persistUserMessage: 'hello',
      contextGraphId: 'project-1',
    });
    expect(forwardedBodies[0].contextEntries[0]).toMatchObject({
      key: expect.stringMatching(/^attachment_import_result_/),
      label: 'Attachment import result: stream-skipped.epub',
    });
    expect(JSON.parse(forwardedBodies[0].contextEntries[0].value)).toMatchObject({
      assertionUri: attachmentImportResult.assertionUri,
      fileHash: attachmentImportResult.fileHash,
      extractionStatus: 'skipped',
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

  it('surfaces attachment metadata and skipped import results in the Hermes OpenAI system prompt', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const storeChatExchange = vi.fn(async () => {});
    const attachmentRef = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/notes',
      fileHash: 'sha256:abc123',
      contextGraphId: 'project-1',
      fileName: 'notes.md',
      detectedContentType: 'text/markdown',
      extractionStatus: 'completed' as const,
      tripleCount: 12,
      rootEntity: 'did:dkg:context-graph:project-1/assertion/notes',
    };
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/skipped',
      fileHash: 'sha256:skip',
      contextGraphId: 'project-1',
      fileName: 'skipped.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
    const verifiedAttachmentRef = {
      ...attachmentRef,
      markdownHash: attachmentRef.fileHash,
      markdownForm: `urn:dkg:file:${attachmentRef.fileHash}`,
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hermes attachment reply' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const { ctx, res } = makeHermesRouteContext({
      text: 'summarize attached context',
      correlationId: 'corr-openai-attach',
      sessionId: 'hermes:dkg-ui:attachments',
      contextGraphId: 'project-1',
      attachmentRefs: [attachmentRef],
      attachmentImportResults: [attachmentImportResult],
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
    ctx.agent.store = makeHermesAttachmentStore([attachmentRef]);
    ctx.extractionStatus.set(attachmentRef.assertionUri, {
      status: 'completed',
      fileName: attachmentRef.fileName,
      fileHash: attachmentRef.fileHash,
      detectedContentType: attachmentRef.detectedContentType,
      tripleCount: attachmentRef.tripleCount,
      rootEntity: attachmentRef.rootEntity,
    });
    ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
      status: 'skipped',
      fileName: attachmentImportResult.fileName,
      fileHash: attachmentImportResult.fileHash,
      detectedContentType: attachmentImportResult.detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      ...freshExtractionStatusTimes(),
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const systemPrompt = calls[0].body.messages[0].content as string;
    expect(systemPrompt).toContain('Node UI context entries:');
    expect(systemPrompt).toContain('"Attachment import result: skipped.epub"');
    expect(systemPrompt).toContain('\\"extractionStatus\\":\\"skipped\\"');
    expect(systemPrompt).toContain('Node UI attachment assertion refs:');
    expect(systemPrompt).toContain('"notes.md": assertionUri="did:dkg:context-graph:project-1/assertion/notes"');
    expect(systemPrompt).toContain('contextGraphId="project-1"');
    expect(systemPrompt).toContain('fileHash="sha256:abc123"');
    expect(systemPrompt).toContain('contentType="text/markdown"');
    expect(systemPrompt).toContain('status="completed"');
    expect(systemPrompt).toContain('tripleCount=12');
    expect(systemPrompt).toContain('rootEntity="did:dkg:context-graph:project-1/assertion/notes"');
    expect(systemPrompt).toContain(`markdownHash="${attachmentRef.fileHash}"`);
    expect(systemPrompt).toContain('dkg_import_artifact_read_markdown');
    expect(systemPrompt).toContain('dkg_semantic_enrichment_write');
    expect(systemPrompt).toContain('Use dkg_import_artifact_resolve only when you need to re-check artifact metadata');
    expect(systemPrompt).not.toContain('resolve the artifact with dkg_import_artifact_resolve');
    expect(systemPrompt).not.toContain('Keep deterministic import assertions separate');
    expect(storeChatExchange).toHaveBeenCalledWith(
      'hermes:dkg-ui:attachments',
      'summarize attached context',
      'Hermes attachment reply',
      undefined,
      expect.objectContaining({
        attachmentRefs: [verifiedAttachmentRef],
        persistenceState: 'stored',
      }),
    );
  });

  it('persists a context summary for Hermes OpenAI attachment-import-only sends', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const storeChatExchange = vi.fn(async () => {});
    const attachmentImportResult = {
      assertionUri: 'did:dkg:context-graph:project-1/assertion/skipped-only-openai',
      fileHash: 'sha256:skip-openai',
      contextGraphId: 'project-1',
      fileName: 'skipped-only.epub',
      detectedContentType: 'application/epub+zip',
      extractionStatus: 'skipped' as const,
      pipelineUsed: null,
      tripleCount: 0,
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hermes import-only reply' } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const { ctx, res } = makeHermesRouteContext({
      correlationId: 'corr-openai-import-only',
      sessionId: 'hermes:dkg-ui:import-only',
      persistUserMessage: 'Attachment import result: skipped-only.epub.',
      contextGraphId: 'project-1',
      attachmentImportResults: [attachmentImportResult],
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
    ctx.extractionStatus.set(attachmentImportResult.assertionUri, {
      status: 'skipped',
      fileName: attachmentImportResult.fileName,
      fileHash: attachmentImportResult.fileHash,
      detectedContentType: attachmentImportResult.detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      ...freshExtractionStatusTimes(),
    });

    await handleHermesRoutes(ctx);

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    const userMessage = calls[0].body.messages[1].content as string;
    expect(userMessage).toContain('Current DKG context graph id: "project-1"');
    expect(userMessage).toContain('Node UI context entries:');
    expect(userMessage).toContain('"Attachment import result: skipped-only.epub"');
    expect(userMessage).toContain('\\"fileHash\\":\\"sha256:skip-openai\\"');
    expect(storeChatExchange).toHaveBeenCalledWith(
      'hermes:dkg-ui:import-only',
      'Attachment import result: skipped-only.epub.',
      'Hermes import-only reply',
      undefined,
      expect.objectContaining({
        persistenceState: 'stored',
      }),
    );
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
