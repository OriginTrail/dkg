// Bounded-concurrency ordered map shared by agent subsystems. Keeping this
// neutral avoids coupling p2p retry scheduling to the sync directory.

/**
 * Like `Promise.all(items.map(fn))` but with at most `limit` callbacks in
 * flight. Results preserve input order. A rejecting callback rejects the call.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (!Number.isInteger(limit) || limit <= 0 || limit >= items.length) {
    return Promise.all(items.map((item, i) => fn(item, i)));
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * Bounded concurrent `every`. The first false result or rejection settles the
 * predicate immediately and prevents queued callbacks from starting. Work
 * already in flight is observed so a non-cooperative callback cannot create an
 * unhandled rejection; callers can abort those siblings from inside `fn`.
 */
export async function everyWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<boolean>,
): Promise<boolean> {
  if (items.length === 0) return true;
  const workerCount = !Number.isInteger(limit) || limit <= 0 || limit >= items.length
    ? items.length
    : limit;
  let nextIndex = 0;
  let stopped = false;

  return new Promise<boolean>((resolve, reject) => {
    let remainingWorkers = workerCount;
    const settleWorker = () => {
      remainingWorkers -= 1;
      if (remainingWorkers === 0 && !stopped) {
        stopped = true;
        resolve(true);
      }
    };
    const worker = async () => {
      try {
        while (!stopped) {
          const index = nextIndex++;
          if (index >= items.length) return;
          if (!(await fn(items[index]!, index))) {
            if (!stopped) {
              stopped = true;
              resolve(false);
            }
            return;
          }
        }
      } catch (error) {
        if (!stopped) {
          stopped = true;
          reject(error);
        }
      } finally {
        settleWorker();
      }
    };
    for (let index = 0; index < workerCount; index += 1) void worker();
  });
}

/** Bounded counterpart to Promise.allSettled; results preserve input order. */
export async function mapWithConcurrencySettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return Object.freeze({
        status: 'fulfilled' as const,
        value: await fn(item, index),
      });
    } catch (reason) {
      return Object.freeze({ status: 'rejected' as const, reason });
    }
  });
}
