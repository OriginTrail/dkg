import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  planNextRfc64CatalogExactSetV1,
  type ReconcileRfc64PublicRootCatalogExactSetParamsV1,
} from '../src/dkg-agent-rfc64-catalog-upsert.js';

type Asset = ReconcileRfc64PublicRootCatalogExactSetParamsV1['assets'][number];

function plannerAsset(kaId: bigint): Asset {
  return Object.freeze({
    assertionCoordinate: `asset-${kaId}`,
    projectionBytes: new Uint8Array([Number(kaId % 251n)]),
    seal: Object.freeze({ reservedKaId: kaId.toString() }),
  }) as unknown as Asset;
}

describe('RFC-64 exact-set bounded planner v1', () => {
  it('frees one current-only slot before inserting into a full 1,024-row set', () => {
    const current = Array.from(
      { length: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 },
      (_value, index) => plannerAsset(BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 + index)),
    );
    const target = Array.from(
      { length: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 },
      (_value, index) => plannerAsset(BigInt(index)),
    );

    const freed = planNextRfc64CatalogExactSetV1(current, target);
    expect(freed).toHaveLength(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 - 1);
    expect(freed.some((asset) => asset.seal.reservedKaId === '2047')).toBe(false);

    const inserted = planNextRfc64CatalogExactSetV1(freed, target);
    expect(inserted).toHaveLength(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
    expect(inserted[0]?.seal.reservedKaId).toBe('0');
    expect(Math.max(freed.length, inserted.length)).toBe(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
  });
});
