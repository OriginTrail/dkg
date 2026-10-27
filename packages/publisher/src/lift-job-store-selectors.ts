import { controlStoreOptions, type QueryOptions, type QueryResult, type TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJobAccepted, LiftJobState, PersistedLiftJob } from './lift-job.js';
import {
  CONTROL_ACCEPTED_AT,
  CONTROL_LIFECYCLE_KEY,
  CONTROL_NEXT_RETRY_AT,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  integer,
  literal,
} from './async-lift-control-plane.js';
import {
  compareAcceptedJobs,
  expectBindings,
  isKnowledgeAssetVmPublishJobRequest,
  projectListedLiftJobs,
} from './async-lift-publisher-utils.js';
import { decodeLiftJobPayload, decodedLiftJobOrThrow } from './lift-job-payload-codec.js';
import { LiftLegacyScanMemo } from './lift-legacy-scan-memo.js';

/**
 * Read-only queue candidate selection. These snapshots never authorize a transition: callers
 * re-read under the appropriate durable ownership lock before acting. Malformed inventory rows
 * are skipped while exact job reads and admission checks retain their strict decoder.
 *
 * OT-RFC-73 S1: a read that runs under the global claim lock (the admission duplicate check, claim candidate
 * selection, and a bulk retry's list when its caller passes the control options) is tagged for the publisher's
 * control path. The unlocked reads (`list()`, `reconciliationInventory`, the boot backfill, and the bounded page and
 * COUNT reads of `LiftJobListingSelectors`) keep the caller's lane.
 */
export class LiftJobStoreSelectors {
  constructor(
    protected readonly store: Pick<TripleStore, 'query'>,
    protected readonly graphUri: string,
    protected readonly project: (job: PersistedLiftJob) => PersistedLiftJob,
    private readonly legacyScan = new LiftLegacyScanMemo(store, graphUri),
  ) {}

  async list(
    filter: { status?: LiftJobState; contextGraphId?: string } = {},
    options: QueryOptions = { source: 'publisher.asyncLift.list' },
  ): Promise<PersistedLiftJob[]> {
    const statusFilter = filter.status ? `FILTER (?status = ${literal(filter.status)})` : '';
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload . ${statusFilter} } }`,
      options,
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

  /**
   * Valid writers index every lifecycle; only pre-index rows need the tolerant fallback.
   *
   * The indexed branch is bound by the lifecycle-key literal, so its cost follows the rows under
   * THIS key. The fallback branch has no such bound: it joins status and payload of EVERY retained
   * job and removes the indexed ones with FILTER NOT EXISTS, and admission runs it under the
   * global claim lock. A scan that finds no un-indexed VM-publish row therefore clears the
   * process-wide memo (`LiftLegacyScanMemo`), and later admissions of any publisher instance over
   * this store send only the indexed branch. A restart scans once more. `options.legacyUnindexedScan`
   * forces either form (tests, diagnostics) and leaves the memo alone.
   *
   * Accepted narrowing (P7's own, beyond the share-side D1/D2/D4 of plan D-5): a legacy un-indexed
   * VM-publish row that appears AFTER the memo has cleared is not seen until the next boot
   * backfill (`ensureVmPublishIntentIndex`) or restart. Nothing writes such a row any more, and
   * every node owns its store, so it does not arise in practice.
   */
  async vmPublishAdmissionCandidates(
    lifecycleKey: string,
    keyOfJob: (job: PersistedLiftJob) => string | null,
    options: { readonly legacyUnindexedScan?: boolean } = {},
  ): Promise<PersistedLiftJob[]> {
    const forced = options.legacyUnindexedScan !== undefined;
    const scanLegacy = options.legacyUnindexedScan ?? this.legacyScan.scanRequired();
    const indexedBranch = `{
          ?job <${CONTROL_LIFECYCLE_KEY}> ${literal(lifecycleKey)} ; <${CONTROL_PAYLOAD}> ?payload .
          OPTIONAL { ?job <${CONTROL_STATUS}> ?status }
          BIND(true AS ?indexed)
        }`;
    const legacyBranch = `{
          ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload .
          FILTER NOT EXISTS { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey }
        }`;
    const result = await this.store.query(
      `SELECT ?payload ?status ?indexed WHERE { GRAPH <${this.graphUri}> {
        ${scanLegacy ? `${indexedBranch} UNION ${legacyBranch}` : indexedBranch}
      } }`,
      controlStoreOptions('publisher', 'publisher.asyncLift.findActiveVmPublish'),
    );
    const rows = expectBindings(result);
    const jobs = new Map<string, PersistedLiftJob>();
    // Decode the indexed branch first regardless of backend UNION row order.
    for (const row of rows) {
      if (row['indexed'] === undefined) continue;
      const job = decodedLiftJobOrThrow(decodeLiftJobPayload(row['payload']));
      if (job !== null && keyOfJob(job) !== lifecycleKey) {
        throw new Error(`Malformed persisted LiftJob payload: lifecycle index does not match ${lifecycleKey}`);
      }
      // Preserve list membership while still checking every indexed payload strictly above.
      if (job !== null && row['status'] !== undefined) jobs.set(job.jobId, job);
    }
    // Include all statuses: finalized siblings demote ordinary failed history, but never held jobs.
    // A legacy row counts against clearing the memo only when it has a lifecycle key: a keyless one
    // (a pre-guard admission whose name carries U+001F, which the backfill cannot index either)
    // drops out of every group, so it can never change an admission decision.
    // Corruption-only edge: such a row carrying the payload jobId of an indexed job on ANOTHER subject
    // (one jobId on two subjects = corrupted data) replaced that job in the map above before P7, but
    // once the memo has cleared it is never read, so the indexed job now stays: a different decision.
    let keyedLegacyRows = 0;
    for (const row of rows) {
      if (row['indexed'] !== undefined) continue;
      const job = parseInventoryPayload(row['payload']);
      if (job === null) continue;
      jobs.set(job.jobId, job);
      if (keyOfJob(job) !== null) keyedLegacyRows += 1;
    }
    if (scanLegacy && !forced && keyedLegacyRows === 0) this.legacyScan.clear();
    return projectListedLiftJobs([...jobs.values()], undefined, this.project);
  }

  /**
   * The VM-publish jobs the boot backfill can repair: rows with a status and a payload but no
   * lifecycle-key index. Indexed history is filtered in the store, so it never transfers.
   */
  async unindexedVmPublishJobs(): Promise<PersistedLiftJob[]> {
    const result = await this.store.query(
      `SELECT ?payload ?status WHERE { GRAPH <${this.graphUri}> {
        ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload .
        FILTER NOT EXISTS { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey }
      } }`,
      { source: 'publisher.asyncLift.ensureVmPublishIntentIndex' },
    );
    return this.projectInventory(result).filter((job) => isKnowledgeAssetVmPublishJobRequest(job.request));
  }

  /** Select the oldest accepted payload, skipping malformed rows without starving later work. */
  async nextAccepted(): Promise<LiftJobAccepted | undefined> {
    const result = await this.store.query(
      `SELECT ?payload WHERE { GRAPH <${this.graphUri}> { ?job <${CONTROL_STATUS}> ${literal('accepted')} ; <${CONTROL_ACCEPTED_AT}> ?acceptedAt ; <${CONTROL_PAYLOAD}> ?payload } }`,
      controlStoreOptions('publisher', 'publisher.asyncLift.nextAccepted'),
    );
    return selectAccepted(expectBindings(result));
  }

  /** One claim snapshot; a sweep with any decoded due candidates requires a fresh accepted read. */
  async claimCandidates(now: number): Promise<{
    dueRetries: PersistedLiftJob[];
    nextAccepted: LiftJobAccepted | undefined;
  }> {
    const result = await this.store.query(
      `SELECT ?payload ?retry WHERE { GRAPH <${this.graphUri}> {
        {
          ?job <${CONTROL_STATUS}> ${literal('failed')} ;
            <${CONTROL_NEXT_RETRY_AT}> ?nextRetryAt ; <${CONTROL_PAYLOAD}> ?payload .
          FILTER (?nextRetryAt <= ${integer(now)})
          BIND(true AS ?retry)
        } UNION {
          ?job <${CONTROL_STATUS}> ${literal('accepted')} ;
            <${CONTROL_ACCEPTED_AT}> ?acceptedAt ; <${CONTROL_PAYLOAD}> ?payload .
        }
      } }`,
      controlStoreOptions('publisher', 'publisher.asyncLift.claimCandidates'),
    );
    const rows = expectBindings(result);
    return {
      dueRetries: this.projectInventory({ type: 'bindings', bindings: rows.filter((row) => row['retry'] !== undefined) }),
      nextAccepted: selectAccepted(rows.filter((row) => row['retry'] === undefined)),
    };
  }

  private projectInventory(result: QueryResult, contextGraphId?: string): PersistedLiftJob[] {
    return projectListedLiftJobs(
      expectBindings(result).map((row) => parseInventoryPayload(row['payload'])),
      contextGraphId,
      this.project,
    );
  }
}

export function parseInventoryPayload(binding?: string): PersistedLiftJob | null {
  const decoded = decodeLiftJobPayload(binding);
  return decoded.kind === 'canonical' || decoded.kind === 'compatibility' ? decoded.job : null;
}

function selectAccepted(rows: Array<Record<string, string>>): LiftJobAccepted | undefined {
  return rows.map((row) => parseInventoryPayload(row['payload']))
    .filter((job): job is LiftJobAccepted => job?.status === 'accepted')
    .sort(compareAcceptedJobs)
    .at(0);
}
