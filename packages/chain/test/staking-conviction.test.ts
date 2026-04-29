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

  // ─────────────────────────────────────────────────────────────────────
  // — evm-adapter.ts:1809).
  // Pre-fix: a `resolveContract('StakingV10')` failure silently set
  // `stakingV10 = undefined`, which made the allowance update fall
  // through and the adapter went straight into
  // `nft.createConviction(amount > 0)`. The inner
  // `StakingV10.token.transferFrom(staker, stakingStorage, amount)`
  // then reverted with an opaque `ERC20InsufficientAllowance`
  // several call frames deep — a misconfigured deployment surfaced
  // as a chain revert instead of a clear adapter error.
  // The fix throws fast when `amount > 0n && stakingV10 === undefined`.
  // ─────────────────────────────────────────────────────────────────────
  it('stakeWithLock fails fast with a clear adapter error when StakingV10 is unavailable and amount > 0', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    // Init the adapter once so internal contract resolution is set up;
    // we then monkey-patch `resolveContract` to simulate a missing
    // StakingV10 deployment ONLY for the StakingV10 lookup. Other
    // resolutions (DKGStakingConvictionNFT, token, etc.) keep working.
    await (adapter as any).init();
    const original = (adapter as any).resolveContract.bind(adapter);
    (adapter as any).resolveContract = async (name: string) => {
      if (name === 'StakingV10') {
        throw new Error('StakingV10 not found in deployment manifest (test simulation)');
      }
      return original(name);
    };

    try {
      await expect(
        adapter.stakeWithLock!(BigInt(coreProfileId), ethers.parseEther('100000'), 6),
      ).rejects.toThrow(/StakingV10 contract is unavailable/);
    } finally {
      (adapter as any).resolveContract = original;
    }
  });

  it('stakeWithLock with amount === 0n still works when StakingV10 is unavailable (no allowance needed)', async () => {
    const { coreProfileId } = getSharedContext();
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await (adapter as any).init();
    const original = (adapter as any).resolveContract.bind(adapter);
    (adapter as any).resolveContract = async (name: string) => {
      if (name === 'StakingV10') {
        throw new Error('StakingV10 not found in deployment manifest (test simulation)');
      }
      return original(name);
    };

    try {
      // amount = 0 → no token transfer needed → must not require StakingV10.
      // The underlying contract may or may not accept zero-amount conviction
      // (depends on contract semantics), but the ADAPTER must not be the
      // failure point — the throw we care about is the StakingV10
      // unavailability message.
      const promise = adapter.stakeWithLock!(BigInt(coreProfileId), 0n, 6);
      // Whatever the chain does, the adapter must not synthesize the
      // "StakingV10 contract is unavailable" error for amount === 0n.
      await promise.catch((err: Error) => {
        expect(err.message).not.toMatch(/StakingV10 contract is unavailable/);
      });
    } finally {
      (adapter as any).resolveContract = original;
    }
  });
});
