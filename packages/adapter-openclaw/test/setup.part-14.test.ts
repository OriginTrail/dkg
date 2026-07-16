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
