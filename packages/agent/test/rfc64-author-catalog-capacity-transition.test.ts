/**
 * GH#3134 — moving an author catalog to a larger bucket count, and building a large catalog in one
 * step. The rows are synthetic but canonical and bound to the author; every produced object is
 * signed and checked against the head through the core's directory path verification.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertAuthorCatalogRowV1,
  catalogKeyToBucketIdV1,
  computeAuthorCatalogScopeDigestV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  Rfc64AuthorCatalogProductionErrorV1,
  produceSparseAuthorCatalogSuccessorV1,
  type Rfc64AuthorCatalogEip191SignerV1,
} from '../src/rfc64/author-catalog-producer.js';
import {
  AUTHOR_CATALOG_TRANSITION_FILL_ROWS_V1,
  chooseAuthorCatalogBucketCountV1,
  produceAuthorCatalogCapacityTransitionV1,
  produceAuthorCatalogInOneStepV1,
  type ProducedAuthorCatalogV1,
} from '../src/rfc64/author-catalog-capacity-transition-v1.js';

const wallet = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const AUTHOR = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a' as EvmAddressV1;
const DELEGATION_DIGEST = `0x${'66'.repeat(32)}` as Digest32V1;
const SEAL_DIGEST = `0x${'44'.repeat(32)}` as Digest32V1;
const signer: Rfc64AuthorCatalogEip191SignerV1 = {
  issuer: wallet.address.toLowerCase() as EvmAddressV1,
  signDigest: (digest) => wallet.signMessage(digest),
};

describe('author catalog capacity transition (GH#3134)', () => {
  it('moves a full one-bucket catalog to the bucket count it chooses, with every row and a path to each bucket', async () => {
    const full = await oneStep('1', rows(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1));
    expect(full.head.payload).toMatchObject({ bucketCount: '1', totalRows: '1024', version: '0' });
    const next = rows(1, MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1);
    const all = [...rows(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1), ...next];

    const bucketCount = chooseAuthorCatalogBucketCountV1(all, '1' as CountV1);
    const moved = await produceAuthorCatalogCapacityTransitionV1({
      previousHead: full.head,
      bucketCount,
      rows: all,
      issuedAt: '1700000000001' as TimestampMsV1,
      signer,
    });

    expect(moved.head.payload).toMatchObject({
      bucketCount,
      totalRows: '1025',
      version: '1',
      previousHeadDigest: full.head.objectDigest,
      era: '0',
      directoryHeight: '0',
      catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    });
    expect(BigInt(bucketCount)).toBeGreaterThan(1n);
    expect(Math.max(...moved.buckets.map((bucket) => bucket.payload.rows.length)))
      .toBeLessThanOrEqual(AUTHOR_CATALOG_TRANSITION_FILL_ROWS_V1);
    expectComplete(moved, all);
    await expectSigned(moved);
  });

  it('builds a catalog with a two-level directory, each bucket reachable from the root', async () => {
    const built = await oneStep('512', rows(600));
    expect(built.head.payload).toMatchObject({ bucketCount: '512', directoryHeight: '1', totalRows: '600' });
    // The root covers two level-0 nodes of 256 buckets each.
    const [root, ...leaves] = built.directoryNodes;
    expect(root!.payload).toMatchObject({ level: '1', firstBucketId: '0' });
    expect(root!.payload.entries).toHaveLength(2);
    expect(leaves.map((node) => node.payload.firstBucketId)).toEqual(['0', '256']);
    expectComplete(built, rows(600));
  });

  it('lets an ordinary successor change one row in one bucket of the moved catalog', async () => {
    const full = await oneStep('1', rows(64));
    const moved = await produceAuthorCatalogCapacityTransitionV1({
      previousHead: full.head,
      bucketCount: '8' as CountV1,
      rows: rows(64),
      issuedAt: '1700000000001' as TimestampMsV1,
      signer,
    });
    const added = rows(1, 64)[0]!;
    const bucketId = catalogKeyToBucketIdV1(added.kaId, '8' as CountV1);
    const bucket = moved.buckets.find((candidate) => candidate.payload.bucketId === bucketId) ?? null;

    const successor = await produceSparseAuthorCatalogSuccessorV1({
      previousHead: moved.head,
      previousDirectoryPath: pathTo(moved, bucketId),
      previousBucket: bucket,
      selectedBucketId: bucketId,
      nextRows: [...(bucket?.payload.rows ?? []), added]
        .sort((left, right) => (BigInt(left.kaId) < BigInt(right.kaId) ? -1 : 1)),
      issuedAt: '1700000000002' as TimestampMsV1,
      signer,
    });

    expect(successor.head.payload).toMatchObject({
      bucketCount: '8',
      totalRows: '65',
      version: '2',
      previousHeadDigest: moved.head.objectDigest,
    });
    // Only the changed bucket and its one directory node are new objects.
    expect(successor.stagedObjects).toHaveLength(3);
  });

  it('refuses what is not a move to more capacity', async () => {
    const full = await oneStep('2', rows(20));
    const move = (bucketCount: string, catalogRows: readonly AuthorCatalogRowV1[]) =>
      produceAuthorCatalogCapacityTransitionV1({
        previousHead: full.head,
        bucketCount: bucketCount as CountV1,
        rows: catalogRows,
        issuedAt: '1700000000001' as TimestampMsV1,
        signer,
      });
    await expect(move('2', rows(20))).rejects.toMatchObject({ code: 'catalog-production-history' });
    await expect(move('3', rows(20))).rejects.toMatchObject({ code: 'catalog-production-input' });
    await expect(move('4', rows(19))).rejects.toMatchObject({ code: 'catalog-production-delta' });
    await expect(move('4', [...rows(20), rows(20)[0]!])).rejects.toBeInstanceOf(Rfc64AuthorCatalogProductionErrorV1);
  });

  it('refuses a bucket count at which one bucket would hold more than a bucket can', async () => {
    await expect(oneStep('1', rows(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 + 1)))
      .rejects.toThrow(/above 1024: choose a larger bucket count/);
  });
});

async function oneStep(bucketCount: string, catalogRows: readonly AuthorCatalogRowV1[]): Promise<ProducedAuthorCatalogV1> {
  return produceAuthorCatalogInOneStepV1({
    scope: scope(bucketCount),
    catalogIssuerDelegationDigest: DELEGATION_DIGEST,
    rows: catalogRows,
    issuedAt: '1700000000000' as TimestampMsV1,
    signer,
  });
}

/** Every input row is in exactly one bucket, the one its key names, and that bucket verifies under the head. */
function expectComplete(produced: ProducedAuthorCatalogV1, expected: readonly AuthorCatalogRowV1[]): void {
  const held = produced.buckets.flatMap((bucket) => bucket.payload.rows.map((row) => row.kaId));
  expect(held.slice().sort()).toEqual(expected.map((row) => row.kaId).sort());
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope(produced.head.payload.bucketCount));
  for (const bucket of produced.buckets) {
    expect(bucket.payload.catalogScopeDigest).toBe(scopeDigest);
    for (const row of bucket.payload.rows) {
      expect(catalogKeyToBucketIdV1(row.kaId, produced.head.payload.bucketCount)).toBe(bucket.payload.bucketId);
    }
    const verified = verifyAuthorCatalogDirectoryPathV1(produced.head, pathTo(produced, bucket.payload.bucketId), bucket.payload.bucketId);
    expect(readVerifiedAuthorCatalogBucketDescriptorV1(verified, produced.head).bucketDigest).toBe(bucket.objectDigest);
  }
  // Staged before they are named: buckets, then directory nodes from the leaves up, then the head.
  expect(produced.stagedObjects.at(-1)).toBe(produced.head);
  expect(produced.stagedObjects.slice(0, produced.buckets.length)).toEqual(produced.buckets);
}

async function expectSigned(produced: ProducedAuthorCatalogV1): Promise<void> {
  for (const object of produced.stagedObjects) await verifyControlEnvelopeIssuerSignatureV1(object);
}

function pathTo(produced: ProducedAuthorCatalogV1, bucketId: DecimalU64V1): SignedAuthorCatalogDirectoryNodeEnvelopeV1[] {
  const height = Number(produced.head.payload.directoryHeight);
  const path: SignedAuthorCatalogDirectoryNodeEnvelopeV1[] = [];
  for (let level = height; level >= 0; level -= 1) {
    const span = 256n ** BigInt(level + 1);
    const first = (BigInt(bucketId) / span) * span;
    path.push(produced.directoryNodes.find((node) => (
      node.payload.level === level.toString() && node.payload.firstBucketId === first.toString()
    ))!);
  }
  return path;
}

function scope(bucketCount: string): AuthorCatalogScopeV1 {
  return {
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/catalog-capacity',
    governanceChainId: '20430',
    governanceContractAddress: '0x2222222222222222222222222222222222222222',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: '0',
    bucketCount,
  } as AuthorCatalogScopeV1;
}

function rows(count: number, start = 0): AuthorCatalogRowV1[] {
  return Array.from({ length: count }, (_value, index) => row(BigInt(start + index + 1)));
}

function row(number: bigint): AuthorCatalogRowV1 {
  const projectionDigest = digest(number, 1);
  const candidate = {
    kaId: ((BigInt(AUTHOR) << 96n) | number).toString(),
    assertionCoordinate: `asset-${number}`,
    assertionVersion: '1',
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest,
    sealDigest: SEAL_DIGEST,
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest,
      byteLength: '16',
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: '1',
      blobDigest: digest(number, 2),
      chunkTreeRoot: digest(number, 3),
    },
  } as unknown as AuthorCatalogRowV1;
  assertAuthorCatalogRowV1(candidate);
  return candidate;
}

function digest(number: bigint, variant: number): Digest32V1 {
  return ethers.keccak256(ethers.toUtf8Bytes(`${variant}:${number}`)) as Digest32V1;
}
