import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  discoverWorkspace,
  discoverAgentName,
  writeDkgConfig,
  mergeOpenClawConfig,
  writeWorkspaceConfig,
  installCanonicalNodeSkill,
  openclawConfigPath,
  runSetup,
} from '../src/setup.js';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let testDir: string;

function makeTestDir(): string {
  const dir = join(tmpdir(), `dkg-setup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  testDir = makeTestDir();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discoverAgentName
// ---------------------------------------------------------------------------

describe('discoverAgentName', () => {
  it('returns override when provided', () => {
    expect(discoverAgentName('/nonexistent', 'my-agent')).toBe('my-agent');
  });

  it('parses name from IDENTITY.md with Name field', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\n- **Name**: Alice\n- **Role**: Assistant\n');
    expect(discoverAgentName(ws)).toBe('Alice');
  });

  it('parses name from plain Name: format', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# My Agent\nName: Bob\n');
    expect(discoverAgentName(ws)).toBe('Bob');
  });

  it('falls back to generated name when IDENTITY.md has no Name field', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\nJust some text\n');
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  it('falls back to generated name when IDENTITY.md is missing', () => {
    const ws = join(testDir, 'my-workspace');
    mkdirSync(ws, { recursive: true });
    const name = discoverAgentName(ws);
    expect(name).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// writeDkgConfig
// ---------------------------------------------------------------------------

const fakeNetwork = {
  networkName: 'Test Network',
  relays: ['/ip4/1.2.3.4/tcp/9090/p2p/12D3test'],
  defaultContextGraphs: ['testing'],
  defaultNodeRole: 'edge' as const,
  chain: {
    type: 'evm' as const,
    rpcUrl: 'https://rpc.test',
    hubAddress: '0xTEST',
    chainId: 'test:1',
  },
};

describe('writeDkgConfig', () => {
  it('creates a new config from network defaults', () => {
    const dkgHome = join(testDir, '.dkg');
    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('test-agent', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.name).toBe('test-agent');
      expect(config.apiPort).toBe(9200);
      expect(config.nodeRole).toBe('edge');
      expect(config.contextGraphs).toEqual(['testing']);
      expect(config.chain.rpcUrl).toBe('https://rpc.test');
      expect(config.relay).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('merges with existing config without overwriting', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      nodeRole: 'core',
      contextGraphs: ['custom'],
      relay: '/ip4/5.6.7.8/tcp/9090/p2p/existing',
      chain: { type: 'evm', rpcUrl: 'https://custom.rpc', hubAddress: '0xCUSTOM', chainId: 'custom:2' },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('new-agent', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      // Existing values preserved
      expect(config.name).toBe('existing-node');
      expect(config.apiPort).toBe(9300);
      expect(config.nodeRole).toBe('core');
      expect(config.contextGraphs).toEqual(['custom']);
      expect(config.relay).toBe('/ip4/5.6.7.8/tcp/9090/p2p/existing');
      expect(config.chain.rpcUrl).toBe('https://custom.rpc');
      expect(config.openclawAdapter).toBeUndefined();
      expect(config.openclawChannel).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('removes stale legacy OpenClaw flags from an existing DKG config', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      openclawAdapter: true,
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9201',
      },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('existing-node', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.openclawAdapter).toBeUndefined();
      expect(config.openclawChannel).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('migrates legacy OpenClaw transport hints into localAgentIntegrations before removing the old key', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9301',
        gatewayUrl: 'http://127.0.0.1:9300',
      },
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
          },
        },
      },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('existing-node', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.openclawChannel).toBeUndefined();
      expect(config.localAgentIntegrations.openclaw.transport).toMatchObject({
        kind: 'openclaw-channel',
        bridgeUrl: 'http://127.0.0.1:9301',
        gatewayUrl: 'http://127.0.0.1:9300',
      });
    } finally {
      process.env.DKG_HOME = original;
    }
  });
});

// ---------------------------------------------------------------------------
// mergeOpenClawConfig
// ---------------------------------------------------------------------------

describe('mergeOpenClawConfig', () => {
  it('adds adapter to a minimal openclaw.json', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.allow).toContain('adapter-openclaw');
    expect(config.plugins.load.paths).toContain('/path/to/adapter');
    expect(config.plugins.entries['adapter-openclaw']).toEqual({ enabled: true });
  });

  it('is idempotent — no duplicates on second run', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');
    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.allow.filter((x: string) => x === 'adapter-openclaw')).toHaveLength(1);
    expect(config.plugins.load.paths.filter((x: string) => x === '/path/to/adapter')).toHaveLength(1);
  });

  it('preserves existing plugin config', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        allow: ['other-plugin'],
        load: { paths: ['/other'] },
        entries: { 'other-plugin': { enabled: true, foo: 'bar' } },
      },
      someOtherKey: 123,
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.allow).toContain('other-plugin');
    expect(config.plugins.allow).toContain('adapter-openclaw');
    expect(config.plugins.load.paths).toContain('/other');
    expect(config.plugins.entries['other-plugin']).toEqual({ enabled: true, foo: 'bar' });
    expect(config.someOtherKey).toBe(123);
  });

  it('creates a backup file', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const files = readdirSync(testDir);
    const backups = files.filter((f: string) => f.startsWith('openclaw.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes Windows backslashes in adapter path', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, 'C:\\Users\\test\\adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.load.paths[0]).toBe('C:/Users/test/adapter');
  });

  it('replaces stale cached adapter-openclaw load paths with the current adapter path', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        allow: ['adapter-openclaw'],
        load: {
          paths: [
            'C:/Users/test/AppData/Local/npm-cache/_npx/123/node_modules/@origintrail-official/dkg-adapter-openclaw',
            '/other/plugin',
          ],
        },
        entries: {
          'adapter-openclaw': { enabled: true },
        },
      },
    }));

    mergeOpenClawConfig(configPath, 'C:\\Projects\\dkg-v9\\packages\\adapter-openclaw');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.load.paths).toEqual([
      '/other/plugin',
      'C:/Projects/dkg-v9/packages/adapter-openclaw',
    ]);
  });

  it('writes plugins.slots.memory = "adapter-openclaw" to elect the adapter into the memory slot', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots).toBeDefined();
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
  });

  it('preserves an existing plugins.slots object when adding the memory slot', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: {
          contextEngine: 'some-context-engine',
          other: 'other-value',
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
    expect(config.plugins.slots.contextEngine).toBe('some-context-engine');
    expect(config.plugins.slots.other).toBe('other-value');
  });

  it('refuses to merge when plugins.slots.contextEngine === "adapter-openclaw" (wrong-slot guard)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { contextEngine: 'adapter-openclaw' },
      },
    }));

    expect(() => mergeOpenClawConfig(configPath, '/path/to/adapter')).toThrow(/contextEngine/);
  });

  it('overwrites a different plugins.slots.memory value with a log line', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { memory: 'memory-core' },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
  });

  it('is idempotent on plugins.slots.memory re-runs — byte-identical output', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter');
    const firstRun = readFileSync(configPath, 'utf-8');
    const firstBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    mergeOpenClawConfig(configPath, '/path/to/adapter');
    const secondRun = readFileSync(configPath, 'utf-8');
    const secondBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    expect(secondRun).toBe(firstRun);
    expect(secondBackupCount).toBe(firstBackupCount);
  });
});

// ---------------------------------------------------------------------------
// openclaw.plugin.json — manifest kind declaration
// ---------------------------------------------------------------------------

describe('openclaw.plugin.json manifest', () => {
  it('declares kind: "memory" so the adapter is eligible for memory-slot election', () => {
    const manifestPath = join(__dirname, '..', 'openclaw.plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.kind).toBe('memory');
    expect(manifest.id).toBe('adapter-openclaw');
  });
});

// ---------------------------------------------------------------------------
// writeWorkspaceConfig
// ---------------------------------------------------------------------------

describe('writeWorkspaceConfig', () => {
  it('creates workspace config with defaults', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });

    writeWorkspaceConfig(ws, 9200);

    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8'));
    expect(config['dkg-node'].daemonUrl).toBe('http://127.0.0.1:9200');
    expect(config['dkg-node'].memory.enabled).toBe(true);
    expect(config['dkg-node'].channel.enabled).toBe(true);
    expect(config['dkg-node'].game).toBeUndefined();
  });

  it('preserves existing workspace config keys', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), JSON.stringify({
      'some-other-plugin': { key: 'value' },
    }));

    writeWorkspaceConfig(ws, 9200);

    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8'));
    expect(config['some-other-plugin']).toEqual({ key: 'value' });
    expect(config['dkg-node']).toBeDefined();
  });

  it('removes legacy game config from the workspace dkg-node block', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), JSON.stringify({
      'dkg-node': {
        daemonUrl: 'http://127.0.0.1:9200',
        memory: { enabled: true },
        channel: { enabled: true },
        game: { enabled: true },
      },
    }));

    writeWorkspaceConfig(ws, 9200);

    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8'));
    expect(config['dkg-node'].game).toBeUndefined();
  });

  it('preserves existing daemonUrl when --port not explicit', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), JSON.stringify({
      'dkg-node': {
        daemonUrl: 'http://custom:8080',
        memory: { enabled: false, watchDebounceMs: 3000 },
      },
    }));

    writeWorkspaceConfig(ws, 9200);

    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8'));
    // daemonUrl is preserved when portExplicit is not set
    expect(config['dkg-node'].daemonUrl).toBe('http://custom:8080');
    // Sub-config keys like watchDebounceMs are preserved
    expect(config['dkg-node'].memory.watchDebounceMs).toBe(3000);
    // User-configured enabled: false is respected on re-runs (idempotent)
    expect(config['dkg-node'].memory.enabled).toBe(false);
  });

  it('overrides daemonUrl when --port is explicit', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'config.json'), JSON.stringify({
      'dkg-node': {
        daemonUrl: 'http://custom:8080',
      },
    }));

    writeWorkspaceConfig(ws, 9200, true);

    const config = JSON.parse(readFileSync(join(ws, 'config.json'), 'utf-8'));
    expect(config['dkg-node'].daemonUrl).toBe('http://127.0.0.1:9200');
  });
});

// ---------------------------------------------------------------------------
// installCanonicalNodeSkill
// ---------------------------------------------------------------------------

describe('installCanonicalNodeSkill', () => {
  it('resolves the canonical skill from the current CLI package layout by default', () => {
    const ws = join(testDir, 'workspace');

    const targetPath = installCanonicalNodeSkill(ws);

    expect(targetPath).toBe(join(ws, 'skills', 'dkg-node', 'SKILL.md'));
    const copied = readFileSync(targetPath, 'utf-8');
    expect(copied).toContain('name: dkg-node');
    expect(copied).toContain('# DKG V10 Node Skill');
    expect(copied).toContain('OriginTrail');
  });

  it('copies the canonical CLI skill into the OpenClaw workspace', () => {
    const ws = join(testDir, 'workspace');
    const sourceDir = join(testDir, 'cli-skill');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, '# Canonical DKG Node Skill\n');

    const targetPath = installCanonicalNodeSkill(ws, sourcePath);

    expect(targetPath).toBe(join(ws, 'skills', 'dkg-node', 'SKILL.md'));
    expect(readFileSync(targetPath, 'utf-8')).toBe('# Canonical DKG Node Skill\n');
  });

  it('overwrites an existing workspace dkg-node skill with the canonical CLI copy', () => {
    const ws = join(testDir, 'workspace');
    const sourceDir = join(testDir, 'cli-skill');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(join(ws, 'skills', 'dkg-node'), { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), '# Old Adapter Skill\n');
    writeFileSync(sourcePath, '# Canonical DKG Node Skill\n');

    installCanonicalNodeSkill(ws, sourcePath);

    expect(readFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), 'utf-8')).toBe('# Canonical DKG Node Skill\n');
  });
});

// ---------------------------------------------------------------------------
// discoverWorkspace
// ---------------------------------------------------------------------------

describe('discoverWorkspace', () => {
  it('uses override path when provided', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });

    const result = discoverWorkspace(ws);
    expect(result.workspaceDir).toBe(ws);
  });

  it('throws when override path does not exist', () => {
    expect(() => discoverWorkspace('/nonexistent/path/xyz')).toThrow('does not exist');
  });
});

// ---------------------------------------------------------------------------
// openclawConfigPath — honors OPENCLAW_HOME (Codex PR #228 review #6)
// ---------------------------------------------------------------------------

describe('openclawConfigPath', () => {
  it('honors OPENCLAW_HOME when set', () => {
    const fakeHome = join(testDir, 'custom-openclaw-home');
    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = fakeHome;

    try {
      expect(openclawConfigPath()).toBe(join(fakeHome, 'openclaw.json'));
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = original;
      }
    }
  });

  it('falls back to ~/.openclaw/openclaw.json when OPENCLAW_HOME is unset', () => {
    const original = process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_HOME;

    try {
      expect(openclawConfigPath()).toBe(join(homedir(), '.openclaw', 'openclaw.json'));
    } finally {
      if (original !== undefined) {
        process.env.OPENCLAW_HOME = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runSetup — AbortSignal threading (Codex PR #228 review #1)
// ---------------------------------------------------------------------------

describe('runSetup abort signal', () => {
  it('throws before any filesystem writes when the signal is already aborted', async () => {
    // Point DKG/OpenClaw home at the empty tmp dir so a stray write would be
    // observable, and give runSetup a valid workspace so Step 1's discovery
    // check would otherwise succeed.
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const workspace = join(testDir, 'workspace');
    mkdirSync(workspace, { recursive: true });

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const controller = new AbortController();
      controller.abort();

      await expect(
        runSetup({
          workspace,
          start: false,
          verify: false,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/Setup aborted/);

      // No state should have been written.
      expect(existsSync(dkgHome)).toBe(false);
      expect(existsSync(openclawHome)).toBe(false);
      expect(existsSync(join(workspace, 'config.json'))).toBe(false);
      expect(existsSync(join(workspace, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('stops cooperatively mid-flow when the signal aborts between steps', async () => {
    // Pre-seed a valid workspace + openclaw.json so Steps 1, 2, and 3 complete,
    // then abort before Step 5 (merge). Assert the merge did not run.
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const workspace = join(testDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    // Minimal openclaw.json setup won't merge because we abort beforehand.
    const openclawConfigPath = join(openclawHome, 'openclaw.json');
    writeFileSync(openclawConfigPath, JSON.stringify({ plugins: {} }, null, 2) + '\n');

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      const controller = new AbortController();
      // Abort immediately — Step 1's `throwIfAborted()` fires first, so merge
      // + workspace-config + skill-install never run. The observable guarantee
      // we care about: openclaw.json is byte-identical to what we wrote.
      controller.abort();

      const before = readFileSync(openclawConfigPath, 'utf-8');
      await expect(
        runSetup({
          workspace,
          start: false,
          verify: false,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/Setup aborted/);
      const after = readFileSync(openclawConfigPath, 'utf-8');
      expect(after).toBe(before);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('completes normally when signal is undefined (backwards compatibility)', async () => {
    // Smoke test that the abort gate is a no-op without a signal — guards
    // against the check accidentally rejecting the `undefined` case.
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const workspace = join(testDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({ plugins: {} }, null, 2) + '\n',
    );

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({
          workspace,
          start: false,
          verify: false,
          // no signal
        }),
      ).resolves.toBeUndefined();
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });
});
