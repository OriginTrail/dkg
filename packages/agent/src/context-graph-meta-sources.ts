import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { ACCESS_ROW_ROOT_PREDICATES } from './curator-meta-member-list.js';

/**
 * What the shared system graphs may state about a context graph. A graph's access
 * list comes from its own `_meta`, or from its authoritative roster where it has
 * one. The readers of these graphs apply the rules below to a fact's predicate and
 * to the lexical form of its object.
 */

export const LEGACY_SCHEMA_NS = 'http://schema.org/';

// The `agents` system graph holds agents' profiles. About a context graph it can
// declare existence, a description and a restriction, nothing that says who speaks
// for the graph or who may access it.
const AGENTS_GRAPH_META_PREDICATES: ReadonlySet<string> = new Set([
  DKG_ONTOLOGY.RDF_TYPE,
  DKG_ONTOLOGY.SCHEMA_NAME,
  `${LEGACY_SCHEMA_NS}name`,
  DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
  `${LEGACY_SCHEMA_NS}description`,
  DKG_ONTOLOGY.DKG_CREATED_AT,
  DKG_ONTOLOGY.DKG_ACCESS_POLICY,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
]);

/** Whether the `agents` graph may state this fact about a context graph. */
export function agentsGraphMayState(predicate: string, object: string): boolean {
  return AGENTS_GRAPH_META_PREDICATES.has(predicate)
    // A policy from this graph can only make a graph private, never public.
    && (predicate !== DKG_ONTOLOGY.DKG_ACCESS_POLICY || object.trim().toLowerCase() !== 'public');
}

/**
 * Whether the `ontology` graph may state this fact about a context graph. It is the
 * catalogue of public graphs: it keeps their definition, and no access row.
 */
export function ontologyGraphMayState(predicate: string): boolean {
  return !ACCESS_ROW_ROOT_PREDICATES.has(predicate);
}
