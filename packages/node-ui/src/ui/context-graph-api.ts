import {
  serializeContextGraphListOptions,
  type ContextGraphListPageResponse,
  type ContextGraphListSummaryRow,
} from '@origintrail-official/dkg-core';
import { BASE, authHeaders, fetchWithTimeout, HttpError } from './http.js';

const CONTEXT_GRAPH_LOAD_TIMEOUT_MS = 60_000;
const CONTEXT_GRAPH_LIST_PAGE_LIMIT = 100;
const CONTEXT_GRAPH_LIST_MAX_PAGES = 10_000;
const CONTEXT_GRAPH_LIST_MAX_RESTARTS = 3;
const SNAPSHOT_CHANGED_CODE = 'CONTEXT_GRAPH_LIST_SNAPSHOT_CHANGED';

export interface ContextGraphListView {
  contextGraphs: ContextGraphListSummaryRow[];
}

interface ContextGraphListCacheEntry extends ContextGraphListView {
  etag: string;
}

class ContextGraphAuthorizationChangedError extends Error {
  constructor() {
    super('Context-graph authorization changed during pagination');
    this.name = 'ContextGraphAuthorizationChangedError';
  }
}

const cacheByAuthorization = new Map<string, ContextGraphListCacheEntry>();
const inFlightByAuthorization = new Map<string, Promise<ContextGraphListView>>();

function captureAuthorization(): { key: string; headers: Record<string, string> } {
  const headers = authHeaders();
  return { key: headers.Authorization ?? '', headers };
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

function decodePage(value: unknown): ContextGraphListPageResponse<ContextGraphListSummaryRow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid context-graph list page');
  }
  const page = value as Partial<ContextGraphListPageResponse<ContextGraphListSummaryRow>>;
  if (
    !Array.isArray(page.contextGraphs)
    || !page.contextGraphs.every(isSummaryRow)
    || (page.nextCursor !== undefined && typeof page.nextCursor !== 'string')
  ) {
    throw new Error('Invalid context-graph list page');
  }
  return page as ContextGraphListPageResponse<ContextGraphListSummaryRow>;
}

async function httpError(response: Response): Promise<HttpError> {
  const body = await response.json().catch(() => ({}));
  const message = (body as { error?: string })?.error ?? `HTTP ${response.status}`;
  return new HttpError(response.status, message, body);
}

function authorizationIsCurrent(key: string): boolean {
  return captureAuthorization().key === key;
}

async function fetchContextGraphPages(
  authorization: { key: string; headers: Record<string, string> },
): Promise<ContextGraphListView> {
  const cached = cacheByAuthorization.get(authorization.key);
  const requestPage = async (cursor?: string, etag?: string): Promise<Response> => {
    const query = serializeContextGraphListOptions({
      limit: CONTEXT_GRAPH_LIST_PAGE_LIMIT,
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
  if (response.status === 304 && cached) {
    if (!authorizationIsCurrent(authorization.key)) {
      throw new ContextGraphAuthorizationChangedError();
    }
    return cloneView(cached);
  }
  if (!response.ok) throw await httpError(response);

  const etag = response.headers.get('etag') ?? undefined;
  const contextGraphs: ContextGraphListSummaryRow[] = [];
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < CONTEXT_GRAPH_LIST_MAX_PAGES; pageNumber += 1) {
    const data = decodePage(await response.json());
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

  if (!authorizationIsCurrent(authorization.key)) {
    throw new ContextGraphAuthorizationChangedError();
  }
  const visible = contextGraphs.filter((row) => !row.isSystem);
  if (etag) {
    cacheByAuthorization.set(authorization.key, {
      etag,
      contextGraphs: visible.map((row) => ({ ...row })),
    });
  } else {
    cacheByAuthorization.delete(authorization.key);
  }
  return { contextGraphs: visible };
}

function isRestartable(error: unknown): boolean {
  return error instanceof ContextGraphAuthorizationChangedError
    || (
      error instanceof HttpError
      && error.status === 409
      && (error.body as { code?: unknown } | undefined)?.code === SNAPSHOT_CHANGED_CODE
    );
}

export async function fetchContextGraphs(): Promise<ContextGraphListView> {
  for (let attempt = 0; attempt < CONTEXT_GRAPH_LIST_MAX_RESTARTS; attempt += 1) {
    const authorization = captureAuthorization();
    for (const cachedAuthorization of cacheByAuthorization.keys()) {
      if (cachedAuthorization !== authorization.key) {
        cacheByAuthorization.delete(cachedAuthorization);
      }
    }
    let request = inFlightByAuthorization.get(authorization.key);
    if (!request) {
      request = fetchContextGraphPages(authorization);
      inFlightByAuthorization.set(authorization.key, request);
    }
    try {
      const view = await request;
      if (!authorizationIsCurrent(authorization.key)) continue;
      return cloneView(view);
    } catch (error) {
      if (!isRestartable(error)) throw error;
    } finally {
      if (inFlightByAuthorization.get(authorization.key) === request) {
        inFlightByAuthorization.delete(authorization.key);
      }
    }
  }
  throw new Error('Context-graph list changed repeatedly while loading');
}
