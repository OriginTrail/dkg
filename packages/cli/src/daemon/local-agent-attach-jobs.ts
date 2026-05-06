/**
 * Generic per-integration UI attach-job scheduler. Lifted from
 * `packages/cli/src/daemon/openclaw.ts` (which still re-exports the
 * OpenClaw-named bindings as a backwards-compat alias) in S1 of issue
 * #386 because adapter-hermes' S3 work needs an identically-shaped
 * scheduler keyed on `'hermes'` instead of `'openclaw'`.
 *
 * The previous OpenClaw-only Map (`pendingOpenClawUiAttachJobs`) +
 * helpers (`scheduleOpenClawUiAttachJob`, `cancelPendingLocalAgentAttachJob`,
 * `isOpenClawUiAttachCancelled`) keyed everything on a string
 * `integrationId`, so the migration is a rename: the same Map and the
 * same scheduling/cancellation logic just lose the `OpenClaw` substring
 * from the public symbols. Existing OpenClaw call sites continue to
 * import the legacy names from `daemon/openclaw.ts` (re-exports). New
 * Hermes call sites in S3 should import the generic names from this
 * module directly.
 *
 * Module-private state: `pendingAttachJobs` is intentionally NOT
 * exported. All access goes through the helpers below; that's what lets
 * `cancelPending(id)` reach into the same Map that `scheduleAttachJob(id)`
 * populated without a global registry.
 */

export type PendingAttachJob = {
  job: Promise<void>;
  controller: AbortController;
  cancelled: boolean;
};

const pendingAttachJobs = new Map<string, PendingAttachJob>();

/**
 * Schedule (or join) a per-integration UI attach job. If a job for
 * `integrationId` is already pending, the existing job is returned and
 * `task` is NOT invoked — the second caller observes the in-flight
 * promise. If no job is pending, a new `AbortController` + `PendingAttachJob`
 * is created, `task(job)` is invoked, and the entry is auto-cleared
 * from the registry when the task settles (success or failure).
 *
 * `onAttachScheduled` lets the daemon route emit a notice + transition
 * the integration record to `'connecting'` synchronously while the
 * background job runs.
 */
export function scheduleAttachJob(
  integrationId: string,
  task: (job: PendingAttachJob) => Promise<void>,
  onAttachScheduled?: (id: string, job: Promise<void>) => void,
): { started: boolean; job: Promise<void>; controller: AbortController } {
  const existing = pendingAttachJobs.get(integrationId);
  if (existing) {
    onAttachScheduled?.(integrationId, existing.job);
    return { started: false, job: existing.job, controller: existing.controller };
  }

  const controller = new AbortController();
  const jobState: PendingAttachJob = {
    controller,
    cancelled: false,
    job: Promise.resolve().then(() => task(jobState)).finally(() => {
      const current = pendingAttachJobs.get(integrationId);
      if (current === jobState) {
        pendingAttachJobs.delete(integrationId);
      }
    }),
  };
  pendingAttachJobs.set(integrationId, jobState);
  onAttachScheduled?.(integrationId, jobState.job);
  return { started: true, job: jobState.job, controller };
}

/**
 * Cancel an in-flight attach job for `integrationId`. Aborts the
 * associated `AbortController`, marks `cancelled: true` so
 * `isCancelled(job)` returns `true` even before the abort propagates,
 * and removes the entry from the registry so a subsequent
 * `scheduleAttachJob(integrationId, ...)` can start fresh.
 */
export function cancelPending(integrationId: string): void {
  const job = pendingAttachJobs.get(integrationId);
  if (!job) return;
  job.cancelled = true;
  job.controller.abort();
  pendingAttachJobs.delete(integrationId);
}

/**
 * `true` when the job's `cancelled` flag was set OR its `AbortController`
 * has been aborted from any side. Used by long-running attach tasks to
 * exit early between step boundaries.
 */
export function isCancelled(job: PendingAttachJob): boolean {
  return job.cancelled || job.controller.signal.aborted;
}
