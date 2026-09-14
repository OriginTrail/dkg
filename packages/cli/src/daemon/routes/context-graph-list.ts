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
import {
  CONTEXT_GRAPH_LIST_DEFAULT_LIMIT,
  CONTEXT_GRAPH_LIST_ERROR_CODES,
  CONTEXT_GRAPH_LIST_MAX_LIMIT,
  CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
  CONTEXT_GRAPH_LIST_PROJECTIONS,
  CONTEXT_GRAPH_LIST_WIRE_KEYS,
  CONTEXT_GRAPH_LIST_WIRE_KEY_VALUES,
  type ContextGraphListErrorCode,
  type ContextGraphListFullRow,
  type ContextGraphListPageResponse,
  type ContextGraphListProjection,
  type ContextGraphListRow,
  type ContextGraphListSummaryRow,
} from '@origintrail-official/dkg-core';
import {
  jsonResponse,
  jsonResponseHeaders,
  jsonSerializedResponse,
  serializeJsonResponseBody,
} from '../http-utils.js';
import type { RequestContext } from './context.js';

export {
  CONTEXT_GRAPH_LIST_DEFAULT_LIMIT,
  CONTEXT_GRAPH_LIST_MAX_LIMIT,
  CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
};
export const CONTEXT_GRAPH_LIST_EXPOSE_HEADERS = [
  'ETag',
  'X-DKG-List-Mode',
  'X-DKG-Result-Count',
  'X-DKG-Total-Count',
  'X-DKG-Response-Bytes',
  'X-DKG-Route-Ms',
  'Server-Timing',
].join(', ');

export interface ContextGraphListQuery {
  limit: number;
  projection: ContextGraphListProjection;
  subscribed?: boolean;
  synced?: boolean;
  onChain?: boolean;
  search?: string;
  cursorPosition?: number;
  cursorCollectionDigest?: string;
  fingerprint: string;
}

export type ContextGraphListQueryResult =
  | { ok: true; mode: 'legacy' }
  | { ok: true; mode: 'paged'; query: ContextGraphListQuery }
  | { ok: false; error: string };

const KNOWN_QUERY_KEYS = new Set(CONTEXT_GRAPH_LIST_WIRE_KEY_VALUES);
const CURSOR_PREFIX = 'v2:';
const CURSOR_BODY_RE = /^([0-9a-f]{16}):([0-9a-f]{64}):([0-9]+)$/;

function parseBoolean(
  searchParams: URLSearchParams,
  key: 'subscribed' | 'synced' | 'onChain',
): { ok: true; value?: boolean } | { ok: false; error: string } {
  const wireKey = CONTEXT_GRAPH_LIST_WIRE_KEYS[key];
  const raw = searchParams.get(wireKey);
  if (raw === null) return { ok: true };
  if (raw !== 'true' && raw !== 'false') {
    return { ok: false, error: `"${wireKey}" must be "true" or "false"` };
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

function encodeCursor(
  fingerprint: string,
  collectionDigest: string,
  position: number,
): string {
  return Buffer.from(
    `${CURSOR_PREFIX}${fingerprint}:${collectionDigest}:${position}`,
    'utf8',
  )
    .toString('base64url');
}

function decodeCursor(cursor: string): {
  fingerprint: string;
  collectionDigest: string;
  position: number;
} | undefined {
  if (cursor.length > 256) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const match = CURSOR_BODY_RE.exec(decoded.slice(CURSOR_PREFIX.length));
  if (!match) return undefined;
  return {
    fingerprint: match[1]!,
    collectionDigest: match[2]!,
    position: Number(match[3]),
  };
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

  const rawLimit = searchParams.get(CONTEXT_GRAPH_LIST_WIRE_KEYS.limit);
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

  const rawProjection = searchParams.get(CONTEXT_GRAPH_LIST_WIRE_KEYS.projection) ?? 'full';
  if (!(CONTEXT_GRAPH_LIST_PROJECTIONS as readonly string[]).includes(rawProjection)) {
    return { ok: false, error: '"projection" must be "full" or "summary"' };
  }
  const projection = rawProjection as ContextGraphListProjection;

  const subscribed = parseBoolean(searchParams, 'subscribed');
  if (!subscribed.ok) return subscribed;
  const synced = parseBoolean(searchParams, 'synced');
  if (!synced.ok) return synced;
  const onChain = parseBoolean(searchParams, 'onChain');
  if (!onChain.ok) return onChain;

  const rawSearch = searchParams.get(CONTEXT_GRAPH_LIST_WIRE_KEYS.q);
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

  const rawCursor = searchParams.get(CONTEXT_GRAPH_LIST_WIRE_KEYS.cursor);
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
    if (!Number.isSafeInteger(cursor.position)) {
      return { ok: false, error: '"cursor" position is outside the supported range' };
    }
    query.cursorPosition = cursor.position;
    query.cursorCollectionDigest = cursor.collectionDigest;
  }

  return { ok: true, mode: 'paged', query };
}

function hasOnChainId(row: ContextGraphListFullRow): boolean {
  const value = row.onChainId;
  return value !== undefined && value.trim() !== '' && value.trim() !== '0';
}

function truncateCodePoints(value: string, limit: number): {
  value: string;
  truncated: boolean;
} {
  const codePoints = [...value];
  return codePoints.length <= limit
    ? { value, truncated: false }
    : { value: codePoints.slice(0, limit).join(''), truncated: true };
}

function summaryRow(row: ContextGraphListFullRow): ContextGraphListSummaryRow {
  const name = truncateCodePoints(row.name, 256);
  const description = row.description === undefined
    ? undefined
    : truncateCodePoints(row.description, 512);
  const boundedOptional = (value: string | undefined, limit: number): string | undefined => {
    if (value === undefined) return undefined;
    return [...value].length <= limit ? value : undefined;
  };
  const curator = boundedOptional(row.curator, 256);
  const accessPolicy = boundedOptional(row.accessPolicy, 64);
  const onChainId = boundedOptional(row.onChainId, 128);
  return {
    id: row.id,
    name: name.value,
    ...(name.truncated ? { nameTruncated: true } : {}),
    ...(description === undefined ? {} : { description: description.value }),
    ...(description?.truncated ? { descriptionTruncated: true } : {}),
    ...(curator === undefined ? {} : { curator }),
    ...(accessPolicy === undefined ? {} : { accessPolicy }),
    isSystem: row.isSystem,
    subscribed: row.subscribed,
    synced: row.synced,
    ...(onChainId === undefined ? {} : { onChainId }),
    ...(row.callerInvolved === undefined
      ? {}
      : { callerInvolved: row.callerInvolved === true }),
  };
}

const CANONICAL_ROW_TEXT_FIELDS = [
  'uri',
  'name',
  'description',
  'creator',
  'curator',
  'accessPolicy',
  'createdAt',
  'onChainId',
] as const satisfies ReadonlyArray<keyof ContextGraphListFullRow>;

/**
 * Compatibility normalization for the paged endpoint only. The legacy route
 * preserves the agent's byte shape. For duplicate logical identities, prefer
 * the row with stronger live-state evidence, then use an explicit field order
 * as the stable final tie-breaker. HTTP object serialization is deliberately
 * absent from this domain decision.
 */
export function canonicalizeContextGraphRowsForPaging(
  rows: readonly ContextGraphListFullRow[],
): ContextGraphListFullRow[] {
  const compare = (left: ContextGraphListFullRow, right: ContextGraphListFullRow): number => {
    const evidence = [
      Number(hasOnChainId(left)) - Number(hasOnChainId(right)),
      Number(left.callerInvolved === true) - Number(right.callerInvolved === true),
      Number(left.subscribed === true) - Number(right.subscribed === true),
      Number(left.synced === true) - Number(right.synced === true),
    ];
    for (const comparison of evidence) {
      if (comparison !== 0) return comparison;
    }
    for (const field of CANONICAL_ROW_TEXT_FIELDS) {
      const comparison = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
      if (comparison !== 0) return -comparison;
    }
    return Number(left.isSystem) - Number(right.isSystem);
  };

  const canonical = new Map<string, ContextGraphListFullRow>();
  for (const row of rows) {
    if (row.id.length === 0) continue;
    const existing = canonical.get(row.id);
    if (!existing || compare(row, existing) > 0) canonical.set(row.id, row);
  }
  return [...canonical.values()];
}

function prepareRows(
  rows: ContextGraphListFullRow[],
  query: ContextGraphListQuery,
): ContextGraphListRow[] {
  return canonicalizeContextGraphRowsForPaging(rows)
    .filter((row) => query.subscribed === undefined
      || (row.subscribed === true) === query.subscribed)
    .filter((row) => query.synced === undefined
      || (row.synced === true) === query.synced)
    .filter((row) => query.onChain === undefined
      || hasOnChainId(row) === query.onChain)
    .filter((row) => query.search === undefined || (
      row.id.toLocaleLowerCase('en-US').includes(query.search)
      || row.name.toLocaleLowerCase('en-US').includes(query.search)
    ))
    .map((row) => query.projection === 'summary' ? summaryRow(row) : { ...row })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export type ContextGraphListPagePayload = ContextGraphListPageResponse;

export type ContextGraphListPageResult =
  | {
      ok: true;
      payload: ContextGraphListPagePayload;
      etag: string;
      body: string;
      serializedBytes: number;
    }
  | {
      ok: false;
      error: string;
      code: ContextGraphListErrorCode;
    };

function payloadWithExactSize(
  rows: ContextGraphListRow[],
  total: number,
  limit: number,
  nextCursor: string | undefined,
): { payload: ContextGraphListPagePayload; body: string; serializedBytes: number } {
  const payload: ContextGraphListPagePayload = {
    contextGraphs: rows,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    page: {
      returned: rows.length,
      total,
      limit,
      serializedBytes: 0,
      maxSerializedBytes: CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
    },
  };
  let serializedBytes = 0;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    payload.page.serializedBytes = serializedBytes;
    const body = serializeJsonResponseBody(payload);
    const nextSize = Buffer.byteLength(body);
    if (nextSize === serializedBytes) return { payload, body, serializedBytes };
    serializedBytes = nextSize;
  }
  throw new Error('Context-graph response byte accounting did not converge');
}

/**
 * Hash the prepared collection with bounded intermediate allocations. The
 * digest is deliberately equivalent to serializing the array as JSON, but a
 * registry-sized JSON string is never retained while calculating it. This is
 * also the digest carried by cursors, so it must remain stable across walks.
 */
function digestPreparedRows(rows: readonly ContextGraphListRow[]): string {
  const hash = createHash('sha256').update('[', 'utf8');
  rows.forEach((row, index) => {
    if (index > 0) hash.update(',', 'utf8');
    hash.update(serializeJsonResponseBody(row), 'utf8');
  });
  return hash.update(']', 'utf8').digest('hex');
}

export function buildContextGraphListPage(
  rows: ContextGraphListFullRow[],
  query: ContextGraphListQuery,
): ContextGraphListPageResult {
  const prepared = prepareRows(rows, query);
  const collectionDigest = digestPreparedRows(prepared);
  if (
    query.cursorCollectionDigest !== undefined
    && query.cursorCollectionDigest !== collectionDigest
  ) {
    return {
      ok: false,
      error: 'The context-graph registry changed during pagination; restart from the first page',
      code: CONTEXT_GRAPH_LIST_ERROR_CODES.snapshotChanged,
    };
  }
  const start = query.cursorPosition ?? 0;
  const after = prepared.slice(start);
  const pageEntries = after.slice(0, query.limit);

  while (pageEntries.length > 0) {
    const moreRowsRemain = after.length > pageEntries.length;
    const nextCursor = moreRowsRemain
      ? encodeCursor(
          query.fingerprint,
          collectionDigest,
          start + pageEntries.length,
        )
      : undefined;
    const built = payloadWithExactSize(
      pageEntries,
      prepared.length,
      query.limit,
      nextCursor,
    );
    if (built.serializedBytes <= CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES) {
      const etagDigest = createHash('sha256').update(built.body, 'utf8').digest('hex');
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
      code: CONTEXT_GRAPH_LIST_ERROR_CODES.entryTooLarge,
    };
  }

  const built = payloadWithExactSize([], prepared.length, query.limit, undefined);
  const etagDigest = createHash('sha256').update(built.body, 'utf8').digest('hex');
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
  values: {
    returned: number;
    total: number;
    bytes: number;
    elapsedMs: number;
    etag?: string;
    mode: 'legacy' | 'paged';
  },
): Record<string, string> {
  return {
    ...(values.etag === undefined ? {} : {
      ETag: values.etag,
      'Cache-Control': 'private, no-cache',
    }),
    Vary: 'Authorization',
    'Access-Control-Expose-Headers': CONTEXT_GRAPH_LIST_EXPOSE_HEADERS,
    'X-DKG-List-Mode': values.mode,
    'X-DKG-Result-Count': String(values.returned),
    'X-DKG-Total-Count': String(values.total),
    'X-DKG-Response-Bytes': String(values.bytes),
    'X-DKG-Route-Ms': String(values.elapsedMs),
    'Server-Timing': `dkg-context-graph-list;dur=${values.elapsedMs}`,
  };
}

export async function handleContextGraphListRoute(
  ctx: RequestContext,
  now: () => number = () => performance.now(),
): Promise<void> {
  const startedAt = now();
  const parsed = parseContextGraphListQuery(ctx.url.searchParams);
  if (!parsed.ok) {
    jsonResponse(ctx.res, 400, { error: parsed.error });
    return;
  }

  const contextGraphs = await ctx.agent.listContextGraphs({
    callerAgentAddress: ctx.requestAgentAddress ?? null,
  });

  if (parsed.mode === 'legacy') {
    const payload = { contextGraphs };
    const body = serializeJsonResponseBody(payload);
    const serializedBytes = Buffer.byteLength(body);
    const elapsedMs = Math.round((now() - startedAt) * 100) / 100;
    jsonSerializedResponse(ctx.res, 200, body, undefined, responseHeaders({
      returned: contextGraphs.length,
      total: contextGraphs.length,
      bytes: serializedBytes,
      elapsedMs,
      mode: 'legacy',
    }));
    return;
  }

  const page = buildContextGraphListPage(contextGraphs, parsed.query);
  if (!page.ok) {
    jsonResponse(
      ctx.res,
      page.code === CONTEXT_GRAPH_LIST_ERROR_CODES.snapshotChanged ? 409 : 413,
      {
        error: page.error,
        code: page.code,
        maxSerializedBytes: CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
      },
    );
    return;
  }

  const elapsedMs = Math.round((now() - startedAt) * 100) / 100;
  const headers = responseHeaders({
    returned: page.payload.page.returned,
    total: page.payload.page.total,
    bytes: page.serializedBytes,
    elapsedMs,
    etag: page.etag,
    mode: 'paged',
  });
  if (etagMatches(ctx.req.headers['if-none-match'], page.etag)) {
    ctx.res.writeHead(304, jsonResponseHeaders(ctx.res, undefined, {
      ...headers,
      'X-DKG-Response-Bytes': '0',
    }));
    ctx.res.end();
    return;
  }
  jsonSerializedResponse(
    ctx.res,
    200,
    page.body,
    undefined,
    headers,
  );
}
