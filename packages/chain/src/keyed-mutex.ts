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
 */
// One serialized write may legitimately hold the lane for the 180s receipt
// window plus populate/broadcast overhead. Keep one queue-position budget above
// that bound; deeper callers receive one budget per predecessor.
export const DEFAULT_KEYED_SERIALIZER_ACQUIRE_TIMEOUT_MS = 240_000;

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
  ) {
    super(`Timed out after ${waitMs}ms waiting for transaction lane ${key} (queue depth ${queueDepth})`);
    this.name = 'KeyedSerializerAcquireTimeoutError';
  }
}

export class KeyedSerializer {
  private readonly lanes = new Map<string, SerializerLane>();

  constructor(
    private readonly acquireTimeoutMs = DEFAULT_KEYED_SERIALIZER_ACQUIRE_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(acquireTimeoutMs) || acquireTimeoutMs <= 0) {
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
    let acquired = false;
    let timedOut = false;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = setTimeout(() => {
      if (acquired) return;
      timedOut = true;
      rejectResult(new KeyedSerializerAcquireTimeoutError(key, waitMs, queueDepth));
    }, waitMs);
    timeout.unref?.();

    // `prev` is a non-rejecting queue tail. A caller that times out is skipped
    // when it eventually reaches the front, so abandoned writes never execute.
    const execution = prev.then(async () => {
      if (timedOut) return;
      acquired = true;
      clearTimeout(timeout);
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

  /** In-flight plus queued operations for one key. */
  queueDepth(key: string): number {
    return this.lanes.get(key)?.depth ?? 0;
  }
}
