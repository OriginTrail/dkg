import type { QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJobAccepted, LiftJobState, PersistedLiftJob } from './lift-job.js';
import {
  CONTROL_ACCEPTED_AT,
  CONTROL_NEXT_RETRY_AT,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  integer,
  literal,
} from './async-lift-control-plane.js';
import {
  compareAcceptedJobs,
  expectBindings,
  projectListedLiftJobs,
} from './async-lift-publisher-utils.js';
import { decodeLiftJobPayload } from './lift-job-payload-codec.js';

/**
 * Read-only queue candidate selection. These snapshots never authorize a transition: callers
 * re-read under the appropriate durable ownership lock before acting. Malformed inventory rows
 * are skipped while exact job reads and admission checks retain their strict decoder.
 */
export class LiftJobStoreSelectors {
  constructor(
    private readonly store: Pick<TripleStore, 'query'>,
    private readonly graphUri: string,
    private readonly project: (job: PersistedLiftJob) => PersistedLiftJob,
  ) {}

  async list(filter: { status?: LiftJobState; contextGraphId?: string } = {}): Promise<PersistedLiftJob[]> {
    const statusFilter = filter.status ? `FILTER (?status = ${literal(filter.status)})` : '';
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload . ${statusFilter} } }`,
      { source: 'publisher.asyncLift.list' },
    );
    return this.projectInventory(result, filter.contextGraphId);
  }

  /**
   * Keep every failed row: proof scheduling uses absence to prune earned backoff, so due-time
   * filtering or pagination here would reset deferred held jobs. The snapshot coordinator draws
   * its ordering scope before this one read; accepted and finalized history need not transfer.
   */
  async reconciliationInventory(): Promise<PersistedLiftJob[]> {
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> {
        VALUES ?status { ${['claimed', 'validated', 'broadcast', 'included', 'failed'].map(literal).join(' ')} }
        ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload .
      } }`,
      { source: 'publisher.asyncLift.reconciliationInventory' },
    );
    return this.projectInventory(result);
  }

  /** Select the oldest accepted payload, skipping malformed rows without starving later work. */
  async nextAccepted(): Promise<LiftJobAccepted | undefined> {
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_STATUS}> ${literal('accepted')} ; <${CONTROL_ACCEPTED_AT}> ?acceptedAt ; <${CONTROL_PAYLOAD}> ?payload } }`,
      { source: 'publisher.asyncLift.nextAccepted' },
    );
    return expectBindings(result)
      .map((row) => parseInventoryPayload(row['payload']))
      .filter((job): job is LiftJobAccepted => job?.status === 'accepted')
      .sort(compareAcceptedJobs)
      .at(0);
  }

  /**
   * nextRetryAt has been persisted alongside the payload since the original control-plane
   * schema. Bound the candidate read in the store so each claim avoids parsing terminal failure
   * history. The caller still checks the canonical payload's timestamp and retry eligibility.
   */
  async dueRetries(now: number): Promise<PersistedLiftJob[]> {
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> {
        ?job <${CONTROL_STATUS}> ${literal('failed')} ;
          <${CONTROL_NEXT_RETRY_AT}> ?nextRetryAt ; <${CONTROL_PAYLOAD}> ?payload .
        FILTER (?nextRetryAt <= ${integer(now)})
      } }`,
      { source: 'publisher.asyncLift.dueRetries' },
    );
    return this.projectInventory(result);
  }

  private projectInventory(result: QueryResult, contextGraphId?: string): PersistedLiftJob[] {
    return projectListedLiftJobs(
      expectBindings(result).map((row) => parseInventoryPayload(row['payload'])),
      contextGraphId,
      this.project,
    );
  }
}

function parseInventoryPayload(binding?: string): PersistedLiftJob | null {
  const decoded = decodeLiftJobPayload(binding);
  return decoded.kind === 'canonical' || decoded.kind === 'compatibility' ? decoded.job : null;
}
