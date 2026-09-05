import {
  isStoreOperationTimeoutError,
} from '@origintrail-official/dkg-storage';
import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE' as const;
const promoteReplaySafeBrand: unique symbol = Symbol('promote-replay-safe');

/**
 * Typed failure emitted only by concrete promote preparation/commit boundaries
 * whose replay contract is known. The original error remains available as the
 * standard `cause`; callers cannot accidentally turn an arbitrary callback
 * into a replay-safe operation through a generic public runner.
 */
export class PromoteReplaySafeError extends Error {
  readonly code = PROMOTE_REPLAY_SAFE_ERROR_CODE;
  readonly [promoteReplaySafeBrand] = true;

  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
    this.name = 'PromoteReplaySafeError';
  }
}

export interface PromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

/** Consume replay-safe certification without replacing the underlying error contract. */
export function isPromoteReplaySafeError(
  error: unknown,
): error is PromoteReplaySafeError {
  try {
    return error !== null
      && (typeof error === 'object' || typeof error === 'function')
      && (error as PromoteReplaySafeError)[promoteReplaySafeBrand] === true;
  } catch {
    return false;
  }
}

function certifyPromoteReplaySafe(error: unknown): PromoteReplaySafeError {
  return isPromoteReplaySafeError(error) ? error : new PromoteReplaySafeError(error);
}

/**
 * Certify a chain transport outage only at the publisher-owned seam before
 * any SWM mutation has begun. The worker consumes the brand and never infers
 * replay safety from diagnostic stage strings.
 */
export function classifyPreCommitChainRpcFailure(error: unknown): unknown {
  return isChainRpcTransportError(error)
    ? certifyPromoteReplaySafe(error)
    : error;
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
    && error.storeOperation === 'replaceGraph') {
    return certifyPromoteReplaySafe(error);
  }
  return error;
}
