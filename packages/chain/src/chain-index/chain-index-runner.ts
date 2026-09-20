// SPDX-License-Identifier: Apache-2.0

import type { ChainIndexTick, ChainIndexTickResult } from './chain-index-tick.js';

/** Backoff ceiling for a scope whose ticks keep failing (review C8). */
const MAX_TICK_BACKOFF_MULTIPLIER = 16;

/**
 * Ticks between backfill pages when nothing says otherwise.
 *
 * One page after EVERY tick contradicted this file's own reason for keeping
 * them apart: it made the steady-state cost two `eth_getLogs` per pass for the
 * whole life of the backfill, not one.
 */
const DEFAULT_BACKFILL_EVERY_TICKS = 10;

export interface ChainIndexRunnerOptions {
  /** `chain.indexTickMs` (T). The same T every staleness bound is derived from. */
  readonly intervalMs: number;
  /**
   * How many ticks pass between bounded backfill pages. History is not urgent;
   * a fresh head is. Keeping them apart is what keeps the per-tick cost flat.
   * Defaults to {@link DEFAULT_BACKFILL_EVERY_TICKS}.
   */
  readonly backfillEveryTicks?: number;
  readonly onResult?: (result: ChainIndexTickResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The ONE background loop. It runs on every role.
 *
 * Before this, an edge node had no loop at all: the readers WERE the scanner,
 * so the node's RPC demand scaled with how often anything asked a question
 * rather than with how often the chain changed. One tick per T replaces that,
 * and every reader becomes a local read of what the tick already stored.
 *
 * Self-scheduling rather than `setInterval`: a tick that takes longer than T
 * must not queue a second one behind it, because two passes racing on the same
 * cursor just lose the CAS and repeat each other's requests.
 */
export class ChainIndexRunner {
  readonly #options: ChainIndexRunnerOptions;
  readonly #setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #inFlight: Promise<void> | undefined;
  #consecutiveFailures = 0;
  #ticksSinceBackfill = 0;

  constructor(
    private readonly tick: ChainIndexTick,
    options: ChainIndexRunnerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new Error('chain.indexTickMs must be a positive integer');
    }
    this.#options = options;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle); });
  }

  get started(): boolean {
    return this.#abort !== undefined;
  }

  start(): void {
    if (this.#abort !== undefined) return;
    this.#abort = new AbortController();
    this.#consecutiveFailures = 0;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    const abort = this.#abort;
    this.#abort = undefined;
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    abort?.abort(new DOMException('Chain index runner stopped', 'AbortError'));
    await this.#inFlight?.catch(() => undefined);
  }

  #schedule(delayMs: number): void {
    if (this.#abort === undefined) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#inFlight = this.#pass().finally(() => { this.#inFlight = undefined; });
    }, delayMs);
    // A node's chain index must never be the reason a process refuses to exit.
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #pass(): Promise<void> {
    const abort = this.#abort;
    if (abort === undefined) return;
    try {
      const result = await this.tick.runOnce(abort.signal);
      this.#options.onResult?.(result);
      this.#consecutiveFailures = 0;

      const configured = this.#options.backfillEveryTicks;
      const everyTicks = configured !== undefined
        && Number.isSafeInteger(configured)
        && configured >= 1
        ? configured
        : DEFAULT_BACKFILL_EVERY_TICKS;
      this.#ticksSinceBackfill += 1;
      if (this.#ticksSinceBackfill >= everyTicks) {
        this.#ticksSinceBackfill = 0;
        const backfill = await this.tick.backfillOnce(abort.signal);
        this.#options.onResult?.(backfill);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#consecutiveFailures += 1;
      this.#options.onError?.(error);
    } finally {
      // Exponential backoff on a failing scope, so a cold edge that cannot
      // reach an endpoint does not re-request every T forever.
      const multiplier = Math.min(
        MAX_TICK_BACKOFF_MULTIPLIER,
        2 ** Math.max(0, this.#consecutiveFailures - 1),
      );
      this.#schedule(this.#options.intervalMs * multiplier);
    }
  }
}
