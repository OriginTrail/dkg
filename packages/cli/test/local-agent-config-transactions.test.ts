import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DkgHomeFiles, type DkgConfig } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';
import {
  type LocalAgentUiAttachDeps,
  getLocalAgentIntegration,
  updateLocalAgentIntegration,
} from '../src/daemon/local-agents.js';
import {
  handleLocalAgentsRoutes,
  persistLocalAgentAttachPatch,
} from '../src/daemon/routes/local-agents.js';

const disconnectHermesProfileMock = vi.hoisted(() => vi.fn());
const resolveHermesProfileMock = vi.hoisted(() => vi.fn<NonNullable<LocalAgentUiAttachDeps['resolveHermesProfile']>>(() => ({
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

describe('local-agent configuration transactions', () => {
  it('keeps node-UI probes outside the config queue without overwriting newer integration edits', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const initial = makeConfig({
      localAgentIntegrations: {
        hermes: {
          enabled: true,
          transport: { kind: 'hermes-openai', gatewayUrl: 'http://127.0.0.1:8642', healthUrl: 'http://127.0.0.1:8642/stale-health' },
          capabilities: { chatAttachments: false },
          metadata: { profileName: 'research', hermesHome: 'C:\\Hermes\\research', operatorLabel: 'initial' },
          runtime: { status: 'degraded', ready: false },
        },
      },
    });
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), initial);
    let probeEntered!: () => void;
    let releaseProbe!: () => void;
    const entered = new Promise<void>(resolve => { probeEntered = resolve; });
    const blocked = new Promise<void>(resolve => { releaseProbe = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      probeEntered();
      await blocked;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const connectReq = makeJsonRequest('POST', '/api/local-agent-integrations/connect', {
      id: 'hermes',
      metadata: { source: 'node-ui', profileName: 'research', hermesHome: 'C:\\Hermes\\research' },
    });
    const connectRes = makeJsonResponse();

    let refreshEntered!: () => void;
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>(resolve => { refreshEntered = resolve; });
    const refreshBlocked = new Promise<void>(resolve => { releaseRefresh = resolve; });
    let connecting: Promise<unknown> | undefined;
    let refreshing: Promise<unknown> | undefined;
    const edits: Promise<unknown>[] = [];
    try {
      connecting = handleLocalAgentsRoutes({
        req: connectReq,
        res: connectRes,
        configStore,
        path: '/api/local-agent-integrations/connect',
        bridgeAuthToken: 'bridge-token',
      } as any);
      await entered;
      let connectEditCommitted = false;
      edits.push(configStore.update(current => {
        const next = structuredClone(current) as DkgConfig;
        next.name = 'committed during blocked probe';
        updateLocalAgentIntegration(next, 'hermes', { capabilities: { chatAttachments: true }, metadata: { operatorLabel: 'edited during connect' } });
        return next;
      }, 'configuration-only')
        .then(() => { connectEditCommitted = true; }));
      await vi.waitFor(() => expect(connectEditCommitted).toBe(true));
      expect(configStore.current.name).toBe('committed during blocked probe');
      releaseProbe();
      await connecting;

      expect(configStore.current.name).toBe('committed during blocked probe');
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')).name).toBe('committed during blocked probe');
      expect(connectRes.statusCode).toBe(200);
      expect(configStore.current.localAgentIntegrations?.hermes).toMatchObject({
        capabilities: { chatAttachments: true }, metadata: { operatorLabel: 'edited during connect' },
      });
      expect(configStore.current.localAgentIntegrations?.hermes?.transport).not.toHaveProperty('healthUrl');
      const connectBody = JSON.parse(connectRes.body);
      expect(connectBody.integration).toEqual(getLocalAgentIntegration(configStore.current, 'hermes'));
      expect(configStore.current.localAgentIntegrations?.hermes?.runtime)
        .toMatchObject({ status: 'degraded', ready: false });
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')))
        .toEqual(configStore.current);

      const refreshReq = makeJsonRequest('POST', '/api/local-agent-integrations/hermes/refresh', {});
      const refreshRes = makeJsonResponse();
      refreshing = handleLocalAgentsRoutes({
        req: refreshReq,
        res: refreshRes,
        configStore,
        path: '/api/local-agent-integrations/hermes/refresh',
        bridgeAuthToken: 'bridge-token',
      } as any, {
        refreshFromUi: async () => {
          refreshEntered();
          await refreshBlocked;
          const patch = { runtime: { status: 'ready' as const, ready: true, lastError: null } };
          return { patch };
        },
      });
      await refreshStarted;
      let refreshEditCommitted = false;
      edits.push(configStore.update(current => {
        const next = structuredClone(current) as DkgConfig;
        next.name = 'committed during blocked refresh';
        updateLocalAgentIntegration(next, 'hermes', { runtime: { status: 'degraded', ready: false }, metadata: { operatorLabel: 'edited during refresh' } });
        return next;
      }, 'configuration-only')
        .then(() => { refreshEditCommitted = true; }));
      await vi.waitFor(() => expect(refreshEditCommitted).toBe(true));
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')).name).toBe('committed during blocked refresh');
      releaseRefresh();
      await refreshing;
      expect(configStore.current.name).toBe('committed during blocked refresh');

      expect(refreshRes.statusCode).toBe(200);
      expect(configStore.current.localAgentIntegrations?.hermes).toMatchObject({
        runtime: { status: 'degraded', ready: false },
        capabilities: { chatAttachments: true }, metadata: { operatorLabel: 'edited during refresh' },
      });
      expect(JSON.parse(refreshRes.body).integration)
        .toEqual(getLocalAgentIntegration(configStore.current, 'hermes'));
      expect(JSON.parse(readFileSync(configStore.files.configPath, 'utf8')))
        .toEqual(configStore.current);
    } finally {
      releaseProbe(); releaseRefresh();
      await Promise.allSettled([connecting, refreshing, ...edits]);
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });
  it('rebases deferred integration state through the canonical config store', async () => {
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    const initial = makeConfig({
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          capabilities: { chatAttachments: true },
          metadata: { operatorLabel: 'keep me' },
          runtime: { status: 'connecting', ready: false },
        },
      },
    });
    const configStore = await DkgConfigStore.open(new DkgHomeFiles(dkgHome), initial);
    const context = { configStore };

    try {
      await persistLocalAgentAttachPatch(context, '', { runtime: { status: 'ready' } });
      await persistLocalAgentAttachPatch(context, 'hermes', { runtime: { status: 'ready' } });
      expect(configStore.current.localAgentIntegrations).toEqual(initial.localAgentIntegrations);

      await persistLocalAgentAttachPatch(context, ' OpenClaw ', {
        runtime: { status: 'ready', ready: true, lastError: null },
        metadata: { setupAudit: 'complete' },
      });
      expect(configStore.current.localAgentIntegrations?.openclaw?.runtime)
        .toMatchObject({ status: 'ready', ready: true });
      expect(configStore.current.localAgentIntegrations?.openclaw?.capabilities)
        .toEqual({ chatAttachments: true });
      expect(configStore.current.localAgentIntegrations?.openclaw?.metadata)
        .toMatchObject({ operatorLabel: 'keep me', setupAudit: 'complete' });

      await configStore.update(current => ({
        ...current,
        localAgentIntegrations: {
          ...current.localAgentIntegrations,
          openclaw: {
            ...current.localAgentIntegrations?.openclaw,
            enabled: false,
            runtime: { status: 'disconnected', ready: false, lastError: null },
          },
        },
      }), 'configuration-only');
      await persistLocalAgentAttachPatch(context, 'openclaw', {
        enabled: true,
        runtime: { status: 'ready', ready: true, lastError: null },
      });
      expect(configStore.current.localAgentIntegrations?.openclaw)
        .toMatchObject({ enabled: false, runtime: { status: 'disconnected' } });
      expect(initial.localAgentIntegrations?.openclaw?.runtime)
        .toEqual({ status: 'connecting', ready: false });
    } finally {
      rmSync(dkgHome, { recursive: true, force: true });
    }
  });

});
