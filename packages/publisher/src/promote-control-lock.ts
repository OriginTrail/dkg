/**
 * The share queue's mutex, one per control graph in the process.
 *
 * Every public queue method runs its store work inside `withPromoteControlLock`, so a job cannot be read
 * stale and then written over a conflicting row, and the store calls made inside it are the ones the
 * share control path serves (OT-RFC-73 S1: each carries `controlStoreOptions('share', source)`). It is a
 * plain FIFO chain, not a lane scope: the lock sets no ambient store priority, and the worker wake the
 * queue raises from inside it (`notifyWorkAvailable`) runs with no lane scope at all, so the worker tick
 * inherits nothing from the queue or from the caller that enqueued.
 *
 * Keyed on the control-graph URI rather than the queue instance, so two queues over one graph (the
 * daemon's admission instance and its runtime instance, or a retention sweep) exclude each other.
 */
const mutationQueues = new Map<string, Promise<void>>();

/** Serializes control-graph mutations and consistent reads, including fallback replacements. */
export async function withPromoteControlLock<T>(graphUri: string, fn: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(graphUri) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(graphUri, next);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (mutationQueues.get(graphUri) === next) {
      mutationQueues.delete(graphUri);
    }
  }
}
