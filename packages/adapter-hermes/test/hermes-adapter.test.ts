import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import type { DaemonPluginApi } from '../src/types.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

interface TrackingApi extends DaemonPluginApi {
  routes: Map<string, (req: any, res: any) => Promise<void>>;
  hooks: Map<string, () => Promise<void>>;
  registerHttpRouteCalls: any[];
  registerHookCalls: any[];
}

function createTrackingApi(): TrackingApi {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>();
  const hooks = new Map<string, () => Promise<void>>();
  const registerHttpRouteCalls: any[] = [];
  const registerHookCalls: any[] = [];

  const storeChatTurnCalls: any[][] = [];
  const importMemoriesCalls: any[][] = [];
  let storeChatTurnError: Error | null = null;
  let importMemoriesError: Error | null = null;

  return {
    routes,
    hooks,
    registerHttpRouteCalls,
    registerHookCalls,
    registerHttpRoute: (opts: any) => {
      registerHttpRouteCalls.push(opts);
      routes.set(`${opts.method} ${opts.path}`, opts.handler);
    },
    registerHook: (event: string, handler: any, meta?: any) => {
      registerHookCalls.push({ event, handler, meta });
      hooks.set(event, handler);
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
    },
    agent: {
      query: async () => {},
      share: async () => {},
      importMemories: async (...args: any[]) => {
        importMemoriesCalls.push(args);
        if (importMemoriesError) throw importMemoriesError;
        return undefined;
      },
      storeChatTurn: async (...args: any[]) => {
        storeChatTurnCalls.push(args);
        if (storeChatTurnError) throw storeChatTurnError;
        return undefined;
      },
      _storeChatTurnCalls: storeChatTurnCalls,
      _importMemoriesCalls: importMemoriesCalls,
      _setStoreChatTurnError: (e: Error | null) => { storeChatTurnError = e; },
      _setImportMemoriesError: (e: Error | null) => { importMemoriesError = e; },
    },
  } as any;
}

function trackingRes() {
  const calls: { status?: number; json?: any }[] = [];
  const res: any = {};
  res.status = (code: number) => { calls.push({ status: code }); return res; };
  res.json = (body: any) => { calls.push({ json: body }); return res; };
  return { res, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HermesAdapterPlugin', () => {
  it('registers HTTP routes on first call', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(2);
    expect([...api.routes.keys()].sort()).toEqual([
      'GET /api/hermes/status',
      'POST /api/hermes-channel/persist-turn',
    ]);
  });

  it('registers session_end lifecycle hook', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHookCalls.some(
      (c: any) => c.event === 'session_end' && c.meta?.name === 'hermes-adapter-stop',
    )).toBe(true);
  });

  it('skips route registration on second call (idempotent)', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);
    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(2);
  });
});

describe('POST /api/hermes-channel/persist-turn', () => {
  let api: TrackingApi;
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(() => {
    api = createTrackingApi();
    registerHermesRoutes(api);
    handler = api.routes.get('POST /api/hermes-channel/persist-turn')!;
  });

  it('stores chat turn and returns success', async () => {
    const body = {
      sessionId: 's1',
      turnId: 't1',
      idempotencyKey: 'idem-t1',
      userMessage: 'hello',
      assistantReply: 'hi there',
    };
    const { res, calls } = trackingRes();

    await handler({ body }, res);

    expect((api.agent as any)._storeChatTurnCalls[0]).toEqual([
      's1',
      'hello',
      'hi there',
      { turnId: 't1', idempotencyKey: 'idem-t1', source: 'hermes-channel' },
    ]);
    expect((api.agent as any)._importMemoriesCalls[0][0]).toBe('hi there');
    expect((api.agent as any)._importMemoriesCalls[0][1]).toBe('hermes-session:s1:turn:t1');
    expect(calls.some(c => c.json?.success === true && c.json?.turnId === 't1')).toBe(true);
  });

  it('returns 400 when sessionId is missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { turnId: 't1', idempotencyKey: 'idem', userMessage: 'hello' } }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('returns 400 when both user and assistant are missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem' } }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
  });

  it('succeeds with only user (no assistant)', async () => {
    const { res, calls } = trackingRes();

    await handler({
      body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem', userMessage: 'hello' },
    }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
    expect((api.agent as any)._importMemoriesCalls).toHaveLength(0);
  });

  it('does not fail when importMemories throws', async () => {
    (api.agent as any)._setImportMemoriesError(new Error('LLM timeout'));
    const { res, calls } = trackingRes();

    await handler({
      body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem', userMessage: '', assistantReply: 'x' },
    }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('returns 500 when storeChatTurn throws', async () => {
    (api.agent as any)._setStoreChatTurnError(new Error('DB error'));
    const { res, calls } = trackingRes();

    await handler({
      body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem', userMessage: 'u', assistantReply: 'a' },
    }, res);

    expect(calls.some(c => c.status === 500)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('handles absent storeChatTurn gracefully', async () => {
    api.agent.storeChatTurn = undefined;
    const { res, calls } = trackingRes();

    await handler({
      body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem', userMessage: 'u', assistantReply: 'a' },
    }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('handles absent importMemories gracefully', async () => {
    api.agent.importMemories = undefined;
    const { res, calls } = trackingRes();

    await handler({
      body: { sessionId: 's1', turnId: 't1', idempotencyKey: 'idem', userMessage: '', assistantReply: 'stuff' },
    }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });
});

describe('GET /api/hermes/status', () => {
  it('returns adapter status JSON', async () => {
    const api = createTrackingApi();
    registerHermesRoutes(api);
    const handler = api.routes.get('GET /api/hermes/status')!;
    const { res, calls } = trackingRes();

    await handler({}, res);

    expect(calls.some(c =>
      c.json?.adapter === 'hermes' &&
      c.json?.framework === 'hermes-agent' &&
      c.json?.status === 'connected',
    )).toBe(true);
  });
});

describe('HermesDkgClient', () => {
  it('registers Hermes through the local-agent integration route', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, integration: { id: 'hermes' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HermesDkgClient({
      baseUrl: 'http://127.0.0.1:9200/',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.connectHermesIntegration({
      metadata: { profileName: 'dkg-smoke' },
      transport: { bridgeUrl: 'http://127.0.0.1:3199' },
    });

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/connect');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.id).toBe('hermes');
    expect(body.manifest.setupEntry).toBe('./setup-entry.mjs');
    expect(body.transport.kind).toBe('hermes-channel');
    expect(body.capabilities.localChat).toBe(true);
  });

  it('redacts bearer tokens from daemon errors', async () => {
    const fetchImpl = async () => new Response('Bearer secret-token exploded', { status: 500 });
    const client = new HermesDkgClient({
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.getHermesChannelHealth()).rejects.toThrow('[REDACTED]');
    await expect(client.getHermesChannelHealth()).rejects.not.toThrow('secret-token');
    expect(redact('Authorization: Bearer secret-token', 'secret-token')).not.toContain('secret-token');
  });

  it('reads the daemon Hermes channel health wire shape', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      target: 'gateway',
      bridge: { ok: false, error: 'bridge unavailable' },
      gateway: { ok: true, channel: 'hermes-channel' },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const client = new HermesDkgClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    const health = await client.getHermesChannelHealth();

    expect(health.ok).toBe(true);
    expect(health.target).toBe('gateway');
    expect(health.bridge?.ok).toBe(false);
    expect(health.gateway?.channel).toBe('hermes-channel');
  });

  it('marks Hermes disconnected through the local-agent integration route', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, integration: { id: 'hermes', enabled: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new HermesDkgClient({
      baseUrl: 'http://127.0.0.1:9200/',
      apiToken: 'secret-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.disconnectHermesIntegration();

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/hermes');
    expect(calls[0].init.method).toBe('PUT');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.enabled).toBe(false);
    expect(body.runtime.status).toBe('disconnected');
    expect(body.runtime.ready).toBe(false);
  });
});

describe('Hermes profile setup helpers', () => {
  it('resolves named Hermes profiles into profile-scoped Hermes homes', () => {
    const profile = resolveHermesProfile({ profileName: 'dkg-smoke' });

    expect(profile.hermesHome.replace(/\\/g, '/')).toContain('/.hermes/profiles/dkg-smoke');
    expect(profile.configPath.replace(/\\/g, '/')).toContain('/.hermes/profiles/dkg-smoke/config.yaml');
  });

  it('plans setup without writing files in dry-run mode', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const plan = planHermesSetup({
      hermesHome,
      profileName: 'dev',
      dryRun: true,
      daemonUrl: 'http://127.0.0.1:9200/',
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.state.daemonUrl).toBe('http://127.0.0.1:9200');
    expect(plan.actions.some((action) => action.path.endsWith('dkg.json'))).toBe(true);
  });

  it('writes ownership-marked profile artifacts idempotently', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const first = setupHermesProfile({
      hermesHome,
      profileName: 'dev',
      nodeSkillContent: '# DKG Node\n',
    });
    const second = setupHermesProfile({
      hermesHome,
      profileName: 'dev',
      nodeSkillContent: '# DKG Node\n',
    });
    const verify = verifyHermesProfile({ hermesHome, profileName: 'dev' });

    expect(first.state.installedAt).toBe(second.state.installedAt);
    expect(verify.ok).toBe(true);
    expect(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8')).toContain('@origintrail-official/dkg-adapter-hermes');
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: dkg');
    expect(readFileSync(join(hermesHome, 'skills', 'dkg-node', 'SKILL.md'), 'utf-8')).toContain('Managed by @origintrail-official/dkg-adapter-hermes');
    expect(readFileSync(join(hermesHome, 'plugins', 'dkg', '__init__.py'), 'utf-8')).toContain('DKGMemoryProvider');
    expect(readFileSync(join(hermesHome, 'plugins', 'dkg', '__init__.py'), 'utf-8')).toContain('from .client import DKGClient');
    expect(readFileSync(join(hermesHome, 'plugins', 'dkg', 'cli.py'), 'utf-8')).not.toContain('plugins.memory.dkg');
    expect(readFileSync(join(hermesHome, 'plugins', 'dkg', '.dkg-adapter-hermes-owner.json'), 'utf-8')).toContain('@origintrail-official/dkg-adapter-hermes');
  });

  it('writes provider-readable publish guard keys into dkg.json', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    setupHermesProfile({
      hermesHome,
      publishGuard: {
        defaultToolExposure: 'direct',
        allowDirectPublish: true,
        requireExplicitApproval: false,
        requireWalletCheck: false,
      },
    });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    expect(config.publish_guard).toEqual({
      defaultToolExposure: 'direct',
      allowDirectPublish: true,
      requireExplicitApproval: false,
      requireWalletCheck: false,
    });
    expect(config.publish_tool).toBe('direct');
    expect(config.allow_direct_publish).toBe(true);
    expect(config.require_explicit_approval).toBe(false);
    expect(config.require_wallet_check).toBe(false);
  });

  it('detects provider conflicts and preserves user config on disconnect/uninstall', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');

    expect(() => setupHermesProfile({ hermesHome, memoryMode: 'provider' })).toThrow('memory.provider: mem0');

    const plan = setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    const verify = verifyHermesProfile({ hermesHome });
    const providerVerify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(plan.warnings).toHaveLength(0);
    expect(verify.ok).toBe(true);
    expect(verify.profile.memoryMode).toBe('tools-only');
    expect(verify.warnings).toHaveLength(0);
    expect(providerVerify.ok).toBe(false);
    expect(providerVerify.status).toBe('error');
    expect(providerVerify.errors[0]).toContain('mem0');
    await expect(runVerify({ hermesHome })).resolves.toBeUndefined();
    await expect(runVerify({ hermesHome, memoryMode: 'provider' })).rejects.toThrow('mem0');
    await expect(runDoctor({ hermesHome, memoryMode: 'provider' })).rejects.toThrow('mem0');

    disconnectHermesProfile({ hermesHome });
    uninstallHermesProfile({ hermesHome });

    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: mem0');
  });

  it('removes only ownership-marked provider plugin artifacts during uninstall', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });

    uninstallHermesProfile({ hermesHome, profileName: 'dev' });

    expect(existsSync(join(hermesHome, 'plugins', 'dkg'))).toBe(false);
  });

  it('reports a partially removed provider plugin during verify', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    rmSync(join(hermesHome, 'plugins', 'dkg'), { recursive: true, force: true });

    const verify = verifyHermesProfile({ hermesHome, profileName: 'dev' });

    expect(verify.ok).toBe(false);
    expect(verify.errors[0]).toContain('provider plugin is missing');
  });

  it('reports missing or unowned dkg.json during verify', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    rmSync(join(hermesHome, 'dkg.json'), { force: true });

    const missingVerify = verifyHermesProfile({ hermesHome, profileName: 'dev' });
    expect(missingVerify.ok).toBe(false);
    expect(missingVerify.errors.some((error) => error.includes('dkg.json'))).toBe(true);

    writeFileSync(join(hermesHome, 'dkg.json'), JSON.stringify({ managedBy: 'someone-else' }));
    const unownedVerify = verifyHermesProfile({ hermesHome, profileName: 'dev' });
    expect(unownedVerify.ok).toBe(false);
    expect(unownedVerify.errors.some((error) => error.includes('not ownership-marked'))).toBe(true);
  });

  it('reports provider-mode config drift when managed memory.provider is missing', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  retrieval_k: 8\n');

    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(verify.ok).toBe(false);
    expect(verify.errors.some((error) => error.includes('managed memory.provider: dkg'))).toBe(true);
  });

  it('adds a managed provider line inside an existing Hermes memory config', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  retrieval_k: 8\n');

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    expect((config.match(/^memory:/gm) ?? [])).toHaveLength(1);
    expect(config).toContain('  provider: dkg');
    expect(config).toContain('  retrieval_k: 8');
  });

  it('marks an existing dkg provider line so verify and disconnect own it', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  provider: dkg\n  retrieval_k: 8\n');

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(verify.ok).toBe(true);
    expect(config).toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(config).toContain('  retrieval_k: 8');
    expect((config.match(/provider: dkg/g) ?? [])).toHaveLength(1);

    disconnectHermesProfile({ hermesHome });

    const disconnectedConfig = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const disconnectedVerify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(disconnectedConfig).not.toContain('provider: dkg');
    expect(disconnectedConfig).not.toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(disconnectedConfig).toContain('  retrieval_k: 8');
    expect(disconnectedVerify.ok).toBe(true);
    expect(disconnectedVerify.status).toBe('disconnected');
    expect(disconnectedVerify.errors.some((error) => error.includes('managed memory.provider'))).toBe(false);
  });

  it('best-effort disables the daemon registry during disconnect and uninstall', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    setupHermesProfile({
      hermesHome,
      memoryMode: 'provider',
      daemonUrl: 'http://127.0.0.1:9333',
    });

    await runDisconnect({ hermesHome });
    await runUninstall({ hermesHome });

    const disconnectCalls = calls.filter((call) =>
      call.url === 'http://127.0.0.1:9333/api/local-agent-integrations/hermes'
      && call.init.method === 'PUT');
    expect(disconnectCalls).toHaveLength(2);
    for (const call of disconnectCalls) {
      const body = JSON.parse(String(call.init.body));
      expect(body.enabled).toBe(false);
      expect(body.runtime.status).toBe('disconnected');
    }
  });

  it('removes the managed provider block when switching to tools-only mode', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: dkg');

    const plan = setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome });

    expect(plan.profile.memoryMode).toBe('tools-only');
    expect(config).not.toContain('provider: dkg');
    expect(config).not.toContain('BEGIN DKG ADAPTER HERMES MANAGED');
    expect(verify.ok).toBe(true);
    expect(verify.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect preserves a disconnected tools-only profile mode', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');
    setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({ hermesHome, start: false });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const verify = verifyHermesProfile({ hermesHome });
    expect(config).toContain('provider: mem0');
    expect(config).not.toContain('provider: dkg');
    expect(verify.ok).toBe(true);
    expect(verify.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect preserves persisted daemon and bridge settings when flags are omitted', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({
      hermesHome,
      memoryMode: 'tools-only',
      daemonUrl: 'https://dkg.example.com/',
      gatewayUrl: 'https://hermes.example.com/',
      bridgeHealthUrl: 'https://hermes.example.com/health/',
    });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({ hermesHome, start: false, verify: false });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.daemon_url).toBe('https://dkg.example.com');
    expect(config.bridge).toEqual({
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/health',
    });
    expect(state.daemonUrl).toBe('https://dkg.example.com');
    expect(state.bridge).toEqual(config.bridge);
    expect(state.profile.memoryMode).toBe('tools-only');
  });

  it('rejects unsupported non-interactive ask memory mode', async () => {
    await expect(runSetup({
      memoryMode: 'ask' as any,
      dryRun: true,
    })).rejects.toThrow('not supported');
  });

  it('exposes a dry-run CLI setup helper for dkg hermes setup', async () => {
    await expect(runSetup({
      profile: 'dkg-smoke',
      dryRun: true,
      daemonUrl: 'http://127.0.0.1:9200/',
    })).resolves.toBeUndefined();
  });

  it('uses profile in adapter CLI setup options', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    await runSetup({
      hermesHome,
      profile: 'explicit',
      start: false,
      verify: false,
    });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.profile_name).toBe('explicit');
    expect(state.profile.profileName).toBe('explicit');
  });

  it('reads the first usable default DKG auth token file line for setup daemon registration', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = mkdtempSync(join(tmpdir(), 'dkg-home-'));
    writeFileSync(join(dkgHome, 'auth.token'), '# comment\n\nfile-token\nignored-token\n');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const oldDkgHome = process.env.DKG_HOME;
    const oldApiToken = process.env.DKG_API_TOKEN;
    const oldAuthToken = process.env.DKG_AUTH_TOKEN;
    process.env.DKG_HOME = dkgHome;
    delete process.env.DKG_API_TOKEN;
    delete process.env.DKG_AUTH_TOKEN;
    try {
      await runSetup({ hermesHome, verify: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      if (oldApiToken === undefined) delete process.env.DKG_API_TOKEN;
      else process.env.DKG_API_TOKEN = oldApiToken;
      if (oldAuthToken === undefined) delete process.env.DKG_AUTH_TOKEN;
      else process.env.DKG_AUTH_TOKEN = oldAuthToken;
    }

    expect(calls[0].url).toBe('http://127.0.0.1:9200/api/local-agent-integrations/connect');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer file-token');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({ kind: 'hermes-channel' });
    expect(body.transport.bridgeUrl).toBeUndefined();
  });

  it('preserves explicit gateway transport inputs during setup registration', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await runSetup({
      hermesHome,
      verify: false,
      gatewayUrl: 'https://hermes.example.com/',
      bridgeHealthUrl: 'https://hermes.example.com/api/hermes-channel/health/',
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({
      kind: 'hermes-channel',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(state.bridge).toEqual({
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
  });
});
