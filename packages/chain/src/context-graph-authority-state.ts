// SPDX-License-Identifier: Apache-2.0

import {
  assertContextGraphAccessPolicyV1,
  assertContextGraphPublishPolicyV1,
  snapshotContextGraphPublishDomainV1,
  type ContextGraphAccessPolicyV1,
  type ContextGraphPublishDomainV1,
  type ContextGraphPublishPolicyV1,
  type DecimalU256V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import {
  applyContextGraphAuthorityGenerationEvent,
  type ContextGraphAuthorityGenerationState,
} from './context-graph-authority-generation.js';

export const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;

export type ContextGraphAuthorityPublishReference = Readonly<{
  publishAuthority: EvmAddressV1 | null;
  publishAuthorityAccountId: DecimalU256V1;
}>;

/** Canonical materialized authority state, including its generation counters. */
export type ContextGraphAuthorityState = ContextGraphAuthorityGenerationState & Readonly<{
  owner: string;
  active: boolean;
  accessPolicy: ContextGraphAccessPolicyV1;
  participantAgents: readonly string[];
}> & ContextGraphPublishDomainV1;

/** One graph's state inside the contract-wide materialized index. */
export type ContextGraphAuthorityIndexState = ContextGraphAuthorityState & Readonly<{
  contextGraphId: string;
}>;

interface ContextGraphAuthorityIndexEventBase {
  readonly contextGraphId: bigint;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
}

export type ContextGraphAuthorityIndexCreationEvent =
  ContextGraphAuthorityIndexEventBase
  & Readonly<{
    name: 'ContextGraphCreated';
    owner: string;
    nameHash: string;
    participantAgents: readonly string[];
    accessPolicy: ContextGraphAccessPolicyV1;
  }>
  & ContextGraphPublishDomainV1;

export interface ContextGraphAuthorityIndexTransferEvent
  extends ContextGraphAuthorityIndexEventBase {
  readonly name: 'Transfer';
  readonly from: string;
  readonly to: string;
}

export type ContextGraphAuthorityIndexPublishPolicyEvent =
  ContextGraphAuthorityIndexEventBase
  & Readonly<{ name: 'PublishPolicyUpdated' }>
  & ContextGraphPublishDomainV1;

export interface ContextGraphAuthorityIndexPublishAuthorityEvent
  extends ContextGraphAuthorityIndexEventBase, ContextGraphAuthorityPublishReference {
  readonly name: 'PublishAuthorityUpdated';
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

export function normalizeContextGraphAuthorityAccessPolicy(
  value: unknown,
): ContextGraphAccessPolicyV1 | undefined {
  try {
    assertContextGraphAccessPolicyV1(value);
    return value;
  } catch {
    return undefined;
  }
}

export function normalizeContextGraphAuthorityPublishPolicy(
  value: unknown,
): ContextGraphPublishPolicyV1 | undefined {
  try {
    assertContextGraphPublishPolicyV1(value);
    return value;
  } catch {
    return undefined;
  }
}

export function normalizeContextGraphAuthorityPublishReference(
  publishAuthority: unknown,
  publishAuthorityAccountId: unknown,
): ContextGraphAuthorityPublishReference | undefined {
  const authority = typeof publishAuthority === 'string' && ADDRESS_PATTERN.test(publishAuthority)
    ? publishAuthority.toLowerCase()
    : publishAuthority;
  const normalizedAuthority = authority === ZERO_ADDRESS ? null : authority;
  const normalizedAccountId = typeof publishAuthorityAccountId === 'bigint'
    ? publishAuthorityAccountId.toString(10)
    : publishAuthorityAccountId;
  try {
    // Policy 0 admits every non-null canonical authority/account pair, so it
    // provides the canonical scalar validation without inventing another codec.
    const domain = snapshotContextGraphPublishDomainV1(
      0,
      normalizedAuthority,
      normalizedAccountId,
    );
    return Object.freeze({
      publishAuthority: domain.publishAuthority,
      publishAuthorityAccountId: domain.publishAuthorityAccountId,
    });
  } catch {
    if (normalizedAuthority !== null) return undefined;
    // Null is a valid normalized reference only for the open domain. Validate
    // its account scalar there; the caller supplies the actual policy later.
    try {
      const domain = snapshotContextGraphPublishDomainV1(
        1,
        normalizedAuthority,
        normalizedAccountId,
      );
      return Object.freeze({
        publishAuthority: domain.publishAuthority,
        publishAuthorityAccountId: domain.publishAuthorityAccountId,
      });
    } catch {
      return undefined;
    }
  }
}

export function normalizeContextGraphAuthorityPublishDomain(
  publishPolicy: unknown,
  publishAuthority: unknown,
  publishAuthorityAccountId: unknown,
): ContextGraphPublishDomainV1 | undefined {
  const policy = normalizeContextGraphAuthorityPublishPolicy(publishPolicy);
  const reference = normalizeContextGraphAuthorityPublishReference(
    publishAuthority,
    publishAuthorityAccountId,
  );
  if (policy === undefined || reference === undefined) return undefined;
  try {
    return snapshotContextGraphPublishDomainV1(
      policy,
      reference.publishAuthority,
      reference.publishAuthorityAccountId,
    );
  } catch {
    return undefined;
  }
}

export function freezeContextGraphAuthorityIndexState(
  state: ContextGraphAuthorityIndexState,
): ContextGraphAuthorityIndexState {
  return Object.freeze({
    ...state,
    participantAgents: Object.freeze([...state.participantAgents]),
  });
}

/** Apply materialized-field patches around the one canonical generation reducer. */
export function applyContextGraphAuthorityStateEvent(
  previous: ContextGraphAuthorityIndexState | undefined,
  event: ContextGraphAuthorityIndexEvent,
): ContextGraphAuthorityIndexState | undefined {
  const contextGraphId = event.contextGraphId.toString(10);
  const subject = `Context Graph ${contextGraphId}`;

  if (event.name === 'Transfer' && event.from === ZERO_ADDRESS) return previous;
  if (event.name === 'ContextGraphDeactivated') {
    if (previous === undefined) throw new Error(`${subject} authority event precedes creation`);
    return freezeContextGraphAuthorityIndexState({ ...previous, active: false });
  }
  if (event.name === 'Transfer' && event.to === ZERO_ADDRESS) {
    throw new Error(`${subject} authority index cannot materialize a burned token`);
  }
  if (event.name === 'Transfer' && event.from === event.to) return previous;

  const generation = applyContextGraphAuthorityGenerationEvent(previous, event, subject);
  switch (event.name) {
    case 'ContextGraphCreated': {
      const domain = normalizeContextGraphAuthorityPublishDomain(
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (domain === undefined) {
        throw new Error(`${subject} creation event violates its publish policy`);
      }
      return freezeContextGraphAuthorityIndexState({
        contextGraphId,
        owner: event.owner,
        active: true,
        accessPolicy: event.accessPolicy,
        participantAgents: event.participantAgents,
        ...domain,
        ...generation,
      });
    }
    case 'Transfer':
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        owner: event.to,
      });
    case 'PublishPolicyUpdated': {
      const domain = normalizeContextGraphAuthorityPublishDomain(
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (domain === undefined) {
        throw new Error(`${subject} policy event violates its publish policy`);
      }
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        ...domain,
      });
    }
    case 'PublishAuthorityUpdated': {
      const domain = normalizeContextGraphAuthorityPublishDomain(
        previous!.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (domain === undefined) {
        throw new Error(`${subject} publisher event violates its publish policy`);
      }
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        ...domain,
      });
    }
    case 'AgentParticipantAdded': {
      const participantAgents = new Set(previous!.participantAgents);
      if (participantAgents.has(event.agent)) {
        throw new Error(`${subject} adds an existing participant agent`);
      }
      if (participantAgents.size >= MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
        throw new Error(`${subject} participant-agent limit exceeded`);
      }
      participantAgents.add(event.agent);
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        participantAgents: [...participantAgents].sort(),
      });
    }
    case 'AgentParticipantRemoved': {
      const participantAgents = new Set(previous!.participantAgents);
      if (!participantAgents.delete(event.agent)) {
        throw new Error(`${subject} removes an unknown participant agent`);
      }
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        participantAgents: [...participantAgents].sort(),
      });
    }
  }
}
