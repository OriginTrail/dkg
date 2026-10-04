import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMemoryLayersDeduped, type MemoryLayersApiResponse } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';

interface ReadScope {
  contextGraphId: string;
  includeQueryCatalog: boolean;
}

type ReadState = { scope: ReadScope } & (
  | { phase: 'loading'; snapshot: MemoryLayersApiResponse | null; failure: null }
  | { phase: 'ready'; snapshot: MemoryLayersApiResponse; failure: null }
  | { phase: 'failed'; snapshot: null; failure: string }
);

function sameScope(left: ReadScope, right: ReadScope): boolean {
  return left.contextGraphId === right.contextGraphId
    && left.includeQueryCatalog === right.includeQueryCatalog;
}

/** Owns one scoped snapshot and serializes refreshes to one trailing read. */
export function useMemoryLayersSnapshot(contextGraphId: string, includeQueryCatalog: boolean) {
  const scope = { contextGraphId, includeQueryCatalog };
  const [state, setState] = useState<ReadState>({
    scope, phase: 'loading', snapshot: null, failure: null,
  });
  const coordinator = useRef({ scope, active: false, epoch: 0, running: false, pending: false });
  coordinator.current.scope = scope;

  const readOnce = useCallback(async () => {
    const owner = coordinator.current;
    const requestedScope = owner.scope;
    const requestedEpoch = owner.epoch;
    setState(previous => ({
      scope: requestedScope,
      phase: 'loading',
      snapshot: sameScope(previous.scope, requestedScope) ? previous.snapshot : null,
      failure: null,
    }));

    let completed: ReadState;
    try {
      const snapshot = await fetchMemoryLayersDeduped(
        requestedScope.contextGraphId, requestedScope.includeQueryCatalog,
      );
      completed = { scope: requestedScope, phase: 'ready', snapshot, failure: null };
    } catch (error: unknown) {
      completed = {
        scope: requestedScope, phase: 'failed', snapshot: null,
        failure: error instanceof Error ? error.message : 'Failed to load memory data',
      };
    }

    // Every success or failure passes the same ownership fence. Scope changes,
    // unmounts and StrictMode effect remounts all invalidate the captured epoch.
    if (owner.active && owner.epoch === requestedEpoch && sameScope(owner.scope, requestedScope)) {
      setState(completed);
    }
  }, []);

  const refresh = useCallback(async () => {
    const owner = coordinator.current;
    if (!owner.active || !owner.scope.contextGraphId) return;
    if (owner.running) {
      owner.pending = true;
      return;
    }
    owner.running = true;
    try {
      do {
        owner.pending = false;
        await readOnce();
      } while (owner.active && owner.pending);
    } finally {
      owner.running = false;
    }
  }, [readOnce]);

  useMemoryGraphEvents(contextGraphId, refresh);
  useEffect(() => {
    const owner = coordinator.current;
    owner.active = true;
    void refresh();
    return () => {
      owner.active = false;
      owner.pending = false;
      owner.epoch++;
    };
  }, [contextGraphId, includeQueryCatalog, refresh]);

  const visibleState: ReadState = sameScope(state.scope, scope) ? state : {
    scope, phase: 'loading', snapshot: null, failure: null,
  };
  return { state: visibleState, refresh };
}
