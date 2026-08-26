/** Internal bounded LRU used by the SPARQL analyzer and exercised with test-owned instances. */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(
    private readonly maxEntries: number,
    private readonly shouldAdmit: (key: K) => boolean = () => true,
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
    if (!this.shouldAdmit(key)) return;
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size <= this.maxEntries) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}

export const SPARQL_ANALYSIS_CACHE_MAX_ENTRIES = 256;
export const SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH = 64 * 1024;
