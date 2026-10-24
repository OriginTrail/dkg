import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';

/**
 * Canonical durable-meta admission rule for signed agent-delegation subjects.
 *
 * Both the normal materialized-row responder and the store-bounded paged
 * responder embed this exact expression. Keeping the active-member test here
 * prevents the two paths from independently reimplementing the allow/revoke
 * semantics as JavaScript sets versus SPARQL EXISTS clauses.
 */
export function durableMetaDelegationSubjectAdmissionExpression(
  contextGraphId: string,
): string {
  const cgEntity = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const subjectPrefix = `did:dkg:agent-delegation:${contextGraphId}:`;
  return `(
    STRSTARTS(STR(?s), ${sparqlString(subjectPrefix)})
    && EXISTS {
      GRAPH ?g {
        ?s <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?delegatedAgent .
        <${cgEntity}> (<${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}>|<${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}>) ?memberAgent .
        FILTER(LCASE(STR(?delegatedAgent)) = LCASE(STR(?memberAgent)))
        FILTER NOT EXISTS {
          <${cgEntity}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?revokedAgent .
          FILTER(LCASE(STR(?delegatedAgent)) = LCASE(STR(?revokedAgent)))
        }
      }
    }
  )`;
}
