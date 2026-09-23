/**
 * The external-store quad-count part of the GET /api/status wire contract,
 * defined once. The daemon route and ApiClient both import it, so changing a
 * status value, a field or the query spelling breaks the other side's compile
 * instead of drifting silently.
 */

/**
 * What the reported count means: 'not-requested' (no count has been asked
 * for; plain /api/status never starts one), 'pending' (a count is running),
 * 'ready', or 'unreachable' (the last count failed).
 */
export type StoreQuadsStatus = 'not-requested' | 'pending' | 'ready' | 'unreachable';

/**
 * The quad-count fields of the status response. Local backends send only
 * `storeQuads: null`. Older daemons omit the age. Asked with
 * `includeStoreQuads=true`, only daemons before 10.0.6 omit the status, and
 * for them a null count keeps its legacy unreachable meaning; 10.0.7 to
 * 10.0.18 also omit it from plain /api/status until a count is cached, and
 * there null means only that no count is cached yet.
 */
export interface StoreQuadsStatusFields {
  storeQuads?: number | null;
  storeQuadsStatus?: StoreQuadsStatus;
  /** Age of the cached result on the daemon's clock; null when there is none or it is unknown. */
  storeQuadsAgeMs?: number | null;
  /** Whether a count is running in the background, to replace the reported result. */
  storeQuadsRefreshing?: boolean;
}

const INCLUDE_STORE_QUADS_PARAM = 'includeStoreQuads';

/**
 * Query asking the daemon to refresh its cached count in the background, which
 * costs a full-store COUNT at most once per daemon cache TTL.
 */
export const INCLUDE_STORE_QUADS_QUERY = `${INCLUDE_STORE_QUADS_PARAM}=true`;

/** Whether a status request asked for a count refresh. */
export function parseIncludeStoreQuads(params: URLSearchParams): boolean {
  const value = params.get(INCLUDE_STORE_QUADS_PARAM);
  return value === 'true' || value === '1';
}
