import { sparqlString } from '@origintrail-official/dkg-core/dist/sparql-safe.js';

/** Build the graph-prefix filter shared by profile and agent metadata reads. */
export function metaGraphPrefixFilter(contextGraphId: string): string {
  const prefix = `did:dkg:context-graph:${contextGraphId}/meta`;
  return `FILTER(strstarts(str(?g), ${sparqlString(prefix)}))`;
}
