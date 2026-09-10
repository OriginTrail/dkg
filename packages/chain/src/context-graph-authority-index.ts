// SPDX-License-Identifier: Apache-2.0

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
  readonly cursor: ContextGraphAuthorityIndexCursor;
  readonly states: readonly ContextGraphAuthorityIndexState[];
}

/**
 * Durable backing for the contract-wide authority index.
 *
 * `commitPage` must atomically write every changed state and advance `next`.
 * It returns false when the stored cursor no longer equals `expected`, allowing
 * a stale provider completion to reload instead of regressing newer progress.
 */
export interface ContextGraphAuthorityIndexStore {
  load(scope: string): Promise<ContextGraphAuthorityIndexCheckpoint | undefined>;
  commitPage(
    scope: string,
    expected: ContextGraphAuthorityIndexCursor | undefined,
    next: ContextGraphAuthorityIndexCursor,
    changedStates: readonly ContextGraphAuthorityIndexState[],
  ): Promise<boolean>;
  delete(scope: string): Promise<void>;
}

declare const TRUSTED_AUTHORITY_INDEX_STORE: unique symbol;

/**
 * Contract-wide generations are authority-bearing historical aggregates.
 * Only process-owned storage inside the node's local integrity boundary may be
 * admitted here; a remote/shared implementation must not be trusted merely
 * because it satisfies the structural store interface.
 */
export interface TrustedContextGraphAuthorityIndexStore
  extends ContextGraphAuthorityIndexStore {
  readonly [TRUSTED_AUTHORITY_INDEX_STORE]: true;
}

const trustedAuthorityIndexStores = new WeakSet<object>();

/** Explicitly admit a process-owned backend into the authority trust boundary. */
export function trustContextGraphAuthorityIndexStore<T extends ContextGraphAuthorityIndexStore>(
  store: T,
): T & TrustedContextGraphAuthorityIndexStore {
  trustedAuthorityIndexStores.add(store);
  return store as T & TrustedContextGraphAuthorityIndexStore;
}

/** Runtime guard for composition points that retain the trusted store. */
export function isTrustedContextGraphAuthorityIndexStore(
  store: ContextGraphAuthorityIndexStore,
): store is TrustedContextGraphAuthorityIndexStore {
  return trustedAuthorityIndexStores.has(store);
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

/** The six log signatures consumed by the future contract-wide scanner. */
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
  /** Full replacement rows for only the graphs changed by this page. */
  readonly changedStates: readonly ContextGraphAuthorityIndexState[];
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
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
    ? value
    : undefined;
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

function increment(value: number, label: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`Context Graph authority index ${label} exceeds the safe integer range`);
  }
  return next;
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
  const candidate = value as { cursor?: unknown; states?: unknown };
  if (
    candidate.cursor === null
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
  if (
    deploymentBlockNumber === undefined
    || throughBlockNumber === undefined
    || throughBlockHash === undefined
    || stateCount === undefined
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
  return Object.freeze({ cursor, states: sortAndFreezeStates(states) });
}

function normalizePageEvent(
  event: ContextGraphAuthorityIndexEvent,
  fromBlockNumber: number,
  throughBlockNumber: number,
  throughBlockHash: string,
): ContextGraphAuthorityIndexEvent {
  if (typeof event.contextGraphId !== 'bigint' || event.contextGraphId <= 0n) {
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
 * The caller persists `changedStates` and `checkpoint.cursor` in one store
 * transaction. Adaptive range splitting can therefore commit a successful left
 * leaf before the right leaf is attempted, making provider failures resumable.
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
  const changedIds = new Set<string>();
  for (const event of normalizedEvents) {
    const contextGraphId = event.contextGraphId.toString(10);
    const prior = states.get(contextGraphId);
    if (event.name === 'ContextGraphCreated') {
      if (prior !== undefined) {
        throw new Error(`Context Graph ${contextGraphId} has more than one creation event`);
      }
      states.set(contextGraphId, freezeState({
        contextGraphId,
        nameHash: event.nameHash,
        ownershipEra: 0,
        policyVersion: 0,
        rosterVersion: 0,
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash,
      }));
      changedIds.add(contextGraphId);
      continue;
    }
    if (
      event.name === 'Transfer'
      && (event.from === ZERO_ADDRESS || event.to === ZERO_ADDRESS || event.from === event.to)
    ) {
      // ERC-721 mint/burn/self-transfer does not create an ownership generation.
      continue;
    }
    if (prior === undefined) {
      throw new Error(`Context Graph ${contextGraphId} authority event precedes creation`);
    }
    let next: ContextGraphAuthorityIndexState;
    switch (event.name) {
      case 'Transfer':
        next = {
          ...prior,
          ownershipEra: increment(prior.ownershipEra, 'ownership era'),
          policyVersion: increment(prior.policyVersion, 'policy version'),
          rosterVersion: increment(prior.rosterVersion, 'roster version'),
          sourceBlockNumber: event.blockNumber,
          sourceBlockHash: event.blockHash,
        };
        break;
      case 'PublishPolicyUpdated':
      case 'PublishAuthorityUpdated':
        next = {
          ...prior,
          policyVersion: increment(prior.policyVersion, 'policy version'),
          sourceBlockNumber: event.blockNumber,
          sourceBlockHash: event.blockHash,
        };
        break;
      case 'AgentParticipantAdded':
      case 'AgentParticipantRemoved':
        next = {
          ...prior,
          rosterVersion: increment(prior.rosterVersion, 'roster version'),
        };
        break;
    }
    states.set(contextGraphId, freezeState(next));
    changedIds.add(contextGraphId);
  }

  const allStates = sortAndFreezeStates(states.values());
  const cursor = Object.freeze({
    deploymentBlockNumber,
    throughBlockNumber,
    throughBlockHash,
    stateCount: allStates.length,
  });
  const checkpoint = Object.freeze({ cursor, states: allStates });
  const changedStates = sortAndFreezeStates(
    [...changedIds].map((contextGraphId) => states.get(contextGraphId)!),
  );
  return Object.freeze({ checkpoint, changedStates });
}
