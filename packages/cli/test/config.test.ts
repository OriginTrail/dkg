import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  repoDir,
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
