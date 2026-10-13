// SPDX-License-Identifier: Apache-2.0
import { executeGraphScopedPublication } from './graph-scoped-publication.js';
import { ATOMIC_ASSET_GROUP_MAX_ASSETS, UnsupportedTripleStoreCapabilityError, type AtomicAssetReplacement, type TripleStore,
  type QueryOptions } from '@origintrail-official/dkg-storage';
import { filterOversizedSyncQuads } from '../oversize-filter.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

/** The same per-KA lock domain as individual materialization, acquired in a total order. */
export async function materializeVerifiedGraphScopedGroup(params: {
  store: TripleStore; assets: readonly VerifiedGraphScopedAsset[]; options?: QueryOptions;
  assertCurrent: () => void; shouldQuarantineCommitted: () => boolean;
}): Promise<'applied' | 'quarantined'> {
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
  const publish = async (replacements: AtomicAssetReplacement[], commitOptions: QueryOptions) => {
    if (!store.replaceAssetGroup) throw new UnsupportedTripleStoreCapabilityError('replaceAssetGroup', 'snapshot');
    await store.replaceAssetGroup(replacements, commitOptions);
  };
  return executeGraphScopedPublication({ store, assets, options, assertCurrent, shouldQuarantineCommitted,
    requireCurrentMetadata: true,
    stale: () => { throw new Error('Materialization group has a newer local assertion'); },
    complete: () => { assertCurrent(); return 'applied' as const; },
    publish, quarantine: publish,
  });
}
