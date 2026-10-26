// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createPublishedNamedKaVmLifecycleWriter } from '../named-ka-vm-lifecycle.js';
import { createMutationObservedStore } from './context-graph-cache-invalidating-store.js';
import { createStoreMutationOwner } from './observed-store-mutation.js';
import { createStorageAckLedgerTimestampWriter } from './storage-ack-ledger-timestamp-writer.js';
import type { StoreMutationObserver } from './store-mutation.js';

/** One private owner observes ordinary mutations and both typed raw-store writers. */
export function createAgentStoreComposition(
  raw: TripleStore,
  invalidate: () => void,
  observer: StoreMutationObserver,
) {
  const owner = createStoreMutationOwner(invalidate, observer);
  const store = createMutationObservedStore(raw, owner);
  return {
    store, heldContent: owner.contentFence,
    publishedLifecycleWriter: createPublishedNamedKaVmLifecycleWriter({
      updateStore: raw, fallbackStore: store, executeMutation: owner.execute,
    }),
    ledgerTimestampWriter: createStorageAckLedgerTimestampWriter(raw, owner.execute),
  };
}
