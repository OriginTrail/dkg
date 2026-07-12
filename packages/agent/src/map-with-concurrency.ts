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
