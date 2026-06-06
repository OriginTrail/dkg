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

});
