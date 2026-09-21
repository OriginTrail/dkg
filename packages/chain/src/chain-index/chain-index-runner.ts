// SPDX-License-Identifier: Apache-2.0

import type { ChainIndexTick, ChainIndexTickResult } from './chain-index-tick.js';

/** Backoff ceiling for a scope whose ticks keep failing (review C8). */
const MAX_TICK_BACKOFF_MULTIPLIER = 16;

/**
 * Consecutive QUIET passes before the loop lengthens its own period.
 *
 * Not one: a single empty pass is the normal case between two blocks that
 * happened to carry nothing for this node, and reacting to it would make the
 * period oscillate for no reason. Three is long enough that the scope is
 * genuinely doing nothing and short enough that a node left idle overnight
 * spends almost all of that night at the widened period.
 */
const IDLE_TICKS_BEFORE_BACKOFF = 3;

/**
 * The fraction of the readers' freshness budget the idle period may consume.
 *
 * The widened period is what decides how old `cursor.head` can be when a
 * reader arrives, and a head past the budget is REFUSED — the reader falls
 * back to the live chain read this loop exists to replace. Backing off past
 * the budget would therefore RAISE physical demand, so the ceiling keeps a
 * third of it in hand for the pass's own duration and for wall-clock skew.
 */
const IDLE_BACKOFF_BUDGET_NUMERATOR = 2;
const IDLE_BACKOFF_BUDGET_DENOMINATOR = 3;

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
  /**
   * How old the head this loop stores may become before its READERS stop
   * answering from it — `resolveContextGraphAuthorityIndexStaleMs(T)`, the
   * same number the projection cache and the anchor resolver are built from.
   *
   * Supplying it lets a scope that is observing nothing lengthen its period
   * instead of re-reading an unchanging chain every T. Omitting it keeps the
   * flat period, so a caller that cannot state the contract cannot silently
   * opt into a staler one.
   */
  readonly idleHeadAgeBudgetMs?: number;
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
 *
 * THE PERIOD IS NOT FIXED. A flat T meant an idle node paid the same head and
 * lineage reads per minute as a busy one, forever — on a measured six-node
 * devnet the loop was more than half of all traffic while nothing whatsoever
 * was happening. So a scope that keeps observing nothing widens its own
 * period, and a scope that observes anything returns to T on the very next
 * pass. The widening is bounded by {@link
 * ChainIndexRunnerOptions.idleHeadAgeBudgetMs} rather than by a constant,
 * because the cost of getting it wrong is not staleness — it is the readers
 * refusing this loop's head and going to the chain themselves, which is
 * strictly more expensive than the passes the backoff skipped.
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
  #consecutiveQuietTicks = 0;

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
    this.#consecutiveQuietTicks = 0;
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

  /**
   * A pass that learned nothing this node had to store.
   *
   * `outcome: 'idle'` alone is the wrong test. It means the HEAD did not move,
   * which on a 2s-block chain essentially never happens — the loop would keep
   * its shortest period forever on exactly the chains whose demand matters
   * most. The quiet case that actually dominates an idle node is a head that
   * ADVANCED while carrying nothing for this node's addresses and topics.
   *
   * Every other outcome is excluded on purpose: `endpoint-lagging`,
   * `fork-suspected`, `tombstoned` and `cas-lost` all describe a scope that is
   * in trouble or contended, and none of them may be allowed to look like
   * quiet and slow the loop down while it is trying to converge.
   */
  static #isQuiet(result: ChainIndexTickResult): boolean {
    if (result.outcome !== 'advanced' && result.outcome !== 'idle') return false;
    return (result.fetchedRows ?? 0) === 0;
  }

  /**
   * How many periods a quiet scope may wait, bounded by the readers' contract.
   *
   * Derived rather than configured: the one thing that must never happen is a
   * period so wide that `cursor.head` ages past what the projection cache and
   * the anchor resolver accept, because their refusal is a fall back to the
   * live read — which costs MORE than the pass this was trying to skip.
   */
  #idleBackoffMultiplier(): number {
    const budgetMs = this.#options.idleHeadAgeBudgetMs;
    if (budgetMs === undefined
      || !Number.isSafeInteger(budgetMs)
      || budgetMs < 1) return 1;
    if (this.#consecutiveQuietTicks < IDLE_TICKS_BEFORE_BACKOFF) return 1;
    const spendableMs = Math.floor(
      (budgetMs * IDLE_BACKOFF_BUDGET_NUMERATOR) / IDLE_BACKOFF_BUDGET_DENOMINATOR,
    );
    return Math.max(1, Math.floor(spendableMs / this.#options.intervalMs));
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
      // Reset on the FIRST row: a scope that just learned something is a scope
      // whose next pass must be at the full rate, not one widened period later.
      this.#consecutiveQuietTicks = ChainIndexRunner.#isQuiet(result)
        ? this.#consecutiveQuietTicks + 1
        : 0;

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
        // A backfill still producing rows means the scope has not converged,
        // whatever the head passes look like. Hold the full rate until it has.
        if (!ChainIndexRunner.#isQuiet(backfill)) this.#consecutiveQuietTicks = 0;
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      this.#consecutiveFailures += 1;
      // A pass that threw learned nothing, which is not the same as a chain
      // with nothing to learn. Failure owns the period here; letting a throw
      // also count as quiet would compound the two backoffs.
      this.#consecutiveQuietTicks = 0;
      this.#options.onError?.(error);
    } finally {
      // Exponential backoff on a failing scope, so a cold edge that cannot
      // reach an endpoint does not re-request every T forever.
      const failureMultiplier = Math.min(
        MAX_TICK_BACKOFF_MULTIPLIER,
        2 ** Math.max(0, this.#consecutiveFailures - 1),
      );
      // A quiet scope waits longer too, but only ever within the freshness
      // budget its readers hold it to. `max` because a failing scope must keep
      // the wider of the two: idleness never shortens a failure's backoff.
      const multiplier = Math.max(failureMultiplier, this.#idleBackoffMultiplier());
      this.#schedule(this.#options.intervalMs * multiplier);
    }
  }
}
