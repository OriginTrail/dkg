import type { ServerResponse } from 'node:http';
import { Logger, createOperationContext, type CanonicalLogRecord } from '@origintrail-official/dkg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE_CODE,
  corsHeaders,
  isContextGraphReadAuthorityUnavailable,
  respondContextGraphReadAuthorityUnavailable,
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

  beforeEach(() => {
    records.length = 0;
    Logger.setSink((record) => { records.push(record); });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    Logger.setSink(null);
    vi.restoreAllMocks();
  });

  function attributed(dependency: string, reason = 'registered-authority-error'): Error {
    return Object.assign(authorityUnavailableError(), { source: 'registered-chain', reason, dependency });
  }

  /** The one log line written under `operationId`. */
  function lineFor(operationId: string): CanonicalLogRecord {
    const lines = records.filter((record) => record.operationId === operationId);
    expect(lines).toHaveLength(1);
    return lines[0]!;
  }

  it('answers a store failure and a chain failure identically, and tells them apart in the log', () => {
    const storeCtx = createOperationContext('query');
    const chainCtx = createOperationContext('query');
    const storeRes = mockResponse();
    const chainRes = mockResponse();

    respondIfContextGraphReadAuthorityUnavailable(storeRes, attributed('store', 'response-test-a'), storeCtx);
    respondIfContextGraphReadAuthorityUnavailable(chainRes, attributed('chain', 'response-test-a'), chainCtx);

    expect(storeRes.statusCode).toBe(503);
    expect(chainRes.statusCode).toBe(503);
    expect(chainRes.body).toBe(storeRes.body);
    expect(storeRes.headers['Retry-After']).toBe('3');
    expect(chainRes.headers['Retry-After']).toBe('3');
    expect(storeRes.headers['x-dkg-operation-id']).toBe(storeCtx.operationId);
    expect(chainRes.headers['x-dkg-operation-id']).toBe(chainCtx.operationId);
    expect(lineFor(storeCtx.operationId).message)
      .toContain('source=registered-chain reason=response-test-a dependency=store');
    expect(lineFor(chainCtx.operationId).message)
      .toContain('source=registered-chain reason=response-test-a dependency=chain');
    expect(records.some((record) => record.message.includes('cg-x'))).toBe(false);
  });

  it('keeps a searchable line for a repeated attribution, under the repeat\'s own operation id', () => {
    const first = createOperationContext('query');
    const repeat = createOperationContext('query');

    respondIfContextGraphReadAuthorityUnavailable(mockResponse(), attributed('store', 'response-test-b'), first);
    const res = mockResponse();
    respondIfContextGraphReadAuthorityUnavailable(res, attributed('store', 'response-test-b'), repeat);

    expect(lineFor(first.operationId).level).toBe('warn');
    expect(res.headers['x-dkg-operation-id']).toBe(repeat.operationId);
    expect(lineFor(repeat.operationId)).toMatchObject({ level: 'info' });
    expect(lineFor(repeat.operationId).message).toContain('reason=response-test-b dependency=store');
  });

  it('logs an attribution field whose getter throws as unknown', () => {
    const hostile = authorityUnavailableError();
    Object.defineProperty(hostile, 'reason', { get() { throw new Error('hostile getter'); } });
    const ctx = createOperationContext('query');

    expect(respondIfContextGraphReadAuthorityUnavailable(mockResponse(), hostile, ctx)).toBe(true);

    expect(lineFor(ctx.operationId).message).toContain('reason=unknown');
  });

  it('gives a response without an operation context a fresh operation id to correlate', () => {
    const res = mockResponse();

    respondWithDaemonError(res, attributed('local-state', 'response-test-c'));

    const operationId = res.headers['x-dkg-operation-id']!;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lineFor(operationId).message).toContain('dependency=local-state');
  });

  it('renders an already-classified decision through the same response', () => {
    const fromDecision = mockResponse();
    const fromError = mockResponse();
    const ctx = createOperationContext('query');

    respondContextGraphReadAuthorityUnavailable(fromDecision, {
      source: 'legacy-local', reason: 'response-test-d', dependency: 'store',
    }, ctx);
    respondIfContextGraphReadAuthorityUnavailable(fromError, attributed('store', 'response-test-d'));

    expect(fromDecision.statusCode).toBe(503);
    expect(fromDecision.body).toBe(fromError.body);
    expect(fromDecision.headers['Retry-After']).toBe('3');
    expect(fromDecision.headers['x-dkg-operation-id']).toBe(ctx.operationId);
    expect(lineFor(ctx.operationId).message).toContain('source=legacy-local reason=response-test-d dependency=store');
  });
});

describe('corsHeaders', () => {
  it('lets an allowed cross-origin client read the retry hint and the operation id', () => {
    expect(corsHeaders('https://app.example.invalid')['Access-Control-Expose-Headers'])
      .toBe('Retry-After, x-dkg-operation-id');
    expect(corsHeaders(null)).toEqual({});
  });
});
