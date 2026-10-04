// SPDX-License-Identifier: Apache-2.0
import { isSparqlUpdateOperation } from '@origintrail-official/dkg-core';
import { composeTripleStoreCommitment, deleteByPatternWithoutCount, isStoreOperationNotStarted,
  type TripleStore, type Quad, type SortedGraphSetSource, type StoreOperation } from '@origintrail-official/dkg-storage';
import { atomicSubjectMutationFacade } from './atomic-subject-mutation-facade.js';

export function createListContextGraphsCacheInvalidatingStore(
  innerStore: TripleStore,
  invalidate: () => void,
  // #1863 — `targetGraph` lets a single-graph destructive mutation (replaceSubject)
  // dirty the projection by graph rather than by inserted quads (covers deletes).
  markProjectionDirty?: (
    quads?: readonly Quad[],
    targetGraph?: string,
    targetSubject?: string,
  ) => void,
): TripleStore & Partial<SortedGraphSetSource> {
  const invalidateAfterMutation = async <T>(
    work: () => Promise<T>,
    changed: (result: T) => boolean,
    markDirty?: () => void,
    operation?: StoreOperation,
  ): Promise<T> => {
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
        () => markProjectionDirty?.(undefined, pattern.graph),
        'deleteByPattern',
      );
    },
    deleteByPatternWithoutCount(pattern, options) {
      return invalidateAfterMutation(
        () => deleteByPatternWithoutCount(innerStore, pattern, options),
        () => true,
        () => markProjectionDirty?.(undefined, pattern.graph),
        'deleteByPattern',
      );
    },
    query(sparql, options) {
      return invalidateAfterMutation(
        () => innerStore.query(sparql, options),
        () => isSparqlUpdateOperation(sparql),
        () => markProjectionDirty?.(),
        isSparqlUpdateOperation(sparql) ? 'query' : undefined,
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
          () => markProjectionDirty?.(undefined, graphUri),
          'replaceGraph',
        )
      : undefined,
    // Preserve atomic rootless KA graph+metadata materialization.
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
            // Both deletion targets are named. A graph-scoped invalidation
            // covers inserted and removed facts without scanning the payload.
            () => {
              markProjectionDirty?.(undefined, graphUri);
              markProjectionDirty?.(undefined, metaGraphUri);
            },
            'replaceGraphAndSubject',
          )
      : undefined,
    ...atomicSubjectMutationFacade(innerStore, (operation, graphUri, subject, quads, execute) =>
      invalidateAfterMutation(execute, () => true,
        // The target graph covers deleted facts; the replacement quads
        // cover inserted recipient facts. The subject lets downstream
        // invalidation distinguish exact atomic replacement paths.
        () => markProjectionDirty?.(quads, graphUri, subject), operation)),
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
            markProjectionDirty(undefined, input.sharedProjectionGraph);
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
        )
      : undefined,
    listGraphs(options) {
      return innerStore.listGraphs(options);
    },
    // Forward unchanged graph visibility to preserve the responder's stable catalog path.
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
    // Forward the optional UPDATE capability truthfully. An opaque mutation can
    // create/drop graphs or recipient facts, so invalidate both caches.
    update: innerStore.update
      ? (sparql, options) => invalidateAfterMutation(
        () => innerStore.update!(sparql, options),
        () => true,
        () => markProjectionDirty?.(),
        'update',
      )
      : undefined,
    // Preserve explicit whole-request atomicity and the same outcome-aware invalidation as UPDATE.
    atomicUpdate: innerStore.atomicUpdate
      ? (sparql, options) => invalidateAfterMutation(
        () => innerStore.atomicUpdate!(sparql, options),
        () => true,
        () => markProjectionDirty?.(),
        'update',
      )
      : undefined,
    commitment: composeTripleStoreCommitment(innerStore),
    flush: innerStore.flush ? (options) => innerStore.flush!(options) : undefined,
    close() {
      return innerStore.close();
    },
  };
  return wrapper;
}
