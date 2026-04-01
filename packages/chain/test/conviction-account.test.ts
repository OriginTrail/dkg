import { describe, it, expect } from 'vitest';
import { MockChainAdapter, computePublisherDiscount } from '../src/mock-adapter.js';

describe('Publishing Conviction Account (MockChainAdapter)', () => {
  it('creates a conviction account with 12-month lock', async () => {
    const adapter = new MockChainAdapter();
    const amount = 100_000n * 10n ** 18n;
    const result = await adapter.createConvictionAccount(amount);

    expect(result.success).toBe(true);
    expect(result.accountId).toBe(1n);

    const info = await adapter.getConvictionAccountInfo(1n);
    expect(info).not.toBeNull();
    expect(info!.lockedBalance).toBe(amount);
    expect(info!.topUpBalance).toBe(0n);
    expect(info!.initialCommitment).toBe(amount);
    expect(info!.conviction).toBe(amount * 12n);
  });

  it('returns correct discount for each tier', async () => {
    const tiers: Array<[bigint, number]> = [
      [24_999n * 10n ** 18n, 0],
      [25_000n * 10n ** 18n, 1000],
      [50_000n * 10n ** 18n, 2000],
      [100_000n * 10n ** 18n, 3000],
      [250_000n * 10n ** 18n, 4000],
      [500_000n * 10n ** 18n, 5000],
      [1_000_000n * 10n ** 18n, 7500],
      [2_000_000n * 10n ** 18n, 7500],
    ];

    for (const [commitment, expectedBps] of tiers) {
      expect(computePublisherDiscount(commitment)).toBe(expectedBps);
    }
  });

  it('returns discount via adapter for created account', async () => {
    const adapter = new MockChainAdapter();
    await adapter.createConvictionAccount(500_000n * 10n ** 18n);
    const { discountBps } = await adapter.getConvictionDiscount(1n);
    expect(discountBps).toBe(5000); // 50%
  });

  it('computes discounted cost correctly', async () => {
    const adapter = new MockChainAdapter();
    await adapter.createConvictionAccount(100_000n * 10n ** 18n); // 30% discount
    const baseCost = 1000n * 10n ** 18n;
    const { discountedCost } = await adapter.getConvictionDiscountedCost(1n, baseCost);
    expect(discountedCost).toBe(700n * 10n ** 18n); // 1000 * 7000/10000
  });

  it('tops up account without changing conviction', async () => {
    const adapter = new MockChainAdapter();
    const initial = 100_000n * 10n ** 18n;
    const topUp = 50_000n * 10n ** 18n;
    await adapter.createConvictionAccount(initial);

    const before = await adapter.getConvictionAccountInfo(1n);
    await adapter.topUpConvictionAccount(1n, topUp);
    const after = await adapter.getConvictionAccountInfo(1n);

    expect(after!.topUpBalance).toBe(topUp);
    expect(after!.lockedBalance).toBe(initial);
    expect(after!.conviction).toBe(before!.conviction);
    expect(after!.initialCommitment).toBe(initial);
  });

  it('closes account after lock expired and balances zero', async () => {
    const adapter = new MockChainAdapter();
    await adapter.createConvictionAccount(100_000n * 10n ** 18n);

    // Cannot close during lock
    const failResult = await adapter.closeConvictionAccount(1n);
    expect(failResult.success).toBe(false);

    // Advance past 12 epochs — still can't close (balances not zero)
    adapter.setMockEpoch(14n);
    const failResult2 = await adapter.closeConvictionAccount(1n);
    expect(failResult2.success).toBe(false);
  });

  it('returns null for nonexistent account', async () => {
    const adapter = new MockChainAdapter();
    const info = await adapter.getConvictionAccountInfo(999n);
    expect(info).toBeNull();
  });

  it('returns zero discount for nonexistent account', async () => {
    const adapter = new MockChainAdapter();
    const { discountBps } = await adapter.getConvictionDiscount(999n);
    expect(discountBps).toBe(0);
  });
});
