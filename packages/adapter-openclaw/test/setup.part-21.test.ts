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

  // the contextEngine wrong-slot guard is merge-time deep inside
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
