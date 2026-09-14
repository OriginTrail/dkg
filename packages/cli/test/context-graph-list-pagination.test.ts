import { describe, expect, it, vi } from 'vitest';
import {
  buildContextGraphListPage,
  CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES,
  handleContextGraphListRoute,
  parseContextGraphListQuery,
} from '../src/daemon/routes/context-graph-list.js';
import type { ContextGraphListFullRow } from '@origintrail-official/dkg-core';
import type { RequestContext } from '../src/daemon/routes/context.js';

function rows(count: number): ContextGraphListFullRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `graph-${String(index).padStart(4, '0')}`,
    uri: `did:dkg:context-graph:graph-${index}`,
    name: `Context Graph ${index}`,
    description: `Description ${index} ${'x'.repeat(80)}`,
    curator: `did:dkg:agent:0x${String(index).padStart(40, '0')}`,
    accessPolicy: index % 2 === 0 ? 'public' : 'private',
    isSystem: false,
    subscribed: index % 3 === 0,
    synced: index % 5 === 0,
    ...(index % 7 === 0 ? { onChainId: String(index + 1) } : {}),
    callerInvolved: index % 11 === 0,
  }));
}

function pagedQuery(params: Record<string, string>) {
  const parsed = parseContextGraphListQuery(new URLSearchParams(params));
  expect(parsed.ok && parsed.mode === 'paged').toBe(true);
  if (!parsed.ok || parsed.mode !== 'paged') throw new Error('expected paged query');
  return parsed.query;
}

function responseRecorder() {
  const state: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {};
  const res = {
    writeHead(status: number, headers: Record<string, string> = {}) {
      state.status = status;
      state.headers = headers;
      return this;
    },
    end(body?: string) {
      state.body = body ?? '';
      return this;
    },
  };
  return { state, res };
}

describe('bounded context-graph listing', () => {
  it('preserves the parameterless legacy response mode', () => {
    expect(parseContextGraphListQuery(new URLSearchParams())).toEqual({
      ok: true,
      mode: 'legacy',
    });
  });

  it.each([
    [{ limit: '0' }, /between 1 and 100/],
    [{ limit: '101' }, /between 1 and 100/],
    [{ subscribed: 'yes' }, /must be "true" or "false"/],
    [{ projection: 'tiny' }, /must be "full" or "summary"/],
    [{ limt: '20' }, /Unknown query parameter/],
  ])('rejects an invalid bounded query %#', (input, expected) => {
    const parsed = parseContextGraphListQuery(new URLSearchParams(input));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(expected);
  });

  it('walks 537 shuffled rows without duplicate or omitted graph ids', () => {
    const source = rows(537).reverse();
    const observed: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = pagedQuery({
        limit: '37',
        projection: 'summary',
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = buildContextGraphListPage(source, query);
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error(page.error);
      expect(page.serializedBytes).toBeLessThanOrEqual(CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page.payload))).toBe(page.serializedBytes);
      observed.push(...page.payload.contextGraphs.map((row) => row.id));
      cursor = page.payload.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(15);
    expect(observed).toHaveLength(537);
    expect(new Set(observed).size).toBe(537);
    expect(new Set(observed)).toEqual(new Set(source.map((row) => row.id)));
  });

  it('deduplicates ids before reporting the total or returning rows', () => {
    const source = [
      ...rows(20),
      { ...rows(1)[0]!, name: 'Conflicting duplicate' },
    ];
    const firstQuery = pagedQuery({ limit: '100', projection: 'summary' });
    const first = buildContextGraphListPage(source, firstQuery);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const ids = first.payload.contextGraphs.map((row) => row.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(first.payload.page.total).toBe(20);
    expect(first.payload.nextCursor).toBeUndefined();
  });

  it('binds cursors to the filters and projection', () => {
    const first = buildContextGraphListPage(
      rows(20),
      pagedQuery({ limit: '3', projection: 'summary', subscribed: 'true' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const changed = parseContextGraphListQuery(new URLSearchParams({
      limit: '3',
      projection: 'full',
      subscribed: 'true',
      cursor: first.payload.nextCursor!,
    }));
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error).toMatch(/different filter or projection/);
  });

  it('applies search before projecting summary rows', () => {
    const page = buildContextGraphListPage(
      rows(30),
      pagedQuery({
        projection: 'summary',
        q: 'graph-0000',
      }),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error);
    expect(page.payload.contextGraphs).toEqual([
      expect.objectContaining({
        id: 'graph-0000',
        subscribed: true,
        synced: true,
        onChainId: '1',
      }),
    ]);
    expect(page.payload.contextGraphs[0]).not.toHaveProperty('uri');
  });

  it('applies subscribed, synced, and onChain filters independently', () => {
    const source = rows(30);
    const cases = [
      {
        params: { projection: 'summary', subscribed: 'false' },
        expected: source.filter((row) => !row.subscribed).map((row) => row.id),
      },
      {
        params: { projection: 'summary', synced: 'true' },
        expected: source.filter((row) => row.synced).map((row) => row.id),
      },
      {
        params: { projection: 'summary', onChain: 'false' },
        expected: source.filter((row) => row.onChainId === undefined).map((row) => row.id),
      },
    ];
    for (const testCase of cases) {
      const page = buildContextGraphListPage(source, pagedQuery(testCase.params));
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error(page.error);
      expect(new Set(page.payload.contextGraphs.map((row) => row.id))).toEqual(
        new Set(testCase.expected),
      );
      expect(page.payload.contextGraphs.length).toBeGreaterThan(0);
      expect(page.payload.contextGraphs.length).toBeLessThan(source.length);
    }
  });

  it('enforces exact summary name and description boundaries', () => {
    const source: ContextGraphListFullRow[] = [
      {
        ...rows(1)[0]!,
        id: 'oversized-summary',
        name: 'n'.repeat(257),
        description: 'd'.repeat(513),
      },
      {
        ...rows(1)[0]!,
        id: 'boundary-summary',
        name: 'b'.repeat(256),
        description: 'c'.repeat(512),
      },
    ];
    const page = buildContextGraphListPage(
      source,
      pagedQuery({ limit: '10', projection: 'summary' }),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error);
    const oversized = page.payload.contextGraphs.find((row) => row.id === 'oversized-summary');
    const boundary = page.payload.contextGraphs.find((row) => row.id === 'boundary-summary');
    expect(oversized).toMatchObject({
      name: 'n'.repeat(256),
      nameTruncated: true,
      description: 'd'.repeat(512),
      descriptionTruncated: true,
    });
    expect(boundary).toMatchObject({
      name: 'b'.repeat(256),
      description: 'c'.repeat(512),
    });
    expect(boundary).not.toHaveProperty('nameTruncated');
    expect(boundary).not.toHaveProperty('descriptionTruncated');
  });

  it('shrinks a page by serialized bytes and rejects one oversized full row', () => {
    const bulky = rows(100).map((row) => ({
      ...row,
      description: 'z'.repeat(4_000),
    }));
    const summary = buildContextGraphListPage(
      bulky,
      pagedQuery({ limit: '100', projection: 'summary' }),
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) throw new Error(summary.error);
    expect(summary.serializedBytes).toBeLessThanOrEqual(CONTEXT_GRAPH_LIST_MAX_RESPONSE_BYTES);
    expect(summary.payload.contextGraphs.length).toBeGreaterThan(0);
    expect(summary.payload.contextGraphs.length).toBeLessThan(100);
    expect(summary.payload.nextCursor).toBeDefined();

    const oversized = buildContextGraphListPage(
      [{ ...rows(1)[0]!, description: 'z'.repeat(70_000) }],
      pagedQuery({ limit: '1', projection: 'full' }),
    );
    expect(oversized).toMatchObject({
      ok: false,
      code: 'CONTEXT_GRAPH_LIST_ENTRY_TOO_LARGE',
    });
  });

  it('makes the first-page ETag cover changes beyond that page', () => {
    const source = rows(200);
    const query = pagedQuery({ limit: '10', projection: 'summary' });
    const original = buildContextGraphListPage(source, query);
    const reordered = buildContextGraphListPage([...source].reverse(), query);
    const changed = buildContextGraphListPage([
      ...source.slice(0, -1),
      { ...source.at(-1)!, name: 'Changed beyond the first page' },
    ], query);
    expect(original.ok && reordered.ok && changed.ok).toBe(true);
    if (!original.ok || !reordered.ok || !changed.ok) return;
    expect(reordered.etag).toBe(original.etag);
    expect(changed.etag).not.toBe(original.etag);
  });

  it('rejects a later page when the collection changed after its cursor was issued', () => {
    const source = rows(101);
    const first = buildContextGraphListPage(
      source,
      pagedQuery({ limit: '100', projection: 'summary' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const cursor = first.payload.nextCursor!;

    const changed = buildContextGraphListPage(
      source.slice(0, -1),
      pagedQuery({ limit: '100', projection: 'summary', cursor }),
    );
    expect(changed).toMatchObject({
      ok: false,
      code: 'CONTEXT_GRAPH_LIST_SNAPSHOT_CHANGED',
    });

    const restored = buildContextGraphListPage(
      source,
      pagedQuery({ limit: '100', projection: 'summary' }),
    );
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.etag).toBe(first.etag);
  });

  it('returns a bodyless 304 with observability headers for a matching ETag', async () => {
    const listContextGraphs = vi.fn(async () => rows(120));
    const first = responseRecorder();
    await handleContextGraphListRoute({
      req: { headers: {} },
      res: first.res,
      agent: { listContextGraphs },
      url: new URL('http://localhost/api/context-graph/list?limit=25&projection=summary'),
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as unknown as RequestContext);

    expect(first.state.status).toBe(200);
    expect(first.state.headers).toMatchObject({
      'X-DKG-List-Mode': 'paged',
      'X-DKG-Result-Count': '25',
      'X-DKG-Total-Count': '120',
    });
    expect(first.state.headers?.ETag).toMatch(/^"dkg-cg-list-[0-9a-f]{64}"$/);
    expect(Buffer.byteLength(first.state.body ?? '')).toBe(
      Number(first.state.headers?.['X-DKG-Response-Bytes']),
    );

    const conditional = responseRecorder();
    await handleContextGraphListRoute({
      req: { headers: { 'if-none-match': first.state.headers?.ETag } },
      res: conditional.res,
      agent: { listContextGraphs },
      url: new URL('http://localhost/api/context-graph/list?limit=25&projection=summary'),
      requestAgentAddress: '0x0000000000000000000000000000000000000001',
    } as unknown as RequestContext);

    expect(conditional.state.status).toBe(304);
    expect(conditional.state.body).toBe('');
    expect(conditional.state.headers).toMatchObject({
      ETag: first.state.headers?.ETag,
      'X-DKG-Response-Bytes': '0',
    });
  });
});
