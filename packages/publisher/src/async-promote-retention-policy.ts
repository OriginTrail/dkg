/**
 * What share-queue retention may delete (OT-RFC-73 D-6, AC7): the pure decision for one parsed job.
 *
 * A job is deleted only when every rule below says it owns nothing and it is old enough. Three classes are deletable and nothing else is:
 *  - `succeeded`: 7 days after its `updatedAt` (the instant it finished);
 *  - `cancelled`: an operator-cancelled job that never started promote, after the benign window (7 days);
 *  - `retired_no_effect`: a certified retired no-effect rejection, after the benign window (7 days).
 * Every other `failed` job is kept until an operator clears it: it may be needed for inspection or `recover`.
 *
 * A job is NEVER deleted when (checked from the payload, under the queue mutation lock, immediately before the delete):
 *  - its payload is unreadable, malformed, ambiguous (several payload triples), or carries a state this build does not recognise;
 *  - a benign-class candidate's commit marker holds a flag that is not a boolean, or lacks one, `promoteStarted` included (a bad or missing value is no evidence
 *    that promote never started);
 *  - a cancelled job's commit marker has ANY flag set (`wmCleaned`, `lifecycleStamped`, `gossiped` as well as `promoteStarted`, `swmInserted`): it ran, whatever `promoteStarted` says;
 *  - a cancelled job's `formatVersion` is not an integer from 2 (the first format whose workers record the whole marker before they enter promote) up to this build's:
 *    a row from before (absent, 0 or 1) may have started promote, so its history is uncertain, and retention does not infer the absence of effects from a missing
 *    legacy marker any more than the queue's own reclaim does. Any other value is no format a writer produced either;
 *  - it has index triples but no payload, or its stored `state` triple is missing or differs from the payload's state;
 *  - it was written by a newer queue format than this build understands;
 *  - it is not terminal (`queued`, `running`, `failed_retrying`: a job that a worker holds, waits to retry or has not run);
 *  - it still owns an unfinished bound share obligation (`hasUnfinishedBoundObligation`): the recovery owner must survive;
 *  - it is `failed` and not one of the two benign classes: partial-promote ambiguity, legacy rows, post-commit failures (replay budget
 *    remaining or exhausted), fatal errors;
 *  - a benign-class candidate carries a post-commit failure or needs manual inspection (a second, independent reason to keep);
 *  - an admission whose outcome is still uncertain refers to it (`hasPendingJob` on the queue's own admission coordinator);
 *  - it is younger than its window (by BOTH the stored `updatedAt` index triple and the payload's own `updatedAt`), or dated after `now`.
 */
import { hasUnfinishedBoundObligation } from './async-promote-ownership.js';
import { isAutomaticallyRecoverablePostCommitFailure, requiresManualInspection } from './async-promote-recovery-policy.js';
import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION, PROMOTE_COMMIT_MARKER_STEPS, PROMOTE_JOB_STATES, type PromoteJob } from './async-promote-queue-types.js';
import { isPromotePostCommitAttemptError, type StructurallyValidPromoteJobPayload } from './async-promote-queue-utils.js';
import { isRetiredBoundRejection } from './promote-no-effect-rejection.js';

/** The D-6 window of both queues: a deletable job leaves 7 days after it finished. */
export const SHARE_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `off` does nothing, `report` judges and counts what `delete` would remove and removes nothing, `delete` removes it. */
export const SHARE_RETENTION_MODES = Object.freeze(['off', 'report', 'delete'] as const);
export type ShareRetentionMode = (typeof SHARE_RETENTION_MODES)[number];

export interface PromoteRetentionPolicy {
  /** A `succeeded` job whose `updatedAt` is at least this many ms old may be deleted. Positive, finite. */
  readonly succeededMaxAgeMs: number;
  /**
   * Age (ms) after which the two benign `failed` classes (operator-cancelled, certified retired no-effect rejection) may be deleted.
   * Undefined = failed jobs are never deleted by the sweep.
   */
  readonly benignFailedMaxAgeMs?: number;
}

export type PromoteRetentionKeepReason =
  | 'unreadable' | 'index_mismatch' | 'unknown_state' | 'newer_format' | 'not_terminal' | 'unfinished_bound_obligation'
  | 'failed_retained' | 'post_commit_recoverable' | 'pending_admission' | 'too_recent' | 'future_dated' | 'vanished';

export const PROMOTE_RETENTION_KEEP_REASONS: readonly PromoteRetentionKeepReason[] = Object.freeze([
  'unreadable', 'index_mismatch', 'unknown_state', 'newer_format', 'not_terminal', 'unfinished_bound_obligation',
  'failed_retained', 'post_commit_recoverable', 'pending_admission', 'too_recent', 'future_dated', 'vanished',
]);

export type PromoteRetentionJobClass = 'succeeded' | 'cancelled' | 'retired_no_effect';

export const PROMOTE_RETENTION_JOB_CLASSES: readonly PromoteRetentionJobClass[] = Object.freeze(['succeeded', 'cancelled', 'retired_no_effect']);

export type PromoteRetentionDecision =
  | { readonly delete: true; readonly jobClass: PromoteRetentionJobClass }
  | { readonly delete: false; readonly reason: PromoteRetentionKeepReason };

/**
 * Reasons that cannot change by themselves: the scan cursor simply moves past such a row and does not come back to it before the next safety rescan.
 * `vanished` is a scanned subject that has index triples but no payload: either a concurrent clear removed it between scan and verify (then it is gone
 * from the index too) or it is an orphan index row, which is not a job this module may judge, so it is never deleted and never allowed to occupy a batch
 * again. The other reasons (`pending_admission`: an in-process flight settles within seconds; `too_recent`: the payload is younger than its index triple
 * and ages into eligibility; `future_dated`: the clock catches up) are TRANSIENT: the oldest such row marks where the cursor is rewound to once the earliest
 * moment it can change has passed.
 */
export const PERMANENT_KEEP_REASONS: ReadonlySet<PromoteRetentionKeepReason> = new Set<PromoteRetentionKeepReason>([
  'unreadable', 'index_mismatch', 'unknown_state', 'newer_format', 'unfinished_bound_obligation', 'failed_retained', 'post_commit_recoverable', 'vanished',
]);

export function emptyKeptCounts(): Record<PromoteRetentionKeepReason, number> {
  return Object.fromEntries(PROMOTE_RETENTION_KEEP_REASONS.map(reason => [reason, 0])) as Record<PromoteRetentionKeepReason, number>;
}

export function emptyClassCounts(): Record<PromoteRetentionJobClass, number> {
  return { succeeded: 0, cancelled: 0, retired_no_effect: 0 };
}

/**
 * A format whose workers record the whole commit marker (all five flags, `promoteStarted` included) before they enter promote: an integer from the first such format
 * up (a format above this build's was kept as `newer_format` before this is asked). A row from before (`formatVersion` absent, 0 or 1) is no "never started" evidence:
 * a pre-format-2 worker could enter promote without recording a marker, the only marker such a row can carry (four flags) is written when a worker claims the job,
 * and a pre-format-2 reclaim cleared the marker of a running job and kept its attempt count, so a later cancel leaves no marker on a job that may have run. The queue's
 * own reclaim sends every such row to manual inspection and never infers the absence of effects from a missing legacy marker. The parser does not validate
 * `formatVersion`, so this gate does: -1, 1.5, -0, 1e-300 and -Infinity (the JSON text -1e999) are numbers no writer produced, and so are a string, `null` or an object.
 */
function isMarkerWriterFormat(version: unknown): boolean {
  return typeof version === 'number' && Number.isInteger(version) && version >= ASYNC_PROMOTE_QUEUE_MIN_AUTO_RECOVERABLE_FORMAT_VERSION;
}

/**
 * The commit marker of a benign-class candidate is evidence the class rests on (`promoteStarted`, `swmInserted`), so every one of the five flags it holds must be a
 * boolean. The shared classifier checks four of the five and lets a bad `promoteStarted` through, and this gate does not lean on it for any of them. Absent is not bad
 * as a whole: a job that never ran has no marker. A marker WITHOUT a flag is: every writer from format 2 on stores all five, so a missing one is a mangled key and says
 * nothing about whether promote started. (The pre-format-2 shape, a marker without `promoteStarted`, is no readable evidence either: `isMarkerWriterFormat`.)
 */
function hasReadableCommitMarker(job: StructurallyValidPromoteJobPayload): boolean {
  const marker: unknown = job.commitMarker;
  if (marker === undefined) return true;
  if (typeof marker !== 'object' || marker === null) return false;
  const flags = marker as Record<string, unknown>;
  return PROMOTE_COMMIT_MARKER_STEPS.every(step => typeof flags[step] === 'boolean');
}

/** The benign failed classes of D-6: nothing else that failed is ever deletable. */
function benignFailedClass(job: StructurallyValidPromoteJobPayload): Exclude<PromoteRetentionJobClass, 'succeeded'> | undefined {
  if (isRetiredBoundRejection(job)) return 'retired_no_effect';
  // "Never started promote" is read off the whole marker: a flag for any later step (`wmCleaned`, `lifecycleStamped`, `gossiped`) also says the job ran. It is read only
  // from a format that records the marker before promote is entered: a legacy row's missing marker (or its marker without `promoteStarted`) proves nothing.
  if (job.reason === 'cancelled' && isMarkerWriterFormat(job.formatVersion) && job.request.recoveryBinding === undefined && !PROMOTE_COMMIT_MARKER_STEPS.some(step => job.commitMarker?.[step] === true)) return 'cancelled';
  return undefined;
}

/** Pure decision for one parsed job. `now` and the policy fix the cutoffs; `hasPendingAdmission` is the in-process uncertain-admission registry. */
export function decidePromoteRetention(
  job: StructurallyValidPromoteJobPayload,
  now: number,
  policy: PromoteRetentionPolicy,
  hasPendingAdmission: (jobId: string) => boolean,
): PromoteRetentionDecision {
  if (!(PROMOTE_JOB_STATES as readonly string[]).includes(job.state)) return { delete: false, reason: 'unknown_state' };
  if ((job.formatVersion ?? 0) > ASYNC_PROMOTE_QUEUE_FORMAT_VERSION) return { delete: false, reason: 'newer_format' };
  if (job.state !== 'succeeded' && job.state !== 'failed') return { delete: false, reason: 'not_terminal' };
  if (hasUnfinishedBoundObligation(job)) return { delete: false, reason: 'unfinished_bound_obligation' };
  let jobClass: PromoteRetentionJobClass;
  let maxAgeMs: number;
  if (job.state === 'succeeded') {
    jobClass = 'succeeded';
    maxAgeMs = policy.succeededMaxAgeMs;
  } else {
    const benign = policy.benignFailedMaxAgeMs === undefined ? undefined : benignFailedClass(job);
    if (benign === undefined) return { delete: false, reason: 'failed_retained' };
    if (!hasReadableCommitMarker(job)) return { delete: false, reason: 'unreadable' };      // the class rests on the marker: `!== true` reads "true" or null as "never started"
    // The classes above are an allow-list; these two are independent reasons to keep that hold if either predicate ever drifts. A payload
    // whose free-text fields have an unexpected type makes the predicates throw: that row is kept as unreadable, never a stuck batch.
    try {
      const failed = { ...job, state: 'failed' } as PromoteJob;
      if (isPromotePostCommitAttemptError(job.attempt.lastError) || isAutomaticallyRecoverablePostCommitFailure(failed)) {
        return { delete: false, reason: 'post_commit_recoverable' };
      }
      if (requiresManualInspection(failed)) return { delete: false, reason: 'failed_retained' };
    } catch {
      return { delete: false, reason: 'unreadable' };
    }
    jobClass = benign;
    maxAgeMs = policy.benignFailedMaxAgeMs!;
  }
  if (!Number.isFinite(job.updatedAt)) return { delete: false, reason: 'too_recent' };
  if (job.updatedAt > now) return { delete: false, reason: 'future_dated' };
  if (!(now - job.updatedAt >= maxAgeMs)) return { delete: false, reason: 'too_recent' };
  if (hasPendingAdmission(job.jobId)) return { delete: false, reason: 'pending_admission' };
  return { delete: true, jobClass };
}
