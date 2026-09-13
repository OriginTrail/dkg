// SPDX-License-Identifier: Apache-2.0

import {
  activeRpcRequestAbortSignal,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';

interface KeyedBackgroundPassV1 {
  requested: boolean;
  run: Promise<void>;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'RFC-64 background work aborted',
  );
  error.name = 'AbortError';
  return error;
}

/**
 * One agent-lifecycle owner for detached RFC-64 work that may reach chain RPC.
 *
 * Awaited operations keep their caller's request class; scheduled operations
 * establish the background class here, rather than at scattered call sites.
 * Both receive the same lifecycle signal and are physically drained on close.
 */
export class Rfc64BackgroundWorkDispatcherV1 {
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #keyed = new Map<string, KeyedBackgroundPassV1>();
  #lifecycle = new AbortController();
  #closed = false;

  get shutdownSignal(): AbortSignal {
    return this.#lifecycle.signal;
  }

  runAwaited<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    return this.#run(false, work, ownerSignal);
  }

  runBackground<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    return this.#run(true, work, ownerSignal);
  }

  /** Coalesce repeated state notifications into at most one follow-up pass. */
  scheduleKeyed(
    key: string,
    work: (signal: AbortSignal) => Promise<void>,
    onError: (error: unknown) => void,
  ): boolean {
    if (this.#closed) return false;
    const existing = this.#keyed.get(key);
    if (existing !== undefined) {
      existing.requested = true;
      return true;
    }
    const state: KeyedBackgroundPassV1 = {
      requested: true,
      run: Promise.resolve(),
    };
    this.#keyed.set(key, state);
    const run = this.runBackground(async (signal) => {
      while (!signal.aborted && state.requested) {
        state.requested = false;
        try {
          await work(signal);
        } catch (error) {
          if (signal.aborted) return;
          onError(error);
        }
      }
    }).finally(() => {
      if (this.#keyed.get(key) === state) this.#keyed.delete(key);
    });
    state.run = run;
    void run.catch(() => undefined);
    return true;
  }

  async whenIdle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled(this.#inFlight);
    }
  }

  async closeAndDrain(): Promise<void> {
    this.#closed = true;
    if (!this.#lifecycle.signal.aborted) {
      this.#lifecycle.abort(abortError('RFC-64 background dispatcher is closing'));
    }
    await this.whenIdle();
    this.#keyed.clear();
  }

  reopen(): void {
    if (!this.#closed) return;
    if (this.#inFlight.size > 0) {
      throw new Error('RFC-64 background dispatcher cannot reopen before drain');
    }
    this.#lifecycle = new AbortController();
    this.#closed = false;
  }

  #run<T>(
    background: boolean,
    work: (signal: AbortSignal) => Promise<T>,
    ownerSignal: AbortSignal | undefined,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(abortError(this.#lifecycle.signal.reason));
    }
    // Awaited work belongs to its ambient caller; detached background work
    // belongs only to its explicit owner (when present) and this lifecycle.
    // Build the effective signal before entering the context so the work
    // callback and transports that consume its explicit signal observe the
    // same cancellation boundary.
    const signals = [
      this.#lifecycle.signal,
      ownerSignal,
      background ? undefined : activeRpcRequestAbortSignal(),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const uniqueSignals = [...new Set(signals)];
    const signal = uniqueSignals.length === 1
      ? uniqueSignals[0]
      : AbortSignal.any(uniqueSignals);
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    const operation = Promise.resolve(withRpcRequestContext({
      ...(background ? { requestClass: 'background' as const } : {}),
      signal,
      inheritSignal: false,
    }, () => work(signal)));
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
    return tracked;
  }
}
