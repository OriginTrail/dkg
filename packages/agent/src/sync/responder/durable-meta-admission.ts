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
 * Every test here is an exact lookup from `?s`, so its cost follows the number
 * of subjects it is asked about. The one admission rule that is not such a
 * lookup, a subject named by a promoted assertion, is decided in process with
 * {@link createAssertionNameMatcher} from the names
 * {@link durableMetaAssertionNamesQuery} reads.
 *
 * INVARIANT: this expression together with the name matcher is the twin of the
 * in-process admission applied to a session snapshot
 * (`filterDurableMetaSnapshotRows`). The two MUST admit the same subjects and
 * MUST be edited together; the oversized-fallback suite compares them branch by
 * branch.
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
      )`;
}

/** The lexical value of a metadata literal term as the admission rules read it. */
export function durableMetaLiteralValue(value: string | undefined): string {
  if (!value) return '';
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
}

/** Marks the subjects the assertion-name rule can admit. */
export const DURABLE_META_ASSERTION_SUBJECT_MARKER = '/assertion/';

/**
 * The names of the assertions of `graph` that left working memory, one row a
 * distinct name (`?name`), at most `limit` rows. One pass over the lifecycle
 * records that carry a name.
 */
export function durableMetaAssertionNamesQuery(graph: string, limit: number): string {
  return `
    SELECT DISTINCT ?name WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?anLifecycle <${DKG_ASSERTION_NAME}> ?an ; <${DKG_MEMORY_LAYER}> ?ml }
      FILTER(?ml != ${sparqlString(MemoryLayer.WorkingMemory)})
      BIND(STR(?an) AS ?name)
      FILTER(?name != "")
    }
    LIMIT ${Math.max(0, Math.floor(limit))}
  `;
}

/**
 * The assertion-name rule: a subject under an assertion path whose path ends
 * with `/<name>` for the name of an assertion that left working memory. Names
 * are indexed by their last path segment, so a subject is compared with the
 * few names that share its last segment and not with every name.
 */
export function createAssertionNameMatcher(names: Iterable<string>): (subject: string) => boolean {
  const namesByTail = new Map<string, string[]>();
  for (const name of names) {
    if (!name) continue;
    const tail = name.slice(name.lastIndexOf('/') + 1);
    const sameTail = namesByTail.get(tail);
    if (sameTail) sameTail.push(name);
    else namesByTail.set(tail, [name]);
  }
  return (subject) => {
    if (!subject.includes(DURABLE_META_ASSERTION_SUBJECT_MARKER)) return false;
    const tail = subject.slice(subject.lastIndexOf('/') + 1);
    return (namesByTail.get(tail) ?? []).some((name) => subject.endsWith(`/${name}`));
  };
}
