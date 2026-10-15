/**
 * GH#3134 — the production successor producer on a catalog of more than one bucket: it replaces
 * the bucket of the changed asset and its directory path, and leaves every other bucket as it is.
 * The catalog is moved from one bucket to four by the capacity transition producer.
 */
import { describe, expect, it } from 'vitest';

import {
  catalogKeyToBucketIdV1,
  type CountV1,
  type DecimalU64V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
} from '@origintrail-official/dkg-core';

import { produceAuthorCatalogCapacityTransitionV1 } from '../src/rfc64/author-catalog-capacity-transition-v1.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from '../src/rfc64/public-catalog-successor-producer-v1.js';
import {
  PRODUCER_DEPLOYMENT,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSignerV1,
  type ProducerHistoryV1,
} from './support/rfc64-successor-producer-fixture.js';

const BUCKETS = '4' as CountV1;

describe('successor production in a catalog of more than one bucket (GH#3134)', () => {
  it('places a new asset into its own bucket and keeps the other buckets', async () => {
    const { moved, authorization, kaNumbers } = await movedCatalog();
    const added = await firstAssetOutside(kaNumbers);
    const bucketId = bucketOf(added);
    const previousBucket = moved.buckets.find((bucket) => bucket.payload.bucketId === bucketId) ?? null;
    const sameBucket = await assetsIn(kaNumbers, bucketId);

    const produced = await producerOverMemoryV1().produceAndStageExactSet({
      previousHead: moved.head,
      previousDirectoryPath: moved.directoryNodes,
      previousBucket,
      selectedBucketId: bucketId,
      assets: [...sameBucket, added],
      deployment: PRODUCER_DEPLOYMENT,
      issuedAt: '1773900010000' as never,
      catalogSigner: producerSignerV1(),
      catalogIssuerAuthorization: authorization,
    });

    expect(produced.publication.head.payload).toMatchObject({
      bucketCount: BUCKETS,
      directoryHeight: '0',
      totalRows: String(kaNumbers.length + 1),
      version: String(BigInt(moved.head.payload.version) + 1n),
      previousHeadDigest: moved.head.objectDigest,
    });
    expect(produced.publication.bucket?.payload.bucketId).toBe(bucketId);
    expect(produced.publication.bucket?.payload.rows.map((row) => row.kaId))
      .toEqual(produced.assets.map((asset) => asset.row.kaId));
    // The root names the new bucket; every other descriptor is the moved catalog's.
    const [root] = produced.publication.directoryPath;
    const [movedRoot] = moved.directoryNodes;
    root!.payload.entries.forEach((entry, index) => {
      if (String(index) === bucketId) expect(entry).not.toEqual(movedRoot!.payload.entries[index]);
      else expect(entry).toEqual(movedRoot!.payload.entries[index]);
    });
  });

  it('refuses a set that names an asset of another bucket', async () => {
    const { moved, authorization, kaNumbers } = await movedCatalog();
    const added = await firstAssetOutside(kaNumbers);
    const otherBucket = ((BigInt(bucketOf(added)) + 1n) % BigInt(BUCKETS)).toString() as DecimalU64V1;

    await expect(producerOverMemoryV1().produceAndStageExactSet({
      previousHead: moved.head,
      previousDirectoryPath: moved.directoryNodes,
      previousBucket: moved.buckets.find((bucket) => bucket.payload.bucketId === otherBucket) ?? null,
      selectedBucketId: otherBucket,
      assets: [...await assetsIn(kaNumbers, otherBucket), added],
      deployment: PRODUCER_DEPLOYMENT,
      issuedAt: '1773900010000' as never,
      catalogSigner: producerSignerV1(),
      catalogIssuerAuthorization: authorization,
    })).rejects.toMatchObject({ code: 'catalog-successor-producer-binding' });
  });
});

/** A one-bucket catalog of six assets, placed one at a time, then moved to four buckets. */
async function movedCatalog() {
  const { authorization, history: genesis } = await producerGenesisV1();
  const producer = producerOverMemoryV1();
  const kaNumbers = [1, 2, 3, 4, 5, 6];
  let history: ProducerHistoryV1 = genesis;
  let bucket: SignedAuthorCatalogBucketEnvelopeV1 | null = null;
  for (let count = 1; count <= kaNumbers.length; count += 1) {
    const produced = await producer.produceAndStageExactSet({
      ...history,
      assets: await Promise.all(kaNumbers.slice(0, count).map((kaNumber) => producerAssetV1(kaNumber))),
      deployment: PRODUCER_DEPLOYMENT,
      issuedAt: String(1773900001000 + count) as never,
      catalogSigner: producerSignerV1(),
      catalogIssuerAuthorization: authorization,
    });
    bucket = produced.publication.bucket;
    history = {
      previousHead: produced.publication.head,
      previousDirectoryPath: produced.publication.directoryPath,
      previousBucket: bucket,
    };
  }
  const moved = await produceAuthorCatalogCapacityTransitionV1({
    previousHead: history.previousHead,
    bucketCount: BUCKETS,
    rows: bucket!.payload.rows,
    issuedAt: '1773900009000' as never,
    signer: producerSignerV1(),
  });
  return { moved, authorization, kaNumbers };
}

async function firstAssetOutside(kaNumbers: readonly number[]): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> {
  return producerAssetV1(Math.max(...kaNumbers) + 1);
}

async function assetsIn(kaNumbers: readonly number[], bucketId: DecimalU64V1): Promise<Rfc64PublicCatalogSuccessorAssetInputV1[]> {
  const assets = await Promise.all(kaNumbers.map((kaNumber) => producerAssetV1(kaNumber)));
  return assets.filter((asset) => bucketOf(asset) === bucketId);
}

function bucketOf(asset: Rfc64PublicCatalogSuccessorAssetInputV1): DecimalU64V1 {
  return catalogKeyToBucketIdV1(asset.seal.reservedKaId as never, BUCKETS);
}
