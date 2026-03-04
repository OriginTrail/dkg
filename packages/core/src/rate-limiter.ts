/**
 * Sliding-window rate limiter for per-peer / per-topic / per-protocol throttling.
 *
 * Uses a token-bucket approach with automatic stale-entry cleanup.
 */

export interface RateLimitConfig {
  /** Maximum number of events allowed within the window. */
  maxPerWindow: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

interface BucketEntry {
  timestamps: number[];
  blocked: boolean;
}

export class RateLimiter {
  private readonly config: RateLimitConfig;
  private readonly buckets = new Map<string, BucketEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(config.windowMs * 2, 60_000));
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   * Automatically records the event if allowed.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    let entry = this.buckets.get(key);

    if (!entry) {
      entry = { timestamps: [now], blocked: false };
      this.buckets.set(key, entry);
      return true;
    }

    entry.timestamps = entry.timestamps.filter(t => t > cutoff);

    if (entry.timestamps.length >= this.config.maxPerWindow) {
      entry.blocked = true;
      return false;
    }

    entry.timestamps.push(now);
    entry.blocked = false;
    return true;
  }

  /** Check without recording — peek at whether next request would be allowed. */
  wouldAllow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const entry = this.buckets.get(key);
    if (!entry) return true;
    const active = entry.timestamps.filter(t => t > cutoff);
    return active.length < this.config.maxPerWindow;
  }

  /** Number of requests remaining in the current window for this key. */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const entry = this.buckets.get(key);
    if (!entry) return this.config.maxPerWindow;
    const active = entry.timestamps.filter(t => t > cutoff);
    return Math.max(0, this.config.maxPerWindow - active.length);
  }

  /** Remove stale entries that have no timestamps in the current window. */
  private cleanup(): void {
    const cutoff = Date.now() - this.config.windowMs;
    for (const [key, entry] of this.buckets) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  /** Stop the cleanup timer (call on shutdown). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  /** Current number of tracked keys. */
  get size(): number {
    return this.buckets.size;
  }
}
