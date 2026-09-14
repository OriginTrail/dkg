// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  AbortableKeyedSingleFlight,
  TtlValueCache,
} from './keyed-ttl-single-flight-cache.js';
import type { RpcRequestClass } from './rpc-request-transport.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;
const CONTEXT_GRAPH_NAME_HASH_INVALIDATED_MESSAGE =
  'Context Graph name-hash binding changed during current-slot resolution';

export interface ContextGraphNameHashResolverDependencies {
  /** One concrete adapter-owned lookup for a normalized bytes32 commitment. */
  readonly load: (nameHash: string, signal: AbortSignal) => Promise<bigint | null>;
  /** Optional source generation that invalidates misses from older snapshots. */
  readonly generation?: () => number;
}

export interface ContextGraphNameHashResolveOptions {
  readonly signal?: AbortSignal;
  /** Explicit caller partition used to prevent priority inversion. */
  readonly requestClass?: RpcRequestClass;
}

interface ContextGraphNameHashResolutionCacheEntry {
  readonly value: bigint | null;
  /** Source generation observed immediately after the fenced load completed. */
  readonly generation?: number;
}

/**
 * Deployment-scoped, single-flight reverse lookup for cold Context Graphs.
 *
 * This generic boundary owns only input normalization, caller cancellation,
 * and the short negative cache. Chain-specific enumeration and temporal
 * fencing belong to the concrete source behind `load`. Shared physical work
 * survives while any waiter remains, and is cancelled when the final waiter
 * leaves so abandoned RPC admission cannot outlive its owner.
 *
 * Only misses are cached. A positive binding is returned for process-local use
 * but deliberately not kept here: ContextGraphStorage does not enforce
 * name-hash uniqueness, so a later duplicate slot must be visible to the next
 * independent lookup.
 */
export class ContextGraphNameHashResolver {
  private readonly partitions: Readonly<Record<RpcRequestClass, {
    readonly cache: TtlValueCache<string, ContextGraphNameHashResolutionCacheEntry>;
    readonly singleFlight: AbortableKeyedSingleFlight<
      string,
      ContextGraphNameHashResolutionCacheEntry
    >;
  }>>;

  constructor(
    private readonly dependencies: ContextGraphNameHashResolverDependencies,
  ) {
    this.partitions = Object.freeze({
      foreground: this.createPartition(),
      background: this.createPartition(),
    });
  }

  async resolve(
    rawNameHash: string,
    options: ContextGraphNameHashResolveOptions = {},
  ): Promise<bigint | null> {
    options.signal?.throwIfAborted();
    const nameHash = normalizeContextGraphNameHash(rawNameHash);
    if (nameHash === ethers.ZeroHash) return null;

    const partition = this.partitions[options.requestClass ?? 'foreground'];
    for (;;) {
      const cached = partition.cache.get(nameHash);
      let resolved: ContextGraphNameHashResolutionCacheEntry;
      try {
        resolved = cached ?? await partition.singleFlight.run(
          nameHash,
          async (physicalSignal) => ({
            value: await this.dependencies.load(nameHash, physicalSignal),
            // A cold current-slot load may advance the source generation itself.
            // Stamp the resulting miss after that commit so the next caller does
            // not immediately discard a fresh negative cache and repeat every
            // chain fence. A later, independent state advance still invalidates
            // the entry through the equality check below.
            generation: this.dependencies.generation?.(),
          }),
          options.signal,
          (value) => { partition.cache.set(nameHash, value); },
          'Context Graph name-hash resolution has no active waiters',
        );
      } catch (error) {
        // Adapter-wide cache invalidation is a stale-work fence, not an
        // operation failure. The old physical read is already aborted and
        // prevented from publishing; restart this caller against the new
        // generation unless its own deadline/cancellation has fired.
        if (
          !options.signal?.aborted
          && error instanceof Error
          && error.name === 'AbortError'
          && error.message === CONTEXT_GRAPH_NAME_HASH_INVALIDATED_MESSAGE
        ) continue;
        throw error;
      }
      const currentGeneration = this.dependencies.generation?.();
      if (
        resolved.generation === undefined
        || currentGeneration === resolved.generation
      ) return resolved.value;
      partition.cache.delete(nameHash);
      partition.singleFlight.invalidate(nameHash);
    }
  }

  invalidateAll(): void {
    this.invalidateCaches();
  }

  private createPartition(): {
    readonly cache: TtlValueCache<string, ContextGraphNameHashResolutionCacheEntry>;
    readonly singleFlight: AbortableKeyedSingleFlight<
      string,
      ContextGraphNameHashResolutionCacheEntry
    >;
  } {
    return {
      cache: new TtlValueCache({
        ttlMs: ({ value }) => value === null
          ? CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS
          : 0,
      }),
      singleFlight: new AbortableKeyedSingleFlight(),
    };
  }

  private invalidateCaches(): void {
    for (const partition of Object.values(this.partitions)) {
      partition.cache.clear();
      partition.singleFlight.invalidateAll(
        CONTEXT_GRAPH_NAME_HASH_INVALIDATED_MESSAGE,
      );
    }
  }
}

function normalizeContextGraphNameHash(value: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new TypeError('resolveContextGraphIdByNameHash requires a bytes32 nameHash');
  }
  return value.toLowerCase();
}
