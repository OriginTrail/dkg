// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  getSyncCheckpointKey,
  type SelectedSwmMetaRetentionScope,
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
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from './durable-session.js';

/** Exact prefix retained only by one selected-provider transfer owner. */
interface SelectedSwmMetaContinuationState {
  quads: Quad[];
  bytesEstimate: number;
  nextOffset: number;
  checkpointKey: string;
  requesterScope: SelectedSwmMetaRetentionScope;
  /** Incremented whenever the responder restarts this prefix from offset zero. */
  generation: number;
  completed: boolean;
  expiresAtMs: number;
  retentionLease: SelectedSwmMetaRetentionLease;
}

export interface SelectedSwmMetaFetcher {
  readonly strategy: SharedMemoryMetadataFetcher;
  continuation(contextGraphId: string): SelectedSwmMetaContinuation;
  /**
   * Drop terminal/empty state at an outer reconciler boundary and describe the
   * useful incomplete prefix that remains eligible for a later invocation.
   */
  settleOuterInvocation(): SelectedSwmMetaRetentionState;
  cleanup(): void;
}

export interface SelectedSwmMetaRetentionState {
  readonly retained: boolean;
  /** Changes only when a retained generation or exact prefix changes. */
  readonly progressToken: string;
  /** Earliest independent Context Graph prefix expiry. */
  readonly nextExpiryAtMs: number | undefined;
}

/** Immutable continuation evidence captured immediately after one SWM round. */
export interface SelectedSwmMetaContinuation {
  readonly progress: number | undefined;
  readonly generation: number;
  readonly completed: boolean;
}

interface SelectedSwmMetaTransferEntry {
  fetcher: SelectedSwmMetaFetcher | undefined;
  tail: Promise<void>;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Agent-local, peer-serial ownership for selected-SWM metadata prefixes.
 *
 * A responder offset is meaningful only together with the byte-identical
 * validated prefix and responder session that produced it. This coordinator
 * keeps that tuple alive across bounded reconciler invocations, while allowing
 * exactly one invocation for a peer to mutate it at a time. It is deliberately
 * not a generic SWM cache: ordinary/private SWM retain their existing behavior.
 */
export class SelectedSwmMetaTransferCoordinator {
  readonly #entries = new Map<string, SelectedSwmMetaTransferEntry>();

  readonly #now: () => number;

  #closed = false;

  constructor(options: {
    readonly now?: () => number;
  } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  run<T>(
    remotePeerId: string,
    createFetcher: () => SelectedSwmMetaFetcher,
    operation: (fetcher: SelectedSwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    let entry = this.#entries.get(remotePeerId);
    if (!entry) {
      entry = {
        fetcher: undefined,
        tail: Promise.resolve(),
        expiryTimer: undefined,
      };
      this.#entries.set(remotePeerId, entry);
    }

    const execute = entry.tail.then(async () => {
      if (this.#closed) throw this.#closedError();
      this.#clearExpiryTimer(entry!);
      const retainedBeforeRun = entry!.fetcher?.settleOuterInvocation();
      if (entry!.fetcher && !retainedBeforeRun?.retained) {
        entry!.fetcher.cleanup();
        entry!.fetcher = undefined;
      }
      const fetcher = entry!.fetcher ?? createFetcher();
      entry!.fetcher = fetcher;
      let succeeded = false;
      try {
        const result = await operation(fetcher);
        succeeded = true;
        return result;
      } finally {
        if (!succeeded) {
          // An escaping abort, validation/integrity failure, or local build
          // failure must never leave a cursor whose owner already unwound.
          fetcher.cleanup();
          entry!.fetcher = undefined;
        } else {
          const retention = fetcher.settleOuterInvocation();
          if (!retention.retained) {
            fetcher.cleanup();
            entry!.fetcher = undefined;
          } else {
            this.#scheduleExpiry(remotePeerId, entry!, retention.nextExpiryAtMs);
          }
        }
      }
    });
    const settled = execute.then(() => undefined, () => undefined);
    entry.tail = settled;
    void settled.then(() => {
      if (
        this.#entries.get(remotePeerId) === entry
        && entry!.tail === settled
        && !entry!.fetcher
      ) {
        this.#entries.delete(remotePeerId);
      }
    });
    return execute;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    for (const entry of entries) this.#clearExpiryTimer(entry);
    await Promise.all(entries.map((entry) => entry.tail));
    for (const entry of entries) {
      entry.fetcher?.cleanup();
      entry.fetcher = undefined;
    }
    this.#entries.clear();
  }

  #clearExpiryTimer(entry: SelectedSwmMetaTransferEntry): void {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    entry.expiryTimer = undefined;
  }

  #scheduleExpiry(
    remotePeerId: string,
    entry: SelectedSwmMetaTransferEntry,
    nextExpiryAtMs: number | undefined,
  ): void {
    this.#clearExpiryTimer(entry);
    if (nextExpiryAtMs === undefined || this.#closed) return;
    const delayMs = Math.max(1, nextExpiryAtMs - this.#now());
    entry.expiryTimer = setTimeout(() => {
      entry.expiryTimer = undefined;
      if (this.#closed || this.#entries.get(remotePeerId) !== entry) return;
      const expire = entry.tail.then(() => {
        if (this.#closed || this.#entries.get(remotePeerId) !== entry) return;
        const retention = entry.fetcher?.settleOuterInvocation();
        if (!retention?.retained) {
          entry.fetcher?.cleanup();
          entry.fetcher = undefined;
          this.#entries.delete(remotePeerId);
          return;
        }
        this.#scheduleExpiry(remotePeerId, entry, retention.nextExpiryAtMs);
      });
      entry.tail = expire.then(() => undefined, () => undefined);
    }, delayMs);
    entry.expiryTimer.unref?.();
  }

  #closedError(): Error {
    const error = new Error('Selected SWM metadata transfer coordinator is closed');
    error.name = 'AbortError';
    return error;
  }
}

interface SelectedMetaPageFetchRequest {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly graphUri: string;
  readonly deadline: number;
  readonly requesterScope: SelectedSwmMetaRetentionScope;
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
  readonly requesterScope: SelectedSwmMetaRetentionScope;
  readonly retentionBudget: { lease(): SelectedSwmMetaRetentionLease };
  readonly fetchPage: (request: SelectedMetaPageFetchRequest) => Promise<SyncPageResult>;
  readonly deleteCheckpoint: (checkpointKey: string) => void;
  readonly now?: () => number;
  readonly retentionTtlMs?: number;
}): SelectedSwmMetaFetcher {
  const states = new Map<string, SelectedSwmMetaContinuationState>();
  const completedContextGraphs = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const retentionTtlMs = options.retentionTtlMs ?? DURABLE_DATA_SYNC_SESSION_TTL_MS;
  if (!Number.isSafeInteger(retentionTtlMs) || retentionTtlMs <= 0) {
    throw new Error(`Invalid selected SWM metadata retention TTL: ${retentionTtlMs}`);
  }

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
    // A prefix is coordinator-local. A checkpoint without that byte-identical
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
      expiresAtMs: 0,
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
      const previousGeneration = state.generation;
      const previousOffset = state.nextOffset;
      const previousRows = state.quads.length;
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
      if (
        !state.completed
        && state.nextOffset > 0
        && state.quads.length > 0
        && (
          state.generation !== previousGeneration
          || state.nextOffset > previousOffset
          || state.quads.length > previousRows
        )
      ) {
        // Each Context Graph owns an independent sliding expiry. Progress on a
        // sibling CG cannot keep an abandoned prefix resident.
        state.expiresAtMs = now() + retentionTtlMs;
      }
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
        state.expiresAtMs = 0;
        state.generation += 1;
        completedContextGraphs.delete(request.contextGraphId);
        return fetchRetained(request, state, false);
      }
      // Only an incomplete result returned by the page fetcher is resumable.
      // Every thrown boundary is fail-closed: discard the prefix and its exact
      // responder cursor before propagating the original error unchanged.
      release(request.contextGraphId, state);
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
    settleOuterInvocation() {
      for (const [contextGraphId, state] of states) {
        // Completed manifests may be reused by continuation passes in the same
        // outer invocation, but never become a cross-invocation cache. Empty
        // state has no validated prefix to justify a non-zero cursor lifetime.
        if (
          state.completed
          || state.nextOffset <= 0
          || state.quads.length === 0
          || state.expiresAtMs <= now()
        ) {
          release(contextGraphId, state);
          completedContextGraphs.delete(contextGraphId);
        }
      }
      const retained = [...states.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([contextGraphId, state]) => [
          contextGraphId,
          state.requesterScope,
          state.generation,
          state.nextOffset,
          state.quads.length,
          state.checkpointKey,
        ]);
      return {
        retained: retained.length > 0,
        progressToken: JSON.stringify(retained),
        nextExpiryAtMs: retained.length > 0
          ? Math.min(...[...states.values()].map((state) => state.expiresAtMs))
          : undefined,
      };
    },
    cleanup() {
      for (const [contextGraphId, state] of states) release(contextGraphId, state);
      completedContextGraphs.clear();
    },
  };
}
