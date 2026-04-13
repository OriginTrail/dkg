import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  IMPORT_SOURCES,
  gameApi,
} from '../src/ui/api.js';

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

beforeEach(() => {
  (globalThis as any).fetch = mockFetch({});
});

afterEach(() => {
  vi.restoreAllMocks();
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
    (globalThis as any).fetch = mockFetch({ peerId: 'abc', synced: true });
    const res = await fetchStatus();
    expect(res).toEqual({ peerId: 'abc', synced: true });
    expect(fetch).toHaveBeenCalledWith('/api/status', expect.any(Object));
  });

  it('fetchAgents calls /api/agents', async () => {
    (globalThis as any).fetch = mockFetch({ agents: [] });
    await fetchAgents();
    expect(fetch).toHaveBeenCalledWith('/api/agents', expect.any(Object));
  });

  it('fetchMetrics calls /api/metrics', async () => {
    (globalThis as any).fetch = mockFetch({ total_kcs: 5 });
    const res = await fetchMetrics();
    expect(res.total_kcs).toBe(5);
  });

  it('fetchConnections calls /api/connections', async () => {
    (globalThis as any).fetch = mockFetch({ peers: [] });
    await fetchConnections();
    expect(fetch).toHaveBeenCalledWith('/api/connections', expect.any(Object));
  });

  it('fetchLlmSettings calls /api/settings/llm', async () => {
    (globalThis as any).fetch = mockFetch({ model: 'gpt-4' });
    const res = await fetchLlmSettings();
    expect(res.model).toBe('gpt-4');
  });

  it('fetchRetentionSettings calls /api/settings/retention', async () => {
    (globalThis as any).fetch = mockFetch({ retentionDays: 30 });
    const res = await fetchRetentionSettings();
    expect(res.retentionDays).toBe(30);
  });

  it('fetchTelemetrySettings calls /api/settings/telemetry', async () => {
    (globalThis as any).fetch = mockFetch({ enabled: true });
    const res = await fetchTelemetrySettings();
    expect(res.enabled).toBe(true);
  });

  it('fetchApps calls /api/apps', async () => {
    (globalThis as any).fetch = mockFetch({ apps: [] });
    await fetchApps();
    expect(fetch).toHaveBeenCalledWith('/api/apps', expect.any(Object));
  });

  it('fetchRpcHealth calls /api/rpc-health', async () => {
    (globalThis as any).fetch = mockFetch({ healthy: true });
    await fetchRpcHealth();
    expect(fetch).toHaveBeenCalledWith('/api/chain/rpc-health', expect.any(Object));
  });

  it('fetchEconomics calls /api/economics', async () => {
    (globalThis as any).fetch = mockFetch({ periods: [] });
    await fetchEconomics();
    expect(fetch).toHaveBeenCalledWith('/api/economics', expect.any(Object));
  });

  it('fetchWalletsBalances calls /api/wallets/balances', async () => {
    (globalThis as any).fetch = mockFetch({ wallets: [] });
    await fetchWalletsBalances();
    expect(fetch).toHaveBeenCalledWith('/api/wallets/balances', expect.any(Object));
  });

  it('fetchSavedQueries calls /api/saved-queries', async () => {
    (globalThis as any).fetch = mockFetch({ queries: [] });
    await fetchSavedQueries();
    expect(fetch).toHaveBeenCalledWith('/api/saved-queries', expect.any(Object));
  });
});

describe('parameterized GET endpoints', () => {
  it('fetchOperations includes query params', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [], total: 0 });
    await fetchOperations({ limit: '10' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/api/operations?');
    expect(url).toContain('limit=10');
  });

  it('fetchOperations with no params omits query string', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [], total: 0 });
    await fetchOperations();
    expect(fetch).toHaveBeenCalledWith('/api/operations', expect.any(Object));
  });

  it('fetchOperationsWithPhases adds phases=1', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [], total: 0 });
    await fetchOperationsWithPhases({ limit: '5' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('phases=1');
    expect(url).toContain('limit=5');
  });

  it('fetchOperation calls /api/operations/:id', async () => {
    (globalThis as any).fetch = mockFetch({ operation: {}, logs: [], phases: [] });
    await fetchOperation('op-123');
    expect(fetch).toHaveBeenCalledWith('/api/operations/op-123', expect.any(Object));
  });

  it('fetchErrorHotspots with period', async () => {
    (globalThis as any).fetch = mockFetch({ hotspots: [] });
    await fetchErrorHotspots(3600000);
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('periodMs=3600000');
  });

  it('fetchErrorHotspots without period', async () => {
    (globalThis as any).fetch = mockFetch({ hotspots: [] });
    await fetchErrorHotspots();
    expect(fetch).toHaveBeenCalledWith('/api/error-hotspots', expect.any(Object));
  });

  it('fetchLogs with params', async () => {
    (globalThis as any).fetch = mockFetch({ logs: [], total: 0 });
    await fetchLogs({ level: 'error' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('level=error');
  });

  it('fetchNodeLog with lines', async () => {
    (globalThis as any).fetch = mockFetch({ lines: [], totalSize: 0 });
    await fetchNodeLog({ lines: 100 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('lines=100');
  });

  it('fetchNodeLog with q filter', async () => {
    (globalThis as any).fetch = mockFetch({ lines: [], totalSize: 0 });
    await fetchNodeLog({ q: 'error' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('q=error');
  });

  it('fetchCatchupStatus calls correct endpoint', async () => {
    (globalThis as any).fetch = mockFetch({ jobId: 'j1', status: 'done' });
    await fetchCatchupStatus('cg-1');
    expect(fetch).toHaveBeenCalledWith('/api/sync/catchup-status?contextGraphId=cg-1', expect.any(Object));
  });

  it('fetchSuccessRates calls correct endpoint', async () => {
    (globalThis as any).fetch = mockFetch({ rates: [] });
    await fetchSuccessRates(60000);
    expect(fetch).toHaveBeenCalledWith('/api/success-rates?periodMs=60000', expect.any(Object));
  });

  it('fetchMetricsHistory includes from/to/maxPoints', async () => {
    (globalThis as any).fetch = mockFetch({ snapshots: [] });
    await fetchMetricsHistory(1000, 2000, 50);
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('from=1000');
    expect(url).toContain('to=2000');
    expect(url).toContain('maxPoints=50');
  });

  it('fetchPerTypeStats with optional bucketMs', async () => {
    (globalThis as any).fetch = mockFetch({ buckets: [], types: [], series: {} });
    await fetchPerTypeStats(60000, 5000);
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('periodMs=60000');
    expect(url).toContain('bucketMs=5000');
  });

  it('fetchPerTypeStats without bucketMs', async () => {
    (globalThis as any).fetch = mockFetch({ buckets: [], types: [], series: {} });
    await fetchPerTypeStats(60000);
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('periodMs=60000');
    expect(url).not.toContain('bucketMs');
  });
});

describe('fetchContextGraphs', () => {
  it('maps paranets to contextGraphs', async () => {
    (globalThis as any).fetch = mockFetch({ paranets: [{ id: 'p1', name: 'Test' }] });
    const res = await fetchContextGraphs();
    expect(res.contextGraphs).toEqual([{ id: 'p1', name: 'Test' }]);
  });

  it('prefers contextGraphs over paranets', async () => {
    (globalThis as any).fetch = mockFetch({ contextGraphs: [{ id: 'cg1' }], paranets: [{ id: 'p1' }] });
    const res = await fetchContextGraphs();
    expect(res.contextGraphs[0].id).toBe('cg1');
  });

  it('filters out system context graphs', async () => {
    (globalThis as any).fetch = mockFetch({
      contextGraphs: [{ id: 'user', isSystem: false }, { id: 'sys', isSystem: true }],
    });
    const res = await fetchContextGraphs();
    expect(res.contextGraphs).toHaveLength(1);
    expect(res.contextGraphs[0].id).toBe('user');
  });
});

describe('notification endpoints', () => {
  it('fetchNotifications with since param', async () => {
    (globalThis as any).fetch = mockFetch({ notifications: [] });
    await fetchNotifications({ since: 1000 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('since=1000');
  });

  it('fetchNotifications with limit param', async () => {
    (globalThis as any).fetch = mockFetch({ notifications: [] });
    await fetchNotifications({ limit: 5 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('limit=5');
  });

  it('fetchNotifications with no params', async () => {
    (globalThis as any).fetch = mockFetch({ notifications: [] });
    await fetchNotifications();
    expect(fetch).toHaveBeenCalledWith('/api/notifications', expect.any(Object));
  });

  it('markNotificationsRead with ids', async () => {
    (globalThis as any).fetch = mockFetch({ ok: true });
    await markNotificationsRead([1, 2, 3]);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.ids).toEqual([1, 2, 3]);
  });

  it('markNotificationsRead without ids sends empty body', async () => {
    (globalThis as any).fetch = mockFetch({ ok: true });
    await markNotificationsRead();
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.ids).toBeUndefined();
  });
});

describe('POST endpoints', () => {
  it('executeQuery sends sparql and contextGraphId', async () => {
    (globalThis as any).fetch = mockFetch({ result: { bindings: [] } });
    await executeQuery('SELECT * WHERE { ?s ?p ?o }', 'cg-1');
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.sparql).toBe('SELECT * WHERE { ?s ?p ?o }');
    expect(body.contextGraphId).toBe('cg-1');
  });

  it('publishTriples writes then publishes', async () => {
    (globalThis as any).fetch = mockFetch({ success: true });
    await publishTriples('cg-1', [{ s: 'a', p: 'b', o: 'c' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const call1Url = (fetch as any).mock.calls[0][0] as string;
    const call2Url = (fetch as any).mock.calls[1][0] as string;
    expect(call1Url).toContain('/api/shared-memory/write');
    expect(call2Url).toContain('/api/shared-memory/publish');
  });

  it('publishSharedMemory sends contextGraphId', async () => {
    (globalThis as any).fetch = mockFetch({ ual: 'did:dkg:test' });
    await publishSharedMemory('cg-1');
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.contextGraphId).toBe('cg-1');
  });

  it('promoteAssertion sends correct params', async () => {
    (globalThis as any).fetch = mockFetch({ promotedCount: 1 });
    await promoteAssertion('cg-1', 'assertion-1', 'all');
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/api/assertion/assertion-1/promote');
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.contextGraphId).toBe('cg-1');
    expect(body.entities).toBe('all');
  });

  it('createSavedQuery sends POST', async () => {
    (globalThis as any).fetch = mockFetch({ id: 1 });
    await createSavedQuery({ name: 'test', sparql: 'SELECT 1' });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.name).toBe('test');
  });

  it('shutdownNode sends POST', async () => {
    (globalThis as any).fetch = mockFetch({});
    await shutdownNode();
    expect((fetch as any).mock.calls[0][1].method).toBe('POST');
  });

  it('subscribeToContextGraph sends POST', async () => {
    (globalThis as any).fetch = mockFetch({});
    await subscribeToContextGraph('cg-1');
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.contextGraphId).toBe('cg-1');
  });

  it('fetchExtractionStatus calls correct endpoint', async () => {
    (globalThis as any).fetch = mockFetch({ fileHash: 'sha256:abc', detectedContentType: 'text/plain' });
    await fetchExtractionStatus('a1', 'cg-1');
    expect(fetch).toHaveBeenCalledWith('/api/assertion/a1/extraction-status?contextGraphId=cg-1', expect.any(Object));
  });

  it('fetchQueryHistory calls correct endpoint', async () => {
    (globalThis as any).fetch = mockFetch({ history: [] });
    await fetchQueryHistory(10, 5);
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });
});

describe('fetchFailedOperations', () => {
  it('sends phase filter', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [] });
    await fetchFailedOperations({ phase: 'publish' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('phase=publish');
  });

  it('sends operationName filter', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [] });
    await fetchFailedOperations({ operationName: 'PUBLISH' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('operationName=PUBLISH');
  });

  it('sends all filters', async () => {
    (globalThis as any).fetch = mockFetch({ operations: [] });
    await fetchFailedOperations({ phase: 'p', operationName: 'o', periodMs: 1000, q: 'err', limit: 5 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('phase=p');
    expect(url).toContain('operationName=o');
    expect(url).toContain('periodMs=1000');
    expect(url).toContain('q=err');
    expect(url).toContain('limit=5');
  });
});

describe('fetchOperationStats', () => {
  it('sends name filter', async () => {
    (globalThis as any).fetch = mockFetch({ summary: {}, timeSeries: [] });
    await fetchOperationStats({ name: 'PUBLISH' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('name=PUBLISH');
  });

  it('sends periodMs filter', async () => {
    (globalThis as any).fetch = mockFetch({ summary: {}, timeSeries: [] });
    await fetchOperationStats({ periodMs: 60000 });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('periodMs=60000');
  });
});

describe('listSwmEntities', () => {
  it('uses shared-working-memory view', async () => {
    (globalThis as any).fetch = mockFetch({ result: { bindings: [] } });
    await listSwmEntities('cg-1');
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.view).toBe('shared-working-memory');
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

describe('IMPORT_SOURCES', () => {
  it('contains expected sources', () => {
    expect(IMPORT_SOURCES).toContain('claude');
    expect(IMPORT_SOURCES).toContain('chatgpt');
    expect(IMPORT_SOURCES).toContain('gemini');
    expect(IMPORT_SOURCES).toContain('other');
  });
});
