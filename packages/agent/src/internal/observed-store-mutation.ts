// SPDX-License-Identifier: Apache-2.0

import { isStoreOperationNotStarted, type Quad, type StoreOperation } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

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
  return invalidateAfterMutation;
}
