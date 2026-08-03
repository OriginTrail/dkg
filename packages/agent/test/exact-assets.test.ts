import { describe, expect, it } from 'vitest';
import {
  MAX_EXACT_SYNC_ASSETS,
  decodeExactAssetUals,
  encodeExactAssetUals,
  exactAssetFilterKey,
  normalizeExactAssetUals,
} from '../src/sync/exact-assets.js';

const ual = (number: number) =>
  `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${number}`;

describe('exact VM sync asset filter', () => {
  it('canonicalizes, deduplicates, and round-trips a bounded KA batch', () => {
    const normalized = normalizeExactAssetUals([ual(2), ual(1), ual(2)]);
    expect(normalized).toEqual([ual(1), ual(2)]);
    expect(decodeExactAssetUals(encodeExactAssetUals([ual(2), ual(1)]))).toEqual(normalized);
    expect(exactAssetFilterKey([ual(2), ual(1)]))
      .toBe(exactAssetFilterKey([ual(1), ual(2)]));
  });

  it('fails closed for malformed or oversized present filters', () => {
    expect(normalizeExactAssetUals(['not-a-ual'])).toEqual([]);
    expect(normalizeExactAssetUals(Array.from(
      { length: MAX_EXACT_SYNC_ASSETS + 1 },
      (_, index) => ual(index),
    ))).toEqual([]);
  });
});
