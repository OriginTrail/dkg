import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SparqlHttpResponseError,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  configureApiQueryPriority,
  createApiQueryRequestLifecycle,
  handleQueryRoutes,
  resolveApiQueryPriority,
} from '../src/daemon/routes/query.js';
import { respondIfStoreUnavailable } from '../src/daemon/http-utils.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

class RequestStub extends EventEmitter {
  aborted = false;
  method = 'POST';
  __dkgPrebufferedBody: Buffer;

  constructor(body: Record<string, unknown> = {
    sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
  }) {
    super();
    this.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  }
}

class ResponseStub extends EventEmitter {
  destroyed = false;
  headersSent = false;
  writableEnded = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    this.writableEnded = true;
    return this;
  }
}

function queryRouteContext(
  req: RequestStub,
  res: ResponseStub,
  agent: Record<string, unknown>,
  tracker: Record<string, unknown>,
): RequestContext {
  return {
    req,
    res,
    agent,
    tracker,
    validTokens: new Set<string>(),
    url: new URL('http://127.0.0.1/api/query'),
    path: '/api/query',
    requestToken: undefined,
    requestAgentAddress: '',
  } as unknown as RequestContext;
}

describe('/api/query request lifecycle', () => {
  const originalPriority = process.env.DKG_API_QUERY_PRIORITY;

  afterEach(() => {
    if (originalPriority === undefined) delete process.env.DKG_API_QUERY_PRIORITY;
    else process.env.DKG_API_QUERY_PRIORITY = originalPriority;
    configureApiQueryPriority(originalPriority, {
      info: () => {},
      warn: () => {},
    });
  });

  it('resolves the lane once, logs it, and warns when an incident override is invalid', () => {
    expect(resolveApiQueryPriority(undefined)).toBe('background');
    expect(resolveApiQueryPriority('background')).toBe('background');
    expect(resolveApiQueryPriority('normal')).toBe('normal');
    expect(resolveApiQueryPriority(' NORMAL ')).toBe('normal');
    expect(resolveApiQueryPriority('ack')).toBe('background');

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    expect(configureApiQueryPriority('normal', logger)).toBe('normal');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('priority: normal'));
    expect(logger.warn).not.toHaveBeenCalled();

    expect(configureApiQueryPriority('noraml', logger)).toBe('background');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid DKG_API_QUERY_PRIORITY="noraml"'),
    );
    expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('priority: background'));
  });

  it('forwards the exact lane/source and aborts the signal on request disconnect', () => {
    process.env.DKG_API_QUERY_PRIORITY = 'normal';
    configureApiQueryPriority(process.env.DKG_API_QUERY_PRIORITY, {
      info: () => {},
      warn: () => {},
    });
    const req = new RequestStub();
    const res = new ResponseStub();
    const lifecycle = createApiQueryRequestLifecycle(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );

    expect(lifecycle.priority).toBe('normal');
    expect(lifecycle.source).toBe('api.query');
    expect(lifecycle.signal.aborted).toBe(false);

    req.emit('aborted');

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toMatchObject({
      code: 'API_QUERY_CALLER_DISCONNECTED',
      message: 'API query caller disconnected',
    });
    lifecycle.dispose();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('maps scheduler admission shedding to retryable HTTP 503', () => {
    const res = new ResponseStub();
    const error = new StoreSchedulerBusyError(
      'queue_wait_timeout',
      'background',
      'api.query',
    );

    expect(respondIfStoreUnavailable(
      res as unknown as ServerResponse,
      error,
    )).toBe('not_started');
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      reason: 'queue_wait_timeout',
      priority: 'background',
      retryable: true,
      outcome: 'not_started',
    });
  });

  it('maps store deadlines to retryable HTTP 503', () => {
    const res = new ResponseStub();
    const error = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      timeoutMs: 30_000,
    });

    expect(respondIfStoreUnavailable(
      res as unknown as ServerResponse,
      error,
    )).toBe('indeterminate');
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
      backend: 'oxigraph-server',
      operation: 'query',
    });
  });

  it('does not reclassify unrelated route errors', () => {
    const res = new ResponseStub();
    expect(respondIfStoreUnavailable(
      res as unknown as ServerResponse,
      new Error('parse failed'),
    )).toBeNull();
    expect(respondIfStoreUnavailable(
      res as unknown as ServerResponse,
      {
        code: 'STORE_SCHEDULER_BUSY',
        reason: 'queue_full',
        priority: 'background',
      },
    )).toBeNull();
    expect(res.writableEnded).toBe(false);
  });

  it('passes the lifecycle admission options through the actual route handoff', async () => {
    const req = new RequestStub();
    const res = new ResponseStub();
    let receivedOptions: Record<string, unknown> | undefined;
    const agent = {
      query: vi.fn(async (_sparql: string, options: Record<string, unknown>) => {
        receivedOptions = options;
        return { type: 'bindings', bindings: [] };
      }),
    };
    const tracker = {
      start: vi.fn(),
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };

    await handleQueryRoutes(queryRouteContext(req, res, agent, tracker));

    expect(agent.query).toHaveBeenCalledTimes(1);
    expect(receivedOptions).toMatchObject({
      priority: 'background',
      source: 'api.query',
    });
    expect(receivedOptions?.signal).toBeInstanceOf(AbortSignal);
    expect((receivedOptions?.signal as AbortSignal).aborted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(tracker.complete).toHaveBeenCalledTimes(1);
    expect(tracker.fail).not.toHaveBeenCalled();
  });

  it('tracks not-started store failures as cancellation and indeterminate failures as failure', async () => {
    for (const outcome of ['not_started', 'indeterminate'] as const) {
      const req = new RequestStub();
      const res = new ResponseStub();
      const tracker = {
        start: vi.fn(),
        startPhase: vi.fn(),
        completePhase: vi.fn(),
        complete: vi.fn(),
        fail: vi.fn(),
        cancel: vi.fn(),
      };
      const error = new StoreOperationTimeoutError({
        backend: 'oxigraph-server',
        operation: 'query',
        outcome,
      });

      await handleQueryRoutes(queryRouteContext(req, res, {
        query: vi.fn(async () => { throw error; }),
      }, tracker));

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ outcome });
      expect(tracker.cancel).toHaveBeenCalledTimes(outcome === 'not_started' ? 1 : 0);
      expect(tracker.fail).toHaveBeenCalledTimes(outcome === 'indeterminate' ? 1 : 0);
    }
  });

  it('maps a GenUI entity-query store timeout through the route as retryable 503', async () => {
    const req = new RequestStub({
      contextGraphId: 'cg-1',
      entityUri: 'urn:entity:1',
      libraryPrompt: 'Render the entity',
    });
    const res = new ResponseStub();
    const timeout = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      timeoutMs: 30_000,
    });
    const ctx = queryRouteContext(req, res, {
      query: vi.fn(async () => { throw timeout; }),
    }, {});
    ctx.path = '/api/genui/render';
    ctx.url = new URL('http://127.0.0.1/api/genui/render');
    ctx.config = { llm: { apiKey: 'test-key' } } as RequestContext['config'];

    await handleQueryRoutes(ctx);

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
      backend: 'oxigraph-server',
      operation: 'query',
    });
  });

  it('aborts the route signal on disconnect and maps canonical shedding to 503', async () => {
    const disconnectReq = new RequestStub();
    const disconnectRes = new ResponseStub();
    let receivedSignal: AbortSignal | undefined;
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const disconnectTracker = {
      start: vi.fn(),
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };
    const disconnectRoute = handleQueryRoutes(queryRouteContext(
      disconnectReq,
      disconnectRes,
      {
        query: vi.fn(async (_sparql: string, options: Record<string, unknown>) => {
          receivedSignal = options.signal as AbortSignal;
          queryStarted();
          return new Promise((_resolve, reject) => {
            receivedSignal?.addEventListener(
              'abort',
              () => reject(receivedSignal?.reason),
              { once: true },
            );
          });
        }),
      },
      disconnectTracker,
    ));
    await started;

    disconnectReq.aborted = true;
    disconnectReq.emit('aborted');
    await disconnectRoute;

    expect(receivedSignal?.aborted).toBe(true);
    expect(disconnectTracker.cancel).toHaveBeenCalledTimes(1);
    expect(disconnectTracker.fail).not.toHaveBeenCalled();
    expect(disconnectRes.writableEnded).toBe(true);

    const busyReq = new RequestStub();
    const busyRes = new ResponseStub();
    let busyOptions: Record<string, unknown> | undefined;
    const busyTracker = {
      start: vi.fn(),
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };
    await handleQueryRoutes(queryRouteContext(
      busyReq,
      busyRes,
      {
        query: vi.fn(async (_sparql: string, options: Record<string, unknown>) => {
          busyOptions = options;
          throw new StoreSchedulerBusyError(
            'queue_wait_timeout',
            'background',
            'api.query',
          );
        }),
      },
      busyTracker,
    ));

    expect(busyOptions).toMatchObject({
      priority: 'background',
      source: 'api.query',
    });
    expect(busyOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(busyRes.statusCode).toBe(503);
    expect(busyRes.headers['Retry-After']).toBe('1');
    expect(JSON.parse(busyRes.body)).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      retryable: true,
    });
    expect(busyTracker.cancel).toHaveBeenCalledTimes(1);
    expect(busyTracker.fail).not.toHaveBeenCalled();
  });

  // GH#1758 / PR #2330 review — the adapter, the engine marker and the
  // classifier are each covered, but nothing proved `/api/query` USES the
  // marker. Reverting the route to inline message matching would leave all of
  // those green while a malformed caller query escaped as HTTP 500 again.
  it('renders a marked caller-SPARQL rejection as HTTP 400', async () => {
    const req = new RequestStub();
    const res = new ResponseStub();
    const tracker = {
      start: vi.fn(),
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };

    // Structurally complete marker — what DKGQueryEngine throws when the store
    // rejects caller-supplied SPARQL with 400/422.
    const marked = Object.assign(
      new Error('SPARQL HTTP query failed (400): error at 1:15: expected one of REDUCED'),
      { code: 'CALLER_SPARQL_REJECTED', status: 400 },
    );

    await handleQueryRoutes(queryRouteContext(req, res, {
      query: vi.fn(async () => { throw marked; }),
    }, tracker));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: marked.message });
  });

  it('does NOT render an UNMARKED typed store rejection as a caller error', async () => {
    // The converse: an engine-generated query rejected by the backend is an
    // integration fault and must stay a server error, even at 400 and even
    // when its body reads like a legacy client-error family.
    const req = new RequestStub();
    const res = new ResponseStub();
    const tracker = {
      start: vi.fn(),
      startPhase: vi.fn(),
      completePhase: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };

    const unmarked = new SparqlHttpResponseError('query', 400, 'Query must start with SELECT');

    await expect(handleQueryRoutes(queryRouteContext(req, res, {
      query: vi.fn(async () => { throw unmarked; }),
    }, tracker))).rejects.toBe(unmarked);

    expect(res.statusCode).not.toBe(400);
  });
});
