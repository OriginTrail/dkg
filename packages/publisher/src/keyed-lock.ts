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

/**
 * The per-KA SWM write-lock key.
 *
 * EVERY path that writes a shared-working-memory per-KA layer graph must
 * serialize on this exact key, against the SAME lock map (the agent owns it and
 * injects it into SharedMemoryHandler). Live gossip already does; the public
 * catch-up materializer must too, or this interleaving destroys data:
 *
 *   1. catch-up observes the KA's assertion graph is absent
 *   2. gossip acquires its lock and commits a newer, richer graph
 *   3. catch-up replaces that graph with its older verified snapshot
 *
 * Deriving the key in ONE exported function is what makes drift impossible —
 * two hand-rolled copies of this string format would fail silently, as an
 * unequal key does not error, it just stops serializing.
 *
 * The UAL segment is lowercased: UAL address segments appear in both
 * checksummed and lowercase forms depending on the source (chain read vs head
 * subject), and a case mismatch would under-merge the lock. Over-merging two
 * distinct KAs into one key would merely coarsen serialization; under-merging
 * recreates the race. Lowercase is therefore the safe direction.
 */
export function swmKaWriteLockKey(
  contextGraphId: string,
  subGraphName: string | undefined,
  kaUal: string,
): string {
  const lockNamespace = subGraphName
    ? `${contextGraphId}\0${subGraphName}`
    : contextGraphId;
  return `${lockNamespace}\0ka\0${kaUal.toLowerCase()}`;
}
