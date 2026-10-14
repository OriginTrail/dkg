import type { GetView } from '@origintrail-official/dkg-core';
import { classifySparqlOperation } from '@origintrail-official/dkg-core/dist/sparql-operation.js';
import type { PublicQueryQuad, PublicQueryResponse, PublicQueryResult } from '@origintrail-official/dkg-core/query-result';
import { BASE, authHeaders, HttpError, fetchWithTimeout, getWithTimeout } from './http.js';
import { ReadCache, UI_READ_MAX_AGE_MS } from './lib/read-cache.js';

const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60_000;

// Concurrent identical requests share one fetch. Ordinary query execution
// remains fresh; inventory callers may explicitly reuse bounded cached reads.
export type QueryExecutionResult = PublicQueryResult;
export type QueryExecutionResponse = PublicQueryResponse;

export function normalizeQueryExecutionResponse(
  response: unknown,
  sparql: string,
): QueryExecutionResponse {
  const envelope = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown>
    : {};
  const candidate = envelope.result ?? envelope.results;
  const raw = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};

  if (raw.type === 'boolean' && typeof raw.value === 'boolean') {
    return { result: { type: 'boolean', value: raw.value } };
  }
  if (raw.type === 'quads' && Array.isArray(raw.quads)) {
    return { result: { type: 'quads', quads: raw.quads as PublicQueryQuad[] } };
  }
  if (raw.type === 'bindings' && Array.isArray(raw.bindings)) {
    return { result: { type: 'bindings', bindings: raw.bindings as Array<Record<string, unknown>> } };
  }

  const operation = classifySparqlOperation(sparql);
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings as Array<Record<string, unknown>>
    : [];
  if (operation.kind === 'read' && operation.form === 'ASK') {
    const term = bindings[0]?.result;
    const value = term && typeof term === 'object' && !Array.isArray(term)
      ? (term as { value?: unknown }).value
      : term;
    return { result: { type: 'boolean', value: String(value).toLowerCase() === 'true' } };
  }
  if (operation.kind === 'read' && (operation.form === 'CONSTRUCT' || operation.form === 'DESCRIBE')) {
    return {
      result: {
        type: 'quads',
        quads: Array.isArray(raw.quads) ? raw.quads as PublicQueryQuad[] : [],
      },
    };
  }
  return { result: { type: 'bindings', bindings } };
}

const inflightQuery = new Map<string, Promise<QueryExecutionResponse>>();
const graphListCache = new ReadCache<{ contextGraphs: any[] }>(2 * 1024 * 1024, 1);
let graphListGeneration = 0;
let graphListRequest: { key: string; promise: Promise<{ contextGraphs: any[] }> } | null = null;
const queryReadCache = new ReadCache<QueryExecutionResponse>();
const queryGenerations = new Map<string, number>();
let querySession = '';
let queryGeneration = 0;

export function invalidateQueryCache(contextGraphId?: string): void {
  graphListCache.invalidate();
  graphListGeneration++;
  queryReadCache.invalidate(contextGraphId);
  if (contextGraphId) {
    if (!queryGenerations.has(contextGraphId) && queryGenerations.size >= 128) invalidateQueryCache();
    queryGenerations.set(contextGraphId, (queryGenerations.get(contextGraphId) ?? 0) + 1);
  }
  else {
    queryGeneration++;
    queryGenerations.clear();
    inflightQuery.clear();
  }
}

export interface QueryReadOptions { maxAgeMs?: number; }

export function postQueryDeduped(body: Record<string, unknown>, read: QueryReadOptions = {}): Promise<QueryExecutionResponse> {
  const headers = authHeaders();
  const session = JSON.stringify(headers);
  if (session !== querySession) {
    invalidateQueryCache();
    querySession = session;
  }
  const scope = String(body.contextGraphId ?? '');
  const generation = queryGenerations.get(scope) ?? 0;
  const globalGeneration = queryGeneration;
  const requestBody = JSON.stringify(body);
  const key = JSON.stringify([session, globalGeneration, generation, requestBody]);
  const maxAgeMs = read.maxAgeMs ?? 0;
  const operation = classifySparqlOperation(String(body.sparql ?? '')).kind;
  const cacheable = maxAgeMs > 0 && operation === 'read';
  const cached = cacheable ? queryReadCache.get(key, maxAgeMs) : undefined;
  if (cached) return Promise.resolve(cached);
  const existing = inflightQuery.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const res = await fetchWithTimeout(`${BASE}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: requestBody,
    }, 60_000);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) invalidateQueryCache();
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg, errBody);
    }
    const result = normalizeQueryExecutionResponse(await res.json(), String(body.sparql ?? ''));
    if (session !== JSON.stringify(authHeaders())) throw new HttpError(401, 'The session changed while loading data.');
    if (operation !== 'read') invalidateQueryCache(scope || undefined);
    if (cacheable && session === querySession && globalGeneration === queryGeneration && generation === (queryGenerations.get(scope) ?? 0)) {
      queryReadCache.set(key, result, scope);
    }
    return result;
  })().finally(() => {
    if (inflightQuery.get(key) === promise) inflightQuery.delete(key);
  });
  inflightQuery.set(key, promise);
  return promise;
}

export type QueryExecutionView = GetView;

export interface QueryExecutionOptions {
  contextGraphId?: string;
  subGraphName?: string;
  includeSharedMemory?: boolean;
  graphSuffix?: '_shared_memory';
  view?: QueryExecutionView;
  /** Include assertion partitions for callers whose query constrains them. */
  includeContextGraphPartitions?: boolean;
}

export const executeQuery = (
  sparql: string,
  options: QueryExecutionOptions = {},
  read: QueryReadOptions = {},
) =>
  postQueryDeduped({ sparql, ...options }, read);

export async function fetchContextGraphs(): Promise<{ contextGraphs: any[] }> {
  const session = JSON.stringify(authHeaders());
  if (session !== querySession) { invalidateQueryCache(); querySession = session; }
  const key = JSON.stringify([session, graphListGeneration]);
  const cached = graphListCache.get(key, UI_READ_MAX_AGE_MS);
  if (cached) return cached;
  if (graphListRequest?.key === key) return graphListRequest.promise;
  const generation = graphListGeneration;
  const promise = getWithTimeout<{ contextGraphs?: any[] }>(
    '/api/context-graph/list',
    CONTEXT_GRAPH_LOAD_TIMEOUT_MS,
  ).then(data => {
    if (session !== JSON.stringify(authHeaders())) throw new HttpError(401, 'The session changed while loading data.');
    const result = { contextGraphs: (data.contextGraphs ?? []).filter((p: any) => !p.isSystem) };
    if (generation === graphListGeneration && session === JSON.stringify(authHeaders())) graphListCache.set(key, result);
    return result;
  }).catch(error => {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) invalidateQueryCache();
    throw error;
  }).finally(() => { if (graphListRequest?.promise === promise) graphListRequest = null; });
  graphListRequest = { key, promise };
  return promise;
}
