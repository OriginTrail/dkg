/**
 * GH#3134 — the applied-inventory commitment of a catalog head: the flat row hash for one bucket,
 * byte for byte as before, and the signed directory for more than one bucket.
 */
import { describe, expect, it } from 'vitest';

import type { CountV1, Digest32V1, KaIdV1 } from '@origintrail-official/dkg-core';

import { computeRfc64CatalogAppliedInventoryDigestV1 } from '../src/rfc64/applied-catalog-inventory-digest-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from '../src/rfc64/public-catalog-inventory-completeness-v1.js';

const AUTHOR = '0x1111111111111111111111111111111111111111';
const SCOPE = digest(1);
const ROWS = [10, 2].map((number) => ({
  kaId: ((BigInt(AUTHOR) << 96n) | BigInt(number)).toString() as KaIdV1,
  catalogRowDigest: digest(number * 4),
  contentDigest: digest(number * 4 + 1),
  sealDigest: digest(number * 4 + 2),
  kaUal: `did:dkg:otp:20430/${AUTHOR}/${number}`,
  activatedTripleCount: number + 1,
}));

describe('applied-inventory commitment of a catalog head (GH#3134)', () => {
  it('is the flat row hash for a one-bucket catalog', () => {
    const flat = computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: SCOPE, rows: ROWS });

    expect(commit('1', digest(7), '2', ROWS)).toBe(flat);
    expect(commit('1', digest(7), '0', [])).toBe(computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: SCOPE,
      rows: [],
    }));
  });

  it('commits a catalog of more than one bucket through its directory root and row count', () => {
    const committed = commit('4', digest(7), '2', ROWS);

    // The rows a caller passes are the changed bucket's; they do not enter the commitment.
    expect(commit('4', digest(7), '2', [])).toBe(committed);
    expect(committed).not.toBe(computeRfc64AppliedInventoryDigestV1({ catalogScopeDigest: SCOPE, rows: ROWS }));
    expect(commit('4', digest(8), '2', ROWS)).not.toBe(committed);
    expect(commit('4', digest(7), '3', ROWS)).not.toBe(committed);
    expect(computeRfc64CatalogAppliedInventoryDigestV1({
      catalogScopeDigest: digest(2),
      rows: ROWS,
      directory: { bucketCount: '4' as CountV1, directoryRootDigest: digest(7), totalRows: '2' as CountV1 },
    })).not.toBe(committed);
  });

  it('refuses a directory that is not canonical', () => {
    expect(() => commit('4', '0x07' as Digest32V1, '2', ROWS)).toThrow();
    expect(() => commit('4', digest(7), '02', ROWS)).toThrow();
  });
});

function commit(bucketCount: string, directoryRootDigest: Digest32V1, totalRows: string, rows: typeof ROWS) {
  return computeRfc64CatalogAppliedInventoryDigestV1({
    catalogScopeDigest: SCOPE,
    rows,
    directory: {
      bucketCount: bucketCount as CountV1,
      directoryRootDigest,
      totalRows: totalRows as CountV1,
    },
  });
}

function digest(number: number): Digest32V1 {
  return `0x${number.toString(16).padStart(64, '0')}` as Digest32V1;
}
