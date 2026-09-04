import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1,
  planPrivateCatalogConstructionV1,
} from './batch-plan.ts';

test('one asset keeps one production successor and needs no fixture predecessor', () => {
  assert.deepEqual(planPrivateCatalogConstructionV1(1), {
    assetCount: 1,
    fixturePredecessorAssetCount: 0,
    fixtureStageBatchSize: PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1,
    fixtureStageBatchSizes: [],
    productionSuccessorCount: 1,
    productionSuccessorExactSetSizes: [1],
  });
});

test('500 assets use bounded linear fixture batches and one exact final successor', () => {
  const plan = planPrivateCatalogConstructionV1(500);
  assert.deepEqual(plan.fixtureStageBatchSizes, [64, 64, 64, 64, 64, 64, 64, 51]);
  assert.equal(plan.fixtureStageBatchSizes.reduce((sum, size) => sum + size, 0), 499);
  assert.ok(plan.fixtureStageBatchSizes.every((size) => size <= 64));
  assert.equal(plan.productionSuccessorCount, 1);
  assert.deepEqual(plan.productionSuccessorExactSetSizes, [500]);
});

test('batch plan is deterministic at exact and partial boundaries', () => {
  assert.deepEqual(planPrivateCatalogConstructionV1(65, 16), {
    assetCount: 65,
    fixturePredecessorAssetCount: 64,
    fixtureStageBatchSize: 16,
    fixtureStageBatchSizes: [16, 16, 16, 16],
    productionSuccessorCount: 1,
    productionSuccessorExactSetSizes: [65],
  });
  assert.deepEqual(planPrivateCatalogConstructionV1(66, 16).fixtureStageBatchSizes,
    [16, 16, 16, 16, 1]);
});

test('batch plan rejects counts outside the release gate bounds', () => {
  for (const count of [0, -1, 501, 1.5, Number.NaN]) {
    assert.throws(() => planPrivateCatalogConstructionV1(count), /assetCount/u);
  }
  for (const size of [0, 129, 1.5]) {
    assert.throws(() => planPrivateCatalogConstructionV1(32, size), /fixtureStageBatchSize/u);
  }
});
