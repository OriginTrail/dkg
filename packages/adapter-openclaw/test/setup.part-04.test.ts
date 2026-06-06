import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Mock the core module at the module boundary so every `runSetup` invocation
// in this suite gets a controllable `requestFaucetFunding` spy. `vi.mock` is
// hoisted by vitest, so the mock intercepts `setup.ts`'s top-level import
// regardless of where this line appears. Other `@origintrail-official/dkg-core`
// exports are passed through unchanged via `importActual` so existing tests
// that rely on core semantics (transitive imports) stay intact.
//
// We hoist the same `requestFaucetFunding` spy and inject it into TWO mock
// surfaces: (1) the dkg-core barrel (so any direct caller in this package
// gets the spy via the public surface), and (2) the dkg-core `dist/faucet.js`
// module path (so `fundWalletsBestEffort` inside dkg-core's own
// `faucet-orchestration.ts` — which calls `requestFaucetFunding` via an
// in-package import — also routes through the spy). The barrel-level mock
// alone wouldn't intercept dkg-core's intra-package call after the S1 of
// issue #386 extracted the orchestrator into core (`fundWalletsBestEffort`
// reaches `requestFaucetFunding` via `./faucet.js`, not via the barrel).
const requestFaucetFundingSpy = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, funded: ['0.01 ETH', '1000 TRAC'] })),
);
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    requestFaucetFunding: requestFaucetFundingSpy,
    fundWalletsBestEffort: vi.fn(async ({ network, idempotencySeed, callerId, didStartDaemon }) => {
      const faucetUrl = network?.faucet?.url;
      const faucetMode = network?.faucet?.mode;
      if (!faucetUrl || !faucetMode) return;

      const walletAddresses = didStartDaemon
        ? await actual.readWalletsWithRetry()
        : actual.readWallets();
      if (!walletAddresses.length) return;

      try {
        const result = await requestFaucetFundingSpy(
          faucetUrl,
          faucetMode,
          walletAddresses,
          idempotencySeed ?? callerId,
        );
        if (!result.success || result.error) {
          actual.logManualFundingInstructions(
            result.failedWallets?.length ? result.failedWallets : walletAddresses,
            faucetUrl,
            faucetMode,
          );
        }
      } catch {
        actual.logManualFundingInstructions(walletAddresses, faucetUrl, faucetMode);
      }
    }),
  };
});
import { requestFaucetFunding } from '@origintrail-official/dkg-core';

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
  loadNetworkConfig,
  readWallets,
  readWalletsWithRetry,
  logManualFundingInstructions,
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

  it('writes entry.config.stateDir when setup provides a workspace-scoped default', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const stateDir = join(defaultInstalledWorkspace, '.dkg-adapter');

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir,
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(stateDir);
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBe('setup-default');
  });

  it('does not mark an incoming stateDir as setup-owned without the setup marker', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    const stateDir = join(defaultInstalledWorkspace, '.dkg-adapter');

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir,
      memory: { enabled: true },
      channel: { enabled: true },
    }, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(stateDir);
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBeUndefined();
  });

  it('preserves an existing setup-owned stateDir marker when entryConfig omits stateDir', () => {
    const configPath = join(testDir, 'openclaw.json');
    const stateDir = join(defaultInstalledWorkspace, '.openclaw');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              installedWorkspace: defaultInstalledWorkspace,
              stateDir,
              stateDirSource: 'setup-default',
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
    expect(entryConfig.stateDir).toBe(stateDir);
    expect(entryConfig.stateDirSource).toBe('setup-default');
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

});
