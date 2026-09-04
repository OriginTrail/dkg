// SPDX-License-Identifier: Apache-2.0

/**
 * Dormant R1.1 boundary between the signed SWM author inventory and catalog
 * production. It authenticates one exact inventory snapshot, resolves every
 * row to immutable projection/seal input, and refuses any cross-layer drift
 * before a catalog successor can be staged.
 *
 * This module does not schedule ordinary SHARE work, switch a semantic head,
 * announce availability, or claim receiver convergence.
 */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  parseCanonicalGraphScopedAuthorSealV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type AuthorCatalogScopeV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { mapWithConcurrency } from '../map-with-concurrency.js';
import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  './public-catalog-successor-producer-v1.js';
import {
  assertExactFieldSetV1,
  snapshotPlainDataRecordV1,
} from './inventory-v1/exact-record.js';

export const RFC64_SWM_INVENTORY_CATALOG_TARGET_MAX_ROWS_V1 =
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;

/** Bound read-only projection resolution so a large author lane does not serialize N store reads. */
const RFC64_SWM_INVENTORY_CATALOG_RESOLVE_CONCURRENCY_V1 = 8;

export type Rfc64SwmInventoryCatalogReconcilerErrorCodeV1 =
  | 'swm-catalog-reconcile-input'
  | 'swm-catalog-reconcile-signature'
  | 'swm-catalog-reconcile-capacity'
  | 'swm-catalog-reconcile-resolution'
  | 'swm-catalog-reconcile-binding';

export class Rfc64SwmInventoryCatalogReconcilerErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SwmInventoryCatalogReconcilerErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SwmInventoryCatalogReconcilerErrorV1';
  }
}

export interface PrepareRfc64SwmInventoryCatalogTargetInputV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  /** Resolve the exact durable shared projection and seal named by one signed row. */
  readonly resolveAsset: (
    row: Readonly<SwmAuthorInventoryRowV1>,
  ) => Promise<Rfc64PublicCatalogSuccessorAssetInputV1>;
}

export interface PreparedRfc64SwmInventoryCatalogTargetV1 {
  readonly inventoryHeadObjectDigest: string;
  readonly inventoryScope: Readonly<SwmAuthorInventoryScopeV1>;
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  /** Canonical inventory order, which is also mathematical packed-KA order. */
  readonly assets: readonly Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>[];
}

/**
 * Authenticate and detach one signed exact SWM inventory before resolving any
 * payload. Every resolved asset is then rebound to its signed row. A resolver
 * cannot substitute a different version, projection, seal, author, or KA.
 */
export async function prepareRfc64SwmInventoryCatalogTargetV1(
  input: PrepareRfc64SwmInventoryCatalogTargetInputV1,
): Promise<PreparedRfc64SwmInventoryCatalogTargetV1> {
  const snapshot = snapshotInventory(input?.snapshot);
  if (snapshot.rows.length > RFC64_SWM_INVENTORY_CATALOG_TARGET_MAX_ROWS_V1) {
    fail(
      'swm-catalog-reconcile-capacity',
      `bounded R1.1 catalog target exceeds ${RFC64_SWM_INVENTORY_CATALOG_TARGET_MAX_ROWS_V1} rows`,
    );
  }
  if (typeof input?.resolveAsset !== 'function') {
    fail('swm-catalog-reconcile-input', 'resolveAsset must be a function');
  }
  try {
    await verifyControlEnvelopeIssuerSignatureV1(snapshot.head);
  } catch (cause) {
    fail(
      'swm-catalog-reconcile-signature',
      'SWM inventory head issuer signature is invalid',
      cause,
    );
  }

  const inventoryScope = Object.freeze(
    deriveSwmAuthorInventoryScopeFromHeadV1(snapshot.head.payload),
  );
  const catalogScope = Object.freeze({
    ...inventoryScope,
    bucketCount: '1',
  }) as AuthorCatalogScopeV1;
  const assets = await mapWithConcurrency(
    snapshot.rows,
    RFC64_SWM_INVENTORY_CATALOG_RESOLVE_CONCURRENCY_V1,
    async (row): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> => {
      let resolved: Rfc64PublicCatalogSuccessorAssetInputV1;
      try {
        resolved = await input.resolveAsset(row);
      } catch (cause) {
        fail(
          'swm-catalog-reconcile-resolution',
          `durable catalog asset could not be resolved for ${row.kaUal}`,
          cause,
        );
      }
      const asset = snapshotAsset(resolved);
      assertAssetBindsInventoryRow(asset, row);
      return asset;
    },
  );

  return Object.freeze({
    inventoryHeadObjectDigest: snapshot.head.objectDigest,
    inventoryScope,
    catalogScope,
    assets: Object.freeze(assets),
  });
}

function snapshotInventory(input: unknown): SwmAuthorInventorySnapshotV1 {
  try {
    const record = snapshotPlainDataRecordV1(input, 'R1.1 SWM inventory snapshot');
    assertExactFieldSetV1(
      record,
      ['head', 'rows'],
      'R1.1 SWM inventory snapshot',
    );
    const head = parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(record.head as never),
    );
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1(record.rows as never),
    );
    const snapshot = Object.freeze({ head, rows });
    assertSwmAuthorInventorySnapshotBindingV1(snapshot);
    return snapshot;
  } catch (cause) {
    fail(
      'swm-catalog-reconcile-input',
      'SWM inventory snapshot is not canonical or internally bound',
      cause,
    );
  }
}

function snapshotAsset(input: unknown): Rfc64PublicCatalogSuccessorAssetInputV1 {
  try {
    const record = snapshotPlainDataRecordV1(input, 'R1.1 catalog successor asset');
    assertExactFieldSetV1(
      record,
      ['assertionCoordinate', 'projectionBytes', 'seal'],
      'R1.1 catalog successor asset',
    );
    if (!(record.projectionBytes instanceof Uint8Array)) {
      throw new TypeError('projectionBytes must be a Uint8Array');
    }
    const seal = parseCanonicalGraphScopedAuthorSealV1(
      canonicalizeCanonicalGraphScopedAuthorSealV1(record.seal as never),
    );
    return Object.freeze({
      assertionCoordinate: record.assertionCoordinate as never,
      projectionBytes: new Uint8Array(record.projectionBytes),
      seal,
    });
  } catch (cause) {
    fail(
      'swm-catalog-reconcile-resolution',
      'resolved catalog asset is not one canonical immutable snapshot',
      cause,
    );
  }
}

function assertAssetBindsInventoryRow(
  asset: Readonly<Rfc64PublicCatalogSuccessorAssetInputV1>,
  row: Readonly<SwmAuthorInventoryRowV1>,
): void {
  try {
    if (asset.assertionCoordinate !== row.assertionCoordinate) {
      throw new Error('assertionCoordinate differs');
    }
    if (asset.seal.assertionVersion !== row.assertionVersion) {
      throw new Error('assertionVersion differs');
    }
    if (asset.seal.kaUal !== row.kaUal) throw new Error('kaUal differs');
    if (asset.seal.publicTripleCount !== row.publicTripleCount) {
      throw new Error('publicTripleCount differs');
    }
    if (asset.seal.privateTripleCount !== row.privateTripleCount) {
      throw new Error('privateTripleCount differs');
    }
    if (computeKaProjectionDigestV1(asset.projectionBytes) !== row.projectionDigest) {
      throw new Error('projectionDigest differs');
    }
    if (computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal) !== row.sealDigest) {
      throw new Error('sealDigest differs');
    }
  } catch (cause) {
    fail(
      'swm-catalog-reconcile-binding',
      `resolved catalog asset differs from signed SWM inventory row ${row.kaUal}`,
      cause,
    );
  }
}

function fail(
  code: Rfc64SwmInventoryCatalogReconcilerErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SwmInventoryCatalogReconcilerErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
