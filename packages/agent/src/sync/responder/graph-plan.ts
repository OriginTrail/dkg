import {
  DKG_ONTOLOGY,
  MemoryLayer,
  assertSafeIri,
  sparqlString,
  validateSubGraphName,
  contextGraphCatalogUri,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { isSharedMemoryBucketDescendantDataGraph } from '../shared-memory-graphs.js';

export type SyncRow = { s: string; p: string; o: string; g: string };

const DKG = 'http://dkg.io/ontology/';
const DKG_SUB_GRAPH = `${DKG}SubGraph`;
const DKG_WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
const DKG_PUBLISHED_AT = `${DKG}publishedAt`;
const DKG_ROOT_ENTITY = `${DKG}rootEntity`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_ASSERTION_NAME = `${DKG}assertionName`;
const DKG_MEMORY_LAYER = `${DKG}memoryLayer`;
const DKG_PART_OF = `${DKG}partOf`;
const DKG_BATCH_ID = `${DKG}batchId`;
const SCHEMA_NAME = 'http://schema.org/name';
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated';
const PROV_USED = 'http://www.w3.org/ns/prov#used';

export interface GraphListMemo {
  get(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<readonly string[]>;
}

export interface SubGraphNameMemo {
  get(contextGraphId: string, options?: { refresh?: boolean; signal?: AbortSignal }): Promise<readonly string[]>;
}

export interface SyncRowListMemo {
  get(
    key: string,
    loadRows: () => Promise<readonly SyncRow[]>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<readonly SyncRow[] | null>;
}

interface RowListCache {
  memo: SyncRowListMemo;
  key: string;
  refresh?: boolean;
  expiredMessage?: string;
}

export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  let cached: readonly string[] | null = null;
  let cachedAt = 0;
  let inflight: Promise<readonly string[]> | null = null;
  return {
    async get(options?: { refresh?: boolean; signal?: AbortSignal }) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      if (inflight) return [...(await raceAgainstAbort(inflight, options?.signal))];
      if (!options?.refresh && cached && now - cachedAt < ttlMs) return [...cached];
      const load = store.listGraphs()
        .then((graphs) => {
          const sorted = [...new Set(graphs)].sort(compareCodePoint);
          cached = sorted;
          cachedAt = Date.now();
          return sorted;
        })
        .finally(() => {
          inflight = null;
        });
      inflight = load;
      const graphs = await load;
      throwIfAborted(options?.signal);
      return [...graphs];
    },
  };
}

export function createResponderSyncRowListMemo(
  ttlMs = 120_000,
  maxEntries = 32,
): SyncRowListMemo {
  const cached = new Map<string, {
    value: readonly SyncRow[];
    cachedAt: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
  }>();
  const expired = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, Promise<readonly SyncRow[]>>();

  const deleteCached = (key: string) => {
    const existing = cached.get(key);
    if (existing) clearTimeout(existing.cleanupTimer);
    cached.delete(key);
  };

  const deleteExpired = (key: string) => {
    const timer = expired.get(key);
    if (timer) clearTimeout(timer);
    expired.delete(key);
  };

  const markExpired = (key: string) => {
    deleteCached(key);
    deleteExpired(key);
    const timer = setTimeout(() => {
      expired.delete(key);
    }, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    expired.set(key, timer);
  };

  const pruneExpired = (now = Date.now()) => {
    for (const [key, entry] of cached) {
      if (now - entry.cachedAt >= ttlMs) markExpired(key);
    }
  };

  const scheduleCleanup = (key: string, cachedAt: number) => {
    const timer = setTimeout(() => {
      const existing = cached.get(key);
      if (existing?.cachedAt === cachedAt) cached.delete(key);
    }, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  const storeCached = (key: string, value: readonly SyncRow[]) => {
    const now = Date.now();
    pruneExpired(now);
    deleteExpired(key);
    if (value.length === 0) return;
    const replacingExisting = cached.has(key);
    if (!replacingExisting && cached.size >= maxEntries) {
      throw new Error('Too many active durable data sync session snapshots');
    }
    deleteCached(key);
    cached.set(key, {
      value,
      cachedAt: now,
      cleanupTimer: scheduleCleanup(key, now),
    });
  };

  return {
    async get(key, loadRows, options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal }) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      pruneExpired(now);
      const pending = inflight.get(key);
      if (pending) return [...(await raceAgainstAbort(pending, options?.signal))];
      if (expired.has(key)) {
        if (options?.refresh) {
          deleteExpired(key);
        } else {
          throw new Error('Durable data sync session snapshot expired before page completion');
        }
      }

      const existing = cached.get(key);
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) {
        const refreshed = {
          value: existing.value,
          cachedAt: now,
          cleanupTimer: scheduleCleanup(key, now),
        };
        deleteCached(key);
        cached.set(key, refreshed);
        return [...existing.value];
      }
      if (options?.requireExisting) return null;
      if (!cached.has(key) && cached.size + inflight.size >= maxEntries) {
        throw new Error('Too many active durable data sync session snapshots');
      }

      const load = loadRows()
        .then((rows) => {
          const value = [...rows];
          storeCached(key, value);
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === load) inflight.delete(key);
        });
      inflight.set(key, load);
      const rows = await load;
      throwIfAborted(options?.signal);
      return [...rows];
    },
  };
}

export function createResponderSwmAdmissionMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo(
    (contextGraphId) => readAdmittedSwmSubGraphNames(store, contextGraphId),
    ttlMs,
  );
}

export function createResponderSubGraphRegistrationMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo(
    (contextGraphId) => readRegisteredSubGraphNames(store, contextGraphId),
    ttlMs,
  );
}

function createSubGraphNameMemo(
  loadNames: (contextGraphId: string) => Promise<string[]>,
  ttlMs: number,
): SubGraphNameMemo {
  const cached = new Map<string, { value: readonly string[]; cachedAt: number }>();
  const inflight = new Map<string, Promise<readonly string[]>>();
  return {
    async get(contextGraphId: string, options?: { refresh?: boolean; signal?: AbortSignal }) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      const existing = cached.get(contextGraphId);
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) return [...existing.value];
      const pending = inflight.get(contextGraphId);
      if (pending) return [...(await raceAgainstAbort(pending, options?.signal))];
      const load = loadNames(contextGraphId)
        .then((names) => {
          cached.set(contextGraphId, { value: names, cachedAt: Date.now() });
          return names;
        })
        .finally(() => {
          inflight.delete(contextGraphId);
        });
      inflight.set(contextGraphId, load);
      const names = await load;
      throwIfAborted(options?.signal);
      return [...names];
    },
  };
}

export function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function compareRows(a: SyncRow, b: SyncRow): number {
  return (
    compareCodePoint(a.g, b.g) ||
    compareCodePoint(a.s, b.s) ||
    compareCodePoint(a.p, b.p) ||
    compareCodePoint(a.o, b.o)
  );
}

export function serializeResponderRows(rows: readonly SyncRow[]): string {
  return rows.map((row) =>
    `${formatTerm(row.s)} <${assertSafeIri(row.p)}> ${formatTerm(row.o)} <${assertSafeIri(row.g)}> .`,
  ).join('\n');
}

export async function readSwmMetaPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  registeredSubGraphNames: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
}): Promise<SyncRow[]> {
  const graphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, true);
  const graphSet = new Set(params.graphList);
  const candidateGraphs = graphs.filter((graph) => graphSet.has(graph));
  if (params.rowListMemo && params.rowListCacheKey) {
    return readCachedRowsPage(
      {
        memo: params.rowListMemo,
        key: params.rowListCacheKey,
        refresh: params.refreshRowList,
        expiredMessage: 'Shared-memory meta sync session snapshot expired before page completion',
      },
      () => readSwmMetaRows(params.store, candidateGraphs, params.cutoffIso),
      params.offset,
      params.limit,
      params.signal,
    );
  }
  return readSwmMetaRowsPage(
    params.store,
    candidateGraphs,
    params.cutoffIso,
    params.offset,
    params.limit,
    params.signal,
  );
}

export async function readSwmDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  registeredSubGraphNames: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
}): Promise<SyncRow[]> {
  const dataGraphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, false);
  const graphSet = new Set(params.graphList);
  const candidateGraphsFor = (graph: string) => params.graphList
    .filter((candidate) => candidate === graph || isSharedMemoryBucketDescendantDataGraph(candidate, graph))
    .sort(compareCodePoint);
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      expiredMessage: 'Shared-memory data sync session snapshot expired before page completion',
    }
    : undefined;

  if (!params.cutoffIso) {
    const candidateGraphs = dedupeStrings(dataGraphs.flatMap(candidateGraphsFor)).sort(compareCodePoint);
    return readPagedRowsAcrossGraphs(
      params.store,
      candidateGraphs,
      params.offset,
      params.limit,
      async () => true,
      cache,
      params.signal,
    );
  }

  const loadRows = (signal?: AbortSignal) => readFreshSwmDataRows(
    params.store,
    dataGraphs,
    graphSet,
    candidateGraphsFor,
    params.cutoffIso!,
    signal,
  );
  if (cache) {
    return readCachedRowsPage(cache, () => loadRows(), params.offset, params.limit, params.signal);
  }
  const rows = await loadRows(params.signal);
  return rows.slice(Math.max(0, Math.floor(params.offset)), Math.max(0, Math.floor(params.offset)) + Math.max(0, Math.floor(params.limit)));
}

export async function readDurableMetaPage(params: {
  store: TripleStore;
  contextGraphId: string;
  registeredSubGraphNames: readonly string[];
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
}): Promise<SyncRow[]> {
  const loadRows = (signal?: AbortSignal) =>
    readDurableMetaRows(params.store, params.contextGraphId, params.registeredSubGraphNames, signal);
  if (params.rowListMemo && params.rowListCacheKey) {
    return readCachedRowsPage(
      {
        memo: params.rowListMemo,
        key: params.rowListCacheKey,
        refresh: params.refreshRowList,
        expiredMessage: 'Durable meta sync session snapshot expired before page completion',
      },
      () => loadRows(),
      params.offset,
      params.limit,
      params.signal,
    );
  }
  const rows = await loadRows(params.signal);
  const safeOffset = Math.max(0, Math.floor(params.offset));
  const safeLimit = Math.max(0, Math.floor(params.limit));
  return rows.slice(safeOffset, safeOffset + safeLimit);
}

export async function readDurableDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  sinceBatchId: bigint | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheScope?: string;
  refreshRowList?: boolean;
}): Promise<SyncRow[]> {
  const cgPrefix = contextGraphDataGraphUri(params.contextGraphId);
  const topMetaGraph = contextGraphMetaGraphUri(params.contextGraphId);
  const candidateGraphs = params.graphList.filter((graph) => {
    if (graph !== cgPrefix && !graph.startsWith(`${cgPrefix}/`)) return false;
    if (graph === topMetaGraph) return false;
    // Shared-memory graphs (`/_shared_memory`, `/_shared_memory_meta`, including
    // per-sub-graph buckets) are the EXCLUSIVE domain of the dedicated SWM phase
    // (readSwmDataPage), which applies per-(graph,subject) REPLACE + the
    // curator-skip. Serving them in the durable DATA phase makes the requester
    // blind-UNION them, which (a) corrupts single-valued SWM into {v1,v2}, and
    // (b) lets a curator reverse-sync its OWN CG's SWM from a member, polluting
    // itself (devnet curator-converge Gate A) — and it leaks gated SWM to durable
    // requesters. SWM is never served through the durable data phase.
    if (graph.includes('/_shared_memory')) return false;
    return !graph.includes('/_private');
  }).sort(compareCodePoint);

  let assertionGraphs: Set<string> | null = null;
  const isAdmitted = (signal?: AbortSignal) => async (graph: string): Promise<boolean> => {
    if (graph.includes('/assertion/')) {
      assertionGraphs ??= await readAdmittedAssertionGraphs(params.store, params.contextGraphId, signal);
      const assertionGraph = graph.endsWith('/_meta') ? graph.slice(0, -'/_meta'.length) : graph;
      if (!assertionGraphs.has(assertionGraph)) return false;
    }
    return !(await isDescendantOfKnownChildContextGraph(params.store, cgPrefix, graph, signal));
  };

  if (params.sinceBatchId == null) {
    return readPagedRowsAcrossGraphs(
      params.store,
      candidateGraphs,
      params.offset,
      params.limit,
      isAdmitted(params.rowListMemo ? undefined : params.signal),
      params.rowListMemo
        ? {
          memo: params.rowListMemo,
          key: durableDataRowListCacheKey(params.rowListCacheScope ?? 'default', params.contextGraphId, params.sinceBatchId),
          refresh: params.refreshRowList,
        }
        : undefined,
      params.signal,
    );
  }

  const graphs: string[] = [];
  const isAdmittedForRequest = isAdmitted(params.signal);
  for (const graph of candidateGraphs) {
    if (await isAdmittedForRequest(graph)) graphs.push(graph);
  }

  const metaGraphs = [
    topMetaGraph,
    ...graphs.filter((graph) =>
      graph.startsWith(`${cgPrefix}/`) && graph.endsWith('/_meta'),
    ),
  ];
  return readPagedDurableDeltaRowsAcrossGraphs(
    params.store,
    graphs,
    metaGraphs,
    params.sinceBatchId,
    params.offset,
    params.limit,
    params.rowListMemo
      ? {
        memo: params.rowListMemo,
        key: durableDataRowListCacheKey(params.rowListCacheScope ?? 'default', params.contextGraphId, params.sinceBatchId),
        refresh: params.refreshRowList,
      }
      : undefined,
    params.signal,
  );
}

/**
 * read the public catalog facet. STRICTLY bounded to exactly the
 * `_catalog` named graph (`did:dkg:context-graph:{cg}/_catalog`): it reads that
 * one graph and nothing else, so the open-serve path cannot leak any gated
 * quad. This is the only graph the §7 facet open-serve releases without auth.
 */
export async function readCatalogPage(params: {
  store: TripleStore;
  contextGraphId: string;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const catalogGraph = contextGraphCatalogUri(params.contextGraphId);
  return readPagedRowsAcrossGraphs(
    params.store,
    [catalogGraph],
    params.offset,
    params.limit,
    async () => true, // the single graph is already the bound; admit it
  );
}

async function readPagedRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
  cache?: RowListCache,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  if (!cache) {
    return readPagedRowsAcrossGraphsStoreBounded(store, graphs, offset, limit, isAdmitted, signal);
  }

  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const loadRows = async (): Promise<SyncRow[]> => {
    const admittedGraphs: string[] = [];
    for (const graph of graphs) {
      if (!(await isAdmitted(graph))) continue;
      admittedGraphs.push(graph);
    }
    return readRowsAcrossGraphs(store, admittedGraphs);
  };

  return readCachedRowsPage(
    {
      ...cache,
      expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion',
    },
    loadRows,
    safeOffset,
    safeLimit,
    signal,
  );
}

async function readPagedRowsAcrossGraphsStoreBounded(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const admittedGraphs: string[] = [];
  for (const graph of graphs) {
    if (!(await isAdmitted(graph))) continue;
    admittedGraphs.push(graph);
  }

  return readRowsPageAcrossGraphs(store, admittedGraphs, offset, limit, signal);
}

async function readPagedDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
  cache?: RowListCache,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  if (!cache) {
    return readDurableDeltaRowsPageAcrossGraphs(store, graphs, metaGraphs, sinceBatchId, offset, limit, signal);
  }

  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  return readCachedRowsPage(
    {
      ...cache,
      expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion',
    },
    () => readDurableDeltaRowsAcrossGraphs(store, graphs, metaGraphs, sinceBatchId),
    safeOffset,
    safeLimit,
    signal,
  );
}

async function readCachedRowsPage(
  cache: RowListCache,
  loadRows: () => Promise<readonly SyncRow[]>,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const rows = await cache.memo.get(cache.key, loadRows, {
    refresh: cache.refresh,
    requireExisting: safeOffset > 0,
    signal,
  });
  if (rows == null) {
    throw new Error(cache.expiredMessage ?? 'Sync session snapshot expired before page completion');
  }
  return [...rows].slice(safeOffset, safeOffset + safeLimit);
}

function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function readAdmittedSwmSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const names: string[] = [];
  for (const name of await readRegisteredSubGraphNames(store, contextGraphId, signal)) {
    const childCgUri = `${cgPrefix}/${name}`;
    if (await isKnownContextGraph(store, childCgUri, signal)) continue;
    names.push(name);
  }
  return names.sort(compareCodePoint);
}

function swmGraphsForRegisteredSubGraphs(
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  meta: boolean,
): string[] {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const suffix = meta ? '/_shared_memory_meta' : '/_shared_memory';
  return [
    `${cgPrefix}${suffix}`,
    ...dedupeStrings(registeredSubGraphNames)
      .filter((name) => validateSubGraphName(name).valid)
      .map((name) => `${cgPrefix}/${name}${suffix}`),
  ].sort(compareCodePoint);
}

async function readRegisteredSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?sg ?name WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?sg <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_SUB_GRAPH}> ;
            <${SCHEMA_NAME}> ?name .
      }
    }
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ subject: row['sg'], name: stripLiteral(row['name']) }))
    .filter(({ subject, name }) =>
      name &&
      validateSubGraphName(name).valid &&
      subject === `${contextGraphDataGraphUri(contextGraphId)}/${name}`,
    )
    .map(({ name }) => name)
    .sort(compareCodePoint);
}

async function isKnownContextGraph(
  store: TripleStore,
  contextGraphUri: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const metaGraph = `${contextGraphUri}/_meta`;
  const res = await store.query(`
    ASK {
      GRAPH <${assertSafeIri(metaGraph)}> {
        {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        } UNION {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
        }
      }
    }
  `, { signal });
  return res.type === 'boolean' && res.value;
}

async function isDescendantOfKnownChildContextGraph(
  store: TripleStore,
  cgPrefix: string,
  graph: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (graph === cgPrefix || !graph.startsWith(`${cgPrefix}/`)) return false;
  const remainder = graph.slice(cgPrefix.length + 1);
  const segments = remainder.split('/').filter(Boolean);
  if (isParentOwnedReservedGraphSegments(segments)) return false;
  if (await isKnownContextGraph(store, graph, signal)) return true;
  if (graph.endsWith('/_meta')) {
    const graphOwner = graph.slice(0, -'/_meta'.length);
    if (await isKnownContextGraph(store, graphOwner, signal)) return true;
  }
  let childUri = cgPrefix;
  for (const segment of segments) {
    childUri = `${childUri}/${segment}`;
    if (await isKnownContextGraph(store, childUri, signal)) return true;
  }
  return false;
}

function isParentOwnedReservedGraphSegments(segments: readonly string[]): boolean {
  return isDurableContextPartitionGraphSegments(segments) || isAssertionGraphSegments(segments);
}

function isDurableContextPartitionGraphSegments(segments: readonly string[]): boolean {
  return segments[0] === 'context' && (
    (segments.length === 2 && /^[0-9]+$/.test(segments[1])) ||
    (segments.length === 3 && /^[0-9]+$/.test(segments[1]) && segments[2] === '_meta')
  );
}

function isAssertionGraphSegments(segments: readonly string[]): boolean {
  if (segments.length !== 3 && !(segments.length === 4 && segments[3] === '_meta')) {
    return false;
  }
  return (
    segments[0] === 'assertion' &&
    segments[1].startsWith('0x') &&
    segments[1].length > 2 &&
    segments[2].length > 0
  );
}

async function readAdmittedAssertionGraphs(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?g WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?lifecycle <${DKG_ASSERTION_GRAPH}> ?g ;
                   <${DKG_MEMORY_LAYER}> ?layer .
        FILTER(?layer != ${sparqlString(MemoryLayer.WorkingMemory)})
      }
    }
  `, { signal });
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['g']).filter(Boolean));
}

async function readRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

async function readRowsPageAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  const values = graphValues(graphs);
  if (safeLimit === 0 || !values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readSwmMetaRows(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string | null,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const swmMetaValues = graphValues(swmMetaGraphs);
  if (!swmMetaValues) return [];
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${swmMetaValues} }
      GRAPH ?g {
        ?s ?p ?o .
        ${cutoffIso
    ? `
        ?s <${DKG_PUBLISHED_AT}> ?ts .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`
    : ''}
      }
    }
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

async function readSwmMetaRowsPage(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string | null,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const swmMetaValues = graphValues(swmMetaGraphs);
  const swmMetaClause = swmMetaValues
    ? `
        VALUES ?g { ${swmMetaValues} }
        GRAPH ?g {
          ?s ?p ?o .
          ${cutoffIso
            ? `
          ?s <${DKG_PUBLISHED_AT}> ?ts .
          FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`
            : ''}
        }
      `
    : '';
  if (!swmMetaClause) return [];
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      ${swmMetaClause}
    }
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readFreshSwmDataRows(
  store: TripleStore,
  dataGraphs: readonly string[],
  graphSet: ReadonlySet<string>,
  candidateGraphsFor: (graph: string) => string[],
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const rows: SyncRow[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    const roots = await readFreshSwmRoots(store, metaGraph, cutoffIso, signal);
    if (roots.size === 0) continue;
    const rootPrefixes = [...roots].map((root) => `${root}/.well-known/genid/`);
    const graphRows = await readRowsAcrossGraphs(store, candidateGraphsFor(graph), signal);
    rows.push(...graphRows.filter((row) =>
      roots.has(row.s) || rootPrefixes.some((prefix) => row.s.startsWith(prefix)),
    ));
  }
  return rows.sort(compareRows);
}

async function readFreshSwmRoots(
  store: TripleStore,
  metaGraph: string,
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const res = await store.query(`
    SELECT DISTINCT ?root WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_PUBLISHED_AT}> ?ts ;
            <${DKG_ROOT_ENTITY}> ?root .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `, { signal });
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['root']).filter(Boolean));
}

async function readDurableMetaRows(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const registeredSubGraphSubjects = new Set(dedupeStrings(registeredSubGraphNames)
    .filter((name) => validateSubGraphName(name).valid)
    .map((name) => `${cgEntity}/${name}`));
  const rows = await readRowsAcrossGraphs(store, [metaGraph], signal);
  const nonWorkingLifecycles = new Set<string>();
  for (const row of rows) {
    if (row.p === DKG_MEMORY_LAYER && stripLiteral(row.o) !== MemoryLayer.WorkingMemory) {
      nonWorkingLifecycles.add(row.s);
    }
  }

  const assertionGraphs = new Set<string>();
  const assertionNames = new Set<string>();
  const eventSubjects = new Set<string>();
  for (const row of rows) {
    if (nonWorkingLifecycles.has(row.s) && row.p === DKG_ASSERTION_GRAPH) {
      assertionGraphs.add(row.o);
    }
    if (nonWorkingLifecycles.has(row.s) && row.p === DKG_ASSERTION_NAME) {
      const name = stripLiteral(row.o);
      if (name) assertionNames.add(name);
    }
    if ((row.p === PROV_GENERATED || row.p === PROV_USED) && nonWorkingLifecycles.has(row.o)) {
      eventSubjects.add(row.s);
    }
  }

  return rows.filter((row) =>
    row.s === cgEntity ||
    registeredSubGraphSubjects.has(row.s) ||
    row.s.startsWith('did:dkg:activity:') ||
    row.s.startsWith('did:dkg:join-request:') ||
    nonWorkingLifecycles.has(row.s) ||
    assertionGraphs.has(row.s) ||
    eventSubjects.has(row.s) ||
    (
      row.s.includes('/assertion/') &&
      [...assertionNames].some((name) => row.s.endsWith(`/${name}`))
    ),
  );
}

async function readDurableDeltaRowsPageAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  const values = graphValues(graphs);
  if (safeLimit === 0 || !values) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?g ?s ?p ?o WHERE {
      ${durableDeltaWhereClauseForGraphs(values, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId, true)}
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?g ?s ?p ?o WHERE {
      ${durableDeltaWhereClauseForGraphs(values, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId, true)}
  `, { signal });
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

function durableDeltaWhereClauseForGraphs(
  graphValuesClause: string,
  metaGraphs: readonly string[],
): string {
  const values = metaGraphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
  if (!values) {
    return `
      VALUES ?g { ${graphValuesClause} }
      GRAPH ?g { ?s ?p ?o }
    `;
  }
  return `
      VALUES ?g { ${graphValuesClause} }
      GRAPH ?g { ?s ?p ?o }
      OPTIONAL {
        {
          SELECT ?deltaRoot ?deltaBid WHERE {
            VALUES ?deltaMg { ${values} }
            GRAPH ?deltaMg {
              {
                ?deltaKa <${DKG_PART_OF}> ?deltaUal ;
                         <${DKG_ROOT_ENTITY}> ?deltaRoot .
                { ?deltaUal <${DKG_BATCH_ID}> ?deltaBid }
                UNION
                { ?deltaKa <${DKG_BATCH_ID}> ?deltaBid }
              }
              UNION
              {
                ?deltaKa <${DKG_ROOT_ENTITY}> ?deltaRoot ;
                         <${DKG_BATCH_ID}> ?deltaBid .
              }
              FILTER(REGEX(STR(?deltaBid), "^-?\\\\d+$"))
            }
          }
        }
        FILTER(sameTerm(?s, ?deltaRoot) || STRSTARTS(STR(?s), CONCAT(STR(?deltaRoot), "/.well-known/genid/")))
        BIND(xsd:integer(STR(?deltaBid)) AS ?deltaBatch)
      }
    `;
}

function durableDeltaGroupClause(
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  includeGraph: boolean = false,
): string {
  if (metaGraphs.length === 0) return '';
  return `
    GROUP BY ${includeGraph ? '?g ' : ''}?s ?p ?o
    HAVING(COUNT(?deltaBatch) = 0 || MAX(?deltaBatch) > ${sinceBatchId.toString()})
  `;
}

function graphValues(graphs: readonly string[]): string {
  return dedupeStrings(graphs).map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
}

function durableDataRowListCacheKey(scope: string, contextGraphId: string, sinceBatchId: bigint | null): string {
  return `durable-data:${scope}:${contextGraphId}:${sinceBatchId == null ? 'full' : `since:${sinceBatchId.toString()}`}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function contextGraphDataGraphUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}`;
}

function contextGraphMetaGraphUri(contextGraphId: string): string {
  return `${contextGraphDataGraphUri(contextGraphId)}/_meta`;
}

function stripLiteral(value: string | undefined): string {
  if (!value) return '';
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
}

function formatTerm(term: string): string {
  if (term.startsWith('"') || term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${assertSafeIri(term)}>`;
}
