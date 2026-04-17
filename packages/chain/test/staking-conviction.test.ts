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

describe('Staking Conviction (EVMChainAdapter)', () => {
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

  it('stakeWithLock stores lock and returns success', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const result = await adapter.stakeWithLock!(BigInt(coreProfileId), ethers.parseEther('100000'), 6);
    expect(result.success).toBe(true);
  });

  it('getDelegatorConvictionMultiplier returns value after stakeWithLock', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await adapter.stakeWithLock!(BigInt(coreProfileId), ethers.parseEther('100000'), 6);

    const { multiplier } = await adapter.getDelegatorConvictionMultiplier!(BigInt(coreProfileId), adapter.getSignerAddress());
    expect(multiplier).toBeGreaterThanOrEqual(1);
  });

  it('stakeWithLock only extends, never shortens lock', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await adapter.stakeWithLock!(BigInt(coreProfileId), ethers.parseEther('100000'), 12);

    const { multiplier: m1 } = await adapter.getDelegatorConvictionMultiplier!(BigInt(coreProfileId), adapter.getSignerAddress());

    await adapter.stakeWithLock!(BigInt(coreProfileId), ethers.parseEther('50000'), 3);

    const { multiplier: m2 } = await adapter.getDelegatorConvictionMultiplier!(BigInt(coreProfileId), adapter.getSignerAddress());
    expect(m2).toBeGreaterThanOrEqual(m1);
  });

  it('returns 1x multiplier for address with no lock', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { multiplier } = await adapter.getDelegatorConvictionMultiplier!(BigInt(coreProfileId), '0x' + '0'.repeat(40));
    expect(multiplier).toBe(1.0);
  });
});
