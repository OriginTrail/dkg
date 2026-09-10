// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  encodeContextGraphAuthorityGenerationV1,
  normalizeContextGraphAuthorityGenerationState,
  normalizeContextGraphAuthorityHash,
  normalizeContextGraphAuthorityNonNegativeSafeInteger,
  type ContextGraphAuthorityGenerationState,
} from './context-graph-authority-generation.js';
import {
  freezeContextGraphAuthorityIndexState,
  MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS,
  normalizeContextGraphAuthorityAccessPolicy,
  normalizeContextGraphAuthorityPublishDomain,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-state.js';

export type { ContextGraphAuthorityIndexState } from './context-graph-authority-state.js';

export const CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION = 2 as const;

/** A contiguous, fully reduced contract-history prefix. */
export interface ContextGraphAuthorityIndexCursor {
  readonly deploymentBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
}

declare const validatedContextGraphAuthorityIndexCheckpoint: unique symbol;

/** Constructed only by the chain-owned creator or opaque durable decoder. */
export interface ContextGraphAuthorityIndexCheckpoint {
  readonly version: typeof CONTEXT_GRAPH_AUTHORITY_INDEX_CHECKPOINT_VERSION;
  readonly cursor: ContextGraphAuthorityIndexCursor;
  readonly states: readonly ContextGraphAuthorityIndexState[];
  /** Detects torn, stale-schema, and accidentally edited durable payloads. */
  readonly integrity: string;
  readonly [validatedContextGraphAuthorityIndexCheckpoint]: true;
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

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function normalizePositiveDecimal(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= ethers.MaxUint256 ? value : undefined;
}

export function normalizeAuthorityIndexAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function normalizeAuthorityIndexParticipantAgents(
  value: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
    return undefined;
  }
  const agents = value.map(normalizeAuthorityIndexAddress);
  if (agents.some((agent) => agent === undefined || agent === ZERO_ADDRESS)) return undefined;
  const unique = new Set(agents as string[]);
  return unique.size === agents.length
    ? Object.freeze([...unique].sort())
    : undefined;
}

function compareContextGraphIds(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
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

function stateIntegrityValues(
  state: ContextGraphAuthorityIndexState,
): readonly unknown[] {
  type MaterializedField = Exclude<
    keyof ContextGraphAuthorityIndexState,
    keyof ContextGraphAuthorityGenerationState
  >;
  // Both the materialized and shared-generation portions are fixed durable
  // tuples. The named field map retains compile-time completeness without
  // making its property enumeration order part of the persisted format.
  const fields = {
    contextGraphId: state.contextGraphId,
    owner: state.owner,
    active: state.active,
    accessPolicy: state.accessPolicy,
    publishPolicy: state.publishPolicy,
    publishAuthority: state.publishAuthority,
    publishAuthorityAccountId: state.publishAuthorityAccountId,
    participantAgents: state.participantAgents,
  } satisfies { [K in MaterializedField]: unknown };
  return Object.freeze([
    fields.contextGraphId,
    fields.owner,
    fields.active,
    fields.accessPolicy,
    fields.publishPolicy,
    fields.publishAuthority,
    fields.publishAuthorityAccountId,
    fields.participantAgents,
    ...encodeContextGraphAuthorityGenerationV1(state),
  ]);
}

/**
 * Opaque, deterministic revision for one materialized authority state.
 *
 * Consumers can compare this value without learning which authority field
 * changed. The domain tag keeps it independent from the checkpoint integrity
 * encoding even though both deliberately cover the complete state.
 */
export function contextGraphAuthorityIndexStateRevision(
  state: ContextGraphAuthorityIndexState,
): string {
  const canonical = JSON.stringify([
    'dkg-context-graph-authority-index-state-revision-v1',
    ...stateIntegrityValues(state),
  ]);
  return ethers.keccak256(ethers.toUtf8Bytes(canonical)).toLowerCase();
}

function contextGraphAuthorityIndexIntegrity(
  checkpoint: ContextGraphAuthorityIndexIntegrityInput,
): string {
  const canonical = JSON.stringify([
    'dkg-context-graph-authority-index-checkpoint-v2',
    checkpoint.version,
    checkpoint.cursor.deploymentBlockNumber,
    checkpoint.cursor.throughBlockNumber,
    checkpoint.cursor.throughBlockHash,
    checkpoint.states.length,
    ...checkpoint.states.flatMap(stateIntegrityValues),
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
  const owner = normalizeAuthorityIndexAddress(candidate.owner);
  const active = typeof candidate.active === 'boolean' ? candidate.active : undefined;
  const accessPolicy = normalizeContextGraphAuthorityAccessPolicy(candidate.accessPolicy);
  const publishDomain = normalizeContextGraphAuthorityPublishDomain(
    candidate.publishPolicy,
    candidate.publishAuthority,
    candidate.publishAuthorityAccountId,
  );
  const participantAgents = normalizeAuthorityIndexParticipantAgents(
    candidate.participantAgents,
  );
  const generation = normalizeContextGraphAuthorityGenerationState(candidate);
  if (
    contextGraphId === undefined
    || owner === undefined
    || owner === ZERO_ADDRESS
    || active === undefined
    || accessPolicy === undefined
    || publishDomain === undefined
    || participantAgents === undefined
    || generation === undefined
    || generation.sourceBlockNumber < cursor.deploymentBlockNumber
    || generation.sourceBlockNumber > cursor.throughBlockNumber
    || generation.policyVersion < generation.ownershipEra
    || generation.rosterVersion < generation.ownershipEra
  ) return undefined;
  return freezeContextGraphAuthorityIndexState({
    contextGraphId,
    owner,
    active,
    accessPolicy,
    ...publishDomain,
    participantAgents,
    ...generation,
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
  const deploymentBlockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(
    rawCursor.deploymentBlockNumber,
  );
  const throughBlockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(
    rawCursor.throughBlockNumber,
  );
  const throughBlockHash = normalizeContextGraphAuthorityHash(rawCursor.throughBlockHash);
  const integrity = normalizeContextGraphAuthorityHash(candidate.integrity);
  if (
    deploymentBlockNumber === undefined
    || throughBlockNumber === undefined
    || throughBlockHash === undefined
    || integrity === undefined
    || throughBlockNumber < deploymentBlockNumber
  ) return undefined;
  const cursor = Object.freeze({
    deploymentBlockNumber,
    throughBlockNumber,
    throughBlockHash,
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
  }) as ContextGraphAuthorityIndexCheckpoint;
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
    cursor: Object.freeze({ ...cursor }),
    states: frozenStates,
  } as const;
  return Object.freeze({
    ...checkpointWithoutIntegrity,
    integrity: contextGraphAuthorityIndexIntegrity(checkpointWithoutIntegrity),
  }) as ContextGraphAuthorityIndexCheckpoint;
}
