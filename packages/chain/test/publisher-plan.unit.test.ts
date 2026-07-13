import { describe, expect, it, vi } from 'vitest';
import { resolvePublisherCandidatePricing } from '../src/publisher-plan.js';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { ContextGraphMethods } from '../src/evm-adapter-context-graph.js';

describe('resolvePublisherCandidatePricing', () => {
  it('keeps the public publish planner on the publish mixin boundary', () => {
    expect(Object.hasOwn(PublishMethods.prototype, 'resolvePublisherPublishPlan')).toBe(true);
    expect(Object.hasOwn(ContextGraphMethods.prototype, 'resolvePublisherPublishPlan')).toBe(false);
  });

  it('uses a covering PCA lock and its exact clamped quote', async () => {
    const quote = vi.fn(async (epochs: number) => BigInt(epochs));
    const canCover = vi.fn(async () => true);

    const pricing = await resolvePublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000001',
      defaultPublishEpochs: 12,
      quote,
      conviction: {
        getAccountId: async () => 42n,
        getLockDurationEpochs: async () => 24,
        canCover,
      },
    });

    expect(pricing).toMatchObject({
      publishEpochs: 24,
      tokenAmount: 24n,
      pcaAccountId: 42n,
      pcaLockDurationEpochs: 24,
      pcaApplied: true,
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(24);
    expect(canCover).toHaveBeenCalledWith(42n, 24n);
  });

  it('keeps the direct-spend lifetime when exact PCA coverage is not confirmed', async () => {
    const quote = vi.fn(async (epochs: number) => BigInt(epochs * 10));

    const pricing = await resolvePublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000002',
      defaultPublishEpochs: 12,
      quote,
      conviction: {
        getAccountId: async () => 7n,
        getLockDurationEpochs: async () => 24,
        canCover: async () => false,
      },
    });

    expect(pricing).toMatchObject({
      publishEpochs: 12,
      tokenAmount: 120n,
      pcaAccountId: 7n,
      pcaLockDurationEpochs: 24,
      pcaApplied: false,
    });
    expect(quote.mock.calls).toEqual([[24], [12]]);
  });

  it('fails safely to protocol-minimum direct pricing after PCA and quote failures', async () => {
    const pricing = await resolvePublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000003',
      defaultPublishEpochs: 12,
      quote: async () => { throw new Error('quote unavailable'); },
      conviction: {
        getAccountId: async () => { throw new Error('PCA RPC unavailable'); },
        getLockDurationEpochs: async () => 24,
        canCover: async () => true,
      },
    });

    expect(pricing.publishEpochs).toBe(12);
    expect(pricing.tokenAmount).toBe(12n);
    expect(pricing.pcaApplied).toBe(false);
    expect(pricing.pcaProbeError).toBeInstanceOf(Error);
    expect(pricing.quoteError).toBeInstanceOf(Error);
  });
});
