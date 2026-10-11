import { withRpcRequestContext } from '@origintrail-official/dkg-chain';
import { CoalescingRecurringTask } from '@origintrail-official/dkg-core';

/**
 * Bounded on-chain Context Graph discovery scheduling.
 *
 * ContextGraphStorage id enumeration runs first on every pass. It is the
 * authoritative history source: it lists every Context Graph that exists on
 * chain from a durable id cursor, with view calls only. The repair slot keeps
 * its mutable facts fresh at the repair cadence.
 *
 * The ContextGraphNameRegistry lanes run only while a registry is bound in the
 * Hub. The registry is archived and neither mainnet registers it, so there the
 * agent reports its absence once and both registry lanes are skipped instead
 * of scanning nothing every tick. Where it is bound, live discovery and
 * historical repair stay deliberately different lanes: live discovery resumes
 * its durable cursor with the chain adapter's reorg overlap and is the only
 * lane whose failure is retried as a pinned scheduler slot; historical repair
 * runs only after live success, owns an independent atomic cursor/target, and
 * is bounded on every invocation.
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

type CancellableScanOptions = ScanOptions & { signal: AbortSignal };

export interface ChainDiscoveryScanRunner {
  /** Run at most one live-then-repair pass; overlapping calls are dropped. */
  run(): Promise<void>;
  /** Arm the initial pass; the runner owns every later periodic deadline. */
  schedule(initialDelayMs?: number): boolean;
  /** Clear the deadline, abort, and drain before agent/store teardown. */
  close(): Promise<void>;
}

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
    discoverContextGraphsFromChain(options: CancellableScanOptions): Promise<number>;
    repairContextGraphRegistry?(options: {
      pageBudget: number;
      minimumIntervalMs: number;
      signal: AbortSignal;
    }): Promise<number>;
    /**
     * Whether a ContextGraphNameRegistry is bound. When it resolves false the
     * registry lanes are skipped; agents without the probe keep them.
     */
    hasContextGraphNameRegistry?(): Promise<boolean>;
    /** ContextGraphStorage id enumeration from its durable cursor. */
    discoverContextGraphsFromStorage?(options: { signal: AbortSignal }): Promise<number>;
    /** Refresh enumerated graphs' mutable facts, at most once per interval. */
    refreshContextGraphsFromStorage?(options: {
      minimumIntervalMs: number;
      signal: AbortSignal;
    }): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  repairEveryTicks?: number;
  /** @deprecated Use repairEveryTicks. */
  fullScanEvery?: number;
  /** Zero/omitted disables periodic rearming for manually driven callers. */
  intervalMs?: number;
}): ChainDiscoveryScanRunner {
  let state = INITIAL_SCAN_SCHEDULER_STATE;

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

  const repairIntervalMs = (): number => {
    const configuredRepairEvery = input.repairEveryTicks ?? input.fullScanEvery;
    const repairEvery = typeof configuredRepairEvery === 'number'
      && Number.isFinite(configuredRepairEvery)
      && configuredRepairEvery >= 1
      ? Math.floor(configuredRepairEvery)
      : CHAIN_REPAIR_AUDIT_EVERY_TICKS;
    return repairEvery * CHAIN_DISCOVERY_SCAN_INTERVAL_MS;
  };

  /**
   * ContextGraphStorage enumeration: the authoritative history lane. Its
   * failure is reported and retried next tick without blocking the registry
   * lanes. Resolves whether the lane ran and succeeded.
   */
  const discoverFromStorage = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const found = await withRpcRequestContext(
        { requestClass: 'background', signal },
        () => input.agent.discoverContextGraphsFromStorage!({ signal }),
      );
      if (found > 0) safeLog(`Chain storage scan: discovered ${found} new context graph(s)`);
      return true;
    } catch (error) {
      if (!signal.aborted) {
        safeLog(`Chain storage scan failed; retrying next tick: ${describeError(error)}`);
      }
      return false;
    }
  };

  /** Keeps enumerated graphs' mutable facts fresh at the repair cadence. */
  const refreshFromStorage = async (signal: AbortSignal): Promise<void> => {
    if (!input.agent.refreshContextGraphsFromStorage) return;
    try {
      const changed = await withRpcRequestContext(
        { requestClass: 'background', signal },
        () => input.agent.refreshContextGraphsFromStorage!({
          minimumIntervalMs: repairIntervalMs(),
          signal,
        }),
      );
      if (changed > 0) safeLog(`Chain storage refresh: updated ${changed} context graph(s)`);
    } catch (error) {
      if (!signal.aborted) {
        safeLog(`Chain storage refresh failed; retrying next tick: ${describeError(error)}`);
      }
    }
  };

  /**
   * The registry lanes run while a registry is bound. An agent without the
   * probe keeps them, and a failed probe does too: an unreadable Hub fails the
   * registry scan the same way, under its existing retry accounting.
   */
  const registryBound = async (signal: AbortSignal): Promise<boolean> => {
    try {
      return await withRpcRequestContext(
        { requestClass: 'background', signal },
        () => input.agent.hasContextGraphNameRegistry!(),
      );
    } catch {
      return true;
    }
  };

  /** The ContextGraphNameRegistry live lane, then its bounded repair audit. */
  const runRegistryLanes = async (signal: AbortSignal): Promise<void> => {
    const step = planScan(state, { pageBudget: input.pageBudget });
    let plan: ScanPlan;
    if (step.kind === 'ready') {
      plan = step.plan;
    } else {
      let watermarkSeeded: boolean;
      try {
        watermarkSeeded = await withRpcRequestContext(
          { requestClass: 'background', signal },
          () => input.agent.hasContextGraphRegistryScanWatermark(),
        );
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
      outcome = {
        ok: true,
        // Live discovery is latency-sensitive relative to historical repair,
        // but it is still daemon-scheduled maintenance. Keeping it in the
        // background RPC partition lets an interactive registration preempt
        // the next scan request instead of sharing and exhausting foreground
        // capacity during a slow page application.
        found: await withRpcRequestContext(
          { requestClass: 'background', signal },
          () => input.agent.discoverContextGraphsFromChain({
            ...plan.scan,
            signal,
          }),
        ),
      };
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
      try {
        const found = await withRpcRequestContext(
          { requestClass: 'background', signal },
          () => input.agent.repairContextGraphRegistry!({
            pageBudget: input.pageBudget ?? CHAIN_DISCOVERY_SCAN_PAGE_BUDGET,
            minimumIntervalMs: repairIntervalMs(),
            signal,
          }),
        );
        if (found > 0) safeLog(`Chain repair audit: discovered ${found} new context graph(s)`);
      } catch (error) {
        safeLog(`Chain repair audit failed; retrying next tick: ${describeError(error)}`);
      }
    }
  };

  const execute = async (signal: AbortSignal): Promise<void> => {
    // Agents without the storage lane or the registry probe take the legacy
    // path with no extra awaits, so its scheduling is unchanged.
    const storageHealthy = input.agent.discoverContextGraphsFromStorage
      ? await discoverFromStorage(signal)
      : false;
    if (signal.aborted) return;
    const bound = input.agent.hasContextGraphNameRegistry ? await registryBound(signal) : true;
    if (bound) await runRegistryLanes(signal);
    if (signal.aborted) return;
    // Like the registry audit, refresh adds traffic only after a healthy pass.
    if (storageHealthy) await refreshFromStorage(signal);
  };

  const task = new CoalescingRecurringTask({
    retryIntervalMs: input.intervalMs,
    requestWhileRunning: 'drop',
    runPass: async (signal) => {
      await execute(signal);
      return 'rearm';
    },
    onError: (error) => {
      safeLog(`Chain discovery scheduler failed; retrying next tick: ${describeError(error)}`);
    },
    closingMessage: 'Chain Context Graph discovery runner is closing',
  });

  return {
    run: async (): Promise<void> => {
      if (!task.request()) return;
      await task.whenIdle();
    },
    schedule: (initialDelayMs = 15_000): boolean => task.schedule(initialDelayMs),
    close: (): Promise<void> => task.close(),
  };
}
