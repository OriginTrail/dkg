import { controlStoreOptions, type QueryOptions, type QueryResult, type TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJobAccepted, LiftJobState, PersistedLiftJob } from './lift-job.js';
import {
  CONTROL_ACCEPTED_AT,
  CONTROL_LIFECYCLE_KEY,
  CONTROL_NEXT_RETRY_AT,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  integer,
  jobSubject,
  knowledgeAssetVmPublishLifecycleKey,
  literal,
} from './async-lift-control-plane.js';
import {
  compareAcceptedJobs,
  expectBindings,
  isKnowledgeAssetVmPublishJobRequest,
  projectListedLiftJobs,
} from './async-lift-publisher-utils.js';
import { decodeLiftJobPayload, decodedLiftJobOrThrow } from './lift-job-payload-codec.js';
import { LiftJobPayloadUnreadableError } from './lift-job-payload-unreadable.js';
import { LiftLegacyScanMemo } from './lift-legacy-scan-memo.js';

/**
 * #1828 / GH#2270 - the lifecycle key a persisted job belongs to, or null when it has none: a
 * non-VM-publish request, or a malformed legacy one (a pre-guard admission whose name carries
 * U+001F). A malformed PERSISTED job must never abort a scan and block an unrelated admission,
 * so it simply drops out of every group.
 *
 * This is the ONE lifecycle-key classification of a persisted job. It is owned here, beside the
 * admission scan, because the scan's process-wide completion memo (`LiftLegacyScanMemo`) is shared
 * by every selector over the store and its rule - a scan that finds no KEYED legacy row ends the
 * scan for all of them - depends on exactly this classification. A caller-supplied classifier could
 * declare the scan complete (return null for a keyed legacy row) or fail the indexed-row integrity
 * check for everyone, so `vmPublishAdmissionCandidates` takes none.
 */
export function lifecycleKeyOfJob(job: PersistedLiftJob): string | null {
  if (!isKnowledgeAssetVmPublishJobRequest(job.request)) return null;
  try {
    return knowledgeAssetVmPublishLifecycleKey(job.request.knowledgeAssetVmPublish);
  } catch {
    return null;
  }
}

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
   * this store send only the indexed branch. A restart scans once more. The memo is the only policy:
   * nothing forces either form (a test forgets the memo with `LiftLegacyScanMemo.forgetForTesting`).
   * What counts as "a keyed legacy row" is the module's own `lifecycleKeyOfJob`: no caller can
   * supply a different classification, so none can declare the scan complete for the others.
   *
   * Accepted narrowing (P7's own, beyond the share-side D1/D2/D4 of plan D-5): a legacy un-indexed
   * VM-publish row that appears AFTER the memo has cleared is not seen until the next boot
   * backfill (`ensureVmPublishIntentIndex`) or restart. Nothing writes such a row any more, and
   * every node owns its store, so it does not arise in practice.
   */
  async vmPublishAdmissionCandidates(lifecycleKey: string): Promise<PersistedLiftJob[]> {
    return this.vmPublishCandidates(lifecycleKey, controlStoreOptions('publisher', 'publisher.asyncLift.findActiveVmPublish'));
  }

  /**
   * The same read with the caller's options, so a sweep can label its own reads (OT-RFC-73 P11). Admission calls the one-argument method above: it has no policy argument.
   * `oneRecordPerJob` is for the callers that delete records, the retention sweep and bulk clear (online review 4396325296, #3562): the read keeps one record per job id, the
   * last row's, so two records of one id leave the engine's row order to decide which one the caller sees. Admission keeps that answer; a caller that deletes records must
   * not judge a key from it, and with the flag the read throws for such a key instead (`refuseTwoRecordsOfOneJob`).
   */
  async vmPublishCandidates(lifecycleKey: string, options: QueryOptions, oneRecordPerJob = false): Promise<PersistedLiftJob[]> {
    const scanLegacy = this.legacyScan.scanRequired();
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
      `SELECT ${oneRecordPerJob ? '?job ' : ''}?payload ?status ?indexed WHERE { GRAPH <${this.graphUri}> {
        ${scanLegacy ? `${indexedBranch} UNION ${legacyBranch}` : indexedBranch}
      } }`,
      options,
    );
    const rows = expectBindings(result);
    if (oneRecordPerJob) refuseTwoRecordsOfOneJob(rows);
    const jobs = new Map<string, PersistedLiftJob>();
    // Decode the indexed branch first regardless of backend UNION row order.
    for (const row of rows) {
      if (row['indexed'] === undefined) continue;
      const job = decodedLiftJobOrThrow(decodeLiftJobPayload(row['payload']));
      if (job !== null && lifecycleKeyOfJob(job) !== lifecycleKey) {
        throw new LiftJobPayloadUnreadableError(`Malformed persisted LiftJob payload: lifecycle index does not match ${lifecycleKey}`);
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
      if (lifecycleKeyOfJob(job) !== null) keyedLegacyRows += 1;
    }
    if (scanLegacy && keyedLegacyRows === 0) this.legacyScan.clear();
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

/**
 * OT-RFC-73 P11 (online review 4396325296): throw when the rows of a sibling read hold two records of one job id, of which the read's collapse by job id would show one: a
 * payload stored under a subject that is not its own job's (`jobSubject(jobId)`: the subject the serializer writes and a removal deletes), or one job stored with two payloads.
 * One id under two subjects is the first case, since only one of them is the id's own. A row whose payload does not decode is no record of the read (it skips such a row or
 * throws for it), and the same subject and payload twice (a repeated status triple) is one record.
 */
function refuseTwoRecordsOfOneJob(rows: ReadonlyArray<Record<string, string>>): void {
  const payloads = new Map<string, string>();
  for (const row of rows) {
    const payload = row['payload'];
    const job = parseInventoryPayload(payload);
    if (job === null || payload === undefined) continue;
    if (row['job'] !== jobSubject(job.jobId)) {
      throw new LiftJobPayloadUnreadableError(`Malformed persisted LiftJob payload: subject ${row['job']} holds a payload of job ${job.jobId}`);
    }
    if ((payloads.get(job.jobId) ?? payload) !== payload) {
      throw new LiftJobPayloadUnreadableError(`Malformed persisted LiftJob payload: job ${job.jobId} is stored with two payloads`);
    }
    payloads.set(job.jobId, payload);
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
