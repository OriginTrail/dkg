// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { ReadThroughTtlCache } from './keyed-ttl-single-flight-cache.js';

const CONTEXT_GRAPH_NAME_HASH_NEGATIVE_TTL_MS = 30_000;

/**
 * Maximum current high-water id for the fast getNameHash enumeration. Above
 * this threshold the adapter switches before any per-id read to its bounded,
 * deploy-anchored exact-topic event scan; large future deployments therefore
 * remain serviceable without turning every cold bind into thousands of calls.
 */
export const CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS = 1_024n;

/** Fixed pressure bound for the current-state getNameHash enumeration. */
export const CONTEXT_GRAPH_NAME_HASH_ENUMERATION_CONCURRENCY = 4;

export interface ContextGraphNameHashResolverDependencies {
  /** One concrete adapter-owned lookup for a normalized bytes32 commitment. */
  readonly load: (nameHash: string) => Promise<bigint | null>;
}

export interface ContextGraphNameHashSlotIndexScope {
  readonly storageAddress: string;
  readonly providers: readonly object[];
  readonly rpcUrls: readonly string[];
}

export interface ContextGraphNameHashSlot {
  readonly id: bigint;
  readonly nameHash: string | null;
}

export interface ContextGraphNameHashSlotIndexAnchor {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export type ContextGraphNameHashSlotIndexResult =
  | { readonly mode: 'current'; readonly id: bigint | null; readonly highWater: bigint }
  | { readonly mode: 'historical' };

interface ContextGraphNameHashSlotIndexState {
  readonly scope: ContextGraphNameHashSlotIndexScope;
  readonly highWater: bigint;
  readonly anchor: ContextGraphNameHashSlotIndexAnchor;
  readonly idsByHash: ReadonlyMap<string, readonly bigint[]>;
}

export interface ContextGraphNameHashSlotIndexDependencies {
  readonly captureScope: () => Promise<ContextGraphNameHashSlotIndexScope>;
  readonly captureAnchor: () => Promise<ContextGraphNameHashSlotIndexAnchor>;
  readonly loadAnchorHash: (blockNumber: number) => Promise<string | null>;
  readonly loadLatestId: () => Promise<bigint>;
  readonly loadRange: (
    firstId: bigint,
    lastId: bigint,
  ) => Promise<readonly ContextGraphNameHashSlot[]>;
  readonly onCommit?: () => void;
}

/**
 * Adapter-local inverse index over ContextGraphStorage's bounded, write-once
 * name-hash slots. Refreshes are globally serialized across requested hashes:
 * one lookup builds the initial snapshot and later lookups scan only ids above
 * its high-water mark. A provider/deployment change, lowered counter, or
 * changed canonical block anchor rebuilds from slot one. The adapter also
 * re-reads a unique candidate before use. Together these retain constant
 * steady-state cost while detecting same-count reorgs and live slot drift.
 *
 * Range results are staged and committed atomically. Caller cancellation lives
 * outside this object (in ContextGraphNameHashResolver), so an aborted waiter
 * cannot cancel or partially mutate the shared index. Explicit invalidation is
 * epoch guarded for the same reason.
 */
export class ContextGraphNameHashSlotIndex {
  private state: ContextGraphNameHashSlotIndexState | undefined;

  private epoch = 0;

  private tail: Promise<void> = Promise.resolve();

  resolve(
    normalizedNameHash: string,
    dependencies: ContextGraphNameHashSlotIndexDependencies,
  ): Promise<ContextGraphNameHashSlotIndexResult> {
    const run = this.tail.then(
      () => this.resolveSerialized(normalizedNameHash, dependencies),
      () => this.resolveSerialized(normalizedNameHash, dependencies),
    );
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  clear(): void {
    this.epoch += 1;
    this.state = undefined;
  }

  private async resolveSerialized(
    normalizedNameHash: string,
    dependencies: ContextGraphNameHashSlotIndexDependencies,
  ): Promise<ContextGraphNameHashSlotIndexResult> {
    const epoch = this.epoch;
    const scope = await dependencies.captureScope();
    const latestId = await dependencies.loadLatestId();
    if (latestId < 0n) {
      throw new Error(
        `resolveContextGraphIdByNameHash: getLatestContextGraphId returned ` +
        `invalid negative id ${latestId.toString()}`,
      );
    }
    if (latestId > CONTEXT_GRAPH_NAME_HASH_FAST_ENUMERATION_MAX_IDS) {
      return { mode: 'historical' };
    }

    const previous = this.state;
    let rebuild = previous === undefined
      || !sameScope(previous.scope, scope)
      || latestId < previous.highWater;
    if (!rebuild && previous !== undefined) {
      const currentAnchorHash = await dependencies.loadAnchorHash(
        previous.anchor.blockNumber,
      );
      rebuild = currentAnchorHash?.toLowerCase() !== previous.anchor.blockHash;
    }
    const firstId = rebuild ? 1n : (previous?.highWater ?? 0n) + 1n;
    const nextAnchor = rebuild || firstId <= latestId
      ? await dependencies.captureAnchor()
      : previous?.anchor;
    const staged = firstId <= latestId
      ? await dependencies.loadRange(firstId, latestId)
      : [];

    if (nextAnchor === undefined) {
      throw new Error(
        'resolveContextGraphIdByNameHash: current-slot refresh has no chain anchor',
      );
    }
    if (rebuild || staged.length > 0) {
      const currentAnchorHash = await dependencies.loadAnchorHash(
        nextAnchor.blockNumber,
      );
      if (currentAnchorHash?.toLowerCase() !== nextAnchor.blockHash) {
        throw new Error(
          'resolveContextGraphIdByNameHash: canonical chain anchor changed ' +
          'during current-slot refresh',
        );
      }
    }

    const scopeAfterRead = await dependencies.captureScope();
    if (this.epoch !== epoch || !sameScope(scope, scopeAfterRead)) {
      throw new Error(
        'resolveContextGraphIdByNameHash: chain provider or ContextGraphStorage ' +
        'binding changed during current-slot refresh',
      );
    }

    let state = previous;
    if (rebuild || staged.length > 0) {
      const idsByHash = rebuild
        ? new Map<string, bigint[]>()
        : cloneIdsByHash(previous?.idsByHash);
      appendSlots(idsByHash, staged, firstId, latestId);
      state = {
        scope: copyScope(scope),
        highWater: latestId,
        anchor: nextAnchor,
        idsByHash,
      };
      this.state = state;
      // Advancing or rebuilding the complete slot snapshot invalidates any
      // per-name negative TTL: the newly staged ids may contain that hash.
      dependencies.onCommit?.();
    }

    const ids = state?.idsByHash.get(normalizedNameHash) ?? [];
    if (ids.length === 0) return { mode: 'current', id: null, highWater: latestId };
    if (ids.length !== 1) {
      throw new Error(
        `resolveContextGraphIdByNameHash: ambiguous ${normalizedNameHash}; ` +
        `getNameHash commits it to ${ids.length} numeric ids`,
      );
    }
    return { mode: 'current', id: ids[0]!, highWater: latestId };
  }
}

function sameScope(
  a: ContextGraphNameHashSlotIndexScope,
  b: ContextGraphNameHashSlotIndexScope,
): boolean {
  return a.storageAddress === b.storageAddress
    && sameValues(a.providers, b.providers)
    && sameValues(a.rpcUrls, b.rpcUrls);
}

function sameValues<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function copyScope(
  scope: ContextGraphNameHashSlotIndexScope,
): ContextGraphNameHashSlotIndexScope {
  return {
    storageAddress: scope.storageAddress,
    providers: [...scope.providers],
    rpcUrls: [...scope.rpcUrls],
  };
}

function cloneIdsByHash(
  source: ReadonlyMap<string, readonly bigint[]> | undefined,
): Map<string, bigint[]> {
  return new Map(
    [...(source ?? [])].map(([nameHash, ids]) => [nameHash, [...ids]]),
  );
}

function appendSlots(
  idsByHash: Map<string, bigint[]>,
  slots: readonly ContextGraphNameHashSlot[],
  firstId: bigint,
  lastId: bigint,
): void {
  const expectedCount = lastId < firstId ? 0 : Number(lastId - firstId + 1n);
  if (slots.length !== expectedCount) {
    throw new Error(
      `resolveContextGraphIdByNameHash: current-slot refresh returned ` +
      `${slots.length} rows for ${expectedCount} ids`,
    );
  }
  const seen = new Set<bigint>();
  for (const slot of slots) {
    if (slot.id < firstId || slot.id > lastId || seen.has(slot.id)) {
      throw new Error(
        `resolveContextGraphIdByNameHash: invalid current-slot refresh id ` +
        `${slot.id.toString()} for range [${firstId.toString()}, ${lastId.toString()}]`,
      );
    }
    seen.add(slot.id);
    if (slot.nameHash === null || slot.nameHash === ethers.ZeroHash) continue;
    const normalized = slot.nameHash.toLowerCase();
    const ids = idsByHash.get(normalized) ?? [];
    ids.push(slot.id);
    idsByHash.set(normalized, ids);
  }
}

/**
 * Deployment-scoped, single-flight reverse lookup for cold Context Graphs.
 *
 * Only misses are cached. A positive binding is returned for process-local use
 * but deliberately not kept here: ContextGraphStorage does not enforce
 * name-hash uniqueness, so a later duplicate slot must be visible to the next
 * independent lookup.
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
