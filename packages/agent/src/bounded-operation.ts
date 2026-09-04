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
 * started it receives a signal that aborts with either boundary. Late
 * fulfillment or rejection is consumed after timeout/abort so a non-cooperative
 * dependency cannot create an unhandled rejection.
 */
export function runBoundedOperation<T>(
  start: (signal: AbortSignal) => T | PromiseLike<T>,
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

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operationController = new AbortController();
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      complete();
    };
    const abortOperation = (reason: unknown) => {
      if (!operationController.signal.aborted) operationController.abort(reason);
    };
    const onAbort = () => {
      const error = createAbortError(signal?.reason);
      abortOperation(signal?.reason ?? error);
      finish(() => reject(error));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => {
        const error = new BoundedOperationTimeoutError(label, timeoutMs);
        abortOperation(error);
        finish(() => reject(error));
      },
      timeoutMs,
    );
    timer.unref?.();
    // Cover an abort between the initial check and listener registration
    // without starting dependency work.
    if (signal?.aborted) {
      onAbort();
      return;
    }

    let work: Promise<T>;
    try {
      work = Promise.resolve(start(operationController.signal));
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    work.catch(() => {
      // The boundary may already have rejected on timeout or caller abort.
    });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
