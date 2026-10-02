// SPDX-License-Identifier: Apache-2.0

import type { ChainEventLogBinding } from './chain-event-log-binding.js';
import type { ChainEventLogStore } from './chain-index/chain-event-log.js';
import type { EvmChainIndexRuntime } from './evm-chain-index-runtime.js';

/**
 * Owns the process-wide one-log runtime lifecycle for an adapter.
 *
 * Construction inputs still come from the adapter because it resolves Hub
 * contracts and transport. Everything mutable about the runtime itself lives
 * here: its durable-store eligibility, single-flight start, generation fence,
 * attached binding, rotation retirement, and shutdown.
 */
export class EvmChainIndexRuntimeOwner {
  readonly #store: ChainEventLogStore | undefined;
  readonly #onError: (error: unknown) => void;
  #binding: ChainEventLogBinding | undefined;
  #runtime: EvmChainIndexRuntime | undefined;
  #starting: Promise<void> | undefined;
  #generation = 0;

  constructor(
    store: ChainEventLogStore | undefined,
    onError: (error: unknown) => void,
  ) {
    this.#store = store;
    this.#onError = onError;
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
   */
  start(build: (store: ChainEventLogStore) => Promise<EvmChainIndexRuntime>): void {
    const store = this.#store;
    if (store === undefined || this.#starting !== undefined) return;
    const generation = ++this.#generation;
    this.#starting = (async () => {
      const runtime = await build(store);
      if (generation !== this.#generation) {
        await runtime.stop();
        return;
      }
      this.#runtime = runtime;
      // Attach before scheduling the first pass. Empty coverage makes this
      // safe, and readers arriving in between do not fall back needlessly.
      this.#binding = runtime.binding;
      runtime.start();
    })().catch((error: unknown) => {
      if (generation === this.#generation) this.#starting = undefined;
      this.#onError(error);
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
    void runtime?.stop().catch(() => undefined);
  }

  /** Disown in-flight construction and stop the current runtime. */
  stop(): void {
    this.#generation += 1;
    void this.#runtime?.stop().catch(() => undefined);
    this.#runtime = undefined;
    this.#starting = undefined;
    this.#binding = undefined;
  }
}
