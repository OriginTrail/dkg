import { isStoreOperationTimeoutError } from '@origintrail-official/dkg-storage';

export const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';
const EXACT_SWM_GRAPH_REPLACEMENT_STAGE =
  'atomic-exact-swm-graph-replacement' as const;

export interface PromoteReplaySafeErrorLike {
  readonly code: typeof PROMOTE_REPLAY_SAFE_ERROR_CODE;
  readonly stage: typeof EXACT_SWM_GRAPH_REPLACEMENT_STAGE;
  readonly cause: unknown;
}

/**
 * Producer-owned proof that retrying the complete promote attempt converges.
 * Consumers must never infer this disposition from a low-level store operation.
 */
export class PromoteReplaySafeError extends Error {
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
  }
}

/** Accept replay-safe certification across package and worker realms. */
export function isPromoteReplaySafeError(
  error: unknown,
): error is PromoteReplaySafeErrorLike {
  if (!error || typeof error !== 'object') return false;
  const shaped = error as Partial<PromoteReplaySafeErrorLike>;
  return shaped.code === PROMOTE_REPLAY_SAFE_ERROR_CODE
    && shaped.stage === EXACT_SWM_GRAPH_REPLACEMENT_STAGE
    && shaped.cause !== undefined;
}

/** Unwrap producer-certified replay safety at a package/worker boundary. */
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
