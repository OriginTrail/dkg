interface KeyedSerializerAdmission {
  /** Maximum advertised occupancy for this operation once it reaches the lane. */
  operationBudgetMs: number;
  /** Builds the domain-specific error returned when queued admission expires. */
  timeoutError: (waitMs: number, queueDepth: number) => Error;
}

type KeyedSerializerEntryState = 'queued' | 'running' | 'timed-out';

interface KeyedSerializerEntry {
  readonly fn: () => Promise<unknown>;
  readonly operationBudgetMs?: number;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: unknown) => void;
  state: KeyedSerializerEntryState;
  timeout?: ReturnType<typeof setTimeout>;
}

interface KeyedSerializerLane {
  readonly entries: KeyedSerializerEntry[];
  running: boolean;
}

/**
 * Per-key async serializer.
 *
 * Operations submitted under the same key run strictly one-at-a-time in
 * submission order; operations under different keys run concurrently. A
 * rejecting operation does not wedge its key's queue -- the next operation
 * still runs.
 *
 * This class is also the single owner of optional bounded-admission state.
 * Domain wrappers provide only a budget and timeout-error factory; ordering,
 * entry lifecycle, timeout skipping, cleanup and active-state reporting all
 * live in this queue.
 */
export class KeyedSerializer {
  private readonly lanes = new Map<string, KeyedSerializerLane>();

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Plain serialized work never times out or gets skipped.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(key, fn);
  }

  /**
   * Run `fn` in the same FIFO queue with bounded admission.
   *
   * The deadline is the sum of every live predecessor's advertised operation
   * budget. If it expires, this entry's promise rejects immediately, but the
   * entry remains as a FIFO barrier and its callback is skipped when it reaches
   * the front. A timed-out entry stops contributing to later deadlines.
   */
  runWithAdmission<T>(
    key: string,
    admission: KeyedSerializerAdmission,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!Number.isFinite(admission.operationBudgetMs) || admission.operationBudgetMs <= 0) {
      throw new Error('Keyed serializer admission budget must be a positive finite number');
    }
    return this.enqueue(key, fn, admission);
  }

  /** True while `key` has an in-flight or queued operation. */
  isActive(key: string): boolean {
    return this.lanes.has(key);
  }

  /** Number of keys with an in-flight or queued operation. */
  get activeKeyCount(): number {
    return this.lanes.size;
  }

  private enqueue<T>(
    key: string,
    fn: () => Promise<T>,
    admission?: KeyedSerializerAdmission,
  ): Promise<T> {
    const lane = this.lanes.get(key) ?? { entries: [], running: false };
    if (!this.lanes.has(key)) this.lanes.set(key, lane);
    const queueDepth = lane.entries.length + 1;
    const waitMs = admission
      ? lane.entries
        .filter((entry) => entry.state === 'queued' || entry.state === 'running')
        .reduce(
          (total, entry) => total + (entry.operationBudgetMs ?? Number.POSITIVE_INFINITY),
          0,
        )
      : 0;

    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const entry: KeyedSerializerEntry = {
      fn,
      operationBudgetMs: admission?.operationBudgetMs,
      resolve: resolveResult as (value: unknown) => void,
      reject: rejectResult,
      state: 'queued',
    };
    lane.entries.push(entry);

    if (admission && waitMs > 0 && Number.isFinite(waitMs)) {
      entry.timeout = setTimeout(() => {
        if (entry.state !== 'queued') return;
        entry.state = 'timed-out';
        entry.reject(admission.timeoutError(waitMs, queueDepth));
      }, waitMs);
      entry.timeout.unref?.();
    }

    this.drain(key, lane);
    return result;
  }

  private drain(key: string, lane: KeyedSerializerLane): void {
    if (lane.running) return;
    const entry = lane.entries[0];
    if (!entry) {
      if (this.lanes.get(key) === lane) this.lanes.delete(key);
      return;
    }
    if (entry.state === 'timed-out') {
      lane.entries.shift();
      if (entry.timeout) clearTimeout(entry.timeout);
      this.drain(key, lane);
      return;
    }

    lane.running = true;
    entry.state = 'running';
    if (entry.timeout) clearTimeout(entry.timeout);
    void Promise.resolve()
      .then(entry.fn)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        lane.running = false;
        if (lane.entries[0] === entry) {
          lane.entries.shift();
        } else {
          const index = lane.entries.indexOf(entry);
          if (index >= 0) lane.entries.splice(index, 1);
        }
        this.drain(key, lane);
      });
  }
}
