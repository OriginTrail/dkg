import {
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  WORKSPACE_OWNER_PREDICATE,
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import {
  tryUpdateWithTouchedGraphs,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const DATA_CLEANUP_SOURCE = 'publisher.clearPublishedSwmRoots.data';
const METADATA_CLEANUP_SOURCE = 'publisher.clearPublishedSwmRoots.metadata';
const MEMBER_PREDICATES = `<${DKG_ROOT_ENTITY_LEGACY}>, <${DKG_ENTITY}>`;

export interface PublishedSwmMetadataCleanupResult {
  roots: string[];
  mode: 'batched-update' | 'serial-fallback';
  ownerDeletedTotal: number;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sparqlValues(iris: readonly string[]): string {
  return iris.map((iri) => `<${iri}>`).join(' ');
}

function parseCountLiteral(value: string | false | undefined): number {
  if (!value) return Number.NaN;
  const stripped = value.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Remove one root from the public subset recorded for a share operation.
 * The operation subject is removed only after its last member edge is gone.
 * This is the canonical serial primitive used by both ordinary SWM upserts and
 * the confirmed-publish compatibility path.
 */
export async function deleteSharedMemoryMetadataForRoot(
  store: TripleStore,
  metadataGraph: string,
  rootEntity: string,
): Promise<void> {
  const result = await store.query(
    `SELECT DISTINCT ?op WHERE { GRAPH <${metadataGraph}> { ?op (<${DKG_ROOT_ENTITY_LEGACY}>|<${DKG_ENTITY}>) <${rootEntity}> } }`,
  );
  if (result.type !== 'bindings') return;

  for (const row of result.bindings) {
    const operation = row.op;
    if (!operation) continue;

    await store.delete([
      {
        subject: operation,
        predicate: DKG_ROOT_ENTITY_LEGACY,
        object: rootEntity,
        graph: metadataGraph,
      },
      {
        subject: operation,
        predicate: DKG_ENTITY,
        object: rootEntity,
        graph: metadataGraph,
      },
    ]);

    const remaining = await store.query(
      `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${metadataGraph}> { <${operation}> (<${DKG_ROOT_ENTITY_LEGACY}>|<${DKG_ENTITY}>) ?r } }`,
    );
    const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.c;
    if (parseCountLiteral(rawCount) === 0) {
      await store.deleteByPattern({ graph: metadataGraph, subject: operation });
    }
  }
}

/**
 * Remove the selected roots and their generated descendants from every
 * resolved SWM data graph. Update-capable stores use one bounded mutation;
 * stores that report the optional capability as unsupported retain the fully
 * awaited serial behavior.
 */
export async function deletePublishedSwmRootData(
  store: TripleStore,
  rootEntities: readonly string[],
  dataGraphs: readonly string[],
): Promise<void> {
  const roots = unique(rootEntities);
  const targetGraphs = unique(dataGraphs);
  if (roots.length === 0 || targetGraphs.length === 0) return;

  if (typeof store.update === 'function') {
    // Validate every interpolated term before the first destructive mutation.
    for (const root of roots) assertSafeIri(root);
    for (const graph of targetGraphs) assertSafeIri(graph);

    const updateApplied = await tryUpdateWithTouchedGraphs(
      store,
      `DELETE { GRAPH ?targetGraph { ?subject ?predicate ?object } }
WHERE {
  VALUES ?targetGraph { ${sparqlValues(targetGraphs)} }
  GRAPH ?targetGraph {
    VALUES ?root { ${sparqlValues(roots)} }
    ?subject ?predicate ?object .
    FILTER(
      ?subject = ?root ||
      STRSTARTS(STR(?subject), CONCAT(STR(?root), "/.well-known/genid/"))
    )
  }
}`,
      targetGraphs,
      { source: DATA_CLEANUP_SOURCE },
    );
    if (updateApplied) return;
  }

  for (const root of roots) {
    for (const graph of targetGraphs) {
      await store.deleteByPattern({ graph, subject: root });
      await store.deleteBySubjectPrefix(graph, `${root}/.well-known/genid/`);
      await store.deleteByPattern({
        graph,
        subject: root,
        predicate: WORKSPACE_OWNER_PREDICATE,
      });
    }
  }
}

/**
 * Clear root ownership and share-operation membership after confirmed publish.
 * Candidate operation subjects are deduplicated in a subquery before their
 * triples are joined, avoiding the N roots x N operation-triples expansion of
 * the normal one-operation/many-roots metadata shape.
 */
export async function clearPublishedSwmRootMetadata(
  store: TripleStore,
  metadataGraph: string,
  rootEntities: readonly string[],
): Promise<PublishedSwmMetadataCleanupResult> {
  const roots = unique(rootEntities);
  if (roots.length === 0) {
    return { roots, mode: 'serial-fallback', ownerDeletedTotal: 0 };
  }

  if (typeof store.update === 'function') {
    assertSafeIri(metadataGraph);
    for (const root of roots) assertSafeIri(root);

    const rootValues = sparqlValues(roots);
    const updateApplied = await tryUpdateWithTouchedGraphs(
      store,
      `DELETE { GRAPH <${metadataGraph}> { ?operation ?predicate ?object } }
WHERE {
  {
    SELECT ?operation
    WHERE {
      {
        SELECT ?operation (COUNT(DISTINCT ?selectedRoot) AS ?selectedRootCount)
        WHERE {
          GRAPH <${metadataGraph}> {
            VALUES ?selectedRoot { ${rootValues} }
            ?operation ?selectedMemberPredicate ?selectedRoot .
            FILTER(?selectedMemberPredicate IN (${MEMBER_PREDICATES}))
          }
        }
        GROUP BY ?operation
      }
      GRAPH <${metadataGraph}> {
        ?operation ?allMemberPredicate ?allRoot .
        FILTER(?allMemberPredicate IN (${MEMBER_PREDICATES}))
      }
    }
    GROUP BY ?operation ?selectedRootCount
    HAVING (COUNT(DISTINCT ?allRoot) = ?selectedRootCount)
  }
  GRAPH <${metadataGraph}> { ?operation ?predicate ?object }
};
DELETE {
  GRAPH <${metadataGraph}> {
    ?root <${WORKSPACE_OWNER_PREDICATE}> ?owner .
    ?operation ?memberPredicate ?root .
  }
}
WHERE {
  GRAPH <${metadataGraph}> {
    VALUES ?root { ${rootValues} }
    { ?root <${WORKSPACE_OWNER_PREDICATE}> ?owner }
    UNION
    {
      ?operation ?memberPredicate ?root .
      FILTER(?memberPredicate IN (${MEMBER_PREDICATES}))
    }
  }
}`,
      [metadataGraph],
      { source: METADATA_CLEANUP_SOURCE },
    );
    if (updateApplied) {
      return { roots, mode: 'batched-update', ownerDeletedTotal: 0 };
    }
  }

  let ownerDeletedTotal = 0;
  for (const root of roots) {
    ownerDeletedTotal += await store.deleteByPattern({
      graph: metadataGraph,
      subject: root,
      predicate: WORKSPACE_OWNER_PREDICATE,
    });
    await deleteSharedMemoryMetadataForRoot(store, metadataGraph, root);
  }
  return { roots, mode: 'serial-fallback', ownerDeletedTotal };
}
