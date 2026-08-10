// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  getSyncCheckpointKey,
  type SyncCheckpointScope,
} from './checkpoint/state.js';
import { estimateQuadHeapBytes } from './memory-telemetry.js';
import {
  SyncPageAccumulationLimitError,
  type SyncPageResult,
} from './requester/page-fetch.js';
import type {
  SharedMemoryMetadataFetchRequest,
  SharedMemoryMetadataFetcher,
} from './requester/shared-memory-sync.js';
import type { SelectedSwmMetaRetentionLease } from './selected-swm-meta-budget.js';

/** Exact prefix retained only for one selected-provider invocation. */
export interface SelectedSwmMetaContinuationState {
  quads: Quad[];
  bytesEstimate: number;
  nextOffset: number;
  checkpointKey: string;
  requesterScope: SyncCheckpointScope;
  /** Incremented whenever the responder restarts this prefix from offset zero. */
  generation: number;
  completed: boolean;
  retentionLease: SelectedSwmMetaRetentionLease;
}

export interface SelectedSwmMetaFetcher {
  readonly strategy: SharedMemoryMetadataFetcher;
  continuation(contextGraphId: string): SelectedSwmMetaContinuation;
  cleanup(): void;
}

/** Immutable continuation evidence captured immediately after one SWM round. */
export interface SelectedSwmMetaContinuation {
  readonly progress: number | undefined;
  readonly generation: number;
  readonly completed: boolean;
}

interface SelectedMetaPageFetchRequest {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly graphUri: string;
  readonly deadline: number;
  readonly requesterScope: SyncCheckpointScope;
  readonly maxAcceptedQuads: number;
  readonly maxAcceptedHeapBytesEstimate: number;
}

/**
 * Build the selected-only metadata strategy outside the generic SWM pipeline.
 *
 * It owns responder-session scoping, exact prefix retention, process-wide
 * reservations and the one bounded fresh-generation retry. The generic
 * requester sees only a normal metadata page plus a voluntary-yield bit.
 */
export function createSelectedSwmMetaFetcher(options: {
  readonly remotePeerId: string;
  readonly requesterScope: SyncCheckpointScope;
  readonly retentionBudget: { lease(): SelectedSwmMetaRetentionLease };
  readonly fetchPage: (request: SelectedMetaPageFetchRequest) => Promise<SyncPageResult>;
  readonly deleteCheckpoint: (checkpointKey: string) => void;
}): SelectedSwmMetaFetcher {
  const states = new Map<string, SelectedSwmMetaContinuationState>();
  const completedContextGraphs = new Set<string>();

  const release = (
    contextGraphId: string,
    state = states.get(contextGraphId),
  ): void => {
    states.delete(contextGraphId);
    if (!state) return;
    options.deleteCheckpoint(state.checkpointKey);
    state.retentionLease.release();
  };

  const ensureState = (contextGraphId: string): SelectedSwmMetaContinuationState => {
    const existing = states.get(contextGraphId);
    if (existing) return existing;
    completedContextGraphs.delete(contextGraphId);
    const checkpointKey = getSyncCheckpointKey(
      options.remotePeerId,
      contextGraphId,
      true,
      'meta',
      undefined,
      undefined,
      undefined,
      undefined,
      options.requesterScope,
    );
    // A prefix is invocation-local. A checkpoint without that byte-identical
    // prefix cannot be resumed, even if a previous process left it behind.
    options.deleteCheckpoint(checkpointKey);
    const state: SelectedSwmMetaContinuationState = {
      quads: [],
      bytesEstimate: 0,
      nextOffset: 0,
      checkpointKey,
      requesterScope: options.requesterScope,
      generation: 0,
      completed: false,
      retentionLease: options.retentionBudget.lease(),
    };
    states.set(contextGraphId, state);
    return state;
  };

  const fetchRetained = async (
    request: SharedMemoryMetadataFetchRequest,
    state: SelectedSwmMetaContinuationState,
    allowFreshRestartRetry: boolean,
  ): Promise<SyncPageResult> => {
    // Reserve before yielding to transport. Overlapping selected invocations
    // therefore cannot both spend the same process-wide free allowance.
    const reservation = state.retentionLease.reserve();
    try {
      const fetched = await options.fetchPage({
        ...request,
        requesterScope: state.requesterScope,
        maxAcceptedQuads: reservation.maxRows,
        maxAcceptedHeapBytesEstimate: reservation.maxBytesEstimate,
      });
      const resumesPrefix = fetched.resumedFromOffset === state.nextOffset;
      const restartedFromZero = fetched.resumedFromOffset === 0;
      if (!resumesPrefix && !restartedFromZero) {
        options.deleteCheckpoint(fetched.checkpointKey);
        completedContextGraphs.delete(request.contextGraphId);
        release(request.contextGraphId, state);
        throw new Error(
          `SWM metadata continuation offset mismatch for "${request.contextGraphId}": `
          + `retained=${state.nextOffset}, resumed=${fetched.resumedFromOffset}`,
        );
      }
      const fetchedBytesEstimate = fetched.quads.reduce(
        (total, quad) => total + estimateQuadHeapBytes(quad),
        0,
      );
      const nextRows = resumesPrefix
        ? state.quads.length + fetched.quads.length
        : fetched.quads.length;
      const nextBytesEstimate = resumesPrefix
        ? state.bytesEstimate + fetchedBytesEstimate
        : fetchedBytesEstimate;
      reservation.commitReplace(nextRows, nextBytesEstimate);
      if (resumesPrefix) {
        for (const quad of fetched.quads) state.quads.push(quad);
      } else {
        state.quads = fetched.quads;
        if (state.nextOffset > 0) state.generation += 1;
      }
      state.bytesEstimate = nextBytesEstimate;
      state.nextOffset = fetched.nextOffset;
      state.checkpointKey = fetched.checkpointKey;
      state.completed = fetched.completed;
      if (state.completed) completedContextGraphs.add(request.contextGraphId);
      return { ...fetched, quads: state.quads };
    } catch (error) {
      reservation.release();
      if (
        allowFreshRestartRetry
        && error instanceof SyncPageAccumulationLimitError
        && error.responderSessionStartedFresh === true
        && state.nextOffset > 0
      ) {
        // The responder replaced its immutable row-list. Drop the obsolete full
        // prefix and retry once with the full bounded allowance.
        options.deleteCheckpoint(state.checkpointKey);
        state.retentionLease.replace(0, 0);
        state.quads = [];
        state.bytesEstimate = 0;
        state.nextOffset = 0;
        state.completed = false;
        state.generation += 1;
        completedContextGraphs.delete(request.contextGraphId);
        return fetchRetained(request, state, false);
      }
      throw error;
    }
  };

  const strategy: SharedMemoryMetadataFetcher = {
    async fetch(request) {
      const state = ensureState(request.contextGraphId);
      if (state.completed) {
        return {
          result: {
            quads: state.quads,
            bytesReceived: 0,
            resumedFromOffset: state.nextOffset,
            nextOffset: state.nextOffset,
            checkpointKey: state.checkpointKey,
            completed: true,
            timedOut: false,
          },
          continuationYielded: false,
        };
      }
      const result = await fetchRetained(request, state, true);
      return { result, continuationYielded: !state.completed };
    },
    release,
  };

  return {
    strategy,
    continuation: (contextGraphId) => {
      const state = states.get(contextGraphId);
      return {
        progress: state?.nextOffset,
        generation: state?.generation ?? 0,
        completed: completedContextGraphs.has(contextGraphId),
      };
    },
    cleanup() {
      for (const [contextGraphId, state] of states) release(contextGraphId, state);
      completedContextGraphs.clear();
    },
  };
}
