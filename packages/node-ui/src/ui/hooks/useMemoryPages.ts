import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invalidateQueryCache } from '../api.js';
import { useMemoryGraphEvents } from './useNodeEvents.js';
import { memoryQueryDefinitions, type MemoryQueryDefinition } from './memory-query-definition.js';
import { MEMORY_LIMIT_MESSAGE, readMemoryGraphPage, type LayerResult } from './memory-graph-query.js';
import type { LayeredTriple, MemoryLayerStatus, TrustLevel } from './useMemoryEntities.js';

interface MemorySource {
  definition: MemoryQueryDefinition;
  pages: LayerResult[];
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
const canContinue = (source: MemorySource) => !source.blocked && !!source.pages.at(-1)?.truncated;

/** Refresh and continuation both accept complete pages through this transition. */
function acceptPage(source: MemorySource, result: LayerResult): MemorySource {
  return { ...source, pages: [...source.pages, result], status: 'ok', pageError: undefined };
}

async function readSource(source: MemorySource, mode: ReadMode, contextGraphId: string, isCurrent: () => boolean) {
  const depth = mode === 'refresh' ? Math.max(1, source.pages.length) : 1;
  let next: MemorySource = { ...source, pages: mode === 'refresh' ? [] : source.pages,
    status: 'ok', blocked: false, pageError: undefined };
  for (let page = 0; page < depth && isCurrent(); page++) {
    const previous = next.pages.at(-1);
    if (previous && !previous.truncated) break;
    const result = await readMemoryGraphPage(source.definition, contextGraphId, {
      includeContextGraphPartitions: true, cursor: previous?.cursor, isCurrent,
    });
    if (!result.ok) {
      return {
        ...next, status: 'error' as const, blocked: result.incomplete,
        // Keep a coherent last successful preview if replay fails partway.
        pages: mode === 'refresh' && source.pages.length ? source.pages : next.pages,
        pageError: mode === 'append' ? result.incomplete ? MEMORY_LIMIT_MESSAGE : RETRY_PAGE : undefined,
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
  const activeRef = useRef(false);
  const versionRef = useRef(0);
  const requestRef = useRef<{ key: string; promise: Promise<void>; again: boolean } | null>(null);

  const commit = useCallback((next: MemoryPages) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const run = useCallback((mode: ReadMode): Promise<void> => {
    if (!contextGraphId) return Promise.resolve();
    const running = requestRef.current;
    if (running?.key === key) {
      if (mode === 'refresh') running.again = true;
      return running.promise;
    }
    const previous = stateRef.current;
    const sources = definitions.map(definition => previous.contextGraphId === contextGraphId
      ? previous.sources.find(source => source.definition.key === definition.key) ?? emptySource(definition)
      : emptySource(definition));
    if (mode === 'append' && !sources.some(canContinue)) return Promise.resolve();
    const version = ++versionRef.current;
    const isCurrent = () => activeRef.current && version === versionRef.current;
    const entry = { key, promise: Promise.resolve(), again: false };
    commit({ key, contextGraphId, sources, loading: true });
    entry.promise = (async () => {
      const results = await Promise.all(sources.map(source => mode === 'append' && !canContinue(source)
        ? source : readSource(source, mode, contextGraphId, isCurrent)));
      if (isCurrent()) commit({ key, contextGraphId, sources: results, loading: false });
    })().finally(() => {
      if (isCurrent() && stateRef.current.loading) commit({ ...stateRef.current, loading: false });
      if (requestRef.current !== entry) return;
      requestRef.current = null;
      if (entry.again && isCurrent()) void run('refresh');
    });
    requestRef.current = entry;
    return entry.promise;
  }, [contextGraphId, definitions, key, commit]);

  useMemoryGraphEvents(contextGraphId, () => { void run('refresh'); });
  useEffect(() => {
    activeRef.current = true;
    if (contextGraphId) void run('refresh');
    else commit({ key, contextGraphId, sources: [], loading: false });
    return () => {
      activeRef.current = false;
      versionRef.current++;
      requestRef.current = null;
    };
  }, [run, contextGraphId, key, commit]);

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
  const incomplete = sources.some(source => source.blocked || source.pages.some(page => page.incomplete));
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
