// SPDX-License-Identifier: Apache-2.0

/** A timeout raised by {@link runBoundedOperation}. */
export class BoundedOperationTimeoutError extends Error {
  readonly code = 'BOUNDED_OPERATION_TIMEOUT';

  constructor(
    readonly operationLabel: string,
    readonly timeoutMs: number,
  ) {
    super(`${operationLabel} timed out after ${timeoutMs}ms`);
    this.name = 'BoundedOperationTimeoutError';
  }
}

export function isBoundedOperationTimeoutError(
  error: unknown,
): error is BoundedOperationTimeoutError {
  return error instanceof BoundedOperationTimeoutError
    || (
      error instanceof Error
      && (error as Error & { code?: unknown }).code === 'BOUNDED_OPERATION_TIMEOUT'
    );
}

export function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const error = new Error(reason.message || 'aborted');
    error.name = 'AbortError';
    (error as Error & { cause?: unknown }).cause = reason;
    return error;
  }
  const error = new Error(typeof reason === 'string' ? reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Run one lazily-started operation with a caller-abort and deadline boundary.
 *
 * The operation is not started when the caller is already aborted. Once it is
 * started, late fulfillment or rejection is consumed after timeout/abort so a
 * non-cooperative dependency cannot create an unhandled rejection.
 */
export function runBoundedOperation<T>(
  start: () => T | PromiseLike<T>,
  options: {
    timeoutMs: number;
    label: string;
    signal?: AbortSignal;
  },
): Promise<T> {
  const { timeoutMs, label, signal } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError('timeoutMs must be a positive finite number'));
  }
  if (signal?.aborted) return Promise.reject(createAbortError(signal.reason));

  let work: Promise<T>;
  try {
    work = Promise.resolve(start());
  } catch (error) {
    return Promise.reject(error);
  }
  work.catch(() => {
    // The boundary may already have rejected on timeout or caller abort.
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(createAbortError(signal?.reason)));

    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(new BoundedOperationTimeoutError(label, timeoutMs))),
      timeoutMs,
    );
    timer.unref?.();
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    // Cover an abort between the initial check and listener registration.
    if (signal?.aborted) onAbort();
  });
}
