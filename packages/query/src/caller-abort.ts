/** Normalize an AbortSignal reason without losing Error identity. */
export function callerAbortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

/**
 * Race shared work against one caller's cancellation without cancelling the
 * shared operation. The listener is removed when either side settles.
 */
export function raceAgainstCallerAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(callerAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(callerAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
