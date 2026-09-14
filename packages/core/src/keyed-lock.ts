/**
 * Run `fn` while holding every requested key in a caller-owned lock domain.
 *
 * Keys are deduplicated and sorted, then one shared gate is installed for all
 * of them before awaiting any predecessor. That makes overlapping multi-key
 * calls deadlock-free while allowing disjoint calls to proceed concurrently.
 * Entries self-evict when their chain drains, and a rejected callback cannot
 * poison later callers because the coordination gate only resolves.
 */
export async function withKeyedLocks<T>(
  lockMap: Map<string, Promise<void>>,
  keys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  const predecessor = Promise.all(
    uniqueKeys.map((key) => lockMap.get(key) ?? Promise.resolve()),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const key of uniqueKeys) lockMap.set(key, gate);

  await predecessor;
  try {
    return await fn();
  } finally {
    release();
    for (const key of uniqueKeys) {
      if (lockMap.get(key) === gate) lockMap.delete(key);
    }
  }
}
