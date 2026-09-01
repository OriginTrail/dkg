/**
 * Chain-discovery scan scheduling: which scan mode each run issues, and the
 * runner the daemon's 30-minute timer drives (GH#2323).
 *
 * Extracted from lifecycle.ts — the scheduler is a self-contained state
 * machine with a narrow dependency surface (two agent methods and a log
 * sink), and retry/cadence policy changes should not require editing the
 * module that also owns boot, servers, workers and shutdown.
 *
 * The policy lives in two PURE functions over a discriminated state —
 * `planScan` (what this tick runs) and `commitScanOutcome` (how the result
 * moves the state) — so invalid combinations (a retry count without a pinned
 * scan, overdue ticks without an overdue resync) are unrepresentable, and
 * the runner itself does nothing but single-flight orchestration and I/O.
 */

export const CHAIN_FULL_SCAN_EVERY = 48; // about once per day at the 30-minute cadence
export const CHAIN_DISCOVERY_SCAN_PAGE_BUDGET = 30;

/**
 * How many consecutive ticks a failed scan is retried AS-IS before the
 * scheduler releases its slot and lets the normal cadence proceed. Bounded
 * because an unbounded pin trades one liveness bug for another: a
 * deterministically failing historical page would otherwise block
 * incremental discovery of new blocks forever.
 */
export const MAX_CONSECUTIVE_SAME_SCAN_RETRIES = 3;

/**
 * While a full resync is overdue (a `seedFull` exhausted its retries), a
 * fresh attempt fires every this-many RUNNER TICKS (~2h at the 30-minute
 * cadence) — ticks, not completed slots, so a failing incremental's retry
 * cycle cannot postpone the owed resync. Incremental scans run on the ticks
 * in between, keeping recent-block discovery live while the historical
 * re-walk stays scheduled.
 */
export const OVERDUE_FULL_RESYNC_RETRY_EVERY = 4;

export function chainDiscoveryScanOptions(input: {
  watermarkSeeded: boolean;
  run?: number;
  fullScanEvery?: number;
  pageBudget?: number;
}):
  | { mode: 'incremental'; pageBudget: number }
  | { mode: 'seedFromCursor'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'seedFull'; throwOnChainScanFailure: true } {
  const configuredFullScanEvery = input.fullScanEvery;
  let fullScanEvery = CHAIN_FULL_SCAN_EVERY;
  if (
    typeof configuredFullScanEvery === 'number' &&
    Number.isFinite(configuredFullScanEvery) &&
    configuredFullScanEvery >= 1
  ) {
    fullScanEvery = Math.floor(configuredFullScanEvery);
  }
  const configuredPageBudget = input.pageBudget;
  const pageBudget = (
    typeof configuredPageBudget === 'number' &&
    Number.isFinite(configuredPageBudget) &&
    configuredPageBudget >= 1
  )
    ? Math.floor(configuredPageBudget)
    : CHAIN_DISCOVERY_SCAN_PAGE_BUDGET;
  const run = input.run ?? 0;
  const startupRecoveryScan = input.watermarkSeeded && run === 0;
  const periodicFullResync = input.watermarkSeeded && run > 0 && run % fullScanEvery === 0;
  if (startupRecoveryScan || periodicFullResync) {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  return input.watermarkSeeded && !periodicFullResync
    ? { mode: 'incremental', pageBudget }
    : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
}

export type ScanOptions = ReturnType<typeof chainDiscoveryScanOptions>;

export interface ScanSchedulerConfig {
  pageBudget?: number;
  fullScanEvery?: number;
}

/**
 * The scheduler state. Invalid combinations are unrepresentable by
 * construction: a retry count exists only inside `pinned`, overdue ticks
 * only inside `overdueResync`.
 *
 * `pinned` — a failed scan retried AS-IS. Captured options, not a
 * recomputed mode: the mode derives from the run number AND the mutable
 * watermark, and a partially-successful scan moves the watermark, so a
 * fresh node's failed `seedFromCursor` recomputed would become an unbounded
 * `seedFull` from block zero instead of resuming its cursor.
 *
 * `overdueResync` — a `seedFull` that exhausted its retries. Released, not
 * forgotten: it fires again every OVERDUE_FULL_RESYNC_RETRY_EVERY ticks.
 */
export interface ScanSchedulerState {
  /** Advances only when a scan settles its slot (success or exhausted). */
  readonly run: number;
  readonly pinned?: { readonly options: ScanOptions; readonly failures: number };
  readonly overdueResync?: { readonly ticksSinceAttempt: number };
}

export const INITIAL_SCAN_SCHEDULER_STATE: ScanSchedulerState = { run: 0 };

export type ScanOutcome =
  | { readonly ok: true; readonly found: number }
  | { readonly ok: false; readonly error: unknown };

/** What the runner should tell the operator, decided by the pure layer. */
export type ScanReport =
  | { kind: 'discovered'; found: number }
  | { kind: 'quiet' }
  | { kind: 'retryScheduled'; run: number; mode: ScanOptions['mode']; failures: number; error: unknown }
  | { kind: 'slotReleased'; run: number; mode: ScanOptions['mode']; attempts: number; resyncStaysScheduled: boolean; error: unknown };

/**
 * An executable plan: the scan to run plus everything commit needs, carried
 * AS ONE UNIT. The retry history travels inside the plan, so structurally
 * copying the scan options cannot reset it, and commit needs no reference
 * identity with the scheduler's pin.
 */
export interface ScanPlan {
  readonly scan: ScanOptions;
  /** Failures already recorded against THIS scan before this attempt. */
  readonly priorFailures: number;
  /** Scheduler state as of planning, tick accounting applied. */
  readonly state: ScanSchedulerState;
}

/**
 * Planning names its own prerequisite instead of making the caller predict
 * it: a pinned retry and a DUE overdue resync are executable immediately —
 * in particular, an overdue `seedFull` must not be skippable by a failing,
 * irrelevant watermark probe — while only the canonical cadence selection
 * needs the probe, via `complete`.
 */
export type ScanPlanStep =
  | { readonly kind: 'ready'; readonly plan: ScanPlan }
  | {
      readonly kind: 'needsWatermark';
      /**
       * The scheduler state with this tick's accounting (overdue aging)
       * already applied. A caller whose probe FAILS must commit this state —
       * discarding it would let a persistently failing probe postpone the
       * overdue resync forever, in exactly the store-outage scenario the
       * resync exists to recover from.
       */
      readonly agedState: ScanSchedulerState;
      readonly complete: (watermarkSeeded: boolean) => ScanPlan;
    };

/**
 * Pure: choose this tick's scan and account for overdue-cadence time.
 *
 * Overdue ticks count on EVERY planned tick, and when the cadence comes due
 * the owed `seedFull` fires — replacing a pinned `incremental` retry if one
 * exists (an incremental's work is subsumed by the full re-walk), but never
 * preempting a pinned `seedFull`/`seedFromCursor`, whose own retries are the
 * more specific recovery already in progress.
 */
export function planScan(
  state: ScanSchedulerState,
  config: ScanSchedulerConfig = {},
): ScanPlanStep {
  if (state.overdueResync) {
    const ticks = state.overdueResync.ticksSinceAttempt + 1;
    const preemptable = state.pinned === undefined || state.pinned.options.mode === 'incremental';
    if (ticks >= OVERDUE_FULL_RESYNC_RETRY_EVERY && preemptable) {
      return {
        kind: 'ready',
        plan: {
          scan: { mode: 'seedFull', throwOnChainScanFailure: true },
          priorFailures: 0,
          state: { run: state.run, overdueResync: { ticksSinceAttempt: 0 } },
        },
      };
    }
    state = { ...state, overdueResync: { ticksSinceAttempt: ticks } };
  }
  if (state.pinned) {
    return {
      kind: 'ready',
      plan: { scan: state.pinned.options, priorFailures: state.pinned.failures, state },
    };
  }
  const planned = state;
  return {
    kind: 'needsWatermark',
    agedState: planned,
    complete: (watermarkSeeded: boolean): ScanPlan => ({
      scan: chainDiscoveryScanOptions({
        run: planned.run,
        watermarkSeeded,
        pageBudget: config.pageBudget,
        fullScanEvery: config.fullScanEvery,
      }),
      priorFailures: 0,
      state: planned,
    }),
  };
}

/**
 * Pure: fold a plan's outcome into the next state, and say what to report.
 * The outcome is discriminated — `Promise.reject(undefined)` is a FAILURE
 * carrying `undefined`, not a success (a sentinel comparison would commit it
 * as one, consuming the slot and clearing an overdue resync no scan earned).
 */
export function commitScanOutcome(
  plan: ScanPlan,
  outcome: ScanOutcome,
): { state: ScanSchedulerState; report: ScanReport } {
  const { scan, state } = plan;
  if (outcome.ok) {
    return {
      state: {
        run: state.run + 1,
        // A completed full resync settles the overdue debt; any other success
        // leaves it (still owed, still on cadence).
        ...(scan.mode !== 'seedFull' && state.overdueResync !== undefined
          ? { overdueResync: state.overdueResync }
          : {}),
      },
      report: outcome.found > 0 ? { kind: 'discovered', found: outcome.found } : { kind: 'quiet' },
    };
  }
  // Retry history comes from the plan itself — never from comparing object
  // identities, which a structural copy would silently defeat.
  const failures = plan.priorFailures + 1;
  if (failures <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES) {
    return {
      state: { ...state, pinned: { options: scan, failures } },
      report: { kind: 'retryScheduled', run: state.run, mode: scan.mode, failures, error: outcome.error },
    };
  }
  // Retries exhausted: release the slot so the cadence proceeds; keep a
  // failed full resync scheduled instead of forgetting it.
  return {
    state: {
      run: state.run + 1,
      ...(scan.mode === 'seedFull'
        ? { overdueResync: { ticksSinceAttempt: 0 } }
        : state.overdueResync !== undefined
          ? { overdueResync: state.overdueResync }
          : {}),
    },
    report: {
      kind: 'slotReleased',
      run: state.run,
      mode: scan.mode,
      attempts: failures,
      resyncStaysScheduled: scan.mode === 'seedFull',
      error: outcome.error,
    },
  };
}

/**
 * TOTAL error description: chain discovery is non-critical and the lifecycle
 * hands the runner straight to a timer with no rejection handler, so a
 * throw ANYWHERE in reporting escapes as an unhandled rejection and can take
 * the daemon down. A rejection value is arbitrary — `Object.create(null)`
 * has no toString, and a poisoned `toString`/`message` getter throws — so
 * both the property access and the coercion sit inside the catch.
 */
const describeError = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    return String(error);
  } catch {
    return 'unknown error (rejection value could not be formatted)';
  }
};

/**
 * The I/O shell (GH#2323): single-flight guard, the watermark probe with its
 * own narrow error boundary, one state assignment per tick committed BEFORE
 * any logging, and a log sink that cannot affect scheduling — every policy
 * decision lives in the pure functions above.
 */
export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(options: ScanOptions): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  fullScanEvery?: number;
}): () => Promise<void> {
  let state = INITIAL_SCAN_SCHEDULER_STATE;
  let inFlight = false;

  const safeLog = (msg: string): void => {
    try {
      input.log(msg);
    } catch {
      /* a broken log sink must not affect scan scheduling */
    }
  };

  const reportLine = (report: ScanReport): string | undefined => {
    switch (report.kind) {
      case 'quiet':
        return undefined;
      case 'discovered':
        return `Chain scan: discovered ${report.found} new context graph(s)`;
      case 'retryScheduled':
        return (
          `Chain scan run ${report.run} (${report.mode}) failed; ` +
          `the same scan retries next tick: ${describeError(report.error)}`
        );
      case 'slotReleased':
        return (
          `Chain scan run ${report.run} (${report.mode}) failed ${report.attempts}x; ` +
          `releasing the slot so discovery continues` +
          (report.resyncStaysScheduled
            ? ` — the full resync stays scheduled and retries every ${OVERDUE_FULL_RESYNC_RETRY_EVERY} tick(s)`
            : '') +
          `: ${describeError(report.error)}`
        );
    }
  };

  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // Planning names its own prerequisite: only the canonical cadence
      // selection needs the watermark probe. A pinned retry or a DUE overdue
      // resync executes without it — so an irrelevant probe failure cannot
      // skip either.
      const step = planScan(state, {
        pageBudget: input.pageBudget,
        fullScanEvery: input.fullScanEvery,
      });
      let plan: ScanPlan;
      if (step.kind === 'ready') {
        plan = step.plan;
      } else {
        let watermarkSeeded: boolean;
        try {
          watermarkSeeded = await input.agent.hasContextGraphRegistryScanWatermark();
        } catch (err) {
          // Scoped to the probe call alone, so nothing else — least of all a
          // throwing log line — can be misclassified as a probe failure. The
          // tick's ACCOUNTING is kept even though no scan ran: the overdue
          // debt must keep aging under a failing probe, or four consecutive
          // probe failures would postpone the probe-independent resync
          // forever. The run does not advance and nothing is pinned.
          state = step.agedState;
          safeLog(
            `Chain scan run ${state.run} skipped (watermark probe failed; retrying next tick): ` +
              `${describeError(err)}`,
          );
          return;
        }
        plan = step.complete(watermarkSeeded);
      }
      let outcome: ScanOutcome;
      try {
        outcome = { ok: true, found: await input.agent.discoverContextGraphsFromChain(plan.scan) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      const committed = commitScanOutcome(plan, outcome);
      state = committed.state; // committed before ANY logging
      try {
        // describeError is total, but reporting stays inside its own no-throw
        // boundary anyway — nothing after the state commit may reject the
        // runner the timer never observes.
        const line = reportLine(committed.report);
        if (line !== undefined) safeLog(line);
      } catch {
        /* reporting must never affect scheduling or the timer */
      }
    } finally {
      inFlight = false;
    }
  };
}
