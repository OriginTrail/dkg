/**
 * Canonical representation of a voluntary local shared-memory yield.
 *
 * The discriminator and the affected snapshot-plane count intentionally live
 * in one value.  Keeping them together prevents consumers from manufacturing
 * contradictory states such as a local-yield reason with a zero/missing
 * incomplete count.
 */
declare const positiveSnapshotPlaneCount: unique symbol;
export type PositiveSnapshotPlaneCount = number & {
  readonly [positiveSnapshotPlaneCount]: true;
};

export interface SharedMemoryLocalYield {
  readonly kind: 'local-budget-yield';
  readonly snapshotPlaneIncomplete: PositiveSnapshotPlaneCount;
}

/** One snapshot walk yielded before its remaining work was admitted. */
export function sharedMemoryLocalYield(
  snapshotPlaneIncomplete = 1,
): SharedMemoryLocalYield {
  if (!Number.isSafeInteger(snapshotPlaneIncomplete) || snapshotPlaneIncomplete < 1) {
    throw new RangeError('snapshotPlaneIncomplete must be a positive safe integer');
  }
  return {
    kind: 'local-budget-yield',
    snapshotPlaneIncomplete: snapshotPlaneIncomplete as PositiveSnapshotPlaneCount,
  };
}

/** Merge aggregate local-yield evidence without separating reason and count. */
export function mergeSharedMemoryLocalYield(
  a: SharedMemoryLocalYield | undefined,
  b: SharedMemoryLocalYield | undefined,
): SharedMemoryLocalYield | undefined {
  if (!a) return b;
  if (!b) return a;
  return sharedMemoryLocalYield(
    a.snapshotPlaneIncomplete + b.snapshotPlaneIncomplete,
  );
}
