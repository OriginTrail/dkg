/**
 * OT-RFC-38 LU-6 Phase B — Pre-registration ciphertext rate-limits.
 *
 * The discovery-beacon path lets cores host SWM ciphertext for
 * curated CGs that haven't paid gas to register on chain (the
 * freemium tier). To prevent this from becoming a free DoS vector
 * (any wallet can spam beacons and saturate cores with ciphertext),
 * we apply two layers of sliding-window budgets:
 *
 *   1. **Per-curator-EOA** sliding window
 *        - SPEC §1.2.4 numbers: 1 MB/min AND 50 MB/h
 *        - First trip rejects the offending envelope; the curator's
 *          window is unchanged so a subsequent re-attempt will still
 *          be over budget until the window slides.
 *
 *   2. **Per-core aggregate**
 *        - Total pre-registration ciphertext held across ALL
 *          curators. Default 4 GB (configurable). Hits eviction
 *          BEFORE the per-curator window; if a core is at its
 *          aggregate cap it returns "rejected: core full" without
 *          mutating any per-curator counter.
 *
 * Design notes:
 *
 * - **In-memory** sliding window. Survives daemon restart by
 *   re-reading from the SwmHostModeStore on init (caller's
 *   responsibility — see `seed()`). Restart amnesia is acceptable
 *   for this abuse-control surface; the on-disk per-CG byte cap +
 *   TTL handle the actual storage cleanup.
 *
 * - **Two windows** (1 min + 1 h) tracked independently — a curator
 *   can burst up to 1 MB in a single minute, but 50 MB/h means the
 *   sustained rate after the first minute drops to ~830 KB/min on
 *   average.
 *
 * - **Per-second buckets** for both windows: O(1) eviction on slide,
 *   tight memory bound (60 buckets for the 1-min window, 3600
 *   buckets for the 1-h window; per-curator).
 *
 * - **Curator key is the recovered EOA from the beacon**, never the
 *   `senderPeerId`. The peer id is libp2p-derived and rotates;
 *   wallet identity is the abuse vector we actually want to bound.
 */

export interface DiscoveryRateLimitOptions {
  /** Per-curator EOA per-minute byte cap. Default: 1 MB. */
  perCuratorBytesPerMinute?: number;
  /** Per-curator EOA per-hour byte cap. Default: 50 MB. */
  perCuratorBytesPerHour?: number;
  /** Per-core aggregate byte cap (all unregistered CGs). Default: 4 GB. */
  coreAggregateBytes?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AdmissionResult {
  /** True iff the envelope should be admitted into host-mode storage. */
  admit: boolean;
  /** Human-readable rejection reason when admit=false. */
  reason?: string;
  /** Snapshot of relevant counters at decision time (for logging/metrics). */
  state: {
    curatorBytesThisMinute: number;
    curatorBytesThisHour: number;
    coreAggregateBytes: number;
  };
}

interface CuratorWindow {
  /** Per-second buckets covering the last 60 s. */
  minuteBuckets: Map<number, number>;
  /** Per-second buckets covering the last 3600 s. */
  hourBuckets: Map<number, number>;
}

const DEFAULT_PER_CURATOR_BYTES_PER_MINUTE = 1 * 1024 * 1024;
const DEFAULT_PER_CURATOR_BYTES_PER_HOUR = 50 * 1024 * 1024;
const DEFAULT_CORE_AGGREGATE_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Sliding-window rate-limiter for pre-registration ciphertext writes
 * admitted via discovery-beacon auto-host. Thread-safety: assumes a
 * single-event-loop context (the agent's). Concurrent `admit` calls
 * for the same curator would interleave reads/writes without locking,
 * but Node's per-tick atomicity makes this safe at this granularity.
 */
export class DiscoveryRateLimit {
  private readonly perCuratorBytesPerMinute: number;
  private readonly perCuratorBytesPerHour: number;
  private readonly coreAggregateBytes: number;
  private readonly now: () => number;
  private readonly curators = new Map<string, CuratorWindow>();
  private coreAggregateNow = 0;

  constructor(options: DiscoveryRateLimitOptions = {}) {
    this.perCuratorBytesPerMinute = options.perCuratorBytesPerMinute ?? DEFAULT_PER_CURATOR_BYTES_PER_MINUTE;
    this.perCuratorBytesPerHour = options.perCuratorBytesPerHour ?? DEFAULT_PER_CURATOR_BYTES_PER_HOUR;
    this.coreAggregateBytes = options.coreAggregateBytes ?? DEFAULT_CORE_AGGREGATE_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Seed the per-core aggregate counter from on-disk state (called
   * on agent start after the SwmHostModeStore enumerates its
   * unregistered totals). Per-curator windows are NOT seeded —
   * they cold-start empty on every restart, which is intentional
   * (the abuse-control window is "ongoing" rather than "ever").
   */
  seedAggregate(bytesOnDisk: number): void {
    this.coreAggregateNow = Math.max(0, bytesOnDisk);
  }

  /**
   * Inspect whether an `envelopeBytes`-sized write from `curatorEoa`
   * would be admitted, AND if so, commit the write to the budget.
   * One call covers both the dry-run check and the bookkeeping —
   * callers shouldn't try to split these (race conditions across
   * the two phases would let bursts past the cap).
   *
   * Returns `admit: false` AND DOES NOT mutate any counter when the
   * write would exceed any cap.
   */
  admit(curatorEoa: string, envelopeBytes: number): AdmissionResult {
    const eoa = curatorEoa.toLowerCase();
    const nowSec = Math.floor(this.now() / 1000);
    const window = this.getOrCreateWindow(eoa);
    pruneOlderThan(window.minuteBuckets, nowSec - 60);
    pruneOlderThan(window.hourBuckets, nowSec - 3600);

    const curatorMinute = sumBuckets(window.minuteBuckets);
    const curatorHour = sumBuckets(window.hourBuckets);

    const state = {
      curatorBytesThisMinute: curatorMinute,
      curatorBytesThisHour: curatorHour,
      coreAggregateBytes: this.coreAggregateNow,
    };

    if (this.coreAggregateNow + envelopeBytes > this.coreAggregateBytes) {
      return {
        admit: false,
        reason: `core aggregate budget exceeded: ${this.coreAggregateNow + envelopeBytes} > ${this.coreAggregateBytes} bytes`,
        state,
      };
    }
    if (curatorMinute + envelopeBytes > this.perCuratorBytesPerMinute) {
      return {
        admit: false,
        reason: `curator ${eoa} per-minute budget exceeded: ${curatorMinute + envelopeBytes} > ${this.perCuratorBytesPerMinute} bytes`,
        state,
      };
    }
    if (curatorHour + envelopeBytes > this.perCuratorBytesPerHour) {
      return {
        admit: false,
        reason: `curator ${eoa} per-hour budget exceeded: ${curatorHour + envelopeBytes} > ${this.perCuratorBytesPerHour} bytes`,
        state,
      };
    }

    window.minuteBuckets.set(nowSec, (window.minuteBuckets.get(nowSec) ?? 0) + envelopeBytes);
    window.hourBuckets.set(nowSec, (window.hourBuckets.get(nowSec) ?? 0) + envelopeBytes);
    this.coreAggregateNow += envelopeBytes;

    return {
      admit: true,
      state: {
        curatorBytesThisMinute: curatorMinute + envelopeBytes,
        curatorBytesThisHour: curatorHour + envelopeBytes,
        coreAggregateBytes: this.coreAggregateNow,
      },
    };
  }

  /**
   * Decrement the core-aggregate counter when bytes are reclaimed
   * (TTL prune, byte-cap eviction, or CG transitions to registered
   * and stops counting against the pre-reg budget). Per-curator
   * windows are NOT affected — those are based on wall-clock
   * arrivals; reclaim doesn't unwind history.
   *
   * Safe to call with `bytes > current aggregate`; clamps to zero.
   */
  releaseAggregate(bytes: number): void {
    this.coreAggregateNow = Math.max(0, this.coreAggregateNow - bytes);
  }

  /** Test-only state snapshot. */
  snapshot(): {
    coreAggregateBytes: number;
    curators: Record<string, { minuteBytes: number; hourBytes: number }>;
  } {
    const out: Record<string, { minuteBytes: number; hourBytes: number }> = {};
    for (const [eoa, window] of this.curators.entries()) {
      out[eoa] = {
        minuteBytes: sumBuckets(window.minuteBuckets),
        hourBytes: sumBuckets(window.hourBuckets),
      };
    }
    return { coreAggregateBytes: this.coreAggregateNow, curators: out };
  }

  private getOrCreateWindow(eoa: string): CuratorWindow {
    let window = this.curators.get(eoa);
    if (!window) {
      window = { minuteBuckets: new Map(), hourBuckets: new Map() };
      this.curators.set(eoa, window);
    }
    return window;
  }
}

function pruneOlderThan(buckets: Map<number, number>, cutoffSec: number): void {
  for (const key of buckets.keys()) {
    if (key <= cutoffSec) buckets.delete(key);
  }
}

function sumBuckets(buckets: Map<number, number>): number {
  let total = 0;
  for (const v of buckets.values()) total += v;
  return total;
}
