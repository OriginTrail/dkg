import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { computeConvictionMultiplier } from '../src/mock-adapter.js';

describe('Staking Conviction (MockChainAdapter)', () => {
  it('stakeWithLock stores lock and returns success', async () => {
    const adapter = new MockChainAdapter();
    const result = await adapter.stakeWithLock(1n, 100_000n, 6);
    expect(result.success).toBe(true);
  });

  it('returns correct multiplier for V10 discrete tiers', async () => {
    expect(computeConvictionMultiplier(0)).toBe(0);
    expect(computeConvictionMultiplier(1)).toBe(1.0);
    expect(computeConvictionMultiplier(2)).toBe(1.5);
    expect(computeConvictionMultiplier(3)).toBe(2.0);
    expect(computeConvictionMultiplier(5)).toBe(2.0);
    expect(computeConvictionMultiplier(6)).toBe(3.5);
    expect(computeConvictionMultiplier(11)).toBe(3.5);
    expect(computeConvictionMultiplier(12)).toBe(6.0);
    expect(computeConvictionMultiplier(24)).toBe(6.0);
  });

  it('getDelegatorConvictionMultiplier returns correct value after stakeWithLock', async () => {
    const adapter = new MockChainAdapter();
    await adapter.stakeWithLock(1n, 100_000n, 6);

    const { multiplier } = await adapter.getDelegatorConvictionMultiplier(1n, adapter.signerAddress);
    expect(multiplier).toBe(3.5);
  });

  it('stakeWithLock only extends, never shortens lock', async () => {
    const adapter = new MockChainAdapter();
    await adapter.stakeWithLock(1n, 100_000n, 12);
    await adapter.stakeWithLock(1n, 50_000n, 3);

    const { multiplier } = await adapter.getDelegatorConvictionMultiplier(1n, adapter.signerAddress);
    expect(multiplier).toBe(6.0);
  });

  it('returns 1x multiplier for default (unset) lock', async () => {
    const adapter = new MockChainAdapter();
    const { multiplier } = await adapter.getDelegatorConvictionMultiplier(1n, '0x0000');
    expect(multiplier).toBe(1.0);
  });
});
