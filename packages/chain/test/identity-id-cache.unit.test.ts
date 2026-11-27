import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityIdCache } from '../src/identity-id-cache.js';

const SIGNER = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';

afterEach(() => vi.useRealTimers());

describe('IdentityIdCache signer address boundary', () => {
  it('shares a checksummed signer zero across address forms until its short TTL expires', async () => {
    vi.useFakeTimers({ now: 0 });
    const cache = new IdentityIdCache(SIGNER);
    const load = vi.fn().mockResolvedValueOnce(0n).mockResolvedValueOnce(42n);
    await expect(cache.getOrLoad(SIGNER.toLowerCase(), load)).resolves.toBe(0n);
    vi.setSystemTime(14_999);
    await expect(cache.getOrLoad(SIGNER, load)).resolves.toBe(0n);
    expect(load).toHaveBeenCalledExactlyOnceWith(SIGNER, expect.any(Function));
    vi.setSystemTime(15_001);
    await expect(cache.getOrLoad(SIGNER, load)).resolves.toBe(42n);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

it('reports shared progress to each active waiter without lending cancellation to the load', async () => {
  const cache = new IdentityIdCache(SIGNER), abort = new AbortController();
  let release!: (id: bigint) => void, report!: () => void;
  const load = vi.fn((_address: string, notify: () => void) => {
    report = notify; return new Promise<bigint>(resolve => { release = resolve; });
  });
  const firstProgress = vi.fn(), secondProgress = vi.fn();
  const first = cache.getOrLoad(SIGNER, load, { signal: abort.signal, onProgress: firstProgress });
  report();
  const second = cache.getOrLoad(SIGNER, load, { onProgress: secondProgress });
  const third = cache.getOrLoad(SIGNER, load, { onProgress: () => { throw new Error('observer'); } });
  report(); abort.abort(); report();
  expect(firstProgress).toHaveBeenCalledTimes(2);
  expect(secondProgress).toHaveBeenCalledTimes(2);
  release(7n); expect(await Promise.all([first, second, third])).toEqual([7n, 7n, 7n]);
  report(); expect(secondProgress).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
});

it('keeps progress subscriptions separate across invalidation generations', async () => {
  const cache = new IdentityIdCache(SIGNER);
  let oldReport!: () => void, release!: (id: bigint) => void;
  const oldProgress = vi.fn(), newProgress = vi.fn();
  const old = cache.getOrLoad(SIGNER, (_address, notify) => {
    oldReport = notify; return new Promise<bigint>(resolve => { release = resolve; });
  }, { onProgress: oldProgress });
  cache.invalidate(SIGNER);
  const current = cache.getOrLoad(SIGNER, async (_address, notify) => { notify(); return 8n; }, { onProgress: newProgress });
  oldReport();
  expect(oldProgress).toHaveBeenCalledTimes(1); expect(newProgress).toHaveBeenCalledTimes(1);
  expect(await current).toBe(8n); release(7n); expect(await old).toBe(7n);
  expect(await cache.getOrLoad(SIGNER, async () => { throw new Error('cache lost'); })).toBe(8n);
});
