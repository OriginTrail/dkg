import {
  assertSubjectReplacementPayload,
  tryReplaceSubjectsAtomically,
  type Quad,
  type SubjectReplacement,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

export type QueryCatalogWriteMode = 'insert' | 'upsert';

export const QUERY_CATALOG_ATOMIC_UPSERT_UNSUPPORTED =
  'QUERY_CATALOG_ATOMIC_UPSERT_UNSUPPORTED';

export class QueryCatalogAtomicUpsertUnsupportedError extends Error {
  readonly code = QUERY_CATALOG_ATOMIC_UPSERT_UNSUPPORTED;

  constructor() {
    super('Query catalog upsert requires an atomic multi-subject replacement capability');
    this.name = 'QueryCatalogAtomicUpsertUnsupportedError';
  }
}

// Serialize complete catalog writes per reserved profile graph. The storage
// primitive provides the commit boundary; this lock preserves request order
// when several daemon callers save the same catalog concurrently.
const queryCatalogWriteLocks = new Map<string, Promise<void>>();

async function withQueryCatalogWriteLock<T>(
  graph: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queryCatalogWriteLocks.get(graph) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const safePrevious = previous.catch(() => undefined);
  const current = safePrevious.then(() => gate);
  queryCatalogWriteLocks.set(graph, current);
  await safePrevious;
  try {
    return await operation();
  } finally {
    release();
    if (queryCatalogWriteLocks.get(graph) === current) {
      queryCatalogWriteLocks.delete(graph);
    }
  }
}

function assertManagedQueryCatalogSubject(subject: string, contextGraphId: string): void {
  const base = `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:`;
  const catalogPrefix = `${base}catalog:`;
  const queryPrefix = `${base}query:`;
  if (
    (subject.startsWith(catalogPrefix) && subject.length > catalogPrefix.length)
    || (subject.startsWith(queryPrefix) && subject.length > queryPrefix.length)
  ) {
    return;
  }
  throw new Error(
    `Query catalog upsert subject must belong to context graph "${contextGraphId}" `
      + `and use ${catalogPrefix}<slug> or ${queryPrefix}<slug>: ${subject}`,
  );
}

function groupSubjectReplacements(
  graph: string,
  contextGraphId: string,
  quads: Quad[],
): SubjectReplacement[] {
  const bySubject = new Map<string, Quad[]>();
  for (const quad of quads) {
    assertManagedQueryCatalogSubject(quad.subject, contextGraphId);
    const subjectQuads = bySubject.get(quad.subject) ?? [];
    subjectQuads.push(quad);
    bySubject.set(quad.subject, subjectQuads);
  }
  return [...bySubject].map(([subject, subjectQuads]) => {
    assertSubjectReplacementPayload(graph, subject, subjectQuads);
    return { subject, quads: subjectQuads };
  });
}

export async function writeQueryCatalog(
  store: TripleStore,
  graph: string,
  contextGraphId: string,
  quads: Quad[],
  mode: QueryCatalogWriteMode,
): Promise<{ subjectsUpserted?: number }> {
  return withQueryCatalogWriteLock(graph, async () => {
    if (mode === 'insert') {
      await store.insert(quads, { source: 'daemon.profile.queryCatalog.insert' });
      return {};
    }

    const replacements = groupSubjectReplacements(graph, contextGraphId, quads);
    const replaced = await tryReplaceSubjectsAtomically(
      store,
      graph,
      replacements,
      { source: 'daemon.profile.queryCatalog.upsert' },
    );
    if (!replaced) throw new QueryCatalogAtomicUpsertUnsupportedError();
    return { subjectsUpserted: replacements.length };
  });
}
