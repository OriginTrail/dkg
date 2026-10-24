// SPDX-License-Identifier: Apache-2.0

import type {
  Digest32V1,
  SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import type { Rfc64PublicCatalogNativeFetchScopeV1 } from './public-catalog-native-transport-v1.js';

const RFC64_SCOPED_READ_CAPABILITY_BRAND_V1: unique symbol = Symbol(
  'rfc64-catalog-native-scoped-read-capability-v1',
);

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

export function mintRfc64CatalogNativeScopedReadCapabilityV1(input: {
  readonly scope: Rfc64PublicCatalogNativeFetchScopeV1;
  readonly readCatalogObjectByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readCatalogObjectByDigest'];
  readonly readKaBundleByDigest: Rfc64CatalogNativeScopedReadCapabilityV1['readKaBundleByDigest'];
}): Rfc64CatalogNativeScopedReadCapabilityV1 {
  if (typeof input.readCatalogObjectByDigest !== 'function') {
    throw new TypeError('scoped catalog object reader must be callable');
  }
  if (typeof input.readKaBundleByDigest !== 'function') {
    throw new TypeError('scoped KA bundle reader must be callable');
  }
  const capability = Object.freeze({
    [RFC64_SCOPED_READ_CAPABILITY_BRAND_V1]: true as const,
    scope: Object.freeze({ ...input.scope }),
    readCatalogObjectByDigest: input.readCatalogObjectByDigest,
    readKaBundleByDigest: input.readKaBundleByDigest,
  });
  return capability;
}

export function isMintedRfc64CatalogNativeScopedReadCapabilityV1(
  value: unknown,
): value is Rfc64CatalogNativeScopedReadCapabilityV1 {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return (value as Record<PropertyKey, unknown>)[
      RFC64_SCOPED_READ_CAPABILITY_BRAND_V1
    ] === true;
  } catch {
    return false;
  }
}
