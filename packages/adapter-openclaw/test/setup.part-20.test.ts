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

describe('runSetup workspace migration', () => {



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
