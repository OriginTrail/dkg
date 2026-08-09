declare const STORE_CONTROL_BARRIER_RESULT_V1: unique symbol;

/**
 * Runtime coalescing identity bound to one transition-result type.
 *
 * Typed barriers coalesce by key object identity, not by the purpose string.
 * Reusing one key therefore also reuses its `T`; a separately created key with
 * the same diagnostic purpose is a distinct transition and cannot share the
 * first key's promise.
 */
export interface StoreControlBarrierKeyV1<T> {
  readonly purpose: string;
  readonly [STORE_CONTROL_BARRIER_RESULT_V1]: (value: T) => T;
}

export function createStoreControlBarrierKeyV1<T>(
  purpose: string,
): StoreControlBarrierKeyV1<T> {
  if (purpose.length === 0) throw new Error('store control barrier purpose must not be empty');
  // The private required brand prevents callers from forging a typed key with
  // a plain object. It has no runtime role: identity is the coalescing key.
  return Object.freeze({ purpose }) as StoreControlBarrierKeyV1<T>;
}
