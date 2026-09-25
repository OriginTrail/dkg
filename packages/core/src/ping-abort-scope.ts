/**
 * A probe owns these parent subscriptions only until its physical stream has
 * finished. Native AbortSignal.any chains retain dependency bookkeeping on a
 * long-lived parent; explicit disposal bounds it to currently active probes.
 */
export function pingAbortScope(...parents: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const subscriptions = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [parent, abort] of subscriptions) parent.removeEventListener('abort', abort);
    subscriptions.clear();
  };
  for (const parent of parents) {
    if (parent === undefined || subscriptions.has(parent)) continue;
    if (parent.aborted) {
      dispose();
      controller.abort(parent.reason);
      break;
    }
    const abort = () => {
      dispose();
      controller.abort(parent.reason);
    };
    subscriptions.set(parent, abort);
    parent.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
