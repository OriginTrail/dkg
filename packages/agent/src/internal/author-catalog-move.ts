// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { readAppliedCatalogBucketsV1 } from '../rfc64/applied-catalog-authority-transition-v1.js';
import { computeRfc64CatalogAppliedInventoryDigestV1 } from '../rfc64/applied-catalog-inventory-digest-v1.js';
import {
  chooseAuthorCatalogBucketCountV1,
  produceAuthorCatalogCapacityTransitionV1,
  type ProducedAuthorCatalogV1,
} from '../rfc64/author-catalog-capacity-transition-v1.js';
import type { Rfc64AuthorCatalogEip191SignerV1 } from '../rfc64/author-catalog-producer.js';
import type { AppliedCatalogHeadSnapshotV1 } from '../rfc64/inventory-v1/index.js';
import type { Rfc64PersistenceV1 } from '../rfc64/persistence-v1.js';

/** The control store stages at most this many objects in one call. */
const STAGED_OBJECTS_PER_CALL_V1 = 16;

export interface MovedAuthorCatalogV1 {
  /** The lane at its new bucket count. */
  readonly scope: Readonly<AuthorCatalogScopeV1>;
  /** The applied-head record of the new scope. */
  readonly applied: AppliedCatalogHeadSnapshotV1;
  readonly produced: ProducedAuthorCatalogV1;
}

/**
 * GH#3134 — move the applied catalog of `scope` to more buckets. Every row of its applied head is
 * read bucket by bucket, without bundles, and spread over the bucket count the transition producer
 * chooses; the objects are staged, buckets first and the head last, and the head is applied as the
 * first head of the larger scope. The applied head of `scope` stays as it is: the author keeps
 * serving it to nodes that read only one-bucket catalogs. Runs under the lane's mutation lock; a
 * crash before the applied-head CAS leaves only staged objects that nothing names.
 */
export async function moveAuthorCatalogToMoreBucketsV1(input: Readonly<{
  persistence: Rfc64PersistenceV1;
  scope: Readonly<AuthorCatalogScopeV1>;
  applied: AppliedCatalogHeadSnapshotV1;
  signer: Rfc64AuthorCatalogEip191SignerV1;
  issuedAt: TimestampMsV1;
  stageOnly: boolean;
}>): Promise<MovedAuthorCatalogV1> {
  const { persistence, scope, applied } = input;
  const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
    objectDigest: applied.currentCatalogHeadDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) throw new Error('RFC-64 applied author head is not durably staged');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const buckets = await readAppliedCatalogBucketsV1(
    persistence.controlObjects,
    storedHead,
    scope,
    verifyControlEnvelopeIssuerSignatureV1,
  );
  const rows = buckets.flatMap((bucket) => bucket.rows);
  const produced = await produceAuthorCatalogCapacityTransitionV1({
    previousHead: storedHead.envelope,
    bucketCount: chooseAuthorCatalogBucketCountV1(rows, scope.bucketCount),
    rows,
    issuedAt: input.issuedAt,
    signer: input.signer,
  });
  for (let index = 0; index < produced.stagedObjects.length; index += STAGED_OBJECTS_PER_CALL_V1) {
    await persistence.controlObjects.stageVerifiedObjects(await Promise.all(
      produced.stagedObjects.slice(index, index + STAGED_OBJECTS_PER_CALL_V1).map(async (envelope) => ({
        envelope,
        issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
      })),
    ));
  }
  const moved = Object.freeze({ ...scope, bucketCount: produced.head.payload.bucketCount });
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(moved);
  const { snapshot } = persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
    catalogScopeDigest,
    authorAddress: scope.authorAddress,
    currentCatalogHeadDigest: produced.head.objectDigest as Digest32V1,
    appliedInventoryDigest: computeRfc64CatalogAppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
      directory: produced.head.payload,
    }),
    catalogVersion: produced.head.payload.version,
    inventoryRowCount: produced.head.payload.totalRows,
    expectedCurrentCatalogHeadDigest: null,
    stageOnly: input.stageOnly,
  });
  return Object.freeze({ scope: moved, applied: snapshot, produced });
}
