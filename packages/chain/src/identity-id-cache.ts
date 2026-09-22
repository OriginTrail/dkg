import { ethers } from 'ethers';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

// Positive registrations may be reused for five minutes. Only the node's
// signer gets a short negative cache; arbitrary-address misses must observe
// external registration immediately on the next lookup.
export const IDENTITY_ID_POSITIVE_TTL_MS = 5 * 60 * 1000;
export const SIGNER_IDENTITY_ID_ZERO_TTL_MS = 15 * 1000;

type IdentityIdCacheEntry = {
  identityId: bigint;
  ttlMs: number;
};

export class IdentityIdCache {
  private readonly values = new ReadThroughTtlCache<string, IdentityIdCacheEntry>({
    ttlMs: (entry) => entry.ttlMs,
  });

  private readonly signerCacheKey: string;

  constructor(
    signerAddress: string,
    private readonly positiveTtlMs = IDENTITY_ID_POSITIVE_TTL_MS,
    private readonly signerZeroTtlMs = SIGNER_IDENTITY_ID_ZERO_TTL_MS,
  ) {
    this.signerCacheKey = identityCacheKey(signerAddress);
  }

  async getOrLoad(
    address: string,
    load: (checksumAddress: string) => Promise<bigint>,
  ): Promise<bigint> {
    if (!ethers.isAddress(address)) return 0n;
    const checksum = ethers.getAddress(address);
    const cacheKey = identityCacheKey(checksum);
    const entry = await this.values.getOrLoad(cacheKey, cacheKey, async () => {
      const identityId = await load(checksum);
      return this.entry(cacheKey, identityId);
    });
    return entry.identityId;
  }

  seed(address: string, identityId: bigint): void {
    const cacheKey = identityCacheKey(address);
    this.values.seed(cacheKey, this.entry(cacheKey, identityId));
  }

  invalidate(address: string): void {
    const cacheKey = identityCacheKey(address);
    this.values.invalidate(cacheKey);
  }

  invalidateAll(): void {
    this.values.invalidateAll();
  }

  private entry(cacheKey: string, identityId: bigint): IdentityIdCacheEntry {
    const ttlMs = identityId > 0n
      ? this.positiveTtlMs
      : cacheKey === this.signerCacheKey
        ? this.signerZeroTtlMs
        : 0;
    return { identityId, ttlMs };
  }
}


function identityCacheKey(address: string): string {
  return ethers.getAddress(address).toLowerCase();
}
