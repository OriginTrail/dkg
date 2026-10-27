// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { FinalizedVmAssetCommitment } from './sync/requester/finalized-vm-asset-commitment.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { ProveHeldAssets } from './sync/requester/held-assets-contracts.js';
import { graphScopedDurableManifestPrefixAtOffset } from './sync/durable-integrity.js';
import type { StoredDurablePrefix } from './sync/requester/durable-prefix-proof.js';
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
        let commitments: FinalizedVmAssetCommitment[] = [];
        const held = await readHeldGraphScopedAssets(store, request, undefined, evidence => commitments.push(evidence), confirmation());
        proof.assertCurrent(); request.signal?.throwIfAborted();
        return { held, assertCurrent: proof.assertCurrent, close: proof.close,
          retain: uals => {
            proof.assertCurrent();
            if ([...uals].some(ual => !held.has(ual))) throw new Error('Cannot retain an unproven held asset');
            proof.restrict(scopeOf(request.descriptors.filter(descriptor => uals.has(descriptor.ual))));
            for (const ual of held) if (!uals.has(ual)) held.delete(ual);
            commitments = commitments.filter(commitment => uals.has(commitment.ual));
          },
          reconcile: async ctx => {
            for (const commitment of commitments) {
              request.signal?.throwIfAborted(); proof.assertCurrent();
              await reconcile(commitment, ctx);
              request.signal?.throwIfAborted(); proof.assertCurrent();
            }
          } };
      } catch (error) { proof.close(); throw error; }
    },
  };
}

/** Bind the host-owned content prover to this paging operation's subscription ownership. */
export function createStoredPrefixAcquirer(
  prove: ProveHeldAssets | undefined, contextGraphId: string, assertOwnership: () => void,
): StoredDurablePrefix | undefined {
  if (!prove) return undefined;
  return async (manifest, offset, signal) => {
    const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, offset);
    if (!prefix || manifest.contextGraphId !== contextGraphId) throw new Error('Cannot prove stored durable prefix');
    const descriptors = manifest.descriptors.slice(0, prefix.descriptorCount);
    assertOwnership(); signal?.throwIfAborted();
    const proof = await prove({ contextGraphId, descriptors, signal });
    if (!proof) throw new Error('Cannot prove stored durable prefix');
    const assertCurrent = () => { assertOwnership(); proof.assertCurrent(); };
    try {
      assertCurrent(); signal?.throwIfAborted();
      if (descriptors.some(descriptor => !proof.held.has(descriptor.ual))) throw new Error('Stored durable prefix is missing or corrupt');
      return { assertCurrent, close: proof.close, covers: ual => proof.held.has(ual) };
    } catch (error) { proof.close(); throw error; }
  };
}
