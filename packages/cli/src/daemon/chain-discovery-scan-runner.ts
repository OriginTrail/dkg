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

export function chainDiscoveryScanOptions(input: {
  watermarkSeeded: boolean;
  startupPhase: ChainDiscoveryStartupPhase;
  successfulScansInCycle: number;
  fullRecoveryPending?: boolean;
  fullRecoveryRetryReady?: boolean;
  fullScanEvery?: number;
  pageBudget?: number;
}):
  | { mode: 'incremental'; pageBudget: number }
  | { mode: 'seedFromCursor'; throwOnChainScanFailure: true; pageBudget: number }
  | { mode: 'seedFull'; throwOnChainScanFailure: true } {
  const configuredFullScanEvery = input.fullScanEvery;
  let fullScanEvery = CHAIN_DISCOVERY_SCAN_SCHEDULE.fullScanEvery;
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

  if (input.startupPhase === 'undetermined') {
    return input.watermarkSeeded
      ? { mode: 'seedFull', throwOnChainScanFailure: true }
      : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
  }
  if (input.startupPhase === 'cursorSeed') {
    return input.watermarkSeeded
      ? { mode: 'incremental', pageBudget }
      : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
  }
  if (input.startupPhase === 'startupFullRecovery') {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  if (input.fullRecoveryPending) {
    return input.fullRecoveryRetryReady
      ? { mode: 'seedFull', throwOnChainScanFailure: true }
      : { mode: 'incremental', pageBudget };
  }
  if (input.watermarkSeeded && input.successfulScansInCycle >= fullScanEvery) {
    return { mode: 'seedFull', throwOnChainScanFailure: true };
  }
  return input.watermarkSeeded
    ? { mode: 'incremental', pageBudget }
    : { mode: 'seedFromCursor', throwOnChainScanFailure: true, pageBudget };
}

function safeLog(log: (message: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    // Logging must not turn a non-critical scan or scan failure into a daemon failure.
  }
}

export function createChainDiscoveryScanRunner(input: {
  agent: {
    hasContextGraphRegistryScanWatermark(): Promise<boolean>;
    discoverContextGraphsFromChain(
      options: ReturnType<typeof chainDiscoveryScanOptions>,
    ): Promise<number>;
  };
  log: (msg: string) => void;
  pageBudget?: number;
  fullScanEvery?: number;
}): () => Promise<void> {
  let startupPhase: ChainDiscoveryStartupPhase = 'undetermined';
  let startupFullFailures = 0;
  let successfulScansInCycle = 0;
  let fullRecoveryPending = false;
  let fullRecoveryRetryReady = false;
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
          `Chain scan: watermark probe failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      if (startupPhase === 'undetermined') {
        startupPhase = watermarkSeeded ? 'startupFullRecovery' : 'cursorSeed';
      }

      const options = chainDiscoveryScanOptions({
        watermarkSeeded,
        startupPhase,
        successfulScansInCycle,
        fullRecoveryPending,
        fullRecoveryRetryReady,
        pageBudget: input.pageBudget,
        fullScanEvery: input.fullScanEvery,
      });

      let found: number;
      try {
        found = await input.agent.discoverContextGraphsFromChain(options);
      } catch (error) {
        safeLog(
          input.log,
          `Chain scan: ${options.mode} scan failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        if (startupPhase === 'startupFullRecovery') {
          startupFullFailures += 1;
          // Retry startup recovery once immediately. If the historical range remains unavailable,
          // enter steady state and interleave tip discovery before each later full retry.
          if (startupFullFailures >= 2) {
            startupPhase = 'complete';
            fullRecoveryPending = true;
            fullRecoveryRetryReady = false;
          }
        } else if (options.mode === 'seedFull') {
          fullRecoveryPending = true;
          fullRecoveryRetryReady = false;
        } else if (fullRecoveryPending && options.mode === 'incremental') {
          // One tip-discovery attempt, successful or not, prevents an unavailable historical range
          // from monopolizing the scheduler. The next invocation may retry full recovery.
          fullRecoveryRetryReady = true;
        }
        return;
      }

      if (options.mode === 'seedFull') {
        startupPhase = 'complete';
        startupFullFailures = 0;
        successfulScansInCycle = 1;
        fullRecoveryPending = false;
        fullRecoveryRetryReady = false;
      } else {
        if (startupPhase === 'cursorSeed') startupPhase = 'complete';
        successfulScansInCycle += 1;
        if (fullRecoveryPending && options.mode === 'incremental') {
          fullRecoveryRetryReady = true;
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
