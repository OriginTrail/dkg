/** Small dependency-free bounded LRU for in-process memoization. */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(
    private readonly maxEntries: number,
    private readonly shouldAdmit: (key: K, value: V) => boolean = () => true,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (!this.shouldAdmit(key, value)) return;
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.maxEntries) return;
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}
