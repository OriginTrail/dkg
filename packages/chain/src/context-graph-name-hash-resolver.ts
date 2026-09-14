// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  AbortableKeyedSingleFlight,
  SingleFlightInvalidatedError,
  TtlValueCache,
} from './keyed-ttl-single-flight-cache.js';
import type { RpcRequestClass } from './rpc-request-transport.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;
const CONTEXT_GRAPH_NAME_HASH_INVALIDATED_MESSAGE =
  'Context Graph name-hash binding changed during current-slot resolution';

export function normalizeContextGraphNameHashBatch(nameHashes: readonly string[]): readonly string[] {
  if (!Array.isArray(nameHashes)) {
    throw new TypeError('Context Graph name-hash batch must be an array');
  }
  return [...new Set(nameHashes.map(normalizeContextGraphNameHash))];
}

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
          async (physicalSignal) => {
            const value = await this.dependencies.load(nameHash, physicalSignal);
            // A superseded loader may ignore cancellation. Its old absence proof
            // must not reach waiting callers or repopulate the negative cache.
            physicalSignal.throwIfAborted();
            // A cold current-slot load may advance the source generation itself.
            // Stamp the resulting miss after that commit so the next caller does
            // not immediately discard a fresh negative cache and repeat every
            // chain fence. A later, independent state advance still invalidates
            // the entry through the equality check below.
            return { value, generation: this.dependencies.generation?.() };
          },
          options.signal,
          (value) => { partition.cache.set(nameHash, value); },
          'Context Graph name-hash resolution has no active waiters',
        );
      } catch (error) {
        // Binding rotation invalidates the shared physical read, not this
        // logical caller. Retry from the fresh generation unless the caller
        // itself was cancelled.
        if (
          error instanceof SingleFlightInvalidatedError
          && error.retryable
          && !options.signal?.aborted
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

  /** Reconcile fresh batch evidence without disturbing unrelated scalar work. */
  invalidateNames(rawNameHashes: readonly string[]): void {
    const names = normalizeContextGraphNameHashBatch(rawNameHashes);
    for (const partition of Object.values(this.partitions)) {
      for (const name of names) {
        partition.cache.delete(name);
        partition.singleFlight.invalidate(
          name,
          'Context Graph name-hash resolution was superseded by a fresh batch',
        );
      }
    }
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
        { retryable: true },
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
