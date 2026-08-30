// SPDX-License-Identifier: Apache-2.0

/** One cancellation policy for RFC-64 work that waits on non-cooperative promises. */

function abortErrorV1(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
}

export function throwIfRfc64AbortedV1(
  signal: AbortSignal | undefined,
  fallbackMessage = 'RFC-64 operation aborted',
): void {
  if (signal?.aborted) throw abortErrorV1(signal, fallbackMessage);
}

export function raceRfc64AgainstAbortV1<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  fallbackMessage = 'RFC-64 operation aborted',
): Promise<T> {
  if (signal === undefined) return work;
  throwIfRfc64AbortedV1(signal, fallbackMessage);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortErrorV1(signal, fallbackMessage));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
