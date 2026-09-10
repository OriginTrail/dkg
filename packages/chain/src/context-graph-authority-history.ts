// SPDX-License-Identifier: Apache-2.0

import { BoundedLruCache } from '@origintrail-official/dkg-core';

export const CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES = 1_024;

export interface ContextGraphAuthorityHistoryEvent {
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
}

/** Creation is the only history event that must carry the immutable name hash. */
export interface ContextGraphAuthorityHistoryCreationEvent
  extends ContextGraphAuthorityHistoryEvent {
  readonly nameHash: string;
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
  | 'Transfer'
  | 'PublishPolicyUpdated'
  | 'PublishAuthorityUpdated'
  | 'AgentParticipantAdded'
  | 'AgentParticipantRemoved';

export interface ContextGraphAuthorityHistoryEventQuery {
  readonly name: ContextGraphAuthorityHistoryEventName;
  readonly contextGraphId: bigint;
}

export interface ContextGraphAuthorityHistoryLoadInput {
  readonly cacheKey: string;
  /** Stable identity of the physical RPC reader used for this provider attempt. */
  readonly readScope: object;
  readonly contextGraphId: bigint;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
  readonly loadColdFromBlock: () => Promise<number>;
  readonly readBlockHash: (blockNumber: number) => Promise<string | null>;
  readonly readCreationEvents: (
    contextGraphId: bigint,
    fromBlock: number,
    toBlock: number,
  ) => Promise<readonly ContextGraphAuthorityHistoryCreationEvent[]>;
  readonly readEvents: (
    query: ContextGraphAuthorityHistoryEventQuery,
    fromBlock: number,
    toBlock: number,
  ) => Promise<readonly ContextGraphAuthorityHistoryEvent[]>;
}

export interface ContextGraphAuthorityHistoryResolution {
  readonly state: ContextGraphAuthorityHistoryState;
  /** Revalidate and publish only after the matching current state is decoded. */
  publish(): Promise<void>;
}

/**
 * Atomic owner of finalized history loading, publication, and invalidation.
 * Same-head readers share a scan, an older completion cannot replace a newer
 * watermark, and clear() invalidates every in-flight publication lease.
 */
export class ContextGraphAuthorityHistoryCache {
  readonly #entries: BoundedLruCache<string, ContextGraphAuthorityHistoryState>;
  readonly #inflight = new Map<string, Promise<ContextGraphAuthorityHistoryState>>();
  readonly #identityIds = new WeakMap<object, number>();
  #nextIdentityId = 1;
  #epoch = 0;

  constructor(
    readonly maxEntries: number = CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Context Graph authority history cache must retain at least one entry');
    }
    this.#entries = new BoundedLruCache(maxEntries);
  }

  async resolve(
    input: ContextGraphAuthorityHistoryLoadInput,
  ): Promise<ContextGraphAuthorityHistoryResolution> {
    const epoch = this.#epoch;
    const finalizedHash = input.finalized.hash.toLowerCase();
    const normalizedInput = {
      ...input,
      finalized: { number: input.finalized.number, hash: finalizedHash },
    };
    // A failover retry at the same finalized head must be able to leave a
    // stalled endpoint behind. Likewise, callers with independent abort
    // signals must not inherit one another's cancellation. Readers only share
    // work when the logical head, physical endpoint, and cancellation domain
    // are all compatible.
    const loadKey = [
      input.cacheKey,
      input.finalized.number,
      finalizedHash,
      this.#identityId(input.readScope),
      input.signal === undefined ? 'no-signal' : this.#identityId(input.signal),
    ].join('\u0000');
    let pending = this.#inflight.get(loadKey);
    if (pending === undefined) {
      pending = this.#load(normalizedInput);
      this.#inflight.set(loadKey, pending);
      void pending.finally(() => {
        if (this.#inflight.get(loadKey) === pending) this.#inflight.delete(loadKey);
      }).catch(() => {});
    }
    const state = await pending;
    return Object.freeze({
      state,
      publish: async () => {
        // This is intentionally the final await: callers invoke publish only
        // after their concurrent current-state read and every field decode.
        const stableHash = await input.readBlockHash(input.finalized.number);
        if (stableHash?.toLowerCase() !== finalizedHash) {
          throw new Error('finalized Context Graph authority anchor changed during resolution');
        }
        if (this.#epoch !== epoch) {
          throw new Error('Context Graph authority history was invalidated during resolution');
        }
        const current = this.#entries.get(input.cacheKey);
        if (current !== undefined && current.throughBlockNumber > state.throughBlockNumber) return;
        if (
          current !== undefined
          && current.throughBlockNumber === state.throughBlockNumber
          && current.throughBlockHash === state.throughBlockHash
        ) return;
        this.#entries.set(input.cacheKey, state);
      },
    });
  }

  clear(): void {
    this.#epoch += 1;
    this.#entries.clear();
    this.#inflight.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #identityId(identity: object): number {
    const existing = this.#identityIds.get(identity);
    if (existing !== undefined) return existing;
    const assigned = this.#nextIdentityId;
    this.#nextIdentityId += 1;
    this.#identityIds.set(identity, assigned);
    return assigned;
  }

  async #load(
    input: ContextGraphAuthorityHistoryLoadInput,
  ): Promise<ContextGraphAuthorityHistoryState> {
    let previous = this.#entries.get(input.cacheKey);
    if (previous !== undefined) {
      const anchorHash = previous.throughBlockNumber === input.finalized.number
        ? input.finalized.hash
        : previous.throughBlockNumber < input.finalized.number
          ? await input.readBlockHash(previous.throughBlockNumber)
          : null;
      if (anchorHash?.toLowerCase() !== previous.throughBlockHash) {
        // Do not let a slow stale-anchor check delete a newer state published
        // while its RPC request was in flight.
        if (this.#entries.get(input.cacheKey) === previous) {
          this.#entries.delete(input.cacheKey);
        }
        previous = undefined;
      }
    }
    return loadContextGraphAuthorityHistory({ ...input, previous });
  }
}

export interface ResolveContextGraphAuthorityHistoryInput
  extends ContextGraphAuthorityHistoryLoadInput {
  readonly cache: ContextGraphAuthorityHistoryCache;
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
  const { cache, ...loadInput } = input;
  return cache.resolve(loadInput);
}

async function loadContextGraphAuthorityHistory(
  input: ContextGraphAuthorityHistoryLoadInput & {
    readonly previous?: ContextGraphAuthorityHistoryState;
  },
): Promise<ContextGraphAuthorityHistoryState> {
  const previous = input.previous;
  const cold = previous === undefined;
  const fromBlock = previous === undefined
    ? await input.loadColdFromBlock()
    : previous.throughBlockNumber + 1;
  const read = async (
    name: ContextGraphAuthorityHistoryEventName,
  ): Promise<ContextGraphAuthorityHistoryEvent[]> => {
    const events: ContextGraphAuthorityHistoryEvent[] = [];
    for (let lo = fromBlock; lo <= input.finalized.number; lo += input.pageSize) {
      input.signal?.throwIfAborted();
      const hi = Math.min(lo + input.pageSize - 1, input.finalized.number);
      events.push(...await input.readEvents({ name, contextGraphId: input.contextGraphId }, lo, hi));
    }
    return events;
  };
  const readCreation = async (): Promise<ContextGraphAuthorityHistoryCreationEvent[]> => {
    const events: ContextGraphAuthorityHistoryCreationEvent[] = [];
    for (let lo = fromBlock; lo <= input.finalized.number; lo += input.pageSize) {
      input.signal?.throwIfAborted();
      const hi = Math.min(lo + input.pageSize - 1, input.finalized.number);
      events.push(...await input.readCreationEvents(input.contextGraphId, lo, hi));
    }
    return events;
  };
  const [created, transfers, publishPolicy, publishAuthority, participantAdds,
    participantRemoves] = await Promise.all([
    cold ? readCreation() : Promise.resolve([]),
    read('Transfer'),
    read('PublishPolicyUpdated'),
    read('PublishAuthorityUpdated'),
    read('AgentParticipantAdded'),
    read('AgentParticipantRemoved'),
  ]);
  if (cold && created.length !== 1) {
    throw new Error(
      `Context Graph ${input.contextGraphId.toString()} has ${created.length} finalized creation events`,
    );
  }
  const policySource = latestEvent([
    ...created,
    ...transfers,
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
  const creationNameHash = creation?.nameHash;
  if (previous === undefined && !creationNameHash) {
    throw new Error(`Context Graph ${input.contextGraphId.toString()} creation event has no name hash`);
  }
  const ownershipDelta = transfers.length;
  return Object.freeze({
    throughBlockNumber: input.finalized.number,
    throughBlockHash: input.finalized.hash,
    nameHash: previous?.nameHash ?? creationNameHash!,
    ownershipEra: (previous?.ownershipEra ?? 0) + ownershipDelta,
    policyVersion: (previous?.policyVersion ?? 0)
      + ownershipDelta + publishPolicy.length + publishAuthority.length,
    rosterVersion: (previous?.rosterVersion ?? 0)
      + ownershipDelta + participantAdds.length + participantRemoves.length,
    sourceBlockNumber,
    sourceBlockHash: sourceBlockHash.toLowerCase(),
    sourceLogIndex,
  });
}
