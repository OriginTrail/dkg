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
  PublicSnapshotMetadata,
  SharedMemoryMetadataFetchRequest,
  SharedMemoryMetadataFetcher,
} from './requester/shared-memory-sync.js';
import type { SelectedSwmMetaRetentionLease } from './selected-swm-meta-budget.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from './durable-session.js';

/** Post-metadata continuation bound to one exact ordered manifest. */
interface SelectedSwmSnapshotWalkState {
  readonly orderedManifest: readonly PublicSnapshotMetadata[];
  readonly resolvedRefs: Set<string>;
  readonly suppressedMetadataRowsByRef: Map<string, readonly Quad[]>;
  expiresAtMs: number;
}

/** Exact metadata prefix retained only by one selected-provider transfer owner. */
interface SelectedSwmMetaContinuationState {
  quads: Quad[];
  bytesEstimate: number;
  nextOffset: number;
  checkpointKey: string;
  requesterScope: SelectedSwmMetaRetentionScope;
  /** Incremented whenever the responder restarts this prefix from offset zero. */
  generation: number;
  completed: boolean;
  /** Prefix expiry; terminal metadata has no prefix retention clock. */
  metadataExpiresAtMs: number;
  /** Independent continuation created only after metadata is complete. */
  snapshotWalk?: SelectedSwmSnapshotWalkState;
  retentionLease: SelectedSwmMetaRetentionLease;
}

export interface SelectedSwmMetaFetcher {
  readonly strategy: SharedMemoryMetadataFetcher;
  continuation(contextGraphId: string): SelectedSwmMetaContinuation;
}

interface SelectedSwmMetaRetentionState {
  readonly retained: boolean;
  /** Earliest independent Context Graph prefix expiry. */
  readonly nextExpiryAtMs: number | undefined;
}

interface SelectedSwmMetaFetcherLifecycle {
  /** Release expired inactive prefixes while an outer peer operation is live. */
  pruneExpiredPrefixes(): SelectedSwmMetaRetentionState;
  /**
   * Drop terminal/empty state at an outer reconciler boundary and describe the
   * useful incomplete prefix that remains eligible for a later invocation.
   */
  settleOuterInvocation(): SelectedSwmMetaRetentionState;
  cleanup(): void;
}

const selectedSwmMetaFetcherLifecycles = new WeakMap<
SelectedSwmMetaFetcher,
SelectedSwmMetaFetcherLifecycle
>();

/**
 * One peer's complete retained-prefix lifecycle.
 *
 * The coordinator only registers these owners by peer. Serialization, outer
 * invocation boundaries, independent prefix expiry, failure cleanup, and
 * shutdown drain all remain behind this single API.
 */
export class SelectedSwmMetaTransferOwner {
  readonly #now: () => number;

  readonly #onIdle: (() => void) | undefined;

  #fetcher: SelectedSwmMetaFetcher | undefined;

  #tail: Promise<void> = Promise.resolve();

  #expiryTimer: ReturnType<typeof setTimeout> | undefined;

  #active = false;

  #pendingRuns = 0;

  #closed = false;

  constructor(options: {
    readonly now?: () => number;
    readonly onIdle?: () => void;
  } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#onIdle = options.onIdle;
  }

  run<T>(
    createFetcher: () => SelectedSwmMetaFetcher,
    operation: (fetcher: SelectedSwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closedError());
    this.#pendingRuns += 1;
    const execute = this.#tail.then(async () => {
      if (this.#closed) throw this.#closedError();
      this.#active = true;
      try {
        const retainedBeforeRun = this.#fetcher
          ? this.#lifecycle(this.#fetcher).settleOuterInvocation()
          : undefined;
        if (this.#fetcher && !retainedBeforeRun?.retained) {
          this.#releaseFetcher();
        }
        const fetcher = this.#fetcher ?? createFetcher();
        // Resolve the private lifecycle before retaining a newly-created
        // fetcher, so an invalid factory cannot become owner state.
        this.#lifecycle(fetcher);
        this.#fetcher = fetcher;
        let succeeded = false;
        try {
          const result = await operation(fetcher);
          succeeded = true;
          return result;
        } finally {
          if (!succeeded) {
            this.#releaseFetcher();
          } else {
            const retention = this.#lifecycle(fetcher).settleOuterInvocation();
            if (!retention.retained) {
              this.#releaseFetcher();
            } else {
              this.#scheduleExpiry(retention.nextExpiryAtMs);
            }
          }
        }
      } finally {
        this.#active = false;
      }
    });
    const settled = execute.then(() => undefined, () => undefined);
    this.#tail = settled;
    void settled.then(() => {
      this.#pendingRuns -= 1;
      this.#notifyIdle();
    });
    return execute;
  }

  isIdle(): boolean {
    return this.#pendingRuns === 0 && !this.#fetcher;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearExpiryTimer();
    await this.#tail;
    this.#releaseFetcher();
  }

  #lifecycle(fetcher: SelectedSwmMetaFetcher): SelectedSwmMetaFetcherLifecycle {
    const lifecycle = selectedSwmMetaFetcherLifecycles.get(fetcher);
    if (!lifecycle) {
      throw new Error('Selected SWM metadata owner received an unowned fetcher');
    }
    return lifecycle;
  }

  #releaseFetcher(): void {
    if (this.#fetcher) this.#lifecycle(this.#fetcher).cleanup();
    this.#fetcher = undefined;
    this.#clearExpiryTimer();
  }

  #clearExpiryTimer(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  #scheduleExpiry(nextExpiryAtMs: number | undefined): void {
    this.#clearExpiryTimer();
    if (nextExpiryAtMs === undefined || this.#closed) return;
    const delayMs = Math.max(1, nextExpiryAtMs - this.#now());
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      if (this.#closed || !this.#fetcher) return;
      // The fetcher protects active CGs, allowing this peer owner to reclaim
      // expired siblings even while another CG's operation is in flight.
      const retention = this.#lifecycle(this.#fetcher).pruneExpiredPrefixes();
      if (!retention.retained) {
        if (!this.#active) {
          this.#releaseFetcher();
          this.#notifyIdle();
        }
        return;
      }
      this.#scheduleExpiry(retention.nextExpiryAtMs);
    }, delayMs);
    this.#expiryTimer.unref?.();
  }

  #closedError(): Error {
    const error = new Error('Selected SWM metadata transfer owner is closed');
    error.name = 'AbortError';
    return error;
  }

  #notifyIdle(): void {
    if (this.isIdle()) this.#onIdle?.();
  }
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
  readonly returnAcceptedPrefixOnRetryableTransportFailure: true;
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
  const activeContextGraphs = new Set<string>();
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
      metadataExpiresAtMs: 0,
      retentionLease: options.retentionBudget.lease(),
    };
    states.set(contextGraphId, state);
    return state;
  };

  const hasRetainedMetadataPrefix = (state: SelectedSwmMetaContinuationState): boolean => (
    !state.completed
    && state.nextOffset > 0
    && state.quads.length > 0
  );

  const hasIncompleteSnapshotWalk = (state: SelectedSwmMetaContinuationState): boolean => {
    const walk = state.snapshotWalk;
    return state.completed
      && walk !== undefined
      && walk.orderedManifest.length > 0
      && walk.resolvedRefs.size < walk.orderedManifest.length;
  };

  const hasRetainedContinuation = (state: SelectedSwmMetaContinuationState): boolean => (
    hasRetainedMetadataPrefix(state) || hasIncompleteSnapshotWalk(state)
  );

  const retainedContinuationExpiry = (
    state: SelectedSwmMetaContinuationState,
  ): number | undefined => {
    if (hasRetainedMetadataPrefix(state)) return state.metadataExpiresAtMs;
    if (hasIncompleteSnapshotWalk(state)) return state.snapshotWalk?.expiresAtMs;
    return undefined;
  };

  const pruneExpiredStates = (): void => {
    for (const [contextGraphId, state] of states) {
      // This fetcher owns multiple Context Graphs for one peer. The
      // coordinator's timer is intentionally peer-wide, so enforce each CG's
      // independent TTL at every serialized fetch boundary and timer tick.
      // Completed/empty state keeps its existing outer-invocation lifecycle.
      const expiryAtMs = retainedContinuationExpiry(state);
      if (
        !activeContextGraphs.has(contextGraphId)
        && expiryAtMs !== undefined
        && expiryAtMs <= now()
      ) {
        release(contextGraphId, state);
        completedContextGraphs.delete(contextGraphId);
      }
    }
  };

  const retentionState = (): SelectedSwmMetaRetentionState => {
    const expiringInactiveStates = [...states.entries()]
      .filter(([contextGraphId, state]) => (
        !activeContextGraphs.has(contextGraphId)
        && hasRetainedContinuation(state)
      ));
    return {
      retained: states.size > 0,
      nextExpiryAtMs: expiringInactiveStates.length > 0
        ? Math.min(...expiringInactiveStates.flatMap(([, state]) => {
          const expiryAtMs = retainedContinuationExpiry(state);
          return expiryAtMs === undefined ? [] : [expiryAtMs];
        }))
        : undefined,
    };
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
        returnAcceptedPrefixOnRetryableTransportFailure: true,
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
        state.metadataExpiresAtMs = now() + retentionTtlMs;
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
        state.metadataExpiresAtMs = 0;
        state.snapshotWalk = undefined;
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
      pruneExpiredStates();
      const state = ensureState(request.contextGraphId);
      activeContextGraphs.add(request.contextGraphId);
      try {
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
      } finally {
        activeContextGraphs.delete(request.contextGraphId);
        pruneExpiredStates();
      }
    },
    release,
    snapshotWalk(contextGraphId, orderedManifest) {
      const state = states.get(contextGraphId);
      if (!state?.completed) {
        return {
          orderedManifest,
          resolvedRefs: new Set<string>(),
          suppressedMetadataRows: () => [],
          markResolved: () => {},
        };
      }
      const retainedWalk = state.snapshotWalk;
      const walk = retainedWalk && manifestsEqual(retainedWalk.orderedManifest, orderedManifest)
        ? retainedWalk
        : {
          orderedManifest: [...orderedManifest],
          resolvedRefs: new Set<string>(),
          suppressedMetadataRowsByRef: new Map<string, readonly Quad[]>(),
          expiresAtMs: 0,
        };
      state.snapshotWalk = walk;
      const allowedRefs = new Set(walk.orderedManifest.map((snapshot) => snapshot.ref));
      if (walk.orderedManifest.length > 0 && walk.resolvedRefs.size < walk.orderedManifest.length) {
        walk.expiresAtMs = now() + retentionTtlMs;
      }
      return {
        orderedManifest: walk.orderedManifest,
        resolvedRefs: walk.resolvedRefs,
        suppressedMetadataRows(ref: string) {
          return walk.suppressedMetadataRowsByRef.get(ref) ?? [];
        },
        markResolved(ref: string, suppressedMetadataRows: readonly Quad[] = []) {
          if (
            states.get(contextGraphId) !== state
            || state.snapshotWalk !== walk
            || !allowedRefs.has(ref)
            || walk.resolvedRefs.has(ref)
          ) return;
          walk.suppressedMetadataRowsByRef.set(
            ref,
            suppressedMetadataRows.map((quad) => ({ ...quad })),
          );
          walk.resolvedRefs.add(ref);
          if (walk.resolvedRefs.size < walk.orderedManifest.length) {
            walk.expiresAtMs = now() + retentionTtlMs;
          }
        },
      };
    },
  };

  const fetcher: SelectedSwmMetaFetcher = {
    strategy,
    continuation: (contextGraphId) => {
      const state = states.get(contextGraphId);
      return {
        progress: state?.nextOffset,
        generation: state?.generation ?? 0,
        completed: completedContextGraphs.has(contextGraphId),
      };
    },
  };
  selectedSwmMetaFetcherLifecycles.set(fetcher, {
    pruneExpiredPrefixes() {
      pruneExpiredStates();
      return retentionState();
    },
    settleOuterInvocation() {
      pruneExpiredStates();
      for (const [contextGraphId, state] of states) {
        // A completed manifest remains useful only while its exact snapshot
        // walk is incomplete. That lets later bounded reconciler invocations
        // skip refs already materialized instead of spending every slice
        // re-reading the same prefix. Full walks, zero-ref manifests and empty
        // metadata state have no resumable work and are released immediately.
        if (!hasRetainedContinuation(state)) {
          release(contextGraphId, state);
          completedContextGraphs.delete(contextGraphId);
        }
      }
      return retentionState();
    },
    cleanup() {
      for (const [contextGraphId, state] of states) release(contextGraphId, state);
      completedContextGraphs.clear();
    },
  });
  return fetcher;
}

function manifestsEqual(
  left: readonly PublicSnapshotMetadata[],
  right: readonly PublicSnapshotMetadata[],
): boolean {
  return left.length === right.length
    && left.every((snapshot, index) => {
      const candidate = right[index];
      return snapshot.ref === candidate.ref
        && snapshot.digest === candidate.digest
        && snapshot.count === candidate.count;
    });
}
