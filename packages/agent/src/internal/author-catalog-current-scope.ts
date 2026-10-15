// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64InventoryV1OperationsV1 } from '../rfc64/inventory-v1/index.js';

/** Bucket counts probed for an author's current catalog, largest first: 2^16 down to 2. */
const PROBED_CATALOG_BUCKET_COUNTS_V1 = Object.freeze(
  Array.from({ length: 16 }, (_, index) => (1n << BigInt(16 - index)).toString(10)),
);

/**
 * GH#3134 — the author's current catalog scope of a lane: the bucket count of the lane's newest
 * applied head. A catalog only moves to more buckets, and the author keeps the old head to serve,
 * so the largest count that has an applied head is the current one. With none it is one bucket.
 */
export function readCurrentAuthorCatalogScopeV1(
  inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>,
  lane: Readonly<Omit<AuthorCatalogScopeV1, 'bucketCount'>>,
): Readonly<AuthorCatalogScopeV1> {
  for (const bucketCount of PROBED_CATALOG_BUCKET_COUNTS_V1) {
    const scope = Object.freeze({ ...lane, bucketCount }) as AuthorCatalogScopeV1;
    const applied = inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(scope),
      lane.authorAddress,
    );
    if (applied !== null) return scope;
  }
  return Object.freeze({ ...lane, bucketCount: '1' }) as AuthorCatalogScopeV1;
}
