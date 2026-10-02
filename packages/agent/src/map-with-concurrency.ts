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
 * predicate immediately, aborts active siblings and prevents queued callbacks
 * from starting. Work already in flight is observed so a non-cooperative
 * callback cannot create an unhandled rejection.
 */
export async function everyWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<boolean>,
  externalSignal?: AbortSignal,
): Promise<boolean> {
  externalSignal?.throwIfAborted();
  if (items.length === 0) return true;
  const workerCount = !Number.isInteger(limit) || limit <= 0 || limit >= items.length
    ? items.length
    : limit;
  const stop = new AbortController();
  const signal = externalSignal === undefined
    ? stop.signal
    : AbortSignal.any([externalSignal, stop.signal]);
  let nextIndex = 0;
  let settled = false;

  return new Promise<boolean>((resolve, reject) => {
    let remainingWorkers = workerCount;
    let onExternalAbort: (() => void) | undefined;
    const cleanup = () => {
      if (onExternalAbort !== undefined) {
        externalSignal!.removeEventListener('abort', onExternalAbort);
      }
    };
    const settleFalse = () => {
      if (settled) return;
      settled = true;
      stop.abort(new Error('Bounded every predicate returned false'));
      cleanup();
      resolve(false);
    };
    const settleError = (error: unknown) => {
      if (settled) return;
      settled = true;
      stop.abort(error);
      cleanup();
      reject(error);
    };
    if (externalSignal !== undefined) {
      onExternalAbort = () => settleError(
        externalSignal.reason ?? Object.assign(new Error('Bounded every aborted'), { name: 'AbortError' }),
      );
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      if (externalSignal.aborted) onExternalAbort();
    }
    const settleWorker = () => {
      remainingWorkers -= 1;
      if (remainingWorkers === 0 && !settled) {
        settled = true;
        cleanup();
        resolve(true);
      }
    };
    const worker = async () => {
      try {
        while (!settled) {
          const index = nextIndex++;
          if (index >= items.length) return;
          if (!(await fn(items[index]!, index, signal))) {
            settleFalse();
            return;
          }
        }
      } catch (error) {
        settleError(error);
      } finally {
        settleWorker();
      }
    };
    if (!settled) {
      for (let index = 0; index < workerCount; index += 1) void worker();
    }
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
