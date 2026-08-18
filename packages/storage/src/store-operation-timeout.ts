export const STORE_OPERATION_TIMEOUT_CODE = 'STORE_OPERATION_TIMEOUT' as const;

export type StoreOperationOutcome = 'not_started' | 'indeterminate';

/**
 * Structural timeout shape accepted across package/prototype boundaries.
 * Only `code` is required; every other field is optional because the guard
 * deliberately supports older or re-wrapped errors that retained the stable
 * code but not the concrete class prototype or metadata.
 */
export interface StoreOperationTimeoutErrorLike {
  code: typeof STORE_OPERATION_TIMEOUT_CODE;
  retryable?: true;
  message?: string;
  backend?: string;
  operation?: string;
  timeoutMs?: number;
  outcome?: StoreOperationOutcome;
}

export interface StoreOperationTimeoutErrorOptions {
  backend: string;
  operation: string;
  timeoutMs?: number;
  outcome?: StoreOperationOutcome;
  message?: string;
  cause?: unknown;
}

/**
 * Typed retryable deadline failure emitted by triple-store adapters.
 *
 * `name` intentionally remains `TimeoutError` for compatibility with callers
 * that already recognize the platform timeout shape; `code` is the stable DKG
 * contract used by HTTP routes and async job classifiers.
 */
export class StoreOperationTimeoutError extends Error implements StoreOperationTimeoutErrorLike {
  readonly code = STORE_OPERATION_TIMEOUT_CODE;
  readonly retryable = true as const;
  readonly backend: string;
  readonly operation: string;
  readonly timeoutMs?: number;
  readonly outcome: StoreOperationOutcome;

  constructor(options: StoreOperationTimeoutErrorOptions) {
    const suffix = options.timeoutMs === undefined ? '' : ` after ${options.timeoutMs}ms`;
    super(
      options.message
        ?? `${options.backend} ${options.operation} exceeded its store deadline${suffix}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'TimeoutError';
    this.backend = options.backend;
    this.operation = options.operation;
    this.timeoutMs = options.timeoutMs;
    this.outcome = options.outcome ?? 'indeterminate';
  }
}

export function isStoreOperationTimeoutError(
  error: unknown,
): error is StoreOperationTimeoutErrorLike {
  if (!error || typeof error !== 'object') return false;
  const shaped = error as Record<string, unknown>;
  return shaped.code === STORE_OPERATION_TIMEOUT_CODE
    && (shaped.retryable === undefined || shaped.retryable === true)
    && (shaped.message === undefined || typeof shaped.message === 'string')
    && (shaped.backend === undefined || typeof shaped.backend === 'string')
    && (shaped.operation === undefined || typeof shaped.operation === 'string')
    && (shaped.timeoutMs === undefined || (
      typeof shaped.timeoutMs === 'number' && Number.isFinite(shaped.timeoutMs)
    ))
    && (
      shaped.outcome === undefined
      || shaped.outcome === 'not_started'
      || shaped.outcome === 'indeterminate'
    );
}
