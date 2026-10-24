import { assertSafeIri, contextGraphMetaUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { stripSparqlLiteralValue } from './query-binding.js';

/** Read canonical local routing facts; recovery owns authentication and provenance. */
export function registeredSubGraphPattern(contextGraphId: string): string {
  return registeredSubGraphBranches(contextGraphId).map(branch => `{ ${branch} }`).join(' UNION ');
}
/** Separate branches let callers compose a flat UNION on Blazegraph 2.1.5. */
export function registeredSubGraphBranches(contextGraphId: string): string[] {
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  return [
    `GRAPH <${meta}> { ?subGraph a <http://dkg.io/ontology/SubGraph> ; <http://schema.org/name> ?name . }`,
    `GRAPH <${meta}> { ?asset <http://dkg.io/ontology/authenticatedSubGraphName> ?name . }`,
  ];
}
export function decodeRegisteredSubGraphName(value: string | undefined): string | undefined {
  const name = stripSparqlLiteralValue(value);
  return validateSubGraphName(name).valid ? name : undefined;
}
