/** Health of one operational-wallet transaction lane. */
export type SignerTxLaneState = 'idle' | 'busy' | 'stalled';

/** One bounded operator-facing snapshot of a busy transaction lane. */
export interface SignerTxSerializerObservation {
  key: string;
  /** Queued + running operations. */
  depth: number;
  /** Operations queued behind the holder. */
  waiting: number;
  holderLabel: string;
  holdElapsedMs: number;
  oldestWaiterLabel?: string;
  oldestWaiterMs?: number;
  /** The same canonical verdict consumed by wallet selection. */
  state: SignerTxLaneState;
}

export interface SignerTxSerializerOptions {
  /** Delay before the first observation for a lane. */
  observeAfterMs: number;
  /** Cadence of subsequent observations. */
  observeIntervalMs: number;
  /** Hold duration after which the canonical lane state becomes stalled. */
  stallAfterMs: number;
  now?: () => number;
  onObserve?: (observation: SignerTxSerializerObservation) => void;
}

interface Waiter {
  label: string;
  queuedAt: number;
}

interface Lane {
  /** Authoritative FIFO tail for this lane. It never rejects. */
  tail: Promise<void>;
  /** Queued + running operations. */
  depth: number;
  holder?: { label: string; startedAt: number };
  /** Insertion-ordered, so the first entry is the longest-waiting. */
  waiters: Set<Waiter>;
  /** Exactly one observer lifecycle per wallet lane. */
  firstTimer?: ReturnType<typeof setTimeout>;
  repeatTimer?: ReturnType<typeof setInterval>;
}

/**
 * Transaction-specific, monitored FIFO serializer.
 *
 * Acquisition intentionally has no timeout. A healthy critical section can
 * contain approval and broadcast work whose own bounds are much longer than a
 * useful acquisition timeout. Reporting the holder, waiter and canonical lane
 * health makes a wedge actionable without allowing abandoned calls to send
 * later after their predecessor eventually settles.
 */
export class SignerTxSerializer {
  private readonly lanes = new Map<string, Lane>();
  private readonly now: () => number;
  private readonly onObserve: (observation: SignerTxSerializerObservation) => void;

  constructor(private readonly options: SignerTxSerializerOptions) {
    this.now = options.now ?? Date.now;
    this.onObserve = options.onObserve ?? defaultObserve;
  }

  /**
   * Serialize one named operation on `key`. The label is required so every
   * production diagnostic identifies the operation holding or waiting.
   */
  run<T>(key: string, fn: () => Promise<T>, label: string): Promise<T> {
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

    const execute = async (): Promise<T> => {
      currentLane.waiters.delete(waiter);
      currentLane.holder = { label, startedAt: this.now() };
      try {
        return await fn();
      } finally {
        currentLane.holder = undefined;
        currentLane.depth -= 1;
      }
    };
    // A rejected predecessor must neither skip nor wedge its successor.
    const result = currentLane.tail.then(execute, execute);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    currentLane.tail = tail;
    void tail.then(() => {
      // A call submitted between settlement and this cleanup microtask has
      // replaced `tail`; it owns the lane and must keep its observer alive.
      if (
        currentLane.tail === tail
        && currentLane.depth === 0
        && this.lanes.get(key) === currentLane
      ) {
        this.clearObserver(currentLane);
        this.lanes.delete(key);
      }
    });
    return result;
  }

  /** True while `key` has an in-flight or queued transaction. */
  isActive(key: string): boolean {
    return this.lanes.has(key);
  }

  get activeKeyCount(): number {
    return this.lanes.size;
  }

  /** Queued + running transactions on `key`. */
  depth(key: string): number {
    return this.lanes.get(key)?.depth ?? 0;
  }

  /** Canonical health classification consumed by both logs and wallet choice. */
  state(key: string): SignerTxLaneState {
    return classifyLaneState(this.lanes.get(key), this.now(), this.options.stallAfterMs);
  }

  private ensureObserver(key: string, lane: Lane): void {
    if (lane.firstTimer !== undefined || lane.repeatTimer !== undefined) return;
    lane.firstTimer = setTimeout(() => {
      lane.firstTimer = undefined;
      this.emit(key, lane);
      lane.repeatTimer = setInterval(
        () => this.emit(key, lane),
        this.options.observeIntervalMs,
      );
      lane.repeatTimer.unref?.();
    }, this.options.observeAfterMs);
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
    if (!holder) return;
    const oldest = lane.waiters.values().next().value as Waiter | undefined;
    const now = this.now();
    const holdElapsedMs = now - holder.startedAt;
    const oldestWaiterMs = oldest ? now - oldest.queuedAt : undefined;
    // The observer belongs to the lane, whose lifetime can span many short
    // holders. Do not transfer that age to a newly-acquired holder: report only
    // when the CURRENT hold or CURRENT oldest wait is itself interesting.
    if (
      holdElapsedMs < this.options.observeAfterMs
      && (oldestWaiterMs ?? 0) < this.options.observeAfterMs
    ) return;
    this.onObserve({
      key,
      depth: lane.depth,
      waiting: lane.waiters.size,
      holderLabel: holder.label,
      holdElapsedMs,
      oldestWaiterLabel: oldest?.label,
      oldestWaiterMs,
      state: classifyLaneState(lane, now, this.options.stallAfterMs),
    });
  }
}

/** The only lane-health policy used by queries, observations, and routing. */
function classifyLaneState(
  lane: Lane | undefined,
  now: number,
  stallAfterMs: number,
): SignerTxLaneState {
  if (!lane) return 'idle';
  if (!lane.holder) return 'busy';
  return now - lane.holder.startedAt >= stallAfterMs ? 'stalled' : 'busy';
}

function defaultObserve(observation: SignerTxSerializerObservation): void {
  const waiting = observation.waiting > 0
    ? ` ${observation.waiting} operation(s) queued behind it` +
      (observation.oldestWaiterLabel
        ? `, longest ${observation.oldestWaiterLabel} waiting ` +
          `${Math.round((observation.oldestWaiterMs ?? 0) / 1000)}s`
        : '')
    : ' nothing queued behind it';
  console.warn(
    `[chain] tx serializer${observation.state === 'stalled' ? ' STALL' : ''}: ` +
      `${observation.holderLabel} has held the lane for ${observation.key} ` +
      `${Math.round(observation.holdElapsedMs / 1000)}s;${waiting}.`,
  );
}
