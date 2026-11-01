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
      && typeof (candidate as Partial<SparqlEngineCapability>).sparqlEngine === 'string')?.sparqlEngine ?? null;
}
