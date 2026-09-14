import {
  serializeContextGraphListOptions,
  type ContextGraphListSummaryRow,
} from '@origintrail-official/dkg-core/context-graph-list-wire';
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

type DecodedContextGraphListPage = {
  contextGraphs: ContextGraphListSummaryRow[];
  nextCursor?: string;
};

type ContextGraphPageWalkResult =
  | { kind: 'not-modified' }
  | { kind: 'loaded'; view: ContextGraphListView; etag?: string };

const cacheByAuthorization = new Map<string, ContextGraphListCacheEntry>();
const inFlightByAuthorization = new Map<string, Promise<ContextGraphPageWalkResult>>();

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

function authorizationIsCurrent(key: string): boolean {
  return captureAuthorization().key === key;
}

async function fetchContextGraphPages(
  authorization: { key: string; headers: Record<string, string> },
  cachedEtag?: string,
): Promise<ContextGraphPageWalkResult> {
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

  let response = await requestPage(undefined, cachedEtag);
  if (response.status === 304) return { kind: 'not-modified' };
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

  const visible = contextGraphs.filter((row) => !row.isSystem);
  return {
    kind: 'loaded',
    view: { contextGraphs: visible },
    ...(etag === undefined ? {} : { etag }),
  };
}

function isSnapshotChanged(error: unknown): boolean {
  return error instanceof HttpError
    && error.status === 409
    && (error.body as { code?: unknown } | undefined)?.code === SNAPSHOT_CHANGED_CODE;
}

export async function fetchContextGraphs(): Promise<ContextGraphListView> {
  for (let attempt = 0; attempt < CONTEXT_GRAPH_LIST_MAX_RESTARTS; attempt += 1) {
    const authorization = captureAuthorization();
    for (const cachedAuthorization of cacheByAuthorization.keys()) {
      if (cachedAuthorization !== authorization.key) {
        cacheByAuthorization.delete(cachedAuthorization);
      }
    }
    const cached = cacheByAuthorization.get(authorization.key);
    let request = inFlightByAuthorization.get(authorization.key);
    if (!request) {
      request = fetchContextGraphPages(authorization, cached?.etag);
      inFlightByAuthorization.set(authorization.key, request);
    }
    try {
      const result = await request;
      if (!authorizationIsCurrent(authorization.key)) continue;
      if (result.kind === 'not-modified') {
        if (!cached) throw new Error('Context-graph list returned 304 without a cached view');
        return cloneView(cached);
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
      if (!isSnapshotChanged(error)) throw error;
    } finally {
      if (inFlightByAuthorization.get(authorization.key) === request) {
        inFlightByAuthorization.delete(authorization.key);
      }
    }
  }
  throw new Error('Context-graph list changed repeatedly while loading');
}
