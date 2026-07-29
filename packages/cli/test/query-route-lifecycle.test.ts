import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import {
  createApiQueryRequestLifecycle,
  resolveApiQueryPriority,
  respondIfApiQueryStoreBusy,
} from '../src/daemon/routes/query.js';

class RequestStub extends EventEmitter {
  aborted = false;
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

describe('/api/query request lifecycle', () => {
  const originalPriority = process.env.DKG_API_QUERY_PRIORITY;

  afterEach(() => {
    if (originalPriority === undefined) delete process.env.DKG_API_QUERY_PRIORITY;
    else process.env.DKG_API_QUERY_PRIORITY = originalPriority;
  });

  it('defaults API reads to background and allows a reversible normal-lane override', () => {
    expect(resolveApiQueryPriority(undefined)).toBe('background');
    expect(resolveApiQueryPriority('background')).toBe('background');
    expect(resolveApiQueryPriority('normal')).toBe('normal');
    expect(resolveApiQueryPriority(' NORMAL ')).toBe('normal');
    expect(resolveApiQueryPriority('ack')).toBe('background');
  });

  it('forwards the exact lane/source and aborts the signal on request disconnect', () => {
    process.env.DKG_API_QUERY_PRIORITY = 'normal';
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

    expect(respondIfApiQueryStoreBusy(
      res as unknown as ServerResponse,
      error,
    )).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('1');
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      reason: 'queue_wait_timeout',
      priority: 'background',
      retryable: true,
    });
  });

  it('does not reclassify unrelated route errors', () => {
    const res = new ResponseStub();
    expect(respondIfApiQueryStoreBusy(
      res as unknown as ServerResponse,
      new Error('parse failed'),
    )).toBe(false);
    expect(res.writableEnded).toBe(false);
  });
});
