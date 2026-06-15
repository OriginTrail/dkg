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
// unmergeOpenClawConfig (PR #228 Codex N2 — restore prior memory-slot owner)
// ---------------------------------------------------------------------------

describe('unmergeOpenClawConfig', () => {


  it('restores plugins.slots.memory to the previous owner when the merge persisted one', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    // Merge → captures "memory-core" as previousMemorySlotOwner.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.slots.memory).toBe('adapter-openclaw');
    expect(afterMerge.plugins.entries['adapter-openclaw'].config.dkgSetupState.previousMemorySlotOwner).toBe('memory-core');

    // Unmerge → restores "memory-core" and removes the entry entirely.
    unmergeOpenClawConfig(configPath);
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.slots.memory).toBe('memory-core');
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  it('clears plugins.slots.memory when no prior owner was persisted', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // Merge on a clean config — no previousMemorySlotOwner is captured.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.slots.memory).toBe('adapter-openclaw');
    expect(afterMerge.plugins.entries['adapter-openclaw'].config.dkgSetupState?.previousMemorySlotOwner).toBeUndefined();

    unmergeOpenClawConfig(configPath);
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.slots.memory).toBeUndefined();
  });

  it('merge→unmerge round-trip from a clean openclaw.json restores the original memory-slot state', () => {
    const configPath = join(testDir, 'openclaw.json');
    // "clean" here means: plugins object exists but no slot is set; mimics a
    // fresh install that hasn't configured a memory provider yet.
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    unmergeOpenClawConfig(configPath);

    const final = JSON.parse(readFileSync(configPath, 'utf-8'));
    // plugins.slots.memory is unset again — same as before the merge/unmerge cycle.
    expect(final.plugins.slots?.memory).toBeUndefined();
  });

  it('is idempotent — a second unmerge on an already-disconnected config writes nothing', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    unmergeOpenClawConfig(configPath);
    const firstBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;
    const firstContent = readFileSync(configPath, 'utf-8');

    unmergeOpenClawConfig(configPath);
    const secondBackupCount = readdirSync(testDir).filter((f: string) => f.startsWith('openclaw.json.bak.')).length;
    const secondContent = readFileSync(configPath, 'utf-8');

    expect(secondContent).toBe(firstContent);
    expect(secondBackupCount).toBe(firstBackupCount);
  });

  it('leaves plugins.slots.memory alone when the user has externally re-owned the slot between merge and unmerge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    // Simulate external modification: user swaps in a different memory plugin.
    const intermediate = JSON.parse(readFileSync(configPath, 'utf-8'));
    intermediate.plugins.slots.memory = 'some-other-memory-plugin';
    writeFileSync(configPath, JSON.stringify(intermediate, null, 2) + '\n');

    unmergeOpenClawConfig(configPath);

    const final = JSON.parse(readFileSync(configPath, 'utf-8'));
    // We don't clobber the user's new choice, and the adapter entry is gone.
    expect(final.plugins.slots.memory).toBe('some-other-memory-plugin');
    expect(final.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  // PR #228 Codex N4 — a missing openclaw.json is treated as already-
  // disconnected so the Disconnect UI flow doesn't strand users who removed
  // or relocated OpenClaw. No throw, no `.bak`, no file created.
  it('is a no-op when openclaw.json is missing', () => {
    const configPath = join(testDir, 'does-not-exist.json');
    const countBefore = readdirSync(testDir).length;

    expect(() => unmergeOpenClawConfig(configPath)).not.toThrow();

    expect(existsSync(configPath)).toBe(false);
    expect(readdirSync(testDir).length).toBe(countBefore);
    expect(
      readdirSync(testDir).some((f: string) => f.includes('.bak.')),
    ).toBe(false);
  });

  it('is a no-op when openclaw.json exists but is not valid JSON', () => {
    const configPath = join(testDir, 'openclaw.json');
    const original = '{ not-valid-json';
    writeFileSync(configPath, original);
    const countBefore = readdirSync(testDir).length;

    expect(() => unmergeOpenClawConfig(configPath)).not.toThrow();

    // File untouched (not rewritten), no `.bak` sibling written.
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readdirSync(testDir).length).toBe(countBefore);
    expect(
      readdirSync(testDir).some((f: string) => f.startsWith('openclaw.json.bak.')),
    ).toBe(false);
  });

  // PR #228 Codex R4-N1 — when a caller supplies an explicit openclaw.json
  // path that doesn't exist, we must NOT silently fall back to the default
  // `~/.openclaw/openclaw.json`. Doing so would unmerge the wrong config for
  // users who relocated OpenClaw (data-corruption path).
  it('does NOT fall back to the default home when an explicit missing path is supplied', () => {
    // The explicit path the caller passes: a directory that doesn't contain openclaw.json.
    const relocated = join(testDir, 'relocated-openclaw');
    mkdirSync(relocated, { recursive: true });
    const explicitMissingPath = join(relocated, 'openclaw.json');

    // The default home we want left untouched — a fully-merged config that
    // would be visibly mutated if unmerge fell through to it.
    const defaultHome = join(testDir, 'default-openclaw');
    mkdirSync(defaultHome, { recursive: true });
    const defaultConfigPath = join(defaultHome, 'openclaw.json');
    writeFileSync(defaultConfigPath, JSON.stringify({ plugins: {} }, null, 2) + '\n');
    mergeOpenClawConfig(defaultConfigPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const defaultContentBefore = readFileSync(defaultConfigPath, 'utf-8');
    const defaultBackupsBefore = readdirSync(defaultHome).filter(
      (f: string) => f.startsWith('openclaw.json.bak.'),
    ).length;

    // Point OPENCLAW_HOME at `defaultHome` — this is what setup.ts's
    // `openclawDir()` would consult if the explicit-path guard fell through.
    const originalEnv = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = defaultHome;
    try {
      expect(() => unmergeOpenClawConfig(explicitMissingPath)).not.toThrow();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = originalEnv;
      }
    }

    // The default home's config must be byte-identical and no new `.bak`.
    expect(readFileSync(defaultConfigPath, 'utf-8')).toBe(defaultContentBefore);
    const defaultBackupsAfter = readdirSync(defaultHome).filter(
      (f: string) => f.startsWith('openclaw.json.bak.'),
    ).length;
    expect(defaultBackupsAfter).toBe(defaultBackupsBefore);
    // And the explicit path didn't get a freshly-created file either.
    expect(existsSync(explicitMissingPath)).toBe(false);
  });

  // D1 — unmerge deletes the adapter entry entirely (including its config
  // sub-object). The adapter owns every field on this entry post-D2, so there
  // is no user-customizable state to preserve.
  it('removes the adapter entry entirely on unmerge (including entry.config)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    // Merge populates entry + entry.config.
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.plugins.entries['adapter-openclaw'].config).toBeDefined();

    unmergeOpenClawConfig(configPath);

    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  // Codex PR #234 R2-1 (as refined by R3-2) — unmerge returns the prior
  // memory-slot owner for slot restoration. `installedWorkspace` is NOT
  // returned post-R3-2: the daemon reads it off openclaw.json BEFORE calling
  // unmerge, so the skill cleanup runs before the entry is deleted.
  it('returns previousMemorySlotOwner read before entry deletion', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'memory-core' } },
    }));
    const ws = join(testDir, 'workspace');
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, ws);

    const result = unmergeOpenClawConfig(configPath);

    expect(result).toEqual({ previousMemorySlotOwner: 'memory-core' });
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  // Legacy layout: older adapter versions wrote bookkeeping at the entry ROOT
  // (not under config.dkgSetupState). A user who upgrades and disconnects WITHOUT
  // re-running setup must still restore correctly via the entry-root fallback.
  it('restores slot/profile/channel from LEGACY entry-root bookkeeping (no dkgSetupState)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        allow: ['adapter-openclaw'],
        slots: { memory: 'adapter-openclaw' },
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: { daemonUrl: 'http://127.0.0.1:9200' },
            // bookkeeping at the entry ROOT, as older versions wrote it:
            previousMemorySlotOwner: 'memory-core',
            previousToolsProfile: 'coding',
            previousChannelsDkgUi: null,
            mergedChannelsDkgUi: { enabled: true, port: 9201 },
            mergedToolsShape: { profile: 'full', alsoAllow: ['group:plugins'] },
          },
        },
      },
      tools: { profile: 'full', alsoAllow: ['group:plugins'] },
      channels: { 'dkg-ui': { enabled: true, port: 9201 } },
    }, null, 2) + '\n');

    const result = unmergeOpenClawConfig(configPath);
    const after = JSON.parse(readFileSync(configPath, 'utf-8'));

    // Slot owner read from the legacy root location and restored.
    expect(result).toEqual({ previousMemorySlotOwner: 'memory-core' });
    expect(after.plugins.slots.memory).toBe('memory-core');
    // tools.profile reverted to the captured "coding" (mergedToolsShape matched).
    expect(after.tools.profile).toBe('coding');
    // channels.dkg-ui deleted (previousChannelsDkgUi === null + mergedChannelsDkgUi matched).
    expect(after.channels?.['dkg-ui']).toBeUndefined();
    // Entry fully removed, so the strict-rejected root keys are gone too.
    expect(after.plugins.entries['adapter-openclaw']).toBeUndefined();
  });

  it('returns an empty object when openclaw.json is absent', () => {
    const missingPath = join(testDir, 'never-existed.json');
    expect(unmergeOpenClawConfig(missingPath)).toEqual({});
  });

  it('returns an empty object when openclaw.json is unparseable JSON', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, '{this is not: json');
    expect(unmergeOpenClawConfig(configPath)).toEqual({});
  });

  it('omits previousMemorySlotOwner when the merge did not capture one (clean install)', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));
    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const result = unmergeOpenClawConfig(configPath);

    expect(result.previousMemorySlotOwner).toBeUndefined();
  });

  // PR #250 review comment 1 — round-trip restoration of tools.profile +
  // channels.dkg-ui. Without these, a connect→disconnect cycle would leave
  // openclaw.json permanently widened.
  it('round-trip: absent tools.profile + absent channels.dkg-ui → merge → unmerge restores absent', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({ plugins: {} }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    // After merge: both keys are now present.
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.tools.profile).toBe('full');
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    unmergeOpenClawConfig(configPath);

    // After unmerge: both keys are gone, and the channels container is also
    // removed (not left as `channels: {}`) so the round-trip returns the
    // config to its pre-merge shape.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools?.profile).toBeUndefined();
    expect(afterUnmerge.channels).toBeUndefined();
  });

  it('round-trip: pre-existing sibling channel preserved when channels.dkg-ui is removed on unmerge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      channels: { telegram: { enabled: true, botToken: 'abc' } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    // After merge: telegram still present, dkg-ui added.
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.channels.telegram).toEqual({ enabled: true, botToken: 'abc' });
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    unmergeOpenClawConfig(configPath);

    // After unmerge: dkg-ui gone, telegram preserved, channels container retained.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.channels?.['dkg-ui']).toBeUndefined();
    expect(afterUnmerge.channels?.telegram).toEqual({ enabled: true, botToken: 'abc' });
  });

  it('merge: respects user-disabled channel on adapter entry (does not silently re-enable)', () => {
    const configPath = join(testDir, 'openclaw.json');
    // User has explicitly disabled the channel on the adapter entry.
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        entries: {
          'adapter-openclaw': {
            enabled: true,
            config: { channel: { enabled: false, port: 9201 } },
          },
        },
      },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    // Entry-level enabled=false is preserved by first-wins merge.
    expect(afterMerge.plugins.entries['adapter-openclaw'].config.channel.enabled).toBe(false);
    // Top-level channels.dkg-ui MUST honor the user's disable — we only add the
    // `port` key here so OpenClaw's meaningful-config check still fires.
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: false, port: 9201 });
  });

  it('round-trip: "coding" profile + degenerate { enabled: true } channel → merge → unmerge restores prior values', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'coding' },
      channels: { 'dkg-ui': { enabled: true } },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    // After merge: profile upgraded, channel port added.
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.tools.profile).toBe('full');
    expect(afterMerge.channels['dkg-ui']).toEqual({ enabled: true, port: 9201 });

    unmergeOpenClawConfig(configPath);

    // After unmerge: both restored to pre-merge shape.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools.profile).toBe('coding');
    expect(afterUnmerge.channels['dkg-ui']).toEqual({ enabled: true });
  });

  it('round-trip: explicit "minimal" profile preserved through merge + unmerge', () => {
    const configPath = join(testDir, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: {},
      tools: { profile: 'minimal' },
    }));

    mergeOpenClawConfig(configPath, '/path/to/adapter', defaultEntryConfig, defaultInstalledWorkspace);

    // Merge leaves "minimal" alone — no capture, no mutation.
    const afterMerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterMerge.tools.profile).toBe('minimal');

    unmergeOpenClawConfig(configPath);

    // Unmerge still leaves "minimal" alone — nothing to restore, we never captured.
    const afterUnmerge = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterUnmerge.tools.profile).toBe('minimal');
  });

});
