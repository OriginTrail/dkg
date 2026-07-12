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
export const DEFAULT_KEYED_SERIALIZER_ACQUIRE_TIMEOUT_MS = 60_000;

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
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();

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
    const prev = this.tails.get(key) ?? Promise.resolve();
    const queueDepth = (this.depths.get(key) ?? 0) + 1;
    this.depths.set(key, queueDepth);

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
      rejectResult(new KeyedSerializerAcquireTimeoutError(key, this.acquireTimeoutMs, queueDepth));
    }, this.acquireTimeoutMs);
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
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Keep the map bounded by in-flight keys, not history: once this tail
    // settles, drop it if nothing newer has been queued behind it.
    void tail.then(() => {
      const remaining = (this.depths.get(key) ?? 1) - 1;
      if (remaining > 0) this.depths.set(key, remaining);
      else this.depths.delete(key);
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

  /** In-flight plus queued operations for one key. */
  queueDepth(key: string): number {
    return this.depths.get(key) ?? 0;
  }
}
