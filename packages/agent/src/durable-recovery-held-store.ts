// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { FinalizedVmAssetCommitment } from './sync/requester/finalized-vm-asset-commitment.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { ProveHeldAssets } from './sync/requester/held-assets-contracts.js';
import { graphScopedDurableManifestPrefixAtOffset } from './sync/durable-integrity.js';
import type { StoredDurablePrefix } from './sync/requester/durable-prefix-proof.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
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
      const proof = fence.openScope({ assertionGraphs: request.descriptors.map(d => d.assertionGraph),
        metadataGraph: contextGraphMetaUri(request.contextGraphId), subjects: request.descriptors.map(d => d.ual) });
      if (!proof) return undefined;
      try {
        request.signal?.throwIfAborted();
        const commitments: FinalizedVmAssetCommitment[] = [];
        const held = await readHeldGraphScopedAssets(store, request, undefined, evidence => commitments.push(evidence), confirmation());
        proof.assertCurrent(); request.signal?.throwIfAborted();
        return { held, commitments: Object.freeze(commitments), assertCurrent: proof.assertCurrent, close: proof.close };
      } catch (error) { proof.close(); throw error; }
    },
    reconcile: async (request, proof, ctx) => {
      for (const commitment of proof.commitments) {
        request.signal?.throwIfAborted(); proof.assertCurrent();
        await reconcile(commitment, ctx);
        request.signal?.throwIfAborted(); proof.assertCurrent();
      }
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
