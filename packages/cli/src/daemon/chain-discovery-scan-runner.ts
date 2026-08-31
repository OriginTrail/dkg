export const CHAIN_DISCOVERY_SCAN_INTERVAL_MS = 30 * 60 * 1000;
export const CHAIN_DISCOVERY_FULL_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function deriveChainFullScanEvery(input: {
  intervalMs: number;
  fullResyncIntervalMs: number;
}): number {
  return Math.max(1, Math.round(input.fullResyncIntervalMs / input.intervalMs));
}

export const CHAIN_DISCOVERY_SCAN_SCHEDULE = Object.freeze({
  intervalMs: CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
  fullResyncIntervalMs: CHAIN_DISCOVERY_FULL_RESYNC_INTERVAL_MS,
  fullScanEvery: deriveChainFullScanEvery({
    intervalMs: CHAIN_DISCOVERY_SCAN_INTERVAL_MS,
    fullResyncIntervalMs: CHAIN_DISCOVERY_FULL_RESYNC_INTERVAL_MS,
  }),
});

export const CHAIN_FULL_SCAN_EVERY = CHAIN_DISCOVERY_SCAN_SCHEDULE.fullScanEvery;
export const CHAIN_DISCOVERY_SCAN_PAGE_BUDGET = 30;

export type ManagedChainDiscoveryScanState =
  | { kind: 'undetermined' }
  | { kind: 'initial'; strategy: 'cursor' | 'full'; failures: number }
  | { kind: 'steady'; successfulScansInCycle: number; cursorFailures: number }
  | {
      kind: 'recovery';
      step: 'tip' | 'incremental' | 'full';
      successfulScansInCycle: number;
    };

type ActiveManagedChainDiscoveryScanState = Exclude<
  ManagedChainDiscoveryScanState,
  { kind: 'undetermined' }
>;

/** Input retained for callers of the original daemon lifecycle helper. */
export type LegacyChainDiscoveryScanOptionsInput = {
  watermarkSeeded: boolean;
  run?: number;
  fullScanEvery?: number;
  pageBudget?: number;
};

export type ChainDiscoveryScanOptions =
  | { mode: 'incremental'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'incremental'; pageBudget: number }
  | { mode: 'tip' }
  | { mode: 'seedFromCursor'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'seedFull'; throwOnChainScanFailure: true };

function normalizeFullScanEvery(configured: number | undefined): number {
  let fullScanEvery = CHAIN_DISCOVERY_SCAN_SCHEDULE.fullScanEvery;
  if (
    typeof configured === 'number' &&
    Number.isFinite(configured) &&
    configured >= 1
  ) {
    fullScanEvery = Math.floor(configured);
  }
  return fullScanEvery;
}

function normalizePageBudget(configured: number | undefined): number {
  return (
    typeof configured === 'number' &&
    Number.isFinite(configured) &&
    configured >= 1
  )
    ? Math.floor(configured)
    : CHAIN_DISCOVERY_SCAN_PAGE_BUDGET;
}

/** Original invocation-count policy retained for external daemon-barrel callers. */
export function chainDiscoveryScanOptions(
  input: LegacyChainDiscoveryScanOptionsInput,
): ChainDiscoveryScanOptions {
  const fullScanEvery = normalizeFullScanEvery(input.fullScanEvery);
  const pageBudget = normalizePageBudget(input.pageBudget);
  const run = input.run ?? 0;
  const startupRecoveryScan = input.watermarkSeeded && run === 0;
  const periodicFullResync = input.watermarkSeeded && run > 0 && run % fullScanEvery === 0;
  if (startupRecoveryScan || periodicFullResync) {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  return input.watermarkSeeded
    ? { mode: 'incremental', pageBudget }
    : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
}

export function resolveManagedChainDiscoveryScanAttempt(input: {
  state: ManagedChainDiscoveryScanState;
  watermarkSeeded: boolean;
  fullScanEvery?: number;
  pageBudget?: number;
}): {
  state: ActiveManagedChainDiscoveryScanState;
  options: ChainDiscoveryScanOptions;
  nextOnSuccess: ManagedChainDiscoveryScanState;
  nextOnFailure: ManagedChainDiscoveryScanState;
} {
  const fullScanEvery = normalizeFullScanEvery(input.fullScanEvery);
  const pageBudget = normalizePageBudget(input.pageBudget);
  const state: ActiveManagedChainDiscoveryScanState = input.state.kind === 'undetermined'
    ? input.watermarkSeeded
      ? { kind: 'initial', strategy: 'full', failures: 0 }
      : { kind: 'initial', strategy: 'cursor', failures: 0 }
    : input.state;
  const steady = (successfulScansInCycle: number): ManagedChainDiscoveryScanState => ({
    kind: 'steady',
    successfulScansInCycle,
    cursorFailures: 0,
  });
  const recovery = (
    step: 'tip' | 'incremental' | 'full',
    successfulScansInCycle: number,
  ): ManagedChainDiscoveryScanState => ({
    kind: 'recovery',
    step,
    successfulScansInCycle,
  });

  switch (state.kind) {
    case 'initial': {
      const options: ChainDiscoveryScanOptions = state.strategy === 'full'
        ? { mode: 'seedFull', throwOnChainScanFailure: true }
        : input.watermarkSeeded
          ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
          : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
      return {
        state,
        options,
        nextOnSuccess: steady(1),
        nextOnFailure: state.failures + 1 >= 2
          ? recovery('tip', 0)
          : { ...state, failures: state.failures + 1 },
      };
    }
    case 'recovery': {
      const nextStep = state.step === 'tip'
        ? input.watermarkSeeded ? 'incremental' : 'full'
        : state.step === 'incremental' ? 'full' : 'tip';
      const options: ChainDiscoveryScanOptions = state.step === 'tip'
        ? { mode: 'tip' }
        : state.step === 'full'
          ? { mode: 'seedFull', throwOnChainScanFailure: true }
          : input.watermarkSeeded
            ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
            : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
      return {
        state,
        options,
        nextOnSuccess: state.step === 'full'
          ? steady(1)
          : recovery(nextStep, state.successfulScansInCycle),
        nextOnFailure: recovery(nextStep, state.successfulScansInCycle),
      };
    }
    case 'steady': {
      const fullAttempt = input.watermarkSeeded
        && state.successfulScansInCycle >= fullScanEvery;
      if (fullAttempt) {
        return {
          state,
          options: { mode: 'seedFull', throwOnChainScanFailure: true },
          nextOnSuccess: steady(1),
          nextOnFailure: recovery('tip', state.successfulScansInCycle),
        };
      }
      return {
        state,
        options: input.watermarkSeeded
          ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
          : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget },
        nextOnSuccess: steady(state.successfulScansInCycle + 1),
        nextOnFailure: state.cursorFailures + 1 >= 2
          ? recovery('tip', state.successfulScansInCycle)
          : { ...state, cursorFailures: state.cursorFailures + 1 },
      };
    }
  }
}

/** Compatibility wrapper over the attempt's co-located transition model. */
export function transitionManagedChainDiscoveryScanState(input: {
  state: ActiveManagedChainDiscoveryScanState;
  watermarkSeeded: boolean;
  outcome: 'success' | 'failure';
  fullScanEvery?: number;
}): ManagedChainDiscoveryScanState {
  const attempt = resolveManagedChainDiscoveryScanAttempt({
    state: input.state,
    watermarkSeeded: input.watermarkSeeded,
    fullScanEvery: input.fullScanEvery,
  });
  return input.outcome === 'success'
    ? attempt.nextOnSuccess
    : attempt.nextOnFailure;
}

function safeLog(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    // Logging must not turn a non-critical scan or scan failure into a daemon failure.
  }
}

function safeErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    // Promise rejection reasons are arbitrary values. Even property access or coercion can throw,
    // so error reporting must have a value-independent fallback inside the scan failure boundary.
    return 'unformattable error';
  }
}

export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(
      options: ChainDiscoveryScanOptions,
    ): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  fullScanEvery?: number;
}): () => Promise<void> {
  let state: ManagedChainDiscoveryScanState = { kind: 'undetermined' };
  let inFlight = false;

  return async () => {
    if (inFlight) return;
    inFlight = true;

    try {
      let watermarkSeeded: boolean;
      try {
        watermarkSeeded = await input.agent.hasContextGraphRegistryScanWatermark();
      } catch (error) {
        safeLog(
          input.log,
          `Chain scan: watermark probe failed: ${safeErrorMessage(error)}`,
        );
        return;
      }

      const attempt = resolveManagedChainDiscoveryScanAttempt({
        state,
        watermarkSeeded,
        pageBudget: input.pageBudget,
        fullScanEvery: input.fullScanEvery,
      });
      state = attempt.state;
      const { options } = attempt;

      let found: number;
      try {
        found = await input.agent.discoverContextGraphsFromChain(options);
      } catch (error) {
        safeLog(
          input.log,
          `Chain scan: ${options.mode} scan failed: ${safeErrorMessage(error)}`,
        );
        state = attempt.nextOnFailure;
        return;
      }

      state = attempt.nextOnSuccess;

      if (found > 0) {
        safeLog(input.log, `Chain scan: discovered ${found} new context graph(s)`);
      }
    } finally {
      inFlight = false;
    }
  };
}
