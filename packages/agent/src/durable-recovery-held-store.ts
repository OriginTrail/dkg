// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { HeldGraphScopedAssetsRequest } from './sync/requester/stored-graph-assets.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import { heldGraphScopedAssetsReader, readHeldGraphScopedAssets } from './sync/requester/stored-graph-assets.js';

export interface HeldAssetsProof {
  readonly held: ReadonlySet<string>;
  assertCurrent(): void;
  close(): void;
}
export type ProveHeldAssets = (request: HeldGraphScopedAssetsRequest) => Promise<HeldAssetsProof | undefined>;

/** Bind private content ownership and existing SWM housekeeping at composition. */
export function createDurableHeldStore(
  store: TripleStore,
  fence: StoreContentFence | undefined,
  reconcile: DurableRecoveryHost['reconcile'],
  confirmation: () => 'confirmed' | 'integrity-only' = () => 'confirmed',
): DurableRecoveryHost['heldStore'] {
  if (!fence) return undefined;
  return {
    prove: async request => {
      const proof = fence.openScope({ assertionGraphs: request.descriptors.map(d => d.assertionGraph),
        metadataGraph: contextGraphMetaUri(request.contextGraphId), subjects: request.descriptors.map(d => d.ual) });
      if (!proof) return undefined;
      try {
        request.signal?.throwIfAborted();
        const held = await heldGraphScopedAssetsReader(store, confirmation)(request);
        proof.assertCurrent(); request.signal?.throwIfAborted();
        return { held, assertCurrent: proof.assertCurrent, close: proof.close };
      } catch (error) { proof.close(); throw error; }
    },
    reconcile: async (request, held, ctx) => {
      // Re-read one copy at a time rather than retain an entire generation's payload.
      // Canonical reconciliation rechecks VM and SWM under the publisher lock.
      await readHeldGraphScopedAssets(store, {
        ...request, descriptors: request.descriptors.filter(descriptor => held.has(descriptor.ual)),
      }, undefined, asset => reconcile(asset, ctx));
    },
  };
}
