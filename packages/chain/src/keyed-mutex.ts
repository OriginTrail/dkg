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
 * wait for a predecessor was a bare promise-chain link with no timer, no
 * counter and no log. A queued caller's `fn` was simply never invoked, so none
 * of the downstream bounds ever armed — populate, broadcast and receipt
 * deadlines all apply AFTER acquisition. Three mainnet publishes logged
 * "Submitting V10 on-chain publish tx" and then produced nothing for two
 * hours, with acquisition the only unbounded zero-diagnostic segment in the
 * path. This class now reports long waits and long holds; it deliberately does
 * NOT impose an acquisition timeout — see the note on `run`.
 */

/** Observation emitted while a caller waits for, or holds, a lane. */
export interface KeyedSerializerObservation {
  kind: 'wait' | 'hold';
  key: string;
  /** Caller-supplied description of the operation. */
  label: string;
  /** Milliseconds spent waiting (kind='wait') or holding (kind='hold'). */
  elapsedMs: number;
  /** Queued operations ahead of this caller at submission (kind='wait'). */
  positionsAhead: number;
  /** Total queued+running operations on this key right now. */
  depth: number;
  /** The operation currently holding the lane, when known (kind='wait'). */
  holderLabel?: string;
  /** True once elapsed passes the stall threshold — a wedge, not queueing. */
  stalled: boolean;
}

export interface KeyedSerializerOptions {
  /** Emit the first observation after this long. */
  observeAfterMs?: number;
  /** Repeat cadence after the first observation. */
  observeIntervalMs?: number;
  /**
   * Beyond this, a wait or hold is reported as stalled rather than queued.
   * Callers should derive it from their own in-lane bounds — the critical
   * section legitimately contains a full transaction round-trip.
   */
  stallAfterMs?: number;
  now?: () => number;
  onObserve?: (observation: KeyedSerializerObservation) => void;
}

const DEFAULT_OBSERVE_AFTER_MS = 30_000;
const DEFAULT_OBSERVE_INTERVAL_MS = 60_000;
const DEFAULT_STALL_AFTER_MS = 1_200_000;

interface Lane {
  tail: Promise<void>;
  /** Queued + running operations. Load-bearing: see `isActive`. */
  depth: number;
  holder?: { label: string; startedAt: number };
  /** At most one holder, so at most one hold observer. */
  holdTimer?: ReturnType<typeof setInterval>;
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
   * NO ACQUISITION TIMEOUT, deliberately. The critical section legitimately
   * contains a full transaction round-trip — `ensureV10ApproveTrac` runs
   * INSIDE the lane and is bounded by the adapter's receipt deadline (600s by
   * default), and the forced-reapprove path can do that twice — so a healthy
   * publish can hold a lane for ten to twenty minutes. A timeout short enough
   * to catch a wedge would abort legitimate work; one long enough to be safe
   * would not catch anything the operator has not already noticed. Reporting
   * the wait is what turns a silent two-hour wedge into something diagnosable,
   * which is what the issue actually asks for.
   */
  run<T>(key: string, fn: () => Promise<T>, label = 'write'): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), depth: 0 };
      this.lanes.set(key, lane);
    }
    const currentLane = lane;

    const queuedAt = this.now();
    currentLane.depth += 1;
    const positionsAhead = currentLane.depth - 1;

    // The wait observer is CALL-SCOPED, never stored on the lane. Several
    // callers can be waiting at once, so a single slot on `Lane` would be
    // overwritten by each new arrival — leaking the previous timer and, at
    // depth >= 3, emitting false stall reports on a healthy lane.
    let waitTimer: ReturnType<typeof setInterval> | undefined;
    const clearWaitObserver = (): void => {
      if (waitTimer !== undefined) {
        clearInterval(waitTimer);
        waitTimer = undefined;
      }
    };
    if (positionsAhead > 0) {
      waitTimer = setInterval(() => {
        const elapsedMs = this.now() - queuedAt;
        if (elapsedMs < this.observeAfterMs) return;
        this.onObserve({
          kind: 'wait',
          key,
          label,
          elapsedMs,
          positionsAhead,
          depth: currentLane.depth,
          holderLabel: currentLane.holder?.label,
          stalled: elapsedMs >= this.stallAfterMs,
        });
      }, Math.min(this.observeAfterMs, this.observeIntervalMs));
      // Never hold the process open for a diagnostic.
      waitTimer.unref?.();
    }

    const wrapped = async (): Promise<T> => {
      // FIRST statement, synchronous, before any await: a caller that has
      // acquired must never emit a "waiting" line.
      clearWaitObserver();
      const startedAt = this.now();
      currentLane.holder = { label, startedAt };
      currentLane.holdTimer = setInterval(() => {
        const elapsedMs = this.now() - startedAt;
        if (elapsedMs < this.observeAfterMs) return;
        this.onObserve({
          kind: 'hold',
          key,
          label,
          elapsedMs,
          positionsAhead: 0,
          depth: currentLane.depth,
          stalled: elapsedMs >= this.stallAfterMs,
        });
      }, Math.min(this.observeAfterMs, this.observeIntervalMs));
      currentLane.holdTimer.unref?.();
      try {
        return await fn();
      } finally {
        if (currentLane.holdTimer !== undefined) {
          clearInterval(currentLane.holdTimer);
          currentLane.holdTimer = undefined;
        }
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
        clearWaitObserver();
        if (cur.holdTimer !== undefined) {
          clearInterval(cur.holdTimer);
          cur.holdTimer = undefined;
        }
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
   * — making the wedge this class now reports MORE likely.
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
   * How long the current holder of `key` has held it, or `undefined` when the
   * lane is idle or merely queued. Lets callers distinguish "busy" from
   * "wedged" without reaching into internals.
   */
  holdElapsedMs(key: string): number | undefined {
    const holder = this.lanes.get(key)?.holder;
    return holder ? this.now() - holder.startedAt : undefined;
  }
}

function defaultObserve(o: KeyedSerializerObservation): void {
  const where = o.kind === 'wait'
    ? `waiting ${Math.round(o.elapsedMs / 1000)}s behind ${o.positionsAhead} operation(s)` +
      (o.holderLabel ? ` (holder: ${o.holderLabel})` : '')
    : `has held the lane ${Math.round(o.elapsedMs / 1000)}s`;
  // `console.warn` is the logging convention in this package.
  console.warn(
    `[chain] tx serializer${o.stalled ? ' STALL' : ''}: ${o.label} on ${o.key} ${where}; ` +
      `lane depth ${o.depth}.`,
  );
}
