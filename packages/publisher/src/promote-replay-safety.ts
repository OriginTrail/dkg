import {
  isStoreOperationTimeoutError,
  type StoreOperationTimeoutErrorLike,
} from '@origintrail-official/dkg-storage';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';

const certifiedReplaySafeErrors = new WeakSet<object>();

export interface PromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

/** Consume replay-safe certification without replacing the storage error contract. */
export function isPromoteReplaySafeError(
  error: unknown,
): error is StoreOperationTimeoutErrorLike {
  return error !== null
    && typeof error === 'object'
    && certifiedReplaySafeErrors.has(error);
}

/** Return a bounded identity only for producer-certified replay-safe errors. */
export function getPromoteReplaySafeErrorDiagnostic(
  error: unknown,
): PromoteReplaySafeErrorDiagnostic | undefined {
  return isPromoteReplaySafeError(error)
    ? { name: 'PromoteReplaySafeError', code: PROMOTE_REPLAY_SAFE_ERROR_CODE }
    : undefined;
}

/**
 * Compatibility helper retained for consumers written against the earlier
 * wrapper boundary. Certified failures now retain their original identity.
 */
export function unwrapPromoteReplaySafeError(error: unknown): unknown {
  return error;
}

/**
 * The publisher owns the exact graph and frozen payload at this call site, so
 * an indeterminate atomic replace has only the permitted old-or-new outcomes.
 */
export function classifyExactSwmGraphReplaceFailure(error: unknown): unknown {
  if (isStoreOperationTimeoutError(error)
    && error.outcome === 'indeterminate'
    && error.storeOperation === 'replaceGraph') {
    certifiedReplaySafeErrors.add(error);
  }
  return error;
}
