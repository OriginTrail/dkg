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
  type EvmContextGraphNameHashReader,
} from './evm-context-graph-name-hash-fence.js';
import {
  EvmContextGraphNameHashHistoricalLogResolver,
} from './evm-context-graph-name-hash-historical-log-resolver.js';

export interface EvmContextGraphNameHashResolverDependencies {
  readonly reader: EvmContextGraphNameHashReader;
}

export class EvmContextGraphNameHashResolver {
  private readonly resolutionCache: ContextGraphNameHashResolver;

  private readonly reader: EvmContextGraphNameHashReader;

  private readonly currentSlotResolver: EvmContextGraphNameHashCurrentSlotResolver;

  private readonly historicalLogResolver: EvmContextGraphNameHashHistoricalLogResolver;

  constructor(dependencies: EvmContextGraphNameHashResolverDependencies) {
    this.resolutionCache = new ContextGraphNameHashResolver({
      load: (nameHash) => this.loadFromChain(nameHash),
    });
    this.reader = dependencies.reader;
    this.currentSlotResolver = new EvmContextGraphNameHashCurrentSlotResolver(
      this.reader,
      { onIndexCommit: () => this.resolutionCache.invalidateAll() },
    );
    this.historicalLogResolver = new EvmContextGraphNameHashHistoricalLogResolver(
      this.reader,
    );
  }

  resolve(nameHash: string, signal?: AbortSignal): Promise<bigint | null> {
    return this.resolutionCache.resolve(nameHash, signal);
  }

  invalidateAll(): void {
    this.reader.invalidate();
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
