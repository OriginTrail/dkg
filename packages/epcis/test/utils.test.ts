import { describe, it, expect } from 'vitest';
import { parseQueryParams, hasAtLeastOneFilter, hasValidDateRange } from '../src/utils.js';

describe('parseQueryParams', () => {
  it('extracts string params from URLSearchParams', () => {
    const sp = new URLSearchParams('epc=urn:test&bizStep=receiving&bizLocation=urn:loc:1');
    const params = parseQueryParams(sp);

    expect(params.epc).toBe('urn:test');
    expect(params.bizStep).toBe('receiving');
    expect(params.bizLocation).toBe('urn:loc:1');
  });

  it('extracts date range params', () => {
    const sp = new URLSearchParams('from=2024-01-01T00:00:00Z&to=2024-12-31T23:59:59Z');
    const params = parseQueryParams(sp);

    expect(params.from).toBe('2024-01-01T00:00:00Z');
    expect(params.to).toBe('2024-12-31T23:59:59Z');
  });

  it('extracts parentID, childEPC, inputEPC, outputEPC', () => {
    const sp = new URLSearchParams('parentID=urn:parent&childEPC=urn:child&inputEPC=urn:in&outputEPC=urn:out');
    const params = parseQueryParams(sp);

    expect(params.parentID).toBe('urn:parent');
    expect(params.childEPC).toBe('urn:child');
    expect(params.inputEPC).toBe('urn:in');
    expect(params.outputEPC).toBe('urn:out');
  });

  it('parses fullTrace boolean', () => {
    expect(parseQueryParams(new URLSearchParams('fullTrace=true')).fullTrace).toBe(true);
    expect(parseQueryParams(new URLSearchParams('fullTrace=false')).fullTrace).toBe(false);
    expect(parseQueryParams(new URLSearchParams('')).fullTrace).toBeUndefined();
  });

  it('parses limit and offset as integers', () => {
    const params = parseQueryParams(new URLSearchParams('limit=50&offset=200'));

    expect(params.limit).toBe(50);
    expect(params.offset).toBe(200);
  });

  it('ignores non-numeric limit/offset', () => {
    const params = parseQueryParams(new URLSearchParams('limit=abc&offset=xyz'));

    expect(params.limit).toBeUndefined();
    expect(params.offset).toBeUndefined();
  });

  it('returns only defined params (no undefined keys polluting the object)', () => {
    const params = parseQueryParams(new URLSearchParams('epc=urn:test'));

    expect(params.epc).toBe('urn:test');
    expect(params.bizStep).toBeUndefined();
  });
});

describe('hasAtLeastOneFilter', () => {
  it('returns true when a filter param is present', () => {
    expect(hasAtLeastOneFilter({ epc: 'urn:test' })).toBe(true);
    expect(hasAtLeastOneFilter({ bizStep: 'receiving' })).toBe(true);
    expect(hasAtLeastOneFilter({ from: '2024-01-01T00:00:00Z' })).toBe(true);
    expect(hasAtLeastOneFilter({ parentID: 'urn:parent' })).toBe(true);
  });

  it('returns false when only control params are present', () => {
    expect(hasAtLeastOneFilter({ fullTrace: true })).toBe(false);
    expect(hasAtLeastOneFilter({ limit: 100, offset: 0 })).toBe(false);
    expect(hasAtLeastOneFilter({})).toBe(false);
  });

  it('returns false when all filter values are undefined', () => {
    expect(hasAtLeastOneFilter({ epc: undefined, bizStep: undefined })).toBe(false);
  });
});

describe('hasValidDateRange', () => {
  it('returns true when no dates are provided', () => {
    expect(hasValidDateRange({})).toBe(true);
  });

  it('returns true when only from is provided', () => {
    expect(hasValidDateRange({ from: '2024-01-01T00:00:00Z' })).toBe(true);
  });

  it('returns true when only to is provided', () => {
    expect(hasValidDateRange({ to: '2024-12-31T00:00:00Z' })).toBe(true);
  });

  it('returns true when from <= to', () => {
    expect(hasValidDateRange({ from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' })).toBe(true);
  });

  it('returns true when from == to', () => {
    expect(hasValidDateRange({ from: '2024-06-01T00:00:00Z', to: '2024-06-01T00:00:00Z' })).toBe(true);
  });

  it('returns false when from > to', () => {
    expect(hasValidDateRange({ from: '2024-12-31T00:00:00Z', to: '2024-01-01T00:00:00Z' })).toBe(false);
  });
});
