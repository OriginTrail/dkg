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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';



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

  it('provisions API_SERVER_KEY and API_SERVER_ENABLED in .env for the loopback hermes-openai transport', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const result = setupHermesProfile({ hermesHome });
    const envPath = join(hermesHome, '.env');

    expect(existsSync(envPath)).toBe(true);
    const env = readFileSync(envPath, 'utf-8');
    const keyMatch = env.match(/^API_SERVER_KEY=(.+)$/m);
    expect(keyMatch?.[1] && keyMatch[1].length).toBeGreaterThan(0);
    expect(env).toMatch(/^API_SERVER_ENABLED=true$/m);
    expect(result.state.apiServerKeyConfigured).toBe(true);

    // Re-run is idempotent: the generated key is never regenerated/overwritten.
    const generatedKey = keyMatch![1];
    setupHermesProfile({ hermesHome });
    expect(readFileSync(envPath, 'utf-8')).toContain(`API_SERVER_KEY=${generatedKey}`);
  });

  it('preserves an existing user API_SERVER_KEY (incl. inline comments) and unrelated .env lines', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    // Inline comments must be parsed (dotenv) so the existing key is detected
    // (not overwritten) and an already-true API_SERVER_ENABLED is not duplicated.
    writeFileSync(
      join(hermesHome, '.env'),
      'FOO=bar\nAPI_SERVER_ENABLED=true # on\nAPI_SERVER_KEY=user-secret # mine\n',
    );

    setupHermesProfile({ hermesHome });

    const env = readFileSync(join(hermesHome, '.env'), 'utf-8');
    expect(env).toContain('API_SERVER_KEY=user-secret # mine');
    expect(env).toContain('FOO=bar');
    expect((env.match(/^API_SERVER_ENABLED=/gm) ?? []).length).toBe(1);
  });

  it('does not write .env in dry-run but reports the provisioning action', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    const plan = planHermesSetup({ hermesHome, dryRun: true });

    expect(existsSync(join(hermesHome, '.env'))).toBe(false);
    const envAction = plan.actions.find((action) => action.path.endsWith('.env'));
    // Fresh profile → the dry-run preview must say `create`, not `update`, so it
    // is clear a brand-new secret file is about to be written.
    expect(envAction?.type).toBe('create');
  });

  it('does not provision .env for a remote (non-loopback) gateway transport', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    setupHermesProfile({ hermesHome, gatewayUrl: 'https://hermes.example.com:8642' });

    expect(existsSync(join(hermesHome, '.env'))).toBe(false);
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

  it('does not provision .env when setup aborts (no side effect on failure)', () => {
    const hermesHome = mkdtempSync(join(tmpdir(), 'hermes-profile-'));
    writeFileSync(join(hermesHome, 'config.yaml'), 'memory: # existing provider\n  provider: mem0\n');

    // preserveProvider throws on the existing non-DKG provider BEFORE the
    // (now last) .env provisioning step, so no API_SERVER_KEY is written.
    expect(() => setupHermesProfile({ hermesHome, memoryMode: 'provider', preserveProvider: true }))
      .toThrow('memory.provider: mem0');
    expect(existsSync(join(hermesHome, '.env'))).toBe(false);
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

});
