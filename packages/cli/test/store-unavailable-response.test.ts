import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
} from '@origintrail-official/dkg-storage';
import {
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
  it('maps pre-dispatch scheduler shedding to retryable 503 with a known outcome', () => {
    const res = mockResponse();
    const error = new StoreSchedulerBusyError(
      'queue_wait_timeout',
      'normal',
      'knowledge-assets.write',
    );

    expect(respondIfStoreUnavailable(res, error)).toBe(true);
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

  it('maps an adapter deadline to retryable 503 with an indeterminate outcome', () => {
    const res = mockResponse();
    const error = new StoreOperationTimeoutError({
      backend: 'oxigraph-server',
      operation: 'query',
      timeoutMs: 30_000,
    });

    expect(respondIfStoreUnavailable(res, error)).toBe(true);
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

  it('accepts a code-only timeout crossing a package/prototype boundary', () => {
    const res = mockResponse();

    expect(respondIfStoreUnavailable(res, {
      code: 'STORE_OPERATION_TIMEOUT',
      message: 'wrapped store timeout',
    })).toBe(true);
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: 'wrapped store timeout',
      code: 'STORE_OPERATION_TIMEOUT',
      retryable: true,
      outcome: 'indeterminate',
    });
  });

  it('does not reclassify unrelated failures', () => {
    const res = mockResponse();
    expect(respondIfStoreUnavailable(res, new Error('invalid query'))).toBe(false);
    expect(respondIfStoreUnavailable(res, {
      code: 'STORE_OPERATION_TIMEOUT',
      outcome: 'completed',
    })).toBe(false);
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
