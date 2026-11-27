// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeAuthorCatalogRowV1, canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1, computeKaChunkTreeRootV1,
  encodeOpaqueKaBundleV1, parseCanonicalAuthorCatalogRowV1,
  KA_TRANSFER_CHUNK_SIZE_BYTES_V1, KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1, KA_TRANSFER_PROJECTION_V1,
  verifyCanonicalCgSharedProjectionBytesV1, DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  type AuthorCatalogRowV1, type AuthorCatalogScopeV1, type CatalogSealDeploymentProfileV1,
  type ByteLengthV1, type CountV1,
} from '@origintrail-official/dkg-core';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from '../rfc64/public-catalog-successor-asset-v1.js';
import type { Rfc64PublicCatalogSuccessorRowBindingV1 } from '../rfc64/public-catalog-successor-row-binding-v1.js';

/** The fields of a prepared successor row that its produced-row verification reads. */
export interface PreparedSuccessorRowV1 {
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly scope: AuthorCatalogScopeV1;
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly sealBytes: Uint8Array;
  readonly bundleBytes: Uint8Array;
}

const preparedAssetBrand: unique symbol = Symbol('prepared catalog asset');
const preparedAssets = new WeakSet<object>();

/** Only canonical preparation can pair this row with its captured seal and projection. */
export interface PreparedCatalogAssetV1 extends PreparedSuccessorRowV1 {
  readonly [preparedAssetBrand]: true;
  readonly assertProjectionBinds: () => void;
}

/** Check provenance before looking up a remembered row, including for structurally copied inputs. */
export function assertCanonicalPreparedCatalogAssetV1(prepared: PreparedCatalogAssetV1): void {
  if (!preparedAssets.has(prepared)) throw new TypeError('Expected a canonically prepared catalog asset');
}

/** Own one snapshot; no independently supplied seal/projection can reach verification later. */
export function prepareCatalogAssetV1(
  asset: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>,
  binding: Rfc64PublicCatalogSuccessorRowBindingV1,
): PreparedCatalogAssetV1 {
  if (!(asset.projectionBytes instanceof Uint8Array)) throw new TypeError('Expected projection bytes');
  const projectionBytes = new Uint8Array(asset.projectionBytes);
  const seal = Object.freeze({ ...asset.seal });
  const sealBytes = canonicalizeCanonicalGraphScopedAuthorSealBytesV1(seal);
  const encoded = encodeOpaqueKaBundleV1(projectionBytes, sealBytes);
  const byteLength = BigInt(encoded.bundleBytes.byteLength);
  const row = parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1({
    kaId: seal.reservedKaId,
    assertionCoordinate: asset.assertionCoordinate,
    assertionVersion: seal.assertionVersion,
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest: encoded.projectionDigest,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: encoded.projectionDigest,
      byteLength: byteLength.toString() as ByteLengthV1,
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: (((byteLength - 1n) / KA_TRANSFER_CHUNK_SIZE_BYTES_V1) + 1n).toString() as CountV1,
      blobDigest: encoded.blobDigest,
      chunkTreeRoot: computeKaChunkTreeRootV1(encoded.bundleBytes),
    },
  }));
  Object.freeze(row.transfer);
  Object.freeze(row);
  // Production already detached these bindings once for the entire target. Keep that sharing.
  const scope = Object.isFrozen(binding.scope) ? binding.scope : Object.freeze({ ...binding.scope });
  const deployment = Object.isFrozen(binding.deployment)
    ? binding.deployment : Object.freeze({ ...binding.deployment });
  const prepared: PreparedCatalogAssetV1 = Object.freeze({
    [preparedAssetBrand]: true as const,
    scope, deployment, row,
    // Exposed byte copies cannot change the captured validation/staging inputs.
    get sealBytes() { return new Uint8Array(sealBytes); },
    get bundleBytes() { return new Uint8Array(encoded.bundleBytes); },
    assertProjectionBinds(): void {
      verifyCanonicalCgSharedProjectionBytesV1(projectionBytes, seal, row.projectionDigest,
        DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1);
    },
  });
  preparedAssets.add(prepared);
  return prepared;
}
