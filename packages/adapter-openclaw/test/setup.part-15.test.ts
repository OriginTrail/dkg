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
// resolveWorkspaceDirFromConfig — shared resolver between setup install and
// the daemon-side Disconnect path (Codex PR #234 R1-1).
// ---------------------------------------------------------------------------

describe('resolveWorkspaceDirFromConfig', () => {
  // Use a deterministic openclaw.json path inside testDir so relative-path
  // resolution is independent of cwd. OPENCLAW_HOME is scoped per-test only
  // for the default-fallback cases.
  let openclawConfigFilePath: string;

  beforeEach(() => {
    const openclawHome = join(testDir, '.openclaw');
    mkdirSync(openclawHome, { recursive: true });
    openclawConfigFilePath = join(openclawHome, 'openclaw.json');
  });



  it('prefers agents.defaults.workspace over other key variants', () => {
    const wanted = join(testDir, 'wanted-ws');
    const result = resolveWorkspaceDirFromConfig(
      {
        agents: { defaults: { workspace: wanted } },
        workspace: join(testDir, 'ignored-ws'),
        workspaceDir: join(testDir, 'also-ignored'),
      },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('falls back to top-level workspace when agents.defaults.workspace is absent', () => {
    const wanted = join(testDir, 'top-level-ws');
    const result = resolveWorkspaceDirFromConfig(
      { workspace: wanted, workspaceDir: join(testDir, 'ignored') },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('falls back to workspaceDir when the first two keys are absent', () => {
    const wanted = join(testDir, 'legacy-key-ws');
    const result = resolveWorkspaceDirFromConfig(
      { workspaceDir: wanted },
      openclawConfigFilePath,
    );
    expect(result).toBe(wanted);
  });

  it('expands a leading ~ to homedir()', () => {
    const result = resolveWorkspaceDirFromConfig(
      { agents: { defaults: { workspace: '~/foo' } } },
      openclawConfigFilePath,
    );
    expect(result).toBe(join(homedir(), 'foo'));
  });

  it('resolves relative paths against dirname(openclawConfigPath) — not cwd', () => {
    const result = resolveWorkspaceDirFromConfig(
      { workspace: './workspace' },
      openclawConfigFilePath,
    );
    expect(result).toBe(join(dirname(openclawConfigFilePath), 'workspace'));
  });

  it('passes absolute paths through unchanged', () => {
    const absolute = join(testDir, 'already', 'absolute');
    const result = resolveWorkspaceDirFromConfig(
      { workspace: absolute },
      openclawConfigFilePath,
    );
    expect(result).toBe(absolute);
  });

  it('returns default $OPENCLAW_HOME/workspace when no key is set but the dir exists', () => {
    const openclawHome = join(testDir, 'default-home');
    const defaultWs = join(openclawHome, 'workspace');
    mkdirSync(defaultWs, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBe(defaultWs);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  it('returns null when no key is set and the default $OPENCLAW_HOME/workspace does not exist', () => {
    const openclawHome = join(testDir, 'empty-home');
    mkdirSync(openclawHome, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  // the default-fallback must derive from `dirname(openclawConfigPath)`
  // rather than the process-wide `$OPENCLAW_HOME`. A legacy install whose
  // openclaw.json lives at a non-default path (e.g. a user-specified
  // `--config-path`-style location in scripts, or a `OPENCLAW_HOME`-shadowed
  // directory from a prior version) would otherwise resolve to the default
  // `~/.openclaw/workspace` on Disconnect — cleaning the wrong SKILL.md or
  // missing the real one.
  it('derives the default fallback from dirname(openclawConfigPath), not $OPENCLAW_HOME (R9-1)', () => {
    // Set `OPENCLAW_HOME` to one place; the openclaw.json lives somewhere
    // else entirely. The fallback must target the config-adjacent workspace,
    // NOT `$OPENCLAW_HOME/workspace`.
    const shadowHome = join(testDir, 'shadow-openclaw-home');
    const shadowWs = join(shadowHome, 'workspace');
    mkdirSync(shadowWs, { recursive: true });

    const configHome = join(testDir, 'legacy-install-dir');
    const configWs = join(configHome, 'workspace');
    mkdirSync(configWs, { recursive: true });
    const legacyConfigPath = join(configHome, 'openclaw.json');

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = shadowHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        { plugins: {} },
        legacyConfigPath,
      );
      // Correct answer: co-located with the config file.
      expect(result).toBe(configWs);
      // Pre-R9-1 regression guard — the shadow path must NOT win.
      expect(result).not.toBe(shadowWs);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

  it('returns null when the winning key is present but not a non-empty string (no fallback cascade across keys)', () => {
    // Matches discoverWorkspace semantics: `??` only skips null/undefined, so
    // a present-but-empty-string / non-string value does NOT cascade to the
    // next key. With no default $OPENCLAW_HOME/workspace on disk the resolver
    // returns null, matching the existing install-path throw conditions.
    const openclawHome = join(testDir, 'empty-home-2');
    mkdirSync(openclawHome, { recursive: true });

    const original = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;
    try {
      const result = resolveWorkspaceDirFromConfig(
        {
          agents: { defaults: { workspace: '' } },
          workspace: 'would-have-been-picked-if-cascading',
        },
        join(openclawHome, 'openclaw.json'),
      );
      expect(result).toBeNull();
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_HOME;
      else process.env.OPENCLAW_HOME = original;
    }
  });

});
