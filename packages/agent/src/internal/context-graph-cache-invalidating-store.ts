// SPDX-License-Identifier: Apache-2.0

import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, isStoreOperationNotStarted, type TripleStore, type Quad, type SortedGraphSetSource, type StoreOperation } from '@origintrail-official/dkg-storage';

/** What a destructive mutation names beyond its graph and subject. */
export interface StoreMutationScope {
  predicate?: string;
  /** The inserted quads were not visible to the decorator. */
  unscopedPayload?: boolean;
}

export function createListContextGraphsCacheInvalidatingStore(
  innerStore: TripleStore,
  invalidate: () => void,
  // #1863 — `targetGraph` lets a single-graph destructive mutation (replaceSubject)
  // dirty the projection by graph rather than by inserted quads (covers deletes).
  markProjectionDirty?: (
    quads?: readonly Quad[],
    targetGraph?: string,
    targetSubject?: string,
    scope?: StoreMutationScope,
  ) => void,
  // Called before an inserting write is dispatched (no quads: they are unknown).
  anticipateWrite?: (quads?: readonly Quad[]) => void,
): TripleStore & Partial<SortedGraphSetSource> {
  const invalidateAfterMutation = async <T>(
    work: () => Promise<T>,
    changed: (result: T) => boolean,
    markDirty?: () => void,
    operation?: StoreOperation,
    anticipate?: () => void,
  ): Promise<T> => {
    anticipate?.();
    try {
      const result = await work();
      if (changed(result)) {
        invalidate();
        markDirty?.();
      }
      return result;
    } catch (error) {
      // A mutation may have committed before its response was lost. Only an
      // outcome-tagged pre-dispatch refusal proves cache/authority state did
      // not change; every indeterminate outcome must invalidate fail-closed.
      if (operation !== undefined && !isStoreOperationNotStarted(error, operation)) {
        invalidate();
        markDirty?.();
      }
      throw error;
    }
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
        () => markProjectionDirty?.(quads),
        'insert',
        () => anticipateWrite?.(quads),
      );
    },
    delete(quads, options) {
      return invalidateAfterMutation(
        () => innerStore.delete(quads, options),
        () => quads.length > 0,
        () => markProjectionDirty?.(quads),
        'delete',
      );
    },
    deleteByPattern(pattern, options) {
      return invalidateAfterMutation(
        () => innerStore.deleteByPattern(pattern, options),
        removed => removed > 0,
        () => markProjectionDirty?.(undefined, pattern.graph, pattern.subject, { predicate: pattern.predicate }),
        'deleteByPattern',
      );
    },
    deleteByPatternWithoutCount(pattern, options) {
      return invalidateAfterMutation(
        () => deleteByPatternWithoutCount(innerStore, pattern, options),
        () => true,
        () => markProjectionDirty?.(undefined, pattern.graph, pattern.subject, { predicate: pattern.predicate }),
        'deleteByPattern',
      );
    },
    query(sparql, options) {
      return invalidateAfterMutation(
        () => innerStore.query(sparql, options),
        () => isSparqlUpdateOperation(sparql),
        () => markProjectionDirty?.(),
        isSparqlUpdateOperation(sparql) ? 'query' : undefined,
        isSparqlUpdateOperation(sparql) ? () => anticipateWrite?.() : undefined,
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
        () => markProjectionDirty?.(undefined, graphUri),
        'dropGraph',
      );
    },
    replaceGraph: innerStore.replaceGraph
      ? (graphUri, quads, options) => invalidateAfterMutation(
          () => innerStore.replaceGraph!(graphUri, quads, options),
          () => true,
          () => markProjectionDirty?.(quads, graphUri),
          'replaceGraph',
          () => anticipateWrite?.(quads),
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
            () => {
              markProjectionDirty?.(graphQuads, graphUri);
              markProjectionDirty?.(metadataQuads, metaGraphUri, metadataSubject);
            },
            'replaceGraphAndSubject',
            () => anticipateWrite?.([...graphQuads, ...metadataQuads]),
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
            // The target graph covers deleted facts; the replacement quads
            // cover inserted recipient facts. The subject lets downstream
            // invalidation distinguish exact atomic replacement paths.
            () => markProjectionDirty?.(quads, graphUri, subject),
            'replaceSubject',
            () => anticipateWrite?.(quads),
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
          () => {
            // The CAS names every graph it replaces. A graph-wide dirty mark
            // here invalidates an unrelated private CG's own metadata proof
            // after every authored row, even though the CAS only changed this
            // exact projection and its control subjects. Fence each named
            // target, including deleted facts, without losing the conservative
            // all-graph fallback used by genuinely opaque store mutations.
            if (markProjectionDirty === undefined) return;
            const unscoped = { unscopedPayload: true };
            markProjectionDirty(undefined, input.sharedProjectionGraph, undefined, unscoped);
            markProjectionDirty(undefined, input.authorSealGraph);
            if ('currentHead' in input) {
              for (const transition of [
                input.currentHead,
                input.subgraphMutationGeneration,
                input.contextGraphMutationGeneration,
                input.appliedSet,
              ]) {
                markProjectionDirty(undefined, transition.graphUri);
              }
            } else {
              markProjectionDirty(undefined, input.currentHeadGraph);
              for (const transition of [
                input.kaStateDigest,
                input.subgraphMutationGeneration,
                input.contextGraphMutationGeneration,
                input.appliedSet,
                ...input.sealInvalidations,
              ]) {
                markProjectionDirty(undefined, transition.graphUri);
              }
            }
          },
          'rfc64AuthorCommitCasV1',
          () => anticipateWrite?.(),
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
        () => markProjectionDirty?.(),
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
        () => markProjectionDirty?.(),
        'update',
        () => anticipateWrite?.(),
      )
      : undefined,
    flush: innerStore.flush ? (options) => innerStore.flush!(options) : undefined,
    close() {
      return innerStore.close();
    },
  };
  return wrapper;
}
