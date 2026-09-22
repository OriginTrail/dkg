// SPDX-License-Identifier: Apache-2.0

import {
  createAbortError,
  runBoundedOperation,
} from './bounded-operation.js';

interface ColdResolutionFlight {
  readonly key: string;
  readonly label: string;
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  readonly startedAtMs: number;
}

export interface FinalizedAuthorityColdResolutionReadOptions {
  /** Diagnostic label; the request deadline error carries it verbatim. */
  readonly label: string;
  /** This caller's deadline. Missing it fails THIS caller, never the flight. */
  readonly requestTimeoutMs: number;
  /** This caller's abort. Leaving fails THIS caller, never the flight. */
  readonly signal?: AbortSignal;
  /**
   * Budget for a flight this call starts. Defaults to the coordinator's cold
   * budget and is never applied below `requestTimeoutMs`, so a caller that
   * was explicitly allowed a long wait can never be cut short by the flight.
   */
  readonly coldTimeoutMs?: number;
}

export interface FinalizedAuthorityColdResolutionOptions {
  /** Read per flight so a reconfigured agent is honored without a rebuild. */
  readonly coldTimeoutMs: () => number;
  /** Test seam. */
  readonly now?: () => number;
}

/**
 * Detached single-flight owner for cold finalized Context Graph authority
 * resolutions.
 *
 * The chain reader's projection cache coalesces concurrent readers, but a
 * refresh is always the INITIATING caller's own read: when that caller's
 * request deadline aborts it, the refresh is abandoned, nothing is published,
 * and every retry repeats the full cold event-log walk. Slow public RPC
 * endpoints turned that into a 503 after exactly the request deadline on every
 * attempt.
 *
 * Here a resolution is started at most once per key while it is in flight,
 * under its OWN abort controller and the cold budget. Callers only WAIT on it,
 * each bounded by their own request deadline and abort signal. A caller that
 * times out receives the ordinary bounded-operation timeout (the fail-closed
 * `chain-access-policy-timeout` disposition) while the flight runs on; when it
 * completes without an abort, the chain reader has retained its projection and
 * the next request is answered from the snapshot without RPC. Concurrent and
 * retrying callers attach to the same flight instead of starting a second scan.
 *
 * Nothing is memoized here: authority is never retained as a time-based cache
 * at this layer. Only the in-flight promise is shared.
 */
export class FinalizedAuthorityColdResolutionV1 {
  readonly #flights = new Map<string, ColdResolutionFlight>();
  readonly #coldTimeoutMs: () => number;
  readonly #now: () => number;
  #closed = false;

  constructor(options: FinalizedAuthorityColdResolutionOptions) {
    this.#coldTimeoutMs = options.coldTimeoutMs;
    this.#now = options.now ?? Date.now;
  }

  /** Keys with a resolution currently in flight. */
  get inFlightKeys(): readonly string[] {
    return [...this.#flights.keys()];
  }

  /**
   * Await `key`'s resolution under this caller's request budget, starting it
   * when nothing is in flight. `start` receives the FLIGHT's signal, which
   * aborts only at the cold budget or on {@link close}.
   */
  read<T>(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    options: FinalizedAuthorityColdResolutionReadOptions,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(createAbortError(
        'finalized authority cold resolution is closed',
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError(options.signal.reason));
    }
    const flight = this.#flights.get(key) ?? this.#launch(key, start, options);
    // Only the WAIT is bounded by the request: the flight keeps its own
    // controller, so the timeout's internal abort reaches nothing.
    return runBoundedOperation(
      () => flight.promise as Promise<T>,
      {
        label: options.label,
        timeoutMs: options.requestTimeoutMs,
        signal: options.signal,
      },
    );
  }

  /** Settle after every flight in progress has completed or been aborted. */
  async whenIdle(): Promise<void> {
    for (;;) {
      const active = [...this.#flights.values()].map((flight) => flight.promise);
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  /** Abort every flight; later reads reject until {@link reopen}. */
  close(reason: unknown = createAbortError('finalized authority cold resolution closed')): void {
    this.#closed = true;
    for (const flight of this.#flights.values()) {
      if (!flight.controller.signal.aborted) flight.controller.abort(reason);
    }
  }

  reopen(): void {
    this.#closed = false;
  }

  #launch<T>(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    options: FinalizedAuthorityColdResolutionReadOptions,
  ): ColdResolutionFlight {
    const controller = new AbortController();
    const coldTimeoutMs = Math.max(
      options.coldTimeoutMs ?? this.#coldTimeoutMs(),
      options.requestTimeoutMs,
    );
    const promise = runBoundedOperation(start, {
      label: `${options.label} cold resolution`,
      timeoutMs: coldTimeoutMs,
      signal: controller.signal,
    });
    const flight: ColdResolutionFlight = {
      key,
      label: options.label,
      controller,
      promise,
      startedAtMs: this.#now(),
    };
    this.#flights.set(key, flight);
    const retire = () => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    };
    // Every waiter observes the settlement through its own bounded wait; the
    // flight itself must never surface as an unhandled rejection after the
    // last waiter has already left.
    promise.then(retire, retire);
    return flight;
  }
}
