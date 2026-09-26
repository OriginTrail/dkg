import type { ServerResponse } from 'node:http';
import { Logger, createOperationContext, type CanonicalLogRecord } from '@origintrail-official/dkg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
  isContextGraphReadAuthorityUnavailable,
  respondIfContextGraphReadAuthorityUnavailable,
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

/**
 * Shaped like the agent's `ContextGraphReadAuthorityUnavailableError`: the
 * daemon recognizes it structurally rather than by instance, so the agent's
 * internal error type stays off the public package surface.
 */
function authorityUnavailableError(): Error & { code: string; retryable: boolean } {
  return Object.assign(
    new Error(
      'Context Graph read authority is unavailable for "cg-x" '
      + '(registered-chain/chain-access-policy-timeout)',
    ),
    { code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE, retryable: true },
  );
}

describe('isContextGraphReadAuthorityUnavailable', () => {
  it('matches only the retryable authority marker', () => {
    expect(isContextGraphReadAuthorityUnavailable(authorityUnavailableError())).toBe(true);
  });

  it('rejects a same-code error that is not marked retryable', () => {
    // `retryable` is part of the contract: a non-retryable carrier of the same
    // code must not be answered with a 503 + Retry-After.
    const err = Object.assign(new Error('nope'), {
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      retryable: false,
    });
    expect(isContextGraphReadAuthorityUnavailable(err)).toBe(false);
  });

  it('rejects unrelated errors and non-objects without throwing', () => {
    expect(isContextGraphReadAuthorityUnavailable(new Error('boom'))).toBe(false);
    expect(isContextGraphReadAuthorityUnavailable(undefined)).toBe(false);
    expect(isContextGraphReadAuthorityUnavailable(null)).toBe(false);
    expect(isContextGraphReadAuthorityUnavailable('string')).toBe(false);
  });

  it('survives a throwing `code` accessor', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'code', {
      get() { throw new Error('hostile getter'); },
    });
    expect(isContextGraphReadAuthorityUnavailable(hostile)).toBe(false);
  });
});

describe('respondIfContextGraphReadAuthorityUnavailable', () => {
  it('answers 503 with Retry-After and withholds the internal source/reason', () => {
    const res = mockResponse();
    expect(respondIfContextGraphReadAuthorityUnavailable(res, authorityUnavailableError()))
      .toBe(true);

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('3');
    const body = JSON.parse(res.body ?? '{}');
    expect(body).toMatchObject({
      code: CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
      retryable: true,
    });
    // The graph id, authority source and internal reason must not leak.
    expect(res.body).not.toContain('cg-x');
    expect(res.body).not.toContain('registered-chain');
    expect(res.body).not.toContain('chain-access-policy-timeout');
  });

  it('declines unrelated errors so the caller falls through', () => {
    const res = mockResponse();
    expect(respondIfContextGraphReadAuthorityUnavailable(res, new Error('boom'))).toBe(false);
    expect(res.headersSent).toBe(false);
  });
});

describe('respondWithDaemonError', () => {
  it('maps the authority marker to the uniform retryable 503, not a 500', () => {
    // This is the whole point of moving the helper into http-utils: routes that
    // merely RE-THROW (epcis, query-catalog) previously answered 500 and echoed
    // the internal reason.
    const res = mockResponse();
    respondWithDaemonError(res, authorityUnavailableError());

    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('3');
    expect(JSON.parse(res.body ?? '{}').code)
      .toBe(CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE);
    expect(res.body).not.toContain('chain-access-policy-timeout');
  });
});

describe('read-authority 503 attribution in the daemon log (#2834)', () => {
  const records: CanonicalLogRecord[] = [];
  // Far from the real clock, which the earlier cases log under.
  let clock = Date.UTC(2100, 0, 1);

  beforeEach(() => {
    records.length = 0;
    // Each case starts past every rate-limit window an earlier case opened.
    clock += 3_600_000;
    vi.useFakeTimers({ now: clock, toFake: ['Date'] });
    Logger.setSink((record) => { records.push(record); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Logger.setSink(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function attributed(dependency: string): Error {
    return Object.assign(authorityUnavailableError(), {
      source: 'registered-chain',
      reason: 'registered-authority-error',
      dependency,
    });
  }

  it('answers a store failure and a chain failure identically, and tells them apart in the log', () => {
    const storeCtx = createOperationContext('query');
    const chainCtx = createOperationContext('query');
    const storeRes = mockResponse();
    const chainRes = mockResponse();

    respondIfContextGraphReadAuthorityUnavailable(storeRes, attributed('store'), storeCtx);
    respondIfContextGraphReadAuthorityUnavailable(chainRes, attributed('chain'), chainCtx);

    expect(storeRes.statusCode).toBe(503);
    expect(chainRes.statusCode).toBe(503);
    expect(chainRes.body).toBe(storeRes.body);
    expect(storeRes.headers['Retry-After']).toBe('3');
    expect(chainRes.headers['Retry-After']).toBe('3');
    expect(storeRes.headers['x-dkg-operation-id']).toBe(storeCtx.operationId);
    expect(chainRes.headers['x-dkg-operation-id']).toBe(chainCtx.operationId);
    expect(records.map((record) => [record.level, record.operationId, record.message])).toEqual([
      ['warn', storeCtx.operationId, expect.stringContaining('source=registered-chain reason=registered-authority-error dependency=store')],
      ['warn', chainCtx.operationId, expect.stringContaining('source=registered-chain reason=registered-authority-error dependency=chain')],
    ]);
    expect(records.some((record) => record.message.includes('cg-x'))).toBe(false);
  });

  it('counts repeats of one attribution within a minute and reports them with the next line', () => {
    for (let i = 0; i < 3; i += 1) {
      respondIfContextGraphReadAuthorityUnavailable(mockResponse(), attributed('store'), createOperationContext('query'));
    }
    expect(records).toHaveLength(1);

    vi.setSystemTime(clock + 61_000);
    respondIfContextGraphReadAuthorityUnavailable(mockResponse(), attributed('store'), createOperationContext('query'));

    expect(records).toHaveLength(2);
    expect(records[1]!.message).toContain('dependency=store (2 more since the last report)');
  });

  it('logs anything but an attribution token as unknown', () => {
    respondIfContextGraphReadAuthorityUnavailable(mockResponse(), Object.assign(authorityUnavailableError(), {
      source: 'registered-chain',
      reason: 'RPC https://user:secret@rpc.example.invalid failed',
      dependency: { raw: true },
    }));

    expect(records[0]!.message).toContain('source=registered-chain reason=unknown dependency=unknown');
    expect(records[0]!.message).not.toContain('secret');
  });

  it('starts a new window when the clock steps back', () => {
    respondIfContextGraphReadAuthorityUnavailable(mockResponse(), attributed('chain'), createOperationContext('query'));
    vi.setSystemTime(clock - 30_000);
    respondIfContextGraphReadAuthorityUnavailable(mockResponse(), attributed('chain'), createOperationContext('query'));

    expect(records).toHaveLength(2);
  });

  it('logs an attribution field whose getter throws as unknown', () => {
    const hostile = authorityUnavailableError();
    Object.defineProperty(hostile, 'source', { get() { throw new Error('hostile getter'); } });

    expect(respondIfContextGraphReadAuthorityUnavailable(mockResponse(), hostile)).toBe(true);

    expect(records[0]!.message).toContain('source=unknown reason=unknown dependency=unknown');
  });

  it('gives a response without an operation context a fresh operation id to correlate', () => {
    const res = mockResponse();

    respondWithDaemonError(res, attributed('local-state'));

    expect(res.headers['x-dkg-operation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(records.map((record) => record.operationId)).toEqual([res.headers['x-dkg-operation-id']]);
    expect(records[0]!.message).toContain('dependency=local-state');
  });
});
