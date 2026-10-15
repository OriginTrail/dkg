// SPDX-License-Identifier: Apache-2.0

import {
  AUTHOR_CATALOG_DIRECTORY_FANOUT_V1,
  ZERO_DIGEST32_V1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type DecimalU64V1,
  type Digest32V1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import type { Rfc64PersistenceV1 } from '../rfc64/persistence-v1.js';

/** What a successor in one bucket is produced from. */
export interface BoundedAuthorCatalogHistoryV1 {
  readonly previousHead: SignedAuthorCatalogHeadEnvelopeV1;
  /** Root to leaf, over the selected bucket. */
  readonly previousDirectoryPath: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  /** The selected bucket's object; null when its descriptor is empty. */
  readonly previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
}

/**
 * The predecessor of a successor in `selectedBucketId` (GH#3134): the staged head, the directory
 * path from its root to that bucket and the bucket itself, read from the durable store and checked
 * against the head. Only one bucket is read, whatever the catalog's size; a one-bucket catalog
 * reads its root and its one bucket, as it always did.
 */
export async function loadBoundedAuthorCatalogHistoryV1(
  persistence: Rfc64PersistenceV1,
  ref: Readonly<{ objectDigest: Digest32V1; signatureVariantDigest: Digest32V1 }>,
  selectedBucketId: DecimalU64V1 = '0' as DecimalU64V1,
): Promise<BoundedAuthorCatalogHistoryV1> {
  const storedHead = await persistence.controlObjects.getVerifiedObject({
    objectDigest: ref.objectDigest,
    signatureVariantDigest: ref.signatureVariantDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) throw new Error('RFC-64 predecessor head is not durably staged');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const previousHead = storedHead.envelope;
  const { bucketCount, directoryHeight, directoryRootDigest, totalRows } = previousHead.payload;
  if (BigInt(selectedBucketId) >= BigInt(bucketCount)) {
    throw new Error('RFC-64 selected bucket is outside the predecessor catalog');
  }

  const path: SignedAuthorCatalogDirectoryNodeEnvelopeV1[] = [];
  let nodeDigest = directoryRootDigest;
  for (let level = BigInt(directoryHeight); level >= 0n; level -= 1n) {
    const storedNode = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: nodeDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedNode === null) {
      throw new Error(path.length === 0
        ? 'RFC-64 predecessor directory root is not staged'
        : 'RFC-64 predecessor directory node is not staged');
    }
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(storedNode.envelope, bucketCount);
    const node = storedNode.envelope;
    path.push(node);
    if (level === 0n) break;
    const entry = node.payload.entries[Number(
      (BigInt(selectedBucketId) - BigInt(node.payload.firstBucketId))
        / AUTHOR_CATALOG_DIRECTORY_FANOUT_V1 ** level,
    )];
    if (entry === undefined || !('childDigest' in entry)) {
      throw new Error('RFC-64 predecessor directory has no child over the selected bucket');
    }
    nodeDigest = entry.childDigest;
  }
  let rootRows = 0n;
  for (const entry of path[0]!.payload.entries) rootRows += BigInt(entry.rowCount);
  if (rootRows.toString() !== totalRows) {
    throw new Error('RFC-64 predecessor root row count does not match its head');
  }
  const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
    verifyAuthorCatalogDirectoryPathV1(previousHead, path, selectedBucketId),
    previousHead,
  );
  if ((descriptor.rowCount === '0') !== (descriptor.bucketDigest === ZERO_DIGEST32_V1)) {
    throw new Error('RFC-64 predecessor empty-bucket descriptor is inconsistent');
  }

  let previousBucket: SignedAuthorCatalogBucketEnvelopeV1 | null = null;
  if (descriptor.bucketDigest !== ZERO_DIGEST32_V1) {
    const storedBucket = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: descriptor.bucketDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedBucket === null) throw new Error('RFC-64 predecessor bucket is not staged');
    assertSignedAuthorCatalogBucketEnvelopeV1(storedBucket.envelope);
    previousBucket = storedBucket.envelope;
    if (previousBucket.payload.rows.length.toString() !== descriptor.rowCount) {
      throw new Error('RFC-64 predecessor bucket row count does not match its head');
    }
  }
  return Object.freeze({
    previousHead,
    previousDirectoryPath: Object.freeze(path),
    previousBucket,
  });
}
