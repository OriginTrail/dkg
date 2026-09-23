// SPDX-License-Identifier: Apache-2.0

/**
 * Move curated and local-only Context Graph metadata out of the shared
 * `ontology` system graph and into each graph's own `_meta`.
 *
 * `ontology` is the network-wide catalogue of public graphs. A curated or
 * `private: true` graph's metadata belongs in its own `_meta`. Earlier builds
 * also wrote some of it to ontology:
 *
 * - the on-chain id binding of a registered curated graph;
 * - the definition of a `private: true` (local-only) graph;
 * - the new name of a renamed curated graph.
 *
 * This pass removes those rows. For a graph this node holds (it has the
 * graph's own `_meta`), facts that `_meta` lacks are copied there first. A
 * graph counts as private when:
 *
 * - this node's own policy for a graph it holds says so;
 * - ontology carries its private definition, or only its name (a public
 *   graph's definition carries its name);
 * - a bare on-chain id binding names a slot the chain proves curated, or a
 *   slot the chain proves isn't live (it may be a curated slot this node's RPC
 *   can't see yet; a public binding comes back with the next sync).
 *
 * A public definition, a held graph whose own policy is public, and a binding
 * to a live public slot are kept. A binding whose slot can't be classified
 * now is kept and retried on the next pass. Chain reads are bounded per pass.
 *
 * A graph with a public definition in ontology is never a candidate, so the
 * common case costs one store query and no chain read.
 */

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const SYSTEM_IDS = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

/** Chain classifications one pass may start; the rest wait for the next pass. */
export const METADATA_RELOCATION_MAX_CHAIN_CLASSIFICATIONS = 16;

/**
 * An on-chain slot named by an ontology binding. `curated` and `public` are
 * proven on a live slot; `inactive` means the chain proved the slot isn't
 * live; `unknown` means no proof either way right now.
 */
export type OntologyBindingSlotClass = 'curated' | 'public' | 'inactive' | 'unknown';

export interface ContextGraphMetadataRelocationDependencies {
  readonly store: TripleStore;
  /**
   * This node's own policy for a graph it holds: `private`, `public`, or
   * `null` when no local policy is known. Consulted only for graphs whose
   * `_meta` this node has.
   */
  readonly localAccessPolicy: (contextGraphId: string) => Promise<'private' | 'public' | null>;
  /**
   * Classify a numeric slot named by a bare binding. Omit to leave bindings
   * that need the chain untouched (no chain access).
   */
  readonly classifyOnChainSlot?: (onChainId: string) => Promise<OntologyBindingSlotClass>;
  /** Defaults to {@link METADATA_RELOCATION_MAX_CHAIN_CLASSIFICATIONS}. */
  readonly maxChainClassifications?: number;
}

export interface ContextGraphMetadataRelocationResult {
  /** Held graphs whose private facts moved from ontology to their `_meta`. */
  readonly movedToMeta: readonly string[];
  /** Graphs not held here whose private rows were deleted from ontology. */
  readonly deletedForeign: number;
  /** Graphs kept because a binding's slot couldn't be classified this pass. */
  readonly unclassified: number;
}

interface OntologyRow {
  readonly predicate: string;
  readonly object: string;
}

interface Candidate {
  readonly ontologyRows: OntologyRow[];
  /** This node has the graph's own `_meta`, so it holds the graph. */
  held: boolean;
}

function stripLiteral(value: string): string {
  return value.replace(/^"|"(?:\^\^<[^>]*>|@[A-Za-z-]+)?$/g, '');
}

async function candidates(store: TripleStore, ontologyGraph: string): Promise<Map<string, Candidate>> {
  // Every context-graph subject in ontology that carries a binding, a policy or
  // a name but no public definition, with all of its ontology rows and whether
  // this node holds the graph. Public definitions are excluded in the store,
  // and one query serves every candidate, so a pass over a large ontology
  // graph costs no per-subject reads.
  const result = await store.query(`
    SELECT ?contextGraph ?predicate ?object ?held WHERE {
      {
        SELECT DISTINCT ?contextGraph WHERE {
          GRAPH <${ontologyGraph}> {
            { ?contextGraph <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?value }
            UNION { ?contextGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?value }
            UNION { ?contextGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?value }
            FILTER NOT EXISTS {
              ?contextGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
              FILTER NOT EXISTS {
                ?contextGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?privatePolicy .
                FILTER(isLiteral(?privatePolicy) && LCASE(STR(?privatePolicy)) = "private")
              }
            }
          }
          FILTER(STRSTARTS(STR(?contextGraph), "${CONTEXT_GRAPH_URI_PREFIX}"))
        }
      }
      # sparql-scan-allow: R4 -- ?contextGraph is bound by the candidate subquery; reads only candidate subjects
      GRAPH <${ontologyGraph}> { ?contextGraph ?predicate ?object }
      BIND(IRI(CONCAT(STR(?contextGraph), "/_meta")) AS ?metaGraph)
      # sparql-scan-allow: R2 -- ?metaGraph is one exact IRI per candidate and EXISTS stops at the first row
      BIND(EXISTS { GRAPH ?metaGraph { ?contextGraph ?metaPredicate ?metaObject } } AS ?held)
    }
  `, { source: 'agent.contextGraphMetadataRelocation.candidates' });
  const bySubject = new Map<string, Candidate>();
  if (result.type !== 'bindings') return bySubject;
  for (const row of result.bindings) {
    const subject = row['contextGraph'];
    const predicate = row['predicate'];
    const object = row['object'];
    if (!subject || !predicate || !object) continue;
    const candidate = bySubject.get(subject) ?? { ontologyRows: [], held: false };
    candidate.ontologyRows.push({ predicate, object });
    candidate.held ||= /^"?true"?(?:\^\^<[^>]*>)?$/.test(row['held'] ?? '');
    bySubject.set(subject, candidate);
  }
  return bySubject;
}

async function rowsOf(store: TripleStore, graph: string, subject: string): Promise<OntologyRow[]> {
  const result = await store.query(`
    SELECT ?predicate ?object WHERE {
      GRAPH <${graph}> { <${subject}> ?predicate ?object }
    }
  `, { source: 'agent.contextGraphMetadataRelocation.subjectRows' });
  if (result.type !== 'bindings') return [];
  return result.bindings.flatMap((row) => (
    row['predicate'] && row['object']
      ? [{ predicate: row['predicate'], object: row['object'] }]
      : []
  ));
}

function safeIriOrNull(value: string): string | null {
  try {
    return assertSafeIri(value);
  } catch {
    return null;
  }
}

export async function relocatePrivateContextGraphMetadata(
  deps: ContextGraphMetadataRelocationDependencies,
): Promise<ContextGraphMetadataRelocationResult> {
  const { store } = deps;
  const ontologyGraph = assertSafeIri(contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY));
  const maxChainClassifications = deps.maxChainClassifications
    ?? METADATA_RELOCATION_MAX_CHAIN_CLASSIFICATIONS;
  const slotClasses = new Map<string, OntologyBindingSlotClass>();
  let chainClassifications = 0;
  const classifySlot = async (onChainId: string): Promise<OntologyBindingSlotClass> => {
    const known = slotClasses.get(onChainId);
    if (known !== undefined) return known;
    if (!deps.classifyOnChainSlot || !/^[1-9]\d*$/.test(onChainId)) return 'unknown';
    if (chainClassifications >= maxChainClassifications) return 'unknown';
    chainClassifications += 1;
    const slotClass = await deps.classifyOnChainSlot(onChainId)
      .catch((): OntologyBindingSlotClass => 'unknown');
    slotClasses.set(onChainId, slotClass);
    return slotClass;
  };

  const movedToMeta: string[] = [];
  let deletedForeign = 0;
  let unclassified = 0;

  for (const [subject, candidate] of await candidates(store, ontologyGraph)) {
    const contextGraphId = subject.slice(CONTEXT_GRAPH_URI_PREFIX.length);
    if (!contextGraphId || SYSTEM_IDS.has(contextGraphId)) continue;
    const safeSubject = safeIriOrNull(subject);
    const metaGraph = safeIriOrNull(contextGraphMetaGraphUri(contextGraphId));
    if (safeSubject === null || metaGraph === null) continue;
    if (contextGraphDataGraphUri(contextGraphId) !== safeSubject) continue;

    const { ontologyRows, held } = candidate;
    const localPolicy = held ? await deps.localAccessPolicy(contextGraphId) : null;
    if (localPolicy === 'public') continue;

    let remove = localPolicy === 'private'
      || ontologyRows.some((row) => (
        row.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY
        && stripLiteral(row.object).trim().toLowerCase() === 'private'
      ))
      || ontologyRows.every((row) => row.predicate === DKG_ONTOLOGY.SCHEMA_NAME);
    if (!remove) {
      const onChainIds = ontologyRows
        .filter((row) => row.predicate === CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE)
        .map((row) => stripLiteral(row.object).trim());
      if (onChainIds.length === 0 || !deps.classifyOnChainSlot) continue;
      let anyUnknown = false;
      for (const onChainId of onChainIds) {
        const slotClass = await classifySlot(onChainId);
        if (slotClass === 'curated' || slotClass === 'inactive') {
          remove = true;
          break;
        }
        if (slotClass === 'unknown') anyUnknown = true;
      }
      if (!remove) {
        if (anyUnknown) unclassified += 1;
        continue;
      }
    }

    const activities = ontologyRows
      .filter((row) => row.predicate === DKG_ONTOLOGY.PROV_GENERATED_BY)
      .map((row) => safeIriOrNull(row.object))
      .filter((activity): activity is string => activity !== null);
    if (held) {
      await copyMissingFactsToMeta(store, ontologyGraph, metaGraph, safeSubject, ontologyRows, activities);
      movedToMeta.push(contextGraphId);
    } else {
      deletedForeign += 1;
    }
    await deleteByPatternWithoutCount(store, { graph: ontologyGraph, subject: safeSubject });
    for (const activity of activities) {
      await deleteByPatternWithoutCount(store, { graph: ontologyGraph, subject: activity });
    }
  }

  if (movedToMeta.length > 0 || deletedForeign > 0) {
    await store.flush?.();
  }
  return { movedToMeta, deletedForeign, unclassified };
}

async function copyMissingFactsToMeta(
  store: TripleStore,
  ontologyGraph: string,
  metaGraph: string,
  subject: string,
  ontologyRows: readonly OntologyRow[],
  activities: readonly string[],
): Promise<void> {
  // `_meta` already holds the authoritative copy of anything it has; only a
  // predicate it lacks is carried over, so a stale ontology value never adds
  // a second name or binding.
  const metaPredicates = new Set((await rowsOf(store, metaGraph, subject)).map((row) => row.predicate));
  const inserts: Quad[] = ontologyRows
    .filter((row) => !metaPredicates.has(row.predicate))
    .map((row) => ({ subject, predicate: row.predicate, object: row.object, graph: metaGraph }));
  // Provenance activity IRIs embed the graph id, so they move with it.
  for (const activity of activities) {
    if ((await rowsOf(store, metaGraph, activity)).length > 0) continue;
    for (const row of await rowsOf(store, ontologyGraph, activity)) {
      inserts.push({ subject: activity, predicate: row.predicate, object: row.object, graph: metaGraph });
    }
  }
  if (inserts.length > 0) {
    await store.insert(inserts, { source: 'agent.contextGraphMetadataRelocation.moveToMeta' });
  }
}
