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



  // S1 step 4 ordering-invariant regression guard (issue #386 / execution-plan.md
  // §3.S1 step 4). After the agent-agnostic field-level merge moved to
  // dkg-core's `ensureDkgNodeConfig`, OpenClaw's `writeDkgConfig` MUST keep
  // running `migrateLegacyOpenClawTransport` + the `openclawAdapter`/
  // `openclawChannel` deletes + `pruneNetworkPinnedDefaults` BEFORE delegating
  // to `ensureDkgNodeConfig`. If a future refactor flipped the order:
  //   - Migration after merge: the `...existing` spread inside
  //     `ensureDkgNodeConfig` would already have copied `openclawChannel`
  //     into the output; the post-merge migration would then have to mutate
  //     the *output* of `ensureDkgNodeConfig`, but the helper writes the
  //     file synchronously, so the on-disk JSON would still contain
  //     `openclawChannel` — and `localAgentIntegrations.openclaw.transport`
  //     would be missing the migrated bridgeUrl/gatewayUrl.
  //   - Delete after merge: same shape — `openclawChannel` would survive
  //     to disk.
  // This test asserts the union of both: bridge/gateway hints land under
  // `localAgentIntegrations.openclaw.transport` AND the legacy key is gone
  // AND the post-migration `name`/`apiPort` field-level merge respects the
  // overrides — three signals from one fixture so a future refactor that
  // breaks any one is caught with a precise stack trace.
  it('ordering invariant: legacy migration + prune run before ensureDkgNodeConfig field merge', () => {
    const dkgHome = join(testDir, '.dkg-ordering-invariant');
    mkdirSync(dkgHome, { recursive: true });
    writeFileSync(join(dkgHome, 'config.json'), JSON.stringify({
      // Fields the migration must consume + delete:
      openclawChannel: {
        bridgeUrl: 'http://127.0.0.1:9999',
        gatewayUrl: 'http://127.0.0.1:8888',
      },
      openclawAdapter: { stale: true },
      // Field the prune must strip (matches network default below):
      autoUpdate: { enabled: true, repo: 'OriginTrail/dkg', branch: 'main', checkIntervalMinutes: 30 },
      // Pre-existing localAgentIntegrations the migration extends in-place
      // (proves the migration ran on `existing` BEFORE field-level merge —
      // if the order flipped, `localAgentIntegrations` would still be the
      // pre-migration shape and bridgeUrl/gatewayUrl would be missing):
      localAgentIntegrations: { openclaw: { enabled: true, transport: { kind: 'openclaw-channel' } } },
      // Field the merge must preserve over the explicit override (proves
      // ensureDkgNodeConfig saw post-migration existing with name intact):
      name: 'preserved-from-existing',
      apiPort: 9400,
    }));

    const original = process.env.DKG_HOME;
    process.env.DKG_HOME = dkgHome;
    try {
      writeDkgConfig('discovered-name', {
        ...fakeNetwork,
        autoUpdate: { enabled: true, repo: 'OriginTrail/dkg', branch: 'main', checkIntervalMinutes: 30 },
      }, 9200);

      const config = JSON.parse(readFileSync(join(dkgHome, 'config.json'), 'utf-8'));

      // (1) Migration ran: bridge/gateway hints ended up under
      // localAgentIntegrations.openclaw.transport.
      expect(config.localAgentIntegrations.openclaw.transport).toMatchObject({
        kind: 'openclaw-channel',
        bridgeUrl: 'http://127.0.0.1:9999',
        gatewayUrl: 'http://127.0.0.1:8888',
      });
      // (2) Delete ran: legacy keys gone from on-disk config.
      expect(config.openclawChannel).toBeUndefined();
      expect(config.openclawAdapter).toBeUndefined();
      // (3) Prune ran: stale auto-pinned autoUpdate fields stripped, only
      // `enabled` mirrored back via ensureDkgNodeConfig.
      expect(config.autoUpdate).toEqual({ enabled: true });
      // (4) Field-level merge respected post-migration existing: name/apiPort
      // preserved (no explicit overrides, so first-wins on `existing`).
      expect(config.name).toBe('preserved-from-existing');
      expect(config.apiPort).toBe(9400);
    } finally {
      process.env.DKG_HOME = original;
    }
  });

});
