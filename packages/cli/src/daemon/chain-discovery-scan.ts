import { withRpcRequestContext } from '@origintrail-official/dkg-chain';

/**
 * Bounded ContextGraphNameRegistry discovery scheduling.
 *
 * Live discovery and historical repair are deliberately different lanes:
 * live discovery always runs first, resumes its durable cursor with the chain
 * adapter's reorg overlap, and is the only lane whose failure is retried as a
 * pinned scheduler slot. Historical repair runs only after live success, owns
 * an independent atomic cursor/target, and is bounded on every invocation.
 */

/** Default completed-repair generation interval: about once per day. */
export const CHAIN_REPAIR_AUDIT_EVERY_TICKS = 48;
/** @deprecated Use CHAIN_REPAIR_AUDIT_EVERY_TICKS. */
export const CHAIN_FULL_SCAN_EVERY = CHAIN_REPAIR_AUDIT_EVERY_TICKS;
export const CHAIN_DISCOVERY_SCAN_PAGE_BUDGET = 30;
export const CHAIN_DISCOVERY_SCAN_INTERVAL_MS = 30 * 60 * 1_000;
export const MAX_CONSECUTIVE_SAME_SCAN_RETRIES = 3;

/**
 * @deprecated No overdue unbounded resync is scheduled. Kept as a source-level
 * compatibility export for callers which imported the old policy constant.
 */
export const OVERDUE_FULL_RESYNC_RETRY_EVERY = 4;

export type ScanOptions =
  | { mode: 'incremental'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'seedLiveTail'; throwOnChainScanFailure: true; pageBudget: number };

export function chainDiscoveryScanOptions(input: {
  watermarkSeeded: boolean;
  pageBudget?: number;
}): ScanOptions {
  const configuredPageBudget = input.pageBudget;
  const pageBudget = (
    typeof configuredPageBudget === 'number'
    && Number.isFinite(configuredPageBudget)
    && configuredPageBudget >= 1
  )
    ? Math.floor(configuredPageBudget)
    : CHAIN_DISCOVERY_SCAN_PAGE_BUDGET;
  return input.watermarkSeeded
    ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
    : { mode: 'seedLiveTail', throwOnChainScanFailure: true, pageBudget };
}

export interface ScanSchedulerConfig {
  pageBudget?: number;
  /** Number of 30-minute ticks between completed historical repair generations. */
  repairEveryTicks?: number;
  /** @deprecated Use repairEveryTicks. Compatibility is isolated at the runner boundary. */
  fullScanEvery?: number;
}

export interface ScanSchedulerState {
  /** Advances only when a live scan settles its slot (success or retry exhaustion). */
  readonly run: number;
  readonly pinned?: { readonly options: ScanOptions; readonly failures: number };
}

export const INITIAL_SCAN_SCHEDULER_STATE: ScanSchedulerState = { run: 0 };

export type ScanOutcome =
  | { readonly ok: true; readonly found: number }
  | { readonly ok: false; readonly error: unknown };

export type ScanReport =
  | { kind: 'discovered'; found: number }
  | { kind: 'quiet' }
  | { kind: 'retryScheduled'; run: number; mode: ScanOptions['mode']; failures: number; error: unknown }
  | { kind: 'slotReleased'; run: number; mode: ScanOptions['mode']; attempts: number; error: unknown };

export interface ScanPlan {
  readonly scan: ScanOptions;
  readonly priorFailures: number;
  readonly state: ScanSchedulerState;
}

export type ScanPlanStep =
  | { readonly kind: 'ready'; readonly plan: ScanPlan }
  | {
      readonly kind: 'needsWatermark';
      readonly agedState: ScanSchedulerState;
      readonly complete: (watermarkSeeded: boolean) => ScanPlan;
    };

/** Pure live-lane planner. Failed scans retry with their exact captured mode. */
export function planScan(
  state: ScanSchedulerState,
  config: ScanSchedulerConfig = {},
): ScanPlanStep {
  if (state.pinned) {
    return {
      kind: 'ready',
      plan: { scan: state.pinned.options, priorFailures: state.pinned.failures, state },
    };
  }
  return {
    kind: 'needsWatermark',
    agedState: state,
    complete: (watermarkSeeded: boolean): ScanPlan => ({
      scan: chainDiscoveryScanOptions({
        watermarkSeeded,
        pageBudget: config.pageBudget,
      }),
      priorFailures: 0,
      state,
    }),
  };
}

/** Pure live-lane transition. Retry exhaustion releases discovery liveness. */
export function commitScanOutcome(
  plan: ScanPlan,
  outcome: ScanOutcome,
): { state: ScanSchedulerState; report: ScanReport } {
  const { scan, state } = plan;
  if (outcome.ok) {
    return {
      state: { run: state.run + 1 },
      report: outcome.found > 0 ? { kind: 'discovered', found: outcome.found } : { kind: 'quiet' },
    };
  }
  const failures = plan.priorFailures + 1;
  if (failures <= MAX_CONSECUTIVE_SAME_SCAN_RETRIES) {
    return {
      state: { run: state.run, pinned: { options: scan, failures } },
      report: { kind: 'retryScheduled', run: state.run, mode: scan.mode, failures, error: outcome.error },
    };
  }
  return {
    state: { run: state.run + 1 },
    report: {
      kind: 'slotReleased',
      run: state.run,
      mode: scan.mode,
      attempts: failures,
      error: outcome.error,
    },
  };
}

const describeError = (error: unknown): string => {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    return String(error);
  } catch {
    return 'unknown error (rejection value could not be formatted)';
  }
};

/**
 * Single-flight I/O shell. The optional repair operation is separate so the
 * daemon can wrap only that call in the background RPC request class while
 * keeping live discovery in the foreground lane.
 */
export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(options: ScanOptions): Promise<number>;
    repairContextGraphRegistry?(options: {
      pageBudget: number;
      minimumIntervalMs: number;
    }): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  repairEveryTicks?: number;
  /** @deprecated Use repairEveryTicks. */
  fullScanEvery?: number;
}): () => Promise<void> {
  let state = INITIAL_SCAN_SCHEDULER_STATE;
  let inFlight = false;

  const safeLog = (msg: string): void => {
    try {
      input.log(msg);
    } catch {
      /* a broken log sink must not affect scheduling */
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
          `Chain scan run ${report.run} (${report.mode}) failed; `
          + `the same scan retries next tick: ${describeError(report.error)}`
        );
      case 'slotReleased':
        return (
          `Chain scan run ${report.run} (${report.mode}) failed ${report.attempts}x; `
          + `releasing the slot so discovery continues: ${describeError(report.error)}`
        );
    }
  };

  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const step = planScan(state, { pageBudget: input.pageBudget });
      let plan: ScanPlan;
      if (step.kind === 'ready') {
        plan = step.plan;
      } else {
        let watermarkSeeded: boolean;
        try {
          watermarkSeeded = await input.agent.hasContextGraphRegistryScanWatermark();
        } catch (error) {
          state = step.agedState;
          safeLog(
            `Chain scan run ${state.run} skipped (watermark probe failed; retrying next tick): `
            + describeError(error),
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
      state = committed.state;
      try {
        const line = reportLine(committed.report);
        if (line !== undefined) safeLog(line);
      } catch {
        /* reporting must never affect scheduling */
      }

      // Do not add repair traffic while live catch-up is unhealthy. On success,
      // live has already committed before this independently bounded lane starts.
      if (outcome.ok && input.agent.repairContextGraphRegistry) {
        const configuredRepairEvery = input.repairEveryTicks ?? input.fullScanEvery;
        const repairEvery = typeof configuredRepairEvery === 'number'
          && Number.isFinite(configuredRepairEvery)
          && configuredRepairEvery >= 1
          ? Math.floor(configuredRepairEvery)
          : CHAIN_REPAIR_AUDIT_EVERY_TICKS;
        try {
          const found = await withRpcRequestContext(
            { requestClass: 'background' },
            () => input.agent.repairContextGraphRegistry!({
              pageBudget: input.pageBudget ?? CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
              minimumIntervalMs: repairEvery * CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
            }),
          );
          if (found > 0) safeLog(`Chain repair audit: discovered ${found} new context graph(s)`);
        } catch (error) {
          safeLog(`Chain repair audit failed; retrying next tick: ${describeError(error)}`);
        }
      }
    } finally {
      inFlight = false;
    }
  };
}
