/**
 * Unit tests for HubResolutionCache. Covers the three paths that
 * matter for the live-rotation bug:
 *   - first call resolves and caches,
 *   - TTL expiry forces a re-resolve,
 *   - explicit `invalidate()` (used by the Hub event listener and the
 *     `UnauthorizedAccess(Only Contracts in Hub)` self-invalidation
 *     in the EVM adapter) forces a re-resolve.
 *
 * Plus the concurrent-get single-flight guarantee so a burst of
 * post-invalidation calls collapses to one Hub `eth_call`.
 */
import { describe, it, expect } from 'vitest';
import { HubResolutionCache } from '../src/hub-resolution-cache.js';

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('HubResolutionCache', () => {
  it('resolves once and reuses the cached value across calls', async () => {
    let calls = 0;
    const cache = new HubResolutionCache(async () => {
      calls += 1;
      return `v${calls}`;
    });
    expect(await cache.get()).toBe('v1');
    expect(await cache.get()).toBe('v1');
    expect(await cache.get()).toBe('v1');
    expect(calls).toBe(1);
  });

  it('re-resolves after TTL expiry', async () => {
    let calls = 0;
    const clock = fakeClock();
    const cache = new HubResolutionCache(
      async () => {
        calls += 1;
        return `v${calls}`;
      },
      { ttlMs: 1_000, now: clock.now },
    );
    expect(await cache.get()).toBe('v1');
    clock.advance(500);
    expect(await cache.get()).toBe('v1');
    expect(calls).toBe(1);
    clock.advance(600); // 1100ms total — past TTL
    expect(await cache.get()).toBe('v2');
    expect(calls).toBe(2);
  });

  it('does NOT re-resolve when ttlMs is omitted (event-/error-driven only)', async () => {
    let calls = 0;
    const clock = fakeClock();
    const cache = new HubResolutionCache(
      async () => {
        calls += 1;
        return `v${calls}`;
      },
      { now: clock.now },
    );
    await cache.get();
    clock.advance(10 * 60 * 1000); // 10 minutes
    await cache.get();
    expect(calls).toBe(1);
  });

  it('invalidate() forces a re-resolve on next get()', async () => {
    let calls = 0;
    const cache = new HubResolutionCache(async () => {
      calls += 1;
      return `v${calls}`;
    });
    expect(await cache.get()).toBe('v1');
    cache.invalidate();
    expect(await cache.get()).toBe('v2');
    expect(calls).toBe(2);
  });

  it('peek() returns the snapshot without triggering a refresh', async () => {
    let calls = 0;
    const clock = fakeClock();
    const cache = new HubResolutionCache(
      async () => {
        calls += 1;
        return `v${calls}`;
      },
      { ttlMs: 1, now: clock.now },
    );
    expect(cache.peek()).toBeNull();
    await cache.get();
    expect(cache.peek()).toBe('v1');
    clock.advance(1_000);
    expect(cache.peek()).toBe('v1'); // peek does NOT refresh, even when stale
    expect(calls).toBe(1);
    cache.invalidate();
    expect(cache.peek()).toBeNull();
  });

  it('coalesces concurrent gets into one resolver call (single-flight)', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const cache = new HubResolutionCache(
      () =>
        new Promise<string>((resolve) => {
          calls += 1;
          release = resolve;
        }),
    );
    const p1 = cache.get();
    const p2 = cache.get();
    const p3 = cache.get();
    expect(calls).toBe(1);
    release('v1');
    expect(await p1).toBe('v1');
    expect(await p2).toBe('v1');
    expect(await p3).toBe('v1');
    expect(calls).toBe(1);
  });

  it('rethrows resolver errors and clears the in-flight slot so the next call retries', async () => {
    let calls = 0;
    const cache = new HubResolutionCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error('rpc down');
      return `v${calls}`;
    });
    await expect(cache.get()).rejects.toThrow('rpc down');
    expect(await cache.get()).toBe('v2');
    expect(calls).toBe(2);
  });

  it('invalidate() during an in-flight resolve discards the result so it cannot write back the stale value', async () => {
    // Simulates the race the Codex review flagged:
    //   1. tick T0 calls get() — resolver starts, awaiting RPC
    //   2. Hub rotates RandomSampling; listener calls invalidate()
    //   3. tick T0's resolver finally returns the PRE-rotation address
    //   4. without the generation guard, that pre-rotation value
    //      would land in `cached` and the very next get() would
    //      observe it (still stale) instead of re-resolving.
    let calls = 0;
    let releaseFirst!: (v: string) => void;
    const cache = new HubResolutionCache(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return `post-rotation-v${calls}`;
    });

    const inflight = cache.get();
    expect(calls).toBe(1);
    expect(cache.peek()).toBeNull();

    // Hub-event-listener equivalent fires while the first resolve is
    // still suspended.
    cache.invalidate();
    expect(cache.peek()).toBeNull();

    // Stale value finally lands. Awaiters of the original promise
    // still receive it (we don't break their contract), but the cache
    // must NOT remember it.
    releaseFirst('pre-rotation-stale');
    expect(await inflight).toBe('pre-rotation-stale');
    expect(cache.peek()).toBeNull();

    // Next get() forces a fresh resolve (no coalescing onto the dead
    // generation), and that result is what becomes the new cache.
    expect(await cache.get()).toBe('post-rotation-v2');
    expect(cache.peek()).toBe('post-rotation-v2');
    expect(calls).toBe(2);
  });
});
