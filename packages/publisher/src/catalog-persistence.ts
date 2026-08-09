import {
  tryDeleteSubjects,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

function catalogStoreOptions(operation: string, signal?: AbortSignal): QueryOptions {
  return {
    priority: 'ack',
    source: `storage-ack.persistCatalog.${operation}`,
    ...(signal ? { signal } : {}),
  };
}

/**
 * Replace the touched subjects in a verified public catalog and make the
 * replacement durable.
 *
 * The fast path clears IRI subjects in one bounded server-side operation. Blank-node
 * labels are scoped to a single RDF operation and therefore cannot safely be
 * carried into a later subject-set operation; catalogs containing one use the legacy
 * per-subject delete path. Stores without the structured capability use that same
 * compatibility path, while genuine execution errors still propagate.
 */
export async function replaceCatalogQuads(
  store: TripleStore,
  catalogGraph: string,
  parsedCatalog: readonly Quad[],
  signal?: AbortSignal,
): Promise<void> {
  const catalogSubjects = [...new Set(parsedCatalog.map((quad) => quad.subject))];
  const canUseTargetedUpdate = catalogSubjects.length > 0 &&
    catalogSubjects.every((subject) => !subject.startsWith('_:'));
  const usedTargetedUpdate = canUseTargetedUpdate && await tryDeleteSubjects(
    store,
    { graphUri: catalogGraph, subjects: catalogSubjects },
    catalogStoreOptions('deleteSubjects', signal),
  );

  if (!usedTargetedUpdate) {
    for (const subject of catalogSubjects) {
      await store.deleteByPattern(
        { graph: catalogGraph, subject },
        catalogStoreOptions('deleteByPattern', signal),
      );
    }
  }

  await store.insert(
    parsedCatalog.map((quad) => ({ ...quad, graph: catalogGraph })),
    catalogStoreOptions('insert', signal),
  );
  // The ACK asserts this data is stored. Force any debounced persistence
  // boundary before the caller signs it.
  await store.flush?.(catalogStoreOptions('flush', signal));
}
