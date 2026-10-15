// SPDX-License-Identifier: Apache-2.0

/** The exact-set plan of a catalog mutation: what the next one-KA successor changes. */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64CatalogSuccessorAssetInputV1 } from '../dkg-agent-rfc64-catalog.js';
import {
  compareRfc64PublicCatalogSuccessorAssetsByKaIdV1,
  snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1,
} from '../rfc64/public-catalog-successor-asset-v1.js';
import {
  AuthorCatalogFullErrorV1,
  assertAuthorCatalogTakesNewRowsV1,
} from './author-catalog-capacity.js';

export type Rfc64CatalogProjectionTargetPolicyV1 =
  | 'exact-replacement'
  | 'monotonic-union';

export function assertReplacementHistoryIsContiguousV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): void {
  const currentByKaId = new Map(current.map((asset) => [asset.seal.reservedKaId, asset]));
  for (const targetAsset of target) {
    const currentAsset = currentByKaId.get(targetAsset.seal.reservedKaId);
    if (currentAsset === undefined || sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) continue;
    const currentVersion = BigInt(currentAsset.seal.assertionVersion);
    const targetVersion = BigInt(targetAsset.seal.assertionVersion);
    if (
      currentAsset.assertionCoordinate !== targetAsset.assertionCoordinate
      || targetVersion <= currentVersion
    ) {
      throw new Error(
        `RFC-64 exact-set replacement for KA ${targetAsset.seal.reservedKaId} is not a newer assertion version on the same coordinate`,
      );
    }
  }
}

/** Build the explicit projection target before entering the mutation engine. */
export function planRfc64CatalogProjectionTargetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  requested: readonly Rfc64CatalogSuccessorAssetInputV1[],
  policy: Rfc64CatalogProjectionTargetPolicyV1,
): readonly Rfc64CatalogSuccessorAssetInputV1[] {
  if (policy === 'exact-replacement') return requested;
  const retained = current.filter((existing) => !requested.some(
    (candidate) => candidate.seal.reservedKaId === existing.seal.reservedKaId,
  ));
  // GH#3134 — requested rows the catalog does not hold are new; the others replace their rows.
  assertAuthorCatalogTakesNewRowsV1(current, retained.length + requested.length - current.length);
  return snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
    [...retained, ...requested],
    'RFC-64 monotonic-union target assets',
  );
}

export function planNextRfc64CatalogExactSetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): Rfc64CatalogSuccessorAssetInputV1[] {
  let currentIndex = 0;
  let targetIndex = 0;
  while (currentIndex < current.length || targetIndex < target.length) {
    const currentAsset = current[currentIndex];
    const targetAsset = target[targetIndex];
    if (currentAsset === undefined) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset!);
    }
    if (targetAsset === undefined) {
      return current.filter((_, index) => index !== currentIndex);
    }
    const comparison = compareRfc64CatalogAssetsByKaIdV1(currentAsset, targetAsset);
    if (comparison < 0) return current.filter((_, index) => index !== currentIndex);
    if (comparison > 0) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset);
    }
    if (!sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) {
      if (
        BigInt(targetAsset.seal.assertionVersion)
          > BigInt(currentAsset.seal.assertionVersion) + 1n
      ) {
        // A durable inventory can advance more than once while catalog
        // projection is unavailable. Remove the stale row first, then insert
        // the independently verified latest row on the following successor.
        return current.filter((_, index) => index !== currentIndex);
      }
      const next = [...current];
      next[currentIndex] = targetAsset;
      return next;
    }
    currentIndex += 1;
    targetIndex += 1;
  }
  throw new Error('RFC-64 exact-set planner was called for an already-converged target');
}

function insertOrFreeRfc64CatalogCapacityV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  if (current.length < MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    return insertRfc64CatalogAssetV1(current, asset);
  }
  const targetKaIds = new Set(target.map((targetAsset) => targetAsset.seal.reservedKaId));
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!targetKaIds.has(current[index]!.seal.reservedKaId)) {
      return current.filter((_currentAsset, currentIndex) => currentIndex !== index);
    }
  }
  throw new AuthorCatalogFullErrorV1(current, 1);
}

function insertRfc64CatalogAssetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  const next = [...current, asset];
  next.sort((left, right) => compareRfc64CatalogAssetsByKaIdV1(left, right));
  return next;
}

function compareRfc64CatalogAssetsByKaIdV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): -1 | 0 | 1 {
  return compareRfc64PublicCatalogSuccessorAssetsByKaIdV1(left, right);
}

export function sameRfc64SuccessorAssetSetsV1(
  left: readonly Rfc64CatalogSuccessorAssetInputV1[],
  right: readonly Rfc64CatalogSuccessorAssetInputV1[],
): boolean {
  return left.length === right.length
    && left.every((asset, index) => sameRfc64SuccessorAssetV1(asset, right[index]!));
}

export function sameRfc64SuccessorAssetV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): boolean {
  return left.assertionCoordinate === right.assertionCoordinate
    && canonicalizeCanonicalGraphScopedAuthorSealV1(left.seal)
      === canonicalizeCanonicalGraphScopedAuthorSealV1(right.seal)
    && equalBytes(left.projectionBytes, right.projectionBytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((byte, index) => byte === right[index]);
}
