// SPDX-License-Identifier: Apache-2.0

import {
  AbortableKeyedSingleFlight,
  SingleFlightInvalidatedError,
} from './keyed-ttl-single-flight-cache.js';
import { RpcEndpointsExhaustedError } from './chain-rpc-transport-error.js';
import { errorMessage } from './evm-adapter-errors.js';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import { hostOnlyRpcText, rpcHost } from './rpc-failover-log.js';
import {
  activeRpcRequestAbortSignal,
  activeRpcRequestContext,
  withDetachedRpcRequestContext,
  withRpcRequestContext,
} from './rpc-request-transport.js';
import type { RpcRequestClass } from './rpc-request-transport.js';

/** What a chain adapter gives the initialization its callers share. */
export interface SharedAdapterInitializationHost {
  /** The adapter's RPC endpoints, for the error a failed run reports. */
  rpcUrls(): readonly string[];
  /** Whether the adapter's bindings are resolved. */
  isInitialized(): boolean;
  /** A run completed and nothing ended it meanwhile. */
  markInitialized(): void;
  /**
   * Resolve the bindings, then start the adapter-owned work in
   * `startsRequestClass`.
   */
  initContracts(startsRequestClass: RpcRequestClass): Promise<void>;
}

/**
 * The initialization every caller that finds a chain adapter uninitialized
 * waits for, instead of repeating its Hub reads. A caller leaves it under its
 * own cancellation; a reset of the bindings, or the adapter's destruction,
 * ends it for everyone.
 */
export class SharedAdapterInitialization {
  readonly #flight = new AbortableKeyedSingleFlight<'init', void>();

  /**
   * The progress observers of the callers waiting for the run that is out,
   * one entry for each caller so that a caller that leaves takes only its
   * own. A caller hears of the run's progress for as long as it waits and is
   * not cancelled: one that bounds inactivity keeps seeing a run that
   * advances.
   */
  readonly #observers = new Set<{
    readonly notify: () => void;
    readonly signal: AbortSignal | undefined;
  }>();

  /** Set by `destroy()`: the adapter is not initialized again. */
  #destroyed = false;

  constructor(private readonly host: SharedAdapterInitializationHost) {}

  /** Callers that are waiting with a progress observer. */
  get observerCount(): number {
    return this.#observers.size;
  }

  /** Resolves once the adapter is initialized, by a run this caller shares. */
  async ensure(): Promise<void> {
    while (!this.host.isInitialized()) {
      if (this.#destroyed) throw new Error('chain adapter was destroyed and is not initialized again');
      const starter = activeRpcRequestContext();
      const observer = starter.onProgress === undefined
        ? undefined
        : { notify: starter.onProgress, signal: starter.signal };
      if (observer !== undefined) this.#observers.add(observer);
      try {
        await this.#flight.run(
          'init',
          // The run belongs to the adapter and to nobody waiting for it: it
          // has its own signal and no caller's usage attribution, and it
          // reports progress to whoever is waiting at the time. It is
          // admitted in the foreground class, so no waiter is held at the
          // background rate, with the admission priority of the caller that
          // starts it, which is what that caller's own initialization had.
          // The starter also decides what it always did: the request class
          // of the long-running work initialization starts.
          (signal) => withDetachedRpcRequestContext('foreground', () => withRpcRequestContext(
            {
              signal,
              onProgress: () => this.reportProgress(),
              ...(starter.admissionPriority === undefined
                ? {}
                : { admissionPriority: starter.admissionPriority }),
            },
            () => this.#run(starter.requestClass),
          )),
          starter.signal,
          () => this.host.markInitialized(),
          'chain adapter initialization has no active waiters',
        );
      } catch (error) {
        // A reset ended the run this caller was waiting for. The next run
        // resolves the bindings as the Hub has them now.
        if (error instanceof SingleFlightInvalidatedError && error.retryable) continue;
        throw error;
      } finally {
        if (observer !== undefined) this.#observers.delete(observer);
      }
    }
  }

  /** What the run does when one of its requests has succeeded. */
  reportProgress(): void {
    for (const observer of this.#observers) {
      // As for a request of its own: a cancelled caller hears nothing more.
      if (observer.signal?.aborted) continue;
      try { observer.notify(); } catch { /* an observer cannot change the run */ }
    }
  }

  /**
   * The bindings were reset. A run that is out resolved some of them before
   * the reset, so it is ended: its reads are cancelled, it binds and starts
   * nothing more, and the callers waiting for it wait for the next one.
   */
  rearm(): void {
    this.#flight.invalidate('init', 'chain adapter bindings were reset', { retryable: true });
  }

  /** The adapter was destroyed: the run that is out ends and none follows. */
  destroy(): void {
    this.#destroyed = true;
    this.#flight.invalidateAll('chain adapter destroyed');
  }

  async #run(startsRequestClass: RpcRequestClass): Promise<void> {
    try {
      await this.host.initContracts(startsRequestClass);
    } catch (err) {
      // A run that was ended reports why it was ended, not what its
      // interrupted read made of that.
      activeRpcRequestAbortSignal()?.throwIfAborted();
      // Initialization sits on the critical path of every chain write
      // (`createOnChainContextGraph`, publish, verify, …). If the Hub lookups
      // fail because the configured RPC endpoint(s) are exhausted (perpetual
      // 429 / unreachable), surface the same `RPC_ENDPOINTS_EXHAUSTED` contract
      // the tx-send path uses, so callers (e.g. `/api/context-graph/register`
      // → `classifyRegisterContextGraphError`) map it to a bounded 503 instead
      // of a generic 500 — and never hang waiting on it (#894 follow-up). A
      // non-RPC error (e.g. a genuine "contract not in Hub" misconfig) keeps
      // its original shape.
      if (classifyRpcRetryDisposition(err) === 'failover') {
        const rpcUrls = this.host.rpcUrls();
        throw new RpcEndpointsExhaustedError(
          `chain initialisation failed on all configured RPC endpoints (${rpcUrls.map(rpcHost).join(', ')}): ${hostOnlyRpcText(errorMessage(err))}`,
          { cause: err, rpcUrls },
        );
      }
      throw err;
    }
  }
}

/**
 * How an initialization run writes a binding. A run that was ended binds
 * nothing more, whatever a read it had out still answers: the bindings belong
 * to the run that follows it. The check and the write are one step.
 */
export function initializationBinder<C extends object>(
  bindings: C,
): <K extends keyof C>(key: K, binding: C[K]) => void {
  const signal = activeRpcRequestAbortSignal();
  return (key, binding) => {
    signal?.throwIfAborted();
    bindings[key] = binding;
  };
}
