// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { applyContextGraphAuthorityGenerationEvent } from './context-graph-authority-generation.js';
import {
  createContextGraphAuthorityIndexCheckpoint,
  freezeContextGraphAuthorityIndexState,
  normalizeAuthorityIndexHash,
  normalizeAuthorityIndexNonNegativeSafeInteger,
  normalizeContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-index-checkpoint.js';

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

export type ContextGraphAuthorityIndexEvent =
  | ContextGraphAuthorityIndexCreationEvent
  | ContextGraphAuthorityIndexTransferEvent
  | ContextGraphAuthorityIndexPolicyEvent
  | ContextGraphAuthorityIndexRosterEvent;

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

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function normalizeAddress(value: unknown): string | undefined {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value)
    ? value.toLowerCase()
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
      const nameHash = normalizeAuthorityIndexHash(event.nameHash);
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
    const prior = states.get(contextGraphId);
    if (
      event.name === 'Transfer'
      && (event.from === ZERO_ADDRESS || event.to === ZERO_ADDRESS || event.from === event.to)
    ) continue;
    const next = applyContextGraphAuthorityGenerationEvent(
      prior,
      event,
      `Context Graph ${contextGraphId}`,
    );
    states.set(contextGraphId, freezeContextGraphAuthorityIndexState({
      contextGraphId,
      ...next,
    }));
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
