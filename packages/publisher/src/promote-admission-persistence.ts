import { isStoreOperationNotStarted, type TripleStore } from '@origintrail-official/dkg-storage';
import { persistPromoteJob } from './bound-promote-job.js';
import type { PromoteJob } from './async-promote-queue-types.js';

export type PromotePersistenceResult = { ok: true } | {
  ok: false;
  admissionOutcome: 'not_admitted' | 'indeterminate';
  cause: unknown;
};

/** Owns the distinction between primary persistence and post-write flush. */
export async function persistPromoteJobWithEvidence(
  store: TripleStore, graphUri: string, job: PromoteJob,
): Promise<PromotePersistenceResult> {
  try { await persistPromoteJob(store, graphUri, job); }
  catch (cause) {
    return { ok: false, cause, admissionOutcome: isStoreOperationNotStarted(cause, 'replaceSubject')
      ? 'not_admitted' : 'indeterminate' };
  }
  try { await store.flush?.(); }
  catch (cause) { return { ok: false, cause, admissionOutcome: 'indeterminate' }; }
  return { ok: true };
}
