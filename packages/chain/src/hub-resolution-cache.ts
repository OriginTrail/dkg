/**
 * Caches a Hub-resolved value (typically a `Contract` instance for a
 * given Hub-registered contract name). Re-resolves lazily when:
 *   - cache is empty (first call),
 *   - TTL expired (when `ttlMs > 0`), OR
 *   - `invalidate()` was called explicitly (e.g. from a Hub
 *     `ContractChanged` / `NewContract` event listener, or after a
 *     write surfaced `UnauthorizedAccess(Only Contracts in Hub)`).
 *
 * This is the structural fix for the post-rotation stale-address bug:
 * `EVMChainAdapter` cached every Hub-resolved address once at boot, so
 * a contract rotation on the live Hub (e.g. `RandomSampling` swapped
 * to a new deployment) silently broke writes from running daemons —
 * the OLD address kept getting called, was no longer "in Hub", and
 * its writes to its storage contract reverted with
 * `UnauthorizedAccess(Only Contracts in Hub)` until the daemon was
 * restarted.
 *
 * The cache is intentionally agnostic to what `T` is: callers wire it
 * up with a resolver closure that does the actual `Hub.getContractAddress`
 * + `new Contract(...)` step.
 */
export interface HubResolutionCacheOptions {
  /** Re-resolve when the cached value is older than this. `0` disables periodic refresh. */
  ttlMs?: number;
  /** Override clock for tests. */
  now?: () => number;
}

export class HubResolutionCache<T> {
  private cached: T | null = null;
  private resolvedAt = 0;
  private inflight: Promise<T> | null = null;
  /**
   * Monotonic generation counter. Bumped on every `invalidate()` so an
   * in-flight resolve started under generation N cannot write back its
   * value if `invalidate()` was called while it was suspended (the
   * post-invalidation get() is at generation N+1 and starts a fresh
   * resolve). Without this guard a Hub rotation that lands while a
   * previous tick's resolve is awaiting the RPC reply would re-cache
   * the **pre-rotation** address — exactly the stale-entry bug this
   * cache was added to fix.
   *
   * NOTE: This counter is INVALIDATE-ONLY. It does NOT bump on a
   * successful TTL-driven re-resolve. Callers that need to detect a
   * silent contract swap (e.g. via TTL refresh on a stale Hub view)
   * should compare the resolved value/identity itself rather than
   * relying solely on this counter — see
   * `EVMChainAdapter.inflightDurationProbeContract`.
   */
  private generation = 0;

  constructor(
    private readonly resolve: () => Promise<T>,
    private readonly opts: HubResolutionCacheOptions = {},
  ) {}

  /**
   * Return the cached value, re-resolving if it is missing or stale.
   * Concurrent callers during a re-resolve share the same in-flight
   * promise so we don't issue duplicate Hub reads, but only as long
   * as no `invalidate()` has fired in the interim — see `generation`.
   */
  async get(): Promise<T> {
    const now = this.opts.now?.() ?? Date.now();
    if (this.cached !== null) {
      const ttl = this.opts.ttlMs ?? 0;
      const stale = ttl > 0 && now - this.resolvedAt > ttl;
      if (!stale) return this.cached;
    }
    if (this.inflight) return this.inflight;
    const startGeneration = this.generation;
    this.inflight = (async () => {
      try {
        const value = await this.resolve();
        // If `invalidate()` ran while we were awaiting, the cache
        // now belongs to a newer generation (and a newer get() may
        // already be coalescing a fresh resolve). Returning `value`
        // to our awaiters is fine — they asked under our generation
        // — but we must not write it back to `cached` or future
        // synchronous reads would observe the stale address.
        if (this.generation === startGeneration) {
          this.cached = value;
          this.resolvedAt = this.opts.now?.() ?? Date.now();
        }
        return value;
      } finally {
        // Only clear `inflight` if we still own it. A concurrent
        // `invalidate()` may have already replaced it (effectively),
        // but checking by reference identity covers both the
        // single-resolve and racing cases.
        if (this.generation === startGeneration) {
          this.inflight = null;
        }
      }
    })();
    return this.inflight;
  }

  /**
   * Drop the cached value AND invalidate any in-flight resolve so its
   * result cannot write back to the cache. Next `get()` re-resolves
   * from source. Idempotent — duplicate calls (e.g. from the
   * double-emit `Hub.ContractChanged`/`NewContract` pair) are safe.
   */
  invalidate(): void {
    this.cached = null;
    this.resolvedAt = 0;
    this.generation += 1;
    this.inflight = null;
  }

  /** Snapshot the cached value without triggering a refresh. Returns `null` if never resolved or invalidated. */
  peek(): T | null {
    return this.cached;
  }

  /**
   * Snapshot the current generation. Callers use this to detect whether
   * an `invalidate()` has happened during their `await get()` window —
   * if `currentGeneration()` differs from a previously-captured value,
   * the awaited result was resolved against a stale Hub view and must
   * not be used for any downstream "remember this last-known address"
   * side-channel (it's still safe to *use once* and discard, since
   * `withHubStaleRetry` will catch the inevitable on-chain failure).
   */
  currentGeneration(): number {
    return this.generation;
  }
}
