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
    expect(load).toHaveBeenCalledExactlyOnceWith(SIGNER);
    vi.setSystemTime(15_001);
    await expect(cache.getOrLoad(SIGNER, load)).resolves.toBe(42n);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
