// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
} from '@origintrail-official/dkg-core';

import { MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1 } from '../rfc64/author-catalog-capacity-transition-v1.js';
import type { Rfc64InventoryV1OperationsV1 } from '../rfc64/inventory-v1/index.js';

/** Every bucket count a catalog can be moved to, largest first. */
const BUCKET_COUNTS_LARGEST_FIRST_V1: readonly CountV1[] = Object.freeze(((): CountV1[] => {
  const counts: CountV1[] = [];
  for (let count = MAX_AUTHOR_CATALOG_CHOSEN_BUCKET_COUNT_V1; count > 1n; count /= 2n) {
    counts.push(count.toString() as CountV1);
  }
  return counts;
})());

/**
 * GH#3134 — the author's catalog scope for an author lane: the lane with the bucket count of its
 * newest applied head, or one bucket when no larger count is applied.
 *
 * The bucket count is part of the scope, and a move only ever raises it. After a move the author
 * keeps the old scope's last head to serve to nodes that read only one-bucket catalogs, so a lane
 * can have an applied head at more than one count: the largest is the current one. `lane` may name
 * any bucket count; only its other fields are read. A lookup is a primary-key read per count.
 */
export function readCurrentAuthorCatalogScopeV1(
  inventory: Pick<Rfc64InventoryV1OperationsV1, 'readAppliedCatalogHeadV1'>,
  lane: Readonly<AuthorCatalogScopeV1>,
): Readonly<AuthorCatalogScopeV1> {
  for (const bucketCount of BUCKET_COUNTS_LARGEST_FIRST_V1) {
    const scope = Object.freeze({ ...lane, bucketCount });
    const applied = inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(scope),
      lane.authorAddress,
    );
    if (applied !== null) return scope;
  }
  return lane.bucketCount === '1' ? lane : Object.freeze({ ...lane, bucketCount: '1' as CountV1 });
}
