import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
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
  isDkgMonorepo,
  dkgDir,
  repoDir,
  resolveChainConfig,
} from '../src/config.js';

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

  afterEach(() => {
    if (origHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = origHome;
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
});

describe('resolveChainConfig (field-level merge)', () => {
  const fullNetworkChain = {
    type: 'evm' as const,
    rpcUrl: 'https://network.example/rpc',
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
    expect(merged?.chainId).toBe(fullNetworkChain.chainId);
  });

  it('returns a partial block when only config supplies fields (no network)', () => {
    const merged = resolveChainConfig(
      { chain: { rpcUrl: 'https://standalone.example/rpc' } },
      null,
    );
    expect(merged?.rpcUrl).toBe('https://standalone.example/rpc');
    expect(merged?.hubAddress).toBeUndefined();
    expect(merged?.chainId).toBeUndefined();
    // Callers (lifecycle, publisher-runner) MUST guard for the missing
    // hubAddress before passing to the agent.
  });

  it('preserves explicit `type: "mock"` and `mockIdentityId` override (test-only path)', () => {
    const merged = resolveChainConfig(
      { chain: { type: 'mock', mockIdentityId: '42' } },
      { chain: fullNetworkChain },
    );
    expect(merged?.type).toBe('mock');
    expect(merged?.mockIdentityId).toBe('42');
    // Hub/RPC inherit, but the daemon's mock branch ignores them.
    expect(merged?.hubAddress).toBe(fullNetworkChain.hubAddress);
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
