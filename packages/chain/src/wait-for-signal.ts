// SPDX-License-Identifier: Apache-2.0

/** Waiter-local cancellation for a generic shared operation. */
function waiterAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Shared request waiter aborted'), { name: 'AbortError' });
}

export async function waitForSignal<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return shared;
  if (signal.aborted) throw waiterAbortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(waiterAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([shared, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
