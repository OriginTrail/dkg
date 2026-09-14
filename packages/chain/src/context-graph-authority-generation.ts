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

interface ContextGraphAuthorityGenerationEventBase {
  readonly blockNumber: number;
  readonly blockHash: string;
}

type ContextGraphAuthorityPayloadlessEventName =
  | 'Transfer'
  | 'PublishPolicyUpdated'
  | 'PublishAuthorityUpdated'
  | 'AgentParticipantAdded'
  | 'AgentParticipantRemoved';

/**
 * One union member per event name, so `Extract<..., { name: N }>` yields the
 * exact variant and a creation name can never be paired with a payload-less
 * event (or vice versa) at a typed boundary.
 */
export type ContextGraphAuthorityGenerationEvent =
  | (ContextGraphAuthorityGenerationEventBase & {
      readonly name: 'ContextGraphCreated';
      readonly nameHash: string;
    })
  | {
      [Name in ContextGraphAuthorityPayloadlessEventName]:
        ContextGraphAuthorityGenerationEventBase & { readonly name: Name };
    }[ContextGraphAuthorityPayloadlessEventName];

export type ContextGraphAuthorityGenerationEventName =
  ContextGraphAuthorityGenerationEvent['name'];

/** The event variant carrying `name`, including its name-specific payload. */
export type ContextGraphAuthorityGenerationEventOf<
  Name extends ContextGraphAuthorityGenerationEventName,
> = Extract<ContextGraphAuthorityGenerationEvent, { readonly name: Name }>;

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
