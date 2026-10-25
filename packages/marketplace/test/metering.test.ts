import { describe, expect, it } from 'vitest';
import { BuyerMeter, countTokens, formatTrac, proRataFinalize, queryUnits } from '../src/index.js';
import type { PlanPolicy } from '../src/index.js';

const TRAC = 10n ** 18n;

const POLICY: PlanPolicy = {
  totalBudgetWei: 10n * TRAC,
  buckets: [
    { match: { serviceType: 'inference' }, budgetWei: 6n * TRAC, priceCapWeiPerUnit: 10n ** 12n, maxUnitsPerCall: 4096n },
    { match: { serviceType: 'query' }, budgetWei: 5n * TRAC, priceCapWeiPerUnit: 10n ** 14n, maxUnitsPerCall: 512n },
  ],
};

describe('BuyerMeter reserve / settle / void', () => {
  it('reserves at admission and settles the actual value, releasing the rest', () => {
    const meter = new BuyerMeter(POLICY);
    meter.reserve(0, 'call-1', 2n * TRAC);
    expect(meter.snapshot().buckets[0]).toEqual({ budgetWei: 6n * TRAC, settledWei: 0n, reservedWei: 2n * TRAC });
    meter.settle('call-1', TRAC / 2n);
    expect(meter.snapshot().buckets[0]).toEqual({ budgetWei: 6n * TRAC, settledWei: TRAC / 2n, reservedWei: 0n });
    expect(meter.totalSettledWei).toBe(TRAC / 2n);
  });

  it('voids a reservation on failure without recording usage', () => {
    const meter = new BuyerMeter(POLICY);
    meter.reserve(1, 'call-2', 3n * TRAC);
    meter.voidReservation('call-2');
    expect(meter.snapshot().buckets[1]).toEqual({ budgetWei: 5n * TRAC, settledWei: 0n, reservedWei: 0n });
    expect(() => meter.voidReservation('call-2')).toThrow('no reservation');
  });

  it('refuses reservations beyond the bucket budget', () => {
    const meter = new BuyerMeter(POLICY);
    meter.reserve(0, 'call-3', 6n * TRAC);
    expect(() => meter.reserve(0, 'call-4', 1n)).toThrow('bucket 0 cannot cover');
  });

  it('refuses reservations beyond the plan total even with bucket headroom', () => {
    const meter = new BuyerMeter(POLICY);
    meter.reserve(0, 'call-5', 6n * TRAC);
    // Bucket 1 alone could cover 5 TRAC, but the plan total (10) cannot.
    expect(() => meter.reserve(1, 'call-6', 5n * TRAC)).toThrow('plan total cannot cover');
    meter.reserve(1, 'call-7', 4n * TRAC);
  });

  it('rejects duplicate call ids, unknown settlements, and over-settlement', () => {
    const meter = new BuyerMeter(POLICY);
    meter.reserve(0, 'call-8', TRAC);
    expect(() => meter.reserve(0, 'call-8', TRAC)).toThrow('duplicate reservation');
    expect(() => meter.settle('missing', 1n)).toThrow('no reservation');
    expect(() => meter.settle('call-8', TRAC + 1n)).toThrow('outside reservation');
    expect(() => meter.reserve(0, 'call-9', 0n)).toThrow('must be positive');
    expect(() => meter.reserve(5, 'call-10', 1n)).toThrow('unknown meter bucket');
  });

  it('renders the RFC meter line from bigint accounting only', () => {
    const meter = new BuyerMeter(POLICY, { resetsLabel: 'epoch 42 end' });
    meter.reserve(0, 'call-11', 2n * TRAC);
    meter.settle('call-11', (3n * TRAC) / 2n);
    meter.reserve(1, 'call-12', TRAC / 4n);
    expect(meter.meterSummary()).toBe('used 1.5 TRAC · remaining 8.25 TRAC · resets epoch 42 end');
  });
});

describe('formatTrac', () => {
  it('formats wei without floating point', () => {
    expect(formatTrac(0n)).toBe('0');
    expect(formatTrac(TRAC)).toBe('1');
    expect(formatTrac(1n)).toBe('0.000000000000000001');
    expect(formatTrac(2_500_000_000_000_000_000n)).toBe('2.5');
    expect(formatTrac(-TRAC / 2n)).toBe('-0.5');
  });
});

describe('unit counting schedule', () => {
  it('countTokens = ceil(utf8Bytes / 4)', () => {
    expect(countTokens('')).toBe(0n);
    expect(countTokens('abcd')).toBe(1n);
    expect(countTokens('abcde')).toBe(2n);
    // '€' is 3 UTF-8 bytes: 9 bytes total -> ceil(9/4) = 3.
    expect(countTokens('€€€')).toBe(3n);
  });

  it('queryUnits = 10 + ceil(bytes / 100) + rows', () => {
    expect(queryUnits('', 0)).toBe(10n);
    expect(queryUnits('SELECT * WHERE { ?s ?p ?o }', 5n)).toBe(10n + 1n + 5n);
    expect(queryUnits('x'.repeat(101), 0)).toBe(10n + 2n);
    expect(() => queryUnits('q', -1)).toThrow('non-negative');
  });
});

describe('proRataFinalize (mirror of Marketplace.finalizeBucket)', () => {
  it('passes claims through untouched when the bucket covers them', () => {
    expect(
      proRataFinalize(10n * TRAC, [
        { identityId: 1n, claimedWei: 4n * TRAC },
        { identityId: 2n, claimedWei: 6n * TRAC },
      ]),
    ).toEqual([
      { identityId: 1n, finalizedWei: 4n * TRAC },
      { identityId: 2n, finalizedWei: 6n * TRAC },
    ]);
  });

  it('floors pro-rata shares exactly like the contract and leaves the residue', () => {
    // funded = 10, claims = 7 + 8 = 15: finalized_i = floor(claimed_i * 10 / 15).
    const finalized = proRataFinalize(10n, [
      { identityId: 1n, claimedWei: 7n },
      { identityId: 2n, claimedWei: 8n },
    ]);
    expect(finalized).toEqual([
      { identityId: 1n, finalizedWei: 4n }, // floor(70 / 15) = 4
      { identityId: 2n, finalizedWei: 5n }, // floor(80 / 15) = 5
    ]);
    const paidOut = finalized.reduce((sum, entry) => sum + entry.finalizedWei, 0n);
    expect(paidOut).toBe(9n); // 1 wei of flooring residue stays in the pool
  });

  it('is order-independent: no submission-order priority', () => {
    const forward = proRataFinalize(100n, [
      { identityId: 1n, claimedWei: 150n },
      { identityId: 2n, claimedWei: 50n },
    ]);
    const reversed = proRataFinalize(100n, [
      { identityId: 2n, claimedWei: 50n },
      { identityId: 1n, claimedWei: 150n },
    ]);
    expect(forward.find((entry) => entry.identityId === 1n)).toEqual(
      reversed.find((entry) => entry.identityId === 1n),
    );
    expect(forward.find((entry) => entry.identityId === 2n)).toEqual(
      reversed.find((entry) => entry.identityId === 2n),
    );
  });

  it('validates inputs', () => {
    expect(() => proRataFinalize(-1n, [])).toThrow('non-negative');
    expect(() => proRataFinalize(1n, [{ identityId: 1n, claimedWei: -1n }])).toThrow('non-negative');
    expect(proRataFinalize(0n, [{ identityId: 1n, claimedWei: 5n }])).toEqual([
      { identityId: 1n, finalizedWei: 0n },
    ]);
  });
});
