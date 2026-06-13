import {
  DKG_ONTOLOGY,
  MemoryLayer,
  assertSafeIri,
  sparqlString,
  validateSubGraphName,
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

export interface GraphListMemo {
  get(options?: { refresh?: boolean }): Promise<readonly string[]>;
}

export interface SubGraphNameMemo {
  get(contextGraphId: string, options?: { refresh?: boolean }): Promise<readonly string[]>;
}

export interface SyncRowListMemo {
  get(
    key: string,
    loadRows: () => Promise<readonly SyncRow[]>,
    options?: { refresh?: boolean; requireExisting?: boolean },
  ): Promise<readonly SyncRow[] | null>;
}

export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  let cached: readonly string[] | null = null;
  let cachedAt = 0;
  let inflight: Promise<readonly string[]> | null = null;
  return {
    async get(options?: { refresh?: boolean }) {
      const now = Date.now();
      if (inflight) return [...(await inflight)];
      if (!options?.refresh && cached && now - cachedAt < ttlMs) return [...cached];
      inflight = store.listGraphs()
        .then((graphs) => {
          const sorted = [...new Set(graphs)].sort(compareCodePoint);
          cached = sorted;
          cachedAt = Date.now();
          return sorted;
        })
        .finally(() => {
          inflight = null;
        });
      return [...(await inflight)];
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
    async get(key, loadRows, options?: { refresh?: boolean; requireExisting?: boolean }) {
      const now = Date.now();
      pruneExpired(now);
      const pending = inflight.get(key);
      if (pending) return [...(await pending)];
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
      return [...(await load)];
    },
  };
}

export function createResponderSwmAdmissionMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo((contextGraphId) => readAdmittedSwmSubGraphNames(store, contextGraphId), ttlMs);
}

export function createResponderSubGraphRegistrationMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo((contextGraphId) => readRegisteredSubGraphNames(store, contextGraphId), ttlMs);
}

function createSubGraphNameMemo(
  loadNames: (contextGraphId: string) => Promise<string[]>,
  ttlMs: number,
): SubGraphNameMemo {
  const cached = new Map<string, { value: readonly string[]; cachedAt: number }>();
  const inflight = new Map<string, Promise<readonly string[]>>();
  return {
    async get(contextGraphId: string, options?: { refresh?: boolean }) {
      const now = Date.now();
      const existing = cached.get(contextGraphId);
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) return [...existing.value];
      const pending = inflight.get(contextGraphId);
      if (pending) return [...(await pending)];
      const load = loadNames(contextGraphId)
        .then((names) => {
          cached.set(contextGraphId, { value: names, cachedAt: Date.now() });
          return names;
        })
        .finally(() => {
          inflight.delete(contextGraphId);
        });
      inflight.set(contextGraphId, load);
      return [...(await load)];
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
}): Promise<SyncRow[]> {
  const graphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, true);
  const graphSet = new Set(params.graphList);
  const candidateGraphs = graphs.filter((graph) => graphSet.has(graph));
  return readSwmMetaRowsPage(
    params.store,
    candidateGraphs,
    params.cutoffIso,
    params.offset,
    params.limit,
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
}): Promise<SyncRow[]> {
  const dataGraphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, false);
  const graphSet = new Set(params.graphList);
  const candidateGraphsFor = (graph: string) => params.graphList
    .filter((candidate) => candidate === graph || isSharedMemoryBucketDescendantDataGraph(candidate, graph))
    .sort(compareCodePoint);

  if (!params.cutoffIso) {
    const candidateGraphs = dedupeStrings(dataGraphs.flatMap(candidateGraphsFor)).sort(compareCodePoint);
    return readPagedRowsAcrossGraphsStoreBounded(params.store, candidateGraphs, params.offset, params.limit, async () => true);
  }

  const rows: SyncRow[] = [];
  let skip = params.offset;
  let remaining = params.limit;
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    for (const candidate of candidateGraphsFor(graph)) {
      if (skip > 0) {
        const count = await countFreshSwmDataGraphRows(params.store, candidate, metaGraph, params.cutoffIso);
        if (skip >= count) {
          skip -= count;
          continue;
        }
      }

      const page = await readFreshSwmDataGraphRowsPage(params.store, candidate, metaGraph, params.cutoffIso, skip, remaining);
      rows.push(...page);
      remaining -= page.length;
      skip = 0;
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }
  return rows;
}

export async function readDurableMetaPage(params: {
  store: TripleStore;
  contextGraphId: string;
  registeredSubGraphNames: readonly string[];
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  return readDurableMetaRowsPage(
    params.store,
    params.contextGraphId,
    params.registeredSubGraphNames,
    params.offset,
    params.limit,
  );
}

export async function readDurableDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  sinceBatchId: bigint | null;
  offset: number;
  limit: number;
  rowListMemo?: SyncRowListMemo;
  rowListCacheScope?: string;
  refreshRowList?: boolean;
}): Promise<SyncRow[]> {
  const cgPrefix = contextGraphDataGraphUri(params.contextGraphId);
  const topMetaGraph = contextGraphMetaGraphUri(params.contextGraphId);
  const candidateGraphs = params.graphList.filter((graph) => {
    if (graph !== cgPrefix && !graph.startsWith(`${cgPrefix}/`)) return false;
    if (graph === topMetaGraph) return false;
    return !graph.includes('/_private');
  }).sort(compareCodePoint);

  let assertionGraphs: Set<string> | null = null;
  const isAdmitted = async (graph: string): Promise<boolean> => {
    if (graph.includes('/assertion/')) {
      assertionGraphs ??= await readAdmittedAssertionGraphs(params.store, params.contextGraphId);
      const assertionGraph = graph.endsWith('/_meta') ? graph.slice(0, -'/_meta'.length) : graph;
      if (!assertionGraphs.has(assertionGraph)) return false;
    }
    return !(await isDescendantOfKnownChildContextGraph(params.store, cgPrefix, graph));
  };

  if (params.sinceBatchId == null) {
    return readPagedRowsAcrossGraphs(
      params.store,
      candidateGraphs,
      params.offset,
      params.limit,
      isAdmitted,
      params.rowListMemo
        ? {
          memo: params.rowListMemo,
          key: durableDataRowListCacheKey(params.rowListCacheScope ?? 'default', params.contextGraphId, params.sinceBatchId),
          refresh: params.refreshRowList,
        }
        : undefined,
    );
  }

  const graphs: string[] = [];
  for (const graph of candidateGraphs) {
    if (await isAdmitted(graph)) graphs.push(graph);
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
  );
}

async function readPagedRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
  cache?: { memo: SyncRowListMemo; key: string; refresh?: boolean },
): Promise<SyncRow[]> {
  if (!cache) {
    return readPagedRowsAcrossGraphsStoreBounded(store, graphs, offset, limit, isAdmitted);
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

  const rows = await cache.memo.get(cache.key, loadRows, {
    refresh: cache.refresh,
    requireExisting: safeOffset > 0,
  });
  if (rows == null) {
    throw new Error('Durable data sync session snapshot expired before page completion');
  }
  return [...rows].slice(safeOffset, safeOffset + safeLimit);
}

async function readPagedRowsAcrossGraphsStoreBounded(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
): Promise<SyncRow[]> {
  const admittedGraphs: string[] = [];
  for (const graph of graphs) {
    if (!(await isAdmitted(graph))) continue;
    admittedGraphs.push(graph);
  }

  return readRowsPageAcrossGraphs(store, admittedGraphs, offset, limit);
}

async function readPagedDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
  cache?: { memo: SyncRowListMemo; key: string; refresh?: boolean },
): Promise<SyncRow[]> {
  if (!cache) {
    return readDurableDeltaRowsPageAcrossGraphs(store, graphs, metaGraphs, sinceBatchId, offset, limit);
  }

  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const rows = await cache.memo.get(
    cache.key,
    () => readDurableDeltaRowsAcrossGraphs(store, graphs, metaGraphs, sinceBatchId),
    {
      refresh: cache.refresh,
      requireExisting: safeOffset > 0,
    },
  );
  if (rows == null) {
    throw new Error('Durable data sync session snapshot expired before page completion');
  }
  return [...rows].slice(safeOffset, safeOffset + safeLimit);
}

async function readAdmittedSwmSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
): Promise<string[]> {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const names: string[] = [];
  for (const name of await readRegisteredSubGraphNames(store, contextGraphId)) {
    const childCgUri = `${cgPrefix}/${name}`;
    if (await isKnownContextGraph(store, childCgUri)) continue;
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
): Promise<string[]> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?sg ?name WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?sg <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_SUB_GRAPH}> ;
            <${SCHEMA_NAME}> ?name .
      }
    }
  `);
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

async function isKnownContextGraph(store: TripleStore, contextGraphUri: string): Promise<boolean> {
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
  `);
  return res.type === 'boolean' && res.value;
}

async function isDescendantOfKnownChildContextGraph(
  store: TripleStore,
  cgPrefix: string,
  graph: string,
): Promise<boolean> {
  if (graph === cgPrefix || !graph.startsWith(`${cgPrefix}/`)) return false;
  const remainder = graph.slice(cgPrefix.length + 1);
  const segments = remainder.split('/').filter(Boolean);
  if (isParentOwnedReservedGraphSegments(segments)) return false;
  if (await isKnownContextGraph(store, graph)) return true;
  if (graph.endsWith('/_meta')) {
    const graphOwner = graph.slice(0, -'/_meta'.length);
    if (await isKnownContextGraph(store, graphOwner)) return true;
  }
  let childUri = cgPrefix;
  for (const segment of segments) {
    childUri = `${childUri}/${segment}`;
    if (await isKnownContextGraph(store, childUri)) return true;
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
  `);
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['g']).filter(Boolean));
}

async function countGraphRows(store: TripleStore, graph: string): Promise<number> {
  const res = await store.query(`
    SELECT (COUNT(*) AS ?count) WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
  `);
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
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readSwmMetaRowsPage(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string | null,
  offset: number,
  limit: number,
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
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function countFreshSwmDataGraphRows(
  store: TripleStore,
  graph: string,
  metaGraph: string,
  cutoffIso: string,
): Promise<number> {
  const res = await store.query(`
    SELECT (COUNT(*) AS ?count) WHERE {
      {
        SELECT DISTINCT ?s ?p ?o WHERE {
          ${freshSwmDataWhereClause(graph, metaGraph, cutoffIso)}
        }
      }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readFreshSwmDataGraphRowsPage(
  store: TripleStore,
  graph: string,
  metaGraph: string,
  cutoffIso: string,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const res = await store.query(`
    SELECT DISTINCT ?s ?p ?o WHERE {
      ${freshSwmDataWhereClause(graph, metaGraph, cutoffIso)}
    }
    ORDER BY ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: graph }))
    .filter((row) => row.s && row.p && row.o);
}

function freshSwmDataWhereClause(graph: string, metaGraph: string, cutoffIso: string): string {
  return `
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_PUBLISHED_AT}> ?ts ;
            <${DKG_ROOT_ENTITY}> ?root .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
      FILTER(sameTerm(?s, ?root) || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
  `;
}

async function readDurableMetaRowsPage(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const registeredSubGraphSubjects = dedupeStrings(registeredSubGraphNames)
    .filter((name) => validateSubGraphName(name).valid)
    .map((name) => `<${assertSafeIri(`${cgEntity}/${name}`)}>`);
  const registeredSubGraphSubjectClause = registeredSubGraphSubjects.length === 0
    ? ''
    : `${registeredSubGraphSubjects.length === 1
      ? `sameTerm(?s, ${registeredSubGraphSubjects[0]})`
      : `?s IN (${registeredSubGraphSubjects.join(', ')})`} ||`;
  const workingMemory = sparqlString(MemoryLayer.WorkingMemory);
  const res = await store.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> { ?s ?p ?o }
      FILTER(
        STR(?s) = ${sparqlString(cgEntity)} ||
        ${registeredSubGraphSubjectClause}
        STRSTARTS(STR(?s), "did:dkg:activity:") ||
        STRSTARTS(STR(?s), "did:dkg:join-request:") ||
        EXISTS {
          GRAPH <${assertSafeIri(metaGraph)}> {
            ?lc <${DKG_MEMORY_LAYER}> ?layer .
            FILTER(STR(?layer) != ${workingMemory})
            {
              FILTER(sameTerm(?lc, ?s))
            } UNION {
              ?lc <${DKG_ASSERTION_GRAPH}> ?s .
            } UNION {
              ?lc <${DKG_ASSERTION_NAME}> ?aname .
              FILTER(
                CONTAINS(STR(?s), "/assertion/") &&
                STRENDS(STR(?s), CONCAT("/", STR(?aname)))
              )
            }
          }
        } ||
        EXISTS {
          GRAPH <${assertSafeIri(metaGraph)}> {
            { ?evt <http://www.w3.org/ns/prov#generated> ?parent }
            UNION
            { ?evt <http://www.w3.org/ns/prov#used> ?parent }
            FILTER(sameTerm(?evt, ?s))
            ?parent <${DKG_MEMORY_LAYER}> ?eventLayer .
            FILTER(STR(?eventLayer) != ${workingMemory})
          }
        }
      )
    }
    ORDER BY ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: metaGraph }))
    .filter((row) => row.s && row.p && row.o);
}

async function readDurableDeltaRowsPageAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
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
  `);
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
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?g ?s ?p ?o WHERE {
      ${durableDeltaWhereClauseForGraphs(values, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId, true)}
  `);
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

function parseIntegerLiteral(value: string | undefined): bigint | null {
  const stripped = stripLiteral(value);
  if (!/^-?\d+$/.test(stripped)) return null;
  try {
    return BigInt(stripped);
  } catch {
    return null;
  }
}

function formatTerm(term: string): string {
  if (term.startsWith('"') || term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${assertSafeIri(term)}>`;
}
