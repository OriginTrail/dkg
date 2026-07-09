/**
 * Signer-registration TTL cache for the storage-ACK path.
 *
 * Extracted from `storage-ack-handler.ts` (otReviewAgent #1408): a small,
 * dependency-free chain-read cache the agent wires around
 * `chain.isOperationalWalletRegistered`. It owns no ACK-handler state, so it
 * lives on the signer-registration/chain-read boundary rather than widening the
 * protocol handler's surface.
 */

/**
 * Default freshness window for {@link withSignerRegistrationCache}: a
 * signer-registration verdict is served from cache (no chain read) for
 * this long after the last successful lookup. Registration changes are
 * operator-driven and rare, so 30s of staleness is a safe trade for not
 * issuing one live RPC per inbound StorageACK request.
 */
export const SIGNER_REGISTRATION_CACHE_TTL_MS = 30_000;
/**
 * Default serve-stale window for {@link withSignerRegistrationCache}:
 * when the live lookup THROWS, a previously-successful verdict this
 * recent is served instead of propagating the error. Generous on
 * purpose — a degraded shared RPC should not stop an otherwise-healthy
 * core from ACKing for minutes at a time.
 */
export const SIGNER_REGISTRATION_STALE_WINDOW_MS = 5 * 60_000;

/**
 * Wrap a live signer-registration lookup (`StorageACKHandlerConfig.
 * isSignerRegistered`) with a tiny TTL cache + serve-stale-on-error.
 *
 * Why this exists (testnet storage-ACK dead-air incident): the agent
 * wires `isSignerRegistered` straight to `chain.
 * isOperationalWalletRegistered` — a LIVE, UNCACHED chain read executed
 * on EVERY inbound StorageACK request, on EVERY core. When the shared
 * RPC degrades, every ACK on every core fails its signer lookup
 * simultaneously and the whole network stops ACKing at once. Caching
 * the last good verdict bounds the blast radius of an RPC blip to at
 * most one decline per core per stale window.
 *
 * Semantics:
 *   - within `ttlMs` of the last SUCCESSFUL lookup: cached verdict,
 *     zero chain reads (both `true` and `false` are cached — a
 *     known-unregistered signer should not hammer the RPC either);
 *   - lookup THROWS + a cached verdict newer than `staleWindowMs`
 *     exists: serve the stale verdict (`onServedStale` fires so the
 *     caller can log it at DEBUG);
 *   - lookup THROWS + no usable cache: rethrow — the handler turns
 *     that into a transient `CORE_TEMPORARILY_UNAVAILABLE` decline.
 *
 * Deliberately dependency-free closure state (no timers, no cross-
 * package cache util) so the agent can wire it inline. `now` is an
 * injection seam for tests only.
 */
export function withSignerRegistrationCache(
  lookup: () => Promise<boolean>,
  options: {
    ttlMs?: number;
    staleWindowMs?: number;
    /** Called when a lookup error was absorbed by serving a stale verdict. */
    onServedStale?: (err: unknown, staleValue: boolean) => void;
    /** Test seam — defaults to `Date.now`. */
    now?: () => number;
  } = {},
): () => Promise<boolean> {
  const ttlMs = options.ttlMs ?? SIGNER_REGISTRATION_CACHE_TTL_MS;
  const staleWindowMs = options.staleWindowMs ?? SIGNER_REGISTRATION_STALE_WINDOW_MS;
  const now = options.now ?? Date.now;
  let cached: { value: boolean; at: number } | undefined;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    try {
      const value = await lookup();
      cached = { value, at: now() };
      return value;
    } catch (err) {
      if (cached && now() - cached.at < staleWindowMs) {
        try {
          options.onServedStale?.(err, cached.value);
        } catch {
          // Observability must never change the probe's answer.
        }
        return cached.value;
      }
      throw err;
    }
  };
}
