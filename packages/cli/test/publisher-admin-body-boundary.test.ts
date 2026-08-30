import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { SAFE_JOB_ID_ERROR } from '@origintrail-official/dkg-publisher';

// #1890 — the four publisher admin POST routes now share one request-body boundary
// (readSmallJsonObject). This pins each route's body handling — importantly the previously
// unpinned cancel/retry/clear edges: a `null`/non-object body is normalized to `{}` (so it
// yields the route's bounded 4xx/2xx instead of a destructure TypeError → 500), while every
// route keeps its own field validation + response shape. clear-job's wire contract is
// asserted byte-identical (also guarded end-to-end by publisher-clear-job-route.test.ts).
describe('#1890 publisher admin POST body boundary', () => {
  function control(
    overrides: Partial<NonNullable<RequestContext['publisherControl']>> = {},
  ): RequestContext['publisherControl'] {
    return {
      cancel: async () => {},
      // GH#2270 — the route reads the DETAILED disposition; `retry` stays on the fake
      // because it is still the base-contract method (delegating to this one in the real
      // publisher), and a body-boundary row must not depend on which one the route picked.
      retry: async () => 3,
      retryDetailed: async (filter) => filter?.jobId === 'lift-job-7'
        ? { retried: 1, blockedPendingRecovery: 0, skipped: 0 }
        : { retried: 3, blockedPendingRecovery: 1, skipped: 2 },
      clear: async () => 2,
      clearTerminalJob: async () => ({ outcome: 'already_absent' as const }),
      ...overrides,
    } as unknown as RequestContext['publisherControl'];
  }

  async function post(
    path: string,
    rawBody: string,
    publisherControl = control(),
  ) {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = Readable.from([]);
    Object.assign(req, {
      method: 'POST', url: path, headers: { host: '127.0.0.1' },
      __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8'),
    });
    const res = {
      statusCode: 0, body: '', headers: undefined as Record<string, string> | undefined, writableEnded: false,
      writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; },
      end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
    };
    const ctx = {
      req: req as RequestContext['req'],
      res: res as unknown as ServerResponse,
      agent: {} as RequestContext['agent'],
      publisherControl,
      publisherState: { runtime: null, availability: { available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true } },
      config: {} as RequestContext['config'],
      startedAt: 0,
      dashDb: {} as RequestContext['dashDb'],
      opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
      network: null as RequestContext['network'],
      tracker: {} as RequestContext['tracker'],
      memoryManager: {} as RequestContext['memoryManager'],
      bridgeAuthToken: undefined,
      nodeVersion: 'test', nodeCommit: 'test',
      catchupTracker: {} as RequestContext['catchupTracker'],
      extractionRegistry: {} as RequestContext['extractionRegistry'],
      fileStore: {} as RequestContext['fileStore'],
      extractionStatus: new Map(),
      assertionImportLocks: new Map(),
      vectorStore: {} as RequestContext['vectorStore'],
      embeddingProvider: null,
      validTokens: new Set<string>(),
      apiHost: '127.0.0.1', apiPortRef: { value: 0 },
      url, path: url.pathname,
      requestToken: undefined, requestAgentAddress: '0x0',
    } as unknown as RequestContext;
    await handlePublisherRoutes(ctx);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {} };
  }

  describe('cancel', () => {
    it('valid jobId → 200 cancelled', async () => {
      expect(await post('/api/publisher/cancel', JSON.stringify({ jobId: 'j1' }))).toEqual({ status: 200, body: { cancelled: 'j1' } });
    });
    it('missing jobId → 400', async () => {
      expect(await post('/api/publisher/cancel', '{}')).toEqual({ status: 400, body: { error: 'Missing jobId' } });
    });
    it('invalid JSON → 400 Invalid JSON body', async () => {
      expect(await post('/api/publisher/cancel', '{bad')).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });
    });
    it('null body → 400 (hardened, not a 500)', async () => {
      expect(await post('/api/publisher/cancel', 'null')).toEqual({ status: 400, body: { error: 'Missing jobId' } });
    });
    it('empty body → 400 Missing jobId (hardened, not a 500)', async () => {
      expect(await post('/api/publisher/cancel', '')).toEqual({ status: 400, body: { error: 'Missing jobId' } });
    });
  });

  describe('retry', () => {
    it('empty object body {} → 200 retried', async () => {
      expect(await post('/api/publisher/retry', '{}')).toEqual({ status: 200, body: { retried: 3, blockedPendingRecovery: 1, skipped: 2 } });
    });
    it('empty body → 200 retried (hardened, not a 500)', async () => {
      expect(await post('/api/publisher/retry', '')).toEqual({ status: 200, body: { retried: 3, blockedPendingRecovery: 1, skipped: 2 } });
    });
    it('unsupported status → 400', async () => {
      expect(await post('/api/publisher/retry', JSON.stringify({ status: 'queued' }))).toEqual({ status: 400, body: { error: 'Only status=failed is supported' } });
    });
    it('exact jobId → retries only the selected job', async () => {
      expect(await post('/api/publisher/retry', JSON.stringify({
        status: 'failed',
        jobId: 'lift-job-7',
      }))).toEqual({
        status: 200,
        body: { retried: 1, blockedPendingRecovery: 0, skipped: 0 },
      });
    });
    it('invalid jobId → 400', async () => {
      expect(await post('/api/publisher/retry', JSON.stringify({ status: 'failed', jobId: 42 }))).toEqual({
        status: 400,
        body: { error: SAFE_JOB_ID_ERROR },
      });
    });
    it('empty jobId → 400 without broadening to retry-all', async () => {
      expect(await post('/api/publisher/retry', JSON.stringify({ status: 'failed', jobId: '' }))).toEqual({
        status: 400,
        body: { error: SAFE_JOB_ID_ERROR },
      });
    });
    it('rejects unsafe and overlength jobIds before querying publisher control', async () => {
      const retryDetailed = vi.fn(async () => ({
        retried: 0,
        blockedPendingRecovery: 0,
        skipped: 0,
      }));
      const publisherControl = control({ retryDetailed });

      for (const jobId of ['bad>id', 'a'.repeat(257)]) {
        expect(await post(
          '/api/publisher/retry',
          JSON.stringify({ status: 'failed', jobId }),
          publisherControl,
        )).toEqual({ status: 400, body: { error: SAFE_JOB_ID_ERROR } });
      }
      expect(retryDetailed).not.toHaveBeenCalled();
    });
    it('null body → 200 (hardened, not a 500)', async () => {
      expect(await post('/api/publisher/retry', 'null')).toEqual({ status: 200, body: { retried: 3, blockedPendingRecovery: 1, skipped: 2 } });
    });
  });

  describe('clear', () => {
    it('valid status → 200 cleared', async () => {
      expect(await post('/api/publisher/clear', JSON.stringify({ status: 'failed' }))).toEqual({ status: 200, body: { cleared: 2, status: 'failed' } });
    });
    it('missing/invalid status → 400', async () => {
      expect(await post('/api/publisher/clear', '{}')).toEqual({ status: 400, body: { error: 'status must be failed or finalized' } });
    });
    it('null body → 400 (hardened, not a 500)', async () => {
      expect(await post('/api/publisher/clear', 'null')).toEqual({ status: 400, body: { error: 'status must be failed or finalized' } });
    });
  });

  describe('clear-job (byte-identical contract preserved)', () => {
    it('valid jobId → 200 already_absent', async () => {
      expect(await post('/api/publisher/clear-job', JSON.stringify({ jobId: 'j1' }))).toEqual({ status: 200, body: { outcome: 'already_absent', jobId: 'j1' } });
    });
    it('missing jobId → 400 malformed', async () => {
      expect(await post('/api/publisher/clear-job', '{}')).toEqual({ status: 400, body: { outcome: 'rejected', reason: 'malformed', error: 'Missing jobId' } });
    });
    it('null body → 400 malformed (no 500)', async () => {
      expect(await post('/api/publisher/clear-job', 'null')).toEqual({ status: 400, body: { outcome: 'rejected', reason: 'malformed', error: 'Missing jobId' } });
    });
    it('invalid JSON → 400 Invalid JSON body', async () => {
      expect(await post('/api/publisher/clear-job', '{bad')).toEqual({ status: 400, body: { error: 'Invalid JSON body' } });
    });
  });
});
