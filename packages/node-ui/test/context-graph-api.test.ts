import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fetchContextGraphs } from '../src/ui/context-graph-api.js';
import type { ContextGraphListSummaryRow } from '@origintrail-official/dkg-core/context-graph-list-wire';

let server: Server;
let baseUrl: string;
const requestLog: Array<{
  url: string;
  headers: Record<string, string | string[] | undefined>;
}> = [];
let contextGraphPagination: {
  etag: string;
  pages: Record<string, { contextGraphs: ContextGraphListSummaryRow[]; nextCursor?: string }>;
} | undefined;

function contextGraphSummary(
  id: string,
  isSystem = false,
): ContextGraphListSummaryRow {
  return {
    id,
    name: id,
    isSystem,
    subscribed: false,
    synced: false,
  };
}

type ResponseOverride = {
  match: (url: string) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};
let responseOverrides: ResponseOverride[] = [];

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      req.on('data', () => undefined);
      req.on('end', async () => {
        const reqUrl = req.url ?? '';
        requestLog.push({ url: reqUrl, headers: req.headers });
        const overrideIndex = responseOverrides.findIndex((override) => override.match(reqUrl));
        if (overrideIndex !== -1) {
          const [override] = responseOverrides.splice(overrideIndex, 1);
          if (override.delayMs !== undefined) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, override.delayMs));
          }
          res.writeHead(override.status, {
            'Content-Type': 'application/json',
            ...override.headers,
          });
          res.end(JSON.stringify(override.body));
          return;
        }
        if (reqUrl.startsWith('/api/context-graph/list') && contextGraphPagination) {
          const parsed = new URL(reqUrl, 'http://localhost');
          const cursor = parsed.searchParams.get('cursor') ?? '';
          if (cursor === '' && req.headers['if-none-match'] === contextGraphPagination.etag) {
            res.writeHead(304, { ETag: contextGraphPagination.etag });
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ETag: contextGraphPagination.etag,
          });
          res.end(JSON.stringify(contextGraphPagination.pages[cursor] ?? { contextGraphs: [] }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ contextGraphs: [contextGraphSummary('cg1')] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

describe('context graph API', () => {
  const origFetch = globalThis.fetch;

  beforeAll(async () => {
    await startTestServer();
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      return origFetch(`${baseUrl}${url}`, init);
    };
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    requestLog.length = 0;
    responseOverrides = [];
    contextGraphPagination = undefined;
    if (typeof window !== 'undefined') window.__DKG_TOKEN__ = undefined;
  });

  it('walks bounded context-graph pages and reuses them after a 304', async () => {
    contextGraphPagination = {
      etag: '"context-graphs-v1"',
      pages: {
        '': {
          contextGraphs: [
            contextGraphSummary('cg-1'),
            contextGraphSummary('agents', true),
          ],
          nextCursor: 'page-2',
        },
        'page-2': { contextGraphs: [contextGraphSummary('cg-2')] },
      },
    };

    await expect(fetchContextGraphs()).resolves.toEqual({
      contextGraphs: [contextGraphSummary('cg-1'), contextGraphSummary('cg-2')],
    });
    expect(requestLog.map((entry) => entry.url)).toEqual([
      '/api/context-graph/list?limit=100&projection=summary',
      '/api/context-graph/list?limit=100&cursor=page-2&projection=summary',
    ]);

    requestLog.length = 0;
    await expect(fetchContextGraphs()).resolves.toEqual({
      contextGraphs: [contextGraphSummary('cg-1'), contextGraphSummary('cg-2')],
    });
    expect(requestLog).toHaveLength(1);
    expect(requestLog[0]?.headers['if-none-match']).toBe('"context-graphs-v1"');
  });

  it('surfaces an unsuccessful first context-graph page', async () => {
    responseOverrides.push({
      match: (url) => url.startsWith('/api/context-graph/list'),
      status: 503,
      body: { error: 'context graph registry unavailable' },
    });

    await expect(fetchContextGraphs()).rejects.toThrow('context graph registry unavailable');
    expect(requestLog).toHaveLength(1);
  });

  it('rejects a malformed context-graph page at the decoded boundary', async () => {
    responseOverrides.push({
      match: (url) => url.startsWith('/api/context-graph/list'),
      status: 200,
      body: { contextGraphs: 'not-an-array', nextCursor: 42 },
    });

    await expect(fetchContextGraphs()).rejects.toThrow('Invalid context-graph list page');
    expect(requestLog).toHaveLength(1);
  });

  it('surfaces a later-page transport error without returning a partial list', async () => {
    contextGraphPagination = {
      etag: '"context-graphs-later-error"',
      pages: {
        '': { contextGraphs: [contextGraphSummary('cg-1')], nextCursor: 'failed-page' },
      },
    };
    responseOverrides.push({
      match: (url) => url.includes('cursor=failed-page'),
      status: 502,
      body: undefined,
    });

    await expect(fetchContextGraphs()).rejects.toThrow('HTTP 502');
    expect(requestLog.map((entry) => entry.url)).toEqual([
      '/api/context-graph/list?limit=100&projection=summary',
      '/api/context-graph/list?limit=100&cursor=failed-page&projection=summary',
    ]);
  });

  it('rejects a repeated context-graph cursor instead of looping', async () => {
    contextGraphPagination = {
      etag: '"context-graphs-repeated-cursor"',
      pages: {
        '': { contextGraphs: [contextGraphSummary('cg-1')], nextCursor: 'repeated' },
        repeated: { contextGraphs: [contextGraphSummary('cg-2')], nextCursor: 'repeated' },
      },
    };

    await expect(fetchContextGraphs()).rejects.toThrow('repeated pagination cursor');
    expect(requestLog).toHaveLength(2);
  });

  it('coalesces concurrent context-graph walks and returns independent arrays', async () => {
    contextGraphPagination = {
      etag: '"context-graphs-coalesced"',
      pages: { '': { contextGraphs: [contextGraphSummary('cg-shared')] } },
    };

    const first = fetchContextGraphs();
    const second = fetchContextGraphs();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(requestLog).toHaveLength(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.contextGraphs).not.toBe(secondResult.contextGraphs);
  });

  it('restarts a page walk when the registry snapshot changes', async () => {
    responseOverrides.push(
      {
        match: (url) => url.includes('/api/context-graph/list?') && !url.includes('cursor='),
        status: 200,
        body: {
          contextGraphs: [contextGraphSummary('cg-old-1')],
          nextCursor: 'old-page-2',
        },
        headers: { ETag: '"old-snapshot"' },
      },
      {
        match: (url) => url.includes('cursor=old-page-2'),
        status: 409,
        body: {
          code: 'CONTEXT_GRAPH_LIST_SNAPSHOT_CHANGED',
          error: 'registry changed',
        },
      },
      {
        match: (url) => url.includes('/api/context-graph/list?') && !url.includes('cursor='),
        status: 200,
        body: {
          contextGraphs: [
            contextGraphSummary('cg-new-1'),
            contextGraphSummary('cg-new-2'),
          ],
        },
        headers: { ETag: '"new-snapshot"' },
      },
    );

    await expect(fetchContextGraphs()).resolves.toEqual({
      contextGraphs: [
        contextGraphSummary('cg-new-1'),
        contextGraphSummary('cg-new-2'),
      ],
    });
    expect(requestLog).toHaveLength(3);
  });

  it('never coalesces or returns a page walk across bearer identities', async () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    window.__DKG_TOKEN__ = 'token-a';
    responseOverrides.push(
      {
        match: () => true,
        status: 200,
        body: { contextGraphs: [contextGraphSummary('private-a')] },
        headers: { ETag: '"token-a"' },
        delayMs: 100,
      },
      {
        match: () => true,
        status: 200,
        body: { contextGraphs: [contextGraphSummary('visible-b')] },
        headers: { ETag: '"token-b"' },
      },
      {
        match: () => true,
        status: 304,
        body: undefined,
        headers: { ETag: '"token-b"' },
      },
    );

    const underA = fetchContextGraphs();
    while (requestLog.length < 1) await new Promise((resolveRequest) => setTimeout(resolveRequest, 0));
    window.__DKG_TOKEN__ = 'token-b';
    const underB = fetchContextGraphs();
    const [resultA, resultB] = await Promise.all([underA, underB]);

    expect(resultA).toEqual({ contextGraphs: [contextGraphSummary('visible-b')] });
    expect(resultB).toEqual({ contextGraphs: [contextGraphSummary('visible-b')] });
    expect(requestLog).toHaveLength(3);
    expect(requestLog[0]?.headers.authorization).toBe('Bearer token-a');
    expect(requestLog.slice(1).every(
      (entry) => entry.headers.authorization === 'Bearer token-b',
    )).toBe(true);
  });

  it('does not send a stale-authorized continuation after the bearer changes', async () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    window.__DKG_TOKEN__ = 'token-a';
    responseOverrides.push(
      {
        match: () => true,
        status: 200,
        body: {
          contextGraphs: [contextGraphSummary('private-a')],
          nextCursor: 'private-a-page-2',
        },
        headers: { ETag: '"token-a"' },
        delayMs: 50,
      },
      {
        match: () => true,
        status: 200,
        body: { contextGraphs: [contextGraphSummary('visible-b')] },
        headers: { ETag: '"token-b"' },
      },
    );

    const result = fetchContextGraphs();
    while (requestLog.length < 1) await new Promise((resolveRequest) => setTimeout(resolveRequest, 0));
    window.__DKG_TOKEN__ = 'token-b';

    await expect(result).resolves.toEqual({
      contextGraphs: [contextGraphSummary('visible-b')],
    });
    expect(requestLog).toHaveLength(2);
    expect(requestLog.some((entry) => entry.url.includes('private-a-page-2'))).toBe(false);
    expect(requestLog.map((entry) => entry.headers.authorization)).toEqual([
      'Bearer token-a',
      'Bearer token-b',
    ]);
  });

  it('discards a failed continuation when the bearer changes in flight', async () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    window.__DKG_TOKEN__ = 'token-a';
    responseOverrides.push(
      {
        match: (url) => !url.includes('cursor='),
        status: 200,
        body: {
          contextGraphs: [contextGraphSummary('private-a')],
          nextCursor: 'private-a-page-2',
        },
        headers: { ETag: '"token-a"' },
      },
      {
        match: (url) => url.includes('cursor=private-a-page-2'),
        status: 401,
        body: { error: 'old token expired' },
        delayMs: 50,
      },
      {
        match: (url) => !url.includes('cursor='),
        status: 200,
        body: { contextGraphs: [contextGraphSummary('visible-b')] },
        headers: { ETag: '"token-b"' },
      },
    );

    const result = fetchContextGraphs();
    while (requestLog.length < 2) await new Promise((resolveRequest) => setTimeout(resolveRequest, 0));
    window.__DKG_TOKEN__ = 'token-b';

    await expect(result).resolves.toEqual({
      contextGraphs: [contextGraphSummary('visible-b')],
    });
    expect(requestLog.map((entry) => entry.headers.authorization)).toEqual([
      'Bearer token-a',
      'Bearer token-a',
      'Bearer token-b',
    ]);
    expect(requestLog.map((entry) => entry.url)).toEqual([
      '/api/context-graph/list?limit=100&projection=summary',
      '/api/context-graph/list?limit=100&cursor=private-a-page-2&projection=summary',
      '/api/context-graph/list?limit=100&projection=summary',
    ]);
  });

  it('invalidates a delayed conditional walk across an A to B to A change', async () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    window.__DKG_TOKEN__ = 'token-a';
    contextGraphPagination = {
      etag: '"token-a-cached"',
      pages: { '': { contextGraphs: [contextGraphSummary('cached-a')] } },
    };
    await fetchContextGraphs();

    contextGraphPagination = undefined;
    requestLog.length = 0;
    responseOverrides.push(
      {
        match: () => true,
        status: 304,
        body: undefined,
        headers: { ETag: '"token-a-cached"' },
        delayMs: 40,
      },
      {
        match: () => true,
        status: 200,
        body: { contextGraphs: [contextGraphSummary('visible-b')] },
        headers: { ETag: '"token-b"' },
        delayMs: 40,
      },
      {
        match: () => true,
        status: 200,
        body: { contextGraphs: [contextGraphSummary('fresh-a')] },
        headers: { ETag: '"token-a-fresh"' },
        delayMs: 120,
      },
    );

    const oldA = fetchContextGraphs();
    while (requestLog.length < 1) await new Promise((resolveRequest) => setTimeout(resolveRequest, 0));
    window.__DKG_TOKEN__ = 'token-b';
    const underB = fetchContextGraphs();
    while (requestLog.length < 2) await new Promise((resolveRequest) => setTimeout(resolveRequest, 0));
    window.__DKG_TOKEN__ = 'token-a';
    const currentA = fetchContextGraphs();

    await expect(Promise.all([oldA, underB, currentA])).resolves.toEqual([
      { contextGraphs: [contextGraphSummary('fresh-a')] },
      { contextGraphs: [contextGraphSummary('fresh-a')] },
      { contextGraphs: [contextGraphSummary('fresh-a')] },
    ]);
    expect(requestLog).toHaveLength(3);
    expect(requestLog.map((entry) => entry.headers.authorization)).toEqual([
      'Bearer token-a',
      'Bearer token-b',
      'Bearer token-a',
    ]);
  });
});
