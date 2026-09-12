// SPDX-License-Identifier: Apache-2.0

import { readPrivateCatalogAppliedProjectionEvidenceV1 } from './memory-evidence.mjs';

/** Project the canonical verified closure into the fixture's per-asset evidence. */
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
