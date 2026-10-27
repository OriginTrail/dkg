/**
 * What publisher retention may delete (OT-RFC-73 D-6, AC7, P11): the pure rules for one record.
 *
 * ONE class is deletable and nothing else is: a `finalized` job, 7 days after the instant it finished (`finalizedAt`). Every failed publisher job is kept until an
 * operator clears it (the plan defines no harmless failed class for this queue), and so is every job that is not terminal.
 *
 * A finalized job is NEVER deleted when (checked from the payload, under the claim lock, immediately before the delete):
 *  - its payload is unreadable, ambiguous (several payload triples), another job's, or carries no finish time;
 *  - its stored `status`, `finalizedAt` or lifecycle-key triples disagree with the payload, or its key does not lead to it (the sweep reads its siblings the way
 *    admission does, and a record admission cannot reach is one it cannot judge);
 *  - a wallet lock still names it (a bound obligation: the coordinator releases ownership of a finalized job, so a lock that survives means something is
 *    mid-flight);
 *  - its `finalizedAt` or `updatedAt` is dated after `now`, or it is younger than the window;
 *  - an older sibling of its lifecycle key is kept (a failed job, a job that is not terminal, a finalized one that is not deletable itself, one the sweep kept earlier in its
 *    walk, one it could not delete at all: a pre-upgrade payload, a stored index the scan does not match): see async-lift-lifecycle-siblings.ts, which is the rule that keeps
 *    every binding decision of the key as it was, and async-lift-retention.ts, which keeps the records of a key leaving oldest first.
 * The pending-admission, held and post-commit-recoverable jobs of AC7 need no rule of their own here: an admission in flight holds the claim lock the sweep runs
 * under, a held job is a failed job (kept), and a finalized publisher job has no recovery left to run.
 */
import type { PersistedLiftJob } from './lift-job.js';
import { RETENTION_MODES, RETENTION_WINDOW_MS, type RetentionMode } from './retention-sweep-core.js';

/** The D-6 window of both queues: a finalized job leaves 7 days after it finished. */
export const PUBLISHER_RETENTION_WINDOW_MS = RETENTION_WINDOW_MS;
export const PUBLISHER_RETENTION_MODES = RETENTION_MODES;
export type PublisherRetentionMode = RetentionMode;

export interface PublisherRetentionPolicy {
  /** A `finalized` job whose `finalizedAt` is at least this many ms old may be deleted. Positive, finite. */
  readonly finalizedMaxAgeMs: number;
}

export type PublisherRetentionKeepReason =
  | 'unreadable' | 'unknown_state' | 'index_mismatch' | 'not_terminal' | 'bound_obligation' | 'too_recent' | 'future_dated'
  | 'older_sibling_kept' | 'older_sibling_pending' | 'siblings_unreadable' | 'binding_would_change' | 'vanished';

export const PUBLISHER_RETENTION_KEEP_REASONS: readonly PublisherRetentionKeepReason[] = Object.freeze([
  'unreadable', 'unknown_state', 'index_mismatch', 'not_terminal', 'bound_obligation', 'too_recent', 'future_dated',
  'older_sibling_kept', 'older_sibling_pending', 'siblings_unreadable', 'binding_would_change', 'vanished',
]);

/** The only class: the vocabulary of the counters mirrors the share sweep's classes. */
export type PublisherRetentionJobClass = 'finalized';
export const PUBLISHER_RETENTION_JOB_CLASSES: readonly PublisherRetentionJobClass[] = Object.freeze(['finalized']);

export function emptyKeptCounts(): Record<PublisherRetentionKeepReason, number> {
  return Object.fromEntries(PUBLISHER_RETENTION_KEEP_REASONS.map((reason) => [reason, 0])) as Record<PublisherRetentionKeepReason, number>;
}

export function emptyClassCounts(): Record<PublisherRetentionJobClass, number> {
  return { finalized: 0 };
}

/**
 * The per-record rule, over the record alone (its siblings are the key plan's business): why this record cannot be deleted now, or undefined when it can.
 * `now` and the policy fix the cutoff; a record dated after `now` is never deletable, whatever the clock says.
 */
export function judgeFinalizedRecord(job: PersistedLiftJob, now: number, policy: PublisherRetentionPolicy): PublisherRetentionKeepReason | undefined {
  if (job.status !== 'finalized') return 'not_terminal';
  const finalizedAt = job.timestamps.finalizedAt;
  const updatedAt = job.timestamps.updatedAt;
  if (typeof finalizedAt !== 'number' || !Number.isFinite(finalizedAt) || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return 'unreadable';
  if (finalizedAt > now || updatedAt > now) return 'future_dated';
  if (!(now - finalizedAt >= policy.finalizedMaxAgeMs)) return 'too_recent';
  return undefined;
}
