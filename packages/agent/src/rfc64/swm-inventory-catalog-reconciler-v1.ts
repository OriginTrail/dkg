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
  authorCatalogRowCapacityV1,
  canonicalizeCanonicalGraphScopedAuthorSealV1,
  computeAuthorCatalogScopeDigestV1,
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

import type { Rfc64PublicCatalogSuccessorAssetInputV1 } from
  './public-catalog-successor-producer-v1.js';
import {
  assertExactFieldSetV1,
  snapshotPlainDataRecordV1,
} from './inventory-v1/exact-record.js';

/**
 * GH#3134 — the most rows an author catalog of `scope` may be planned to hold. The share-time
 * projection's target and the exact-set planner are both bounded by it. While a catalog cannot
 * move to more buckets it is the scope's own capacity; once a full bucket moves the catalog to
 * more buckets, it becomes the node's maximum for one catalog, and both bounds follow.
 */
export function rfc64CatalogTargetRowCapacityV1(
  scope: Readonly<Pick<AuthorCatalogScopeV1, 'bucketCount'>>,
): bigint {
  return authorCatalogRowCapacityV1(scope.bucketCount);
}

/**
 * The target bound of a catalog of one bucket.
 *
 * @deprecated A target is bounded by its catalog's capacity, `authorCatalogRowCapacityV1` of the
 * scope's bucket count (GH#3134); for one bucket that is this value.
 */
export const RFC64_SWM_INVENTORY_CATALOG_TARGET_MAX_ROWS_V1 =
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;

/** Bound read-only projection resolution so a large author lane does not serialize N store reads. */
const RFC64_SWM_INVENTORY_CATALOG_RESOLVE_CONCURRENCY_V1 = 8;

/** A usable caller width, never wider than the bound above. */
function resolveConcurrencyV1(requested: number | undefined): number {
  return Number.isSafeInteger(requested) && (requested as number) >= 1
    ? Math.min(requested as number, RFC64_SWM_INVENTORY_CATALOG_RESOLVE_CONCURRENCY_V1)
    : RFC64_SWM_INVENTORY_CATALOG_RESOLVE_CONCURRENCY_V1;
}

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
  readonly signal?: AbortSignal;
  /**
   * Most rows resolved at once, at most 8 (the default). A caller whose
   * resolver reads through an admission lane passes what that lane admits at
   * once: a wider fan-out queues its surplus reads behind their own siblings.
   */
  readonly resolveConcurrency?: number;
  /** Resolve the exact durable shared projection and seal named by one signed row. */
  readonly resolveAsset: (
    row: Readonly<SwmAuthorInventoryRowV1>,
    signal: AbortSignal,
  ) => Promise<Rfc64PublicCatalogSuccessorAssetInputV1>;
  /**
   * The assets already placed in the target's catalog, such as the applied catalog's (GH#3134),
   * asked for once the inventory is authenticated and fits its catalog. A placed asset is used
   * instead of a resolution only when it binds its signed row exactly, as a resolved asset must;
   * every other row is resolved, and so is every row when the placed assets cannot be read.
   */
  readonly readPlacedAssets?: (
    catalogScope: Readonly<AuthorCatalogScopeV1>,
  ) => Promise<Rfc64PlacedCatalogAssetLookupV1>;
  /**
   * The author's current catalog scope for the inventory's lane (GH#3134), such as
   * `readCurrentAuthorCatalogScopeV1` returns. It must be the lane's own; without it the catalog
   * is one bucket.
   */
  readonly currentCatalogScope?: (
    lane: Readonly<SwmAuthorInventoryScopeV1>,
  ) => Readonly<AuthorCatalogScopeV1>;
}

/** The asset placed for a row's KA, if any. */
export type Rfc64PlacedCatalogAssetLookupV1 = (
  row: Readonly<SwmAuthorInventoryRowV1>,
) => Readonly<Rfc64PublicCatalogSuccessorAssetInputV1> | undefined;

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
 * cannot substitute a different version, projection, seal, author, or KA, and
 * neither can a placed asset: one that does not bind its row is resolved.
 */
export async function prepareRfc64SwmInventoryCatalogTargetV1(
  input: PrepareRfc64SwmInventoryCatalogTargetInputV1,
): Promise<PreparedRfc64SwmInventoryCatalogTargetV1> {
  const snapshot = snapshotInventory(input?.snapshot);
  if (typeof input?.resolveAsset !== 'function') {
    fail('swm-catalog-reconcile-input', 'resolveAsset must be a function');
  }
  if (input.readPlacedAssets !== undefined && typeof input.readPlacedAssets !== 'function') {
    fail('swm-catalog-reconcile-input', 'readPlacedAssets must be a function');
  }
  if (input.currentCatalogScope !== undefined && typeof input.currentCatalogScope !== 'function') {
    fail('swm-catalog-reconcile-input', 'currentCatalogScope must be a function');
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
  const catalogScope = currentCatalogScopeV1(input, inventoryScope);
  // Nothing past what the catalog may hold is resolved (GH#3134).
  const capacity = rfc64CatalogTargetRowCapacityV1(catalogScope);
  if (BigInt(snapshot.rows.length) > capacity) {
    fail(
      'swm-catalog-reconcile-capacity',
      `bounded R1.1 catalog target of ${snapshot.rows.length} rows exceeds the ${capacity} rows`
        + ` of a catalog of ${catalogScope.bucketCount} bucket(s)`,
    );
  }
  const placedAsset = await readPlacedAssetsV1(input, catalogScope);
  const assets = await resolveCatalogAssetsWithDrainV1(
    snapshot.rows,
    async (row, signal): Promise<Rfc64PublicCatalogSuccessorAssetInputV1> => {
      const placed = placedAssetForRowV1(placedAsset, row);
      if (placed !== undefined) return placed;
      let resolved: Rfc64PublicCatalogSuccessorAssetInputV1;
      try {
        signal.throwIfAborted();
        resolved = await input.resolveAsset(row, signal);
        signal.throwIfAborted();
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
    resolveConcurrencyV1(input.resolveConcurrency),
    input.signal,
  );

  return Object.freeze({
    inventoryHeadObjectDigest: snapshot.head.objectDigest,
    inventoryScope,
    catalogScope,
    assets: Object.freeze(assets),
  });
}

/** Failed repairs retain ownership of admitted reads until physical retirement. */
async function resolveCatalogAssetsWithDrainV1<T>(
  rows: readonly SwmAuthorInventoryRowV1[],
  resolve: (row: Readonly<SwmAuthorInventoryRowV1>, signal: AbortSignal) => Promise<T>,
  concurrency: number,
  externalSignal?: AbortSignal,
): Promise<T[]> {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const results: T[] = [];
  let next = 0;
  let failed = false;
  let failure: unknown;
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
    controller.abort(error);
  };
  const onAbort = () => stop(externalSignal!.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all(Array.from({
      length: Math.min(rows.length, concurrency),
    }, async () => {
      while (!failed && next < rows.length) {
        const index = next++;
        try {
          results[index] = await resolve(rows[index]!, controller.signal);
        } catch (error) {
          stop(error);
        }
      }
    }));
  } finally {
    externalSignal?.removeEventListener('abort', onAbort);
  }
  if (failed) throw failure;
  return results;
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

/** The lane's catalog scope: the caller's current one, which must be of this very lane. */
function currentCatalogScopeV1(
  input: PrepareRfc64SwmInventoryCatalogTargetInputV1,
  inventoryScope: Readonly<SwmAuthorInventoryScopeV1>,
): Readonly<AuthorCatalogScopeV1> {
  if (input.currentCatalogScope === undefined) {
    return Object.freeze({ ...inventoryScope, bucketCount: '1' }) as AuthorCatalogScopeV1;
  }
  let scope: Readonly<AuthorCatalogScopeV1>;
  try {
    scope = input.currentCatalogScope(inventoryScope);
    // The digest checks the bucket count and every other field of the scope.
    const { bucketCount, ...lane } = scope;
    const sameLane = Object.keys(inventoryScope).length === Object.keys(lane).length
      && Object.entries(inventoryScope).every(([key, value]) => (
        (lane as Record<string, unknown>)[key] === value
      ));
    if (!sameLane) throw new Error('the current catalog scope is of another lane');
    computeAuthorCatalogScopeDigestV1(Object.freeze({ ...inventoryScope, bucketCount }) as AuthorCatalogScopeV1);
    return Object.freeze({ ...inventoryScope, bucketCount }) as AuthorCatalogScopeV1;
  } catch (cause) {
    fail(
      'swm-catalog-reconcile-input',
      'the current catalog scope is not a scope of the inventory\'s lane',
      cause,
    );
  }
}

/** The caller's placed assets, or none when there are none to read or they cannot be read. */
async function readPlacedAssetsV1(
  input: PrepareRfc64SwmInventoryCatalogTargetInputV1,
  catalogScope: Readonly<AuthorCatalogScopeV1>,
): Promise<Rfc64PlacedCatalogAssetLookupV1 | undefined> {
  if (input.readPlacedAssets === undefined) return undefined;
  input.signal?.throwIfAborted();
  try {
    const lookup = await input.readPlacedAssets(catalogScope);
    return typeof lookup === 'function' ? lookup : undefined;
  } catch {
    return undefined;
  } finally {
    input.signal?.throwIfAborted();
  }
}

/**
 * The placed asset's own snapshot when it binds `row` exactly, else undefined: the row is then
 * resolved like any other.
 */
function placedAssetForRowV1(
  placedAsset: Rfc64PlacedCatalogAssetLookupV1 | undefined,
  row: Readonly<SwmAuthorInventoryRowV1>,
): Rfc64PublicCatalogSuccessorAssetInputV1 | undefined {
  const placed = placedAsset?.(row);
  if (placed === undefined) return undefined;
  try {
    const asset = snapshotAsset(placed);
    assertAssetBindsInventoryRow(asset, row);
    return asset;
  } catch {
    return undefined;
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
