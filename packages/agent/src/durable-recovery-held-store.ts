// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { ProveHeldAssets } from './sync/requester/held-assets-contracts.js';
import { graphScopedDurableManifestPrefixAtOffset } from './sync/durable-integrity.js';
import type { StoredDurablePrefix } from './sync/requester/durable-prefix-proof.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import type { StoreContentFence } from './internal/store-content-fence.js';
import { heldGraphScopedAssetsReader, readHeldGraphScopedAssets } from './sync/requester/stored-graph-assets.js';

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
