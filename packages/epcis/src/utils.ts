import type { EpcisQueryParams } from './types.js';

const FILTER_KEYS = ['epc', 'bizStep', 'bizLocation', 'from', 'to', 'parentID', 'childEPC', 'inputEPC', 'outputEPC'] as const;

/** Parse URLSearchParams into typed EpcisQueryParams. */
export function parseQueryParams(sp: URLSearchParams): EpcisQueryParams {
  const params: EpcisQueryParams = {};

  for (const key of FILTER_KEYS) {
    const val = sp.get(key);
    if (val != null && val !== '') {
      (params as Record<string, string>)[key] = val;
    }
  }

  const fullTrace = sp.get('fullTrace');
  if (fullTrace != null) {
    params.fullTrace = fullTrace === 'true';
  }

  const limit = sp.get('limit');
  if (limit != null && /^\d+$/.test(limit)) {
    params.limit = Number.parseInt(limit, 10);
  }

  const offset = sp.get('offset');
  if (offset != null && /^\d+$/.test(offset)) {
    params.offset = Number.parseInt(offset, 10);
  }

  return params;
}

/** Returns true if at least one actual filter param is set (excludes fullTrace, limit, offset). */
export function hasAtLeastOneFilter(params: EpcisQueryParams): boolean {
  return FILTER_KEYS.some((key) => params[key] !== undefined);
}

/** Returns true if the date range is valid (from <= to), or if either/both are missing. */
export function hasValidDateRange(params: Pick<EpcisQueryParams, 'from' | 'to'>): boolean {
  if (!params.from || !params.to) return true;
  return Date.parse(params.from) <= Date.parse(params.to);
}
