/**
 * Bounded `GET /api/context-graph/list` pagination (GH #1765).
 *
 * A parameterless request retains the legacy `{ contextGraphs }` response.
 * Supplying any supported query parameter selects a deterministic, keyset-
 * paginated response capped at 100 rows and 64 KiB of serialized JSON. The
 * ETag for each page also covers the complete filtered collection, so the
 * Node UI can validate its cached multi-page list with one conditional request.
 */
import { createHash } from 'node:crypto';
import { corsHeaders, jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

export const CONTEXT_GRAPH_LIST_DEFAULT_LIMIT = 50;
export const CONTEXT_GRAPH_LIST_MAX_LIMIT = 100;
export const CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES = 64 * 1024;

export type ContextGraphListProjection = 'full' | 'summary';

export type ContextGraphListRow = Record<string, unknown> & {
  id: string;
  name?: string;
  description?: string;
  curator?: string;
  accessPolicy?: string;
  isSystem?: boolean;
  subscribed?: boolean;
  synced?: boolean;
  onChainId?: string;
  callerInvolved?: boolean;
};

export interface ContextGraphListQuery {
  limit: number;
  projection: ContextGraphListProjection;
  subscribed?: boolean;
  synced?: boolean;
  onChain?: boolean;
  search?: string;
  cursorDigest?: string;
  fingerprint: string;
}

export type ContextGraphListQueryResult =
  | { ok: true; mode: 'legacy' }
  | { ok: true; mode: 'paged'; query: ContextGraphListQuery }
  | { ok: false; error: string };

const KNOWN_QUERY_KEYS = new Set([
  'limit',
  'cursor',
  'projection',
  'subscribed',
  'synced',
  'onChain',
  'q',
]);
const CURSOR_PREFIX = 'v1:';
const CURSOR_BODY_RE = /^([0-9a-f]{16}):([0-9a-f]{64})$/;

function parseBoolean(
  searchParams: URLSearchParams,
  key: 'subscribed' | 'synced' | 'onChain',
): { ok: true; value?: boolean } | { ok: false; error: string } {
  const raw = searchParams.get(key);
  if (raw === null) return { ok: true };
  if (raw !== 'true' && raw !== 'false') {
    return { ok: false, error: `"${key}" must be "true" or "false"` };
  }
  return { ok: true, value: raw === 'true' };
}

function queryFingerprint(query: {
  projection: ContextGraphListProjection;
  subscribed?: boolean;
  synced?: boolean;
  onChain?: boolean;
  search?: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    query.projection,
    query.subscribed ?? null,
    query.synced ?? null,
    query.onChain ?? null,
    query.search ?? null,
  ]), 'utf8').digest('hex').slice(0, 16);
}

function encodeCursor(fingerprint: string, rowDigest: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${fingerprint}:${rowDigest}`, 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor: string): {
  fingerprint: string;
  rowDigest: string;
} | undefined {
  if (cursor.length > 256) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const match = CURSOR_BODY_RE.exec(decoded.slice(CURSOR_PREFIX.length));
  if (!match) return undefined;
  return { fingerprint: match[1]!, rowDigest: match[2]! };
}

export function parseContextGraphListQuery(
  searchParams: URLSearchParams,
): ContextGraphListQueryResult {
  if ([...searchParams.keys()].length === 0) return { ok: true, mode: 'legacy' };

  for (const key of searchParams.keys()) {
    if (!KNOWN_QUERY_KEYS.has(key)) {
      return {
        ok: false,
        error: `Unknown query parameter "${key}"; supported: ${[...KNOWN_QUERY_KEYS].join(', ')}`,
      };
    }
  }

  const rawLimit = searchParams.get('limit');
  let limit = CONTEXT_GRAPH_LIST_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^[0-9]+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) {
      return { ok: false, error: '"limit" must be a positive integer' };
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > CONTEXT_GRAPH_LIST_MAX_LIMIT) {
      return {
        ok: false,
        error: `"limit" must be between 1 and ${CONTEXT_GRAPH_LIST_MAX_LIMIT}`,
      };
    }
  }

  const rawProjection = searchParams.get('projection') ?? 'full';
  if (rawProjection !== 'full' && rawProjection !== 'summary') {
    return { ok: false, error: '"projection" must be "full" or "summary"' };
  }
  const projection = rawProjection as ContextGraphListProjection;

  const subscribed = parseBoolean(searchParams, 'subscribed');
  if (!subscribed.ok) return subscribed;
  const synced = parseBoolean(searchParams, 'synced');
  if (!synced.ok) return synced;
  const onChain = parseBoolean(searchParams, 'onChain');
  if (!onChain.ok) return onChain;

  const rawSearch = searchParams.get('q');
  const search = rawSearch?.trim().toLocaleLowerCase('en-US') || undefined;
  if (search && search.length > 256) {
    return { ok: false, error: '"q" must not exceed 256 characters' };
  }

  const filters = {
    projection,
    ...(subscribed.value === undefined ? {} : { subscribed: subscribed.value }),
    ...(synced.value === undefined ? {} : { synced: synced.value }),
    ...(onChain.value === undefined ? {} : { onChain: onChain.value }),
    ...(search === undefined ? {} : { search }),
  };
  const fingerprint = queryFingerprint(filters);
  const query: ContextGraphListQuery = { limit, fingerprint, ...filters };

  const rawCursor = searchParams.get('cursor');
  if (rawCursor !== null) {
    const cursor = decodeCursor(rawCursor);
    if (!cursor) {
      return { ok: false, error: '"cursor" is not a cursor from a previous response' };
    }
    if (cursor.fingerprint !== fingerprint) {
      return {
        ok: false,
        error: '"cursor" was issued under different filter or projection parameters',
      };
    }
    query.cursorDigest = cursor.rowDigest;
  }

  return { ok: true, mode: 'paged', query };
}

function wireStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (
    typeof entry === 'bigint' ? entry.toString() : entry
  ));
}

function rowDigest(row: ContextGraphListRow): string {
  return createHash('sha256').update(row.id, 'utf8').digest('hex');
}

function hasOnChainId(row: ContextGraphListRow): boolean {
  const value = row.onChainId ?? row.onChainContextGraphId;
  if (typeof value === 'string') return value.trim() !== '' && value.trim() !== '0';
  return value !== undefined && value !== null && value !== false && value !== 0;
}

function summaryRow(row: ContextGraphListRow): ContextGraphListRow {
  const rawName = typeof row.name === 'string' ? row.name : row.id;
  const rawDescription = typeof row.description === 'string' ? row.description : undefined;
  return {
    id: row.id,
    name: rawName.slice(0, 256),
    ...(rawName.length > 256 ? { nameTruncated: true } : {}),
    ...(rawDescription === undefined ? {} : { description: rawDescription.slice(0, 512) }),
    ...(rawDescription !== undefined && rawDescription.length > 512
      ? { descriptionTruncated: true }
      : {}),
    ...(typeof row.curator === 'string' ? { curator: row.curator } : {}),
    ...(typeof row.accessPolicy === 'string' ? { accessPolicy: row.accessPolicy } : {}),
    isSystem: row.isSystem === true,
    subscribed: row.subscribed === true,
    synced: row.synced === true,
    ...(row.onChainId === undefined ? {} : { onChainId: row.onChainId }),
    ...(row.callerInvolved === undefined
      ? {}
      : { callerInvolved: row.callerInvolved === true }),
  };
}

function prepareRows(
  rows: ContextGraphListRow[],
  query: ContextGraphListQuery,
): Array<{ digest: string; row: ContextGraphListRow }> {
  const unique = new Map<string, ContextGraphListRow>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) continue;
    const existing = unique.get(row.id);
    if (!existing || wireStringify(row) < wireStringify(existing)) {
      unique.set(row.id, row);
    }
  }

  return [...unique.values()]
    .filter((row) => query.subscribed === undefined
      || (row.subscribed === true) === query.subscribed)
    .filter((row) => query.synced === undefined
      || (row.synced === true) === query.synced)
    .filter((row) => query.onChain === undefined
      || hasOnChainId(row) === query.onChain)
    .filter((row) => query.search === undefined || (
      row.id.toLocaleLowerCase('en-US').includes(query.search)
      || (typeof row.name === 'string'
        && row.name.toLocaleLowerCase('en-US').includes(query.search))
    ))
    .map((row) => ({
      digest: rowDigest(row),
      row: query.projection === 'summary' ? summaryRow(row) : { ...row },
    }))
    .sort((left, right) => (
      left.digest < right.digest
        ? -1
        : left.digest > right.digest
          ? 1
          : left.row.id.localeCompare(right.row.id)
    ));
}

export interface ContextGraphListPagePayload {
  contextGraphs: ContextGraphListRow[];
  nextCursor?: string;
  page: {
    returned: number;
    total: number;
    limit: number;
    serializedBytes: number;
    maxSerializedBytes: number;
    elapsedMs: number;
  };
}

export type ContextGraphListPageResult =
  | {
      ok: true;
      payload: ContextGraphListPagePayload;
      etag: string;
      serializedBytes: number;
    }
  | {
      ok: false;
      error: string;
      code: 'CONTEXT_GRAPH_LIST_ENTRY_TOO_LARGE';
    };

function payloadWithExactSize(
  rows: ContextGraphListRow[],
  total: number,
  limit: number,
  elapsedMs: number,
  nextCursor: string | undefined,
): { payload: ContextGraphListPagePayload; serializedBytes: number } {
  const payload: ContextGraphListPagePayload = {
    contextGraphs: rows,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    page: {
      returned: rows.length,
      total,
      limit,
      serializedBytes: 0,
      maxSerializedBytes: CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
      elapsedMs,
    },
  };
  let serializedBytes = 0;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    payload.page.serializedBytes = serializedBytes;
    const nextSize = Buffer.byteLength(wireStringify(payload));
    if (nextSize === serializedBytes) break;
    serializedBytes = nextSize;
  }
  payload.page.serializedBytes = serializedBytes;
  serializedBytes = Buffer.byteLength(wireStringify(payload));
  payload.page.serializedBytes = serializedBytes;
  return { payload, serializedBytes: Buffer.byteLength(wireStringify(payload)) };
}

export function buildContextGraphListPage(
  rows: ContextGraphListRow[],
  query: ContextGraphListQuery,
  elapsedMs = 0,
): ContextGraphListPageResult {
  const prepared = prepareRows(rows, query);
  const after = query.cursorDigest === undefined
    ? prepared
    : prepared.filter((entry) => entry.digest > query.cursorDigest!);
  const pageEntries = after.slice(0, query.limit);

  while (pageEntries.length > 0) {
    const moreRowsRemain = after.length > pageEntries.length;
    const nextCursor = moreRowsRemain
      ? encodeCursor(query.fingerprint, pageEntries[pageEntries.length - 1]!.digest)
      : undefined;
    const built = payloadWithExactSize(
      pageEntries.map((entry) => entry.row),
      prepared.length,
      query.limit,
      elapsedMs,
      nextCursor,
    );
    if (built.serializedBytes <= CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES) {
      const etagDigest = createHash('sha256').update(wireStringify({
        fingerprint: query.fingerprint,
        limit: query.limit,
        cursor: query.cursorDigest ?? null,
        collection: prepared,
      }), 'utf8').digest('hex');
      return {
        ok: true,
        ...built,
        etag: `"dkg-cg-list-${etagDigest}"`,
      };
    }
    pageEntries.pop();
  }

  if (after.length > 0) {
    return {
      ok: false,
      error: `One context-graph ${query.projection} row exceeds the ${CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES}-byte paginated response limit`,
      code: 'CONTEXT_GRAPH_LIST_ENTRY_TOO_LARGE',
    };
  }

  const built = payloadWithExactSize([], prepared.length, query.limit, elapsedMs, undefined);
  const etagDigest = createHash('sha256').update(wireStringify({
    fingerprint: query.fingerprint,
    limit: query.limit,
    cursor: query.cursorDigest ?? null,
    collection: prepared,
  }), 'utf8').digest('hex');
  return { ok: true, ...built, etag: `"dkg-cg-list-${etagDigest}"` };
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return false;
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`;
  });
}

function responseHeaders(
  ctx: Pick<RequestContext, 'res'>,
  values: {
    returned: number;
    total: number;
    bytes: number;
    elapsedMs: number;
    etag?: string;
    mode: 'legacy' | 'paged';
  },
): Record<string, string> {
  const origin = ((ctx.res as unknown as { __corsOrigin?: string | null }).__corsOrigin) ?? null;
  return {
    ...corsHeaders(origin),
    ...(values.etag === undefined ? {} : {
      ETag: values.etag,
      'Cache-Control': 'private, no-cache',
    }),
    Vary: origin && origin !== '*' ? 'Origin, Authorization' : 'Authorization',
    'X-DKG-List-Mode': values.mode,
    'X-DKG-Result-Count': String(values.returned),
    'X-DKG-Total-Count': String(values.total),
    'X-DKG-Response-Bytes': String(values.bytes),
    'X-DKG-Route-Ms': String(values.elapsedMs),
    'Server-Timing': `dkg-context-graph-list;dur=${values.elapsedMs}`,
  };
}

export async function handleContextGraphListRoute(ctx: RequestContext): Promise<void> {
  const startedAt = performance.now();
  const parsed = parseContextGraphListQuery(ctx.url.searchParams);
  if (!parsed.ok) {
    jsonResponse(ctx.res, 400, { error: parsed.error });
    return;
  }

  const contextGraphs = await ctx.agent.listContextGraphs({
    callerAgentAddress: ctx.requestAgentAddress ?? null,
  }) as ContextGraphListRow[];
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;

  if (parsed.mode === 'legacy') {
    const payload = { contextGraphs };
    const serializedBytes = Buffer.byteLength(wireStringify(payload));
    jsonResponse(ctx.res, 200, payload, undefined, responseHeaders(ctx, {
      returned: contextGraphs.length,
      total: contextGraphs.length,
      bytes: serializedBytes,
      elapsedMs,
      mode: 'legacy',
    }));
    return;
  }

  const page = buildContextGraphListPage(contextGraphs, parsed.query, elapsedMs);
  if (!page.ok) {
    jsonResponse(ctx.res, 413, {
      error: page.error,
      code: page.code,
      maxSerializedBytes: CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
    });
    return;
  }

  const headers = responseHeaders(ctx, {
    returned: page.payload.page.returned,
    total: page.payload.page.total,
    bytes: page.serializedBytes,
    elapsedMs,
    etag: page.etag,
    mode: 'paged',
  });
  if (etagMatches(ctx.req.headers['if-none-match'], page.etag)) {
    ctx.res.writeHead(304, { ...headers, 'X-DKG-Response-Bytes': '0' });
    ctx.res.end();
    return;
  }
  jsonResponse(ctx.res, 200, page.payload, undefined, headers);
}
