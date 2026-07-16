import type { EpcisQueryParams } from './types.js';

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
const STANDARD_TO_CANONICAL: Record<string, keyof EpcisQueryParams> = {
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

/** Parse URLSearchParams into typed EpcisQueryParams. */
export function parseQueryParams(sp: URLSearchParams): EpcisQueryParams {
  const params: EpcisQueryParams = { finalized: true };

  for (const key of FILTER_KEYS) {
    const val = resolveParam(sp, key);
    if (val !== undefined) {
      (params as Record<string, string>)[key] = val;
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
    params.anyEPC = anyEpcStandard;
    delete params.epc;
  } else {
    const fullTrace = sp.get('fullTrace');
    if (fullTrace === 'true' && params.epc) {
      params.anyEPC = params.epc;
      delete params.epc;
    }
  }

  const perPage = sp.get('perPage');
  if (perPage != null && /^\d+$/.test(perPage)) {
    params.perPage = Number.parseInt(perPage, 10);
  }

  // limit is an alias for perPage — only applies if perPage wasn't explicitly set
  const limit = sp.get('limit');
  if (params.perPage == null && limit != null && /^\d+$/.test(limit)) {
    params.perPage = Number.parseInt(limit, 10);
  }

  // nextPageToken is a base64-encoded "offset:N" — takes precedence over raw offset
  const nextPageToken = sp.get('nextPageToken');
  if (nextPageToken) {
    const decoded = decodePageToken(nextPageToken);
    if (decoded != null) {
      params.offset = decoded;
    }
  }

  if (params.offset == null) {
    const offset = sp.get('offset');
    if (offset != null && /^\d+$/.test(offset)) {
      params.offset = Number.parseInt(offset, 10);
    }
  }

  if (sp.get('finalized') === 'false') {
    params.finalized = false;
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
