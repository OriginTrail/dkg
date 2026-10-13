import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type { GraphWriteRevisionSource } from '@origintrail-official/dkg-storage';
import { callerAbortReason, raceAgainstCallerAbort } from './caller-abort.js';

const DEFAULT_MAX_ENTRIES = 256;

export interface ScopedContentGraphDiscoveryMemoOptions {
  maxEntries?: number;
}

export interface ScopedContentGraphDiscoverySnapshot {
  readonly inventory: readonly string[];
  readonly subGraphs: readonly string[];
  readonly assertionGraphs: readonly string[];
  readonly childContextGraphs: readonly string[];
}

export interface ScopedContentGraphDiscoveryRequest {
  contextKey: string;
  laneKey: string;
  graphPrefix: string;
  signal?: AbortSignal;
  load: () => Promise<ScopedContentGraphDiscoverySnapshot>;
}

/**
 * Revision-gated, lane-aware memo for authorization-sensitive graph discovery.
 * Completed and in-flight reuse is enabled only when the revision source
 * explicitly observes every writer that can mutate the live store. A local
 * generation cannot authorize reuse for an externally mutable SPARQL backend.
 */
export class ScopedContentGraphDiscoveryMemo {
  private readonly completed: BoundedLruCache<string, ScopedContentGraphDiscoverySnapshot>;
  private readonly inFlight = new Map<string, Promise<ScopedContentGraphDiscoverySnapshot>>();

  constructor(
    private readonly revisionSource: GraphWriteRevisionSource | null,
    options: ScopedContentGraphDiscoveryMemoOptions = {},
  ) {
    this.completed = new BoundedLruCache(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  get(request: ScopedContentGraphDiscoveryRequest): Promise<ScopedContentGraphDiscoverySnapshot> {
    if (request.signal?.aborted) return Promise.reject(callerAbortReason(request.signal));
    if (this.revisionSource?.writeRevisionCoverage !== 'all-writers') {
      return raceAgainstCallerAbort(request.load(), request.signal);
    }

    const before = this.revisionSource.getWriteRevision(request.graphPrefix);
    if (!before.stable) return raceAgainstCallerAbort(request.load(), request.signal);

    const completedKey = JSON.stringify([request.contextKey, before.generation]);
    const cached = this.completed.get(completedKey);
    if (cached) return raceAgainstCallerAbort(Promise.resolve(cached), request.signal);

    const flightKey = JSON.stringify([
      request.contextKey,
      request.laneKey,
      before.generation,
    ]);
    const pending = this.inFlight.get(flightKey);
    if (pending) return raceAgainstCallerAbort(pending, request.signal);

    const promise = request.load().then((value) => {
      const after = this.revisionSource!.getWriteRevision(request.graphPrefix);
      if (after.stable && after.generation === before.generation) {
        const immutable = Object.freeze({
          inventory: Object.freeze([...value.inventory]),
          subGraphs: Object.freeze([...value.subGraphs]),
          assertionGraphs: Object.freeze([...value.assertionGraphs]),
          childContextGraphs: Object.freeze([...value.childContextGraphs]),
        });
        this.completed.set(completedKey, immutable);
        return immutable;
      }
      return value;
    });
    this.inFlight.set(flightKey, promise);
    void promise.finally(() => {
      if (this.inFlight.get(flightKey) === promise) this.inFlight.delete(flightKey);
    }).catch(() => undefined);
    return raceAgainstCallerAbort(promise, request.signal);
  }
}
