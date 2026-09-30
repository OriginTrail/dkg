import type { TripleStore } from './triple-store.js';

/** Reads bound to one backend commit point; transaction identifiers remain adapter-private. */
export type ReadSnapshotStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

export interface ReadSnapshotCapability {
  withReadSnapshot<T>(read: (snapshot: ReadSnapshotStore) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function asReadSnapshotCapability(store: TripleStore): ReadSnapshotCapability | null {
  // Each decorator exposes this function only if it composes its inner read
  // facade. Never inspect an inner store here or bypass outer transformations.
  const candidate = store as TripleStore & Partial<ReadSnapshotCapability>;
  return typeof candidate.withReadSnapshot === 'function'
    ? candidate as ReadSnapshotCapability : null;
}
