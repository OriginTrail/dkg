// SPDX-License-Identifier: Apache-2.0

import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ContextGraphMetaProjection } from '../context-graph-meta-projection.js';
import { createPublishedNamedKaVmLifecycleWriter } from '../named-ka-vm-lifecycle.js';
import { createMutationObservedStore } from './context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from './observed-store-mutation.js';
import { createProjectionMutationObserver } from './projection-mutation-observer.js';
import { createStorageAckCopyCleanupWriter } from './storage-ack-copy-cleanup-writer.js';
import { createStorageAckLedgerTimestampWriter } from './storage-ack-ledger-timestamp-writer.js';

/** Keep all typed agent writers on the same observer and configured store decorators. */
export function createAgentMutationWriters(
  store: TripleStore,
  invalidate: () => void,
  getProjection: () => ContextGraphMetaProjection | undefined,
) {
  const executeMutation = createObservedStoreMutation(invalidate, createProjectionMutationObserver(getProjection));
  const agentStore = createMutationObservedStore(store, executeMutation);
  return {
    agentStore,
    publishedLifecycleWriter: createPublishedNamedKaVmLifecycleWriter({
      updateStore: store, fallbackStore: agentStore, executeMutation,
    }),
    ledgerTimestampWriter: createStorageAckLedgerTimestampWriter(store, executeMutation),
    storageAckCopyCleanup: createStorageAckCopyCleanupWriter(store, executeMutation),
  };
}
