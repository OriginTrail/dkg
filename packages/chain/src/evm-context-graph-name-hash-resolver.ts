// SPDX-License-Identifier: Apache-2.0

/**
 * Small orchestrator for EVM Context Graph name-hash reverse resolution.
 *
 * Result caching is the only concern outside the chain source. The adapter
 * supplies one source whose high-level resolve operation owns current-slot and
 * historical lookup ordering, consensus, and revalidation end to end.
 */

import { ContextGraphNameHashResolver } from './context-graph-name-hash-resolver.js';
import {
  type EvmContextGraphNameHashSource,
} from './evm-context-graph-name-hash-fence.js';

export interface EvmContextGraphNameHashResolverDependencies {
  readonly source: EvmContextGraphNameHashSource;
}

export class EvmContextGraphNameHashResolver {
  private readonly resolutionCache: ContextGraphNameHashResolver;

  private readonly source: EvmContextGraphNameHashSource;

  constructor(dependencies: EvmContextGraphNameHashResolverDependencies) {
    this.resolutionCache = new ContextGraphNameHashResolver({
      load: (nameHash) => this.loadFromChain(nameHash),
    });
    this.source = dependencies.source;
  }

  resolve(nameHash: string, signal?: AbortSignal): Promise<bigint | null> {
    return this.resolutionCache.resolve(nameHash, signal);
  }

  invalidateAll(): void {
    this.source.invalidate();
    this.resolutionCache.invalidateAll();
  }

  /** One uncached, fully fenced lookup across the adapter-owned chain source. */
  async loadFromChain(normalizedNameHash: string): Promise<bigint | null> {
    return this.source.resolve(
      normalizedNameHash,
      () => this.resolutionCache.invalidateAll(),
    );
  }
}
