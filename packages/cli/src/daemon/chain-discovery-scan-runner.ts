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
  | { kind: 'cursorSeed'; failures: number }
  | { kind: 'startupFullRecovery'; failures: number }
  | { kind: 'steady'; successfulScansInCycle: number; cursorFailures: number }
  | { kind: 'recoveryTip'; successfulScansInCycle: number }
  | { kind: 'recoveryIncremental'; successfulScansInCycle: number }
  | { kind: 'recoveryFull'; successfulScansInCycle: number };

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
} {
  const fullScanEvery = normalizeFullScanEvery(input.fullScanEvery);
  const pageBudget = normalizePageBudget(input.pageBudget);
  const state: ActiveManagedChainDiscoveryScanState = input.state.kind === 'undetermined'
    ? input.watermarkSeeded
      ? { kind: 'startupFullRecovery', failures: 0 }
      : { kind: 'cursorSeed', failures: 0 }
    : input.state;

  switch (state.kind) {
    case 'startupFullRecovery':
    case 'recoveryFull':
      return { state, options: { mode: 'seedFull', throwOnChainScanFailure: true } };
    case 'recoveryTip':
      return { state, options: { mode: 'tip' } };
    case 'cursorSeed':
    case 'recoveryIncremental':
      return {
        state,
        options: input.watermarkSeeded
          ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
          : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget },
      };
    case 'steady':
      if (input.watermarkSeeded && state.successfulScansInCycle >= fullScanEvery) {
        return { state, options: { mode: 'seedFull', throwOnChainScanFailure: true } };
      }
      return {
        state,
        options: input.watermarkSeeded
          ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
          : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget },
      };
  }
}

export function transitionManagedChainDiscoveryScanState(input: {
  state: ActiveManagedChainDiscoveryScanState;
  watermarkSeeded: boolean;
  outcome: 'success' | 'failure';
  fullScanEvery?: number;
}): ManagedChainDiscoveryScanState {
  const { state } = input;
  const successes = 'successfulScansInCycle' in state
    ? state.successfulScansInCycle
    : 0;
  const steadyFullAttempt = state.kind === 'steady'
    && input.watermarkSeeded
    && successes >= normalizeFullScanEvery(input.fullScanEvery);

  if (input.outcome === 'failure') {
    switch (state.kind) {
      case 'startupFullRecovery':
        return state.failures + 1 >= 2
          ? { kind: 'recoveryTip', successfulScansInCycle: 0 }
          : { ...state, failures: state.failures + 1 };
      case 'cursorSeed':
        return state.failures + 1 >= 2
          ? { kind: 'recoveryTip', successfulScansInCycle: 0 }
          : { ...state, failures: state.failures + 1 };
      case 'recoveryTip':
        return input.watermarkSeeded
          ? { kind: 'recoveryIncremental', successfulScansInCycle: successes }
          : { kind: 'recoveryFull', successfulScansInCycle: successes };
      case 'recoveryIncremental':
        return { kind: 'recoveryFull', successfulScansInCycle: successes };
      case 'recoveryFull':
        return { kind: 'recoveryTip', successfulScansInCycle: successes };
      case 'steady':
        if (steadyFullAttempt) {
          return { kind: 'recoveryTip', successfulScansInCycle: successes };
        }
        return state.cursorFailures + 1 >= 2
          ? { kind: 'recoveryTip', successfulScansInCycle: successes }
          : { ...state, cursorFailures: state.cursorFailures + 1 };
    }
  }

  switch (state.kind) {
    case 'startupFullRecovery':
    case 'recoveryFull':
      return { kind: 'steady', successfulScansInCycle: 1, cursorFailures: 0 };
    case 'cursorSeed':
      return { kind: 'steady', successfulScansInCycle: 1, cursorFailures: 0 };
    case 'recoveryTip':
      return input.watermarkSeeded
        ? { kind: 'recoveryIncremental', successfulScansInCycle: successes }
        : { kind: 'recoveryFull', successfulScansInCycle: successes };
    case 'recoveryIncremental':
      return { kind: 'recoveryFull', successfulScansInCycle: successes };
    case 'steady':
      return steadyFullAttempt
        ? { kind: 'steady', successfulScansInCycle: 1, cursorFailures: 0 }
        : {
            kind: 'steady',
            successfulScansInCycle: successes + 1,
            cursorFailures: 0,
          };
  }
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
        state = transitionManagedChainDiscoveryScanState({
          state: attempt.state,
          watermarkSeeded,
          outcome: 'failure',
          fullScanEvery: input.fullScanEvery,
        });
        return;
      }

      state = transitionManagedChainDiscoveryScanState({
        state: attempt.state,
        watermarkSeeded,
        outcome: 'success',
        fullScanEvery: input.fullScanEvery,
      });

      if (found > 0) {
        safeLog(input.log, `Chain scan: discovered ${found} new context graph(s)`);
      }
    } finally {
      inFlight = false;
    }
  };
}
