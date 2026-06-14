import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dkgAuthTokenPath } from '@origintrail-official/dkg-core';
import {
  loadNetworkConfig,
  loadConfig,
  removePid,
  removeApiPort,
  saveConfig,
  writePid,
  writeApiPort,
  readPid,
  readApiPort,
  ensureDkgDir,
  configExists,
  readNodeRoleFromConfigSync,
  isDkgMonorepo,
  dkgDir,
  classifyMonorepoInit,
  sharedHomeInitGate,
  repoDir,
  resolveAutoUpdateSource,
  resolveApprovalPolicy,
  resolveChainConfig,
} from '../src/config.js';

describe('classifyMonorepoInit (dkg init monorepo home guard — issue #960)', () => {
  const npmHome = '/home/u/.dkg';
  const devHome = '/home/u/.dkg-dev';

  it('npm install (not a monorepo) → not-monorepo (no notice)', () => {
    expect(classifyMonorepoInit({ isMonorepo: false, dkgHomeEnv: undefined, resolvedHome: npmHome, npmHome }))
      .toBe('not-monorepo');
  });

  it('explicit DKG_HOME → explicit-home (user choice, bypass)', () => {
    expect(classifyMonorepoInit({ isMonorepo: true, dkgHomeEnv: '/tmp/scratch', resolvedHome: '/tmp/scratch', npmHome }))
      .toBe('explicit-home');
  });

  it('whitespace-only DKG_HOME is treated as unset', () => {
    expect(classifyMonorepoInit({ isMonorepo: true, dkgHomeEnv: '   ', resolvedHome: devHome, npmHome }))
      .toBe('dev-home');
  });

  it('monorepo, no ~/.dkg config → dev-home (resolves to ~/.dkg-dev): proceed', () => {
    expect(classifyMonorepoInit({ isMonorepo: true, dkgHomeEnv: undefined, resolvedHome: devHome, npmHome }))
      .toBe('dev-home');
  });

  it('monorepo, ~/.dkg config present → shared-npm-home (resolver fell back to ~/.dkg): gated opt-in', () => {
    expect(classifyMonorepoInit({ isMonorepo: true, dkgHomeEnv: undefined, resolvedHome: npmHome, npmHome }))
      .toBe('shared-npm-home');
  });
});

describe('sharedHomeInitGate (dkg init shared ~/.dkg opt-in — issue #960 round-3)', () => {
  it('--yes → proceed (explicit non-interactive opt-in, regardless of TTY)', () => {
    expect(sharedHomeInitGate({ yes: true, isTty: false })).toBe('proceed');
    expect(sharedHomeInitGate({ yes: true, isTty: true })).toBe('proceed');
  });

  it('interactive TTY, no --yes → prompt (ask before touching ~/.dkg)', () => {
    expect(sharedHomeInitGate({ yes: false, isTty: true })).toBe('prompt');
  });

  it('non-interactive, no --yes → refuse (cannot ask; must not silently overwrite)', () => {
    expect(sharedHomeInitGate({ yes: false, isTty: false })).toBe('refuse');
  });
});

describe('removePid / removeApiPort (catch path)', () => {
  it('removePid does not throw when pid file does not exist (ENOENT)', async () => {
    await expect(removePid()).resolves.toBeUndefined();
  });

  it('removeApiPort does not throw when api.port file does not exist (ENOENT)', async () => {
    await expect(removeApiPort()).resolves.toBeUndefined();
  });

  it('removePid removes existing pid file', async () => {
    await ensureDkgDir();
    await writePid(12345);
    await expect(removePid()).resolves.toBeUndefined();
    expect(await readPid()).toBeNull();
  });

  it('removeApiPort removes existing api.port file', async () => {
    await ensureDkgDir();
    await writeApiPort(9200);
    await expect(removeApiPort()).resolves.toBeUndefined();
    expect(await readApiPort()).toBeNull();
  });
});

describe('loadNetworkConfig', () => {
  it('loads network/testnet.json with correct shape when run from repo', async () => {
    const config = await loadNetworkConfig();
    if (!config) {
      expect(config).toBeNull();
      return;
    }
    expect(typeof config.networkName).toBe('string');
    expect(config.networkName.length).toBeGreaterThan(0);
    expect(Array.isArray(config.relays)).toBe(true);
    expect(config.relays.length).toBeGreaterThan(0);
    expect(config.relays[0]).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW/);
    expect(config.defaultNodeRole).toMatch(/^edge|core$/);
    if (config.chain) {
      expect(config.chain.type).toBe('evm');
      expect(typeof config.chain.rpcUrl).toBe('string');
      expect(config.chain.rpcUrl.length).toBeGreaterThan(0);
      expect(typeof config.chain.hubAddress).toBe('string');
      expect(typeof config.chain.chainId).toBe('string');
    }
  });

  it('includes faucet config with valid URL and mode when present', async () => {
    const config = await loadNetworkConfig();
    if (!config) {
      expect(config).toBeNull();
      return;
    }
    if (config.faucet) {
      expect(config.faucet.url).toMatch(/^https?:\/\//);
      expect(typeof config.faucet.mode).toBe('string');
      expect(config.faucet.mode.length).toBeGreaterThan(0);
    }
  });

  it('loads a specific network by name', async () => {
    const { _resetNetworkConfigCache } = await import('../src/config.js');
    _resetNetworkConfigCache();
    const config = await loadNetworkConfig('testnet');
    if (!config) {
      expect(config).toBeNull();
      return;
    }
    expect(config.networkName).toMatch(/testnet/i);
  });

  it('returns null when network config file does not exist', async () => {
    const { _resetNetworkConfigCache } = await import('../src/config.js');
    _resetNetworkConfigCache();
    const config = await loadNetworkConfig('nonexistent-network');
    expect(config).toBeNull();
  });

});

describe('isDkgMonorepo', () => {
  it('returns true when running from the DKG monorepo', () => {
    const result = isDkgMonorepo();
    if (repoDir() === null) {
      expect(result).toBe(false);
    } else {
      expect(result).toBe(true);
    }
  });
});

describe('dkgDir', () => {
  const origHome = process.env.DKG_HOME;
  const origOsHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    if (origHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = origHome;
    if (origOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = origOsHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it('returns ~/.dkg-dev when in monorepo without existing ~/.dkg/config.json, else ~/.dkg', () => {
    delete process.env.DKG_HOME;
    const hasExistingConfig = existsSync(join(homedir(), '.dkg', 'config.json'));
    if (hasExistingConfig) {
      expect(dkgDir()).toMatch(/\.dkg$/);
    } else {
      expect(dkgDir()).toMatch(/\.dkg-dev$/);
    }
  });

  it('respects DKG_HOME override', () => {
    process.env.DKG_HOME = '/tmp/custom-dkg';
    expect(dkgDir()).toBe('/tmp/custom-dkg');
  });

  it('uses ~/.dkg-dev for monorepo config writes when ~/.dkg/config.json is absent', async () => {
    delete process.env.DKG_HOME;
    const tempHome = join(tmpdir(), `dkg-cli-config-home-${randomBytes(4).toString('hex')}`);
    await mkdir(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    try {
      const expected = isDkgMonorepo()
        ? join(tempHome, '.dkg-dev')
        : join(tempHome, '.dkg');
      expect(dkgDir()).toBe(expected);
      expect(dkgAuthTokenPath(dkgDir())).toBe(join(expected, 'auth.token'));
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it('uses ~/.dkg for monorepo config writes when ~/.dkg/config.json already exists', async () => {
    delete process.env.DKG_HOME;
    const tempHome = join(tmpdir(), `dkg-cli-config-home-${randomBytes(4).toString('hex')}`);
    const dkgHome = join(tempHome, '.dkg');
    await mkdir(dkgHome, { recursive: true });
    await writeFile(join(dkgHome, 'config.json'), '{}\n');
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    try {
      expect(dkgDir()).toBe(dkgHome);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe('localAgentIntegrations config round-trip', () => {
  const origHome = process.env.DKG_HOME;
  let tempDir = '';

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-local-agents-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    process.env.DKG_HOME = tempDir;
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = origHome;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('persists the generic local agent integration registry', async () => {
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      localAgentIntegrations: {
        openclaw: {
          enabled: true,
          transport: {
            kind: 'openclaw-channel',
            gatewayUrl: 'http://gateway.local:3030',
          },
          manifest: {
            packageName: '@dkg/openclaw-adapter',
            version: '2026.4.12',
          },
          runtime: {
            status: 'ready',
          },
        },
      },
    });

    const loaded = await loadConfig();
    expect(loaded.localAgentIntegrations?.openclaw?.transport?.gatewayUrl).toBe('http://gateway.local:3030');
    expect(loaded.localAgentIntegrations?.openclaw?.manifest?.version).toBe('2026.4.12');
    expect(loaded.localAgentIntegrations?.openclaw?.runtime?.status).toBe('ready');
  });

  it('surfaces malformed config.json instead of falling back to stale YAML', async () => {
    await writeFile(join(tempDir, 'config.json'), '{ not valid json', 'utf8');
    await writeFile(join(tempDir, 'config.yaml'), 'name: stale-yaml\napiPort: 9317\n', 'utf8');

    await expect(loadConfig()).rejects.toThrow(SyntaxError);
  });

  it('surfaces malformed config.yaml instead of falling back to defaults', async () => {
    await writeFile(join(tempDir, 'config.yaml'), 'name: [unterminated\napiPort: 9317\n', 'utf8');

    let thrown: unknown;
    try {
      await loadConfig();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('YAMLException');
  });

  it('treats yaml-only homes as initialized configs', async () => {
    await writeFile(join(tempDir, 'config.yaml'), 'name: yaml-only\napiPort: 9317\n', 'utf8');

    expect(configExists()).toBe(true);
  });

  it('reads nodeRole from yaml-only config for sync daemon entrypoint routing', async () => {
    await writeFile(join(tempDir, 'config.yaml'), 'name: yaml-core\nnodeRole: core\n', 'utf8');

    expect(readNodeRoleFromConfigSync()).toBe('core');
  });

  it('keeps config.json precedence for sync nodeRole reads', async () => {
    await writeFile(join(tempDir, 'config.json'), JSON.stringify({ nodeRole: 'edge' }), 'utf8');
    await writeFile(join(tempDir, 'config.yaml'), 'nodeRole: core\n', 'utf8');

    expect(readNodeRoleFromConfigSync()).toBe('edge');
  });

  it('round-trips relayServerCapacity through saveConfig/loadConfig (operator override)', async () => {
    // PR #524 review (branarakic): the README documents
    // `relayServerCapacity` as a `config.json` knob, so the CLI
    // schema must actually persist + restore it. This guards
    // against regressions where the field gets dropped from the
    // DkgConfig type or stripped on serialization.
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'core',
      relayServerCapacity: 2048,
    });

    const loaded = await loadConfig();
    expect(loaded.nodeRole).toBe('core');
    expect(loaded.relayServerCapacity).toBe(2048);
  });

  it('round-trips relayReservationCount through saveConfig/loadConfig (operator override)', async () => {
    // PR3 multi-reservation tuning: same contract as
    // relayServerCapacity above — operators should be able to
    // override the default 3-reservation count from config.json.
    // This guards against the field getting dropped from the
    // DkgConfig schema or stripped on serialization.
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      relayPeers: ['/dns4/relay.example.com/tcp/4001/p2p/12D3KooWFakeRelayPeerIdForTest'],
      relayReservationCount: 5,
    });

    const loaded = await loadConfig();
    expect(loaded.nodeRole).toBe('edge');
    expect(loaded.relayReservationCount).toBe(5);
  });

  it('omits relayReservationCount when not set (so DKGNode.start() applies the default)', async () => {
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      relayPeers: ['/dns4/relay.example.com/tcp/4001/p2p/12D3KooWFakeRelayPeerIdForTest'],
    });

    const loaded = await loadConfig();
    expect(loaded.relayReservationCount).toBeUndefined();
  });

  it('omits relayServerCapacity when not set (so DKGNode.start() applies the default)', async () => {
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'core',
    });

    const loaded = await loadConfig();
    expect(loaded.nodeRole).toBe('core');
    expect(loaded.relayServerCapacity).toBeUndefined();
  });

  it('round-trips the network.* libp2p tunables through saveConfig/loadConfig', async () => {
    // PR feat/chain-network-libp2p-tunables: the small-network knobs
    // are documented as `config.json` keys, so the CLI schema must
    // persist + restore them. This guards against regressions where
    // any field gets dropped from the DkgConfig type or stripped on
    // serialization.
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      network: {
        peerStoreMaxAddressAgeMs: 24 * 3_600_000,
        peerStoreMaxPeerAgeMs: 7 * 24 * 3_600_000,
        dhtQuerySelfIntervalMs: 60_000,
      },
    });

    const loaded = await loadConfig();
    expect(loaded.network?.peerStoreMaxAddressAgeMs).toBe(24 * 3_600_000);
    expect(loaded.network?.peerStoreMaxPeerAgeMs).toBe(7 * 24 * 3_600_000);
    expect(loaded.network?.dhtQuerySelfIntervalMs).toBe(60_000);
  });

  it('omits the network block entirely when not set (upstream libp2p defaults apply)', async () => {
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
    });

    const loaded = await loadConfig();
    expect(loaded.network).toBeUndefined();
  });
});

describe('resolveAutoUpdateSource', () => {
  it('resolves local source independently of auto-update enabled state', () => {
    expect(resolveAutoUpdateSource(
      { autoUpdate: { enabled: false, source: 'npm' } },
      { autoUpdate: { enabled: true, source: 'git' } as any },
    )).toBe('npm');
  });

  it('falls back to the network source when local config disables polling without a source override', () => {
    expect(resolveAutoUpdateSource(
      { autoUpdate: { enabled: false } },
      { autoUpdate: { enabled: false, source: 'npm' } as any },
    )).toBe('npm');
  });

  it('returns undefined when neither source supplies an install-mode override', () => {
    expect(resolveAutoUpdateSource(
      { autoUpdate: { enabled: false } },
      { autoUpdate: { enabled: false } as any },
    )).toBeUndefined();
  });
});

describe('resolveChainConfig (field-level merge)', () => {
  const fullNetworkChain = {
    type: 'evm' as const,
    rpcUrl: 'https://network.example/rpc',
    rpcUrls: ['https://network-backup-1.example/rpc', 'https://network-backup-2.example/rpc'],
    hubAddress: '0xNETWORKHUB000000000000000000000000000000',
    chainId: 'base:84532',
  };

  it('returns undefined when neither config nor network supplies a chain block', () => {
    expect(resolveChainConfig({}, null)).toBeUndefined();
    expect(resolveChainConfig({}, { chain: undefined })).toBeUndefined();
    expect(resolveChainConfig(null, null)).toBeUndefined();
  });

  it('falls back to the network chain when config has no override', () => {
    const merged = resolveChainConfig({}, { chain: fullNetworkChain });
    expect(merged).toEqual({
      type: 'evm',
      rpcUrl: fullNetworkChain.rpcUrl,
      rpcUrls: fullNetworkChain.rpcUrls,
      hubAddress: fullNetworkChain.hubAddress,
      chainId: fullNetworkChain.chainId,
    });
  });

  it('overrides only the fields the operator set, inheriting the rest from network', () => {
    // Operator wants their private RPC but should inherit hub + chainId.
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'https://my-private-rpc.example/abc' } },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe('https://my-private-rpc.example/abc');
    expect(merged?.rpcUrls).toEqual(fullNetworkChain.rpcUrls);
    expect(merged?.hubAddress).toBe(fullNetworkChain.hubAddress);
    expect(merged?.chainId).toBe(fullNetworkChain.chainId);
    expect(merged?.type).toBe('evm');
  });

  it('overrides hub independently of rpcUrl (multichain forward-compat)', () => {
    const merged = resolveChainConfig(
      { chain: { hubAddress: '0xOPERATORHUB0000000000000000000000000000' } },
      { chain: fullNetworkChain },
    );
    expect(merged?.hubAddress).toBe('0xOPERATORHUB0000000000000000000000000000');
    expect(merged?.rpcUrl).toBe(fullNetworkChain.rpcUrl);
    expect(merged?.rpcUrls).toEqual(fullNetworkChain.rpcUrls);
    expect(merged?.chainId).toBe(fullNetworkChain.chainId);
  });

  it('merges cgRegistryScanPageSize with operator precedence', () => {
    const inherited = resolveChainConfig(
      {},
      { chain: { ...fullNetworkChain, cgRegistryScanPageSize: 10_000 } },
    );
    expect(inherited?.cgRegistryScanPageSize).toBe(10_000);

    const overridden = resolveChainConfig(
      { chain: { cgRegistryScanPageSize: 4_000 } },
      { chain: { ...fullNetworkChain, cgRegistryScanPageSize: 10_000 } },
    );
    expect(overridden?.cgRegistryScanPageSize).toBe(4_000);
  });

  it('dedupes primary + backups while preserving operator priority', () => {
    const merged = resolveChainConfig(
      {
        chain: {
          rpcUrl: 'https://operator.example/rpc',
          rpcUrls: [
            'https://operator.example/rpc',
            ' https://backup-a.example/rpc ',
            'https://backup-b.example/rpc',
            'https://backup-a.example/rpc',
          ],
        },
      },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe('https://operator.example/rpc');
    expect(merged?.rpcUrls).toEqual([
      'https://backup-a.example/rpc',
      'https://backup-b.example/rpc',
    ]);
  });

  it('uses operator backup list instead of network backups when set', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrls: ['https://operator-backup.example/rpc'] } },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe(fullNetworkChain.rpcUrl);
    expect(merged?.rpcUrls).toEqual(['https://operator-backup.example/rpc']);
  });

  it('preserves an explicit empty operator backup list instead of inheriting network backups', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrls: [] } },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe(fullNetworkChain.rpcUrl);
    expect(merged?.rpcUrls).toEqual([]);
  });

  it('strips rpcUrls under mock mode along with rpcUrl', () => {
    const merged = resolveChainConfig(
      {
        chain: {
          type: 'mock',
          rpcUrl: 'https://stale-rpc.example',
          rpcUrls: ['https://stale-backup.example'],
          hubAddress: '0xDEADBEEF00000000000000000000000000000000',
        },
      },
      { chain: fullNetworkChain },
    );
    expect(merged?.type).toBe('mock');
    expect(merged?.rpcUrl).toBeUndefined();
    expect(merged?.rpcUrls).toBeUndefined();
  });

  it('merges tokenAddress with operator override precedence', () => {
    const networkTokenAddress = '0xNETWORKTOKEN000000000000000000000000000';
    const operatorTokenAddress = '0xOPERATORTOKEN00000000000000000000000000';

    expect(resolveChainConfig(
      {},
      { chain: { ...fullNetworkChain, tokenAddress: networkTokenAddress } },
    )?.tokenAddress).toBe(networkTokenAddress);

    expect(resolveChainConfig(
      { chain: { tokenAddress: operatorTokenAddress } },
      { chain: { ...fullNetworkChain, tokenAddress: networkTokenAddress } },
    )?.tokenAddress).toBe(operatorTokenAddress);
  });

  it('returns a partial block when only config supplies fields (no network)', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'https://standalone.example/rpc' } },
      null,
    );
    expect(merged?.rpcUrl).toBe('https://standalone.example/rpc');
    expect(merged?.rpcUrls).toBeUndefined();
    expect(merged?.hubAddress).toBeUndefined();
    expect(merged?.chainId).toBeUndefined();
    // Callers (lifecycle, publisher-runner) MUST guard for the missing
    // hubAddress before passing to the agent.
  });

  it('does NOT inherit EVM fields from network when config opts into mock mode', () => {
    // Critical: a hybrid `{ type: 'mock' }` config that inherits the
    // network's rpcUrl/hubAddress/chainId would have lifecycle.ts wire up
    // a MockChainAdapter (correct), but publisher-runner, the wallet/
    // balance/rpc-health routes, and `dkg set-ask` would see "chain
    // configured" via the inherited fields and start hitting the real
    // network. Mock mode must short-circuit the merge.
    const merged = resolveChainConfig(
      { chain: { type: 'mock', mockIdentityId: '42' } },
      { chain: fullNetworkChain },
    );
    expect(merged?.type).toBe('mock');
    expect(merged?.mockIdentityId).toBe('42');
    expect(merged?.rpcUrl).toBeUndefined();
    expect(merged?.rpcUrls).toBeUndefined();
    expect(merged?.hubAddress).toBeUndefined();
    expect(merged?.chainId).toBeUndefined();
  });

  it('keeps mock-relevant fields (chainId, mockIdentityId) under mock mode', () => {
    // A test fixture that pins a mock chainId (to exercise a specific
    // chain identifier inside MockChainAdapter) must round-trip without
    // network inheritance.
    const merged = resolveChainConfig(
      {
        chain: {
          type: 'mock',
          chainId: 'mock:31337',
          mockIdentityId: '7',
        },
      },
      { chain: fullNetworkChain },
    );
    expect(merged).toEqual({
      type: 'mock',
      chainId: 'mock:31337',
      mockIdentityId: '7',
    });
  });

  it('strips stale rpcUrl/hubAddress from operator config under mock mode', () => {
    // Regression: an operator who flips an existing EVM config to mock
    // without deleting rpcUrl/hubAddress would otherwise leave a hybrid
    // resolved view. Every consumer that gates on `rpcUrl && hubAddress`
    // (publisher-runner, the wallet/balance/rpc-health routes, `dkg set-ask`,
    // and lifecycle's chainConfig forward to DKGAgent) would then open a
    // real ethers.JsonRpcProvider against the operator's stale URL while
    // lifecycle simultaneously wires up MockChainAdapter. resolveChainConfig
    // must drop these fields so that mock mode is fully isolated.
    const merged = resolveChainConfig(
      {
        chain: {
          type: 'mock',
          rpcUrl: 'https://stale-rpc.example',
          hubAddress: '0xDEADBEEF00000000000000000000000000000000',
          chainId: 'mock:31337',
          mockIdentityId: '9',
        },
      },
      { chain: fullNetworkChain },
    );
    expect(merged).toEqual({
      type: 'mock',
      chainId: 'mock:31337',
      mockIdentityId: '9',
    });
    expect(merged?.rpcUrl).toBeUndefined();
    expect(merged?.rpcUrls).toBeUndefined();
    expect(merged?.hubAddress).toBeUndefined();
  });

  it('does not return undefined fields as own keys (clean shape for downstream spread)', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'https://only-rpc.example' } },
      null,
    );
    expect(merged).toBeDefined();
    expect(Object.keys(merged ?? {})).toEqual(['type', 'rpcUrl']);
  });
});

describe('resolveApprovalPolicy (YAML/JSON config → runtime ApprovalPolicy)', () => {
  // The chain adapter's runtime API takes a bigint for targetAllowance;
  // YAML / JSON can't carry bigints natively, so the operator-facing config
  // accepts a decimal string. This converter pins down the contract.

  it('returns undefined when the operator omitted the field (chain adapter uses its built-in default)', () => {
    expect(resolveApprovalPolicy(undefined)).toBeUndefined();
  });

  it('passes through per-publish with no extra fields', () => {
    expect(resolveApprovalPolicy({ mode: 'per-publish' })).toEqual({
      mode: 'per-publish',
      targetAllowance: undefined,
      refillBelowFraction: undefined,
    });
  });

  it('defaults mode to per-publish if omitted (operator could supply only fraction overrides for replenishing post-hoc)', () => {
    expect(resolveApprovalPolicy({})).toEqual({
      mode: 'per-publish',
      targetAllowance: undefined,
      refillBelowFraction: undefined,
    });
  });

  it('converts targetAllowance string → bigint for replenishing', () => {
    const out = resolveApprovalPolicy({
      mode: 'replenishing',
      targetAllowance: '1000000000000000000000', // 1000 TRAC
      refillBelowFraction: 0.2,
    });
    expect(out).toEqual({
      mode: 'replenishing',
      targetAllowance: 10n ** 21n,
      refillBelowFraction: 0.2,
    });
  });

  it('accepts unlimited', () => {
    expect(resolveApprovalPolicy({ mode: 'unlimited' })).toEqual({
      mode: 'unlimited',
      targetAllowance: undefined,
      refillBelowFraction: undefined,
    });
  });

  it('throws on unknown mode', () => {
    expect(() => resolveApprovalPolicy({ mode: 'free-for-all' as any })).toThrow(
      /must be one of 'per-publish' \| 'replenishing' \| 'unlimited'/,
    );
  });

  it('throws on unparseable targetAllowance', () => {
    expect(() =>
      resolveApprovalPolicy({
        mode: 'replenishing',
        targetAllowance: 'one thousand TRAC',
      }),
    ).toThrow(/must be a decimal wei-TRAC bigint string/);
  });

  it('throws on negative targetAllowance', () => {
    expect(() =>
      resolveApprovalPolicy({
        mode: 'replenishing',
        targetAllowance: '-1',
      }),
    ).toThrow(/must be non-negative/);
  });

  it('throws on out-of-range refillBelowFraction', () => {
    expect(() =>
      resolveApprovalPolicy({ mode: 'replenishing', refillBelowFraction: 1.5 }),
    ).toThrow(/must be a finite number in \[0, 1\]/);
    expect(() =>
      resolveApprovalPolicy({ mode: 'replenishing', refillBelowFraction: -0.1 }),
    ).toThrow(/must be a finite number in \[0, 1\]/);
    expect(() =>
      resolveApprovalPolicy({
        mode: 'replenishing',
        refillBelowFraction: Number.NaN,
      }),
    ).toThrow(/must be a finite number in \[0, 1\]/);
  });
});
