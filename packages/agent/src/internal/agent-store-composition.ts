// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createPublishedNamedKaVmLifecycleWriter } from '../named-ka-vm-lifecycle.js';
import { createMutationObservedStore } from './context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from './observed-store-mutation.js';
import { createStorageAckLedgerTimestampWriter } from './storage-ack-ledger-timestamp-writer.js';
import { StoreContentFence } from './store-content-fence.js';
import type { StoreMutationObserver } from './store-mutation.js';

/** One private owner observes ordinary mutations and both typed raw-store writers. */
export function createAgentStoreComposition(
  raw: TripleStore,
  invalidate: () => void,
  observer: StoreMutationObserver,
) {
  const heldContent = new StoreContentFence();
  const executeMutation = createObservedStoreMutation(invalidate, {
    begin(mutation) {
      const settleProjection = observer.begin(mutation);
      const settleContent = heldContent.begin(mutation);
      return outcome => { settleContent(outcome); settleProjection(outcome); };
    },
  });
  const store = createMutationObservedStore(raw, executeMutation);
  return {
    store, heldContent,
    publishedLifecycleWriter: createPublishedNamedKaVmLifecycleWriter({
      updateStore: raw, fallbackStore: store, executeMutation,
    }),
    ledgerTimestampWriter: createStorageAckLedgerTimestampWriter(raw, executeMutation),
  };
}
