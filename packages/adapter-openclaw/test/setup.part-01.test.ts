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
// discoverAgentName
// ---------------------------------------------------------------------------

describe('discoverAgentName', () => {
  // Point DKG_HOME at a fresh tmp dir per test so the persisted-name
  // branch (C8) sees no ~/.dkg/config.json unless the test explicitly
  // seeds one. Otherwise, a dev-machine `~/.dkg/config.json.name`
  // would leak into these tests and break the fallback assertions.
  let originalDkg: string | undefined;
  let dkgHome: string;

  beforeEach(() => {
    originalDkg = process.env.DKG_HOME;
    dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    process.env.DKG_HOME = dkgHome;
  });

  afterEach(() => {
    process.env.DKG_HOME = originalDkg;
  });



  it('returns override when provided', () => {
    expect(discoverAgentName('/nonexistent', 'my-agent')).toBe('my-agent');
  });

  it('parses name from IDENTITY.md with Name field', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\n- **Name**: Alice\n- **Role**: Assistant\n');
    expect(discoverAgentName(ws)).toBe('Alice');
  });

  it('parses name from plain Name: format', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# My Agent\nName: Bob\n');
    expect(discoverAgentName(ws)).toBe('Bob');
  });

  it('falls back to generated name when IDENTITY.md has no Name field and no persisted config', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\nJust some text\n');
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  it('falls back to generated name when IDENTITY.md is missing and no persisted config', () => {
    const ws = join(testDir, 'my-workspace');
    mkdirSync(ws, { recursive: true });
    const name = discoverAgentName(ws);
    expect(name).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  // C8: persisted name stability. On re-runs where IDENTITY.md is absent
  // (or has no Name: field), the faucet Idempotency-Key must stay stable
  // across invocations to avoid duplicate requests. Honoring
  // `~/.dkg/config.json.name` (written by a prior setup run via
  // writeDkgConfig's first-wins semantics) achieves this without
  // introducing a new source of truth.
  it('returns the persisted name from ~/.dkg/config.json when IDENTITY.md is missing', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: 'persisted-agent' }));
    expect(discoverAgentName(ws)).toBe('persisted-agent');
  });

  it('returns the persisted name when IDENTITY.md has no Name: field', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\nJust some text\n');
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: 'persisted-agent' }));
    expect(discoverAgentName(ws)).toBe('persisted-agent');
  });

  it('prefers IDENTITY.md over persisted name when both are present', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\nName: Alice\n');
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: 'persisted-agent' }));
    expect(discoverAgentName(ws)).toBe('Alice');
  });

  it('prefers the override arg over both IDENTITY.md and persisted name', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'IDENTITY.md'), '# Identity\nName: Alice\n');
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: 'persisted-agent' }));
    expect(discoverAgentName(ws, 'override-agent')).toBe('override-agent');
  });

  it('falls through to random when persisted config.json exists but lacks a name field', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ apiPort: 9200 }));
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  it('falls through to random when persisted config.json is unparseable', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), '{not-json');
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  it('falls through to random when persisted config.json has a non-string name', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: 42 }));
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

  it('falls through to random when persisted config.json has an empty-string name', () => {
    const ws = join(testDir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({ name: '   ' }));
    expect(discoverAgentName(ws)).toMatch(/^openclaw-agent-[a-z0-9]+$/);
  });

});
