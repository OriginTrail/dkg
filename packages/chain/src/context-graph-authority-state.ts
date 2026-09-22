// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDecimalU256,
  assertCanonicalEvmAddress,
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
  normalizeContextGraphAuthorityHash,
  normalizeContextGraphAuthorityNonNegativeSafeInteger,
  type ContextGraphAuthorityGenerationState,
} from './context-graph-authority-generation.js';
import {
  contextGraphAuthorityIndexIdFromBigInt,
  type ContextGraphAuthorityIndexId,
} from './context-graph-authority-index-id.js';

export const MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS = 256;

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const MAX_U256 = (1n << 256n) - 1n;

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
  contextGraphId: ContextGraphAuthorityIndexId;
}>;

declare const canonicalContextGraphAuthorityIndexEvent: unique symbol;

interface ContextGraphAuthorityIndexEventBase {
  readonly contextGraphId: bigint;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly index: number;
  readonly [canonicalContextGraphAuthorityIndexEvent]: true;
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

interface RawContextGraphAuthorityIndexEventBase {
  readonly contextGraphId: unknown;
  readonly blockNumber: unknown;
  readonly blockHash: unknown;
  readonly index: unknown;
}

export type RawContextGraphAuthorityIndexEvent =
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'ContextGraphCreated';
      owner: unknown;
      nameHash: unknown;
      participantAgents: unknown;
      accessPolicy: unknown;
      publishPolicy: unknown;
      publishAuthority: unknown;
      publishAuthorityAccountId: unknown;
    }>)
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'Transfer';
      from: unknown;
      to: unknown;
    }>)
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'PublishPolicyUpdated';
      publishPolicy: unknown;
      publishAuthority: unknown;
      publishAuthorityAccountId: unknown;
    }>)
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'PublishAuthorityUpdated';
      publishAuthority: unknown;
      publishAuthorityAccountId: unknown;
    }>)
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'AgentParticipantAdded' | 'AgentParticipantRemoved';
      agent: unknown;
    }>)
  | (RawContextGraphAuthorityIndexEventBase & Readonly<{
      name: 'ContextGraphDeactivated';
    }>);

export interface ContextGraphAuthorityIndexEventPage {
  readonly fromBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
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

export function normalizeContextGraphAuthorityAccessPolicy(
  value: unknown,
): ContextGraphAccessPolicyV1 | undefined {
  try {
    const normalized = typeof value === 'bigint' ? Number(value) : value;
    assertContextGraphAccessPolicyV1(normalized);
    return normalized;
  } catch {
    return undefined;
  }
}

export function normalizeContextGraphAuthorityPublishPolicy(
  value: unknown,
): ContextGraphPublishPolicyV1 | undefined {
  try {
    const normalized = typeof value === 'bigint' ? Number(value) : value;
    assertContextGraphPublishPolicyV1(normalized);
    return normalized;
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
    if (normalizedAuthority !== null) {
      assertCanonicalEvmAddress(normalizedAuthority, 'publishAuthority');
    }
    assertCanonicalDecimalU256(normalizedAccountId, 'publishAuthorityAccountId');
    return Object.freeze({
      publishAuthority: normalizedAuthority,
      publishAuthorityAccountId: normalizedAccountId,
    });
  } catch {
    return undefined;
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

/** Validate one untrusted decoder/test DTO into the sole transition event model. */
export function normalizeContextGraphAuthorityIndexEvent(
  event: RawContextGraphAuthorityIndexEvent,
  page: ContextGraphAuthorityIndexEventPage,
): ContextGraphAuthorityIndexEvent {
  if (
    typeof event.contextGraphId !== 'bigint'
    || event.contextGraphId <= 0n
    || event.contextGraphId > MAX_U256
  ) {
    throw new Error('Context Graph authority index event has an invalid context graph id');
  }
  const blockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(event.blockNumber);
  const blockHash = normalizeContextGraphAuthorityHash(event.blockHash);
  const index = normalizeContextGraphAuthorityNonNegativeSafeInteger(event.index);
  if (
    blockNumber === undefined
    || blockNumber < page.fromBlockNumber
    || blockNumber > page.throughBlockNumber
    || blockHash === undefined
    || index === undefined
  ) {
    throw new Error('Context Graph authority index event falls outside its page or is malformed');
  }
  if (blockNumber === page.throughBlockNumber && blockHash !== page.throughBlockHash) {
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
      const owner = normalizeAuthorityIndexAddress(event.owner);
      const nameHash = normalizeContextGraphAuthorityHash(event.nameHash);
      const participantAgents = normalizeAuthorityIndexParticipantAgents(
        event.participantAgents,
      );
      const accessPolicy = normalizeContextGraphAuthorityAccessPolicy(event.accessPolicy);
      const publishDomain = normalizeContextGraphAuthorityPublishDomain(
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (
        owner === undefined
        || owner === ZERO_ADDRESS
        || nameHash === undefined
        || participantAgents === undefined
        || accessPolicy === undefined
        || publishDomain === undefined
      ) {
        throw new Error('Context Graph authority index creation event has invalid authority state');
      }
      return Object.freeze({
        ...base,
        name: event.name,
        owner,
        nameHash,
        participantAgents,
        accessPolicy,
        ...publishDomain,
      }) as ContextGraphAuthorityIndexCreationEvent;
    }
    case 'Transfer': {
      const from = normalizeAuthorityIndexAddress(event.from);
      const to = normalizeAuthorityIndexAddress(event.to);
      if (from === undefined || to === undefined) {
        throw new Error('Context Graph authority index transfer event has an invalid address');
      }
      return Object.freeze({ ...base, name: event.name, from, to }) as
        ContextGraphAuthorityIndexTransferEvent;
    }
    case 'PublishPolicyUpdated': {
      const publishDomain = normalizeContextGraphAuthorityPublishDomain(
        event.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (publishDomain === undefined) {
        throw new Error('Context Graph authority index policy event has invalid authority state');
      }
      return Object.freeze({
        ...base,
        name: event.name,
        ...publishDomain,
      }) as ContextGraphAuthorityIndexPublishPolicyEvent;
    }
    case 'PublishAuthorityUpdated': {
      const publishReference = normalizeContextGraphAuthorityPublishReference(
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
      if (publishReference === undefined) {
        throw new Error('Context Graph authority index publisher event has invalid authority state');
      }
      return Object.freeze({
        ...base,
        name: event.name,
        ...publishReference,
      }) as ContextGraphAuthorityIndexPublishAuthorityEvent;
    }
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved': {
      const agent = normalizeAuthorityIndexAddress(event.agent);
      if (agent === undefined || agent === ZERO_ADDRESS) {
        throw new Error('Context Graph authority index roster event has an invalid agent');
      }
      return Object.freeze({ ...base, name: event.name, agent }) as
        ContextGraphAuthorityIndexRosterEvent;
    }
    case 'ContextGraphDeactivated':
      return Object.freeze({ ...base, name: event.name }) as
        ContextGraphAuthorityIndexDeactivationEvent;
    default:
      throw new Error('Context Graph authority index event has an unsupported name');
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

function projectContextGraphAuthorityPublishDomain(
  domain: ContextGraphPublishDomainV1,
): ContextGraphPublishDomainV1 {
  return domain.publishPolicy === 0
    ? {
        publishPolicy: 0,
        publishAuthority: domain.publishAuthority,
        publishAuthorityAccountId: domain.publishAuthorityAccountId,
      }
    : {
        publishPolicy: 1,
        publishAuthority: null,
        publishAuthorityAccountId: domain.publishAuthorityAccountId,
      };
}

/** Apply materialized-field patches around the one canonical generation reducer. */
export function applyContextGraphAuthorityStateEvent(
  previous: ContextGraphAuthorityIndexState | undefined,
  event: ContextGraphAuthorityIndexEvent,
): ContextGraphAuthorityIndexState | undefined {
  const contextGraphId = contextGraphAuthorityIndexIdFromBigInt(event.contextGraphId);
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
      return freezeContextGraphAuthorityIndexState({
        contextGraphId,
        owner: event.owner,
        active: true,
        accessPolicy: event.accessPolicy,
        participantAgents: event.participantAgents,
        ...projectContextGraphAuthorityPublishDomain(event),
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
      return freezeContextGraphAuthorityIndexState({
        ...previous!,
        ...generation,
        ...projectContextGraphAuthorityPublishDomain(event),
      });
    }
    case 'PublishAuthorityUpdated': {
      const domain = snapshotContextGraphPublishDomainV1(
        previous!.publishPolicy,
        event.publishAuthority,
        event.publishAuthorityAccountId,
      );
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
