// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;

export interface ContextGraphNameHashResolverDependencies {
  /** One concrete adapter-owned lookup for a normalized bytes32 commitment. */
  readonly load: (nameHash: string) => Promise<bigint | null>;
  /** Optional source generation that invalidates misses from older snapshots. */
  readonly generation?: () => number;
}

export interface ContextGraphNameHashResolveOptions {
  readonly signal?: AbortSignal;
  /** Explicit caller partition used to prevent priority inversion. */
  readonly partition?: string;
}

/**
 * Deployment-scoped, single-flight reverse lookup for cold Context Graphs.
 *
 * This generic boundary owns only input normalization, caller cancellation,
 * and the short negative cache. Chain-specific enumeration and temporal
 * fencing belong to the concrete source behind `load`.
 *
 * Only misses are cached. A positive binding is returned for process-local use
 * but deliberately not kept here: ContextGraphStorage does not enforce
 * name-hash uniqueness, so a later duplicate slot must be visible to the next
 * independent lookup.
 */
export class ContextGraphNameHashResolver {
  private readonly caches = new Map<
    string,
    ReadThroughTtlCache<string, bigint | null>
  >();

  private cacheGeneration: number | undefined;

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

    const generation = this.dependencies.generation?.();
    if (generation !== undefined) {
      if (this.cacheGeneration === undefined) {
        this.cacheGeneration = generation;
      } else if (generation !== this.cacheGeneration) {
        this.invalidateCaches();
        this.cacheGeneration = generation;
      }
    }

    const shared = this.cacheFor(options.partition ?? 'default').getOrLoad(
      nameHash,
      nameHash,
      () => this.dependencies.load(nameHash),
    );
    return waitForResolution(shared, options.signal);
  }

  invalidateAll(): void {
    this.invalidateCaches();
    this.cacheGeneration = this.dependencies.generation?.();
  }

  private cacheFor(partition: string): ReadThroughTtlCache<string, bigint | null> {
    let cache = this.caches.get(partition);
    if (cache === undefined) {
      cache = new ReadThroughTtlCache<string, bigint | null>({
        ttlMs: (value) => value === null
          ? CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS
          : 0,
      });
      this.caches.set(partition, cache);
    }
    return cache;
  }

  private invalidateCaches(): void {
    for (const cache of this.caches.values()) cache.invalidateAll();
  }
}

function normalizeContextGraphNameHash(value: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new TypeError('resolveContextGraphIdByNameHash requires a bytes32 nameHash');
  }
  return value.toLowerCase();
}

function waitForResolution<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason instanceof Error
        ? signal.reason
        : Object.assign(new Error('Context Graph name-hash resolution aborted'), {
            name: 'AbortError',
          }),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
