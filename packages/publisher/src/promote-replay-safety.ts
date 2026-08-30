import { isStoreOperationTimeoutError } from '@origintrail-official/dkg-storage';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';
const EXACT_SWM_GRAPH_REPLACEMENT_STAGE =
  'atomic-exact-swm-graph-replacement' as const;

const certifiedReplaySafeErrors = new WeakSet<object>();

export interface PromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

/**
 * Producer-owned proof that retrying the complete promote attempt converges.
 * Consumers must never infer this disposition from a low-level store operation.
 */
class PromoteReplaySafeError extends Error {
  override readonly name = 'PromoteReplaySafeError';
  readonly code = PROMOTE_REPLAY_SAFE_ERROR_CODE;
  readonly stage = EXACT_SWM_GRAPH_REPLACEMENT_STAGE;
  override readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Promote may be retried after ${EXACT_SWM_GRAPH_REPLACEMENT_STAGE}: ${detail}`,
      { cause },
    );
    this.cause = cause;
    certifiedReplaySafeErrors.add(this);
  }
}

/** Consume replay-safe certification without exposing a forgeable producer API. */
export function isPromoteReplaySafeError(
  error: unknown,
): error is Error & { readonly cause: unknown } {
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

/** Unwrap producer-certified replay safety at the publisher/consumer boundary. */
export function unwrapPromoteReplaySafeError(error: unknown): unknown {
  return isPromoteReplaySafeError(error) ? error.cause : error;
}

/**
 * The publisher owns the exact graph and frozen payload at this call site, so
 * an indeterminate atomic replace has only the permitted old-or-new outcomes.
 */
export function classifyExactSwmGraphReplaceFailure(error: unknown): unknown {
  return isStoreOperationTimeoutError(error)
    && error.outcome === 'indeterminate'
    && error.storeOperation === 'replaceGraph'
    ? new PromoteReplaySafeError(error)
    : error;
}
