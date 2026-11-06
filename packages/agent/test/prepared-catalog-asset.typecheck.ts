import type { CanonicalGraphScopedAuthorSealV1 } from '@origintrail-official/dkg-core';
import type { PreparedCatalogAssetV1, PreparedSuccessorRowV1 } from '../src/internal/prepared-catalog-asset.js';
import type { Rfc64SuccessorRowVerificationV1 } from '../src/internal/verified-catalog-rows.js';

declare const verifier: Rfc64SuccessorRowVerificationV1;
declare const prepared: PreparedCatalogAssetV1;
declare const row: PreparedSuccessorRowV1;
declare const seal: CanonicalGraphScopedAuthorSealV1;

verifier.assertAssetBinds(prepared);
// @ts-expect-error A structural row cannot stand in for canonical asset preparation.
verifier.assertAssetBinds({ ...row, assertProjectionBinds: () => {} });
// @ts-expect-error A second seal/projection representation cannot cross the validation boundary.
verifier.assertAssetBinds(prepared, new Uint8Array(), seal);
