import { describe, expect, it, vi } from 'vitest';
import {
  AbortableKeyedSingleFlight,
  KeyedSingleFlight,
  ReadThroughTtlCache,
  TtlValueCache,
} from '../src/keyed-ttl-single-flight-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('TtlValueCache', () => {
  it('returns cached values until TTL expiry', () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const cache = new TtlValueCache<string, number>({ ttlMs: 1000 });

      expect(cache.set('a', 1)).toBe(true);
      expect(cache.get('a')).toBe(1);

      vi.setSystemTime(1001);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.has('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches null as a real value without treating it as a miss', () => {
    const cache = new TtlValueCache<string, null>({ ttlMs: 1000 });

    expect(cache.set('missing', null)).toBe(true);
    expect(cache.get('missing')).toBeNull();
    expect(cache.has('missing')).toBe(true);
  });

  it('does not store values whose computed TTL is zero', () => {
    const cache = new TtlValueCache<string, number>({
      ttlMs: (value) => value > 0 ? 1000 : 0,
    });

    expect(cache.set('missing', 0)).toBe(false);
    expect(cache.has('missing')).toBe(false);
    expect((cache as unknown as { values: Map<string, number> }).values.size).toBe(0);

    expect(cache.set('present', 5)).toBe(true);
    expect(cache.get('present')).toBe(5);
  });
});

describe('KeyedSingleFlight', () => {
  it('coalesces concurrent loads for the same in-flight key', async () => {
    let calls = 0;
    const singleFlight = new KeyedSingleFlight<string>();

    const results = await Promise.all([
      singleFlight.run('a', 'a', async () => ++calls),
      singleFlight.run('a', 'a', async () => ++calls),
    ]);

    expect(results).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it('invalidates all observed in-flight variants and blocks stale success hooks', async () => {
    const soft = deferred<number>();
    const strict = deferred<number>();
    const freshValue = deferred<number>();
    const values = new TtlValueCache<string, number>({ ttlMs: 1000 });
    const singleFlight = new KeyedSingleFlight<string, string>();

    const staleSoft = singleFlight.run('agent', 'agent:soft', async () => soft.promise, (value) => values.set('agent', value));
    const staleStrict = singleFlight.run('agent', 'agent:strict', async () => strict.promise, (value) => values.set('agent', value));
    singleFlight.invalidate('agent');
    values.delete('agent');

    soft.resolve(7);
    strict.resolve(8);
    await expect(staleSoft).resolves.toBe(7);
    await expect(staleStrict).resolves.toBe(8);
    expect(values.has('agent')).toBe(false);

    const fresh = singleFlight.run('agent', 'agent:strict', async () => freshValue.promise, (value) => values.set('agent', value));
    freshValue.resolve(9);
    await expect(fresh).resolves.toBe(9);
    expect(values.get('agent')).toBe(9);
  });

  it('does not let an older invalidated read remove a newer in-flight variant', async () => {
    const stale = deferred<number>();
    const newer = deferred<number>();
    const fresh = deferred<number>();
    const values = new TtlValueCache<string, number>({ ttlMs: 1000 });
    const singleFlight = new KeyedSingleFlight<string>();

    const staleLookup = singleFlight.run('account', 'account', async () => stale.promise, (value) => values.set('account', value));
    singleFlight.invalidate('account');

    const newerLookup = singleFlight.run('account', 'account', async () => newer.promise, (value) => values.set('account', value));
    stale.resolve(1);
    await expect(staleLookup).resolves.toBe(1);

    singleFlight.invalidate('account');
    const freshLookup = singleFlight.run('account', 'account', async () => fresh.promise, (value) => values.set('account', value));

    newer.resolve(2);
    fresh.resolve(3);
    await expect(newerLookup).resolves.toBe(2);
    await expect(freshLookup).resolves.toBe(3);
    expect(values.get('account')).toBe(3);
  });

  it('scopes identical in-flight keys by value key', async () => {
    let calls = 0;
    const singleFlight = new KeyedSingleFlight<string, string>();

    const results = await Promise.all([
      singleFlight.run('left', 'shared', async () => ++calls),
      singleFlight.run('right', 'shared', async () => ++calls),
    ]);

    expect(results).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});

describe('AbortableKeyedSingleFlight', () => {
  it('keeps shared work alive when one of two waiters cancels', async () => {
    const flight = new AbortableKeyedSingleFlight<string, number>();
    const loaded = deferred<number>();
    let physicalSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      physicalSignal = signal;
      return loaded.promise;
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = flight.run('chain', load, firstController.signal);
    const second = flight.run('chain', load, secondController.signal);
    firstController.abort(new Error('first left'));
    await expect(first).rejects.toThrow('first left');
    expect(physicalSignal?.aborted).toBe(false);
    loaded.resolve(31337);
    await expect(second).resolves.toBe(31337);
  });

  it('aborts physical work when the final waiter leaves and admits a fresh run', async () => {
    const flight = new AbortableKeyedSingleFlight<string, number>();
    const controller = new AbortController();
    let firstPhysicalSignal: AbortSignal | undefined;
    const first = flight.run('chain', async (signal) => {
      firstPhysicalSignal = signal;
      return new Promise<number>(() => undefined);
    }, controller.signal);
    controller.abort(new Error('deadline'));
    await expect(first).rejects.toThrow('deadline');
    expect(firstPhysicalSignal?.aborted).toBe(true);
    await expect(flight.run('chain', async () => 84532)).resolves.toBe(84532);
  });

  it('rejects invalidated waiters and suppresses stale success without removing the newer run', async () => {
    const flight = new AbortableKeyedSingleFlight<string, number>();
    const stale = deferred<number>();
    const fresh = deferred<number>();
    const successes: number[] = [];
    const oldRun = flight.run(
      'chain',
      async () => stale.promise,
      undefined,
      (value) => successes.push(value),
    );
    flight.invalidate('chain');
    const newRun = flight.run(
      'chain',
      async () => fresh.promise,
      undefined,
      (value) => successes.push(value),
    );
    stale.resolve(1);
    fresh.resolve(2);
    await expect(oldRun).rejects.toMatchObject({ name: 'AbortError' });
    await expect(newRun).resolves.toBe(2);
    expect(successes).toEqual([2]);
  });

  it.each(['key', 'all'] as const)(
    'rejects a completed but undelivered result after %s invalidation',
    async (scope) => {
      const flight = new AbortableKeyedSingleFlight<string, number>();
      const stale = deferred<number>();
      const fresh = deferred<number>();
      const successes: number[] = [];
      let replacement: Promise<number> | undefined;
      const oldRun = flight.run(
        'chain',
        async () => stale.promise,
        undefined,
        (value) => successes.push(value),
      );

      stale.resolve(1);
      queueMicrotask(() => {
        if (scope === 'key') flight.invalidate('chain', 'newer proof');
        else flight.invalidateAll('newer proof');
        replacement = flight.run(
          'chain',
          async () => fresh.promise,
          undefined,
          (value) => successes.push(value),
        );
      });

      await expect(oldRun).rejects.toMatchObject({ name: 'AbortError', message: 'newer proof' });
      fresh.resolve(2);
      expect(replacement).toBeDefined();
      await expect(replacement!).resolves.toBe(2);
      expect(successes).toEqual([2]);
    },
  );
});

describe('ReadThroughTtlCache', () => {
  it('coalesces getOrLoad calls and caches retained values', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let calls = 0;
      const cache = new ReadThroughTtlCache<string, number>({ ttlMs: 1000 });
      const read = () => cache.getOrLoad('wallet', 'wallet', async () => ++calls);

      await expect(Promise.all([read(), read()])).resolves.toEqual([1, 1]);
      expect(calls).toBe(1);
      await expect(read()).resolves.toBe(1);

      vi.setSystemTime(1001);
      await expect(read()).resolves.toBe(2);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches null as a retained read-through value', async () => {
    let calls = 0;
    const cache = new ReadThroughTtlCache<string, number | null>({ ttlMs: 1000 });

    await expect(cache.getOrLoad('missing', 'missing', async () => {
      calls++;
      return null;
    })).resolves.toBeNull();
    await expect(cache.getOrLoad('missing', 'missing', async () => {
      calls++;
      return 5;
    })).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it('does not retain zero-TTL values', async () => {
    let calls = 0;
    const cache = new ReadThroughTtlCache<string, number>({
      ttlMs: (value) => value > 0 ? 1000 : 0,
    });

    await expect(cache.getOrLoad('account', 'account', async () => calls++)).resolves.toBe(0);
    await expect(cache.getOrLoad('account', 'account', async () => calls++)).resolves.toBe(1);
    expect(calls).toBe(2);
  });

  it('seeds, invalidates, and broadly invalidates cached values', async () => {
    let calls = 0;
    const cache = new ReadThroughTtlCache<string, number>({ ttlMs: 1000 });

    cache.seed('a', 7);
    await expect(cache.getOrLoad('a', 'a', async () => ++calls)).resolves.toBe(7);

    cache.invalidate('a');
    await expect(cache.getOrLoad('a', 'a', async () => ++calls)).resolves.toBe(1);

    cache.seed('b', 9);
    cache.invalidateAll();
    await expect(cache.getOrLoad('b', 'b', async () => ++calls)).resolves.toBe(2);
  });

  it('suppresses stale in-flight success after invalidation', async () => {
    const stale = deferred<number>();
    const fresh = deferred<number>();
    const cache = new ReadThroughTtlCache<string, number>({ ttlMs: 1000 });

    const staleLookup = cache.getOrLoad('account', 'account', async () => stale.promise);
    cache.invalidate('account');
    const freshLookup = cache.getOrLoad('account', 'account', async () => fresh.promise);

    stale.resolve(1);
    fresh.resolve(2);

    await expect(staleLookup).resolves.toBe(1);
    await expect(freshLookup).resolves.toBe(2);
    await expect(cache.getOrLoad('account', 'account', async () => 3)).resolves.toBe(2);
  });
});
