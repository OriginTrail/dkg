import {
  DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  assertSafeIri,
  contextGraphDataGraphUri,
  sparqlString,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';

const DKG = 'http://dkg.io/ontology/';
const DKG_CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const DKG_STATUS = `${DKG}status`;
const DKG_MEMORY_LAYER = `${DKG}memoryLayer`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_ASSERTION_NAME = `${DKG}assertionName`;
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated';
const PROV_USED = 'http://www.w3.org/ns/prov#used';
const DKG_JOIN_REQUEST_SUBJECT_PREFIX = 'did:dkg:join-request:';

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

/**
 * Pending join requests are curator-only moderation records: a subject under
 * their prefix is never durable metadata, whatever else admits it.
 */
export function durableMetaJoinRequestExclusionExpression(): string {
  return `(!isIRI(?s) || !STRSTARTS(STR(?s), ${sparqlString(DKG_JOIN_REQUEST_SUBJECT_PREFIX)}))`;
}

/**
 * Store-side durable-meta admission of the subject `?s` in the metadata graph
 * `?g`. Admission is decided per subject: every row of an admitted subject is
 * durable metadata.
 *
 * INVARIANT: this is the SPARQL twin of the in-process admission applied to a
 * session snapshot (`filterDurableMetaSnapshotRows`). The two MUST admit the
 * same subjects and MUST be edited together; the oversized-fallback suite
 * compares them branch by branch.
 */
export function durableMetaSubjectAdmissionExpression(
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
): string {
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const notWorking = `FILTER(?ml != ${sparqlString(MemoryLayer.WorkingMemory)})`;
  const registeredSubGraphSubjects = [...new Set(registeredSubGraphNames)]
    .filter((name) => validateSubGraphName(name).valid)
    .map((name) => `<${assertSafeIri(`${cgEntity}/${name}`)}>`);
  const registeredSubGraphClause = registeredSubGraphSubjects.length
    ? `|| ?s IN (${registeredSubGraphSubjects.join(', ')})`
    : '';
  return `(
        ?s = <${assertSafeIri(cgEntity)}>
        || ${durableMetaDelegationSubjectAdmissionExpression(contextGraphId)}
        ${registeredSubGraphClause}
        || STRSTARTS(STR(?s), "did:dkg:activity:")
        || EXISTS {
             GRAPH ?g {
               ?s <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion ;
                  <${DKG_STATUS}> ${sparqlString('confirmed')} .
             }
             FILTER(STR(?scopeVersion) = ${sparqlString(String(GRAPH_KA_CONTENT_SCOPE_VERSION))})
             FILTER(REGEX(STR(?s), "^did:dkg:[^/]+/0x[0-9A-Fa-f]{40}/[0-9]+$"))
           }
        || EXISTS { GRAPH ?g { ?s <${DKG_MEMORY_LAYER}> ?ml } ${notWorking} }
        || EXISTS { GRAPH ?g { ?agLifecycle <${DKG_ASSERTION_GRAPH}> ?s ; <${DKG_MEMORY_LAYER}> ?ml } ${notWorking} }
        || EXISTS {
             GRAPH ?g { ?s (<${PROV_GENERATED}>|<${PROV_USED}>) ?evLifecycle . ?evLifecycle <${DKG_MEMORY_LAYER}> ?ml }
             ${notWorking}
           }
        || (
             CONTAINS(STR(?s), "/assertion/") &&
             EXISTS {
               GRAPH ?g { ?anLifecycle <${DKG_ASSERTION_NAME}> ?an ; <${DKG_MEMORY_LAYER}> ?ml }
               ${notWorking}
               FILTER(STR(?an) != "")
               FILTER(STRENDS(STR(?s), CONCAT("/", STR(?an))))
             }
           )
      )`;
}
