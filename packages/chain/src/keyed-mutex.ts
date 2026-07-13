/**
 * Per-key async serializer.
 *
 * Operations submitted under the same key run strictly one-at-a-time in
 * submission order; operations under different keys run concurrently. A
 * rejecting operation does not wedge its key's queue — the next operation
 * still runs.
 *
 * This primitive deliberately owns ordering only. It never times out or skips
 * queued work; callers that need bounded acquisition must opt into the
 * explicitly named `BoundedKeyedSerializer` below.
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Returns `fn`'s result (or rejection) verbatim.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True while `key` has an in-flight or queued operation. */
  isActive(key: string): boolean {
    return this.tails.has(key);
  }

  /** Number of keys with an in-flight or queued operation. */
  get activeKeyCount(): number {
    return this.tails.size;
  }
}

export interface BoundedKeyedSerializerOptions {
  laneLabel?: string;
}

export interface BoundedKeyedSerializerRunOptions {
  /** Maximum legitimate time this operation may occupy the lane for successors. */
  executionBudgetMs: number;
}

interface BoundedSerializerLane {
  tail: Promise<void>;
  depth: number;
  pendingExecutionBudgetMs: number;
}

/**
 * Explicit bounded-acquisition serializer for side-effecting work.
 *
 * A caller whose cumulative predecessor budget expires is rejected and its
 * abandoned callback is skipped when it reaches the front. The lane itself
 * remains owned until every real predecessor settles, preserving same-key
 * exclusion even after a queued caller times out.
 */
export class BoundedKeyedSerializerAcquireTimeoutError extends Error {
  readonly code = 'KEYED_SERIALIZER_ACQUIRE_TIMEOUT';

  constructor(
    readonly key: string,
    readonly waitMs: number,
    readonly queueDepth: number,
    laneLabel: string,
  ) {
    super(`Timed out after ${waitMs}ms waiting for ${laneLabel} ${key} (queue depth ${queueDepth})`);
    this.name = 'BoundedKeyedSerializerAcquireTimeoutError';
  }
}

export class BoundedKeyedSerializer {
  private readonly lanes = new Map<string, BoundedSerializerLane>();
  private readonly laneLabel: string;

  constructor(options: BoundedKeyedSerializerOptions = {}) {
    this.laneLabel = options.laneLabel ?? 'bounded serializer lane';
  }

  run<T>(
    key: string,
    fn: () => Promise<T>,
    options: BoundedKeyedSerializerRunOptions,
  ): Promise<T> {
    const { executionBudgetMs } = options;
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
        rejectResult(new BoundedKeyedSerializerAcquireTimeoutError(
          key,
          waitMs,
          queueDepth,
          this.laneLabel,
        ));
      }, waitMs)
      : undefined;
    timeout?.unref?.();

    const execution = prev.then(async () => {
      if (timedOut) return;
      if (timeout) clearTimeout(timeout);
      try {
        resolveResult(await fn());
      } catch (error) {
        rejectResult(error);
      }
    });
    return {
      result,
      tail: execution.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  isActive(key: string): boolean {
    return this.lanes.has(key);
  }

  get activeKeyCount(): number {
    return this.lanes.size;
  }

  private assertExecutionBudget(value: number): void {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('BoundedKeyedSerializer execution budget must be positive');
    }
  }
}
