// SPDX-License-Identifier: Apache-2.0

import {
  assertSignedAuthorCatalogHeadEnvelopeV1,
  computeAuthorCatalogScopeDigestV1,
  decodeOpaqueKaBundleV1,
  deriveAuthorCatalogScopeFromHeadV1,
  readVerifiedCatalogSealBindingV1,
  verifyCatalogSealBindingV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { loadExactAppliedCatalogRowsV1 } from
  '../../src/rfc64/applied-catalog-authority-transition-v1.ts';
import { computeRfc64AppliedInventoryDigestV1 } from
  '../../src/rfc64/public-catalog-inventory-completeness-v1.ts';
import { unpackKnowledgeAssetId } from '../../src/ka-identity.ts';
import { readPrivateCatalogAppliedProjectionEvidenceV1 } from './memory-evidence.mjs';

/** Verify the durable closure and join its proofs to the exact stored projections. */
export async function readVerifiedAppliedCatalogMemoryEvidenceV1(input) {
  const proofs = await verifyAppliedCatalogSwmClosureV1(input);
  const byKaNumber = new Map(proofs.map(({ kaNumber, proof }) => [kaNumber, proof]));
  const projections = await readPrivateCatalogAppliedProjectionEvidenceV1(input.store, {
    assetNumbers: input.expectedAssetNumbers,
    authorAddress: input.trustedCatalogScope.authorAddress,
    contextGraphId: input.trustedCatalogScope.contextGraphId,
    networkId: input.trustedCatalogScope.networkId,
  });
  return Object.freeze(projections.map((entry) => {
    const swmProof = byKaNumber.get(entry.kaNumber);
    if (swmProof === undefined) {
      throw new Error('verified catalog closure has no proof for stored SWM projection');
    }
    return Object.freeze({ ...entry, swmProof });
  }));
}

/**
 * Verify the durable applied-head record and its complete signed catalog
 * closure, then return the exact per-asset proof set.
 */
export async function verifyAppliedCatalogSwmClosureV1({
  appliedHead,
  controlObjects,
  deployment,
  expectedAssetNumbers,
  kaBundles,
  trustedCatalogScope,
}) {
  if (appliedHead === null || typeof appliedHead !== 'object') {
    throw new TypeError('catalog-row SWM proof requires an applied head');
  }
  const storedHead = await controlObjects.getVerifiedObjectByDigest({
    objectDigest: appliedHead.currentCatalogHeadDigest,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
  });
  if (storedHead === null) throw new Error('applied catalog head has no signed closure');
  assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
  const head = storedHead.envelope;
  const signedScope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  if (
    head.objectDigest !== appliedHead.currentCatalogHeadDigest
    || computeAuthorCatalogScopeDigestV1(signedScope) !== appliedHead.catalogScopeDigest
    || computeAuthorCatalogScopeDigestV1(trustedCatalogScope) !== appliedHead.catalogScopeDigest
    || appliedHead.authorAddress !== trustedCatalogScope.authorAddress
    || head.payload.version !== appliedHead.catalogVersion
    || head.payload.totalRows !== appliedHead.inventoryRowCount
  ) {
    throw new Error('applied catalog head differs from its signed SWM proof closure');
  }
  const rows = await loadExactAppliedCatalogRowsV1(
    controlObjects,
    storedHead,
    trustedCatalogScope,
    verifyControlEnvelopeIssuerSignatureV1,
  );
  if (
    !Array.isArray(expectedAssetNumbers)
    || expectedAssetNumbers.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError('expected catalog SWM asset numbers must be safe integers');
  }
  const expectedNumbers = new Set(expectedAssetNumbers);
  if (expectedNumbers.size !== expectedAssetNumbers.length) {
    throw new Error('expected catalog SWM asset identities are duplicated');
  }
  const byKaNumber = new Map();
  const inventoryRows = [];
  for (const row of rows) {
    const bundleBytes = await kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
    if (bundleBytes === null) throw new Error('signed catalog row has no durable KA bundle');
    const bundle = decodeOpaqueKaBundleV1(bundleBytes);
    if (
      bundle.blobDigest !== row.transfer.blobDigest
      || bundle.projectionDigest !== row.projectionDigest
      || bundleBytes.byteLength.toString() !== row.transfer.byteLength
    ) {
      throw new Error('durable KA bundle differs from its signed catalog row');
    }
    const binding = readVerifiedCatalogSealBindingV1(verifyCatalogSealBindingV1(
      trustedCatalogScope,
      row,
      bundle.sealBytes,
      deployment,
    ));
    const identity = unpackKnowledgeAssetId(BigInt(row.kaId));
    const authorAddress = identity.agentAddress;
    const kaNumber = Number(identity.kaNumber);
    if (
      authorAddress !== trustedCatalogScope.authorAddress
      || !Number.isSafeInteger(kaNumber)
      || !expectedNumbers.has(kaNumber)
      || byKaNumber.has(kaNumber)
      || binding.seal.kaUal
        !== `did:dkg:${trustedCatalogScope.networkId}/${authorAddress}/${kaNumber}`
    ) {
      throw new Error('signed catalog row set differs from the expected asset identities');
    }
    byKaNumber.set(kaNumber, Object.freeze({
      assertionVersion: row.assertionVersion,
      catalogHeadDigest: head.objectDigest,
      kaId: row.kaId,
      projectionDigest: row.projectionDigest,
    }));
    inventoryRows.push(Object.freeze({
      activatedTripleCount: Number(binding.seal.publicTripleCount),
      catalogRowDigest: binding.catalogRowDigest,
      contentDigest: row.projectionDigest,
      kaId: row.kaId,
      kaUal: binding.seal.kaUal,
      sealDigest: binding.sealDigest,
    }));
  }
  if (
    rows.length !== expectedNumbers.size
    || rows.length.toString() !== appliedHead.inventoryRowCount
    || [...expectedNumbers].some((kaNumber) => !byKaNumber.has(kaNumber))
  ) {
    throw new Error('signed catalog closure has missing or extra expected assets');
  }
  if (computeRfc64AppliedInventoryDigestV1({
    catalogScopeDigest: appliedHead.catalogScopeDigest,
    rows: inventoryRows,
  }) !== appliedHead.appliedInventoryDigest) {
    throw new Error('signed catalog closure differs from the durable applied inventory digest');
  }
  return Object.freeze([...byKaNumber.entries()].map(([kaNumber, proof]) => Object.freeze({
    kaNumber,
    proof: Object.freeze({ kind: 'catalog-row', ...proof }),
  })));
}
