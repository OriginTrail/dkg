/**
 * THE one lazy abort boundary for read-only resolution work, INTERNAL (deliberately not
 * exported from the package barrel). It owns both the pre-start check and the listener
 * lifecycle: an already-aborted signal means the work is never launched, abort resolves `null`
 * (a deadline can never authorize anything), an absent signal runs the work unbounded, and the
 * abort listener is removed when the work wins so callers looping many candidates under one
 * shared controller do not accumulate listeners.
 */
export async function resolveWithinAbort<T>(
  work: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (!signal) return await work(undefined);
  if (signal.aborted) return null;
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work(signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
