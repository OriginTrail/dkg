// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { MATERIALIZED_VERSION_PRED } from './metadata.js';

/**
 * Retry-safe replacement of one KA's rows inside a shared metadata graph.
 * Insert the complete new row set first, then prune rows from the previous
 * snapshot that are no longer present. An interruption can temporarily leave
 * duplicate values, but never removes the only discoverable metadata copy;
 * retry converges to the exact requested set.
 */
export async function convergeKnowledgeAssetMetadataRows(
  store: TripleStore,
  metaGraph: string,
  subject: string,
  quads: readonly Quad[],
): Promise<void> {
  const previous = await store.query(
    `CONSTRUCT { <${assertSafeIri(subject)}> ?p ?o } WHERE { ` +
      `GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(subject)}> ?p ?o } }`,
  );
  await store.insert(quads.map((quad) => ({ ...quad, graph: metaGraph })));
  if (previous.type !== 'quads') return;
  const nextKeys = new Set(
    quads.map((quad) => JSON.stringify([quad.subject, quad.predicate, quad.object])),
  );
  const stale = previous.quads.filter(
    // The ordering fence commits separately after every materialized slice.
    // Keep its previous value if a later private/catalog write fails.
    (quad) => quad.predicate !== MATERIALIZED_VERSION_PRED
      && !nextKeys.has(JSON.stringify([quad.subject, quad.predicate, quad.object])),
  );
  if (stale.length > 0) {
    // CONSTRUCT results carry no graph — restore the metadata graph before
    // deleting, otherwise the delete targets the default graph and every
    // superseded control-plane row survives alongside the new value.
    await store.delete(stale.map((quad) => ({ ...quad, graph: metaGraph })));
  }
}
