import {
  isStoreOperationTimeoutError,
  type StoreOperationTimeoutErrorLike,
} from '@origintrail-official/dkg-storage';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';
const promoteReplaySafeBrand: unique symbol = Symbol('promote-replay-safe');

type PromoteReplaySafeTimeoutError = StoreOperationTimeoutErrorLike & {
  readonly [promoteReplaySafeBrand]: true;
};

export interface PromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

/** Consume replay-safe certification without replacing the storage error contract. */
export function isPromoteReplaySafeError(
  error: unknown,
): error is PromoteReplaySafeTimeoutError {
  try {
    return isStoreOperationTimeoutError(error)
      && (error as PromoteReplaySafeTimeoutError)[promoteReplaySafeBrand] === true;
  } catch {
    return false;
  }
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
 * The publisher owns the exact graph and frozen payload at this call site, so
 * an indeterminate atomic replace has only the permitted old-or-new outcomes.
 */
export function classifyExactSwmGraphReplaceFailure(error: unknown): unknown {
  if (isStoreOperationTimeoutError(error)
    && error.outcome === 'indeterminate'
    && (
      error.storeOperation === 'replaceGraph'
      || error.storeOperation === 'replaceGraphAndSubject'
    )) {
    try {
      Object.defineProperty(error, promoteReplaySafeBrand, {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    } catch {
      // Non-extensible or hostile error objects remain uncertified (fail closed).
    }
  }
  return error;
}
