// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityGenerationState } from './context-graph-authority-generation.js';

export const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/** Canonical materialized authority state, including its generation counters. */
export interface ContextGraphAuthorityState extends ContextGraphAuthorityGenerationState {
  readonly owner: string;
  readonly active: boolean;
  readonly accessPolicy: number;
  readonly publishPolicy: number;
  readonly publishAuthority: string | null;
  readonly publishAuthorityAccountId: string;
  readonly participantAgents: readonly string[];
}
/** One graph's state inside the contract-wide materialized index. */
export interface ContextGraphAuthorityIndexState extends ContextGraphAuthorityState {
  readonly contextGraphId: string;
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
  readonly owner: string;
  readonly nameHash: string;
  readonly participantAgents: readonly string[];
  readonly accessPolicy: number;
  readonly publishPolicy: number;
  readonly publishAuthority: string;
  readonly publishAuthorityAccountId: bigint;
}

export interface ContextGraphAuthorityIndexTransferEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'Transfer';
  readonly from: string;
  readonly to: string;
}

export interface ContextGraphAuthorityIndexPublishPolicyEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'PublishPolicyUpdated';
  readonly publishPolicy: number;
  readonly publishAuthority: string;
  readonly publishAuthorityAccountId: bigint;
}

export interface ContextGraphAuthorityIndexPublishAuthorityEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'PublishAuthorityUpdated';
  readonly publishAuthority: string;
  readonly publishAuthorityAccountId: bigint;
}

export type ContextGraphAuthorityIndexPolicyEvent =
  | ContextGraphAuthorityIndexPublishPolicyEvent
  | ContextGraphAuthorityIndexPublishAuthorityEvent;

export interface ContextGraphAuthorityIndexRosterEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'AgentParticipantAdded' | 'AgentParticipantRemoved';
  readonly agent: string;
}

export interface ContextGraphAuthorityIndexDeactivationEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'ContextGraphDeactivated';
}

export type ContextGraphAuthorityIndexEvent =
  | ContextGraphAuthorityIndexCreationEvent
  | ContextGraphAuthorityIndexTransferEvent
  | ContextGraphAuthorityIndexPublishPolicyEvent
  | ContextGraphAuthorityIndexPublishAuthorityEvent
  | ContextGraphAuthorityIndexRosterEvent
  | ContextGraphAuthorityIndexDeactivationEvent;

export function freezeContextGraphAuthorityIndexState(
  state: ContextGraphAuthorityIndexState,
): ContextGraphAuthorityIndexState {
  return Object.freeze({
    ...state,
    participantAgents: Object.freeze([...state.participantAgents]),
  });
}

function increment(value: number, label: string): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`Context Graph authority ${label} exceeds the safe integer range`);
  }
  return next;
}

/** Apply one normalized event to authority fields and generation counters together. */
export function applyContextGraphAuthorityStateEvent(
  previous: ContextGraphAuthorityIndexState | undefined,
  event: ContextGraphAuthorityIndexEvent,
): ContextGraphAuthorityIndexState | undefined {
  const contextGraphId = event.contextGraphId.toString(10);
  const subject = `Context Graph ${contextGraphId}`;

  if (event.name === 'ContextGraphCreated') {
    if (previous !== undefined) throw new Error(`${subject} has more than one creation event`);
    return freezeContextGraphAuthorityIndexState({
      contextGraphId,
      owner: event.owner,
      active: true,
      accessPolicy: event.accessPolicy,
      publishPolicy: event.publishPolicy,
      publishAuthority: event.publishAuthority === ZERO_ADDRESS
        ? null
        : event.publishAuthority,
      publishAuthorityAccountId: event.publishAuthorityAccountId.toString(10),
      participantAgents: event.participantAgents,
      nameHash: event.nameHash,
      ownershipEra: 0,
      policyVersion: 0,
      rosterVersion: 0,
      sourceBlockNumber: event.blockNumber,
      sourceBlockHash: event.blockHash,
    });
  }
  if (event.name === 'Transfer' && event.from === ZERO_ADDRESS) return previous;
  if (previous === undefined) throw new Error(`${subject} authority event precedes creation`);
  if (event.name === 'Transfer' && event.to === ZERO_ADDRESS) {
    throw new Error(`${subject} authority index cannot materialize a burned token`);
  }
  if (event.name === 'Transfer' && event.from === event.to) return previous;

  switch (event.name) {
    case 'ContextGraphDeactivated':
      return freezeContextGraphAuthorityIndexState({ ...previous, active: false });
    case 'Transfer':
      return freezeContextGraphAuthorityIndexState({
        ...previous,
        owner: event.to,
        ownershipEra: increment(previous.ownershipEra, 'ownership era'),
        policyVersion: increment(previous.policyVersion, 'policy version'),
        rosterVersion: increment(previous.rosterVersion, 'roster version'),
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash,
      });
    case 'PublishPolicyUpdated':
      return freezeContextGraphAuthorityIndexState({
        ...previous,
        publishPolicy: event.publishPolicy,
        publishAuthority: event.publishAuthority === ZERO_ADDRESS
          ? null
          : event.publishAuthority,
        publishAuthorityAccountId: event.publishAuthorityAccountId.toString(10),
        policyVersion: increment(previous.policyVersion, 'policy version'),
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash,
      });
    case 'PublishAuthorityUpdated': {
      if (
        (previous.publishPolicy === 0 && event.publishAuthority === ZERO_ADDRESS)
        || (previous.publishPolicy === 1 && (
          event.publishAuthority !== ZERO_ADDRESS || event.publishAuthorityAccountId !== 0n
        ))
      ) throw new Error(`${subject} publisher event violates its publish policy`);
      return freezeContextGraphAuthorityIndexState({
        ...previous,
        publishAuthority: event.publishAuthority === ZERO_ADDRESS
          ? null
          : event.publishAuthority,
        publishAuthorityAccountId: event.publishAuthorityAccountId.toString(10),
        policyVersion: increment(previous.policyVersion, 'policy version'),
        sourceBlockNumber: event.blockNumber,
        sourceBlockHash: event.blockHash,
      });
    }
    case 'AgentParticipantAdded': {
      const participantAgents = new Set(previous.participantAgents);
      if (participantAgents.has(event.agent)) {
        throw new Error(`${subject} adds an existing participant agent`);
      }
      if (participantAgents.size >= MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
        throw new Error(`${subject} participant-agent limit exceeded`);
      }
      participantAgents.add(event.agent);
      return freezeContextGraphAuthorityIndexState({
        ...previous,
        participantAgents: [...participantAgents].sort(),
        rosterVersion: increment(previous.rosterVersion, 'roster version'),
      });
    }
    case 'AgentParticipantRemoved': {
      const participantAgents = new Set(previous.participantAgents);
      if (!participantAgents.delete(event.agent)) {
        throw new Error(`${subject} removes an unknown participant agent`);
      }
      return freezeContextGraphAuthorityIndexState({
        ...previous,
        participantAgents: [...participantAgents].sort(),
        rosterVersion: increment(previous.rosterVersion, 'roster version'),
      });
    }
  }
}
