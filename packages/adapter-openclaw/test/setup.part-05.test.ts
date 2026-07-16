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

describe('mergeOpenClawConfig', () => {



  it('preserves a user-owned stateDir on re-merge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              stateDir: '/user/custom/openclaw-state',
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(defaultInstalledWorkspace, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe('/user/custom/openclaw-state');
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBeUndefined();
  });

  it('preserves a user-owned stateDir that happens to equal the prior workspace default', () => {
    const configPath = join(testDir, 'openclaw.json');
    const firstWs = join(testDir, 'workspace-user-default-a');
    const secondWs = join(testDir, 'workspace-user-default-b');
    const userPinnedStateDir = join(firstWs, '.openclaw');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              installedWorkspace: firstWs,
              stateDir: userPinnedStateDir,
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(secondWs, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, secondWs);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entryConfig = config.plugins.entries['adapter-openclaw'].config;
    expect(entryConfig.stateDir).toBe(userPinnedStateDir);
    expect(entryConfig.stateDirSource).toBeUndefined();
    expect(entryConfig.installedWorkspace).toBe(secondWs);
  });

  it('updates setup-owned stateDir when installedWorkspace changes', () => {
    const configPath = join(testDir, 'openclaw.json');
    const firstWs = join(testDir, 'workspace-a');
    const secondWs = join(testDir, 'workspace-b');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(firstWs, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, firstWs);

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(secondWs, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, secondWs);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(join(secondWs, '.dkg-adapter'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBe('setup-default');
    expect(config.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(secondWs);
  });

  it('rewrites the legacy setup-owned .openclaw default to .dkg-adapter on re-merge', () => {
    const configPath = join(testDir, 'openclaw.json');
    const ws = join(testDir, 'workspace-legacy-default');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              installedWorkspace: ws,
              stateDir: join(ws, '.openclaw'),
              stateDirSource: 'setup-default',
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(ws, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, ws);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(join(ws, '.dkg-adapter'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBe('setup-default');
    expect(config.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(ws);
  });

  it('updates setup-owned stateDir when existing installedWorkspace and stateDir have surrounding whitespace', () => {
    const configPath = join(testDir, 'openclaw.json');
    const firstWs = join(testDir, 'workspace-whitespace-a');
    const secondWs = join(testDir, 'workspace-whitespace-b');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              installedWorkspace: `  ${firstWs}  `,
              stateDir: `  ${join(firstWs, '.openclaw')}  `,
              stateDirSource: 'setup-default',
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(secondWs, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, secondWs);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(join(secondWs, '.dkg-adapter'));
    expect(config.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(secondWs);
  });

  it('updates setup-owned stateDir when the existing value uses a symlink alias', () => {
    const configPath = join(testDir, 'openclaw.json');
    const realWs = join(testDir, 'workspace-real');
    const aliasWs = join(testDir, 'workspace-alias');
    const secondWs = join(testDir, 'workspace-next');
    mkdirSync(realWs, { recursive: true });
    mkdirSync(secondWs, { recursive: true });
    try {
      symlinkSync(realWs, aliasWs, 'dir');
    } catch {
      return;
    }
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              installedWorkspace: realWs,
              stateDir: join(aliasWs, '.openclaw'),
              stateDirSource: 'setup-default',
            },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: join(secondWs, '.dkg-adapter'),
      stateDirSource: 'setup-default',
      memory: { enabled: true },
      channel: { enabled: true },
    }, secondWs);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDir).toBe(join(secondWs, '.dkg-adapter'));
    expect(config.plugins.entries['adapter-openclaw'].config.stateDirSource).toBe('setup-default');
    expect(config.plugins.entries['adapter-openclaw'].config.installedWorkspace).toBe(secondWs);
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

  // PR A — tools.profile patch. Ensures plugin-registered `dkg_*` tools are
  // visible to the agent by upgrading the common default `"coding"` profile
  // (whose allowlist filters out plugin tools) to `"full"`, while respecting
  // explicit restrictive profiles ("minimal", "messaging").
  it('tools.profile: upgrades "coding" → "full"', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'coding' },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.tools.profile).toBe('full');
  });

  it('tools.profile: respects explicit "minimal" (no change)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'minimal' },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.tools.profile).toBe('minimal');
  });

  it('tools.profile: respects explicit "messaging" (no change)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'messaging' },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.tools.profile).toBe('messaging');
  });

  it('tools.profile: sets "full" when absent', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.tools.profile).toBe('full');
  });

  // PR A — channels.dkg-ui patch. Without at least one non-`enabled` key on
  // the channel entry, OpenClaw's loader demotes the plugin to setup-runtime
  // mode where `api.registerTool` is a noop. A port pin is the cheapest
  // non-`enabled` key that satisfies `hasMeaningfulChannelConfigShallow`.
  it('channels.dkg-ui: creates { enabled: true, port: 9201 } when missing', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });
  });

  it('channels.dkg-ui: adds port to degenerate { enabled: true }', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { 'dkg-ui': { enabled: true } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });
  });

  it('channels.dkg-ui: preserves existing user port (no change)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { 'dkg-ui': { enabled: true, port: 9300 } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
  });

  it('is idempotent on tools.profile + channels.dkg-ui — byte-identical output on second run', () => {
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

});
