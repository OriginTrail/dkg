import {
  tryDeleteSubjects,
  type Quad,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

/**
 * The canonical `QueryOptions.source` tag for each catalog-persist step.
 *
 * These strings are an observable contract: storage-side diagnostics and the
 * ACK dead-air guards select store calls by this exact tag. They are literals
 * here, in one place, rather than a template built from the step name — so
 * renaming a step cannot silently change the externally visible tag.
 */
export const CATALOG_PERSIST_SOURCES = {
  deleteSubjects: 'storage-ack.persistCatalog.deleteSubjects',
  deleteByPattern: 'storage-ack.persistCatalog.deleteByPattern',
  insert: 'storage-ack.persistCatalog.insert',
  flush: 'storage-ack.persistCatalog.flush',
} as const;

export type CatalogPersistStep = keyof typeof CATALOG_PERSIST_SOURCES;

function catalogStoreOptions(step: CatalogPersistStep, signal?: AbortSignal): QueryOptions {
  return {
    priority: 'ack',
    source: CATALOG_PERSIST_SOURCES[step],
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
