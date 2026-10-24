/**
 * The external-store part of the GET /api/status wire contract (quad count and
 * reachability), and how fresh the count is kept, defined once. The daemon
 * route and ApiClient both import it, so changing a status value, a field or a
 * query spelling breaks the other side's compile instead of drifting silently.
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
   * COUNT at most once per {@link STORE_QUADS_CACHE_TTL_MS}.
   */
  includeStoreQuads?: boolean;
  /** Check, with a cheap `ASK`, that the store answers at all. */
  probeStore?: boolean;
}

/**
 * How long the daemon reuses a finished count, successful or failed: an
 * `includeStoreQuads` request inside this window starts no COUNT, whoever
 * sends it, so it caps how often any caller can make the daemon count.
 */
export const STORE_QUADS_CACHE_TTL_MS = 30_000;

/**
 * How old a successful count `dkg status` shows before it asks for a recount.
 * A full-store COUNT can occupy a large store for seconds, and scripts or
 * agents may run `dkg status` on a schedule. A failed or missing count it asks
 * for on every run, which {@link STORE_QUADS_CACHE_TTL_MS} caps.
 *
 * Kept next to the TTL because the two only work together: this window must
 * not be shorter than the TTL, or `dkg status` would ask for recounts that the
 * daemon answers from its cache. status-command-store.test.ts pins that.
 */
export const STORE_QUADS_REFRESH_AFTER_MS = 10 * 60_000;

// Each query parameter is spelled like its option.

/** The query string for a status request; empty when nothing is asked. */
export function serializeStatusQuery(options: StatusQueryOptions): string {
  const params = new URLSearchParams();
  const setFlag = (flag: keyof StatusQueryOptions): void => {
    if (options[flag]) params.set(flag, 'true');
  };
  setFlag('includeStoreQuads');
  setFlag('probeStore');
  return params.toString();
}

/** What a status request asked for. Each flag accepts `true` and the legacy `1`. */
export function parseStatusQuery(params: URLSearchParams): Required<StatusQueryOptions> {
  const isSet = (flag: keyof StatusQueryOptions): boolean => {
    const value = params.get(flag);
    return value === 'true' || value === '1';
  };
  return { includeStoreQuads: isSet('includeStoreQuads'), probeStore: isSet('probeStore') };
}
