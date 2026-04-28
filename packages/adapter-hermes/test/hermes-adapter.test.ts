import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import type { DaemonPluginApi, SessionTurnPayload, SessionEndPayload } from '../src/types.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  resolveHermesProfile,
  runSetup,
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

describe('HermesAdapterPlugin', () => {
  it('registers HTTP routes on first call', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(7);
    expect(api.routes.has('GET /api/hermes-channel/health')).toBe(true);
    expect(api.routes.has('POST /api/hermes-channel/send')).toBe(true);
    expect(api.routes.has('POST /api/hermes-channel/stream')).toBe(true);
    expect(api.routes.has('POST /api/hermes-channel/persist-turn')).toBe(true);
    expect(api.routes.has('POST /api/hermes/session-end')).toBe(true);
    expect(api.routes.has('GET /api/hermes/status')).toBe(true);
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

    expect(api.registerHttpRouteCalls).toHaveLength(7);
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

describe('POST /api/hermes/session-end', () => {
  let api: TrackingApi;
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(() => {
    api = createTrackingApi();
    registerHermesRoutes(api);
    handler = api.routes.get('POST /api/hermes/session-end')!;
  });

  it('accepts a valid session-end payload', async () => {
    const body: SessionEndPayload = { sessionId: 's1', turnCount: 5 };
    const { res, calls } = trackingRes();

    await handler({ body }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's1')).toBe(true);
  });

  it('returns 400 when sessionId is missing', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: {} }, res);

    expect(calls.some(c => c.status === 400)).toBe(true);
    expect(calls.some(c => c.json?.success === false)).toBe(true);
  });

  it('works without optional turnCount', async () => {
    const { res, calls } = trackingRes();

    await handler({ body: { sessionId: 's2' } }, res);

    expect(calls.some(c => c.json?.success === true && c.json?.sessionId === 's2')).toBe(true);
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
    expect(readFileSync(join(hermesHome, 'plugins', 'dkg', '.dkg-adapter-hermes-owner.json'), 'utf-8')).toContain('@origintrail-official/dkg-adapter-hermes');
  });

  it('detects provider conflicts and preserves user config on disconnect/uninstall', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');

    expect(() => setupHermesProfile({ hermesHome, memoryMode: 'provider' })).toThrow('memory.provider: mem0');

    const plan = setupHermesProfile({ hermesHome, memoryMode: 'tools-only' });
    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(plan.warnings).toHaveLength(0);
    expect(verify.ok).toBe(true);
    expect(verify.warnings[0]).toContain('mem0');

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

  it('adds a managed provider line inside an existing Hermes memory config', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'model: gpt-5\nmemory:\n  retrieval_k: 8\n');

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    expect((config.match(/^memory:/gm) ?? [])).toHaveLength(1);
    expect(config).toContain('  provider: dkg');
    expect(config).toContain('  retrieval_k: 8');
  });

  it('exposes a dry-run CLI setup helper for dkg hermes setup', async () => {
    await expect(runSetup({
      profile: 'dkg-smoke',
      dryRun: true,
      daemonUrl: 'http://127.0.0.1:9200/',
    })).resolves.toBeUndefined();
  });
});
