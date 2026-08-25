// SPDX-License-Identifier: Apache-2.0

import type {
  Digest32V1,
  SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64PublicCatalogNativeFetchScopeV1 } from './public-catalog-native-transport-v1.js';

declare const RFC64_SCOPED_READ_CAPABILITY_BRAND_V1: unique symbol;

/** Process-local capability. It is not a serializable authority token. */
export interface Rfc64CatalogNativeScopedReadCapabilityV1 {
  readonly [RFC64_SCOPED_READ_CAPABILITY_BRAND_V1]: true;
  readonly scope: Rfc64PublicCatalogNativeFetchScopeV1;
  readonly readCatalogObjectByDigest: (
    objectDigest: Digest32V1,
  ) => Promise<SignedControlEnvelopeV1 | null>;
  readonly readKaBundleByDigest: (
    blobDigest: Digest32V1,
  ) => Promise<Uint8Array | null>;
}

const MINTED_CAPABILITIES = new WeakSet<object>();

export function mintRfc64CatalogNativeScopedReadCapabilityV1(input: {
  readonly scope: Rfc64PublicCatalogNativeFetchScopeV1;
  readonly readCatalogObjectByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readCatalogObjectByDigest'];
  readonly readKaBundleByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readKaBundleByDigest'];
}): Rfc64CatalogNativeScopedReadCapabilityV1 {
  const capability = Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    readCatalogObjectByDigest: input.readCatalogObjectByDigest,
    readKaBundleByDigest: input.readKaBundleByDigest,
  }) as unknown as Rfc64CatalogNativeScopedReadCapabilityV1;
  MINTED_CAPABILITIES.add(capability as object);
  return capability;
}

export function isMintedRfc64CatalogNativeScopedReadCapabilityV1(
  value: unknown,
): value is Rfc64CatalogNativeScopedReadCapabilityV1 {
  return typeof value === 'object'
    && value !== null
    && MINTED_CAPABILITIES.has(value);
}
