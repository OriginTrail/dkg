// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { readPrivateCatalogAppliedProjectionEvidenceV1 } from './memory-evidence.mjs';

/** @typedef {{ readonly expectedAssetNumbers: readonly number[], readonly readVerifiedAppliedCatalogClosure: import('./agent-runtime.ts').Rfc64PrivateCatalogClosureReaderV1, readonly store: import('@origintrail-official/dkg-storage').TripleStore, readonly trustedCatalogScope: Readonly<import('@origintrail-official/dkg-core').AuthorCatalogScopeV1> }} ReadVerifiedAppliedCatalogMemoryEvidenceInputV1 */
/** @typedef {import('./memory-evidence.mjs').Rfc64PrivateCatalogRowSwmProofV1} Rfc64PrivateCatalogRowSwmProofV1 */

/** Project the canonical verified closure into the fixture's per-asset evidence. */
/**
 * @param {ReadVerifiedAppliedCatalogMemoryEvidenceInputV1} input
 * @returns {Promise<readonly Readonly<import('./memory-evidence.mjs').Rfc64PrivateCatalogMemoryEvidenceRowV1>[]>}
 */
export async function readVerifiedAppliedCatalogMemoryEvidenceV1({
  expectedAssetNumbers,
  readVerifiedAppliedCatalogClosure,
  store,
  ...closureCoordinates
}) {
  if (
    !Array.isArray(expectedAssetNumbers)
    || expectedAssetNumbers.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError('expected catalog SWM asset numbers must be safe integers');
  }
  const expectedNumbers = new Set(expectedAssetNumbers.map((value) => BigInt(value)));
  if (expectedNumbers.size !== expectedAssetNumbers.length) {
    throw new Error('expected catalog SWM asset identities are duplicated');
  }
  const closure = await readVerifiedAppliedCatalogClosure(closureCoordinates);
  /** @type {Map<bigint, Readonly<Rfc64PrivateCatalogRowSwmProofV1>>} */
  const byKaNumber = new Map();
  for (const { kaNumber, row } of closure.rows) {
    if (!expectedNumbers.has(kaNumber) || byKaNumber.has(kaNumber)) {
      throw new Error('signed catalog row set differs from the expected asset identities');
    }
    byKaNumber.set(kaNumber, Object.freeze({
      assertionVersion: row.assertionVersion,
      catalogHeadDigest: closure.head.objectDigest,
      kaId: row.kaId,
      kind: 'catalog-row',
      projectionDigest: row.projectionDigest,
    }));
  }
  if (
    closure.rows.length !== expectedNumbers.size
    || [...expectedNumbers].some((kaNumber) => !byKaNumber.has(kaNumber))
  ) {
    throw new Error('signed catalog closure has missing or extra expected assets');
  }
  const projections = await readPrivateCatalogAppliedProjectionEvidenceV1(store, {
    assetNumbers: expectedAssetNumbers,
    authorAddress: closure.catalogScope.authorAddress,
    contextGraphId: closure.catalogScope.contextGraphId,
    networkId: closure.catalogScope.networkId,
  });
  return Object.freeze(projections.map((entry) => {
    const swmProof = byKaNumber.get(BigInt(entry.kaNumber));
    if (swmProof === undefined) {
      throw new Error('verified catalog closure has no proof for stored SWM projection');
    }
    return Object.freeze({ ...entry, swmProof });
  }));
}
