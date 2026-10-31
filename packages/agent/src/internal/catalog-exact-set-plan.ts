// SPDX-License-Identifier: Apache-2.0
import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';
import type { Rfc64CatalogSuccessorAssetInputV1 } from '../dkg-agent-rfc64-catalog.js';
import { compareRfc64PublicCatalogSuccessorAssetsByKaIdV1 } from '../rfc64/public-catalog-successor-asset-v1.js';
import { AuthorCatalogFullErrorV1 } from './author-catalog-capacity.js';
import { sameRfc64SuccessorAssetV1 } from './catalog-asset-revision.js';

/** One planned KA delta, including the final replacement omitted by a withdrawal. */
export interface Rfc64CatalogTransitionV1 {
  readonly nextAssets: Rfc64CatalogSuccessorAssetInputV1[];
  readonly currentAsset: Rfc64CatalogSuccessorAssetInputV1 | undefined;
  readonly targetAsset: Rfc64CatalogSuccessorAssetInputV1 | undefined;
}

function transition(nextAssets: Rfc64CatalogSuccessorAssetInputV1[],
  currentAsset: Rfc64CatalogSuccessorAssetInputV1 | undefined,
  targetAsset: Rfc64CatalogSuccessorAssetInputV1 | undefined): Rfc64CatalogTransitionV1 {
  return { nextAssets, currentAsset, targetAsset };
}

export function planNextRfc64CatalogExactSetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): Rfc64CatalogTransitionV1 {
  let currentIndex = 0;
  let targetIndex = 0;
  while (currentIndex < current.length || targetIndex < target.length) {
    const currentAsset = current[currentIndex];
    const targetAsset = target[targetIndex];
    if (currentAsset === undefined) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset!);
    }
    if (targetAsset === undefined) {
      return transition(current.filter((_, index) => index !== currentIndex), currentAsset, targetAsset);
    }
    const comparison = compareRfc64CatalogAssetsByKaIdV1(currentAsset, targetAsset);
    if (comparison < 0) return transition(current.filter((_, index) => index !== currentIndex), currentAsset, undefined);
    if (comparison > 0) {
      return insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset);
    }
    if (!sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) {
      if (
        BigInt(targetAsset.seal.assertionVersion) === BigInt(currentAsset.seal.assertionVersion)
        ||
        BigInt(targetAsset.seal.assertionVersion)
          > BigInt(currentAsset.seal.assertionVersion) + 1n
      ) {
        // A revised unpublished draft reuses its number; an inventory may also skip versions.
        // After target authorization, remove first and insert on the following successor.
        return transition(current.filter((_, index) => index !== currentIndex), currentAsset, targetAsset);
      }
      const next = [...current];
      next[currentIndex] = targetAsset;
      return transition(next, currentAsset, targetAsset);
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
): Rfc64CatalogTransitionV1 {
  if (current.length < MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    return transition(insertRfc64CatalogAssetV1(current, asset), undefined, asset);
  }
  const targetKaIds = new Set(target.map((targetAsset) => targetAsset.seal.reservedKaId));
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!targetKaIds.has(current[index]!.seal.reservedKaId)) {
      return transition(current.filter((_currentAsset, currentIndex) => currentIndex !== index), current[index], undefined);
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
