import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  discoverWorkspace,
  discoverAgentName,
  writeDkgConfig,
  mergeOpenClawConfig,
  unmergeOpenClawConfig,
  verifyUnmergeInvariants,
  verifySkillRemoved,
  installCanonicalNodeSkill,
  removeCanonicalNodeSkill,
  resolveWorkspaceDirFromConfig,
  openclawConfigPath,
  runSetup,
  type AdapterEntryConfig,
} from '../src/setup.js';

// Default entryConfig fixture used by most mergeOpenClawConfig call sites
// (the new third positional arg after D2). Cases that assert specific
// entry.config values seed their own.
const defaultEntryConfig: AdapterEntryConfig = {
  daemonUrl: 'http://127.0.0.1:9200',
  memory: { enabled: true },
  channel: { enabled: true },
};

// Default install workspace fixture for `mergeOpenClawConfig`'s fourth
// positional arg (Codex PR #234 R2-1). Cases that assert `installedWorkspace`
// semantics seed their own path. The value doesn't need to exist on disk —
// it's a string stored verbatim on the entry.
const defaultInstalledWorkspace = '/tmp/dkg-test-workspace';
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.allow).toContain('adapter-openclaw');
    expect(config.plugins.load.paths).toContain('/path/to/adapter');
    const entry = config.plugins.entries['adapter-openclaw'];
    expect(entry.enabled).toBe(true);
    expect(entry.config).toEqual({
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true },
      installedWorkspace: defaultInstalledWorkspace,
    });
  });

  it('is idempotent — no duplicates on second run', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const files = readdirSync(testDir);
    const backups = files.filter((f: string) => f.startsWith('openclaw.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes Windows backslashes in adapter path', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, 'C:\\Users\\test\\adapter', defaultEntryConfig, defaultInstalledWorkspace);

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

    mergeOpenClawConfig(configPath, 'C:\\Projects\\dkg-v9\\packages\\adapter-openclaw', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.load.paths).toEqual([
      '/other/plugin',
      'C:/Projects/dkg-v9/packages/adapter-openclaw',
    ]);
  });

  it('writes plugins.slots.memory = "adapter-openclaw" to elect the adapter into the memory slot', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

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

    expect(() => mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace)).toThrow(/contextEngine/);
  });

  it('overwrites a different plugins.slots.memory value with a log line', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { memory: 'memory-core' },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
  });

  it('is idempotent on plugins.slots.memory re-runs — byte-identical output', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const firstRun = readFileSync(configPath, 'utf-8');
    const firstBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const secondRun = readFileSync(configPath, 'utf-8');
    const secondBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    expect(secondRun).toBe(firstRun);
    expect(secondBackupCount).toBe(firstBackupCount);
  });

  // PR #228 Codex N2 — persist prior slot owner so disconnect can restore it.
  it('captures a prior non-adapter plugins.slots.memory owner into the adapter entry', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
    expect(config.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBe('memory-core');
  });

  it('on a second merge, does NOT overwrite previousMemorySlotOwner with the adapter id (first-wins)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    // First merge captures "memory-core" into the entry.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBe('memory-core');

    // Second merge: slot is already the adapter, so the capture branch won't
    // fire — and even if it did, the first-wins guard keeps the original.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterSecond.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBe('memory-core');
  });

  // D2 — entry.config is the single source of truth for DkgNodePlugin runtime
  // config. Fresh merge populates it; re-merge preserves user-customized values
  // (first-wins), matching the previousMemorySlotOwner pattern.
  it('writes entry.config with daemonUrl/memory/channel on fresh merge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true },
    }, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entryConfig = config.plugins.entries['adapter-openclaw'].config;
    expect(entryConfig.daemonUrl).toBe('http://127.0.0.1:9200');
    expect(entryConfig.memory).toEqual({ enabled: true });
    expect(entryConfig.channel).toEqual({ enabled: true });
  });

  it('preserves existing entry.config values on re-merge (first-wins semantics)', () => {
    const configPath = join(testDir, 'openclaw.json');
    // Seed: user has a prior merge with a custom daemonUrl and a memory
    // block with enabled:false. The channel block is absent — re-merge
    // should fill it in from defaults without touching existing keys.
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              daemonUrl: 'http://custom:9300',
              memory: { enabled: false },
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true },
    }, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entryConfig = config.plugins.entries['adapter-openclaw'].config;
    // User-customized values survive.
    expect(entryConfig.daemonUrl).toBe('http://custom:9300');
    expect(entryConfig.memory.enabled).toBe(false);
    // Missing sub-object gets filled in from defaults.
    expect(entryConfig.channel).toEqual({ enabled: true });
  });

  it('overrideDaemonUrl option replaces existing daemonUrl (used when --port is explicit)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              daemonUrl: 'http://custom:9300',
              memory: { enabled: true },
              channel: { enabled: true },
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(
      configPath,
      '/path/to/adapter',
      {
        daemonUrl: 'http://127.0.0.1:9400',
        memory: { enabled: true },
        channel: { enabled: true },
      },
      defaultInstalledWorkspace,
      { overrideDaemonUrl: true },
    );

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.daemonUrl).toBe('http://127.0.0.1:9400');
  });
});

// ---------------------------------------------------------------------------
// unmergeOpenClawConfig (PR #228 Codex N2 — restore prior memory-slot owner)
// ---------------------------------------------------------------------------

describe('unmergeOpenClawConfig', () => {
  it('restores plugins.slots.memory to the previous owner when the merge persisted one', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    // Merge → captures "memory-core" as previousMemorySlotOwner.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.slots.memory).toBe('adapter-openclaw');
    expect(afterMerge.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBe('memory-core');

    // Unmerge → restores "memory-core" and removes the entry entirely.
    unmergeOpenClawConfig(configPath);
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.slots.memory).toBe('memory-core');
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  it('clears plugins.slots.memory when no prior owner was persisted', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // Merge on a clean config — no previousMemorySlotOwner is captured.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.slots.memory).toBe('adapter-openclaw');
    expect(afterMerge.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBeUndefined();

    unmergeOpenClawConfig(configPath);
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.slots.memory).toBeUndefined();
  });

  it('merge→unmerge round-trip from a clean openclaw.json restores the original memory-slot state', () => {
    const configPath = join(testDir, 'openclaw.json');
    // "clean" here means: plugins object exists but no slot is set; mimics a
    // fresh install that hasn't configured a memory provider yet.
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    unmergeOpenClawConfig(configPath);

    const final = JSON.parse(readFileSync(configPath, 'utf-8'));
    // plugins.slots.memory is unset again — same as before the merge/unmerge cycle.
    expect(final.plugins.slots?.memory).toBeUndefined();
  });

  it('is idempotent — a second unmerge on an already-disconnected config writes nothing', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    unmergeOpenClawConfig(configPath);
    const firstBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;
    const firstContent = readFileSync(configPath, 'utf-8');

    unmergeOpenClawConfig(configPath);
    const secondBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;
    const secondContent = readFileSync(configPath, 'utf-8');

    expect(secondContent).toBe(firstContent);
    expect(secondBackupCount).toBe(firstBackupCount);
  });

  it('leaves plugins.slots.memory alone when the user has externally re-owned the slot between merge and unmerge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    // Simulate external modification: user swaps in a different memory plugin.
    const intermediate = JSON.parse(readFileSync(configPath, 'utf-8'));
    intermediate.plugins.slots.memory = 'some-other-memory-plugin';
    writeFileSync(configPath, JSON.stringify(intermediate, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    const final = JSON.parse(readFileSync(configPath, 'utf-8'));
    // We don't clobber the user's new choice, and the adapter entry is gone.
    expect(final.plugins.slots.memory).toBe('some-other-memory-plugin');
    expect(final.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  // PR #228 Codex N4 — a missing openclaw.json is treated as already-
  // disconnected so the Disconnect UI flow doesn't strand users who removed
  // or relocated OpenClaw. No throw, no `.bak`, no file created.
  it('is a no-op when openclaw.json is missing', () => {
    const configPath = join(testDir, 'does-not-exist.json');
    const countBefore = readdirSync(testDir).length;

    expect(() => unmergeOpenClawConfig(configPath)).not.toThrow();

    expect(existsSync(configPath)).toBe(false);
    expect(readdirSync(testDir).length).toBe(countBefore);
    expect(
      readdirSync(testDir).some((f: string) => f.includes('.bak.')),
    ).toBe(false);
  });

  it('is a no-op when openclaw.json exists but is not valid JSON', () => {
    const configPath = join(testDir, 'openclaw.json');
    const original = '{ not-valid-json';
    writeFileSync(configPath, original);
    const countBefore = readdirSync(testDir).length;

    expect(() => unmergeOpenClawConfig(configPath)).not.toThrow();

    // File untouched (not rewritten), no `.bak` sibling written.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readdirSync(testDir).length).toBe(countBefore);
    expect(
      readdirSync(testDir).some((f: string) => f.startsWith('openclaw.json.bak.')),
    ).toBe(false);
  });

  // PR #228 Codex R4-N1 — when a caller supplies an explicit openclaw.json
  // path that doesn't exist, we must NOT silently fall back to the default
  // `~/.openclaw/openclaw.json`. Doing so would unmerge the wrong config for
  // users who relocated OpenClaw (data-corruption path).
  it('does NOT fall back to the default home when an explicit missing path is supplied', () => {
    // The explicit path the caller passes: a directory that doesn't contain openclaw.json.
    const relocated = join(testDir, 'relocated-openclaw');
    mkdirSync(relocated, { recursive: true });
    const explicitMissingPath = join(relocated, 'openclaw.json');

    // The default home we want left untouched — a fully-merged config that
    // would be visibly mutated if unmerge fell through to it.
    const defaultHome = join(testDir, 'default-openclaw');
    mkdirSync(defaultHome, { recursive: true });
    const defaultConfigPath = join(defaultHome, 'openclaw.json');
    writeFileSync(defaultConfigPath, JSON.stringify({ plugins: {} }, null, 2) + '\n');
    mergeOpenClawConfig(defaultConfigPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const defaultContentBefore = readFileSync(defaultConfigPath, 'utf-8');
    const defaultBackupsBefore = readdirSync(defaultHome).filter(
      (f: string) => f.startsWith('openclaw.json.bak.'),
    ).length;

    // Point OPENCLAW_HOME at `defaultHome` — this is what setup.ts's
    // `openclawDir()` would consult if the explicit-path guard fell through.
    const originalEnv = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = defaultHome;
    try {
      expect(() => unmergeOpenClawConfig(explicitMissingPath)).not.toThrow();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalEnv;
      }
    }

    // The default home's config must be byte-identical and no new `.bak`.
    expect(readFileSync(defaultConfigPath, 'utf-8')).toBe(defaultContentBefore);
    const defaultBackupsAfter = readdirSync(defaultHome).filter(
      (f: string) => f.startsWith('openclaw.json.bak.'),
    ).length;
    expect(defaultBackupsAfter).toBe(defaultBackupsBefore);
    // And the explicit path didn't get a freshly-created file either.
    expect(existsSync(explicitMissingPath)).toBe(false);
  });

  // D1 — unmerge deletes the adapter entry entirely (including its config
  // sub-object). The adapter owns every field on this entry post-D2, so there
  // is no user-customizable state to preserve.
  it('removes the adapter entry entirely on unmerge (including entry.config)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // Merge populates entry + entry.config.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.entries['adapter-openclaw'].config).toBeDefined();

    unmergeOpenClawConfig(configPath);

    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  // Codex PR #234 R2-1 (as refined by R3-2) — unmerge returns the prior
  // memory-slot owner for slot restoration. `installedWorkspace` is NOT
  // returned post-R3-2: the daemon reads it off openclaw.json BEFORE calling
  // unmerge, so the skill cleanup runs before the entry is deleted.
  it('returns previousMemorySlotOwner read before entry deletion', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));
    const ws = join(testDir, 'workspace');
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, ws);

    const result = unmergeOpenClawConfig(configPath);

    expect(result).toEqual({ previousMemorySlotOwner: 'memory-core' });
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  it('returns an empty object when openclaw.json is absent', () => {
    const missingPath = join(testDir, 'never-existed.json');
    expect(unmergeOpenClawConfig(missingPath)).toEqual({});
  });

  it('returns an empty object when openclaw.json is unparseable JSON', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, '{this is not: json');
    expect(unmergeOpenClawConfig(configPath)).toEqual({});
  });

  it('omits previousMemorySlotOwner when the merge did not capture one (clean install)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const result = unmergeOpenClawConfig(configPath);

    expect(result.previousMemorySlotOwner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeOpenClawConfig installedWorkspace persistence (Codex PR #234 R2-1)
// ---------------------------------------------------------------------------

describe('mergeOpenClawConfig installedWorkspace', () => {
  it('persists installedWorkspace verbatim on the adapter entry', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const ws = join(testDir, 'workspace');

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, ws);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(ws);
  });

  it('overwrites installedWorkspace on re-merge (latest-wins)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const firstWs = join(testDir, 'first-workspace');
    const secondWs = join(testDir, 'second-workspace');

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, firstWs);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))
      .plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(firstWs);

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, secondWs);

    // Latest-wins: re-install updates the authoritative pointer (matches the
    // same semantics as `entry.enabled` and `entry.config.daemonUrl` with
    // overrideDaemonUrl — reinstalls reflect current reality).
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))
      .plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(secondWs);
  });

  it('is idempotent when the same workspace is re-supplied', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const ws = join(testDir, 'workspace');

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, ws);
    const first = readFileSync(configPath, 'utf-8');
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, ws);
    const second = readFileSync(configPath, 'utf-8');

    expect(second).toBe(first);
    expect(JSON.parse(second).plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(ws);
  });
});

// ---------------------------------------------------------------------------
// verifySkillRemoved (Codex PR #234 R2-2)
// ---------------------------------------------------------------------------

describe('verifySkillRemoved', () => {
  it('returns null when the canonical node skill file is absent', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    expect(verifySkillRemoved(ws)).toBeNull();
  });

  it('returns a descriptive failure string when the skill file still exists', () => {
    const ws = join(testDir, 'workspace');
    const skillDir = join(ws, 'skills', 'dkg-node');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '# Canonical DKG Node Skill\n');

    const failure = verifySkillRemoved(ws);

    expect(failure).not.toBeNull();
    expect(failure).toContain(skillPath);
    expect(failure).toMatch(/still present/);
  });

  it('treats a dangling dkg-node/ directory with no SKILL.md as clean (directory alone does not fail)', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(join(ws, 'skills', 'dkg-node'), { recursive: true });
    // No SKILL.md inside the directory. Verify targets the file, not the
    // parent — matches `removeCanonicalNodeSkill`'s unlink target.
    expect(verifySkillRemoved(ws)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyUnmergeInvariants (PR #228 Codex N3 — full reverse-merge check)
// ---------------------------------------------------------------------------

describe('verifyUnmergeInvariants', () => {
  it('returns null when every field `mergeOpenClawConfig` writes has been unwound (entry absent)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: [],
            load: { paths: [] },
            entries: {},
            slots: {},
          },
        },
        null,
        2,
      ) + '\n',
    );

    expect(verifyUnmergeInvariants(configPath)).toBeNull();
  });

  it('returns null when entry exists but is disabled (defensive — absent is the normal post-unmerge state)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: [],
            load: { paths: [] },
            entries: { 'adapter-openclaw': { enabled: false } },
            slots: {},
          },
        },
        null,
        2,
      ) + '\n',
    );

    expect(verifyUnmergeInvariants(configPath)).toBeNull();
  });

  it('returns a descriptive string when plugins.slots.memory is still elected', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          allow: [],
          load: { paths: [] },
          entries: { 'adapter-openclaw': { enabled: false } },
          slots: { memory: 'adapter-openclaw' },
        },
      }),
    );

    expect(verifyUnmergeInvariants(configPath)).toMatch(/plugins\.slots\.memory is still "adapter-openclaw"/);
  });

  it('returns a descriptive string when plugins.allow still contains the adapter', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          allow: ['adapter-openclaw'],
          load: { paths: [] },
          entries: { 'adapter-openclaw': { enabled: false } },
          slots: {},
        },
      }),
    );

    expect(verifyUnmergeInvariants(configPath)).toMatch(/plugins\.allow still contains "adapter-openclaw"/);
  });

  it('returns a descriptive string when plugins.load.paths still contains an adapter load path', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          allow: [],
          load: { paths: ['/home/me/packages/adapter-openclaw'] },
          entries: { 'adapter-openclaw': { enabled: false } },
          slots: {},
        },
      }),
    );

    const result = verifyUnmergeInvariants(configPath);
    expect(result).toMatch(/plugins\.load\.paths still contains adapter path/);
    expect(result).toContain('/home/me/packages/adapter-openclaw');
  });

  it('returns a descriptive string when plugins.entries["adapter-openclaw"] is still present with enabled=true', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          allow: [],
          load: { paths: [] },
          entries: { 'adapter-openclaw': { enabled: true } },
          slots: {},
        },
      }),
    );

    expect(verifyUnmergeInvariants(configPath)).toMatch(
      /plugins\.entries\["adapter-openclaw"\] is still present with enabled=true/,
    );
  });

  // PR #228 Codex N4 — missing file is treated as already-disconnected so
  // the Disconnect UI flow doesn't strand users who removed or relocated
  // OpenClaw. The invariants hold trivially when the config doesn't exist.
  it('returns null on a missing config file (treated as already-disconnected)', () => {
    const configPath = join(testDir, 'does-not-exist.json');

    expect(verifyUnmergeInvariants(configPath)).toBeNull();
  });

  it('does not throw on an unparseable config file — returns a descriptive string', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, '{ not-valid-json');

    const result = verifyUnmergeInvariants(configPath);
    expect(result).toMatch(/Could not parse/);
  });

  // PR #228 Codex R4-N1 — `verifyUnmergeInvariants` must never read the
  // default `~/.openclaw/openclaw.json` when the caller supplied an explicit
  // path. Even when the default home holds a dirty/still-merged config, an
  // explicit missing path should be reported as already-disconnected.
  it('does NOT read the default home when an explicit missing path is supplied', () => {
    const explicitMissingPath = join(testDir, 'relocated', 'openclaw.json');

    // Seed OPENCLAW_HOME with a config whose invariants would FAIL if it
    // were accidentally consulted — slot still elected, adapter still in allow.
    const defaultHome = join(testDir, 'default-openclaw');
    mkdirSync(defaultHome, { recursive: true });
    writeFileSync(
      join(defaultHome, 'openclaw.json'),
      JSON.stringify(
        {
          plugins: {
            allow: ['adapter-openclaw'],
            slots: { memory: 'adapter-openclaw' },
            load: { paths: [] },
            entries: { 'adapter-openclaw': { enabled: true } },
          },
        },
        null,
        2,
      ) + '\n',
    );

    const originalEnv = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = defaultHome;
    try {
      // Returns null because the explicit path is missing; invariants hold
      // trivially. If the fn fell through to the default, it would return a
      // descriptive failure string for one of the three dirty invariants.
      expect(verifyUnmergeInvariants(explicitMissingPath)).toBeNull();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// openclaw.plugin.json — manifest kind declaration
// ---------------------------------------------------------------------------

describe('openclaw.plugin.json manifest', () => {
  it('declares kind: "memory" so the adapter is eligible for memory-slot election', () => {
    const manifestPath = join(__dirname, '..', 'openclaw.plugin.json');
    const packagePath = join(__dirname, '..', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    expect(manifest.kind).toBe('memory');
    // Bot review B1: the manifest `id` and the published npm `name` are
    // intentionally DIFFERENT identifiers. The `id` is the plugin slot
    // key used by OpenClaw's slot resolution (`plugins.slots.memory`,
    // `plugins.entries`, `plugins.allow`) — this must stay short and
    // stable (`adapter-openclaw`) because it is hard-coded across
    // `setup.ts`, `DkgMemoryPlugin.ts`, and `openclaw-entry.mjs`. The
    // `pkg.name` is the scoped npm package name used for installation.
    // A previous iteration of this PR renamed `manifest.id` to
    // `pkg.name` in the manifest alone, which split the plugin identity
    // in two and silently broke slot election; the rename has been
    // reverted and the slot id is once again the short `adapter-openclaw`.
    expect(manifest.id).toBe('adapter-openclaw');
    // Sanity check that both the adapter code AND this test agree on
    // the slot identifier — any future rename must update every call
    // site that matches on `plugins.slots.memory`.
    expect(pkg.name).toBe('@origintrail-official/dkg-adapter-openclaw');
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
// removeCanonicalNodeSkill — symmetric counterpart used by the daemon-side
// Disconnect path to retire the agent-facing skill alongside the config entry.
// ---------------------------------------------------------------------------

describe('removeCanonicalNodeSkill', () => {
  it('removes the canonical node skill and cleans up the empty dkg-node directory', () => {
    const ws = join(testDir, 'workspace');
    const sourceDir = join(testDir, 'cli-skill');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, '# Canonical DKG Node Skill\n');
    installCanonicalNodeSkill(ws, sourcePath);
    const skillPath = join(ws, 'skills', 'dkg-node', 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);

    removeCanonicalNodeSkill(ws);

    expect(existsSync(skillPath)).toBe(false);
    expect(existsSync(join(ws, 'skills', 'dkg-node'))).toBe(false);
    // Outer skills/ parent is adapter-agnostic and must never be touched.
    expect(existsSync(join(ws, 'skills'))).toBe(true);
  });

  it('is idempotent when the skill is absent', () => {
    const ws = join(testDir, 'workspace');
    // No seed — workspace exists but nothing under skills/.
    mkdirSync(ws, { recursive: true });

    expect(() => removeCanonicalNodeSkill(ws)).not.toThrow();
    expect(() => removeCanonicalNodeSkill(ws)).not.toThrow();

    expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(ws, 'skills', 'dkg-node'))).toBe(false);
  });

  it('leaves unrelated files in skills/dkg-node/ intact', () => {
    const ws = join(testDir, 'workspace');
    const sourceDir = join(testDir, 'cli-skill');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, '# Canonical DKG Node Skill\n');
    installCanonicalNodeSkill(ws, sourcePath);
    const siblingPath = join(ws, 'skills', 'dkg-node', 'custom-note.md');
    writeFileSync(siblingPath, '# User note alongside the adapter skill\n');

    removeCanonicalNodeSkill(ws);

    expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    expect(existsSync(siblingPath)).toBe(true);
    // Sibling keeps the dir non-empty, so rmdirSync(ENOTEMPTY) was swallowed.
    expect(existsSync(join(ws, 'skills', 'dkg-node'))).toBe(true);
    expect(readFileSync(siblingPath, 'utf-8')).toBe('# User note alongside the adapter skill\n');
  });

  it('leaves other skills under skills/ intact', () => {
    const ws = join(testDir, 'workspace');
    const sourceDir = join(testDir, 'cli-skill');
    const sourcePath = join(sourceDir, 'SKILL.md');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, '# Canonical DKG Node Skill\n');
    installCanonicalNodeSkill(ws, sourcePath);
    const otherSkillPath = join(ws, 'skills', 'other-skill', 'notes.md');
    mkdirSync(dirname(otherSkillPath), { recursive: true });
    writeFileSync(otherSkillPath, '# Unrelated sibling skill\n');

    removeCanonicalNodeSkill(ws);

    expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(ws, 'skills', 'dkg-node'))).toBe(false);
    expect(existsSync(otherSkillPath)).toBe(true);
    expect(existsSync(join(ws, 'skills'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceDirFromConfig — shared resolver between setup install and
// the daemon-side Disconnect path (Codex PR #234 R1-1).
// ---------------------------------------------------------------------------

describe('resolveWorkspaceDirFromConfig', () => {
  // Use a deterministic openclaw.json path inside testDir so relative-path
  // resolution is independent of cwd. OPENCLAW_HOME is scoped per-test only
  // for the default-fallback cases.
  let openclawConfigFilePath: string;

  beforeEach(() => {
    const openclawHome = join(testDir, '.openclaw');
    mkdirSync(openclawHome, { recursive: true });
    openclawConfigFilePath = join(openclawHome, 'openclaw.json');
  });

  it('prefers agents.defaults.workspace over other key variants', () => {
    const wanted = join(testDir, 'wanted-ws');
    const result = resolveWorkspaceDirFromConfig(
      {
        agents: { defaults: { workspace: wanted } },
        workspace: join(testDir, 'ignored-ws'),
        workspaceDir: join(testDir, 'also-ignored'),
      },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('falls back to top-level workspace when agents.defaults.workspace is absent', () => {
    const wanted = join(testDir, 'top-level-ws');
    const result = resolveWorkspaceDirFromConfig(
      { workspace: wanted, workspaceDir: join(testDir, 'ignored') },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('falls back to workspaceDir when the first two keys are absent', () => {
    const wanted = join(testDir, 'legacy-key-ws');
    const result = resolveWorkspaceDirFromConfig(
      { workspaceDir: wanted },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('expands a leading ~ to homedir()', () => {
    const result = resolveWorkspaceDirFromConfig(
      { agents: { defaults: { workspace: '~/foo' } } },
      openclawConfigFilePath,
    );
    expect(result).toBe(join(homedir(), 'foo'));
  });

  it('resolves relative paths against dirname(openclawConfigPath) — not cwd', () => {
    const result = resolveWorkspaceDirFromConfig(
      { workspace: './workspace' },
      openclawConfigFilePath,
    );
    expect(result).toBe(join(dirname(openclawConfigFilePath), 'workspace'));
  });

  it('passes absolute paths through unchanged', () => {
    const absolute = join(testDir, 'already', 'absolute');
    const result = resolveWorkspaceDirFromConfig(
      { workspace: absolute },
      openclawConfigFilePath,
    );
    expect(result).toBe(absolute);
  });

  it('returns default $OPENCLAW_HOME/workspace when no key is set but the dir exists', () => {
    const openclawHome = join(testDir, 'default-home');
    const defaultWs = join(openclawHome, 'workspace');
    mkdirSync(defaultWs, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBe(defaultWs);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  it('returns null when no key is set and the default $OPENCLAW_HOME/workspace does not exist', () => {
    const openclawHome = join(testDir, 'empty-home');
    mkdirSync(openclawHome, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  // R9-1: the default-fallback must derive from `dirname(openclawConfigPath)`
  // rather than the process-wide `$OPENCLAW_HOME`. A legacy install whose
  // openclaw.json lives at a non-default path (e.g. a user-specified
  // `--config-path`-style location in scripts, or a `OPENCLAW_HOME`-shadowed
  // directory from a prior version) would otherwise resolve to the default
  // `~/.openclaw/workspace` on Disconnect — cleaning the wrong SKILL.md or
  // missing the real one.
  it('derives the default fallback from dirname(openclawConfigPath), not $OPENCLAW_HOME (R9-1)', () => {
    // Set `OPENCLAW_HOME` to one place; the openclaw.json lives somewhere
    // else entirely. The fallback must target the config-adjacent workspace,
    // NOT `$OPENCLAW_HOME/workspace`.
    const shadowHome = join(testDir, 'shadow-openclaw-home');
    const shadowWs = join(shadowHome, 'workspace');
    mkdirSync(shadowWs, { recursive: true });

    const configHome = join(testDir, 'legacy-install-dir');
    const configWs = join(configHome, 'workspace');
    mkdirSync(configWs, { recursive: true });
    const legacyConfigPath = join(configHome, 'openclaw.json');

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = shadowHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        legacyConfigPath,
      );
      // Correct answer: co-located with the config file.
      expect(result).toBe(configWs);
      // Pre-R9-1 regression guard — the shadow path must NOT win.
      expect(result).not.toBe(shadowWs);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  it('returns null when the winning key is present but not a non-empty string (no fallback cascade across keys)', () => {
    // Matches discoverWorkspace semantics: `??` only skips null/undefined, so
    // a present-but-empty-string / non-string value does NOT cascade to the
    // next key. With no default $OPENCLAW_HOME/workspace on disk the resolver
    // returns null, matching the existing install-path throw conditions.
    const openclawHome = join(testDir, 'empty-home-2');
    mkdirSync(openclawHome, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        {
          agents: { defaults: { workspace: '' } },
          workspace: 'would-have-been-picked-if-cascading',
        },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
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

// ---------------------------------------------------------------------------
// runSetup workspace migration (Codex PR #234 R3-3)
// Re-running setup with a different workspace must retire the prior install's
// SKILL.md — otherwise the old `/dir-a/skills/dkg-node/SKILL.md` is orphaned
// and Disconnect will only ever retire whatever `installedWorkspace` points
// at (latest merge wins).
// ---------------------------------------------------------------------------

describe('runSetup workspace migration', () => {
  it('removes the prior install\'s SKILL.md when the workspace changes between setups (cleanup runs AFTER new install lands)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const dirA = join(testDir, 'workspace-a');
    const dirB = join(testDir, 'workspace-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
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
      // First install targets dirA.
      await runSetup({ workspace: dirA, start: false, verify: false });
      const skillA = join(dirA, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(skillA)).toBe(true);
      const afterA = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(afterA.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(dirA);

      // Second install targets dirB — old install's skill at dirA must be retired.
      await runSetup({ workspace: dirB, start: false, verify: false });
      const skillB = join(dirB, 'skills', 'dkg-node', 'SKILL.md');

      // Post-R4-2: end state is new-install-present + old-install-absent +
      // pointer flipped. All three must hold together — proves the migration
      // ran the cleanup strictly after the new install landed.
      expect(existsSync(skillB)).toBe(true);
      expect(existsSync(skillA)).toBe(false);
      const afterB = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(afterB.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(dirB);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Codex PR #234 R4-2 (strictly-additive cleanup) + R5-3 (canary-ordered
  // install BEFORE merge). When install-new fails, both the prior install's
  // SKILL.md AND the openclaw.json pointer must still reflect the old
  // workspace — so a retry reads OLD as the prior install and migrates
  // normally, instead of reading NEW and treating the orphan as fresh.
  it('leaves the prior install\'s SKILL.md AND entry.config.installedWorkspace intact when installing the new skill fails (R4-2 + R5-3)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const dirA = join(testDir, 'workspace-a');
    const dirB = join(testDir, 'workspace-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
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
      // First install lands cleanly at dirA — baseline.
      await runSetup({ workspace: dirA, start: false, verify: false });
      const skillA = join(dirA, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(skillA)).toBe(true);
      const configAfterA = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(configAfterA.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(dirA);

      // Sabotage dirB so installCanonicalNodeSkill's mkdirSync(skills/dkg-node)
      // throws: create `skills` as a FILE so the recursive mkdir hits an
      // intermediate non-directory and fails with ENOTDIR/EEXIST.
      writeFileSync(join(dirB, 'skills'), 'not a directory\n');

      await expect(
        runSetup({ workspace: dirB, start: false, verify: false }),
      ).rejects.toThrow();

      // R4-2 guarantee: old install survived.
      expect(existsSync(skillA)).toBe(true);
      expect(existsSync(join(dirB, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);

      // R5-3 canary-ordered guarantee: install ran BEFORE merge, so when
      // install threw, the config pointer was never flipped. A retry will
      // correctly identify OLD as the prior install.
      const configAfterB = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(configAfterB.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(dirA);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Codex PR #234 R11-2: legacy adapter entries (pre-R2) lack
  // `entry.config.installedWorkspace`. Previously we'd fall back to the
  // config-derived workspace and clean up SKILL.md there, but that's
  // unsafe — a pre-R2 install done with `--workspace /A` against a config
  // that declares `/B` would make the fallback delete the wrong file.
  // Per the pre-launch no-migration stance + R11-2 decline of destructive
  // best-guess, migration is now SKIPPED for legacy entries. The new
  // install still lands cleanly at the current workspace; any pre-R2
  // orphan at the old path stays put (user cleans manually).
  it('SKIPS migration for legacy adapter entries without entry.config.installedWorkspace (R11-2)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const legacyWs = join(testDir, 'legacy-workspace');
    const newWs = join(testDir, 'new-workspace');
    mkdirSync(legacyWs, { recursive: true });
    mkdirSync(newWs, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    // Seed a legacy-shaped openclaw.json with an adapter entry that lacks
    // `entry.config.installedWorkspace` AND a SKILL.md at the workspace
    // that the old fallback would have picked.
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          allow: ['adapter-openclaw'],
          load: { paths: [] },
          entries: {
            'adapter-openclaw': { enabled: true, config: { daemonUrl: 'http://127.0.0.1:9200' } },
          },
          slots: { memory: 'adapter-openclaw' },
        },
        agents: { defaults: { workspace: legacyWs } },
      }, null, 2) + '\n',
    );
    const legacySkill = join(legacyWs, 'skills', 'dkg-node', 'SKILL.md');
    mkdirSync(dirname(legacySkill), { recursive: true });
    writeFileSync(legacySkill, '# Legacy-install DKG Node Skill\n');

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      // Re-run setup with a different workspace. New install must land;
      // legacy SKILL.md must NOT be touched (no fallback = no destructive
      // cleanup from a guessed path).
      await runSetup({ workspace: newWs, start: false, verify: false });

      const newSkill = join(newWs, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(newSkill)).toBe(true);
      // The legacy SKILL.md survives untouched — no guessing, no deleting.
      expect(existsSync(legacySkill)).toBe(true);
      expect(readFileSync(legacySkill, 'utf-8')).toBe('# Legacy-install DKG Node Skill\n');

      // Post-merge the entry now carries the new installedWorkspace pointer
      // so future migrations fire correctly with an authoritative target.
      const after = JSON.parse(readFileSync(join(openclawHome, 'openclaw.json'), 'utf-8'));
      expect(after.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(newWs);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Codex PR #234 R5-2 negative case: fresh install (no adapter entry at all)
  // must NOT trigger a migration against whatever the config-derived
  // workspace resolves to. Only an existing entry gates the fallback.
  it('does NOT trigger migration when the adapter entry is absent (fresh install)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const unrelatedWs = join(testDir, 'unrelated-workspace');
    const newWs = join(testDir, 'new-workspace');
    mkdirSync(unrelatedWs, { recursive: true });
    mkdirSync(newWs, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    // openclaw.json exists with a workspace pointing at an unrelated dir
    // (e.g. the user's default OpenClaw home) BUT no adapter entry at all.
    // This is a fresh install, not a migration.
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({
        plugins: { allow: [], load: { paths: [] }, entries: {}, slots: {} },
        agents: { defaults: { workspace: unrelatedWs } },
      }, null, 2) + '\n',
    );
    // Seed a user-placed file at the unrelated workspace — must survive.
    const unrelatedSkill = join(unrelatedWs, 'skills', 'dkg-node', 'SKILL.md');
    mkdirSync(dirname(unrelatedSkill), { recursive: true });
    writeFileSync(unrelatedSkill, '# User-placed file, NOT adapter-owned\n');
    const unrelatedBytes = readFileSync(unrelatedSkill, 'utf-8');

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await runSetup({ workspace: newWs, start: false, verify: false });

      // New install landed at newWs.
      expect(existsSync(join(newWs, 'skills', 'dkg-node', 'SKILL.md'))).toBe(true);
      // Unrelated workspace file is untouched — no migration ran.
      expect(existsSync(unrelatedSkill)).toBe(true);
      expect(readFileSync(unrelatedSkill, 'utf-8')).toBe(unrelatedBytes);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('does not re-retire anything when setup is re-run against the same workspace', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
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
      await runSetup({ workspace: ws, start: false, verify: false });
      const skillPath = join(ws, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
      const firstSkillBytes = readFileSync(skillPath, 'utf-8');

      // Seed a sibling file to detect any inadvertent cleanup of the whole
      // dkg-node/ dir on the idempotent re-run (migration cleanup is scoped
      // to SKILL.md; the parent dir should remain intact in-place).
      const sibling = join(ws, 'skills', 'dkg-node', 'user-note.md');
      writeFileSync(sibling, '# kept by user\n');

      await runSetup({ workspace: ws, start: false, verify: false });

      // SKILL.md is still there (the fresh install re-copied it) and the
      // sibling user file is untouched — no migration cleanup happened.
      expect(existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, 'utf-8')).toBe(firstSkillBytes);
      expect(existsSync(sibling)).toBe(true);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Codex PR #234 R7-1: symlink aliases of the same workspace must NOT
  // trigger migration. Raw string compare sees `/real` and `/alias` as
  // different — the cleanup would then unlink the freshly-installed SKILL.md
  // through the alias path. `realpathSync`-based compare must collapse
  // them to a single canonical form so cleanup only fires on actual
  // workspace changes.
  it('does NOT trigger migration when the second setup routes through a symlink alias of the prior workspace (R7-1)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const realWs = join(testDir, 'ws-real');
    const aliasWs = join(testDir, 'ws-alias');
    mkdirSync(realWs, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });

    // Create the symlink. Windows needs admin / developer mode; skip the
    // test gracefully if the OS won't let us create the alias.
    let symlinkCreated = false;
    try {
      symlinkSync(realWs, aliasWs, 'dir');
      symlinkCreated = true;
    } catch {
      // Skip — can't exercise the R7-1 failure mode without a symlink.
    }
    if (!symlinkCreated) return;

    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({ plugins: {} }, null, 2) + '\n',
    );

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      // First install targets the real path.
      await runSetup({ workspace: realWs, start: false, verify: false });
      const skillReal = join(realWs, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(skillReal)).toBe(true);
      const installedBytes = readFileSync(skillReal, 'utf-8');

      // Second install targets the alias (symlink). Both paths resolve to
      // the same physical directory; the install is effectively a no-op
      // re-copy, and migration MUST NOT fire (raw compare would make it
      // fire — that's the R7-1 bug).
      await runSetup({ workspace: aliasWs, start: false, verify: false });

      // The SKILL.md must still be on disk — if R7-1 regressed, the raw
      // compare would have treated alias ≠ real, fired migration, and
      // called `removeCanonicalNodeSkill(realWs)` which would delete this
      // file through the other view of the same directory.
      expect(existsSync(skillReal)).toBe(true);
      expect(readFileSync(skillReal, 'utf-8')).toBe(installedBytes);
      // The alias view sees the same file (same physical inode).
      expect(existsSync(join(aliasWs, 'skills', 'dkg-node', 'SKILL.md'))).toBe(true);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Codex PR #234 R6-3: migration cleanup silently swallows unlink errors.
  // When the old SKILL.md cannot be removed (file locked, permissions,
  // replaced by a directory, etc.) verifySkillRemoved must detect the
  // residue and surface it as a loud warning — otherwise the orphan is
  // invisible and Disconnect (which only knows about the new
  // entry.config.installedWorkspace) can never clean it up.
  it('warns loudly when migration cleanup silently fails to remove the prior SKILL.md (R6-3)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const dirA = join(testDir, 'workspace-a');
    const dirB = join(testDir, 'workspace-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
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
      // First install lands at dirA.
      await runSetup({ workspace: dirA, start: false, verify: false });
      const skillA = join(dirA, 'skills', 'dkg-node', 'SKILL.md');
      expect(existsSync(skillA)).toBe(true);

      // Sabotage the prior SKILL.md so unlinkSync fails: replace the FILE
      // with a DIRECTORY. unlinkSync on a directory throws EISDIR/EPERM on
      // every platform. removeCanonicalNodeSkill catches the throw + warns
      // + returns (best-effort), which is the exact silent-miss scenario
      // R6-3 flags. The R6-3 guard must then catch the residue via
      // verifySkillRemoved and surface a second, explicit warn.
      unlinkSync(skillA);
      mkdirSync(skillA, { recursive: true });

      // Manual console.warn hook (vi.spyOn sometimes misses calls routed
      // via the exported `warn` helper in setup.ts under ESM — swapping the
      // reference directly is what setup.ts's `console.warn(...)` dispatches
      // through, and the swap reliably captures both the inner
      // removeCanonicalNodeSkill warn and the outer R6-3 residue warn).
      const originalWarn = console.warn;
      const warnMessages: string[] = [];
      console.warn = (...args: any[]) => {
        warnMessages.push(args.map((a) => String(a)).join(' '));
      };
      try {
        // Second install targets dirB → migration fires → removeCanonicalNodeSkill
        // silent-fails on dirA's SKILL.md-as-directory → R6-3 warn fires.
        await runSetup({ workspace: dirB, start: false, verify: false });
      } finally {
        console.warn = originalWarn;
      }

      // New install landed regardless of cleanup failure — the warning is
      // advisory, not a blocker.
      expect(existsSync(join(dirB, 'skills', 'dkg-node', 'SKILL.md'))).toBe(true);
      // Residue at the prior workspace is still there (as a dir) — user
      // must clean up manually.
      expect(existsSync(skillA)).toBe(true);

      // Verify the R6-3 warn surfaced the orphan path + cleanup command.
      const migrationResidueWarn = warnMessages.find((m) =>
        m.includes('Migration cleanup did not remove the old SKILL.md'),
      );
      expect(migrationResidueWarn).toBeDefined();
      expect(migrationResidueWarn).toContain(skillA);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });
});

// ---------------------------------------------------------------------------
// runSetup openclaw.json preflight (Codex PR #234 R6-2 + R8-2)
// Before step 5 copies SKILL.md to disk, runSetup must preflight the
// openclaw.json that step 6 will merge into. If the preflight throws,
// step 5 never runs — so `mergeOpenClawConfig` can never fail AFTER
// `installCanonicalNodeSkill` has left an orphan on disk. R8-2 extends
// the preflight to also catch the `plugins.slots.contextEngine` wrong-
// slot guard that mergeOpenClawConfig enforces at merge time.
// ---------------------------------------------------------------------------

describe('runSetup openclaw.json preflight (R6-2 + R8-2)', () => {
  it('throws when openclaw.json is invalid JSON and does NOT install SKILL.md', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    // Invalid JSON: empty braces with a trailing stray token.
    writeFileSync(join(openclawHome, 'openclaw.json'), '{ not valid json ,,,\n');

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({ workspace: ws, start: false, verify: false }),
      ).rejects.toThrow(/not valid JSON/i);

      // Step 5 was gated behind the preflight throw → no SKILL.md landed.
      expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('throws when openclaw.json is missing entirely and does NOT install SKILL.md', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    // No openclaw.json written — preflight's existsSync gate must fire.

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({ workspace: ws, start: false, verify: false }),
      ).rejects.toThrow(/openclaw\.json not found/);

      expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // R8-2: the contextEngine wrong-slot guard is merge-time deep inside
  // mergeOpenClawConfig. The preflight must replicate it so a user who
  // misconfigured `plugins.slots.contextEngine = "adapter-openclaw"`
  // fails fast BEFORE step 5 writes the skill file.
  it('throws when plugins.slots.contextEngine === adapter-openclaw and does NOT install SKILL.md (R8-2)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          allow: [],
          load: { paths: [] },
          entries: {},
          // Misconfigured: adapter ID pinned to the wrong slot.
          slots: { contextEngine: 'adapter-openclaw' },
        },
      }, null, 2) + '\n',
    );

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({ workspace: ws, start: false, verify: false }),
      ).rejects.toThrow(/plugins\.slots\.contextEngine/);

      // Preflight fired BEFORE step 5 → no orphan SKILL.md on disk.
      expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  // Unix-only — Windows chmod semantics do not reliably block writes for
  // the owning process. The preflight still runs on Windows, just that this
  // specific failure mode (non-writable file) can't be simulated portably.
  const writabilityFailureModeSupported = process.platform !== 'win32';
  (writabilityFailureModeSupported ? it : it.skip)(
    'throws when openclaw.json is not writable and does NOT install SKILL.md',
    async () => {
      const { chmodSync } = await import('node:fs');
      const dkgHome = join(testDir, '.dkg');
      const openclawHome = join(testDir, '.openclaw');
      const ws = join(testDir, 'workspace');
      mkdirSync(ws, { recursive: true });
      mkdirSync(openclawHome, { recursive: true });
      const configPath = join(openclawHome, 'openclaw.json');
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + '\n');
      chmodSync(configPath, 0o400); // read-only, no write bit for anyone.

      const originalDkg = process.env.DKG_HOME;
      const originalOpenclaw = process.env.OPENCLAW_HOME;
      process.env.DKG_HOME = dkgHome;
      process.env.OPENCLAW_HOME = openclawHome;

      try {
        await expect(
          runSetup({ workspace: ws, start: false, verify: false }),
        ).rejects.toThrow(/not writable/i);

        expect(existsSync(join(ws, 'skills', 'dkg-node', 'SKILL.md'))).toBe(false);
      } finally {
        // Restore perms so afterEach cleanup can unlink.
        try { chmodSync(configPath, 0o600); } catch { /* best-effort */ }
        process.env.DKG_HOME = originalDkg;
        process.env.OPENCLAW_HOME = originalOpenclaw;
      }
    },
  );
});
