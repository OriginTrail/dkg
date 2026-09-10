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
}

/**
 * Optional durable backing for finalized authority-history watermarks.
 *
 * Keys are already scoped by chain deployment, ContextGraphs contract, and
 * context-graph id by the adapter. Implementations must treat values as
 * replaceable checkpoints: the cache revalidates the recorded finalized block
 * hash before using one and falls back to a cold scan on any mismatch.
 */
export interface ContextGraphAuthorityHistoryStore {
  load(cacheKey: string): Promise<ContextGraphAuthorityHistoryState | undefined>;
  save(cacheKey: string, state: ContextGraphAuthorityHistoryState): Promise<void>;
  delete(cacheKey: string): Promise<void>;
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
  readonly #persistence = new Map<string, Promise<void>>();
  readonly #identityIds = new WeakMap<object, number>();
  #nextIdentityId = 1;
  #epoch = 0;

  constructor(
    readonly maxEntries: number = CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES,
    readonly store?: ContextGraphAuthorityHistoryStore,
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
        await this.#saveCheckpoint(input.cacheKey, state);
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
    if (previous === undefined) {
      previous = await this.#loadCheckpoint(input.cacheKey);
      if (previous !== undefined) this.#entries.set(input.cacheKey, previous);
    }
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
        // A null historical lookup can be a transient/non-archive provider
        // limitation. Fail closed for this attempt without destroying a
        // checkpoint that a failover provider may still validate. A concrete
        // hash mismatch (or a watermark from the future) is genuinely stale.
        if (anchorHash !== null || previous.throughBlockNumber > input.finalized.number) {
          await this.#deleteCheckpoint(input.cacheKey);
        }
        previous = undefined;
      }
    }
    return loadContextGraphAuthorityHistory({ ...input, previous });
  }

  async #loadCheckpoint(
    cacheKey: string,
  ): Promise<ContextGraphAuthorityHistoryState | undefined> {
    if (this.store === undefined) return undefined;
    try {
      return normalizeContextGraphAuthorityHistoryState(await this.store.load(cacheKey));
    } catch (err) {
      console.warn(
        `[chain] Context Graph authority history checkpoint load failed: ${formatError(err)}`,
      );
      return undefined;
    }
  }

  async #saveCheckpoint(
    cacheKey: string,
    state: ContextGraphAuthorityHistoryState,
  ): Promise<void> {
    if (this.store === undefined) return;
    const previousSave = this.#persistence.get(cacheKey) ?? Promise.resolve();
    const pending = previousSave.catch(() => {}).then(async () => {
      // A newer publication can arrive while an older store write is queued.
      // Persist only the current watermark so async stores cannot regress it.
      if (this.#entries.get(cacheKey) !== state) return;
      try {
        await this.store!.save(cacheKey, state);
      } catch (err) {
        // Persistence is an RPC-load optimization, never an authority boundary.
        // The verified in-memory state remains usable for this process lifetime.
        console.warn(
          `[chain] Context Graph authority history checkpoint save failed: ${formatError(err)}`,
        );
      }
    });
    this.#persistence.set(cacheKey, pending);
    try {
      await pending;
    } finally {
      if (this.#persistence.get(cacheKey) === pending) this.#persistence.delete(cacheKey);
    }
  }

  async #deleteCheckpoint(cacheKey: string): Promise<void> {
    if (this.store === undefined) return;
    try {
      await this.store.delete(cacheKey);
    } catch (err) {
      console.warn(
        `[chain] Context Graph authority history checkpoint delete failed: ${formatError(err)}`,
      );
    }
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normalizeNonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** Reject malformed/corrupt durable input before it can influence scan bounds. */
export function normalizeContextGraphAuthorityHistoryState(
  value: unknown,
): ContextGraphAuthorityHistoryState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Record<keyof ContextGraphAuthorityHistoryState, unknown>>;
  const throughBlockNumber = normalizeNonNegativeSafeInteger(candidate.throughBlockNumber);
  const throughBlockHash = normalizeHash(candidate.throughBlockHash);
  const nameHash = normalizeHash(candidate.nameHash);
  const ownershipEra = normalizeNonNegativeSafeInteger(candidate.ownershipEra);
  const policyVersion = normalizeNonNegativeSafeInteger(candidate.policyVersion);
  const rosterVersion = normalizeNonNegativeSafeInteger(candidate.rosterVersion);
  const sourceBlockNumber = normalizeNonNegativeSafeInteger(candidate.sourceBlockNumber);
  const sourceBlockHash = normalizeHash(candidate.sourceBlockHash);
  if (
    throughBlockNumber === undefined
    || throughBlockHash === undefined
    || nameHash === undefined
    || ownershipEra === undefined
    || policyVersion === undefined
    || rosterVersion === undefined
    || sourceBlockNumber === undefined
    || sourceBlockHash === undefined
    || sourceBlockNumber > throughBlockNumber
  ) return undefined;
  return Object.freeze({
    throughBlockNumber,
    throughBlockHash,
    nameHash,
    ownershipEra,
    policyVersion,
    rosterVersion,
    sourceBlockNumber,
    sourceBlockHash,
  });
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
      events.push(...await readAuthorityHistoryRange(
        (rangeFrom, rangeTo) => input.readEvents(
          { name, contextGraphId: input.contextGraphId },
          rangeFrom,
          rangeTo,
        ),
        lo,
        hi,
        input.signal,
      ));
    }
    return events;
  };
  const readCreation = async (): Promise<ContextGraphAuthorityHistoryCreationEvent[]> => {
    const events: ContextGraphAuthorityHistoryCreationEvent[] = [];
    for (let lo = fromBlock; lo <= input.finalized.number; lo += input.pageSize) {
      input.signal?.throwIfAborted();
      const hi = Math.min(lo + input.pageSize - 1, input.finalized.number);
      events.push(...await readAuthorityHistoryRange(
        (rangeFrom, rangeTo) => input.readCreationEvents(
          input.contextGraphId,
          rangeFrom,
          rangeTo,
        ),
        lo,
        hi,
        input.signal,
      ));
    }
    return events;
  };
  const [created, transfers, publishPolicy, publishAuthority, participantAdds,
    participantRemoves] = await Promise.all([
    previous === undefined ? readCreation() : Promise.resolve([]),
    read('Transfer'),
    read('PublishPolicyUpdated'),
    read('PublishAuthorityUpdated'),
    read('AgentParticipantAdded'),
    read('AgentParticipantRemoved'),
  ]);
  const baseline: Readonly<{
    nameHash: string;
    ownershipEra: number;
    policyVersion: number;
    rosterVersion: number;
    sourceBlockNumber: number;
    sourceBlockHash: string;
  }> = previous === undefined
    ? (() => {
        const creation = created[0];
        if (created.length !== 1 || creation === undefined) {
          throw new Error(
            `Context Graph ${input.contextGraphId.toString()} has ${created.length} finalized creation events`,
          );
        }
        if (!creation.nameHash) {
          throw new Error(
            `Context Graph ${input.contextGraphId.toString()} creation event has no name hash`,
          );
        }
        return {
          nameHash: creation.nameHash,
          ownershipEra: 0,
          policyVersion: 0,
          rosterVersion: 0,
          sourceBlockNumber: creation.blockNumber,
          sourceBlockHash: creation.blockHash,
        };
      })()
    : {
        nameHash: previous.nameHash,
        ownershipEra: previous.ownershipEra,
        policyVersion: previous.policyVersion,
        rosterVersion: previous.rosterVersion,
        sourceBlockNumber: previous.sourceBlockNumber,
        sourceBlockHash: previous.sourceBlockHash,
      };
  const policySource = latestEvent([
    ...created,
    ...transfers,
    ...publishPolicy,
    ...publishAuthority,
  ]);
  const sourceBlockNumber = policySource?.blockNumber ?? baseline.sourceBlockNumber;
  const sourceBlockHash = policySource?.blockHash ?? baseline.sourceBlockHash;
  const ownershipDelta = transfers.length;
  return Object.freeze({
    throughBlockNumber: input.finalized.number,
    throughBlockHash: input.finalized.hash,
    nameHash: baseline.nameHash,
    ownershipEra: baseline.ownershipEra + ownershipDelta,
    policyVersion: baseline.policyVersion
      + ownershipDelta + publishPolicy.length + publishAuthority.length,
    rosterVersion: baseline.rosterVersion
      + ownershipDelta + participantAdds.length + participantRemoves.length,
    sourceBlockNumber,
    sourceBlockHash: sourceBlockHash.toLowerCase(),
  });
}

/**
 * Retry only provider-declared block-range limits, splitting sequentially so a
 * 50-block fallback RPC can finish a scan configured for 200/2,000-block
 * providers without multiplying the cold-start request burst.
 */
async function readAuthorityHistoryRange<T>(
  read: (fromBlock: number, toBlock: number) => Promise<readonly T[]>,
  fromBlock: number,
  toBlock: number,
  signal?: AbortSignal,
): Promise<T[]> {
  signal?.throwIfAborted();
  try {
    return [...await read(fromBlock, toBlock)];
  } catch (err) {
    if (fromBlock >= toBlock || !isRpcBlockRangeLimitError(err)) throw err;
    const midpoint = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    const left = await readAuthorityHistoryRange(read, fromBlock, midpoint, signal);
    const right = await readAuthorityHistoryRange(read, midpoint + 1, toBlock, signal);
    return [...left, ...right];
  }
}

function isRpcBlockRangeLimitError(err: unknown): boolean {
  const candidate = err as {
    message?: unknown;
    error?: { message?: unknown };
    info?: { error?: { message?: unknown } };
  };
  const message = [
    candidate?.message,
    candidate?.error?.message,
    candidate?.info?.error?.message,
  ].filter((value): value is string => typeof value === 'string').join(' ');
  return /(?:block range too large|exceeds? (?:the )?(?:max(?:imum)? )?block range|maximum allowed is \d+ blocks|limited to (?:a )?\d+ blocks?)/i
    .test(message);
}
