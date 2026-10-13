// SPDX-License-Identifier: Apache-2.0
import { withMaterializationLock } from '@origintrail-official/dkg-publisher';
import { ATOMIC_ASSET_GROUP_MAX_ASSETS, UnsupportedTripleStoreCapabilityError, type AtomicAssetReplacement, type TripleStore,
  type QueryOptions } from '@origintrail-official/dkg-storage';
import { prepareGraphScopedReplacementUnderLock } from './graph-scoped-replacement.js';
import { filterOversizedSyncQuads } from '../oversize-filter.js';
import type { VerifiedGraphScopedAsset, GraphScopedMaterializationOutcome } from './graph-scoped-materialization.js';

/** The same per-KA lock domain as individual materialization, acquired in a total order. */
export async function materializeVerifiedGraphScopedGroup(params: {
  store: TripleStore; assets: readonly VerifiedGraphScopedAsset[]; options?: QueryOptions;
  assertCurrent: () => void; shouldQuarantineCommitted: () => boolean;
}): Promise<GraphScopedMaterializationOutcome[]> {
  const { store, assets, assertCurrent, shouldQuarantineCommitted, options = {} } = params;
  if (!assets.length || assets.length > ATOMIC_ASSET_GROUP_MAX_ASSETS) throw new RangeError('Invalid materialization group');
  const keys = assets.map(a => `${a.metaGraph}\0${a.ual}`);
  if (new Set(keys).size !== keys.length || new Set(assets.map(a => a.contextGraphId)).size !== 1)
    throw new Error('Duplicate or cross-context materialization group');
  assertCurrent();
  for (const asset of assets) {
    if (filterOversizedSyncQuads([...asset.dataQuads, ...asset.metadataQuads]).dropped.length)
      throw new Error('Materialization group contains oversized RDF terms');
  }
  const ordered = [...assets].sort((a,b) => `${a.metaGraph}\0${a.ual}` < `${b.metaGraph}\0${b.ual}` ? -1 : 1);
  const lock = (index: number): Promise<GraphScopedMaterializationOutcome[]> => index < ordered.length
    ? withMaterializationLock(ordered[index]!.metaGraph, ordered[index]!.ual, () => lock(index + 1), { signal: options.signal })
    : apply();
  const apply = async (): Promise<GraphScopedMaterializationOutcome[]> => {
    const replacements: AtomicAssetReplacement[] = [];
    for (const asset of assets) {
      const replacement = await prepareGraphScopedReplacementUnderLock({
        store, asset, options, assertCurrent, requireCurrentMetadata: true,
      });
      // Singleton callers report stale; a group must reject before any write.
      if (!replacement) throw new Error('Materialization group has a newer local assertion');
      replacements.push(replacement);
    }
    assertCurrent();
    // Cancellation must drain the real dispatched transaction while retaining all locks.
    const { signal: _signal, ...commitOptions } = options;
    if (!store.replaceAssetGroup) throw new UnsupportedTripleStoreCapabilityError('replaceAssetGroup', 'snapshot');
    await store.replaceAssetGroup(replacements, commitOptions);
    if (shouldQuarantineCommitted()) {
      await store.replaceAssetGroup(replacements.map(a => ({ ...a, graphQuads: [], metadataQuads: [] })), commitOptions);
      return assets.map(() => 'quarantined');
    }
    // A lifecycle cancellation never creates an ACK. Data already atomically published
    // remains available to a later independently authenticated resume.
    assertCurrent();
    return assets.map(() => 'applied');
  };
  return lock(0);
}
