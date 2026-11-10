import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphWorkerStore, QueryWorkStoppedError, type QueryOptions } from '@origintrail-official/dkg-storage';
import {
  DEFAULT_API_QUERY_TIME_LIMIT_MS,
  MAX_API_QUERY_TIME_LIMIT_MS,
  configureApiQueryTimeLimit,
  getApiQueryTimeLimitMs,
  requestQueryTimeLimitMs,
  resolveApiQueryTimeLimitMs,
} from '../src/daemon/api-query-time-limit.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { handleBoundedQueryRoutes } from '../src/daemon/routes/bounded-query.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

class RequestStub extends EventEmitter {
  aborted = false;
  method = 'POST';
  __dkgPrebufferedBody: Buffer;

  constructor(body: Record<string, unknown>) {
    super();
    this.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
}

class ResponseStub extends EventEmitter {
  destroyed = false;
  headersSent = false;
  writableEnded = false;
  statusCode = 0;
  body = '';

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  setHeader(): void {}

  end(body?: string): this {
    this.body = body ?? '';
    this.writableEnded = true;
    return this;
  }
}

const tracker = () => ({ start: vi.fn(), startPhase: vi.fn(), completePhase: vi.fn(), complete: vi.fn(), fail: vi.fn(), cancel: vi.fn() });

function routeContext(path: string, req: RequestStub, res: ResponseStub, agent: Record<string, unknown>, track = tracker()): RequestContext {
  return {
    req, res, tracker: track,
    agent: { resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed', grantScope: 'node', source: 'legacy-local', reason: 'fixture-node', metadataBootstrap: 'eligible' }), ...agent },
    validTokens: new Set<string>(),
    url: new URL(`http://127.0.0.1${path}`),
    path,
    requestAgentAddress: '',
    authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
  } as unknown as RequestContext;
}

/** An agent whose query runs until its signal aborts, then rejects as `stop` says. */
function waitingAgent(stop: (reason: unknown) => unknown) {
  const seen: { options?: QueryOptions & { signal: AbortSignal } } = {};
  const query = vi.fn((_sparql: string, options: QueryOptions & { signal: AbortSignal }) => {
    seen.options = options;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(stop(options.signal.reason)), { once: true });
    });
  });
  return { query, seen };
}

afterEach(() => {
  configureApiQueryTimeLimit(undefined, { info() {}, warn() {} });
});

describe('the node time limit for /api/query', () => {
  it('defaults to 30 s, reads 0 as off and refuses anything else invalid', () => {
    expect(resolveApiQueryTimeLimitMs(undefined)).toEqual({ limitMs: DEFAULT_API_QUERY_TIME_LIMIT_MS, valid: true });
    expect(resolveApiQueryTimeLimitMs(' ')).toEqual({ limitMs: 30_000, valid: true });
    expect(resolveApiQueryTimeLimitMs('8000')).toEqual({ limitMs: 8_000, valid: true });
    expect(resolveApiQueryTimeLimitMs('0')).toEqual({ limitMs: null, valid: true });
    for (const raw of ['-1', '1.5', '8s', String(MAX_API_QUERY_TIME_LIMIT_MS + 1)]) {
      expect(resolveApiQueryTimeLimitMs(raw)).toEqual({ limitMs: 30_000, valid: false });
    }
  });

  it('logs the effective limit once and warns on an invalid value', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    expect(configureApiQueryTimeLimit('20000', logger)).toBe(20_000);
    expect(getApiQueryTimeLimitMs()).toBe(20_000);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(configureApiQueryTimeLimit('twenty', logger)).toBe(30_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('lets a request lower the limit, never raise it', () => {
    expect(requestQueryTimeLimitMs(undefined, 30_000)).toEqual({ ok: true, limitMs: 30_000 });
    expect(requestQueryTimeLimitMs(8_000, 30_000)).toEqual({ ok: true, limitMs: 8_000 });
    expect(requestQueryTimeLimitMs(30_001, 30_000)).toMatchObject({ ok: false });
    for (const bad of [0, -5, 1.5, '8000', true]) expect(requestQueryTimeLimitMs(bad, 30_000)).toMatchObject({ ok: false });
    expect(requestQueryTimeLimitMs(undefined, null)).toEqual({ ok: true, limitMs: null });
    expect(requestQueryTimeLimitMs(MAX_API_QUERY_TIME_LIMIT_MS, null)).toEqual({ ok: true, limitMs: MAX_API_QUERY_TIME_LIMIT_MS });
  });
});

describe('/api/query answers for its time limit', () => {
  it('hands the store the deadline and a signal that aborts at the limit', async () => {
    const query = vi.fn(async () => ({ bindings: [] }));
    const startedAt = performance.now();
    await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' }), new ResponseStub(), { query }));
    const options = (query.mock.calls[0] as unknown[])[1] as QueryOptions;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.workDeadline! - startedAt).toBeGreaterThan(DEFAULT_API_QUERY_TIME_LIMIT_MS - 1_000);
    expect(options.workDeadline! - startedAt).toBeLessThanOrEqual(DEFAULT_API_QUERY_TIME_LIMIT_MS + 50);
  });

  it('answers 504 saying the node stopped the query when the store stopped it', async () => {
    const { query, seen } = waitingAgent((reason) => new QueryWorkStoppedError('oxigraph-worker', 'stopped', reason));
    const res = new ResponseStub();
    const track = tracker();
    const startedAt = performance.now();
    await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', timeoutMs: 60 }), res, { query }, track));

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(55);
    expect(seen.options?.signal.aborted).toBe(true);
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toEqual({
      code: 'QUERY_TIME_LIMIT_EXCEEDED',
      error: 'The query ran past its time limit of 60 ms, and the node stopped it.',
      timeLimitMs: 60,
      stopped: true,
      retryable: false,
    });
    expect(track.fail).toHaveBeenCalledTimes(1);
    expect(track.cancel).not.toHaveBeenCalled();
  });

  it('says so when the store could not stop the query', async () => {
    const { query } = waitingAgent((reason) => reason);
    const res = new ResponseStub();
    await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', timeoutMs: 40 }), res, { query }));
    expect(res.statusCode).toBe(504);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'QUERY_TIME_LIMIT_EXCEEDED', stopped: false, timeLimitMs: 40 });
    expect(JSON.parse(res.body).error).toContain('may still be running');
  });

  it('refuses a timeoutMs above the node limit before any store work', async () => {
    configureApiQueryTimeLimit('1000', { info() {}, warn() {} });
    const query = vi.fn();
    const res = new ResponseStub();
    await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', timeoutMs: 1_001 }), res, { query }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'timeoutMs must be an integer from 1 to 1000' });
    expect(query).not.toHaveBeenCalled();
  });

  it('sends no answer, and stops the read, when the caller disconnects first', async () => {
    const { query, seen } = waitingAgent((reason) => new QueryWorkStoppedError('oxigraph-worker', 'stopped', reason));
    const req = new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }', timeoutMs: 10_000 });
    const res = new ResponseStub();
    const track = tracker();
    const route = handleQueryRoutes(routeContext('/api/query', req, res, { query }, track));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    req.aborted = true;
    req.emit('aborted');
    await route;

    expect(seen.options?.signal.reason).toMatchObject({ code: 'API_QUERY_CALLER_DISCONNECTED' });
    expect(res.statusCode).toBe(0);
    expect(res.writableEnded).toBe(true);
    expect(track.cancel).toHaveBeenCalledTimes(1);
    expect(track.fail).not.toHaveBeenCalled();
  });

  it('runs without a limit when the node limit is off and the request sets none', async () => {
    configureApiQueryTimeLimit('0', { info() {}, warn() {} });
    const query = vi.fn(async () => ({ bindings: [] }));
    const res = new ResponseStub();
    await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { ?s ?p ?o }' }), res, { query }));
    expect(res.statusCode).toBe(200);
    expect(((query.mock.calls[0] as unknown[])[1] as QueryOptions).workDeadline).toBeUndefined();
  });

  it('stops a real heavy query on the embedded worker store, which then answers at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-query-time-limit-'));
    const store = new OxigraphWorkerStore(join(dir, 'store.nq'));
    try {
      await store.insert(Array.from({ length: 1_000 }, (_, i) => ({
        subject: `urn:s${i}`, predicate: 'urn:p', object: `urn:o${i}`, graph: 'urn:g',
      })));
      const agent = {
        query: (sparql: string, options: QueryOptions) => store.query(sparql, options).then((result) => ({
          bindings: result.type === 'bindings' ? result.bindings : [],
        })),
      };
      const res = new ResponseStub();
      const heavy = 'SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:g> { ?a <urn:p> ?b . ?c <urn:p> ?d . ?e <urn:p> ?f } }';
      const startedAt = performance.now();
      await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: heavy, timeoutMs: 300 }), res, agent));
      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(res.statusCode).toBe(504);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'QUERY_TIME_LIMIT_EXCEEDED', stopped: true, timeLimitMs: 300 });

      const after = new ResponseStub();
      const cheapStartedAt = performance.now();
      await handleQueryRoutes(routeContext('/api/query', new RequestStub({ sparql: 'SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> <urn:o5> } }', timeoutMs: 5_000 }), after, agent));
      expect(after.statusCode).toBe(200);
      expect(JSON.parse(after.body).result.bindings).toEqual([{ s: 'urn:s5' }]);
      expect(performance.now() - cheapStartedAt).toBeLessThan(5_000);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('/api/query/bounded', () => {
  it('hands its deadline to the store as the work deadline', async () => {
    const query = vi.fn(async () => ({ bindings: [] }));
    const res = new ResponseStub();
    const startedAt = performance.now();
    await handleBoundedQueryRoutes(routeContext('/api/query/bounded', new RequestStub({
      version: 1, contextGraphId: 'cg', sparql: 'SELECT ?s WHERE { ?s ?p ?o }', maxRows: 5, timeoutMs: 1_500,
    }), res, { query }));
    expect(res.statusCode).toBe(200);
    const deadline = ((query.mock.calls[0] as unknown[])[1] as QueryOptions).workDeadline!;
    expect(deadline - startedAt).toBeGreaterThan(1_000);
    expect(deadline - startedAt).toBeLessThanOrEqual(1_550);
  });
});
