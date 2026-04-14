import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext | null = null;

describe('EVMChainAdapter integration', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8545);
  }, 60_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('should connect and resolve V8 contracts from Hub', async (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe('evm:31337');

    const kc = await adapter.getContract('KnowledgeCollection');
    expect(kc).toBeDefined();
    expect(await kc.name()).toBe('KnowledgeCollection');

    const staking = await adapter.getContract('Staking');
    expect(staking).toBeDefined();
    expect(await staking.name()).toBe('Staking');
  }, 30_000);

  it('should have correct signer address', (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const address = adapter.getSignerAddress();
    expect(address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('getBlockNumber reads from the live Hardhat node (no contract init required)', async (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const bn = await adapter.getBlockNumber();
    expect(typeof bn).toBe('number');
    expect(bn).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('verifyPublisherOwnsRange resolves KnowledgeAssetsStorage after init', async (test) => {
    if (!ctx) { test.skip(); return; }
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(typeof owns).toBe('boolean');
  }, 30_000);
});
