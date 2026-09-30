import type { TripleStore } from './triple-store.js';

/** Reads bound to one backend commit point; transaction identifiers remain adapter-private. */
export type ReadSnapshotStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

export interface ReadSnapshotCapability {
  withReadSnapshot<T>(read: (snapshot: ReadSnapshotStore) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function asReadSnapshotCapability(store: TripleStore): ReadSnapshotCapability | null {
  // A snapshot returns another read store. Traversing past a decorator would
  // silently discard its query transformations (for example blob hydration).
  // Every layer must explicitly compose a snapshot facade, or the caller must
  // use the consistent single-query fallback.
  let candidate: unknown = store;
  const seen = new Set<unknown>();
  for (let depth = 0; candidate && depth < 16; depth += 1) {
    if (typeof candidate !== 'object' || seen.has(candidate)
      || !('withReadSnapshot' in candidate)
      || typeof candidate.withReadSnapshot !== 'function') return null;
    seen.add(candidate);
    if (!('innerStore' in candidate)) return store as unknown as ReadSnapshotCapability;
    candidate = candidate.innerStore;
  }
  return null;
}
