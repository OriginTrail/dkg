import { isStoreOperationNotStarted, type TripleStore } from '@origintrail-official/dkg-storage';
import { persistPromoteJob } from './bound-promote-job.js';
import type { PromoteJob } from './async-promote-queue-types.js';

export type PromotePersistenceResult = { ok: true } | {
  ok: false;
  admissionOutcome: 'not_admitted' | 'indeterminate';
  cause: unknown;
};

/**
 * When a job write must be on disk. `flush` returns only after the store has persisted the write and
 * everything written before it. `next-flush` returns once the store holds the write: the embedded store
 * persists whole snapshots of its state, so the write is on disk no later than the next flushed write,
 * and a crash before then loses it only together with every write after it. Stores without `flush`
 * persist each write before acknowledging it, so both mean the same there.
 */
export type PromoteJobWriteDurability = 'flush' | 'next-flush';

/** Owns the distinction between primary persistence and post-write flush. */
export async function persistPromoteJobWithEvidence(
  store: TripleStore, graphUri: string, job: PromoteJob, durability: PromoteJobWriteDurability = 'flush',
): Promise<PromotePersistenceResult> {
  try { await persistPromoteJob(store, graphUri, job); }
  catch (cause) {
    return { ok: false, cause, admissionOutcome: isStoreOperationNotStarted(cause, 'replaceSubject')
      ? 'not_admitted' : 'indeterminate' };
  }
  if (durability === 'next-flush') return { ok: true };
  try { await store.flush?.(); }
  catch (cause) { return { ok: false, cause, admissionOutcome: 'indeterminate' }; }
  return { ok: true };
}
