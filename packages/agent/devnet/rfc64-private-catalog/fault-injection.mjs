// SPDX-License-Identifier: Apache-2.0

import {
  decodeOpaqueKaBundleV1,
  encodeOpaqueKaBundleV1,
} from '@origintrail-official/dkg-core';

const AUTHORITY_FAULTS = new Set([
  'omit-receiver',
  'revocation-chain-noop',
  'revocation-over-removal',
]);
const CATALOG_PROOF_FAULTS = new Set([
  'inventory-digest',
  'expected-assets',
  'duplicate-expected-assets',
  'missing-bundle',
  'mismatched-bundle',
  'trusted-scope',
]);

/** Parse test-only corruption controls once into immutable strategies. */
export function createRfc64PrivateFaultProfileV1(environment) {
  const authorityFault = optionalFault(
    environment.DKG_RFC64_PRIVATE_AUTHORITY_FAULT,
    AUTHORITY_FAULTS,
    'authority',
  );
  const catalogProofFault = optionalFault(
    environment.DKG_RFC64_PRIVATE_CATALOG_PROOF_FAULT,
    CATALOG_PROOF_FAULTS,
    'catalog proof',
  );
  return Object.freeze({
    authority: authorityStrategyV1(authorityFault),
    proof: catalogProofStrategyV1(catalogProofFault),
  });
}

function authorityStrategyV1(fault) {
  return Object.freeze({
    fixture(canonical, receiverAddress) {
      if (fault !== 'omit-receiver') return canonical;
      return Object.freeze({
        ...canonical,
        participantAgents: Object.freeze(canonical.participantAgents.filter(
          (address) => address !== receiverAddress,
        )),
      });
    },
    adapterOptions({ authorityStatePath, ownerAddress }) {
      return Object.freeze({
        authorityStatePath: fault === 'omit-receiver' ? undefined : authorityStatePath,
        participantRemovalAlsoRemoves: fault === 'revocation-over-removal'
          ? ownerAddress
          : undefined,
        participantRemovalNoop: fault === 'revocation-chain-noop',
      });
    },
  });
}

function catalogProofStrategyV1(fault) {
  return Object.freeze({
    inputs({
      appliedHead,
      expectedAssetNumbers,
      kaBundles,
      trustedCatalogScope,
      untrustedCatalogScope,
    }) {
      return Object.freeze({
        appliedHead: fault === 'inventory-digest'
          ? Object.freeze({ ...appliedHead, appliedInventoryDigest: `0x${'00'.repeat(32)}` })
          : appliedHead,
        expectedAssetNumbers: fault === 'expected-assets'
          ? Object.freeze([expectedAssetNumbers[0], 43])
          : fault === 'duplicate-expected-assets'
            ? Object.freeze([expectedAssetNumbers[0], expectedAssetNumbers[0]])
            : expectedAssetNumbers,
        kaBundles: wrapKaBundlesV1(kaBundles, fault),
        trustedCatalogScope: fault === 'trusted-scope'
          ? untrustedCatalogScope
          : trustedCatalogScope,
      });
    },
  });
}

function wrapKaBundlesV1(kaBundles, fault) {
  if (fault === 'missing-bundle') {
    return Object.freeze({ readKaBundleByDigest: async () => null });
  }
  if (fault !== 'mismatched-bundle') return kaBundles;
  return Object.freeze({
    readKaBundleByDigest: async (blobDigest) => {
      const bundleBytes = await kaBundles.readKaBundleByDigest(blobDigest);
      if (bundleBytes === null) return null;
      const decoded = decodeOpaqueKaBundleV1(bundleBytes);
      const projectionBytes = decoded.projectionBytes.slice();
      if (projectionBytes.length === 0) {
        throw new Error('cannot inject a mismatched empty catalog projection');
      }
      projectionBytes[0] ^= 1;
      return encodeOpaqueKaBundleV1(projectionBytes, decoded.sealBytes).bundleBytes;
    },
  });
}

function optionalFault(value, supported, label) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !supported.has(value)) {
    throw new Error(`unsupported RFC-64 private ${label} fault injection`);
  }
  return value;
}
