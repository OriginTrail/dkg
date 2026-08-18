export const STORE_OPERATION_TIMEOUT_CODE = 'STORE_OPERATION_TIMEOUT' as const;

export interface StoreOperationTimeoutErrorOptions {
  backend: string;
  operation: string;
  timeoutMs?: number;
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
export class StoreOperationTimeoutError extends Error {
  readonly code = STORE_OPERATION_TIMEOUT_CODE;
  readonly retryable = true as const;
  readonly backend: string;
  readonly operation: string;
  readonly timeoutMs?: number;

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
  }
}

export function isStoreOperationTimeoutError(
  error: unknown,
): error is StoreOperationTimeoutError {
  if (error instanceof StoreOperationTimeoutError) return true;
  if (!error || typeof error !== 'object') return false;
  const shaped = error as { code?: unknown; retryable?: unknown };
  return shaped.code === STORE_OPERATION_TIMEOUT_CODE && shaped.retryable !== false;
}
