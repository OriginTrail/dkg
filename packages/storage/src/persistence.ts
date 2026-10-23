// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions, TripleStore } from './triple-store.js';

export type TripleStoreCommitDurability = 'process-local' | 'restart-durable';
export type TripleStorePersistenceBarrier = (options?: QueryOptions) => Promise<void>;
/** One attempt-scoped boundary; atomicity alone grants neither durability level. */
export interface TripleStoreCommitCapability {
  readonly durability: TripleStoreCommitDurability;
  /** Capture before the attempt's reads and writes. The barrier rejects if its
   * write owner is replaced before certification. Stable adapters reuse a callable. */
  readonly capture: () => TripleStorePersistenceBarrier;
}

/** Cancellation cannot turn a failed or unfinished commit into success. */
export function guardedTripleStorePersistenceBarrier(work: TripleStorePersistenceBarrier): TripleStorePersistenceBarrier {
  return async options => {
    options?.signal?.throwIfAborted();
    await work(options);
    options?.signal?.throwIfAborted();
  };
}

export function certifiedTripleStoreCommitment(
  durability: TripleStoreCommitDurability, work: TripleStorePersistenceBarrier,
): TripleStoreCommitCapability {
  const commit = guardedTripleStorePersistenceBarrier(work);
  return { durability, capture: () => commit };
}

/** Decorators preserve the inner guarantee after their own mutation queue drains. */
export function composeTripleStoreCommitment(
  inner: TripleStore, drain: () => Promise<void>,
): TripleStoreCommitCapability | undefined {
  const capability = inner.commitment;
  if (capability === undefined) return undefined;
  return { durability: capability.durability, capture: () => {
    // Capture synchronously, before either the caller's writes or our own drain.
    const commit = capability.capture();
    return guardedTripleStorePersistenceBarrier(async options => {
      await drain();
      options?.signal?.throwIfAborted();
      await commit(options);
    });
  } };
}
