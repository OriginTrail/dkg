import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATE1_FIXTURE,
  assertFixtureDerivations,
  expectedAppliedReadBack,
} from './model.js';

test('pinned Gate 1 fixture digests derive from exact deterministic bytes', () => {
  assert.doesNotThrow(() => assertFixtureDerivations());
  assert.equal(
    GATE1_FIXTURE.projectionNQuads.trimEnd().split('\n').length,
    GATE1_FIXTURE.positive.activatedQuadCount,
  );
  assert.equal(
    Buffer.byteLength(GATE1_FIXTURE.projectionNQuads),
    GATE1_FIXTURE.positive.contentByteLength,
  );
});
test('durable applied readback is derived from the exact head and count', () => {
  assert.deepEqual(expectedAppliedReadBack(GATE1_FIXTURE.positive), {
    appliedInventoryDigest: GATE1_FIXTURE.positive.head.appliedInventoryDigest,
    catalogVersion: '1',
    currentCatalogHeadDigest: GATE1_FIXTURE.positive.head.catalogHeadDigest,
    inventoryRowCount: 1,
  });
  assert.deepEqual(expectedAppliedReadBack(GATE1_FIXTURE.repairSuccessor), {
    appliedInventoryDigest: GATE1_FIXTURE.repairSuccessor.head.appliedInventoryDigest,
    catalogVersion: '2',
    currentCatalogHeadDigest: GATE1_FIXTURE.repairSuccessor.head.catalogHeadDigest,
    inventoryRowCount: 1,
  });
});
