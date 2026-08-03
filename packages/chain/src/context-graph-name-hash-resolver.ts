// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;

export interface ContextGraphNameHashResolverDependencies {
  /** One concrete adapter-owned lookup for a normalized bytes32 commitment. */
  readonly load: (nameHash: string) => Promise<bigint | null>;
}

/**
 * Deployment-scoped, single-flight reverse lookup for cold Context Graphs.
 *
 * Only misses are cached. A positive binding is returned to the caller and
 * persisted by the Agent subscription layer, but it is deliberately not kept
 * here: ContextGraphStorage does not enforce name-hash uniqueness, so a later
 * duplicate event must be visible to the next independent lookup.
 */
export class ContextGraphNameHashResolver {
  private readonly cache = new ReadThroughTtlCache<string, bigint | null>({
    ttlMs: (value) => value === null
      ? CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS
      : 0,
  });

  constructor(
    private readonly dependencies: ContextGraphNameHashResolverDependencies,
  ) {}

  async resolve(
    rawNameHash: string,
    signal?: AbortSignal,
  ): Promise<bigint | null> {
    signal?.throwIfAborted();
    const nameHash = normalizeContextGraphNameHash(rawNameHash);
    if (nameHash === ethers.ZeroHash) return null;

    const shared = this.cache.getOrLoad(
      nameHash,
      nameHash,
      () => this.dependencies.load(nameHash),
    );
    return waitForResolution(shared, signal);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
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
