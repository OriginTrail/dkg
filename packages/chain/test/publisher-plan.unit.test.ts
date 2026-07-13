import { describe, expect, it, vi } from 'vitest';
import {
  resolveLegacyPublisherCandidatePricing,
  resolveQuotedPublisherCandidatePricing,
} from '../src/publisher-plan.js';
import { EVMChainAdapterBase } from '../src/evm-adapter-base.js';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { ContextGraphMethods } from '../src/evm-adapter-context-graph.js';

describe('publisher candidate pricing boundaries', () => {
  it('keeps publish/PCA orchestration on the publish feature boundary', () => {
    expect(Object.hasOwn(PublishMethods.prototype, 'resolvePublisherPublishPlan')).toBe(true);
    expect(Object.hasOwn(PublishMethods.prototype, 'resolveFundedPublisherPublishPlan')).toBe(true);
    expect(Object.hasOwn(PublishMethods.prototype, 'quoteRequiredPublishTokenAmount')).toBe(true);
    expect(Object.hasOwn(EVMChainAdapterBase.prototype, 'resolveFundedPublisherPublishPlan'))
      .toBe(false);
    expect(Object.hasOwn(EVMChainAdapterBase.prototype, 'quoteRequiredPublishTokenAmount'))
      .toBe(false);
    expect(Object.hasOwn(ContextGraphMethods.prototype, 'resolvePublisherPublishPlan')).toBe(false);
  });

  it('strict planning uses a covering PCA lock and its exact clamped quote', async () => {
    const quote = vi.fn(async (epochs: number) => BigInt(epochs));
    const canCover = vi.fn(async () => true);

    const pricing = await resolveQuotedPublisherCandidatePricing({
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
      source: 'pca',
      pricingMode: 'strict-quoted',
      quoteSource: 'chain',
      publishEpochs: 24,
      tokenAmount: 24n,
      pca: { accountId: 42n, lockDurationEpochs: 24, coverage: 'verified' },
      diagnostics: {},
    });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(quote).toHaveBeenCalledWith(24, 'pca');
    expect(canCover).toHaveBeenCalledWith(42n, 24n);
  });

  it('strict planning keeps direct spend when exact PCA coverage is not confirmed', async () => {
    const quote = vi.fn(async (epochs: number) => BigInt(epochs * 10));

    const pricing = await resolveQuotedPublisherCandidatePricing({
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
      source: 'direct',
      pricingMode: 'strict-quoted',
      quoteSource: 'chain',
      publishEpochs: 12,
      tokenAmount: 120n,
      diagnostics: {
        pcaCandidate: { accountId: 7n, lockDurationEpochs: 24 },
      },
    });
    expect(quote.mock.calls).toEqual([[24, 'pca'], [12, 'direct']]);
  });

  it('strict quote failure propagates instead of manufacturing a fundability amount', async () => {
    await expect(resolveQuotedPublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000003',
      defaultPublishEpochs: 12,
      quote: async () => { throw new Error('AskStorage unavailable'); },
    })).rejects.toThrow('AskStorage unavailable');
  });

  it('legacy compatibility labels protocol-minimum fallback explicitly', async () => {
    const pricing = await resolveLegacyPublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000004',
      defaultPublishEpochs: 12,
      quote: async () => { throw new Error('legacy quote unavailable'); },
    });

    expect(pricing).toMatchObject({
      source: 'direct',
      pricingMode: 'legacy-compatibility',
      quoteSource: 'protocol-minimum',
      publishEpochs: 12,
      tokenAmount: 12n,
    });
    expect(pricing.diagnostics.quoteError).toBeInstanceOf(Error);
  });

  it('legacy compatibility preserves PCA lock coercion without a coverage probe', async () => {
    const pricing = await resolveLegacyPublisherCandidatePricing({
      publisherAddress: '0x0000000000000000000000000000000000000005',
      defaultPublishEpochs: 12,
      quote: async (epochs) => BigInt(epochs),
      conviction: {
        getAccountId: async () => 42n,
        getLockDurationEpochs: async () => 24,
      },
    });

    expect(pricing).toMatchObject({
      source: 'pca',
      pricingMode: 'legacy-compatibility',
      quoteSource: 'chain',
      publishEpochs: 24,
      tokenAmount: 24n,
      pca: { accountId: 42n, lockDurationEpochs: 24, coverage: 'legacy-unchecked' },
    });
  });
});
