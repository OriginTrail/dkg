import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
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

describe('setup-entry.mjs', () => {
  it('skips runtime imports in setup-safe modes', async () => {
    const entry = await import('../setup-entry.mjs');
    const importRuntime = vi.fn(async () => {
      throw new Error('runtime import should be skipped');
    });

    for (const registrationMode of ['setup-only', 'cli-metadata'] as const) {
      const result = entry.default({
        registrationMode,
        _importRuntime: importRuntime,
        logger: { info: vi.fn() },
      });

      expect(result).toBeUndefined();
    }
    expect(importRuntime).not.toHaveBeenCalled();
  });

  it('lazy-loads the runtime plugin for daemon registration', async () => {
    const entry = await import('../setup-entry.mjs');
    const register = vi.fn(() => 'registered');
    let observedConfig: unknown;
    class FakePlugin {
      constructor(config: unknown) {
        observedConfig = config;
      }

      register = register;
    }
    const importRuntime = vi.fn(async () => ({ HermesAdapterPlugin: FakePlugin }));

    const result = await entry.default({
      _importRuntime: importRuntime,
      registerHttpRoute: vi.fn(),
      registerHook: vi.fn(),
      config: { hermes: { profileName: 'dev' } },
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result).toBe('registered');
    expect(importRuntime).toHaveBeenCalledTimes(1);
    expect(observedConfig).toEqual({ profileName: 'dev' });
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe('HermesAdapterPlugin', () => {
  it('registers HTTP routes on first call', () => {
    const plugin = new HermesAdapterPlugin();
    const api = createTrackingApi();

    plugin.register(api);

    expect(api.registerHttpRouteCalls).toHaveLength(1);
    expect([...api.routes.keys()].sort()).toEqual([
      'GET /api/hermes/status',
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

    expect(api.registerHttpRouteCalls).toHaveLength(1);
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

  it('loads the installed provider from Hermes user plugin discovery path', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({
      hermesHome,
      profileName: 'dev',
      nodeSkillContent: '# DKG Node\n',
    });

    const script = String.raw`
import importlib.util
import json
import sys
import types
from pathlib import Path

home = Path(r"${hermesHome.replace(/\\/g, '\\\\')}")
provider_dir = home / "plugins" / "dkg"

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    def is_available(self):
        return True
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: json.dumps({"error": message})
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

module_name = "_hermes_user_memory.dkg"
parent = types.ModuleType("_hermes_user_memory")
parent.__path__ = [str(home / "plugins")]
sys.modules["_hermes_user_memory"] = parent
spec = importlib.util.spec_from_file_location(
    module_name,
    provider_dir / "__init__.py",
    submodule_search_locations=[str(provider_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules[module_name] = module
spec.loader.exec_module(module)

class Collector:
    def __init__(self):
        self.provider = None
    def register_memory_provider(self, provider):
        self.provider = provider

collector = Collector()
module.register(collector)
provider = collector.provider
assert provider is not None, "provider was not registered"
provider.initialize({"session_id": "loader-smoke"})
assert provider.name == "dkg", provider.name
assert any(schema["name"] == "memory_search" for schema in provider.get_tool_schemas())
assert provider._config["context_graph"] == "agent-context", provider._config
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
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
    expect(config.allow_context_graph_admin_tools).toBe(true);
    expect(config.memory_assertion).toBe('memory');
  });

  it('defaults publish tools to direct exposure for skill parity', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-default-publish-'));

    setupHermesProfile({ hermesHome });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    expect(config.publish_guard).toEqual({
      defaultToolExposure: 'direct',
      allowDirectPublish: true,
      requireExplicitApproval: false,
      requireWalletCheck: false,
    });
    expect(config.publish_tool).toBe('direct');
    expect(config.allow_direct_publish).toBe(true);
    expect(config.allow_context_graph_admin_tools).toBe(true);
    expect(config.memory_assertion).toBe('memory');
  });

  it('loads provider guard aliases from dkg.json', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-provider-config-'));
    writeFileSync(join(hermesHome, 'dkg.json'), JSON.stringify({
      publish_guard: {
        defaultToolExposure: 'direct',
        allowDirectPublish: true,
      },
      allowContextGraphAdminTools: true,
    }));
    const script = String.raw`
import importlib.util
import json
import sys
import types
from pathlib import Path

home = Path(r"${hermesHome.replace(/\\/g, '\\\\')}")

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: json.dumps({"error": message})
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

config = module._load_config()
assert config["publish_tool"] == "direct", config
assert config["allow_direct_publish"] is True, config
assert config["allow_context_graph_admin_tools"] is True, config
(home / "dkg.json").write_text(json.dumps({"allow_context_graph_admin_tools": False}), encoding="utf-8")
config = module._load_config()
assert config["allow_context_graph_admin_tools"] is False, config
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('rejects non-loopback bridge URLs during setup', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    expect(() => setupHermesProfile({
      hermesHome,
      bridgeUrl: 'https://hermes.example.com:9202',
    })).toThrow('--gateway-url');
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'))).toBe(false);
  });

  it('accepts loopback bridge URLs during setup', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    const plan = setupHermesProfile({
      hermesHome,
      bridgeUrl: 'http://127.0.0.1:9202/',
    });

    expect(plan.state.bridge).toEqual({ url: 'http://127.0.0.1:9202' });
  });

  it('detects provider conflicts (with --preserve-provider) and preserves user config on disconnect/uninstall', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');

    // S4 step 2 (issue #386): the throw-on-conflict assertion now lives
    // behind `preserveProvider: true` (formerly the default). Default
    // behavior (without the flag) replaces with backup; the rest of this
    // test exercises the `--preserve-provider` opt-out path so the
    // historical assertions stay relevant.
    expect(() => setupHermesProfile({ hermesHome, memoryMode: 'provider', preserveProvider: true }))
      .toThrow('memory.provider: mem0');

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
    const disconnectedVerify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(disconnectedVerify.ok).toBe(true);
    expect(disconnectedVerify.status).toBe('disconnected');
    expect(disconnectedVerify.errors).toHaveLength(0);
    expect(disconnectedVerify.warnings[0]).toContain('disconnected');

    uninstallHermesProfile({ hermesHome });

    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: mem0');
  });

  it('allows user-owned provider config after disconnecting provider mode', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    disconnectHermesProfile({ hermesHome });
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory:\n  provider: mem0\n');

    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(verify.ok).toBe(true);
    expect(verify.status).toBe('disconnected');
    expect(verify.errors).toHaveLength(0);
    expect(verify.warnings[0]).toContain('disconnected');
    await expect(runVerify({ hermesHome, memoryMode: 'provider' })).resolves.toBeUndefined();
    await expect(runDoctor({ hermesHome, memoryMode: 'provider' })).resolves.toBeUndefined();
  });

  it('detects provider conflicts (with --preserve-provider) when the top-level memory block has an inline comment', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory: # existing provider\n  provider: mem0\n');

    // S4 step 2 (issue #386): inline-comment detection still works
    // under `preserveProvider: true` — proves the YAML parser correctly
    // skips comments when finding the configured provider, even on the
    // throw path.
    expect(() => setupHermesProfile({ hermesHome, memoryMode: 'provider', preserveProvider: true }))
      .toThrow('memory.provider: mem0');
  });

  it('ignores nested memory provider blocks when managing Hermes provider config', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'plugins:',
      '  helper:',
      '    memory:',
      '      provider: mem0',
      '',
    ].join('\n'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    const configured = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');

    expect(configured).toContain('    memory:\n      provider: mem0');
    expect(configured).toContain('# BEGIN DKG ADAPTER HERMES MANAGED\nmemory:\n  provider: dkg');

    disconnectHermesProfile({ hermesHome });
    const disconnected = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');

    expect(disconnected).toContain('    memory:\n      provider: mem0');
    expect(disconnected).not.toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
  });

  it('removes only ownership-marked provider plugin artifacts during uninstall', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });

    uninstallHermesProfile({ hermesHome, profileName: 'dev' });

    expect(existsSync(join(hermesHome, 'plugins', 'dkg'))).toBe(false);
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes'))).toBe(false);
  });

  it('preserves manual adapter state files during uninstall', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, profileName: 'dev' });
    const manualPath = join(hermesHome, '.dkg-adapter-hermes', 'operator-note.txt');
    writeFileSync(manualPath, 'keep me\n');

    uninstallHermesProfile({ hermesHome, profileName: 'dev' });

    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'))).toBe(false);
    expect(readFileSync(manualPath, 'utf-8')).toBe('keep me\n');
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

  it('replaces an empty Hermes provider placeholder instead of shadowing the managed DKG provider', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'model: gpt-5',
      'memory:',
      '  memory_enabled: true',
      "  provider: ''",
      '  nudge_interval: 10',
      '',
    ].join('\n'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });

    const config = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8');
    const providerLines = config.split(/\r?\n/).filter((line) => /^\s+provider\s*:/.test(line));
    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(verify.ok).toBe(true);
    expect(providerLines).toEqual(['  provider: dkg']);
    expect(config).toContain('  memory_enabled: true');
    expect(config).toContain('  nudge_interval: 10');
    expect(config).not.toContain("provider: ''");
  });

  it('reports config drift when a later provider line overrides the managed DKG provider', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    writeFileSync(join(hermesHome, 'config.yaml'), [
      'memory:',
      '  # BEGIN DKG ADAPTER HERMES MANAGED',
      '  provider: dkg',
      '  # END DKG ADAPTER HERMES MANAGED',
      "  provider: ''",
      '',
    ].join('\n'));

    const verify = verifyHermesProfile({ hermesHome, memoryMode: 'provider' });

    expect(verify.ok).toBe(false);
    expect(verify.errors.some((error) => error.includes('effective memory.provider: dkg'))).toBe(true);
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
      const body = init?.method === 'GET'
        ? {
            integration: {
              id: 'hermes',
              metadata: { hermesHome },
            },
          }
        : { ok: true };
      return new Response(JSON.stringify(body), {
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

  it('does not disable a daemon registry entry owned by a different Hermes profile', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-a-'));
    const otherHermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-b-'));
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        integration: {
          id: 'hermes',
          enabled: true,
          metadata: {
            profileName: 'profile-b',
            hermesHome: otherHermesHome,
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    setupHermesProfile({
      hermesHome,
      profileName: 'profile-a',
      daemonUrl: 'http://127.0.0.1:9333',
    });

    await runDisconnect({ hermesHome, profile: 'profile-a' });
    await runUninstall({ hermesHome, profile: 'profile-a' });

    expect(calls.filter((call) => call.init.method === 'GET')).toHaveLength(2);
    expect(calls.filter((call) => call.init.method === 'PUT')).toHaveLength(0);
  });

  it('does not create adapter setup state when disconnecting an unconfigured profile', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const plan = disconnectHermesProfile({ hermesHome });
    await runDisconnect({ hermesHome });

    expect(plan.actions).toEqual([
      expect.objectContaining({
        type: 'skip',
        reason: 'Hermes adapter is not configured for this profile',
      }),
    ]);
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes the managed provider block when switching to tools-only mode', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    setupHermesProfile({ hermesHome, memoryMode: 'provider' });
    expect(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')).toContain('provider: dkg');

    const dryRun = planHermesSetup({ hermesHome, memoryMode: 'tools-only', dryRun: true });
    expect(dryRun.actions).toContainEqual(expect.objectContaining({
      type: 'update',
      path: join(hermesHome, 'config.yaml'),
    }));
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
      bridgeHealthUrl: 'https://hermes.example.com/api/hermes-channel/health/',
    });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({ hermesHome, start: false, verify: false });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.daemon_url).toBe('https://dkg.example.com');
    expect(config.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
    expect(state.daemonUrl).toBe('https://dkg.example.com');
    expect(state.bridge).toEqual(config.bridge);
    expect(state.profile.memoryMode).toBe('tools-only');
  });

  it('reconnect can override stale persisted daemon and bridge settings', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({
      hermesHome,
      memoryMode: 'tools-only',
      daemonUrl: 'https://stale-dkg.example.com',
      gatewayUrl: 'https://stale-hermes.example.com',
      bridgeHealthUrl: 'https://stale-hermes.example.com/api/hermes-channel/health',
    });
    disconnectHermesProfile({ hermesHome });

    await runReconnect({
      hermesHome,
      daemonUrl: 'https://fresh-dkg.example.com/',
      gatewayUrl: 'https://fresh-hermes.example.com/',
      bridgeHealthUrl: 'https://fresh-hermes.example.com/api/hermes-channel/health/',
      start: false,
      verify: false,
    });

    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.daemon_url).toBe('https://fresh-dkg.example.com');
    expect(config.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://fresh-hermes.example.com',
      healthUrl: 'https://fresh-hermes.example.com/api/hermes-channel/health',
    });
    expect(state.daemonUrl).toBe('https://fresh-dkg.example.com');
    expect(state.bridge).toEqual(config.bridge);
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
      // S2.3 (issue #386): `runSetup` now flows through the new
      // `runHermesSetup` orchestrator which spawns the DKG daemon when
      // `start !== false` and funds wallets via the faucet when
      // `fund !== false`. This test exercises the daemon-registration
      // probe against an already-running daemon, so we pass
      // `start: false` + `fund: false` to skip both new steps.
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
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
    expect(body.transport).toEqual({
      kind: 'hermes-openai',
      gatewayUrl: 'http://127.0.0.1:8642',
    });
    expect(body.transport.bridgeUrl).toBeUndefined();
  });

  it('uses the shared monorepo DKG home when DKG_HOME is unset for setup daemon registration', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'hermes-dkg-home-'));
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const dkgHome = join(homeRoot, '.dkg');
    const dkgDevHome = join(homeRoot, '.dkg-dev');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(dkgDevHome, { recursive: true });
    writeFileSync(join(dkgHome, 'auth.token'), 'stale-npm-token\n');
    writeFileSync(join(dkgDevHome, 'auth.token'), '# DKG node API token\nlive-dev-token\n');

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
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    delete process.env.DKG_HOME;
    delete process.env.DKG_API_TOKEN;
    delete process.env.DKG_AUTH_TOKEN;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    const resolver = vi.mocked(resolveDkgHome);
    resolver.mockClear();

    try {
      // S2.3: pass `start: false` + `fund: false` to skip both new
      // orchestrator steps; this test exercises the registration-probe
      // path against an already-running daemon (registration is decoupled
      // from --no-start per issue #386 brief, so the probe still fires).
      await runSetup({ hermesHome, verify: false, start: false, fund: false });
    } finally {
      if (oldDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = oldDkgHome;
      if (oldApiToken === undefined) delete process.env.DKG_API_TOKEN;
      else process.env.DKG_API_TOKEN = oldApiToken;
      if (oldAuthToken === undefined) delete process.env.DKG_AUTH_TOKEN;
      else process.env.DKG_AUTH_TOKEN = oldAuthToken;
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
    }

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer live-dev-token');
    const config = JSON.parse(readFileSync(join(hermesHome, 'dkg.json'), 'utf-8'));
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(config.dkg_home).toBe(dkgDevHome);
    expect(state.dkgHome).toBe(dkgDevHome);
    expect(resolver.mock.calls.some(([opts]) => {
      return (opts as any)?.daemonUrl === 'http://127.0.0.1:9200';
    })).toBe(true);
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
      // S2.3: skip new orchestrator steps not under test
      // (test exercises bridge transport persistence, not daemon
      // spawn or faucet funding).
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com/',
      bridgeHealthUrl: 'https://hermes.example.com/api/hermes-channel/health/',
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.transport).toEqual({
      kind: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
    const state = JSON.parse(readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8'));
    expect(state.bridge).toEqual({
      protocol: 'hermes-openai',
      gatewayUrl: 'https://hermes.example.com',
      healthUrl: 'https://hermes.example.com/api/hermes-channel/health',
    });
  });

  it('registers tools-only profiles without provider-owned memory capabilities', async () => {
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
      // S2.3: skip new orchestrator steps not under test
      // (this test exercises tools-only memory-mode capabilities, not
      // daemon spawn or faucet funding).
      start: false,
      fund: false,
      memoryMode: 'tools-only',
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.metadata.memoryMode).toBe('tools-only');
    expect(body.capabilities.dkgPrimaryMemory).toBe(false);
    expect(body.capabilities.wmImportPipeline).toBe(false);
    expect(body.capabilities.localChat).toBe(true);
  });

  it('rejects bridge health URLs without a matching transport base', async () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));

    // S2.3: skip new orchestrator steps not under test on each
    // invocation. These three cases test bridge-URL validation inside
    // `setupHermesProfile`, not the daemon-start or faucet flows.
    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      bridgeHealthUrl: 'https://hermes.example.com/health',
    })).rejects.toThrow('requires --bridge-url or --gateway-url');

    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'https://other-hermes.example.com/api/hermes-channel/health',
    })).rejects.toThrow('must belong to the configured');

    await expect(runSetup({
      hermesHome,
      verify: false,
      start: false,
      fund: false,
      gatewayUrl: 'https://hermes.example.com',
      bridgeHealthUrl: 'https://hermes.example.com/health',
    })).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // S2 step 4 — dry-run hardening (issue #386 contract §5 + H-AC-21/25/26).
  // ---------------------------------------------------------------------------

  // H-AC-21: `--dry-run` does not write any file (no `dkg.json`, no
  // plugin dir, no skill, no `setup-state.json`, no `config.yaml.bak.*`,
  // no mutation of existing `config.yaml`). Brief explicitly calls out
  // "no backup file" — assert no `config.yaml.bak.*` exists.
  it('H-AC-21: --dry-run does not write any file under hermesHome', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-'));
    // Pre-snapshot the empty hermesHome contents.
    const before = readdirSync(hermesHome);
    expect(before).toEqual([]);

    const result = await runHermesSetup({
      hermesHome,
      dryRun: true,
      // start/fund/verify default to true but dryRun must short-circuit
      // them per contract §5. We deliberately leave them at defaults to
      // exercise the dryRun-overrides-everything guarantee.
    });

    // Post-snapshot: no files anywhere under hermesHome.
    const after = readdirSync(hermesHome);
    expect(after).toEqual([]);
    // Defense-in-depth: glob-style assertion that no `config.yaml.bak.*`
    // landed (the brief explicitly calls this out).
    const allEntries = [...after];
    for (const entry of allEntries) {
      expect(entry).not.toMatch(/config\.yaml\.bak\./);
    }
    // Result still populated for caller inspection.
    expect(result.daemonStarted).toBe(false);
    expect(result.fundedWallets).toEqual([]);
    expect(result.transport.kind).toMatch(/^hermes-/);
  });

  // H-AC-25: `--dry-run` returns a `HermesSetupResult` where `state` is
  // populated from the in-memory plan (so callers can inspect what
  // would be written), but no actual filesystem writes occurred.
  it('H-AC-25: --dry-run returns a populated state without writing files', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-state-'));

    const result = await runHermesSetup({
      hermesHome,
      dryRun: true,
    });

    // The plan-state IS populated so the caller can preview what would
    // be written (contract §5: "plan describes the planned actions
    // without executing any").
    expect(result.state).toBeDefined();
    expect(result.state?.profile.hermesHome).toBe(resolve(hermesHome));
    expect(result.state?.managedFiles.length).toBeGreaterThan(0);
    // But none of those managed files actually exist on disk.
    for (const path of result.state?.managedFiles ?? []) {
      expect(existsSync(path)).toBe(false);
    }
  });

  // H-AC-58: when both `--port` and `--daemon-url` are passed and the
  // URL host:port disagrees with `--port`, `daemonUrl` wins (first-wins)
  // AND a `console.warn` line is emitted with the verbatim format
  // documented in setup-entrypoint-contract.md §2.
  it('H-AC-58: --port + --daemon-url conflict warns; daemonUrl wins', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-port-conflict-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runHermesSetup({
      hermesHome,
      daemonUrl: 'http://127.0.0.1:9200',
      port: 9300,
      // Skip new orchestrator steps — we're testing the warn, not the
      // full lifecycle.
      start: false,
      fund: false,
      verify: false,
    });

    // Warn fired with the verbatim format.
    const warnedLines = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnedLines).toContain(
      'daemon URL host:port (127.0.0.1:9200) does not match --port (9300); using URL',
    );
    // First-wins: result.state.daemonUrl is the URL, not the port-derived URL.
    expect(result.state?.daemonUrl).toBe('http://127.0.0.1:9200');

    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // S4 step 2 — replace-by-default + backup + prior-provider capture
  // (issue #386, contract §4 + parity-matrix.md Layer 4 + H-AC-27..31).
  // ---------------------------------------------------------------------------

  // H-AC-27: default `runHermesSetup` replaces an existing non-DKG
  // memory.provider with the managed DKG block.
  it('H-AC-27: replaces existing non-DKG memory.provider with managed DKG block by default', async () => {
    const { runHermesSetup, setupHermesProfile } = await import('../src/setup.js');
    void runHermesSetup; // silence unused-import in case orchestrator path is not exercised here
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-replace-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n  url: redis://localhost\n');

    setupHermesProfile({ hermesHome });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('# END DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('provider: dkg');
  });

  // H-AC-28: replacement writes a timestamped backup at
  // `<hermesHome>/config.yaml.bak.<unix-ts-ms>`. Bytes equal pre-seeded
  // config.yaml (whole-file backup, not partial).
  it('H-AC-28: replacement writes timestamped backup with verbatim original bytes', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-backup-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: claude-memory\n  api_key: sk-fake\n';
    writeFileSync(configPath, original);

    setupHermesProfile({ hermesHome });

    const entries = readdirSync(hermesHome);
    const backups = entries.filter((e) => /^config\.yaml\.bak\.\d+$/.test(e));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(hermesHome, backups[0]), 'utf-8')).toBe(original);
  });

  // H-AC-29: replacement captures prior provider in adapter state.
  // `setup-state.json.priorMemoryProvider` is `{ provider, configBackupPath, capturedAt }`.
  it('H-AC-29: replacement captures priorMemoryProvider in setup-state.json', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-capture-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    setupHermesProfile({ hermesHome });

    const stateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider).toBeDefined();
    expect(state.priorMemoryProvider.provider).toBe('openai-memory');
    expect(state.priorMemoryProvider.configBackupPath).toMatch(/config\.yaml\.bak\.\d+$/);
    expect(state.priorMemoryProvider.capturedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  // H-AC-29 negative: fresh install (no prior provider) does NOT
  // populate priorMemoryProvider.
  it('H-AC-29 (negative): fresh install does not populate priorMemoryProvider', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-fresh-'));
    // No pre-existing config.yaml.

    setupHermesProfile({ hermesHome });

    const stateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider).toBeUndefined();
    // No backup file either.
    const entries = readdirSync(hermesHome);
    expect(entries.filter((e) => /\.bak\./.test(e))).toEqual([]);
  });

  // H-AC-30 (adapter half): `--preserve-provider` (preserveProvider:true)
  // refuses replacement and throws with the verbatim string from the
  // pre-#386 code so external grep / log scrapers stay stable.
  it('H-AC-30 (adapter): preserveProvider:true throws with verbatim message', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-preserve-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    expect(() => setupHermesProfile({ hermesHome, preserveProvider: true })).toThrow(
      'Refusing to replace existing Hermes memory.provider: redis',
    );
    // No backup written when we throw.
    const entries = readdirSync(hermesHome);
    expect(entries.filter((e) => /\.bak\./.test(e))).toEqual([]);
  });

  // H-AC-31: re-run after a replacement does NOT take a second backup.
  // First-wins on capture (priorMemoryProvider unchanged across re-runs).
  it('H-AC-31: re-run after replacement does not take a second backup (first-wins capture)', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-rerun-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    setupHermesProfile({ hermesHome });

    const firstRunBackups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(firstRunBackups.length).toBe(1);
    const firstStateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const firstState = JSON.parse(firstStateRaw);
    expect(firstState.priorMemoryProvider.provider).toBe('redis');

    // Second run on the now-DKG-selected profile.
    setupHermesProfile({ hermesHome });

    const secondRunBackups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(secondRunBackups).toEqual(firstRunBackups);
    const secondStateRaw = readFileSync(join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'), 'utf-8');
    const secondState = JSON.parse(secondStateRaw);
    // First-wins: same provider, same backup path, same capturedAt.
    expect(secondState.priorMemoryProvider).toEqual(firstState.priorMemoryProvider);
  });

  // H-AC-32: replacement is byte-equivalent across re-runs (idempotency
  // on top of replace-by-default). First run replaces; second run on
  // the now-DKG-selected profile must produce byte-identical config.yaml.
  it('H-AC-32: replacement is byte-equivalent across re-runs', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-byteq-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n');

    setupHermesProfile({ hermesHome });
    const after1 = readFileSync(configPath);

    setupHermesProfile({ hermesHome });
    const after2 = readFileSync(configPath);

    expect(after2.equals(after1)).toBe(true);
  });

  // H-AC-33: replacement on a YAML config that already has DKG marked-
  // non-managed: setup adopts the existing line into the managed block
  // without writing a new provider value AND without taking a backup
  // (no actual provider switch occurred — already-DKG users are
  // upgraded in-place by `markExistingDkgProvider`, not "replaced").
  it('H-AC-33: already-DKG (non-managed) is adopted into the managed block without backup', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-already-dkg-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: dkg\n');

    setupHermesProfile({ hermesHome });

    const after = readFileSync(configPath, 'utf-8');
    expect(after).toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('# END DKG ADAPTER HERMES MANAGED');
    expect(after).toContain('provider: dkg');
    // No backup taken — the adoption path doesn't trigger replacement
    // semantics (no prior non-DKG provider was overwritten).
    const backups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(backups).toEqual([]);
    // No priorMemoryProvider captured either (nothing was actually
    // swapped — same provider before and after).
    const stateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    expect(JSON.parse(stateRaw).priorMemoryProvider).toBeUndefined();
  });

  // H-AC-38: disconnect on a profile with no captured priorMemoryProvider
  // — restore is a noop, disconnect succeeds normally.
  it('H-AC-38: disconnect on profile with no priorMemoryProvider — restore is noop', async () => {
    const { setupHermesProfile, disconnectHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-disconnect-noop-'));
    // No pre-existing config.yaml; fresh install means no prior provider captured.
    setupHermesProfile({ hermesHome });

    const disconnectPlan = disconnectHermesProfile({ hermesHome });
    expect(disconnectPlan.state.status).toBe('disconnected');

    const restoreResult = restoreHermesProfile({ hermesHome });
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.path).toBe('noop');
  });

  // H-AC-39: `dkg hermes uninstall` after a replacement restores prior
  // provider AND removes adapter-owned files. Verifies the post-uninstall
  // config.yaml has the captured provider AND the adapter-owned artifacts
  // (dkg.json, plugin dir, setup-state.json) are gone.
  it('H-AC-39: uninstall after replacement restores prior provider and removes adapter files', async () => {
    const { setupHermesProfile, restoreHermesProfile, uninstallHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-uninstall-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    setupHermesProfile({ hermesHome });

    // Mirror the CLI `runUninstall` order: restore BEFORE uninstall
    // so the captured backup is consumed while it still exists. After
    // uninstall, the adapter state dir is removed AND the prior
    // provider line is back in config.yaml.
    const restoreResult = restoreHermesProfile({ hermesHome });
    expect(restoreResult.ok).toBe(true);
    expect(['surgical', 'backup-file']).toContain(restoreResult.path);

    uninstallHermesProfile({ hermesHome });

    // Adapter artifacts gone.
    expect(existsSync(join(hermesHome, 'dkg.json'))).toBe(false);
    expect(existsSync(join(hermesHome, 'plugins', 'dkg'))).toBe(false);
    expect(existsSync(join(hermesHome, '.dkg-adapter-hermes'))).toBe(false);
    // Prior provider restored in config.yaml.
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toContain('provider: openai-memory');
    expect(post).not.toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
  });

  // ---------------------------------------------------------------------------
  // S4 step 3 — restoreHermesProfile primitive
  // (issue #386, contract §6 + QA addendum §10C #1 + H-AC-34..36).
  // ---------------------------------------------------------------------------

  // H-AC-34: restore after replacement puts back the prior provider via
  // the surgical line-rewrite path. Verifies the path discriminator is
  // 'surgical' and the post-restore config has the captured provider.
  it('H-AC-34: restoreHermesProfile via surgical path after replacement', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-surgical-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: redis\n  url: redis://x\n');

    setupHermesProfile({ hermesHome });
    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('surgical');
    expect(result.restoredProvider).toBe('redis');
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toContain('provider: redis');
    expect(post).not.toContain('# BEGIN DKG ADAPTER HERMES MANAGED');
  });

  // H-AC-35: restore falls back to backup-file when the surgical path
  // cannot find an active provider line (e.g. user manually deleted
  // the memory: block from config.yaml between setup and restore).
  it('H-AC-35: restoreHermesProfile falls back to backup-file when surgical path fails', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-backup-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: openai-memory\n  api_key: sk-fake\n';
    writeFileSync(configPath, original);

    setupHermesProfile({ hermesHome });
    // Simulate user deleting the entire memory: block after setup.
    // The managed block remains (since DKG was selected), but no
    // surgical-rewriteable provider line will exist after we strip it.
    writeFileSync(configPath, '# BEGIN DKG ADAPTER HERMES MANAGED\nmemory:\n  provider: dkg\n# END DKG ADAPTER HERMES MANAGED\n');

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('backup-file');
    expect(result.restoredFrom).toMatch(/config\.yaml\.bak\.\d+$/);
    // Whole-file restore: post-restore config matches the original bytes.
    const post = readFileSync(configPath, 'utf-8');
    expect(post).toBe(original);
  });

  // H-AC-36: restore reports `path: 'failed'` when both surgical AND
  // backup-file paths fail (e.g. operator deleted the backup file
  // AND the active config doesn't have an active provider line).
  it('H-AC-36: restoreHermesProfile returns failed when both paths fail', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-failed-'));
    const configPath = join(hermesHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: claude-memory\n');

    setupHermesProfile({ hermesHome });
    // Delete the backup file (operator cleanup) AND strip the memory
    // block from config.yaml (so surgical also fails).
    const backups = readdirSync(hermesHome).filter((e) => /\.bak\./.test(e));
    expect(backups.length).toBe(1);
    rmSync(join(hermesHome, backups[0]));
    writeFileSync(configPath, '# unrelated config\nlogger:\n  level: info\n');

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(false);
    expect(result.path).toBe('failed');
    expect(result.restoreError).toContain('surgical');
    expect(result.restoreError).toContain('backup-file');
  });

  // restoreHermesProfile noop: nothing to restore when no
  // priorMemoryProvider was captured (fresh install).
  it('restoreHermesProfile noop on fresh install', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-restore-noop-'));
    // No pre-existing config.yaml; setup writes a fresh DKG-only one.
    setupHermesProfile({ hermesHome });

    const result = restoreHermesProfile({ hermesHome });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('noop');
    expect(result.restoredProvider).toBeUndefined();
    expect(result.restoredFrom).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // S4 close — adversarial-flagged regressions (issue #386,
  // adversarial-findings.md vectors 1, 5, 6).
  // ---------------------------------------------------------------------------

  // H-AC-26: --dry-run with a pre-seeded non-DKG memory.provider does
  // NOT write a `config.yaml.bak.*` (matrix calls this out as the
  // "critical brief callout"). Adversarial reviewer's vector 1 prevention
  // proof — this seals the seam against a future refactor that drops
  // the dry-run short-circuit before the destructive rewrite.
  it('H-AC-26: --dry-run with pre-seeded non-DKG provider writes no backup', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-dryrun-replace-'));
    const configPath = join(hermesHome, 'config.yaml');
    const original = 'memory:\n  provider: redis\n';
    writeFileSync(configPath, original);

    const result = await runHermesSetup({ hermesHome, dryRun: true });

    // Dry-run completed without throwing.
    expect(result.daemonStarted).toBe(false);
    // No backup written.
    const backups = readdirSync(hermesHome).filter((e) => /^config\.yaml\.bak\./.test(e));
    expect(backups).toEqual([]);
    // config.yaml unchanged.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  // H-AC-48: backup file lands inside the resolved profile directory
  // when `--profile <name>` was passed, NOT under the default
  // `~/.hermes/`. Adversarial reviewer's vector 5 prevention proof —
  // this seals the seam against a future refactor of `resolveHermesProfile`
  // that introduces a `~/.hermes` shortcut bypassing profile resolution.
  it('H-AC-48: --profile <name> + replacement → backup lands inside profile dir', async () => {
    const { runHermesSetup } = await import('../src/setup.js');
    const profileHome = mkdtempSync(join(tmpdir(), 'hermes-profile-research-'));
    const configPath = join(profileHome, 'config.yaml');
    writeFileSync(configPath, 'memory:\n  provider: openai-memory\n');

    // Pass `hermesHome` directly to override `--profile`'s default
    // `~/.hermes/profiles/research` — same effective semantics for
    // path-routing purposes (the H-AC-48 invariant is "backup goes
    // under the resolved hermesHome, never under the default home").
    await runHermesSetup({
      hermesHome: profileHome,
      profile: 'research',
      start: false,
      fund: false,
      verify: false,
    });

    // Backup must be inside the explicit profileHome — NOT under
    // `~/.hermes` or any other default.
    const backups = readdirSync(profileHome).filter((e) => /^config\.yaml\.bak\.\d+$/.test(e));
    expect(backups.length).toBe(1);
    // Defense-in-depth: the captured configBackupPath in setup-state
    // must also point inside profileHome.
    const stateRaw = readFileSync(
      join(profileHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const state = JSON.parse(stateRaw);
    expect(state.priorMemoryProvider.configBackupPath.startsWith(profileHome)).toBe(true);
  });

  // Vector 6 regression: SIGINT-safe ordering. Simulate the
  // partial-state interrupt (dkg.json + managed config.yaml + orphan
  // .bak.<ts> WITHOUT setup-state.json) and assert that re-running
  // setupHermesProfile recovers cleanly: the orphan backup is
  // preserved, AND priorMemoryProvider is restored from the orphan
  // (or — under the adversarial-findings.md option-2 fix — the
  // intent-write recovery path takes over).
  //
  // With the option-2 fix in place, the new contract is: re-running
  // setupHermesProfile after a SIGINT-induced partial state finds
  // the orphan backup at `<configPath>.bak.*`. Because `existingState`
  // is null AFTER the interrupt (setup-state.json never landed), the
  // re-run treats the situation as a fresh install where the active
  // config is already DKG-managed. The orphan backup is preserved on
  // disk so the operator can manually invoke `restoreHermesProfile`
  // pointing at it, OR the adversarial-reviewer's option-1 backup-scan
  // can be added later. This test pins the current option-2 behavior:
  // re-run does NOT delete or churn the orphan backup, and writes
  // setup-state.json with `priorMemoryProvider` derived from
  // `peekProviderSwapIntent` (which returns null when the active
  // config is already DKG-managed → no new capture).
  it('vector-6 regression: SIGINT mid-execute leaves orphan backup; re-run preserves it', async () => {
    const { setupHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-sigint-'));
    const configPath = join(hermesHome, 'config.yaml');

    // Simulate the partial-interrupt state: dkg.json + managed
    // config.yaml + orphan .bak.<ts>. setup-state.json deliberately
    // absent, mirroring an interrupt between the destructive rewrite
    // and the state-write under the PRE-fix code path.
    mkdirSync(join(hermesHome, '.dkg-adapter-hermes'), { recursive: true });
    // dkg.json — owner-marked so re-run doesn't refuse-to-overwrite.
    writeFileSync(
      join(hermesHome, 'dkg.json'),
      JSON.stringify({
        managedBy: '@origintrail-official/dkg-adapter-hermes',
        daemon_url: 'http://127.0.0.1:9200',
      }) + '\n',
    );
    // Plugin dir — ownership-marked so the re-run doesn't refuse.
    mkdirSync(join(hermesHome, 'plugins', 'dkg'), { recursive: true });
    writeFileSync(
      join(hermesHome, 'plugins', 'dkg', '.dkg-adapter-hermes-owner.json'),
      JSON.stringify({
        managedBy: '@origintrail-official/dkg-adapter-hermes',
      }) + '\n',
    );
    // Active config: already-DKG with the managed block (post-rewrite).
    writeFileSync(
      configPath,
      'memory:\n  # BEGIN DKG ADAPTER HERMES MANAGED\n  provider: dkg\n  # END DKG ADAPTER HERMES MANAGED\n',
    );
    // Orphan backup: redis config that the interrupted setup captured.
    const orphanBackupPath = `${configPath}.bak.1700000000000`;
    writeFileSync(orphanBackupPath, 'memory:\n  provider: redis\n  url: redis://x\n');

    // Re-run setup (no `setup-state.json` exists yet — the SIGINT-induced
    // partial state).
    setupHermesProfile({ hermesHome });

    // Orphan backup MUST still be on disk — re-run did not delete it.
    expect(existsSync(orphanBackupPath)).toBe(true);
    expect(readFileSync(orphanBackupPath, 'utf-8')).toBe(
      'memory:\n  provider: redis\n  url: redis://x\n',
    );
    // setup-state.json now exists.
    const stateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const state = JSON.parse(stateRaw);
    expect(state.managedBy).toBe('@origintrail-official/dkg-adapter-hermes');
    // Under the option-2 fix, `peekProviderSwapIntent` reads the
    // already-DKG active config and returns null — no new capture.
    // The operator can manually invoke restoreHermesProfile pointing
    // at the orphan, or a future option-1 backup-scan helper can
    // promote the orphan into priorMemoryProvider. Either way, the
    // orphan is preserved on disk (above) — no silent loss.
    expect(state.priorMemoryProvider).toBeUndefined();
  });

  // Vector 6 regression — happy path: SIGINT BEFORE the destructive
  // rewrite (i.e., AFTER the pre-write of setup-state.json with
  // intended priorMemoryProvider) leaves recoverable state. The
  // option-2 fix's whole point: a re-run sees existingState
  // .priorMemoryProvider already populated and first-wins keeps it.
  it('vector-6 regression: pre-write intent survives interrupt; re-run preserves first-wins capture', async () => {
    const { setupHermesProfile, restoreHermesProfile } = await import('../src/setup.js');
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-sigint-prewrite-'));
    const configPath = join(hermesHome, 'config.yaml');
    const originalRedis = 'memory:\n  provider: redis\n';
    writeFileSync(configPath, originalRedis);

    // First setup completes normally, but we capture the
    // priorMemoryProvider snapshot for the assertion below.
    setupHermesProfile({ hermesHome });
    const firstStateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const firstState = JSON.parse(firstStateRaw);
    expect(firstState.priorMemoryProvider.provider).toBe('redis');
    const firstBackup = firstState.priorMemoryProvider.configBackupPath;
    expect(existsSync(firstBackup)).toBe(true);

    // Re-run after a hypothetical interrupt: setup-state.json exists
    // (pre-write happened), config.yaml is managed-DKG. First-wins
    // semantics keep the original priorMemoryProvider, NOT a new
    // capture from the post-rewrite state.
    setupHermesProfile({ hermesHome });
    const secondStateRaw = readFileSync(
      join(hermesHome, '.dkg-adapter-hermes', 'setup-state.json'),
      'utf-8',
    );
    const secondState = JSON.parse(secondStateRaw);
    expect(secondState.priorMemoryProvider).toEqual(firstState.priorMemoryProvider);

    // Restore via the original captured backup still works.
    const restored = restoreHermesProfile({ hermesHome });
    expect(restored.ok).toBe(true);
    expect(['surgical', 'backup-file']).toContain(restored.path);
  });
});

describe('Hermes Python provider', () => {
  it('persists turn identity sequence across provider restarts', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-provider-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

def make_provider():
    provider = module.DKGMemoryProvider()
    provider._config = {"profile_name": "dev"}
    provider._agent_name = "agent"
    provider._session_id = module._scoped_session_id("session-1", provider._config)
    provider._cache = module._load_cache("agent")
    provider._offline = True
    provider._client = None
    return provider

first = make_provider()
first.sync_turn("same user", "same assistant")
second = make_provider()
second.sync_turn("same user", "same assistant")

cache = module._load_cache("agent")
turns = [item for item in cache["queued_writes"] if item.get("type") == "turn"]
assert len(turns) == 2, turns
assert turns[0]["turn_id"] != turns[1]["turn_id"], turns
assert turns[0]["idempotency_key"] != turns[1]["idempotency_key"], turns
assert turns[0]["turn_id"].split(":")[-2] == "1", turns
assert turns[1]["turn_id"].split(":")[-2] == "2", turns
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('CLI sync preserves queued turn idempotency fields', () => {
    const script = String.raw`
import importlib.util
import sys
import types
from pathlib import Path

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"

pkg = types.ModuleType("plugins.memory.dkg")
pkg.__path__ = [str(plugin_dir)]
pkg._load_config = lambda: {"daemon_url": "http://127.0.0.1:9200", "agent_name": "agent"}
cache = {
    "queued_writes": [{
        "type": "turn",
        "session_id": "session-1",
        "user": "hello",
        "assistant": "hi",
        "turn_id": "turn-123",
        "idempotency_key": "idem-123",
    }]
}
saved = []
pkg._load_cache = lambda agent_name: cache
pkg._save_cache = lambda next_cache, agent_name: saved.append((next_cache, agent_name))

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")
sys.modules["plugins.memory.dkg"] = pkg

store_calls = []
client_mod = types.ModuleType("plugins.memory.dkg.client")
class DKGClient:
    def __init__(self, base_url, **kwargs):
        self.base_url = base_url
    def health_check(self):
        return True
    def store_turn(self, session_id, user, assistant, agent_name="", turn_id="", idempotency_key=""):
        store_calls.append({
            "session_id": session_id,
            "user": user,
            "assistant": assistant,
            "agent_name": agent_name,
            "turn_id": turn_id,
            "idempotency_key": idempotency_key,
        })
        return {"success": True}
    def close(self):
        pass
client_mod.DKGClient = DKGClient
sys.modules["plugins.memory.dkg.client"] = client_mod

click = types.ModuleType("click")
click.echo = lambda *args, **kwargs: None
click.argument = lambda *args, **kwargs: (lambda fn: fn)
class FakeGroup:
    def __init__(self):
        self.commands = {}
    def group(self, name):
        def decorate(fn):
            group = FakeGroup()
            self.commands[name] = group
            return group
        return decorate
    def command(self, name):
        def decorate(fn):
            self.commands[name] = fn
            return fn
        return decorate
click.Group = FakeGroup
sys.modules["click"] = click

spec = importlib.util.spec_from_file_location("plugins.memory.dkg.cli", plugin_dir / "cli.py")
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg.cli"] = module
spec.loader.exec_module(module)

root = FakeGroup()
module.register_cli(root)
root.commands["dkg"].commands["sync"]()

assert store_calls == [{
    "session_id": "session-1",
    "user": "hello",
    "assistant": "hi",
    "agent_name": "agent",
    "turn_id": "turn-123",
    "idempotency_key": "idem-123",
}], store_calls
assert saved[0][0]["queued_writes"] == [], saved
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses assertion-scoped reads for prefetch without requiring an agent-scoped token', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-prefetch-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

client = client_module.DKGClient("http://127.0.0.1:9200")
client_calls = []
def post(path, data=None):
    client_calls.append((path, data or {}))
    return {"quads": []}
client._post = post
client.query_assertion("hermes", "cg:test", "SELECT ?s ?p ?o WHERE { ?s ?p ?o }")
assert client_calls == [
    (
        "/api/assertion/hermes/query",
        {
            "contextGraphId": "cg:test",
            "sparql": "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        },
    )
], client_calls
client.query_assertion("hermes", "cg:test")
assert client_calls[-1] == ("/api/assertion/hermes/query", {"contextGraphId": "cg:test"}), client_calls

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class FakeClient:
    def __init__(self):
        self.calls = []

    def query_assertion(self, assertion_name, context_graph_id, sparql=""):
        self.calls.append((assertion_name, context_graph_id, sparql))
        return {
            "quads": [
                {
                    "subject": "urn:hermes:agent:memory",
                    "predicate": "urn:hermes:content",
                    "object": "Needle fact from DKG",
                }
            ]
        }

    def query(self, *args, **kwargs):
        raise AssertionError("prefetch should use the assertion-scoped query path")

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = FakeClient()
provider._assertion_id = "hermes"
provider._context_graph = "cg:test"
text = provider.prefetch("Needle")

assert len(provider._client.calls) == 1, provider._client.calls
assert provider._client.calls[0][0] == "hermes", provider._client.calls
assert provider._client.calls[0][1] == "cg:test", provider._client.calls
assert "SELECT ?s ?p ?o" in provider._client.calls[0][2], provider._client.calls
assert "CONTAINS" in provider._client.calls[0][2], provider._client.calls
assert "Needle fact from DKG" in text, text
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('exposes the DKG V10 tool names from OpenClaw and the node skill to Hermes agents', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-tools-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

provider = module.DKGMemoryProvider()
names = sorted(schema["name"] for schema in provider.get_tool_schemas())
expected_default = [
    "dkg_assertion_create",
    "dkg_assertion_discard",
    "dkg_assertion_history",
    "dkg_assertion_import_file",
    "dkg_assertion_promote",
    "dkg_assertion_query",
    "dkg_assertion_write",
    "dkg_context_graph_create",
    "dkg_context_graph_invite",
    "dkg_find_agents",
    "dkg_invoke_skill",
    "dkg_join_request_approve",
    "dkg_join_request_list",
    "dkg_join_request_reject",
    "dkg_list_context_graphs",
    "dkg_participant_add",
    "dkg_participant_list",
    "dkg_participant_remove",
    "dkg_publish",
    "dkg_query",
    "dkg_read_messages",
    "dkg_send_message",
    "dkg_shared_memory_publish",
    "dkg_status",
    "dkg_sub_graph_create",
    "dkg_sub_graph_list",
    "dkg_subscribe",
    "dkg_wallet_balances",
    "memory_search",
]
missing = [name for name in expected_default if name not in names]
assert missing == [], missing
subscribe_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_subscribe")
assert "include_shared_memory" in subscribe_schema["parameters"]["properties"], subscribe_schema
search_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "memory_search")
assert "context_graph_id" in search_schema["parameters"]["properties"], search_schema
assert "context_graph" not in search_schema["parameters"]["properties"], search_schema
query_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_query")
assert "sub_graph_name" not in query_schema["parameters"]["properties"], query_schema
share_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_share")
assert "context_graph_id" in share_schema["parameters"]["properties"], share_schema
assert "context_graph" not in share_schema["parameters"]["properties"], share_schema
# sub_graph_name is in the schema so MCP clients can pass it portably
# (#413 — _handle_share already forwards it; the schema exposure was missing).
assert "sub_graph_name" in share_schema["parameters"]["properties"], share_schema
# context_graph_id is required on Hermes too, matching OpenClaw's contract
# (#413 unification — no implicit current-project fallback).
assert share_schema["parameters"]["required"] == ["content", "context_graph_id"], share_schema
missing_cg = provider.handle_tool_call("dkg_share", {"content": "alpha"})
assert "context_graph_id is required" in missing_cg, missing_cg

provider._config = {
    "publish_tool": "disabled",
    "allow_direct_publish": False,
    "allow_context_graph_admin_tools": False,
}
disabled_names = sorted(schema["name"] for schema in provider.get_tool_schemas())
assert "dkg_publish" not in disabled_names, disabled_names
assert "dkg_shared_memory_publish" not in disabled_names, disabled_names
assert "dkg_context_graph_invite" not in disabled_names, disabled_names
guarded = provider.handle_tool_call("dkg_shared_memory_publish", {"context_graph_id": "cg:test"})
assert "disabled by the adapter publish guard" in guarded, guarded
admin_guarded = provider.handle_tool_call("dkg_participant_add", {"context_graph_id": "cg:test", "agent_address": "0xabc"})
assert "Context graph admin tools are disabled" in admin_guarded, admin_guarded

provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
direct_schemas = provider.get_tool_schemas()
direct_names = sorted(schema["name"] for schema in direct_schemas)
for name in ["dkg_publish", "dkg_shared_memory_publish"]:
    assert name in direct_names, direct_names
publish_schema = next(schema for schema in direct_schemas if schema["name"] == "dkg_publish")
quad_props = publish_schema["parameters"]["properties"]["quads"]["items"]["properties"]
assert "graph" in quad_props, publish_schema

provider._config = {
    "publish_tool": "direct",
    "allow_direct_publish": True,
    "allow_context_graph_admin_tools": True,
}
operator_names = sorted(schema["name"] for schema in provider.get_tool_schemas())
for name in [
    "dkg_context_graph_invite",
    "dkg_participant_add",
    "dkg_participant_remove",
    "dkg_join_request_approve",
    "dkg_join_request_reject",
]:
    assert name in operator_names, operator_names
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('routes Hermes parity tools to DKG V10 daemon endpoints', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-tool-routes-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

client = client_module.DKGClient("http://127.0.0.1:9200")
calls = []
client._post = lambda path, data=None: calls.append(("POST", path, data or {})) or {"ok": True}
client._get = lambda path: calls.append(("GET", path, {})) or {"ok": True}

bad_cg = client.create_context_graph("Bad", cg_id="Bad:Id")
assert bad_cg["success"] is False, bad_cg
client.create_context_graph("My Project", "desc")
# T-PRIVACY: client passes accessPolicy + allowedAgents through to the daemon
# verbatim when supplied, and omits them when not. The CLIENT layer does NOT
# validate address format; that's the tool handler's job — the client just
# forwards bytes to the daemon for the cases where a programmatic caller has
# already validated upstream.
client.create_context_graph("Curated", "private cg", access_policy=1)
client.create_context_graph(
    "Team",
    "shared",
    access_policy=1,
    allowed_agents=["0x" + "a" * 40, "0x" + "B" * 40],
)

# Round 3 — access_policy=True (Python bool, which is a subclass of int)
# would have silently sent JSON true to the daemon under the previous
# isinstance(access_policy, int) check; the daemon's typeof check would
# then drop the field and resolve to default-public, the opposite of a
# programmatic caller's intent. Now rejected at the client layer with a
# clear error before any daemon contact.
bool_true_result = client.create_context_graph("BoolTrue", "x", access_policy=True)
assert bool_true_result["success"] is False, bool_true_result
assert "access_policy" in bool_true_result["error"], bool_true_result
bool_false_result = client.create_context_graph("BoolFalse", "x", access_policy=False)
assert bool_false_result["success"] is False, bool_false_result
# Round 3 — only meaningful values {0, 1} accepted; other ints rejected.
out_of_range = client.create_context_graph("Two", "x", access_policy=2)
assert out_of_range["success"] is False, out_of_range
assert "0" in out_of_range["error"] and "1" in out_of_range["error"], out_of_range
# access_policy=0 is the open/discoverable value — accepted.
client.create_context_graph("OpenExplicit", "x", access_policy=0)

client.subscribe("cg:test", include_shared_memory=True)
client.write_assertion("a b", "cg:test", [{"subject": "urn:s", "predicate": "urn:p", "object": '"o"'}], "sub")
client.discard_assertion("a b", "cg:test")
client.assertion_history("a b", "cg:test", agent_address="agent", sub_graph_name="sub")
client.create_sub_graph("cg:test", "notes")
client.list_sub_graphs("cg:test")
client.invite_to_context_graph("cg:test", "peer")
client.add_participant("cg:test", "agent")
client.list_join_requests("cg:test")
client.publish("cg:test", selection=["urn:root"], clear_after=False, sub_graph_name="sub")

_VALID_ADDR_A = "0x" + "a" * 40
_VALID_ADDR_B = "0x" + "B" * 40

assert calls == [
    ("POST", "/api/context-graph/create", {"id": "my-project", "name": "My Project", "description": "desc"}),
    ("POST", "/api/context-graph/create", {"id": "curated", "name": "Curated", "description": "private cg", "accessPolicy": 1}),
    ("POST", "/api/context-graph/create", {"id": "team", "name": "Team", "description": "shared", "accessPolicy": 1, "allowedAgents": [_VALID_ADDR_A, _VALID_ADDR_B]}),
    ("POST", "/api/context-graph/create", {"id": "openexplicit", "name": "OpenExplicit", "description": "x", "accessPolicy": 0}),
    ("POST", "/api/context-graph/subscribe", {"contextGraphId": "cg:test", "includeSharedMemory": True}),
    ("POST", "/api/assertion/a%20b/write", {"contextGraphId": "cg:test", "quads": [{"subject": "urn:s", "predicate": "urn:p", "object": '"o"'}], "subGraphName": "sub"}),
    ("POST", "/api/assertion/a%20b/discard", {"contextGraphId": "cg:test"}),
    ("GET", "/api/assertion/a%20b/history?contextGraphId=cg%3Atest&agentAddress=agent&subGraphName=sub", {}),
    ("POST", "/api/sub-graph/create", {"contextGraphId": "cg:test", "subGraphName": "notes"}),
    ("GET", "/api/sub-graph/list?contextGraphId=cg%3Atest", {}),
    ("POST", "/api/context-graph/invite", {"contextGraphId": "cg:test", "peerId": "peer"}),
    ("POST", "/api/context-graph/cg%3Atest/add-participant", {"agentAddress": "agent"}),
    ("GET", "/api/context-graph/cg%3Atest/join-requests", {}),
    ("POST", "/api/shared-memory/publish", {"contextGraphId": "cg:test", "selection": ["urn:root"], "clearAfter": False, "subGraphName": "sub"}),
], calls

client_identity = client_module.DKGClient("http://127.0.0.1:9200")
def fake_get(path):
    if path == "/api/agent/identity":
        return {"peerId": "peer-from-identity"}
    raise AssertionError(path)
client_identity._get = fake_get
assert client_identity._resolve_agent_address() == "peer-from-identity"
assert client_identity._agent_identity_loaded is False

client_status = client_module.DKGClient("http://127.0.0.1:9200")
def fake_status_get(path):
    if path == "/api/agent/identity":
        return {"success": False}
    if path == "/api/status":
        return {"peerId": "peer-from-status"}
    raise AssertionError(path)
client_status._get = fake_status_get
assert client_status._resolve_agent_address() == "peer-from-status"
assert client_status._agent_identity_loaded is False

client_retry = client_module.DKGClient("http://127.0.0.1:9200")
retry_calls = {"count": 0}
def fake_retry_get(path):
    retry_calls["count"] += 1
    if retry_calls["count"] <= 2:
        return {"success": False}
    if path == "/api/agent/identity":
        return {"peerId": "peer-after-retry"}
    raise AssertionError(path)
client_retry._get = fake_retry_get
assert client_retry._resolve_agent_address() is None
assert client_retry._agent_identity_loaded is False
assert client_retry._resolve_agent_address() == "peer-after-retry"
assert client_retry._agent_identity_loaded is False

client_agent_later = client_module.DKGClient("http://127.0.0.1:9200")
later_calls = {"count": 0}
def fake_later_get(path):
    later_calls["count"] += 1
    if path == "/api/agent/identity" and later_calls["count"] == 1:
        return {"peerId": "peer-before-agent"}
    if path == "/api/agent/identity":
        return {"agentAddress": "0xAgent"}
    raise AssertionError(path)
client_agent_later._get = fake_later_get
assert client_agent_later._resolve_agent_address() == "peer-before-agent"
assert client_agent_later._agent_identity_loaded is False
assert client_agent_later._resolve_agent_address() == "0xAgent"
assert client_agent_later._agent_identity_loaded is True
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('enforces OpenClaw-parity Hermes tool contracts', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-contracts-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: json.dumps({"error": message})
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

client = client_module.DKGClient("http://127.0.0.1:9200")
client._post = lambda path, data=None: {"success": False, "error": "Assertion already exists"}
exists = client.create_assertion("cg:test", "Hermes")
assert exists["success"] is True and exists["alreadyExists"] is True, exists

class FakeError(Exception):
    pass

class FakeResponse:
    text = '{"error":"Assertion already exists"}'

    def json(self):
        return {"error": "Assertion already exists"}

    def raise_for_status(self):
        err = FakeError("400 Client Error")
        err.response = self
        raise err

class FakeSession:
    def post(self, *args, **kwargs):
        return FakeResponse()

client_http = client_module.DKGClient("http://127.0.0.1:9200")
client_http._session = FakeSession()
exists_http = client_http.create_assertion("cg:test", "Hermes")
assert exists_http["success"] is True and exists_http["alreadyExists"] is True, exists_http

created_assertions = []

class ExistingAssertionClient:
    def __init__(self, base_url, **kwargs):
        self.base_url = base_url

    def health_check(self):
        return True

    def create_assertion(self, context_graph_id, name):
        created_assertions.append((context_graph_id, name))
        return {"success": True, "alreadyExists": True}

provider_existing = module.DKGMemoryProvider()
module._load_config = lambda: {
    "daemon_url": "http://127.0.0.1:9200",
    "context_graph": "cg:test",
    "agent_name": "HermesAgent",
}
module._load_cache = lambda agent_name: {"memory": [], "user": [], "queued_writes": []}
client_module.DKGClient = ExistingAssertionClient
provider_existing._backlog_import_if_needed = lambda hermes_home: None
provider_existing.initialize("session-1")
assert provider_existing._assertion_id == "memory", provider_existing._assertion_id
assert created_assertions == [("cg:test", "memory")], created_assertions

class QueryClient:
    def __init__(self):
        self.queries = []

    def _resolve_agent_address(self):
        return "peer-default"

    def query(self, sparql, context_graph_id, **kwargs):
        self.queries.append((sparql, context_graph_id, kwargs))
        return {"ok": True}

provider = module.DKGMemoryProvider()
provider._offline = False
provider._context_graph = "default-cg"
provider._client = QueryClient()

for args, needle in [
    ({"sparql": "ASK {}", "paranet_id": "old"}, "paranet_id"),
    ({"sparql": "ASK {}", "include_shared_memory": True}, "include_shared_memory"),
    ({"sparql": "ASK {}", "context_graph": "old"}, "context_graph"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "bad"}, "view"),
    ({"sparql": "ASK {}", "view": "working-memory"}, "context_graph_id"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "shared-working-memory", "sub_graph_name": "scratch"}, "sub_graph_name"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "working-memory", "agent_address": "   "}, "agent_address"),
]:
    result = json.loads(provider.handle_tool_call("dkg_query", args))
    assert needle in result["error"], (args, result)

result = json.loads(provider.handle_tool_call("dkg_query", {
    "sparql": "ASK {}",
    "context_graph_id": "cg:test",
    "view": "working-memory",
    "agent_address": "did:dkg:agent:peer-explicit",
}))
assert result["ok"] is True, result
assert provider._client.queries[-1][2]["agent_address"] == "peer-explicit", provider._client.queries

result = json.loads(provider.handle_tool_call("dkg_query", {
    "sparql": "ASK {}",
    "context_graph_id": "cg:test",
    "view": "working-memory",
}))
assert result["ok"] is True, result
assert provider._client.queries[-1][2]["agent_address"] == "peer-default", provider._client.queries
provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
for tool_name, args in [
    ("memory_search", {"query": "alpha beta", "context_graph": "legacy"}),
    ("dkg_share", {"content": "alpha", "context_graph": "legacy"}),
    ("dkg_shared_memory_publish", {"context_graph": "legacy"}),
    ("dkg_assertion_write", {
        "context_graph": "legacy",
        "name": "notes",
        "quads": [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}],
    }),
]:
    result = json.loads(provider.handle_tool_call(tool_name, args))
    assert "context_graph" in result["error"], (tool_name, result)

class MessageClient:
    def __init__(self):
        self.paths = []

    def _get(self, path):
        self.paths.append(path)
        return {"ok": True}

provider._client = MessageClient()
result = json.loads(provider.handle_tool_call("dkg_read_messages", {
    "peer": "peer one",
    "limit": 10,
    "since": "123",
}))
assert result["ok"] is True, result
assert provider._client.paths == ["/api/messages?peer=peer+one&limit=10&since=123"], provider._client.paths

class InviteClient:
    def invite_to_context_graph(self, context_graph_id, peer_id):
        return {"success": True, "contextGraphId": context_graph_id}

    def status(self):
        return {
            "multiaddrs": [
                "/ip4/127.0.0.1/tcp/8900/p2p/peer-local",
                "/ip4/203.0.113.10/tcp/8900/p2p/peer-public",
                "/ip4/10.0.0.5/tcp/8900/p2p/peer-private",
            ]
        }

provider._config = {
    "publish_tool": "direct",
    "allow_direct_publish": True,
    "allow_context_graph_admin_tools": True,
}
provider._client = InviteClient()
result = json.loads(provider.handle_tool_call("dkg_context_graph_invite", {
    "context_graph_id": "cg:test",
    "peer_id": "peer-friend",
}))
assert result["success"] is True, result
assert result["peerId"] == "peer-friend", result
assert result["curatorMultiaddr"] == "/ip4/203.0.113.10/tcp/8900/p2p/peer-public", result
assert result["inviteCode"] == "cg:test\n/ip4/203.0.113.10/tcp/8900/p2p/peer-public", result

class RegisterFailClient:
    def __init__(self):
        self.published = False

    def register_context_graph(self, context_graph_id, access_policy=None):
        return {"success": False, "error": "wallet missing"}

    def publish(self, *args, **kwargs):
        self.published = True
        raise AssertionError("publish should not run")

provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
provider._client = RegisterFailClient()
result = json.loads(provider.handle_tool_call("dkg_shared_memory_publish", {
    "context_graph_id": "cg:test",
    "register_if_needed": True,
}))
assert result["success"] is False and "wallet missing" in result["error"], result
assert provider._client.published is False

class AlreadyRegisteredClient(RegisterFailClient):
    def register_context_graph(self, context_graph_id, access_policy=None):
        return {"success": False, "error": "context graph already registered"}

    def publish(self, *args, **kwargs):
        self.published = True
        return {"success": True}

provider._client = AlreadyRegisteredClient()
result = json.loads(provider.handle_tool_call("dkg_shared_memory_publish", {
    "context_graph_id": "cg:test",
    "register_if_needed": True,
}))
assert result["success"] is True and provider._client.published is True, result
assert "registration" in result, result

class PublishClient:
    def __init__(self):
        self.shared = None
        self.published = None

    def share(self, context_graph_id, quads, sub_graph_name=None):
        self.shared = (context_graph_id, quads, sub_graph_name)
        return {"success": True}

    def publish(self, context_graph_id, **kwargs):
        self.published = (context_graph_id, kwargs)
        return {"success": True}

provider._client = PublishClient()
result = json.loads(provider.handle_tool_call("dkg_publish", {
    "context_graph_id": "cg:test",
    "quads": [
        {"subject": "urn:root:1", "predicate": "urn:p", "object": "one"},
        {"subject": "urn:root:2", "predicate": "urn:p", "object": "two"},
        {"subject": "urn:root:1", "predicate": "urn:p2", "object": "three"},
    ],
}))
assert result["success"] is True, result
assert result["rootEntities"] == ["urn:root:1", "urn:root:2"], result
assert provider._client.published == (
    "cg:test",
    {"selection": "all", "clear_after": True, "sub_graph_name": ""},
), provider._client.published
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('keeps generated Hermes DKG session IDs within the Node UI reader limit', () => {
    const script = String.raw`
import importlib.util
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-session-id-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: message
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

session_id = module._scoped_session_id(
    "session-" + ("x" * 200),
    {"profile_name": "Profile " + ("y" * 200)},
)
assert session_id.startswith("hermes:dkg:profile-profile-"), session_id
assert len(session_id) <= 128, (len(session_id), session_id)
assert module._scoped_session_id("hermes:dkg:already-scoped", {"profile_name": "ignored"}) == "hermes:dkg:already-scoped"
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('returns SKILL-shaped Hermes memory_search hits across agent and project layers', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class FakeClient:
    def __init__(self):
        self.calls = []

    def _resolve_agent_address(self):
        return "0xAgent"

    def query(self, sparql, context_graph_id, **kwargs):
        self.calls.append((context_graph_id, kwargs))
        return {
            "result": {
                "bindings": [{
                    "uri": {"value": f"urn:{context_graph_id}:{kwargs['view']}"},
                    "pred": {"value": "schema:description"},
                    "text": {"value": f"alpha beta from {context_graph_id} {kwargs['view']}"},
                }],
            },
        }

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = FakeClient()
provider._context_graph = "project-cg"
provider._cache = {}

result = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha beta", "limit": 10}))
assert result["query"] == "alpha beta", result
assert result["scope"] == "project-cg", result
assert result["count"] == 6, result
layers = [hit["layer"] for hit in result["hits"]]
assert set(layers) == {
    "agent-context-wm",
    "agent-context-swm",
    "agent-context-vm",
    "project-wm",
    "project-swm",
    "project-vm",
}, layers
assert layers[:2] == ["agent-context-vm", "project-vm"], layers
assert {hit["source"] for hit in result["hits"] if hit["layer"].startswith("agent-context")} == {"sessions"}, result
assert {hit["source"] for hit in result["hits"] if hit["layer"].startswith("project")} == {"memory"}, result
assert all(hit["score"] == 1.0 for hit in result["hits"]), result
assert all("_rank" not in hit for hit in result["hits"]), result
assert provider._client.calls == [
    ("agent-context", {"view": "working-memory", "agent_address": "0xAgent"}),
    ("agent-context", {"view": "shared-working-memory", "agent_address": None}),
    ("agent-context", {"view": "verified-memory", "agent_address": None}),
    ("project-cg", {"view": "working-memory", "agent_address": "0xAgent"}),
    ("project-cg", {"view": "shared-working-memory", "agent_address": None}),
    ("project-cg", {"view": "verified-memory", "agent_address": None}),
], provider._client.calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses Hermes client peer fallback for memory_search working-memory queries', () => {
    const script = String.raw`
import importlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-peer-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

client_module = importlib.import_module("plugins.memory.dkg.client")
client = client_module.DKGClient("http://127.0.0.1:9200")
calls = []
queries = []
def fake_get(path):
    calls.append(path)
    if path == "/api/agent/identity":
        return {"success": False}
    if path == "/api/status":
        return {"peerId": "peer-from-status"}
    raise AssertionError(path)
def fake_query(sparql, context_graph_id, **kwargs):
    queries.append((context_graph_id, kwargs))
    return {"result": {"bindings": []}}
client._get = fake_get
client.query = fake_query

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = client
provider._context_graph = "agent-context"
provider._cache = {}

result = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert result == {"query": "alpha", "count": 0, "scope": None, "hits": []}, result
assert calls == ["/api/agent/identity", "/api/status"], calls
assert queries[0] == ("agent-context", {"view": "working-memory", "agent_address": "peer-from-status"}), queries
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not return stale cache hits for online DKG memory_search no-hit responses', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-empty-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: json.dumps({"error": message})
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class EmptyClient:
    def _resolve_agent_address(self):
        return "0xAgent"

    def query(self, sparql, context_graph_id, **kwargs):
        return {"result": {"bindings": []}}

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = EmptyClient()
provider._context_graph = "project-cg"
provider._cache = {"memory": [{"target": "memory", "content": "alpha stale cache"}]}

online = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert online == {"query": "alpha", "count": 0, "scope": "project-cg", "hits": []}, online

provider._offline = True
offline = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert offline["offline"] is True and offline["count"] == 1, offline
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('loads Hermes Python client auth from setup-resolved DKG home', () => {
    const script = String.raw`
import importlib.util
import os
import tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix="hermes-dkg-home-"))
default_home = root / "user-home"
default_dkg_home = default_home / ".dkg"
resolved_dkg_home = root / ".dkg-dev"
default_dkg_home.mkdir(parents=True)
resolved_dkg_home.mkdir(parents=True)
(default_dkg_home / "auth.token").write_text("stale-token\n", encoding="utf-8")
(resolved_dkg_home / "auth.token").write_text("# comment\nlive-token\n", encoding="utf-8")

os.environ["HOME"] = str(default_home)
os.environ["USERPROFILE"] = str(default_home)
os.environ.pop("DKG_HOME", None)

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location("dkg_client", plugin_dir / "client.py")
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)

client = client_module.DKGClient("http://127.0.0.1:9200", dkg_home=str(resolved_dkg_home))
assert client._token == "live-token", client._token

os.environ["DKG_AUTH_TOKEN"] = "env-override-token"
env_override_client = client_module.DKGClient("http://127.0.0.1:9200", dkg_home=str(resolved_dkg_home))
assert env_override_client._token == "env-override-token", env_override_client._token
os.environ.pop("DKG_AUTH_TOKEN", None)

env_dkg_home = root / "env-dkg"
env_dkg_home.mkdir()
(env_dkg_home / "auth.token").write_text("env-token\n", encoding="utf-8")
os.environ["DKG_HOME"] = str(env_dkg_home)
env_client = client_module.DKGClient("http://127.0.0.1:9200")
assert env_client._token == "env-token", env_client._token
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uploads Hermes assertion imports as safe multipart requests', () => {
    const script = String.raw`
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-import-"))
plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

safe_file = home / "notes.md"
safe_file.write_text("# Notes", encoding="utf-8")
outside_file = Path(tempfile.mkdtemp(prefix="hermes-dkg-import-outside-")) / "notes.md"
outside_file.write_text("# Outside", encoding="utf-8")
symlink_file = home / "linked-outside.md"
try:
    os.symlink(outside_file, symlink_file)
except (AttributeError, NotImplementedError, OSError):
    symlink_file = None
blocked_dir = home / ".dkg"
blocked_dir.mkdir()
blocked_file = blocked_dir / "auth.token"
blocked_file.write_text("secret", encoding="utf-8")
ssh_dir = home / ".ssh"
ssh_dir.mkdir()
ssh_key = ssh_dir / "id_rsa"
ssh_key.write_text("secret", encoding="utf-8")

calls = []
class FakeResponse:
    def raise_for_status(self):
        pass
    def json(self):
        return {"success": True}

def fake_post(url, data=None, files=None, headers=None, timeout=None):
    calls.append({
        "url": url,
        "data": data,
        "files": files,
        "headers": headers,
        "timeout": timeout,
    })
    return FakeResponse()

requests_module = types.ModuleType("requests")
requests_module.post = fake_post
sys.modules["requests"] = requests_module

client = client_module.DKGClient("http://127.0.0.1:9200", import_roots=[str(home)])
client._token = "secret-token"
result = client.import_assertion_file("assertion name", "cg:test", str(safe_file), sub_graph_name="sub")
assert result == {"success": True}, result
assert len(calls) == 1, calls
call = calls[0]
assert call["url"].endswith("/api/assertion/assertion%20name/import-file"), call
assert call["data"] == {"contextGraphId": "cg:test", "subGraphName": "sub"}, call
assert call["headers"] == {"Accept": "application/json", "Authorization": "Bearer secret-token"}, call
file_tuple = call["files"]["file"]
assert file_tuple[0] == "notes.md", file_tuple
assert file_tuple[2] == "text/markdown", file_tuple

blocked = client.import_assertion_file("assertion", "cg:test", str(blocked_file))
assert blocked["success"] is False, blocked
assert "Refusing to import" in blocked["error"], blocked
blocked_ssh = client.import_assertion_file("assertion", "cg:test", str(ssh_key))
assert blocked_ssh["success"] is False, blocked_ssh
assert "Refusing to import" in blocked_ssh["error"], blocked_ssh
outside = client.import_assertion_file("assertion", "cg:test", str(outside_file))
assert outside["success"] is False, outside
assert "safe roots" in outside["error"], outside
if symlink_file is not None:
    symlinked = client.import_assertion_file("assertion", "cg:test", str(symlink_file))
    assert symlinked["success"] is False, symlinked
    assert "safe roots" in symlinked["error"], symlinked
client_without_roots = client_module.DKGClient("http://127.0.0.1:9200", import_roots=[])
no_roots = client_without_roots.import_assertion_file("assertion", "cg:test", str(safe_file))
assert no_roots["success"] is False, no_roots
assert "safe roots" in no_roots["error"], no_roots
assert len(calls) == 1, calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('flushes queued memory writes without reapplying them to the local cache', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-queue-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class FakeClient:
    def __init__(self):
        self.writes = []

    def write_assertion(self, assertion_name, context_graph_id, quads):
        self.writes.append((assertion_name, context_graph_id, quads))
        return {"success": True}

provider = module.DKGMemoryProvider()
provider._client = FakeClient()
provider._offline = False
provider._assertion_id = "hermes"
provider._context_graph = "cg:test"
provider._agent_name = "agent"
provider._cache = {
    "memory": [{"target": "memory", "content": "cached fact"}],
    "queued_writes": [{"type": "memory", "action": "add", "target": "memory", "content": "cached fact"}],
}

provider._flush_queued_writes()

assert provider._cache["memory"] == [{"target": "memory", "content": "cached fact"}], provider._cache
assert provider._cache["queued_writes"] == [], provider._cache
assert len(provider._client.writes) == 1, provider._client.writes
assert provider._client.writes[0][2] == [{
    "subject": "urn:hermes:agent:memory",
    "predicate": "urn:hermes:content",
    "object": module._quote_literal("[memory]\ncached fact"),
}], provider._client.writes

provider._cache = {"memory": [], "queued_writes": []}
result = json.loads(provider._handle_memory({"action": "add", "target": "memory", "content": "live fact"}))
assert result["store"] == "dkg", result
assert result["queued"] is False, result
assert provider._client.writes[-1][2] == [{
    "subject": "urn:hermes:agent:memory",
    "predicate": "urn:hermes:content",
    "object": module._quote_literal("[memory]\nlive fact"),
}], provider._client.writes

class FailingClient:
    def write_assertion(self, assertion_name, context_graph_id, quads):
        return {"success": False, "error": "bad literal"}

provider._client = FailingClient()
provider._cache = {"memory": [], "queued_writes": []}
result = json.loads(provider._handle_memory({"action": "add", "target": "memory", "content": "queued fact"}))
assert result["store"] == "local_cache", result
assert result["queued"] is True, result
assert provider._cache["queued_writes"] == [{
    "type": "memory",
    "action": "add",
    "target": "memory",
    "content": "queued fact",
    "old_text": "",
}], provider._cache

provider._assertion_id = ""
provider._cache["queued_writes"] = [{"type": "memory", "action": "replace", "target": "memory", "content": "new fact", "old_text": "cached"}]
provider._flush_queued_writes()
assert provider._cache["queued_writes"] == [{"type": "memory", "action": "replace", "target": "memory", "content": "new fact", "old_text": "cached"}], provider._cache
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('dkg_context_graph_create handler defaults to curated and forwards public + allowed_agents', () => {
    // Privacy-by-default flip in Hermes parity:
    //
    // - No `public` and no `allowed_agents` → handler sends accessPolicy: 1
    //   (curated). The agent's createContextGraph flow auto-includes the
    //   creator in DKG_ALLOWED_AGENT (see packages/agent/src/dkg-agent.ts:3962),
    //   so the creator can immediately read/write without a self-invite.
    // - `public: true` → handler drops accessPolicy (daemon resolves to open)
    //   AND drops allowed_agents even if supplied (meaningless on a public CG).
    // - `allowed_agents: [...]` (no `public`) → handler sends accessPolicy: 1
    //   AND allowedAgents.
    // - Whitespace-only / empty / non-string entries in allowed_agents are
    //   filtered out before forwarding.
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-create-cg-defaults-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")
sys.modules["plugins.memory.dkg"] = types.ModuleType("plugins.memory.dkg")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

provider = module.DKGMemoryProvider()
provider._offline = False

class FakeClient:
    def __init__(self):
        self.calls = []
    def create_context_graph(self, name, description="", cg_id=None, *, access_policy=None, allowed_agents=None):
        self.calls.append({
            "name": name,
            "description": description,
            "cg_id": cg_id,
            "access_policy": access_policy,
            "allowed_agents": allowed_agents,
        })
        return {"created": cg_id or name, "uri": f"did:dkg:context-graph:{cg_id or name}"}

client = FakeClient()
provider._client = client

VALID_A = "0x" + "a" * 40
VALID_B = "0x" + "B" * 40

# Default - no public, no allowed_agents -> curated.
provider._handle_create_cg({"name": "Default", "id": "default"})
# Explicit public - accessPolicy dropped, allowed_agents ignored even if
# malformed (validation only runs when public is false, so public CGs never
# raise on bad allowlist content).
provider._handle_create_cg({"name": "Open", "id": "open", "public": True, "allowed_agents": ["not-an-address"]})
# Curated with explicit allowlist (valid 40-hex addresses).
provider._handle_create_cg({"name": "Team", "id": "team", "allowed_agents": [VALID_A, VALID_B]})
# Curated with whitespace-padded valid entries — trimmed but kept.
provider._handle_create_cg({"name": "Trim", "id": "trim", "allowed_agents": [f"  {VALID_A}  ", VALID_B]})
# Round 1 — invalid address must surface as a tool error and NOT call client.
err = json.loads(provider._handle_create_cg({"name": "Bad", "id": "bad", "allowed_agents": [VALID_A, "not-an-address"]}))
assert "error" in err and "Invalid Ethereum address" in err["error"], err
assert "not-an-address" in err["error"], err
# Round 1 — too-short hex value also rejected.
err2 = json.loads(provider._handle_create_cg({"name": "Short", "id": "short", "allowed_agents": ["0xabc"]}))
assert "error" in err2 and "Invalid Ethereum address" in err2["error"], err2

# Round 2 — fail-fast on non-string entries instead of silently dropping
# them. LLMs occasionally emit numbers / dicts / nulls in tool args; if we
# silently drop them, the agent thinks the participant was added when it
# wasn't. Fail with a precise index-scoped error so the agent can correct.
err3 = json.loads(provider._handle_create_cg({"name": "Mixed", "id": "mixed", "allowed_agents": [VALID_A, 42, VALID_B]}))
assert "error" in err3 and "allowed_agents[1]" in err3["error"] and "must be a string" in err3["error"], err3

# Round 2 — fail-fast on empty / whitespace-only entries.
err4 = json.loads(provider._handle_create_cg({"name": "Empty", "id": "empty", "allowed_agents": [VALID_A, "   "]}))
assert "error" in err4 and "allowed_agents[1]" in err4["error"] and ("empty" in err4["error"] or "whitespace" in err4["error"]), err4

# Round 2 — fail-fast on null entries.
err5 = json.loads(provider._handle_create_cg({"name": "Null", "id": "null", "allowed_agents": [VALID_A, None]}))
assert "error" in err5 and "allowed_agents[1]" in err5["error"], err5

# Round 2 — non-list allowed_agents (e.g. dict, string) rejected.
err6 = json.loads(provider._handle_create_cg({"name": "NotList", "id": "notlist", "allowed_agents": "0x1234"}))
assert "error" in err6 and "must be an array" in err6["error"], err6

# Round 2 — non-boolean public rejected (string "yes" should NOT silently
# fall back to curated; the agent gets a clear error).
err7 = json.loads(provider._handle_create_cg({"name": "Yes", "id": "yes", "public": "yes"}))
assert "error" in err7 and "public" in err7["error"] and "boolean" in err7["error"], err7

# Round 2 — non-boolean public rejected (number 1 should NOT be coerced).
err8 = json.loads(provider._handle_create_cg({"name": "One", "id": "one", "public": 1}))
assert "error" in err8 and "public" in err8["error"], err8

assert client.calls[0] == {
    "name": "Default", "description": "", "cg_id": "default",
    "access_policy": 1, "allowed_agents": None,
}, client.calls[0]
assert client.calls[1] == {
    "name": "Open", "description": "", "cg_id": "open",
    "access_policy": None, "allowed_agents": None,
}, client.calls[1]
assert client.calls[2] == {
    "name": "Team", "description": "", "cg_id": "team",
    "access_policy": 1, "allowed_agents": [VALID_A, VALID_B],
}, client.calls[2]
assert client.calls[3] == {
    "name": "Trim", "description": "", "cg_id": "trim",
    "access_policy": 1, "allowed_agents": [VALID_A, VALID_B],
}, client.calls[3]
# All round-1 + round-2 failure paths must NOT have hit the client —
# pre-flight validation.
assert len(client.calls) == 4, client.calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('dkg_share mints unique subjects per call, N-Triples-quotes content, and surfaces snake_case root_entities', () => {
    // Closes OriginTrail/dkg#414 — the same three SWM-write bugs PR #413
    // fixed for OpenClaw, applied to Hermes:
    //   1. Constant subject → publisher upserts and overwrites prior shares.
    //   2. Raw content → storage parser coerces to invalid IRI.
    //   3. Partial _quote_literal escaping → control bytes leak through.
    const script = String.raw`
import importlib.util
import json
import re
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-share-hardening-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")
sys.modules["plugins.memory.dkg"] = types.ModuleType("plugins.memory.dkg")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

provider = module.DKGMemoryProvider()
provider._offline = False
provider._agent_name = "tester"

class CapturingClient:
    def __init__(self):
        self.calls = []
    def share(self, context_graph_id, quads, sub_graph_name=None):
        self.calls.append({
            "context_graph_id": context_graph_id,
            "quads": quads,
            "sub_graph_name": sub_graph_name,
        })
        return {"shareOperationId": f"swm-{len(self.calls)}", "triplesWritten": len(quads)}

client = CapturingClient()
provider._client = client

# Bug 1 fix — successive shares mint distinct subjects so the publisher
# does not upsert and overwrite prior facts.
r1 = json.loads(provider.handle_tool_call("dkg_share", {"content": "first fact", "context_graph_id": "cg:test"}))
r2 = json.loads(provider.handle_tool_call("dkg_share", {"content": "second fact", "context_graph_id": "cg:test"}))
subject1 = client.calls[0]["quads"][0]["subject"]
subject2 = client.calls[1]["quads"][0]["subject"]
assert subject1 != subject2, (subject1, subject2)
assert re.match(r"^urn:hermes:tester:shared:\d+-[0-9a-f]+$", subject1), subject1
assert re.match(r"^urn:hermes:tester:shared:\d+-[0-9a-f]+$", subject2), subject2

# Response shape parity with OpenClaw: subject + snake_case root_entities.
assert r1["subject"] == subject1, r1
assert r1["root_entities"] == [subject1], r1
assert r1.get("rootEntities") is None, r1
assert "shareOperationId" in r1, r1

# Bug 2 fix — content is wrapped as an N-Triples literal (quoted) before
# being handed to the daemon, not as a bare string the storage layer would
# coerce to an IRI.
obj1 = client.calls[0]["quads"][0]["object"]
assert obj1.startswith('"') and obj1.endswith('"'), obj1
assert obj1 == '"first fact"', obj1

# Bug 3 fix — _quote_literal escapes the full ECHAR set (\\, ", \\b, \\t,
# \\n, \\f, \\r) and UCHAR-encodes any other ASCII control bytes (NUL, VT,
# DEL, etc.) so a payload with mixed control characters round-trips cleanly.
r3 = json.loads(provider.handle_tool_call("dkg_share", {
    "content": "a\nb\rc\td\fe\bf \"q\" \\ end",
    "context_graph_id": "cg:test",
}))
obj_echar = client.calls[2]["quads"][0]["object"]
assert obj_echar == '"a\\nb\\rc\\td\\fe\\bf \\"q\\" \\\\ end"', obj_echar

NUL = chr(0x00)
VT = chr(0x0B)
DEL = chr(0x7F)
r4 = json.loads(provider.handle_tool_call("dkg_share", {
    "content": f"x{NUL}y{VT}z{DEL}",
    "context_graph_id": "cg:test",
}))
obj_uchar = client.calls[3]["quads"][0]["object"]
assert obj_uchar == '"x\\u0000y\\u000Bz\\u007F"', obj_uchar

# sub_graph_name still plumbs through, schema unchanged on that axis.
provider.handle_tool_call("dkg_share", {"content": "scoped", "context_graph_id": "cg:test", "sub_graph_name": "protocols"})
assert client.calls[4]["sub_graph_name"] == "protocols", client.calls[4]

# Schema parity with OpenClaw — content + context_graph_id required, sub_graph_name optional.
share_schema = next(s for s in provider.get_tool_schemas() if s["name"] == "dkg_share")
assert share_schema["parameters"]["required"] == ["content", "context_graph_id"], share_schema
assert "sub_graph_name" in share_schema["parameters"]["properties"], share_schema

# Round 1 — type validation at the runtime boundary. Malformed MCP payloads
# must surface a structured tool_error rather than crashing inside
# _quote_literal with AttributeError on .replace.
client.calls.clear()
err_obj = json.loads(provider.handle_tool_call("dkg_share", {"content": {}, "context_graph_id": "cg:test"}))
assert "error" in err_obj and "must be a string" in err_obj["error"], err_obj
err_bool = json.loads(provider.handle_tool_call("dkg_share", {"content": False, "context_graph_id": "cg:test"}))
# False also trips the "Content is required" check before the type check;
# either is acceptable as long as it's a structured error and no daemon call fired.
assert "error" in err_bool, err_bool
err_cg = json.loads(provider.handle_tool_call("dkg_share", {"content": "hello", "context_graph_id": ["cg:test"]}))
assert "error" in err_cg and ("context_graph_id" in err_cg["error"]), err_cg
err_sub = json.loads(provider.handle_tool_call("dkg_share", {"content": "hello", "context_graph_id": "cg:test", "sub_graph_name": 42}))
assert "error" in err_sub and "sub_graph_name" in err_sub["error"], err_sub
assert client.calls == [], client.calls

# Round 2 — daemon failures must pass through untouched. The Python client
# returns failure shapes ({success: False}, {ok: False}, or bare {error: ...})
# on errors (it doesn't throw), so a write that 4xx'd at the daemon would
# otherwise have synthetic subject / root_entities attached, masking the
# failure for chained publish calls. _handle_share routes through
# _client_result_failed() so all three shapes are caught the same way as
# elsewhere in the module.
class FailingClient:
    def __init__(self, failure):
        self.failure = failure
    def share(self, *args, **kwargs):
        return self.failure

for failure_shape in [
    {"success": False, "error": "context graph not registered"},
    {"ok": False, "error": "auth required"},
    {"error": "stream closed"},
]:
    provider._client = FailingClient(failure_shape)
    fail_result = json.loads(provider.handle_tool_call("dkg_share", {"content": "x", "context_graph_id": "cg:test"}))
    assert "subject" not in fail_result, (failure_shape, fail_result)
    assert "root_entities" not in fail_result, (failure_shape, fail_result)
    # Failure result must pass through untouched.
    for key, expected in failure_shape.items():
        assert fail_result.get(key) == expected, (failure_shape, fail_result)
provider._client = client
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
