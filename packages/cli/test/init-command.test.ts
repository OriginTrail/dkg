import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DkgConfig } from '../src/config.js';

const mocks = vi.hoisted(() => ({
  home: '',
  answers: {} as Record<string, string>,
  questions: [] as string[],
  loadConfig: vi.fn(),
  saveConfig: vi.fn<(config: DkgConfig) => Promise<void>>(),
}));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
  dkgDir: () => mocks.home,
  configPath: () => join(mocks.home, 'config.json'),
  ensureDkgDir: async () => {},
  isDkgMonorepo: () => false,
}));
vi.mock('node:readline', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:readline')>(),
  createInterface: () => ({
    question: (prompt: string, answer: (value: string) => void) => {
      mocks.questions.push(prompt);
      const key = Object.keys(mocks.answers).find((name) => prompt.startsWith(name));
      answer(key === undefined ? '' : mocks.answers[key]);
    },
    close: () => {},
  }),
}));
vi.mock('../src/store-wizard.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/store-wizard.js')>(),
  promptStoreBackend: async () => ({ storeBlock: null }),
}));
vi.mock('@origintrail-official/dkg-agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@origintrail-official/dkg-agent')>(),
  loadOpWallets: async () => [],
}));

import { loadNetworkConfig, resolveChainConfig } from '../src/config.js';
import { registerInitCommand } from '../src/commands/init.js';

async function runInit(networkName = 'testnet') {
  const program = new Command().exitOverride();
  registerInitCommand(program);
  await program.parseAsync(['init', '--network', networkName, '--role', 'edge'], { from: 'user' });
  expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
  expect(mocks.questions.some((prompt) => prompt.startsWith('RPC URL'))).toBe(true);
  expect(mocks.questions.some((prompt) => prompt.startsWith('Hub contract address'))).toBe(true);
  return mocks.saveConfig.mock.calls[0][0];
}

describe('init wizard chain persistence', () => {
  const advancedOverrides = {
    walletRpcUrls: ['https://old-wallet.invalid'], tokenAddress: '0x0000000000000000000000000000000000000042',
    approvalPolicy: 'per-publish', minPublisherNativeWei: '123', minPublisherTracWei: '456',
    finalityConfirmations: 7, maxFeePerGasWei: '789', cgRegistryScanPageSize: 500, receiptTimeoutMs: 45_000,
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.home = await mkdtemp(join(tmpdir(), 'dkg-init-command-'));
    await writeFile(join(mocks.home, 'config.json'), '{}');
    mocks.answers = {};
    mocks.questions = [];
    mocks.saveConfig.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('unexpected process.exit'); });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(mocks.home, { recursive: true, force: true });
  });

  it('removes previously pinned defaults from the same-network saved config', async () => {
    const network = await loadNetworkConfig('testnet');
    const effective = resolveChainConfig(undefined, network)!;
    expect(effective.rpcUrl).toBeTruthy();
    // These are the prompted fields older init versions persisted, not every
    // advanced field present in the resolved network configuration.
    const { type, rpcUrl, rpcUrls, hubAddress, chainId } = effective;
    const chain = { type, rpcUrl, rpcUrls, hubAddress, chainId };
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain });

    const saved = await runInit();
    expect(saved.chain).toBeUndefined();
    expect(JSON.parse(JSON.stringify(saved))).not.toHaveProperty('chain');
    expect(resolveChainConfig(saved, network)).toEqual(effective);
  });

  it('persists genuine operator overrides without pinning the inherited Hub', async () => {
    const network = await loadNetworkConfig('testnet');
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      rpcUrl: 'https://operator.invalid', tokenAddress: 'operator-token',
    } });

    const saved = await runInit();
    expect(saved.chain).toEqual({ type: 'evm', rpcUrl: 'https://operator.invalid', tokenAddress: 'operator-token' });
    expect(resolveChainConfig(saved, { chain: { ...network!.chain, hubAddress: 'rotated-hub' } })?.hubAddress).toBe('rotated-hub');
  });

  it('switches an existing mock node to EVM when the operator enters chain settings', async () => {
    const network = await loadNetworkConfig('testnet');
    const chain = resolveChainConfig(undefined, network)!;
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      type: 'mock', mockIdentityId: '7',
    } });
    mocks.answers = { 'RPC URL': chain.rpcUrl!, 'Hub contract address': chain.hubAddress!, 'Chain ID': chain.chainId! };

    const saved = await runInit();
    expect(saved.chain?.mockIdentityId).toBeUndefined();
    expect(resolveChainConfig(saved, network)).toMatchObject({ type: 'evm', rpcUrl: chain.rpcUrl, hubAddress: chain.hubAddress });
  });

  it('retains mock mode when its empty RPC and Hub prompts are accepted', async () => {
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      type: 'mock', chainId: 'mock:31337', mockIdentityId: '7',
    } });
    const saved = await runInit();
    expect(saved.chain).toEqual({ type: 'mock', chainId: 'mock:31337', mockIdentityId: '7' });
    expect(resolveChainConfig(saved, await loadNetworkConfig('testnet'))).toEqual(saved.chain);
  });

  it('inherits backups when returning an off-overlay primary to the network default', async () => {
    const network = await loadNetworkConfig('testnet');
    const defaults = resolveChainConfig(undefined, network)!;
    expect(defaults.rpcUrls?.length).toBeGreaterThan(0);
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      type: 'evm', rpcUrl: 'http://127.0.0.1:8545',
    } });
    mocks.answers = { 'RPC URL': defaults.rpcUrl! };

    const saved = await runInit();
    expect(saved.chain).toBeUndefined();
    expect(resolveChainConfig(saved, network)?.rpcUrls).toEqual(defaults.rpcUrls);
    expect(resolveChainConfig(saved, { chain: { ...network!.chain, rpcUrls: ['https://rotated.invalid'] } })?.rpcUrls)
      .toEqual(['https://rotated.invalid']);
  });

  it.each(['explicit none', 'persisted empty override'])('keeps deliberate backup removal: %s', async (mode) => {
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      type: 'evm', ...(mode === 'persisted empty override' ? { rpcUrls: [] } : {}),
    } });
    if (mode === 'explicit none') mocks.answers = { 'Backup RPC URLs': 'none' };
    const saved = await runInit();
    expect(saved.chain).toEqual({ type: 'evm', rpcUrls: [] });
    expect(resolveChainConfig(saved, await loadNetworkConfig('testnet'))?.rpcUrls).toEqual([]);
  });

  it('preserves all supported same-network overrides but not unknown or mock-only fields', async () => {
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'testnet', chain: {
      type: 'evm', rpcUrl: 'https://operator.invalid', ...advancedOverrides,
      mockIdentityId: '7', unknownChainField: 'unowned',
    } });
    const saved = await runInit();
    expect(saved.chain).toEqual({ type: 'evm', rpcUrl: 'https://operator.invalid', ...advancedOverrides });
  });

  it('resets chain-specific settings on a network switch and retains portable operator tuning', async () => {
    mocks.loadConfig.mockResolvedValue({ name: 'node', apiPort: 9200, networkConfig: 'mainnet-base', chain: {
      type: 'evm', rpcUrl: 'https://old-primary.invalid', rpcUrls: [],
      hubAddress: '0x0000000000000000000000000000000000000088', chainId: 'base:8453',
      ...advancedOverrides, mockIdentityId: '7', unknownChainField: 'unowned',
    } });
    const saved = await runInit('testnet');
    expect(saved.chain).toEqual({ type: 'evm', cgRegistryScanPageSize: 500, receiptTimeoutMs: 45_000 });
    const network = await loadNetworkConfig('testnet');
    const defaults = resolveChainConfig(undefined, network)!;
    expect(resolveChainConfig(saved, network)).toMatchObject({
      rpcUrl: defaults.rpcUrl, rpcUrls: defaults.rpcUrls, hubAddress: defaults.hubAddress, chainId: defaults.chainId,
    });
  });
});
