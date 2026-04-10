import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkspace,
  discoverAgentName,
  writeDkgConfig,
  mergeOpenClawConfig,
  writeWorkspaceConfig,
  copySkills,
} from '../src/setup.js';

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
      expect(config.openclawAdapter).toBe(true);
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
      // But openclawAdapter is always set
      expect(config.openclawAdapter).toBe(true);
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
    expect(config['dkg-node'].game.enabled).toBe(true);
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
// copySkills
// ---------------------------------------------------------------------------

describe('copySkills', () => {
  it('copies skill files from adapter root to workspace', () => {
    // Create fake adapter root with skills
    const fakeRoot = join(testDir, 'adapter');
    mkdirSync(join(fakeRoot, 'skills', 'dkg-node'), { recursive: true });
    mkdirSync(join(fakeRoot, 'skills', 'origin-trail-game'), { recursive: true });
    writeFileSync(join(fakeRoot, 'skills', 'dkg-node', 'SKILL.md'), '# DKG Node Skills');
    writeFileSync(join(fakeRoot, 'skills', 'origin-trail-game', 'SKILL.md'), '# Game Skills');

    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });

    // Use rootOverride to inject the fake adapter root
    copySkills(ws, fakeRoot);

    expect(readFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), 'utf-8')).toBe('# DKG Node Skills');
    expect(readFileSync(join(ws, 'skills', 'origin-trail-game', 'SKILL.md'), 'utf-8')).toBe('# Game Skills');
  });

  it('skips copy when files are already identical', () => {
    const fakeRoot = join(testDir, 'adapter');
    mkdirSync(join(fakeRoot, 'skills', 'dkg-node'), { recursive: true });
    writeFileSync(join(fakeRoot, 'skills', 'dkg-node', 'SKILL.md'), '# Same Content');

    const ws = join(testDir, 'workspace');
    mkdirSync(join(ws, 'skills', 'dkg-node'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), '# Same Content');

    // Should not throw; just skip
    copySkills(ws, fakeRoot);

    expect(readFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), 'utf-8')).toBe('# Same Content');
  });

  it('updates skill files when content differs', () => {
    const fakeRoot = join(testDir, 'adapter');
    mkdirSync(join(fakeRoot, 'skills', 'dkg-node'), { recursive: true });
    writeFileSync(join(fakeRoot, 'skills', 'dkg-node', 'SKILL.md'), '# Updated Content');

    const ws = join(testDir, 'workspace');
    mkdirSync(join(ws, 'skills', 'dkg-node'), { recursive: true });
    writeFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), '# Old Content');

    copySkills(ws, fakeRoot);

    expect(readFileSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'), 'utf-8')).toBe('# Updated Content');
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
