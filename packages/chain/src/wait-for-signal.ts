// SPDX-License-Identifier: Apache-2.0

/** Waiter-local cancellation for a generic shared operation. */
export async function waitForSignal<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return shared;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('Shared request waiter aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([shared, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
