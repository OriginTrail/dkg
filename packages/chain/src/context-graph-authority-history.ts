// SPDX-License-Identifier: Apache-2.0

export const CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES = 1_024;

export interface ContextGraphAuthorityHistoryEvent {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
  readonly args?: readonly unknown[] | Record<string, unknown>;
}

export interface ContextGraphAuthorityHistoryState {
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly nameHash: string;
  readonly ownershipEra: number;
  readonly policyVersion: number;
  readonly rosterVersion: number;
  readonly sourceBlockNumber: number;
  readonly sourceBlockHash: string;
  readonly sourceLogIndex: number;
}

export type ContextGraphAuthorityHistoryEventName =
  | 'ContextGraphCreated'
  | 'Transfer'
  | 'PublishPolicyUpdated'
  | 'PublishAuthorityUpdated'
  | 'AgentParticipantAdded'
  | 'AgentParticipantRemoved';

/** Bounded LRU storage for finalized per-contract, per-graph history states. */
export class ContextGraphAuthorityHistoryCache {
  readonly #entries = new Map<string, ContextGraphAuthorityHistoryState>();

  constructor(
    readonly maxEntries: number = CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Context Graph authority history cache must retain at least one entry');
    }
  }

  get(key: string): ContextGraphAuthorityHistoryState | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  set(key: string, value: ContextGraphAuthorityHistoryState): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

const adapterAuthorityHistoryCaches = new WeakMap<object, ContextGraphAuthorityHistoryCache>();

export function contextGraphAuthorityHistoryCacheFor(
  owner: object,
): ContextGraphAuthorityHistoryCache {
  let cache = adapterAuthorityHistoryCaches.get(owner);
  if (cache === undefined) {
    cache = new ContextGraphAuthorityHistoryCache();
    adapterAuthorityHistoryCaches.set(owner, cache);
  }
  return cache;
}

export function invalidateContextGraphAuthorityHistory(owner: object): void {
  adapterAuthorityHistoryCaches.get(owner)?.clear();
  adapterAuthorityHistoryCaches.delete(owner);
}

export interface ResolveContextGraphAuthorityHistoryInput {
  readonly cache: ContextGraphAuthorityHistoryCache;
  readonly cacheKey: string;
  readonly contextGraphId: bigint;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
  readonly loadColdFromBlock: () => Promise<number>;
  readonly readBlockHash: (blockNumber: number) => Promise<string | null>;
  readonly readEvents: (
    name: ContextGraphAuthorityHistoryEventName,
    args: readonly unknown[],
    fromBlock: number,
    toBlock: number,
  ) => Promise<readonly ContextGraphAuthorityHistoryEvent[]>;
  readonly isOwnershipTransfer: (event: ContextGraphAuthorityHistoryEvent) => boolean;
  readonly creationNameHash: (event: ContextGraphAuthorityHistoryEvent) => string;
}

export interface ContextGraphAuthorityHistoryResolution {
  readonly state: ContextGraphAuthorityHistoryState;
  /** Publish only after the matching current-state snapshot is decoded. */
  commit(): void;
}

function latestEvent(
  events: readonly ContextGraphAuthorityHistoryEvent[],
): ContextGraphAuthorityHistoryEvent | undefined {
  return [...events].sort((left, right) => (
    left.blockNumber - right.blockNumber || left.index - right.index
  )).at(-1);
}

/** Resolve one cold or suffix history scan into a complete generation state. */
export async function resolveContextGraphAuthorityHistory(
  input: ResolveContextGraphAuthorityHistoryInput,
): Promise<ContextGraphAuthorityHistoryResolution> {
  const finalizedHash = input.finalized.hash.toLowerCase();
  let previous = input.cache.get(input.cacheKey);
  if (previous !== undefined) {
    const anchorHash = previous.throughBlockNumber === input.finalized.number
      ? finalizedHash
      : previous.throughBlockNumber < input.finalized.number
        ? await input.readBlockHash(previous.throughBlockNumber)
        : null;
    if (anchorHash?.toLowerCase() !== previous.throughBlockHash) {
      input.cache.delete(input.cacheKey);
      previous = undefined;
    }
  }
  const cold = previous === undefined;
  const fromBlock = previous === undefined
    ? await input.loadColdFromBlock()
    : previous.throughBlockNumber + 1;
  const read = async (
    name: ContextGraphAuthorityHistoryEventName,
    args: readonly unknown[],
  ): Promise<ContextGraphAuthorityHistoryEvent[]> => {
    const events: ContextGraphAuthorityHistoryEvent[] = [];
    for (let lo = fromBlock; lo <= input.finalized.number; lo += input.pageSize) {
      input.signal?.throwIfAborted();
      const hi = Math.min(lo + input.pageSize - 1, input.finalized.number);
      events.push(...await input.readEvents(name, args, lo, hi));
    }
    return events;
  };
  const [created, transfers, publishPolicy, publishAuthority, participantAdds,
    participantRemoves] = await Promise.all([
    cold ? read('ContextGraphCreated', [input.contextGraphId]) : Promise.resolve([]),
    read('Transfer', [null, null, input.contextGraphId]),
    read('PublishPolicyUpdated', [input.contextGraphId]),
    read('PublishAuthorityUpdated', [input.contextGraphId]),
    read('AgentParticipantAdded', [input.contextGraphId]),
    read('AgentParticipantRemoved', [input.contextGraphId]),
  ]);
  if (cold && created.length !== 1) {
    throw new Error(
      `Context Graph ${input.contextGraphId.toString()} has ${created.length} finalized creation events`,
    );
  }
  const stableHash = await input.readBlockHash(input.finalized.number);
  if (stableHash?.toLowerCase() !== finalizedHash) {
    throw new Error('finalized Context Graph authority anchor changed during resolution');
  }
  const ownershipTransfers = transfers.filter(input.isOwnershipTransfer);
  const policySource = latestEvent([
    ...created,
    ...ownershipTransfers,
    ...publishPolicy,
    ...publishAuthority,
  ]);
  const creation = created[0];
  if (policySource === undefined && previous === undefined) {
    throw new Error(`Context Graph ${input.contextGraphId.toString()} has no authority history source`);
  }
  const sourceBlockNumber = policySource?.blockNumber ?? previous!.sourceBlockNumber;
  const sourceBlockHash = policySource?.blockHash ?? previous!.sourceBlockHash;
  const sourceLogIndex = policySource?.index ?? previous!.sourceLogIndex;
  const ownershipDelta = ownershipTransfers.length;
  const state: ContextGraphAuthorityHistoryState = Object.freeze({
    throughBlockNumber: input.finalized.number,
    throughBlockHash: finalizedHash,
    nameHash: previous?.nameHash ?? input.creationNameHash(creation!),
    ownershipEra: (previous?.ownershipEra ?? 0) + ownershipDelta,
    policyVersion: (previous?.policyVersion ?? 0)
      + ownershipDelta + publishPolicy.length + publishAuthority.length,
    rosterVersion: (previous?.rosterVersion ?? 0)
      + ownershipDelta + participantAdds.length + participantRemoves.length,
    sourceBlockNumber,
    sourceBlockHash: sourceBlockHash.toLowerCase(),
    sourceLogIndex,
  });
  return Object.freeze({
    state,
    commit: () => input.cache.set(input.cacheKey, state),
  });
}
