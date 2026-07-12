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
const DEFAULT_KEYED_SERIALIZER_ACQUIRE_TIMEOUT_MS = 60_000;

export interface KeyedSerializerOptions {
  acquireTimeoutMs?: number;
  laneLabel?: string;
}

interface SerializerLane {
  tail: Promise<void>;
  depth: number;
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
  private readonly acquireTimeoutMs: number;
  private readonly laneLabel: string;

  constructor(options: KeyedSerializerOptions = {}) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_KEYED_SERIALIZER_ACQUIRE_TIMEOUT_MS;
    this.laneLabel = options.laneLabel ?? 'serializer lane';
    if (!Number.isFinite(this.acquireTimeoutMs) || this.acquireTimeoutMs <= 0) {
      throw new Error('KeyedSerializer acquireTimeoutMs must be positive');
    }
  }

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Returns `fn`'s result (or rejection) verbatim.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve(), depth: 0 };
    if (!this.lanes.has(key)) this.lanes.set(key, lane);
    const prev = lane.tail;
    const queueDepth = ++lane.depth;
    const waitMs = this.acquireTimeoutMs * Math.max(1, queueDepth - 1);

    const entry = this.createEntry(key, queueDepth, waitMs, prev, fn);
    lane.tail = entry.tail;
    void entry.tail.then(() => {
      lane.depth -= 1;
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
    let cancelTimeout!: () => void;
    const acquireTimeout = new Promise<never>((_resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        reject(new KeyedSerializerAcquireTimeoutError(
          key,
          waitMs,
          queueDepth,
          this.laneLabel,
        ));
      }, waitMs);
      timeout.unref?.();
      cancelTimeout = () => clearTimeout(timeout);
    });

    // `prev` is a non-rejecting queue tail. A caller that times out is skipped
    // when it eventually reaches the front, so abandoned writes never execute.
    const execution = prev.then(async () => {
      if (timedOut) return;
      cancelTimeout();
      return fn();
    });
    // The queue tail never rejects, so chaining the next op off it is safe.
    return {
      result: Promise.race([execution, acquireTimeout]) as Promise<T>,
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
}
