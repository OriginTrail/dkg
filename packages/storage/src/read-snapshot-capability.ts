import { findTripleStoreCapability, type TripleStore } from './triple-store.js';

/** Reads bound to one backend commit point; transaction identifiers remain adapter-private. */
export type ReadSnapshotStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

export interface ReadSnapshotCapability {
  withReadSnapshot<T>(read: (snapshot: ReadSnapshotStore) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function asReadSnapshotCapability(store: TripleStore): ReadSnapshotCapability | null {
  return findTripleStoreCapability(store, (candidate): candidate is ReadSnapshotCapability =>
    typeof candidate === 'object' && candidate !== null
    && 'withReadSnapshot' in candidate
    && typeof candidate.withReadSnapshot === 'function');
}
