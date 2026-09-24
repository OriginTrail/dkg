// SPDX-License-Identifier: Apache-2.0

import { contextGraphDataUri, contextGraphMetaUri } from './constants.js';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from './genesis.js';
import { sparqlString } from './sparql-safe.js';

/** Predicate of a Context Graph's durable on-chain id binding. */
export const CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;

/**
 * The on-chain slot an ontology binding names. `curated` and `public` are
 * proven by the chain; `inactive` means the slot doesn't read live and isn't
 * proven curated (never created, not visible to this node yet, or a
 * deactivated public graph); `unknown` means no answer right now.
 */
export type OntologyBindingSlotClass = 'curated' | 'public' | 'inactive' | 'unknown';

/**
 * SELECT `?id`: the durable on-chain id binding of one Context Graph.
 *
 * A public graph keeps the binding in the `ontology` system graph, next to its
 * definition. A curated or private graph keeps it only in its own `_meta`
 * graph, with the rest of its metadata. Registration writes the same
 * immutable value to each place it uses; the ontology copy wins when both
 * exist, as it did when it was the only one read.
 *
 * `onChainIds` restricts the answer to those ids, in each graph before the
 * ontology copy is preferred, so other values in either graph can never hide
 * an allowed one. An empty list matches nothing.
 */
export function contextGraphOnChainIdBindingQuery(
  contextGraphId: string,
  options: { readonly onChainIds?: readonly string[] } = {},
): string {
  const subject = contextGraphDataUri(contextGraphId);
  const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const allowed = options.onChainIds === undefined
    ? undefined
    : options.onChainIds.map((onChainId) => sparqlString(onChainId)).join(', ');
  const only = (variable: string) => (allowed === undefined ? '' : ` FILTER(STR(?${variable}) IN (${allowed}))`);
  return `SELECT ?id WHERE {
    OPTIONAL { GRAPH <${ontologyGraph}> { <${subject}> <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?ontologyId }${only('ontologyId')} }
    OPTIONAL { GRAPH <${metaGraph}> { <${subject}> <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?metaId }${only('metaId')} }
    BIND(COALESCE(?ontologyId, ?metaId) AS ?id)
    FILTER(BOUND(?id))
  } LIMIT 1`;
}
