import {
  assertSafeIri,
  contextGraphMetaGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import {
  BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  tryPruneRankedSubjects,
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
      FILTER NOT EXISTS {
        ?request <${REQUEST_STATUS}> ?nonTerminalStatus .
        FILTER(?nonTerminalStatus NOT IN ("approved", "rejected"))
      }
      FILTER(STRSTARTS(STR(?request), ${sparqlString(JOIN_REQUEST_SUBJECT_PREFIX)}))
    }
  `;
}

/**
 * Delete terminal join-request subjects beyond the newest `maxRecords`.
 *
 * Pending requests are never candidates. Production stores prune wholly in a
 * server-side atomic operation that rechecks terminal state at commit time.
 * Legacy stores without that capability skip this resource-hygiene pass: a
 * select-then-delete fallback could erase a subject concurrently reused as a
 * pending request.
 */
export async function pruneTerminalJoinRequestRecords(
  store: TripleStore,
  contextGraphId: string,
  maxRecords = MAX_TERMINAL_JOIN_REQUEST_RECORDS_PER_CONTEXT_GRAPH,
): Promise<void> {
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
  if (overflow === 0) return;

  // Drain the pre-counted overflow in independently scheduled batches. Each
  // mutation rechecks terminal eligibility atomically, and releasing the store
  // scheduler between batches prevents a large historical backlog from holding
  // one unbounded mutation permit.
  let remainingOverflow = overflow;
  while (remainingOverflow > 0) {
    const batchSize = Math.min(
      remainingOverflow,
      BOUNDED_MUTATION_MAX_PRUNE_DELETE,
    );
    const supported = await tryPruneRankedSubjects(store, {
      graphUri: metaGraph,
      subjectPrefix: JOIN_REQUEST_SUBJECT_PREFIX,
      eligibilityPredicate: REQUEST_STATUS,
      eligibleObjects: ['approved', 'rejected'],
      primaryRankPredicate: DECISION_TIMESTAMP,
      secondaryRankPredicate: REQUEST_TIMESTAMP,
      retainNewest: cap,
      maxDelete: batchSize,
    }, { priority: 'background', source: 'join.moderationRetention.prune' });
    if (!supported) return;
    remainingOverflow -= batchSize;
  }
}
