// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import {
  createContextGraphAuthorityIndexCheckpoint,
  normalizeAuthorityIndexAddress,
  normalizeAuthorityIndexHash,
  normalizeAuthorityIndexNonNegativeSafeInteger,
  normalizeAuthorityIndexParticipantAgents,
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
} from './context-graph-authority-index-checkpoint.js';
import {
  applyContextGraphAuthorityStateEvent,
  normalizeContextGraphAuthorityAccessPolicy,
  normalizeContextGraphAuthorityPublishDomain,
  normalizeContextGraphAuthorityPublishReference,
  type ContextGraphAuthorityIndexEvent,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-state.js';

export type {
  ContextGraphAuthorityIndexCreationEvent,
  ContextGraphAuthorityIndexDeactivationEvent,
  ContextGraphAuthorityIndexEvent,
  ContextGraphAuthorityIndexPolicyEvent,
  ContextGraphAuthorityIndexPublishAuthorityEvent,
  ContextGraphAuthorityIndexPublishPolicyEvent,
  ContextGraphAuthorityIndexRosterEvent,
  ContextGraphAuthorityIndexTransferEvent,
} from './context-graph-authority-state.js';

export interface ReduceContextGraphAuthorityIndexPageInput {
  readonly deploymentBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly previous?: ContextGraphAuthorityIndexCheckpoint;
  readonly events: readonly ContextGraphAuthorityIndexEvent[];
}
export interface ContextGraphAuthorityIndexPageReduction {
  readonly checkpoint: ContextGraphAuthorityIndexCheckpoint;
}

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

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
  const blockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(event.blockNumber);
  const blockHash = normalizeAuthorityIndexHash(event.blockHash);
  const index = normalizeAuthorityIndexNonNegativeSafeInteger(event.index);
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
      const owner = normalizeAuthorityIndexAddress(event.owner);
      const nameHash = normalizeAuthorityIndexHash(event.nameHash);
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
      });
    }
    case 'Transfer': {
      const from = normalizeAuthorityIndexAddress(event.from);
      const to = normalizeAuthorityIndexAddress(event.to);
      if (from === undefined || to === undefined) {
        throw new Error('Context Graph authority index transfer event has an invalid address');
      }
      return Object.freeze({ ...base, name: event.name, from, to });
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
      });
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
      });
    }
    case 'AgentParticipantAdded':
    case 'AgentParticipantRemoved': {
      const agent = normalizeAuthorityIndexAddress(event.agent);
      if (agent === undefined || agent === ZERO_ADDRESS) {
        throw new Error('Context Graph authority index roster event has an invalid agent');
      }
      return Object.freeze({ ...base, name: event.name, agent });
    }
    case 'ContextGraphDeactivated':
      return Object.freeze({ ...base, name: event.name });
    default:
      throw new Error('Context Graph authority index event has an unsupported name');
  }
}

/** Reduce one contiguous, successfully fetched block range. */
export function reduceContextGraphAuthorityIndexPage(
  input: ReduceContextGraphAuthorityIndexPageInput,
): ContextGraphAuthorityIndexPageReduction {
  const deploymentBlockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(
    input.deploymentBlockNumber,
  );
  const throughBlockNumber = normalizeAuthorityIndexNonNegativeSafeInteger(
    input.throughBlockNumber,
  );
  const throughBlockHash = normalizeAuthorityIndexHash(input.throughBlockHash);
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
    const next = applyContextGraphAuthorityStateEvent(states.get(contextGraphId), event);
    if (next !== undefined) states.set(contextGraphId, next);
  }

  return Object.freeze({
    checkpoint: createContextGraphAuthorityIndexCheckpoint({
      deploymentBlockNumber,
      throughBlockNumber,
      throughBlockHash,
      stateCount: states.size,
    }, states.values()),
  });
}
