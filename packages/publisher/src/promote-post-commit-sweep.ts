import type { PromoteJob, PromotePostCommitRecoveryEvent } from './async-promote-queue-types.js';
import { postCommitRecoveryExhaustedReason } from './async-promote-queue-utils.js';
import { isAutomaticallyRecoverablePostCommitFailure } from './async-promote-recovery-policy.js';
import { readPromoteJobPage, type PromoteListingHost } from './promote-job-page.js';
import type { PromoteJobCursor } from './promote-list-cursor.js';
import { PROMOTE_POST_COMMIT_FAILURE_CODE, PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from './promote-replay-safety.js';

/**
 * The post-commit recovery sweep (OT-RFC-73 P8a). A post-commit failure is recorded only after the exact SWM replace was
 * dispatched, so the promote may have committed. The publisher's promote is idempotent for exactly that case: a replay
 * validates whatever the exact graph holds against the sealed payload and repairs the durable tail, or re-runs the commit when
 * nothing landed. Re-running it is therefore the same recovery an operator performs through `recover()`, minus the reset of
 * the attempt counter: the replay spends the job's own retry budget so a durable tail that keeps failing cannot loop forever.
 *
 * Reads. The sweep used to read every failed job under the mutex and judge each in JS. The engine now drops the failed jobs
 * whose payload text names neither the post-commit diagnostic code nor the producer's fixed message, which are the only two
 * ways `isAutomaticallyRecoverablePostCommitFailure` recognizes a row; what is left is judged by that unchanged function, so
 * a lookalike that merely contains the text is still left alone. The rest is walked in keyset pages, one hold of the mutex
 * per page, and each page's rows are decided inside the hold that read them.
 *
 * No scheduler wake: every requeued row carries a future `nextRetryAt` that the worker's durable poll already honours.
 * A sweep no longer shows the admission coordinator the failed jobs it does not touch (it used to observe all of them); an
 * owner observation is advisory, expires on its own and is refreshed by every status read and conflict lookup.
 */

export const POST_COMMIT_SWEEP_PAGE_SIZE = 50;
/** The two spellings of the producer's marker in a payload (JSON text): the code, and the message of rows written before the code existed. */
export const POST_COMMIT_MARKERS = [PROMOTE_POST_COMMIT_FAILURE_CODE, JSON.stringify(PROMOTE_POST_COMMIT_FAILURE_MESSAGE).slice(1, -1)] as const;
const SWEEP_SOURCES = { keys: 'publisher.asyncPromote.recoverPostCommit' } as const;

export interface PostCommitSweepOps {
  readonly backoff: (attemptCount: number) => number;
  /** Whether another active job owns the failed job's assertion (the in-hold conflict lookup). */
  ownedElsewhere(job: PromoteJob): Promise<boolean>;
  write(job: PromoteJob): Promise<void>;
}

export async function sweepPostCommitFailures(host: PromoteListingHost, ops: PostCommitSweepOps, pageSize = POST_COMMIT_SWEEP_PAGE_SIZE): Promise<PromotePostCommitRecoveryEvent[]> {
  const events: PromotePostCommitRecoveryEvent[] = [];
  let cursor: PromoteJobCursor | undefined;
  do {
    cursor = await host.locked(async () => {
      const now = host.now();
      const page = await readPromoteJobPage(host, { state: ['failed'] }, { cursor, pageSize, sources: SWEEP_SOURCES, payloadContainsAny: POST_COMMIT_MARKERS });
      for (const job of page.jobs) {
        if (!isAutomaticallyRecoverablePostCommitFailure(job)) continue;
        const attemptCount = Math.max(1, job.attempt.count);
        const maxAttempts = job.attempt.maxRetries;
        if (attemptCount >= maxAttempts) {
          // One durable verdict: the `reason` keeps this row out of every later sweep while leaving explicit operator recovery available.
          await ops.write({ ...job, updatedAt: now, reason: postCommitRecoveryExhaustedReason(attemptCount) });
          events.push({ jobId: job.jobId, action: 'exhausted', attempt: attemptCount, maxAttempts });
          continue;
        }
        // Another active job already owns this assertion; leave the row for a later sweep rather than breaking the per-assertion uniqueness key.
        if (await ops.ownedElsewhere(job)) continue;
        const nextRetryAt = now + ops.backoff(attemptCount);
        await ops.write({
          ...job,
          state: 'failed_retrying',
          updatedAt: now,
          lease: undefined,
          attempt: {
            count: attemptCount,
            maxRetries: maxAttempts,
            nextRetryAt,
            lastError: job.attempt.lastError ? { ...job.attempt.lastError, retryable: true } : undefined,
          },
        });
        events.push({ jobId: job.jobId, action: 'requeued', attempt: attemptCount, maxAttempts, nextRetryAt });
      }
      return page.next;
    });
  } while (cursor);
  return events;
}
