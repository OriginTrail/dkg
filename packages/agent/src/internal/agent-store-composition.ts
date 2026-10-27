// SPDX-License-Identifier: Apache-2.0
import { asStoreRecoveryGenerationReader, type TripleStore } from '@origintrail-official/dkg-storage';
import { clearDischargedStorageAckCopies, type StorageAckCopyCleanupWriter } from '@origintrail-official/dkg-publisher';
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
  const heldContent = new StoreContentFence(asStoreRecoveryGenerationReader(raw));
  const executeMutation = createObservedStoreMutation(invalidate, {
    begin(mutation) {
      const settleProjection = observer.begin(mutation);
      const settleContent = heldContent.begin(mutation);
      return outcome => { settleContent(outcome); settleProjection(outcome); };
    },
  });
  const store = createMutationObservedStore(raw, executeMutation);
  // The publisher owns validation, query construction and update options. This
  // port contributes only the known mutation scope at its dispatch boundary.
  const storageAckCopyCleanupWriter: StorageAckCopyCleanupWriter = input =>
    clearDischargedStorageAckCopies({
      update: raw.update === undefined ? undefined : (sparql, options) => executeMutation(
        () => raw.update!(sparql, options), () => true,
        { removals: [{ graph: input.metaGraph }] }, 'update',
      ),
    }, input);

  return {
    store, heldContent,
    storageAckCopyCleanupWriter,
    publishedLifecycleWriter: createPublishedNamedKaVmLifecycleWriter({
      updateStore: raw, fallbackStore: store, executeMutation,
    }),
    ledgerTimestampWriter: createStorageAckLedgerTimestampWriter(raw, executeMutation),
  };
}
