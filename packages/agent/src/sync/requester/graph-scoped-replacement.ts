// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { mergeSameVersionGraphKnowledgeAssetMetadataV1, overlayLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import type { AtomicAssetReplacement, Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { readCurrentAssertionVersion } from '../../graph-scoped-assertion-version.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

/** Caller owns the per-asset lock and the stale/publication outcome policy. */
export async function prepareGraphScopedReplacementUnderLock(params: {
  store: TripleStore; asset: VerifiedGraphScopedAsset; options: QueryOptions;
  assertCurrent: () => void; requireCurrentMetadata: boolean;
}): Promise<AtomicAssetReplacement | undefined> {
  const { store, asset, options, assertCurrent, requireCurrentMetadata } = params;
  assertCurrent();
  const version = await readCurrentAssertionVersion(store, asset.metaGraph, asset.ual, options);
  assertCurrent();
  if (version !== undefined && version > asset.assertionVersion) return undefined;
  let metadata = asset.metadataQuads;
  if (version === asset.assertionVersion) {
    const current = await readCurrentMetadata(store, asset.metaGraph, asset.ual, options);
    if (!current && requireCurrentMetadata) throw new Error('Group metadata read unavailable');
    if (current) metadata = mergeSameVersionGraphKnowledgeAssetMetadataV1(metadata, current);
    assertCurrent();
  }
  metadata = await overlayLocallyTrustedKnowledgeAssetControls(store, asset.metaGraph, asset.ual, metadata, options);
  assertCurrent();
  return { graphUri: asset.assertionGraph, graphQuads: asset.dataQuads,
    metaGraphUri: asset.metaGraph, metadataSubject: asset.ual, metadataQuads: metadata };
}

async function readCurrentMetadata(store: TripleStore, metaGraph: string, ual: string, options: QueryOptions): Promise<Quad[] | undefined> {
  const result = await store.query(`SELECT ?predicate ?object WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(ual)}> ?predicate ?object . }
  }`, options);
  if (result.type !== 'bindings' || result.bindings.some(row => !row.predicate || !row.object)) return undefined;
  return result.bindings.map(row => ({ graph: metaGraph, subject: ual, predicate: row.predicate!, object: row.object! }));
}
