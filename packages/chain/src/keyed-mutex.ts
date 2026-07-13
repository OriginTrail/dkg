/**
 * Per-key async serializer.
 *
 * Operations submitted under the same key run strictly one-at-a-time in
 * submission order; operations under different keys run concurrently. A
 * rejecting operation does not wedge its key's queue — the next operation
 * still runs.
 *
 * Callers own the timeout and diagnostic policy for their domain. This class
 * only provides keyed, bounded acquisition and queue cleanup.
 */
const DEFAULT_KEYED_SERIALIZER_EXECUTION_BUDGET_MS = 60_000;

export interface KeyedSerializerOptions {
  defaultExecutionBudgetMs?: number;
  laneLabel?: string;
}

export interface KeyedSerializerRunOptions {
  /** Maximum legitimate time this operation may occupy the lane for successors. */
  executionBudgetMs?: number;
}

interface SerializerLane {
  tail: Promise<void>;
  depth: number;
  pendingExecutionBudgetMs: number;
}

export class KeyedSerializerAcquireTimeoutError extends Error {
  readonly code = 'KEYED_SERIALIZER_ACQUIRE_TIMEOUT';

  constructor(
    readonly key: string,
    readonly waitMs: number,
    readonly queueDepth: number,
    laneLabel: string,
  ) {
    super(`Timed out after ${waitMs}ms waiting for ${laneLabel} ${key} (queue depth ${queueDepth})`);
    this.name = 'KeyedSerializerAcquireTimeoutError';
  }
}

export class KeyedSerializer {
  private readonly lanes = new Map<string, SerializerLane>();
  private readonly defaultExecutionBudgetMs: number;
  private readonly laneLabel: string;

  constructor(options: KeyedSerializerOptions = {}) {
    this.defaultExecutionBudgetMs = options.defaultExecutionBudgetMs
      ?? DEFAULT_KEYED_SERIALIZER_EXECUTION_BUDGET_MS;
    this.laneLabel = options.laneLabel ?? 'serializer lane';
    this.assertExecutionBudget(this.defaultExecutionBudgetMs);
  }

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Returns `fn`'s result (or rejection) verbatim.
   */
  run<T>(key: string, fn: () => Promise<T>, options: KeyedSerializerRunOptions = {}): Promise<T> {
    const executionBudgetMs = options.executionBudgetMs ?? this.defaultExecutionBudgetMs;
    this.assertExecutionBudget(executionBudgetMs);
    const lane = this.lanes.get(key) ?? {
      tail: Promise.resolve(),
      depth: 0,
      pendingExecutionBudgetMs: 0,
    };
    if (!this.lanes.has(key)) this.lanes.set(key, lane);
    const prev = lane.tail;
    const queueDepth = ++lane.depth;
    const waitMs = lane.pendingExecutionBudgetMs;
    lane.pendingExecutionBudgetMs += executionBudgetMs;

    const entry = this.createEntry(key, queueDepth, waitMs, prev, fn);
    lane.tail = entry.tail;
    void entry.tail.then(() => {
      lane.depth -= 1;
      lane.pendingExecutionBudgetMs -= executionBudgetMs;
      if (lane.depth === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
    });
    return entry.result;
  }

  /** Build one named queue entry: caller result plus the non-rejecting lane tail. */
  private createEntry<T>(
    key: string,
    queueDepth: number,
    waitMs: number,
    prev: Promise<void>,
    fn: () => Promise<T>,
  ): { result: Promise<T>; tail: Promise<void> } {
    let timedOut = false;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = waitMs > 0
      ? setTimeout(() => {
        timedOut = true;
        rejectResult(new KeyedSerializerAcquireTimeoutError(
          key,
          waitMs,
          queueDepth,
          this.laneLabel,
        ));
      }, waitMs)
      : undefined;
    timeout?.unref?.();

    // `prev` is a non-rejecting queue tail. A caller that times out is skipped
    // when it eventually reaches the front, so abandoned writes never execute.
    const execution = prev.then(async () => {
      if (timedOut) return;
      if (timeout) clearTimeout(timeout);
      try {
        resolveResult(await fn());
      } catch (error) {
        rejectResult(error);
      }
    });
    // The queue tail never rejects, so chaining the next op off it is safe.
    return {
      result,
      tail: execution.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  /** True while `key` has an in-flight or queued operation. */
  isActive(key: string): boolean {
    return this.lanes.has(key);
  }

  /** Number of keys with an in-flight or queued operation. */
  get activeKeyCount(): number {
    return this.lanes.size;
  }

  private assertExecutionBudget(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('KeyedSerializer execution budget must be positive');
    }
  }
}
