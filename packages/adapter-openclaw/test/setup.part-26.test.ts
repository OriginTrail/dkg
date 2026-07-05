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
// runSetup Step 5 — faucet funding
//
// All tests in this block use `start: false, verify: false` to skip the
// daemon-start and verify steps (which would spawn a real `dkg start`
// subprocess). The faucet path still runs because `options.fund !== false`
// defaults `true`. Wallets are pre-seeded in DKG_HOME so the retry loop is
// not exercised here — retry accounting is covered by the
// `readWalletsWithRetry` suite above.
// ---------------------------------------------------------------------------

describe('runSetup Step 5 — faucet funding', () => {
  const SEEDED_ADMIN_WALLET = '0xAAAA0000000000000000000000000000000000AA';
  const SEEDED_OPERATIONAL_WALLETS = [
    '0xBBBB0000000000000000000000000000000000BB',
    '0xCCCC0000000000000000000000000000000000CC',
    '0xDDDD0000000000000000000000000000000000DD',
  ];

  function setupFaucetEnv() {
    const dkgHome = join(testDir, '.dkg');
    const openclawHome = join(testDir, '.openclaw');
    const workspace = join(testDir, 'workspace');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      join(openclawHome, 'openclaw.json'),
      JSON.stringify({ plugins: {} }, null, 2) + '\n',
    );
    // Pre-seed wallets.json so readWallets() returns wallets on the first
    // attempt (bypasses the retry loop — that behavior is covered by the
    // readWalletsWithRetry suite above).
    writeFileSync(
      join(dkgHome, 'wallets.json'),
      JSON.stringify({
        adminWallet: { address: SEEDED_ADMIN_WALLET, privateKey: '0xadmin' },
        wallets: SEEDED_OPERATIONAL_WALLETS.map(address => ({ address, privateKey: `key-${address}` })),
      }),
    );

    const originalDkg = process.env.DKG_HOME;
    const originalOpenclaw = process.env.OPENCLAW_HOME;
    process.env.DKG_HOME = dkgHome;
    process.env.OPENCLAW_HOME = openclawHome;

    return {
      dkgHome,
      openclawHome,
      workspace,
      restore: () => {
        process.env.DKG_HOME = originalDkg;
        process.env.OPENCLAW_HOME = originalOpenclaw;
      },
    };
  }

  beforeEach(() => {
    // Reset the mock between tests so assertions on call counts / args stay
    // isolated. Default behavior restored each test so cases that don't care
    // get a happy response.
    vi.mocked(requestFaucetFunding).mockReset();
    vi.mocked(requestFaucetFunding).mockResolvedValue({
      success: true,
      funded: ['0.01 ETH', '1000 TRAC'],
    });
  });



  it('calls requestFaucetFunding with (url, mode, addresses, agentName) pulled from network.faucet.*', async () => {
    const env = setupFaucetEnv();
    try {
      // Pre-seed an IDENTITY.md so the agentName argument is deterministic.
      writeFileSync(join(env.workspace, 'IDENTITY.md'), '# Identity\n- **Name**: test-agent\n');
      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false });

      expect(requestFaucetFunding).toHaveBeenCalledTimes(1);
      const [url, mode, addresses, nodeName] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(url).toMatch(/^https?:\/\//);
      expect(typeof mode).toBe('string');
      expect(mode.length).toBeGreaterThan(0);
      expect(addresses).toEqual([SEEDED_ADMIN_WALLET, ...SEEDED_OPERATIONAL_WALLETS]);
      expect(nodeName).toBe('test-agent');

      // AC3 invariant (plugins.slots.memory === 'adapter-openclaw') must still
      // assert AFTER the faucet step. This confirms the faucet step did not
      // short-circuit Step 7 (merge).
      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
      expect(cfg.plugins.entries['adapter-openclaw'].config.stateDir).toBe(join(env.workspace, '.dkg-adapter'));
    } finally {
      env.restore();
    }
  });

  it('skips the faucet call when options.fund === false (--no-fund) and still lands the merge', async () => {
    const env = setupFaucetEnv();
    try {
      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false, fund: false });

      expect(requestFaucetFunding).not.toHaveBeenCalled();

      // AC3 still holds — --no-fund does not block the rest of the pipeline.
      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      env.restore();
    }
  });

  it('skips the faucet call under dryRun:true (no faucet request made, no merge written)', async () => {
    const env = setupFaucetEnv();
    try {
      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false, dryRun: true });

      expect(requestFaucetFunding).not.toHaveBeenCalled();

      // Dry-run does not merge either — openclaw.json remains unchanged
      // (still the empty `plugins: {}` seeded in setupFaucetEnv).
      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins?.slots).toBeUndefined();
    } finally {
      env.restore();
    }
  });

  it('continues non-fatally and logs manual curl instructions when requestFaucetFunding returns a 429 failure', async () => {
    vi.mocked(requestFaucetFunding).mockResolvedValueOnce({
      success: false,
      funded: [],
      error: 'HTTP 429: rate limited',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = setupFaucetEnv();
    try {
      await expect(
        runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false }),
      ).resolves.toBeUndefined();

      // Manual-curl block is logged (`console.log` with the literal "curl -X POST").
      const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toContain('To fund wallets manually');
      expect(logged).toContain('curl -X POST');

      // AC3 invariant holds — failure did not block Step 7 (merge).
      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      logSpy.mockRestore();
      env.restore();
    }
  });

  it('continues non-fatally when requestFaucetFunding returns a 5xx failure', async () => {
    vi.mocked(requestFaucetFunding).mockResolvedValueOnce({
      success: false,
      funded: [],
      error: 'HTTP 503: service unavailable',
    });
    const env = setupFaucetEnv();
    try {
      await expect(
        runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false }),
      ).resolves.toBeUndefined();

      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      env.restore();
    }
  });

  it('continues non-fatally when requestFaucetFunding throws a network error', async () => {
    vi.mocked(requestFaucetFunding).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = setupFaucetEnv();
    try {
      await expect(
        runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false }),
      ).resolves.toBeUndefined();

      const logged = logSpy.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toContain('To fund wallets manually');

      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      logSpy.mockRestore();
      env.restore();
    }
  });

  it('continues non-fatally when requestFaucetFunding throws an AbortError (timeout path)', async () => {
    // `requestFaucetFunding` in core wraps fetch with AbortSignal.timeout(...).
    // A triggered timeout surfaces as a DOMException with name "TimeoutError"
    // (or AbortError on some runtimes). Cover both.
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    vi.mocked(requestFaucetFunding).mockRejectedValueOnce(timeoutErr);
    const env = setupFaucetEnv();
    try {
      await expect(
        runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false }),
      ).resolves.toBeUndefined();

      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      env.restore();
    }
  });

  it('warns and skips faucet when no wallets are available (readWallets returns empty after retries)', async () => {
    // Remove the pre-seeded wallets.json so readWallets returns [].
    const env = setupFaucetEnv();
    rmSync(join(env.dkgHome, 'wallets.json'));
    try {
      await expect(
        runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false }),
      ).resolves.toBeUndefined();

      // With `start: false`, the retry loop is intentionally skipped (no
      // point retrying when we didn't start the daemon this run). We still
      // assert that runSetup did NOT call the faucet and that Step 7 (merge)
      // still ran — i.e., faucet step is truly non-fatal.
      expect(requestFaucetFunding).not.toHaveBeenCalled();

      const cfg = JSON.parse(readFileSync(join(env.openclawHome, 'openclaw.json'), 'utf-8'));
      expect(cfg.plugins.slots.memory).toBe('adapter-openclaw');
    } finally {
      env.restore();
    }
  });

  // ---- C9: effective-name drift protection -----------------------------
  //
  // The faucet Idempotency-Key seed is derived from the
  // `agentName` argument. `writeDkgConfig` uses first-wins semantics on
  // `name` (existing value wins unless --name was passed), so on re-runs
  // the name the node actually persists can differ from whatever
  // `discoverAgentName` returned in-memory this run (specifically when
  // IDENTITY.md has changed between runs). runSetup must thread the
  // post-writeDkgConfig effective name through to the faucet so retry
  // identity matches what's persisted on disk.

  it('faucet receives the persisted config.json name when IDENTITY.md changes between re-runs', async () => {
    const env = setupFaucetEnv();
    try {
      // Simulate "run 1 already happened": pre-seed ~/.dkg/config.json
      // with an older persisted name.
      writeFileSync(
        join(env.dkgHome, 'config.json'),
        JSON.stringify({ name: 'persisted-run1' }),
      );
      // "Run 2" has a different IDENTITY.md name — writeDkgConfig's
      // first-wins keeps the persisted name, so the faucet MUST use
      // "persisted-run1", not "changed-run2".
      writeFileSync(join(env.workspace, 'IDENTITY.md'), '# Identity\nName: changed-run2\n');

      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false });

      expect(requestFaucetFunding).toHaveBeenCalledTimes(1);
      const [, , , nodeName] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(nodeName).toBe('persisted-run1');
    } finally {
      env.restore();
    }
  });

  it('faucet receives the discovered IDENTITY.md name on first run (no pre-existing config.json)', async () => {
    const env = setupFaucetEnv();
    try {
      // No pre-existing config.json — writeDkgConfig will persist the
      // discovered IDENTITY.md name, and the faucet should receive it.
      writeFileSync(join(env.workspace, 'IDENTITY.md'), '# Identity\nName: first-run-name\n');

      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false });

      const [, , , nodeName] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(nodeName).toBe('first-run-name');
      // Sanity: writeDkgConfig actually persisted the first-run name.
      const cfg = JSON.parse(readFileSync(join(env.dkgHome, 'config.json'), 'utf-8'));
      expect(cfg.name).toBe('first-run-name');
    } finally {
      env.restore();
    }
  });

  it('explicit options.name override wins over both persisted and discovered names', async () => {
    const env = setupFaucetEnv();
    try {
      // Persisted name from a prior run AND a conflicting IDENTITY.md —
      // --name should beat both.
      writeFileSync(
        join(env.dkgHome, 'config.json'),
        JSON.stringify({ name: 'stale-persisted' }),
      );
      writeFileSync(join(env.workspace, 'IDENTITY.md'), '# Identity\nName: stale-identity\n');

      await runSetup({
        workspace: env.workspace,
        network: 'testnet',
        start: false,
        verify: false,
        name: 'explicit-override',
      });

      const [, , , nodeName] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(nodeName).toBe('explicit-override');
      // writeDkgConfig's `nameExplicit` override path must have flipped
      // the persisted file to the explicit value too — otherwise the
      // on-disk and in-memory identities would disagree after this run.
      const cfg = JSON.parse(readFileSync(join(env.dkgHome, 'config.json'), 'utf-8'));
      expect(cfg.name).toBe('explicit-override');
    } finally {
      env.restore();
    }
  });

  it('C8 regression guard: persisted name still wins over random fallback when IDENTITY.md is absent', async () => {
    const env = setupFaucetEnv();
    try {
      // No IDENTITY.md, but a persisted name exists. Pre-C8 behavior was
      // to roll a new random `openclaw-agent-XXXXX` each call; C8 made
      // discoverAgentName honor the persisted value; C9 must not have
      // regressed that.
      writeFileSync(
        join(env.dkgHome, 'config.json'),
        JSON.stringify({ name: 'persisted-no-identity' }),
      );

      await runSetup({ workspace: env.workspace, network: 'testnet', start: false, verify: false });

      const [, , , nodeName] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(nodeName).toBe('persisted-no-identity');
    } finally {
      env.restore();
    }
  });

  it('#1306: eagerly creates wallets via the injected hook (even --no-fund), skipped on --dry-run', async () => {
    const env = setupFaucetEnv();
    try {
      // --no-fund must STILL create wallets (mainnet has no faucet but the node
      // needs wallets for manual funding + publishing). Called with the home dir.
      const loadOpWallets = vi.fn(async () => ({
        adminWallet: { address: '0xAAAA', privateKey: '0x0' },
        wallets: [],
      }));
      await runSetup(
        { workspace: env.workspace, network: 'testnet', start: false, verify: false, fund: false },
        { loadOpWallets },
      );
      expect(loadOpWallets).toHaveBeenCalledTimes(1);
      expect(loadOpWallets.mock.calls[0][0]).toBe(env.dkgHome);

      // --dry-run must NOT create wallets.
      loadOpWallets.mockClear();
      await runSetup(
        { workspace: env.workspace, network: 'testnet', start: false, verify: false, dryRun: true },
        { loadOpWallets },
      );
      expect(loadOpWallets).not.toHaveBeenCalled();
    } finally {
      env.restore();
    }
  });

  it('#1443: invokes the post-config setup hook, skipped on --dry-run', async () => {
    const env = setupFaucetEnv();
    try {
      const afterConfigBootstrap = vi.fn(async () => {});
      await runSetup(
        { workspace: env.workspace, network: 'testnet', start: false, verify: false, fund: false },
        { afterConfigBootstrap },
      );
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
      expect(afterConfigBootstrap.mock.calls[0][0]).toBe(env.dkgHome);

      afterConfigBootstrap.mockClear();
      await runSetup(
        { workspace: env.workspace, network: 'testnet', start: false, verify: false, dryRun: true },
        { afterConfigBootstrap },
      );
      expect(afterConfigBootstrap).not.toHaveBeenCalled();
    } finally {
      env.restore();
    }
  });

  it('#1443: a failing post-config setup hook is best-effort', async () => {
    const env = setupFaucetEnv();
    try {
      const afterConfigBootstrap = vi.fn(async () => { throw new Error('invalid credential file'); });
      await expect(
        runSetup(
          { workspace: env.workspace, network: 'testnet', start: false, verify: false, fund: false },
          { afterConfigBootstrap },
        ),
      ).resolves.toBeUndefined();
      expect(afterConfigBootstrap).toHaveBeenCalledTimes(1);
    } finally {
      env.restore();
    }
  });

  it('#1306: a failing loadOpWallets is best-effort — setup still completes', async () => {
    const env = setupFaucetEnv();
    try {
      const loadOpWallets = vi.fn(async () => { throw new Error('boom'); });
      // Wallet pre-creation is best-effort; a throw must NOT abort setup.
      await expect(
        runSetup(
          { workspace: env.workspace, network: 'testnet', start: false, verify: false, fund: false },
          { loadOpWallets },
        ),
      ).resolves.toBeUndefined();
      expect(loadOpWallets).toHaveBeenCalledTimes(1);
    } finally {
      env.restore();
    }
  });

  it('#1306: eager-created wallets feed the faucet (pre-creation runs before funding)', async () => {
    const env = setupFaucetEnv();
    // Remove the pre-seeded wallets so ONLY the hook can provide them — proves
    // the hook writes wallets.json BEFORE the funding step reads it.
    rmSync(join(env.dkgHome, 'wallets.json'));
    try {
      const loadOpWallets = vi.fn(async (dir: string) => {
        const cfg = {
          adminWallet: { address: '0xADMIN', privateKey: '0x0' },
          wallets: [{ address: '0xOP1', privateKey: '0x0' }],
        };
        writeFileSync(join(dir, 'wallets.json'), JSON.stringify(cfg));
        return cfg;
      });
      await runSetup(
        { workspace: env.workspace, network: 'testnet', start: false, verify: false },
        { loadOpWallets },
      );
      // The faucet now finds the eager-created wallets and funds them.
      expect(requestFaucetFunding).toHaveBeenCalledTimes(1);
      const [, , addresses] = vi.mocked(requestFaucetFunding).mock.calls[0];
      expect(addresses).toEqual(['0xADMIN', '0xOP1']);
    } finally {
      env.restore();
    }
  });

});
