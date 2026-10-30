import type { GetView } from '@origintrail-official/dkg-core';
import { classifySparqlOperation } from '@origintrail-official/dkg-core/dist/sparql-operation.js';
import type { PublicQueryQuad, PublicQueryResponse, PublicQueryResult } from '@origintrail-official/dkg-core/query-result';
import { BASE, authHeaders, HttpError } from './http.js';
import { loadContextGraphList } from './context-graph-api.js';
import { fetchQueryJson, AUTOMATIC_QUERY_TIMEOUT_MS, AUTOMATIC_QUERY_MAX_BYTES } from './query-transport.js';
import { CachedRead, UI_READ_MAX_AGE_MS } from './lib/read-cache.js';

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

const graphLists = new CachedRead<{ contextGraphs: any[] }>(2 * 1024 * 1024, 1);
const queries = new CachedRead<QueryExecutionResponse>();
let querySession = '';

export function invalidateQueryCache(contextGraphId?: string): void {
  graphLists.invalidate();
  queries.invalidate(contextGraphId || undefined);
}

export interface QueryReadOptions {
  maxAgeMs?: number;
  /** null is reserved for explicit interactive execution. */
  timeoutMs?: number | null;
  maxResponseBytes?: number | null;
}

export function postQueryDeduped(body: Record<string, unknown>, read: QueryReadOptions = {}): Promise<QueryExecutionResponse> {
  const headers = authHeaders();
  const session = JSON.stringify(headers);
  if (session !== querySession) {
    invalidateQueryCache();
    querySession = session;
  }
  const scope = String(body.contextGraphId ?? '');
  const requestBody = JSON.stringify(body);
  const timeoutMs = read.timeoutMs === undefined ? AUTOMATIC_QUERY_TIMEOUT_MS : read.timeoutMs;
  const maxResponseBytes = read.maxResponseBytes === undefined ? AUTOMATIC_QUERY_MAX_BYTES : read.maxResponseBytes;
  const key = JSON.stringify([session, requestBody, timeoutMs, maxResponseBytes]);
  const maxAgeMs = read.maxAgeMs ?? 0;
  const operation = classifySparqlOperation(String(body.sparql ?? '')).kind;
  const cacheable = maxAgeMs > 0 && operation === 'read';
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: requestBody,
  };
  return queries.run(key, { scope, maxAgeMs: cacheable ? maxAgeMs : 0 }, async isCurrent => {
    const { response: res, body: responseBody } = await fetchQueryJson(`${BASE}/api/query`, init, { timeoutMs, maxResponseBytes }, response => {
      if (isCurrent() && (response.status === 401 || response.status === 403)) invalidateQueryCache();
    });
    if (!res.ok) {
      const errBody = responseBody;
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg, errBody);
    }
    const result = normalizeQueryExecutionResponse(responseBody, String(body.sparql ?? ''));
    if (session !== JSON.stringify(authHeaders())) throw new HttpError(401, 'The session changed while loading data.');
    if (operation !== 'read') invalidateQueryCache(scope || undefined);
    return result;
  });
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

export async function fetchContextGraphs(options: { fresh?: boolean } = {}): Promise<{ contextGraphs: any[] }> {
  const session = JSON.stringify(authHeaders());
  if (session !== querySession) { invalidateQueryCache(); querySession = session; }
  if (options.fresh) graphLists.invalidate();
  return graphLists.run(session, { maxAgeMs: UI_READ_MAX_AGE_MS }, isCurrent => loadContextGraphList().then(view => {
    if (session !== JSON.stringify(authHeaders())) throw new HttpError(401, 'The session changed while loading data.');
    return view;
  }).catch(error => {
    if (isCurrent() && error instanceof HttpError && (error.status === 401 || error.status === 403)) invalidateQueryCache();
    throw error;
  }));
}
