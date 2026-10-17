import { isRetiredBoundRejection } from './promote-no-effect-rejection.js';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob } from './async-promote-queue-types.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_CONTEXT_GRAPH_ID, PROMOTE_ASSERTION_NAME,
  PROMOTE_UNIQUENESS_KEY, PROMOTE_PAYLOAD, expectBindings, literal, parseJobPayload,
  promoteLaneConflictScope, promoteLaneScopesConflict, uniquenessLookupKeys,
  type PromoteUniquenessInput } from './async-promote-queue-utils.js';

export type PromoteOwnershipReader = (request: PromoteUniquenessInput) => Promise<PromoteJob | undefined>;

/** Explicit scope: constructing another queue never changes this reader's authority. */
export function createPromoteOwnershipReader(store: TripleStore,
  graph: string = DEFAULT_PROMOTE_CONTROL_GRAPH_URI): PromoteOwnershipReader {
  return async request => (await readPromoteOwnershipCandidates(store, graph, promoteOwnershipLookup(request)))
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

/** One trusted queue reader for admission conflicts and lifecycle ownership. */
export async function readPromoteOwnershipCandidates(store: TripleStore, graph: string,
  lookup: PromoteConflictLookup): Promise<PromoteJob[]> {
  const selection = lookup.lookupQuery.kind === 'assertionWildcard'
    ? `<${PROMOTE_CONTEXT_GRAPH_ID}> ${literal(lookup.request.contextGraphId)} ; <${PROMOTE_ASSERTION_NAME}> ${literal(lookup.request.assertionName)} ;`
    : `<${PROMOTE_UNIQUENESS_KEY}> ?key ;`;
  const filter = lookup.lookupQuery.kind === 'uniquenessKeys'
    ? `FILTER (?key IN (${lookup.lookupQuery.keys.map(literal).join(', ')}))` : '';
  const rows = expectBindings(await store.query(`SELECT ?payload WHERE { GRAPH <${graph}> {
    ?job ${selection} <${PROMOTE_PAYLOAD}> ?payload . ${filter}
  } }`, { source: 'publisher.asyncPromote.findActiveConflict' }));
  return rows.map(row => {
    const job = parseJobPayload(row.payload);
    if (!job) throw Object.assign(new Error('Conflicting share ownership record is unreadable; inspection required'),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    return job;
  }).filter(job => promoteLaneScopesConflict(storedPromoteLaneScope(job), lookup.laneScope));
}
