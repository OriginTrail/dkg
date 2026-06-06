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

describe('unmergeOpenClawConfig', () => {



  it('round-trip: user-customized channels.dkg-ui (non-enabled key) preserved through merge + unmerge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { 'dkg-ui': { enabled: true, port: 9999, customField: 'user-owned' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    // Merge leaves the user channel alone — no capture, no mutation.
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9999, customField: 'user-owned' });

    unmergeOpenClawConfig(configPath);

    // Unmerge still leaves it alone.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9999, customField: 'user-owned' });
  });

  // PR #250 review comment 3 — post-merge user edits must be preserved by
  // unmerge. The ownership check is strict deep-equal against the exact shape
  // merge wrote; any divergence means the user now owns the channel.
  it('round-trip: user adds field to merge-created channel → unmerge preserves user edit', () => {
    const configPath = join(testDir, 'openclaw.json');
    // Seed: no channels.dkg-ui at all.
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    // Simulate the user adding an auth block after merge.
    const userEdited = {
      ...afterMerge,
      channels: {
        ...afterMerge.channels,
        'dkg-ui': { ...afterMerge.channels['dkg-ui'], auth: { token: 'xyz' } },
      },
    };
    writeFileSync(configPath, JSON.stringify(userEdited, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    // User's edit survives — disconnect saw that the channel no longer matches
    // what merge wrote, so it left the channel entirely alone.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.channels['dkg-ui']).toEqual({
      enabled: true,
      port: 9201,
      auth: { token: 'xyz' },
    });
  });

  it('round-trip: user changes port on merge-created channel → unmerge preserves user port', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    // User changes the port.
    const userEdited = {
      ...afterMerge,
      channels: { ...afterMerge.channels, 'dkg-ui': { enabled: true, port: 9500 } },
    };
    writeFileSync(configPath, JSON.stringify(userEdited, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    // Port 9500 survives — it's not the shape merge wrote.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9500 });
  });

  it('round-trip: user edits degenerate-upgraded channel → unmerge preserves user edit', () => {
    const configPath = join(testDir, 'openclaw.json');
    // Seed: degenerate channel that merge upgrades by adding a port.
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { 'dkg-ui': { enabled: true } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    // User edits post-merge — changes port and adds a field.
    const userEdited = {
      ...afterMerge,
      channels: {
        ...afterMerge.channels,
        'dkg-ui': { enabled: true, port: 9500, foo: 'bar' },
      },
    };
    writeFileSync(configPath, JSON.stringify(userEdited, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    // The user's shape survives — disconnect did NOT restore the original
    // `{ enabled: true }` because the current channel diverges from the merge
    // output.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9500, foo: 'bar' });
  });

  // PR #250 review comment 8 — mergedToolsShape snapshot gates tools.profile
  // revert on the full `tools` section being untouched. User edits anywhere
  // under `tools` mean the whole section is user-owned; we leave it alone.
  it('round-trip: user adds unrelated tools field post-merge → unmerge preserves profile', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.tools.profile).toBe('full');

    // Simulate user adding an unrelated tools field — profile stays "full".
    const userEdited = {
      ...afterMerge,
      tools: { ...afterMerge.tools, web: { enabled: false } },
    };
    writeFileSync(configPath, JSON.stringify(userEdited, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    // Profile stays "full" — the tools section diverges from mergedToolsShape
    // (it has a new `web` field), so we treat the whole section as user-owned.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools.profile).toBe('full');
    expect(afterUnmerge.tools.web).toEqual({ enabled: false });
  });

  it('round-trip: unchanged tools section → unmerge reverts "coding" profile', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'coding' },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.tools.profile).toBe('full');

    // No post-merge edits — tools matches mergedToolsShape → revert runs.
    unmergeOpenClawConfig(configPath);

    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools.profile).toBe('coding');
  });

  // PR #250 review comment 10 — mergedToolsShape must refresh ONLY when this
  // merge pass actually mutated `config.tools`. Otherwise a re-merge that
  // respects a later user choice (e.g. profile changed to "minimal") would
  // overwrite the snapshot with the user's current shape, causing unmerge's
  // deep-equal to match and silently revert `previousToolsProfile`.
  it('re-merge after user switches to "minimal": mergedToolsShape stays at prior output, unmerge preserves "minimal"', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'coding' },
    }));

    // First merge: upgrades "coding" → "full" and captures mergedToolsShape.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterFirst = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterFirst.tools.profile).toBe('full');
    expect(afterFirst.plugins.entries['adapter-openclaw'].mergedToolsShape)
      .toEqual({ alsoAllow: ['group:plugins'], profile: 'full' });
    expect(afterFirst.plugins.entries['adapter-openclaw'].previousToolsProfile).toBe('coding');

    // User switches to "minimal" and adds a post-merge field.
    afterFirst.tools = { profile: 'minimal', alsoAllow: ['group:plugins'], web: { enabled: false } };
    writeFileSync(configPath, JSON.stringify(afterFirst, null, 2) + '\n');

    // Re-merge: "minimal" is respected (no profile mutation), alsoAllow already
    // present (no push). mutatedTools stays false, so the snapshot is NOT
    // overwritten with the current user shape.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterSecond = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterSecond.tools.profile).toBe('minimal');
    // Snapshot still reflects the FIRST merge's output, not the user's current shape.
    expect(afterSecond.plugins.entries['adapter-openclaw'].mergedToolsShape)
      .toEqual({ alsoAllow: ['group:plugins'], profile: 'full' });

    // Unmerge: current tools (`minimal`, with `web` field) ≠ snapshot (`full`)
    // → deep-equal fails → profile revert is skipped → user's "minimal" survives.
    unmergeOpenClawConfig(configPath);
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools.profile).toBe('minimal');
    expect(afterUnmerge.tools.web).toEqual({ enabled: false });
  });

  it('first-merge no-op on settled tools: mergedToolsShape is NOT captured when nothing was mutated', () => {
    const configPath = join(testDir, 'openclaw.json');
    // Config already has profile: "full" and alsoAllow includes "group:plugins".
    // Merge has nothing to do under `config.tools` — should not capture a snapshot.
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'full', alsoAllow: ['group:plugins'] },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.tools.profile).toBe('full');
    // No mutation ⇒ no capture. previousToolsProfile also stays absent.
    expect(config.plugins.entries['adapter-openclaw'].mergedToolsShape).toBeUndefined();
    expect('previousToolsProfile' in config.plugins.entries['adapter-openclaw']).toBe(false);
  });

  it('re-merge idempotency on settled tools: snapshot once captured, not re-written on no-op re-merge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // First merge creates the settled state + captures the snapshot.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const firstRun = readFileSync(configPath, 'utf-8');
    const firstBackups = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    // Second merge: tools is already settled — no mutation should occur.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const secondRun = readFileSync(configPath, 'utf-8');
    const secondBackups = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;

    // Byte-identical output proves mergedToolsShape wasn't re-written with a
    // (possibly differently-ordered) new structuredClone.
    expect(secondRun).toBe(firstRun);
    expect(secondBackups).toBe(firstBackups);
  });

});
