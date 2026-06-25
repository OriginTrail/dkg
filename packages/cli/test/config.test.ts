import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dkgAuthTokenPath } from '@origintrail-official/dkg-core';
import { computeNetworkId } from '../../core/src/genesis.js';
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
  resolveNetworkConfigName,
  resolveAutoUpdateSource,
  resolveApprovalPolicy,
  resolveChainConfig,
  resolveReadyChainConfig,
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
    expect(config.networkName).toBe('DKG V10 Base Testnet');
    expect((config as any).genesisId).toBe('base-testnet');
    expect(config.networkId).toBe('7449c543ff04a550b2dafa999fe8ee577a00b212023bb4d4244e8d58a4792c7b');
  });

  it('loads mainnet prep configs without activating testnet genesis or relays', async () => {
    const { _resetNetworkConfigCache } = await import('../src/config.js');
    const testnetNetworkId = '7449c543ff04a550b2dafa999fe8ee577a00b212023bb4d4244e8d58a4792c7b';
    const sharedMainnetPrep = {
      genesisVersion: 1,
      relays: [
        '/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS',
        '/ip4/178.105.105.102/tcp/9090/p2p/PEER_ID_LUNARIS',
        '/ip4/178.156.214.4/tcp/9090/p2p/PEER_ID_ORIONIS',
        '/ip4/178.105.111.185/tcp/9090/p2p/PEER_ID_KEPLER',
      ],
      defaultContextGraphs: [],
      defaultNodeRole: 'edge',
      // Mainnet tracks a dedicated `mainnet` dist-tag channel (stable-only),
      // NOT `latest` — so no node ever follows whatever `latest` points at.
      autoUpdate: {
        enabled: true,
        repo: 'OriginTrail/dkg',
        branch: 'main',
        checkIntervalMinutes: 5,
        channel: 'mainnet',
        allowPrerelease: false,
      },
    };
    _resetNetworkConfigCache();
    const testnetConfig = await loadNetworkConfig('testnet');
    const testnetRelays = testnetConfig?.relays ?? [];
    const mainnets = [
      {
        name: 'mainnet-base',
        networkName: 'DKG V10 Base Mainnet',
        genesisId: 'base-mainnet',
        networkId: '562ea760dbe27fb4233d58dfc958bbddf844b82596ec3d51dff98718e6bf61ca',
        chainName: 'base',
        chainId: 'base:8453',
        rpcUrl: 'https://mainnet.base.org',
        // Default multi-RPC backups shipped with the overlay (failover engine).
        rpcUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
        hubAddress: '0x99Aa571fD5e681c2D27ee08A7b7989DB02541d13',
        // Relays populated + pre-deployment gate lifted (#1292).
        pending: false,
      },
      {
        name: 'mainnet-gnosis',
        networkName: 'DKG V10 Gnosis Mainnet',
        genesisId: 'gnosis-mainnet',
        networkId: 'e08a9fb72a648ec2eb2fd9c152ded90a8ad67bb56f27df4781d9bb7e261fb7a7',
        chainName: 'gnosis',
        chainId: 'gnosis:100',
        rpcUrl: 'https://rpc.gnosischain.com',
        // Default multi-RPC backups shipped with the overlay (failover engine).
        rpcUrls: ['https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
        hubAddress: '0x882D0BF07F956b1b94BBfe9E77F47c6fc7D4EC8f',
        // Relays populated + pre-deployment gate lifted (#1292).
        pending: false,
      },
      {
        name: 'mainnet-neuroweb',
        networkName: 'DKG V10 NeuroWeb Mainnet',
        genesisId: 'neuroweb-mainnet',
        networkId: '83698bd2a305d6261169bfe96dd7c2f8aa9d24bee92150eee949a9a89bb68729',
        chainName: 'neuroweb',
        chainId: 'neuroweb:2043',
        rpcUrl: 'https://astrosat-parachain-rpc.origin-trail.network',
        hubAddress: '0x0957e25BD33034948abc28204ddA54b6E1142D6F',
        // Relays not provisioned yet — still pre-deployment gated.
        pending: true,
      },
    ];

    for (const expected of mainnets) {
      _resetNetworkConfigCache();
      const config = await loadNetworkConfig(expected.name);
      expect(config).not.toBeNull();
      const cfg = config! as any;

      // Invariants for every mainnet preset, gated or live: it must never
      // inherit the testnet genesis/relays, and its identity + chain wiring
      // must match the committed values.
      expect(cfg.networkId).not.toBe(testnetNetworkId);
      expect(cfg.relays).not.toEqual(testnetRelays);
      expect(cfg.networkName).toBe(expected.networkName);
      expect(cfg.genesisId).toBe(expected.genesisId);
      expect(cfg.networkId).toBe(expected.networkId);
      expect(await computeNetworkId(expected.genesisId)).toBe(expected.networkId);
      // Active networks (base/gnosis) ship default rpcUrls backups so the
      // failover engine is enabled out of the box; the pre-deployment-gated
      // neuroweb overlay intentionally stays single-RPC (no rpcUrls key).
      expect(cfg.chain).toEqual({
        name: expected.chainName,
        type: 'evm',
        chainId: expected.chainId,
        rpcUrl: expected.rpcUrl,
        ...(expected.rpcUrls ? { rpcUrls: expected.rpcUrls } : {}),
        hubAddress: expected.hubAddress,
      });
      // Non-relay prep fields are identical across all mainnets regardless of
      // readiness (relays are asserted per-readiness below).
      expect({
        genesisVersion: cfg.genesisVersion,
        defaultContextGraphs: cfg.defaultContextGraphs,
        defaultNodeRole: cfg.defaultNodeRole,
        autoUpdate: cfg.autoUpdate,
      }).toEqual({
        genesisVersion: sharedMainnetPrep.genesisVersion,
        defaultContextGraphs: sharedMainnetPrep.defaultContextGraphs,
        defaultNodeRole: sharedMainnetPrep.defaultNodeRole,
        autoUpdate: sharedMainnetPrep.autoUpdate,
      });

      if (expected.pending) {
        // Still pre-deployment: the readiness gate (config.ts) refuses these
        // via the `_status` marker AND the placeholder relay PeerIDs.
        expect(cfg._status).toMatch(/pre-deployment: replace PEER_ID_\* relay values before enabling/);
        expect(cfg._status).not.toContain('PLACEHOLDER_MAINNET_NETWORK_ID');
        expect(cfg.relays).toEqual(sharedMainnetPrep.relays);
        for (const relay of cfg.relays) {
          expect(relay).toMatch(/^\/ip4\/178\./);
          expect(relay).toMatch(/\/p2p\/PEER_ID_/);
        }
      } else {
        // Live: pre-deployment gate lifted — no `_status`, and every relay
        // carries a real libp2p PeerID (no placeholder), so the node boots.
        expect(cfg._status).toBeUndefined();
        expect(cfg.relays.length).toBeGreaterThan(0);
        for (const relay of cfg.relays) {
          expect(relay).not.toContain('PEER_ID_');
          expect(relay).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW[1-9A-HJ-NP-Za-km-z]+$/);
        }
      }
    }
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

  it('round-trips networkConfig through saveConfig/loadConfig (network selector)', async () => {
    await saveConfig({
      name: 'test-node',
      networkConfig: 'mainnet-base',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'core',
    });

    const loaded = await loadConfig();
    expect(loaded.networkConfig).toBe('mainnet-base');
    expect(resolveNetworkConfigName(loaded)).toBe('mainnet-base');
  });

  it('falls back to project default network when networkConfig is unset or blank', () => {
    expect(resolveNetworkConfigName({})).toBe('testnet');
    expect(resolveNetworkConfigName({ networkConfig: '   ' })).toBe('testnet');
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

  it('round-trips syncAgentsMeta=false through saveConfig/loadConfig (edge store-load optimization)', async () => {
    await saveConfig({
      name: 'test-node',
      apiPort: 9200,
      listenPort: 0,
      nodeRole: 'edge',
      syncAgentsMeta: false,
    });

    const loaded = await loadConfig();
    expect(loaded.nodeRole).toBe('edge');
    expect(loaded.syncAgentsMeta).toBe(false);
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

  it('threads the shipped network rpcUrls defaults through to the failover engine (real overlays)', async () => {
    const { _resetNetworkConfigCache } = await import('../src/config.js');
    const overlays = [
      { name: 'mainnet-base', primary: 'https://mainnet.base.org', backups: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'] },
      { name: 'mainnet-gnosis', primary: 'https://rpc.gnosischain.com', backups: ['https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'] },
      { name: 'testnet', primary: 'https://sepolia.base.org', backups: ['https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'] },
    ];
    for (const { name, primary, backups } of overlays) {
      _resetNetworkConfigCache();
      const network = await loadNetworkConfig(name);
      const merged = resolveChainConfig({}, network);
      // Primary endpoint is unchanged (backwards compatible); backups are
      // inherited so the adapter builds a multi-RPC FallbackProvider.
      expect(merged?.rpcUrl).toBe(primary);
      expect(merged?.rpcUrls).toEqual(backups);
    }
  });

  it('a single-RPC overlay (pre-deployment neuroweb) still resolves with NO rpcUrls (back-compat)', async () => {
    const { _resetNetworkConfigCache } = await import('../src/config.js');
    _resetNetworkConfigCache();
    const network = await loadNetworkConfig('mainnet-neuroweb');
    const merged = resolveChainConfig({}, network);
    expect(merged?.rpcUrl).toBe('https://astrosat-parachain-rpc.origin-trail.network');
    expect(merged?.rpcUrls).toBeUndefined();
  });

  it('keeps raw chain merging side-effect-free for pre-deployment network metadata', () => {
    const merged = resolveChainConfig({}, {
      _status: 'pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet',
      networkName: 'DKG V10 Base Mainnet',
      relays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS'],
      chain: fullNetworkChain,
    });

    expect(merged?.hubAddress).toBe(fullNetworkChain.hubAddress);
  });

  it('refuses ready chain resolution from a pre-deployment network', () => {
    expect(() => resolveReadyChainConfig({}, {
      _status: 'pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet',
      networkName: 'DKG V10 Base Mainnet',
      relays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS'],
      chain: fullNetworkChain,
    })).toThrow(/pre-deployment/);
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

  it('does NOT inherit public backups behind a LOCAL (loopback) primary — avoids a cross-chain FallbackProvider', () => {
    // A local Hardhat / devnet primary (loopback) on a real-network overlay
    // must stay single-RPC: ethers rejects a FallbackProvider that spans chains
    // (local 31337 + public Base Sepolia 84532). This is the kafka-plugin /
    // devnet e2e regression the default backups would otherwise cause.
    for (const localUrl of ['http://127.0.0.1:8545', 'http://localhost:9549', 'http://0.0.0.0:8545', 'http://127.0.0.2:8545']) {
      const merged = resolveChainConfig({ chain: { rpcUrl: localUrl } }, { chain: fullNetworkChain });
      expect(merged?.rpcUrl).toBe(localUrl);
      expect(merged?.rpcUrls ?? []).toEqual([]);
    }
  });

  it('an explicit operator rpcUrls still wins even with a loopback primary', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'http://127.0.0.1:8545', rpcUrls: ['http://127.0.0.1:8546'] } },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe('http://127.0.0.1:8545');
    expect(merged?.rpcUrls).toEqual(['http://127.0.0.1:8546']);
  });

  it('does NOT inherit public backups when the operator pins a DIFFERENT chainId — even on a non-loopback host (#1329 review)', () => {
    // A Docker/LAN devnet primary that overrides chainId to a different chain
    // (e.g. local 31337 on the testnet base:84532 overlay) is NOT loopback, but
    // inheriting the public Base-Sepolia backups would still build a cross-chain
    // FallbackProvider that ethers rejects at init. Suppress on chain-identity
    // mismatch, not only on loopback URLs.
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'http://hardhat:8545', chainId: 'evm:31337' } },
      { chain: fullNetworkChain },
    );
    expect(merged?.rpcUrl).toBe('http://hardhat:8545');
    expect(merged?.chainId).toBe('evm:31337');
    expect(merged?.rpcUrls ?? []).toEqual([]);
  });

  it('STILL inherits public backups for a non-loopback private RPC on the SAME chain', () => {
    // The intended operator case: a private/custom RPC on the overlay's own
    // chain (chainId omitted, or explicitly equal) keeps the public backups for
    // failover. Only a DIFFERENT chain (loopback or mismatched chainId) suppresses.
    const omittedChainId = resolveChainConfig(
      { chain: { rpcUrl: 'https://my-private-rpc.example/abc' } },
      { chain: fullNetworkChain },
    );
    expect(omittedChainId?.rpcUrls).toEqual(fullNetworkChain.rpcUrls);

    const sameChainId = resolveChainConfig(
      { chain: { rpcUrl: 'https://my-private-rpc.example/abc', chainId: fullNetworkChain.chainId } },
      { chain: fullNetworkChain },
    );
    expect(sameChainId?.rpcUrls).toEqual(fullNetworkChain.rpcUrls);
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

  it('preserves operator approvalPolicy', () => {
    const operatorApprovalPolicy = {
      mode: 'replenishing' as const,
      targetAllowance: '1000000000000000000',
      refillBelowFraction: 0.5,
    };

    expect(resolveChainConfig(
      { chain: { approvalPolicy: operatorApprovalPolicy } },
      { chain: fullNetworkChain },
    )?.approvalPolicy).toEqual(operatorApprovalPolicy);
  });

  it('keeps approvalPolicy local-only even when network config supplies one', () => {
    const networkApprovalPolicy = {
      mode: 'unlimited' as const,
    };
    const operatorApprovalPolicy = {
      mode: 'replenishing' as const,
      targetAllowance: '1000000000000000000',
    };

    expect(resolveChainConfig(
      {},
      { chain: { ...fullNetworkChain, approvalPolicy: networkApprovalPolicy } as any },
    )?.approvalPolicy).toBeUndefined();

    expect(resolveChainConfig(
      {},
      { chain: { ...fullNetworkChain, approvalPolicy: [] } as any },
    )?.approvalPolicy).toBeUndefined();

    expect(resolveChainConfig(
      { chain: { approvalPolicy: operatorApprovalPolicy } },
      { chain: { ...fullNetworkChain, approvalPolicy: networkApprovalPolicy } as any },
    )?.approvalPolicy).toEqual(operatorApprovalPolicy);
  });

  it('normalizes operator approvalPolicy string shorthand', () => {
    expect(resolveChainConfig(
      { chain: { approvalPolicy: 'unlimited' } },
      { chain: fullNetworkChain },
    )?.approvalPolicy).toEqual({ mode: 'unlimited' });
  });

  it('rejects malformed non-object operator approvalPolicy values', () => {
    expect(() => resolveChainConfig(
      { chain: { approvalPolicy: 'forever' as any } },
      { chain: fullNetworkChain },
    )).toThrow(/chain\.approvalPolicy must be an object or a valid mode string/);

    expect(() => resolveChainConfig(
      { chain: { approvalPolicy: [] as any } },
      { chain: fullNetworkChain },
    )).toThrow(/chain\.approvalPolicy must be an object/);
  });

  it('treats null operator approvalPolicy as unset', () => {
    const merged = resolveChainConfig(
      { chain: { approvalPolicy: null as any } },
      { chain: fullNetworkChain },
    );

    expect(merged?.approvalPolicy).toBeUndefined();
    expect(merged?.rpcUrl).toBe(fullNetworkChain.rpcUrl);
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
