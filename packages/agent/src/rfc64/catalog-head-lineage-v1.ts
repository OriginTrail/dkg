// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertAuthorCatalogHeadScopeBindingV1,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

/** Maximum signed predecessor tail exposed and consumed for one head jump. */
export const RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 =
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;

export interface Rfc64CatalogHeadLineageNodeV1<T> {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly evidence: T;
}

export interface WalkRfc64BoundedCatalogHeadLineageParamsV1<T> {
  readonly target: SignedAuthorCatalogHeadEnvelopeV1;
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  readonly readPredecessor: (
    digest: Digest32V1,
    child: SignedAuthorCatalogHeadEnvelopeV1,
    index: number,
  ) => Promise<Readonly<Rfc64CatalogHeadLineageNodeV1<T>> | null>;
  /** Stop before fetching this already-known durable anchor. */
  readonly anchorHeadDigest?: Digest32V1;
  readonly maxPredecessors?: number;
}

export interface Rfc64BoundedCatalogHeadLineageV1<T> {
  readonly ancestors: readonly Readonly<Rfc64CatalogHeadLineageNodeV1<T>>[];
  readonly terminalChild: SignedAuthorCatalogHeadEnvelopeV1;
  readonly disposition: 'anchor' | 'genesis' | 'missing' | 'limit';
}

/**
 * Walk one signed predecessor chain with one shared stopping, anchoring and
 * window policy. Provider and receiver retain their own read/error/staging
 * behavior through the narrow callback and returned disposition.
 */
export async function walkRfc64BoundedCatalogHeadLineageV1<T>(
  params: WalkRfc64BoundedCatalogHeadLineageParamsV1<T>,
): Promise<Readonly<Rfc64BoundedCatalogHeadLineageV1<T>>> {
  const maxPredecessors = params.maxPredecessors
    ?? RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1;
  if (
    !Number.isSafeInteger(maxPredecessors)
    || maxPredecessors < 0
    || maxPredecessors > RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1
  ) throw new Error('catalog predecessor walk has an invalid bounded window');

  const ancestors: Readonly<Rfc64CatalogHeadLineageNodeV1<T>>[] = [];
  let child = params.target;
  for (let index = 0; index < maxPredecessors; index += 1) {
    const predecessorDigest = child.payload.previousHeadDigest;
    if (predecessorDigest === null) {
      return lineageResult(ancestors, child, 'genesis');
    }
    if (predecessorDigest === params.anchorHeadDigest) {
      return lineageResult(ancestors, child, 'anchor');
    }
    const read = await params.readPredecessor(predecessorDigest, child, index);
    if (read === null) return lineageResult(ancestors, child, 'missing');
    assertRfc64BoundedCatalogPredecessorV1(
      read.head,
      child,
      params.catalogScope,
    );
    ancestors.push(Object.freeze({ head: read.head, evidence: read.evidence }));
    child = read.head;
  }
  if (child.payload.previousHeadDigest === params.anchorHeadDigest) {
    return lineageResult(ancestors, child, 'anchor');
  }
  if (child.payload.previousHeadDigest === null) {
    return lineageResult(ancestors, child, 'genesis');
  }
  return lineageResult(ancestors, child, 'limit');
}

function lineageResult<T>(
  ancestors: readonly Readonly<Rfc64CatalogHeadLineageNodeV1<T>>[],
  terminalChild: SignedAuthorCatalogHeadEnvelopeV1,
  disposition: Rfc64BoundedCatalogHeadLineageV1<T>['disposition'],
): Readonly<Rfc64BoundedCatalogHeadLineageV1<T>> {
  return Object.freeze({
    ancestors: Object.freeze([...ancestors]),
    terminalChild,
    disposition,
  });
}

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
