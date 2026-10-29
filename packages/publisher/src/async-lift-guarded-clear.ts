/**
 * Bulk `clear(status)` of the publisher queue, with the sibling guard (OT-RFC-73 P11; async-lift-lifecycle-siblings.ts).
 *
 * `clear('finalized')` and `clear('failed')` remove every job of that status that bulk cleanup may take (`isBulkClearableTerminalLiftJob`: never a held job, never one in the
 * recovery lane). Before P11 each removal looked at the job alone, so clearing could change which record binds a lifecycle key: deleting the newest record of a key
 * made an older failed sibling the newest, and a failed job that is retryable binds again, so a re-submit reaccepted the old job instead of starting a new one. The
 * guard closes that, independently of the retention mode (it is always on):
 *  - a finalized job is kept while an older failed sibling of its key is kept;
 *  - no removal is made that would make a different, kept record bind the key (removing the binding job itself, which vacates the key, is what clearing a failed job is for);
 *  - a key whose records cannot be decoded keeps the job (admission cannot read that key either), and the pass goes on;
 *  - every key whose admission reads the job is judged, not only its payload's (#3562): a job stored with a lifecycle-key triple its payload's key does not account for (a
 *    second one, one that names another key, one on a job without a key) is kept, as retention keeps it (`keyedIndexAgrees`). The other key's admission reads the job and
 *    refuses it, and removing the job would change that answer;
 *  - a key whose sibling read holds two records of one job id (a payload stored under another job's subject, or one job stored with two payloads) is kept whole, as
 *    retention keeps it: admission sees one of the two, the engine's row order decides which, and the record the clear re-reads under the job's lock need not be the one it
 *    listed. For the same reason a job is removed only when that re-read is the listed job, under its own subject, still in the status the clear asked for.
 * Each job is judged and removed under the global claim lock and its job lock (as `clearTerminalJob` does), oldest first, so the siblings it reads cannot change under it and every
 * intermediate state of a pass keeps the key's newest record. `clearTerminalJob(jobId)` stays the unguarded, deliberate exact-job override.
 */
import { controlStoreOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { isSafeJobId } from './job-id.js';
import type { PersistedLiftJob } from './lift-job.js';
import { CONTROL_LIFECYCLE_KEY, jobSubject } from './async-lift-control-plane.js';
import { expectBindings } from './async-lift-publisher-utils.js';
import { isBulkClearableTerminalLiftJob } from './async-lift-retry-disposition.js';
import { bulkClearKeepsBinding, isUndecodableSiblingError, keyedIndexAgrees } from './async-lift-lifecycle-siblings.js';
import { lifecycleKeyOfJob } from './lift-job-store-selectors.js';
import type { LiftJobRecoveryTransitionScope } from './lift-job-transition-scope.js';

export const LIFT_CLEAR_SIBLINGS_SOURCE = 'publisher.asyncLift.clear.siblings';
export const LIFT_CLEAR_KEYS_SOURCE = 'publisher.asyncLift.clear.keys';

export interface GuardedClearDeps {
  /** The status the clear removes. */
  readonly status: 'finalized' | 'failed';
  /** The jobs of the status, oldest first (a snapshot: each is re-read under its locks). */
  readonly jobs: readonly PersistedLiftJob[];
  /** One job under the global claim lock and its job lock: a fresh read and the scope that can remove it. */
  readonly transact: (jobId: string, work: (current: PersistedLiftJob, scope: LiftJobRecoveryTransitionScope) => Promise<void>) => Promise<void>;
  /**
   * The records of a lifecycle key as admission reads them (the control path, under `LIFT_CLEAR_SIBLINGS_SOURCE`). Throws a `LiftJobPayloadUnreadableError` for a record
   * that does not decode, and for two records of one job id (`vmPublishCandidates(..., oneRecordPerJob = true)`).
   */
  readonly siblings: (lifecycleKey: string) => Promise<PersistedLiftJob[]>;
  /** The lifecycle-key terms stored for a job's subject (`readStoredLifecycleKeys`). */
  readonly storedKeys: (jobId: string) => Promise<ReadonlySet<string>>;
}

/** The lifecycle-key terms stored for `jobId`'s subject, as the store spells them (the control path, under `LIFT_CLEAR_KEYS_SOURCE`). `jobId` must be a safe job id. */
export async function readStoredLifecycleKeys(store: Pick<TripleStore, 'query'>, graphUri: string, jobId: string): Promise<Set<string>> {
  const query = `SELECT ?key WHERE { GRAPH <${graphUri}> { <${jobSubject(jobId)}> <${CONTROL_LIFECYCLE_KEY}> ?key } }`;
  return new Set(expectBindings(await store.query(query, controlStoreOptions('publisher', LIFT_CLEAR_KEYS_SOURCE))).flatMap((row) => (row['key'] === undefined ? [] : [row['key']])));
}

/** Remove the clearable jobs whose removal keeps every binding decision; returns how many were removed. */
export async function clearTerminalJobsGuarded({ status, jobs, transact, siblings, storedKeys }: GuardedClearDeps): Promise<number> {
  let cleared = 0;
  for (const snapshot of jobs) {
    if (!isSafeJobId(snapshot.jobId)) continue;                                      // never interpolate an id the job-id grammar does not allow
    await transact(snapshot.jobId, async (job, scope) => {
      if (job.jobId !== snapshot.jobId || job.status !== status || !isBulkClearableTerminalLiftJob(job)) return;
      const key = lifecycleKeyOfJob(job);
      const keys = await storedKeys(job.jobId);
      if (!keyedIndexAgrees(keys, key)) return;                                       // a key triple beyond the payload's: that key's admission refuses the job, and would not after
      if (key !== null) {
        let records: PersistedLiftJob[];
        try { records = await siblings(key); } catch (cause) {
          if (isUndecodableSiblingError(cause)) return;                             // a key whose records cannot be read is kept, as admission cannot read it either
          throw cause;
        }
        if (keys.size === 1 && !records.some((record) => record.jobId === job.jobId)) return;   // its one key triple is not its payload's key: the read by that key does not reach it
        if (!bulkClearKeepsBinding(records, job)) return;
      }
      await scope.commitRemoval();
      cleared += 1;
    });
  }
  return cleared;
}
