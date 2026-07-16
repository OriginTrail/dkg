/**
 * Optional TripleStore operations that a decorator may expose even when its
 * wrapped backend cannot perform them.
 */
export type TripleStoreCapability =
  | 'update'
  | 'replaceGraph'
  | 'replaceGraphAndSubject';

/**
 * Typed signal that an optional store capability is unavailable.
 *
 * Decorators use this instead of a generic Error when their public method is
 * present but the wrapped store lacks the corresponding optional operation.
 * Callers may then choose a compatibility fallback without accidentally
 * treating a genuine execution failure as "unsupported". Implementations
 * must raise it before starting the operation so a caller can safely fall back.
 */
export class UnsupportedTripleStoreCapabilityError extends Error {
  readonly capability: TripleStoreCapability;
  readonly storeName: string;

  constructor(capability: TripleStoreCapability, storeName: string) {
    super(`${storeName}: inner store does not support ${capability}()`);
    this.name = 'UnsupportedTripleStoreCapabilityError';
    this.capability = capability;
    this.storeName = storeName;
  }
}

/**
 * A capability refusal is a clean preflight outcome — the contract requires it
 * to be raised before the operation starts — so decorators that treat a failed
 * `replaceGraph` as an indeterminate (possibly committed) mutation must exempt
 * it from cache-dirtying and reconcile flagging.
 */
export function isReplaceGraphCapabilityRefusal(error: unknown): boolean {
  return (
    error instanceof UnsupportedTripleStoreCapabilityError &&
    error.capability === 'replaceGraph'
  );
}

export function isReplaceGraphAndSubjectCapabilityRefusal(error: unknown): boolean {
  return (
    error instanceof UnsupportedTripleStoreCapabilityError &&
    error.capability === 'replaceGraphAndSubject'
  );
}
