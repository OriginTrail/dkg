/**
 * Per-key async serializer.
 *
 * Operations submitted under the same key run strictly one-at-a-time in
 * submission order; operations under different keys run concurrently. A
 * rejecting operation does not wedge its key's queue — the next operation
 * still runs.
 *
 * The EVM adapter uses this to serialize the nonce-critical send window
 * (populate → sign → broadcast → confirm) PER operational wallet. The
 * round-robin signer pool can route two concurrent writes to the SAME
 * wallet; without serialization both populate against the same `pending`
 * nonce before either is broadcast, so the second to land reverts
 * `Nonce too low` and the publish degrades to `tentative kaId:0`
 * (OriginTrail/dkg#953). Serializing per wallet keeps the nonce monotonic
 * while preserving cross-wallet concurrency.
 *
 * OBSERVABILITY (GH#1574). Acquisition used to be structurally invisible: the
 * wait for a predecessor was a bare promise-chain link with no timer, counter
 * or log. A queued caller's `fn` was simply never invoked, so none of the
 * downstream bounds ever armed — populate, broadcast and receipt deadlines all
 * apply AFTER acquisition. Three mainnet publishes logged "Submitting V10
 * on-chain publish tx" and then produced nothing for two hours, with
 * acquisition the only unbounded zero-diagnostic segment in the path.
 *
 * Each lane owns ONE observer that reports a bounded snapshot: who holds it,
 * how long, how deep the queue is, and how long the oldest waiter has waited.
 * Deliberately not one timer per queued call — a lane with a wedged holder and
 * 100 queued publishes would then create 101 timers and emit 101 lines per
 * cadence to describe a single unhealthy lane.
 */

/** Health of a single lane, as the serializer defines it. */
export type LaneState = 'idle' | 'busy' | 'stalled';

/** One bounded snapshot of a lane that has been busy long enough to report. */
export interface KeyedSerializerObservation {
  key: string;
  /** Queued + running operations. */
  depth: number;
  /** Operations queued behind the holder. */
  waiting: number;
  /** The operation currently holding the lane. */
  holderLabel: string;
  /** How long the holder has held it. */
  holdElapsedMs: number;
  /** The longest-waiting queued operation, when there is one. */
  oldestWaiterLabel?: string;
  oldestWaiterMs?: number;
  /** True once the hold passes the stall threshold — a wedge, not queueing. */
  stalled: boolean;
}

export interface KeyedSerializerOptions {
  /** Delay before the FIRST observation for a lane. */
  observeAfterMs?: number;
  /** Cadence of subsequent observations. Distinct from the initial delay. */
  observeIntervalMs?: number;
  /**
   * Beyond this hold duration a lane is `stalled` rather than `busy`. Callers
   * should derive it from their own in-lane bounds — the critical section
   * legitimately contains a full transaction round-trip.
   */
  stallAfterMs?: number;
  now?: () => number;
  onObserve?: (observation: KeyedSerializerObservation) => void;
}

const DEFAULT_OBSERVE_AFTER_MS = 30_000;
const DEFAULT_OBSERVE_INTERVAL_MS = 60_000;
const DEFAULT_STALL_AFTER_MS = 1_200_000;

interface Waiter {
  label: string;
  queuedAt: number;
}

interface Lane {
  tail: Promise<void>;
  /** Queued + running operations. Load-bearing: see `isActive`. */
  depth: number;
  holder?: { label: string; startedAt: number };
  /** Insertion-ordered, so the first entry is the longest-waiting. */
  waiters: Set<Waiter>;
  /** Exactly one observer per lane, whatever the queue depth. */
  firstTimer?: ReturnType<typeof setTimeout>;
  repeatTimer?: ReturnType<typeof setInterval>;
}

export class KeyedSerializer {
  private readonly lanes = new Map<string, Lane>();
  private readonly observeAfterMs: number;
  private readonly observeIntervalMs: number;
  private readonly stallAfterMs: number;
  private readonly now: () => number;
  private readonly onObserve: (o: KeyedSerializerObservation) => void;

  constructor(options: KeyedSerializerOptions = {}) {
    this.observeAfterMs = options.observeAfterMs ?? DEFAULT_OBSERVE_AFTER_MS;
    this.observeIntervalMs = options.observeIntervalMs ?? DEFAULT_OBSERVE_INTERVAL_MS;
    this.stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.now = options.now ?? Date.now;
    this.onObserve = options.onObserve ?? defaultObserve;
  }

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Returns `fn`'s result (or rejection) verbatim.
   *
   * `label` names the operation in diagnostics — pass the caller's own
   * operation name so a report can say WHAT is holding the lane.
   *
   * NO ACQUISITION TIMEOUT, deliberately. The critical section legitimately
   * contains a full transaction round-trip — the adapter's TRAC approval runs
   * INSIDE the lane bounded by its receipt deadline, and the forced-reapprove
   * path can do that twice — so a healthy publish can hold a lane ten to
   * twenty minutes. A timeout short enough to catch a wedge would abort
   * legitimate work; one long enough to be safe would not catch anything an
   * operator had not already noticed. Worse, `tail.then(fn, fn)` has `fn`
   * ALREADY chained, so rejecting the outer promise on a timer would leave
   * `fn` to run when the predecessor settles — sending a transaction for an
   * operation the caller gave up on and very likely retried elsewhere.
   * Reporting the wait is what turns a silent wedge into something
   * diagnosable, which is what GH#1574 asks for.
   */
  run<T>(key: string, fn: () => Promise<T>, label = 'write'): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), depth: 0, waiters: new Set() };
      this.lanes.set(key, lane);
    }
    const currentLane = lane;

    currentLane.depth += 1;
    const waiter: Waiter = { label, queuedAt: this.now() };
    currentLane.waiters.add(waiter);
    this.ensureObserver(key, currentLane);

    const wrapped = async (): Promise<T> => {
      // Synchronous, before any await: a caller that has acquired must never
      // be counted among the waiters.
      currentLane.waiters.delete(waiter);
      currentLane.holder = { label, startedAt: this.now() };
      try {
        return await fn();
      } finally {
        currentLane.holder = undefined;
        currentLane.depth -= 1;
      }
    };

    // `fn` runs once the predecessor settles, regardless of how it settled — a
    // failed predecessor must not skip or wedge the successor.
    const result = currentLane.tail.then(wrapped, wrapped);
    // The queue tail never rejects, so chaining the next op off it is safe.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    currentLane.tail = tail;
    // Keep the map bounded by in-flight keys, not history: once this tail
    // settles, drop it if nothing newer has been queued behind it.
    void tail.then(() => {
      const cur = this.lanes.get(key);
      if (cur === currentLane && cur.tail === tail) {
        this.clearObserver(cur);
        this.lanes.delete(key);
      }
    });
    return result;
  }

  /**
   * True while `key` has an in-flight or queued operation.
   *
   * LOAD-BEARING, not diagnostic: the adapter's fundable-signer selection uses
   * it to soft-prefer an idle wallet (GH#953). If a lane entry leaked, every
   * wallet would read busy forever and the idle bias would silently disappear
   * — making the wedge this class reports MORE likely.
   */
  isActive(key: string): boolean {
    return this.lanes.has(key);
  }

  /** Number of keys with an in-flight or queued operation. */
  get activeKeyCount(): number {
    return this.lanes.size;
  }

  /** Queued + running operations on `key`. 0 when the lane is idle. */
  depth(key: string): number {
    return this.lanes.get(key)?.depth ?? 0;
  }

  /**
   * Lane health, as ONE definition owned here.
   *
   * The adapter ranks this when choosing a wallet rather than reading raw
   * timings and re-deriving the threshold — two copies of the policy would
   * drift, and diagnostics could then call a lane stalled while wallet
   * selection still called it healthy.
   */
  state(key: string): LaneState {
    const lane = this.lanes.get(key);
    if (!lane) return 'idle';
    const holder = lane.holder;
    if (holder && this.now() - holder.startedAt >= this.stallAfterMs) return 'stalled';
    return 'busy';
  }

  /** True when `key`'s holder has held past the stall threshold. */
  isStalled(key: string): boolean {
    return this.state(key) === 'stalled';
  }

  /** How long the current holder of `key` has held it, if any. */
  holdElapsedMs(key: string): number | undefined {
    const holder = this.lanes.get(key)?.holder;
    return holder ? this.now() - holder.startedAt : undefined;
  }

  /**
   * Arm the lane's single observer: one shot after `observeAfterMs`, then
   * every `observeIntervalMs`. Keeping the initial delay and the repeat
   * cadence distinct matters — reusing the smaller of the two for a repeating
   * timer makes a long wedge log twice as often as configured.
   */
  private ensureObserver(key: string, lane: Lane): void {
    if (lane.firstTimer !== undefined || lane.repeatTimer !== undefined) return;
    lane.firstTimer = setTimeout(() => {
      lane.firstTimer = undefined;
      this.emit(key, lane);
      lane.repeatTimer = setInterval(() => this.emit(key, lane), this.observeIntervalMs);
      lane.repeatTimer.unref?.();
    }, this.observeAfterMs);
    // Never hold the process open for a diagnostic.
    lane.firstTimer.unref?.();
  }

  private clearObserver(lane: Lane): void {
    if (lane.firstTimer !== undefined) {
      clearTimeout(lane.firstTimer);
      lane.firstTimer = undefined;
    }
    if (lane.repeatTimer !== undefined) {
      clearInterval(lane.repeatTimer);
      lane.repeatTimer = undefined;
    }
  }

  private emit(key: string, lane: Lane): void {
    const holder = lane.holder;
    // Nothing holds the lane — a handover in progress is not worth reporting.
    if (!holder) return;
    const oldest = lane.waiters.values().next().value as Waiter | undefined;
    const holdElapsedMs = this.now() - holder.startedAt;
    this.onObserve({
      key,
      depth: lane.depth,
      waiting: lane.waiters.size,
      holderLabel: holder.label,
      holdElapsedMs,
      oldestWaiterLabel: oldest?.label,
      oldestWaiterMs: oldest ? this.now() - oldest.queuedAt : undefined,
      stalled: holdElapsedMs >= this.stallAfterMs,
    });
  }
}

function defaultObserve(o: KeyedSerializerObservation): void {
  const waiting = o.waiting > 0
    ? ` ${o.waiting} operation(s) queued behind it` +
      (o.oldestWaiterLabel
        ? `, longest ${o.oldestWaiterLabel} waiting ${Math.round((o.oldestWaiterMs ?? 0) / 1000)}s`
        : '')
    : ' nothing queued behind it';
  // `console.warn` is the logging convention in this package.
  console.warn(
    `[chain] tx serializer${o.stalled ? ' STALL' : ''}: ${o.holderLabel} has held the lane for ` +
      `${o.key} ${Math.round(o.holdElapsedMs / 1000)}s;${waiting}.`,
  );
}
