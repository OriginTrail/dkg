// SPDX-License-Identifier: Apache-2.0

export interface TtlValueCacheOptions<V> {
  ttlMs: number | ((value: CacheValue<V>) => number);
  now?: () => number;
}

export type CacheValue<V> = undefined extends V ? never : V;

/**
 * Small process-local TTL value cache.
 *
 * `undefined` is intentionally excluded from stored values so `get()` can use
 * it as the miss sentinel. A non-positive TTL means "do not retain".
 */
export class TtlValueCache<K, V> {
  private readonly values = new Map<K, { value: CacheValue<V>; cachedAt: number }>();

  private readonly ttlMs: number | ((value: CacheValue<V>) => number);

  private readonly now: () => number;

  constructor(options: TtlValueCacheOptions<V>) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(key: K, now = this.now()): CacheValue<V> | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    const ttl = this.ttlFor(entry.value);
    if (now - entry.cachedAt < ttl) return entry.value;
    this.values.delete(key);
    return undefined;
  }

  has(key: K, now = this.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  set(key: K, value: CacheValue<V>): boolean {
    if (this.ttlFor(value) <= 0) {
      this.values.delete(key);
      return false;
    }
    this.values.set(key, { value, cachedAt: this.now() });
    return true;
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }

  private ttlFor(value: CacheValue<V>): number {
    return typeof this.ttlMs === 'function' ? this.ttlMs(value) : this.ttlMs;
  }
}

/**
 * Per-key promise coalescer with invalidation epochs.
 *
 * Invalidation clears known in-flight variants for the value key and bumps an
 * epoch. A pre-invalidation promise can still resolve to its original caller,
 * but its `onSuccess` hook is suppressed so it cannot repopulate stale state.
 */
export class KeyedSingleFlight<K, I = K> {
  private readonly inflightByKey = new Map<K, Map<I, Promise<unknown>>>();

  private readonly keyEpochs = new Map<K, number>();

  private globalEpoch = 0;

  async run<V>(
    key: K,
    inflightKey: I,
    load: () => Promise<V>,
    onSuccess?: (value: V) => void,
  ): Promise<V> {
    const keys = this.inflightKeysFor(key);
    const existing = keys.get(inflightKey) as Promise<V> | undefined;
    if (existing) return existing;

    const epoch = this.epoch(key);
    const lookup = (async () => {
      const value = await load();
      if (onSuccess && this.epochUnchanged(key, epoch)) onSuccess(value);
      return value;
    })();

    keys.set(inflightKey, lookup);
    try {
      return await lookup;
    } finally {
      this.removeInflightKeyFor(key, inflightKey, lookup);
    }
  }

  invalidate(key: K): void {
    this.clearInflightForKey(key);
    this.bumpKeyEpoch(key);
  }

  invalidateAll(): void {
    this.inflightByKey.clear();
    this.globalEpoch++;
  }

  private clearInflightForKey(key: K): void {
    this.inflightByKey.delete(key);
  }

  private inflightKeysFor(key: K): Map<I, Promise<unknown>> {
    let keys = this.inflightByKey.get(key);
    if (!keys) {
      keys = new Map<I, Promise<unknown>>();
      this.inflightByKey.set(key, keys);
    }
    return keys;
  }

  private removeInflightKeyFor(key: K, inflightKey: I, promise: Promise<unknown>): void {
    const keys = this.inflightByKey.get(key);
    if (!keys) return;
    if (keys.get(inflightKey) !== promise) return;
    keys.delete(inflightKey);
    if (keys.size === 0) this.inflightByKey.delete(key);
  }

  private bumpKeyEpoch(key: K): void {
    this.keyEpochs.set(key, (this.keyEpochs.get(key) ?? 0) + 1);
  }

  private epoch(key: K): { global: number; key: number } {
    return {
      global: this.globalEpoch,
      key: this.keyEpochs.get(key) ?? 0,
    };
  }

  private epochUnchanged(key: K, epoch: { global: number; key: number }): boolean {
    return this.globalEpoch === epoch.global && (this.keyEpochs.get(key) ?? 0) === epoch.key;
  }
}

/**
 * Read-through TTL cache that owns the cache/single-flight/invalidation
 * protocol for callers.
 */
export class ReadThroughTtlCache<K, V, I = K> {
  private readonly values: TtlValueCache<K, V>;

  private readonly singleFlight = new KeyedSingleFlight<K, I>();

  constructor(options: TtlValueCacheOptions<V>) {
    this.values = new TtlValueCache<K, V>(options);
  }

  async getOrLoad(
    key: K,
    inflightKey: I,
    load: () => Promise<CacheValue<V>>,
  ): Promise<CacheValue<V>> {
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    return this.singleFlight.run(key, inflightKey, load, (value) => {
      this.values.set(key, value);
    });
  }

  seed(key: K, value: CacheValue<V>): void {
    this.singleFlight.invalidate(key);
    this.values.set(key, value);
  }

  invalidate(key: K): void {
    this.values.delete(key);
    this.singleFlight.invalidate(key);
  }

  invalidateAll(): void {
    this.values.clear();
    this.singleFlight.invalidateAll();
  }
}
