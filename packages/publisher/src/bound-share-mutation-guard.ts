import type { TripleStore } from '@origintrail-official/dkg-storage';
import { expectBindings, literal, normalizePromoteAgentLane, parseJobPayload, uniquenessLookupKeys,
  PROMOTE_UNIQUENESS_KEY, PROMOTE_PAYLOAD, PROMOTE_STATE } from './async-promote-queue-utils.js';

/** Called under the publisher lifecycle lock, including after its own SWM tail completes. */
export async function assertNoUnfinishedBoundShare(
  store: TripleStore, contextGraphId: string, assertionName: string, agentAddress: string, subGraphName?: string,
): Promise<void> {
  const keys = uniquenessLookupKeys({ contextGraphId, assertionName, agentAddress, subGraphName });
  const rows = expectBindings(await store.query(`SELECT ?payload WHERE { GRAPH ?controlGraph {
    ?job <${PROMOTE_UNIQUENESS_KEY}> ?key ; <${PROMOTE_STATE}> ?state ; <${PROMOTE_PAYLOAD}> ?payload .
    FILTER (?key IN (${keys.map(literal).join(', ')})) FILTER (?state != "succeeded")
  } }`, { source: 'publisher.assertion.boundRecoveryMutationGuard' }));
  for (const row of rows) {
    const job = parseJobPayload(row.payload);
    if (!job) throw Object.assign(new Error('Share ownership is unreadable; preserve the sealed asset for inspection'),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    if (!job.request.recoveryBinding || job.state === 'succeeded'
      || normalizePromoteAgentLane(job.request.agentAddress) !== normalizePromoteAgentLane(agentAddress)) continue;
    throw Object.assign(new Error('The original share still owns recovery; wait for its completion before changing the sealed asset'),
      { code: 'KA_PROMOTE_RECOVERY_REQUIRED', recoveryJobId: job.jobId });
  }
}
