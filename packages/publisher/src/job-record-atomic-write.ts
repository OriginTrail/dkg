import {
  controlStoreOptions,
  tryReplaceSubjectAndInsertAtomically,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { serializeJobRecord } from './async-lift-control-plane.js';
import type { LiftJob } from './lift-job.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';

/** Reassert the immutable request and replace the job without exposing a dangling requestRef. */
export async function persistLiftJobRecord(store: TripleStore, graphUri: string, job: LiftJob): Promise<void> {
  const { jobRef, jobQuads, requestQuads } = serializeJobRecord(job, graphUri);
  // One options object serves the atomic write and the fallback's delete and insert: they are one logical write.
  const writeJob = controlStoreOptions('publisher', 'publisher.asyncLift.writeJob');
  // The storage try helper validates both groups before capability dispatch or refusal,
  // so the fallback also rejects malformed input before request reassertion.
  const replaced = await tryReplaceSubjectAndInsertAtomically(store, graphUri, jobRef, jobQuads, requestQuads, writeJob);
  if (replaced) return;
  // Only absent capability / clean preflight refusal reaches this existing request-first path.
  // Execution errors propagate: replay after an uncertain commit could overwrite a later claim.
  await store.insert(requestQuads, controlStoreOptions('publisher', 'publisher.asyncLift.writeJobRequest'));
  await replaceSubjectAtomicallyOrFallback(store, graphUri, jobRef, jobQuads, writeJob);
}
