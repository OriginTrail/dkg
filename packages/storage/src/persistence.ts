// SPDX-License-Identifier: Apache-2.0
import type { QueryOptions, TripleStore } from './triple-store.js';

export type TripleStoreCommitDurability = 'process-local' | 'restart-durable';
export type TripleStorePersistenceBarrier = (options?: QueryOptions) => Promise<void>;
/** One commit boundary with an explicit guarantee; atomicity alone grants neither level. */
export interface TripleStoreCommitCapability {
  readonly durability: TripleStoreCommitDurability;
  readonly commit: TripleStorePersistenceBarrier;
}

/** Cancellation cannot turn a failed or unfinished commit into success. */
export function certifiedTripleStoreCommitment(
  durability: TripleStoreCommitDurability, work: TripleStorePersistenceBarrier,
): TripleStoreCommitCapability {
  return { durability, commit: async (options?: QueryOptions) => {
    options?.signal?.throwIfAborted();
    await work(options);
    options?.signal?.throwIfAborted();
  } };
}

/** Decorators preserve the inner guarantee after their own mutation queue drains. */
export function composeTripleStoreCommitment(
  inner: TripleStore, drain?: () => Promise<void>,
): TripleStoreCommitCapability | undefined {
  const capability = inner.commitment;
  if (capability === undefined) return undefined;
  return certifiedTripleStoreCommitment(capability.durability, async (options) => {
    await drain?.();
    options?.signal?.throwIfAborted();
    await capability.commit(options);
  });
}
