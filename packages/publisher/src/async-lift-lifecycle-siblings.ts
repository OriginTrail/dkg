/**
 * Sibling-aware removal of publisher records (OT-RFC-73 P11, D-6, AC7): when may a record of a lifecycle key be deleted without changing which record
 * binds that key?
 *
 * The records of one lifecycle key (a publish job's context graph, name, sub-graph and agent lane) are siblings. Whether a record BINDS the key is not a
 * property of the record alone (`selectLifecycleBindingJobs`, async-lift-retry-disposition.ts): an ordinary failed job older than the key's NEWEST record is
 * history and binds nothing, whatever its own state says. Delete that newest record, and the failed job is the newest, so it binds again: admission would
 * reaccept a job its successor superseded. A finalized record never binds its key (`isOccupyingLifecycleJob`), but it can be the very record that keeps an
 * older failed one from binding. That is the hazard, and these rules remove it:
 *
 *  - the records of a key are taken oldest first, by the order that decides which one is the newest (`compareAcceptedJobs`);
 *  - a deletion plan for a key is a PREFIX of that order: the oldest records, up to the first one that is not deletable. A failed record, a record that is not
 *    terminal, a finalized one that is not old enough, or one that cannot be read all end the prefix, and so does every record behind them. So no finalized
 *    record is deleted while an older failed sibling of its key is kept, and a key's records leave oldest first: every intermediate state, after any number
 *    of deletes, still holds the key's newest record until the last one goes;
 *  - the newest record itself is deletable when it is finalized, old enough and nothing older is kept (a finalized record binds nothing, so the key is
 *    vacant either way);
 *  - and the rule is checked against the binding selector itself: the plan is refused unless the binding list of the key is exactly the same without the
 *    deleted records (`bindingUnchanged`). The reasoning above is why that never fires; the check is why nobody has to trust the reasoning.
 *
 * Bulk `clear(status)` applies the same guard to its removals (`bulkClearKeepsBinding`): it may still remove a record that binds the key itself (that is what
 * clearing a failed job is for), never one whose removal makes a different, kept record bind it.
 *
 * Everything here is a pure function of the records; the callers read them under the claim lock.
 */
import type { PersistedLiftJob } from './lift-job.js';
import { compareAcceptedJobs, isFailedJob } from './async-lift-publisher-utils.js';
import { selectLifecycleBindingJobs } from './async-lift-retry-disposition.js';
import { lifecycleKeyOfJob } from './lift-job-store-selectors.js';
import { LiftJobPayloadUnreadableError } from './lift-job-payload-unreadable.js';

/**
 * The sibling read throws a `LiftJobPayloadUnreadableError` for a record it cannot decode, exactly as admission's read does (the key is unreadable for admission too); any other
 * error is a store failure, whatever its message says. Callers keep the records they were about to remove from such a key and carry on, never abort a whole sweep or clear on one
 * poisoned key. The test is the error's type, not its wording.
 */
export const isUndecodableSiblingError = (cause: unknown): boolean => cause instanceof LiftJobPayloadUnreadableError;

/**
 * Do the lifecycle-key triples stored for a record (`keys`, the terms as the store answers them) agree with its payload's key? A record with a key carries at most one
 * such triple and one without a key none: a triple beyond the payload's names a key whose admission reads this record and refuses it (the index does not match), and
 * removing the record would change that answer (online review 4395740472, #3562). One triple is not compared with the payload's key here (its U+001F separators are
 * spelled the engine's way): the key's own sibling read is made by that very triple, so a caller checks that the record is among the records that read returned.
 */
export const keyedIndexAgrees = (keys: ReadonlySet<string>, key: string | null): boolean => keys.size <= (key === null ? 0 : 1);

/** The records of `key` among `candidates`, oldest first (the order that makes the last one the key's newest). */
export function recordsOfKey(candidates: readonly PersistedLiftJob[], key: string): PersistedLiftJob[] {
  return candidates.filter((job) => lifecycleKeyOfJob(job) === key).sort(compareAcceptedJobs);
}

/** The jobs that bind `key` among `candidates`, in the order admission answers for them (the selector's own, not a copy of it). */
export function bindingJobIds(candidates: readonly PersistedLiftJob[], key: string): string[] {
  return (selectLifecycleBindingJobs(candidates, lifecycleKeyOfJob).get(key) ?? []).map((job) => job.jobId);
}

/** Does the key bind exactly the same jobs, in the same order, once `removed` are gone? */
export function bindingUnchanged(candidates: readonly PersistedLiftJob[], key: string, removed: ReadonlySet<string>): boolean {
  const before = bindingJobIds(candidates, key);
  const after = bindingJobIds(candidates.filter((job) => !removed.has(job.jobId)), key);
  return before.length === after.length && before.every((jobId, index) => jobId === after[index]);
}

/** Does removing `removed` make a job bind the key that did not bind it before? (Removing the binding job itself, vacating the key, does not.) */
export function removalPromotesSibling(candidates: readonly PersistedLiftJob[], key: string, removed: ReadonlySet<string>): boolean {
  const before = new Set(bindingJobIds(candidates, key));
  return bindingJobIds(candidates.filter((job) => !removed.has(job.jobId)), key).some((jobId) => !before.has(jobId));
}

/**
 * May bulk `clear(status)` remove `job` (a record it has already found clearable)? `siblings` are the records of its key as admission reads them.
 *  - a finalized record stays while an older failed sibling of its key is kept: that sibling could bind the key again;
 *  - no record is removed if a kept sibling would bind the key because of it.
 */
export function bulkClearKeepsBinding(siblings: readonly PersistedLiftJob[], job: PersistedLiftJob): boolean {
  const key = lifecycleKeyOfJob(job);
  if (key === null) return true;
  const records = recordsOfKey(siblings, key);
  if (job.status === 'finalized' && records.some((sibling) => sibling.jobId !== job.jobId && isFailedJob(sibling) && compareAcceptedJobs(sibling, job) < 0)) return false;
  return !removalPromotesSibling(records, key, new Set([job.jobId]));
}

/** Why a record of a key is not deletable on its own, or undefined when nothing but its siblings stands in the way. */
export type RecordVerdict = (job: PersistedLiftJob) => string | undefined;

export interface KeyDeletionPlan {
  /** The key's records, oldest first. */
  readonly order: readonly PersistedLiftJob[];
  /** The deletable prefix, oldest first. */
  readonly prefix: readonly PersistedLiftJob[];
  /** Why each record behind the prefix is kept: its own reason, or `blocked` when only an older kept record stands in the way. */
  readonly kept: ReadonlyMap<string, string>;
  /** False when the binding selector says deleting the prefix would change the key's binding list: nothing is deletable then. */
  readonly bindingStable: boolean;
}

/**
 * The deletion plan of one key. `verdict` is the per-record rule (a finalized record old enough, not dated after now, and so on): a record it gives a reason for ends
 * the prefix, and every record behind it is `blocked`.
 */
export function planKeyDeletion(
  candidates: readonly PersistedLiftJob[], key: string, verdict: RecordVerdict,
  /** The binding check; a test may replace it to prove the plan honours a refusal. */
  stable: typeof bindingUnchanged = bindingUnchanged,
): KeyDeletionPlan {
  const order = recordsOfKey(candidates, key);
  const prefix: PersistedLiftJob[] = [];
  const kept = new Map<string, string>();
  let blocked = false;
  for (const job of order) {
    if (blocked) { kept.set(job.jobId, 'blocked'); continue; }
    const reason = verdict(job);
    if (reason === undefined) prefix.push(job);
    else { blocked = true; kept.set(job.jobId, reason); }
  }
  const bindingStable = prefix.length === 0 || stable(candidates, key, new Set(prefix.map((job) => job.jobId)));
  if (!bindingStable) for (const job of prefix) kept.set(job.jobId, 'binding_would_change');
  return { order, prefix: bindingStable ? prefix : [], kept, bindingStable };
}
