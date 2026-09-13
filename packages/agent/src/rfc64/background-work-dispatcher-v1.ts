// SPDX-License-Identifier: Apache-2.0

import {
  activeRpcRequestAbortSignal,
  withOwnedRpcRequestContext,
} from '@origintrail-official/dkg-chain';

interface KeyedBackgroundPassV1 {
  requested: boolean;
  run: Promise<void>;
  readonly work: (signal: AbortSignal) => Promise<void>;
}

export type Rfc64BackgroundWorkErrorHandlerV1 = (
  key: string,
  error: unknown,
) => void;

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
 * One agent-lifecycle owner for RFC-64 responsibility work that may reach chain RPC.
 *
 * Awaited reconciliation keeps its caller's request class; detached keyed
 * reconciliation establishes the background class here. Both receive the same
 * lifecycle signal and are physically drained on close.
 */
export class Rfc64BackgroundWorkDispatcherV1 {
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #keyed = new Map<string, KeyedBackgroundPassV1>();
  #lifecycle = new AbortController();
  #closed = false;

  constructor(
    private readonly onError: Rfc64BackgroundWorkErrorHandlerV1 = () => undefined,
  ) {}

  get shutdownSignal(): AbortSignal {
    return this.#lifecycle.signal;
  }

  runAwaited<T>(
    work: (signal: AbortSignal) => Promise<T>,
    ownerSignal?: AbortSignal,
  ): Promise<T> {
    return this.#run(false, work, ownerSignal);
  }

  /** Coalesce repeated state notifications into at most one follow-up pass. */
  scheduleKeyed(
    key: string,
    work: (signal: AbortSignal) => Promise<void>,
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
      work,
    };
    this.#keyed.set(key, state);
    this.#launchKeyed(key, state);
    return true;
  }

  #launchKeyed(key: string, state: KeyedBackgroundPassV1): void {
    const run = this.#run(true, async (signal) => {
      while (!signal.aborted && state.requested) {
        state.requested = false;
        try {
          await state.work(signal);
        } catch (error) {
          if (signal.aborted) return;
          this.onError(key, error);
        }
      }
    }, undefined).finally(() => {
      if (this.#keyed.get(key) !== state) return;
      // A notification can arrive after the runner observes requested=false
      // but before this settlement callback owns the keyed state. Hand that
      // accepted notification to a successor before releasing the key.
      if (!this.#closed && state.requested) {
        this.#launchKeyed(key, state);
        return;
      }
      this.#keyed.delete(key);
    });
    state.run = run;
    void run.catch(() => undefined);
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
    const operation = Promise.resolve(withOwnedRpcRequestContext({
      ...(background ? { requestClass: 'background' as const } : {}),
      signal,
    }, () => work(signal)));
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
    return tracked;
  }
}
