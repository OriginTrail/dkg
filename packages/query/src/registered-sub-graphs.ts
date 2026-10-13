import { assertSafeIri, contextGraphMetaUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { stripSparqlLiteralValue } from './query-binding.js';

/** Read canonical local routing facts; recovery owns authentication and provenance. */
export function registeredSubGraphPattern(contextGraphId: string): string {
  return `GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
    { ?subGraph a <http://dkg.io/ontology/SubGraph> ; <http://schema.org/name> ?name . }
    UNION { ?asset <http://dkg.io/ontology/authenticatedSubGraphName> ?name . }
  }`;
}
export function decodeRegisteredSubGraphName(value: string | undefined): string | undefined {
  const name = stripSparqlLiteralValue(value);
  return validateSubGraphName(name).valid ? name : undefined;
}
