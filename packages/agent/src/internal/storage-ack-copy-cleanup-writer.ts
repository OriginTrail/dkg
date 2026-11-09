// SPDX-License-Identifier: Apache-2.0

import { planStorageAckCopyCleanup, type StorageAckCopyCleanupWriter } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ObservedStoreMutation } from './observed-store-mutation.js';

/** Compose over configured decorators; never unwrap an arbitrary store or trust SPARQL scope hints. */
export function createStorageAckCopyCleanupWriter(
  store: TripleStore, executeMutation: ObservedStoreMutation,
): StorageAckCopyCleanupWriter {
  return async input => {
    const plan = planStorageAckCopyCleanup(input);
    if (!plan) return;
    if (typeof store.update !== 'function') {
      throw new Error('the triple store cannot run an update for the StorageACK copy cleanup');
    }
    // The query can remove every predicate of a matched operation, including key facts.
    // Observe the whole graph, not just the predicates used to select those operations.
    await executeMutation(
      () => store.update!(plan.sparql, plan.options), () => true,
      { removals: [{ graph: plan.graph }] }, 'update',
    );
  };
}
