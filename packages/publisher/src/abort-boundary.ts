/**
 * r4 (3877695872) — THE one lazy abort boundary for read-only resolution work, INTERNAL
 * (deliberately not exported from the package barrel). Owning both the pre-start check and the
 * listener lifecycle here is the point: an already-aborted signal must mean the work is never
 * launched (an eager-argument variant of this helper launched it anyway), abort resolves `null`
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
