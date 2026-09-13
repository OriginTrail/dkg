// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  AbortableKeyedSingleFlight,
  TtlValueCache,
} from './keyed-ttl-single-flight-cache.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;

export interface ContextGraphNameHashResolverDependencies {
  /** One concrete adapter-owned lookup for a normalized bytes32 commitment. */
  readonly load: (nameHash: string, signal: AbortSignal) => Promise<bigint | null>;
  /** Optional source generation that invalidates misses from older snapshots. */
  readonly generation?: () => number;
}

export interface ContextGraphNameHashResolveOptions {
  readonly signal?: AbortSignal;
  /** Explicit caller partition used to prevent priority inversion. */
  readonly partition?: string;
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
  private readonly partitions = new Map<string, {
    readonly cache: TtlValueCache<string, ContextGraphNameHashResolutionCacheEntry>;
    readonly singleFlight: AbortableKeyedSingleFlight<
      string,
      ContextGraphNameHashResolutionCacheEntry
    >;
  }>();

  constructor(
    private readonly dependencies: ContextGraphNameHashResolverDependencies,
  ) {}

  async resolve(
    rawNameHash: string,
    options: ContextGraphNameHashResolveOptions = {},
  ): Promise<bigint | null> {
    options.signal?.throwIfAborted();
    const nameHash = normalizeContextGraphNameHash(rawNameHash);
    if (nameHash === ethers.ZeroHash) return null;

    const partition = this.partitionFor(options.partition ?? 'default');
    for (;;) {
      const cached = partition.cache.get(nameHash);
      const resolved = cached ?? await partition.singleFlight.run(
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

  private partitionFor(
    partition: string,
  ): {
    readonly cache: TtlValueCache<string, ContextGraphNameHashResolutionCacheEntry>;
    readonly singleFlight: AbortableKeyedSingleFlight<
      string,
      ContextGraphNameHashResolutionCacheEntry
    >;
  } {
    let state = this.partitions.get(partition);
    if (state === undefined) {
      state = {
        cache: new TtlValueCache({
          ttlMs: ({ value }) => value === null
            ? CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS
            : 0,
        }),
        singleFlight: new AbortableKeyedSingleFlight(),
      };
      this.partitions.set(partition, state);
    }
    return state;
  }

  private invalidateCaches(): void {
    for (const partition of this.partitions.values()) {
      partition.cache.clear();
      partition.singleFlight.invalidateAll(
        'Context Graph name-hash binding changed during current-slot resolution',
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
