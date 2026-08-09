// SPDX-License-Identifier: Apache-2.0

/**
 * Small orchestrator for EVM Context Graph name-hash reverse resolution.
 *
 * Result caching, current-slot enumeration, historical log scanning, and
 * shared chain fences deliberately have separate owners. The adapter supplies
 * only low-level EVM primitives and retains one stable public lookup method.
 */

import { ContextGraphNameHashResolver } from './context-graph-name-hash-resolver.js';
import {
  EvmContextGraphNameHashCurrentSlotResolver,
} from './evm-context-graph-name-hash-current-slot-resolver.js';
import {
  EvmContextGraphNameHashFence,
  type EvmContextGraphNameHashFenceDependencies,
} from './evm-context-graph-name-hash-fence.js';
import {
  EvmContextGraphNameHashHistoricalLogResolver,
  type EvmContextGraphNameHashHistoricalLogResolverDependencies,
} from './evm-context-graph-name-hash-historical-log-resolver.js';

export interface EvmContextGraphNameHashResolverDependencies
  extends EvmContextGraphNameHashFenceDependencies,
    EvmContextGraphNameHashHistoricalLogResolverDependencies {}

export class EvmContextGraphNameHashResolver {
  private readonly resolutionCache: ContextGraphNameHashResolver;

  private readonly fence: EvmContextGraphNameHashFence;

  private readonly currentSlotResolver: EvmContextGraphNameHashCurrentSlotResolver;

  private readonly historicalLogResolver: EvmContextGraphNameHashHistoricalLogResolver;

  constructor(dependencies: EvmContextGraphNameHashResolverDependencies) {
    this.resolutionCache = new ContextGraphNameHashResolver({
      load: (nameHash) => this.loadFromChain(nameHash),
    });
    this.fence = new EvmContextGraphNameHashFence(dependencies);
    this.currentSlotResolver = new EvmContextGraphNameHashCurrentSlotResolver(
      this.fence,
      { onIndexCommit: () => this.resolutionCache.invalidateAll() },
    );
    this.historicalLogResolver = new EvmContextGraphNameHashHistoricalLogResolver(
      this.fence,
      dependencies,
    );
  }

  resolve(nameHash: string, signal?: AbortSignal): Promise<bigint | null> {
    return this.resolutionCache.resolve(nameHash, signal);
  }

  invalidateAll(): void {
    this.fence.invalidate();
    this.currentSlotResolver.clear();
    this.resolutionCache.invalidateAll();
  }

  /** One uncached lookup across the current-slot or historical EVM lane. */
  async loadFromChain(normalizedNameHash: string): Promise<bigint | null> {
    const current = await this.currentSlotResolver.resolve(normalizedNameHash);
    return current.mode === 'historical'
      ? this.historicalLogResolver.resolve(normalizedNameHash)
      : current.id;
  }
}
