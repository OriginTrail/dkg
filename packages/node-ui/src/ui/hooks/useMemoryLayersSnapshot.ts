import { useCallback, useRef, useState } from 'react';
import { fetchMemoryLayersDeduped, type MemoryLayersApiResponse } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { useCoalescingRecurringTask } from './useCoalescingRecurringTask.js';

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
  const currentScope = useRef(scope);
  currentScope.current = scope;

  const readOnce = useCallback(async (signal: AbortSignal) => {
    const requestedScope = currentScope.current;
    if (!requestedScope.contextGraphId || signal.aborted) return 'idle' as const;
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

    // The canonical task owns pass lifetime; scope also fences results between
    // render and effect cleanup, before the previous pass has been aborted.
    if (!signal.aborted && sameScope(currentScope.current, requestedScope)) {
      setState(completed);
    }
    return 'idle' as const;
  }, []);

  const refresh = useCoalescingRecurringTask(JSON.stringify([contextGraphId, includeQueryCatalog]), readOnce);

  useMemoryGraphEvents(contextGraphId, refresh);

  const visibleState: ReadState = sameScope(state.scope, scope) ? state : {
    scope, phase: 'loading', snapshot: null, failure: null,
  };
  return { state: visibleState, refresh };
}
