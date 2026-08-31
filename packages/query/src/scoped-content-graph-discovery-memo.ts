import { performance } from 'node:perf_hooks';
import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type { GraphWriteRevisionSource } from '@origintrail-official/dkg-storage';

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_TTL_MS = 10_000;

export interface ScopedContentGraphDiscoveryMemoOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
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
  private readonly completed: BoundedLruCache<
    string,
    { validatedAt: number; value: readonly string[] }
  >;
  private readonly inFlight = new Map<string, Promise<readonly string[]>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly revisionSource: GraphWriteRevisionSource | null,
    options: ScopedContentGraphDiscoveryMemoOptions = {},
  ) {
    this.completed = new BoundedLruCache(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const configuredTtl = options.ttlMs ?? DEFAULT_TTL_MS;
    this.ttlMs = Number.isFinite(configuredTtl) ? Math.max(0, configuredTtl) : DEFAULT_TTL_MS;
    this.now = options.now ?? (() => performance.now());
  }

  get(request: ScopedContentGraphDiscoveryRequest): Promise<readonly string[]> {
    if (request.signal?.aborted) return Promise.reject(abortReason(request.signal));
    if (this.revisionSource?.writeRevisionCoverage !== 'all-writers') {
      return raceAgainstCallerAbort(request.load(), request.signal);
    }

    const before = this.revisionSource.getWriteRevision(request.graphPrefix);
    if (!before.stable) return raceAgainstCallerAbort(request.load(), request.signal);

    const completedKey = JSON.stringify([request.contentKey, before.generation]);
    const cached = this.completed.get(completedKey);
    if (cached && this.now() - cached.validatedAt < this.ttlMs) {
      return raceAgainstCallerAbort(Promise.resolve(cached.value), request.signal);
    }
    if (cached) this.completed.delete(completedKey);

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
        this.completed.set(completedKey, { validatedAt: this.now(), value: immutable });
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

function raceAgainstCallerAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}
