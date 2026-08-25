import { describe, expect, it } from 'vitest';
import { SparqlHttpResponseError } from '@origintrail-official/dkg-storage';
import { classifySparqlHttpError, isClientQueryError } from '../src/daemon/routes/query.js';

// GH#1758 — invalid SPARQL was AGAIN reported as HTTP 500, a silent
// re-regression of #889.
//
// #889 added an anchored `/^error at \d+:\d+:/` pattern, which matches only
// when oxigraph's parse error is the WHOLE message. The store adapter wrapped
// it as `SPARQL HTTP query failed (400): error at 1:15: …`, burying the parse
// error mid-string, so the anchor stopped matching and the error fell through
// to a 500. The condition also lived inline inside a catch block, so nothing
// could regression-test it.
//
// PR #2330 review: the first fix classified EVERY wrapped 4xx as a client
// error, which is wrong — a store can answer 401/403 for stale daemon
// credentials, 404 for a bad endpoint, or 429 when throttling us. Those are
// server/integration faults. The upstream status is now carried as data on a
// typed error rather than recovered from the message with a regex.
describe('classifySparqlHttpError — typed upstream status (GH#1758)', () => {
  it('maps a malformed-query status to 400', () => {
    for (const status of [400, 422]) {
      const err = new SparqlHttpResponseError('query', status, 'error at 1:15: expected one of REDUCED');
      expect(classifySparqlHttpError(err)).toBe(400);
    }
  });

  it('keeps store-rejects-us statuses as server errors', () => {
    // The PR #2330 review case: telling the caller their query is invalid when
    // the store rejected OUR credentials suppresses the retry / operator
    // remediation that would actually fix it.
    for (const status of [401, 403, 404, 429]) {
      const err = new SparqlHttpResponseError('query', status, 'Unauthorized');
      expect(classifySparqlHttpError(err)).toBe(500);
    }
  });

  it('keeps 5xx as a server error', () => {
    for (const status of [500, 502, 503]) {
      expect(classifySparqlHttpError(new SparqlHttpResponseError('query', status, 'boom'))).toBe(500);
    }
  });

  it('classifies every operation the adapter throws for', () => {
    for (const op of ['query', 'construct', 'update']) {
      expect(classifySparqlHttpError(new SparqlHttpResponseError(op, 400, 'bad'))).toBe(400);
      expect(classifySparqlHttpError(new SparqlHttpResponseError(op, 401, 'nope'))).toBe(500);
    }
  });

  it('returns undefined for anything untyped, so legacy matching still runs', () => {
    expect(classifySparqlHttpError(new Error('SPARQL HTTP query failed (400): x'))).toBeUndefined();
    expect(classifySparqlHttpError(new Error('ECONNREFUSED'))).toBeUndefined();
    expect(classifySparqlHttpError(undefined)).toBeUndefined();
    expect(classifySparqlHttpError(null)).toBeUndefined();
  });

  it('recognises a structurally-equivalent error across a realm boundary', () => {
    // Workers / bundling can break `instanceof`; the duck-typed branch keeps
    // classification working when the class identity does not survive.
    const plain = Object.assign(new Error('SPARQL HTTP query failed (400): bad'), {
      name: 'SparqlHttpResponseError',
      status: 400,
      operation: 'query',
      responseExcerpt: 'bad',
    });
    expect(classifySparqlHttpError(plain)).toBe(400);
  });

  it('preserves the rendered message, so log greps keep working', () => {
    expect(new SparqlHttpResponseError('query', 400, 'error at 1:15: bad').message)
      .toBe('SPARQL HTTP query failed (400): error at 1:15: bad');
  });
});

describe('isClientQueryError — legacy message families (GH#1758)', () => {
  it('still classifies the bare #889 parse error', () => {
    expect(isClientQueryError('error at 1:15: expected one of REDUCED, [_]')).toBe(true);
  });

  it('no longer blanket-classifies a wrapped 4xx by message', () => {
    // Status now travels as data. Message matching must not resurrect the
    // over-broad rule the review rejected.
    expect(isClientQueryError('SPARQL HTTP query failed (401): Unauthorized')).toBe(false);
    expect(isClientQueryError('SPARQL HTTP query failed (429): slow down')).toBe(false);
  });

  it('keeps the pre-existing client-error families', () => {
    expect(isClientQueryError('SPARQL rejected: no')).toBe(true);
    expect(isClientQueryError('Parse error near line 2')).toBe(true);
    expect(isClientQueryError('Query must start with SELECT')).toBe(true);
    expect(isClientQueryError("query: 'agentAddress' must be a string")).toBe(true);
    expect(isClientQueryError('Invalid minTrust value')).toBe(true);
  });

  it('leaves genuine server faults alone', () => {
    expect(isClientQueryError('ECONNREFUSED 127.0.0.1:7878')).toBe(false);
    expect(isClientQueryError('store timeout after 30000ms')).toBe(false);
    expect(isClientQueryError('')).toBe(false);
  });
});
