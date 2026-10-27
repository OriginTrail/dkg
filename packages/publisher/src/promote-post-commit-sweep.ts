import type { PromoteJob, PromoteListFilter, PromotePostCommitRecoveryEvent } from './async-promote-queue-types.js';
import { comparePromoteJobs, postCommitRecoveryExhaustedReason, type PromoteReadyOrder } from './async-promote-queue-utils.js';
import { isAutomaticallyRecoverablePostCommitFailure } from './async-promote-recovery-policy.js';
import { readPromoteJobPage, readPromoteJobPayloads, type PromoteListingHost } from './promote-job-page.js';
import type { PromoteJobCursor } from './promote-list-cursor.js';
import { PROMOTE_POST_COMMIT_FAILURE_CODE, PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from './promote-replay-safety.js';

/**
 * The post-commit recovery sweep (OT-RFC-73 P8a). A post-commit failure is recorded only after the exact SWM replace was
 * dispatched, so the promote may have committed. The publisher's promote is idempotent for exactly that case: a replay
 * validates whatever the exact graph holds against the sealed payload and repairs the durable tail, or re-runs the commit when
 * nothing landed. Re-running it is therefore the same recovery an operator performs through `recover()`, minus the reset of
 * the attempt counter: the replay spends the job's own retry budget so a durable tail that keeps failing cannot loop forever.
 *
 * Reads. The sweep used to read every failed job under the mutex and judge each in JS, in the queue's order (`comparePromoteJobs`:
 * ready time, then `jobId.localeCompare`). The engine now drops the failed jobs whose payload text names neither the post-commit
 * diagnostic code nor the producer's fixed message, which are the only two ways `isAutomaticallyRecoverablePostCommitFailure`
 * recognizes a row; what is left is judged by that unchanged function, so a lookalike that merely contains the text is still left
 * alone. The order is part of the outcome: requeuing a job makes it the active owner of its assertion, which defers every later
 * candidate of the same assertion, so a different order can requeue a different job. The keyset pages come in `(enqueuedAt, jobId)`
 * order, which is not that order (code point against locale ties, and a failed row may carry a `nextRetryAt` the keys do not know),
 * so the sweep works in two passes, each holding the mutex for at most `pageSize` rows at a time:
 *   1. find: walk the keyset pages, one hold each, and keep only the accepted rows' ranking fields (`jobId`, `enqueuedAt`,
 *      `nextRetryAt`), one candidate per job, then sort those with `comparePromoteJobs`. That is a few small records, never the payloads;
 *   2. decide: take the sorted candidates `pageSize` at a time, and in one hold per turn read their rows again by subject and judge
 *      each, in order, with the unchanged policy and the in-hold conflict lookup. The re-read is what makes the gap between the
 *      passes safe: a candidate that left the failed state or changed meanwhile (an operator's `recover`, a cancel) is judged as it
 *      is now and never overwritten from an older copy.
 * A candidate that appears after the find pass is a change after the walk and waits for the next sweep.
 *
 * No scheduler wake: every requeued row carries a future `nextRetryAt` that the worker's durable poll already honours.
 * A sweep no longer shows the admission coordinator the failed jobs it does not touch (it used to observe all of them); an
 * owner observation is advisory, expires on its own and is refreshed by every status read and conflict lookup.
 */

export const POST_COMMIT_SWEEP_PAGE_SIZE = 50;
/** The two spellings of the producer's marker in a payload (JSON text): the code, and the message of rows written before the code existed. */
export const POST_COMMIT_MARKERS = [PROMOTE_POST_COMMIT_FAILURE_CODE, JSON.stringify(PROMOTE_POST_COMMIT_FAILURE_MESSAGE).slice(1, -1)] as const;
const SWEEP_SOURCES = { keys: 'publisher.asyncPromote.recoverPostCommit', payloads: 'publisher.asyncPromote.recoverPostCommit.payloads' } as const;
const FAILED: Pick<PromoteListFilter, 'state'> = { state: ['failed'] };

export interface PostCommitSweepOps {
  readonly backoff: (attemptCount: number) => number;
  /** Whether another active job owns the failed job's assertion (the in-hold conflict lookup). */
  ownedElsewhere(job: PromoteJob): Promise<boolean>;
  write(job: PromoteJob): Promise<void>;
}

export async function sweepPostCommitFailures(host: PromoteListingHost, ops: PostCommitSweepOps, pageSize = POST_COMMIT_SWEEP_PAGE_SIZE): Promise<PromotePostCommitRecoveryEvent[]> {
  // Find: the candidates the policy accepts, a page per hold, keeping only what ranks them.
  // One candidate per job: a record with a second `enqueuedAt` triple (corruption; the queue never writes one) comes back once per triple, on one
  // key page or on two. The ranking fields are those of the decoded payload, not of the key, so every copy ranks alike and the first read stands for the job.
  const found = new Map<string, PromoteReadyOrder>();
  let cursor: PromoteJobCursor | undefined;
  do {
    cursor = await host.locked(async () => {
      const page = await readPromoteJobPage(host, FAILED, { cursor, pageSize, sources: { keys: SWEEP_SOURCES.keys }, payloadContainsAny: POST_COMMIT_MARKERS });
      for (const job of page.jobs) {
        if (!found.has(job.jobId) && isAutomaticallyRecoverablePostCommitFailure(job)) {
          found.set(job.jobId, { jobId: job.jobId, enqueuedAt: job.enqueuedAt, attempt: { nextRetryAt: job.attempt.nextRetryAt } });
        }
      }
      return page.next;
    });
  } while (cursor);
  const candidates = [...found.values()].sort(comparePromoteJobs);
  // Decide: `pageSize` candidates per hold, in that order, each on the row as the hold reads it (a candidate that left the failed state since is not touched).
  const events: PromotePostCommitRecoveryEvent[] = [];
  for (let at = 0; at < candidates.length; at += pageSize) {
    const turn = candidates.slice(at, at + pageSize);
    await host.locked(async () => {
      const now = host.now();
      for (const job of await readPromoteJobPayloads(host, FAILED, turn, SWEEP_SOURCES.payloads)) {
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
    });
  }
  return events;
}
