// SPDX-License-Identifier: Apache-2.0

/** Canonical authority-generation state shared by every history scanner. */
export interface ContextGraphAuthorityGenerationState {
  readonly nameHash: string;
  readonly ownershipEra: number;
  readonly policyVersion: number;
  readonly rosterVersion: number;
  readonly sourceBlockNumber: number;
  readonly sourceBlockHash: string;
}

const AUTHORITY_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

/** Canonical hash scalar shared by every durable authority envelope. */
export function normalizeContextGraphAuthorityHash(value: unknown): string | undefined {
  return typeof value === 'string' && AUTHORITY_HASH_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

/** Canonical counter/block scalar shared by every durable authority envelope. */
export function normalizeContextGraphAuthorityNonNegativeSafeInteger(
  value: unknown,
): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** Decode only the shared generation payload; envelopes add their own bounds. */
export function normalizeContextGraphAuthorityGenerationState(
  value: unknown,
): ContextGraphAuthorityGenerationState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<Record<keyof ContextGraphAuthorityGenerationState, unknown>>;
  const nameHash = normalizeContextGraphAuthorityHash(candidate.nameHash);
  const ownershipEra = normalizeContextGraphAuthorityNonNegativeSafeInteger(candidate.ownershipEra);
  const policyVersion = normalizeContextGraphAuthorityNonNegativeSafeInteger(candidate.policyVersion);
  const rosterVersion = normalizeContextGraphAuthorityNonNegativeSafeInteger(candidate.rosterVersion);
  const sourceBlockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(
    candidate.sourceBlockNumber,
  );
  const sourceBlockHash = normalizeContextGraphAuthorityHash(candidate.sourceBlockHash);
  if (
    nameHash === undefined
    || ownershipEra === undefined
    || policyVersion === undefined
    || rosterVersion === undefined
    || sourceBlockNumber === undefined
    || sourceBlockHash === undefined
  ) return undefined;
  return Object.freeze({
    nameHash,
    ownershipEra,
    policyVersion,
    rosterVersion,
    sourceBlockNumber,
    sourceBlockHash,
  });
}

/**
 * Versioned generation payload embedded by the v1 history and v2 index
 * checkpoint codecs. The fixed tuple is part of those durable formats; model
 * property order and later model additions cannot change it accidentally.
 */
export type ContextGraphAuthorityGenerationV1 = readonly [
  nameHash: string,
  ownershipEra: number,
  policyVersion: number,
  rosterVersion: number,
  sourceBlockNumber: number,
  sourceBlockHash: string,
];

export function encodeContextGraphAuthorityGenerationV1(
  state: ContextGraphAuthorityGenerationState,
): ContextGraphAuthorityGenerationV1 {
  return Object.freeze([
    state.nameHash,
    state.ownershipEra,
    state.policyVersion,
    state.rosterVersion,
    state.sourceBlockNumber,
    state.sourceBlockHash,
  ]);
}

interface ContextGraphAuthorityGenerationEventBase {
  readonly blockNumber: number;
  readonly blockHash: string;
}

export type ContextGraphAuthorityGenerationEvent =
  | (ContextGraphAuthorityGenerationEventBase & {
      readonly name: 'ContextGraphCreated';
      readonly nameHash: string;
    })
  | (ContextGraphAuthorityGenerationEventBase & {
      readonly name:
        | 'Transfer'
        | 'PublishPolicyUpdated'
        | 'PublishAuthorityUpdated'
        | 'AgentParticipantAdded'
        | 'AgentParticipantRemoved';
    });

function increment(value: number, label: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`Context Graph authority ${label} exceeds the safe integer range`);
  }
  return next;
}

/** Apply one already-normalized event using the protocol's single transition model. */
export function applyContextGraphAuthorityGenerationEvent(
  previous: ContextGraphAuthorityGenerationState | undefined,
  event: ContextGraphAuthorityGenerationEvent,
  subject: string,
): ContextGraphAuthorityGenerationState {
  if (event.name === 'ContextGraphCreated') {
    if (previous !== undefined) {
      throw new Error(`${subject} has more than one creation event`);
    }
    return Object.freeze({
      nameHash: event.nameHash,
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: event.blockNumber,
      sourceBlockHash: event.blockHash.toLowerCase(),
    });
  }
  if (previous === undefined) {
    throw new Error(`${subject} authority event precedes creation`);
  }
  switch (event.name) {
    case 'Transfer':
      return Object.freeze({
        ...previous,
        ownershipEra: increment(previous.ownershipEra, 'ownership era'),
        policyVersion: increment(previous.policyVersion, 'policy version'),
        rosterVersion: increment(previous.rosterVersion, 'roster version'),
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash.toLowerCase(),
      });
    case 'PublishPolicyUpdated':
    case 'PublishAuthorityUpdated':
      return Object.freeze({
        ...previous,
        policyVersion: increment(previous.policyVersion, 'policy version'),
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash.toLowerCase(),
      });
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved':
      return Object.freeze({
        ...previous,
        rosterVersion: increment(previous.rosterVersion, 'roster version'),
      });
  }
}
