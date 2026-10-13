import { assertSafeIri, contextGraphMetaUri, contextGraphDataUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { stripSparqlLiteralValue } from './query-binding.js';

/** Read registrations and locally authenticated snapshot descriptors, never peer control records.
 * Descriptor discovery adds routing facts only; existing graph and memory-layer fences still apply.
 */
export function registeredSubGraphPattern(contextGraphId: string): string {
  return `GRAPH <${assertSafeIri(contextGraphMetaUri(contextGraphId))}> {
    { ?subGraph a <http://dkg.io/ontology/SubGraph> ; <http://schema.org/name> ?name . }
    UNION {
      ?asset <http://dkg.io/ontology/kaUal> ?asset ;
        <http://dkg.io/ontology/contentScopeVersion> 2 ;
        <http://dkg.io/ontology/contextGraph> <${assertSafeIri(contextGraphDataUri(contextGraphId))}> ;
        <http://dkg.io/ontology/status> "confirmed" ;
        <http://dkg.io/ontology/chainSnapshotDigest> ?snapshotDigest ;
        <http://dkg.io/ontology/assertionGraph> ?recoveredGraph ;
        <http://dkg.io/ontology/subGraphName> ?name .
      FILTER(STRSTARTS(STR(?recoveredGraph), CONCAT("${assertSafeIri(contextGraphDataUri(contextGraphId))}/", STR(?name), "/_verifiable_memory/")))
    }
  }`;
}
export function decodeRegisteredSubGraphName(value: string | undefined): string | undefined {
  const name = stripSparqlLiteralValue(value);
  return validateSubGraphName(name).valid ? name : undefined;
}
