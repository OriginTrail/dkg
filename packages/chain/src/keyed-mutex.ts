/**
 * Per-key async serializer.
 *
 * Operations submitted under the same key run strictly one-at-a-time in
 * submission order; operations under different keys run concurrently. A
 * rejecting operation does not wedge its key's queue — the next operation
 * still runs.
 *
 * This primitive deliberately owns ordering only. It never times out or skips
 * queued work. The domain-specific bounded admission queue for nonce-critical
 * EVM writes lives separately in `signer-write-lane.ts`.
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
