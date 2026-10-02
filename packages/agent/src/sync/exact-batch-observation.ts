/** Optional instrumentation never changes transport/verification/commit outcomes. */
export function observeExactBatch(callback: (() => unknown) | undefined): void {
  try {
    const result = callback?.();
    if (result !== null && result !== undefined
      && (typeof result === 'object' || typeof result === 'function')
      && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
    }
  } catch { /* observation only */ }
}
