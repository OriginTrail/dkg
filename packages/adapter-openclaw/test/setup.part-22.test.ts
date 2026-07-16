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
// Preflight runs BEFORE daemon + faucet (C10 extraction)
//
// With the preflight moved to new Step 4 (between writeDkgConfig and
// startDaemon), deterministic openclaw.json misconfigurations must throw
// BEFORE the faucet gets called. This matters because faucet calls count
// against the 3-calls-per-8h IP-level rate limit regardless of outcome
// — so a user with a broken openclaw.json shouldn't burn a slot on a
// setup that was always going to fail at merge.
// ---------------------------------------------------------------------------

describe('runSetup preflight runs before faucet (C10)', () => {
  beforeEach(() => {
    vi.mocked(requestFaucetFunding).mockReset();
    vi.mocked(requestFaucetFunding).mockResolvedValue({
      success: true,
      funded: ['0.01 ETH', '1000 TRAC'],
    });
  });



  it('does NOT call the faucet when openclaw.json is missing', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    // Pre-seed wallets.json so Step 6 would succeed if it ever ran.
    writeFileSync(
      join(dkgHome, 'wallets.json'),
      JSON.stringify({ wallets: [{ address: '0xAA', privateKey: '0x01' }] }),
    );
    // Intentionally no openclaw.json — preflight must throw before faucet.

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({ workspace: ws, start: false, verify: false }),
      ).rejects.toThrow(/openclaw\.json not found/);

      expect(requestFaucetFunding).not.toHaveBeenCalled();
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('does NOT call the faucet when openclaw.json is invalid JSON', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(dkgHome, 'wallets.json'),
      JSON.stringify({ wallets: [{ address: '0xAA', privateKey: '0x01' }] }),
    );
    writeFileSync(join(openclawHome, 'openclaw.json'), '{ not valid json ,,,\n');

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    try {
      await expect(
        runSetup({ workspace: ws, start: false, verify: false }),
      ).rejects.toThrow(/not valid JSON/i);

      expect(requestFaucetFunding).not.toHaveBeenCalled();
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

  it('does NOT call the faucet when plugins.slots.contextEngine is wrong-slot-wired (R8-2)', async () => {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const ws = join(testDir, 'workspace');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(dkgHome, 'wallets.json'),
      JSON.stringify({ wallets: [{ address: '0xAA', privateKey: '0x01' }] }),
    );
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          allow: [],
          load: { paths: [] },
          entries: {},
          slots: { contextEngine: 'adapter-openclaw' }, // misconfigured
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

      expect(requestFaucetFunding).not.toHaveBeenCalled();
    } finally {
      process.env.DKG_HOME = originalDkg;
      process.env.OPENCLAW_HOME = originalOpenclaw;
    }
  });

});
