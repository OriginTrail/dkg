// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { FinalizedVmAssetCommitment } from './sync/requester/finalized-vm-asset-commitment.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { LOCAL_TRUSTED_KA_CONTROLS_GRAPH, type TripleStore } from '@origintrail-official/dkg-storage';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import { readHeldGraphScopedAssets } from './sync/requester/stored-graph-assets.js';

/** Bind private content ownership and existing SWM housekeeping at composition. */
export function createDurableHeldStore(
  store: TripleStore,
  fence: StoreContentFence | undefined,
  reconcile: (commitment: FinalizedVmAssetCommitment, ctx: OperationContext) => Promise<void>,
  confirmation: () => 'confirmed' | 'integrity-only' = () => 'confirmed',
): DurableRecoveryHost['heldStore'] {
  if (!fence) return undefined;
  return {
    prove: async request => {
      const scopeOf = (descriptors: typeof request.descriptors) => ({
        graphs: [...descriptors.map(d => d.assertionGraph), LOCAL_TRUSTED_KA_CONTROLS_GRAPH],
        metadataGraph: contextGraphMetaUri(request.contextGraphId), subjects: descriptors.map(d => d.ual) });
      const proof = fence.openScope(scopeOf(request.descriptors));
      if (!proof) return undefined;
      try {
        request.signal?.throwIfAborted();
        const held = await readHeldGraphScopedAssets(store, request, undefined, confirmation());
        proof.assertCurrent(); request.signal?.throwIfAborted();
        return { held, assertCurrent: proof.assertCurrent, close: proof.close,
          retain: uals => {
            proof.assertCurrent();
            if ([...uals].some(ual => !held.has(ual))) throw new Error('Cannot retain an unproven held asset');
            proof.restrict(scopeOf(request.descriptors.filter(descriptor => uals.has(descriptor.ual))));
            for (const ual of held.keys()) if (!uals.has(ual)) held.delete(ual);
          },
          reconcile: async ctx => {
            for (const evidence of held.values()) {
              if (evidence.kind !== 'confirmed') continue;
              request.signal?.throwIfAborted(); proof.assertCurrent();
              await reconcile(evidence.commitment, ctx);
              request.signal?.throwIfAborted(); proof.assertCurrent();
            }
          } };
      } catch (error) { proof.close(); throw error; }
    },
  };
}
