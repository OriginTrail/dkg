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
// writeDkgConfig
// ---------------------------------------------------------------------------

const fakeNetwork = {
  networkName: 'Test Network',
  relays: ['/ip4/1.2.3.4/tcp/9090/p2p/12D3test'],
  defaultContextGraphs: ['testing'],
  defaultNodeRole: 'edge' as const,
  chain: {
    type: 'evm' as const,
    rpcUrl: 'https://rpc.test',
    hubAddress: '0xTEST',
    chainId: 'test:1',
  },
};



describe('writeDkgConfig', () => {


  it('creates a new config from network defaults', () => {
    const dkgHome = join(testDir, '.dkg');
    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('test-agent', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.name).toBe('test-agent');
      expect(config.apiPort).toBe(9200);
      expect(config.nodeRole).toBe('edge');
      expect(config.contextGraphs).toEqual(['testing']);
      // Chain is intentionally NOT persisted on a fresh setup — the daemon
      // resolves it at runtime from network/<env>.json via resolveChainConfig
      // (cli/src/config.ts), so future hub/RPC rotations propagate without
      // a config rewrite. autoUpdate likewise omits repo/branch/etc. but
      // keeps the `enabled` flag mirrored from the network default because
      // several consumers (/api/status, /api/info, telemetry log pusher,
      // resolveAutoUpdateEnabled) read `config.autoUpdate?.enabled` directly
      // without a network fallback. fakeNetwork has no autoUpdate, so
      // nothing should be written at all here.
      expect(config.chain).toBeUndefined();
      expect(config.autoUpdate).toBeUndefined();
      expect(config.relay).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('merges with existing config without overwriting', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      nodeRole: 'core',
      contextGraphs: ['custom'],
      relay: '/ip4/5.6.7.8/tcp/9090/p2p/existing',
      chain: { type: 'evm', rpcUrl: 'https://custom.rpc', hubAddress: '0xCUSTOM', chainId: 'custom:2' },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('new-agent', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      // Existing values preserved
      expect(config.name).toBe('existing-node');
      expect(config.apiPort).toBe(9300);
      expect(config.nodeRole).toBe('core');
      expect(config.contextGraphs).toEqual(['custom']);
      expect(config.relay).toBe('/ip4/5.6.7.8/tcp/9090/p2p/existing');
      expect(config.chain.rpcUrl).toBe('https://custom.rpc');
      expect(config.openclawAdapter).toBeUndefined();
      expect(config.openclawChannel).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('mirrors only autoUpdate.enabled from network default and preserves existing pins', () => {
    // Regression: previously `writeDkgConfig` copied the entire
    // `network.autoUpdate` block into the user's config when absent,
    // which froze repo/branch/checkInterval at first-run values and broke
    // future rotations (main -> release/v10) shipped via
    // `network/<env>.json#autoUpdate`. The daemon's
    // `resolveAutoUpdateConfig` already does field-level fall-through, so
    // we drop everything *except* `enabled` — that one flag stays because
    // /api/status, /api/info, the telemetry log pusher in lifecycle.ts,
    // and `resolveAutoUpdateEnabled` itself read
    // `config.autoUpdate?.enabled` directly without a network fallback.
    //
    // (1) Fresh setup, network has autoUpdate.enabled=true with extra
    //     pins -> persist ONLY { enabled: true }, no repo/branch.
    const fresh = join(testDir, '.dkg-fresh');
    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = fresh;
    try {
      writeDkgConfig('test-agent', {
        ...fakeNetwork,
        autoUpdate: { enabled: true, repo: 'OriginTrail/dkg', branch: 'main' },
      } as any, 9200);
      const cfg = JSON.parse(readFileSync(join(fresh, 'config.json'), 'utf-8'));
      expect(cfg.autoUpdate).toEqual({ enabled: true });
      expect(cfg.chain).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }

    // (2) Fresh setup, network explicitly disables autoUpdate -> mirror it.
    const disabled = join(testDir, '.dkg-disabled');
    process.env.DKG_HOME = disabled;
    try {
      writeDkgConfig('test-agent', {
        ...fakeNetwork,
        autoUpdate: { enabled: false, repo: 'OriginTrail/dkg', branch: 'main' },
      } as any, 9200);
      const cfg = JSON.parse(readFileSync(join(disabled, 'config.json'), 'utf-8'));
      expect(cfg.autoUpdate).toEqual({ enabled: false });
    } finally {
      process.env.DKG_HOME = original;
    }

    // (3) Existing config with an operator-pinned autoUpdate. The heal-legacy
    //     pass (`pruneNetworkPinnedDefaults`) operates per-field: any field
    //     whose value equals the current network default is treated as a
    //     stale auto-copy from a pre-PR-322 setup run and dropped, while
    //     fields that differ from the network default are preserved as
    //     genuine operator overrides. Here `repo` matches the network value
    //     so it gets dropped (the resolver will re-derive it at runtime),
    //     `branch` differs ('release/v10' vs 'main') so it's preserved as a
    //     real override, and `enabled` is kept regardless. This matches the
    //     companion expectation in the "heals legacy auto-pinned" test
    //     below — see case (2) at line ~432 which asserts the same
    //     per-field semantics directly.
    const persisted = join(testDir, '.dkg-persisted');
    mkdirSync(persisted, { recursive: true });
    writeFileSync(join(persisted, 'config.json'), JSON.stringify({
      name: 'pinned-node',
      apiPort: 9300,
      autoUpdate: { enabled: true, repo: 'OriginTrail/dkg', branch: 'release/v10' },
    }));
    process.env.DKG_HOME = persisted;
    try {
      writeDkgConfig('pinned-node', {
        ...fakeNetwork,
        autoUpdate: { enabled: true, repo: 'OriginTrail/dkg', branch: 'main' },
      } as any, 9300);
      const cfg = JSON.parse(readFileSync(join(persisted, 'config.json'), 'utf-8'));
      expect(cfg.autoUpdate).toEqual({
        enabled: true,
        branch: 'release/v10',
      });
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('heals legacy auto-pinned chain/autoUpdate copies on rerun (PR #322 follow-up)', () => {
    // Earlier `dkg openclaw setup` runs blindly copied the entire `chain` and
    // `autoUpdate` blocks from `network/<env>.json` into ~/.dkg/config.json.
    // After PR #322 fresh installs no longer do that, but operators who
    // already ran the buggy version were stuck on stale snapshots — a hub or
    // RPC rotation in network config would NOT propagate, exactly the failure
    // mode that broke the testnet relays. The heal pass strips fields that
    // still equal the current network default (= clearly auto-copies, never
    // deliberate overrides) while leaving real customisations alone.
    const original = process.env.DKG_HOME;
    const networkV2 = {
      ...fakeNetwork,
      chain: {
        type: 'evm',
        rpcUrl: 'https://sepolia.base.org',
        hubAddress: '0xNEW_HUB_AFTER_ROTATION',
        chainId: 'base:84532',
      },
      autoUpdate: {
        enabled: true,
        repo: 'OriginTrail/dkg',
        branch: 'main',
        checkIntervalMinutes: 5,
      },
    } as any;

    // (1) Pure auto-copy of an OLD network snapshot: every field happens to
    //     match the *previous* defaults (old hub address, old branch, …) but
    //     is now stale. We mimic that by writing a config whose chain/auto
    //     blocks are byte-identical to the *current* network — i.e. the
    //     operator was on the same defaults before. Heal must strip both
    //     blocks so the resolver re-derives them from network at runtime.
    const legacy = join(testDir, '.dkg-legacy-autopin');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), JSON.stringify({
      name: 'legacy-node',
      apiPort: 9300,
      chain: { ...networkV2.chain },
      autoUpdate: { ...networkV2.autoUpdate },
    }));
    process.env.DKG_HOME = legacy;
    try {
      writeDkgConfig('legacy-node', networkV2, 9300);
      const cfg = JSON.parse(readFileSync(join(legacy, 'config.json'), 'utf-8'));
      expect(cfg.chain).toBeUndefined();
      expect(cfg.autoUpdate).toEqual({ enabled: true });
    } finally {
      process.env.DKG_HOME = original;
    }

    // (2) Operator pinned a private RPC and a release-branch override. The
    //     hubAddress and chainId in their config still match the network
    //     default (auto-copied), so those should be stripped, but the
    //     overridden rpcUrl + branch + repo (matches default) ride along
    //     correctly: rpcUrl differs -> kept; branch differs -> kept; repo
    //     matches -> dropped; hubAddress matches -> dropped.
    const mixed = join(testDir, '.dkg-mixed-overrides');
    mkdirSync(mixed, { recursive: true });
    writeFileSync(join(mixed, 'config.json'), JSON.stringify({
      name: 'mixed-node',
      apiPort: 9301,
      chain: {
        type: networkV2.chain.type,
        rpcUrl: 'https://my-private.rpc.example',
        hubAddress: networkV2.chain.hubAddress,
        chainId: networkV2.chain.chainId,
      },
      autoUpdate: {
        enabled: true,
        repo: networkV2.autoUpdate.repo,
        branch: 'release/v10',
        checkIntervalMinutes: networkV2.autoUpdate.checkIntervalMinutes,
      },
    }));
    process.env.DKG_HOME = mixed;
    try {
      writeDkgConfig('mixed-node', networkV2, 9301);
      const cfg = JSON.parse(readFileSync(join(mixed, 'config.json'), 'utf-8'));
      expect(cfg.chain).toEqual({ rpcUrl: 'https://my-private.rpc.example' });
      expect(cfg.autoUpdate).toEqual({ enabled: true, branch: 'release/v10' });
    } finally {
      process.env.DKG_HOME = original;
    }

    // (3) Operator deliberately disabled auto-update while the network has it
    //     enabled. `enabled` differs from network -> the whole autoUpdate
    //     block must survive the heal (we keep the disagreeing `enabled`
    //     even though all other fields would otherwise be pruned).
    const disabledOverride = join(testDir, '.dkg-disabled-override');
    mkdirSync(disabledOverride, { recursive: true });
    writeFileSync(join(disabledOverride, 'config.json'), JSON.stringify({
      name: 'opt-out-node',
      apiPort: 9302,
      autoUpdate: {
        enabled: false,
        repo: networkV2.autoUpdate.repo,
        branch: networkV2.autoUpdate.branch,
      },
    }));
    process.env.DKG_HOME = disabledOverride;
    try {
      writeDkgConfig('opt-out-node', networkV2, 9302);
      const cfg = JSON.parse(readFileSync(join(disabledOverride, 'config.json'), 'utf-8'));
      expect(cfg.autoUpdate).toEqual({ enabled: false });
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('removes stale legacy OpenClaw flags from an existing DKG config', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      openclawAdapter: true,
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9201',
      },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('existing-node', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.openclawAdapter).toBeUndefined();
      expect(config.openclawChannel).toBeUndefined();
    } finally {
      process.env.DKG_HOME = original;
    }
  });

  it('migrates legacy OpenClaw transport hints into localAgentIntegrations before removing the old key', () => {
    const dkgHome = join(testDir, '.dkg');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'existing-node',
      apiPort: 9300,
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9301',
        gatewayUrl: 'http://127.0.0.1:9300',
      },
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
          },
        },
      },
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;

    try {
      writeDkgConfig('existing-node', fakeNetwork, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));
      expect(config.openclawChannel).toBeUndefined();
      expect(config.localAgentIntegrations.openclaw.transport).toMatchObject({
        kind: 'openclaw-channel',
        bridgeUrl: 'http://127.0.0.1:9301',
        gatewayUrl: 'http://127.0.0.1:9300',
      });
    } finally {
      process.env.DKG_HOME = original;
    }
  });

});
