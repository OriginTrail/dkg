// SPDX-License-Identifier: Apache-2.0

import { abortError, waitForSignal } from './wait-for-signal.js';

export interface TtlValueCacheOptions<V> {
  ttlMs: number | ((value: CacheValue<V>) => number);
  now?: () => number;
}

export type CacheValue<V> = undefined extends V ? never : V;

export const SINGLE_FLIGHT_INVALIDATED_CODE = 'SINGLE_FLIGHT_INVALIDATED' as const;

/** Stable invalidation signal; diagnostic wording never controls retry policy. */
export class SingleFlightInvalidatedError extends Error {
  readonly code = SINGLE_FLIGHT_INVALIDATED_CODE;
  readonly retryable: boolean;

  constructor(
    message = 'Shared request was invalidated',
    options: { readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'SingleFlightInvalidatedError';
    this.retryable = options.retryable === true;
  }
}

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

interface AbortableKeyedFlightState<V> {
  readonly controller: AbortController;
  readonly outcome: Promise<V>;
  readonly abandonmentMessage: string;
  waiters: number;
  settled: boolean;
  invalidated: Error | undefined;
}

interface AbortableKeyedFlightCoreOptions {
  readonly defer: (dispatch: () => void) => void;
  readonly detachOnDispatch: boolean;
  readonly abandonmentMessage: string;
}

export interface AbortableKeyedFlightResult<V> {
  /** True only for the caller that opened this physical flight. */
  readonly initiated: boolean;
  readonly value: V;
}

/**
 * Canonical waiter/controller bookkeeping shared by immediate and deferred
 * keyed flights. Policy stays in the wrappers: whether a key remains joinable
 * after dispatch, what a loader rejection means, and how invalidation treats
 * callers already enrolled.
 */
class AbortableKeyedFlightCore<K, V> {
  readonly #inflight = new Map<K, AbortableKeyedFlightState<V>>();
  readonly #options: AbortableKeyedFlightCoreOptions;

  constructor(options: AbortableKeyedFlightCoreOptions) {
    this.#options = options;
  }

  async run(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    waiterSignal?: AbortSignal,
    onSuccess?: (value: V) => void,
    abandonmentMessage = this.#options.abandonmentMessage,
  ): Promise<AbortableKeyedFlightResult<V>> {
    waiterSignal?.throwIfAborted();
    let state = this.#inflight.get(key);
    const initiated = state === undefined;
    if (state === undefined) state = this.#open(key, load, onSuccess, abandonmentMessage);
    else state.waiters += 1;

    try {
      const value = await waitForSignal(state.outcome, waiterSignal);
      if (state.invalidated !== undefined) throw state.invalidated;
      return { initiated, value };
    } finally {
      this.#leave(key, state);
    }
  }

  /** Detach known keys while allowing already-enrolled callers to finish. */
  detachAll(): void {
    this.#inflight.clear();
  }

  invalidate(key: K, error: Error): void {
    const state = this.#inflight.get(key);
    this.#inflight.delete(key);
    if (state === undefined) return;
    state.invalidated = error;
    if (!state.settled) state.controller.abort(error);
  }

  invalidateAll(createError: () => Error): void {
    for (const key of this.#inflight.keys()) this.invalidate(key, createError());
  }

  #open(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    onSuccess: ((value: V) => void) | undefined,
    abandonmentMessage: string,
  ): AbortableKeyedFlightState<V> {
    const controller = new AbortController();
    let resolveOutcome!: (value: V) => void;
    let rejectOutcome!: (error: unknown) => void;
    const outcome = new Promise<V>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    const state: AbortableKeyedFlightState<V> = {
      controller,
      outcome,
      abandonmentMessage,
      // The initiator is enrolled before `defer` runs, including when a test
      // or embedding invokes its dispatch callback synchronously.
      waiters: 1,
      settled: false,
      invalidated: undefined,
    };
    const complete = (settle: () => void) => {
      if (state.settled) return;
      state.settled = true;
      settle();
      if (state.waiters === 0 && this.#inflight.get(key) === state) {
        this.#inflight.delete(key);
      }
    };
    this.#inflight.set(key, state);
    const dispatch = () => {
      if (this.#options.detachOnDispatch && this.#inflight.get(key) === state) {
        this.#inflight.delete(key);
      }
      if (state.invalidated !== undefined) {
        complete(() => rejectOutcome(state.invalidated));
        return;
      }
      if (state.waiters === 0) {
        const abandoned = abortError(state.abandonmentMessage);
        if (!controller.signal.aborted) controller.abort(abandoned);
        complete(() => rejectOutcome(abandoned));
        return;
      }
      let loaded: Promise<V>;
      try {
        // Invoke synchronously inside the scheduled dispatch. Callers that
        // wait one microtask before invalidating must know the loader has
        // already subscribed to the physical signal.
        loaded = load(controller.signal);
      } catch (error) {
        complete(() => rejectOutcome(error));
        return;
      }
      void loaded.then(
        (value) => {
          try {
            if (onSuccess !== undefined && this.#inflight.get(key) === state) {
              onSuccess(value);
            }
            complete(() => resolveOutcome(value));
          } catch (error) {
            complete(() => rejectOutcome(error));
          }
        },
        (error) => complete(() => rejectOutcome(error)),
      );
    };
    try {
      this.#options.defer(dispatch);
    } catch (error) {
      complete(() => rejectOutcome(error));
    }
    return state;
  }

  #leave(key: K, state: AbortableKeyedFlightState<V>): void {
    state.waiters -= 1;
    if (state.waiters > 0) return;
    if (this.#inflight.get(key) === state) this.#inflight.delete(key);
    if (state.settled || state.invalidated !== undefined) return;
    state.controller.abort(abortError(state.abandonmentMessage));
  }
}

export interface AbortableDeferredKeyedFlightOptions {
  /** Defers dispatch so same-turn callers can enrol in the same flight. */
  readonly defer: (dispatch: () => void) => void;
  readonly abandonmentMessage?: string;
}

/**
 * A keyed flight that is joinable only until dispatch. Detachment removes
 * keys but does not disturb callers already enrolled in a live read.
 */
export class AbortableDeferredKeyedFlight<K, V> {
  readonly #core: AbortableKeyedFlightCore<K, V>;

  constructor(options: AbortableDeferredKeyedFlightOptions) {
    this.#core = new AbortableKeyedFlightCore({
      defer: options.defer,
      detachOnDispatch: true,
      abandonmentMessage: options.abandonmentMessage
        ?? 'Deferred shared request has no active waiters',
    });
  }

  run(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    waiterSignal?: AbortSignal,
  ): Promise<AbortableKeyedFlightResult<V>> {
    return this.#core.run(key, load, waiterSignal);
  }

  detachAll(): void {
    this.#core.detachAll();
  }
}

/**
 * Per-key shared physical work with waiter-local cancellation.
 *
 * A caller abandoning its wait never poisons peers. When the final waiter
 * leaves, the physical operation is aborted and detached from the key so a
 * later caller can start fresh. Invalidation aborts and detaches the current
 * physical request, suppresses stale publication through `onSuccess`, and
 * rejects enrolled waiters even if the loader ignores cancellation or already
 * completed before its result could be delivered.
 */
export class AbortableKeyedSingleFlight<K, V> {
  readonly #core = new AbortableKeyedFlightCore<K, V>({
    defer: (dispatch) => queueMicrotask(dispatch),
    detachOnDispatch: false,
    abandonmentMessage: 'Shared request has no active waiters',
  });

  async run(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    waiterSignal?: AbortSignal,
    onSuccess?: (value: V) => void,
    abandonmentMessage = 'Shared request has no active waiters',
  ): Promise<V> {
    return (await this.#core.run(
      key,
      load,
      waiterSignal,
      onSuccess,
      abandonmentMessage,
    )).value;
  }

  invalidate(
    key: K,
    reason = 'Shared request was invalidated',
    options: { readonly retryable?: boolean } = {},
  ): void {
    this.#core.invalidate(key, new SingleFlightInvalidatedError(reason, options));
  }

  invalidateAll(
    reason = 'Shared requests were invalidated',
    options: { readonly retryable?: boolean } = {},
  ): void {
    this.#core.invalidateAll(() => new SingleFlightInvalidatedError(reason, options));
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
