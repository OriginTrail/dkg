import { ethers } from 'ethers';
import type { V10PublishingConvictionAccountInfo } from './chain-adapter.js';
import { KeyedSingleFlight, ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

export type PcaMutationInvalidation<T> =
  | { kind: 'account-created'; accountIdFromResult: (result: T) => bigint | undefined }
  | { kind: 'account-changed'; accountId: bigint }
  | { kind: 'agents-changed'; accountId: bigint; agents: readonly string[] }
  | { kind: 'all-agents-cleared'; accountId: bigint };

export class PcaReadCache {
  private static readonly READ_TTL_MS = 15 * 1000;

  private readonly agentAccountIdLookups = new KeyedSingleFlight<string, string>();

  private readonly accountInfoCache = new ReadThroughTtlCache<string, V10PublishingConvictionAccountInfo | null>({
    ttlMs: (value) => (value === null ? 0 : PcaReadCache.READ_TTL_MS),
  });

  async getAgentAccountId(
    agent: string,
    strict: boolean,
    load: (normalizedAgent: string) => Promise<bigint>,
  ): Promise<bigint> {
    const normalized = this.normalizeAgent(agent);
    if (!normalized) return 0n;
    return this.agentAccountIdLookups.run(
      normalized.cacheKey,
      `${normalized.cacheKey}:${strict ? 'strict' : 'soft'}`,
      () => load(normalized.address),
    );
  }

  async getAccountInfo(
    accountId: bigint,
    extended: boolean,
    load: () => Promise<V10PublishingConvictionAccountInfo | null>,
  ): Promise<V10PublishingConvictionAccountInfo | null> {
    const key = this.accountInfoCacheKey(accountId, extended);
    return this.accountInfoCache.getOrLoad(key, key, load);
  }

  invalidateMutation<T>(invalidation: PcaMutationInvalidation<T>, result: T): void {
    switch (invalidation.kind) {
      case 'account-created':
        this.invalidatePcaAccountInfo(invalidation.accountIdFromResult(result));
        return;
      case 'account-changed':
        this.invalidatePcaAccountInfo(invalidation.accountId);
        return;
      case 'agents-changed':
        this.invalidatePcaAccountInfo(invalidation.accountId);
        for (const agent of invalidation.agents) this.invalidatePcaAgent(agent);
        return;
      case 'all-agents-cleared':
        this.invalidatePcaAccountInfo(invalidation.accountId);
        this.invalidatePcaAgentsForAccount(invalidation.accountId);
        return;
    }
  }

  private invalidatePcaAccountInfo(accountId?: bigint): void {
    if (accountId == null || accountId <= 0n) return;
    for (const key of [
      this.accountInfoCacheKey(accountId, false),
      this.accountInfoCacheKey(accountId, true),
    ]) {
      this.accountInfoCache.invalidate(key);
    }
  }

  private invalidatePcaAgent(agent: string): void {
    const normalized = this.normalizeAgent(agent);
    if (!normalized) return;
    this.agentAccountIdLookups.invalidate(normalized.cacheKey);
  }

  private invalidateAllPcaAgents(): void {
    this.agentAccountIdLookups.invalidateAll();
  }

  private invalidatePcaAgentsForAccount(accountId?: bigint): void {
    if (accountId == null || accountId <= 0n) return;
    // The chain exposes no cheap reverse index from account -> agents here.
    // A broad flush is safer than retaining a stale allow-list after clearAgents().
    this.invalidateAllPcaAgents();
  }

  private accountInfoCacheKey(accountId: bigint, extended: boolean): string {
    return `${accountId.toString()}:${extended ? 'extended' : 'base'}`;
  }

  private normalizeAgent(agent: string): { address: string; cacheKey: string } | undefined {
    if (!ethers.isAddress(agent)) return undefined;
    const address = ethers.getAddress(agent);
    return { address, cacheKey: address.toLowerCase() };
  }
}
