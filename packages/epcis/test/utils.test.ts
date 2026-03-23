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

  it('fullTrace=true without epc has no effect (fullTrace is resolved, not passed through)', () => {
    const params = parseQueryParams(new URLSearchParams('fullTrace=true'));
    expect(params.fullTrace).toBeUndefined();
    expect(params.anyEPC).toBeUndefined();
  });

  it('parses limit as perPage alias and offset as integers', () => {
    const params = parseQueryParams(new URLSearchParams('limit=50&offset=200'));

    expect(params.perPage).toBe(50);
    expect(params.offset).toBe(200);
  });

  it('ignores non-numeric limit/offset', () => {
    const params = parseQueryParams(new URLSearchParams('limit=abc&offset=xyz'));

    expect(params.perPage).toBeUndefined();
    expect(params.offset).toBeUndefined();
  });

  it('returns only defined params (no undefined keys polluting the object)', () => {
    const params = parseQueryParams(new URLSearchParams('epc=urn:test'));

    expect(params.epc).toBe('urn:test');
    expect(params.bizStep).toBeUndefined();
  });

  it('accepts MATCH_epc as standard name for epc', () => {
    const params = parseQueryParams(new URLSearchParams('MATCH_epc=urn:epc:standard'));

    expect(params.epc).toBe('urn:epc:standard');
  });

  it('accepts all EPCIS 2.0 standard parameter names', () => {
    const sp = new URLSearchParams([
      ['EQ_bizStep', 'receiving'],
      ['EQ_bizLocation', 'urn:loc:1'],
      ['GE_eventTime', '2024-01-01T00:00:00Z'],
      ['LT_eventTime', '2024-12-31T00:00:00Z'],
      ['MATCH_parentID', 'urn:parent'],
      ['MATCH_inputEPC', 'urn:in'],
      ['MATCH_outputEPC', 'urn:out'],
    ]);
    const params = parseQueryParams(sp);

    expect(params.bizStep).toBe('receiving');
    expect(params.bizLocation).toBe('urn:loc:1');
    expect(params.from).toBe('2024-01-01T00:00:00Z');
    expect(params.to).toBe('2024-12-31T00:00:00Z');
    expect(params.parentID).toBe('urn:parent');
    expect(params.inputEPC).toBe('urn:in');
    expect(params.outputEPC).toBe('urn:out');
  });

  it('standard name takes precedence when both standard and alias are provided', () => {
    const sp = new URLSearchParams('MATCH_epc=urn:standard&epc=urn:alias');
    const params = parseQueryParams(sp);

    expect(params.epc).toBe('urn:standard');
  });

  it('parses MATCH_anyEPC as anyEPC', () => {
    const params = parseQueryParams(new URLSearchParams('MATCH_anyEPC=urn:epc:trace'));

    expect(params.anyEPC).toBe('urn:epc:trace');
  });

  it('maps epc + fullTrace=true to anyEPC (backward compat)', () => {
    const params = parseQueryParams(new URLSearchParams('epc=urn:epc:trace&fullTrace=true'));

    expect(params.anyEPC).toBe('urn:epc:trace');
    expect(params.epc).toBeUndefined();
    expect(params.fullTrace).toBeUndefined();
  });

  it('MATCH_anyEPC takes precedence over epc+fullTrace combo', () => {
    const sp = new URLSearchParams('MATCH_anyEPC=urn:standard&epc=urn:alias&fullTrace=true');
    const params = parseQueryParams(sp);

    expect(params.anyEPC).toBe('urn:standard');
    expect(params.epc).toBeUndefined();
  });

  it('epc without fullTrace stays as epc (no anyEPC)', () => {
    const params = parseQueryParams(new URLSearchParams('epc=urn:test'));

    expect(params.epc).toBe('urn:test');
    expect(params.anyEPC).toBeUndefined();
  });

  it('extracts eventType param', () => {
    const params = parseQueryParams(new URLSearchParams('eventType=ObjectEvent'));
    expect(params.eventType).toBe('ObjectEvent');
  });

  it('extracts action via alias and EQ_action standard name', () => {
    expect(parseQueryParams(new URLSearchParams('action=OBSERVE')).action).toBe('OBSERVE');
    expect(parseQueryParams(new URLSearchParams('EQ_action=ADD')).action).toBe('ADD');
  });

  it('EQ_action takes precedence over action alias', () => {
    const params = parseQueryParams(new URLSearchParams('EQ_action=ADD&action=OBSERVE'));
    expect(params.action).toBe('ADD');
  });

  it('extracts disposition via alias and EQ_disposition standard name', () => {
    expect(parseQueryParams(new URLSearchParams('disposition=in_transit')).disposition).toBe('in_transit');
    expect(parseQueryParams(new URLSearchParams('EQ_disposition=in_transit')).disposition).toBe('in_transit');
  });

  it('extracts readPoint via alias and EQ_readPoint standard name', () => {
    expect(parseQueryParams(new URLSearchParams('readPoint=urn:epc:id:sgln:4012345.00001.0')).readPoint).toBe('urn:epc:id:sgln:4012345.00001.0');
    expect(parseQueryParams(new URLSearchParams('EQ_readPoint=urn:epc:id:sgln:4012345.00001.0')).readPoint).toBe('urn:epc:id:sgln:4012345.00001.0');
  });

  it('parses perPage as integer', () => {
    const params = parseQueryParams(new URLSearchParams('perPage=10'));
    expect(params.perPage).toBe(10);
  });

  it('accepts limit as alias for perPage', () => {
    const params = parseQueryParams(new URLSearchParams('limit=50'));
    expect(params.perPage).toBe(50);
  });

  it('perPage takes precedence over limit alias', () => {
    const params = parseQueryParams(new URLSearchParams('perPage=10&limit=50'));
    expect(params.perPage).toBe(10);
  });

  it('decodes nextPageToken to offset', () => {
    const token = btoa('offset:50');
    const params = parseQueryParams(new URLSearchParams(`nextPageToken=${token}`));
    expect(params.offset).toBe(50);
  });

  it('nextPageToken takes precedence over raw offset', () => {
    const token = btoa('offset:100');
    const params = parseQueryParams(new URLSearchParams(`nextPageToken=${token}&offset=200`));
    expect(params.offset).toBe(100);
  });

  it('ignores invalid nextPageToken and falls back to raw offset', () => {
    const params = parseQueryParams(new URLSearchParams('nextPageToken=not-valid-base64!!!&offset=200'));
    expect(params.offset).toBe(200);
  });
});

describe('hasAtLeastOneFilter', () => {
  it('returns true when a filter param is present', () => {
    expect(hasAtLeastOneFilter({ epc: 'urn:test' })).toBe(true);
    expect(hasAtLeastOneFilter({ bizStep: 'receiving' })).toBe(true);
    expect(hasAtLeastOneFilter({ from: '2024-01-01T00:00:00Z' })).toBe(true);
    expect(hasAtLeastOneFilter({ parentID: 'urn:parent' })).toBe(true);
    expect(hasAtLeastOneFilter({ eventType: 'ObjectEvent' })).toBe(true);
    expect(hasAtLeastOneFilter({ action: 'OBSERVE' })).toBe(true);
    expect(hasAtLeastOneFilter({ disposition: 'in_transit' })).toBe(true);
    expect(hasAtLeastOneFilter({ readPoint: 'urn:epc:id:sgln:4012345.00001.0' })).toBe(true);
  });

  it('returns false when only control params are present', () => {
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
