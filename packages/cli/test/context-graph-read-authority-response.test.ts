import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
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
