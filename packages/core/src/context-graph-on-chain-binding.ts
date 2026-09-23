// SPDX-License-Identifier: Apache-2.0

import { contextGraphDataUri, contextGraphMetaUri } from './constants.js';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from './genesis.js';

/** Predicate of a Context Graph's durable on-chain id binding. */
export const CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;

/**
 * SELECT `?id`: the durable on-chain id binding of one Context Graph.
 *
 * A public graph keeps the binding in the `ontology` system graph, next to its
 * definition. A curated or private graph keeps it only in its own `_meta`
 * graph, with the rest of its metadata. Registration writes the same
 * immutable value to each place it uses; the ontology copy wins when both
 * exist, as it did when it was the only one read.
 */
export function contextGraphOnChainIdBindingQuery(contextGraphId: string): string {
  const subject = contextGraphDataUri(contextGraphId);
  const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  return `SELECT ?id WHERE {
    OPTIONAL { GRAPH <${ontologyGraph}> { <${subject}> <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?ontologyId } }
    OPTIONAL { GRAPH <${metaGraph}> { <${subject}> <${CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE}> ?metaId } }
    BIND(COALESCE(?ontologyId, ?metaId) AS ?id)
    FILTER(BOUND(?id))
  } LIMIT 1`;
}
