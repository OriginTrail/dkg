import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { ethers } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

let fileSnapshotId: string;
let testSnapshotId: string;

describe('Publishing Conviction Account (EVMChainAdapter)', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, adapter.getSignerAddress(), ethers.parseEther('50000000'));
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  beforeEach(async () => {
    testSnapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertSnapshot(testSnapshotId);
  });

  it('creates a conviction account', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const result = await adapter.createConvictionAccount!(ethers.parseEther('100000'), 6);

    expect(result.success).toBe(true);
    expect(result.accountId).toBeGreaterThanOrEqual(1n);
  });

  it('returns discount info for a conviction account', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    const { accountId } = await adapter.createConvictionAccount!(ethers.parseEther('500000'), 6);
    const { discountBps, conviction } = await adapter.getConvictionDiscount!(accountId);

    expect(conviction).toBeGreaterThan(0n);
    expect(discountBps).toBeGreaterThan(0);
  });

  it('returns higher discount for larger locks', async () => {
    const adapter1 = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { accountId: id1 } = await adapter1.createConvictionAccount!(ethers.parseEther('100000'), 6);
    const { discountBps: d1 } = await adapter1.getConvictionDiscount!(id1);

    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const adapter2 = createEVMAdapter(HARDHAT_KEYS.EXTRA2);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, adapter2.getSignerAddress(), ethers.parseEther('5000000'));
    const { accountId: id2 } = await adapter2.createConvictionAccount!(ethers.parseEther('100000'), 12);
    const { discountBps: d2 } = await adapter2.getConvictionDiscount!(id2);

    expect(d2).toBeGreaterThanOrEqual(d1);
  });

  it('adds funds to account', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { accountId } = await adapter.createConvictionAccount!(ethers.parseEther('100000'), 6);
    await adapter.addConvictionFunds!(accountId, ethers.parseEther('50000'));

    const info = await adapter.getConvictionAccountInfo!(accountId);
    expect(info).not.toBeNull();
    expect(info!.balance).toBe(ethers.parseEther('150000'));
  });

  it('extends lock and recalculates conviction', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { accountId } = await adapter.createConvictionAccount!(ethers.parseEther('100000'), 6);

    const before = await adapter.getConvictionAccountInfo!(accountId);
    expect(before!.lockEpochs).toBe(6);

    await adapter.extendConvictionLock!(accountId, 6);

    const after = await adapter.getConvictionAccountInfo!(accountId);
    expect(after!.lockEpochs).toBe(12);
    expect(after!.conviction).toBeGreaterThan(before!.conviction);
  });

  it('returns null for nonexistent account', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const info = await adapter.getConvictionAccountInfo!(999n);
    expect(info).toBeNull();
  });

  it('returns zero discount for nonexistent account', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { discountBps } = await adapter.getConvictionDiscount!(999n);
    expect(discountBps).toBe(0);
  });
});
