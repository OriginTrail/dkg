import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type { GraphWriteRevisionSource } from '@origintrail-official/dkg-storage';
import { callerAbortReason, raceAgainstCallerAbort } from './caller-abort.js';

const DEFAULT_MAX_ENTRIES = 256;

export interface ScopedContentGraphDiscoveryMemoOptions {
  maxEntries?: number;
}

export interface ScopedContentGraphDiscoveryRequest {
  contentKey: string;
  laneKey: string;
  graphPrefix: string;
  signal?: AbortSignal;
  load: () => Promise<readonly string[]>;
}

/**
 * Revision-gated, lane-aware memo for authorization-sensitive graph discovery.
 * Completed and in-flight reuse is enabled only when the revision source
 * explicitly observes every writer that can mutate the live store. A local
 * generation cannot authorize reuse for an externally mutable SPARQL backend.
 */
export class ScopedContentGraphDiscoveryMemo {
  private readonly completed: BoundedLruCache<string, readonly string[]>;
  private readonly inFlight = new Map<string, Promise<readonly string[]>>();

  constructor(
    private readonly revisionSource: GraphWriteRevisionSource | null,
    options: ScopedContentGraphDiscoveryMemoOptions = {},
  ) {
    this.completed = new BoundedLruCache(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  get(request: ScopedContentGraphDiscoveryRequest): Promise<readonly string[]> {
    if (request.signal?.aborted) return Promise.reject(callerAbortReason(request.signal));
    if (this.revisionSource?.writeRevisionCoverage !== 'all-writers') {
      return raceAgainstCallerAbort(request.load(), request.signal);
    }

    const before = this.revisionSource.getWriteRevision(request.graphPrefix);
    if (!before.stable) return raceAgainstCallerAbort(request.load(), request.signal);

    const completedKey = JSON.stringify([request.contentKey, before.generation]);
    const cached = this.completed.get(completedKey);
    if (cached) return raceAgainstCallerAbort(Promise.resolve(cached), request.signal);

    const flightKey = JSON.stringify([
      request.contentKey,
      request.laneKey,
      before.generation,
    ]);
    const pending = this.inFlight.get(flightKey);
    if (pending) return raceAgainstCallerAbort(pending, request.signal);

    const promise = request.load().then((value) => {
      const after = this.revisionSource!.getWriteRevision(request.graphPrefix);
      if (after.stable && after.generation === before.generation) {
        const immutable = Object.freeze([...value]);
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
