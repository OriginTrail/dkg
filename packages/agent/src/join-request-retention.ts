import {
  assertSafeIri,
  contextGraphMetaGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

const JOIN_REQUEST_SUBJECT_PREFIX = 'did:dkg:join-request:';
const REQUEST_STATUS = 'https://dkg.network/ontology#requestStatus';
const REQUEST_TIMESTAMP = 'https://dkg.network/ontology#requestTimestamp';
const DECISION_TIMESTAMP = 'https://dkg.network/ontology#decisionTimestamp';

/**
 * Terminal moderation resources are useful for curator diagnostics, but unlike
 * pending requests they do not participate in admission. Keep a generous,
 * deterministic per-CG tail so churn cannot grow `_meta` without bound.
 */
export const MAX_TERMINAL_JOIN_REQUEST_RECORDS_PER_CONTEXT_GRAPH = 10_000;

function bindingInteger(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/^-?\d+|^"(-?\d+)"/);
  const parsed = Number(match?.[1] ?? match?.[0] ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function terminalJoinRequestWhere(metaGraph: string): string {
  return `
    GRAPH <${assertSafeIri(metaGraph)}> {
      ?request <${REQUEST_STATUS}> ?status .
      OPTIONAL { ?request <${REQUEST_TIMESTAMP}> ?requestTimestamp }
      OPTIONAL { ?request <${DECISION_TIMESTAMP}> ?decisionTimestamp }
      VALUES ?status { "approved" "rejected" }
      FILTER(STRSTARTS(STR(?request), ${sparqlString(JOIN_REQUEST_SUBJECT_PREFIX)}))
    }
  `;
}

/**
 * Delete terminal join-request subjects beyond the newest `maxRecords`.
 *
 * Pending requests are never candidates. Production stores prune wholly in a
 * server-side SPARQL update; the compatibility fallback materializes only the
 * overflow subject IDs, never their full moderation payloads.
 */
export async function pruneTerminalJoinRequestRecords(
  store: TripleStore,
  contextGraphId: string,
  maxRecords = MAX_TERMINAL_JOIN_REQUEST_RECORDS_PER_CONTEXT_GRAPH,
): Promise<number> {
  const cap = Math.max(0, Math.floor(maxRecords));
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const countResult = await store.query(`
    SELECT (COUNT(DISTINCT ?request) AS ?count) WHERE {
      ${terminalJoinRequestWhere(metaGraph)}
    }
  `, { priority: 'background', source: 'join.moderationRetention.count' });
  const total = countResult.type === 'bindings'
    ? bindingInteger(countResult.bindings[0]?.['count'])
    : 0;
  const overflow = Math.max(0, total - cap);
  if (overflow === 0) return 0;

  const overflowSelection = `
    SELECT ?request
           (MAX(?decisionTimestamp) AS ?latestDecisionTimestamp)
           (MAX(?requestTimestamp) AS ?latestRequestTimestamp)
    WHERE {
      ${terminalJoinRequestWhere(metaGraph)}
    }
    GROUP BY ?request
    ORDER BY DESC(COALESCE(
      xsd:integer(STR(?latestDecisionTimestamp)),
      xsd:integer(STR(?latestRequestTimestamp)),
      0
    )) DESC(STR(?request))
    OFFSET ${cap}
  `;

  if (typeof store.update === 'function') {
    await store.update(`
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      DELETE { GRAPH <${assertSafeIri(metaGraph)}> { ?request ?predicate ?object } }
      WHERE {
        { ${overflowSelection} }
        GRAPH <${assertSafeIri(metaGraph)}> { ?request ?predicate ?object }
      }
    `, {
      touchedGraphs: [metaGraph],
      priority: 'background',
      source: 'join.moderationRetention.prune',
    });
    return overflow;
  }

  const result = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    ${overflowSelection}
  `, { priority: 'background', source: 'join.moderationRetention.selectOverflow' });
  if (result.type !== 'bindings') return 0;
  const subjects = result.bindings
    .map((row) => row['request'])
    .filter((subject): subject is string => Boolean(subject));
  for (const subject of subjects) {
    await deleteByPatternWithoutCount(
      store,
      { graph: metaGraph, subject },
      { priority: 'background', source: 'join.moderationRetention.pruneFallback' },
    );
  }
  return subjects.length;
}
