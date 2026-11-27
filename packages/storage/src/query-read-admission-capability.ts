import { findTripleStoreCapability, type TripleStore } from './triple-store.js';

export type QueryReadAdmissionCapability = Required<Pick<TripleStore, 'withQueryReadAdmission'>>;

/** Discover the admission lifetime owner; reads still use the outer store. */
export function asQueryReadAdmissionCapability(store: unknown): QueryReadAdmissionCapability | null {
  return findTripleStoreCapability(store, (candidate): candidate is QueryReadAdmissionCapability =>
    typeof candidate === 'object' && candidate !== null
      && typeof (candidate as Partial<QueryReadAdmissionCapability>).withQueryReadAdmission === 'function');
}
