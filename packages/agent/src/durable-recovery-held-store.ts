// SPDX-License-Identifier: Apache-2.0
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import { heldGraphScopedAssetsReader } from './sync/requester/stored-graph-assets.js';

/** Bind the stored-prefix reader to its private mutation watch. */
export function createDurableHeldStore(
  store: TripleStore,
  fence: StoreContentFence | undefined,
  confirmation: () => 'confirmed' | 'integrity-only' = () => 'confirmed',
): DurableRecoveryHost['heldStore'] {
  return fence ? { read: heldGraphScopedAssetsReader(store, confirmation), openScope: fence.openScope.bind(fence) } : undefined;
}
