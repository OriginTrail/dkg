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

export type ChainDiscoveryStartupPhase =
  | 'undetermined'
  | 'cursorSeed'
  | 'startupFullRecovery'
  | 'complete';

type ChainDiscoveryRecoveryStep = 'tip' | 'incremental' | 'full';

type ManagedChainDiscoveryScanOptionsInput = {
  watermarkSeeded: boolean;
  startupPhase: ChainDiscoveryStartupPhase;
  successfulScansInCycle: number;
  recoveryStep?: ChainDiscoveryRecoveryStep;
  fullScanEvery?: number;
  pageBudget?: number;
};

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

/** Outcome-aware policy used only by the managed daemon scan runner. */
function managedChainDiscoveryScanOptions(
  input: ManagedChainDiscoveryScanOptionsInput,
): ChainDiscoveryScanOptions {
  const fullScanEvery = normalizeFullScanEvery(input.fullScanEvery);
  const pageBudget = normalizePageBudget(input.pageBudget);

  if (input.startupPhase === 'undetermined') {
    return input.watermarkSeeded
      ? { mode: 'seedFull', throwOnChainScanFailure: true }
      : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
  }
  if (input.startupPhase === 'cursorSeed') {
    return input.watermarkSeeded
      ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
      : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
  }
  if (input.startupPhase === 'startupFullRecovery') {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  if (input.recoveryStep === 'tip') return { mode: 'tip' };
  if (input.recoveryStep === 'incremental') {
    return input.watermarkSeeded
      ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
      : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
  }
  if (input.recoveryStep === 'full') {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  if (input.watermarkSeeded && input.successfulScansInCycle >= fullScanEvery) {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  return input.watermarkSeeded
    ? { mode: 'incremental', throwOnChainScanFailure: true, pageBudget }
    : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
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
  let startupPhase: ChainDiscoveryStartupPhase = 'undetermined';
  let startupFullFailures = 0;
  let successfulScansInCycle = 0;
  let recoveryStep: ChainDiscoveryRecoveryStep | undefined;
  let cursorBackedFailures = 0;
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

      if (startupPhase === 'undetermined') {
        startupPhase = watermarkSeeded ? 'startupFullRecovery' : 'cursorSeed';
      }

      const scheduledRecoveryStep = recoveryStep;
      const options = managedChainDiscoveryScanOptions({
        watermarkSeeded,
        startupPhase,
        successfulScansInCycle,
        recoveryStep: scheduledRecoveryStep,
        pageBudget: input.pageBudget,
        fullScanEvery: input.fullScanEvery,
      });

      let found: number;
      try {
        found = await input.agent.discoverContextGraphsFromChain(options);
      } catch (error) {
        safeLog(
          input.log,
          `Chain scan: ${options.mode} scan failed: ${safeErrorMessage(error)}`,
        );

        if (startupPhase === 'startupFullRecovery') {
          startupFullFailures += 1;
          // Retry startup recovery once immediately. If the historical range remains unavailable,
          // enter steady state and interleave tip discovery before each later full retry.
          if (startupFullFailures >= 2) {
            startupPhase = 'complete';
            recoveryStep = 'tip';
          }
        } else if (options.mode === 'seedFull') {
          recoveryStep = 'tip';
        } else if (scheduledRecoveryStep === 'tip' && options.mode === 'tip') {
          // A tip probe cannot fill a multi-page cursor-to-tip gap by itself. Whether the probe
          // succeeds or fails, give the usable historical cursor one bounded catch-up turn.
          recoveryStep = watermarkSeeded ? 'incremental' : 'full';
        } else if (
          scheduledRecoveryStep === 'incremental' &&
          (options.mode === 'seedFromCursor' || options.mode === 'incremental')
        ) {
          recoveryStep = 'full';
        } else if (options.mode === 'seedFromCursor' || options.mode === 'incremental') {
          cursorBackedFailures += 1;
          // A bounded retry absorbs transient RPC failures. Persistent cursor-backed failure means
          // historical progress is blocked, so preserve that cursor and enter the same tip/full
          // recovery alternation used for failed full scans.
          if (cursorBackedFailures >= 2) {
            startupPhase = 'complete';
            recoveryStep = 'tip';
            cursorBackedFailures = 0;
          }
        }
        return;
      }

      if (options.mode === 'seedFull') {
        startupPhase = 'complete';
        startupFullFailures = 0;
        successfulScansInCycle = 1;
        recoveryStep = undefined;
        cursorBackedFailures = 0;
      } else {
        if (startupPhase === 'cursorSeed') startupPhase = 'complete';
        if (options.mode === 'seedFromCursor' || options.mode === 'incremental') {
          cursorBackedFailures = 0;
        }
        if (scheduledRecoveryStep === 'tip' && options.mode === 'tip') {
          recoveryStep = watermarkSeeded ? 'incremental' : 'full';
        } else if (
          scheduledRecoveryStep === 'incremental' &&
          (options.mode === 'seedFromCursor' || options.mode === 'incremental')
        ) {
          recoveryStep = 'full';
        }
        if (scheduledRecoveryStep === undefined) {
          successfulScansInCycle += 1;
        }
      }

      if (found > 0) {
        safeLog(input.log, `Chain scan: discovered ${found} new context graph(s)`);
      }
    } finally {
      inFlight = false;
    }
  };
}
