/**
 * The parts of a queue retention sweep that do not depend on the queue (OT-RFC-73 P10a/P11): the tunables and their bounds, the clock guard, the hold
 * budget with its adaptive slice size, the overlap guard, the logger and the validators. The share sweep (async-promote-retention.ts) and the publisher sweep
 * (async-lift-retention.ts) are built on it, so a change to how a tick is guarded or how a hold is timed is one change and both queues keep the same
 * result, counter and gauge vocabulary for the periodic line.
 *
 * Nothing here touches a store or knows a job: a sweep gives it clocks, durations and counts, and it answers with a verdict or a number.
 */
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

/** `off` does nothing, `report` judges and counts what `delete` would remove and removes nothing, `delete` removes it. */
export const RETENTION_MODES = Object.freeze(['off', 'report', 'delete'] as const);
export type RetentionMode = (typeof RETENTION_MODES)[number];

/** The D-6 window of both queues: a deletable job leaves 7 days after it finished. */
export const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const RETENTION_SWEEP_DEFAULTS = Object.freeze({
  /** Most candidate rows one batch judges. */
  batchSize: 100,
  /** The hard maximum of `batchSize`: one scan reads, and one pass of holds judges, at most this many rows. */
  maxBatchSize: 1000,
  /** Most jobs verified and deleted under ONE hold of the queue lock (the lock is released between slices). */
  sliceSize: 10,
  /** The time one hold of the lock may take: the slice size adapts to it, and no delete starts that would take the hold past it. */
  holdBudgetMs: 50,
  /** The hard maximum of the hold budget and of the slice size. */
  maxHoldBudgetMs: 50,
  maxSliceSize: 100,
  /** The floor of every retention window (24 h): a misconfiguration cannot shrink the D-6 window of 7 days to minutes. */
  minWindowMs: 24 * 60 * 60 * 1000,
  /** Safety net: every this many ms (once a pass has reached the end) the scan restarts from the oldest row. */
  rescanIntervalMs: 3_600_000,
  /** A tick is skipped when the wall clock has run ahead of the monotonic clock by more than this many intervals since the last tick that ran. */
  clockGuardFactor: 3,
});

export type RetentionSkip = 'off' | 'overlap' | 'clock_invalid' | 'clock_backwards' | 'clock_jump';
export const RETENTION_SKIPS: readonly RetentionSkip[] = ['off', 'overlap', 'clock_invalid', 'clock_backwards', 'clock_jump'];

export interface RetentionLogger { info(message: string): void; warn(message: string): void }

/** The sweep's own logger unless the caller passed one; created on first use so importing the module opens nothing. */
export function lazyRetentionLogger(name: string): () => RetentionLogger {
  let logger: RetentionLogger | undefined;
  return () => logger ??= (() => {
    const log = new Logger(name);
    return { info: (message: string) => log.info(createOperationContext('system'), message), warn: (message: string) => log.warn(createOperationContext('system'), message) };
  })();
}

export const errorMessage = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 200);

export const sumInto = <K extends string>(into: Record<K, number>, from: Readonly<Partial<Record<K, number>>>): void => { for (const key of Object.keys(from) as K[]) into[key] += from[key] ?? 0; };

// ---------------------------------------------------------------------------------------------------------------------------------------
// Validators (the messages are part of the sweeps' contract: the tests and the operator read them)
// ---------------------------------------------------------------------------------------------------------------------------------------

export const positiveFinite = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
};

export const boundedInteger = (value: unknown, name: string, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) throw new Error(`${name} must be a positive integer of at most ${max}`);
  return value as number;
};

/** A retention window: positive, finite and at least `minWindowMs` (24 h). */
export const ageWindowMs = (value: unknown, name: string): number => {
  const ms = positiveFinite(value, name);
  if (ms < RETENTION_SWEEP_DEFAULTS.minWindowMs) throw new Error(`${name} must be at least ${RETENTION_SWEEP_DEFAULTS.minWindowMs} ms (24 hours)`);
  return ms;
};

// ---------------------------------------------------------------------------------------------------------------------------------------
// Overlap guard
// ---------------------------------------------------------------------------------------------------------------------------------------

const activeBatches = new WeakMap<TripleStore, Set<string>>();

/**
 * Batches of one store and graph never overlap, even across two sweep objects: their cursors and the lock holds would otherwise interleave. Returns the
 * release function, or undefined when a batch of this store and graph is already running.
 */
export function claimBatch(store: TripleStore, graphUri: string): (() => void) | undefined {
  const running = activeBatches.get(store) ?? activeBatches.set(store, new Set()).get(store)!;
  if (running.has(graphUri)) return undefined;
  running.add(graphUri);
  return () => { running.delete(graphUri); };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Clock guard
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * The wall clock decides which jobs are old enough, so a clock that stepped back or leapt forward must not be trusted for a tick. A tick is skipped when
 *  - `now` is earlier than the start of the last tick that ran (`clock_backwards`), or
 *  - the wall clock has run ahead of the monotonic clock by more than `clockGuardFactor` intervals since the last tick that ran (`clock_jump`): wall minus monotonic
 *    is constant while the clock is sound, so a late timer or a slow batch (both advance the two clocks alike) never trips it.
 * Only a tick that ran moves the baseline (`started`): a skipped tick is not a sweep start. A far-future clock therefore stays skipped on every later tick until it comes
 * back, and a clock stepped back resumes once it has caught up with the last sweep start (or when it returns). The price is that a real clock step forward (NTP,
 * a resumed VM) keeps retention off until the process restarts: the warn line and the `skipped.clock_jump` counter make that visible, and the rows just stay
 * (when in doubt, keep). The guard bounds a STEP; it is no defence against a clock that runs fast tick after tick, and the first tick of a process has no baseline
 * to compare with (a caller that starts the timer should do so once the host clock is synchronised).
 */
export class RetentionClockGuard {
  /** Wall clock of the last tick that ran, and its wall-minus-monotonic offset: the baseline. */
  private lastStart: number | undefined;
  private lastOffset: number | undefined;

  constructor(private readonly intervalMs: number, private readonly factor: number) {}

  verdict(now: number, mono: number): Extract<RetentionSkip, `clock_${string}`> | undefined {
    if (!Number.isFinite(now) || !Number.isFinite(mono)) return 'clock_invalid';
    if (this.lastStart === undefined || this.lastOffset === undefined) return undefined;
    if (now < this.lastStart) return 'clock_backwards';
    if (now - mono - this.lastOffset > this.factor * this.intervalMs) return 'clock_jump';
    return undefined;
  }

  /** This tick runs: it is the baseline of the next one. */
  started(now: number, mono: number): void { this.lastStart = now; this.lastOffset = now - mono; }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Hold budget
// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * The time one hold of the queue lock may take, and the slice size that fits it. `sliceNow` starts at the configured size and adapts: it halves after a hold past
 * the budget, fits the budget after a deferral, and creeps back up (one job at a time) while holds are cheap.
 */
export class HoldBudget {
  sliceNow: number;

  constructor(private readonly sliceSize: number, private readonly budgetMs: number) { this.sliceNow = sliceSize; }

  /** No further delete starts once the next one (predicted from the last) would take the hold past the budget. */
  wouldExceed(elapsedMs: number, lastOpMs: number): boolean { return elapsedMs + lastOpMs > this.budgetMs; }

  /** Whether the hold ended past the budget. */
  exceeded(elapsedMs: number): boolean { return elapsedMs > this.budgetMs; }

  /** Adapt the slice size after a hold of `elapsedMs` over `sliceLength` jobs; `fittedInBudget` is how many deletes fitted when the hold deferred the rest. */
  adapt(elapsedMs: number, sliceLength: number, fittedInBudget: number | undefined): void {
    if (fittedInBudget !== undefined) this.sliceNow = Math.max(1, Math.min(this.sliceNow, fittedInBudget));
    else if (elapsedMs > this.budgetMs) this.sliceNow = Math.max(1, Math.floor(this.sliceNow / 2));
    else if (elapsedMs <= this.budgetMs / 2 && sliceLength >= this.sliceNow && this.sliceNow < this.sliceSize) this.sliceNow += 1;
  }
}
