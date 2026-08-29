import { isStoreOperationTimeoutError } from '@origintrail-official/dkg-storage';

export const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';

/**
 * Producer-owned proof that retrying the complete promote attempt converges.
 * Consumers must never infer this disposition from a low-level store operation.
 */
export class PromoteReplaySafeError extends Error {
  override readonly name = 'PromoteReplaySafeError';
  readonly code = PROMOTE_REPLAY_SAFE_ERROR_CODE;

  constructor(
    readonly stage: 'atomic-exact-swm-graph-replacement',
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Promote may be retried after ${stage}: ${detail}`, { cause });
  }
}

/**
 * The publisher owns the exact graph and frozen payload at this call site, so
 * an indeterminate atomic replace has only the permitted old-or-new outcomes.
 */
export function classifyExactSwmGraphReplaceFailure(error: unknown): unknown {
  return isStoreOperationTimeoutError(error)
    && error.outcome === 'indeterminate'
    && error.storeOperation === 'replaceGraph'
    ? new PromoteReplaySafeError('atomic-exact-swm-graph-replacement', error)
    : error;
}
