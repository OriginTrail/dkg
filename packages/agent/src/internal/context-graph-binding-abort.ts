// SPDX-License-Identifier: Apache-2.0



export function contextGraphBindingAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal.reason ?? 'Context Graph binding resolution aborted'));
  error.name = 'AbortError';
  return error;
}

export function raceContextGraphBindingAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(contextGraphBindingAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(contextGraphBindingAbortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
