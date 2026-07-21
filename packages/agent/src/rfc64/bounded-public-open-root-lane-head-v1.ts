// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical shape shared by the bounded RFC-64 public/open root-lane adapters.
 *
 * This boundary deliberately does not assert the complete signed envelope or
 * policy scope: those checks remain owned by the caller's verified-object and
 * trusted-policy boundaries. It only centralizes the lane shape and the safe
 * numeric conversion that receiver, producer, reconciler, and durable-history
 * loading must agree on.
 */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertCanonicalDecimalU64,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

export interface BoundedPublicOpenRootLaneHeadOptionsV1 {
  /** Whether a head claiming genesis history is accepted by this caller. */
  readonly allowGenesis: boolean;
}

export interface BoundedPublicOpenRootLaneHeadV1 {
  /** Safe numeric form of the canonical, bounded totalRows scalar. */
  readonly rowCount: number;
  /** True when either canonical history marker claims the genesis branch. */
  readonly isGenesis: boolean;
}

/**
 * Read the common bounded public/open root-lane invariant from a verified head.
 *
 * A zero-row non-genesis head remains valid here because durable predecessor
 * history can represent a successor that removed its final row. Callers whose
 * active successor slice requires at least one row retain that narrower check.
 */
export function readBoundedPublicOpenRootLaneHeadV1(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  options: BoundedPublicOpenRootLaneHeadOptionsV1,
): Readonly<BoundedPublicOpenRootLaneHeadV1> {
  if (typeof options?.allowGenesis !== 'boolean') {
    throw new TypeError('bounded public/open root-lane allowGenesis policy is required');
  }
  if (
    head.payload.subGraphName !== null
    || head.payload.bucketCount !== '1'
    || head.payload.directoryHeight !== '0'
  ) {
    throw new RangeError(
      'catalog head is outside the public/open root lane with one level-zero bucket',
    );
  }

  try {
    assertCanonicalDecimalU64(head.payload.totalRows, 'catalog head totalRows');
  } catch (cause) {
    throw new RangeError('catalog head totalRows is not a canonical decimal u64', {
      cause,
    });
  }
  const rowCount = Number(head.payload.totalRows);
  if (
    !Number.isSafeInteger(rowCount)
    || rowCount < 0
    || rowCount > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
  ) {
    throw new RangeError(
      `catalog head totalRows is outside 0..${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1}`,
    );
  }

  // Preserve the receiver's existing fail-closed classification: either marker
  // routes the head through the canonical genesis assertion instead of letting
  // a partial genesis claim enter the successor path.
  const isGenesis = head.payload.version === '0'
    || head.payload.previousHeadDigest === null;
  if (isGenesis && !options.allowGenesis) {
    throw new RangeError('bounded public/open root-lane caller does not allow genesis');
  }

  return Object.freeze({ rowCount, isGenesis });
}
