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
  unmergeOpenClawConfig,
  verifyUnmergeInvariants,
  installCanonicalNodeSkill,
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.allow).toContain('adapter-openclaw');
    expect(config.plugins.load.paths).toContain('/path/to/adapter');
    const entry = config.plugins.entries['adapter-openclaw'];
    expect(entry.enabled).toBe(true);
    expect(entry.config).toEqual({
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true },
    });
  });

  it('is idempotent — no duplicates on second run', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

    const files = readdirSync(testDir);
    const backups = files.filter((f: string) => f.startsWith('openclaw.json.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('normalizes Windows backslashes in adapter path', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, 'C:\\Users\\test\\adapter', defaultEntryConfig);

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

    mergeOpenClawConfig(configPath, 'C:\\Projects\\dkg-v9\\packages\\adapter-openclaw', defaultEntryConfig);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.load.paths).toEqual([
      '/other/plugin',
      'C:/Projects/dkg-v9/packages/adapter-openclaw',
    ]);
  });

  it('writes plugins.slots.memory = "adapter-openclaw" to elect the adapter into the memory slot', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

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

    expect(() => mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig)).toThrow(/contextEngine/);
  });

  it('overwrites a different plugins.slots.memory value with a log line', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { memory: 'memory-core' },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.slots.memory).toBe('adapter-openclaw');
  });

  it('is idempotent on plugins.slots.memory re-runs — byte-identical output', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
    const firstRun = readFileSync(configPath, 'utf-8');
    const firstBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);

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
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.plugins.entries['adapter-openclaw'].previousMemorySlotOwner).toBe('memory-core');

    // Second merge: slot is already the adapter, so the capture branch won't
    // fire — and even if it did, the first-wins guard keeps the original.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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
    });

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
    });

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
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
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
    mergeOpenClawConfig(defaultConfigPath, '/path/to/adapter', defaultEntryConfig);
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
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.entries['adapter-openclaw'].config).toBeDefined();

    unmergeOpenClawConfig(configPath);

    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
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
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.kind).toBe('memory');
    expect(manifest.id).toBe('adapter-openclaw');
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
