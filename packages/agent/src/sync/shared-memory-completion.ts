/**
 * Canonical representation of a voluntary local shared-memory yield.
 *
 * This is deliberately plane-neutral: metadata, data, and snapshot work can
 * all exhaust the same local admission budget. Plane-specific incomplete
 * counts belong to the layer that knows which work remained.
 */
export interface SharedMemoryLocalYield {
  readonly kind: 'local-budget-yield';
}

/** The shared-memory requester voluntarily yielded to its local scheduler. */
export function sharedMemoryLocalYield(): SharedMemoryLocalYield {
  return { kind: 'local-budget-yield' };
}

/** Merge aggregate local-yield evidence. */
export function mergeSharedMemoryLocalYield(
  a: SharedMemoryLocalYield | undefined,
  b: SharedMemoryLocalYield | undefined,
): SharedMemoryLocalYield | undefined {
  return a ?? b;
}
