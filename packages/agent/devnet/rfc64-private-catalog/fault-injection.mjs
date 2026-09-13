// SPDX-License-Identifier: Apache-2.0
// @ts-check

/** @typedef {'omit-receiver' | 'revocation-chain-noop' | 'revocation-over-removal'} Rfc64PrivateAuthorityFaultV1 */
/** @typedef {'expected-assets' | 'duplicate-expected-assets' | 'trusted-scope'} Rfc64PrivateCatalogProofFaultV1 */
/** @typedef {{ readonly authority: Rfc64PrivateAuthorityFaultV1 | null, readonly catalogProof: Rfc64PrivateCatalogProofFaultV1 | null }} Rfc64PrivateFaultSelectionV1 */

/** @type {ReadonlySet<Rfc64PrivateAuthorityFaultV1>} */
const AUTHORITY_FAULTS = new Set([
  'omit-receiver',
  'revocation-chain-noop',
  'revocation-over-removal',
]);
/** @type {ReadonlySet<Rfc64PrivateCatalogProofFaultV1>} */
const CATALOG_PROOF_FAULTS = new Set([
  'expected-assets',
  'duplicate-expected-assets',
  'trusted-scope',
]);

/** Parse test-only corruption controls once for construction-time substitution. */
/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {Readonly<Rfc64PrivateFaultSelectionV1>}
 */
export function parseRfc64PrivateFaultSelectionV1(environment) {
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
    authority: authorityFault,
    catalogProof: catalogProofFault,
  });
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
