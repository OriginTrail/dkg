// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions, TripleStore } from './triple-store.js';

export type TripleStorePersistenceBarrier = (options?: QueryOptions) => Promise<void>;

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
  return composeBarrier(inner.persist?.bind(inner), drain);
}
export function composeTripleStoreEphemeralCommit(
  inner: TripleStore, drain?: () => Promise<void>,
): TripleStorePersistenceBarrier | undefined {
  return composeBarrier(inner.commitEphemeral?.bind(inner), drain);
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
