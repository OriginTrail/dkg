// SPDX-License-Identifier: Apache-2.0

import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  describeRfc64AuthorCommitCasV1,
  isStoreOperationNotStarted,
  type Rfc64AuthorCommitCasInputV1,
  type SortedGraphSetSource,
  type Quad,
  type StoreOperation,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

// A commit the canonical plan refuses is refused by the store before dispatch too; until it is,
// it may change anything.
function describeCommit(input: Rfc64AuthorCommitCasInputV1): StoreMutation {
  try {
    return describeRfc64AuthorCommitCasV1(input);
  } catch {
    return { everything: true };
  }
}

/**
 * The third argument this factory took before it took an observer, still accepted because the
 * factory is reachable through the historical `dkg-agent-base` export: called after a write that
 * changed something, with its quads, or with the graph and subject it removed, or with nothing
 * when it may have changed anything.
 */
export type ProjectionDirtyCallback = (quads?: readonly Quad[], targetGraph?: string, targetSubject?: string) => void;

function observerFromCallback(markProjectionDirty: ProjectionDirtyCallback): StoreMutationObserver {
  return {
    begin: (mutation) => (outcome) => {
      if (outcome === 'unchanged') return;
      if (mutation.everything) {
        markProjectionDirty();
        return;
      }
      for (const { graph, subject } of mutation.removals ?? []) markProjectionDirty(undefined, graph, subject);
      if (mutation.quads) markProjectionDirty(mutation.quads);
    },
  };
}

export function createListContextGraphsCacheInvalidatingStore(
  innerStore: TripleStore,
  invalidate: () => void,
  // Every write is described once (#1863: a single-graph destructive mutation
  // names its target graph so deleted facts are fenced, not only inserted
  // ones) and the observer sees it before dispatch and again when it settles.
  observerOrCallback?: StoreMutationObserver | ProjectionDirtyCallback,
): TripleStore & Partial<SortedGraphSetSource> {
  const observer = typeof observerOrCallback === 'function'
    ? observerFromCallback(observerOrCallback)
    : observerOrCallback;
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
      settle?.(indeterminate ? 'indeterminate' : 'unchanged');
      throw error;
    }
    const didChange = changed(result);
    if (didChange) invalidate();
    settle?.(didChange ? 'changed' : 'unchanged');
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
    // after a proven commit; a clean guard conflict changes nothing. The commit
    // names every graph and subject it replaces, so only those are fenced, not
    // every cache of an unrelated private graph.
    rfc64AuthorCommitCasV1: innerStore.rfc64AuthorCommitCasV1
      ? (input, options) => invalidateAfterMutation(
          () => innerStore.rfc64AuthorCommitCasV1!(input, options),
          result => result === 'committed',
          describeCommit(input),
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
