// SPDX-License-Identifier: Apache-2.0

import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, isStoreOperationNotStarted, type TripleStore, type SortedGraphSetSource, type StoreOperation } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

export function createListContextGraphsCacheInvalidatingStore(
  innerStore: TripleStore,
  invalidate: () => void,
  // Every write is described once (#1863: a single-graph destructive mutation
  // names its target graph so deleted facts are fenced, not only inserted
  // ones) and the observer sees it before dispatch and again when it settles.
  observer?: StoreMutationObserver,
): TripleStore & Partial<SortedGraphSetSource> {
  const invalidateAfterMutation = async <T>(
    work: () => Promise<T>,
    changed: (result: T) => boolean,
    mutation?: StoreMutation,
    operation?: StoreOperation,
  ): Promise<T> => {
    const settle = mutation === undefined ? undefined : observer?.begin(mutation);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      // A mutation may have committed before its response was lost. Only an
      // outcome-tagged pre-dispatch refusal proves cache/authority state did
      // not change; every indeterminate outcome must invalidate fail-closed.
      const indeterminate = operation !== undefined && !isStoreOperationNotStarted(error, operation);
      if (indeterminate) invalidate();
      settle?.(indeterminate);
      throw error;
    }
    const didChange = changed(result);
    if (didChange) invalidate();
    settle?.(didChange);
    return result;
  };
  const sortedSource = typeof (innerStore as Partial<SortedGraphSetSource>).listGraphsSorted
    === 'function'
    ? innerStore as TripleStore & SortedGraphSetSource
    : null;
  const wrapper: TripleStore
    & Partial<SortedGraphSetSource>
    & { readonly innerStore: TripleStore } = {
    innerStore,
    get queryCancellation() {
      return innerStore.queryCancellation;
    },
    getPressureSnapshot() {
      return innerStore.getPressureSnapshot?.();
    },
    insert(quads, options) {
      return invalidateAfterMutation(
        () => innerStore.insert(quads, options),
        () => quads.length > 0,
        { quads },
        'insert',
      );
    },
    delete(quads, options) {
      return invalidateAfterMutation(
        () => innerStore.delete(quads, options),
        () => quads.length > 0,
        { quads },
        'delete',
      );
    },
    deleteByPattern(pattern, options) {
      return invalidateAfterMutation(
        () => innerStore.deleteByPattern(pattern, options),
        removed => removed > 0,
        { removals: [pattern] },
        'deleteByPattern',
      );
    },
    deleteByPatternWithoutCount(pattern, options) {
      return invalidateAfterMutation(
        () => deleteByPatternWithoutCount(innerStore, pattern, options),
        () => true,
        { removals: [pattern] },
        'deleteByPattern',
      );
    },
    query(sparql, options) {
      const update = isSparqlUpdateOperation(sparql);
      return invalidateAfterMutation(
        () => innerStore.query(sparql, options),
        () => update,
        update ? { everything: true } : undefined,
        update ? 'query' : undefined,
      );
    },
    hasGraph(graphUri, options) {
      return innerStore.hasGraph(graphUri, options);
    },
    createGraph(graphUri) {
      return innerStore.createGraph(graphUri);
    },
    dropGraph(graphUri, options) {
      return invalidateAfterMutation(
        () => innerStore.dropGraph(graphUri, options),
        () => true,
        { removals: [{ graph: graphUri }] },
        'dropGraph',
      );
    },
    replaceGraph: innerStore.replaceGraph
      ? (graphUri, quads, options) => invalidateAfterMutation(
          () => innerStore.replaceGraph!(graphUri, quads, options),
          () => true,
          { removals: [{ graph: graphUri }], quads },
          'replaceGraph',
        )
      : undefined,
    // Rootless KA materialization replaces the assertion graph and its UAL
    // metadata subject in one backend transaction. Preserve that optional
    // capability through the agent decorator just like replaceGraph/update;
    // omitting it makes every capable production backend appear unsupported.
    replaceGraphAndSubject: innerStore.replaceGraphAndSubject
      ? (graphUri, graphQuads, metaGraphUri, metadataSubject, metadataQuads, options) =>
          invalidateAfterMutation(
            () => innerStore.replaceGraphAndSubject!(
              graphUri,
              graphQuads,
              metaGraphUri,
              metadataSubject,
              metadataQuads,
              options,
            ),
            () => true,
            // Both deletion targets are named, the metadata one with its subject.
            {
              removals: [{ graph: graphUri }, { graph: metaGraphUri, subject: metadataSubject }],
              quads: [...graphQuads, ...metadataQuads],
            },
            'replaceGraphAndSubject',
          )
      : undefined,
    // #1863 — the async-lift publisher persists a job transition via this atomic
    // single-subject replace. Preserve the optional capability through the agent
    // decorator just like replaceGraph/replaceGraphAndSubject/update; omitting it
    // makes every capable production backend appear unsupported, so the publisher
    // silently falls back to non-atomic delete-then-insert and the fix is a no-op.
    replaceSubject: innerStore.replaceSubject
      ? (graphUri, subject, quads, options) =>
          invalidateAfterMutation(
            () => innerStore.replaceSubject!(graphUri, subject, quads, options),
            () => true,
            // The target graph and subject cover deleted facts; the
            // replacement quads cover inserted recipient facts.
            { removals: [{ graph: graphUri, subject }], quads },
            'replaceSubject',
          )
      : undefined,
    // RFC-64 author publication moves a complete public-SWM projection and
    // its bounded semantic control state through one backend CAS. Preserve the
    // capability through this cache-invalidation decorator and invalidate only
    // after a proven commit; a clean guard conflict changes nothing.
    rfc64AuthorCommitCasV1: innerStore.rfc64AuthorCommitCasV1
      ? (input, options) => invalidateAfterMutation(
          () => innerStore.rfc64AuthorCommitCasV1!(input, options),
          result => result === 'committed',
          // The CAS names every graph it replaces. A graph-wide dirty mark
          // would invalidate an unrelated private CG's own metadata proof
          // after every authored row, even though the CAS only changed this
          // exact projection and its control subjects. Fence each named
          // target, including deleted facts, without losing the conservative
          // all-graph fallback used by genuinely opaque store mutations.
          {
            removals: ('currentHead' in input
              ? [
                input.sharedProjectionGraph,
                input.authorSealGraph,
                ...[input.currentHead, input.subgraphMutationGeneration, input.contextGraphMutationGeneration, input.appliedSet]
                  .map((transition) => transition.graphUri),
              ]
              : [
                input.sharedProjectionGraph,
                input.authorSealGraph,
                input.currentHeadGraph,
                ...[input.kaStateDigest, input.subgraphMutationGeneration, input.contextGraphMutationGeneration, input.appliedSet, ...input.sealInvalidations]
                  .map((transition) => transition.graphUri),
              ]
            ).map((graph) => ({ graph })),
            unseenPayload: true,
          },
          'rfc64AuthorCommitCasV1',
        )
      : undefined,
    listGraphs(options) {
      return innerStore.listGraphs(options);
    },
    // This wrapper changes mutation-side cache state but not graph visibility,
    // so forwarding the direct inner capability preserves the same public
    // boundary while keeping the responder's identity-stable catalog path live.
    listGraphsSorted: sortedSource
      ? (options) => sortedSource.listGraphsSorted(options)
      : undefined,
    listGraphsByPrefix(prefix, options) {
      return innerStore.listGraphsByPrefix
        ? innerStore.listGraphsByPrefix(prefix, options)
        : innerStore.listGraphs(options).then((graphs) => graphs.filter((graph) => graph.startsWith(prefix)));
    },
    deleteBySubjectPrefix(graphUri, prefix, options) {
      return invalidateAfterMutation(
        () => innerStore.deleteBySubjectPrefix(graphUri, prefix, options),
        removed => removed > 0,
        { everything: true },
        'deleteBySubjectPrefix',
      );
    },
    countQuads(graphUri, options) {
      return innerStore.countQuads(graphUri, options);
    },
    // Defined iff the inner store supports it, so the capability propagates
    // truthfully up the decorator chain (callers gate on `typeof store.update
    // === 'function'`). A server-side UPDATE can create/drop named graphs and
    // mutate projected content, so it invalidates the listGraphs cache and
    // marks the projection dirty just like insert/delete.
    update: innerStore.update
      ? (sparql, options) => invalidateAfterMutation(
        () => innerStore.update!(sparql, options),
        () => true,
        { everything: true },
        'update',
      )
      : undefined,
    flush: innerStore.flush ? (options) => innerStore.flush!(options) : undefined,
    close() {
      return innerStore.close();
    },
  };
  return wrapper;
}
