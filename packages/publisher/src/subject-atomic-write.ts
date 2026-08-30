// #1938 — the single shared atomic-replace/fallback writer for the two persistent
// publisher control-plane queues (async-lift #1863/#1919 and async-promote #1933).
// The atomic-capable-vs-fallback policy is a publisher/storage concern, NOT a per-queue
// one; keeping it in one place stops the queues drifting on fallback behavior or `source`
// tagging. Each queue keeps only its own record-shaping concern (lift's request-first
// pre-insert ordering; promote's single-subject guard) and calls this for the mutable
// subject write.

import {
  assertSubjectReplacementPayload,
  deleteByPatternWithoutCount,
  tryReplaceSubjectAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

/**
 * Persist a single mutable subject as one atomic replace when the store can guarantee one
 * commit boundary, else fall through to the BOUNDED delete-then-insert.
 *
 * The single-subject invariant is enforced UP FRONT via the storage layer's own
 * `assertSubjectReplacementPayload` — the SAME assertion the atomic path runs inside
 * `buildAtomicSubjectReplaceUpdate` — so BOTH paths reject an out-of-contract payload
 * identically (subject is a canonical skolem IRI; every quad targets exactly `subject` in
 * `graphUri`; blank-node free). Without this, only the atomic path validated: the bounded
 * fallback deletes only `subject`'s rows in `graphUri` and then inserts whatever it is
 * given, so a co-located or blank-node quad would be silently leaked on the fallback path
 * while the atomic path rejected it (#1938 — close the asymmetry rather than leave the
 * invariant to caller discipline). The queue serializers still own record shaping.
 *
 * The atomic path routes through the storage capability `tryReplaceSubjectAtomically` (a
 * sibling of `replaceGraph` / `replaceGraphAndSubject`): the storage layer owns the
 * transaction boundary, literal externalization, and graph-set-index / changelog /
 * reserved-plane bookkeeping structurally — a raw `update()` string would be scanned and
 * false-rejected by ChangelogStore. On a store with no `replaceSubject`, or a
 * non-transactional endpoint that refuses it, the fallback delete is scoped to EXACTLY
 * `subject` in `graphUri`, so it never widens to touch a co-located subject (e.g. the lift
 * queue's immutable request row).
 *
 * `source` is passed through per-queue (`publisher.asyncLift.writeJob` /
 * `publisher.asyncPromote.writeJob`) so storage-side instrumentation still attributes the
 * write to its originating queue.
 */
export async function replaceSubjectAtomicallyOrFallback(
  store: TripleStore,
  graphUri: string,
  subject: string,
  quads: Quad[],
  source: string,
): Promise<void> {
  // Enforce the atomic path's single-subject contract on BOTH paths, before either runs.
  assertSubjectReplacementPayload(graphUri, subject, quads);
  const replaced = await tryReplaceSubjectAtomically(store, graphUri, subject, quads, { source });
  if (replaced) return;
  await deleteByPatternWithoutCount(store, { subject, graph: graphUri });
  await store.insert(quads);
}
