import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoalescingRecurringTask } from '@origintrail-official/dkg-core/dist/coalescing-recurring-task.js';
import { invalidateQueryCache } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { memoryQueryDefinitions, type MemoryQueryDefinition } from './memory-query-definition.js';
import { MEMORY_LIMIT_MESSAGE, readMemoryGraphPage, type MemoryGraphPage, type MemoryReadFailureReason } from './memory-graph-query.js';
import type { LayeredMemoryTriple, MemoryLayerStatus, TrustLevel } from './useMemoryEntities.js';

interface MemorySource {
  definition: MemoryQueryDefinition;
  pages: MemoryGraphPage[];
  read: { kind: 'loading' | 'ready' }
    | { kind: 'failed'; reason: MemoryReadFailureReason; mode: ReadMode };
}

interface MemoryPages {
  key: string;
  contextGraphId: string;
  sources: MemorySource[];
  loading: boolean;
}

type ReadMode = 'refresh' | 'append';
const RETRY_PAGE = 'Could not load more graph data. Retry to continue from the last loaded page.';
const emptySource = (definition: MemoryQueryDefinition): MemorySource => ({ definition, pages: [], read: { kind: 'loading' } });

function sourceActions(source: MemorySource) {
  const hasCursor = !!source.pages.at(-1)?.nextCursor;
  if (source.read.kind !== 'failed') return { canContinue: hasCursor, canRetry: false };
  switch (source.read.reason) {
    case 'unavailable': return { canContinue: hasCursor, canRetry: true };
    case 'response-limit':
    case 'cancelled': return { canContinue: false, canRetry: false };
  }
}
const canContinue = (source: MemorySource) => sourceActions(source).canContinue;

function pageFailureMessage(source: MemorySource): string | null {
  if (source.read.kind !== 'failed' || source.read.mode !== 'append' || source.read.reason === 'cancelled') return null;
  return source.read.reason === 'response-limit' ? MEMORY_LIMIT_MESSAGE : RETRY_PAGE;
}

/** Refresh and continuation both accept complete pages through this transition. */
function acceptPage(source: MemorySource, result: MemoryGraphPage): MemorySource {
  return { ...source, pages: [...source.pages, result], read: { kind: 'ready' } };
}

async function readSource(source: MemorySource, mode: ReadMode, contextGraphId: string, signal: AbortSignal) {
  const depth = mode === 'refresh' ? Math.max(1, source.pages.length) : 1;
  let next: MemorySource = { ...source, pages: mode === 'refresh' ? [] : source.pages,
    read: { kind: 'ready' } };
  for (let page = 0; page < depth && !signal.aborted; page++) {
    const previous = next.pages.at(-1);
    if (previous && !previous.nextCursor) break;
    const result = await readMemoryGraphPage(source.definition, contextGraphId, {
      includeContextGraphPartitions: true, cursor: previous?.nextCursor, signal,
    });
    if (!result.ok) {
      return {
        ...next, read: { kind: 'failed' as const, reason: result.reason, mode },
        // Keep a coherent last successful preview if replay fails partway.
        pages: mode === 'refresh' && source.pages.length ? source.pages : next.pages,
      };
    }
    next = acceptPage(next, result);
  }
  return next;
}

/** One scoped page collection owns rows, continuation, loaded depth and read status. */
export function useMemoryPages(contextGraphId: string, includeQueryCatalog: boolean) {
  const key = JSON.stringify([contextGraphId, includeQueryCatalog]);
  const definitions = useMemo(() => memoryQueryDefinitions(contextGraphId, includeQueryCatalog), [contextGraphId, includeQueryCatalog]);
  const [state, setState] = useState<MemoryPages>({ key: '', contextGraphId: '', sources: [], loading: true });
  // This ref points at the same committed collection, for queued async work.
  const stateRef = useRef(state);
  const taskRef = useRef<{ key: string; task: CoalescingRecurringTask; mode: ReadMode } | null>(null);

  const commit = useCallback((next: MemoryPages) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const task: CoalescingRecurringTask = new CoalescingRecurringTask({
      closingMessage: 'Memory graph scope closed',
      runPass: async signal => {
        const mode = entry.mode;
        entry.mode = 'refresh';
        const previous = stateRef.current;
        const sources = definitions.map(definition => previous.contextGraphId === contextGraphId
          ? previous.sources.find(source => source.definition.key === definition.key) ?? emptySource(definition)
          : emptySource(definition));
        if (mode === 'append' && !sources.some(canContinue)) return;
        commit({ key, contextGraphId, sources, loading: true });
        const results = await Promise.all(sources.map(source => mode === 'append' && !canContinue(source)
          ? source : readSource(source, mode, contextGraphId, signal)));
        if (!signal.aborted) commit({ key, contextGraphId, sources: results, loading: false });
      },
      onError: () => {
        if (!task.closed) commit({ ...stateRef.current, loading: false,
          sources: stateRef.current.sources.map(source => ({ ...source,
            read: { kind: 'failed', reason: 'unavailable', mode: 'refresh' } })),
        });
      },
    });
    const entry = { key, mode: 'refresh' as ReadMode, task };
    taskRef.current = entry;
    if (contextGraphId) entry.task.request();
    else commit({ key, contextGraphId, sources: [], loading: false });
    return () => {
      taskRef.current = null;
      void entry.task.close();
    };
  }, [contextGraphId, definitions, key, commit]);
  const run = useCallback((mode: ReadMode) => {
    const entry = taskRef.current;
    if (!entry || entry.key !== key || !contextGraphId) return;
    // Repeated Load more clicks are dropped; refreshes queue one pass behind
    // whichever page read is active. The shared task owns cancellation/drain.
    if (mode === 'append' && entry.task.running) return;
    entry.mode = mode;
    entry.task.request();
  }, [key, contextGraphId]);
  useMemoryGraphEvents(contextGraphId, () => run('refresh'));

  const current = state.key === key;
  const triples = useMemo<LayeredMemoryTriple[]>(() => current ? state.sources.flatMap(source =>
    source.pages.flatMap(page => page.triples.map(triple => ({ ...triple, layer: source.definition.layer })))) : [], [state.sources, current]);
  const status = (layer: TrustLevel): MemoryLayerStatus => {
    const sources = current ? state.sources.filter(source => source.definition.layer === layer) : [];
    if (!sources.length) return contextGraphId ? 'loading' : 'ok';
    return sources.some(source => source.read.kind === 'failed') ? 'error'
      : state.loading ? 'loading' : 'ok';
  };
  const layerStatus = { wm: status('working'), swm: status('shared'), vm: status('verified') };
  const sources = current ? state.sources : [];
  const actions = sources.map(sourceActions);
  const hasMore = actions.some(action => action.canContinue);
  const canRetry = actions.some(action => action.canRetry);
  const incomplete = sources.some(source => (source.read.kind === 'failed' && source.read.reason === 'response-limit')
    || source.pages.some(page => page.omittedRelationships));
  const failed = Object.values(layerStatus).filter(value => value === 'error').length;
  const refresh = useCallback(() => { invalidateQueryCache(contextGraphId); void run('refresh'); }, [contextGraphId, run]);
  const loadMore = useCallback(() => { void run('append'); }, [run]);
  return {
    triples, layerStatus, hasMore, canRetry, loading: !current || state.loading,
    partial: hasMore || incomplete || failed > 0,
    error: failed === 3 ? 'Failed to load memory data' : null,
    pageError: sources.map(pageFailureMessage).find(Boolean) ?? null,
    limitMessage: incomplete ? MEMORY_LIMIT_MESSAGE : null,
    refresh, loadMore,
  };
}
