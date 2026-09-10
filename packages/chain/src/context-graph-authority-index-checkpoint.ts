// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import type { ContextGraphAuthorityGenerationState } from './context-graph-authority-generation.js';

export const CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION = 1 as const;

/** One compact authority generation for a ContextGraphStorage token. */
export interface ContextGraphAuthorityIndexState
  extends ContextGraphAuthorityGenerationState {
  readonly contextGraphId: string;
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
  readonly cursor: ContextGraphAuthorityIndexCursor;
  readonly states: readonly ContextGraphAuthorityIndexState[];
  /** Detects torn, stale-schema, and accidentally edited durable payloads. */
  readonly integrity: string;
}

/**
 * Durable backing for the contract-wide authority index.
 *
 * The store owns a monotonic, non-repeating CAS token. Invalidating a payload
 * advances that token and leaves a tombstone, so a scanner holding an older
 * token can never overwrite a newly rebuilt checkpoint (the ABA case).
 * Authority-bearing contents remain opaque outside the chain package.
 */
export interface ContextGraphAuthorityIndexStore {
  /** Opaque durable input; the chain-owned decoder is the sole read boundary. */
  load(scope: string): Promise<Readonly<{ token: number; value: unknown | null }> | undefined>;
  /** Persist a checkpoint and return its store-owned token, or lose the CAS. */
  compareAndSwap(
    scope: string,
    expectedToken: number | undefined,
    checkpoint: unknown,
  ): Promise<number | undefined>;
  /** Replace only the rejected token with a newer durable tombstone. */
  invalidate(scope: string, expectedToken: number): Promise<number | undefined>;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

export function normalizeAuthorityIndexHash(value: unknown): string | undefined {
  return typeof value === 'string' && HASH_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function normalizeAuthorityIndexNonNegativeSafeInteger(
  value: unknown,
): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function normalizePositiveDecimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= ethers.MaxUint256 ? value : undefined;
}

function compareContextGraphIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

export function freezeContextGraphAuthorityIndexState(
  state: ContextGraphAuthorityIndexState,
): ContextGraphAuthorityIndexState {
  return Object.freeze({ ...state });
}

export function sortAndFreezeContextGraphAuthorityIndexStates(
  states: Iterable<ContextGraphAuthorityIndexState>,
): readonly ContextGraphAuthorityIndexState[] {
  return Object.freeze(
    [...states]
      .sort((left, right) => compareContextGraphIds(left.contextGraphId, right.contextGraphId))
      .map(freezeContextGraphAuthorityIndexState),
  );
}

type ContextGraphAuthorityIndexIntegrityInput = Pick<
  ContextGraphAuthorityIndexCheckpoint,
  'version' | 'cursor' | 'states'
>;

function generationIntegrityValues(
  state: ContextGraphAuthorityGenerationState,
): readonly unknown[] {
  // The mapped object makes adding a canonical generation field a compile-time
  // failure here until the durable integrity encoding explicitly includes it.
  const fields = {
    nameHash: state.nameHash,
    ownershipEra: state.ownershipEra,
    policyVersion: state.policyVersion,
    rosterVersion: state.rosterVersion,
    sourceBlockNumber: state.sourceBlockNumber,
    sourceBlockHash: state.sourceBlockHash,
  } satisfies { [K in keyof ContextGraphAuthorityGenerationState]: unknown };
  return Object.values(fields);
}

function contextGraphAuthorityIndexIntegrity(
  checkpoint: ContextGraphAuthorityIndexIntegrityInput,
): string {
  const canonical = JSON.stringify([
    'dkg-context-graph-authority-index-checkpoint-v1',
    checkpoint.version,
    checkpoint.cursor.deploymentBlockNumber,
    checkpoint.cursor.throughBlockNumber,
    checkpoint.cursor.throughBlockHash,
    checkpoint.cursor.stateCount,
    ...checkpoint.states.flatMap((state) => [
      state.contextGraphId,
      ...generationIntegrityValues(state),
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
  const nameHash = normalizeAuthorityIndexHash(candidate.nameHash);
  const ownershipEra = normalizeAuthorityIndexNonNegativeSafeInteger(candidate.ownershipEra);
  const policyVersion = normalizeAuthorityIndexNonNegativeSafeInteger(candidate.policyVersion);
  const rosterVersion = normalizeAuthorityIndexNonNegativeSafeInteger(candidate.rosterVersion);
  const sourceBlockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(
    candidate.sourceBlockNumber,
  );
  const sourceBlockHash = normalizeAuthorityIndexHash(candidate.sourceBlockHash);
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
  return freezeContextGraphAuthorityIndexState({
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
    cursor?: unknown;
    states?: unknown;
    integrity?: unknown;
  };
  if (
    candidate.version !== CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION
    || candidate.cursor === null
    || typeof candidate.cursor !== 'object'
    || Array.isArray(candidate.cursor)
    || !Array.isArray(candidate.states)
  ) return undefined;
  const rawCursor = candidate.cursor as Partial<
    Record<keyof ContextGraphAuthorityIndexCursor, unknown>
  >;
  const deploymentBlockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(
    rawCursor.deploymentBlockNumber,
  );
  const throughBlockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(
    rawCursor.throughBlockNumber,
  );
  const throughBlockHash = normalizeAuthorityIndexHash(rawCursor.throughBlockHash);
  const stateCount = normalizeAuthorityIndexNonNegativeSafeInteger(rawCursor.stateCount);
  const integrity = normalizeAuthorityIndexHash(candidate.integrity);
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
    cursor,
    states: sortAndFreezeContextGraphAuthorityIndexStates(states),
    integrity,
  });
  return integrity === contextGraphAuthorityIndexIntegrity(checkpoint)
    ? checkpoint
    : undefined;
}

export function createContextGraphAuthorityIndexCheckpoint(
  cursor: ContextGraphAuthorityIndexCursor,
  states: Iterable<ContextGraphAuthorityIndexState>,
): ContextGraphAuthorityIndexCheckpoint {
  const frozenStates = sortAndFreezeContextGraphAuthorityIndexStates(states);
  const checkpointWithoutIntegrity = {
    version: CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION,
    cursor: Object.freeze({ ...cursor, stateCount: frozenStates.length }),
    states: frozenStates,
  } as const;
  return Object.freeze({
    ...checkpointWithoutIntegrity,
    integrity: contextGraphAuthorityIndexIntegrity(checkpointWithoutIntegrity),
  });
}
