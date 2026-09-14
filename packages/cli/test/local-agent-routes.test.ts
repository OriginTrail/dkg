import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DkgHomeFiles, type DkgConfig } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';
import {
  type LocalAgentUiAttachDeps,
  LOCAL_AGENT_INTEGRATION_DEFINITIONS,
  connectLocalAgentIntegrationFromUi,
  extractLocalAgentIntegrationPatch,
  getLocalAgentIntegration,
  refreshLocalAgentIntegrationFromUi,
  updateLocalAgentIntegration,
} from '../src/daemon/local-agents.js';
import { localAgentConnectorFor } from '../src/daemon/local-agent-connectors/index.js';
import { handleLocalAgentsRoutes } from '../src/daemon/routes/local-agents.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';

const disconnectHermesProfileMock = vi.hoisted(() => vi.fn());
const restoreHermesProfileMock = vi.hoisted(() => vi.fn());
const resolveHermesProfileMock = vi.hoisted(() => vi.fn<NonNullable<LocalAgentUiAttachDeps['resolveHermesProfile']>>(() => ({
  profileName: undefined,
  hermesHome: 'C:\\Hermes\\default',
  memoryMode: 'provider',
})));
vi.mock('@origintrail-official/dkg-adapter-hermes', () => ({
  disconnectHermesProfile: disconnectHermesProfileMock,
  restoreHermesProfile: restoreHermesProfileMock,
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

afterEach(() => {
  vi.unstubAllGlobals();
  disconnectHermesProfileMock.mockReset();
  restoreHermesProfileMock.mockReset();
  restoreHermesProfileMock.mockResolvedValue({ ok: true, path: 'noop' });
  resolveHermesProfileMock.mockReset();
  resolveHermesProfileMock.mockReturnValue({
    profileName: undefined,
    hermesHome: 'C:\\Hermes\\default',
    memoryMode: 'provider',
  });
});

describe('generic local-agent routes', () => {
  it('commits connector-owned disconnect warnings without route ID branches', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          metadata: { profileName: 'research', hermesHome: 'C:\\Hermes\\research' },
          runtime: { status: 'ready', ready: true },
        },
      },
    }));
    disconnectHermesProfileMock.mockResolvedValue(undefined);
    restoreHermesProfileMock.mockResolvedValue({
      ok: false,
      path: 'failed',
      restoreError: 'provider backup missing',
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
        configStore,
        path: '/api/local-agent-integrations/hermes',
      } as any);

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).integration).toMatchObject({
        enabled: false,
        runtime: {
          status: 'disconnected',
          ready: false,
          lastError: 'provider backup missing',
        },
      });
      expect(disconnectHermesProfileMock).toHaveBeenCalledWith({
        profileName: 'research',
        hermesHome: 'C:\\Hermes\\research',
      });
    } finally {
      await configStore.close();
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('rebases deferred route attach patches and lets a newer disconnect win', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig());
    let finishAttach!: (patch: Record<string, unknown>) => Promise<void>;
    const connectFromUi: typeof connectLocalAgentIntegrationFromUi = async (_config, body) => {
      return {
        ok: true,
        state: extractLocalAgentIntegrationPatch({
          ...body,
          capabilities: { localChat: true },
          runtime: { status: 'connecting', ready: false, lastError: null },
        }),
        notice: 'attach scheduled',
        afterCommit: (sink) => {
          finishAttach = sink.persist;
          return { notice: 'attach scheduled' };
        },
      };
    };
    const connect = async () => {
      const req = makeJsonRequest('POST', '/api/local-agent-integrations/connect', {
        id: 'custom-agent',
        metadata: { source: 'node-ui', operatorLabel: 'initial' },
      });
      const res = makeJsonResponse();
      await handleLocalAgentsRoutes({ req, res, configStore, path: '/api/local-agent-integrations/connect' } as any, {
        connectFromUi,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).integration)
        .toEqual(getLocalAgentIntegration(configStore.current, 'custom-agent'));
    };

    try {
      await connect();
      await configStore.update(current => {
        const next = structuredClone(current) as DkgConfig;
        updateLocalAgentIntegration(next, 'custom-agent', {
          capabilities: { chatAttachments: true },
          metadata: { operatorLabel: 'edited while attaching' },
        });
        return next;
      }, 'configuration-only');
      await finishAttach({
        transport: { kind: 'custom-bridge', bridgeUrl: 'http://127.0.0.1:9444' },
        metadata: { setupAudit: 'complete' },
        runtime: { status: 'ready', ready: true, lastError: null },
      });
      expect(configStore.current.localAgentIntegrations?.['custom-agent']).toMatchObject({
        capabilities: { localChat: true, chatAttachments: true },
        metadata: { source: 'node-ui', operatorLabel: 'edited while attaching', setupAudit: 'complete' },
        runtime: { status: 'ready', ready: true },
      });

      await connect();
      const disconnectReq = makeJsonRequest('PUT', '/api/local-agent-integrations/custom-agent', {
        enabled: false,
        runtime: { status: 'disconnected' },
      });
      const disconnectRes = makeJsonResponse();
      await handleLocalAgentsRoutes({
        req: disconnectReq,
        res: disconnectRes,
        configStore,
        path: '/api/local-agent-integrations/custom-agent',
      } as any);
      await finishAttach({ runtime: { status: 'ready', ready: true, lastError: null } });

      expect(disconnectRes.statusCode).toBe(200);
      expect(JSON.parse(disconnectRes.body).integration)
        .toEqual(getLocalAgentIntegration(configStore.current, 'custom-agent'));
      expect(configStore.current.localAgentIntegrations?.['custom-agent']).toMatchObject({
        enabled: false,
        metadata: { userDisabled: true },
        runtime: { status: 'disconnected', ready: false },
      });
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')))
        .toEqual(configStore.current);
    } finally {
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('commits an explicit failed attach state before reporting the route error', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig());
    const req = makeJsonRequest('POST', '/api/local-agent-integrations/connect', {
      id: 'hermes',
      metadata: { source: 'node-ui' },
    });
    const res = makeJsonResponse();
    try {
      await handleLocalAgentsRoutes({
        req,
        res,
        configStore,
        path: '/api/local-agent-integrations/connect',
      } as any, {
        connectFromUi: (candidate, body, token) => connectLocalAgentIntegrationFromUi(candidate, body, token, {
          probeHermesHealth: async () => { throw new Error('setup probe failed'); },
        }),
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'setup probe failed' });
      expect(configStore.current.localAgentIntegrations?.hermes?.runtime)
        .toMatchObject({ status: 'error', ready: false, lastError: 'setup probe failed' });
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')))
        .toEqual(configStore.current);
    } finally {
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('commits the registration and connector state as one patch through one reducer', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig());
    const req = makeJsonRequest('POST', '/api/local-agent-integrations/connect', {
      id: 'custom-agent',
      name: 'Custom Agent',
      transport: { kind: 'custom-bridge', bridgeUrl: 'http://127.0.0.1:9444/' },
      capabilities: { localChat: true },
      metadata: { source: 'node-ui', operatorLabel: 'initial' },
    });
    const res = makeJsonResponse();
    try {
      await handleLocalAgentsRoutes({ req, res, configStore, path: '/api/local-agent-integrations/connect' } as any);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.notice)
        .toBe('Custom Agent was registered. Chat will appear here once its framework bridge is available.');
      expect(body.integration).toEqual(getLocalAgentIntegration(configStore.current, 'custom-agent'));
      // The registration's own transport is part of the single committed state;
      // no second, transport-less patch replays over it.
      expect(configStore.current.localAgentIntegrations?.['custom-agent']).toMatchObject({
        enabled: true,
        name: 'Custom Agent',
        transport: { kind: 'custom-bridge', bridgeUrl: 'http://127.0.0.1:9444' },
        capabilities: { localChat: true },
        metadata: { source: 'node-ui', operatorLabel: 'initial' },
        runtime: { status: 'connecting', ready: false, lastError: null },
      });
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8'))).toEqual(configStore.current);
    } finally {
      await configStore.close();
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it.each(['connect', 'refresh', 'failed-connect'] as const)('keeps a newer explicit disconnect after blocked %s preparation', async operation => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig({
      localAgentIntegrations: { hermes: { enabled: true, runtime: { status: 'ready', ready: true } } },
    }));
    const entered = deferred();
    const released = deferred();
    const patch = { runtime: { status: 'ready' as const, ready: true, lastError: null } };
    const path = operation === 'refresh'
      ? '/api/local-agent-integrations/hermes/refresh' : '/api/local-agent-integrations/connect';
    const req = makeJsonRequest('POST', path, { id: 'hermes', metadata: { source: 'node-ui' } });
    const res = makeJsonResponse();
    const running = handleLocalAgentsRoutes({ req, res, configStore, path } as any, {
      connectFromUi: async (_config, body) => {
        entered.resolve();
        await released.promise;
        const registration = extractLocalAgentIntegrationPatch(body);
        if (operation === 'failed-connect') return {
          ok: false,
          state: { ...registration, runtime: { status: 'error', ready: false, lastError: 'probe failed' } },
          error: 'probe failed',
        };
        return { ok: true, state: { ...registration, ...patch } };
      },
      refreshFromUi: async () => {
        entered.resolve();
        await released.promise;
        return { patch };
      },
    });
    try {
      await entered.promise;
      await configStore.update(current => {
        const next = structuredClone(current) as DkgConfig;
        updateLocalAgentIntegration(next, 'hermes', { enabled: false, runtime: { status: 'disconnected' } });
        return next;
      }, 'configuration-only');
      released.resolve();
      await running;
      expect(res.statusCode).toBe(operation === 'refresh' ? 200 : 409);
      if (operation !== 'refresh') {
        expect(JSON.parse(res.body)).toMatchObject({
          ok: false,
          code: 'LOCAL_AGENT_PLAN_SUPERSEDED',
        });
      }
      expect(configStore.current.localAgentIntegrations?.hermes).toMatchObject({
        enabled: false, metadata: { userDisabled: true }, runtime: { status: 'disconnected', ready: false },
      });
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8'))).toEqual(configStore.current);
    } finally {
      released.resolve();
      await running;
      await configStore.close();
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('keeps a newer disconnect when connect preparation started from an already disabled entry', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: false,
          metadata: { userDisabled: true },
          runtime: { status: 'disconnected', ready: false },
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    }));
    const entered = deferred();
    const released = deferred();
    const req = makeJsonRequest('POST', '/api/local-agent-integrations/connect', {
      id: 'hermes', metadata: { source: 'node-ui' },
    });
    const res = makeJsonResponse();
    const running = handleLocalAgentsRoutes({
      req, res, configStore, path: '/api/local-agent-integrations/connect',
    } as any, {
      connectFromUi: async (_config, body) => {
        entered.resolve();
        await released.promise;
        return {
          ok: true,
          state: extractLocalAgentIntegrationPatch(body),
          notice: 'Hermes is connected and chat-ready.',
        };
      },
    });
    try {
      await entered.promise;
      await configStore.update(current => {
        const next = structuredClone(current) as DkgConfig;
        updateLocalAgentIntegration(
          next,
          'hermes',
          { enabled: false, runtime: { status: 'disconnected' } },
          new Date('2026-09-02T00:00:00.000Z'),
        );
        return next;
      }, 'configuration-only');
      released.resolve();
      await running;
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        ok: false,
        code: 'LOCAL_AGENT_PLAN_SUPERSEDED',
        integration: getLocalAgentIntegration(configStore.current, 'hermes'),
      });
      expect(body).not.toHaveProperty('notice');
      expect(body.error).not.toContain('connected');
      expect(configStore.current.localAgentIntegrations?.hermes).toMatchObject({
        enabled: false,
        updatedAt: '2026-09-02T00:00:00.000Z',
        metadata: { userDisabled: true },
        runtime: { status: 'disconnected', ready: false },
      });
    } finally {
      released.resolve();
      await running;
      await configStore.close();
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

  it('publishes the legacy register-adapter route through the canonical store', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), makeConfig());
    const req = makeJsonRequest('POST', '/api/register-adapter', {
      id: 'openclaw',
      transport: { gatewayUrl: 'http://127.0.0.1:18789' },
    });
    const res = makeJsonResponse();
    try {
      await handleStatusRoutes({
        req,
        res,
        configStore,
        path: '/api/register-adapter',
        url: new URL('http://localhost/api/register-adapter'),
      } as any);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).integration)
        .toEqual(getLocalAgentIntegration(configStore.current, 'openclaw'));
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')))
        .toEqual(configStore.current);
    } finally {
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

});

describe('local-agent connector lifecycle contract', () => {
  it('gives every connector one complete lifecycle', () => {
    const ids = Object.keys(LOCAL_AGENT_INTEGRATION_DEFINITIONS);
    expect(ids).toEqual(expect.arrayContaining(['openclaw', 'hermes', 'prime-agent', 'local-llm']));
    // An id with no dedicated strategy still resolves to the generic
    // connector, so a new integration cannot reach a half-implemented
    // lifecycle by being forgotten in one phase.
    for (const id of [...ids, 'not-registered']) {
      const connector = localAgentConnectorFor(id);
      expect(typeof connector.createPlan, `${id} connect`).toBe('function');
      expect(typeof connector.createRefreshPlan, `${id} refresh`).toBe('function');
      expect(typeof connector.cancelPending, `${id} cancel`).toBe('function');
      expect(typeof connector.createDisconnectPlan, `${id} disconnect`).toBe('function');
    }
  });

  it('drives connect, refresh and disconnect for a registry-only connector through one contract', async () => {
    const config = makeConfig();
    const connector = localAgentConnectorFor('not-registered');

    const plan = await connector.createPlan({
      config,
      body: {},
      bridgeAuthToken: undefined,
      requested: { id: 'not-registered', name: 'Not Registered' },
      existingBeforeConnect: null,
      hadStoredTransportBeforeConnect: false,
    });
    expect(plan.ok).toBe(true);
    expect(plan.state).toEqual({});
    expect(plan.notice).toContain('Not Registered');

    const refresh = await connector.createRefreshPlan({
      config,
      id: 'not-registered',
      bridgeAuthToken: 'bridge-token',
    });
    expect(refresh.patch).toEqual({});

    await connector.cancelPending('not-registered');

    const disconnect = await connector.createDisconnectPlan({
      config,
      id: 'not-registered',
      state: { enabled: false },
    });
    expect(disconnect.state).toEqual({ enabled: false });
  });

  it('refreshes a registry-only integration through the generic strategy', async () => {
    const { patch } = await refreshLocalAgentIntegrationFromUi(
      makeConfig(), 'local-llm', 'bridge-token',
    );
    expect(patch).toEqual({});
  });

  it('rejects a refresh for an integration the registry does not define', async () => {
    await expect(
      refreshLocalAgentIntegrationFromUi(makeConfig(), 'does-not-exist', 'bridge-token'),
    ).rejects.toThrow(/Unknown integration/);
  });
});
