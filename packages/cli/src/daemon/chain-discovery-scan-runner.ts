export const CHAIN_FULL_SCAN_EVERY = 48; // about once per day at the 30-minute cadence
export const CHAIN_DISCOVERY_SCAN_PAGE_BUDGET = 30;

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
  let successfulRuns = 0;
  let startupPath: 'undetermined' | 'seedFromCursor' | 'seedFull' = 'undetermined';
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

      if (startupPath === 'undetermined') {
        startupPath = watermarkSeeded ? 'seedFull' : 'seedFromCursor';
      }

      // A failed initial cursor seed can still persist a watermark after applying a page.
      // Once that bounded path has begun, a newly visible watermark must resume through the
      // incremental cursor path rather than reclassifying the retry as run-0 seedFull.
      const optionRun = successfulRuns === 0 && startupPath === 'seedFromCursor'
        ? 1
        : successfulRuns;
      const options = chainDiscoveryScanOptions({
        run: optionRun,
        watermarkSeeded,
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
        return;
      }

      successfulRuns += 1;
      if (found > 0) {
        safeLog(input.log, `Chain scan: discovered ${found} new context graph(s)`);
      }
    } finally {
      inFlight = false;
    }
  };
}
