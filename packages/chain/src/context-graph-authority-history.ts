// SPDX-License-Identifier: Apache-2.0

import { BoundedLruCache } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { KeyedSerializer } from './keyed-mutex.js';

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

export const CONTEXT_GRAPH_AUTHORITY_HISTORY_CHECKPOINT_VERSION = 1 as const;

export interface ContextGraphAuthorityHistoryCheckpointV1 {
  readonly version: typeof CONTEXT_GRAPH_AUTHORITY_HISTORY_CHECKPOINT_VERSION;
  readonly state: ContextGraphAuthorityHistoryState;
  /** Detects torn, stale-schema, and accidentally edited local payloads. */
  readonly integrity: string;
}

/** Opaque persistence backend; decoding and version ownership stay in chain. */
export interface ContextGraphAuthorityHistoryStore {
  load(cacheKey: string): Promise<unknown>;
  save(cacheKey: string, checkpoint: ContextGraphAuthorityHistoryCheckpointV1): Promise<void>;
  delete(cacheKey: string): Promise<void>;
}

declare const TRUSTED_AUTHORITY_HISTORY_STORE: unique symbol;

/**
 * Authority generations are historical aggregates and cannot be authenticated
 * from a block hash alone. A checkpoint backend therefore belongs to the
 * node's trusted local integrity domain; untrusted remote/shared stores must
 * not be promoted through this interface.
 */
export interface TrustedContextGraphAuthorityHistoryStore
  extends ContextGraphAuthorityHistoryStore {
  readonly [TRUSTED_AUTHORITY_HISTORY_STORE]: true;
}

const trustedAuthorityHistoryStores = new WeakSet<object>();

/** Explicitly admit a process-owned backend into the authority trust boundary. */
export function trustContextGraphAuthorityHistoryStore<T extends ContextGraphAuthorityHistoryStore>(
  store: T,
): T & TrustedContextGraphAuthorityHistoryStore {
  trustedAuthorityHistoryStores.add(store);
  return store as T & TrustedContextGraphAuthorityHistoryStore;
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

interface ColdScanWaiter {
  readonly cacheKey: string;
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
}

/**
 * One cold Context Graph history at a time, while allowing concurrent provider
 * attempts for that same graph so failover can leave a stalled endpoint behind.
 */
class ContextGraphAuthorityColdScanAdmission {
  #activeCacheKey: string | undefined;
  #activeCount = 0;
  readonly #waiters: ColdScanWaiter[] = [];

  async run<T>(
    cacheKey: string,
    signal: AbortSignal | undefined,
    read: () => Promise<T>,
  ): Promise<T> {
    await this.#acquire(cacheKey, signal);
    try {
      signal?.throwIfAborted();
      return await read();
    } finally {
      this.#release();
    }
  }

  async #acquire(cacheKey: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#activeCacheKey === undefined || this.#activeCacheKey === cacheKey) {
      this.#activeCacheKey = cacheKey;
      this.#activeCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ColdScanWaiter = {
        cacheKey,
        signal,
        resolve: () => {
          if (signal) signal.removeEventListener('abort', abort);
          resolve();
        },
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    this.#activeCount -= 1;
    if (this.#activeCount > 0) return;
    this.#activeCacheKey = undefined;
    while (this.#waiters.length > 0) {
      const first = this.#waiters.shift()!;
      if (first.signal?.aborted) continue;
      this.#activeCacheKey = first.cacheKey;
      const admitted = [first];
      for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.#waiters[index]!;
        if (waiter.cacheKey !== first.cacheKey || waiter.signal?.aborted) continue;
        admitted.push(waiter);
        this.#waiters.splice(index, 1);
      }
      this.#activeCount = admitted.length;
      for (const waiter of admitted) waiter.resolve();
      return;
    }
  }
}

/**
 * Atomic owner of finalized history loading, publication, and invalidation.
 * Same-head readers share a scan, an older completion cannot replace a newer
 * watermark, and clear() invalidates every in-flight publication lease.
 */
export class ContextGraphAuthorityHistoryCache {
  readonly #entries: BoundedLruCache<string, ContextGraphAuthorityHistoryState>;
  readonly #inflight = new Map<string, Promise<ContextGraphAuthorityHistoryState>>();
  readonly #persistence = new KeyedSerializer();
  readonly #coldScans = new ContextGraphAuthorityColdScanAdmission();
  readonly #identityIds = new WeakMap<object, number>();
  #nextIdentityId = 1;
  #epoch = 0;

  constructor(
    readonly maxEntries: number = CONTEXT_GRAPH_AUTHORITY_HISTORY_MAX_ENTRIES,
    readonly store?: TrustedContextGraphAuthorityHistoryStore,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Context Graph authority history cache must retain at least one entry');
    }
    if (store !== undefined && !trustedAuthorityHistoryStores.has(store)) {
      throw new Error(
        'Context Graph authority history store must be explicitly admitted as trusted local storage',
      );
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
    // A lagging endpoint cannot authenticate a watermark from its future. Keep
    // that higher checkpoint in memory and durable storage, cold-scan only for
    // this request, and let publish monotonicity prevent the older result from
    // replacing it. A later caught-up endpoint can validate and resume from it.
    if (previous !== undefined && previous.throughBlockNumber > input.finalized.number) {
      return this.#coldScans.run(input.cacheKey, input.signal, () => (
        loadContextGraphAuthorityHistory({ ...input, previous: undefined })
      ));
    }
    if (previous !== undefined) {
      const anchorHash = previous.throughBlockNumber === input.finalized.number
        ? input.finalized.hash
        : await input.readBlockHash(previous.throughBlockNumber);
      if (anchorHash?.toLowerCase() !== previous.throughBlockHash) {
        // Do not let a slow stale-anchor check delete a newer state published
        // while its RPC request was in flight.
        if (this.#entries.get(input.cacheKey) === previous) {
          this.#entries.delete(input.cacheKey);
        }
        // A null historical lookup can be a transient/non-archive provider
        // limitation. Fail closed for this attempt without destroying a
        // checkpoint that a failover provider may still validate. A concrete
        // hash mismatch is a genuinely stale anchor.
        if (anchorHash !== null) {
          await this.#deleteCheckpoint(input.cacheKey);
        }
        previous = undefined;
      }
    }
    return previous === undefined
      ? this.#coldScans.run(input.cacheKey, input.signal, () => (
          loadContextGraphAuthorityHistory({ ...input, previous: undefined })
        ))
      : loadContextGraphAuthorityHistory({ ...input, previous });
  }

  async #loadCheckpoint(
    cacheKey: string,
  ): Promise<ContextGraphAuthorityHistoryState | undefined> {
    if (this.store === undefined) return undefined;
    try {
      return decodeContextGraphAuthorityHistoryCheckpoint(await this.store.load(cacheKey));
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
    await this.#persistence.run(cacheKey, async () => {
      // A newer publication can arrive while an older store write is queued.
      // Persist only the current watermark so async stores cannot regress it.
      if (this.#entries.get(cacheKey) !== state) return;
      try {
        await this.store!.save(cacheKey, encodeContextGraphAuthorityHistoryCheckpoint(state));
      } catch (err) {
        // Persistence is optional for availability. Once explicitly admitted,
        // its valid checkpoints are authority-bearing; a write failure still
        // leaves this process's chain-derived in-memory state usable.
        console.warn(
          `[chain] Context Graph authority history checkpoint save failed: ${formatError(err)}`,
        );
      }
    });
  }

  async #deleteCheckpoint(cacheKey: string): Promise<void> {
    if (this.store === undefined) return;
    await this.#persistence.run(cacheKey, async () => {
      // A concurrent publication may have installed a newer desired state
      // before this queued delete begins. In that case the deletion belongs to
      // an obsolete generation and must not touch durable storage.
      if (this.#entries.get(cacheKey) !== undefined) return;
      try {
        await this.store!.delete(cacheKey);
      } catch (err) {
        console.warn(
          `[chain] Context Graph authority history checkpoint delete failed: ${formatError(err)}`,
        );
      }
    });
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

function contextGraphAuthorityHistoryStateIntegrity(
  state: ContextGraphAuthorityHistoryState,
): string {
  const canonical = JSON.stringify([
    'dkg-context-graph-authority-history-checkpoint-v1',
    state.throughBlockNumber,
    state.throughBlockHash,
    state.nameHash,
    state.ownershipEra,
    state.policyVersion,
    state.rosterVersion,
    state.sourceBlockNumber,
    state.sourceBlockHash,
  ]);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical)).toLowerCase();
}

/** The chain-owned encoder used before an opaque backend write. */
export function encodeContextGraphAuthorityHistoryCheckpoint(
  value: ContextGraphAuthorityHistoryState,
): ContextGraphAuthorityHistoryCheckpointV1 {
  const state = normalizeContextGraphAuthorityHistoryState(value);
  if (state === undefined) {
    throw new Error('Cannot persist an invalid Context Graph authority history state');
  }
  return Object.freeze({
    version: CONTEXT_GRAPH_AUTHORITY_HISTORY_CHECKPOINT_VERSION,
    state,
    integrity: contextGraphAuthorityHistoryStateIntegrity(state),
  });
}

/** Reject raw, old-version, malformed, or integrity-mismatched backend data. */
export function decodeContextGraphAuthorityHistoryCheckpoint(
  value: unknown,
): ContextGraphAuthorityHistoryState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Record<keyof ContextGraphAuthorityHistoryCheckpointV1, unknown>>;
  if (candidate.version !== CONTEXT_GRAPH_AUTHORITY_HISTORY_CHECKPOINT_VERSION) return undefined;
  const state = normalizeContextGraphAuthorityHistoryState(candidate.state);
  const integrity = normalizeHash(candidate.integrity);
  if (
    state === undefined
    || integrity === undefined
    || integrity !== contextGraphAuthorityHistoryStateIntegrity(state)
  ) return undefined;
  return state;
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
      events.push(...await input.readEvents(
        { name, contextGraphId: input.contextGraphId },
        lo,
        hi,
      ));
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
  // A cold history may span thousands of pages. Serialize its event streams so
  // a node with no checkpoint cannot saturate every fallback endpoint with six
  // independent walks. Once a verified checkpoint exists, retain parallel
  // one-page suffix reads for the steady-state path.
  const [created, transfers, publishPolicy, publishAuthority, participantAdds,
    participantRemoves] = previous === undefined
    ? [
        await readCreation(),
        await read('Transfer'),
        await read('PublishPolicyUpdated'),
        await read('PublishAuthorityUpdated'),
        await read('AgentParticipantAdded'),
        await read('AgentParticipantRemoved'),
      ]
    : await Promise.all([
        Promise.resolve([] as ContextGraphAuthorityHistoryCreationEvent[]),
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
