import { findTripleStoreCapability } from './triple-store.js';

/** SPARQL engines whose evaluation the query layer relies on by name. */
export type SparqlEngineFamily = 'oxigraph';

interface SparqlEngineCapability {
  readonly sparqlEngine: SparqlEngineFamily;
}

/** The engine behind a store, through its decorators; null when the store doesn't know. */
export function sparqlEngineOf(store: unknown): SparqlEngineFamily | null {
  return findTripleStoreCapability(store, (candidate): candidate is SparqlEngineCapability =>
    typeof candidate === 'object' && candidate !== null
      && (candidate as Partial<SparqlEngineCapability>).sparqlEngine === 'oxigraph')?.sparqlEngine ?? null;
}

interface DefaultGraphUnionCapability {
  readonly defaultGraphIsGraphUnion: true;
}

/**
 * Whether the store answers a pattern outside GRAPH, in a query that names no
 * dataset, from the set merge of all its graphs, and lets `GRAPH ?g` range over
 * every graph of that merge, its own default graph included.
 */
export function storeDefaultGraphIsGraphUnion(store: unknown): boolean {
  return findTripleStoreCapability(store, (candidate): candidate is DefaultGraphUnionCapability =>
    typeof candidate === 'object' && candidate !== null
      && (candidate as Partial<DefaultGraphUnionCapability>).defaultGraphIsGraphUnion === true) !== null;
}

interface QueryDatasetRestrictionCapability {
  readonly restrictsQueryDataset: true;
}

/**
 * Whether the store behind these decorators answers `withheldGraphRoots` by
 * restricting the query's dataset. A store that does not refuses such a query.
 */
export function storeRestrictsQueryDataset(store: unknown): boolean {
  return findTripleStoreCapability(store, (candidate): candidate is QueryDatasetRestrictionCapability =>
    typeof candidate === 'object' && candidate !== null
      && (candidate as Partial<QueryDatasetRestrictionCapability>).restrictsQueryDataset === true) !== null;
}
