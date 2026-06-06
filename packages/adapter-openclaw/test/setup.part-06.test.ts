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



  // PR #250 review comment 2 — keep top-level channels.dkg-ui.port in sync with
  // the adapter entry's own config.channel.port so the plugin doesn't end up
  // looking at two different ports in two different places.
  it('channels.dkg-ui.port: derives from entryConfig.channel.port when provided', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 9300 },
    } as AdapterEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
  });

  // PR #250 review comment 6 — on re-runs, the adapter entry's existing port
  // wins (first-wins) over the incoming default. The top-level channel must
  // match the preserved entry port, not the incoming fallback 9201.
  it('channels.dkg-ui.port: uses preserved entry.config.channel.port on re-merge even when incoming entryConfig has no port', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: {
              daemonUrl: 'http://127.0.0.1:9200',
              memory: { enabled: true },
              channel: { enabled: true, port: 9300 },
            },
          },
        },
      },
    }));

    // Incoming entryConfig has no port — first-wins preserves the existing 9300
    // on the adapter entry, and the top-level channel should inherit it.
    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true },
    } as AdapterEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.plugins.entries['adapter-openclaw'].config.channel.port).toBe(9300);
    expect(config.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
  });

  // PR #250 review comment 7 — after a first merge, the channel is strictly
  // adapter-owned (byte-identical to mergedChannelsDkgUi). A re-run with a
  // different port must refresh the top-level channel, not leave the stale
  // port in place. The strict user-edit guard from comment 3 shouldn't
  // prevent adapter-owned refresh.
  it('re-merge refreshes channels.dkg-ui.port when the channel still matches last merge output', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // First merge with default entryConfig → creates { enabled: true, port: 9201 }.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });
    expect(afterFirst.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9201 });

    // Simulate the user (or a later setup run) updating the adapter entry's
    // channel port to 9300 directly on the entry config.
    afterFirst.plugins.entries['adapter-openclaw'].config.channel.port = 9300;
    writeFileSync(configPath, JSON.stringify(afterFirst, null, 2) + '\n');

    // Re-merge with default entryConfig (no port) — first-wins preserves 9300
    // on the entry, and the adapter-owned channel should refresh to match.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterSecond.plugins.entries['adapter-openclaw'].config.channel.port).toBe(9300);
    expect(afterSecond.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
    // mergedChannelsDkgUi tracks the latest adapter output.
    expect(afterSecond.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9300 });
  });

  it('re-merge idempotency: unchanged adapter-owned channel produces byte-identical JSON', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const firstRun = readFileSync(configPath, 'utf-8');
    const firstBackups = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    // Re-run with identical state — the refresh branch must be a no-op.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const secondRun = readFileSync(configPath, 'utf-8');
    const secondBackups = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    expect(secondRun).toBe(firstRun);
    expect(secondBackups).toBe(firstBackups);
  });

  // PR #250 review comment 9 — `mergedChannelsDkgUi` must refresh on EVERY
  // channel write, not just the first-wins capture path. Re-creation or
  // re-upgrade at a different port on a subsequent merge needs the snapshot
  // to follow, otherwise unmerge's deep-equal ownership check fails and the
  // adapter-owned channel is left behind on disconnect.
  it('re-create after user deletion: mergedChannelsDkgUi tracks the NEW port, previousChannelsDkgUi stays first-wins', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // First merge at port 9201.
    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 9201 },
    } as AdapterEntryConfig, defaultInstalledWorkspace);

    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.plugins.entries['adapter-openclaw'].previousChannelsDkgUi).toBeNull();
    expect(afterFirst.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9201 });

    // Simulate user deleting channels.dkg-ui. Also reset entry port so
    // post-merge resolution picks 9300.
    delete afterFirst.channels['dkg-ui'];
    afterFirst.plugins.entries['adapter-openclaw'].config.channel.port = 9300;
    writeFileSync(configPath, JSON.stringify(afterFirst, null, 2) + '\n');

    // Re-merge: must re-create at 9300 and refresh mergedChannelsDkgUi.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterSecond.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
    // `previousChannelsDkgUi` stays first-wins (original absent → `null`).
    expect(afterSecond.plugins.entries['adapter-openclaw'].previousChannelsDkgUi).toBeNull();
    // `mergedChannelsDkgUi` tracks the LATEST output (9300, not stale 9201).
    expect(afterSecond.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9300 });
  });

  it('re-upgrade degenerate channel: mergedChannelsDkgUi tracks the NEW port, previousChannelsDkgUi stays first-wins', () => {
    const configPath = join(testDir, 'openclaw.json');
    // Seed: degenerate channel so the first merge captures
    // previousChannelsDkgUi = { enabled: true } (first-wins).
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { 'dkg-ui': { enabled: true } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', {
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
      channel: { enabled: true, port: 9201 },
    } as AdapterEntryConfig, defaultInstalledWorkspace);

    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.plugins.entries['adapter-openclaw'].previousChannelsDkgUi).toEqual({ enabled: true });
    expect(afterFirst.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9201 });

    // Simulate user stripping channel back to degenerate + bumping entry port.
    afterFirst.channels['dkg-ui'] = { enabled: true };
    afterFirst.plugins.entries['adapter-openclaw'].config.channel.port = 9300;
    writeFileSync(configPath, JSON.stringify(afterFirst, null, 2) + '\n');

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterSecond.channels['dkg-ui']).toEqual({ enabled: true, port: 9300 });
    // first-wins preserves the original degenerate shape.
    expect(afterSecond.plugins.entries['adapter-openclaw'].previousChannelsDkgUi).toEqual({ enabled: true });
    // Latest-output snapshot follows the new port.
    expect(afterSecond.plugins.entries['adapter-openclaw'].mergedChannelsDkgUi).toEqual({ enabled: true, port: 9300 });
  });

});
