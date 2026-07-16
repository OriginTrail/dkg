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
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Run `fn` after every previously-submitted operation for `key` has
   * settled. Returns `fn`'s result (or rejection) verbatim.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // `fn` runs once `prev` settles, regardless of how it settled — a failed
    // predecessor must not skip or wedge the successor.
    const result = prev.then(fn, fn);
    // The queue tail never rejects, so chaining the next op off it is safe.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Keep the map bounded by in-flight keys, not history: once this tail
    // settles, drop it if nothing newer has been queued behind it.
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
