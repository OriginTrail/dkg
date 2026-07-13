interface KeyedSerializerAdmission {
  /** Maximum advertised occupancy for this operation once it reaches the lane. */
  operationBudgetMs: number;
  /** Builds the domain-specific error returned when queued admission expires. */
  timeoutError: (waitMs: number, queueDepth: number) => Error;
  /** One-shot observability hook when this operation enters behind predecessors. */
  onQueued?: (waitMs: number, queueDepth: number) => void;
}

type KeyedSerializerEntryState = 'queued' | 'running' | 'timed-out';

interface KeyedSerializerEntry {
  readonly admission?: KeyedSerializerAdmission;
  readonly enqueuedAt: number;
  readonly fn: () => Promise<unknown>;
  readonly queueDepth: number;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: unknown) => void;
  deadlineAt?: number;
  state: KeyedSerializerEntryState;
  startedAt?: number;
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
    const now = Date.now();
    const livePredecessors = lane.entries.filter(
      (predecessor) => predecessor.state === 'queued' || predecessor.state === 'running',
    );
    const initialWaitMs = admission
      ? livePredecessors.reduce(
        (total, predecessor) => total + (predecessor.admission?.operationBudgetMs ?? Number.POSITIVE_INFINITY),
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
      admission,
      enqueuedAt: now,
      fn,
      queueDepth,
      resolve: resolveResult as (value: unknown) => void,
      reject: rejectResult,
      deadlineAt: admission && initialWaitMs > 0 && Number.isFinite(initialWaitMs)
        ? now + initialWaitMs
        : undefined,
      state: 'queued',
    };
    lane.entries.push(entry);
    if (admission?.onQueued && livePredecessors.length > 0 && Number.isFinite(initialWaitMs)) {
      try {
        admission.onQueued(initialWaitMs, queueDepth);
      } catch {
        // Queue diagnostics must never alter signer-write admission.
      }
    }
    this.refreshAdmissionTimeouts(key, lane);
    this.drain(key, lane);
    return result;
  }

  /**
   * Refresh caller deadlines after an entry expires or a predecessor finishes
   * early. Every entry receives the full advertised budget of predecessors
   * that were live when it joined. If one of those predecessors later times
   * out, its abandoned budget is removed from every successor immediately;
   * this can expire an entire queued burst at the same real blocker deadline.
   */
  private refreshAdmissionTimeouts(key: string, lane: KeyedSerializerLane): void {
    const now = Date.now();
    for (const entry of lane.entries) {
      if (entry.timeout) {
        clearTimeout(entry.timeout);
        entry.timeout = undefined;
      }
    }

    // Expiring one queued entry removes its advertised occupancy from all
    // successors. Repeat the scan so collapsed deadlines expire in the same
    // pass rather than receiving serial, already-abandoned grace periods.
    let expiredOne = true;
    while (expiredOne) {
      expiredOne = false;
      for (let index = 0; index < lane.entries.length; index += 1) {
        const entry = lane.entries[index]!;
        if (
          entry.state !== 'queued'
          || !entry.admission
          || entry.deadlineAt === undefined
          || entry.deadlineAt > now
        ) continue;

        entry.state = 'timed-out';
        entry.reject(entry.admission.timeoutError(
          Math.max(0, entry.deadlineAt - entry.enqueuedAt),
          entry.queueDepth,
        ));
        for (const successor of lane.entries.slice(index + 1)) {
          if (successor.state === 'queued' && successor.deadlineAt !== undefined) {
            successor.deadlineAt -= entry.admission.operationBudgetMs;
          }
        }
        expiredOne = true;
      }
    }

    for (const entry of lane.entries) {
      if (entry.state !== 'queued' || entry.deadlineAt === undefined) continue;
      entry.timeout = setTimeout(() => {
        this.refreshAdmissionTimeouts(key, lane);
        this.drain(key, lane);
      }, Math.max(0, entry.deadlineAt - now));
      entry.timeout.unref?.();
    }
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
    entry.startedAt = Date.now();
    if (entry.timeout) clearTimeout(entry.timeout);
    void Promise.resolve()
      .then(entry.fn)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        const finishedAt = Date.now();
        const unusedBudgetMs = entry.admission && entry.startedAt !== undefined
          ? Math.max(0, entry.admission.operationBudgetMs - (finishedAt - entry.startedAt))
          : 0;
        lane.running = false;
        if (lane.entries[0] === entry) {
          lane.entries.shift();
        } else {
          const index = lane.entries.indexOf(entry);
          if (index >= 0) lane.entries.splice(index, 1);
        }
        if (unusedBudgetMs > 0) {
          for (const successor of lane.entries) {
            if (successor.state === 'queued' && successor.deadlineAt !== undefined) {
              successor.deadlineAt -= unusedBudgetMs;
            }
          }
        }
        this.drain(key, lane);
        this.refreshAdmissionTimeouts(key, lane);
      });
  }
}
