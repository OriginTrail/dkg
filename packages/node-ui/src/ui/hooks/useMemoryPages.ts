import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CoalescingRecurringTask } from '@origintrail-official/dkg-core/dist/coalescing-recurring-task.js';
import { invalidateQueryCache } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { memoryQueryDefinitions, type MemoryQueryDefinition } from './memory-query-definition.js';
import { MEMORY_LIMIT_MESSAGE, readMemoryGraphPage, type MemoryGraphPage } from './memory-graph-query.js';
import type { LayeredTriple, MemoryLayerStatus, TrustLevel } from './useMemoryEntities.js';

interface MemorySource {
  definition: MemoryQueryDefinition;
  pages: MemoryGraphPage[];
  status: MemoryLayerStatus;
  blocked?: boolean;
  pageError?: string;
}

interface MemoryPages {
  key: string;
  contextGraphId: string;
  sources: MemorySource[];
  loading: boolean;
}

type ReadMode = 'refresh' | 'append';
const RETRY_PAGE = 'Could not load more graph data. Retry to continue from the last loaded page.';
const emptySource = (definition: MemoryQueryDefinition): MemorySource => ({ definition, pages: [], status: 'loading' });
const canContinue = (source: MemorySource) => !source.blocked && !!source.pages.at(-1)?.nextCursor;

/** Refresh and continuation both accept complete pages through this transition. */
function acceptPage(source: MemorySource, result: MemoryGraphPage): MemorySource {
  return { ...source, pages: [...source.pages, result], status: 'ok', pageError: undefined };
}

async function readSource(source: MemorySource, mode: ReadMode, contextGraphId: string, signal: AbortSignal) {
  const depth = mode === 'refresh' ? Math.max(1, source.pages.length) : 1;
  let next: MemorySource = { ...source, pages: mode === 'refresh' ? [] : source.pages,
    status: 'ok', blocked: false, pageError: undefined };
  for (let page = 0; page < depth && !signal.aborted; page++) {
    const previous = next.pages.at(-1);
    if (previous && !previous.nextCursor) break;
    const result = await readMemoryGraphPage(source.definition, contextGraphId, {
      includeContextGraphPartitions: true, cursor: previous?.nextCursor, signal,
    });
    if (!result.ok) {
      return {
        ...next, status: 'error' as const, blocked: result.reason === 'response-limit',
        // Keep a coherent last successful preview if replay fails partway.
        pages: mode === 'refresh' && source.pages.length ? source.pages : next.pages,
        pageError: mode === 'append' ? result.reason === 'response-limit' ? MEMORY_LIMIT_MESSAGE : RETRY_PAGE : undefined,
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
      onError: () => { if (!task.closed) commit({ ...stateRef.current, loading: false }); },
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
  const triples = useMemo<LayeredTriple[]>(() => current ? state.sources.flatMap(source =>
    source.pages.flatMap(page => page.triples.map(triple => ({ ...triple, layer: source.definition.layer })))) : [], [state.sources, current]);
  const status = (layer: TrustLevel): MemoryLayerStatus => {
    const sources = current ? state.sources.filter(source => source.definition.layer === layer) : [];
    if (!sources.length) return contextGraphId ? 'loading' : 'ok';
    return sources.some(source => source.status === 'error') ? 'error'
      : state.loading ? 'loading' : 'ok';
  };
  const layerStatus = { wm: status('working'), swm: status('shared'), vm: status('verified') };
  const sources = current ? state.sources : [];
  const hasMore = sources.some(canContinue);
  const incomplete = sources.some(source => source.blocked || source.pages.some(page => page.omittedRelationships));
  const failed = Object.values(layerStatus).filter(value => value === 'error').length;
  const refresh = useCallback(() => { invalidateQueryCache(contextGraphId); void run('refresh'); }, [contextGraphId, run]);
  const loadMore = useCallback(() => { void run('append'); }, [run]);
  return {
    triples, layerStatus, hasMore, loading: !current || state.loading,
    partial: hasMore || incomplete || failed > 0,
    error: failed === 3 ? 'Failed to load memory data' : null,
    pageError: sources.find(source => source.pageError)?.pageError ?? null,
    limitMessage: incomplete ? MEMORY_LIMIT_MESSAGE : null,
    refresh, loadMore,
  };
}
