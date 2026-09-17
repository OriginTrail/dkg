// SPDX-License-Identifier: Apache-2.0

import {
  normalizeContextGraphAuthorityHash,
  normalizeContextGraphAuthorityNonNegativeSafeInteger,
} from './context-graph-authority-generation.js';
import {
  createContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexCheckpoint,
} from './context-graph-authority-index-checkpoint.js';
import {
  applyContextGraphAuthorityStateEvent,
  normalizeContextGraphAuthorityIndexEvent,
  type ContextGraphAuthorityIndexState,
  type RawContextGraphAuthorityIndexEvent,
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
  RawContextGraphAuthorityIndexEvent,
} from './context-graph-authority-state.js';

export interface ReduceContextGraphAuthorityIndexPageInput {
  readonly deploymentBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly previous?: ContextGraphAuthorityIndexCheckpoint;
  readonly events: readonly RawContextGraphAuthorityIndexEvent[];
}
export interface ContextGraphAuthorityIndexPageReduction {
  readonly checkpoint: ContextGraphAuthorityIndexCheckpoint;
}

/** Reduce one contiguous, successfully fetched block range. */
export function reduceContextGraphAuthorityIndexPage(
  input: ReduceContextGraphAuthorityIndexPageInput,
): ContextGraphAuthorityIndexPageReduction {
  const deploymentBlockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(
    input.deploymentBlockNumber,
  );
  const throughBlockNumber = normalizeContextGraphAuthorityNonNegativeSafeInteger(
    input.throughBlockNumber,
  );
  const throughBlockHash = normalizeContextGraphAuthorityHash(input.throughBlockHash);
  if (
    deploymentBlockNumber === undefined
    || throughBlockNumber === undefined
    || throughBlockHash === undefined
  ) {
    throw new Error('Context Graph authority index page has an invalid block boundary');
  }
  // `previous` is branded by the creator/decoder. Opaque durable validation
  // happens once in ContextGraphAuthorityIndex.#load, not once per scan page.
  const previous = input.previous;
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
    .map((event) => normalizeContextGraphAuthorityIndexEvent(event, {
      fromBlockNumber,
      throughBlockNumber,
      throughBlockHash,
    }))
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
    }, states.values()),
  });
}
