// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import { readStoreOperationExecutionGeneration, isStoreOperationNotStarted, type Quad, type StoreOperation } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

/** Writes performed by this asynchronous operation, independent of its semantic result. */
const mutationScopes = new AsyncLocalStorage<{ changed: boolean }>();
export async function observeStoreMutations<T>(work: () => Promise<T>): Promise<{ result: T; mutated: boolean }> {
  const parent = mutationScopes.getStore();
  const scope = { changed: false };
  try {
    const result = await mutationScopes.run(scope, work);
    return { result, mutated: scope.changed };
  } finally {
    if (parent && scope.changed) parent.changed = true;
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

export type ObservedStoreMutation = <T>(
  work: () => Promise<T>,
  changed: (result: T) => boolean,
  mutation?: StoreMutation,
  operation?: StoreOperation,
) => Promise<T>;

/** Shared mutation observation for the store wrapper and explicitly composed typed writers. */
export function createObservedStoreMutation(
  invalidate: () => void,
  observerOrCallback?: StoreMutationObserver | ProjectionDirtyCallback,
): ObservedStoreMutation {
  const observer = typeof observerOrCallback === 'function'
    ? observerFromCallback(observerOrCallback)
    : observerOrCallback;
  const invalidateAfterMutation = async <T>(
    work: () => Promise<T>,
    changed: (result: T) => boolean,
    mutation?: StoreMutation,
    operation?: StoreOperation,
  ): Promise<T> => {
    const scope = mutationScopes.getStore();
    const settle = mutation === undefined ? undefined : observer?.begin(mutation);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      // A mutation may have committed before its response was lost. Only an
      // outcome-tagged pre-dispatch refusal proves cache/authority state did
      // not change; every indeterminate outcome must invalidate fail-closed.
      const indeterminate = operation === undefined
        ? mutation !== undefined : !isStoreOperationNotStarted(error, operation);
      if (indeterminate) { if (scope) scope.changed = true; invalidate(); }
      const generation = operation === undefined ? undefined : readStoreOperationExecutionGeneration(error, operation);
      const outcome = indeterminate ? 'indeterminate' : 'unchanged';
      if (generation === undefined) settle?.(outcome);
      else settle?.(outcome, { generation });
      throw error;
    }
    const didChange = changed(result);
    if (didChange) { if (scope) scope.changed = true; invalidate(); }
    settle?.(didChange ? 'changed' : 'unchanged');
    return result;
  };
  return invalidateAfterMutation;
}
