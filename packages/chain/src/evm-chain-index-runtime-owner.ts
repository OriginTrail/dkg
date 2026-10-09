// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogBinding } from './chain-event-log-binding.js';
import type { ChainEventLogStore } from './chain-index/chain-event-log.js';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import type { EvmChainIndexRuntime } from './evm-chain-index-runtime.js';
import { hostOnlyRpcText } from './rpc-failover-log.js';

/** Wait before the second attempt of a deferred start; doubles up to the cap. */
export const CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS = 5_000;
/** Longest wait between two attempts of a deferred start. */
export const CHAIN_INDEX_START_RETRY_MAX_DELAY_MS = 60_000;

/** One line per outcome of a start; never one per attempt. */
export interface EvmChainIndexStartReport {
  /** The start failed and is not retried: the adapter keeps every pre-log path. */
  disabled(error: unknown): void;
  /** The first attempt was refused for now; the start is retried until it settles. */
  deferred(error: unknown, retryInMs: number): void;
  /** The runtime attached after a deferred start. */
  started(attempts: number, deferredForMs: number): void;
}

export interface EvmChainIndexRuntimeOwnerOptions {
  readonly report?: EvmChainIndexStartReport;
  /** A failure worth another attempt later, as opposed to one that ends the start. */
  readonly isRetryLater?: (error: unknown) => boolean;
  readonly retryInitialDelayMs?: number;
  readonly retryMaxDelayMs?: number;
}

const failureText = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const consoleStartReport: EvmChainIndexStartReport = {
  disabled(error) {
    console.warn(`[chain] one-log chain index disabled: ${failureText(error)}`);
  },
  deferred(error, retryInMs) {
    console.warn(
      `[chain] one-log chain index start deferred (retrying, next attempt in ${retryInMs / 1_000}s): `
        + hostOnlyRpcText(failureText(error)),
    );
  },
  started(attempts, deferredForMs) {
    console.log(
      `[chain] one-log chain index started on attempt ${attempts}, `
        + `${Math.round(deferredForMs / 1_000)}s after its start was deferred`,
    );
  },
};

/**
 * Owns the process-wide one-log runtime lifecycle for an adapter.
 *
 * Construction inputs still come from the adapter because it resolves Hub
 * contracts and transport. Everything mutable about the runtime itself lives
 * here: its durable-store eligibility, single-flight start, generation fence,
 * attached binding, rotation retirement, and shutdown.
 *
 * A start can be refused for now rather than fail: its reads wait in the
 * process's own RPC admission queue, and a read that is not admitted before its
 * deadline says nothing about the chain. Such a start is retried here, on a
 * capped backoff, until the runtime attaches, the owner stops, or a rotation
 * retires the generation. Without that the node would run without its log for
 * the life of the process, because nothing else starts it again.
 */
export class EvmChainIndexRuntimeOwner {
  readonly #store: ChainEventLogStore | undefined;
  readonly #report: EvmChainIndexStartReport;
  readonly #isRetryLater: (error: unknown) => boolean;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaxDelayMs: number;
  #binding: ChainEventLogBinding | undefined;
  #runtime: EvmChainIndexRuntime | undefined;
  #starting: Promise<void> | undefined;
  #generation = 0;
  /** Ends the wait before the next attempt of a deferred start. */
  #endRetryWait: (() => void) | undefined;

  constructor(
    store: ChainEventLogStore | undefined,
    options: EvmChainIndexRuntimeOwnerOptions = {},
  ) {
    this.#store = store;
    this.#report = options.report ?? consoleStartReport;
    this.#isRetryLater = options.isRetryLater
      ?? ((error) => classifyRpcRetryDisposition(error) === 'retry-later');
    this.#retryInitialDelayMs = options.retryInitialDelayMs
      ?? CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? CHAIN_INDEX_START_RETRY_MAX_DELAY_MS;
  }

  get binding(): ChainEventLogBinding | undefined {
    return this.#binding;
  }

  /** Exposed only so lifecycle tests can await the detached start precisely. */
  get starting(): Promise<void> | undefined {
    return this.#starting;
  }

  /** Exposed only so lifecycle tests can assert that store-less adapters stay idle. */
  get runtime(): EvmChainIndexRuntime | undefined {
    return this.#runtime;
  }

  /** Attach or clear a binding supplied from outside this owner. */
  attach(binding: ChainEventLogBinding | undefined): void {
    this.#binding = binding;
  }

  /**
   * Build once without blocking the caller. The builder is invoked
   * synchronously up to its first await, so callers can close over a snapshot
   * of the Hub-resolved contracts before a concurrent rotation mutates them.
   *
   * A deferred start calls the same builder again. Its snapshot stays the
   * right one for as long as the generation does: every rotation that moves
   * an indexed contract retires the generation first.
   */
  start(build: (store: ChainEventLogStore) => Promise<EvmChainIndexRuntime>): void {
    const store = this.#store;
    if (store === undefined || this.#starting !== undefined) return;
    const generation = ++this.#generation;
    this.#starting = this.#startUntilSettled(store, build, generation);
  }

  async #startUntilSettled(
    store: ChainEventLogStore,
    build: (store: ChainEventLogStore) => Promise<EvmChainIndexRuntime>,
    generation: number,
  ): Promise<void> {
    let deferredAtMs: number | undefined;
    let retryInMs = this.#retryInitialDelayMs;
    for (let attempt = 1; ; attempt += 1) {
      let runtime: EvmChainIndexRuntime;
      try {
        runtime = await build(store);
      } catch (error: unknown) {
        if (!this.#isRetryLater(error)) return this.#disable(error, generation);
        // A retired generation has nothing left to retry, and nothing was
        // disabled: whoever retired it starts the next one.
        if (generation !== this.#generation) return;
        if (deferredAtMs === undefined) {
          deferredAtMs = Date.now();
          this.#report.deferred(error, retryInMs);
        }
        await this.#waitBeforeRetry(retryInMs);
        if (generation !== this.#generation) return;
        retryInMs = Math.min(retryInMs * 2, this.#retryMaxDelayMs);
        continue;
      }
      try {
        if (generation !== this.#generation) {
          await runtime.stop();
          return;
        }
        this.#runtime = runtime;
        // Attach before scheduling the first pass. Empty coverage makes this
        // safe, and readers arriving in between do not fall back needlessly.
        this.#binding = runtime.binding;
        runtime.start();
      } catch (error: unknown) {
        return this.#disable(error, generation);
      }
      if (deferredAtMs !== undefined) this.#report.started(attempt, Date.now() - deferredAtMs);
      return;
    }
  }

  /** End the start on a failure that is not retried, and say so. */
  #disable(error: unknown, generation: number): void {
    if (generation === this.#generation) this.#starting = undefined;
    this.#report.disabled(error);
  }

  /** Resolves when the delay has passed, or at once when the owner moves on. */
  #waitBeforeRetry(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const end = (): void => {
        clearTimeout(timer);
        this.#endRetryWait = undefined;
        resolve();
      };
      const timer = setTimeout(end, delayMs);
      // A pending retry must not keep a process alive that is otherwise done.
      timer.unref?.();
      this.#endRetryWait = end;
    });
  }

  /** Retire an owned runtime after an indexed Hub binding rotates. */
  rebuild(): void {
    if (this.#store === undefined) return;
    this.#generation += 1;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#starting = undefined;
    this.#binding = undefined;
    this.#endRetryWait?.();
    void runtime?.stop().catch(() => undefined);
  }

  /** Disown in-flight construction and stop the current runtime. */
  stop(): void {
    this.#generation += 1;
    void this.#runtime?.stop().catch(() => undefined);
    this.#runtime = undefined;
    this.#starting = undefined;
    this.#binding = undefined;
    this.#endRetryWait?.();
  }
}
