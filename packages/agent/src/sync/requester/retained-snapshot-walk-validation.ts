// SPDX-License-Identifier: Apache-2.0

import type { SyncWorkAdmission } from '../work-admission.js';
import type { RetainedSharedMemorySnapshotWalkContinuation } from './shared-memory-sync.js';

export type RetainedSnapshotWalkValidation =
  | { kind: 'complete'; validatedRefs: number }
  | { kind: 'local-budget-yield'; validatedRefs: number };

/** Revalidate cross-job completion evidence before any retained ref is reused. */
export async function validateRetainedSnapshotWalk(options: {
  readonly walk: RetainedSharedMemorySnapshotWalkContinuation;
  readonly deadline: number;
  readonly workAdmission: SyncWorkAdmission;
  readonly validateRef: (ref: string) => Promise<boolean>;
  readonly now?: () => number;
}): Promise<RetainedSnapshotWalkValidation> {
  const { walk, deadline, workAdmission, validateRef } = options;
  const now = options.now ?? Date.now;
  const retainedRefs = walk.resolvedRefsSnapshot();
  let validatedRefs = 0;
  for (const [index, ref] of retainedRefs.entries()) {
    if (now() >= deadline || !workAdmission.canAdmitWork()) {
      for (const unvalidatedRef of retainedRefs.slice(index)) {
        walk.invalidateResolved(unvalidatedRef);
      }
      return { kind: 'local-budget-yield', validatedRefs };
    }
    if (await validateRef(ref)) validatedRefs += 1;
    else walk.invalidateResolved(ref);
  }
  return { kind: 'complete', validatedRefs };
}
