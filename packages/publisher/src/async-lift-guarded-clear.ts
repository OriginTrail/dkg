/**
 * Bulk `clear(status)` of the publisher queue, with the sibling guard (OT-RFC-73 P11; async-lift-lifecycle-siblings.ts).
 *
 * `clear('finalized')` and `clear('failed')` remove every job of that status that bulk cleanup may take (`isBulkClearableTerminalLiftJob`: never a held job, never one in the
 * recovery lane). Before P11 each removal looked at the job alone, so clearing could change which record binds a lifecycle key: deleting the newest record of a key
 * made an older failed sibling the newest, and a failed job that is retryable binds again, so a re-submit reaccepted the old job instead of starting a new one. The
 * guard closes that, independently of the retention mode (it is always on):
 *  - a finalized job is kept while an older failed sibling of its key is kept;
 *  - no removal is made that would make a different, kept record bind the key (removing the binding job itself, which vacates the key, is what clearing a failed job is for);
 *  - a key whose records cannot be decoded keeps the job (admission cannot read that key either), and the pass goes on.
 * Each job is judged and removed under the global claim lock and its job lock (as `clearTerminalJob` does), oldest first, so the siblings it reads cannot change under it and every
 * intermediate state of a pass keeps the key's newest record. `clearTerminalJob(jobId)` stays the unguarded, deliberate exact-job override.
 */
import type { PersistedLiftJob } from './lift-job.js';
import { isBulkClearableTerminalLiftJob } from './async-lift-retry-disposition.js';
import { bulkClearKeepsBinding, isUndecodableSiblingError } from './async-lift-lifecycle-siblings.js';
import { lifecycleKeyOfJob } from './lift-job-store-selectors.js';
import type { LiftJobRecoveryTransitionScope } from './lift-job-transition-scope.js';

export const LIFT_CLEAR_SIBLINGS_SOURCE = 'publisher.asyncLift.clear.siblings';

export interface GuardedClearDeps {
  /** The jobs of the status, oldest first (a snapshot: each is re-read under its locks). */
  readonly jobs: readonly PersistedLiftJob[];
  /** One job under the global claim lock and its job lock: a fresh read and the scope that can remove it. */
  readonly transact: (jobId: string, work: (current: PersistedLiftJob, scope: LiftJobRecoveryTransitionScope) => Promise<void>) => Promise<void>;
  /** The records of a lifecycle key as admission reads them (the control path, under `LIFT_CLEAR_SIBLINGS_SOURCE`). */
  readonly siblings: (lifecycleKey: string) => Promise<PersistedLiftJob[]>;
}

/** Remove the clearable jobs whose removal keeps every binding decision; returns how many were removed. */
export async function clearTerminalJobsGuarded({ jobs, transact, siblings }: GuardedClearDeps): Promise<number> {
  let cleared = 0;
  for (const snapshot of jobs) {
    await transact(snapshot.jobId, async (job, scope) => {
      if (!isBulkClearableTerminalLiftJob(job)) return;
      const key = lifecycleKeyOfJob(job);
      if (key !== null) {
        let records: PersistedLiftJob[];
        try { records = await siblings(key); } catch (cause) {
          if (isUndecodableSiblingError(cause)) return;                             // a key whose records cannot be read is kept, as admission cannot read it either
          throw cause;
        }
        if (!bulkClearKeepsBinding(records, job)) return;
      }
      await scope.commitRemoval();
      cleared += 1;
    });
  }
  return cleared;
}
