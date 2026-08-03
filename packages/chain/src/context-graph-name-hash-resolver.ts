// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;

export interface ContextGraphNameHashResolutionScope {
  /** Deployment address plus normalized name hash. */
  readonly cacheKey: string;
  /** One exact-topic, deploy-anchored historical scan. */
  readonly scan: () => Promise<bigint | null>;
}

export interface ContextGraphNameHashResolverDependencies {
  prepare(nameHash: string): Promise<ContextGraphNameHashResolutionScope>;
}

export interface ContextGraphNameHashScanInput<Preferred, Log> {
  readonly nameHash: string;
  readonly fromBlock: number;
  readonly head: number;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly queryPage: (
    lo: number,
    hi: number,
    preferred: Preferred | undefined,
  ) => Promise<{ logs: ReadonlyArray<Log>; preferred: Preferred }>;
  readonly parseContextGraphId: (log: Log) => bigint | null;
  readonly readCurrentNameHash: (contextGraphId: bigint) => Promise<string | null>;
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

    const scope = await this.dependencies.prepare(nameHash);
    signal?.throwIfAborted();
    const shared = this.cache.getOrLoad(
      scope.cacheKey,
      scope.cacheKey,
      scope.scan,
    );
    return waitForResolution(shared, signal);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
  }
}

/** Execute and verify one bounded exact-topic historical scan. */
export async function scanContextGraphIdByNameHash<Preferred, Log>(
  input: ContextGraphNameHashScanInput<Preferred, Log>,
): Promise<bigint | null> {
  if (input.fromBlock > input.head) return null;

  const pages = Math.ceil((input.head - input.fromBlock + 1) / input.pageSize);
  if (pages > input.maxPages) {
    throw new Error(
      `resolveContextGraphIdByNameHash: historical ContextGraphCreated scan ` +
      `would need ${pages} eth_getLogs calls over blocks ` +
      `[${input.fromBlock}, ${input.head}] at a ${input.pageSize}-block window ` +
      `(budget ${input.maxPages} pages).`,
    );
  }

  const ids = new Set<bigint>();
  let preferred: Preferred | undefined;
  for (let lo = input.fromBlock; lo <= input.head; lo += input.pageSize) {
    const hi = Math.min(lo + input.pageSize - 1, input.head);
    const page = await input.queryPage(lo, hi, preferred);
    preferred = page.preferred;
    for (const log of page.logs) {
      const id = input.parseContextGraphId(log);
      if (id === null) continue;
      if (id <= 0n) {
        throw new Error(
          `resolveContextGraphIdByNameHash: invalid Context Graph id ` +
          `${id.toString()} for ${input.nameHash}`,
        );
      }
      ids.add(id);
    }
  }

  if (ids.size === 0) return null;
  if (ids.size !== 1) {
    throw new Error(
      `resolveContextGraphIdByNameHash: ambiguous ${input.nameHash}; ` +
      `ContextGraphCreated committed it to ${ids.size} numeric ids`,
    );
  }

  const id = ids.values().next().value as bigint;
  const currentHash = await input.readCurrentNameHash(id);
  if (currentHash !== input.nameHash) {
    throw new Error(
      `resolveContextGraphIdByNameHash: slot ${id.toString()} currently commits ` +
      `${currentHash ?? ethers.ZeroHash}, expected ${input.nameHash}`,
    );
  }
  return id;
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
