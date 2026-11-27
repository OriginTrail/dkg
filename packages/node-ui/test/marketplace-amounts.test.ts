import { describe, expect, it } from 'vitest';
import { fmtMicro, microOfWei, tracOfWei, weiOfMicro, weiOfTrac } from '../src/ui/marketplace/amounts.js';
import { lineFor } from '../src/ui/marketplace/purchase/Composer.js';
import type { Offer, Service } from '../src/ui/marketplace/api/types.js';

const offer = (seller: number, pricePerUnit: string, nextPricePerUnit?: string): Offer => ({
  serviceId: '0x01', seller, epoch: 664, unit: 'token', pricePerUnit, pricePerUnitTrac: '0.0',
  ...(nextPricePerUnit ? { nextPricePerUnit, nextPricePerUnitTrac: '0.0' } : {}),
  provenance: 'weights-pinned', available: true, measured: { latencyMs: null, tokensPerSecond: null },
});

describe('marketplace amounts', () => {
  it('writes a price in µTRAC exactly, for a value to edit, and reads it back to the wei', () => {
    for (const wei of [1n, 10n, 123_456_000_000n, 123_456_789_012n, 700_000_000_000n, 10n ** 12n, 3n * 10n ** 18n + 7n]) {
      expect(weiOfMicro(microOfWei(wei))).toBe(wei);
    }
    expect(microOfWei('123456000000')).toBe('0.123456');
    expect(microOfWei('10')).toBe('0.00000000001');
    expect(microOfWei('1200000000000')).toBe('1.2');
  });

  it('writes an amount in TRAC exactly, for a value to edit, and reads it back to the wei', () => {
    for (const wei of [1n, 5n * 10n ** 17n, 10n ** 18n, 123_456_789_012_345_678n, 3n * 10n ** 18n + 7n]) {
      expect(weiOfTrac(tracOfWei(wei))).toBe(wei);
    }
    expect(tracOfWei('500000000000000000')).toBe('0.5');
    expect(tracOfWei('2000000000000000000')).toBe('2');
    expect(tracOfWei('1')).toBe('0.000000000000000001');
  });

  it('cuts a price to four places for display only', () => {
    expect(fmtMicro('123456000000')).toBe('0.1234');
    expect(fmtMicro('10')).toBe('<0.0001');
    expect(weiOfMicro(fmtMicro('123456000000'))).not.toBe(123_456_000_000n);
  });

  it('caps a new line at the dearest seller\'s price to the wei, so every seller qualifies', () => {
    const service: Service = {
      serviceId: '0x01', serviceClass: 'inference', label: 'urn:test:model:a',
      offers: [offer(1, '123456789012'), offer(2, '10', '123456789013')],
      priceMin: '10', priceMinTrac: '0.0', priceMax: '123456789012', priceMaxTrac: '0.0',
    };
    expect(weiOfMicro(lineFor(service, 'current').capMicro)).toBe(123_456_789_012n);
    expect(weiOfMicro(lineFor(service, 'next').capMicro)).toBe(123_456_789_013n);
    const dust: Service = { ...service, offers: [offer(1, '10')] };
    expect(weiOfMicro(lineFor(dust, 'current').capMicro)).toBe(10n);
  });
});
