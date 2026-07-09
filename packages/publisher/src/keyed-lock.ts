/**
 * Gate-based multi-key lock — the single canonical implementation of this concurrency
 * idiom in the publisher package. The `withWriteLocks` methods in `dkg-publisher.ts`
 * (publish/`share`/CAS) and `workspace-handler.ts` (workspace writes) and the
 * agents/_meta retention path all delegate here, each supplying its own lock `Map`, so
 * there is ONE implementation to audit rather than per-module copies.
 *
 * Algorithm: sort + dedupe the keys, snapshot the predecessor gate per key, install
 * ONE shared gate for every key SYNCHRONOUSLY (before any `await`, so there is no
 * partial-hold-and-wait → deadlock-free even for overlapping / cyclic key sets),
 * await the predecessors, run `fn` while holding all keys, then release the gate and
 * evict the keys it still owns (skipping any a later call has since overwritten).
 * Two calls sharing ANY key serialize; calls over disjoint key sets run concurrently.
 *
 * The caller supplies the lock `Map` (per-instance or module-level) so the lock
 * domain is explicit. Entries self-evict once a key's chain drains, so the map stays
 * bounded. The gate is resolve-only (never rejects), so a failing `fn` propagates to
 * its own caller without poisoning successors.
 */
export async function withKeyedLocks<T>(
  lockMap: Map<string, Promise<void>>,
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  const predecessor = Promise.all(uniqueKeys.map((k) => lockMap.get(k) ?? Promise.resolve()));
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  for (const k of uniqueKeys) lockMap.set(k, gate);
  await predecessor;
  try {
    return await fn();
  } finally {
    release();
    for (const k of uniqueKeys) {
      if (lockMap.get(k) === gate) lockMap.delete(k);
    }
  }
}
