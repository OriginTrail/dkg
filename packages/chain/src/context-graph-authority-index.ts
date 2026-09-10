// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { applyContextGraphAuthorityGenerationEvent } from './context-graph-authority-generation.js';

export const CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION = 1 as const;

/**
 * One compact authority generation for a ContextGraphStorage token.
 *
 * `sourceBlock*` identifies the latest creation/ownership/publish-policy event;
 * roster-only changes deliberately do not move that policy source.
 */
export interface ContextGraphAuthorityIndexState {
  readonly contextGraphId: string;
  readonly nameHash: string;
  readonly ownershipEra: number;
  readonly policyVersion: number;
  readonly rosterVersion: number;
  readonly sourceBlockNumber: number;
  readonly sourceBlockHash: string;
}

/** A contiguous, fully reduced contract-history prefix. */
export interface ContextGraphAuthorityIndexCursor {
  readonly deploymentBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly stateCount: number;
}

export interface ContextGraphAuthorityIndexCheckpoint {
  readonly version: typeof CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION;
  /** Monotonic compare-and-swap generation owned by the chain scanner. */
  readonly revision: number;
  readonly cursor: ContextGraphAuthorityIndexCursor;
  readonly states: readonly ContextGraphAuthorityIndexState[];
  /** Detects torn, stale-schema, and accidentally edited durable payloads. */
  readonly integrity: string;
}

/**
 * Durable backing for the contract-wide authority index.
 *
 * `compareAndSwap` atomically replaces one opaque checkpoint only when its
 * revision still equals `expectedRevision`. The persistence package never
 * decodes authority-bearing contents; chain owns the sole codec boundary.
 */
export interface ContextGraphAuthorityIndexStore {
  /** Opaque durable input; the chain-owned decoder is the sole read boundary. */
  load(scope: string): Promise<Readonly<{ revision: number; value: unknown }> | undefined>;
  compareAndSwap(
    scope: string,
    expectedRevision: number | undefined,
    nextRevision: number,
    checkpoint: unknown,
  ): Promise<boolean>;
  /** Delete only the revision the scanner actually rejected. */
  delete(scope: string, expectedRevision: number): Promise<boolean>;
}

interface ContextGraphAuthorityIndexEventBase {
  readonly contextGraphId: bigint;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
}

export interface ContextGraphAuthorityIndexCreationEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'ContextGraphCreated';
  readonly nameHash: string;
}

export interface ContextGraphAuthorityIndexTransferEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'Transfer';
  readonly from: string;
  readonly to: string;
}

export interface ContextGraphAuthorityIndexPolicyEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'PublishPolicyUpdated' | 'PublishAuthorityUpdated';
}

export interface ContextGraphAuthorityIndexRosterEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'AgentParticipantAdded' | 'AgentParticipantRemoved';
}

/** The six log signatures consumed by the contract-wide scanner. */
export type ContextGraphAuthorityIndexEvent =
  | ContextGraphAuthorityIndexCreationEvent
  | ContextGraphAuthorityIndexTransferEvent
  | ContextGraphAuthorityIndexPolicyEvent
  | ContextGraphAuthorityIndexRosterEvent;

export interface ReduceContextGraphAuthorityIndexPageInput {
  /** Inclusive first block of the physical contract deployment. */
  readonly deploymentBlockNumber: number;
  /** Inclusive end of this successfully read contiguous range. */
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly previous?: ContextGraphAuthorityIndexCheckpoint;
  readonly events: readonly ContextGraphAuthorityIndexEvent[];
}

export interface ContextGraphAuthorityIndexPageReduction {
  readonly checkpoint: ContextGraphAuthorityIndexCheckpoint;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function normalizeHash(value: unknown): string | undefined {
  return typeof value === 'string' && HASH_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normalizeAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normalizeNonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function normalizePositiveDecimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= ethers.MaxUint256 ? value : undefined;
}

function incrementRevision(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error('Context Graph authority index revision exceeds the safe integer range');
  }
  return next;
}

function retryableAuthorityIndexReadError(message: string): Error {
  return Object.assign(new Error(message), { code: 'NETWORK_ERROR' });
}

function compareContextGraphIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function freezeState(state: ContextGraphAuthorityIndexState): ContextGraphAuthorityIndexState {
  return Object.freeze({ ...state });
}

function sortAndFreezeStates(
  states: Iterable<ContextGraphAuthorityIndexState>,
): readonly ContextGraphAuthorityIndexState[] {
  return Object.freeze(
    [...states]
      .sort((left, right) => compareContextGraphIds(left.contextGraphId, right.contextGraphId))
      .map(freezeState),
  );
}

type ContextGraphAuthorityIndexIntegrityInput = Pick<
  ContextGraphAuthorityIndexCheckpoint,
  'version' | 'revision' | 'cursor' | 'states'
>;

function contextGraphAuthorityIndexIntegrity(
  checkpoint: ContextGraphAuthorityIndexIntegrityInput,
): string {
  const canonical = JSON.stringify([
    'dkg-context-graph-authority-index-checkpoint-v1',
    checkpoint.version,
    checkpoint.revision,
    checkpoint.cursor.deploymentBlockNumber,
    checkpoint.cursor.throughBlockNumber,
    checkpoint.cursor.throughBlockHash,
    checkpoint.cursor.stateCount,
    ...checkpoint.states.flatMap((state) => [
      state.contextGraphId,
      state.nameHash,
      state.ownershipEra,
      state.policyVersion,
      state.rosterVersion,
      state.sourceBlockNumber,
      state.sourceBlockHash,
    ]),
  ]);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical)).toLowerCase();
}

function normalizeIndexState(
  value: unknown,
  cursor: ContextGraphAuthorityIndexCursor,
): ContextGraphAuthorityIndexState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Record<keyof ContextGraphAuthorityIndexState, unknown>>;
  const contextGraphId = normalizePositiveDecimal(candidate.contextGraphId);
  const nameHash = normalizeHash(candidate.nameHash);
  const ownershipEra = normalizeNonNegativeSafeInteger(candidate.ownershipEra);
  const policyVersion = normalizeNonNegativeSafeInteger(candidate.policyVersion);
  const rosterVersion = normalizeNonNegativeSafeInteger(candidate.rosterVersion);
  const sourceBlockNumber = normalizeNonNegativeSafeInteger(candidate.sourceBlockNumber);
  const sourceBlockHash = normalizeHash(candidate.sourceBlockHash);
  if (
    contextGraphId === undefined
    || nameHash === undefined
    || ownershipEra === undefined
    || policyVersion === undefined
    || rosterVersion === undefined
    || sourceBlockNumber === undefined
    || sourceBlockHash === undefined
    || sourceBlockNumber < cursor.deploymentBlockNumber
    || sourceBlockNumber > cursor.throughBlockNumber
    || policyVersion < ownershipEra
    || rosterVersion < ownershipEra
  ) return undefined;
  return freezeState({
    contextGraphId,
    nameHash,
    ownershipEra,
    policyVersion,
    rosterVersion,
    sourceBlockNumber,
    sourceBlockHash,
  });
}

/** Reject malformed/corrupt durable input before it can affect scan bounds. */
export function normalizeContextGraphAuthorityIndexCheckpoint(
  value: unknown,
): ContextGraphAuthorityIndexCheckpoint | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as {
    version?: unknown;
    revision?: unknown;
    cursor?: unknown;
    states?: unknown;
    integrity?: unknown;
  };
  if (
    candidate.version !== CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION
    || normalizeNonNegativeSafeInteger(candidate.revision) === undefined
    || candidate.revision === 0
    || candidate.cursor === null
    || typeof candidate.cursor !== 'object'
    || Array.isArray(candidate.cursor)
    || !Array.isArray(candidate.states)
  ) return undefined;
  const rawCursor = candidate.cursor as Partial<
    Record<keyof ContextGraphAuthorityIndexCursor, unknown>
  >;
  const deploymentBlockNumber = normalizeNonNegativeSafeInteger(
    rawCursor.deploymentBlockNumber,
  );
  const throughBlockNumber = normalizeNonNegativeSafeInteger(rawCursor.throughBlockNumber);
  const throughBlockHash = normalizeHash(rawCursor.throughBlockHash);
  const stateCount = normalizeNonNegativeSafeInteger(rawCursor.stateCount);
  const integrity = normalizeHash(candidate.integrity);
  if (
    deploymentBlockNumber === undefined
    || throughBlockNumber === undefined
    || throughBlockHash === undefined
    || stateCount === undefined
    || integrity === undefined
    || throughBlockNumber < deploymentBlockNumber
    || candidate.states.length !== stateCount
  ) return undefined;
  const cursor = Object.freeze({
    deploymentBlockNumber,
    throughBlockNumber,
    throughBlockHash,
    stateCount,
  });
  const states: ContextGraphAuthorityIndexState[] = [];
  const ids = new Set<string>();
  for (const rawState of candidate.states) {
    const state = normalizeIndexState(rawState, cursor);
    if (state === undefined || ids.has(state.contextGraphId)) return undefined;
    ids.add(state.contextGraphId);
    states.push(state);
  }
  const checkpoint = Object.freeze({
    version: CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION,
    revision: Number(candidate.revision),
    cursor,
    states: sortAndFreezeStates(states),
    integrity,
  });
  return integrity === contextGraphAuthorityIndexIntegrity(checkpoint)
    ? checkpoint
    : undefined;
}

function normalizePageEvent(
  event: ContextGraphAuthorityIndexEvent,
  fromBlockNumber: number,
  throughBlockNumber: number,
  throughBlockHash: string,
): ContextGraphAuthorityIndexEvent {
  if (
    typeof event.contextGraphId !== 'bigint'
    || event.contextGraphId <= 0n
    || event.contextGraphId > ethers.MaxUint256
  ) {
    throw new Error('Context Graph authority index event has an invalid context graph id');
  }
  const blockNumber = normalizeNonNegativeSafeInteger(event.blockNumber);
  const blockHash = normalizeHash(event.blockHash);
  const index = normalizeNonNegativeSafeInteger(event.index);
  if (
    blockNumber === undefined
    || blockNumber < fromBlockNumber
    || blockNumber > throughBlockNumber
    || blockHash === undefined
    || index === undefined
  ) {
    throw new Error('Context Graph authority index event falls outside its page or is malformed');
  }
  if (blockNumber === throughBlockNumber && blockHash !== throughBlockHash) {
    throw new Error('Context Graph authority index event disagrees with the page anchor');
  }
  const base = {
    contextGraphId: event.contextGraphId,
    blockNumber,
    blockHash,
    index,
  };
  switch (event.name) {
    case 'ContextGraphCreated': {
      const nameHash = normalizeHash(event.nameHash);
      if (nameHash === undefined) {
        throw new Error('Context Graph authority index creation event has an invalid name hash');
      }
      return Object.freeze({ ...base, name: event.name, nameHash });
    }
    case 'Transfer': {
      const from = normalizeAddress(event.from);
      const to = normalizeAddress(event.to);
      if (from === undefined || to === undefined) {
        throw new Error('Context Graph authority index transfer event has an invalid address');
      }
      return Object.freeze({ ...base, name: event.name, from, to });
    }
    case 'PublishPolicyUpdated':
    case 'PublishAuthorityUpdated':
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved':
      return Object.freeze({ ...base, name: event.name });
    default:
      throw new Error('Context Graph authority index event has an unsupported name');
  }
}

/**
 * Reduce one contiguous, successfully fetched block range.
 *
 * The scanner persists the returned checkpoint before reading the next page,
 * making provider failures resumable from the last complete range.
 */
export function reduceContextGraphAuthorityIndexPage(
  input: ReduceContextGraphAuthorityIndexPageInput,
): ContextGraphAuthorityIndexPageReduction {
  const deploymentBlockNumber = normalizeNonNegativeSafeInteger(input.deploymentBlockNumber);
  const throughBlockNumber = normalizeNonNegativeSafeInteger(input.throughBlockNumber);
  const throughBlockHash = normalizeHash(input.throughBlockHash);
  if (
    deploymentBlockNumber === undefined
    || throughBlockNumber === undefined
    || throughBlockHash === undefined
  ) {
    throw new Error('Context Graph authority index page has an invalid block boundary');
  }
  const previous = input.previous === undefined
    ? undefined
    : normalizeContextGraphAuthorityIndexCheckpoint(input.previous);
  if (input.previous !== undefined && previous === undefined) {
    throw new Error('Context Graph authority index previous checkpoint is malformed');
  }
  if (
    previous !== undefined
    && previous.cursor.deploymentBlockNumber !== deploymentBlockNumber
  ) {
    throw new Error('Context Graph authority index deployment block changed');
  }
  const fromBlockNumber = previous === undefined
    ? deploymentBlockNumber
    : previous.cursor.throughBlockNumber + 1;
  if (!Number.isSafeInteger(fromBlockNumber) || throughBlockNumber < fromBlockNumber) {
    throw new Error('Context Graph authority index page is empty, overlapping, or non-contiguous');
  }

  const normalizedEvents = input.events
    .map((event) => normalizePageEvent(
      event,
      fromBlockNumber,
      throughBlockNumber,
      throughBlockHash,
    ))
    .sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);
  for (let index = 1; index < normalizedEvents.length; index += 1) {
    const left = normalizedEvents[index - 1]!;
    const right = normalizedEvents[index]!;
    if (left.blockNumber === right.blockNumber && left.index === right.index) {
      throw new Error('Context Graph authority index page contains a duplicate log position');
    }
  }

  const states = new Map<string, ContextGraphAuthorityIndexState>(
    previous?.states.map((state) => [state.contextGraphId, state]) ?? [],
  );
  for (const event of normalizedEvents) {
    const contextGraphId = event.contextGraphId.toString(10);
    const prior = states.get(contextGraphId);
    if (
      event.name === 'Transfer'
      && (event.from === ZERO_ADDRESS || event.to === ZERO_ADDRESS || event.from === event.to)
    ) {
      // ERC-721 mint/burn/self-transfer does not create an ownership generation.
      continue;
    }
    const next = applyContextGraphAuthorityGenerationEvent(
      prior,
      event,
      `Context Graph ${contextGraphId}`,
    );
    states.set(contextGraphId, freezeState({ contextGraphId, ...next }));
  }

  const allStates = sortAndFreezeStates(states.values());
  const cursor = Object.freeze({
    deploymentBlockNumber,
    throughBlockNumber,
    throughBlockHash,
    stateCount: allStates.length,
  });
  const checkpointWithoutIntegrity = {
    version: CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION,
    revision: previous === undefined ? 1 : incrementRevision(previous.revision),
    cursor,
    states: allStates,
  } as const;
  const checkpoint = Object.freeze({
    ...checkpointWithoutIntegrity,
    integrity: contextGraphAuthorityIndexIntegrity(checkpointWithoutIntegrity),
  });
  return Object.freeze({ checkpoint });
}

export interface ContextGraphAuthorityIndexScanInput {
  /** Deployment + physical ContextGraphStorage address; contains no secret. */
  readonly scope: string;
  readonly contextGraphId: bigint;
  /** Physical RPC reader identity; isolates a timed-out provider attempt. */
  readonly readScope: object;
  readonly deploymentBlockNumber: number;
  readonly finalized: Readonly<{ number: number; hash: string }>;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
  readonly readBlockHash: (
    blockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<string | null>;
  /** Read all six indexed authority event signatures for one inclusive range. */
  readonly readPage: (
    fromBlockNumber: number,
    throughBlockNumber: number,
    lifecycleSignal: AbortSignal,
  ) => Promise<readonly ContextGraphAuthorityIndexEvent[]>;
}

/**
 * Process-local owner for the durable contract-wide authority index.
 *
 * Every successfully reduced page is persisted before the next page starts.
 * A later call (including one on a fallback endpoint) therefore resumes at the
 * next block instead of repeating the already-covered contract prefix.
 */
export class ContextGraphAuthorityIndex {
  readonly #entries = new Map<string, ContextGraphAuthorityIndexCheckpoint>();
  readonly #inflight = new Map<
    string,
    Map<object, Promise<ContextGraphAuthorityIndexCheckpoint>>
  >();
  #epoch = 0;
  #lifecycleAbort = new AbortController();

  constructor(readonly localStore?: ContextGraphAuthorityIndexStore) {}

  clear(): void {
    this.#lifecycleAbort.abort(new DOMException(
      'Context Graph authority index lifecycle cleared',
      'AbortError',
    ));
    this.#lifecycleAbort = new AbortController();
    this.#epoch += 1;
    this.#entries.clear();
    this.#inflight.clear();
  }

  async resolve(
    input: ContextGraphAuthorityIndexScanInput,
  ): Promise<ContextGraphAuthorityIndexState> {
    const scope = input.scope.trim();
    if (scope.length === 0) throw new Error('Context Graph authority index scope is empty');
    if (
      typeof input.contextGraphId !== 'bigint'
      || input.contextGraphId <= 0n
      || input.contextGraphId > ethers.MaxUint256
    ) {
      throw new Error('Context Graph authority index target id is invalid');
    }
    if (input.readScope === null || typeof input.readScope !== 'object') {
      throw new Error('Context Graph authority index read scope is invalid');
    }
    const finalizedHash = normalizeHash(input.finalized.hash);
    if (finalizedHash === undefined) {
      throw new Error('Context Graph authority index finalized hash is invalid');
    }
    const scanKey = [scope, input.finalized.number, finalizedHash].join('\u0000');
    let byReader = this.#inflight.get(scanKey);
    if (byReader === undefined) {
      byReader = new Map();
      this.#inflight.set(scanKey, byReader);
    }
    let pending = byReader.get(input.readScope);
    if (pending === undefined) {
      const epoch = this.#epoch;
      const lifecycleSignal = this.#lifecycleAbort.signal;
      pending = this.#scan({ ...input, scope, finalized: {
        number: input.finalized.number,
        hash: finalizedHash,
      } }, epoch, lifecycleSignal);
      byReader.set(input.readScope, pending);
      void pending.finally(() => {
        if (byReader!.get(input.readScope) === pending) byReader!.delete(input.readScope);
        if (byReader!.size === 0 && this.#inflight.get(scanKey) === byReader) {
          this.#inflight.delete(scanKey);
        }
      }).catch(() => {});
    }
    const checkpoint = await waitForSharedAuthorityIndexScan(pending, input.signal);
    // Target lookup intentionally happens after the shared contract scan, so
    // every waiter resolves its own graph from the same complete checkpoint.
    return this.#requireState(checkpoint, input.contextGraphId);
  }

  async #scan(
    input: ContextGraphAuthorityIndexScanInput,
    epoch: number,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint> {
    const scope = input.scope;
    const deploymentBlockNumber = normalizeNonNegativeSafeInteger(input.deploymentBlockNumber);
    const finalizedNumber = normalizeNonNegativeSafeInteger(input.finalized.number);
    const finalizedHash = normalizeHash(input.finalized.hash);
    const pageSize = normalizeNonNegativeSafeInteger(input.pageSize);
    if (
      deploymentBlockNumber === undefined
      || finalizedNumber === undefined
      || finalizedHash === undefined
      || pageSize === undefined
      || pageSize < 1
      || deploymentBlockNumber > finalizedNumber
    ) {
      throw new Error('Context Graph authority index scan bounds are invalid');
    }

    let checkpoint = await this.#load(scope);
    if (checkpoint !== undefined) {
      checkpoint = await this.#admitCheckpoint(
        scope,
        checkpoint,
        deploymentBlockNumber,
        { number: finalizedNumber, hash: finalizedHash },
        input.readBlockHash,
        lifecycleSignal,
      );
    }

    for (;;) {
      lifecycleSignal.throwIfAborted();
      if (checkpoint !== undefined && checkpoint.cursor.throughBlockNumber === finalizedNumber) {
        return checkpoint;
      }

      const fromBlockNumber = checkpoint === undefined
        ? deploymentBlockNumber
        : checkpoint.cursor.throughBlockNumber + 1;
      const throughBlockNumber = Math.min(
        fromBlockNumber + pageSize - 1,
        finalizedNumber,
      );
      const throughBlockHash = throughBlockNumber === finalizedNumber
        ? finalizedHash
        : normalizeHash(await input.readBlockHash(throughBlockNumber, lifecycleSignal));
      if (throughBlockHash === undefined) {
        throw new Error(
          `Context Graph authority index block ${throughBlockNumber} is unavailable`,
        );
      }

      const events = await input.readPage(
        fromBlockNumber,
        throughBlockNumber,
        lifecycleSignal,
      );
      lifecycleSignal.throwIfAborted();
      const reduction = reduceContextGraphAuthorityIndexPage({
        deploymentBlockNumber,
        throughBlockNumber,
        throughBlockHash,
        previous: checkpoint,
        events,
      });
      const next = reduction.checkpoint;

      if (this.localStore !== undefined) {
        const committed = await this.localStore.compareAndSwap(
          scope,
          checkpoint?.revision,
          next.revision,
          next,
        );
        if (!committed) {
          // Another valid provider completion won the page. Reload its result
          // and continue from that cursor rather than overwriting or rescanning.
          const winner = await this.#load(scope, true);
          if (winner === undefined) {
            throw new Error('Context Graph authority index CAS winner is malformed');
          }
          checkpoint = await this.#admitCheckpoint(
            scope,
            winner,
            deploymentBlockNumber,
            { number: finalizedNumber, hash: finalizedHash },
            input.readBlockHash,
            lifecycleSignal,
          );
          continue;
        }
      }

      const current = this.#entries.get(scope);
      if (this.#epoch === epoch && (
        current === undefined
        || current.cursor.throughBlockNumber <= next.cursor.throughBlockNumber
      )) {
        this.#entries.set(scope, next);
      }
      checkpoint = this.#epoch === epoch ? (this.#entries.get(scope) ?? next) : next;
    }
  }

  async #load(
    scope: string,
    forceDurable = false,
  ): Promise<ContextGraphAuthorityIndexCheckpoint | undefined> {
    const memory = forceDurable ? undefined : this.#entries.get(scope);
    if (memory !== undefined) return memory;
    if (this.localStore === undefined) return undefined;
    const record = await this.localStore.load(scope);
    if (record === undefined) return undefined;
    const checkpoint = normalizeContextGraphAuthorityIndexCheckpoint(record.value);
    if (checkpoint === undefined || checkpoint.revision !== record.revision) {
      const deleted = await this.localStore.delete(scope, record.revision);
      if (!deleted) return this.#load(scope, true);
      this.#entries.delete(scope);
      return undefined;
    }
    this.#entries.set(scope, checkpoint);
    return checkpoint;
  }

  async #admitCheckpoint(
    scope: string,
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
    deploymentBlockNumber: number,
    finalized: Readonly<{ number: number; hash: string }>,
    readBlockHash: (
      blockNumber: number,
      lifecycleSignal: AbortSignal,
    ) => Promise<string | null>,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint | undefined> {
    if (
      checkpoint.cursor.deploymentBlockNumber !== deploymentBlockNumber
    ) {
      return this.#discardOrReload(
        scope,
        checkpoint,
        deploymentBlockNumber,
        finalized,
        readBlockHash,
        lifecycleSignal,
      );
    }
    if (checkpoint.cursor.throughBlockNumber > finalized.number) {
      // A lagging provider/caller is not evidence that the durable prefix is
      // invalid. Preserve the newer winner and let endpoint failover obtain a
      // head that can serve it.
      throw retryableAuthorityIndexReadError(
        `Context Graph authority index finalized head ${finalized.number} is behind `
        + `durable cursor ${checkpoint.cursor.throughBlockNumber}`,
      );
    }
    const anchorHash = checkpoint.cursor.throughBlockNumber === finalized.number
      ? finalized.hash
      : normalizeHash(await readBlockHash(
          checkpoint.cursor.throughBlockNumber,
          lifecycleSignal,
        ));
    if (anchorHash === undefined) {
      // A non-archive endpoint must not destroy a valid durable prefix. Let the
      // adapter fail over to an endpoint that can revalidate it.
      throw retryableAuthorityIndexReadError(
        `Context Graph authority index anchor ${checkpoint.cursor.throughBlockNumber} is unavailable`,
      );
    }
    if (anchorHash !== checkpoint.cursor.throughBlockHash) {
      return this.#discardOrReload(
        scope,
        checkpoint,
        deploymentBlockNumber,
        finalized,
        readBlockHash,
        lifecycleSignal,
      );
    }
    return checkpoint;
  }

  async #discardOrReload(
    scope: string,
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
    deploymentBlockNumber: number,
    finalized: Readonly<{ number: number; hash: string }>,
    readBlockHash: (
      blockNumber: number,
      lifecycleSignal: AbortSignal,
    ) => Promise<string | null>,
    lifecycleSignal: AbortSignal,
  ): Promise<ContextGraphAuthorityIndexCheckpoint | undefined> {
    if (this.#entries.get(scope) === checkpoint) this.#entries.delete(scope);
    if (this.localStore === undefined) return undefined;
    const deleted = await this.localStore.delete(scope, checkpoint.revision);
    if (deleted) return undefined;
    const winner = await this.#load(scope, true);
    return winner === undefined
      ? undefined
      : this.#admitCheckpoint(
          scope,
          winner,
          deploymentBlockNumber,
          finalized,
          readBlockHash,
          lifecycleSignal,
        );
  }

  #requireState(
    checkpoint: ContextGraphAuthorityIndexCheckpoint,
    contextGraphId: bigint,
  ): ContextGraphAuthorityIndexState {
    const id = contextGraphId.toString(10);
    const state = checkpoint.states.find((candidate) => candidate.contextGraphId === id);
    if (state === undefined) {
      throw new Error(`Context Graph ${id} has no finalized creation event`);
    }
    return state;
  }
}

function waitForSharedAuthorityIndexScan<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
