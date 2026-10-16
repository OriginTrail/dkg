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
 * {@link createAssertionNameMatcher} from the lifecycle records
 * {@link durableMetaPromotedAssertionsQuery} reads, and asked again per subject
 * by {@link durableMetaNamedSubjectRowsQuery}.
 *
 * INVARIANT: this expression together with the name rule is the twin of the
 * in-process admission applied to a session snapshot
 * (`filterDurableMetaSnapshotRows`). The two MUST admit the same subjects and
 * MUST be edited together; the oversized-fallback suite compares them branch by
 * branch. One deliberate difference: here a name admits a subject only when a
 * lifecycle record with an IRI carries it, because that record is what a page
 * read asks again. Conforming writers emit no other kind.
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

/** Marks the subjects the assertion-name rule can admit. */
export const DURABLE_META_ASSERTION_SUBJECT_MARKER = '/assertion/';

/**
 * The assertions of `graph` that left working memory: one row per lifecycle
 * record with an IRI and a name (`?lifecycle`, `?name`), at most `limit` rows.
 * One pass over the lifecycle records that carry a name.
 */
export function durableMetaPromotedAssertionsQuery(graph: string, limit: number): string {
  return `
    SELECT ?lifecycle ?name WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?lifecycle <${DKG_ASSERTION_NAME}> ?an ; <${DKG_MEMORY_LAYER}> ?ml }
      FILTER(isIRI(?lifecycle))
      FILTER(?ml != ${sparqlString(MemoryLayer.WorkingMemory)})
      BIND(STR(?an) AS ?name)
      FILTER(?name != "")
    }
    LIMIT ${Math.max(0, Math.floor(limit))}
  `;
}

/**
 * The rows (`?s ?p ?o`) of the subjects, among pairs of a subject and the
 * lifecycle record that named it, that the record still names: it still
 * carries a name the subject's path ends with and has not gone back to working
 * memory.
 *
 * One group on purpose: the pairs, the record's two rows and the subject's
 * rows. With the record test in a sub-select of its own, a store may read the
 * subjects' rows without the pairs; measured on a managed Oxigraph that made
 * this read grow with the graph, while this form stays an exact lookup per
 * pair. DISTINCT, because a record with two names or two layers would
 * otherwise repeat the subject's rows.
 */
export function durableMetaNamedSubjectRowsQuery(
  graph: string,
  pairs: ReadonlyArray<readonly [subject: string, lifecycle: string]>,
): string {
  const values = pairs
    .map(([subject, lifecycle]) => `(<${assertSafeIri(subject)}> <${assertSafeIri(lifecycle)}>)`)
    .join(' ');
  return `
      SELECT DISTINCT ?s ?p ?o WHERE {
        VALUES (?s ?lifecycle) { ${values} }
        GRAPH <${assertSafeIri(graph)}> {
          ?lifecycle <${DKG_ASSERTION_NAME}> ?an ; <${DKG_MEMORY_LAYER}> ?ml .
          ?s ?p ?o
        }
        FILTER(?ml != ${sparqlString(MemoryLayer.WorkingMemory)})
        FILTER(STR(?an) != "")
        FILTER(STRENDS(STR(?s), CONCAT("/", STR(?an))))
      }
    `;
}

/**
 * The assertion-name rule: a subject under an assertion path whose path ends
 * with `/<name>` for the name of an assertion that left working memory; the
 * matcher returns that name. Names are indexed by their last path segment, so
 * a subject is compared with the few names that share its last segment and
 * not with every name.
 */
export function createAssertionNameMatcher(names: Iterable<string>): (subject: string) => string | undefined {
  const namesByTail = new Map<string, string[]>();
  for (const name of names) {
    if (!name) continue;
    const tail = name.slice(name.lastIndexOf('/') + 1);
    const sameTail = namesByTail.get(tail);
    if (sameTail) sameTail.push(name);
    else namesByTail.set(tail, [name]);
  }
  return (subject) => {
    if (!subject.includes(DURABLE_META_ASSERTION_SUBJECT_MARKER)) return undefined;
    const tail = subject.slice(subject.lastIndexOf('/') + 1);
    return namesByTail.get(tail)?.find((name) => subject.endsWith(`/${name}`));
  };
}
