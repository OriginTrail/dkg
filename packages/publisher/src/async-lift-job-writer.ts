// SPDX-License-Identifier: Apache-2.0

import type { JournalKind, LiftJob } from './lift-job.js';

/** Return the diagnostic annotations actually persisted, without changing the lifecycle variant. */
export async function writeLiftJobCandidate<T extends LiftJob>(
  writer: (job: LiftJob, kind: JournalKind) => Promise<LiftJob | void>,
  job: T,
  kind: JournalKind,
): Promise<T> {
  return (await writer(job, kind) ?? job) as T;
}
