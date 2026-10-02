import {
  deleteByPatternWithoutCount,
  tryUpdateWithTouchedGraphs,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { sparqlIri } from '@origintrail-official/dkg-core';
import { ACKCommitSequence } from './ack-commit-sequence.js';

/**
 * Replace the touched subjects in a verified public catalog and make the
 * replacement durable.
 *
 * The fast path clears IRI subjects in one server-side UPDATE. Blank-node
 * labels are scoped to a single RDF operation and therefore cannot safely be
 * carried into a later UPDATE; catalogs containing one use the legacy
 * per-subject delete path. Stores with no real UPDATE capability use that same
 * compatibility path, while genuine UPDATE execution errors still propagate.
 */
export async function replaceCatalogQuads(
  store: TripleStore,
  catalogGraph: string,
  parsedCatalog: readonly Quad[],
  signal?: AbortSignal,
): Promise<void> {
  const commit = new ACKCommitSequence(signal);
  const catalogSubjects = [...new Set(parsedCatalog.map((quad) => quad.subject))];
  const canUseTargetedUpdate = catalogSubjects.length > 0 &&
    catalogSubjects.every((subject) => !subject.startsWith('_:'));
  const usedTargetedUpdate = canUseTargetedUpdate && await commit.write(
    'storage-ack.persistCatalog.update',
    (options) => tryUpdateWithTouchedGraphs(store,
    `DELETE { GRAPH ${sparqlIri(catalogGraph)} { ?s ?p ?o } }
WHERE { GRAPH ${sparqlIri(catalogGraph)} {
  VALUES ?s { ${catalogSubjects.map((subject) => sparqlIri(subject)).join(' ')} }
  ?s ?p ?o
} }`,
    [catalogGraph],
    options),
    (used) => used,
  );

  if (!usedTargetedUpdate) {
    for (const subject of catalogSubjects) {
      await commit.write(
        'storage-ack.persistCatalog.deleteByPattern',
        (options) => deleteByPatternWithoutCount(store, { graph: catalogGraph, subject }, options),
      );
    }
  }

  await commit.write(
    'storage-ack.persistCatalog.insert',
    (options) => store.insert(parsedCatalog.map((quad) => ({ ...quad, graph: catalogGraph })), options),
  );
  // The ACK asserts this data is stored. Force any debounced persistence
  // boundary before the caller signs it.
  await commit.write('storage-ack.persistCatalog.flush', async (options) => { await store.flush?.(options); });
}
