/**
 * GH#3134 — exact-set reconciliation of a catalog of more than one bucket, over fake reads and
 * successors: which buckets are read, which are left alone, and the bounds.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  catalogKeyToBucketIdV1,
  encodeOpaqueKaBundleV1,
  type AuthorCatalogRowV1,
  type CountV1,
  type DecimalU64V1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';

import {
  bucketRowsHoldAssetsV1,
  bucketRowsPlaceAssetsV1,
  groupCatalogAssetsByBucketV1,
  reconcileCatalogBucketsV1,
  type CatalogBucketReconciliationV1,
} from '../src/internal/catalog-bucket-reconcile.js';
import type { Rfc64CatalogMutationStateV1 } from '../src/internal/catalog-mutation-memory.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from '../src/rfc64/public-catalog-successor-producer-v1.js';
import { producerAssetV1 } from './support/rfc64-successor-producer-fixture.js';

const BUCKETS = '4' as CountV1;
type Asset = Rfc64PublicCatalogSuccessorAssetInputV1;

describe('bucket-by-bucket reconciliation (GH#3134)', () => {
  it('splits a target by bucket, each part in KA order', async () => {
    const assets = await assetsFor(8);
    const groups = groupCatalogAssetsByBucketV1(assets, BUCKETS);

    expect([...groups.values()].flat()).toHaveLength(8);
    for (const [bucketId, part] of groups) {
      for (const asset of part) expect(bucketOf(asset)).toBe(bucketId);
      expect(part).toEqual(assets.filter((asset) => bucketOf(asset) === bucketId));
    }
  });

  it('knows a bucket that places its part exactly, and one that holds its part among other rows', async () => {
    const [first, second, third] = await assetsFor(3);
    const rows = [rowOf(first!), rowOf(second!)];

    expect(bucketRowsPlaceAssetsV1(rows, [first!, second!])).toBe(true);
    expect(bucketRowsPlaceAssetsV1(rows, [first!])).toBe(false);
    expect(bucketRowsPlaceAssetsV1(rows, [first!, third!])).toBe(false);
    expect(bucketRowsHoldAssetsV1(rows, [second!])).toBe(true);
    expect(bucketRowsHoldAssetsV1(rows, [third!])).toBe(false);
    // A newer version of the same KA is another bundle.
    const newer = await producerAssetV1(Number(kaNumberOf(first!)), '2');
    expect(bucketRowsHoldAssetsV1(rows, [newer])).toBe(false);
    expect(bucketRowsPlaceAssetsV1([{ ...rowOf(first!), assertionCoordinate: 'moved' as never }], [first!])).toBe(false);
  });

  it('reads with bundles and changes only the buckets whose rows differ from their part', async () => {
    const assets = await assetsFor(8);
    const catalog = groupCatalogAssetsByBucketV1(assets.slice(0, 6), BUCKETS);
    const run = harness(catalog);

    const result = await reconcileCatalogBucketsV1(run.input(assets, 'exact-replacement'));

    const changed = [...new Set(assets.slice(6).map(bucketOf))].sort();
    expect(run.statesRead.sort()).toEqual(changed);
    expect(result).toMatchObject({ successorsApplied: 2, sourceCurrent: true });
    expect(result.last?.assets.at(-1)).toBeDefined();
  });

  it('empties a bucket the exact replacement no longer names, and keeps it under a monotonic union', async () => {
    const assets = await assetsFor(8);
    const catalog = groupCatalogAssetsByBucketV1(assets, BUCKETS);
    const [dropped] = [...catalog.keys()];
    const target = assets.filter((asset) => bucketOf(asset) !== dropped);

    const exact = harness(catalog);
    const replaced = await reconcileCatalogBucketsV1(exact.input(target, 'exact-replacement'));
    expect(exact.statesRead).toEqual([dropped]);
    expect(replaced.successorsApplied).toBe(catalog.get(dropped!)!.length);

    const union = harness(catalog);
    await expect(reconcileCatalogBucketsV1(union.input(target, 'monotonic-union')))
      .resolves.toMatchObject({ successorsApplied: 0, last: null });
    expect(union.statesRead).toEqual([]);
  });

  it('stops at its successor limit, and at a commit whose source moved on', async () => {
    const assets = await assetsFor(8);
    const limited = harness(new Map());
    await expect(reconcileCatalogBucketsV1({ ...limited.input(assets, 'exact-replacement'), successorLimit: 3 }))
      .rejects.toThrow('RFC-64 exact-set reconciliation exceeded its bounded successor limit');

    const moved = harness(new Map(), false);
    await expect(reconcileCatalogBucketsV1(moved.input(assets, 'exact-replacement')))
      .resolves.toMatchObject({ successorsApplied: 1, sourceCurrent: false });
  });
});

/** A catalog in memory: its buckets' rows, states read, successors applied one KA at a time. */
function harness(initial: ReadonlyMap<string, readonly Asset[]>, sourceCurrent = true) {
  const buckets = new Map([...initial].map(([bucketId, part]) => [bucketId, [...part]]));
  const statesRead: string[] = [];
  return {
    statesRead,
    input(requested: readonly Asset[], policy: CatalogBucketReconciliationV1['policy']): CatalogBucketReconciliationV1 {
      return {
        bucketCount: BUCKETS,
        requested,
        policy,
        bucketsWithRows: [...buckets.keys()].filter((bucketId) => buckets.get(bucketId)!.length > 0) as DecimalU64V1[],
        readBucketRows: async (bucketId) => (buckets.get(bucketId) ?? []).map(rowOf),
        readBucketState: async (bucketId) => {
          statesRead.push(bucketId);
          return stateOf(bucketId, buckets.get(bucketId) ?? []);
        },
        applySuccessor: vi.fn(async (state: Rfc64CatalogMutationStateV1, assets: readonly Asset[]) => {
          buckets.set(state.bucketId, [...assets]);
          return { next: stateOf(state.bucketId, assets), sourceCurrent };
        }),
        successorLimit: 100,
        throwIfAborted: () => undefined,
      };
    },
  };
}

function stateOf(bucketId: string, assets: readonly Asset[]): Rfc64CatalogMutationStateV1 {
  return { bucketId, assets: [...assets] } as unknown as Rfc64CatalogMutationStateV1;
}

function rowOf(asset: Asset): AuthorCatalogRowV1 {
  return {
    kaId: asset.seal.reservedKaId,
    assertionCoordinate: asset.assertionCoordinate,
    transfer: {
      blobDigest: encodeOpaqueKaBundleV1(
        asset.projectionBytes,
        canonicalizeCanonicalGraphScopedAuthorSealBytesV1(asset.seal),
      ).blobDigest,
    },
  } as unknown as AuthorCatalogRowV1;
}

async function assetsFor(count: number): Promise<Asset[]> {
  const assets = await Promise.all(Array.from({ length: count }, (_value, index) => producerAssetV1(index + 1)));
  return assets.sort((left, right) => (BigInt(left.seal.reservedKaId) < BigInt(right.seal.reservedKaId) ? -1 : 1));
}

function bucketOf(asset: Asset): string {
  return catalogKeyToBucketIdV1(asset.seal.reservedKaId as KaIdV1, BUCKETS);
}

function kaNumberOf(asset: Asset): bigint {
  return BigInt(asset.seal.reservedKaId) & ((1n << 96n) - 1n);
}
