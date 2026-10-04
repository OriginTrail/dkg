// SPDX-License-Identifier: Apache-2.0
import { findTripleStoreCapability, type QueryOptions, type TripleStore } from './triple-store.js';

export interface TripleStorePersistenceCapability {
  /** Persist completed mutations through the outer composition's barrier. */
  persist(options?: QueryOptions): Promise<void>;
}

/** A decorator's optional/no-op flush does not certify its underlying backend. */
export function asTripleStorePersistenceCapability(store: TripleStore): TripleStorePersistenceCapability | null {
  let forwardingFlush = true;
  const backend = findTripleStoreCapability(store, (candidate): candidate is TripleStore => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const current = candidate as Partial<TripleStore>;
    if (current.writesDurableOnAcknowledgement === true) return true;
    forwardingFlush &&= typeof current.flush === 'function';
    return !('innerStore' in candidate) && forwardingFlush;
  });
  if (backend === null) return null;
  return Object.freeze({
    async persist(options?: QueryOptions): Promise<void> {
      options?.signal?.throwIfAborted();
      await store.flush?.(options);
      options?.signal?.throwIfAborted();
    },
  });
}
