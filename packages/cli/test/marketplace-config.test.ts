import { describe, it, expect } from 'vitest';
import {
  MARKETPLACE_ENABLED_ENV,
  parseMarketplaceOffering,
  parseMarketplaceUint,
  resolveMarketplaceAgentConfig,
  type DkgMarketplaceConfig,
} from '../src/marketplace-config.js';

describe('parseMarketplaceUint', () => {
  it('parses decimal strings and safe-integer numbers to bigint', () => {
    expect(parseMarketplaceUint('500000000000', 'ask')).toBe(500_000_000_000n);
    expect(parseMarketplaceUint(' 42 ', 'epoch')).toBe(42n);
    expect(parseMarketplaceUint(0, 'zero')).toBe(0n);
    expect(parseMarketplaceUint(1000, 'units')).toBe(1000n);
    // A uint96 ask comfortably above 2^53 must survive losslessly as a string.
    expect(parseMarketplaceUint('79228162514264337593543950335', 'ask')).toBe(2n ** 96n - 1n);
  });

  it('rejects numbers beyond JSON safe-integer range (already rounded by the parser)', () => {
    expect(() => parseMarketplaceUint(2 ** 53, 'ask')).toThrow(/ask must be a non-negative integer/);
  });

  it('rejects negatives, decimals, hex and junk, naming the field', () => {
    expect(() => parseMarketplaceUint(-1, 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint('1.5', 'budget')).toThrow(/budget must be a non-negative decimal integer string/);
    expect(() => parseMarketplaceUint('0x10', 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint(undefined, 'budget')).toThrow(/budget/);
    expect(() => parseMarketplaceUint('', 'budget')).toThrow(/budget/);
  });
});

describe('parseMarketplaceOffering', () => {
  const valid = {
    offeringLocalId: 'devnet-llm',
    serviceType: 'inference',
    unit: 'token',
    askPerUnitWei: '500000000000',
  };

  it('maps wei/unit strings to bigint and keeps optional fields only when present', () => {
    const offering = parseMarketplaceOffering(
      { ...valid, modelId: 'stub-1', capacityUnitsPerMin: 60000, expiresAt: 1793577600, executor: 'stub-inference' },
      'offerings[0]',
    );
    expect(offering).toEqual({
      offeringLocalId: 'devnet-llm',
      serviceType: 'inference',
      modelId: 'stub-1',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
      capacityUnitsPerMin: 60_000n,
      expiresAt: 1793577600,
      executor: 'stub-inference',
    });
    const minimal = parseMarketplaceOffering(valid, 'offerings[0]');
    expect(minimal).toEqual({
      offeringLocalId: 'devnet-llm',
      serviceType: 'inference',
      unit: 'token',
      askPerUnitWei: 500_000_000_000n,
    });
    expect('modelId' in minimal).toBe(false);
    expect('capacityUnitsPerMin' in minimal).toBe(false);
  });

  it('rejects malformed fields with the offending key path', () => {
    expect(() => parseMarketplaceOffering('nope', 'offerings[0]')).toThrow(/offerings\[0\] must be an offering object/);
    expect(() => parseMarketplaceOffering({ ...valid, serviceType: 'chat' }, 'offerings[1]'))
      .toThrow(/offerings\[1\]\.serviceType must be one of inference, query, reasoning, graph-ml/);
    expect(() => parseMarketplaceOffering({ ...valid, unit: 'calls' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.unit/);
    expect(() => parseMarketplaceOffering({ ...valid, askPerUnitWei: '0.5' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.askPerUnitWei/);
    expect(() => parseMarketplaceOffering({ ...valid, offeringLocalId: '' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.offeringLocalId/);
    expect(() => parseMarketplaceOffering({ ...valid, executor: 'real-llm' }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.executor/);
    expect(() => parseMarketplaceOffering({ ...valid, expiresAt: -5 }, 'offerings[0]'))
      .toThrow(/offerings\[0\]\.expiresAt/);
  });
});

describe('resolveMarketplaceAgentConfig', () => {
  it('returns undefined with no block and no env — the runtime stays off', () => {
    expect(resolveMarketplaceAgentConfig(undefined, undefined)).toBeUndefined();
  });

  it(`${MARKETPLACE_ENABLED_ENV}=1 enables with no config block at all`, () => {
    expect(resolveMarketplaceAgentConfig(undefined, '1')).toEqual({ enabled: true });
  });

  it('the environment override wins over the config flag, both ways', () => {
    expect(resolveMarketplaceAgentConfig({ enabled: true }, '0')?.enabled).toBe(false);
    expect(resolveMarketplaceAgentConfig({ enabled: false }, 'true')?.enabled).toBe(true);
  });

  it('a junk environment value fails loudly instead of picking a side', () => {
    expect(() => resolveMarketplaceAgentConfig({ enabled: true }, 'yes'))
      .toThrow(new RegExp(MARKETPLACE_ENABLED_ENV));
  });

  it('maps the full block: offerings, batching exposure and buyer knobs', () => {
    const config: DkgMarketplaceConfig = {
      enabled: true,
      seller: {
        offerings: [{
          offeringLocalId: 'devnet-knowledge',
          serviceType: 'query',
          unit: 'query-unit',
          askPerUnitWei: '15000000000000',
        }],
        flushIntervalMs: 2000,
        batching: { maxBatchSize: 10, maxDelayMs: 4000, maxBuyerExposureWei: '1000000000000000000' },
      },
      buyer: { authTtlSeconds: 300, quoteTimeoutMs: 1500, serveTimeoutMs: 20000, maxQuoteProbes: 4 },
    };
    const resolved = resolveMarketplaceAgentConfig(config, undefined);
    expect(resolved).toEqual({
      enabled: true,
      seller: {
        offerings: [{
          offeringLocalId: 'devnet-knowledge',
          serviceType: 'query',
          unit: 'query-unit',
          askPerUnitWei: 15_000_000_000_000n,
        }],
        flushIntervalMs: 2000,
        batching: { maxBatchSize: 10, maxDelayMs: 4000, maxBuyerExposureWei: 10n ** 18n },
      },
      buyer: { authTtlSeconds: 300, quoteTimeoutMs: 1500, serveTimeoutMs: 20000, maxQuoteProbes: 4 },
    });
  });

  it('a present-but-disabled block is still parsed so typos fail at boot', () => {
    expect(() => resolveMarketplaceAgentConfig({
      enabled: false,
      seller: { offerings: [{ offeringLocalId: 'x', serviceType: 'inference', unit: 'token', askPerUnitWei: 'ten' }] },
    } as DkgMarketplaceConfig, undefined)).toThrow(/marketplace\.seller\.offerings\[0\]\.askPerUnitWei/);
    expect(resolveMarketplaceAgentConfig({ enabled: false }, undefined)).toEqual({ enabled: false });
  });

  it('rejects malformed seller/buyer shapes, naming the config key', () => {
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, seller: [] as never }, undefined))
      .toThrow(/marketplace\.seller must be an object/);
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, seller: { offerings: {} as never } }, undefined))
      .toThrow(/marketplace\.seller\.offerings must be an array/);
    expect(() => resolveMarketplaceAgentConfig({ enabled: true, buyer: { authTtlSeconds: -1 } }, undefined))
      .toThrow(/marketplace\.buyer\.authTtlSeconds/);
    expect(() => resolveMarketplaceAgentConfig(
      { enabled: true, seller: { batching: { maxBuyerExposureWei: 2 ** 53 } } },
      undefined,
    )).toThrow(/marketplace\.seller\.batching\.maxBuyerExposureWei/);
  });
});
