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
        (total, predecessor) => total + this.remainingOccupancyMs(predecessor, now),
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
    this.refreshAdmissionTimeouts(lane);
    this.drain(key, lane);
    return result;
  }

  /**
   * Recompute queued deadlines from occupancy that can still happen. The
   * running predecessor contributes only its unused budget; every queued
   * predecessor contributes its full budget. Timed-out entries contribute
   * nothing, so a burst behind one wedged operation collapses at that
   * operation's deadline instead of waiting on callbacks that will be skipped.
   */
  private refreshAdmissionTimeouts(lane: KeyedSerializerLane): void {
    const now = Date.now();
    let hasLivePredecessor = false;
    let remainingPredecessorOccupancyMs = 0;
    for (const entry of lane.entries) {
      if (entry.timeout) {
        clearTimeout(entry.timeout);
        entry.timeout = undefined;
      }
      if (entry.state === 'queued' && entry.admission && hasLivePredecessor) {
        if (remainingPredecessorOccupancyMs <= 0) {
          entry.state = 'timed-out';
          entry.reject(entry.admission.timeoutError(now - entry.enqueuedAt, entry.queueDepth));
        } else if (Number.isFinite(remainingPredecessorOccupancyMs)) {
          entry.timeout = setTimeout(
            () => this.refreshAdmissionTimeouts(lane),
            remainingPredecessorOccupancyMs,
          );
          entry.timeout.unref?.();
        }
      }

      if (entry.state === 'queued' || entry.state === 'running') {
        hasLivePredecessor = true;
        remainingPredecessorOccupancyMs += this.remainingOccupancyMs(entry, now);
      }
    }
  }

  private remainingOccupancyMs(entry: KeyedSerializerEntry, now: number): number {
    const budgetMs = entry.admission?.operationBudgetMs ?? Number.POSITIVE_INFINITY;
    if (entry.state !== 'running' || entry.startedAt === undefined) return budgetMs;
    return Math.max(0, budgetMs - (now - entry.startedAt));
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
        // The event loop may have been blocked past a queued deadline, letting
        // this promise settle before its overdue timer callback runs. Rebase
        // while the completed runner still occupies the lane so successors
        // observe its exhausted budget and are rejected before it is removed.
        this.refreshAdmissionTimeouts(lane);
        lane.running = false;
        if (lane.entries[0] === entry) {
          lane.entries.shift();
        } else {
          const index = lane.entries.indexOf(entry);
          if (index >= 0) lane.entries.splice(index, 1);
        }
        // Remove the finished occupancy, then give the new head an immediate
        // start and rebase later entries behind that head's full plan.
        this.refreshAdmissionTimeouts(lane);
        this.drain(key, lane);
      });
  }
}
