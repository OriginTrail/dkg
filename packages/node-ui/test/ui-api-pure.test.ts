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
  fetchLogs,
  fetchNodeLog,
  fetchConnections,
  fetchLlmSettings,
  fetchRetentionSettings,
  fetchTelemetrySettings,
  fetchCatchupStatus,
  fetchNotifications,
  markNotificationsRead,
  fetchApps,
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
  gameApi,
} from '../src/ui/api.js';

let server: Server;
let baseUrl: string;
const requestLog: Array<{ url: string; method: string; body: string }> = [];

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
        } else if (url.startsWith('/api/settings/llm')) {
          res.end(JSON.stringify({ model: 'gpt-4' }));
        } else if (url.startsWith('/api/settings/retention')) {
          res.end(JSON.stringify({ retentionDays: 30 }));
        } else if (url.startsWith('/api/settings/telemetry')) {
          res.end(JSON.stringify({ enabled: true }));
        } else if (url.startsWith('/api/apps')) {
          res.end(JSON.stringify({ apps: [] }));
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
        } else if (url.startsWith('/api/logs')) {
          res.end(JSON.stringify({ logs: [], total: 0 }));
        } else if (url.startsWith('/api/node-log')) {
          res.end(JSON.stringify({ lines: [], totalSize: 0 }));
        } else if (url.startsWith('/api/sync/catchup-status')) {
          res.end(JSON.stringify({ jobId: 'j1', status: 'done' }));
        } else if (url.startsWith('/api/notifications')) {
          res.end(JSON.stringify({ notifications: [], ok: true }));
        } else if (url.startsWith('/api/success-rates')) {
          res.end(JSON.stringify({ rates: [] }));
        } else if (url.startsWith('/api/per-type-stats')) {
          res.end(JSON.stringify({ buckets: [], types: [], series: {} }));
        } else if (url.startsWith('/api/context-graphs') || url.startsWith('/api/paranets')) {
          res.end(JSON.stringify({ contextGraphs: [{ id: 'cg1' }], paranets: [{ id: 'p1', name: 'Test' }] }));
        } else if (url.startsWith('/api/query')) {
          res.end(JSON.stringify({ result: { bindings: [] } }));
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

    it('fetchLlmSettings calls /api/settings/llm', async () => {
      const res = await fetchLlmSettings();
      expect(res.model).toBe('gpt-4');
    });

    it('fetchRetentionSettings calls /api/settings/retention', async () => {
      const res = await fetchRetentionSettings();
      expect(res.retentionDays).toBe(30);
    });

    it('fetchTelemetrySettings calls /api/settings/telemetry', async () => {
      const res = await fetchTelemetrySettings();
      expect(res.enabled).toBe(true);
    });

    it('fetchApps calls /api/apps', async () => {
      await fetchApps();
      expect(requestLog.some(r => r.url.startsWith('/api/apps'))).toBe(true);
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

    it('fetchLogs with params', async () => {
      await fetchLogs({ level: 'error' });
      const call = requestLog.find(r => r.url.includes('/api/logs'));
      expect(call?.url).toContain('level=error');
    });

    it('fetchNodeLog with lines', async () => {
      await fetchNodeLog({ lines: 100 });
      const call = requestLog.find(r => r.url.includes('/api/node-log'));
      expect(call?.url).toContain('lines=100');
    });

    it('fetchCatchupStatus calls correct endpoint', async () => {
      await fetchCatchupStatus('cg-1');
      expect(requestLog.some(r => r.url.includes('contextGraphId=cg-1'))).toBe(true);
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

    it('publishSharedMemory sends contextGraphId', async () => {
      await publishSharedMemory('cg-1');
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/shared-memory/publish'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
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

  describe('gameApi', () => {
    it('exports expected methods', () => {
      expect(gameApi).toHaveProperty('lobby');
      expect(gameApi).toHaveProperty('join');
      expect(gameApi).toHaveProperty('leave');
      expect(gameApi).toHaveProperty('create');
      expect(gameApi).toHaveProperty('info');
      expect(gameApi).toHaveProperty('swarm');
    });
  });

  // IMPORT_SOURCES test block removed — the constant was retired along
  // with /api/memory/import as part of the openclaw-dkg-primary-memory
  // work. See Dashboard / ui/api.ts for the deletion context.
});
