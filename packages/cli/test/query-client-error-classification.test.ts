import { describe, expect, it } from 'vitest';
import { SparqlHttpResponseError } from '@origintrail-official/dkg-storage';
import { isClientQueryFailure } from '../src/daemon/routes/query-error.js';

// GH#1758 — invalid SPARQL was AGAIN reported as HTTP 500, a silent
// re-regression of #889. #889's anchored `/^error at \d+:\d+:/` matched only
// when oxigraph's parse error was the WHOLE message; the store adapter wraps it
// mid-string, so the anchor stopped matching.
//
// PR #2330 review, round 3: an upstream 400 alone does NOT prove the CALLER's
// query was malformed. One `/api/query` request also runs engine-generated
// queries for access control, graph resolution and metadata scans. A store that
// rejects one of THOSE with 400 is an integration fault; answering 400 blames
// the caller and suppresses operator remediation. The query engine now marks
// the single store call carrying caller-supplied SPARQL, and only that marker
// classifies.
const callerRejected = (status: number) =>
  Object.assign(new Error(`SPARQL HTTP query failed (${status}): error at 1:15: bad`), {
    code: 'CALLER_SPARQL_REJECTED',
    status,
  });

describe('isClientQueryFailure — caller-SPARQL provenance (GH#1758)', () => {
  it('classifies a marked caller-query rejection as a client error', () => {
    for (const status of [400, 422]) {
      expect(isClientQueryFailure(callerRejected(status))).toBe(true);
    }
  });

  it('does NOT classify an unmarked store 400 — it may be an engine-internal query', () => {
    // The review's case: an access-check or graph-resolution query rejected by
    // the configured backend surfaces as the same typed 400. That is a server
    // fault and must not be reported as the caller's bad SPARQL.
    expect(isClientQueryFailure(new SparqlHttpResponseError('query', 400, 'backend incompatibility'))).toBe(false);
    expect(isClientQueryFailure(new SparqlHttpResponseError('query', 422, 'unprocessable'))).toBe(false);
  });

  it('does not classify store-rejects-us statuses either', () => {
    for (const status of [401, 403, 404, 429]) {
      expect(isClientQueryFailure(new SparqlHttpResponseError('query', status, 'nope'))).toBe(false);
    }
  });

  it('does not classify 5xx', () => {
    for (const status of [500, 502, 503]) {
      expect(isClientQueryFailure(new SparqlHttpResponseError('query', status, 'boom'))).toBe(false);
    }
  });

  it('requires the full marker shape, not just the code', () => {
    expect(isClientQueryFailure({ code: 'CALLER_SPARQL_REJECTED' })).toBe(false);
    expect(isClientQueryFailure({ code: 'CALLER_SPARQL_REJECTED', status: 'x', message: 'y' })).toBe(false);
    expect(isClientQueryFailure({ code: 'CALLER_SPARQL_REJECTED', status: NaN, message: 'y' })).toBe(false);
  });

  it('ignores nullish and non-object inputs', () => {
    expect(isClientQueryFailure(undefined)).toBe(false);
    expect(isClientQueryFailure(null)).toBe(false);
    expect(isClientQueryFailure('a string')).toBe(false);
  });
});

describe('isClientQueryFailure — legacy message families (GH#1758)', () => {
  it('still classifies the bare #889 parse error', () => {
    expect(isClientQueryFailure(new Error('error at 1:15: expected one of REDUCED, [_]'))).toBe(true);
  });

  it('keeps the pre-existing client-error families', () => {
    for (const msg of [
      'SPARQL rejected: no',
      'Parse error near line 2',
      'Query must start with SELECT',
      "query: 'agentAddress' must be a string",
      'Invalid minTrust value',
    ]) {
      expect(isClientQueryFailure(new Error(msg))).toBe(true);
    }
  });

  it('does not resurrect the over-broad wrapped-status message rule', () => {
    // An untyped error whose TEXT looks wrapped must not classify — provenance
    // is what decides now, not the rendered message.
    expect(isClientQueryFailure(new Error('SPARQL HTTP query failed (400): x'))).toBe(false);
  });

  it('leaves genuine server faults alone', () => {
    expect(isClientQueryFailure(new Error('ECONNREFUSED 127.0.0.1:7878'))).toBe(false);
    expect(isClientQueryFailure(new Error('store timeout after 30000ms'))).toBe(false);
    expect(isClientQueryFailure(new Error(''))).toBe(false);
  });
});
