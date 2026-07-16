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
