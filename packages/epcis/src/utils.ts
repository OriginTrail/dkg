import { EpcisQueryValidationError } from './query-validation.js';
import type { EpcisQueryParams, EpcisEventFilters, EpcisEventsRequest, EpcisPageParams } from './types.js';

/** Decode a base64 nextPageToken ("offset:N") to its numeric offset, or null if invalid. */
export function decodePageToken(token: string): number | null {
  try {
    const decoded = atob(token);
    const match = decoded.match(/^offset:(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/** Encode a numeric offset into a base64 nextPageToken. */
export function encodePageToken(offset: number): string {
  return btoa(`offset:${offset}`);
}

const FILTER_KEYS = ['eventID', 'epc', 'bizStep', 'bizLocation', 'from', 'to', 'parentID', 'childEPC', 'inputEPC', 'outputEPC', 'configurationId', 'shipmentId', 'eventType', 'action', 'disposition', 'readPoint'] as const;

/** Maps EPCIS 2.0 standard parameter names to internal canonical names. */
const STANDARD_TO_CANONICAL: Record<string, keyof EpcisEventFilters> = {
  MATCH_epc: 'epc',
  EQ_bizStep: 'bizStep',
  EQ_bizLocation: 'bizLocation',
  GE_eventTime: 'from',
  LT_eventTime: 'to',
  MATCH_parentID: 'parentID',
  MATCH_inputEPC: 'inputEPC',
  MATCH_outputEPC: 'outputEPC',
  EQ_configurationId: 'configurationId',
  EQ_shipmentId: 'shipmentId',
  EQ_action: 'action',
  EQ_disposition: 'disposition',
  EQ_readPoint: 'readPoint',
};

/** Read a param by standard name first, then alias. Standard takes precedence. */
function resolveParam(sp: URLSearchParams, canonical: string): string | undefined {
  // Find the standard name that maps to this canonical key
  for (const [standard, target] of Object.entries(STANDARD_TO_CANONICAL)) {
    if (target === canonical) {
      const val = sp.get(standard);
      if (val != null && val !== '') return val;
    }
  }
  // Fall back to alias (friendly name)
  const val = sp.get(canonical);
  if (val != null && val !== '') return val;
  return undefined;
}

/** A supplied numeric field must not silently become an omitted field. */
function parsePaginationInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new EpcisQueryValidationError(`EPCIS ${name} must be a nonnegative safe integer`);
  }
  return Number(value);
}

/** Normalize HTTP aliases once, keeping event filters separate from paging. */
export function parseEventsRequest(sp: URLSearchParams): EpcisEventsRequest {
  const filters: EpcisEventFilters = {};
  const page: EpcisPageParams = {};

  for (const key of FILTER_KEYS) {
    const val = resolveParam(sp, key);
    if (val !== undefined) {
      filters[key] = val;
    }
  }

  // MATCH_anyEPC (standard EPCIS name), `anyEPC` (canonical alias —
  // matches the api-client's `EpcisEventQuery.anyEPC` field; accepting
  // both mirrors the FILTER_KEYS dual-name resolution above), or
  // epc+fullTrace=true (backward compat). Without the `anyEPC` alias
  // here, `dkg epcis query --any-epc <urn>` (which the api-client
  // serializes as `?anyEPC=<urn>`) was silently dropped — the server
  // returned an unfiltered eventList and the user never saw the filter
  // failed to apply.
  const anyEpcStandard = sp.get('MATCH_anyEPC') ?? sp.get('anyEPC');
  if (anyEpcStandard != null && anyEpcStandard !== '') {
    filters.anyEPC = anyEpcStandard;
    delete filters.epc;
  } else {
    const fullTrace = sp.get('fullTrace');
    if (fullTrace === 'true' && filters.epc) {
      filters.anyEPC = filters.epc;
      delete filters.epc;
    }
  }

  // The explicit perPage value wins over its limit alias, including invalid input.
  const perPage = sp.get('perPage') ?? sp.get('limit');
  if (perPage !== null) page.perPage = parsePaginationInteger(perPage, 'page size');

  // nextPageToken is a base64-encoded "offset:N" — takes precedence over raw offset
  const nextPageToken = sp.get('nextPageToken');
  if (nextPageToken) {
    const decoded = decodePageToken(nextPageToken);
    if (decoded != null) {
      page.offset = decoded;
    }
  }

  if (page.offset == null) {
    const offset = sp.get('offset');
    if (offset !== null) {
      page.offset = parsePaginationInteger(offset, 'offset');
    }
  }

  return { filters, page, finalized: sp.get('finalized') !== 'false' };
}

/** @deprecated Use parseEventsRequest for separate filters, page and scope input. */
export function parseQueryParams(sp: URLSearchParams): EpcisQueryParams {
  const { filters, page, finalized } = parseEventsRequest(sp);
  return { ...filters, ...page, finalized };
}

/** Returns true if at least one actual filter param is set (excludes fullTrace, limit, offset). */
export function hasAtLeastOneFilter(params: EpcisQueryParams): boolean {
  return FILTER_KEYS.some((key) => params[key] !== undefined);
}

/** Returns true if the date range is valid (from <= to), or if either/both are missing. */
export function hasValidDateRange(params: Pick<EpcisEventFilters, 'from' | 'to'>): boolean {
  if (!params.from || !params.to) return true;
  return Date.parse(params.from) <= Date.parse(params.to);
}
