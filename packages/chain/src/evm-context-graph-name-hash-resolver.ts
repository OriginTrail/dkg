// SPDX-License-Identifier: Apache-2.0

/**
 * Small orchestrator for EVM Context Graph name-hash reverse resolution.
 *
 * Result caching is the only concern outside the chain source. The adapter
 * supplies one source whose high-level resolve operation owns current-slot and
 * historical lookup ordering, consensus, and revalidation end to end.
 */

import {
  ContextGraphNameHashResolver,
  normalizeContextGraphNameHashBatch,
} from './context-graph-name-hash-resolver.js';
import {
  activeRpcRequestContext,
  withOwnedRpcRequestContext,
  withRpcRequestContext,
} from './rpc-request-transport.js';
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
    this.source = dependencies.source;
    this.resolutionCache = new ContextGraphNameHashResolver({
      load: (nameHash, signal) => this.loadFromChain(nameHash, signal),
      generation: () => this.source.currentSlotRevision,
    });
  }

  resolve(nameHash: string, signal?: AbortSignal): Promise<bigint | null> {
    return this.resolutionCache.resolve(nameHash, {
      signal,
      requestClass: activeRpcRequestContext().requestClass,
    });
  }

  /** One fresh proof for all names; supersede older scalar evidence before return. */
  async resolveMany(nameHashes: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, bigint | null>> {
    signal?.throwIfAborted();
    const normalized = normalizeContextGraphNameHashBatch(nameHashes);
    if (normalized.length === 0) return new Map();
    try {
      return await withRpcRequestContext({ signal }, async () => {
        const bindings = await this.source.resolveMany(normalized);
        activeRpcRequestContext().signal?.throwIfAborted();
        // Historical proofs do not advance the current-slot generation. A
        // subsequent scalar policy check must not reuse an older cached miss.
        this.resolutionCache.invalidateNames(normalized);
        return bindings;
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }

  invalidateAll(): void {
    this.source.invalidate();
    this.resolutionCache.invalidateAll();
  }

  /** One uncached, fully fenced lookup across the adapter-owned chain source. */
  async loadFromChain(
    normalizedNameHash: string,
    signal: AbortSignal,
  ): Promise<bigint | null> {
    try {
      return await withOwnedRpcRequestContext({ signal }, () =>
        this.source.resolve(normalizedNameHash));
    } catch (error) {
      // A provider-consensus fence may summarize individually cancelled reads
      // as incomplete quorum. Preserve the physical owner's stronger lifecycle
      // reason so invalidation and final-waiter abandonment remain observable.
      signal.throwIfAborted();
      throw error;
    }
  }
}
