import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadNetworkConfig,
  removePid,
  removeApiPort,
  writePid,
  writeApiPort,
  readPid,
  readApiPort,
  ensureDkgDir,
  isDkgMonorepo,
  dkgDir,
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
  it('loads network/testnet.json with shape expected by join flow when run from repo', async () => {
    const config = await loadNetworkConfig();
    if (!config) return;
    expect(config.networkName).toBeDefined();
    expect(Array.isArray(config.relays)).toBe(true);
    expect(config.relays.length).toBeGreaterThan(0);
    expect(config.relays[0]).toMatch(/^\/ip4\/\d+\.\d+\.\d+\.\d+\/tcp\/\d+\/p2p\/12D3KooW/);
    expect(config.defaultNodeRole).toMatch(/^edge|core$/);
    if (config.chain) {
      expect(config.chain.type).toBe('evm');
      expect(config.chain.rpcUrl).toBeDefined();
      expect(config.chain.hubAddress).toBeDefined();
      expect(config.chain.chainId).toBeDefined();
    }
  });

  it('includes faucet config when present in testnet.json', async () => {
    const config = await loadNetworkConfig();
    if (!config) return;
    if (config.faucet) {
      expect(config.faucet.url).toMatch(/^https?:\/\//);
      expect(config.faucet.mode).toBeDefined();
      expect(typeof config.faucet.mode).toBe('string');
    }
  });
});

describe('isDkgMonorepo', () => {
  it('returns true when running from the dkg-v9 monorepo', () => {
    expect(isDkgMonorepo()).toBe(true);
  });
});

describe('dkgDir', () => {
  const origHome = process.env.DKG_HOME;

  afterEach(() => {
    if (origHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = origHome;
  });

  it('returns ~/.dkg-dev when running from monorepo (no DKG_HOME)', () => {
    delete process.env.DKG_HOME;
    expect(dkgDir()).toMatch(/\.dkg-dev$/);
  });

  it('respects DKG_HOME override', () => {
    process.env.DKG_HOME = '/tmp/custom-dkg';
    expect(dkgDir()).toBe('/tmp/custom-dkg');
  });
});
