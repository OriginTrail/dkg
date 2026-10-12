// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { mergeSameVersionGraphKnowledgeAssetMetadataV1, overlayLocallyTrustedKnowledgeAssetControls,
  withMaterializationLock } from '@origintrail-official/dkg-publisher';
import { UnsupportedTripleStoreCapabilityError, type AtomicAssetReplacement, type TripleStore,
  type QueryOptions } from '@origintrail-official/dkg-storage';
import { readCurrentAssertionVersion } from '../../graph-scoped-assertion-version.js';
import { filterOversizedSyncQuads } from '../oversize-filter.js';
import type { VerifiedGraphScopedAsset, GraphScopedMaterializationOutcome } from './graph-scoped-materialization.js';

/** The same per-KA lock domain as individual materialization, acquired in a total order. */
export async function materializeVerifiedGraphScopedGroup(params: {
  store: TripleStore; assets: readonly VerifiedGraphScopedAsset[]; options?: QueryOptions;
  assertCurrent: () => void; shouldQuarantineCommitted: () => boolean;
}): Promise<GraphScopedMaterializationOutcome[]> {
  const { store, assets, assertCurrent, shouldQuarantineCommitted, options = {} } = params;
  if (!assets.length || assets.length > 8) throw new RangeError('Invalid materialization group');
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
      assertCurrent();
      const version = await readCurrentAssertionVersion(store, asset.metaGraph, asset.ual, options);
      // A stale member cannot silently become acknowledged coverage for this snapshot.
      if (version !== undefined && version > asset.assertionVersion) throw new Error('Materialization group has a newer local assertion');
      let metadata = asset.metadataQuads;
      if (version === asset.assertionVersion) {
        const rows = await store.query(`SELECT ?predicate ?object WHERE { GRAPH <${assertSafeIri(asset.metaGraph)}> { <${assertSafeIri(asset.ual)}> ?predicate ?object } }`, options);
        if (rows.type !== 'bindings' || rows.bindings.some(r => !r.predicate || !r.object)) throw new Error('Group metadata read unavailable');
        metadata = mergeSameVersionGraphKnowledgeAssetMetadataV1(metadata, rows.bindings.map(r => ({
          graph: asset.metaGraph, subject: asset.ual, predicate: r.predicate!, object: r.object!,
        })));
      }
      metadata = await overlayLocallyTrustedKnowledgeAssetControls(store, asset.metaGraph, asset.ual, metadata, options);
      replacements.push({ graphUri: asset.assertionGraph, graphQuads: asset.dataQuads,
        metaGraphUri: asset.metaGraph, metadataSubject: asset.ual, metadataQuads: metadata });
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
