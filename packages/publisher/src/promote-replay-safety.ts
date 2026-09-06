import {
  isStoreOperationTimeoutError,
  type StoreOperationTimeoutErrorLike,
} from '@origintrail-official/dkg-storage';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';
const promoteReplaySafeBrand: unique symbol = Symbol('promote-replay-safe');

export const PROMOTE_RETRYABLE_FAILURE_CODE = 'PROMOTE_RETRYABLE_FAILURE' as const;
export const PROMOTE_RETRYABLE_FAILURE_ERROR_NAME = 'PromoteRetryableFailureError' as const;
export const PROMOTE_POST_COMMIT_FAILURE_CODE = 'PROMOTE_POST_COMMIT_FAILURE' as const;
export const PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME = 'PromotePostCommitFailureError' as const;

type PromoteReplaySafeTimeoutError = StoreOperationTimeoutErrorLike & {
  readonly [promoteReplaySafeBrand]: true;
};

export interface PromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

/**
 * Queue-owned retry disposition for transient failures that occur before a
 * promote can commit. The exact structural code intentionally survives Error
 * serialization and package/bundle boundaries.
 */
export interface PromoteRetryableFailureMarker {
  readonly code: typeof PROMOTE_RETRYABLE_FAILURE_CODE;
}

export interface PromoteRetryableFailureDiagnostic {
  readonly name: typeof PROMOTE_RETRYABLE_FAILURE_ERROR_NAME;
  readonly code: typeof PROMOTE_RETRYABLE_FAILURE_CODE;
}

export interface PromotePostCommitFailureDiagnostic {
  readonly name: typeof PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME;
  readonly code: typeof PROMOTE_POST_COMMIT_FAILURE_CODE;
}

export type PromoteFailureDiagnostic =
  | PromoteReplaySafeErrorDiagnostic
  | PromoteRetryableFailureDiagnostic
  | PromotePostCommitFailureDiagnostic;

export type PromoteFailureDisposition =
  | {
      readonly classification: 'transient';
      readonly retryable: true;
      readonly diagnostic: PromoteReplaySafeErrorDiagnostic | PromoteRetryableFailureDiagnostic;
    }
  | {
      readonly classification: 'fatal';
      readonly retryable: false;
      readonly diagnostic: PromotePostCommitFailureDiagnostic;
    };

class PromoteRetryableFailureError extends Error implements PromoteRetryableFailureMarker {
  readonly code = PROMOTE_RETRYABLE_FAILURE_CODE;

  constructor(cause: unknown) {
    super('A promote prerequisite is temporarily unavailable', { cause });
    this.name = PROMOTE_RETRYABLE_FAILURE_ERROR_NAME;
  }
}

class PromotePostCommitFailureError extends Error {
  readonly code = PROMOTE_POST_COMMIT_FAILURE_CODE;

  constructor(cause: unknown) {
    super('A promote post-commit step failed after Shared Memory was committed', { cause });
    this.name = PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME;
  }
}

/** Translate a domain failure at the promote boundary into the queue contract. */
export function createPromoteRetryableFailure(
  cause: unknown,
): Error & PromoteRetryableFailureMarker {
  return new PromoteRetryableFailureError(cause);
}

/** Mark an unsafe finalization failure or a post-commit side effect as terminal. */
export function createPromotePostCommitFailure(cause: unknown): Error {
  return new PromotePostCommitFailureError(cause);
}

/**
 * Only for the publisher's idempotent durable finalization (not observer hooks
 * or gossip). A storage operation proven not to have started can re-enter the
 * same immutable operation and repair its tail. Unknown/indeterminate outcomes
 * and unrelated retry markers cannot earn that permission here.
 */
export async function runPromoteCommittedFinalization(
  finalize: () => Promise<void>,
): Promise<void> {
  try {
    await finalize();
  } catch (error) {
    if (isStoreOperationTimeoutError(error) && error.outcome === 'not_started') throw error;
    throw createPromotePostCommitFailure(error);
  }
}

/** Structural so the disposition survives durable/bundle boundaries. */
export function isPromoteRetryableFailure(
  error: unknown,
): error is PromoteRetryableFailureMarker {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return false;
  }
  try {
    return Reflect.get(error, 'code') === PROMOTE_RETRYABLE_FAILURE_CODE;
  } catch {
    return false;
  }
}

/** Return a fixed, privacy-bounded identity for the generic queue marker. */
export function getPromoteRetryableFailureDiagnostic(
  error: unknown,
): PromoteRetryableFailureDiagnostic | undefined {
  return isPromoteRetryableFailure(error)
    ? {
        name: PROMOTE_RETRYABLE_FAILURE_ERROR_NAME,
        code: PROMOTE_RETRYABLE_FAILURE_CODE,
      }
    : undefined;
}

function getPromotePostCommitFailureDiagnostic(
  error: unknown,
): PromotePostCommitFailureDiagnostic | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return undefined;
  }
  try {
    return Reflect.get(error, 'code') === PROMOTE_POST_COMMIT_FAILURE_CODE
      ? {
          name: PROMOTE_POST_COMMIT_FAILURE_ERROR_NAME,
          code: PROMOTE_POST_COMMIT_FAILURE_CODE,
        }
      : undefined;
  } catch {
    return undefined;
  }
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
 * The single public consumer contract for producer-certified promote
 * failures. Internal marker families stay distinct, while queue disposition
 * and privacy-bounded diagnostics are read together exactly once.
 */
export function getPromoteFailureDisposition(
  error: unknown,
): PromoteFailureDisposition | undefined {
  const postCommitDiagnostic = getPromotePostCommitFailureDiagnostic(error);
  if (postCommitDiagnostic) {
    return {
      classification: 'fatal',
      retryable: false,
      diagnostic: postCommitDiagnostic,
    };
  }
  const prerequisiteDiagnostic = getPromoteRetryableFailureDiagnostic(error);
  if (prerequisiteDiagnostic) {
    return {
      classification: 'transient',
      retryable: true,
      diagnostic: prerequisiteDiagnostic,
    };
  }
  const replaySafeDiagnostic = getPromoteReplaySafeErrorDiagnostic(error);
  return replaySafeDiagnostic
    ? {
        classification: 'transient',
        retryable: true,
        diagnostic: replaySafeDiagnostic,
      }
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
