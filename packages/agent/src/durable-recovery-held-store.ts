// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import { heldGraphScopedAssetsReader, readHeldGraphScopedAssets } from './sync/requester/stored-graph-assets.js';

/** Bind private content ownership and existing SWM housekeeping at composition. */
export function createDurableHeldStore(
  store: TripleStore,
  fence: StoreContentFence | undefined,
  reconcile: DurableRecoveryHost['reconcile'],
): DurableRecoveryHost['heldStore'] {
  if (!fence) return undefined;
  return {
    read: heldGraphScopedAssetsReader(store), withScope: fence.withScope.bind(fence), openScope: fence.openScope.bind(fence),
    reconcile: async (request, held, ctx) => {
      // Re-read one copy at a time rather than retain an entire generation's payload.
      // Canonical reconciliation rechecks VM and SWM under the publisher lock.
      await readHeldGraphScopedAssets(store, {
        ...request, descriptors: request.descriptors.filter(descriptor => held.has(descriptor.ual)),
      }, undefined, asset => reconcile(asset, ctx));
    },
  };
}
