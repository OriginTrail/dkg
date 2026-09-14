import {
  CONTEXT_GRAPH_LIST_ERROR_CODES,
  CONTEXT_GRAPH_LIST_MAX_LIMIT,
  decodeContextGraphListErrorResponse,
  serializeContextGraphListOptions,
  type ContextGraphListSummaryRow,
} from '@origintrail-official/dkg-core/context-graph-list-wire';
import { BASE, authHeaders, fetchWithTimeout, HttpError } from './http.js';

const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60_000;
const CONTEXT_GRAPH_LIST_MAX_PAGES = 10_000;
const CONTEXT_GRAPH_LIST_MAX_RESTARTS = 3;

export interface ContextGraphListView {
  contextGraphs: ContextGraphListSummaryRow[];
}

interface ContextGraphListCacheEntry extends ContextGraphListView {
  etag: string;
}

type DecodedContextGraphListPage = {
  contextGraphs: ContextGraphListSummaryRow[];
  nextCursor?: string;
};

type ContextGraphPageWalkResult =
  | { kind: 'not-modified'; view: ContextGraphListView }
  | { kind: 'loaded'; view: ContextGraphListView; etag?: string };

interface ContextGraphListAuthorization {
  readonly key: string;
  readonly headers: Record<string, string>;
  readonly generation: number;
}

interface InFlightContextGraphPageWalk {
  readonly generation: number;
  readonly request: Promise<ContextGraphPageWalkResult>;
}

const cacheByAuthorization = new Map<string, ContextGraphListCacheEntry>();
const inFlightByAuthorization = new Map<string, InFlightContextGraphPageWalk>();
let currentAuthorizationKey: string | undefined;
let currentAuthorizationGeneration = 0;

class AuthorizationChangedError extends Error {}

function captureAuthorization(): ContextGraphListAuthorization {
  const headers = authHeaders();
  const key = headers.Authorization ?? '';
  if (currentAuthorizationKey === undefined) {
    currentAuthorizationKey = key;
  } else if (currentAuthorizationKey !== key) {
    currentAuthorizationKey = key;
    currentAuthorizationGeneration += 1;
    for (const cachedAuthorization of cacheByAuthorization.keys()) {
      if (cachedAuthorization !== key) cacheByAuthorization.delete(cachedAuthorization);
    }
    // Entries carry their generation, so clearing the registry invalidates old
    // walks without allowing their finally blocks to delete a replacement.
    inFlightByAuthorization.clear();
  }
  return { key, headers, generation: currentAuthorizationGeneration };
}

function cloneView(view: ContextGraphListView): ContextGraphListView {
  return { contextGraphs: view.contextGraphs.map((row) => ({ ...row })) };
}

function isSummaryRow(value: unknown): value is ContextGraphListSummaryRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<ContextGraphListSummaryRow>;
  return typeof row.id === 'string'
    && typeof row.name === 'string'
    && typeof row.isSystem === 'boolean'
    && typeof row.subscribed === 'boolean'
    && typeof row.synced === 'boolean';
}

function decodePage(value: unknown): DecodedContextGraphListPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid context-graph list page');
  }
  const page = value as Partial<DecodedContextGraphListPage>;
  if (
    !Array.isArray(page.contextGraphs)
    || !page.contextGraphs.every(isSummaryRow)
    || (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
  ) {
    throw new Error('Invalid context-graph list page');
  }
  return {
    contextGraphs: page.contextGraphs,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

async function httpError(response: Response): Promise<HttpError> {
  const body = await response.json().catch(() => ({}));
  const message = (body as { error?: string })?.error ?? `HTTP ${response.status}`;
  return new HttpError(response.status, message, body);
}

function authorizationIsCurrent(authorization: ContextGraphListAuthorization): boolean {
  const current = captureAuthorization();
  return current.key === authorization.key
    && current.generation === authorization.generation;
}

async function fetchContextGraphPages(
  authorization: ContextGraphListAuthorization,
  cached?: ContextGraphListCacheEntry,
): Promise<ContextGraphPageWalkResult> {
  const requestPage = async (cursor?: string, etag?: string): Promise<Response> => {
    if (!authorizationIsCurrent(authorization)) throw new AuthorizationChangedError();
    const query = serializeContextGraphListOptions({
      limit: CONTEXT_GRAPH_LIST_MAX_LIMIT,
      projection: 'summary',
      ...(cursor === undefined ? {} : { cursor }),
    });
    return fetchWithTimeout(`${BASE}/api/context-graph/list?${query}`, {
      headers: {
        ...authorization.headers,
        ...(etag === undefined ? {} : { 'If-None-Match': etag }),
      },
    }, CONTEXT_GRAPH_LOAD_TIMEOUT_MS);
  };

  let response = await requestPage(undefined, cached?.etag);
  if (!authorizationIsCurrent(authorization)) throw new AuthorizationChangedError();
  if (response.status === 304) {
    if (!cached) throw new Error('Context-graph list returned an unexpected 304');
    return { kind: 'not-modified', view: cached };
  }
  if (!response.ok) throw await httpError(response);

  const etag = response.headers.get('etag') ?? undefined;
  const contextGraphs: ContextGraphListSummaryRow[] = [];
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < CONTEXT_GRAPH_LIST_MAX_PAGES; pageNumber += 1) {
    const data = decodePage(await response.json());
    if (!authorizationIsCurrent(authorization)) throw new AuthorizationChangedError();
    contextGraphs.push(...data.contextGraphs);
    if (!data.nextCursor) break;
    if (seenCursors.has(data.nextCursor)) {
      throw new Error('Context-graph list returned a repeated pagination cursor');
    }
    seenCursors.add(data.nextCursor);
    response = await requestPage(data.nextCursor);
    if (!response.ok) throw await httpError(response);
    if (pageNumber === CONTEXT_GRAPH_LIST_MAX_PAGES - 1) {
      throw new Error('Context-graph list exceeded the pagination safety bound');
    }
  }

  const visible = contextGraphs.filter((row) => !row.isSystem);
  return {
    kind: 'loaded',
    view: { contextGraphs: visible },
    ...(etag === undefined ? {} : { etag }),
  };
}

function isSnapshotChanged(error: unknown): boolean {
  const response = error instanceof HttpError
    ? decodeContextGraphListErrorResponse(error.body)
    : undefined;
  return error instanceof HttpError
    && error.status === 409
    && response?.code === CONTEXT_GRAPH_LIST_ERROR_CODES.snapshotChanged;
}

export async function fetchContextGraphs(): Promise<ContextGraphListView> {
  for (let attempt = 0; attempt < CONTEXT_GRAPH_LIST_MAX_RESTARTS; attempt += 1) {
    const authorization = captureAuthorization();
    const cached = cacheByAuthorization.get(authorization.key);
    let inFlight = inFlightByAuthorization.get(authorization.key);
    if (!inFlight || inFlight.generation !== authorization.generation) {
      inFlight = {
        generation: authorization.generation,
        request: fetchContextGraphPages(authorization, cached),
      };
      inFlightByAuthorization.set(authorization.key, inFlight);
    }
    try {
      const result = await inFlight.request;
      if (!authorizationIsCurrent(authorization)) continue;
      if (result.kind === 'not-modified') {
        return cloneView(result.view);
      }
      if (result.etag) {
        cacheByAuthorization.set(authorization.key, {
          etag: result.etag,
          contextGraphs: result.view.contextGraphs.map((row) => ({ ...row })),
        });
      } else {
        cacheByAuthorization.delete(authorization.key);
      }
      return cloneView(result.view);
    } catch (error) {
      if (!(error instanceof AuthorizationChangedError) && !isSnapshotChanged(error)) throw error;
    } finally {
      if (inFlightByAuthorization.get(authorization.key) === inFlight) {
        inFlightByAuthorization.delete(authorization.key);
      }
    }
  }
  throw new Error('Context-graph list changed repeatedly while loading');
}
