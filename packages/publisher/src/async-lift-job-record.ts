// SPDX-License-Identifier: Apache-2.0
import { deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import type { LiftJob } from './lift-job.js';
import { serializeJobRecord, jobSubject, requestSubject } from './async-lift-control-plane.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import { withDraftArtifactQueueState } from './draft-artifact-retention.js';

/**
 * #1863 — persist the job record as a single-subject atomic replace so a
 * lock-free reader racing a transition never observes the job subject
 * transiently empty. Every row for `jobSubject` — the payload, the status, and
 * the `CONTROL_LIFECYCLE_KEY` intent-index row (emitted inside `serializeJob`
 * via `serializeVmPublishIntentIndex`) — is replaced in ONE commit, so the
 * false `kind:'none'` intent-lookup miss / dedup gap that hinges on that index
 * row disappearing mid-write cannot occur.
 *
 * Routed through the shared writer `replaceSubjectAtomicallyOrFallback` (#1938),
 * which uses the storage capability `tryReplaceSubjectAtomically` (a
 * sibling of `replaceGraph` / `replaceGraphAndSubject`) rather than a raw
 * `update()` string: the storage layer owns the transaction boundary, literal
 * externalization, graph-set-index and changelog bookkeeping, and — crucially —
 * the reserved-plane guard applies to the TARGET GRAPH structurally instead of
 * scanning a serialized SPARQL string (a raw update would false-reject a job
 * whose quads merely reference a reserved IRI). `replaceSubject` is a STRICT
 * single-subject primitive (it rejects co-located subjects), so the two
 * subjects `serializeJob` emits — the mutable job subject and the immutable
 * request subject — are persisted separately:
 *
 *   1. INSERT the request rows FIRST (idempotent — the request is immutable,
 *      so this is a no-op re-assert on every transition after creation, and the
 *      defensive re-assert legacy/partial re-persist relies on).
 *   2. THEN atomically replace the job subject.
 *
 * The ordering is load-bearing: the request must be present before the job
 * subject becomes observable, or a lock-free reader at CREATION could see a job
 * referencing an absent request (dangling requestRef). The job-replace must
 * never land first. A store that cannot guarantee one commit boundary (no
 * `replaceSubject`, or a non-transactional SPARQL endpoint that refuses it)
 * takes the BOUNDED pre-#1863 delete-then-insert fallback (job subject only —
 * the request stays present): it still has the transient job window, but
 * admission's claim-locked `findActiveKnowledgeAssetVmPublishJob` remains the
 * authoritative dedup guard there. Durability (#1851 fsync) stays scoped to
 * `recordDurableBroadcastBeforeSend`, not here.
 * Draft-reference acquisition shares the queue I/O fence around the complete
 * request-first transition, including that supported fallback window.
 */
export async function persistLiftJobRecord(store: TripleStore, graphUri: string, job: LiftJob): Promise<void> {
  await withDraftArtifactQueueState(store, async () => {
    // The serializer owns the split (and guards that a job record is exactly the
    // job + request subjects) — no ad-hoc subject filters on the write path.
    const { jobRef, jobQuads, requestQuads } = serializeJobRecord(job, graphUri);
    // (1) Request present BEFORE the job subject is observable — ordering matters.
    await store.insert(requestQuads);
    // (2) Atomically replace the mutable job subject via the shared writer (#1938),
    //     which owns the atomic-capable-vs-bounded-fallback policy for both queues.
    await replaceSubjectAtomicallyOrFallback(
      store,
      graphUri,
      jobRef,
      jobQuads,
      'publisher.asyncLift.writeJob',
    );
  });
}

/** Clear both subjects in the same queue view used by artifact-reference acquisition. */
export async function deleteLiftJobRecord(store: TripleStore, graphUri: string, jobId: string): Promise<void> {
  await withDraftArtifactQueueState(store, async () => {
    await deleteByPatternWithoutCount(store, { subject: jobSubject(jobId), graph: graphUri });
    await deleteByPatternWithoutCount(store, { subject: requestSubject(jobId), graph: graphUri });
  });
}
