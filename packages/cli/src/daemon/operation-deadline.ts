// SPDX-License-Identifier: Apache-2.0

/** One deadline/cancellation owner; callers choose the operation and error. */
export async function runWithOperationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; timeoutError: () => Error; signal?: AbortSignal },
): Promise<T> {
  const controller = new AbortController();
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const abort = (reason: unknown) => { controller.abort(reason); rejectCancellation(reason); };
  const onAbort = () => abort(options.signal!.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => abort(options.timeoutError()), options.timeoutMs);
  timer.unref?.();
  try {
    return await Promise.race([cancellation, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
