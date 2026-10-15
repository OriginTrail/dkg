/**
 * GH#3134 — a placement in a catalog of more than one bucket, through a real agent: the upsert
 * resolves the lane's current scope, reads the asset's bucket from the durable store and produces a
 * successor in that bucket; with moves on, a full bucket first moves the catalog to more buckets.
 *
 * As in `rfc64-full-author-catalog.test.ts`, the agent's modules read a bucket cap of 4 in place of
 * 1,024 from the core package, so four real placements fill a bucket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return { ...actual, MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1: 4 };
});

import {
  catalogKeyToBucketIdV1,
  computeAuthorCatalogScopeDigestV1,
  type AuthorCatalogScopeV1,
  type CountV1,
  type KaIdV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import type { DKGAgent } from '../src/index.js';
import { readCurrentAuthorCatalogScopeV1 } from '../src/internal/author-catalog-current-scope.js';
import { readAppliedCatalogRowIdentitiesV1 } from '../src/rfc64/applied-catalog-authority-transition-v1.js';
import { computeRfc64CatalogAppliedInventoryDigestV1 } from '../src/rfc64/applied-catalog-inventory-digest-v1.js';
import { produceAuthorCatalogCapacityTransitionV1 } from '../src/rfc64/author-catalog-capacity-transition-v1.js';
import {
  PLACEMENT_SCOPE,
  appliedCatalogObjectsV1,
  appliedPlacementHeadV1,
  placementAssetV1,
  placementPersistenceV1,
  startPlacementAgentV1,
  upsertPlacementV1,
} from './support/rfc64-catalog-placement-fixture.js';
import { AUTHOR, AUTHOR_WALLET } from './support/rfc64-local-catalog-repair-fixture.js';

const MOVED = Object.freeze({ ...PLACEMENT_SCOPE, bucketCount: '4' as CountV1 }) as AuthorCatalogScopeV1;

describe('placing an asset in a catalog of more than one bucket (GH#3134)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('places it in its bucket of the current scope and leaves the one-bucket head as it was', async () => {
    const agent = await startPlacementAgentV1('multi-bucket-placement');
    for (const kaNumber of [1, 2, 3, 4]) await upsertPlacementV1(agent, await placementAssetV1(kaNumber));
    const oneBucketHead = appliedPlacementHeadV1(agent);
    const moved = await moveToFourBuckets(agent);

    const placed = await placementAssetV1(7);
    const applied = await upsertPlacementV1(agent, placed);

    expect(applied).toMatchObject({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(MOVED),
      catalogVersion: String(BigInt(moved.head.payload.version) + 1n),
      inventoryRowCount: '5',
    });
    expect(appliedPlacementHeadV1(agent)).toEqual(oneBucketHead);
    const bucketId = catalogKeyToBucketIdV1(placed.seal.reservedKaId as KaIdV1, MOVED.bucketCount);
    const persistence = placementPersistenceV1(agent);
    const [bucket] = (await readAppliedCatalogRowIdentitiesV1({
      inventory: persistence.inventory,
      controlObjects: persistence.controlObjects,
      scope: MOVED,
      bucketIds: [bucketId],
    }))!;
    expect(bucket!.rows.map((row) => row.kaId)).toContain(placed.seal.reservedKaId);
    const all = await readAppliedCatalogRowIdentitiesV1({
      inventory: persistence.inventory,
      controlObjects: persistence.controlObjects,
      scope: MOVED,
    });
    expect(all!.flatMap((held) => held.rows)).toHaveLength(5);

    // The same asset again: nothing to sign.
    await expect(upsertPlacementV1(agent, placed)).resolves.toEqual(applied);
  });

  it('moves a catalog whose bucket is full to more buckets, then places the new asset there', async () => {
    vi.stubEnv('DKG_RFC64_CATALOG_BUCKET_MOVES', '1');
    const agent = await startPlacementAgentV1('multi-bucket-move');
    for (const kaNumber of [1, 2, 3, 4]) await upsertPlacementV1(agent, await placementAssetV1(kaNumber));
    const oneBucketHead = appliedPlacementHeadV1(agent)!;

    const applied = await upsertPlacementV1(agent, await placementAssetV1(5));

    const persistence = placementPersistenceV1(agent);
    const current = readCurrentAuthorCatalogScopeV1(persistence.inventory, PLACEMENT_SCOPE);
    expect(BigInt(current.bucketCount)).toBeGreaterThan(1n);
    // The move is one head and the placement the next.
    expect(applied).toMatchObject({
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(current),
      catalogVersion: String(BigInt(oneBucketHead.catalogVersion) + 2n),
      inventoryRowCount: '5',
    });
    expect(appliedPlacementHeadV1(agent)).toEqual(oneBucketHead);
    const buckets = await readAppliedCatalogRowIdentitiesV1({
      inventory: persistence.inventory,
      controlObjects: persistence.controlObjects,
      scope: current,
    });
    expect(buckets!.flatMap((bucket) => bucket.rows)).toHaveLength(5);
    // No bucket of the moved catalog is fuller than half a bucket was when it moved.
    expect(Math.max(...buckets!.map((bucket) => bucket.rows.length))).toBeLessThanOrEqual(3);
  });

  it('refuses a new asset in a full bucket, as before, while moves are off', async () => {
    const agent = await startPlacementAgentV1('multi-bucket-no-move');
    for (const kaNumber of [1, 2, 3, 4]) await upsertPlacementV1(agent, await placementAssetV1(kaNumber));

    await expect(upsertPlacementV1(agent, await placementAssetV1(5))).rejects.toMatchObject({ code: 'catalog-full' });
    expect(readCurrentAuthorCatalogScopeV1(placementPersistenceV1(agent).inventory, PLACEMENT_SCOPE))
      .toEqual(PLACEMENT_SCOPE);
  });
});

/** The applied one-bucket catalog's rows, moved to four buckets and applied as the lane's head. */
async function moveToFourBuckets(agent: DKGAgent) {
  const persistence = placementPersistenceV1(agent);
  const { history } = await appliedCatalogObjectsV1(agent);
  const moved = await produceAuthorCatalogCapacityTransitionV1({
    previousHead: history.previousHead,
    bucketCount: MOVED.bucketCount,
    rows: history.previousBucket!.payload.rows,
    issuedAt: String(Date.now()) as never,
    signer: { issuer: AUTHOR, signDigest: (digest) => AUTHOR_WALLET.signMessage(digest) },
  });
  // The store takes at most 16 objects a call.
  for (let index = 0; index < moved.stagedObjects.length; index += 16) {
    await persistence.controlObjects.stageVerifiedObjects(await Promise.all(
      moved.stagedObjects.slice(index, index + 16).map(async (envelope) => ({
        envelope,
        issuerSignature: await verifyControlEnvelopeIssuerSignatureV1(envelope),
      })),
    ));
  }
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(MOVED);
  persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
    catalogScopeDigest,
    authorAddress: AUTHOR,
    currentCatalogHeadDigest: moved.head.objectDigest,
    appliedInventoryDigest: computeRfc64CatalogAppliedInventoryDigestV1({
      catalogScopeDigest,
      rows: [],
      directory: moved.head.payload,
    }),
    catalogVersion: moved.head.payload.version,
    inventoryRowCount: moved.head.payload.totalRows,
    expectedCurrentCatalogHeadDigest: null,
    stageOnly: false,
  });
  return moved;
}
