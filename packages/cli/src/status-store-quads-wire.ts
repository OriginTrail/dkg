/**
 * The external-store part of the GET /api/status wire contract (quad count and
 * reachability), defined once. The daemon route and ApiClient both import it,
 * so changing a status value, a field or a query spelling breaks the other
 * side's compile instead of drifting silently.
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

/**
 * How an external store answered a cheap reachability check (`ASK`) made for
 * this request: it answered, it failed, or it gave no answer in time. No
 * answer is not reported as unreachable, because a busy store, or a busy
 * daemon store scheduler, delays the check too.
 */
export type StoreReachability = 'reachable' | 'unreachable' | 'no-answer';

/** Sent only when the request asked for the check and the store is external. */
export interface StoreReachabilityFields {
  storeReachability?: StoreReachability;
}

/**
 * What a status request asks the daemon to do besides reporting. Both cost
 * store work, so set them only when actually needed, never for polling.
 */
export interface StatusQueryOptions {
  /**
   * Refresh the cached count in the background, which costs a full-store
   * COUNT at most once per daemon cache TTL.
   */
  includeStoreQuads?: boolean;
  /** Check, with a cheap `ASK`, that the store answers at all. */
  probeStore?: boolean;
}

/**
 * Option name -> query parameter name. `satisfies` makes the map total: an
 * option added to {@link StatusQueryOptions} without a wire key is a compile
 * error.
 */
const STATUS_QUERY_WIRE_KEYS = {
  includeStoreQuads: 'includeStoreQuads',
  probeStore: 'probeStore',
} as const satisfies Record<keyof StatusQueryOptions, string>;

/** The query string for a status request; empty when nothing is asked. */
export function serializeStatusQuery(options: StatusQueryOptions): string {
  const params = new URLSearchParams();
  for (const option of Object.keys(STATUS_QUERY_WIRE_KEYS) as Array<keyof StatusQueryOptions>) {
    if (options[option]) params.set(STATUS_QUERY_WIRE_KEYS[option], 'true');
  }
  return params.toString();
}

/** What a status request asked for. Each flag accepts `true` and the legacy `1`. */
export function parseStatusQuery(params: URLSearchParams): Required<StatusQueryOptions> {
  const isSet = (option: keyof StatusQueryOptions): boolean => {
    const value = params.get(STATUS_QUERY_WIRE_KEYS[option]);
    return value === 'true' || value === '1';
  };
  return { includeStoreQuads: isSet('includeStoreQuads'), probeStore: isSet('probeStore') };
}
