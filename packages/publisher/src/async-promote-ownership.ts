import { isRetiredBoundRejection } from './promote-no-effect-rejection.js';
import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob } from './async-promote-queue-types.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_CONTEXT_GRAPH_ID, PROMOTE_ASSERTION_NAME, PROMOTE_STATE,
  PROMOTE_UNIQUENESS_KEY, PROMOTE_PAYLOAD, expectBindings, literal, parseJobPayload,
  promoteLaneConflictScope, promoteLaneScopesConflict, uniquenessLookupKeys,
  type PromoteUniquenessInput } from './async-promote-queue-utils.js';

export type PromoteOwnershipReader = (request: PromoteUniquenessInput) => Promise<PromoteJob | undefined>;

/** The in-lock conflict check's source label: the queue passes it with the share control options. */
export const FIND_ACTIVE_CONFLICT_SOURCE = 'publisher.asyncPromote.findActiveConflict';

/**
 * The lock-free lifecycle reader reads outside the queue's mutex, so it is not share control work (OT-RFC-73 S1): its own source,
 * no control options, and the lane of its caller.
 */
const OWNERSHIP_READER_OPTIONS: QueryOptions = { source: 'publisher.asyncPromote.ownershipReader' };

/** Explicit scope: constructing another queue never changes this reader's authority. */
export function createPromoteOwnershipReader(store: TripleStore,
  graph: string = DEFAULT_PROMOTE_CONTROL_GRAPH_URI): PromoteOwnershipReader {
  return async request => (await readPromoteOwnershipCandidates(store, graph, promoteOwnershipLookup(request), OWNERSHIP_READER_OPTIONS))
    .find(hasUnfinishedBoundObligation);
}
export function hasUnfinishedBoundObligation(job: Omit<PromoteJob, 'state'> & { state: string }): boolean {
  return job.request.recoveryBinding !== undefined && job.state !== 'succeeded' && !isRetiredBoundRejection(job);
}
export function storedPromoteLaneScope(job: PromoteJob) {
  return promoteLaneConflictScope(job.request, {
    missingAgentAddressMatchesAnyLane: (job.formatVersion ?? 0) < 3 && job.request.agentAddress === undefined,
  });
}
export function promoteOwnershipLookup(request: PromoteUniquenessInput, missingLaneMatchesAnyLane = false) {
  return { request, lookupQuery: missingLaneMatchesAnyLane
    ? { kind: 'assertionWildcard' as const }
    : { kind: 'uniquenessKeys' as const, keys: uniquenessLookupKeys(request) },
  laneScope: promoteLaneConflictScope(request, { missingAgentAddressMatchesAnyLane: missingLaneMatchesAnyLane }) };
}
export type PromoteConflictLookup = ReturnType<typeof promoteOwnershipLookup>;

/**
 * Every serialized bound job carries this property name inside its payload JSON (`request.recoveryBinding`), so a
 * payload without it cannot hold an unfinished bound obligation. Used only as a SUPERSET filter inside SPARQL; the
 * exact decision (`hasUnfinishedBoundObligation`) is still taken in JS on the rows that come back.
 */
const BOUND_REQUEST_MARKER = 'recoveryBinding';

/**
 * The candidate query of a conflict lookup. It returns the original query's rows MINUS the rows that can never decide the lookup:
 *  - state `succeeded`: not an ACTIVE state and `hasUnfinishedBoundObligation` is false by definition;
 *  - state `failed` whose payload has no `recoveryBinding`: not ACTIVE and not a bound obligation.
 * Everything else (queued, running, failed_retrying, bound failed rows, a missing or unrecognised state triple) still comes back and is
 * decoded and judged by the unchanged JS code, so an unreadable row in those classes still fails closed exactly as before.
 *
 * Narrowings accepted for corrupted rows only (OT-RFC-73 D-5; pinned by test/async-promote-bounded-lookup.test.ts, documented in docs/api/async-share-admission.md):
 *  - D1/D2: a row whose state triple says `succeeded`, or `failed` with a payload that shows no `recoveryBinding`, is no longer decoded, so an unreadable payload
 *    there no longer throws `KA_PROMOTE_RECOVERY_REQUIRED`. Such a row cannot be a conflict; the other classes still fail closed.
 *  - D3 (not producible by the queue, which writes both in one atomic replace): a state triple that disagrees with its payload is judged by the triple.
 *  - D4: `findActiveConflict` observes every returned job, and terminal rows are not returned any more, so a lookup no longer clears another process's stale
 *    owner observation of a job that became terminal there. That observation still expires after five minutes or on any read of that job.
 *
 * Index shape: each uniqueness key is a CONSTANT object of a `?job <uniquenessKey> "<key>"` triple pattern (a POS-index range scan whose
 * size is the number of jobs ever stored under that key, never the whole history), followed by a bound-subject payload / state lookup per row.
 * The original `?job <uniquenessKey> ?key . FILTER (?key IN (...))` leaves the key unbound and filters AFTER enumerating every job.
 *
 * Multiplicity: a SPARQL solution sequence is a BAG and every UNION branch / VALUES entry that matches contributes its own solution. The key list is already a
 * set of distinct spellings (`uniquenessLookupKeys`; the builder de-duplicates once more so that it never emits two branches for one string), but an engine may
 * identify two DIFFERENT spellings with ONE stored term: on Blazegraph a job stored under the legacy key or under the default-lane key (spellings that differ only
 * by a trailing U+001F) came back twice, once per branch / entry, where the original single `?key IN (...)` pattern returned it once. `readPromoteOwnershipCandidates`
 * therefore keeps a candidate once however often the engine repeated its row (identical payload text = the same job record). That restores the original's row
 * multiplicity without a DISTINCT in the query, so the query text, and the plan measured on the engine for it, is unchanged.
 */
export function buildPromoteOwnershipCandidateQuery(graph: string, lookup: PromoteConflictLookup): string {
  const keep = `FILTER (!BOUND(?state) || (!sameTerm(?state, "succeeded") && `
    + `(!sameTerm(?state, "failed") || CONTAINS(STR(?payload), ${literal(BOUND_REQUEST_MARKER)}))))`;
  const optionalState = `OPTIONAL { ?job <${PROMOTE_STATE}> ?state . }`;
  if (lookup.lookupQuery.kind === 'assertionWildcard') {
    return `SELECT ?payload WHERE { GRAPH <${graph}> {
    ?job <${PROMOTE_CONTEXT_GRAPH_ID}> ${literal(lookup.request.contextGraphId)} ; <${PROMOTE_ASSERTION_NAME}> ${literal(lookup.request.assertionName)} ; <${PROMOTE_PAYLOAD}> ?payload .
    ${optionalState} ${keep}
  } }`;
  }
  const branches = Array.from(new Set(lookup.lookupQuery.keys)).map(key => `?job <${PROMOTE_UNIQUENESS_KEY}> ${literal(key)} ; <${PROMOTE_PAYLOAD}> ?payload .`);
  const keyed = branches.length === 1 ? branches[0]! : branches.map(branch => `{ ${branch} }`).join(' UNION ');
  return `SELECT ?payload WHERE { GRAPH <${graph}> {
    ${keyed}
    ${optionalState} ${keep}
  } }`;
}

/**
 * One trusted queue reader for admission conflicts and lifecycle ownership. `options` is the caller's: the queue's in-lock check passes the
 * share control options, the lifecycle reader its own source and nothing else. Without them the read keeps the conflict-check source on the caller's lane.
 */
export async function readPromoteOwnershipCandidates(store: TripleStore, graph: string,
  lookup: PromoteConflictLookup, options: QueryOptions = { source: FIND_ACTIVE_CONFLICT_SOURCE }): Promise<PromoteJob[]> {
  const rows = expectBindings(await store.query(buildPromoteOwnershipCandidateQuery(graph, lookup), options));
  const seen = new Set<string>();      // a job is a candidate once, however many branches / entries the engine matched it through (see the builder)
  return rows.filter(row => (seen.has(row.payload) ? false : (seen.add(row.payload), true))).map(row => {
    const job = parseJobPayload(row.payload);
    if (!job) throw Object.assign(new Error('Conflicting share ownership record is unreadable; inspection required'),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    return job;
  }).filter(job => promoteLaneScopesConflict(storedPromoteLaneScope(job), lookup.laneScope));
}
