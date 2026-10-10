// SPDX-License-Identifier: Apache-2.0
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { MATERIALIZED_VERSION_PRED, materializedVersionQuad, readMaterializedVersion } from './metadata.js';
import { insertThenPruneSubjectRows } from './subject-atomic-write.js';

/**
 * Prepare replacement rows once while the caller owns the KA materialization
 * lock. Public data and its metadata can commit together, but only the previous
 * ordering fence belongs in that payload: the new fence commits after every
 * private/catalog slice. Compound and compatibility writes use these same rows.
 */
export async function prepareKnowledgeAssetMaterializationMetadata(
  store: TripleStore,
  metaGraph: string,
  subject: string,
  quads: readonly Quad[],
): Promise<Quad[]> {
  const previousVersion = await readMaterializedVersion(store, metaGraph, subject);
  const rows = quads.filter(quad => quad.predicate !== MATERIALIZED_VERSION_PRED)
    .map(quad => ({ ...quad, graph: metaGraph }));
  if (previousVersion !== null) {
    rows.push(materializedVersionQuad(metaGraph, subject, previousVersion));
  }
  return rows;
}

/**
 * Retry-safe replacement of one KA's rows inside a shared metadata graph.
 * Insert the complete new row set first, then prune rows from the previous
 * snapshot that are no longer present. An interruption can temporarily leave
 * duplicate values, but never removes the only discoverable metadata copy;
 * retry converges to the exact requested set. Without a snapshot the new rows
 * are still inserted and only the prune is skipped.
 */
export async function convergeKnowledgeAssetMetadataRows(
  store: TripleStore,
  metaGraph: string,
  subject: string,
  quads: readonly Quad[],
): Promise<void> {
  await insertThenPruneSubjectRows(store, metaGraph, subject,
    quads.map((quad) => ({ ...quad, graph: metaGraph })), { requireSnapshot: false });
}
