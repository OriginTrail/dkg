import { createServer, type Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  fileUrl,
  authHeaders,
  fetchStatus,
  fetchAgents,
  fetchMetrics,
  fetchContextGraphs,
  fetchOperations,
  fetchOperationsWithPhases,
  fetchOperation,
  fetchErrorHotspots,
  fetchNodeLog,
  fetchConnections,
  fetchRetentionSettings,
  fetchTelemetrySettings,
  markNotificationsRead,
  fetchRpcHealth,
  fetchQueryHistory,
  fetchSavedQueries,
  fetchWalletsBalances,
  fetchEconomics,
  fetchSuccessRates,
  fetchExtractionStatus,
  executeQuery,
  publishTriples,
  publishSharedMemory,
  listSwmEntities,
  listAssertions,
  createSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
  fetchOperationStats,
  fetchFailedOperations,
  fetchPerTypeStats,
  fetchMetricsHistory,
  subscribeToContextGraph,
  shutdownNode,
  promoteAssertion,
} from '../src/ui/api.js';

let server: Server;
let baseUrl: string;
const requestLog: Array<{ url: string; method: string; body: string }> = [];
let queryBindings: any[] = [];

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requestLog.push({ url: req.url ?? '', method: req.method ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });

        const url = req.url ?? '';
        if (url.startsWith('/api/status')) {
          res.end(JSON.stringify({ peerId: 'abc', synced: true }));
        } else if (url.startsWith('/api/agents')) {
          res.end(JSON.stringify({ agents: [] }));
        } else if (url.startsWith('/api/metrics/history')) {
          res.end(JSON.stringify({ snapshots: [] }));
        } else if (url.startsWith('/api/metrics')) {
          res.end(JSON.stringify({ total_kcs: 5 }));
        } else if (url.startsWith('/api/connections')) {
          res.end(JSON.stringify({ peers: [] }));
        } else if (url.startsWith('/api/settings/retention')) {
          res.end(JSON.stringify({ retentionDays: 30 }));
        } else if (url.startsWith('/api/settings/telemetry')) {
          res.end(JSON.stringify({ enabled: true }));
        } else if (url.startsWith('/api/chain/rpc-health')) {
          res.end(JSON.stringify({ healthy: true }));
        } else if (url.startsWith('/api/economics')) {
          res.end(JSON.stringify({ periods: [] }));
        } else if (url.startsWith('/api/wallets/balances')) {
          res.end(JSON.stringify({ wallets: [] }));
        } else if (url.startsWith('/api/saved-queries')) {
          res.end(JSON.stringify({ queries: [], id: 1 }));
        } else if (url.startsWith('/api/operations/') && !url.includes('stats') && !url.includes('failed')) {
          res.end(JSON.stringify({ operation: {}, logs: [], phases: [] }));
        } else if (url.startsWith('/api/operation-stats') || url.startsWith('/api/operations/stats')) {
          res.end(JSON.stringify({ summary: {}, timeSeries: [] }));
        } else if (url.startsWith('/api/operations')) {
          res.end(JSON.stringify({ operations: [], total: 0 }));
        } else if (url.startsWith('/api/error-hotspots')) {
          res.end(JSON.stringify({ hotspots: [] }));
        } else if (url.startsWith('/api/node-log')) {
          res.end(JSON.stringify({ lines: [], totalSize: 0 }));
        } else if (url.startsWith('/api/notifications')) {
          res.end(JSON.stringify({ notifications: [], ok: true }));
        } else if (url.startsWith('/api/success-rates')) {
          res.end(JSON.stringify({ rates: [] }));
        } else if (url.startsWith('/api/per-type-stats')) {
          res.end(JSON.stringify({ buckets: [], types: [], series: {} }));
        } else if (url.startsWith('/api/context-graph/list') || url.startsWith('/api/context-graphs')) {
          res.end(JSON.stringify({ contextGraphs: [{ id: 'cg1' }] }));
        } else if (url.startsWith('/api/query')) {
          res.end(JSON.stringify({ result: { bindings: queryBindings } }));
        } else if (url.startsWith('/api/shared-memory')) {
          res.end(JSON.stringify({ success: true, ual: 'did:dkg:test' }));
        } else if (url.includes('/promote')) {
          res.end(JSON.stringify({ promotedCount: 1 }));
        } else if (url.startsWith('/api/failed-operations')) {
          res.end(JSON.stringify({ operations: [] }));
        } else if (url.includes('/extraction-status')) {
          res.end(JSON.stringify({ fileHash: 'sha256:abc', detectedContentType: 'text/plain' }));
        } else if (url.startsWith('/api/query-history')) {
          res.end(JSON.stringify({ history: [] }));
        } else if (url.startsWith('/api/shutdown')) {
          res.end(JSON.stringify({}));
        } else if (url.startsWith('/api/subscribe')) {
          res.end(JSON.stringify({}));
        } else {
          res.end(JSON.stringify({}));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

describe('UI API tests', () => {
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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    requestLog.length = 0;
    queryBindings = [];
  });

  describe('fileUrl', () => {
    it('preserves sha256: prefix', () => {
      expect(fileUrl('sha256:abcdef')).toBe('/api/file/sha256%3Aabcdef');
    });

    it('preserves keccak256: prefix', () => {
      expect(fileUrl('keccak256:abcdef')).toBe('/api/file/keccak256%3Aabcdef');
    });

    it('adds sha256: prefix to bare hashes', () => {
      expect(fileUrl('abcdef0123456789')).toBe('/api/file/sha256%3Aabcdef0123456789');
    });

    it('appends contentType query param when provided', () => {
      const url = fileUrl('sha256:abc', 'application/pdf');
      expect(url).toContain('?contentType=application%2Fpdf');
    });

    it('omits contentType query param when not provided', () => {
      const url = fileUrl('sha256:abc');
      expect(url).not.toContain('contentType');
    });

    it('encodes special characters in contentType', () => {
      const url = fileUrl('sha256:abc', 'text/plain; charset=utf-8');
      expect(url).toContain('contentType=');
      expect(url).not.toContain(';');
    });
  });

  describe('authHeaders', () => {
    it('returns empty object when window is undefined', () => {
      const headers = authHeaders();
      expect(headers).toEqual({});
    });
  });

  describe('simple GET endpoints', () => {
    it('fetchStatus calls /api/status', async () => {
      const res = await fetchStatus();
      expect(res).toEqual({ peerId: 'abc', synced: true });
      expect(requestLog.some(r => r.url.startsWith('/api/status'))).toBe(true);
    });

    it('fetchAgents calls /api/agents', async () => {
      await fetchAgents();
      expect(requestLog.some(r => r.url.startsWith('/api/agents'))).toBe(true);
    });

    it('fetchMetrics calls /api/metrics', async () => {
      const res = await fetchMetrics();
      expect(res.total_kcs).toBe(5);
    });

    it('fetchConnections calls /api/connections', async () => {
      await fetchConnections();
      expect(requestLog.some(r => r.url.startsWith('/api/connections'))).toBe(true);
    });

    it('fetchRetentionSettings calls /api/settings/retention', async () => {
      const res = await fetchRetentionSettings();
      expect(res.retentionDays).toBe(30);
    });

    it('fetchTelemetrySettings calls /api/settings/telemetry', async () => {
      const res = await fetchTelemetrySettings();
      expect(res.enabled).toBe(true);
    });

    it('fetchRpcHealth calls /api/rpc-health', async () => {
      await fetchRpcHealth();
      expect(requestLog.some(r => r.url.startsWith('/api/chain/rpc-health'))).toBe(true);
    });

    it('fetchEconomics calls /api/economics', async () => {
      await fetchEconomics();
      expect(requestLog.some(r => r.url.startsWith('/api/economics'))).toBe(true);
    });

    it('fetchWalletsBalances calls /api/wallets/balances', async () => {
      await fetchWalletsBalances();
      expect(requestLog.some(r => r.url.startsWith('/api/wallets/balances'))).toBe(true);
    });

    it('fetchSavedQueries calls /api/saved-queries', async () => {
      await fetchSavedQueries();
      expect(requestLog.some(r => r.url.startsWith('/api/saved-queries'))).toBe(true);
    });
  });

  describe('parameterized GET endpoints', () => {
    it('fetchOperations includes query params', async () => {
      await fetchOperations({ limit: '10' });
      const call = requestLog.find(r => r.url.includes('/api/operations'));
      expect(call?.url).toContain('limit=10');
    });

    it('fetchOperationsWithPhases adds phases=1', async () => {
      await fetchOperationsWithPhases({ limit: '5' });
      const call = requestLog.find(r => r.url.includes('phases=1'));
      expect(call).toBeTruthy();
      expect(call?.url).toContain('limit=5');
    });

    it('fetchOperation calls /api/operations/:id', async () => {
      await fetchOperation('op-123');
      expect(requestLog.some(r => r.url.includes('/api/operations/op-123'))).toBe(true);
    });

    it('fetchErrorHotspots with period', async () => {
      await fetchErrorHotspots(3600000);
      const call = requestLog.find(r => r.url.includes('error-hotspots'));
      expect(call?.url).toContain('periodMs=3600000');
    });

    it('fetchNodeLog with lines', async () => {
      await fetchNodeLog({ lines: 100 });
      const call = requestLog.find(r => r.url.includes('/api/node-log'));
      expect(call?.url).toContain('lines=100');
    });

    it('fetchSuccessRates calls correct endpoint', async () => {
      await fetchSuccessRates(60000);
      expect(requestLog.some(r => r.url.includes('periodMs=60000'))).toBe(true);
    });

    it('fetchMetricsHistory includes from/to/maxPoints', async () => {
      await fetchMetricsHistory(1000, 2000, 50);
      const call = requestLog.find(r => r.url.includes('metrics/history') || r.url.includes('from=1000'));
      expect(call?.url).toContain('from=1000');
      expect(call?.url).toContain('to=2000');
      expect(call?.url).toContain('maxPoints=50');
    });
  });

  describe('POST endpoints', () => {
    it('executeQuery sends sparql and contextGraphId', async () => {
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-1');
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/query'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.sparql).toBe('SELECT * WHERE { ?s ?p ?o }');
      expect(body.contextGraphId).toBe('cg-1');
    });

    it('publishSharedMemory sends one explicit root selection', async () => {
      await publishSharedMemory('cg-1', ['urn:root']);
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/shared-memory/publish'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
      expect(body.selection).toEqual(['urn:root']);
      expect(body.clearAfter).toBe(false);
    });

    it('publishSharedMemory keeps the UI-side single-root guard', async () => {
      expect(() => publishSharedMemory('cg-1', ['urn:root:a', 'urn:root:b'])).toThrow(/exactly one root entity/i);
      expect(requestLog.some(r => r.url.includes('/api/shared-memory/publish'))).toBe(false);
    });

    it('listSwmEntities queries the shared-working-memory view', async () => {
      await listSwmEntities('cg-1');
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/query'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
      expect(body.view).toBe('shared-working-memory');
      expect(body.sparql).toContain('/_shared_memory');
      expect(body.sparql).toContain('workspaceOwner');
    });

    it('listSwmEntities collapses skolemized section subjects into canonical roots', async () => {
      queryBindings = [
        { s: { value: 'https://example.org/doc/root' }, cnt: { value: '2' } },
        { s: { value: 'https://example.org/doc/root/.well-known/genid/section-1-intro' }, cnt: { value: '3' } },
        { s: { value: '<https://example.org/doc/child-only/.well-known/genid/section-1-only>' }, cnt: { value: '4' } },
      ];

      await expect(listSwmEntities('cg-1')).resolves.toEqual([
        { uri: 'https://example.org/doc/root', label: 'root', tripleCount: 5 },
        { uri: 'https://example.org/doc/child-only', label: 'child-only', tripleCount: 4 },
      ]);
    });

    it('listAssertions(wm) recognizes the lifecycle-URN marker form (file imports)', async () => {
      // File-imported assertions carry dkg:memoryLayer "WM" ONLY on the
      // lifecycle URN (urn:dkg:assertion:<cg>:<agent>:<name>), not the
      // data-graph URI. The parser must accept it — otherwise the bulk-promote
      // loop sees an empty list and reports "0 triples promoted".
      const agent = '0x' + '1'.repeat(40);
      queryBindings = [{ g: { value: `urn:dkg:assertion:cg-1:${agent}:my-import.md` } }];
      const list = await listAssertions('cg-1', 'wm');
      expect(list.map(a => a.name)).toEqual(['my-import.md']);
    });

    it('listAssertions(wm) dedupes when BOTH the URN and data-URI markers exist', async () => {
      const agent = '0x' + '2'.repeat(40);
      queryBindings = [
        { g: { value: `did:dkg:context-graph:cg-1/assertion/${agent}/doc` } },
        { g: { value: `urn:dkg:assertion:cg-1:${agent}:doc` } },
      ];
      const list = await listAssertions('cg-1', 'wm');
      expect(list.map(a => a.name)).toEqual(['doc']);
    });

    it('listAssertions(wm) parses sub-graph-scoped URN markers and names containing ":"', async () => {
      const agent = '0x' + '3'.repeat(40);
      queryBindings = [{ g: { value: `urn:dkg:assertion:cg-1:code:${agent}:a:b.md` } }];
      const list = await listAssertions('cg-1', 'wm');
      expect(list).toEqual([
        { name: 'a:b.md', graphUri: `urn:dkg:assertion:cg-1:code:${agent}:a:b.md`, tripleCount: undefined, subGraph: 'code' },
      ]);
    });

    it('createSavedQuery sends POST', async () => {
      await createSavedQuery({ name: 'test', sparql: 'SELECT 1' });
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/saved-queries'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.name).toBe('test');
    });

    it('shutdownNode sends POST', async () => {
      await shutdownNode();
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/shutdown'));
      expect(call).toBeTruthy();
    });

    it('subscribeToContextGraph sends POST', async () => {
      await subscribeToContextGraph('cg-1');
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/subscribe'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
    });
  });

  // The Node UI mounts `useMemoryEntities` and `useProjectProfile` from
  // multiple sibling views simultaneously when a project is opened
  // (e.g. Dashboard card + ProjectView). Pre-dedup, each duplicate
  // fan-out hit `/api/query` separately and added seconds of wall-time
  // on a multi-GB Oxigraph store. These tests pin the contract that
  // `executeQuery` collapses concurrent identical POSTs to one fetch
  // while still firing fresh requests once a prior one settles.
  describe('executeQuery in-flight dedup', () => {
    it('coalesces concurrent identical queries to one /api/query POST', async () => {
      const results = await Promise.all([
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-dedup'),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-dedup'),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-dedup'),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-dedup'),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-dedup'),
      ]);
      const queryCalls = requestLog.filter(
        r => r.method === 'POST' && r.url.startsWith('/api/query'),
      );
      expect(queryCalls).toHaveLength(1);
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(r).toEqual({ result: { bindings: [] } });
      }
    });

    it('does not coalesce when args differ', async () => {
      await Promise.all([
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-a'),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-b'),
      ]);
      const queryCalls = requestLog.filter(
        r => r.method === 'POST' && r.url.startsWith('/api/query'),
      );
      expect(queryCalls).toHaveLength(2);
    });

    it('issues a fresh fetch once the prior request has settled', async () => {
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-sequential');
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-sequential');
      const queryCalls = requestLog.filter(
        r => r.method === 'POST' && r.url.startsWith('/api/query'),
      );
      expect(queryCalls).toHaveLength(2);
    });
  });

  // IMPORT_SOURCES test block removed — the constant was retired along
  // with /api/memory/import as part of the openclaw-dkg-primary-memory
  // work. See Dashboard / ui/api.ts for the deletion context.
});
