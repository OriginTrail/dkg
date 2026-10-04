// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions, TripleStore } from './triple-store.js';

export type TripleStorePersistenceBarrier = (options?: QueryOptions) => Promise<void>;
export interface TripleStoreEphemeralCommitCapability {
  /** Completed mutations remain in this explicitly process-local store; no restart durability is promised. */
  commitEphemeral: TripleStorePersistenceBarrier;
}
export interface TripleStorePersistenceCapability {
  /** Persist completed mutations through the outer composition's certified barrier. */
  persist: TripleStorePersistenceBarrier;
}

/** An adapter explicitly certifies its own barrier; neither flush nor wrapper topology grants it. */
export function asTripleStorePersistenceCapability(store: TripleStore): TripleStorePersistenceCapability | null {
  const persist = store.persist;
  return typeof persist === 'function' ? Object.freeze({ persist: persist.bind(store) }) : null;
}

export function asTripleStoreEphemeralCommitCapability(store: TripleStore): TripleStoreEphemeralCommitCapability | null {
  const commitEphemeral = store.commitEphemeral;
  return typeof commitEphemeral === 'function' ? Object.freeze({ commitEphemeral: commitEphemeral.bind(store) }) : null;
}

/** Cancellation cannot turn a failed or unfinished persistence barrier into success. */
export function certifiedTripleStorePersistenceBarrier(work: TripleStorePersistenceBarrier): TripleStorePersistenceBarrier {
  return async (options) => {
    options?.signal?.throwIfAborted();
    await work(options);
    options?.signal?.throwIfAborted();
  };
}

/** Decorators certify only an explicitly certified inner endpoint, after their own mutation queue drains. */
export function composeTripleStorePersistence(
  inner: TripleStore, drain?: () => Promise<void>,
): TripleStorePersistenceBarrier | undefined {
  return composeBarrier(asTripleStorePersistenceCapability(inner)?.persist, drain);
}
export function composeTripleStoreEphemeralCommit(
  inner: TripleStore, drain?: () => Promise<void>,
): TripleStorePersistenceBarrier | undefined {
  return composeBarrier(asTripleStoreEphemeralCommitCapability(inner)?.commitEphemeral, drain);
}
function composeBarrier(
  barrier: TripleStorePersistenceBarrier | undefined, drain?: () => Promise<void>,
): TripleStorePersistenceBarrier | undefined {
  if (barrier === undefined) return undefined;
  return certifiedTripleStorePersistenceBarrier(async (options) => {
    await drain?.();
    options?.signal?.throwIfAborted();
    await barrier(options);
  });
}
