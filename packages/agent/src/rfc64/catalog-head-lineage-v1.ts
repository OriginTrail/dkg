// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertAuthorCatalogHeadScopeBindingV1,
  type AuthorCatalogScopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

/** Maximum signed predecessor tail exposed and consumed for one head jump. */
export const RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 =
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;

/**
 * Canonical invariant for one bounded signed predecessor link.
 *
 * Fetching, signature verification, capability exposure, staging, and error
 * translation remain with their respective owners. This pure assertion keeps
 * the provider and receiver on one protocol definition of contiguous lineage.
 */
export function assertRfc64BoundedCatalogPredecessorV1(
  predecessor: SignedAuthorCatalogHeadEnvelopeV1,
  child: SignedAuthorCatalogHeadEnvelopeV1,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
): void {
  assertAuthorCatalogHeadScopeBindingV1(predecessor.payload, catalogScope);
  const totalRows = Number(BigInt(predecessor.payload.totalRows));
  if (
    child.payload.previousHeadDigest !== predecessor.objectDigest
    || predecessor.issuer !== child.issuer
    || predecessor.payload.catalogIssuerDelegationDigest
      !== child.payload.catalogIssuerDelegationDigest
    || BigInt(predecessor.payload.version) + 1n !== BigInt(child.payload.version)
    || BigInt(predecessor.payload.issuedAt) > BigInt(child.payload.issuedAt)
    || predecessor.payload.bucketCount !== '1'
    || predecessor.payload.directoryHeight !== '0'
    || !Number.isSafeInteger(totalRows)
    || totalRows < 0
    || totalRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
    || (
      predecessor.payload.version === '0'
      && predecessor.payload.previousHeadDigest !== null
    )
    || (
      predecessor.payload.version !== '0'
      && predecessor.payload.previousHeadDigest === null
    )
  ) {
    throw new Error('catalog predecessor is not one contiguous bounded signed head');
  }
}
