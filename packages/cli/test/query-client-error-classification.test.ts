import { describe, expect, it } from 'vitest';
import { isClientQueryError } from '../src/daemon/routes/query.js';

// GH#1758 — invalid SPARQL was AGAIN reported as HTTP 500, a silent
// re-regression of #889.
//
// #889 added an anchored `/^error at \d+:\d+:/` pattern, which matches only
// when oxigraph's parse error is the WHOLE message. The store adapter wraps it
// as `SPARQL HTTP query failed (400): error at 1:15: …`
// (packages/storage/src/adapters/sparql-http.ts:387/671/716), burying the
// parse error mid-string, so the anchor stopped matching and the error fell
// through to a 500. The condition lived inline inside a catch block, so
// nothing could regression-test it — hence this file, and the extraction of
// `isClientQueryError`.
describe('isClientQueryError — wrapped upstream status (GH#1758)', () => {
  it('classifies the adapter-wrapped 400 the issue reports', () => {
    expect(isClientQueryError(
      'SPARQL HTTP query failed (400): error at 1:15: expected one of REDUCED, [_]',
    )).toBe(true);
  });

  it('classifies the wrapped form for every operation the adapter throws', () => {
    for (const op of ['query', 'construct', 'update']) {
      expect(isClientQueryError(`SPARQL HTTP ${op} failed (400): error at 1:15: bad`)).toBe(true);
    }
  });

  it('classifies other 4xx statuses as client errors', () => {
    expect(isClientQueryError('SPARQL HTTP query failed (413): payload too large')).toBe(true);
    expect(isClientQueryError('SPARQL HTTP query failed (422): unprocessable')).toBe(true);
  });

  it('does NOT classify a wrapped 5xx as a client error', () => {
    // A store-side fault must stay a 500 — the caller's query was fine.
    expect(isClientQueryError('SPARQL HTTP query failed (500): internal error')).toBe(false);
    expect(isClientQueryError('SPARQL HTTP query failed (503): unavailable')).toBe(false);
  });

  it('still classifies the bare #889 form (unwrapped)', () => {
    expect(isClientQueryError('error at 1:15: expected one of REDUCED, [_]')).toBe(true);
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
