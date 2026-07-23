// #1938 — the single shared atomic-replace/fallback writer for the two persistent
// publisher control-plane queues (async-lift #1863/#1919 and async-promote #1933).
// The atomic-capable-vs-fallback policy is a publisher/storage concern, NOT a per-queue
// one; keeping it in one place stops the queues drifting on fallback behavior or `source`
// tagging. Each queue keeps only its own record-shaping concern (lift's request-first
// pre-insert ordering; promote's single-subject guard) and calls this for the mutable
// subject write.

import { tryReplaceSubjectAtomically, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

/**
 * Persist a single mutable subject as one atomic replace when the store can guarantee one
 * commit boundary, else fall through to the BOUNDED delete-then-insert.
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
  const replaced = await tryReplaceSubjectAtomically(store, graphUri, subject, quads, { source });
  if (replaced) return;
  await store.deleteByPattern({ subject, graph: graphUri });
  await store.insert(quads);
}
