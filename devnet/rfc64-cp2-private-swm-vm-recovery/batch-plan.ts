export const PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1 = 64;

export interface PrivateCatalogConstructionPlanV1 {
  readonly assetCount: number;
  readonly fixturePredecessorAssetCount: number;
  readonly fixtureStageBatchSize: number;
  readonly fixtureStageBatchSizes: readonly number[];
  readonly productionSuccessorCount: 1;
  readonly productionSuccessorExactSetSizes: readonly [number];
}

/**
 * Keep the scale gate linear without changing the RFC-64 one-row ordinary
 * successor rule. A test-only predecessor contains all but the last row. One
 * production exact-set successor then adds the last row and commits the exact
 * requested final set.
 */
export function planPrivateCatalogConstructionV1(
  assetCount: number,
  fixtureStageBatchSize = PRIVATE_CATALOG_FIXTURE_STAGE_BATCH_SIZE_V1,
): Readonly<PrivateCatalogConstructionPlanV1> {
  assertBoundedPositiveInteger(assetCount, 500, 'assetCount');
  assertBoundedPositiveInteger(fixtureStageBatchSize, 128, 'fixtureStageBatchSize');
  const fixturePredecessorAssetCount = Math.max(0, assetCount - 1);
  const fixtureStageBatchSizes: number[] = [];
  let remaining = fixturePredecessorAssetCount;
  while (remaining > 0) {
    const size = Math.min(remaining, fixtureStageBatchSize);
    fixtureStageBatchSizes.push(size);
    remaining -= size;
  }
  return Object.freeze({
    assetCount,
    fixturePredecessorAssetCount,
    fixtureStageBatchSize,
    fixtureStageBatchSizes: Object.freeze(fixtureStageBatchSizes),
    productionSuccessorCount: 1,
    productionSuccessorExactSetSizes: Object.freeze([assetCount]) as readonly [number],
  });
}

function assertBoundedPositiveInteger(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  }
}
