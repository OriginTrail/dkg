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
  readProfileQueryCatalog,
  writeProfileQueryCatalog,
  listAssertions,
  ensureContextGraphOnChain,
  fetchAssertionUals,
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
  createKnowledgeAsset,
  knowledgeAssetPublish,
  knowledgeAssetPublishWithSeal,
  publishAssertionsToVm,
  partialPublishWarning,
  knowledgeAssetFinalize,
  knowledgeAssetShare,
} from '../src/ui/api.js';

let server: Server;
let baseUrl: string;
const requestLog: Array<{ url: string; method: string; body: string }> = [];
let queryBindings: any[] = [];
// Scripted per-call responses (status + body) for tests that need a non-200
// reply, e.g. a fail-closed publish precondition. Each entry is consumed on
// first match (FIFO). Cleared in beforeEach.
type ResponseOverride = {
  match: (url: string, method: string, body: string) => boolean;
  status: number;
  body: unknown;
};
let responseOverrides: ResponseOverride[] = [];

function startTestServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const reqUrl = req.url ?? '';
        const reqMethod = req.method ?? '';
        requestLog.push({ url: reqUrl, method: reqMethod, body });

        // Scripted override (consumed on first match) — lets a test return a
        // specific failure or partial-success response.
        const ovIdx = responseOverrides.findIndex(o => o.match(reqUrl, reqMethod, body));
        if (ovIdx !== -1) {
          const [ov] = responseOverrides.splice(ovIdx, 1);
          res.writeHead(ov.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(ov.body));
          return;
        }

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
    responseOverrides = [];
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
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-1' });
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/query'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.sparql).toBe('SELECT * WHERE { ?s ?p ?o }');
      expect(body.contextGraphId).toBe('cg-1');
    });

    it('executeQuery sends the daemon working-memory view', async () => {
      await executeQuery(
        'SELECT ?incident WHERE { ?incident ?p ?o }',
        { contextGraphId: 'cg-listenerboi', view: 'working-memory' },
      );
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/query'));
      expect(JSON.parse(call?.body ?? '{}').view).toBe('working-memory');
    });

    it('executeQuery maps named scope and partition options into the request body', async () => {
      await executeQuery('SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }', {
        contextGraphId: 'cg-scoped',
        subGraphName: 'incidents',
        view: 'shared-working-memory',
        includeSharedMemory: true,
        includeContextGraphPartitions: true,
      });
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/query'));
      expect(JSON.parse(call?.body ?? '{}')).toEqual({
        sparql: 'SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } }',
        contextGraphId: 'cg-scoped',
        subGraphName: 'incidents',
        view: 'shared-working-memory',
        includeSharedMemory: true,
        includeContextGraphPartitions: true,
      });
    });

    it('readProfileQueryCatalog uses the dedicated profile endpoint', async () => {
      await readProfileQueryCatalog('cg-listenerboi');
      const call = requestLog.find(
        r => r.method === 'POST' && r.url.includes('/api/profile/query-catalog/read'),
      );
      expect(JSON.parse(call?.body ?? '{}')).toEqual({ contextGraphId: 'cg-listenerboi' });
    });

    it('writeProfileQueryCatalog requests subject-scoped upsert semantics', async () => {
      const quads = [{ subject: 'urn:q', predicate: 'urn:p', object: '"value"', graph: '' }];
      await writeProfileQueryCatalog('cg-listenerboi', quads);
      const call = requestLog.find(
        r => r.method === 'POST' && r.url.includes('/api/profile/query-catalog/write'),
      );
      expect(JSON.parse(call?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-listenerboi',
        mode: 'upsert',
        quads,
      });
    });

    it('knowledgeAssetPublish rejects non-decimal publisher identity overrides before POSTing', async () => {
      expect(() =>
        knowledgeAssetPublish('cg-1', 'f', { publisherNodeIdentityIdOverride: 'abc' }),
      ).toThrow('publisherNodeIdentityIdOverride must be passed as a decimal string');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetPublish rejects negative publisher identity overrides before POSTing', async () => {
      expect(() =>
        knowledgeAssetPublish('cg-1', 'f', { publisherNodeIdentityIdOverride: '-1' }),
      ).toThrow('publisherNodeIdentityIdOverride must be passed as a decimal string');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetPublish rejects unsupported publish options before POSTing', async () => {
      expect(() =>
        knowledgeAssetPublish('cg-1', 'f', { publishEpoch: 3 } as any),
      ).toThrow('Unsupported finalized publish option(s): publishEpoch');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetPublishWithSeal POSTs the canonical per-KA vm/publish (no seal when it succeeds)', async () => {
      await knowledgeAssetPublishWithSeal('cg-1', 'my-asset', { subGraphName: 'sg' });
      const publishCall = requestLog.find(
        r => r.method === 'POST' && r.url.includes('/api/knowledge-assets/my-asset/vm/publish'),
      );
      expect(publishCall).toBeTruthy();
      const body = JSON.parse(publishCall?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
      expect(body.subGraphName).toBe('sg');
      // Happy path: the asset is already sealed, so no wm/finalize is sent and
      // the legacy /api/shared-memory/publish bridge is never touched.
      expect(requestLog.some(r => r.url.includes('/wm/finalize'))).toBe(false);
      expect(requestLog.some(r => r.url.includes('/api/shared-memory/publish'))).toBe(false);
    });

    it('knowledgeAssetPublishWithSeal surfaces a VM_PUBLISH_PRECONDITION without mutating SWM or retrying', async () => {
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/a/vm/publish'),
        status: 409,
        body: { code: 'VM_PUBLISH_PRECONDITION', error: 'is not finalized' },
      });

      await expect(
        knowledgeAssetPublishWithSeal('cg-1', 'a', { subGraphName: 'sg' }),
      ).rejects.toMatchObject({
        status: 409,
        body: { code: 'VM_PUBLISH_PRECONDITION' },
      });

      expect(requestLog.some(r => r.url.includes('/wm/finalize'))).toBe(false);
      const publishCalls = requestLog.filter(r => r.method === 'POST' && r.url.includes('/vm/publish'));
      expect(publishCalls).toHaveLength(1);
    });

    it('knowledgeAssetPublishWithSeal surfaces a 207 partial publish (contextGraphError) without throwing', async () => {
      // The daemon returns HTTP 207 when the KA minted on-chain (confirmed +
      // txHash) but the context-graph binding failed. `post()` treats 207 as ok,
      // so the wrapper resolves; the result must carry `contextGraphError` so the
      // CTAs can render a partial/warning state instead of a clean success.
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/d/vm/publish'),
        status: 207,
        body: { kaId: '0xabc', status: 'confirmed', txHash: '0xdeadbeef', contextGraphError: 'binding failed' },
      });

      const res = await knowledgeAssetPublishWithSeal('cg-1', 'd');

      expect(res.status).toBe('confirmed');
      expect(res.txHash).toBe('0xdeadbeef');
      expect(res.contextGraphError).toBe('binding failed');
      // A 207 is returned directly without any SWM mutation.
      expect(requestLog.some(r => r.url.includes('/wm/finalize'))).toBe(false);
      expect(requestLog.filter(r => r.method === 'POST' && r.url.includes('/vm/publish'))).toHaveLength(1);
    });

    it('publishAssertionsToVm aggregates per-KA results: partial detail, clean sample, subGraph forwarding', async () => {
      // ka 'a' → clean confirm; ka 'b' (sub-graph) → 207 partial with a contextGraphError.
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/a/vm/publish'),
        status: 200,
        body: { kaId: '0xa', status: 'confirmed', txHash: '0xtxa' },
      });
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/b/vm/publish'),
        status: 207,
        body: { kaId: '0xb', status: 'confirmed', txHash: '0xtxb', contextGraphError: 'binding failed for b' },
      });

      const r = await publishAssertionsToVm('cg-1', [{ name: 'a' }, { name: 'b', subGraph: 'sg1' }]);

      expect(r.published).toBe(2);
      expect(r.total).toBe(2);
      expect(r.partial).toBe(1);
      // The first 207's contextGraphError detail is preserved (the drift the shared helper fixes).
      expect(r.partialError).toBe('binding failed for b');
      expect(r.failures).toHaveLength(0);
      // The headline sample prefers the fully-clean result (ka 'a'), not the partial 'b'.
      expect(r.sample?.txHash).toBe('0xtxa');
      expect(r.sample?.contextGraphError).toBeUndefined();
      // ka 'b' was published under its sub-graph (name + subGraphName forwarded by the loop).
      const bPublish = requestLog.find(rq => rq.method === 'POST' && rq.url.includes('/api/knowledge-assets/b/vm/publish'));
      expect(JSON.parse(bPublish!.body).subGraphName).toBe('sg1');
      // Neither KA drew on a PCA → no batch-level discount (badge stays hidden, #9).
      expect(r.convictionCostCovered).toBeUndefined();
    });

    it('publishAssertionsToVm SUMS convictionCostCovered across the batch (#1365 r3 — not off the sample)', async () => {
      // Both KAs draw a discount; the batch must SUM base/discounted (the true total saved),
      // independent of which item becomes the headline `sample`.
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/a/vm/publish'),
        status: 200,
        body: { kaId: '0xa', status: 'confirmed', txHash: '0xtxa', convictionCostCovered: { accountId: '7', epoch: 1284, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' } },
      });
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/b/vm/publish'),
        status: 200,
        body: { kaId: '0xb', status: 'confirmed', txHash: '0xtxb', convictionCostCovered: { accountId: '7', epoch: 1285, baseCost: '2000', discountedCost: '1500', drawnFromEpoch: '1500', drawnFromTopUp: '0' } },
      });

      const r = await publishAssertionsToVm('cg-1', [{ name: 'a' }, { name: 'b' }]);

      expect(r.convictionCostCovered).toBeDefined();
      expect(r.convictionCostCovered!.accountId).toBe('7');
      expect(r.convictionCostCovered!.epoch).toBeUndefined(); // mixed epochs are not attributed to the first event
      expect(r.convictionCostCovered!.baseCost).toBe('3000'); // 1000 + 2000
      expect(r.convictionCostCovered!.discountedCost).toBe('2200'); // 700 + 1500
      expect(r.convictionCostCovered!.drawnFromEpoch).toBe('2200'); // 700 + 1500
    });

    it('publishAssertionsToVm omits single-PCA attribution for mixed-account batch discounts', async () => {
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/a/vm/publish'),
        status: 200,
        body: { kaId: '0xa', status: 'confirmed', txHash: '0xtxa', convictionCostCovered: { accountId: '7', epoch: 1284, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' } },
      });
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/b/vm/publish'),
        status: 200,
        body: { kaId: '0xb', status: 'confirmed', txHash: '0xtxb', convictionCostCovered: { accountId: '8', epoch: 1284, baseCost: '2000', discountedCost: '1000', drawnFromEpoch: '1000', drawnFromTopUp: '0' } },
      });

      const r = await publishAssertionsToVm('cg-1', [{ name: 'a' }, { name: 'b' }]);

      expect(r.convictionCostCovered).toBeDefined();
      expect(r.convictionCostCovered!.accountId).toBeUndefined();
      expect(r.convictionCostCovered!.epoch).toBe(1284);
      expect(r.convictionCostCovered!.baseCost).toBe('3000');
      expect(r.convictionCostCovered!.discountedCost).toBe('1700');
      expect(r.convictionCostCovered!.drawnFromEpoch).toBe('1700');
    });

    it('publishAssertionsToVm collects each per-KA failure into failures[] (named) and keeps going', async () => {
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/x/vm/publish'),
        status: 500,
        body: { error: 'boom' },
      });
      responseOverrides.push({
        match: (url, method) => method === 'POST' && url.includes('/api/knowledge-assets/y/vm/publish'),
        status: 200,
        body: { kaId: '0xy', status: 'confirmed', txHash: '0xtxy' },
      });

      const r = await publishAssertionsToVm('cg-1', [{ name: 'x' }, { name: 'y' }]);

      // 'x' failed but the loop kept going and published 'y'; the failure is captured
      // (named) in failures[], not thrown and not collapsed to a single lastError.
      expect(r.published).toBe(1);
      expect(r.total).toBe(2);
      expect(r.failures).toHaveLength(1);
      expect(r.failures[0].name).toBe('x');
      expect(r.failures[0].error).toBeTruthy();
      expect(r.sample?.txHash).toBe('0xtxy');
    });

    it('partialPublishWarning explains the 207 accurately and never suggests republishing', () => {
      const withDetail = partialPublishWarning('binding failed');
      // The KA is already minted; re-publishing does NOT repair the binding, so
      // the copy must NOT tell the user to republish/retry.
      expect(withDetail).not.toMatch(/republish|re-publish|try again|retry/i);
      expect(withDetail).toMatch(/on-chain/i);
      expect(withDetail).toMatch(/context graph/i);
      expect(withDetail).toContain('binding failed'); // appends the daemon detail
      // Works without a detail string too.
      expect(partialPublishWarning()).not.toMatch(/republish|re-publish|retry/i);
      expect(partialPublishWarning()).not.toContain('(');
    });

    it('createKnowledgeAsset normalizes context graph URIs before POSTing', async () => {
      await createKnowledgeAsset('did:dkg:context-graph:cg-1', 'f');
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/knowledge-assets'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.contextGraphId).toBe('cg-1');
      expect(body.name).toBe('f');
    });

    it('createKnowledgeAsset rejects mutually exclusive authorship fields before POSTing', () => {
      expect(() =>
        createKnowledgeAsset('cg-1', 'f', {
          authorAgentAddress: '0xauthor',
          preSignedAuthorAttestation: { address: '0xauthor', signature: { r: '0xr', vs: '0xvs' } },
        }),
      ).toThrow('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
      expect(requestLog).toHaveLength(0);
    });

    it('createKnowledgeAsset rejects finalized publish fields without quads before POSTing', () => {
      expect(() =>
        createKnowledgeAsset('cg-1', 'f', {
          authorAgentAddress: '0xauthor',
        }),
      ).toThrow('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads');
      expect(requestLog).toHaveLength(0);
    });

    it('createKnowledgeAsset treats empty alsoPublishVm options as default publish', async () => {
      await createKnowledgeAsset('cg-1', 'f', { alsoPublishVm: {} });
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/knowledge-assets'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body.alsoPublishVm).toEqual({});
    });

    it('createKnowledgeAsset rejects unsupported alsoPublishVm options before POSTing', () => {
      expect(() =>
        createKnowledgeAsset('cg-1', 'f', { alsoPublishVm: { publishEpoch: 3 } as any }),
      ).toThrow('Unsupported finalized publish option(s): publishEpoch');
      expect(requestLog).toHaveLength(0);
    });

    it('createKnowledgeAsset rejects array alsoPublishVm before POSTing', () => {
      expect(() =>
        createKnowledgeAsset('cg-1', 'f', { alsoPublishVm: [] as any }),
      ).toThrow('alsoPublishVm must be a boolean or publish-options object');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetFinalize rejects mutually exclusive authorship fields before POSTing', () => {
      expect(() =>
        knowledgeAssetFinalize('cg-1', 'f', {
          authorAgentAddress: '0xauthor',
          preSignedAuthorAttestation: { address: '0xauthor', signature: { r: '0xr', vs: '0xvs' } },
        }),
      ).toThrow('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetFinalize rejects legacy SWM finalization before POSTing', () => {
      expect(() =>
        knowledgeAssetFinalize('cg-1', 'legacy', { layer: 'swm' } as any),
      ).toThrow('Legacy root-scoped Knowledge Assets are read-only');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetFinalize accepts neutral layer:wm but omits it from the wire', async () => {
      await knowledgeAssetFinalize('cg-1', 'asset', { layer: 'wm' });
      expect(JSON.parse(requestLog[0]?.body ?? '{}')).toEqual({ contextGraphId: 'cg-1' });
    });

    it('knowledgeAssetShare sends only atomic scope and rejects root-entity subsets before POSTing', async () => {
      await knowledgeAssetShare('cg-1', 'asset', {
        subGraphName: 'sg',
        entities: 'all', // compatibility-only neutral value
      } as any);
      const call = requestLog.find(r => r.url.includes('/api/knowledge-assets/asset/swm/share'));
      expect(JSON.parse(call?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg',
        awaitCuratorAck: true,
      });

      requestLog.length = 0;
      expect(() =>
        knowledgeAssetShare('cg-1', 'asset', { entities: ['urn:root'] } as any),
      ).toThrow('root-entity selection is not supported');
      expect(requestLog).toHaveLength(0);

      expect(() =>
        knowledgeAssetShare('cg-1', 'asset', { skipSeal: true } as any),
      ).toThrow('always sealed before sharing');
      expect(requestLog).toHaveLength(0);
    });

    it('knowledgeAssetShare preserves an explicit curator-ACK opt-out and rejects invalid values', async () => {
      await knowledgeAssetShare('cg-1', 'asset', {
        subGraphName: 'sg',
        awaitCuratorAck: false,
      });
      expect(JSON.parse(requestLog[0]?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg',
        awaitCuratorAck: false,
      });

      requestLog.length = 0;
      expect(() =>
        knowledgeAssetShare('cg-1', 'asset', { awaitCuratorAck: 'false' } as any),
      ).toThrow('awaitCuratorAck must be a boolean');
      expect(requestLog).toHaveLength(0);
    });

    it('promoteAssertion shares the complete owning KA and never silently widens a legacy subset', async () => {
      await promoteAssertion('cg-1', 'asset', { subGraphName: 'sg' });
      const call = requestLog.find(r => r.url.includes('/api/knowledge-assets/asset/swm/share'));
      expect(JSON.parse(call?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg',
        awaitCuratorAck: true,
      });

      requestLog.length = 0;
      await promoteAssertion('cg-1', 'explicit-opt-out', {
        subGraphName: 'sg-no-ack',
        awaitCuratorAck: false,
      });
      expect(JSON.parse(requestLog[0]?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg-no-ack',
        awaitCuratorAck: false,
      });

      requestLog.length = 0;
      await promoteAssertion('cg-1', 'legacy-caller', 'all', 'sg-legacy');
      expect(JSON.parse(requestLog[0]?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg-legacy',
        awaitCuratorAck: true,
      });

      requestLog.length = 0;
      await promoteAssertion('cg-1', 'undefined-placeholder', undefined, 'sg-from-fourth-arg');
      expect(JSON.parse(requestLog[0]?.body ?? '{}')).toEqual({
        contextGraphId: 'cg-1',
        subGraphName: 'sg-from-fourth-arg',
        awaitCuratorAck: true,
      });

      requestLog.length = 0;
      expect(() => promoteAssertion('cg-1', 'asset', ['urn:root'])).toThrow(
        'root-entity selection is not supported',
      );
      expect(requestLog).toHaveLength(0);
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

    it('listAssertions(swm) reads the memoryLayer "SWM" marker (not async ShareTransition records)', async () => {
      // The SWM listing must use the synchronous _meta memoryLayer marker, not
      // _shared_memory_meta ShareTransition records which lag the promote and
      // made "Publish to VM" report "nothing to publish" right after promoting.
      const agent = '0x' + '4'.repeat(40);
      queryBindings = [{ g: { value: `urn:dkg:assertion:cg-1:${agent}:shared-doc.md` } }];
      const list = await listAssertions('cg-1', 'swm');
      expect(list.map(a => a.name)).toEqual(['shared-doc.md']);
    });

    it('listAssertions(swm) excludes assertions already published to VM (dkg:vmCurrentAssertion)', async () => {
      // Publish records a vmCurrentAssertion pointer but does NOT flip memoryLayer
      // off "SWM" (backend gap), so the SWM list must drop published rows itself.
      const agent = '0x' + '5'.repeat(40);
      queryBindings = [
        { g: { value: `urn:dkg:assertion:cg-1:${agent}:unpublished.md` } },
        { g: { value: `urn:dkg:assertion:cg-1:${agent}:published.md` }, vm: { value: 'abc123deadbeef' } },
      ];
      const list = await listAssertions('cg-1', 'swm');
      expect(list.map(a => a.name)).toEqual(['unpublished.md']);
    });

    it('fetchAssertionUals maps assertionName -> reservedUal (shown next to the filename)', async () => {
      queryBindings = [
        { name: { value: 'spec.md' }, ual: { value: 'did:dkg:evm:31337/0xabc/7' } },
        { name: { value: 'demo.md' }, ual: { value: 'did:dkg:evm:31337/0xabc/8' } },
      ];
      const map = await fetchAssertionUals('cg-1');
      expect(map['spec.md']).toBe('did:dkg:evm:31337/0xabc/7');
      expect(map['demo.md']).toBe('did:dkg:evm:31337/0xabc/8');
    });

    it('ensureContextGraphOnChain auto-registers an off-chain CG before publishing', async () => {
      // mock /api/context-graph/list returns cg1 with no onChainId → the helper
      // must POST /api/context-graph/register so VM publish (on-chain) can proceed.
      await ensureContextGraphOnChain('cg1');
      expect(requestLog.some(r => r.method === 'POST' && r.url.includes('/api/context-graph/register'))).toBe(true);
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
      expect(body.syncMode).toBe('on-demand');
    });

    it('subscribeToContextGraph forwards an explicit always-on choice', async () => {
      await subscribeToContextGraph('cg-1', { syncMode: 'always-on' });
      const call = requestLog.find(r => r.method === 'POST' && r.url.includes('/api/subscribe'));
      const body = JSON.parse(call?.body ?? '{}');
      expect(body).toEqual({ contextGraphId: 'cg-1', syncMode: 'always-on' });
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
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-dedup' }),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-dedup' }),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-dedup' }),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-dedup' }),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-dedup' }),
      ]);
      const queryCalls = requestLog.filter(
        r => r.method === 'POST' && r.url.startsWith('/api/query'),
      );
      expect(queryCalls).toHaveLength(1);
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(r).toEqual({ result: { type: 'bindings', bindings: [] } });
      }
    });

    it('normalizes current and legacy query result shapes at the API boundary', async () => {
      responseOverrides.push(
        {
          match: (url) => url.startsWith('/api/query'),
          status: 200,
          body: { result: { bindings: [{ result: 'false' }] } },
        },
        {
          match: (url) => url.startsWith('/api/query'),
          status: 200,
          body: { result: { type: 'quads', quads: [{ subject: 's', predicate: 'p', object: 'o' }] } },
        },
      );

      await expect(executeQuery('ASK { ?s ?p ?o }')).resolves.toEqual({
        result: { type: 'boolean', value: false },
      });
      await expect(executeQuery('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).resolves.toEqual({
        result: { type: 'quads', quads: [{ subject: 's', predicate: 'p', object: 'o' }] },
      });
    });

    it('does not coalesce when args differ', async () => {
      await Promise.all([
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-a' }),
        executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-b' }),
      ]);
      const queryCalls = requestLog.filter(
        r => r.method === 'POST' && r.url.startsWith('/api/query'),
      );
      expect(queryCalls).toHaveLength(2);
    });

    it('issues a fresh fetch once the prior request has settled', async () => {
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-sequential' });
      await executeQuery('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'cg-sequential' });
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
