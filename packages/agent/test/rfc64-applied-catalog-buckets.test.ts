/**
 * GH#3134 — reading a staged catalog head bucket by bucket, each through its verified directory
 * path: the rows of an applied head, and the predecessor of a successor in one bucket. A catalog of
 * real signed assets is placed one asset at a time in one bucket, then moved to more buckets by the
 * capacity transition producer.
 */
import { describe, expect, it } from 'vitest';

import {
  catalogKeyToBucketIdV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type DecimalU64V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  loadExactAppliedCatalogRowsV1,
  readAppliedCatalogBucketsV1,
} from '../src/rfc64/applied-catalog-authority-transition-v1.js';
import { produceAuthorCatalogCapacityTransitionV1 } from '../src/rfc64/author-catalog-capacity-transition-v1.js';
import { loadBoundedAuthorCatalogHistoryV1 } from '../src/internal/author-catalog-history.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  PRODUCER_DEPLOYMENT,
  producerAssetV1,
  producerGenesisV1,
  producerOverMemoryV1,
  producerSignerV1,
  type ProducerHistoryV1,
} from './support/rfc64-successor-producer-fixture.js';

const KA_NUMBERS = [1, 2, 3, 4, 5, 6];

describe('reading an applied catalog bucket by bucket (GH#3134)', () => {
  it('reads every row of a catalog of four buckets, each in the bucket its key names', async () => {
    const { store, scope, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '4');
    store.add(moved.stagedObjects);

    const buckets = await read(store, moved.head, scope('4'));

    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets.map((bucket) => bucket.bucketId))
      .toEqual(buckets.map((bucket) => bucket.bucketId).sort((left, right) => Number(left) - Number(right)));
    for (const bucket of buckets) {
      expect(bucket.rows.length).toBeGreaterThan(0);
      for (const row of bucket.rows) expect(catalogKeyToBucketIdV1(row.kaId, '4' as CountV1)).toBe(bucket.bucketId);
    }
    const rows = await loadExactAppliedCatalogRowsV1(store, await stored(moved.head), scope('4'), verify);
    expect(rows.map((row) => row.kaId).sort()).toEqual(oneBucket.bucket.payload.rows.map((row) => row.kaId).sort());
  });

  it('reads only the buckets it is asked for, an empty one included', async () => {
    const { store, scope, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '8');
    store.add(moved.stagedObjects);
    const held = moved.buckets[0]!.payload.bucketId;
    const empty = ['0', '1', '2', '3', '4', '5', '6', '7']
      .find((bucketId) => !moved.buckets.some((bucket) => bucket.payload.bucketId === bucketId)) as DecimalU64V1;

    const buckets = await read(store, moved.head, scope('8'), [held, empty]);

    expect(buckets.map((bucket) => bucket.bucketId)).toEqual([held, empty]);
    expect(buckets[0]!.rows).toEqual(moved.buckets[0]!.payload.rows);
    expect(buckets[1]).toMatchObject({ rows: [], descriptor: { rowCount: '0', byteLength: '0' } });
  });

  it('reads a catalog whose directory has two levels', async () => {
    const { store, scope, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '512');
    store.add(moved.stagedObjects);
    expect(moved.head.payload.directoryHeight).toBe('1');

    const buckets = await read(store, moved.head, scope('512'));

    expect(buckets.flatMap((bucket) => bucket.rows).length).toBe(KA_NUMBERS.length);
  });

  it('reads a one-bucket catalog as one bucket', async () => {
    const { store, scope, oneBucket } = await catalog();

    const buckets = await read(store, oneBucket.head, scope('1'));

    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.rows).toEqual(oneBucket.bucket.payload.rows);
  });

  it('refuses a head whose bucket is not staged', async () => {
    const { store, scope, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '4');
    store.add(moved.stagedObjects.filter((object) => object !== moved.buckets[0]));

    await expect(read(store, moved.head, scope('4'))).rejects.toThrow('catalog bucket is not staged');
  });
});

describe('loading the predecessor of a successor in one bucket (GH#3134)', () => {
  it('loads the root and the one bucket of a one-bucket catalog', async () => {
    const { store, oneBucket } = await catalog();

    const history = await loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(oneBucket.head));

    expect(history.previousHead).toEqual(oneBucket.head);
    expect(history.previousDirectoryPath.map((node) => node.objectDigest))
      .toEqual([oneBucket.head.payload.directoryRootDigest]);
    expect(history.previousBucket).toEqual(oneBucket.bucket);
  });

  it('loads the bucket it is asked for, or none for an empty one, in a catalog of eight buckets', async () => {
    const { store, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '8');
    store.add(moved.stagedObjects);
    const held = moved.buckets[0]!;
    const empty = ['0', '1', '2', '3', '4', '5', '6', '7']
      .find((bucketId) => !moved.buckets.some((bucket) => bucket.payload.bucketId === bucketId)) as DecimalU64V1;

    const loaded = await loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(moved.head), held.payload.bucketId);
    const none = await loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(moved.head), empty);

    expect(loaded.previousBucket).toEqual(held);
    expect(none.previousBucket).toBeNull();
    expect(none.previousDirectoryPath).toEqual(loaded.previousDirectoryPath);
  });

  it('walks a two-level directory to the leaf over the bucket', async () => {
    const { store, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '512');
    store.add(moved.stagedObjects);
    const last = moved.buckets.at(-1)!;

    const history = await loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(moved.head), last.payload.bucketId);

    expect(history.previousDirectoryPath.map((node) => node.payload.level)).toEqual(['1', '0']);
    expect(BigInt(history.previousDirectoryPath[1]!.payload.firstBucketId))
      .toBe((BigInt(last.payload.bucketId) / 256n) * 256n);
    expect(history.previousBucket).toEqual(last);
  });

  it('refuses a bucket outside the catalog and a directory node missing from the store', async () => {
    const { store, oneBucket } = await catalog();
    const moved = await moveTo(oneBucket, '512');
    store.add(moved.stagedObjects.filter((object) => object !== moved.directoryNodes[1]));

    await expect(loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(moved.head), '512' as DecimalU64V1))
      .rejects.toThrow('RFC-64 selected bucket is outside the predecessor catalog');
    await expect(loadBoundedAuthorCatalogHistoryV1(persistence(store), ref(moved.head), '0' as DecimalU64V1))
      .rejects.toThrow('RFC-64 predecessor directory node is not staged');
  });
});

const verify = (envelope: SignedControlEnvelopeV1) => verifyControlEnvelopeIssuerSignatureV1(envelope);

/** Six assets placed one at a time in a one-bucket catalog, every object staged in a memory store. */
async function catalog() {
  const { scope: oneBucketScope, authorization, history: genesis } = await producerGenesisV1();
  const store = memoryControlObjects();
  store.add([authorization.catalogIssuerDelegation as SignedControlEnvelopeV1, genesis.previousHead, ...genesis.previousDirectoryPath]);
  const producer = producerOverMemoryV1();
  let history: ProducerHistoryV1 = genesis;
  let bucket: SignedAuthorCatalogBucketEnvelopeV1 | null = null;
  for (let count = 1; count <= KA_NUMBERS.length; count += 1) {
    const produced = await producer.produceAndStageExactSet({
      ...history,
      assets: await Promise.all(KA_NUMBERS.slice(0, count).map((kaNumber) => producerAssetV1(kaNumber))),
      deployment: PRODUCER_DEPLOYMENT,
      issuedAt: String(1773900001000 + count) as never,
      catalogSigner: producerSignerV1(),
      catalogIssuerAuthorization: authorization,
    });
    store.add(produced.publication.stagedObjects);
    bucket = produced.publication.bucket;
    history = {
      previousHead: produced.publication.head,
      previousDirectoryPath: produced.publication.directoryPath,
      previousBucket: bucket,
    };
  }
  const scope = (bucketCount: string): AuthorCatalogScopeV1 => ({ ...oneBucketScope, bucketCount }) as AuthorCatalogScopeV1;
  return { store, scope, oneBucket: { head: history.previousHead, bucket: bucket! } };
}

function moveTo(
  oneBucket: { head: SignedAuthorCatalogHeadEnvelopeV1; bucket: SignedAuthorCatalogBucketEnvelopeV1 },
  bucketCount: string,
) {
  return produceAuthorCatalogCapacityTransitionV1({
    previousHead: oneBucket.head,
    bucketCount: bucketCount as CountV1,
    rows: oneBucket.bucket.payload.rows,
    issuedAt: '1773900009000' as never,
    signer: producerSignerV1(),
  });
}

function read(
  store: ReturnType<typeof memoryControlObjects>,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  scope: AuthorCatalogScopeV1,
  bucketIds?: readonly DecimalU64V1[],
) {
  return stored(head).then((storedHead) => readAppliedCatalogBucketsV1(store, storedHead, scope, verify, bucketIds));
}

async function stored(head: SignedAuthorCatalogHeadEnvelopeV1) {
  return { envelope: head, issuerSignature: await verify(head) };
}

/** Objects by digest; a read verifies the issuer signature as the durable store does. */
function memoryControlObjects() {
  const objects = new Map<string, SignedControlEnvelopeV1>();
  return {
    add(envelopes: readonly SignedControlEnvelopeV1[]): void {
      for (const envelope of envelopes) objects.set(envelope.objectDigest, envelope);
    },
    async getVerifiedObjectByDigest(input: Readonly<{
      objectDigest: string;
      verifyIssuerSignature: typeof verify;
    }>) {
      const envelope = objects.get(input.objectDigest);
      if (envelope === undefined) return null;
      return { envelope, issuerSignature: await input.verifyIssuerSignature(envelope) };
    },
    getVerifiedObject(input: Readonly<{
      objectDigest: string;
      signatureVariantDigest: string;
      verifyIssuerSignature: typeof verify;
    }>) {
      return this.getVerifiedObjectByDigest(input);
    },
  };
}

function persistence(store: ReturnType<typeof memoryControlObjects>): Rfc64PersistenceV1 {
  return { controlObjects: store } as unknown as Rfc64PersistenceV1;
}

function ref(head: SignedAuthorCatalogHeadEnvelopeV1) {
  return { objectDigest: head.objectDigest, signatureVariantDigest: head.objectDigest };
}
