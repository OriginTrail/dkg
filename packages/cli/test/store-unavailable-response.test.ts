import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { ListContextGraphsBudgetExceeded } from '@origintrail-official/dkg-agent/context-graph-list-budget-error';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
  classifyStoreUnavailable,
  respondIfStoreUnavailable,
  respondWithDaemonError,
} from '../src/daemon/http-utils.js';

function mockResponse(): ServerResponse & {
  headers: Record<string, string>;
  body?: string;
} {
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
      this.headersSent = true;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    end(body?: string) {
      this.body = body;
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse & { headers: Record<string, string>; body?: string };
}

describe('respondIfStoreUnavailable', () => {
  it('classifies without rendering so partial-success routes can extend the body', () => {
    const classified = classifyStoreUnavailable(new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'publish',
      timeoutMs: 30_000,
    }));

    expect(classified).toEqual({
      outcome: 'indeterminate',
      body: {
        error: 'oxigraph-server publish exceeded its store deadline after 30000ms',
        code: 'STORE_OPERATION_TIMEOUT',
        retryable: true,
        outcome: 'indeterminate',
        backend: 'oxigraph-server',
        operation: 'publish',
        timeoutMs: 30_000,
      },
    });
  });

  it('maps a control-path refusal to the same retryable not-started 503, naming the control lane', () => {
    for (const reason of ['queue_full', 'queue_wait_timeout'] as const) {
      const res = mockResponse();
      const error = new StoreSchedulerBusyError(reason, 'control', 'publisher.asyncPromote.writeJob');

      expect(respondIfStoreUnavailable(res, error)).toBe('not_started');
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('1');
      expect(JSON.parse(res.body ?? '{}')).toMatchObject({
        code: 'STORE_SCHEDULER_BUSY',
        reason,
        priority: 'control',
        retryable: true,
        outcome: 'not_started',
      });
    }
  });

  it('maps pre-dispatch scheduler shedding to retryable 503 with a known outcome', () => {
    const res = mockResponse();
    const error = new StoreSchedulerBusyError(
      'queue_wait_timeout',
      'normal',
      'knowledge-assets.write',
    );

    expect(respondIfStoreUnavailable(res, error)).toBe('not_started');
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      reason: 'queue_wait_timeout',
      priority: 'normal',
      retryable: true,
      outcome: 'not_started',
    });
  });

  it('keeps other active work out of a scheduler-busy HTTP response', () => {
    const res = mockResponse();
    const error = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'request.read');
    Object.assign(error, { activeAtTimeout: [{
      priority: 'normal', operation: 'tenant/acme/private-sync', count: 7, oldestAgeMs: 1234,
    }] });
    expect(respondIfStoreUnavailable(res, error)).toBe('not_started');
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('tenant/acme/private-sync');
    expect(res.body).not.toContain('1234');
    expect(res.body).not.toContain('activeAtTimeout');
  });

  it('maps an adapter deadline to retryable 503 with an indeterminate outcome', () => {
    const res = mockResponse();
    const error = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      timeoutMs: 30_000,
    });

    expect(respondIfStoreUnavailable(res, error)).toBe('indeterminate');
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: 'oxigraph-server query exceeded its store deadline after 30000ms',
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
      backend: 'oxigraph-server',
      operation: 'query',
      timeoutMs: 30_000,
    });
  });

  it.each(['queue_full', 'queue_wait_timeout'] as const)(
    'accepts a canonical structural scheduler error (%s) without an Error prototype',
    (reason) => {
      const res = mockResponse();
      // Error.message is non-enumerable; package-boundary copies may omit it.
      const error = { ...new StoreSchedulerBusyError(reason, 'normal', 'query') };
      expect(respondIfStoreUnavailable(res, error)).toBe('not_started');
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('1');
      expect(JSON.parse(res.body ?? '{}')).toMatchObject({
        code: 'STORE_SCHEDULER_BUSY', reason, priority: 'normal',
        retryable: true, outcome: 'not_started',
        error: 'Store scheduler is temporarily busy; retry the request',
      });
    },
  );

  it.each(['scheduler capacity exhausted', ''])(
    'preserves a structural scheduler error message (%j)',
    (message) => {
      const classified = classifyStoreUnavailable({
        ...new StoreSchedulerBusyError('queue_full', 'normal', 'query'), message,
      });
      expect(classified).toMatchObject({
        outcome: 'not_started', body: { code: 'STORE_SCHEDULER_BUSY', error: message },
      });
    },
  );

  it.each([null, 42, { detail: 'not a message' }])(
    'rejects structural busy errors with malformed message metadata (%j)',
    (message) => {
      expect(classifyStoreUnavailable({
        ...new StoreSchedulerBusyError('queue_full', 'normal', 'query'), message,
      })).toBeNull();
    },
  );

  it('does not treat a scheduler code or retryable flag alone as admission evidence', () => {
    expect(classifyStoreUnavailable({ code: 'STORE_SCHEDULER_BUSY', retryable: true })).toBeNull();
    expect(classifyStoreUnavailable({
      ...new StoreSchedulerBusyError('queue_full', 'normal', 'query'),
      outcome: 'indeterminate',
    })).toBeNull();
  });

  it('accepts a code-only timeout crossing a package/prototype boundary', () => {
    const res = mockResponse();

    expect(respondIfStoreUnavailable(res, {
      code: 'STORE_OPERATION_TIMEOUT',
      message: 'wrapped store timeout',
    })).toBe('indeterminate');
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: 'wrapped store timeout',
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
    });
  });

  it('does not reclassify unrelated failures', () => {
    const res = mockResponse();
    expect(respondIfStoreUnavailable(res, new Error('invalid query'))).toBeNull();
    expect(respondIfStoreUnavailable(res, {
      code: 'STORE_OPERATION_TIMEOUT',
      outcome: 'completed',
    })).toBeNull();
    expect(res.writableEnded).toBe(false);
  });
});

describe('respondWithDaemonError store fallback', () => {
  it('preserves the retryable store-timeout contract at the top-level route boundary', () => {
    const res = mockResponse();
    respondWithDaemonError(res, new StoreOperationTimeoutError({
      backend: 'blazegraph',
      operation: 'insert',
      timeoutMs: 30_000,
    }));

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body ?? '{}')).toMatchObject({
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
      backend: 'blazegraph',
      operation: 'insert',
    });
  });
});


describe('context graph listing scan deadline', () => {
  it.each(['instance', 'structural'])('renders a retryable 503 for the %s budget error', representation => {
    const error = new ListContextGraphsBudgetExceeded('private internal scan detail', 5000);
    const res = mockResponse();
    respondWithDaemonError(res, representation === 'instance' ? error : { ...error });
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body!)).toEqual({
      error: 'Context graph listing is temporarily busy; retry the request',
      code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED', retryable: true,
    });
    expect(res.body).not.toContain('private internal scan');
  });
  it('keeps an unrelated error and a malformed budget error as server failures', () => {
    for (const error of [new Error('unrelated listing failure'), {
      code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED', retryable: true, timeoutMs: NaN,
    }]) {
      const res = mockResponse();
      respondWithDaemonError(res, error);
      expect(res.statusCode).toBe(500);
      expect(res.headers['Retry-After']).toBeUndefined();
    }
  });
});


it('GET /api/context-graph/list returns 503 during a bounded scan and 200 on the next read', async () => {
  let calls = 0;
  const seenOptions: unknown[] = [];
  const rows = [{ id: 'example', name: 'Example graph' }];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const ctx = { req, res, path: url.pathname, url,
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
      agent: { listContextGraphs: async (options: unknown) => {
        seenOptions.push(options);
        if (++calls === 1) throw new ListContextGraphsBudgetExceeded('ontology/agents definition scan', 5000);
        return rows;
      } },
    } as unknown as RequestContext;
    try { await handleContextGraphRoutes(ctx); }
    catch (error) { respondWithDaemonError(res, error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/context-graph/list`;
  try {
    const busy = await fetch(url);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('Retry-After')).toBe('1');
    expect(await busy.json()).toMatchObject({ code: 'CONTEXT_GRAPH_LIST_BUDGET_EXCEEDED', retryable: true });
    const retry = await fetch(url);
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Retry-After')).toBeNull();
    expect(await retry.json()).toEqual({ contextGraphs: rows });
    expect(calls).toBe(2);
    expect(seenOptions).toEqual([{ callerAgentAddress: null }, { callerAgentAddress: null }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
