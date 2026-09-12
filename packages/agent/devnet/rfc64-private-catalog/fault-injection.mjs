// SPDX-License-Identifier: Apache-2.0
// @ts-check

/** @typedef {'omit-receiver' | 'revocation-chain-noop' | 'revocation-over-removal'} Rfc64PrivateAuthorityFaultV1 */
/** @typedef {'inventory-digest' | 'expected-assets' | 'duplicate-expected-assets' | 'missing-bundle' | 'mismatched-bundle' | 'trusted-scope'} Rfc64PrivateCatalogProofFaultV1 */
/** @typedef {import('./agent-runtime.ts').Rfc64PrivateFaultProfileV1} Rfc64PrivateFaultProfileV1 */
/** @typedef {import('./agent-runtime.ts').Rfc64PrivateCatalogProofInputsV1} Rfc64PrivateCatalogProofInputsV1 */

/** @type {ReadonlySet<Rfc64PrivateAuthorityFaultV1>} */
const AUTHORITY_FAULTS = new Set([
  'omit-receiver',
  'revocation-chain-noop',
  'revocation-over-removal',
]);
/** @type {ReadonlySet<Rfc64PrivateCatalogProofFaultV1>} */
const CATALOG_PROOF_FAULTS = new Set([
  'inventory-digest',
  'expected-assets',
  'duplicate-expected-assets',
  'missing-bundle',
  'mismatched-bundle',
  'trusted-scope',
]);

/** Parse test-only corruption controls once into immutable strategies. */
/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Rfc64PrivateFaultProfileV1}
 */
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

/**
 * @param {Rfc64PrivateAuthorityFaultV1 | null} fault
 * @returns {Rfc64PrivateFaultProfileV1['authority']}
 */
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

/**
 * @param {Rfc64PrivateCatalogProofFaultV1 | null} fault
 * @returns {Rfc64PrivateFaultProfileV1['proof']}
 */
function catalogProofStrategyV1(fault) {
  return Object.freeze({
    /** @param {Rfc64PrivateCatalogProofInputsV1} input */
    inputs({
      appliedHead,
      expectedAssetNumbers,
      readVerifiedAppliedCatalogClosure,
      trustedCatalogScope,
      untrustedCatalogScope,
    }) {
      return Object.freeze({
        appliedHead: fault === 'inventory-digest'
          ? Object.freeze({
              ...appliedHead,
              appliedInventoryDigest:
                /** @type {import('@origintrail-official/dkg-core').Digest32V1} */ (
                  `0x${'00'.repeat(32)}`
                ),
            })
          : appliedHead,
        expectedAssetNumbers: fault === 'expected-assets'
          ? Object.freeze([expectedAssetNumbers[0], 43])
          : fault === 'duplicate-expected-assets'
            ? Object.freeze([expectedAssetNumbers[0], expectedAssetNumbers[0]])
            : expectedAssetNumbers,
        readVerifiedAppliedCatalogClosure: wrapClosureReaderV1(
          readVerifiedAppliedCatalogClosure,
          fault,
        ),
        trustedCatalogScope: fault === 'trusted-scope'
          ? untrustedCatalogScope
          : trustedCatalogScope,
      });
    },
  });
}

/**
 * Keep storage corruption behind the semantic reader boundary. Production
 * integration tests exercise real missing/mismatched durable bundles; these
 * fixture-only strategies preserve the same fail-closed evidence outcomes.
 * @param {Rfc64PrivateCatalogProofInputsV1['readVerifiedAppliedCatalogClosure']} reader
 * @param {Rfc64PrivateCatalogProofFaultV1 | null} fault
 * @returns {Rfc64PrivateCatalogProofInputsV1['readVerifiedAppliedCatalogClosure']}
 */
function wrapClosureReaderV1(reader, fault) {
  if (fault === 'missing-bundle') {
    return async () => {
      throw new Error('signed catalog row has no durable KA bundle');
    };
  }
  if (fault !== 'mismatched-bundle') return reader;
  return async () => {
    throw new Error('durable KA bundle differs from its signed catalog row');
  };
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {ReadonlySet<T>} supported
 * @param {string} label
 * @returns {T | null}
 */
function optionalFault(value, supported, label) {
  if (value === undefined) return null;
  if (
    typeof value !== 'string'
    || !supported.has(/** @type {T} */ (value))
  ) {
    throw new Error(`unsupported RFC-64 private ${label} fault injection`);
  }
  return /** @type {T} */ (value);
}
